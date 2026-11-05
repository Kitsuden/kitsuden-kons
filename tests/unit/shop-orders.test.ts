/**
 * Shop orders.
 *
 * The three decisions that separate a usable shop from one that
 * silently loses money are tested:
 *
 *   1. The price is FROZEN at purchase. If the line stored only the variant's
 *      id, the total of an order from a year ago would be computed with
 *      today's price.
 *   2. Stock is deducted WITHOUT RACES. Six mugs and two buyers
 *      at once is the normal case.
 *   3. Each fulfillment type requires its data. A shipment without an address is
 *      discovered at packing time, which is late.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import {
  validateCompliance,
  freezeLines,
  calculateTotals,
  orderNumber,
  deductStock,
  reserveStock,
  canTransition,
  statusAfterPayment,
  type VariantLike,
} from "../../kons/kon-ecommerce/shop.orders";

const cup = (extra: Partial<VariantLike> = {}): VariantLike => ({
  id: "v-taza",
  productId: "p-taza",
  productName: "Taza de cerámica",
  name: "Grande",
  priceCents: 2500,
  currency: "EUR",
  stock: 6,
  kind: "physical",
  active: true,
  ...extra,
});

const guide = (extra: Partial<VariantLike> = {}): VariantLike => ({
  id: "v-guia",
  productId: "p-guia",
  productName: "Guía de esmaltes",
  name: null,
  priceCents: 900,
  currency: "EUR",
  stock: null, // infinite
  kind: "digital",
  active: true,
  ...extra,
});

// ══ Frozen price ══════════════════════════════════════════════════════════

describe("congelar precios", () => {
  it("copies name and price into the line", () => {
    const l = freezeLines([{ variantId: "v-taza", quantity: 2 }], new Map([["v-taza", cup()]]));
    expect(l[0]).toMatchObject({
      productName: "Taza de cerámica",
      variantName: "Grande",
      unitPriceCents: 2500,
      quantity: 2,
      subtotalCents: 5000,
    });
  });

  it("a LATER price change does not alter the line", () => {
    const variants = new Map([["v-taza", cup()]]);
    const l = freezeLines([{ variantId: "v-taza", quantity: 1 }], variants);

    // The seller raises the price tomorrow.
    variants.set("v-taza", cup({ priceCents: 3000 }));

    expect(l[0].unitPriceCents).toBe(2500);
  });

  it("rejects invalid quantities instead of saving an absurd total", () => {
    const v = new Map([["v-taza", cup()]]);
    expect(() => freezeLines([{ variantId: "v-taza", quantity: 0 }], v)).toThrow(/quantity/);
    expect(() => freezeLines([{ variantId: "v-taza", quantity: -1 }], v)).toThrow(/quantity/);
    expect(() => freezeLines([{ variantId: "v-taza", quantity: 1.5 }], v)).toThrow(/quantity/);
  });

  it("sums in whole cents", () => {
    // With float, 0.1 + 0.2 is not 0.3 and the cart total gets thrown off.
    const l = freezeLines(
      [
        { variantId: "v-taza", quantity: 3 },
        { variantId: "v-guia", quantity: 1 },
      ],
      new Map([
        ["v-taza", cup()],
        ["v-guia", guide()],
      ])
    );
    expect(calculateTotals(l, 450)).toEqual({
      subtotalCents: 8400,
      shippingCents: 450,
      totalCents: 8850,
    });
  });
});

// ══ Fulfillment ═══════════════════════════════════════════════════════════

describe("validation by fulfillment type", () => {
  const base = { customerEmail: "ana@example.com" as const };

  it("digital does not ask for an address", () => {
    const p = validateCompliance({ ...base, fulfillmentType: "digital" }, [guide()]);
    expect(p).toEqual([]);
  });

  it("digital REJECTS a physical product inside", () => {
    // A mug is not delivered by email.
    const p = validateCompliance({ ...base, fulfillmentType: "digital" }, [cup()]);
    expect(p.join(" ")).toMatch(/physical/);
  });

  it("shipping requires a complete address and says WHAT is missing", () => {
    const p = validateCompliance(
      { ...base, fulfillmentType: "shipping", shippingAddress: { line1: "Calle 1" } },
      [cup()]
    );
    expect(p.join(" ")).toMatch(/city/);
    expect(p.join(" ")).toMatch(/postalCode/);
    expect(p.join(" ")).toMatch(/country/);
  });

  it("shipping with a complete address passes", () => {
    const p = validateCompliance(
      {
        ...base,
        fulfillmentType: "shipping",
        shippingAddress: { line1: "Calle 1", city: "Bogotá", postalCode: "110111", country: "CO" },
      },
      [cup()]
    );
    expect(p).toEqual([]);
  });

  it("pickup does not ask for an address, but does ask for a point and a time slot", () => {
    // Not asking for an address is precisely the advantage of local pickup.
    expect(
      validateCompliance({ ...base, fulfillmentType: "pickup", pickupNote: "Taller, L-V 10-14" }, [
        cup(),
      ])
    ).toEqual([]);

    expect(validateCompliance({ ...base, fulfillmentType: "pickup" }, [cup()]).join(" ")).toMatch(
      /pickup/i
    );
  });

  it("rejects mixing currencies", () => {
    const p = validateCompliance({ ...base, fulfillmentType: "digital" }, [
      guide(),
      guide({ id: "v-2", currency: "USD" }),
    ]);
    expect(p.join(" ")).toMatch(/currencies/);
  });

  it("returns ALL the problems, not the first", () => {
    const p = validateCompliance(
      { customerEmail: "no-es-email", fulfillmentType: "shipping" },
      []
    );
    expect(p.length).toBeGreaterThan(1);
  });

  it("rejects products withdrawn from sale", () => {
    const p = validateCompliance({ ...base, fulfillmentType: "digital" }, [
      guide({ active: false }),
    ]);
    expect(p.join(" ")).toMatch(/no longer for sale/);
  });
});

// ══ Stock, against real Postgres ══════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeAll(async () => {
  const client = await PGlite.create();
  db = drizzle(client);
  await client.exec(`
    CREATE TABLE shop_variants (
      id TEXT PRIMARY KEY,
      stock INTEGER,
      active BOOLEAN NOT NULL DEFAULT true
    );
  `);
});

beforeEach(async () => {
  await db.execute(sql.raw("DELETE FROM shop_variants"));
  await db.execute(
    sql.raw("INSERT INTO shop_variants (id, stock) VALUES ('v-taza', 6), ('v-guia', NULL)")
  );
});

async function stockOf(id: string): Promise<number | null> {
  const r = await db.execute(sql`SELECT stock FROM shop_variants WHERE id = ${id}`);
  const rows = (Array.isArray(r) ? r : (r.rows ?? [])) as Array<{ stock: number | null }>;
  return rows[0]?.stock ?? null;
}

describe("existencias", () => {
  it("deducts what was ordered", async () => {
    expect(await deductStock("v-taza", 2, db)).toBe(true);
    expect(await stockOf("v-taza")).toBe(4);
  });

  it("does NOT allow selling below zero", async () => {
    expect(await deductStock("v-taza", 7, db)).toBe(false);
    expect(await stockOf("v-taza")).toBe(6); // intact
  });

  it("allows emptying to exactly zero", async () => {
    expect(await deductStock("v-taza", 6, db)).toBe(true);
    expect(await stockOf("v-taza")).toBe(0);
    expect(await deductStock("v-taza", 1, db)).toBe(false);
  });

  it("stock NULL is infinite and stays that way", async () => {
    // Digital goods are served a thousand times without branching the code.
    expect(await deductStock("v-guia", 999, db)).toBe(true);
    expect(await stockOf("v-guia")).toBeNull();
  });

  it("two simultaneous purchases on the last unit: only one wins", async () => {
    // The case that sinks the naive version (read, check, subtract).
    await db.execute(sql.raw("UPDATE shop_variants SET stock = 1 WHERE id = 'v-taza'"));

    const [a, b] = await Promise.all([
      deductStock("v-taza", 1, db),
      deductStock("v-taza", 1, db),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await stockOf("v-taza")).toBe(0);
  });

  it("an inactive variant cannot be sold", async () => {
    await db.execute(sql.raw("UPDATE shop_variants SET active = false WHERE id = 'v-taza'"));
    expect(await deductStock("v-taza", 1, db)).toBe(false);
  });

  it("if a line fails, it RETURNS what was already deducted", async () => {
    // Without the compensation, those units stay blocked by an order that
    // never existed and are only recovered by hand.
    const lines = freezeLines(
      [
        { variantId: "v-taza", quantity: 2 },
        { variantId: "v-guia", quantity: 1 },
        { variantId: "v-agotada", quantity: 1 },
      ],
      new Map([
        ["v-taza", cup()],
        ["v-guia", guide()],
        ["v-agotada", cup({ id: "v-agotada", productName: "Plato" })],
      ])
    );

    const r = await reserveStock(lines, db);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.soldOut).toBe("Plato");
    expect(await stockOf("v-taza")).toBe(6); // returned
  });
});

// ══ States ════════════════════════════════════════════════════════════════

describe("state machine", () => {
  it("a refunded one does not go back to paid", () => {
    expect(canTransition("refunded", "paid")).toBe(false);
    expect(canTransition("cancelled", "paid")).toBe(false);
  });

  it("physical goods go to production after payment; digital ones are delivered", () => {
    expect(statusAfterPayment("shipping")).toBe("in_production");
    expect(statusAfterPayment("pickup")).toBe("in_production");
    expect(statusAfterPayment("digital")).toBe("delivered");
  });

  it("the normal path of a commissioned order", () => {
    expect(canTransition("pending", "paid")).toBe(true);
    expect(canTransition("paid", "in_production")).toBe(true);
    expect(canTransition("in_production", "ready")).toBe(true);
    expect(canTransition("ready", "delivered")).toBe(true);
  });

  it("something that has not been paid yet cannot be shipped", () => {
    expect(canTransition("pending", "shipped")).toBe(false);
  });
});

describe("order number", () => {
  it("carries the year and zero-pads so that it sorts as text", () => {
    expect(orderNumber(42, new Date("2026-03-01T00:00:00Z"))).toBe("2026-000042");
    expect(
      orderNumber(7, new Date("2026-01-01T00:00:00Z")) <
        orderNumber(100, new Date("2026-01-01T00:00:00Z"))
    ).toBe(true);
  });
});

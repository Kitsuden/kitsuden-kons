/**
 * kon-ecommerce — anonymous `POST /orders` without draining the stock
 * ============================================================================
 *
 * Audit 2026-10-15. Buying is anonymous on purpose and the `pending` order
 * DEDUCTS stock. What was missing:
 *
 *   · No reservation expiry: a loop of unpaid orders left a one-of-a-kind
 *     piece sold out forever.
 *   · No idempotency: a network retry duplicated the order and the deduction.
 *   · The cap of 999 was PER LINE: fifty lines of the same variant
 *     skipped it.
 *   · `shippingAddress` accepted any object of any size.
 *   · Canceling restored nothing, and the status change was not conditional.
 *
 * Against PGlite with the real migrations (0001 + 0002).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AppError } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readSqlFile } from "../../.kitsuden/apps/api/src/lib/sql-file";
import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { kon } from "../../kons/kon-ecommerce";
import { registerShopPolicies } from "../../kons/kon-ecommerce/shop.policy";
import { createShopRouter } from "../../kons/kon-ecommerce/shop.routes";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(here, "../../kons/kon-ecommerce/migrations");

let client: PGlite;
let app: Hono;
let session: { id: string; role: string } | null = null;

beforeAll(async () => {
  client = await PGlite.create();
  for (const stmt of readSqlFile(resolve(MIG, "0001_shop.sql"), "0001_shop").statements) {
    await client.exec(stmt);
  }
  await client.exec(readFileSync(resolve(MIG, "0002_secure_orders.sql"), "utf8"));
  // 0008: payment, delivery, discount codes (the order insert writes its columns).
  await client.exec(readFileSync(resolve(MIG, "0008_checkout_delivery_coupons.sql"), "utf8"));
  registerShopPolicies();

  const ctx = createTestKonContext({
    db: {
      instance: drizzle(client),
      execute: async () => undefined,
      tableExists: async () => true,
    },
    auth: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono middleware double
      requireAuth: (c: any, next: any) => {
        if (!session) return c.json({ error: "no session" }, 401);
        c.set("user", session);
        return next();
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
    } as any,
    konConfig: {
      "kon-ecommerce": { shippingFlatCents: 500, pickupNote: "Taller", reservationMinutes: 30 },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
  } as any);

  app = new Hono();
  app.onError((err) => {
    if (err instanceof AppError) {
      return Response.json({ error: err.message, details: err.details }, { status: err.status });
    }
    return Response.json({ error: String(err) }, { status: 500 });
  });
  app.route("/", createShopRouter(ctx));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  session = null;
  await client.exec(`
    DELETE FROM shop_order_items; DELETE FROM shop_orders;
    DELETE FROM shop_variants; DELETE FROM shop_products;
    INSERT INTO shop_products (id, slug, name, kind, active) VALUES
      ('p-jarron', 'jarron', 'Jarrón único', 'physical', true),
      ('p-guia', 'guia', 'Guía', 'digital', true);
    INSERT INTO shop_variants (id, product_id, name, price_cents, stock) VALUES
      ('v-jarron', 'p-jarron', 'Único', 12000, 1),
      ('v-taza', 'p-jarron', 'Taza', 2000, 6),
      ('v-guia', 'p-guia', 'PDF', 900, NULL);
  `);
});

const stock = async (id: string) =>
  (
    await client.query<{ stock: number | null }>(
      `SELECT stock FROM shop_variants WHERE id = '${id}'`
    )
  ).rows[0].stock;

const requests = async () =>
  (await client.query<{ id: string; status: string }>("SELECT id, status FROM shop_orders")).rows;

const buy = (body: unknown, headers: Record<string, string> = {}) =>
  app.request("/orders", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const pickUpJar = (email = "ana@ejemplo.com") => ({
  items: [{ variantId: "v-jarron", quantity: 1 }],
  customerEmail: email,
  fulfillmentType: "pickup",
});

describe("idempotencia", () => {
  it("the same POST with the same Idempotency-Key does not deduct twice", async () => {
    const h = { "idempotency-key": "pedido-abc-123" };
    const r1 = await buy(pickUpJar(), h);
    const r2 = await buy(pickUpJar(), h);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect((await r2.json()).orderId).toBe((await r1.json()).orderId);
    expect(await requests()).toHaveLength(1);
    expect(await stock("v-jarron")).toBe(0);
  });

  it("two SIMULTANEOUS retries create a single order", async () => {
    const h = { "idempotency-key": "pedido-simultaneo-1" };
    const body = {
      items: [{ variantId: "v-taza", quantity: 2 }],
      customerEmail: "ana@ejemplo.com",
      fulfillmentType: "pickup",
    };
    const [a, b] = await Promise.all([buy(body, h), buy(body, h)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await requests()).toHaveLength(1);
    expect(await stock("v-taza")).toBe(4);
  });

  it("the same key with ANOTHER email does not return someone else's order", async () => {
    const h = { "idempotency-key": "clave-adivinada-1" };
    const deAna = await (
      await buy(
        {
          ...pickUpJar(),
          items: [{ variantId: "v-guia", quantity: 1 }],
          fulfillmentType: "digital",
        },
        h
      )
    ).json();
    const ofOther = await buy(
      {
        items: [{ variantId: "v-guia", quantity: 1 }],
        customerEmail: "otro@ejemplo.com",
        fulfillmentType: "digital",
      },
      h
    );
    expect(ofOther.status).toBe(201);
    expect((await ofOther.json()).orderId).not.toBe(deAna.orderId);
  });

  it("a key with odd characters is rejected", async () => {
    const r = await buy(pickUpJar(), { "idempotency-key": "x'; DROP TABLE--" });
    expect(r.status).toBe(422);
  });
});

describe("unpaid reservations expire", () => {
  it("an old pending is canceled and returns its unit to the catalog", async () => {
    expect((await buy(pickUpJar("bot1@ejemplo.com"))).status).toBe(201);
    expect(await stock("v-jarron")).toBe(0);

    // Sold out for the next one…
    expect((await buy(pickUpJar("compradora@ejemplo.com"))).status).toBe(409);

    // …until the first one's reservation expires (30 min configured).
    await client.exec(
      "UPDATE shop_orders SET placed_at = now() - interval '31 minutes' WHERE status = 'pending'"
    );
    const r = await buy(pickUpJar("compradora@ejemplo.com"));
    expect(r.status).toBe(201);

    const statuses = (await requests()).map((p) => p.status).sort();
    expect(statuses).toEqual(["cancelled", "pending"]);
    expect(await stock("v-jarron")).toBe(0);
  });

  it("a recent pending is NOT released", async () => {
    await buy(pickUpJar("ana@ejemplo.com"));
    expect((await buy(pickUpJar("bea@ejemplo.com"))).status).toBe(409);
    expect((await requests()).map((p) => p.status)).toEqual(["pending"]);
  });
});

describe("stock without overselling", () => {
  it("six mugs and ten simultaneous purchases: six are sold, not one more", async () => {
    const body = (i: number) => ({
      items: [{ variantId: "v-taza", quantity: 1 }],
      customerEmail: `c${i}@ejemplo.com`,
      fulfillmentType: "pickup",
    });
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => buy(body(i))));
    expect(res.filter((r) => r.status === 201)).toHaveLength(6);
    expect(res.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await stock("v-taza")).toBe(0);
  });

  it("repeating the variant across several lines does not skip the cap of 999", async () => {
    const r = await buy({
      items: Array.from({ length: 3 }, () => ({ variantId: "v-guia", quantity: 999 })),
      customerEmail: "ana@ejemplo.com",
      fulfillmentType: "digital",
    });
    expect(r.status).toBe(422);
    expect(await requests()).toHaveLength(0);
  });

  it("the price and the total come from the catalog even if the client sends others", async () => {
    const r = await buy({
      items: [{ variantId: "v-jarron", quantity: 1, priceCents: 1, unitPriceCents: 1 }],
      customerEmail: "ana@ejemplo.com",
      fulfillmentType: "pickup",
      totalCents: 1,
      subtotalCents: 1,
      status: "paid",
    });
    expect(r.status).toBe(201);
    expect((await r.json()).totalCents).toBe(12000);
    expect((await requests())[0].status).toBe("pending");
  });
});

describe("shipping address: allowlist", () => {
  const dispatch = (dir: Record<string, unknown>) => ({
    items: [{ variantId: "v-taza", quantity: 1 }],
    customerEmail: "ana@ejemplo.com",
    fulfillmentType: "shipping",
    shippingAddress: dir,
  });
  const valid = { line1: "Calle 1", city: "Vigo", postalCode: "36201", country: "ES" };

  it("discards fields that are not part of an address", async () => {
    expect((await buy(dispatch({ ...valid, __proto__x: 1, html: "<script>" }))).status).toBe(201);
    const row = await client.query<{ shipping_address: Record<string, unknown> }>(
      "SELECT shipping_address FROM shop_orders"
    );
    expect(Object.keys(row.rows[0].shipping_address).sort()).toEqual(
      ["city", "country", "line1", "postalCode"].sort()
    );
  });

  it("rejects enormous fields", async () => {
    expect((await buy(dispatch({ ...valid, line1: "x".repeat(5000) }))).status).toBe(422);
  });
});

describe("operate orders", () => {
  it("canceling restores the units", async () => {
    const { orderId } = await (await buy(pickUpJar())).json();
    expect(await stock("v-jarron")).toBe(0);

    session = { id: "u-admin", role: "admin" };
    const r = await app.request(`/admin/orders/${orderId}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });
    expect(r.status).toBe(200);
    expect(await stock("v-jarron")).toBe(1);
  });

  it("a regular account neither operates nor reads orders", async () => {
    const { orderId } = await (await buy(pickUpJar())).json();
    session = { id: "u-alta", role: "user" };
    expect((await app.request(`/admin/orders/${orderId}`)).status).toBe(403);
    const r = await app.request(`/admin/orders/${orderId}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });
    expect(r.status).toBe(403);
  });
});

describe("the kon declares its brake", () => {
  it("POST /orders has a fail-closed request limit", () => {
    const rule = kon.rateLimits?.find((r) => r.path === "/orders");
    expect(rule).toBeDefined();
    expect(rule!.limit).toBeLessThanOrEqual(20);
    expect(rule!.failClosed).toBe(true);
  });
});

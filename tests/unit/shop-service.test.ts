/**
 * Complete order creation, against the REAL schema of the migration.
 *
 * The `shop-orders` tests test the pieces separately. Here we test
 * what a buyer actually uses: ordering, the right amount being deducted, it
 * being written with the frozen price, and —most importantly— that if something
 * fails AFTER reserving stock, those units come back.
 *
 * That last case is the one manual compensation does not cover and the transaction
 * does, and it is the one that leaves units blocked forever when it is missing.
 */

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import { readSqlFile } from "../../.kitsuden/apps/api/src/lib/sql-file";
import { createOrder } from "../../kons/kon-ecommerce/shop.service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeAll(async () => {
  const client = await PGlite.create();
  db = drizzle(client);

  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const route = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../kons/kon-ecommerce/migrations/0001_shop.sql"
  );

  for (const stmt of readSqlFile(route, "0001_shop").statements) {
    await client.exec(stmt);
  }
  // 0002: idempotency, reservation index and order RLS.
  const { readFileSync } = await import("node:fs");
  await client.exec(
    readFileSync(route.replace("0001_shop.sql", "0002_secure_orders.sql"), "utf8")
  );
  // 0008: payment, delivery, discount codes (the order insert writes its columns).
  await client.exec(
    readFileSync(route.replace("0001_shop.sql", "0008_checkout_delivery_coupons.sql"), "utf8")
  );
});

beforeEach(async () => {
  await db.execute(sql.raw("DELETE FROM shop_order_items"));
  await db.execute(sql.raw("DELETE FROM shop_orders"));
  await db.execute(sql.raw("DELETE FROM shop_variants"));
  await db.execute(sql.raw("DELETE FROM shop_products"));
  await db.execute(sql.raw("ALTER SEQUENCE shop_order_number_seq RESTART WITH 1"));

  // One statement per call: PGlite uses prepared queries and rejects
  // "cannot insert multiple commands into a prepared statement".
  await db.execute(
    sql.raw(
      "INSERT INTO shop_products (id, slug, name, kind) VALUES " +
        "('p-taza', 'taza', 'Taza de ceramica', 'physical'), ('p-guia', 'guia', 'Guia de esmaltes', 'digital')"
    )
  );
  await db.execute(
    sql.raw(
      "INSERT INTO shop_variants (id, product_id, name, price_cents, stock) VALUES " +
        "('v-taza', 'p-taza', 'Grande', 2500, 6), ('v-guia', 'p-guia', 'Unica', 900, NULL)"
    )
  );
});

async function stock(id: string): Promise<number | null> {
  const r = await db.execute(sql`SELECT stock FROM shop_variants WHERE id = ${id}`);
  const f = (Array.isArray(r) ? r : (r.rows ?? [])) as Array<{ stock: number | null }>;
  return f[0]?.stock ?? null;
}

const pickup = {
  customerEmail: "ana@example.com",
  customerName: "Ana",
  fulfillmentType: "pickup" as const,
  pickupNote: "Taller, L-V 10-14",
};

describe("create an order", () => {
  it("writes order and lines, and deducts stock", async () => {
    const r = await createOrder([{ variantId: "v-taza", quantity: 2 }], pickup, db);

    expect(r.ok).toBe(true);
    expect(r.totalCents).toBe(5000);
    expect(await stock("v-taza")).toBe(4);

    const items = await db.execute(
      sql`SELECT * FROM shop_order_items WHERE order_id = ${r.orderId}`
    );
    const f = (Array.isArray(items) ? items : items.rows) as Array<Record<string, unknown>>;
    expect(f).toHaveLength(1);
    expect(f[0].product_name).toBe("Taza de ceramica");
    expect(f[0].unit_price_cents).toBe(2500);
  });

  it("the price stays FROZEN even if the catalog changes afterwards", async () => {
    const r = await createOrder([{ variantId: "v-taza", quantity: 1 }], pickup, db);
    await db.execute(sql.raw("UPDATE shop_variants SET price_cents = 9900 WHERE id = 'v-taza'"));

    const items = await db.execute(
      sql`SELECT unit_price_cents FROM shop_order_items WHERE order_id = ${r.orderId}`
    );
    const f = (Array.isArray(items) ? items : items.rows) as Array<{ unit_price_cents: number }>;
    expect(f[0].unit_price_cents).toBe(2500);
  });

  it("numbers sequentially without repeating", async () => {
    const a = await createOrder(
      [{ variantId: "v-guia", quantity: 1 }],
      {
        ...pickup,
        fulfillmentType: "digital",
        pickupNote: null,
      },
      db
    );
    const b = await createOrder(
      [{ variantId: "v-guia", quantity: 1 }],
      {
        ...pickup,
        fulfillmentType: "digital",
        pickupNote: null,
      },
      db
    );

    expect(a.number).toBe("2026-000001");
    expect(b.number).toBe("2026-000002");
  });

  it("digital goods do not consume stock", async () => {
    await createOrder(
      [{ variantId: "v-guia", quantity: 50 }],
      {
        ...pickup,
        fulfillmentType: "digital",
        pickupNote: null,
      },
      db
    );
    expect(await stock("v-guia")).toBeNull();
  });
});

describe("rejections, leaving no trace", () => {
  it("a shipment without an address is rejected and does NOT touch stock", async () => {
    const r = await createOrder(
      [{ variantId: "v-taza", quantity: 2 }],
      { customerEmail: "ana@example.com", fulfillmentType: "shipping" },
      db
    );

    expect(r.ok).toBe(false);
    expect(r.problems?.join(" ")).toMatch(/shipping address/);
    // Validating BEFORE reserving avoids blocking units for an order that was
    // going to be rejected anyway.
    expect(await stock("v-taza")).toBe(6);
  });

  it("ordering more than there is is rejected naming the product", async () => {
    const r = await createOrder([{ variantId: "v-taza", quantity: 99 }], pickup, db);
    expect(r.ok).toBe(false);
    expect(r.soldOut).toBe("Taza de ceramica");
    expect(await stock("v-taza")).toBe(6);
  });

  it("a nonexistent variant creates nothing", async () => {
    const r = await createOrder([{ variantId: "no-existe", quantity: 1 }], pickup, db);
    expect(r.ok).toBe(false);

    const requests = await db.execute(sql.raw("SELECT count(*)::int AS n FROM shop_orders"));
    const f = (Array.isArray(requests) ? requests : requests.rows) as Array<{ n: number }>;
    expect(f[0].n).toBe(0);
  });

  it("if the SECOND line sells out, the first returns its units", async () => {
    // The case that leaves units blocked forever when there is no
    // transaction: the first line was already deducted when the second fails.
    await db.execute(
      sql.raw(
        "INSERT INTO shop_products (id, slug, name, kind) VALUES ('p-plato', 'plato', 'Plato', 'physical')"
      )
    );
    await db.execute(
      sql.raw(
        "INSERT INTO shop_variants (id, product_id, name, price_cents, stock) VALUES ('v-plato', 'p-plato', 'Unica', 1800, 1)"
      )
    );

    const r = await createOrder(
      [
        { variantId: "v-taza", quantity: 3 },
        { variantId: "v-plato", quantity: 5 }, // there is only 1
      ],
      pickup,
      db
    );

    expect(r.ok).toBe(false);
    expect(r.soldOut).toBe("Plato");
    expect(await stock("v-taza")).toBe(6); // devueltas
    expect(await stock("v-plato")).toBe(1);
  });

  it("a rejected order does not consume a number", async () => {
    // If it did, the numbering would have gaps and the seller would think
    // orders had been lost.
    await createOrder([{ variantId: "v-taza", quantity: 99 }], pickup, db);
    const ok = await createOrder([{ variantId: "v-taza", quantity: 1 }], pickup, db);
    expect(ok.number).toBe("2026-000001");
  });
});

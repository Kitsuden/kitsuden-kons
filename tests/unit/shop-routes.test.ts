/**
 * The shop's HTTP API
 * ============================================================================
 *
 * The `shop-orders` tests cover the pieces and the `shop-service` ones the
 * full creation against the real schema. Here we test what exists ONLY
 * in the HTTP layer, which is where the risk lives:
 *
 *   · which body fields are ignored on purpose — a buyer sending
 *     `shippingCents: -9900` or a foreign `ownerId` must get nothing;
 *   · that the status is TRANSITIONED and not assigned;
 *   · that the public catalog leaks neither drafts nor internal columns;
 *   · that `/admin/*` does not respond without a session.
 *
 * It runs against PGlite with the real migration, like `shop-service`: a
 * database double would not have detected, for example, that the total is computed by
 * the server and not by the client.
 */

import { PGlite } from "@electric-sql/pglite";
// The facade, not the submodule: `shop.policy.ts` registers the policies against
// THIS instance of the registry. Importing `.kitsuden/packages/engine/src/authz` by deep
// path would give another module, with its own empty registry, and everything would be denied.
import { AppError } from "@kitsuden/engine";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import { readSqlFile } from "../../.kitsuden/apps/api/src/lib/sql-file";
import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
// Importing it registers the policies (deny-by-default).
import { registerShopPolicies } from "../../kons/kon-ecommerce/shop.policy";
import { createShopRouter } from "../../kons/kon-ecommerce/shop.routes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let app: Hono;

/** Who sends the request. `null` = anonymous, which is the buyer's case. */
let session: { id: string; role: string } | null = null;

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

  registerShopPolicies();

  const ctx = createTestKonContext({
    db: { instance: db, execute: async () => undefined, tableExists: async () => true },
    auth: {
      // Double of the real middleware: 401 without a session, and if there is one it leaves it where
      // `authorize` looks for it. This router touches nothing else of `auth`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono middleware double
      requireAuth: (c: any, next: any) => {
        if (!session) return c.json({ error: "no session" }, 401);
        c.set("user", session);
        return next();
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- idem
    } as any,
    konConfig: {
      "kon-ecommerce": { shippingFlatCents: 500, pickupNote: "Taller, L-V de 10 a 14" },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
  } as any);

  app = new Hono();
  // The real app translates AppError in `app.onError`; here the minimum is replicated
  // so that the test checks status codes and not exceptions.
  app.onError((err) => {
    if (err instanceof AppError) {
      return Response.json({ error: err.message, details: err.details }, { status: err.status });
    }
    return Response.json({ error: String(err) }, { status: 500 });
  });
  app.route("/", createShopRouter(ctx));
});

beforeEach(async () => {
  session = null;
  await db.execute(sql.raw("DELETE FROM shop_order_items"));
  await db.execute(sql.raw("DELETE FROM shop_orders"));
  await db.execute(sql.raw("DELETE FROM shop_variants"));
  await db.execute(sql.raw("DELETE FROM shop_products"));
  await db.execute(sql.raw("ALTER SEQUENCE shop_order_number_seq RESTART WITH 1"));

  await db.execute(
    sql.raw(
      "INSERT INTO shop_products (id, slug, name, kind, active, owner_id) VALUES " +
        "('p-taza', 'taza', 'Taza de ceramica', 'physical', true, 'u-duenyo'), " +
        "('p-guia', 'guia', 'Guia de esmaltes', 'digital', true, 'u-duenyo'), " +
        "('p-draft', 'edicion-2027', 'Edicion limitada 2027', 'physical', false, 'u-duenyo')"
    )
  );
  await db.execute(
    sql.raw(
      "INSERT INTO shop_variants (id, product_id, name, price_cents, stock) VALUES " +
        "('v-taza', 'p-taza', 'Grande', 2500, 6), " +
        "('v-guia', 'p-guia', 'Unica', 900, NULL), " +
        "('v-draft', 'p-draft', 'Unica', 9900, 1)"
    )
  );
});

const post = (route: string, body: unknown) =>
  app.request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const digitalPurchase = {
  items: [{ variantId: "v-guia", quantity: 1 }],
  customerEmail: "compradora@ejemplo.com",
  fulfillmentType: "digital" as const,
};

// ════════════════════════════════════════════════════════════════════════════

describe("public catalog", () => {
  it("does not expose inactive products", async () => {
    const res = await app.request("/products");
    const { products } = await res.json();

    expect(res.status).toBe(200);
    expect(products.map((p: { slug: string }) => p.slug).sort()).toEqual(["guia", "taza"]);
  });

  it("a draft responds 404, not 403", async () => {
    // That something called "Edicion limitada 2027" exists is not information
    // that should come out either: a 403 confirms the resource is there.
    expect((await app.request("/products/edicion-2027")).status).toBe(404);
  });

  it("does not leak internal catalog columns", async () => {
    const { products } = await (await app.request("/products")).json();
    for (const p of products) {
      expect(p).not.toHaveProperty("ownerId");
      expect(p).not.toHaveProperty("metadata");
    }
  });
});

describe("what the buyer does NOT decide", () => {
  it("ignores a negative shippingCents from the body", async () => {
    // Without this, `calculateTotals` would do subtotal + (-9900): a discount
    // served by the API itself.
    const res = await post("/orders", { ...digitalPurchase, shippingCents: -9900 });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.totalCents).toBe(900);
  });

  it("applies the CONFIGURED shipping rate, not the one that arrives", async () => {
    const res = await post("/orders", {
      items: [{ variantId: "v-taza", quantity: 1 }],
      customerEmail: "compradora@ejemplo.com",
      fulfillmentType: "shipping",
      shippingAddress: { line1: "Calle 1", city: "Vigo", postalCode: "36201", country: "ES" },
      shippingCents: 0,
    });

    expect(res.status).toBe(201);
    // 2500 for the product + 500 from the kon's configuration.
    expect((await res.json()).totalCents).toBe(3000);
  });

  it("ignores the ownerId in the body", async () => {
    const res = await post("/orders", { ...digitalPurchase, ownerId: "u-duenyo" });
    expect(res.status).toBe(201);

    const rowsValue = await db.execute(sql.raw("SELECT owner_id FROM shop_orders"));
    const rows = Array.isArray(rowsValue) ? rowsValue : rowsValue.rows;
    expect(rows[0].owner_id).toBeNull();
  });

  it("rejects the order with 422 and all the problems at once", async () => {
    const res = await post("/orders", { items: [], customerEmail: "no-es-un-email" });
    expect(res.status).toBe(422);
    // The routes are SDK operations: the AppError is served by the router itself
    // with the core's usual envelope (`respondError`: `error.details`), not
    // this test's `onError`.
    expect((await res.json()).error.details.length).toBeGreaterThan(1);
  });

  it("responds 409 when something ran out, not 422", async () => {
    // The order was valid; what changed was the world. Telling them apart matters:
    // with 409 the client knows that retrying with fewer units makes sense.
    const res = await post("/orders", {
      // There are 6 in stock; 10 is within the per-variant cap (20,
      // audit 2026-10-25), so the order is valid and what fails is the stock.
      items: [{ variantId: "v-taza", quantity: 10 }],
      customerEmail: "compradora@ejemplo.com",
      fulfillmentType: "shipping",
      shippingAddress: { line1: "Calle 1", city: "Vigo", postalCode: "36201", country: "ES" },
    });
    expect(res.status).toBe(409);
  });
});

describe("backoffice access", () => {
  it("without a session orders are not listed", async () => {
    expect((await app.request("/admin/orders")).status).toBe(401);
  });

  it("a regular user neither", async () => {
    session = { id: "u-cliente", role: "user" };
    expect((await app.request("/admin/orders")).status).toBe(403);
  });

  it("the team does", async () => {
    session = { id: "u-admin", role: "admin" };
    expect((await app.request("/admin/orders")).status).toBe(200);
  });
});

describe("the status is transitioned, not assigned", () => {
  /** Creates an order and returns its id. */
  async function request(body: unknown = digitalPurchase): Promise<string> {
    const res = await post("/orders", body);
    return (await res.json()).orderId;
  }

  it("a refunded one cannot go back to paid", async () => {
    const id = await request();
    session = { id: "u-admin", role: "admin" };

    await post(`/admin/orders/${id}/status`, { status: "paid" });
    await post(`/admin/orders/${id}/status`, { status: "refunded" });

    const res = await post(`/admin/orders/${id}/status`, { status: "paid" });
    expect(res.status).toBe(409);
  });

  it("you cannot jump from pending to shipped", async () => {
    const id = await request();
    session = { id: "u-admin", role: "admin" };

    expect((await post(`/admin/orders/${id}/status`, { status: "shipped" })).status).toBe(409);
  });

  it("charging a digital one leaves it delivered", async () => {
    const id = await request();
    session = { id: "u-admin", role: "admin" };

    const res = await post(`/admin/orders/${id}/status`, { status: "paid" });
    expect((await res.json()).order.status).toBe("delivered");
  });

  it("charging a physical one sends it to production", async () => {
    // The status that exists because here whoever sells also manufactures.
    const id = await request({
      items: [{ variantId: "v-taza", quantity: 1 }],
      customerEmail: "compradora@ejemplo.com",
      fulfillmentType: "pickup",
    });
    session = { id: "u-admin", role: "admin" };

    const res = await post(`/admin/orders/${id}/status`, { status: "paid" });
    expect((await res.json()).order.status).toBe("in_production");
  });

  it("rejects a status that does not exist", async () => {
    const id = await request();
    session = { id: "u-admin", role: "admin" };

    expect((await post(`/admin/orders/${id}/status`, { status: "regalado" })).status).toBe(422);
  });
});

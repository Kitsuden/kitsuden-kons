/**
 * kon-ecommerce: `GET /my-orders`, `GET /admin/promotions` and `GET /admin/orders` page
 * ============================================================================
 *
 * `GET /admin/orders` took `limit` (default 50, max 200) with no way past it;
 * it keeps that `limit` and takes `offset` and answers `hasMore`.
 *
 * The other two stopped at a hidden cap (100 orders, 500 codes) with no sign. Now
 * `limit` and `offset` give one page and `hasMore` says whether there is
 * another; without them the answer is what it always was (the default page is
 * the old cap) plus `hasMore`. Real migrations on PGlite, as in
 * shop-checkout-delivery.test.ts.
 */
import { PGlite } from "@electric-sql/pglite";
import { AppError } from "@kitsuden/engine";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { readSqlFile } from "../../.kitsuden/apps/api/src/lib/sql-file";
import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { issueLink } from "../../kons/kon-ecommerce/shop.access";
import { registerShopPolicies } from "../../kons/kon-ecommerce/shop.policy";
import { createShopRouter } from "../../kons/kon-ecommerce/shop.routes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let app: Hono;
let session: { id: string; role: string } | null = null;
let token: string;

const q = (text: string) => db.execute(sql.raw(text));
const get = async (route: string) => {
  const res = await app.request(route);
  return { status: res.status, body: (await res.json()) as any };
};

beforeAll(async () => {
  const client = await PGlite.create();
  db = drizzle(client);
  const MIG = resolve(dirname(fileURLToPath(import.meta.url)), "../../kons/kon-ecommerce/migrations");
  for (const stmt of readSqlFile(resolve(MIG, "0001_shop.sql"), "0001_shop").statements) {
    await client.exec(stmt);
  }
  await client.exec(readFileSync(resolve(MIG, "0002_secure_orders.sql"), "utf8"));
  await client.exec(readFileSync(resolve(MIG, "0008_checkout_delivery_coupons.sql"), "utf8"));

  registerShopPolicies();
  const ctx = createTestKonContext({
    db: { instance: db, execute: async () => undefined, tableExists: async () => true },
    auth: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono middleware double
      requireAuth: (c: any, next: any) => {
        if (!session) return c.json({ error: "no session" }, 401);
        c.set("user", session);
        return next();
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
  } as any);
  app = new Hono();
  app.onError((err) =>
    err instanceof AppError
      ? Response.json({ error: err.message }, { status: err.status })
      : Response.json({ error: String(err) }, { status: 500 })
  );
  app.route("/", createShopRouter(ctx, { payments: null }));

  // Three orders of one buyer (and one of somebody else), created a minute apart.
  await q(`INSERT INTO shop_orders (id, number, fulfillment_type, customer_email, created_at) VALUES
    ('o1', 'A-1', 'digital', 'buyer@example.com', now() - interval '3 minutes'),
    ('o2', 'A-2', 'digital', 'Buyer@example.com', now() - interval '2 minutes'),
    ('o3', 'A-3', 'digital', 'buyer@example.com', now() - interval '1 minute'),
    ('ox', 'A-4', 'digital', 'other@example.com', now())`);
  token = (await issueLink(db, "buyer@example.com"))!;
  expect(token).toBeTruthy();

  await q(`INSERT INTO shop_promotions (id, code, application_type, value, created_at) VALUES
    ('pr1', 'ONE', 'percentage', 10, now() - interval '2 minutes'),
    ('pr2', 'TWO', 'percentage', 20, now() - interval '1 minute')`);
});

describe("GET /my-orders", () => {
  it("without `limit`, every order of that email, newest first, and `hasMore: false`", async () => {
    const { status, body } = await get(`/my-orders?token=${token}`);
    expect(status).toBe(200);
    expect(body.orders.map((o: { id: string }) => o.id)).toEqual(["o3", "o2", "o1"]);
    expect(body.hasMore).toBe(false);
  });

  it("`limit=1` gives one order and `hasMore: true`; the last page says there is no more", async () => {
    const first = await get(`/my-orders?token=${token}&limit=1`);
    expect(first.body.orders.map((o: { id: string }) => o.id)).toEqual(["o3"]);
    expect(first.body.hasMore).toBe(true);
    const last = await get(`/my-orders?token=${token}&limit=1&offset=2`);
    expect(last.body.orders.map((o: { id: string }) => o.id)).toEqual(["o1"]);
    expect(last.body.hasMore).toBe(false);
  });

  it("a page size over the old cap is refused, not silently cut", async () => {
    expect((await get(`/my-orders?token=${token}&limit=101`)).status).toBeGreaterThanOrEqual(400);
  });
});

describe("GET /admin/promotions", () => {
  it("staff: without `limit` every code and `hasMore: false`; `limit=1` one code and `hasMore: true`", async () => {
    session = { id: "u-editor", role: "editor" };
    const all = await get("/admin/promotions");
    expect(all.status).toBe(200);
    expect(all.body.promotions.map((p: { id: string }) => p.id)).toEqual(["pr2", "pr1"]);
    expect(all.body.hasMore).toBe(false);

    const page = await get("/admin/promotions?limit=1");
    expect(page.body.promotions.map((p: { id: string }) => p.id)).toEqual(["pr2"]);
    expect(page.body.hasMore).toBe(true);
    const next = await get("/admin/promotions?limit=1&offset=1");
    expect(next.body.promotions.map((p: { id: string }) => p.id)).toEqual(["pr1"]);
    expect(next.body.hasMore).toBe(false);
  });

  it("still only the team", async () => {
    session = null;
    expect((await get("/admin/promotions?limit=1")).status).toBe(401);
    session = { id: "u1", role: "user" };
    expect((await get("/admin/promotions?limit=1")).status).toBe(403);
  });
});

describe("GET /admin/orders", () => {
  it("staff: without parameters every order, newest first, as before, and `hasMore: false`", async () => {
    session = { id: "u-editor", role: "editor" };
    const all = await get("/admin/orders");
    expect(all.status).toBe(200);
    expect(all.body.orders.map((o: { id: string }) => o.id)).toEqual(["ox", "o3", "o2", "o1"]);
    expect(all.body.hasMore).toBe(false);
  });

  it("`limit=1` has more; `limit=1&offset=1` is the second order; the last page has no more", async () => {
    session = { id: "u-editor", role: "editor" };
    const first = await get("/admin/orders?limit=1");
    expect(first.body.orders.map((o: { id: string }) => o.id)).toEqual(["ox"]);
    expect(first.body.hasMore).toBe(true);
    const second = await get("/admin/orders?limit=1&offset=1");
    expect(second.body.orders.map((o: { id: string }) => o.id)).toEqual(["o3"]);
    expect(second.body.hasMore).toBe(true);
    const last = await get("/admin/orders?limit=2&offset=2");
    expect(last.body.orders.map((o: { id: string }) => o.id)).toEqual(["o2", "o1"]);
    expect(last.body.hasMore).toBe(false);
  });

  it("`status` still filters, and the lenient `limit` still falls back to the default", async () => {
    session = { id: "u-editor", role: "editor" };
    const none = await get("/admin/orders?status=paid");
    expect(none.body.orders).toEqual([]);
    expect(none.body.hasMore).toBe(false);
    const lenient = await get("/admin/orders?limit=abc");
    expect(lenient.status).toBe(200);
    expect(lenient.body.orders).toHaveLength(4);
  });

  it("still only the team", async () => {
    session = null;
    expect((await get("/admin/orders?limit=1")).status).toBe(401);
    session = { id: "u1", role: "user" };
    expect((await get("/admin/orders?limit=1")).status).toBe(403);
  });
});

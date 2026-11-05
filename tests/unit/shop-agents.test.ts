/**
 * kon-ecommerce — an agent with scope sees and operates orders
 * ============================================================================
 *
 * Phase D (e2e test over HTTP, 2026-10-25): an agent with `admin` passed the
 * app's policy (`can()` grants `shop-order:view` by scope) but the RLS
 * of `shop_orders` only let the human roles admin/editor through:
 * `GET /admin/orders` answered 200 with an empty list. Fixed by
 * 0004_agents_with_scope.sql; without it, these tests fail.
 *
 * REAL routes against PGlite with forced RLS and a non-superuser role.
 */

import type { PGlite } from "@electric-sql/pglite";
import { AppError } from "@kitsuden/engine";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { registerShopPolicies } from "../../kons/kon-ecommerce/shop.policy";
import { createShopRouter } from "../../kons/kon-ecommerce/shop.routes";

import { testAuth, dropToAppRole, migratedBase, requestAs } from "./helpers/safe-kons-bench";

let client: PGlite;
let requestValue: ReturnType<typeof requestAs>;
let request: string;

const agent = (...scopes: string[]) => ({ agent: scopes });

beforeAll(async () => {
  client = await migratedBase("kon-ecommerce", [
    "0001_shop.sql",
    "0002_secure_orders.sql",
    "0003_system_without_user.sql",
    "0004_agents_with_scope.sql",
    "0005_common_agent_rule.sql",
    "0008_checkout_delivery_coupons.sql",
  ]);
  await client.exec(`
    INSERT INTO shop_products (id, slug, name, kind, active) VALUES ('p1', 'ebook', 'Ebook', 'digital', true);
    INSERT INTO shop_variants (id, product_id, name, price_cents, currency, stock, active)
      VALUES ('v1', 'p1', 'Roja', 1000, 'EUR', 10, true);
  `);
  registerShopPolicies();
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as any, auth: auth as any });
  const app = host.mount(createShopRouter(ctx));
  // In the real API the core turns AppError into its status; here, the same.
  app.onError((err) =>
    err instanceof AppError
      ? Response.json({ error: err.message }, { status: err.status })
      : Response.json({ error: String(err) }, { status: 500 })
  );
  requestValue = requestAs(app);

  const res = await requestValue("anon", "POST", "/orders", {
    items: [{ variantId: "v1", quantity: 1 }],
    customerEmail: "comprador@example.com",
    fulfillmentType: "digital",
  });
  expect(res.status).toBe(201);
  request = (await res.json()).orderId;
});

afterAll(async () => {
  await client?.close();
});

describe("kon-ecommerce: agents with scope", () => {
  test("an `admin` agent lists and reads orders (before: empty list)", async () => {
    const list = await requestValue(agent("admin"), "GET", "/admin/orders");
    expect(list.status).toBe(200);
    expect((await list.json()).orders.map((o: { id: string }) => o.id)).toContain(request);
    expect((await requestValue(agent("admin"), "GET", `/admin/orders/${request}`)).status).toBe(200);
  });

  test("`shop-order:*` changes an order's status", async () => {
    const res = await requestValue(agent("shop-order:*"), "POST", `/admin/orders/${request}/status`, {
      status: "paid",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).order.status).toBe("delivered");
  });

  test("`shop-order:view` reads but does not change; without scope, 403", async () => {
    expect((await requestValue(agent("shop-order:view"), "GET", "/admin/orders")).status).toBe(200);
    expect(
      (await requestValue(agent("shop-order:view"), "POST", `/admin/orders/${request}/status`, { status: "refunded" }))
        .status
    ).toBe(403);
    const nullish = await requestValue(agent("mcp:connect"), "GET", "/admin/orders");
    expect(nullish.status).toBe(403);
  });

  test("RLS alone: an agent without an orders scope, or a human with scopes, sees no rows", async () => {
    const count = (role: string, scopes: string) =>
      client.transaction(async (tx) => {
        await tx.query(
          `select set_config('app.current_user_id', 'x', true),
                  set_config('app.current_user_role', $1, true),
                  set_config('app.agent_scopes', $2, true)`,
          [role, scopes]
        );
        return ((await tx.query("select count(*)::int as n from shop_orders")).rows[0] as { n: number }).n;
      });
    expect(await count("agent", "mcp:connect,!shop-order:*,admin")).toBe(0);
    expect(await count("user", "admin")).toBe(0);
    expect(await count("agent", "shop-order:view")).toBe(1);
  });
});

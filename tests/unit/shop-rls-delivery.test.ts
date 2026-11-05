/**
 * Row security of the shop's delivery and discount tables (0009)
 * ============================================================================
 *
 * The whole migration chain on PGlite with the core's agent functions, then a NON-superuser role
 * (with a superuser the policies filter nothing and this test would be decoration). License keys,
 * deliveries and "my orders" links are personal or paid-for data: a signed-in customer or an
 * anonymous request must read none of them through the generic surfaces, the team reads them, and
 * an agent only with the scope the app would grant it.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { dropToAppRole, migratedBase, sqlAs } from "./helpers/safe-kons-bench";

let client: PGlite;

const TABLES = [
  "shop_product_files",
  "shop_license_keys",
  "shop_entitlements",
  "shop_promotions",
  "shop_order_links",
] as const;

beforeAll(async () => {
  client = await migratedBase("kon-ecommerce", [
    "0001_shop.sql",
    "0002_secure_orders.sql",
    "0003_system_without_user.sql",
    "0004_agents_with_scope.sql",
    "0005_common_agent_rule.sql",
    "0006_english_names.sql",
    "0007_english_rls.sql",
    "0008_checkout_delivery_coupons.sql",
    "0009_rls_checkout_delivery.sql",
  ]);
  // As the owner, before dropping to the app role: one row in each table.
  await client.exec(`
    INSERT INTO shop_products (id, slug, name, kind, active) VALUES ('p1', 'ebook', 'Ebook', 'digital', true);
    INSERT INTO shop_variants (id, product_id, name, price_cents, currency, stock, active)
      VALUES ('v1', 'p1', 'Unica', 1000, 'EUR', NULL, true);
    INSERT INTO shop_orders (id, number, status, fulfillment_type, customer_email)
      VALUES ('o1', '2026-000001', 'delivered', 'digital', 'c@example.com');
    INSERT INTO shop_product_files (id, product_id, media_id, filename) VALUES ('f1', 'p1', 'm1', 'e.pdf');
    INSERT INTO shop_license_keys (id, variant_id, license_key) VALUES ('k1', 'v1', 'KEY-1');
    INSERT INTO shop_entitlements (id, order_id, kind, license_key) VALUES ('e1', 'o1', 'license', 'KEY-2');
    INSERT INTO shop_promotions (id, code, application_type, value) VALUES ('pr1', 'TEN', 'percentage', 10);
    INSERT INTO shop_order_links (token_hash, email, expires_at)
      VALUES ('h', 'c@example.com', now() + interval '1 hour');
  `);
  await dropToAppRole(client);
});

afterAll(async () => {
  await client?.close();
});

const count = async (actor: Parameters<typeof sqlAs>[1], table: string) =>
  Number(
    (await sqlAs<{ n: number }>(client, actor, `SELECT count(*)::int AS n FROM ${table}`))[0].n
  );

/** Counts as an agent with these scopes, the way the host sets them. */
async function countAsAgent(scopes: string, table: string): Promise<number> {
  return client.transaction(async (tx) => {
    await tx.query(
      `select set_config('app.current_user_id', 'agente-de-prueba', true),
              set_config('app.current_user_role', 'agent', true),
              set_config('app.agent_scopes', $1, true)`,
      [scopes]
    );
    const r = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return Number(r.rows[0].n);
  });
}

describe("0009", () => {
  test.each(TABLES)("%s: no anonymous request or customer reads it", async (table) => {
    expect(await count("anon", table)).toBe(0);
    expect(await count("a", table)).toBe(0);
  });

  test.each(TABLES)("%s: the team reads it", async (table) => {
    expect(await count("staff", table)).toBe(1);
    expect(await count("admin", table)).toBe(1);
  });

  test("an agent reads only what its scopes open", async () => {
    expect(await countAsAgent("blog:*", "shop_entitlements")).toBe(0);
    expect(await countAsAgent("shop-order:view", "shop_entitlements")).toBe(1);
    expect(await countAsAgent("shop-order:view", "shop_license_keys")).toBe(0);
    expect(await countAsAgent("shop-product:update", "shop_license_keys")).toBe(1);
    expect(await countAsAgent("shop-promotion:view", "shop_promotions")).toBe(1);
    // Nobody but the system and the team reads a buyer's link, not even an all-scopes agent.
    expect(await countAsAgent("ecommerce:*", "shop_order_links")).toBe(0);
  });
});

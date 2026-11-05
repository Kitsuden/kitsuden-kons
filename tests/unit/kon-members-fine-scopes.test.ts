/**
 * kon-members — a fine scope opens the rows its operation touches
 * ============================================================================
 *
 * An agent key with only `kon:members:list-members` passed the operation check, but row security
 * on `members` and `member_access` only knew `member:*`, `members:*`, `kon:members:*` and `admin`:
 * the list came back empty and records answered 404 (migrations/0007_fine_scope_rls.sql).
 *
 * REAL routes against PGlite with forced RLS and a non-superuser role; the test host sets
 * `app.agent_scopes` like the core.
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createKonMembers, registerMembersPolicy } from "../../kons/kon-members/index";

import { testAuth, dropToAppRole, migratedBase, requestAs } from "./helpers/safe-kons-bench";

const json = async (r: Response): Promise<any> => r.json();
const agent = (...scopes: string[]) => ({ agent: scopes });

const chain = readdirSync(resolve(__dirname, "../../kons/kon-members/migrations"))
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

let client: PGlite;
let request: ReturnType<typeof requestAs>;

beforeAll(async () => {
  registerMembersPolicy();
  client = await migratedBase("kon-members", chain);
  await client.exec(`
    INSERT INTO members (id, email) VALUES ('m-1', 'reader@example.com');
    INSERT INTO member_tiers (id, slug, name, level) VALUES ('tier_pro', 'pro', 'Pro', 2);
  `);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as any, auth: auth as any });
  request = requestAs(host.mount(createKonMembers(ctx)));
});
afterAll(async () => client?.close());

/** Grants of m-1, read as the superuser (outside row security). */
const grants = async () => {
  await client.exec("RESET ROLE");
  try {
    return (
      await client.query<{ tier_id: string; source: string; revoked: boolean }>(
        "SELECT tier_id, source, revoked_at IS NOT NULL AS revoked FROM member_access WHERE member_id = 'm-1' ORDER BY created_at"
      )
    ).rows;
  } finally {
    await client.exec("SET ROLE kon_safe_app");
  }
};

beforeEach(async () => {
  await client.exec("RESET ROLE; DELETE FROM member_access; SET ROLE kon_safe_app;");
});

describe("read scopes", () => {
  test("kon:members:list-members lists the members (before: empty)", async () => {
    const r = await request(agent("mcp:connect", "kon:members:list-members"), "GET", "/admin/members");
    expect(r.status).toBe(200);
    expect(JSON.stringify(await json(r))).toContain("reader@example.com");
  });

  test("kon:members:get-member reads the record (before: 404)", async () => {
    const r = await request(agent("mcp:connect", "kon:members:get-member"), "GET", "/admin/members/m-1");
    expect(r.status).toBe(200);
    expect((await json(r)).data.email).toBe("reader@example.com");
  });

  test("the wildcard form kon:members:* still works", async () => {
    const r = await request(agent("mcp:connect", "kon:members:*"), "GET", "/admin/members/m-1");
    expect(r.status).toBe(200);
  });

  test("a deny wins: the fine scope with !members:* sees nothing", async () => {
    const r = await request(
      agent("mcp:connect", "kon:members:list-members", "!members:*"),
      "GET",
      "/admin/members"
    );
    expect(r.status).toBe(403);
  });
});

describe("write scopes", () => {
  test("kon:members:gift-access gives access and marks the member comped", async () => {
    const r = await request(agent("mcp:connect", "kon:members:gift-access"), "POST", "/admin/access/comp", {
      memberId: "m-1",
      tierId: "tier_pro",
    });
    expect(r.status).toBe(200);
    expect(await grants()).toEqual([{ tier_id: "tier_pro", source: "comp", revoked: false }]);
  });

  test("kon:members:revoke-access revokes it", async () => {
    await client.exec(
      "RESET ROLE; INSERT INTO member_access (id, member_id, tier_id, source) VALUES ('a-1', 'm-1', 'tier_pro', 'comp'); SET ROLE kon_safe_app;"
    );
    const r = await request(agent("mcp:connect", "kon:members:revoke-access"), "POST", "/admin/access/revoke", {
      memberId: "m-1",
      tierId: "tier_pro",
    });
    expect(r.status).toBe(200);
    expect(await grants()).toEqual([{ tier_id: "tier_pro", source: "comp", revoked: true }]);
  });
});

describe("the database alone: a read scope never writes", () => {
  const as = (scopes: string, sql: string) =>
    client.transaction(async (tx) => {
      await tx.query(
        "select set_config('app.current_user_id', 'ag-1', true), set_config('app.current_user_role', 'agent', true), set_config('app.agent_scopes', $1, true)",
        [scopes]
      );
      return tx.query(sql);
    });

  test("kon:members:list-members reads members but cannot update them or read grants", async () => {
    const r: any = await as("kon:members:list-members", "SELECT count(*)::int AS n FROM members");
    expect(r.rows[0].n).toBe(1);
    const u: any = await as("kon:members:list-members", "UPDATE members SET note = 'x' RETURNING id");
    expect(u.rows).toHaveLength(0);
    const g: any = await as("kon:members:list-members", "SELECT count(*)::int AS n FROM member_access");
    expect(g.rows[0].n).toBe(0);
  });

  test("kon:members:revoke-access does not open members, and sessions stay closed to everyone", async () => {
    const u: any = await as("kon:members:revoke-access", "UPDATE members SET note = 'x' RETURNING id");
    expect(u.rows).toHaveLength(0);
    const s: any = await as("kon:members:*", "SELECT count(*)::int AS n FROM member_sessions");
    expect(s.rows[0].n).toBe(0);
  });
});

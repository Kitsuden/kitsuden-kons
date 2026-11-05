/**
 * kon-conta — an agent with scope works with the data the app opens to it
 * ============================================================================
 *
 * Phase D (e2e test over HTTP, 2026-10-25): an agent with `admin` or `conta:*`
 * passed the app's policy (`can()` grants `conta:<action>` by scope)
 * but RLS only knew the human role and `conta_permissions`: `GET /accounts`
 * answered 200 with `[]` and `POST /accounts` a 404. Migration
 * 0003_agents_with_scope.sql fixes it. Without it, these tests fail.
 *
 * REAL routes against PGlite with forced RLS and a non-superuser role; the
 * test host sets `app.agent_scopes` the same way the core does.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { contaOperations, createKonConta } from "../../kons/kon-conta/index";

import { testAuth, dropToAppRole, migratedBase, requestAs } from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
let ctx: ReturnType<typeof createTestKonContext>;

const agent = (...scopes: string[]) => ({ agent: scopes });

beforeAll(async () => {
  client = await migratedBase("kon-conta", [
    "0000_initial.sql",
    "0001_permissions_and_rls.sql",
    "0002_system_without_user.sql",
    "0003_agents_with_scope.sql",
    "0004_common_agent_rule.sql",
    "0005_english_names.sql",
    "0006_english_rls.sql",
    "0007_billing.sql",
    "0008_fine_scopes_in_rls.sql",
  ]);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  ctx = createTestKonContext({ db: host.db as any, auth: auth as any });
  request = requestAs(host.mount(createKonConta(ctx)));
  expect((await request("admin", "POST", "/seed")).status).toBe(200);
});

afterAll(async () => {
  await client?.close();
});

describe("kon-conta: agents with scope", () => {
  test("an `admin` agent sees the chart of accounts (before: 200 with an empty list)", async () => {
    const res = await request(agent("admin"), "GET", "/accounts");
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.some((x: { code: string }) => x.code === "1000")).toBe(true);
  });

  test("a `conta:*` agent creates an account and an entry, and posts it", async () => {
    const a = agent("mcp:connect", "conta:*");
    const cashBox = await request(a, "POST", "/accounts", { code: "AG-1", name: "Agent cash", type: "asset" });
    expect(cashBox.status).toBe(201);
    const sales = await request(a, "POST", "/accounts", { code: "AG-4", name: "Agent sales", type: "revenue" });
    expect(sales.status).toBe(201);
    const [c, v] = [(await cashBox.json()).data.id, (await sales.json()).data.id];
    const entry = await request(a, "POST", "/journals", {
      date: "2026-10-01",
      description: "sale by the agent",
      lines: [
        { accountId: c, debit: "10" },
        { accountId: v, credit: "10" },
      ],
    });
    expect(entry.status).toBe(201);
    const id = (await entry.json()).data.journal.id;
    expect((await request(a, "POST", `/journals/${id}/post`)).status).toBe(200);
    expect((await request(a, "POST", `/journals/${id}/reverse`, {})).status).toBe(200);
  });

  test("`conta:view` reads but does not write; without a conta scope, 403", async () => {
    const reader = agent("conta:view");
    const list = await request(reader, "GET", "/accounts");
    expect(list.status).toBe(200);
    expect((await list.json()).data.length).toBeGreaterThan(0);
    expect(
      (await request(reader, "POST", "/accounts", { code: "AG-X", name: "x", type: "asset" })).status
    ).toBe(403);
    expect((await request(agent("mcp:connect"), "GET", "/accounts")).status).toBe(403);
  });

  test("a denial wins: `conta:*` + `!conta:write` does not write", async () => {
    const a = agent("conta:*", "!conta:write");
    expect((await request(a, "GET", "/accounts")).status).toBe(200);
    expect(
      (await request(a, "POST", "/accounts", { code: "AG-D", name: "x", type: "asset" })).status
    ).toBe(403);
  });

  test("RLS alone: an agent without a conta scope sees no rows even if the app got it wrong", async () => {
    const rows = await client.transaction(async (tx) => {
      await tx.query(
        `select set_config('app.current_user_id', 'agent-x', true),
                set_config('app.current_user_role', 'agent', true),
                set_config('app.agent_scopes', 'mcp:connect,crm:*,!conta:*', true)`
      );
      return (await tx.query("select count(*)::int as n from conta_accounts")).rows as { n: number }[];
    });
    expect(rows[0].n).toBe(0);
    // and a human does NOT sneak in by setting scopes: the function requires role `agent`
    const human = await client.transaction(async (tx) => {
      await tx.query(
        `select set_config('app.current_user_id', 'human-x', true),
                set_config('app.current_user_role', 'user', true),
                set_config('app.agent_scopes', 'admin', true)`
      );
      return (await tx.query("select count(*)::int as n from conta_accounts")).rows as { n: number }[];
    });
    expect(human[0].n).toBe(0);
  });
});

// Fixed (0008_fine_scopes_in_rls and `grantedByFineScope` in conta.routes.ts): the fine scope of an
// operation (`kon:conta:<operation>`) was refused by the route's `conta` policy check (403) and, past
// it, by row security. Now both accept it, and a denial still wins.
describe("kon-conta: the fine scope of an operation", () => {
  test("`kon:conta:list-accounts` alone lists the accounts, and nothing else", async () => {
    const a = agent("mcp:connect", "kon:conta:list-accounts");
    const res = await request(a, "GET", "/accounts");
    expect(res.status).toBe(200);
    expect((await res.json()).data.some((x: { code: string }) => x.code === "1000")).toBe(true);
    expect(
      (await request(a, "POST", "/accounts", { code: "FS-X", name: "x", type: "asset" })).status
    ).toBe(403);
  });

  test("`kon:conta:create-account` alone creates an account", async () => {
    const res = await request(agent("kon:conta:create-account"), "POST", "/accounts", {
      code: "FS-1",
      name: "Created with a fine scope",
      type: "asset",
    });
    expect(res.status).toBe(201);
    expect((await client.query("select 1 from conta_accounts where code = 'FS-1'")).rows).toHaveLength(1);
  });

  test("a denial of the action or of the kon beats the fine scope", async () => {
    for (const denial of ["!conta:write", "!conta:*", "!kon:conta:create-account"]) {
      const res = await request(agent("kon:conta:create-account", denial), "POST", "/accounts", {
        code: "FS-D",
        name: "x",
        type: "asset",
      });
      expect(res.status, denial).toBe(403);
    }
    expect((await client.query("select 1 from conta_accounts where code = 'FS-D'")).rows).toHaveLength(0);
  });

  test("row security alone: a fine scope reads, and writes only with a write operation's scope", async () => {
    const count = (scopes: string) =>
      client.transaction(async (tx) => {
        await tx.query(
          `select set_config('app.current_user_id', 'agent-f', true),
                  set_config('app.current_user_role', 'agent', true),
                  set_config('app.agent_scopes', $1, true)`,
          [scopes]
        );
        const read = (await tx.query("select count(*)::int as n from conta_accounts")).rows as { n: number }[];
        const write = (await tx.query("select conta_agent_can('write') as w")).rows as { w: boolean }[];
        return { n: read[0].n, w: write[0].w };
      });
    expect(await count("kon:conta:list-accounts")).toMatchObject({ w: false });
    expect((await count("kon:conta:list-accounts")).n).toBeGreaterThan(0);
    expect(await count("kon:conta:create-account")).toMatchObject({ w: true });
    expect(await count("kon:conta:create-account,!conta:write")).toMatchObject({ w: false });
    expect(await count("kon:conta:list-accounts,!conta:*")).toEqual({ n: 0, w: false });
    expect(await count("kon:conta:not-an-operation")).toEqual({ n: 0, w: false });
  });

  test("the SQL map of operations to actions matches every operation the kon declares", async () => {
    const ops = contaOperations(ctx);
    expect(ops.length).toBeGreaterThan(100);
    for (const op of ops) {
      const declared = op.permission?.policy?.action ?? null;
      const { rows } = await client.query<{ a: string | null }>("select conta_operation_action($1) as a", [op.id]);
      expect(rows[0]!.a, op.id).toBe(declared);
    }
  });
});

/**
 * kon-conta — accounting only for the accountant role or admin
 * ============================================================================
 *
 * REAL kon routes against PGlite with forced RLS and a non-superuser
 * role (see helpers/safe-kons-bench.ts). What is pinned down:
 *
 *   1. Having an account does not open the ledger: anonymous 401, user/editor 403.
 *   2. The accountant role comes from `conta_permissions` and is granted ONLY by an admin;
 *      `viewer` reads but does not write.
 *   3. Allowlist: a field that is not in the schema is a 422.
 *   4. A posted entry is not edited, deleted, or reversed twice
 *      (before it unbalanced the balances without a trace).
 *   5. Errors carry no Postgres text.
 *   6. Template formulas do not execute code.
 *   7. RLS filters even if the route got it wrong.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createKonConta } from "../../kons/kon-conta/index";
import { evaluateFormula } from "../../kons/kon-conta/conta.service";

import {
  ACTORS,
  testAuth,
  dropToAppRole,
  migratedBase,
  requestAs,
  withoutInternalDetails,
  sqlAs,
} from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
let cashAccount: string;
let incomeAccount: string;

async function json(res: Response): Promise<any> {
  return res.json();
}

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
  const ctx = createTestKonContext({
    db: host.db as any,
    auth: auth as any,
  });
  const app = host.mount(createKonConta(ctx));
  request = requestAs(app);

  // The admin seeds the chart of accounts and grants the roles.
  expect((await request("admin", "POST", "/seed")).status).toBe(200);
  expect(
    (await request("admin", "PUT", `/permissions/${ACTORS.a.id}`, { role: "accountant" })).status
  ).toBe(200);
  expect(
    (await request("admin", "PUT", `/permissions/${ACTORS.member.id}`, { role: "viewer" })).status
  ).toBe(200);

  const { data } = await json(await request("a", "GET", "/accounts"));
  cashAccount = data.find((x: { code: string }) => x.code === "1000").id;
  incomeAccount = data.find((x: { code: string }) => x.code === "4000").id;
});

afterAll(async () => {
  await client?.close();
});

const entry = (status: "draft" | "posted" = "draft") => ({
  date: "2026-10-01",
  description: "Cobro de honorarios",
  status: status,
  lines: [
    { accountId: cashAccount, debit: "100.00", credit: "0" },
    { accountId: incomeAccount, debit: "0", credit: "100.00" },
  ],
});

describe("who gets in", () => {
  test("anonymous → 401 (and the landing page lists no data)", async () => {
    expect((await request("anon", "GET", "/accounts")).status).toBe(401);
    expect((await request("anon", "GET", "/journals")).status).toBe(401);
    expect((await request("anon", "GET", "/")).status).toBe(200);
  });

  test("any account (public sign-up) → 403 on read and write", async () => {
    expect((await request("b", "GET", "/accounts")).status).toBe(403);
    expect((await request("b", "GET", "/reports/balance-sheet")).status).toBe(403);
    expect((await request("b", "POST", "/journals", entry())).status).toBe(403);
  });

  test("being a site editor gives no access to accounting", async () => {
    expect((await request("staff", "GET", "/accounts")).status).toBe(403);
  });

  test("accountant reads and writes", async () => {
    expect((await request("a", "GET", "/accounts")).status).toBe(200);
    const res = await request("a", "POST", "/journals", entry());
    expect(res.status).toBe(201);
  });

  test("consulta reads and computes, but does not write", async () => {
    expect((await request("member", "GET", "/journals")).status).toBe(200);
    expect((await request("member", "POST", "/journals/validate", entry())).status).toBe(200);
    expect((await request("member", "POST", "/journals", entry())).status).toBe(403);
    expect(
      (await request("member", "PATCH", `/accounts/${cashAccount}`, { name: "Robada" })).status
    ).toBe(403);
  });

  test("only admin grants permissions and seeds; an accountant cannot promote themselves", async () => {
    expect((await request("a", "PUT", `/permissions/${ACTORS.b.id}`, { role: "accountant" })).status).toBe(
      403
    );
    expect((await request("a", "GET", "/permissions")).status).toBe(403);
    expect((await request("a", "POST", "/seed")).status).toBe(403);
    expect((await request("b", "GET", "/accounts")).status).toBe(403);
  });

  test("an agent needs the conta scope", async () => {
    expect((await request({ agent: ["blog:*"] }, "GET", "/accounts")).status).toBe(403);
    expect((await request({ agent: ["conta:view"] }, "GET", "/accounts")).status).toBe(200);
    expect((await request({ agent: ["conta:view"] }, "POST", "/journals", entry())).status).toBe(
      403
    );
  });
});

describe("allowlist of fields", () => {
  test("a field that is not in the schema is a 422, not ignored", async () => {
    const res = await request("a", "POST", "/accounts", {
      code: "9999",
      name: "Inventada",
      type: "asset",
      currentBalance: "1000000",
    });
    expect(res.status).toBe(422);
  });

  test("openingBalance can no longer be changed by PATCH", async () => {
    const res = await request("a", "PATCH", `/accounts/${cashAccount}`, { openingBalance: "5000" });
    expect(res.status).toBe(422);
  });

  test("an entry is no longer created already \"reversed\"", async () => {
    const res = await request("a", "POST", "/journals", { ...entry(), status: "reversed" });
    expect(res.status).toBe(422);
  });
});

describe("the general ledger is not rewritten", () => {
  test("a posted entry is neither edited nor deleted", async () => {
    const createdItem = await json(await request("a", "POST", "/journals", entry("posted")));
    const id = createdItem.data.journal.id;
    expect((await request("a", "PATCH", `/journals/${id}`, { description: "otra" })).status).toBe(
      409
    );
    expect((await request("a", "DELETE", `/journals/${id}`)).status).toBe(409);
  });

  test("a draft is not reversed; a posted one, only once", async () => {
    const draft = await json(await request("a", "POST", "/journals", entry("draft")));
    expect(
      (await request("a", "POST", `/journals/${draft.data.journal.id}/reverse`, {})).status
    ).toBe(409);

    const done = await json(await request("a", "POST", "/journals", entry("posted")));
    const id = done.data.journal.id;
    expect((await request("a", "POST", `/journals/${id}/reverse`, {})).status).toBe(200);
    expect((await request("a", "POST", `/journals/${id}/reverse`, {})).status).toBe(409);
  });
});

describe("errors without internals", () => {
  test("a nonexistent account gives a generic 400, without Postgres text", async () => {
    const res = await request("a", "POST", "/journals", {
      ...entry(),
      lines: [
        { accountId: "no-existe", debit: "5", credit: "0" },
        { accountId: incomeAccount, debit: "0", credit: "5" },
      ],
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(withoutInternalDetails(text)).toBe(true);
    expect(text).not.toContain("conta_");
  });

  test("a business error does explain what is happening", async () => {
    const res = await request("a", "POST", "/journals/inexistente/post");
    expect(res.status).toBe(404);
    expect((await json(res)).error.message).toBe("Journal not found");
  });
});

describe("template formulas without executing code", () => {
  test("correct arithmetic with Decimal", () => {
    expect(
      evaluateFormula("total * 0.1 + (amount - 2) / 4", { total: 100, amount: 10 }).toString()
    ).toBe("12");
  });

  test("what is not arithmetic is rejected", () => {
    for (const f of [
      "process.exit()",
      "constructor",
      "1;2",
      "this",
      "(".repeat(40) + "1" + ")".repeat(40),
    ]) {
      expect(() => evaluateFormula(f, {})).toThrow();
    }
    expect(() => evaluateFormula("1/0", {})).toThrow();
  });

  test("a variable named __proto__ pollutes nothing", () => {
    expect(evaluateFormula("total", JSON.parse('{"total": 3, "__proto__": 9}')).toString()).toBe(
      "3"
    );
  });
});

describe("RLS: the database filters even if the route failed", () => {
  test("without the accountant role, zero rows; with it, they see them; admin, all", async () => {
    const [{ n: deB }] = await sqlAs<{ n: number }>(
      client,
      "b",
      "select count(*)::int n from conta_accounts"
    );
    const [{ n: fromA }] = await sqlAs<{ n: number }>(
      client,
      "a",
      "select count(*)::int n from conta_accounts"
    );
    const [{ n: fromAdmin }] = await sqlAs<{ n: number }>(
      client,
      "admin",
      "select count(*)::int n from conta_accounts"
    );
    expect(deB).toBe(0);
    expect(fromA).toBeGreaterThan(0);
    expect(fromAdmin).toBe(fromA);
  });

  test("consulta cannot write even by hand", async () => {
    await expect(
      sqlAs(
        client,
        "member",
        "update conta_accounts set name = 'x' where code = '1000' returning id"
      )
    ).resolves.toHaveLength(0);
    await expect(
      sqlAs(
        client,
        "member",
        "insert into conta_currencies(code, name, symbol) values ('XXX','x','x')"
      )
    ).rejects.toThrow(/row-level security/);
  });

  test("nobody grants themselves the accountant role via SQL", async () => {
    await expect(
      sqlAs(
        client,
        "b",
        `insert into conta_permissions(user_id, role) values ('${ACTORS.b.id}', 'contable')`
      )
    ).rejects.toThrow(/row-level security/);
  });
});

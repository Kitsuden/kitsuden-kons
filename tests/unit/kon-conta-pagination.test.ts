/**
 * kon-conta — the billing lists that returned every row can be read a page at a time
 * ============================================================================
 *
 * `list-client-funds`, `list-recurring-fees` and `list-success-fees` take an optional `limit`
 * (1-500) and `offset` and answer `hasMore`. Without `limit` they answer every row, as before,
 * with `hasMore: false`. Summaries always cover every row that matches the filter, not the page.
 *
 * `list-accounts`, `list-counterparties`, `list-projects`, `list-disbursements` and
 * `list-client-funds-transactions` took a `limit` with no way past it. They keep that `limit` and
 * its default and take `offset`, with `hasMore`; without `offset` they answer what they did.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createKonConta } from "../../kons/kon-conta/index";

import { ACTORS, testAuth, dropToAppRole, migratedBase, requestAs } from "./helpers/safe-kons-bench";

const MIGRATIONS = [
  "0000_initial.sql",
  "0001_permissions_and_rls.sql",
  "0002_system_without_user.sql",
  "0003_agents_with_scope.sql",
  "0004_common_agent_rule.sql",
  "0005_english_names.sql",
  "0006_english_rls.sql",
  "0007_billing.sql",
  "0008_fine_scopes_in_rls.sql",
];

let client: PGlite;
let request: ReturnType<typeof requestAs>;
const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** Calls as the accountant and fails loudly with the body when the status is not the expected one. */
async function ok(method: string, route: string, body?: unknown, status?: number): Promise<any> {
  const res = await request("a", method, route, body);
  const json = await res.json();
  if (status ? res.status !== status : res.status >= 300) {
    throw new Error(`${method} ${route} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

beforeAll(async () => {
  client = await migratedBase("kon-conta", MIGRATIONS);
  const appDb = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(appDb, auth);
  const ctx = createTestKonContext({ db: host.db as any, auth: auth as any });
  request = requestAs(host.mount(createKonConta(ctx)));

  expect((await request("admin", "POST", "/seed")).status).toBe(200);
  expect((await request("admin", "PUT", `/permissions/${ACTORS.a.id}`, { role: "accountant" })).status).toBe(200);

  const clientA = (await ok("POST", "/counterparties", { name: "Example Client Ltd", type: "client" })).data.id;
  const clientB = (await ok("POST", "/counterparties", { name: "Second Sample Co", type: "client" })).data.id;
  const project = (await ok("POST", "/projects", { clientId: clientA, number: "P-001", name: "Redesign" })).data.id;

  await ok("POST", "/client-funds/deposits", { clientId: clientA, amount: "1000" }, 201);
  await ok("POST", "/client-funds/deposits", { clientId: clientB, amount: "300" }, 201);

  await ok("POST", "/recurring-fees", { clientId: clientA, concept: "Support A", amount: "1200", nextDate: TODAY }, 201);
  await ok("POST", "/recurring-fees", { clientId: clientB, concept: "Support B", amount: "600", nextDate: TODAY }, 201);

  await ok("POST", "/success-fees", { projectId: project, baseAmount: "10000", percentage: "0.1", probability: "0.5" }, 201);
  await ok("POST", "/success-fees", { projectId: project, baseAmount: "20000", percentage: "0.1", probability: "0.5" }, 201);

  await ok("POST", "/projects", { clientId: clientB, number: "P-002", name: "Audit" });
  const cash = (await ok("GET", "/accounts")).data.find((a: any) => a.code === "1000").id;
  for (const description of ["Court fee", "Courier"]) {
    await ok("POST", "/disbursements", { projectId: project, description, amount: "50", paidFromAccountId: cash }, 201);
  }
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("client funds", () => {
  test("limit=1 gives the largest balance and says there are more", async () => {
    const page = await ok("GET", "/client-funds?limit=1");
    expect(page.data).toHaveLength(1);
    expect(page.data[0].clientName).toBe("Example Client Ltd");
    expect(page.hasMore).toBe(true);
    const next = await ok("GET", "/client-funds?limit=1&offset=1");
    expect(next.data.map((r: any) => r.clientName)).toEqual(["Second Sample Co"]);
    expect(next.hasMore).toBe(false);
  });

  test("without limit, every client as before, and hasMore false", async () => {
    const all = await ok("GET", "/client-funds");
    expect(all.data).toHaveLength(2);
    expect(all.hasMore).toBe(false);
  });

  test("a limit out of range is refused", async () => {
    const res = await request("a", "GET", "/client-funds?limit=0");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("recurring and success fees", () => {
  test("recurring fees page, and the summary still covers every fee", async () => {
    const all = await ok("GET", "/recurring-fees");
    expect(all.data).toHaveLength(2);
    expect(all.hasMore).toBe(false);

    const page = await ok("GET", "/recurring-fees?limit=1");
    expect(page.data).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.summary).toEqual(all.summary);
    expect(page.summary.dueCount).toBe(2);
  });

  test("success fees page, and the totals still cover every open fee", async () => {
    const all = await ok("GET", "/success-fees");
    expect(all.data).toHaveLength(2);
    expect(all.hasMore).toBe(false);

    const page = await ok("GET", "/success-fees?limit=1");
    expect(page.data).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.summary).toEqual(all.summary);
  });
});

describe("lists that had a limit and no way past it", () => {
  const lists = [
    { route: "/accounts", rows: 3 },
    { route: "/counterparties", rows: 2 },
    { route: "/projects", rows: 2 },
    { route: "/disbursements", rows: 2 },
    { route: "/client-funds/transactions", rows: 2 },
  ];

  for (const { route, rows } of lists) {
    test(`${route}: no offset is the old answer; limit=1 and offset=1 walk it`, async () => {
      const all = await ok("GET", route);
      expect(all.data.length).toBeGreaterThanOrEqual(rows);
      expect(all.hasMore).toBe(false);

      const first = await ok("GET", `${route}?limit=1`);
      expect(first.data).toEqual([all.data[0]]);
      expect(first.hasMore).toBe(true);

      const second = await ok("GET", `${route}?limit=1&offset=1`);
      expect(second.data).toEqual([all.data[1]]);
      expect(second.hasMore).toBe(all.data.length > 2);

      const past = await ok("GET", `${route}?offset=${all.data.length}`);
      expect(past.data).toEqual([]);
      expect(past.hasMore).toBe(false);
    });
  }

  test("the statement's running balance does not depend on the page", async () => {
    const all = await ok("GET", "/client-funds/transactions");
    const second = await ok("GET", "/client-funds/transactions?limit=1&offset=1");
    expect(second.data[0].balance).toBe(all.data[1].balance);
  });

  test("a negative offset is refused", async () => {
    for (const route of ["/accounts", "/client-funds/transactions"]) {
      const res = await request("a", "GET", `${route}?offset=-1`);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });
});

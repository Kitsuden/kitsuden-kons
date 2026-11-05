/**
 * kon-conta — what a front end and another kon read: lists, summaries, attention, the grouped
 * income statement, and the bridge that keeps clients and projects in step
 * ============================================================================
 *
 * REAL kon routes on PGlite with every migration of the kon and a non-superuser role, so RLS runs
 * (helpers/safe-kons-bench.ts). Its own database: the order-dependent bench of
 * kon-conta-billing.test.ts is left alone. Dates are fixed and `asOf` is passed, so nothing depends
 * on the day the suite runs. What is pinned down:
 *
 *   1. ensureClient and ensureProject create once and then bring the row up to date; an unknown
 *      responsible leaves it as it is; a billing type not offered is refused.
 *   2. clientStatement: issued invoices only, newest first, and an unknown client owes nothing.
 *   3. list-invoices: new filters and sorts, rows with project and reminder and payment counts,
 *      `summary` over every page and `counts` per status that ignore the status filter.
 *   4. add-invoice-reminders: each invoice stands alone.
 *   5. get-invoice journals, a payment's attachment, list-journals lines, account filter and summary.
 *   6. The income statement by month and by quarter ties out to the ungrouped one.
 *   7. Issuer and targets are settings: admin only, merged, audited.
 *   8. get-attention, whole book and per responsible.
 *   9. Semiannual and annual recurring fees move by 6 and 12 months.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createKonConta } from "../../kons/kon-conta/index";
import { d } from "../../kons/kon-conta/conta.service";

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
const AS_OF = "2026-04-01";
const OTHER_USER = "Ot8hE2rU4sE6rI8dX0aB1cD3eF5gH7jK";

type Bridge = typeof import("../../kons/kon-conta/conta.bridge");
let bridge: Bridge;
let client: Awaited<ReturnType<typeof migratedBase>>;
let appDb: Awaited<ReturnType<typeof dropToAppRole>>;
let request: ReturnType<typeof requestAs>;
const acct: Record<string, string> = {};
const inv: Record<string, string> = {};
let clientA: string;
let clientB: string;
let projectA: string;
let projectB: string;
let lead: string;
let other: string;

const dec = (v: unknown) => d(String(v ?? 0));

async function call(actor: Parameters<typeof request>[0], method: string, route: string, body?: unknown) {
  const res = await request(actor, method, route, body);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function ok(method: string, route: string, body?: unknown, status?: number) {
  const r = await call("a", method, route, body);
  if (status ? r.status !== status : r.status >= 300) {
    throw new Error(`${method} ${route} → ${r.status}: ${JSON.stringify(r.json)}`);
  }
  return r.json;
}

async function issue(body: Record<string, unknown>) {
  return (await ok("POST", "/invoices", { issue: true, ...body }, 201)).data;
}

beforeAll(async () => {
  client = await migratedBase("kon-conta", MIGRATIONS);
  appDb = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(appDb, auth);
  const ctx = createTestKonContext({ db: host.db as any, auth: auth as any });
  request = requestAs(host.mount(createKonConta(ctx)));
  // The same runtime import another kon uses: the path is in a variable.
  const bridgePath = "../../kons/kon-conta/conta.bridge";
  bridge = (await import(/* @vite-ignore */ bridgePath)) as Bridge;

  expect((await call("admin", "POST", "/seed")).status).toBe(200);
  expect((await call("admin", "PUT", `/permissions/${ACTORS.a.id}`, { role: "accountant" })).status).toBe(200);
  expect((await call("admin", "PUT", `/permissions/${ACTORS.member.id}`, { role: "viewer" })).status).toBe(200);
  const { data: accounts } = await ok("GET", "/accounts");
  for (const a of accounts) acct[a.code] = a.id;

  lead = (await ok("POST", "/resources", { name: "Lead", billingRate: "100", userId: ACTORS.staff.id }, 201)).data.id;
  other = (await ok("POST", "/resources", { name: "Second", billingRate: "80", userId: OTHER_USER }, 201)).data.id;
  clientA = (
    await ok("POST", "/counterparties", { name: "Alpha Example", type: "client", externalRef: "co-A", fundsMinimum: "500" }, 201)
  ).data.id;
  projectA = (
    await ok("POST", "/projects", { clientId: clientA, number: "P-A", name: "Alpha work", billingType: "time", responsibleResourceId: lead }, 201)
  ).data.id;
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("the bridge keeps clients and projects in step", () => {
  test("ensureClient creates once, then updates only what it is given", async () => {
    const first = await bridge.ensureClient(appDb, { externalRef: "co-B", name: "Beta Co", fundsMinimum: "100", paymentTermsDays: 15 });
    expect(first.created).toBe(true);
    expect(first.client.type).toBe("client");
    clientB = first.client.id;

    const same = await bridge.ensureClient(appDb, { externalRef: "co-B", name: "Beta Co", fundsMinimum: 100 });
    expect(same.created).toBe(false);
    expect(same.client.updatedAt).toEqual(first.client.updatedAt);

    const renamed = await bridge.ensureClient(appDb, { externalRef: "co-B", name: "Beta Company", email: "billing@beta.example" });
    expect(renamed.client.id).toBe(clientB);
    expect(renamed.client.name).toBe("Beta Company");
    expect(renamed.client.email).toBe("billing@beta.example");
    expect(renamed.client.paymentTermsDays).toBe(15);
    expect(dec(renamed.client.fundsMinimum).toFixed(2)).toBe("100.00");

    await expect(bridge.ensureClient(appDb, { externalRef: "co-B", name: "x", paymentTermsDays: -1 })).rejects.toThrow(/paymentTermsDays/);
    await expect(bridge.ensureClient(appDb, { externalRef: "co-B", name: "x", fundsMinimum: "-5" })).rejects.toThrow(/fundsMinimum/);
  });

  test("list-counterparties filters by external reference", async () => {
    const { data } = await ok("GET", "/counterparties?externalRef=co-B");
    expect(data.map((c: { id: string }) => c.id)).toEqual([clientB]);
  });

  test("ensureProject sets the responsible, then updates name, type, category and responsible", async () => {
    const created = await bridge.ensureProject(appDb, {
      externalRef: "deal-B",
      name: "Beta setup",
      responsibleResourceUserId: OTHER_USER,
      client: { externalRef: "co-B", name: "ignored: the client exists" },
    });
    expect(created.created).toBe(true);
    expect(created.project.clientId).toBe(clientB);
    expect(created.project.responsibleResourceId).toBe(other);
    projectB = created.project.id;

    const unchanged = await bridge.ensureProject(appDb, { externalRef: "deal-B", name: "Beta setup", client: { externalRef: "co-B", name: "x" } });
    expect(unchanged.created).toBe(false);
    expect(unchanged.project.updatedAt).toEqual(created.project.updatedAt);

    const updated = await bridge.ensureProject(appDb, {
      externalRef: "deal-B",
      name: "Beta rollout",
      billingType: "fixed",
      category: "Setup",
      responsibleResourceUserId: ACTORS.staff.id,
      client: { externalRef: "co-B", name: "x" },
    });
    expect(updated.created).toBe(false);
    expect(updated.project).toMatchObject({ id: projectB, name: "Beta rollout", billingType: "fixed", category: "Setup", responsibleResourceId: lead });

    // A person with no resource: the responsible stays, and nothing fails.
    const unknown = await bridge.ensureProject(appDb, {
      externalRef: "deal-B",
      name: "Beta rollout",
      responsibleResourceUserId: "no-such-user",
      client: { externalRef: "co-B", name: "x" },
    });
    expect(unknown.project.responsibleResourceId).toBe(lead);

    // Back to the other resource and to time billing, for the rest of the file.
    await bridge.ensureProject(appDb, {
      externalRef: "deal-B",
      name: "Beta rollout",
      billingType: "time",
      responsibleResourceUserId: OTHER_USER,
      client: { externalRef: "co-B", name: "x" },
    });
  });

  test("a billing type the installation does not offer is refused on update too", async () => {
    await bridge.applyContaPreset(appDb, { billingTypes: ["time", "fixed"] });
    try {
      const refused = bridge.ensureProject(appDb, {
        externalRef: "deal-B",
        name: "Beta rollout",
        billingType: "success",
        client: { externalRef: "co-B", name: "x" },
      });
      await expect(refused).rejects.toMatchObject({ name: "AccountingError", status: 400 });
    } finally {
      await bridge.applyContaPreset(appDb, { billingTypes: ["time", "fixed", "recurring", "success"] });
    }
  });

  test("an unknown client owes nothing", async () => {
    expect(await bridge.clientStatement(appDb, { clientExternalRef: "co-nobody" })).toEqual({ balanceDue: "0.0000", invoices: [] });
  });
});

describe("invoices to read", () => {
  test("a book with every status", async () => {
    // Overdue more than 45 days on AS_OF.
    inv.old = (await issue({ clientId: clientA, projectId: projectA, issueDate: "2026-01-05", termsDays: 10, lines: [{ description: "January work", unitPrice: "1000" }] })).id;
    // Partly paid, overdue 11 days.
    inv.part = (await issue({ clientId: clientA, projectId: projectA, feeType: "fixed", issueDate: "2026-03-01", termsDays: 20, lines: [{ description: "Fixed fee", unitPrice: "500" }] })).id;
    // Pending: due after AS_OF.
    inv.pending = (await issue({ clientId: clientB, projectId: projectB, issueDate: "2026-03-20", termsDays: 30, lines: [{ description: "March work", unitPrice: "300" }] })).id;
    // Paid in full, no project.
    inv.paid = (await issue({ clientId: clientB, feeType: "fixed", issueDate: "2026-02-01", termsDays: 0, lines: [{ description: "Kick-off", unitPrice: "250" }] })).id;
    inv.void = (await issue({ clientId: clientB, projectId: projectB, issueDate: "2026-02-10", termsDays: 30, lines: [{ description: "Wrong", unitPrice: "400" }] })).id;
    inv.draft = (
      await ok("POST", "/invoices", { clientId: clientA, projectId: projectA, issueDate: "2026-03-25", termsDays: 30, lines: [{ description: "Not yet", unitPrice: "80" }] }, 201)
    ).data.id;

    const payment = await ok("POST", `/invoices/${inv.part}/payments`, { amount: "200", date: "2026-03-15", attachmentMediaId: "media-receipt-1" }, 201);
    expect(payment.data.payment.attachmentMediaId).toBe("media-receipt-1");
    await ok("POST", `/invoices/${inv.paid}/payments`, { amount: "250", date: "2026-02-05" }, 201);
    await ok("POST", `/invoices/${inv.void}/void`, { reason: "wrong amount" });
  });

  test("add-invoice-reminders records each invoice on its own", async () => {
    const { data } = await ok("POST", "/invoices/reminders", { invoiceIds: [inv.old, inv.part, inv.draft, "no-such-invoice", inv.old], channel: "email", date: "2026-03-28" }, 201);
    expect(data.recorded).toBe(2);
    expect(data.failed).toEqual([
      { invoiceId: inv.draft, reason: "Only an issued invoice takes reminders" },
      { invoiceId: "no-such-invoice", reason: "Invoice not found" },
    ]);
    expect((await call("member", "POST", "/invoices/reminders", { invoiceIds: [inv.old], channel: "email" })).status).toBe(403);
    expect((await call("a", "POST", "/invoices/reminders", { invoiceIds: [], channel: "email" })).status).toBeGreaterThanOrEqual(400);
  });

  test("rows carry project, reminders and payments; summary covers every page; counts ignore status", async () => {
    const res = await ok("GET", `/invoices?asOf=${AS_OF}&include=counts&limit=2`);
    expect(res.data).toHaveLength(2);
    expect(res.pagination.total).toBe(6);
    expect(res.summary).toEqual({ count: 6, total: "2530.0000", paid: "450.0000", balance: "1680.0000" });
    expect(res.counts).toEqual({ draft: 1, pending: 1, partial: 0, overdue: 2, paid: 1, void: 1, open: 3 });

    const open = await ok("GET", `/invoices?asOf=${AS_OF}&status=open&include=counts`);
    expect(open.summary).toEqual({ count: 3, total: "1800.0000", paid: "200.0000", balance: "1600.0000" });
    expect(open.counts.void).toBe(1);

    const part = open.data.find((r: { id: string }) => r.id === inv.part);
    expect(part).toMatchObject({
      projectName: "Alpha work",
      projectNumber: "P-A",
      reminderCount: 1,
      lastReminderOn: "2026-03-28",
      paymentCount: 1,
      displayStatus: "overdue",
      daysOverdue: 11,
    });
    expect(open.data.find((r: { id: string }) => r.id === inv.pending)).toMatchObject({ reminderCount: 0, lastReminderOn: null, paymentCount: 0 });
  });

  test("filters: fee type, responsible, due range; sorts by days overdue and balance", async () => {
    const ids = async (q: string) => (await ok("GET", `/invoices?asOf=${AS_OF}&${q}`)).data.map((r: { id: string }) => r.id);
    expect((await ids("feeType=fixed")).sort()).toEqual([inv.part, inv.paid].sort());
    expect((await ids(`responsibleResourceId=${lead}`)).sort()).toEqual([inv.old, inv.part, inv.draft].sort());
    // The voided one was due on 12 March: a due range does not look at the status.
    expect(await ids("dueFrom=2026-03-01&dueTo=2026-03-31")).toEqual([inv.part, inv.void]);
    expect(await ids("status=overdue&sort=daysOverdue&order=desc")).toEqual([inv.old, inv.part]);
    expect(await ids("status=overdue&sort=daysOverdue&order=asc")).toEqual([inv.part, inv.old]);
    // 300 and 300: the newer issue date comes first.
    expect(await ids("status=open&sort=balance&order=asc")).toEqual([inv.pending, inv.part, inv.old]);
    expect(await ids("sort=total&order=desc&limit=1")).toEqual([inv.old]);
    expect((await call("a", "GET", "/invoices?sort=client")).status).toBeGreaterThanOrEqual(400);
  });

  test("get-invoice: payments keep their attachment, and include=journals brings the books", async () => {
    const plain = (await ok("GET", `/invoices/${inv.part}`)).data;
    expect(plain.journals).toBeUndefined();
    expect(plain.payments[0].attachmentMediaId).toBe("media-receipt-1");

    const { data } = await ok("GET", `/invoices/${inv.part}?include=journals`);
    expect(data.journals.map((j: { journalType: string }) => j.journalType)).toEqual(["invoice", "payment"]);
    for (const journal of data.journals) {
      const debit = journal.lines.reduce((s: ReturnType<typeof d>, l: { debit: string }) => s.plus(l.debit), d(0));
      const credit = journal.lines.reduce((s: ReturnType<typeof d>, l: { credit: string }) => s.plus(l.credit), d(0));
      expect(debit.toFixed(4)).toBe(credit.toFixed(4));
      expect(Object.keys(journal.lines[0]).sort()).toEqual(["accountCode", "accountName", "credit", "debit"]);
    }
    expect(data.journals[0].lines[0]).toMatchObject({ accountCode: "1200", debit: "500.0000" });

    const voided = (await ok("GET", `/invoices/${inv.void}?include=journals`)).data;
    expect(voided.journals.map((j: { journalType: string }) => j.journalType)).toEqual(["invoice", "credit_note"]);
  });

  test("clientStatement: issued invoices only, newest first, with what is still owed", async () => {
    const statement = await bridge.clientStatement(appDb, { clientExternalRef: "co-B" });
    expect(statement.balanceDue).toBe("300.0000");
    expect(statement.invoices.map((i) => i.issueDate)).toEqual(["2026-03-20", "2026-02-01"]);
    expect(statement.invoices[0]).toMatchObject({ total: "300.0000", balance: "300.0000" });
    expect(statement.invoices[0]!.status).not.toBe("paid");
    expect(statement.invoices[1]).toMatchObject({ total: "250.0000", balance: "0.0000", status: "paid" });
    expect(Object.keys(statement.invoices[0]!).sort()).toEqual(["balance", "dueDate", "issueDate", "number", "status", "total"]);
  });
});

describe("journals and the income statement", () => {
  test("list-journals: account filter, summary over the filter, lines on request", async () => {
    await ok("POST", "/journals", {
      date: "2026-02-15",
      description: "Office rent",
      status: "posted",
      lines: [
        { accountId: acct["6000"], debit: "100" },
        { accountId: acct["1100"], credit: "100" },
      ],
    }, 201);

    const all = await ok("GET", "/journals?limit=1");
    expect(all.summary.count).toBe(all.pagination.total);
    expect(all.summary.debit).toBe(all.summary.credit);
    expect(all.data[0].lines).toBeUndefined();

    const receivable = await ok("GET", `/journals?accountId=${acct["1200"]}&include=lines&limit=200`);
    // Five issues, one credit note and two payments: every journal with a line on the account.
    expect(receivable.summary.count).toBe(8);
    expect(receivable.data).toHaveLength(8);
    for (const journal of receivable.data) {
      expect(journal.lines.some((l: { accountId: string; accountCode: string }) => l.accountId === acct["1200"] && l.accountCode === "1200")).toBe(true);
    }
    // Only the lines on the account count, so the summary is that account's movement.
    const { data: trial } = await ok("GET", "/reports/trial-balance");
    const row = trial.find((r: { account: { code: string } }) => r.account.code === "1200");
    expect(dec(receivable.summary.debit).minus(receivable.summary.credit).toFixed(4)).toBe(dec(row.balance).toFixed(4));
    expect((await call("a", "GET", "/journals?include=everything")).status).toBe(400);
  });

  test("by month: every period listed, the movement of each, and totals that tie out", async () => {
    const range = "dateFrom=2026-01-01&dateTo=2026-04-30";
    const { data } = await ok("GET", `/reports/profit-loss?${range}&groupBy=month`);
    expect(data.periods).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    const fees = data.accounts.find((a: { code: string }) => a.code === "4000");
    expect(fees.type).toBe("revenue");
    expect(fees.amounts).toEqual({ "2026-01": "1000.0000", "2026-02": "650.0000", "2026-03": "800.0000", "2026-04": "0.0000" });
    expect(fees.total).toBe("2450.0000");
    const rent = data.accounts.find((a: { code: string }) => a.code === "6000");
    expect(rent.amounts["2026-02"]).toBe("100.0000");
    expect(data.totals).toEqual({ income: "2450.0000", expense: "100.0000", net: "2350.0000", marginPct: 95.9 });

    const flat = (await ok("GET", `/reports/profit-loss?${range}`)).data;
    expect(flat.revenue).toBeDefined();
    expect(dec(flat.totalRevenue).toFixed(4)).toBe(data.totals.income);
    expect(dec(flat.totalExpenses).toFixed(4)).toBe(data.totals.expense);
  });

  test("by quarter, and the refusals", async () => {
    const { data } = await ok("GET", "/reports/profit-loss?dateFrom=2026-02-15&dateTo=2026-04-30&groupBy=quarter");
    expect(data.periods).toEqual(["2026-Q1", "2026-Q2"]);
    // From 15 February: January's invoice and February's earlier ones stay out.
    expect(data.accounts.find((a: { code: string }) => a.code === "4000").amounts).toEqual({ "2026-Q1": "800.0000", "2026-Q2": "0.0000" });
    expect((await call("a", "GET", "/reports/profit-loss?groupBy=week&dateFrom=2026-01-01&dateTo=2026-02-01")).status).toBe(400);
    expect((await call("a", "GET", "/reports/profit-loss?groupBy=month")).status).toBe(400);
    expect((await call("a", "GET", "/reports/profit-loss?groupBy=month&dateFrom=2026-05-01&dateTo=2026-01-01")).status).toBe(400);
    expect((await call("a", "GET", "/reports/profit-loss?groupBy=month&dateFrom=2000-01-01&dateTo=2026-01-01")).status).toBe(400);
  });
});

describe("issuer and targets are settings", () => {
  test("admin only, the issuer merges field by field, targets replace, and it is audited", async () => {
    const first = {
      issuer: { name: "Example Studio", taxId: "TAX-1", bankDetails: "Bank 0001" },
      targets: [{ metric: "billed", period: "month", amount: "10000" }],
    };
    expect((await call("a", "PATCH", "/settings", first)).status).toBe(403);
    expect((await call("admin", "PATCH", "/settings", first)).status).toBe(200);
    expect((await call("admin", "PATCH", "/settings", { issuer: { phone: "+00 000", taxId: "" } })).status).toBe(200);
    const targets = [
      { metric: "collected", period: "quarter", amount: "25000" },
      { metric: "billed", period: "year", amount: "120000.50" },
    ];
    expect((await call("admin", "PATCH", "/settings", { targets })).status).toBe(200);

    const { data } = await ok("GET", "/settings");
    expect(data.issuer).toEqual({ name: "Example Studio", taxId: "", bankDetails: "Bank 0001", phone: "+00 000" });
    expect(data.targets).toEqual(targets);
    expect((await call("admin", "PATCH", "/settings", { targets: [{ metric: "billed", period: "week", amount: "1" }] })).status).toBeGreaterThanOrEqual(400);

    const audit = (await ok("GET", "/audit?action=settings.updated")).data;
    expect(audit.some((a: { summary: string }) => a.summary.includes("issuer"))).toBe(true);
    expect(audit.some((a: { summary: string }) => a.summary.includes("targets"))).toBe(true);
  });
});

describe("what needs attention", () => {
  test("the whole book on a date", async () => {
    await ok("POST", "/client-funds/deposits", { clientId: clientB, amount: "150", date: "2026-02-01" }, 201);
    await ok("POST", "/recurring-fees", { clientId: clientA, concept: "Half-year support", amount: "600", frequency: "semiannual", nextDate: "2026-03-01" }, 201);
    await ok("POST", "/recurring-fees", { clientId: clientA, concept: "Yearly licence", amount: "1200", frequency: "annual", nextDate: "2026-06-01" }, 201);
    await ok("POST", "/bank-lines/import", {
      lines: [
        { date: "2026-03-30", description: "UNKNOWN CREDIT", reference: "R-1", amount: "12.00" },
        { date: "2026-05-01", description: "LATER CREDIT", reference: "R-2", amount: "5.00" },
      ],
    }, 201);

    const { data } = await ok("GET", `/attention?asOf=${AS_OF}`);
    expect(data.overdue.count).toBe(2);
    expect(data.overdue.amount).toBe("1300.0000");
    expect(data.overdue.items).toEqual([
      { invoiceId: inv.old, number: expect.any(String), clientName: "Alpha Example", balance: "1000.0000", daysOverdue: 76 },
      { invoiceId: inv.part, number: expect.any(String), clientName: "Alpha Example", balance: "300.0000", daysOverdue: 11 },
    ]);
    expect(data.severe).toEqual({ count: 1, amount: "1000.0000" });
    expect(data.drafts).toEqual({ count: 1, total: "80.0000" });
    expect(data.recurringDue).toEqual({ count: 1, amount: "600.0000" });
    // Alpha holds nothing against a minimum of 500; Beta holds 150 against 100.
    expect(data.fundsBelowMinimum).toEqual([{ clientId: clientA, name: "Alpha Example", balance: "0.0000", minimum: "500.0000" }]);
    expect(data.bankLinesPending).toEqual({ count: 1 });
    expect(data.closedUntil).toBeNull();

    expect((await ok("GET", `/attention?asOf=${AS_OF}&severeDays=90`)).data.severe.count).toBe(0);
  });

  test("per responsible, and who may read it", async () => {
    const { data } = await ok("GET", `/attention?asOf=${AS_OF}&responsibleResourceId=${other}`);
    expect(data.overdue).toEqual({ count: 0, amount: "0.0000", items: [] });
    expect(data.drafts.count).toBe(0);
    expect(data.recurringDue.count).toBe(0);
    expect(data.fundsBelowMinimum).toEqual([]);
    expect(data.bankLinesPending.count).toBe(1);

    const mine = (await ok("GET", `/attention?asOf=${AS_OF}&responsibleResourceId=${lead}`)).data;
    expect(mine.overdue.count).toBe(2);
    expect(mine.fundsBelowMinimum.map((f: { clientId: string }) => f.clientId)).toEqual([clientA]);

    expect((await call("member", "GET", "/attention")).status).toBe(200);
    expect((await call("b", "GET", "/attention")).status).toBe(403);
    expect((await call("anon", "GET", "/attention")).status).toBe(401);
  });
});

describe("semiannual and annual recurring fees", () => {
  test("each run moves the next date by its months, and the monthly figure divides by them", async () => {
    const list = await ok("GET", "/recurring-fees?active=true");
    // 600 every six months and 1200 a year: 100 + 100 a month.
    expect(list.summary.monthlyRecurring).toBe("200.0000");

    const run = await ok("POST", "/recurring-fees/run", { date: "2026-03-01" });
    expect(run.data.created).toHaveLength(1);
    expect(run.data.created[0].nextDate).toBe("2026-09-01");

    const yearly = list.data.find((f: { frequency: string }) => f.frequency === "annual");
    const billed = await ok("POST", `/recurring-fees/${yearly.id}/bill`, { date: "2026-06-01" }, 201);
    expect(billed.data.nextDate).toBe("2027-06-01");
    expect((await call("a", "POST", "/recurring-fees", { clientId: clientA, concept: "x", amount: "1", frequency: "weekly" })).status).toBeGreaterThanOrEqual(400);
  });

  test("the database takes the new frequencies and nothing else", async () => {
    const rows = await client.query<{ frequency: string }>("select distinct frequency from conta_recurring_fees order by 1");
    expect(rows.rows.map((r) => r.frequency)).toEqual(["annual", "semiannual"]);
    await expect(
      client.query(
        `insert into conta_recurring_fees (id, client_id, concept, amount, frequency, next_date, since) values ('rf-x', $1, 'x', 1, 'weekly', '2026-01-01', '2026-01-01')`,
        [clientA]
      )
    ).rejects.toThrow(/frequency_check/);
  });
});

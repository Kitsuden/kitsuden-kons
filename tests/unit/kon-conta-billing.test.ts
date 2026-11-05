/**
 * kon-conta — billing on the ledger, for any business that bills clients
 * ============================================================================
 *
 * REAL kon routes on PGlite with every migration of the kon and a non-superuser role, so RLS
 * runs (helpers/safe-kons-bench.ts). What is pinned down:
 *
 *   1. Issue, payment and void post balanced journals, through the one posting path.
 *   2. Partial payments keep the right balance, and nothing pays more than is owed.
 *   3. Client funds: nobody takes out more than that client holds, by any route.
 *   4. A closed period refuses postings, and only an admin reopens it.
 *   5. Anonymous, a plain account and a viewer cannot write.
 *   6. Report totals match the ledger.
 *   7. Work is quantity times rate in the resource's unit, and units are never added together.
 *   8. Labels and offered billing types are configuration, applied by a preset.
 *   9. Another kon records work and expenses through conta.bridge without importing the kon.
 *  10. A database at 0006 (matters, trust) upgrades in place to the generic names.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createKonConta } from "../../kons/kon-conta/index";
import { computeInvoiceTotals, suggestBankMatch } from "../../kons/kon-conta/conta.billing";
import { d } from "../../kons/kon-conta/conta.service";

import {
  ACTORS,
  AGENT_FUNCTIONS,
  testAuth,
  dropToAppRole,
  migratedBase,
  requestAs,
  sqlAs,
} from "./helpers/safe-kons-bench";

const BEFORE_BILLING = [
  "0000_initial.sql",
  "0001_permissions_and_rls.sql",
  "0002_system_without_user.sql",
  "0003_agents_with_scope.sql",
  "0004_common_agent_rule.sql",
  "0005_english_names.sql",
  "0006_english_rls.sql",
];
const MIGRATIONS = [...BEFORE_BILLING, "0007_billing.sql", "0008_fine_scopes_in_rls.sql"];

type Dec = ReturnType<typeof d>;
let client: PGlite;
let appDb: Awaited<ReturnType<typeof dropToAppRole>>;
let request: ReturnType<typeof requestAs>;
const acct: Record<string, string> = {};
let clientA: string;
let clientB: string;
let projectA: string;
let consultant: string;
let machine: string;
const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

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

/** Calls as the accountant and fails loudly with the body when the status is not the expected one. */
async function ok(method: string, route: string, body?: unknown, status?: number) {
  const r = await call("a", method, route, body);
  if (status ? r.status !== status : r.status >= 300) {
    throw new Error(`${method} ${route} → ${r.status}: ${JSON.stringify(r.json)}`);
  }
  return r.json;
}

async function journalLines(journalId: string) {
  const { data } = await ok("GET", `/journals/${journalId}`);
  return data.lines as Array<{ accountId: string; debit: string; credit: string }>;
}

function expectBalanced(lines: Array<{ debit: string; credit: string }>) {
  const debit = lines.reduce((s, l) => s.plus(l.debit), d(0));
  const credit = lines.reduce((s, l) => s.plus(l.credit), d(0));
  expect(debit.toFixed(4)).toBe(credit.toFixed(4));
  expect(debit.greaterThan(0)).toBe(true);
}

async function trial() {
  const { data } = await ok("GET", "/reports/trial-balance");
  const byCode: Record<string, { debit: Dec; credit: Dec; balance: Dec }> = {};
  for (const row of data) {
    byCode[row.account.code] = { debit: dec(row.totalDebit), credit: dec(row.totalCredit), balance: dec(row.balance) };
  }
  return byCode;
}

beforeAll(async () => {
  client = await migratedBase("kon-conta", MIGRATIONS);
  appDb = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(appDb, auth);
  const ctx = createTestKonContext({ db: host.db as any, auth: auth as any });
  request = requestAs(host.mount(createKonConta(ctx)));

  expect((await call("admin", "POST", "/seed")).status).toBe(200);
  expect((await call("admin", "PUT", `/permissions/${ACTORS.a.id}`, { role: "accountant" })).status).toBe(200);
  expect((await call("admin", "PUT", `/permissions/${ACTORS.member.id}`, { role: "viewer" })).status).toBe(200);
  // The tax rate is configuration: 7 % here, not a constant in the code.
  expect((await call("admin", "PATCH", "/settings", { defaultTaxRate: "0.07" })).status).toBe(200);

  const { data: accounts } = await ok("GET", "/accounts");
  for (const a of accounts) acct[a.code] = a.id;

  clientA = (await ok("POST", "/counterparties", { name: "Example Client Ltd", type: "client", paymentTermsDays: 30, fundsMinimum: "500" })).data.id;
  clientB = (await ok("POST", "/counterparties", { name: "Second Sample Co", type: "client" })).data.id;
  consultant = (
    await ok("POST", "/resources", { name: "Senior Consultant", title: "Consultant", billingRate: "200", costRate: "80", userId: ACTORS.staff.id })
  ).data.id;
  machine = (await ok("POST", "/resources", { name: "Cutting machine", unit: "day", billingRate: "300", costRate: "100" })).data.id;
  projectA = (
    await ok("POST", "/projects", {
      clientId: clientA,
      number: "P-001",
      name: "Website redesign",
      externalRef: "deal-001",
      category: "Consulting",
      responsibleResourceId: consultant,
    })
  ).data.id;
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("pure rules", () => {
  test("totals: tax on fees net of discount, expenses at cost", () => {
    const t = computeInvoiceTotals(
      [
        { kind: "fee", amount: "900" },
        { kind: "expense", amount: "50" },
      ],
      "100",
      "0.07",
      2
    );
    expect([t.fees, t.feesNet, t.tax, t.expenses, t.total].map((x) => x.toFixed(2))).toEqual([
      "900.00",
      "800.00",
      "56.00",
      "50.00",
      "906.00",
    ]);
  });

  test("bank suggestion: exact balance with the client's name is high confidence", () => {
    const open = [{ id: "i1", number: "INV-1", clientName: "Example Client Ltd", balance: d("906") }];
    expect(suggestBankMatch({ amount: "906", description: "TRANSFER EXAMPLE CLIENT" }, open, [])?.confidence).toBe("high");
    expect(suggestBankMatch({ amount: "-25", description: "MONTHLY FEE" }, open, ["FEE"])?.kind).toBe("fee");
    expect(suggestBankMatch({ amount: "12", description: "UNKNOWN DEPOSIT" }, open, [])).toBeNull();
  });
});

describe("work, invoice, payments and void", () => {
  let invoiceId: string;
  let workIds: string[] = [];
  let disbursementId: string;
  let firstPayment: string;
  let secondPayment: string;

  test("work and an expense wait as work in progress, each unit on its own", async () => {
    workIds = [
      (await ok("POST", "/work-entries", { projectId: projectA, resourceId: consultant, quantity: "3", description: "Design workshop" }, 201)).data.id,
      (await ok("POST", "/work-entries", { projectId: projectA, resourceId: consultant, quantity: "1.5", description: "Client call" }, 201)).data.id,
    ];
    const expense = await ok("POST", "/expenses", { projectId: projectA, description: "Courier", amount: "50", category: "Shipping" }, 201);
    expect(expense.data.kind).toBe("business");
    disbursementId = expense.data.disbursement.id;
    expectBalanced(await journalLines(expense.data.journal.id));

    const { data: wip } = await ok("GET", "/reports/wip");
    const group = wip.groups.find((g: { id: string }) => g.id === projectA);
    expect(group.quantities).toEqual({ hour: "4.5000" });
    expect(dec(group.workValue).toFixed(2)).toBe("900.00");
    expect(dec(group.expenseValue).toFixed(2)).toBe("50.00");
  });

  test("a draft from WIP posts nothing and empties the WIP", async () => {
    const before = (await ok("GET", "/journals?type=invoice")).pagination.total;
    const { data } = await ok(
      "POST",
      "/invoices",
      { clientId: clientA, projectId: projectA, workEntryIds: workIds, disbursementIds: [disbursementId], discount: "100" },
      201
    );
    invoiceId = data.id;
    expect(data.status).toBe("draft");
    expect(data.number).toBeNull();
    expect(data.lines.filter((l: { unit: string | null }) => l.unit === "hour")).toHaveLength(2);
    expect([data.feesNet, data.tax, data.expenses, data.total].map((x: string) => dec(x).toFixed(2))).toEqual([
      "800.00",
      "56.00",
      "50.00",
      "906.00",
    ]);
    expect((await ok("GET", "/journals?type=invoice")).pagination.total).toBe(before);
    const { data: wip } = await ok("GET", "/reports/wip");
    expect(wip.groups.find((g: { id: string }) => g.id === projectA)).toBeUndefined();
    // Already claimed by the draft: a second invoice cannot take it.
    expect((await call("a", "POST", "/invoices", { clientId: clientA, workEntryIds: [workIds[0]] })).status).toBe(409);
  });

  test("issue: a number and a balanced journal to receivable, revenue, reimbursable and tax", async () => {
    const { data } = await ok("POST", `/invoices/${invoiceId}/issue`, {});
    expect(data.status).toBe("issued");
    expect(data.number).toBe(`INV-${TODAY.slice(0, 4)}-0001`);
    const lines = await journalLines(data.journalId);
    expectBalanced(lines);
    const on = (code: string, side: "debit" | "credit") =>
      lines.filter((l) => l.accountId === acct[code]).reduce((s, l) => s.plus(l[side]), d(0)).toFixed(2);
    expect(on("1200", "debit")).toBe("906.00");
    expect(on("4000", "credit")).toBe("800.00");
    expect(on("1250", "credit")).toBe("50.00");
    expect(on("2200", "credit")).toBe("56.00");
    expect((await call("a", "POST", `/invoices/${invoiceId}/issue`, {})).status).toBe(409);
  });

  test("partial payments: balance, status, and no overpaying", async () => {
    const first = await ok("POST", `/invoices/${invoiceId}/payments`, { amount: "400", method: "transfer" }, 201);
    firstPayment = first.data.payment.id;
    expectBalanced(await journalLines(first.data.payment.journalId));
    expect(dec(first.data.invoice.balance).toFixed(2)).toBe("506.00");
    expect(first.data.invoice.displayStatus).toBe("partial");

    expect((await call("a", "POST", `/invoices/${invoiceId}/payments`, { amount: "506.01" })).status).toBe(409);

    const second = await ok("POST", `/invoices/${invoiceId}/payments`, { amount: "506" }, 201);
    secondPayment = second.data.payment.id;
    expect(second.data.invoice.displayStatus).toBe("paid");
    const { data: disb } = await ok("GET", `/disbursements/${disbursementId}`);
    expect(disb.status).toBe("paid");
  });

  test("void is refused while payments are live; reversing them reopens the balance", async () => {
    expect((await call("a", "POST", `/invoices/${invoiceId}/void`, { reason: "wrong client" })).status).toBe(409);
    const reversed = await ok("POST", `/payments/${secondPayment}/reverse`, { reason: "returned check" });
    expect(dec(reversed.data.invoice.balance).toFixed(2)).toBe("506.00");
    expect((await call("a", "POST", `/payments/${secondPayment}/reverse`, {})).status).toBe(409);
    await ok("POST", `/payments/${firstPayment}/reverse`, {});
  });

  test("void posts a balanced credit note, cancels the books and returns work to WIP", async () => {
    const { data } = await ok("POST", `/invoices/${invoiceId}/void`, { reason: "wrong client" });
    expect(data.invoice.status).toBe("void");
    expect(data.invoice.creditNoteNumber).toBe(`CN-${TODAY.slice(0, 4)}-0001`);
    expectBalanced(await journalLines(data.invoice.voidJournalId));

    const t = await trial();
    expect(t["4000"].balance.toFixed(2)).toBe("0.00");
    expect(t["1200"].balance.toFixed(2)).toBe("0.00");
    expect(t["2200"].balance.toFixed(2)).toBe("0.00");
    // The 50 the business advanced is still owed by the client, and is pending again.
    expect(t["1250"].balance.toFixed(2)).toBe("50.00");
    expect((await ok("GET", `/disbursements/${disbursementId}`)).data.status).toBe("pending");

    const { data: wip } = await ok("GET", "/reports/wip");
    expect(wip.groups.find((g: { id: string }) => g.id === projectA).quantities).toEqual({ hour: "4.5000" });

    const audit = await ok("GET", `/audit?entityType=invoice&entityId=${invoiceId}`);
    expect(audit.data.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(["invoice.drafted", "invoice.issued", "payment.recorded", "payment.reversed", "invoice.voided"])
    );
  });

  test("a draft is voided by deleting it, and its work goes back", async () => {
    const draft = await ok("POST", "/invoices", { clientId: clientA, projectId: projectA, workEntryIds: [workIds[0]] }, 201);
    const res = await ok("POST", `/invoices/${draft.data.id}/void`, {});
    expect(res.data.deleted).toBe(true);
    expect((await call("a", "GET", `/invoices/${draft.data.id}`)).status).toBe(404);
    const { data: entries } = await ok("GET", `/work-entries?projectId=${projectA}&unbilled=true`);
    expect(entries).toHaveLength(2);
  });

  test("a resource billed per day: its unit is kept apart and a wrong unit is refused", async () => {
    const wrong = await call("a", "POST", "/work-entries", { projectId: projectA, resourceId: machine, quantity: "2", unit: "hour", description: "Cutting" });
    expect(wrong.status).toBe(400);
    const entry = await ok("POST", "/work-entries", { projectId: projectA, resourceId: machine, quantity: "2", description: "Cutting" }, 201);
    expect(entry.data.unit).toBe("day");
    const { data: wip } = await ok("GET", "/reports/wip");
    const group = wip.groups.find((g: { id: string }) => g.id === projectA);
    expect(group.quantities).toEqual({ hour: "4.5000", day: "2.0000" });
    expect(dec(group.workValue).toFixed(2)).toBe("1500.00");
    await ok("DELETE", `/work-entries/${entry.data.id}`);
  });
});

describe("client funds", () => {
  test("deposit, disbursement and refund post balanced journals and keep the three-way check", async () => {
    const deposit = await ok("POST", "/client-funds/deposits", { clientId: clientA, projectId: projectA, amount: "1000", reference: "DEP-1" }, 201);
    expectBalanced(deposit.data.lines);
    expect(dec(deposit.data.balance).toFixed(2)).toBe("1000.00");
    const paid = await ok("POST", "/client-funds/disbursements", { clientId: clientA, amount: "600", payee: "Registry office" }, 201);
    expect(dec(paid.data.balance).toFixed(2)).toBe("400.00");
    const { data: recon } = await ok("GET", "/client-funds/reconciliation");
    expect(recon.balanced).toBe(true);
  });

  test("overdrawing a client is refused, even with another client's money in the bank", async () => {
    await ok("POST", "/client-funds/deposits", { clientId: clientB, amount: "5000" }, 201);
    const res = await call("a", "POST", "/client-funds/disbursements", { clientId: clientA, amount: "400.01" });
    expect(res.status).toBe(409);
    expect(res.json.error.message).toMatch(/overdraft/i);
    expect((await call("a", "POST", "/client-funds/refunds", { clientId: clientA, amount: "500" })).status).toBe(409);
    expect(
      (await call("a", "POST", "/expenses", { projectId: projectA, description: "Expert", amount: "450", paidFrom: "client_funds" })).status
    ).toBe(409);
  });

  test("the rule holds on manual journals too: no client named, or more than it holds", async () => {
    const lines = [
      { accountId: acct["2100"], debit: "1000" },
      { accountId: acct["1150"], credit: "1000" },
    ];
    const base = { date: TODAY, description: "manual client funds movement", status: "posted", lines };
    expect((await call("a", "POST", "/journals", base)).status).toBe(400);
    expect((await call("a", "POST", "/journals", { ...base, counterpartyId: clientA })).status).toBe(409);
  });

  test("an invoice paid from client funds needs the funds, and moves them out of that bank", async () => {
    const inv = await ok("POST", "/invoices", { clientId: clientA, issue: true, lines: [{ description: "Advice", unitPrice: "500" }] }, 201);
    expect(dec(inv.data.total).toFixed(2)).toBe("535.00");
    expect((await call("a", "POST", `/invoices/${inv.data.id}/payments`, { amount: "535", source: "client_funds" })).status).toBe(409);
    const pay = await ok("POST", `/invoices/${inv.data.id}/payments`, { amount: "400", source: "client_funds" }, 201);
    expectBalanced(await journalLines(pay.data.payment.journalId));
    const clients = (await ok("GET", "/client-funds")).data;
    const a = clients.find((c: { clientId: string }) => c.clientId === clientA);
    expect(dec(a.balance).toFixed(2)).toBe("0.00");
    expect(a.belowMinimum).toBe(true);
    expect((await ok("GET", "/client-funds/reconciliation")).data.balanced).toBe(true);
    const statement = (await ok("GET", `/client-funds/transactions?clientId=${clientA}`)).data;
    expect(dec(statement[0].balance).toFixed(2)).toBe("0.00");
    const byAccount = (await ok("GET", `/client-funds/balance?accountId=${acct["2100"]}`)).data;
    expect(dec(byAccount.balance).toFixed(2)).toBe("5000.00");
  });
});

describe("recurring fees, success fees and the bank", () => {
  test("running recurring fees bills each due one once", async () => {
    await ok("POST", "/recurring-fees", { clientId: clientB, concept: "Monthly support", amount: "1500", quantityIncluded: "10", nextDate: TODAY }, 201);
    const first = await ok("POST", "/recurring-fees/run", {});
    expect(first.data.created).toHaveLength(1);
    expect(first.data.created[0].invoice.feeType).toBe("recurring");
    expect(dec(first.data.created[0].invoice.total).toFixed(2)).toBe("1605.00");
    const lines = await journalLines(first.data.created[0].invoice.journalId);
    expect(lines.some((l) => l.accountId === acct["4100"] && dec(l.credit).toFixed(2) === "1500.00")).toBe(true);
    const again = await ok("POST", "/recurring-fees/run", {});
    expect(again.data.created).toHaveLength(0);
  });

  test("a won success fee bills its share on the success fee revenue account", async () => {
    const created = await ok("POST", "/success-fees", { projectId: projectA, baseAmount: "50000", percentage: "0.1", probability: "0.5" }, 201);
    expect(dec(created.data.weightedFee).toFixed(2)).toBe("2500.00");
    const settled = await ok("POST", `/success-fees/${created.data.id}/settle`, { outcome: "won", achievedAmount: "10000" });
    expect(settled.data.successFee.status).toBe("won");
    expect(dec(settled.data.invoice.feesNet).toFixed(2)).toBe("1000.00");
    const lines = await journalLines(settled.data.invoice.journalId);
    expect(lines.some((l) => l.accountId === acct["4200"])).toBe(true);
    expect((await call("a", "POST", `/success-fees/${created.data.id}/settle`, { outcome: "lost" })).status).toBe(409);
  });

  test("statement lines: import once, suggest, reconcile with real postings", async () => {
    const open = (await ok("GET", "/invoices?status=open")).data.find((i: { clientId: string }) => i.clientId === clientA);
    const lines = [
      { date: TODAY, description: "TRANSFER EXAMPLE CLIENT", reference: "B-1", amount: dec(open.balance).toFixed(2) },
      { date: TODAY, description: "MONTHLY MAINTENANCE FEE", reference: "B-2", amount: "-25.00" },
    ];
    expect((await ok("POST", "/bank-lines/import", { lines }, 201)).data.imported).toBe(2);
    expect((await ok("POST", "/bank-lines/import", { lines }, 201)).data.skipped).toBe(2);
    const pending = (await ok("GET", "/bank-lines?pending=true")).data;
    expect(pending.every((l: { suggestion: { confidence: string } }) => l.suggestion?.confidence === "high")).toBe(true);
    const result = await ok("POST", "/bank-lines/reconcile-suggested", {});
    expect(result.data.reconciled).toHaveLength(2);
    expect((await ok("GET", `/invoices/${open.id}`)).data.displayStatus).toBe("paid");
    expect((await ok("GET", "/bank-lines/summary")).data.pendingLines).toBe(0);
    expect((await trial())["6100"].balance.toFixed(2)).toBe("25.00");
  });
});

describe("reports match the postings", () => {
  test("aging ties out to the receivable account, by client too", async () => {
    const unbilled = (await ok("GET", `/work-entries?projectId=${projectA}&unbilled=true`)).data.map((t: { id: string }) => t.id);
    await ok("POST", "/invoices", { clientId: clientA, projectId: projectA, workEntryIds: unbilled, issue: true }, 201);
    const { data: aging } = await ok("GET", "/reports/aging");
    expect(aging.ledgerDifference).toBe("0.0000");
    expect(dec(aging.total).toFixed(4)).toBe(dec(aging.ledgerBalance).toFixed(4));
    expect(aging.buckets.reduce((s: Dec, b: { amount: string }) => s.plus(b.amount), d(0)).toFixed(4)).toBe(dec(aging.total).toFixed(4));
    const byClient = (await ok("GET", "/reports/aging-by-client")).data;
    expect(byClient.reduce((s: Dec, r: { total: string }) => s.plus(r.total), d(0)).toFixed(4)).toBe(dec(aging.total).toFixed(4));
  });

  test("the trial balance balances and revenue equals the fees of issued invoices", async () => {
    const t = await trial();
    const debit = Object.values(t).reduce((s, r) => s.plus(r.debit), d(0));
    const credit = Object.values(t).reduce((s, r) => s.plus(r.credit), d(0));
    expect(debit.toFixed(4)).toBe(credit.toFixed(4));

    const billed = (await ok("GET", "/reports/billing-by-client")).data.reduce((s: Dec, r: { billed: string }) => s.plus(r.billed), d(0));
    const revenue = t["4000"].balance.plus(t["4100"].balance).plus(t["4200"].balance);
    expect(revenue.toFixed(2)).toBe(billed.toFixed(2));

    const month = (await ok("GET", "/reports/monthly-series?months=1")).data[0];
    expect(dec(month.billed).toFixed(2)).toBe(billed.toFixed(2));
    expect(dec(month.expenses).toFixed(2)).toBe(t["6100"].balance.toFixed(2));

    const byCategory = (await ok("GET", "/reports/billing-by-category")).data;
    expect(byCategory.reduce((s: Dec, r: { billed: string }) => s.plus(r.billed), d(0)).toFixed(2)).toBe(billed.toFixed(2));
    expect(byCategory.some((r: { category: string }) => r.category === "Consulting")).toBe(true);

    const sheet = (await ok("GET", "/reports/balance-sheet")).data;
    expect(dec(sheet.totalAssets).toFixed(2)).toBe(dec(sheet.totalLiabilitiesAndEquity).toFixed(2));
  });

  test("profitability, DSO and performance read the same work and invoices", async () => {
    const projects = (await ok("GET", "/reports/profitability/projects")).data;
    const p = projects.find((r: { id: string }) => r.id === projectA);
    expect(p.quantities).toEqual([{ unit: "hour", worked: "4.5000", billed: "4.5000", unbilled: "0.0000" }]);
    expect(dec(p.cost).toFixed(2)).toBe("360.00");
    expect(p.realizationPct).toBe(100);
    const resources = (await ok("GET", "/reports/profitability/resources")).data;
    const r = resources.find((x: { id: string }) => x.id === consultant);
    expect(r.unit).toBe("hour");
    expect(dec(r.revenue).toFixed(2)).toBe("900.00");
    const dso = (await ok("GET", "/reports/dso")).data;
    expect(dso.invoices).toBeGreaterThan(0);
    const perf = (await ok("GET", "/reports/resource-performance")).data;
    expect(perf.find((x: { id: string }) => x.id === consultant).invoices).toBeGreaterThan(0);
  });
});

describe("closed periods", () => {
  let januaryJournal: string;

  test("only an accountant closes, and nothing posts on a closed date", async () => {
    const lines = [
      { accountId: acct["6000"], debit: "10" },
      { accountId: acct["1100"], credit: "10" },
    ];
    januaryJournal = (await ok("POST", "/journals", { date: "2026-01-15", description: "January rent", status: "posted", lines }, 201)).data.journal.id;

    expect((await call("member", "POST", "/periods/close", { until: "2026-01-31" })).status).toBe(403);
    expect((await call("a", "POST", "/periods/close", { until: "2099-01-31" })).status).toBe(400);
    expect((await ok("POST", "/periods/close", { until: "2026-01-31" })).data.lockedUntil).toBe("2026-01-31");

    const late = await call("a", "POST", "/journals", { date: "2026-01-20", description: "late", status: "posted", lines });
    expect(late.status).toBe(409);
    expect(late.json.error.message).toMatch(/closed/);
    const draft = await ok("POST", "/journals", { date: "2026-01-20", description: "late draft", lines }, 201);
    expect((await call("a", "POST", `/journals/${draft.data.journal.id}/post`)).status).toBe(409);
    expect((await call("a", "POST", `/journals/${januaryJournal}/reverse`, {})).status).toBe(409);
    expect((await call("a", "POST", "/client-funds/deposits", { clientId: clientB, amount: "1", date: "2026-01-10" })).status).toBe(409);
    expect(
      (await call("a", "POST", "/invoices", { clientId: clientB, issue: true, issueDate: "2026-01-10", lines: [{ description: "x", unitPrice: "1" }] })).status
    ).toBe(409);
    // A refusal leaves nothing behind: no orphan draft from the failed issue.
    expect((await ok("GET", "/invoices?status=draft")).data.filter((i: { issueDate: string }) => i.issueDate === "2026-01-10")).toHaveLength(0);
    // Reversing into an open date works.
    expect((await call("a", "POST", `/journals/${januaryJournal}/reverse`, { date: TODAY })).status).toBe(200);
  });

  test("only an admin reopens, and both steps are in the audit trail", async () => {
    expect((await call("a", "POST", "/periods/reopen", {})).status).toBe(403);
    expect((await call("admin", "POST", "/periods/reopen", {})).status).toBe(200);
    const actions = (await ok("GET", "/audit?entityType=period")).data.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["period.closed", "period.reopened"]));
  });
});

describe("labels and billing types are configuration", () => {
  test("get-settings returns generic labels by default", async () => {
    const { data } = await ok("GET", "/settings");
    expect(data.labels.project).toEqual({ singular: "Project", plural: "Projects" });
    expect(data.labels.clientFunds.singular).toBe("Client funds");
    expect(data.billingTypes).toEqual(["time", "fixed", "recurring", "success"]);
  });

  test("a preset renames what the installation shows, idempotently, and limits billing types", async () => {
    const bridgePath = "../../kons/kon-conta/conta.bridge";
    const { applyContaPreset } = (await import(/* @vite-ignore */ bridgePath)) as typeof import("../../kons/kon-conta/conta.bridge");
    const preset = {
      labels: { project: { singular: "Job", plural: "Jobs" }, resource: { singular: "Machine", plural: "Machines" } },
      billingTypes: ["time" as const, "fixed" as const],
    };
    expect((await applyContaPreset(appDb, preset)).changed).toBe(true);
    expect((await applyContaPreset(appDb, preset)).changed).toBe(false);
    const { data } = await ok("GET", "/settings");
    expect(data.labels.project.singular).toBe("Job");
    expect(data.labels.recurringFee.singular).toBe("Recurring fee");

    expect((await call("a", "POST", "/invoices", { clientId: clientB, feeType: "success", lines: [{ description: "x", unitPrice: "1" }] })).status).toBe(400);
    expect((await call("a", "POST", "/projects", { clientId: clientB, number: "P-REC", name: "x", billingType: "recurring" })).status).toBe(400);

    await applyContaPreset(appDb, {
      labels: { project: { singular: "Project", plural: "Projects" }, resource: { singular: "Resource", plural: "Resources" } },
      billingTypes: ["time", "fixed", "recurring", "success"],
    });
  });
});

describe("who can do what", () => {
  test("anonymous 401, a plain account 403, a viewer reads but does not write", async () => {
    expect((await call("anon", "GET", "/invoices")).status).toBe(401);
    expect((await call("b", "GET", "/invoices")).status).toBe(403);
    expect((await call("b", "POST", "/work-entries", { projectId: projectA, resourceId: consultant, quantity: "1", description: "x" })).status).toBe(403);
    expect((await call("member", "GET", "/invoices")).status).toBe(200);
    expect((await call("member", "GET", "/reports/aging")).status).toBe(200);
    expect((await call("member", "POST", "/invoices", { clientId: clientA, lines: [{ description: "x", unitPrice: "1" }] })).status).toBe(403);
    expect((await call("member", "POST", "/client-funds/deposits", { clientId: clientA, amount: "1" })).status).toBe(403);
    expect((await call("member", "PATCH", "/settings", { defaultTaxRate: "0" })).status).toBe(403);
    expect((await call("a", "PATCH", "/settings", { defaultTaxRate: "0" })).status).toBe(403);
    expect((await call({ agent: ["conta:view"] }, "GET", "/invoices")).status).toBe(200);
    expect((await call({ agent: ["conta:view"] }, "POST", "/client-funds/deposits", { clientId: clientA, amount: "1" })).status).toBe(403);
  });

  test("RLS: no rows for a plain account, no writes for a viewer, an audit trail nobody rewrites", async () => {
    const [{ n }] = await sqlAs<{ n: number }>(client, "b", "select count(*)::int n from conta_invoices");
    expect(n).toBe(0);
    await expect(sqlAs(client, "member", `insert into conta_resources(id, name) values ('x', 'x')`)).rejects.toThrow(/row-level security/);
    expect(await sqlAs(client, "a", "update conta_audit_log set summary = 'x' returning id")).toHaveLength(0);
    expect(await sqlAs(client, "admin", "delete from conta_audit_log returning id")).toHaveLength(0);
    const [{ n: kept }] = await sqlAs<{ n: number }>(client, "a", "select count(*)::int n from conta_audit_log");
    expect(kept).toBeGreaterThan(10);
  });
});

describe("another kon records work and expenses without importing kon-conta", () => {
  test("ensureProject, recordProjectWork and recordProjectExpense, idempotent by external reference", async () => {
    // The same runtime import kon-payments uses: the path is in a variable, nothing static.
    const bridgePath = "../../kons/kon-conta/conta.bridge";
    const bridge = (await import(/* @vite-ignore */ bridgePath)) as typeof import("../../kons/kon-conta/conta.bridge");

    // As the system (empty RLS context), which is what `ctx.db.asSystem` gives the calling kon.
    const { project, created } = await bridge.ensureProject(appDb, {
      externalRef: "deal-crm-42",
      name: "Office fit-out",
      client: { externalRef: "company-crm-7", name: "Third Example LLC" },
    });
    expect(created).toBe(true);
    expect(project.number).toBe("EXT-deal-crm-42");
    expect(
      (await bridge.ensureProject(appDb, { externalRef: "deal-crm-42", name: "x", client: { externalRef: "company-crm-7", name: "x" } })).created
    ).toBe(false);

    const input = {
      projectExternalRef: "deal-crm-42",
      resourceUserId: ACTORS.staff.id,
      quantity: "2.25",
      description: "Planning call",
      externalRef: "activity-crm-1001",
      createdBy: ACTORS.staff.id,
    };
    const first = await bridge.recordProjectWork(appDb, input);
    const again = await bridge.recordProjectWork(appDb, input);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.entry.id).toBe(first.entry.id);
    expect(first.entry.createdBy).toBe(ACTORS.staff.id);
    await expect(bridge.recordProjectWork(appDb, { ...input, externalRef: "activity-crm-1002", unit: "day" })).rejects.toThrow(/per hour/);

    const expense = { projectExternalRef: "deal-crm-42", description: "Courier", amount: "30", externalRef: "expense-crm-1" };
    expect((await bridge.recordProjectExpense(appDb, expense)).created).toBe(true);
    expect((await bridge.recordProjectExpense(appDb, expense)).created).toBe(false);

    const { data: wip } = await ok("GET", "/reports/wip");
    const group = wip.groups.find((g: { id: string }) => g.id === project.id);
    expect(group.quantities).toEqual({ hour: "2.2500" });
    expect(dec(group.expenseValue).toFixed(2)).toBe("30.00");
  });

  test("with a user's own context and no accounting role, the database refuses", async () => {
    await expect(
      client.transaction(async (tx) => {
        await tx.query(
          "select set_config('app.current_user_id', $1, true), set_config('app.current_user_role', 'user', true)",
          [ACTORS.b.id]
        );
        await tx.query(
          `insert into conta_work_entries(id, project_id, resource_id, date, description, quantity, billing_rate) values ('w-x', $1, $2, $3, 'x', 1, 1)`,
          [projectA, consultant, TODAY]
        );
      })
    ).rejects.toThrow(/row-level security/);
  });
});

describe("a database at 0006 upgrades in place", () => {
  test("matters, trust names and stored scopes become generic, and the data stays", async () => {
    const old = new PGlite();
    try {
      await old.exec(readFileSync(AGENT_FUNCTIONS, "utf8"));
      const file = (name: string) => readFileSync(resolve(__dirname, "../../kons/kon-conta/migrations", name), "utf8");
      for (const m of BEFORE_BILLING) await old.exec(file(m));
      await old.exec(`
        CREATE TABLE agent_identities (id text PRIMARY KEY, scopes jsonb, allowed_tools jsonb);
        INSERT INTO agent_identities VALUES
          ('ag1', '["conta:view", "kon:conta:list-matters", "!kon:conta:get-trust-balance"]', '["conta__get-matter"]');
        INSERT INTO conta_currencies (code, name, symbol) VALUES ('USD', 'US Dollar', '$');
        INSERT INTO conta_counterparties (id, name, type) VALUES ('c1', 'Old Client', 'client');
        INSERT INTO conta_matters (id, client_id, matter_number, name) VALUES ('m1', 'c1', 'OLD-1', 'Old project');
        INSERT INTO conta_accounts (id, code, name, type, is_trust_account) VALUES
          ('a1', '2100', 'Client Trust Funds', 'liability', true),
          ('a2', '1150', 'Bank - Trust', 'asset', true);
        INSERT INTO conta_journals (id, date, description, status, journal_type) VALUES ('j1', '2026-01-01', 'old deposit', 'posted', 'trust_deposit');
        INSERT INTO conta_ledger_entries (id, journal_id, account_id, matter_id, debit, credit) VALUES
          ('l1', 'j1', 'a2', 'm1', 10, 0), ('l2', 'j1', 'a1', 'm1', 0, 10);
      `);

      // Twice: the second run must change nothing and fail on nothing.
      await old.exec(file("0007_billing.sql"));
      await old.exec(file("0007_billing.sql"));

      const one = async (q: string) => (await old.query<Record<string, unknown>>(q)).rows[0];
      expect(await one("select to_regclass('public.conta_matters') is null as gone")).toEqual({ gone: true });
      expect(await one("select number, name from conta_projects where id = 'm1'")).toEqual({ number: "OLD-1", name: "Old project" });
      expect(await one("select count(*)::int n from conta_ledger_entries where project_id = 'm1'")).toEqual({ n: 2 });
      expect(await one("select journal_type::text t from conta_journals where id = 'j1'")).toEqual({ t: "client_funds_deposit" });
      expect(await one("select name, is_client_funds_account f from conta_accounts where id = 'a1'")).toEqual({
        name: "Client Funds Held",
        f: true,
      });
      expect(await one("select scopes, allowed_tools from agent_identities where id = 'ag1'")).toEqual({
        scopes: ["conta:view", "kon:conta:list-projects", "!kon:conta:get-client-funds-balance"],
        allowed_tools: ["conta__get-project"],
      });
      expect(await one("select count(*)::int n from pg_type where typname = 'conta_matter_status'")).toEqual({ n: 0 });
      expect(
        await one("select count(*) filter (where policyname like 'conta_matters%')::int old, count(*)::int total from pg_policies where tablename = 'conta_projects'")
      ).toEqual({ old: 0, total: 8 });
      expect(await one("select count(*)::int n from pg_constraint where conname like '%matter%'")).toEqual({ n: 0 });
    } finally {
      await old.close();
    }
  });
});

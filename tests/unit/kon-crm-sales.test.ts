/**
 * kon-crm sells: product lines, quotes, forecast and targets, and a CSV import that finds duplicates
 * ============================================================================
 *
 * Every kon-crm migration and the core's `kitsuden_links` on PGlite, as the NON-superuser app role, through
 * the CRM's own router and row security. kon-payments is a double behind `useQuotePaymentGateway`.
 *
 * What these tests hold:
 *   - a line's price is frozen when it is added, and the deal's value is the total of its lines;
 *   - a quote is a snapshot: changing the deal afterwards does not change it;
 *   - a quote moves draft → sent → accepted/rejected and nowhere else;
 *   - accepting with `then: payment` opens a payment for the quote's total, and that payment, when it
 *     arrives, marks the quote paid and lands on the deal's timeline;
 *   - the forecast weights open deals by probability and compares what was won with the target;
 *   - an import row with another email but the same phone and name is a `duplicate`, not a new contact;
 *   - someone who may only see their assigned deals does not see another deal's lines or quotes.
 */

import type { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { onPayment } from "../../kons/kon-crm/crm.connected";
import { useCrmEvents } from "../../kons/kon-crm/crm.events";
import { registerCrmPolicy } from "../../kons/kon-crm/crm.policy";
import { createCRMRouter } from "../../kons/kon-crm/crm.routes";
import { lineAmounts, quoteTotals, useQuotePaymentGateway } from "../../kons/kon-crm/crm.sales";
import { timelineOf } from "../../kons/kon-crm/crm.timeline";

import { APP_ROLE, dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

let client: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a drizzle over PGlite
let db: any;
let request: ReturnType<typeof requestAs>;
const emitted: Array<{ name: string; data: Record<string, unknown> }> = [];
const opened: Array<{ provider: string; input: Record<string, unknown> }> = [];
const json = async (res: Response): Promise<any> => res.json();

async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  await client.exec("RESET ROLE");
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.exec(`SET ROLE ${APP_ROLE}`);
  }
}

beforeAll(async () => {
  const dir = resolve(__dirname, "../../kons/kon-crm/migrations");
  client = await migratedBase("kon-crm", readdirSync(dir).filter((f) => f.endsWith(".sql")).sort());
  await client.exec(readFileSync(resolve(__dirname, "../../.kitsuden/apps/api/src/db/migrations/0032_links.sql"), "utf8"));
  await client.exec(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
    INSERT INTO crm_pipelines (id, name) VALUES ('p1', 'Sales');
    INSERT INTO crm_pipeline_stages (id, pipeline_id, name, "order") VALUES ('s1', 'p1', 'Lead', 0);
    INSERT INTO crm_contacts (id, first_name, last_name, email, phone) VALUES ('c1', 'Ana', 'Ortega', 'ana@client.example', '+51 999 111 222');
    INSERT INTO crm_deals (id, title, pipeline_id, stage_id, contact_id, assigned_to, probability, expected_close_date, currency)
      VALUES ('d1', 'Licenses', 'p1', 's1', 'c1', 'u-seller', 50, '2026-12-10', 'USD');
    INSERT INTO crm_deals (id, title, pipeline_id, stage_id, contact_id, assigned_to, status, value, actual_close_date)
      VALUES ('d-won', 'Won one', 'p1', 's1', 'c1', 'u-seller', 'won', 30000, '2026-12-02');
  `);
  db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const events = { emit: (name: string, data: Record<string, unknown>) => emitted.push({ name, data }), on: () => undefined, off: () => undefined };
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never, events: events as never });
  request = requestAs(host.mount(createCRMRouter(ctx)));
  useCrmEvents(events as never);
  useQuotePaymentGateway(async () => ({
    providers: () => ["stripe"],
    open: async (provider, input) => {
      opened.push({ provider, input: input as never });
      return { ok: true, session: { url: "https://checkout.example/s/1", id: "cs_1" } };
    },
  }));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerCrmPolicy();
  emitted.length = 0;
});

describe("arithmetic", () => {
  it("discounts the gross, taxes the net, rounds each step once", () => {
    expect(lineAmounts(3, 1999, 10, 18)).toEqual({ net: 5397, tax: 971, total: 6368 });
    expect(quoteTotals([{ quantity: 1, unitPrice: 1000, discountPct: 0, taxPct: 0 }, { quantity: 2, unitPrice: 250, discountPct: 50, taxPct: 10 }])).toEqual({
      subtotal: 1250,
      tax: 25,
      total: 1275,
    });
  });
});

describe("lines and quotes", () => {
  let quoteId: string;

  it("a line freezes its price and the deal's value becomes the lines' total", async () => {
    const add = await request("staff", "POST", "/deals/d1/lines", {
      name: "Pro license",
      productType: "shop_variants",
      productId: "v-pro",
      quantity: 3,
      unitPrice: 1999,
      discountPct: 10,
      taxPct: 18,
    });
    expect(add.status).toBe(201);
    const line = (await json(add)).data;
    expect(line.lineTotal).toBe(6368);
    expect(await q(`SELECT value FROM crm_deals WHERE id = 'd1'`)).toEqual([{ value: 6368 }]);

    // A product without the other half of its shape is refused.
    expect((await request("staff", "POST", "/deals/d1/lines", { name: "x", productType: "shop_variants", quantity: 1, unitPrice: 1 })).status).toBe(422);
    // The price is not editable afterwards: unknown field.
    expect((await request("staff", "PATCH", `/deal-lines/${line.id}`, { unitPrice: 1 })).status).toBe(422);
    expect((await request("staff", "PATCH", `/deal-lines/${line.id}`, { quantity: 4 })).status).toBe(200);
    expect(await q(`SELECT value FROM crm_deals WHERE id = 'd1'`)).toEqual([{ value: lineAmounts(4, 1999, 10, 18).total }]);
  });

  it("a quote is a numbered snapshot that later changes do not touch", async () => {
    const made = await request("staff", "POST", "/deals/d1/quotes", { validUntil: "2026-12-31" });
    expect(made.status).toBe(201);
    const quote = (await json(made)).data;
    quoteId = quote.id;
    expect(quote).toMatchObject({ number: "Q-0001", status: "draft", total: lineAmounts(4, 1999, 10, 18).total, currency: "USD" });
    await request("staff", "POST", "/deals/d1/lines", { name: "Support", quantity: 1, unitPrice: 50000 });
    const again = (await json(await request("staff", "GET", `/quotes/${quoteId}`))).data;
    expect(again.lines).toHaveLength(1);
    expect(again.total).toBe(quote.total);
  });

  it("moves draft → sent → accepted, and refuses going back", async () => {
    expect((await request("staff", "POST", `/quotes/${quoteId}/reject`)).status).toBe(409);
    expect((await request("staff", "POST", `/quotes/${quoteId}/send`)).status).toBe(200);
    expect((await request("staff", "POST", `/quotes/${quoteId}/send`)).status).toBe(409);
    expect(emitted.map((e) => e.name)).toContain("crm:quote.sent");
  });

  it("accepting with a payment opens one for the quote's total, and the payment marks it paid", async () => {
    expect((await request("staff", "POST", `/quotes/${quoteId}/accept`, { then: "payment" })).status).toBe(422);
    const res = await request("staff", "POST", `/quotes/${quoteId}/accept`, { then: "payment", provider: "stripe", successUrl: "https://site.example/thanks" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.checkoutUrl).toBe("https://checkout.example/s/1");
    expect(body.data).toMatchObject({ status: "accepted", outcome: "payment", outcomeRef: "cs_1" });
    expect(opened.at(-1)!.input).toMatchObject({
      lines: [{ name: "Quote Q-0001", unitAmount: body.data.total, quantity: 1 }],
      customerEmail: "ana@client.example",
      metadata: { crmQuoteId: quoteId, crmDealId: "d1" },
    });
    const accepted = emitted.find((e) => e.name === "crm:quote.accepted")!.data;
    expect(accepted).toMatchObject({ then: "payment", customerEmail: "ana@client.example" });

    // The payment arrives (kon-payments' event, as the CRM's listener gets it).
    await onPayment(db, "succeeded", {
      paymentEventId: "pe-quote",
      event: { provider: "stripe", paymentId: "pi_1", customerEmail: "ana@client.example", money: { amount: body.data.total, currency: "USD" }, metadata: { crmQuoteId: quoteId } },
    });
    const [paid] = await q<{ paid_at: Date | null; outcome_ref: string }>(`SELECT paid_at, outcome_ref FROM crm_quotes WHERE id = '${quoteId}'`);
    expect(paid!.paid_at).not.toBeNull();
    expect(paid!.outcome_ref).toBe("pi_1");
    const timeline = await timelineOf(db, { dealId: "d1" });
    expect(timeline).toContainEqual(expect.objectContaining({ kind: "link", type: "pay_events", summary: expect.objectContaining({ kind: "quote-payment", quoteId }) }));
  });

  it("a deal without lines has no quote", async () => {
    expect((await request("staff", "POST", "/deals/d-won/quotes", {})).status).toBe(422);
  });
});

describe("forecast and targets", () => {
  it("weights open deals by probability and compares the won value with the target", async () => {
    expect((await request("staff", "PUT", "/targets", { userId: "u-seller", periodStart: "2026-12-01", periodEnd: "2026-12-31", amount: 60000 })).status).toBe(403);
    expect((await request("admin", "PUT", "/targets", { userId: "u-seller", periodStart: "2026-12-01", periodEnd: "2026-12-31", amount: 60000 })).status).toBe(200);
    const forecastRes = await request("staff", "GET", "/forecast?from=2026-12-01&to=2026-12-31");
    const forecastBody = await json(forecastRes);
    const [row] = forecastBody.data;
    const value = (await q<{ value: number }>(`SELECT value FROM crm_deals WHERE id = 'd1'`))[0]!.value;
    expect(row).toMatchObject({
      userId: "u-seller",
      openDeals: 1,
      openValue: value,
      weightedValue: Math.round(value / 2),
      wonDeals: 1,
      wonValue: 30000,
      target: 60000,
      attainment: 50,
    });
  });
});

describe("the import finds duplicates", () => {
  it("another email but the same phone and name is a duplicate of the contact, not a new one", async () => {
    const csv = "email,first_name,last_name,phone\nana.o@other.example,Ana,Ortega,+51 999 111 222\nnew@person.example,Nuevo,Contacto,\n";
    const preview = await json(await request("staff", "POST", "/contacts/import", { csv }));
    expect(preview.rows).toEqual([
      { row: 2, email: "ana.o@other.example", status: "duplicate", match: { id: "c1", rating: 85, reasons: ["same phone", "same name"] } },
      { row: 3, email: "new@person.example", status: "new" },
    ]);
    await request("staff", "POST", "/contacts/import", { csv, apply: true });
    expect(await q(`SELECT 1 FROM crm_contacts WHERE email = 'ana.o@other.example'`)).toEqual([]);
    expect(await q(`SELECT 1 FROM crm_contacts WHERE email = 'new@person.example'`)).toHaveLength(1);
  });
});

describe("the CRM's reports", () => {
  beforeAll(async () => {
    await client.exec(`
      RESET ROLE;
      INSERT INTO crm_pipelines (id, name) VALUES ('p2', 'Reports');
      INSERT INTO crm_pipeline_stages (id, pipeline_id, name, "order") VALUES ('r1', 'p2', 'Lead', 0), ('r2', 'p2', 'Proposal', 1), ('r3', 'p2', 'Closing', 2);
      INSERT INTO crm_deals (id, title, pipeline_id, stage_id, value, status, lost_reason) VALUES
        ('x1', 'A', 'p2', 'r1', 100, 'open', NULL),
        ('x2', 'B', 'p2', 'r2', 200, 'open', NULL),
        ('x3', 'C', 'p2', 'r3', 300, 'won', NULL),
        ('x4', 'D', 'p2', 'r2', 400, 'lost', 'price'),
        ('x5', 'E', 'p2', 'r1', 500, 'lost', 'price');
      INSERT INTO crm_stage_transitions (id, deal_id, from_stage_id, to_stage_id) VALUES
        ('tx1', 'x2', 'r1', 'r2'), ('tx2', 'x3', 'r1', 'r2'), ('tx3', 'x3', 'r2', 'r3'), ('tx4', 'x4', 'r1', 'r2');
      SET ROLE ${APP_ROLE};
    `);
  });

  it("the funnel counts open deals per stage, in stage order", async () => {
    const body = await json(await request("staff", "GET", "/reports/funnel?pipelineId=p2"));
    expect(body.data.map((r: { stage: string; deals: number; dealValue: number }) => [r.stage, r.deals, r.dealValue])).toEqual([
      ["Lead", 1, 100],
      ["Proposal", 1, 200],
      ["Closing", 0, 0],
    ]);
  });

  it("conversion per stage: entered, moved on to a later stage, won", async () => {
    const body = await json(await request("staff", "GET", "/reports/stage-conversion?pipelineId=p2"));
    expect(body.data.map((r: Record<string, unknown>) => [r.stage, r.entered, r.movedOn, r.won, r.conversion])).toEqual([
      ["Lead", 2, 0, 0, 0],
      ["Proposal", 3, 1, 1, 33.3],
      ["Closing", 1, 0, 1, 0],
    ]);
  });

  it("lost reasons, and a pipeline is required where it matters", async () => {
    const body = await json(await request("staff", "GET", "/reports/lost-reasons"));
    expect(body.data).toEqual([{ reason: "price", deals: 2, dealValue: 900 }]);
    expect((await request("staff", "GET", "/reports/funnel")).status).toBe(422);
    expect((await request("staff", "GET", "/reports/made-up")).status).toBe(422);
  });

  it("declares the same reports for Kitsuden's report engine", async () => {
    const { CRM_REPORTS } = await import("../../kons/kon-crm/crm.reports");
    expect(CRM_REPORTS.map((r) => r.id)).toEqual(["funnel", "stage-entries", "lost-reasons"]);
    for (const r of CRM_REPORTS) expect(r.query.source.table.startsWith("crm_")).toBe(true);
  });
});

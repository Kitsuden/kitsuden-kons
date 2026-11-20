/**
 * Selling: what a deal sells, the quote, and how the period is going
 * ============================================================================
 *
 * ── LINES ──────────────────────────────────────────────────────────────────
 *
 * A deal's lines say what it sells. The price is FROZEN when the line is added: a catalog that changes
 * later does not change what was offered. The product is referenced by shape (`productType`,
 * `productId`): a shop variant (`shop_variants`), another kon's item, or nothing at all (a service written
 * by hand). The CRM never reads another kon's catalog; whoever adds the line says the price.
 *
 * Amounts are integers in the smallest unit (cents). With lines, the deal's `value` is their total: one
 * number, not two that drift apart.
 *
 * ── QUOTES ─────────────────────────────────────────────────────────────────
 *
 *   draft ──send──▶ sent ──accept──▶ accepted
 *                        └─reject──▶ rejected
 *
 * A quote is a snapshot of the lines when it is made; editing the deal afterwards does not touch it.
 * Accepting may set something in motion (`then`):
 *
 *   none     nothing but the record
 *   payment  a one-time payment of the quote's total through kon-payments, if installed; the checkout URL
 *            goes back to whoever accepted. When the payment arrives (`payment:payment.succeeded` with
 *            `crmQuoteId`), the quote is marked paid and the payment linked to the deal
 *   order    `crm:quote.accepted` carries the lines; kon-ecommerce, if installed, turns the shop lines into
 *            an order and links it to the deal
 *
 * ── FORECAST AND TARGETS ───────────────────────────────────────────────────
 *
 * Per person (the deal's `assignedTo`) and period: what is open and closes in the period (its value and its
 * value weighted by probability), what was won in it, and the target set for exactly that period.
 */

import { AppError } from "@kitsuden/engine";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "@kitsuden/engine/zod";

import { dbDe, userOf } from "./crm.context";
import type { CrmDb } from "./crm.db";
import { formatNumber, nextNumber } from "./crm.entities";
import { emitCrm } from "./crm.events";
import { crmContacts, crmDealLines, crmDeals, crmQuotes, crmSalesTargets, type QuoteLine } from "./crm.schema";
import { CONFIGURE, EDIT, VIEW, cappedPage, pageOfRows, type Page, type registry } from "./operations";

// ── Arithmetic ──────────────────────────────────────────────────────────────

/** One line: net after discount, tax on the net, total. Rounded once, at the end of each step. */
export function lineAmounts(quantity: number, unitPrice: number, discountPct = 0, taxPct = 0) {
  const gross = quantity * unitPrice;
  const net = Math.round(gross * (1 - discountPct / 100));
  const tax = Math.round(net * (taxPct / 100));
  return { net, tax, total: net + tax };
}

export function quoteTotals(lines: Array<Pick<QuoteLine, "quantity" | "unitPrice" | "discountPct" | "taxPct">>) {
  let subtotal = 0;
  let tax = 0;
  for (const l of lines) {
    const a = lineAmounts(l.quantity, l.unitPrice, l.discountPct, l.taxPct);
    subtotal += a.net;
    tax += a.tax;
  }
  return { subtotal, tax, total: subtotal + tax };
}

type Line = typeof crmDealLines.$inferSelect;

function asQuoteLine(l: Line): QuoteLine {
  return {
    name: l.name,
    sku: l.sku ?? null,
    productType: l.productType ?? null,
    productId: l.productId ?? null,
    quantity: Number(l.quantity),
    unitPrice: l.unitPrice,
    discountPct: Number(l.discountPct),
    taxPct: Number(l.taxPct),
    lineTotal: l.lineTotal,
  };
}

async function visibleDeal(db: CrmDb, dealId: string) {
  const [deal] = await db.select().from(crmDeals).where(eq(crmDeals.id, dealId)).limit(1);
  if (!deal) throw AppError.notFound("Deal not found");
  return deal;
}

/** The deal's value follows its lines (when it has any). */
async function recalcDeal(db: CrmDb, dealId: string): Promise<void> {
  const lines: Line[] = await db.select().from(crmDealLines).where(eq(crmDealLines.dealId, dealId));
  if (lines.length === 0) return;
  const { total } = quoteTotals(lines.map(asQuoteLine));
  await db.update(crmDeals).set({ value: total, currency: lines[0]!.currency, updatedAt: new Date() }).where(eq(crmDeals.id, dealId));
}

// ── kon-payments, reached at runtime (as kon-ecommerce does) ───────────────

export interface QuotePaymentGateway {
  providers(): string[];
  open(
    provider: string,
    input: {
      lines: Array<{ name: string; unitAmount: number; quantity: number }>;
      currency: string;
      successUrl: string;
      cancelUrl?: string;
      customerEmail?: string;
      metadata: Record<string, string>;
    }
  ): Promise<{ ok: true; session: { url: string; id: string } } | { ok: false; status: number; message: string }>;
}

export async function loadPaymentGateway(): Promise<QuotePaymentGateway | null> {
  try {
    const specifier = "../kon-payments/index";
    const m = (await import(/* @vite-ignore */ specifier)) as {
      buildProviders(): Map<string, unknown>;
      orderProviderNames(p: Map<string, unknown>): string[];
      openOrderCheckout(p: Map<string, unknown>, name: string, input: unknown): Promise<never>;
    };
    return {
      providers: () => m.orderProviderNames(m.buildProviders()),
      open: (provider, input) => m.openOrderCheckout(m.buildProviders(), provider, input),
    };
  } catch {
    return null;
  }
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const DealParam = z.object({ id: z.string().min(1).max(64) });
const LineParam = z.object({ id: z.string().min(1).max(64) });
const QuoteParam = z.object({ id: z.string().min(1).max(64) });
const Money = z.number().int().min(0).max(1_000_000_000_00);
const AddLine = z
  .object({
    name: z.string().min(1).max(300),
    sku: z.string().max(100).optional(),
    productType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional().describe("Where the product lives: `shop_variants`…"),
    productId: z.string().min(1).max(100).optional(),
    quantity: z.number().positive().max(1_000_000),
    unitPrice: Money.describe("In cents, frozen: a later catalog change does not touch it"),
    discountPct: z.number().min(0).max(100).default(0),
    taxPct: z.number().min(0).max(100).default(0),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  })
  .strict()
  .refine((l) => (l.productType === undefined) === (l.productId === undefined), "productType and productId go together");
const UpdateLine = z
  .object({
    name: z.string().min(1).max(300).optional(),
    quantity: z.number().positive().max(1_000_000).optional(),
    discountPct: z.number().min(0).max(100).optional(),
    taxPct: z.number().min(0).max(100).optional(),
  })
  .strict();
const CreateQuote = z
  .object({
    validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    notes: z.string().max(5000).optional(),
  })
  .strict();
const AcceptQuote = z
  .object({
    then: z.enum(["none", "payment", "order"]).default("none"),
    provider: z.string().min(1).max(32).optional().describe("For `payment`: the kon-payments provider"),
    successUrl: z.string().url().max(2000).optional().describe("For `payment`: where the payer returns"),
    cancelUrl: z.string().url().max(2000).optional(),
    fulfillmentType: z.enum(["digital", "shipping", "pickup"]).optional().describe("For `order`"),
    shippingAddress: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const ForecastQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const SetTarget = z
  .object({
    userId: z.string().min(1).max(64),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amount: Money,
    currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  })
  .strict();
const Out = z.object({}).passthrough();

// ── Forecast ────────────────────────────────────────────────────────────────

export interface ForecastRow {
  userId: string | null;
  openDeals: number;
  openValue: number;
  weightedValue: number;
  wonDeals: number;
  wonValue: number;
  target: number | null;
  attainment: number | null;
}

/** One query, grouped in Postgres: row security on `crm_deals` applies, and no deal is loaded into memory. */
export async function forecast(db: CrmDb, from: string, to: string): Promise<ForecastRow[]> {
  const start = `${from}T00:00:00.000Z`;
  const end = `${to}T23:59:59.999Z`;
  const open = sql`status = 'open' AND expected_close_date >= ${start}::timestamptz AND expected_close_date <= ${end}::timestamptz`;
  const won = sql`status = 'won' AND COALESCE(actual_close_date, updated_at) >= ${start}::timestamptz AND COALESCE(actual_close_date, updated_at) <= ${end}::timestamptz`;
  const result = await db.execute(sql`
    SELECT assigned_to AS "userId",
      count(*) FILTER (WHERE ${open})::int AS "openDeals",
      COALESCE(sum(value) FILTER (WHERE ${open}), 0)::bigint AS "openValue",
      COALESCE(sum(round(value * COALESCE(probability, 0) / 100.0)) FILTER (WHERE ${open}), 0)::bigint AS "weightedValue",
      count(*) FILTER (WHERE ${won})::int AS "wonDeals",
      COALESCE(sum(value) FILTER (WHERE ${won}), 0)::bigint AS "wonValue"
    FROM crm_deals
    GROUP BY assigned_to
    HAVING count(*) FILTER (WHERE ${open}) > 0 OR count(*) FILTER (WHERE ${won}) > 0
  `);
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<Record<string, unknown>>;
  const out = new Map<string, ForecastRow>();
  for (const r of rows) {
    out.set(String(r.userId ?? ""), {
      userId: (r.userId as string | null) ?? null,
      openDeals: Number(r.openDeals),
      openValue: Number(r.openValue),
      weightedValue: Number(r.weightedValue),
      wonDeals: Number(r.wonDeals),
      wonValue: Number(r.wonValue),
      target: null,
      attainment: null,
    });
  }
  const targets = await db
    .select()
    .from(crmSalesTargets)
    .where(and(eq(crmSalesTargets.periodStart, from), eq(crmSalesTargets.periodEnd, to)));
  for (const t of targets) {
    const row = out.get(t.userId) ?? { userId: t.userId, openDeals: 0, openValue: 0, weightedValue: 0, wonDeals: 0, wonValue: 0, target: null, attainment: null };
    row.target = t.amount;
    out.set(t.userId, row);
  }
  for (const r of out.values()) r.attainment = r.target ? Math.round((r.wonValue / r.target) * 1000) / 10 : null;
  return [...out.values()].sort((a, b) => b.wonValue + b.weightedValue - (a.wonValue + a.weightedValue));
}

// ── Operations ──────────────────────────────────────────────────────────────

let gatewayLoader: () => Promise<QuotePaymentGateway | null> = loadPaymentGateway;

/** Replaces how kon-payments is reached (a test, or a host that wires it differently). */
export function useQuotePaymentGateway(loader: () => Promise<QuotePaymentGateway | null>): void {
  gatewayLoader = loader;
}

export function salesOperations(routes: ReturnType<typeof registry>): void {
  const gateway = () => gatewayLoader();
  routes.get(
    "/deals/:id/lines",
    {
      id: "list-deal-lines",
      unpaginated: "The product lines of one deal, with totals computed over all of them: a few dozen at most.",
      summary: "What a deal sells",
      description: "The deal's product lines in order, with their frozen unit price, discount, tax and total (cents), and the deal's totals. 404 if the deal does not exist or is not visible to you.",
      access: "session",
      permission: VIEW,
      input: { params: DealParam },
      output: { schema: Out },
    },
    async (c) => {
      const db = dbDe(c);
      const deal = await visibleDeal(db, c.req.param("id"));
      const lines: Line[] = await db.select().from(crmDealLines).where(eq(crmDealLines.dealId, deal.id)).orderBy(asc(crmDealLines.position));
      return c.json({ data: lines, totals: { ...quoteTotals(lines.map(asQuoteLine)), currency: lines[0]?.currency ?? deal.currency ?? "USD" } });
    }
  );

  routes.post(
    "/deals/:id/lines",
    {
      id: "add-deal-line",
      summary: "Add a product line to a deal",
      description:
        "Adds a line: `name`, `quantity`, `unitPrice` (cents, FROZEN from now on), optional `discountPct`, `taxPct`, `sku`, and the product by shape (`productType` + `productId`, e.g. `shop_variants`). The deal's value becomes the total of its lines. All lines of a deal share one currency (422 otherwise). 404 if the deal is not visible. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { params: DealParam, body: AddLine },
      output: { schema: Out },
    },
    async (c, input) => {
      const db = dbDe(c);
      const deal = await visibleDeal(db, c.req.param("id"));
      const body = input.body as z.infer<typeof AddLine>;
      const existing: Line[] = await db.select().from(crmDealLines).where(eq(crmDealLines.dealId, deal.id));
      const currency = body.currency ?? existing[0]?.currency ?? deal.currency ?? "USD";
      if (existing.some((l) => l.currency !== currency)) throw AppError.validation(`This deal's lines are in ${existing[0]!.currency}`);
      const amounts = lineAmounts(body.quantity, body.unitPrice, body.discountPct, body.taxPct);
      const [line] = await db
        .insert(crmDealLines)
        .values({
          dealId: deal.id,
          position: existing.length,
          name: body.name,
          sku: body.sku ?? null,
          productType: body.productType ?? null,
          productId: body.productId ?? null,
          quantity: body.quantity,
          unitPrice: body.unitPrice,
          discountPct: body.discountPct,
          taxPct: body.taxPct,
          lineTotal: amounts.total,
          currency,
          createdBy: userOf(c)?.id ?? null,
        })
        .returning();
      await recalcDeal(db, deal.id);
      return c.json({ data: line }, 201);
    }
  );

  routes.patch(
    "/deal-lines/:id",
    {
      id: "update-deal-line",
      summary: "Change a deal line's quantity, discount, tax or name",
      description: "The unit price is not editable: it was frozen when the line was added (remove the line and add it again to change it). 404 if the line's deal is not visible. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { params: LineParam, body: UpdateLine },
      output: { schema: Out },
    },
    async (c, input) => {
      const db = dbDe(c);
      const [line]: Line[] = await db.select().from(crmDealLines).where(eq(crmDealLines.id, c.req.param("id"))).limit(1);
      if (!line) throw AppError.notFound("Line not found");
      const body = input.body as z.infer<typeof UpdateLine>;
      const next = { ...asQuoteLine(line), ...body };
      const amounts = lineAmounts(next.quantity, line.unitPrice, next.discountPct, next.taxPct);
      const [updated] = await db
        .update(crmDealLines)
        .set({ ...body, lineTotal: amounts.total })
        .where(eq(crmDealLines.id, line.id))
        .returning();
      await recalcDeal(db, line.dealId);
      return c.json({ data: updated });
    }
  );

  routes.delete(
    "/deal-lines/:id",
    {
      id: "remove-deal-line",
      summary: "Remove a product line",
      description: "Removes the line; the deal's value becomes the total of the lines left (unchanged when none is left). Quotes already made keep their snapshot. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { params: LineParam },
      output: { schema: Out },
    },
    async (c) => {
      const db = dbDe(c);
      const [line]: Line[] = await db.delete(crmDealLines).where(eq(crmDealLines.id, c.req.param("id"))).returning();
      if (!line) throw AppError.notFound("Line not found");
      await recalcDeal(db, line.dealId);
      return c.json({ data: { id: line.id, removed: true } });
    }
  );

  routes.get(
    "/deals/:id/quotes",
    {
      id: "list-quotes",
      unpaginated: "The quotes of one deal: a handful of revisions.",
      summary: "A deal's quotes",
      description: "The deal's quotes, newest first, with status, totals and what accepting them set in motion. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { params: DealParam },
      output: { schema: Out },
    },
    async (c) => {
      const db = dbDe(c);
      const deal = await visibleDeal(db, c.req.param("id"));
      const quotes = await db.select().from(crmQuotes).where(eq(crmQuotes.dealId, deal.id)).orderBy(sql`${crmQuotes.createdAt} DESC`);
      return c.json({ data: quotes });
    }
  );

  routes.post(
    "/deals/:id/quotes",
    {
      id: "create-quote",
      summary: "Make a quote from the deal's lines",
      description: "A draft quote with a snapshot of the deal's current lines and totals, numbered `Q-0001`… Later changes to the deal do not touch it. 422 when the deal has no lines. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { params: DealParam, body: CreateQuote },
      output: { schema: Out },
    },
    async (c, input) => {
      const db = dbDe(c);
      const deal = await visibleDeal(db, c.req.param("id"));
      const body = input.body as z.infer<typeof CreateQuote>;
      const lines: Line[] = await db.select().from(crmDealLines).where(eq(crmDealLines.dealId, deal.id)).orderBy(asc(crmDealLines.position));
      if (lines.length === 0) throw AppError.validation("A quote needs at least one line on the deal");
      const snapshot = lines.map(asQuoteLine);
      const totals = quoteTotals(snapshot);
      const number = formatNumber({ field: "number", prefix: "Q-", padding: 4 }, await nextNumber(db, "crm_quote"));
      const [quote] = await db
        .insert(crmQuotes)
        .values({
          dealId: deal.id,
          number,
          lines: snapshot,
          ...totals,
          currency: lines[0]!.currency,
          validUntil: body.validUntil ?? null,
          notes: body.notes ?? null,
          createdBy: userOf(c)?.id ?? null,
        })
        .returning();
      return c.json({ data: quote }, 201);
    }
  );

  routes.get(
    "/quotes/:id",
    {
      id: "get-quote",
      summary: "One quote",
      description: "A quote with its lines snapshot and status. 404 if its deal is not visible to you. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { params: QuoteParam },
      output: { schema: Out },
    },
    async (c) => {
      const [quote] = await dbDe(c).select().from(crmQuotes).where(eq(crmQuotes.id, c.req.param("id"))).limit(1);
      if (!quote) throw AppError.notFound("Quote not found");
      return c.json({ data: quote });
    }
  );

  const transition = async (db: CrmDb, quoteId: string, from: string[], set: Record<string, unknown>) => {
    const [quote] = await db.select().from(crmQuotes).where(eq(crmQuotes.id, quoteId)).limit(1);
    if (!quote) throw AppError.notFound("Quote not found");
    if (!from.includes(quote.status)) throw AppError.conflict(`The quote is ${quote.status}`);
    const [updated] = await db
      .update(crmQuotes)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(crmQuotes.id, quote.id), eq(crmQuotes.status, quote.status)))
      .returning();
    if (!updated) throw AppError.conflict("The quote changed meanwhile");
    return updated as typeof crmQuotes.$inferSelect;
  };

  routes.post(
    "/quotes/:id/send",
    {
      id: "send-quote",
      summary: "Mark a quote as sent",
      description: "draft → sent, and `crm:quote.sent`. Sending the document itself is up to you (email, portal). 409 if it is not a draft. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { params: QuoteParam },
      output: { schema: Out },
    },
    async (c) => {
      const quote = await transition(dbDe(c), c.req.param("id"), ["draft"], { status: "sent", sentAt: new Date() });
      emitCrm("quote.sent", { quoteId: quote.id, dealId: quote.dealId, number: quote.number });
      return c.json({ data: quote });
    }
  );

  routes.post(
    "/quotes/:id/reject",
    {
      id: "reject-quote",
      summary: "Mark a quote as rejected",
      description: "sent → rejected. 409 otherwise. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { params: QuoteParam },
      output: { schema: Out },
    },
    async (c) => {
      const quote = await transition(dbDe(c), c.req.param("id"), ["sent"], { status: "rejected", rejectedAt: new Date() });
      emitCrm("quote.rejected", { quoteId: quote.id, dealId: quote.dealId, number: quote.number });
      return c.json({ data: quote });
    }
  );

  routes.post(
    "/quotes/:id/accept",
    {
      id: "accept-quote",
      summary: "Accept a quote, optionally opening a payment or an order",
      description:
        "draft or sent → accepted, and `crm:quote.accepted`. `then: payment` opens a one-time payment of the quote's total through kon-payments (`provider`, `successUrl`) and returns `checkoutUrl`; when it is paid the quote is marked paid. `then: order` asks kon-ecommerce to turn the quote's shop lines into an order (at the shop's own prices). 409 if the quote is not open, 503 when the kon needed is not installed, 422 for a payment without a provider or return URL, 502 when the provider refuses. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { params: QuoteParam, body: AcceptQuote },
      output: { schema: Out },
    },
    async (c, input) => {
      const db = dbDe(c);
      const body = input.body as z.infer<typeof AcceptQuote>;
      const [current] = await db.select().from(crmQuotes).where(eq(crmQuotes.id, c.req.param("id"))).limit(1);
      if (!current) throw AppError.notFound("Quote not found");
      const deal = await visibleDeal(db, current.dealId);
      const [contact] = deal.contactId
        ? await db.select({ email: crmContacts.email, firstName: crmContacts.firstName, lastName: crmContacts.lastName }).from(crmContacts).where(eq(crmContacts.id, deal.contactId))
        : [];

      let checkoutUrl: string | null = null;
      let outcomeRef: string | null = null;
      if (body.then === "payment") {
        if (!body.provider || !body.successUrl) throw AppError.validation("A payment needs `provider` and `successUrl`");
        const payments = await gateway();
        if (!payments) throw new AppError("INTERNAL", "kon-payments is not installed", { status: 503, expose: true });
        const opened = await payments.open(body.provider, {
          // One line with the quote's total: what was agreed, taxes included, not recomputed.
          lines: [{ name: `Quote ${current.number}`, unitAmount: current.total, quantity: 1 }],
          currency: current.currency,
          successUrl: body.successUrl,
          cancelUrl: body.cancelUrl,
          customerEmail: contact?.email || undefined,
          metadata: { crmQuoteId: current.id, crmDealId: deal.id },
        });
        if (!opened.ok) {
          if (opened.status === 404 || opened.status === 422) throw AppError.validation(opened.message);
          throw new AppError("INTERNAL", opened.message, { status: 502, expose: true });
        }
        checkoutUrl = opened.session.url;
        outcomeRef = opened.session.id;
      }

      const quote = await transition(db, current.id, ["draft", "sent"], {
        status: "accepted",
        acceptedAt: new Date(),
        acceptedBy: userOf(c)?.id ?? null,
        outcome: body.then,
        outcomeRef,
        checkoutUrl,
      });
      emitCrm("quote.accepted", {
        quoteId: quote.id,
        dealId: quote.dealId,
        number: quote.number,
        then: body.then,
        lines: quote.lines,
        total: quote.total,
        currency: quote.currency,
        customerEmail: contact?.email ?? null,
        customerName: contact ? `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || null : null,
        fulfillmentType: body.fulfillmentType ?? null,
        shippingAddress: body.shippingAddress ?? null,
      });
      return c.json({ data: quote, checkoutUrl });
    }
  );

  routes.get(
    "/forecast",
    {
      id: "get-forecast",
      summary: "Forecast and targets per person for a period",
      description:
        "Per person (the deal's `assignedTo`) between `from` and `to` (dates): open deals expected to close in the period with their value and value weighted by probability, deals won in the period and their value, the target set for exactly that period, and attainment (% of target won). Amounts in cents. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { query: ForecastQuery },
      output: { schema: Out },
    },
    async (c, input) => {
      const q = input.query as z.infer<typeof ForecastQuery>;
      if (q.to < q.from) throw AppError.validation("`to` is before `from`");
      return c.json({ data: await forecast(dbDe(c), q.from, q.to), period: q });
    }
  );

  routes.get(
    "/targets",
    {
      id: "list-targets",
      summary: "Sales targets",
      description:
        "Targets per person and period, newest period first, a page at a time (`limit` 1-500, default 500; `offset`; `hasMore` says there are more). CRM team only.",
      access: "session",
      permission: VIEW,
      input: { query: z.object(cappedPage(500)).passthrough() },
      output: { schema: Out },
    },
    async (c, input) => {
      const { limit, offset } = input.query as Required<Page>;
      const rows = await dbDe(c)
        .select()
        .from(crmSalesTargets)
        .orderBy(sql`${crmSalesTargets.periodStart} DESC`, asc(crmSalesTargets.id))
        .limit(limit + 1)
        .offset(offset);
      return c.json(pageOfRows(rows, limit));
    }
  );

  routes.put(
    "/targets",
    {
      id: "set-target",
      summary: "Set a person's target for a period",
      description: "Sets (or replaces) how much `userId` is expected to win between `periodStart` and `periodEnd`, in cents. Admin only.",
      access: "session",
      permission: CONFIGURE,
      input: { body: SetTarget },
      output: { schema: Out },
    },
    async (c, input) => {
      const body = input.body as z.infer<typeof SetTarget>;
      if (body.periodEnd < body.periodStart) throw AppError.validation("The period ends before it starts");
      const [row] = await dbDe(c)
        .insert(crmSalesTargets)
        .values({ ...body, createdBy: userOf(c)?.id ?? null })
        .onConflictDoUpdate({
          target: [crmSalesTargets.userId, crmSalesTargets.periodStart, crmSalesTargets.periodEnd],
          set: { amount: body.amount, currency: body.currency },
        })
        .returning();
      return c.json({ data: row });
    }
  );
}

/** A payment for a quote (`metadata.crmQuoteId`) marks it paid. Called by crm.connected.ts's payment listener. */
export async function markQuotePaid(db: CrmDb, quoteId: string, paymentRef: string): Promise<{ quoteId: string; dealId: string } | null> {
  const [quote] = await db
    .update(crmQuotes)
    .set({ paidAt: new Date(), outcomeRef: paymentRef, updatedAt: new Date() })
    .where(and(eq(crmQuotes.id, quoteId), eq(crmQuotes.status, "accepted"), sql`${crmQuotes.paidAt} IS NULL`))
    .returning({ id: crmQuotes.id, dealId: crmQuotes.dealId });
  return quote ? { quoteId: quote.id, dealId: quote.dealId } : null;
}


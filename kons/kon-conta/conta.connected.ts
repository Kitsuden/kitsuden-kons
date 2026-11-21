/**
 * What the ledger does when another kon announces something
 * ============================================================================
 *
 * kon-conta imports no other kon and no other kon imports this file. The two meet on the event
 * bus: a kon says what happened (`odoo:sale_order.confirmed`), and the ledger, if it is installed,
 * writes it down. Without the other kon the listeners sit idle; without this one the events go
 * unheard. Neither needs the other to start.
 *
 *   odoo:sale_order.confirmed   →  the customer as a client, and an ISSUED invoice for the order
 *   odoo:payment.received       →  a payment on the invoices of the orders it settled
 *
 * IDEMPOTENT. Events may repeat, and a listener may run twice. An order is recorded once, keyed
 * `odoo-so:<sale.order id>` (a unique index says so, migration 0009); a payment once, keyed
 * `odoo-payment:<account.payment id>` in the payment's reference.
 *
 * AT MOST ONCE. The bus does not retry. An event this process never heard leaves no invoice; the
 * emitting kon announces a confirmed order again on its next notice about it, and that one is
 * recorded then.
 *
 * OFF UNLESS ASKED FOR (`CONTA_FOLLOW_ODOO=true`). When Odoo keeps the books (its Invoicing app,
 * with the kitsuden_bridge module recording the web payments), kon-conta writing the same sales
 * would be a second set of books for the same money. Turn it on only when kon-conta is the
 * ledger and Odoo is used without its accounting.
 *
 * WHAT IS NOT GUESSED. A document in a currency that is not the ledger's base currency is left
 * out, with a warning: the ledger has no rate to convert it with. An order with no customer is
 * left out. A payment that names no order the ledger has invoiced is left out.
 *
 * The handlers are plain functions on `(db, payload)`, so a test calls them directly.
 */

import type { KonContext, KonEventsDeclaration } from "@kitsuden/shared";
import { Decimal } from "decimal.js";
import { and, asc, eq, inArray } from "drizzle-orm";

import { BillingService, invoiceBalance, today } from "./conta.billing";
import { ensureClient } from "./conta.bridge";
import { contaSettings, invoicePayments, invoices } from "./conta.schema";
import { d, isRealDate, toDb } from "./conta.service";
import type { ContaDb } from "./types";

export const SOURCE = "odoo";
export const orderRef = (odooId: number) => `odoo-so:${odooId}`;
export const partnerRef = (odooId: number) => `odoo-partner:${odooId}`;
export const paymentRef = (odooId: number) => `odoo-payment:${odooId}`;

export const contaEvents: KonEventsDeclaration = {
  emits: {},
  listens: ["odoo:sale_order.confirmed", "odoo:payment.received"],
};

export type Outcome =
  | { status: "recorded"; invoiceIds: string[] }
  | { status: "exists"; invoiceIds: string[] }
  | { status: "skipped"; reason: string };

// ── Reading a payload nobody typed for us ─────────────────────────────────────

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const integer = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);
const words = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/** A decimal string from another kon, or null when it is not an amount. */
function amount(value: unknown): Decimal | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    const parsed = d(value);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

const day = (value: unknown): string => {
  const text = words(value)?.slice(0, 10);
  return text && isRealDate(text) ? text : today();
};

async function baseCurrency(db: ContaDb): Promise<string> {
  const [settings] = await db.select({ currency: contaSettings.baseCurrency }).from(contaSettings).limit(1);
  return settings?.currency ?? "USD";
}

// ── A confirmed order becomes an issued invoice ───────────────────────────────

export async function invoiceFromOdooOrder(dbValue: unknown, payload: unknown): Promise<Outcome> {
  const db = dbValue as ContaDb;
  const order = record(payload);
  const odooId = integer(order?.odooId);
  if (!order || odooId === null) return { status: "skipped", reason: "the event names no order" };
  const name = words(order.name) ?? `Order ${odooId}`;

  const [existing] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.source, SOURCE), eq(invoices.externalRef, orderRef(odooId))))
    .limit(1);
  if (existing) return { status: "exists", invoiceIds: [existing.id] };

  const partner = record(order.partner);
  const partnerId = integer(partner?.odooId);
  if (!partner || partnerId === null) return { status: "skipped", reason: `${name} has no customer` };

  const currency = words(order.currency);
  const base = await baseCurrency(db);
  if (currency && currency !== base) {
    return { status: "skipped", reason: `${name} is in ${currency} and the ledger keeps ${base}` };
  }

  const untaxed = amount(order.amountUntaxed);
  const tax = amount(order.amountTax) ?? new Decimal(0);
  if (!untaxed || untaxed.lte(0)) return { status: "skipped", reason: `${name} has no amount to invoice` };

  const lines = (Array.isArray(order.lines) ? order.lines : []).flatMap((value) => {
    const line = record(value);
    const subtotal = amount(line?.subtotal);
    if (!line || !subtotal || subtotal.isZero()) return [];
    const description = words(line.name) ?? "Item";
    const quantity = amount(line.quantity);
    const unitPrice = amount(line.unitPrice);
    // Odoo's subtotal already carries the line's discount. When quantity × price says the same,
    // the line keeps both; when it does not, the subtotal is what was sold and goes in whole.
    if (quantity && unitPrice && quantity.gt(0) && quantity.times(unitPrice).minus(subtotal).abs().lt("0.00005")) {
      return [{ kind: "fee" as const, description, quantity: toDb(quantity), unitPrice: toDb(unitPrice) }];
    }
    const detail = quantity && unitPrice ? ` (${quantity.toString()} × ${unitPrice.toString()}, discounted)` : "";
    return [{ kind: "fee" as const, description: `${description}${detail}`, quantity: "1", unitPrice: toDb(subtotal) }];
  });
  if (lines.length === 0) return { status: "skipped", reason: `${name} has no lines to invoice` };

  const { client } = await ensureClient(db, {
    externalRef: partnerRef(partnerId),
    name: words(partner.name) ?? `Odoo customer ${partnerId}`,
    ...(words(partner.email) ? { email: words(partner.email) as string } : {}),
    ...(words(partner.vat) ? { taxId: words(partner.vat) as string } : {}),
  });

  // The ledger applies one rate to an invoice. Odoo may have taxed lines differently: the rate
  // that gives Odoo's own tax on Odoo's own net is the one that makes the totals agree.
  const taxRate = tax.div(untaxed).toDecimalPlaces(6).toFixed(6);

  const invoice = await new BillingService(db).createInvoice({
    clientId: client.id,
    concept: `Odoo order ${name}`,
    issueDate: day(order.date),
    taxRate,
    lines,
    issue: true,
    source: SOURCE,
    externalRef: orderRef(odooId),
  });
  return { status: "recorded", invoiceIds: [(invoice as { id: string }).id] };
}

// ── A payment in Odoo becomes a payment on those invoices ─────────────────────

export async function paymentFromOdoo(dbValue: unknown, payload: unknown): Promise<Outcome> {
  const db = dbValue as ContaDb;
  const payment = record(payload);
  const paymentId = integer(payment?.paymentId);
  if (!payment || paymentId === null) return { status: "skipped", reason: "the event names no payment" };
  const reference = paymentRef(paymentId);

  const already = await db
    .select({ invoiceId: invoicePayments.invoiceId })
    .from(invoicePayments)
    .where(eq(invoicePayments.reference, reference));
  if (already.length > 0) return { status: "exists", invoiceIds: already.map((row) => row.invoiceId) };

  const total = amount(payment.amount);
  if (!total || total.lte(0)) return { status: "skipped", reason: `payment ${paymentId} has no amount` };

  const currency = words(payment.currency);
  const base = await baseCurrency(db);
  if (currency && currency !== base) {
    return { status: "skipped", reason: `payment ${paymentId} is in ${currency} and the ledger keeps ${base}` };
  }

  const refs = (Array.isArray(payment.orders) ? payment.orders : []).flatMap((value) => {
    const id = integer(record(value)?.odooId);
    return id === null ? [] : [orderRef(id)];
  });
  if (refs.length === 0) return { status: "skipped", reason: `payment ${paymentId} names no order` };

  const open = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.source, SOURCE), inArray(invoices.externalRef, refs), eq(invoices.status, "issued")))
    .orderBy(asc(invoices.issueDate), asc(invoices.id));
  if (open.length === 0) {
    return { status: "skipped", reason: `payment ${paymentId}: none of its orders has an issued invoice here` };
  }

  // Oldest invoice first, each up to what it still owes. What is left over is not recorded: a
  // payment larger than its invoices is something a person reconciles.
  const billing = new BillingService(db);
  let remaining = total;
  const paid: string[] = [];
  for (const invoice of open) {
    if (remaining.lte(0)) break;
    const share = Decimal.min(remaining, invoiceBalance(invoice));
    if (share.lte(0)) continue;
    await billing.recordPayment(invoice.id, {
      amount: toDb(share),
      date: day(payment.date),
      method: "odoo",
      reference,
    });
    remaining = remaining.minus(share);
    paid.push(invoice.id);
  }
  if (paid.length === 0) {
    return { status: "skipped", reason: `payment ${paymentId}: its invoices are already paid` };
  }
  return { status: "recorded", invoiceIds: paid };
}

// ── Listening ─────────────────────────────────────────────────────────────────

const listening = new WeakSet<object>();

/**
 * Subscribes once per event bus. Each event is handled as the system (the ledger's row security
 * lets only the accounting team write, and no person is asking here), in its own transaction,
 * outside whatever emitted it. A failure is logged and dropped: the emitter must not break
 * because the books could not be written.
 */
/** Whether kon-conta keeps the books of what Odoo sells (`CONTA_FOLLOW_ODOO=true`). */
export function followsOdoo(env: Record<string, string | undefined> = process.env): boolean {
  return env.CONTA_FOLLOW_ODOO === "true";
}

export function listenToOtherKons(ctx: KonContext, env: Record<string, string | undefined> = process.env): void {
  if (!followsOdoo(env)) return;
  if (!ctx.events?.on || listening.has(ctx.events)) return;
  listening.add(ctx.events);

  const handle = (event: string, fn: (db: unknown, payload: unknown) => Promise<Outcome>) => {
    ctx.events.on(event, (payload: unknown) => {
      const asSystem = ctx.db.asSystem ?? (<T>(work: () => Promise<T>) => work());
      const run = () =>
        asSystem(() => (ctx.db.instance as ContaDb).transaction((tx) => fn(tx, payload)))
          .then((outcome) => {
            if (outcome.status === "skipped") ctx.logger.warn(`[Conta] ${event} not recorded: ${outcome.reason}`);
          })
          .catch((error: unknown) => {
            ctx.logger.error(`[Conta] ${event} could not be recorded`, {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      void (ctx.db.background ? ctx.db.background(run) : run());
    });
  };

  handle("odoo:sale_order.confirmed", invoiceFromOdooOrder);
  handle("odoo:payment.received", paymentFromOdoo);
}

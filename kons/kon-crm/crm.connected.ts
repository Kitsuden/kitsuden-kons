/**
 * The CRM hears the other kons
 * ============================================================================
 *
 * A shop sells, a newsletter gains a reader, a payment arrives. Each of those is a person the CRM should
 * know about, and none of those kons may import the CRM (or be imported by it). They meet through events
 * and links:
 *
 *   shop:order.paid                → find or create the buyer, link   order    —ordered_by→  contact
 *   newsletter:member.subscribed   → find or create the reader, link  member   —same_person—  contact
 *   payment:payment.succeeded      → find or create the payer, link   payment  —paid_by→     contact
 *   payment:payment.refunded       → the same, the refund is its own payment row
 *   inbox:message.received         → match the sender, link           message  —about→       contact
 *   inbox:event.synced             → match each attendee, link        meeting  —about→       contact
 *
 * The relation names are Kitsuden's shared vocabulary (`LINK_RELATIONS`): two kons that mean the same thing
 * write the same word, or one of them is invisible to the other.
 *
 * ── FINDING THE PERSON ─────────────────────────────────────────────────────
 *
 * Through the duplicate detector, the same one a form or an import uses (`candidatesFor` + `findDuplicates`),
 * never with an ad hoc `WHERE email = …`. An address on the exclusion list is never turned into a new contact,
 * but an existing contact is still linked: the exclusion list is about writing to them, not about knowing
 * they bought.
 *
 * ── WHAT A LINK CARRIES ────────────────────────────────────────────────────
 *
 * A summary of the other end, written when the link is made (`metadata`): an order number, a subject, an
 * amount. The CRM never reads `shop_orders` or `pay_events`; the timeline shows what the event said. Amounts
 * go under `amountValue`, a key `withoutMoney` (crm.access.ts) removes for whoever may not see money.
 *
 * ── WHEN IT RUNS ───────────────────────────────────────────────────────────
 *
 * After the other kon's request committed (the host delivers kon events only then), as the system, in its own
 * transaction. A failure is logged and dropped: the order is paid whether or not the CRM heard of it.
 * With none of those kons installed nothing is ever emitted, and this is a set of idle listeners.
 */

import { link } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { eq } from "drizzle-orm";

import type { CrmDb } from "./crm.db";
import { findDuplicates, normalizeEmail } from "./crm.dedupe";
import { emitCrm } from "./crm.events";
import { listenToNewsletterExclusions } from "./crm.exclusions";
import { candidatesFor, isSuppressed } from "./crm.intake";
import { markQuotePaid } from "./crm.sales";
import { crmContacts } from "./crm.schema";

/** The `type` of each end, by convention the table's name. */
export const LINK_TYPE = {
  contact: "crm_contacts",
  deal: "crm_deals",
  order: "shop_orders",
  member: "nl_members",
  payment: "pay_events",
  message: "inbox_messages",
  meeting: "inbox_events",
} as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Person {
  email: string | null | undefined;
  name?: string | null;
  /** Where it was heard of: `shop`, `newsletter`, `payments`, `inbox`. Goes to the contact's `source`. */
  source: string;
}

export type Found =
  | { contactId: string; created: boolean }
  | { contactId: null; reason: "no-email" | "suppressed" | "not-found" };

/** "Ana María Ortega" → first "Ana María", last "Ortega". One word is a first name. */
export function splitName(name: string | null | undefined): { firstName: string; lastName: string } {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { firstName: "", lastName: "" };
  if (words.length === 1) return { firstName: words[0]!, lastName: "" };
  return { firstName: words.slice(0, -1).join(" "), lastName: words[words.length - 1]! };
}

/**
 * The contact for a person, through the duplicate detector. `create: false` only looks.
 * A new contact has `origin: automation` and `source` = the kon it came from, and announces itself like any
 * other (`crm:contact.created`).
 */
export async function findOrCreateContact(
  db: CrmDb,
  person: Person,
  options: { create: boolean } = { create: true }
): Promise<Found> {
  const email = normalizeEmail(person.email);
  if (!email || !EMAIL.test(email)) return { contactId: null, reason: "no-email" };
  const { firstName, lastName } = splitName(person.name);

  const probe = { id: "", email, firstName, lastName };
  const candidates = await candidatesFor(db, probe);
  const [best] = findDuplicates(probe, candidates as never);
  if (best) return { contactId: best.id, created: false };

  if (!options.create) return { contactId: null, reason: "not-found" };
  if (await isSuppressed(db, email)) return { contactId: null, reason: "suppressed" };

  const [row] = await db
    .insert(crmContacts)
    .values({
      firstName,
      lastName,
      email,
      source: person.source,
      origin: "automation",
      metadata: { createdFrom: person.source },
    } as typeof crmContacts.$inferInsert)
    .returning({ id: crmContacts.id });
  emitCrm("contact:created", { contactId: row!.id, origin: "automation" });
  return { contactId: row!.id, created: true };
}

// ── The handlers: pure on (db, payload), so a test calls them without an event bus ──

export interface ConnectionResult {
  outcome: "linked" | "ignored" | "skipped";
  contactId?: string | null;
  created?: boolean;
  reason?: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function linkTo(
  db: CrmDb,
  from: { type: string; id: string },
  found: Found,
  relation: string,
  metadata: Record<string, unknown>
): Promise<ConnectionResult> {
  if (found.contactId === null) return { outcome: "skipped", contactId: null, reason: found.reason };
  await link(from, { type: LINK_TYPE.contact, id: found.contactId }, { relation, metadata }, db);
  return { outcome: "linked", contactId: found.contactId, created: found.created };
}

/** `shop:order.paid` → the buyer is a contact, and the order is linked to them. */
export async function onShopOrderPaid(db: CrmDb, payload: unknown): Promise<ConnectionResult> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const orderId = str(p.orderId);
  if (!orderId) return { outcome: "ignored", reason: "no orderId" };
  const found = await findOrCreateContact(db, { email: str(p.customerEmail), name: str(p.customerName), source: "shop" });
  return linkTo(db, { type: LINK_TYPE.order, id: orderId }, found, "ordered_by", {
    kind: "order",
    number: p.number ?? null,
    amountValue: num(p.totalCents),
    currency: str(p.currency),
    paidAt: new Date().toISOString(),
  });
}

/** `newsletter:member.subscribed` → the reader and the contact are the same person. */
export async function onNewsletterSubscribed(db: CrmDb, payload: unknown): Promise<ConnectionResult> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const memberId = str(p.memberId);
  if (!memberId) return { outcome: "ignored", reason: "no memberId" };
  const found = await findOrCreateContact(db, { email: str(p.email), name: str(p.name), source: "newsletter" });
  return linkTo(db, { type: LINK_TYPE.member, id: memberId }, found, "same_person", {
    kind: "newsletter-member",
    subscribedAt: new Date().toISOString(),
  });
}

/**
 * `payment:payment.succeeded` / `payment:payment.refunded` → the payment row is linked to the payer.
 * The payer is found by the email the provider gave; without one, a payment the shop opened still reaches
 * the buyer through the order (`metadata.shopOrderId`, which the order's own link already ties to a contact).
 */
export async function onPayment(
  db: CrmDb,
  kind: "succeeded" | "refunded",
  payload: unknown,
  contactOfOrder?: (orderId: string) => Promise<string | null>
): Promise<ConnectionResult> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const paymentId = str(p.paymentEventId);
  if (!paymentId) return { outcome: "ignored", reason: "no paymentEventId" };
  const event = (p.event ?? {}) as Record<string, unknown>;
  const money = (event.money ?? {}) as Record<string, unknown>;
  const metadata = (event.metadata ?? {}) as Record<string, unknown>;

  // A payment for a CRM quote: the quote is marked paid and the payment tied to its deal.
  const quoteId = str(metadata.crmQuoteId);
  if (quoteId && kind === "succeeded") {
    const paid = await markQuotePaid(db, quoteId, str(event.paymentId) ?? str(event.externalId) ?? paymentId);
    if (paid) {
      await link({ type: LINK_TYPE.payment, id: paymentId }, { type: LINK_TYPE.deal, id: paid.dealId }, {
        relation: "related",
        metadata: { kind: "quote-payment", quoteId, amountValue: num(money.amount), currency: str(money.currency) },
      }, db);
    }
  }

  let found = await findOrCreateContact(db, { email: str(event.customerEmail), source: "payments" });
  const orderId = str(metadata.shopOrderId);
  if (!found.contactId && orderId && contactOfOrder) {
    const contactId = await contactOfOrder(orderId);
    if (contactId) found = { contactId, created: false };
  }
  return linkTo(db, { type: LINK_TYPE.payment, id: paymentId }, found, "paid_by", {
    kind: kind === "succeeded" ? "payment" : "refund",
    provider: str(event.provider),
    amountValue: num(money.amount),
    currency: str(money.currency),
    shopOrderId: orderId,
  });
}

/** `inbox:message.received` → each address on the message that is a contact gets the message, `about` them. */
export async function onInboxMessage(db: CrmDb, payload: unknown): Promise<ConnectionResult[]> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const messageId = str(p.messageId);
  if (!messageId) return [{ outcome: "ignored", reason: "no messageId" }];
  const addresses = [...new Set([p.from, ...(Array.isArray(p.to) ? p.to : []), ...(Array.isArray(p.cc) ? p.cc : [])].map((a) => normalizeEmail(str(a))).filter(Boolean))];
  const own = new Set((Array.isArray(p.mailboxAddresses) ? p.mailboxAddresses : []).map((a) => normalizeEmail(str(a))));
  const results: ConnectionResult[] = [];
  for (const email of addresses) {
    if (own.has(email)) continue;
    // Never create from mail: a newsletter, a vendor or a notification would each become a "contact".
    const found = await findOrCreateContact(db, { email, source: "inbox" }, { create: false });
    results.push(
      await linkTo(db, { type: LINK_TYPE.message, id: messageId }, found, "about", {
        kind: "email",
        subject: str(p.subject),
        direction: str(p.direction),
        at: str(p.at),
      })
    );
  }
  return results;
}

/** `inbox:event.synced` → a meeting is `about` each attendee that is a contact. */
export async function onInboxEvent(db: CrmDb, payload: unknown): Promise<ConnectionResult[]> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const eventId = str(p.eventId);
  if (!eventId) return [{ outcome: "ignored", reason: "no eventId" }];
  if (p.cancelled === true) return [{ outcome: "ignored", reason: "cancelled" }];
  const own = new Set((Array.isArray(p.mailboxAddresses) ? p.mailboxAddresses : []).map((a) => normalizeEmail(str(a))));
  const attendees = [...new Set((Array.isArray(p.attendees) ? p.attendees : []).map((a) => normalizeEmail(str(a))).filter(Boolean))];
  const results: ConnectionResult[] = [];
  for (const email of attendees) {
    if (own.has(email)) continue;
    const found = await findOrCreateContact(db, { email, source: "inbox" }, { create: false });
    results.push(
      await linkTo(db, { type: LINK_TYPE.meeting, id: eventId }, found, "about", {
        kind: "meeting",
        title: str(p.title),
        startsAt: str(p.startsAt),
        endsAt: str(p.endsAt),
      })
    );
  }
  return results;
}

/** The contact an order was already linked to (`ordered_by`), if the CRM heard of that order. */
export async function contactOfOrder(db: CrmDb, orderId: string): Promise<string | null> {
  const { neighbors } = await import("@kitsuden/engine");
  const rows = await neighbors({ type: LINK_TYPE.order, id: orderId }, { relation: "ordered_by", type: LINK_TYPE.contact, limit: 1 }, db);
  const id = rows[0]?.id ?? null;
  if (!id) return null;
  const [contact] = await db.select({ id: crmContacts.id }).from(crmContacts).where(eq(crmContacts.id, id)).limit(1);
  return contact?.id ?? null;
}

// ── Wiring ──────────────────────────────────────────────────────────────────

/** Once per event bus: a kon re-enabled without a restart runs `onStartup` again. */
const listening = new WeakSet<object>();

export function listenToOtherKons(ctx: KonContext): void {
  if (!ctx.events?.on || listening.has(ctx.events)) return;
  listening.add(ctx.events);

  const run = (what: string, fn: (db: CrmDb) => Promise<unknown>) => (): void => {
    const job = async () => {
      const db = ctx.db.instance as CrmDb;
      const asSystem = ctx.db.asSystem ?? (<T>(f: () => Promise<T>) => f());
      try {
        await asSystem(() => (db.transaction ? db.transaction((tx: CrmDb) => fn(tx)) : fn(db)));
      } catch (err) {
        ctx.logger.warn(`[CRM] could not record ${what}`, { error: err instanceof Error ? err.message : String(err) });
      }
    };
    void (ctx.db.background ? ctx.db.background(job) : job());
  };

  ctx.events.on("shop:order.paid", (data: unknown) => run("a paid order", (db) => onShopOrderPaid(db, data))());
  ctx.events.on("newsletter:member.subscribed", (data: unknown) =>
    run("a newsletter subscription", (db) => onNewsletterSubscribed(db, data))()
  );
  ctx.events.on("payment:payment.succeeded", (data: unknown) =>
    run("a payment", (db) => onPayment(db, "succeeded", data, (id) => contactOfOrder(db, id)))()
  );
  ctx.events.on("payment:payment.refunded", (data: unknown) =>
    run("a refund", (db) => onPayment(db, "refunded", data, (id) => contactOfOrder(db, id)))()
  );
  ctx.events.on("inbox:message.received", (data: unknown) => run("an email", (db) => onInboxMessage(db, data))());
  ctx.events.on("inbox:event.synced", (data: unknown) => run("a meeting", (db) => onInboxEvent(db, data))());
  // One "do not contact" with the newsletter (crm.exclusions.ts).
  listenToNewsletterExclusions(ctx);
}

/**
 * Kitsuden Payments — Service
 * ============================================================================
 * Applies a normalized event to the state: records the log (idempotent),
 * updates the subscription and, if the bridge is active, generates the accounting
 * entry in kon-conta.
 */

import { withSavepoint, attemptSql } from "@kitsuden/engine";
import { and, eq, gt, or } from "drizzle-orm";

import { payCustomers, paySubscriptions, payEvents } from "./payments.schema";
import type { PaymentEvent } from "./payments.types";

/** Drizzle executor (db or tx). */
type Db = any;

export interface ApplyResult {
  /** false if the event had already been processed (provider retry). */
  applied: boolean;
  reason?: string;
  subscriptionId?: string;
  journalId?: string;
  /** Account the event has been attributed to (null if it could not be matched). */
  userId?: string | null;
  /**
   * The subscription's state after the event, when the event touched one with a known owner.
   * Emitted with `payment:<type>` so other kons (kon-members) follow it without reading `pay_*`.
   */
  subscription?: SubscriptionState;
}

/** A subscription's state after an event, as other kons see it. */
export interface SubscriptionState {
  id: string;
  status: string;
  planId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

/** Customer id AT the provider for THIS user (or null). Never from the body. */
export async function customerOfUser(
  db: Db,
  userId: string,
  provider: string
): Promise<string | null> {
  const [row] = await db
    .select({ externalId: payCustomers.externalId })
    .from(payCustomers)
    .where(and(eq(payCustomers.userId, userId), eq(payCustomers.provider, provider)))
    .limit(1);
  return row?.externalId ?? null;
}

/** Extracts the userId: first from the metadata, otherwise by the already known customer. */
async function resolveUserId(db: Db, event: PaymentEvent): Promise<string | null> {
  // 1. The metadata is the reliable route: the app put it there when opening the checkout.
  const fromMeta = event.metadata?.userId ?? event.metadata?.user_id;
  if (fromMeta) return fromMeta;

  // 2. Customer already linked in a previous payment.
  if (event.customerId) {
    const [row] = await db
      .select({ userId: payCustomers.userId })
      .from(payCustomers)
      .where(
        and(
          eq(payCustomers.provider, event.provider),
          eq(payCustomers.externalId, event.customerId)
        )
      )
      .limit(1);
    if (row) return row.userId;
  }

  // 3. By email: NO LONGER (an earlier audit). The payment's email is typed by
  //    whoever pays, unverified. An account that paid once with another
  //    person's email stayed linked to that email in `pay_customers`, and
  //    the victim's later payments without metadata (a direct
  //    payment link, a renewal from another gateway) were ATTRIBUTED to the attacker.
  //    An event with no clear owner is recorded with user_id NULL in `pay_events`
  //    and reconciled by hand; losing automatic attribution is better than
  //    giving it away.
  return null;
}

/**
 * Applies an event. It is IDEMPOTENT: the unique index on
 * (provider, externalId) means a provider retry duplicates nothing.
 *
 * `onLedger` is optional — if passed, it is called to generate the accounting
 * entry. It is injected so that the payments kon does not depend on kon-conta
 * (it works the same without it).
 */
/**
 * Uniqueness violation? Drizzle 0.45 wraps the pg error («Failed query:
 * …») and the SQLSTATE and Postgres text go in `cause`: looking only at the
 * outer message, a provider retry came out as a 500.
 */
function isDuplicate(err: unknown): boolean {
  for (let actual = err, i = 0; actual && i < 3; i++) {
    const code = typeof actual === "object" && "code" in actual ? actual.code : undefined;
    const message = actual instanceof Error ? actual.message : String(actual);
    if (code === "23505" || /unique|duplicate/i.test(message)) return true;
    actual = actual instanceof Error ? actual.cause : undefined;
  }
  return false;
}

export async function applyPaymentEvent(
  db: Db,
  event: PaymentEvent,
  onLedger?: (event: PaymentEvent, userId: string | null) => Promise<string | undefined>
): Promise<ApplyResult> {
  // 1. Idempotency: the insert is attempted first. If it collides with the unique
  //    index, the event was already processed and it exits without touching anything else.
  const userId = await resolveUserId(db, event);

  // Entry + event in ONE savepoint of the request's transaction:
  //   · if the event was already there (unique index), the entry just
  //     made is also undone —a provider retry does not duplicate the books— and
  //     the transaction stays alive to respond 200;
  //   · an accounting failure goes in its own savepoint inside: it does not lose the payment.
  let journalId: string | undefined;
  try {
    journalId = await withSavepoint(async () => {
      // An accounting failure must not lose the payment: the event is recorded anyway and
      // the entry can be reconciled later from the log.
      const entry = onLedger
        ? await attemptSql(() => onLedger(event, userId), undefined)
        : undefined;

      await db.insert(payEvents).values({
        provider: event.provider,
        externalId: event.externalId,
        type: event.type,
        userId,
        subscriptionId: event.subscriptionId,
        amount: event.money?.amount,
        currency: event.money?.currency,
        journalId: entry,
        payload: event.raw as Record<string, unknown>,
      });
      return entry;
    });
  } catch (err) {
    // Uniqueness violation = already processed. Any other error does matter.
    if (isDuplicate(err)) {
      return { applied: false, reason: "Event already processed (provider retry)" };
    }
    throw err;
  }

  // 2. Link the customer if it is the first time we see them.
  if (userId && event.customerId) {
    // The link is a shortcut, not a guarantee: it does not block the event (and in its
    // savepoint, a failure does not leave the transaction aborted for step 3).
    const { customerId } = event;
    await attemptSql(
      () =>
        db
          .insert(payCustomers)
          .values({
            userId,
            provider: event.provider,
            externalId: customerId,
            email: event.customerEmail,
          })
          .onConflictDoNothing(),
      undefined
    );
  }

  // 3. Subscription state.
  let subscription: SubscriptionState | undefined;
  if (event.subscriptionId && userId) {
    const status = statusAfterEvent(event);
    // A refund cuts access NOW: the «paid» period stops being so.
    const periodEnd =
      event.type === "payment.refunded" ? event.occurredAt : event.currentPeriodEnd;

    const values = {
      userId,
      provider: event.provider,
      externalId: event.subscriptionId,
      planId: event.planId,
      status,
      currentPeriodEnd: periodEnd ? new Date(periodEnd) : null,
      // A refund or a cancellation that already took effect has nothing left to end later.
      cancelAtPeriodEnd: event.type === "payment.refunded" ? false : event.cancelAtPeriodEnd,
      metadata: event.metadata,
      updatedAt: new Date(),
    };

    // `cancelAtPeriodEnd` is only written when the event says it: an event without the flag
    // (an invoice, a PayPal webhook) must not undo a cancellation recorded earlier.
    const [row] = await db
      .insert(paySubscriptions)
      .values({ ...values, cancelAtPeriodEnd: values.cancelAtPeriodEnd ?? false })
      .onConflictDoUpdate({
        target: [paySubscriptions.provider, paySubscriptions.externalId],
        set: {
          status: values.status,
          planId: values.planId,
          currentPeriodEnd: values.currentPeriodEnd,
          ...(values.cancelAtPeriodEnd === undefined
            ? {}
            : { cancelAtPeriodEnd: values.cancelAtPeriodEnd }),
          updatedAt: values.updatedAt,
        },
      })
      .returning({
        planId: paySubscriptions.planId,
        currentPeriodEnd: paySubscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: paySubscriptions.cancelAtPeriodEnd,
      });

    subscription = {
      id: event.subscriptionId,
      status,
      planId: row?.planId ?? values.planId ?? null,
      currentPeriodEnd: row?.currentPeriodEnd
        ? new Date(row.currentPeriodEnd).toISOString()
        : null,
      cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? values.cancelAtPeriodEnd ?? false,
    };
  }

  return { applied: true, subscriptionId: event.subscriptionId, journalId, userId, subscription };
}

/**
 * Subscription state after an event.
 *
 * Before, any event without an explicit `status` left the subscription in
 * `active` — including `payment.refunded` and `payment.failed`. A Stripe
 * refund (`charge.refunded`) arrived with the charge id as the «subscription» and
 * CREATED an active row: requesting the refund gave paid access for free.
 * Negative events take precedence over the `status` the payload brings.
 */
export function statusAfterEvent(event: PaymentEvent): string {
  switch (event.type) {
    case "payment.refunded":
    case "subscription.canceled":
      return "canceled";
    case "payment.failed":
    case "subscription.payment_failed":
      return "past_due";
    case "subscription.payment_succeeded":
      // A completed charge: activates even if the status comes unmapped (LS: "paid")
      return event.status && event.status !== "incomplete" ? event.status : "active";
    default:
      // A status that is not recognized is NOT taken as paid (an earlier audit:
      // the `?? "active"` turned any odd event into access).
      return event.status ?? "incomplete";
  }
}

/**
 * Does this user have paid access right now?
 *
 * The PAID PERIOD is checked, not just the status: a `canceled`
 * subscription still gives access until what was already charged ends. Charging and
 * cutting off access the same day is the classic complaint about badly built SaaS.
 */
export async function hasActiveAccess(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: paySubscriptions.id })
    .from(paySubscriptions)
    .where(
      and(
        eq(paySubscriptions.userId, userId),
        or(
          eq(paySubscriptions.status, "active"),
          eq(paySubscriptions.status, "trialing"),
          // Canceled but with the period still in force.
          and(
            eq(paySubscriptions.status, "canceled"),
            gt(paySubscriptions.currentPeriodEnd, new Date())
          )
        )
      )
    )
    .limit(1);

  return Boolean(row);
}

/** A user's subscriptions (all, including ended ones). */
export async function listSubscriptions(db: Db, userId: string) {
  return db.select().from(paySubscriptions).where(eq(paySubscriptions.userId, userId));
}

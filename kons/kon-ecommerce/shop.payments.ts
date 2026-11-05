/**
 * Orders and money: moving status, and listening to kon-payments
 * ============================================================================
 *
 * Every status change goes through `applyStatus`, whether the team clicks it, a payment arrives or
 * a refund does. The side effects travel with the change, in its transaction:
 *
 *   paid      → `paid_at`, the payment reference, and the digital lines' entitlements;
 *   cancelled → the reserved units and the discount-code use go back;
 *   refunded  → the entitlements are revoked.
 *
 * ── WHY THE AMOUNT IS CHECKED AGAIN ────────────────────────────────────────
 *
 * The provider charges what it was told, and the webhook says what it charged. Before marking an
 * order paid, the amount and currency are compared with the order's total. A mismatch (a payment
 * page edited by hand at the provider, a code changed between paying and confirming) leaves the
 * order pending and raises `shop:order.payment-mismatch` for a person to look at.
 *
 * ── A PAYMENT THAT ARRIVES LATE ────────────────────────────────────────────
 *
 * Reservations expire (shop.orders.ts): someone can pay a page they left open after the order was
 * cancelled and its units went back on sale. Then the units are reserved again if they are still
 * there; if they are not, the order stays cancelled with the payment noted, and
 * `shop:order.paid-but-unavailable` asks a person to refund it. Never "paid" for goods that are gone.
 */

import { and, eq } from "drizzle-orm";

import { grantEntitlements, revokeEntitlements, type DeliveryResult } from "./shop.delivery";
import {
  canTransition,
  reserveStock,
  restockOrder,
  statusAfterPayment,
  type FrozenLine,
} from "./shop.orders";
import { claimPromotion, releasePromotion } from "./shop.promotions";
import { shopOrderItems, shopOrders, type ShopOrder } from "./shop.schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a Drizzle instance or transaction
type Db = any;

export type OrderStatus = ShopOrder["status"];

/** The statuses an order reaches only after being paid. */
export const PAID_STATUSES: ReadonlySet<string> = new Set([
  "paid",
  "in_production",
  "ready",
  "shipped",
  "delivered",
]);

export interface StatusOptions {
  paymentRef?: string | null;
  paymentProvider?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  now?: Date;
}

export interface StatusResult {
  /** The updated row, or `null` if the order changed meanwhile (the caller answers 409). */
  order: ShopOrder | null;
  delivery?: DeliveryResult;
}

/**
 * Moves `order` to `status` with its side effects, all in one transaction. The UPDATE is
 * conditional on the status read, so two operators (or an operator and a webhook) cannot
 * overwrite each other. The caller has already checked `canTransition`.
 */
export async function applyStatus(
  db: Db,
  order: ShopOrder,
  status: OrderStatus,
  options: StatusOptions = {}
): Promise<StatusResult> {
  const now = options.now ?? new Date();
  // Charging has a different natural destination depending on fulfillment: digital goods deliver
  // themselves, physical ones enter production.
  const target = status === "paid" ? statusAfterPayment(order.fulfillmentType) : status;
  const final = canTransition(status, target) ? target : status;

  const change = async (tx: Db): Promise<StatusResult> => {
    const [row] = await tx
      .update(shopOrders)
      .set({
        status: final,
        paymentRef: options.paymentRef ?? order.paymentRef,
        paymentProvider: options.paymentProvider ?? order.paymentProvider,
        trackingNumber: options.trackingNumber ?? order.trackingNumber,
        trackingUrl: options.trackingUrl ?? order.trackingUrl,
        ...(status === "paid" ? { paidAt: now } : {}),
        updatedAt: now,
      })
      .where(and(eq(shopOrders.id, order.id), eq(shopOrders.status, order.status)))
      .returning();
    if (!row) return { order: null };

    if (final === "cancelled") {
      await restockOrder(order.id, tx);
      await releasePromotion(tx, order.id);
    }
    if (final === "refunded") await revokeEntitlements(tx, order.id, now);
    const delivery = status === "paid" ? await grantEntitlements(tx, order.id, now) : undefined;
    return { order: row as ShopOrder, delivery };
  };

  return db.transaction ? db.transaction((tx: Db) => change(tx)) : change(db);
}

// ── Opening a payment through kon-payments ──────────────────────────────────

/** A one-time payment, the shape kon-payments' `openOrderCheckout` takes. */
export interface OrderPaymentInput {
  lines: Array<{ name: string; unitAmount: number; quantity: number }>;
  currency: string;
  successUrl: string;
  cancelUrl?: string;
  customerEmail?: string;
  metadata: Record<string, string>;
  expiresInMinutes?: number;
}

export type OrderPaymentResult =
  | { ok: true; session: { url: string; id: string } }
  | { ok: false; status: 404 | 422 | 502; message: string };

/** What the shop needs from kon-payments. Injected in tests; loaded at runtime otherwise. */
export interface ShopPaymentGateway {
  /** Providers that can charge a one-time amount. */
  providers(): string[];
  open(provider: string, input: OrderPaymentInput): Promise<OrderPaymentResult>;
}

/**
 * kon-payments, loaded at runtime as a sibling — the same way it loads kon-conta. The specifier
 * goes in a variable so that type-checking the shop does not require that kon. `null` when it is
 * not installed: the shop still sells, and the team marks orders paid by hand.
 */
export async function loadPaymentGateway(): Promise<ShopPaymentGateway | null> {
  try {
    const specifier = "../kon-payments/index";
    const m = (await import(/* @vite-ignore */ specifier)) as {
      buildProviders(): Map<string, unknown>;
      orderProviderNames(p: Map<string, unknown>): string[];
      openOrderCheckout(
        p: Map<string, unknown>,
        name: string,
        input: OrderPaymentInput
      ): Promise<OrderPaymentResult>;
    };
    return {
      // Built per call: keys can be added while the API is running.
      providers: () => m.orderProviderNames(m.buildProviders()),
      open: (provider, input) => m.openOrderCheckout(m.buildProviders(), provider, input),
    };
  } catch {
    return null;
  }
}

// ── Listening to kon-payments ───────────────────────────────────────────────

/** The part of kon-payments' normalized event the shop reads. Structural: no import of that kon. */
export interface PaymentEventLike {
  type: string;
  provider: string;
  externalId: string;
  paymentId?: string;
  settled?: boolean;
  partial?: boolean;
  money?: { amount: number; currency: string };
  metadata?: Record<string, string>;
}

export type PaymentOutcome =
  | "ignored"
  | "not-settled"
  | "mismatch"
  | "already"
  | "paid"
  | "paid-but-unavailable"
  | "refunded"
  | "partial-refund"
  /** Refunded at the provider, but the order's status cannot become `refunded` (one in production, say). */
  | "refund-unapplied";

export interface PaymentHandling {
  outcome: PaymentOutcome;
  order?: ShopOrder;
  /** The status the order had before this event moved it. */
  from?: string;
  delivery?: DeliveryResult;
}

async function orderById(db: Db, id: string): Promise<ShopOrder | null> {
  const [row] = await db.select().from(shopOrders).where(eq(shopOrders.id, id)).limit(1);
  return (row as ShopOrder) ?? null;
}

/**
 * A `payment:payment.succeeded` from kon-payments. Only payments the shop opened carry
 * `metadata.shopOrderId`; anything else (a subscription, another kon's sale) is ignored.
 */
export async function onPaymentSucceeded(
  db: Db,
  event: PaymentEventLike,
  now: Date = new Date()
): Promise<PaymentHandling> {
  const orderId = event.metadata?.shopOrderId;
  if (!orderId) return { outcome: "ignored" };
  // Bank debits complete before the money arrives; the provider sends another event when it does.
  if (event.settled === false) return { outcome: "not-settled" };

  const order = await orderById(db, orderId);
  if (!order) return { outcome: "ignored" };

  if (
    !event.money ||
    event.money.amount !== order.totalCents ||
    event.money.currency.toUpperCase() !== order.currency.toUpperCase()
  ) {
    return { outcome: "mismatch", order };
  }

  const reference = {
    paymentRef: event.paymentId ?? event.externalId,
    paymentProvider: event.provider,
    now,
  };

  if (PAID_STATUSES.has(order.status) || order.status === "refunded")
    return { outcome: "already", order };

  if (order.status === "pending") {
    const r = await applyStatus(db, order, "paid", reference);
    // `null`: something moved it meanwhile (a second copy of the same webhook, the expiry sweep).
    // Read it again and decide on what it is now.
    if (!r.order) return onPaymentSucceeded(db, event, now);
    return { outcome: "paid", order: r.order, delivery: r.delivery, from: "pending" };
  }

  // Cancelled, most likely because nobody paid in time: take the units again if they are still there.
  const retake = async (tx: Db): Promise<PaymentHandling> => {
    const lines = (await tx
      .select()
      .from(shopOrderItems)
      .where(eq(shopOrderItems.orderId, order.id))) as Array<{
      variantId: string | null;
      productName: string;
      quantity: number;
    }>;
    const toReserve = lines.filter((l) => l.variantId) as unknown as FrozenLine[];
    const reserved = await reserveStock(toReserve, tx);
    if (!reserved.ok) {
      // Note the payment on the order so the refund finds it, and leave it cancelled.
      await tx
        .update(shopOrders)
        .set({
          paymentRef: reference.paymentRef,
          paymentProvider: reference.paymentProvider,
          updatedAt: now,
        })
        .where(eq(shopOrders.id, order.id));
      return { outcome: "paid-but-unavailable", order };
    }
    if (order.promotionId) await claimPromotion(tx, order.promotionId); // best effort: they paid with it
    const [reopened] = await tx
      .update(shopOrders)
      .set({ status: "pending", updatedAt: now })
      .where(and(eq(shopOrders.id, order.id), eq(shopOrders.status, "cancelled")))
      .returning();
    if (!reopened) return { outcome: "already", order };
    const r = await applyStatus(tx, reopened as ShopOrder, "paid", reference);
    return {
      outcome: "paid",
      order: r.order ?? undefined,
      delivery: r.delivery,
      from: "cancelled",
    };
  };
  return db.transaction ? db.transaction((tx: Db) => retake(tx)) : retake(db);
}

/**
 * A `payment:payment.refunded`. The order is found by the payment it was charged with (or by the
 * metadata when the provider repeats it). A PARTIAL refund changes nothing here: what was
 * delivered stays delivered, and the event tells whoever needs to know.
 */
export async function onPaymentRefunded(
  db: Db,
  event: PaymentEventLike,
  now: Date = new Date()
): Promise<PaymentHandling> {
  let order: ShopOrder | null = null;
  if (event.metadata?.shopOrderId) order = await orderById(db, event.metadata.shopOrderId);
  if (!order && event.paymentId) {
    const [row] = await db
      .select()
      .from(shopOrders)
      .where(
        and(
          eq(shopOrders.paymentRef, event.paymentId),
          eq(shopOrders.paymentProvider, event.provider)
        )
      )
      .limit(1);
    order = (row as ShopOrder) ?? null;
  }
  if (!order) return { outcome: "ignored" };
  if (event.partial) return { outcome: "partial-refund", order };
  if (order.status === "refunded") return { outcome: "already", order };
  // Money went back but the order cannot say so by itself (in production, cancelled after a late
  // payment…): a person decides, so it is reported instead of dropped.
  if (!canTransition(order.status, "refunded")) return { outcome: "refund-unapplied", order };

  const r = await applyStatus(db, order, "refunded", { now });
  return r.order
    ? { outcome: "refunded", order: r.order, from: order.status }
    : { outcome: "already", order };
}

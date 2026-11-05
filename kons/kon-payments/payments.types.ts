/**
 * Kitsuden Payments — Provider contract
 * ============================================================================
 *
 * The strategy is to CONNECT, not compete: Stripe, Lemon Squeezy, Paddle and
 * PayPal do the same thing (charge, subscribe, notify via webhook) with different
 * APIs. This interface normalizes them so that:
 *
 *   1. The app does not change when switching providers.
 *   2. ALL of them flow into a single event stream → and from there, optionally,
 *      into kon-conta's ledger. That single funnel is what no
 *      competitor has: the books balance themselves whatever the gateway.
 *
 * DESIGN DECISIONS
 *
 * · Money in CENTS (integers). Floats round badly and with money that
 *   is an accounting bug, not a detail.
 * · Signature verification MANDATORY on every provider. An unverified
 *   webhook is an endpoint where anyone declares payments.
 * · Events with `externalId` for IDEMPOTENCY: providers retry, and
 *   processing twice would duplicate entries and accesses.
 */

// ── Money ────────────────────────────────────────────────────────────────────

/** Amount in the minimum unit (cents). 1050 = €10.50. */
export interface Money {
  amount: number;
  /** ISO-4217 in uppercase: EUR, USD… */
  currency: string;
}

// ── Normalized events ────────────────────────────────────────────────────────

export type PaymentEventType =
  | "payment.succeeded"
  | "payment.failed"
  | "payment.refunded"
  | "subscription.created"
  | "subscription.updated"
  | "subscription.canceled"
  | "subscription.payment_succeeded"
  | "subscription.payment_failed";

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "paused"
  | "expired"
  /**
   * Created but not charged yet (PayPal before approving and activating, a
   * Stripe checkout with an asynchronous payment pending). Does NOT give access.
   */
  | "incomplete";

/**
 * An already normalized event, whatever the provider.
 * It is the only thing the rest of the app sees.
 */
export interface PaymentEvent {
  type: PaymentEventType;
  provider: string;
  /**
   * Event id AT THE PROVIDER. Idempotency key: if it was already processed,
   * it is ignored. Providers retry webhooks aggressively.
   */
  externalId: string;
  /** Customer id at the provider. */
  customerId?: string;
  /** Email — sometimes the only thing the user can be matched with. */
  customerEmail?: string;
  /** Subscription id, if applicable. */
  subscriptionId?: string;
  /** Id of the plan/price purchased. */
  planId?: string;
  status?: SubscriptionStatus;
  money?: Money;
  /** End of the paid period — until when to give access. */
  currentPeriodEnd?: string;
  /**
   * The subscription is set to end when the paid period does (the customer cancelled, the access
   * runs out at `currentPeriodEnd`). `undefined` when the provider's event does not say.
   */
  cancelAtPeriodEnd?: boolean;
  /**
   * Id of the PAYMENT at the provider (Stripe payment intent, Lemon Squeezy order…). A later
   * refund names the same id, which is how a one-time purchase is found again without metadata.
   */
  paymentId?: string;
  /**
   * The money was really captured. A Stripe checkout paid by bank debit completes BEFORE the
   * money arrives (`payment_status: "unpaid"`): whatever hands over goods must wait for `true`.
   */
  settled?: boolean;
  /** A refund of PART of the payment: whatever was delivered stays delivered. */
  partial?: boolean;
  /** Data the app attached when starting the checkout (e.g. userId). */
  metadata: Record<string, string>;
  occurredAt: string;
  /** Raw payload, for auditing and for whatever normalization does not cover. */
  raw: unknown;
}

// ── Checkout ─────────────────────────────────────────────────────────────────

export interface CheckoutInput {
  /** Plan/price id at the provider. */
  planId: string;
  /** Where to return after paying. */
  successUrl: string;
  cancelUrl?: string;
  customerEmail?: string;
  /** Customer id if it already exists at the provider. */
  customerId?: string;
  /**
   * Returned as is in the webhook. Your app's `userId` goes here: it is what
   * allows matching the payment with the account without depending on the email.
   */
  metadata?: Record<string, string>;
  /** Quantity, for unit-price products. */
  quantity?: number;
}

/** One line of a one-time payment: a name the buyer recognizes and the amount, in cents. */
export interface PaymentCheckoutLine {
  name: string;
  /** Per unit, in cents. Never below zero. */
  unitAmount: number;
  quantity: number;
}

/**
 * A ONE-TIME payment whose amount the app computes (a shop order), as opposed to `CheckoutInput`,
 * which subscribes to a plan priced at the provider.
 *
 * The amount is the caller's responsibility and the caller must check it again when the payment
 * arrives: the provider charges what it is told.
 */
export interface PaymentCheckoutInput {
  lines: PaymentCheckoutLine[];
  /** ISO-4217, one per payment. */
  currency: string;
  successUrl: string;
  cancelUrl?: string;
  customerEmail?: string;
  /** Comes back in the webhook: how the payment finds its order. */
  metadata: Record<string, string>;
  /** How long the payment page stays open, when the provider lets it be set. */
  expiresInMinutes?: number;
}

export interface CheckoutSession {
  /** URL to redirect the user to. */
  url: string;
  /** Session id at the provider. */
  id: string;
}

// ── Provider ─────────────────────────────────────────────────────────────────

export interface PaymentProvider {
  readonly name: string;

  /** Is it configured (has keys)? If not, the kon skips it. */
  isConfigured(): boolean;

  /** Creates a payment session and returns the redirect URL. */
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;

  /**
   * Creates a ONE-TIME payment for an amount the app computed (a shop order). Optional: a
   * provider without it cannot charge shop orders, and the shop says so instead of failing.
   */
  createPaymentCheckout?(input: PaymentCheckoutInput): Promise<CheckoutSession>;

  /**
   * Verifies the webhook signature and normalizes it.
   *
   * RETURNS null if the signature does not validate — never throws for an invalid signature, so
   * the route responds 400 without noise. An unverified webhook is discarded.
   * Returns `undefined` if the signature is valid but the event is not of interest.
   */
  parseWebhook(
    rawBody: string,
    headers: Record<string, string>
  ): Promise<PaymentEvent | null | undefined>;

  /** Customer portal URL (change card, cancel). Optional. */
  createPortalSession?(customerId: string, returnUrl: string): Promise<{ url: string }>;

  /** Cancels a subscription. Optional. */
  cancelSubscription?(subscriptionId: string, immediately?: boolean): Promise<void>;
}

// ── Shared utilities ─────────────────────────────────────────────────────────

/** Normalizes headers to lowercase (providers vary the casing). */
export function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Constant-time comparison.
 *
 * A `===` on signatures allows timing attacks: the attacker measures
 * how long it takes to fail to deduce the signature byte by byte. Impractical over
 * a network, but it is the standard in webhook verification and costs nothing.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

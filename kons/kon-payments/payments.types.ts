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
  /**
   * The kon's own reference for this payment (`pay_checkouts.reference`), for providers that
   * report the result by an order number of the merchant's (Tilopay, Yappy) instead of carrying
   * metadata back. Set by `openOrderCheckout`; a provider that does not need it ignores it.
   */
  reference?: string;
  /** Who pays, for providers that require a billing address (Tilopay). */
  billing?: CheckoutBilling;
  /** The payer's phone, without country prefix, for wallet providers that ask for it (Yappy). */
  customerPhone?: string;
}

export interface CheckoutBilling {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  address2?: string;
  city: string;
  /** ISO 3166-2 subdivision, e.g. `CR-SJ`, `PA-8` */
  state: string;
  zip: string;
  /** ISO 3166-1 alpha-2 */
  country: string;
}

export interface CheckoutSession {
  /**
   * URL to redirect the user to. Empty for a provider whose payment happens in a button on the
   * merchant's own page (`button` below): there is nowhere to redirect to.
   */
  url: string;
  /** Session id at the provider. */
  id: string;
  /**
   * For a provider that pays inside the merchant's page (Yappy): the script to load and the
   * values to hand to its component. The site renders the button; nothing here is secret.
   */
  button?: {
    script: string;
    params: Record<string, string>;
  };
}

/**
 * A one-time payment this kon opened, as `pay_checkouts` keeps it: what a provider that reports
 * only an order number needs to rebuild the event (amount, metadata), read on the server and
 * never taken from the request.
 */
export interface PendingCheckout {
  reference: string;
  provider: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string | null;
}

/** What a provider makes of a return to the site or a GET notification. */
export interface ReturnResult {
  /** The normalized event; `null` when the request is not authentic; `undefined` when it says nothing new. */
  event: PaymentEvent | null | undefined;
  /** Where to send the browser, when the request came from one. Absent: answer JSON (a server notification). */
  redirect?: string;
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

  /**
   * `redirect` (the default): `createPaymentCheckout` answers a URL to send the buyer to.
   * `button`: it answers `button`, and the site renders the provider's component.
   */
  readonly checkoutStyle?: "redirect" | "button";

  /**
   * For providers that report a result by sending the buyer back, or by a GET notification,
   * instead of a signed POST: `GET /return/:provider`. `find` reads the payment this kon opened
   * by its reference, on the server: the request's own values are never trusted for the amount
   * or the metadata.
   */
  parseReturn?(
    query: Record<string, string>,
    find: (reference: string) => Promise<PendingCheckout | null>
  ): Promise<ReturnResult>;

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

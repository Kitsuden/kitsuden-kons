/**
 * One-time payments for other kons (the shop, kon-odoo)
 * ============================================================================
 *
 * `POST /checkout` subscribes a SIGNED-IN account to a plan priced at the provider. A shop order
 * is neither: the buyer has no account and the amount is computed per order. This is the door
 * for that case, in two forms:
 *
 *   · `openOrderCheckout`, loaded at runtime by kon-ecommerce (as kon-payments loads kon-conta);
 *   · `POST /api/payments/orders/checkout`, for a site's own backend or another kon that does
 *     not load this one, with a key that opens kon-payments.
 *
 * Every payment opened through the route is kept in `pay_checkouts` under a short reference of
 * this kon's: providers that report a result only by an order number (Tilopay, Yappy) find their
 * amount and metadata there.
 *
 * What stays the caller's job: checking who may pay that order, and checking the amount AGAIN
 * when the `payment:payment.succeeded` event arrives — the provider charges what it is told.
 */

import { randomInt } from "node:crypto";

import { allowedReturnUrl } from "./payments.routes";
import type { CheckoutSession, PaymentCheckoutInput, PaymentProvider, PendingCheckout } from "./payments.types";

export type OrderCheckoutResult =
  | { ok: true; session: CheckoutSession; reference: string }
  | { ok: false; status: 404 | 422 | 502; message: string };

/**
 * The configured providers that can charge a one-time amount. By default only those that answer
 * a URL to redirect to: a caller written before button providers existed (kon-ecommerce) would
 * redirect to an empty address. A caller that can render a provider's button asks for both.
 */
export function orderProviderNames(
  providers: Map<string, PaymentProvider>,
  styles: Array<"redirect" | "button"> = ["redirect"]
): string[] {
  return [...providers.values()]
    .filter(
      (p) =>
        p.isConfigured() &&
        typeof p.createPaymentCheckout === "function" &&
        styles.includes(p.checkoutStyle ?? "redirect")
    )
    .map((p) => p.name);
}

/**
 * 15 letters and digits: what Yappy accepts as an order id, and unguessable enough. `randomInt`
 * draws each character evenly; a byte modulo the alphabet would favour some (CodeQL
 * js/biased-cryptographic-random).
 */
export function newReference(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let reference = "K";
  for (let i = 0; i < 14; i++) reference += alphabet[randomInt(alphabet.length)];
  return reference;
}

/** Keeps the payment this kon is about to open. */
export type StoreCheckout = (row: PendingCheckout) => Promise<void>;

/**
 * Opens a one-time payment with one provider. Same return-URL rule as `POST /checkout`: only the
 * site's own origins, or the payment page becomes an open redirector with the provider's brand.
 */
export async function openOrderCheckout(
  providers: Map<string, PaymentProvider>,
  providerName: string,
  input: PaymentCheckoutInput,
  env = process.env,
  store?: StoreCheckout
): Promise<OrderCheckoutResult> {
  const provider = providers.get(providerName);
  if (!provider?.isConfigured() || !provider.createPaymentCheckout) {
    return {
      ok: false,
      status: 404,
      message: `Provider "${providerName}" cannot charge orders here`,
    };
  }
  for (const url of [input.successUrl, input.cancelUrl].filter(Boolean) as string[]) {
    if (!allowedReturnUrl(url, env))
      return { ok: false, status: 422, message: "Return URL not allowed" };
  }
  if (
    input.lines.length === 0 ||
    input.lines.some((l) => !Number.isInteger(l.unitAmount) || l.unitAmount < 0 || l.quantity < 1)
  ) {
    return { ok: false, status: 422, message: "Invalid amount" };
  }
  const amount = input.lines.reduce((sum, line) => sum + line.unitAmount * line.quantity, 0);
  if (amount <= 0) return { ok: false, status: 422, message: "Invalid amount" };

  // A provider that reports by order number cannot be used without somewhere to keep it.
  if (provider.parseReturn && !store) {
    return { ok: false, status: 404, message: `Provider "${providerName}" needs the payments database` };
  }

  const reference = newReference();
  const currency = input.currency.toUpperCase();
  try {
    // Kept BEFORE the provider is asked: a buyer can come back faster than this call returns.
    await store?.({
      reference,
      provider: provider.name,
      amount,
      currency,
      metadata: input.metadata,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl ?? null,
    });
    const session = await provider.createPaymentCheckout({ ...input, currency, reference });
    return { ok: true, session, reference };
  } catch (err) {
    // The detail stays in the caller's log; the buyer gets a plain answer.
    return {
      ok: false,
      status: 502,
      message: err instanceof Error ? err.message : "The payment provider did not respond",
    };
  }
}

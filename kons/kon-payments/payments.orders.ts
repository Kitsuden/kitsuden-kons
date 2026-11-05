/**
 * One-time payments for other kons (the shop)
 * ============================================================================
 *
 * `POST /checkout` subscribes a SIGNED-IN account to a plan priced at the provider. A shop order
 * is neither: the buyer has no account and the amount is computed per order. This is the door
 * for that case. Another kon loads it at runtime (as kon-payments loads kon-conta), so neither
 * kon needs the other to compile or to run.
 *
 * What stays the caller's job: checking who may pay that order, and checking the amount AGAIN
 * when the `payment:payment.succeeded` event arrives — the provider charges what it is told.
 */

import { allowedReturnUrl } from "./payments.routes";
import type { CheckoutSession, PaymentCheckoutInput, PaymentProvider } from "./payments.types";

export type OrderCheckoutResult =
  | { ok: true; session: CheckoutSession }
  | { ok: false; status: 404 | 422 | 502; message: string };

/** The configured providers that can charge a one-time amount. */
export function orderProviderNames(providers: Map<string, PaymentProvider>): string[] {
  return [...providers.values()]
    .filter((p) => p.isConfigured() && typeof p.createPaymentCheckout === "function")
    .map((p) => p.name);
}

/**
 * Opens a one-time payment with one provider. Same return-URL rule as `POST /checkout`: only the
 * site's own origins, or the payment page becomes an open redirector with the provider's brand.
 */
export async function openOrderCheckout(
  providers: Map<string, PaymentProvider>,
  providerName: string,
  input: PaymentCheckoutInput,
  env = process.env
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
  try {
    return { ok: true, session: await provider.createPaymentCheckout(input) };
  } catch (err) {
    // The detail stays in the caller's log; the buyer gets a plain answer.
    return {
      ok: false,
      status: 502,
      message: err instanceof Error ? err.message : "The payment provider did not respond",
    };
  }
}

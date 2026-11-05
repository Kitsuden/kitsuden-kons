/**
 * Kitsuden Payments — Paddle (Billing v2)
 * ============================================================================
 * The other merchant of record on the market. HMAC-SHA256 signature with timestamp,
 * in the same style as Stripe.
 *
 * NOTE: this implementation is for Paddle **Billing** (API v2, `api.paddle.com`),
 * NOT for Paddle Classic (`vendors.paddle.com`), which uses an RSA signature over a
 * PHP-serialized payload. They are different products with incompatible APIs.
 */

import { createHmac } from "node:crypto";

import {
  lowerHeaders,
  timingSafeEqual,
  type CheckoutInput,
  type CheckoutSession,
  type PaymentEvent,
  type PaymentEventType,
  type PaymentProvider,
  type SubscriptionStatus,
} from "../payments.types";

import { providerWait } from "./wait";

const STATUS: Record<string, SubscriptionStatus> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  canceled: "canceled",
  paused: "paused",
};

export function paddleProvider(env = process.env): PaymentProvider {
  const apiKey = env.PADDLE_API_KEY;
  const webhookSecret = env.PADDLE_WEBHOOK_SECRET;
  // Sandbox and production are different hosts.
  const api =
    env.PADDLE_ENV === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";

  return {
    name: "paddle",

    isConfigured: () => Boolean(apiKey),

    async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
      const res = await fetch(`${api}/transactions`, {
        signal: providerWait(),
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          items: [{ price_id: input.planId, quantity: input.quantity ?? 1 }],
          ...(input.customerId ? { customer_id: input.customerId } : {}),
          ...(input.metadata ? { custom_data: input.metadata } : {}),
          checkout: { url: input.successUrl },
        }),
      });

      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`Paddle ${res.status}: ${json?.error?.detail ?? "error"}`);
      }
      return { url: json.data?.checkout?.url, id: json.data?.id };
    },

    async parseWebhook(rawBody, headers) {
      if (!webhookSecret) return null;

      // Format: ts=<timestamp>;h1=<signature>
      const header = lowerHeaders(headers)["paddle-signature"];
      if (!header) return null;

      const parts = Object.fromEntries(
        header.split(";").map((p) => {
          const [k, ...v] = p.split("=");
          return [k.trim(), v.join("=")];
        })
      );
      const timestamp = parts.ts;
      const signature = parts.h1;
      if (!timestamp || !signature) return null;

      const age = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (!Number.isFinite(age) || age > 300) return null;

      const expected = createHmac("sha256", webhookSecret)
        .update(`${timestamp}:${rawBody}`)
        .digest("hex");
      if (!timingSafeEqual(expected, signature)) return null;

      const event = JSON.parse(rawBody);
      const data = event.data ?? {};

      const map: Record<string, PaymentEventType> = {
        "transaction.completed": "payment.succeeded",
        "transaction.payment_failed": "payment.failed",
        "adjustment.created": "payment.refunded",
        "subscription.created": "subscription.created",
        "subscription.updated": "subscription.updated",
        "subscription.canceled": "subscription.canceled",
      };

      const type = map[event.event_type];
      if (!type) return undefined;

      const total = data.details?.totals?.total ?? data.totals?.total;

      return {
        type,
        provider: "paddle",
        externalId: event.event_id,
        customerId: data.customer_id ?? undefined,
        customerEmail: data.customer?.email ?? undefined,
        subscriptionId:
          data.subscription_id ??
          (event.event_type.startsWith("subscription") ? data.id : undefined),
        planId: data.items?.[0]?.price?.id ?? data.items?.[0]?.price_id,
        status: STATUS[data.status] ?? undefined,
        // Paddle gives amounts as a string in the minimum unit.
        money:
          total != null
            ? { amount: Number(total), currency: String(data.currency_code ?? "USD").toUpperCase() }
            : undefined,
        currentPeriodEnd: data.current_billing_period?.ends_at ?? undefined,
        // A cancellation "at the next billing period" is a scheduled change on the subscription.
        cancelAtPeriodEnd: event.event_type.startsWith("subscription.")
          ? data.scheduled_change?.action === "cancel"
          : undefined,
        metadata: data.custom_data ?? {},
        occurredAt: event.occurred_at ?? new Date().toISOString(),
        raw: event,
      } satisfies PaymentEvent;
    },

    async cancelSubscription(subscriptionId, immediately = false) {
      const res = await fetch(`${api}/subscriptions/${subscriptionId}/cancel`, {
        signal: providerWait(),
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          effective_from: immediately ? "immediately" : "next_billing_period",
        }),
      });
      if (!res.ok) throw new Error(`Paddle cancel ${res.status}`);
    },
  };
}

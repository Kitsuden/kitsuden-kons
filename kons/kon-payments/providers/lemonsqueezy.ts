/**
 * Kitsuden Payments — Lemon Squeezy
 * ============================================================================
 * Merchant of record: LS invoices as the seller and handles VAT/sales tax.
 * For a solo dev selling in the EU that solves the most
 * painful problem of the digital business — that is why it is the second provider and not the
 * third.
 *
 * JSON:API, simple HMAC-SHA256 signature over the raw body.
 */

import { createHmac } from "node:crypto";

import {
  lowerHeaders,
  timingSafeEqual,
  type CheckoutInput,
  type CheckoutSession,
  type PaymentCheckoutInput,
  type PaymentEvent,
  type PaymentEventType,
  type PaymentProvider,
  type SubscriptionStatus,
} from "../payments.types";

import { providerWait } from "./wait";

const API = "https://api.lemonsqueezy.com/v1";

const STATUS: Record<string, SubscriptionStatus> = {
  on_trial: "trialing",
  active: "active",
  past_due: "past_due",
  cancelled: "canceled",
  paused: "paused",
  unpaid: "past_due",
  expired: "expired",
};

export function lemonSqueezyProvider(env = process.env): PaymentProvider {
  const apiKey = env.LEMONSQUEEZY_API_KEY;
  const storeId = env.LEMONSQUEEZY_STORE_ID;
  const webhookSecret = env.LEMONSQUEEZY_WEBHOOK_SECRET;

  return {
    name: "lemonsqueezy",

    isConfigured: () => Boolean(apiKey && storeId),

    async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
      const res = await fetch(`${API}/checkouts`, {
        signal: providerWait(),
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/vnd.api+json",
          Accept: "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "checkouts",
            attributes: {
              checkout_data: {
                ...(input.customerEmail ? { email: input.customerEmail } : {}),
                // `custom` is the equivalent of Stripe's metadata: it comes back in
                // the webhook and is how we match the payment with the user.
                ...(input.metadata ? { custom: input.metadata } : {}),
              },
              product_options: {
                redirect_url: input.successUrl,
              },
            },
            relationships: {
              store: { data: { type: "stores", id: String(storeId) } },
              variant: { data: { type: "variants", id: String(input.planId) } },
            },
          },
        }),
      });

      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`Lemon Squeezy ${res.status}: ${json?.errors?.[0]?.detail ?? "error"}`);
      }
      return { url: json.data.attributes.url, id: json.data.id };
    },

    /**
     * One-time payment for an amount the app computed. Lemon Squeezy sells VARIANTS, so it needs
     * one created for this purpose (`LEMONSQUEEZY_ORDER_VARIANT_ID`, a "pay what is asked" product)
     * and charges `custom_price` on it, in the store's currency. Without that variant, shop orders
     * cannot be charged here, and the method says so.
     */
    async createPaymentCheckout(input: PaymentCheckoutInput): Promise<CheckoutSession> {
      const variantId = env.LEMONSQUEEZY_ORDER_VARIANT_ID;
      if (!variantId) {
        throw new Error("Lemon Squeezy: LEMONSQUEEZY_ORDER_VARIANT_ID is not set");
      }
      const total = input.lines.reduce((n, l) => n + l.unitAmount * l.quantity, 0);
      const minutes = Math.min(Math.max(input.expiresInMinutes ?? 60, 5), 1440);
      const res = await fetch(`${API}/checkouts`, {
        signal: providerWait(),
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/vnd.api+json",
          Accept: "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "checkouts",
            attributes: {
              custom_price: total,
              product_options: {
                name: input.metadata.shopOrderNumber
                  ? `Order ${input.metadata.shopOrderNumber}`
                  : "Order",
                description: input.lines
                  .map((l) => `${l.quantity} × ${l.name}`)
                  .join(", ")
                  .slice(0, 500),
                redirect_url: input.successUrl,
              },
              checkout_data: {
                ...(input.customerEmail ? { email: input.customerEmail } : {}),
                custom: input.metadata,
              },
              expires_at: new Date(Date.now() + minutes * 60_000).toISOString(),
            },
            relationships: {
              store: { data: { type: "stores", id: String(storeId) } },
              variant: { data: { type: "variants", id: String(variantId) } },
            },
          },
        }),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`Lemon Squeezy ${res.status}: ${json?.errors?.[0]?.detail ?? "error"}`);
      }
      return { url: json.data.attributes.url, id: json.data.id };
    },

    async parseWebhook(rawBody, headers) {
      if (!webhookSecret) return null;

      const signature = lowerHeaders(headers)["x-signature"];
      if (!signature) return null;

      const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
      if (!timingSafeEqual(expected, signature)) return null;

      const event = JSON.parse(rawBody);
      const name: string = event.meta?.event_name ?? "";
      const attrs = event.data?.attributes ?? {};

      const map: Record<string, PaymentEventType> = {
        order_created: "payment.succeeded",
        order_refunded: "payment.refunded",
        subscription_created: "subscription.created",
        subscription_updated: "subscription.updated",
        subscription_cancelled: "subscription.canceled",
        subscription_expired: "subscription.canceled",
        subscription_payment_success: "subscription.payment_succeeded",
        subscription_payment_failed: "subscription.payment_failed",
      };

      const type = map[name];
      if (!type) return undefined;

      return {
        type,
        provider: "lemonsqueezy",
        // LS does not send an event id of its own: a stable one is composed from the
        // event name and the resource id (enough for idempotency).
        externalId: `ls_${name}_${event.data?.id ?? ""}_${attrs.updated_at ?? ""}`,
        customerId: attrs.customer_id ? String(attrs.customer_id) : undefined,
        customerEmail: attrs.user_email ?? undefined,
        // In `subscription_payment_*` the resource is the INVOICE: its id is not the
        // subscription's (`attrs.subscription_id`). With the invoice's, an orphan
        // «subscription» was created that no cancel could reach and that gave
        // access forever (an earlier audit).
        subscriptionId: name.startsWith("subscription_payment")
          ? attrs.subscription_id != null
            ? String(attrs.subscription_id)
            : undefined
          : name.startsWith("subscription")
            ? String(event.data?.id)
            : undefined,
        planId: attrs.variant_id ? String(attrs.variant_id) : undefined,
        status: STATUS[attrs.status] ?? undefined,
        money:
          attrs.total != null
            ? {
                amount: Number(attrs.total),
                currency: String(attrs.currency ?? "USD").toUpperCase(),
              }
            : undefined,
        currentPeriodEnd: attrs.renews_at ?? attrs.ends_at ?? undefined,
        // A cancelled LS subscription stays usable until `ends_at` (its grace period).
        cancelAtPeriodEnd:
          name.startsWith("subscription_") && !name.startsWith("subscription_payment")
            ? attrs.cancelled === true
            : undefined,
        // The ORDER is the payment: `order_created` and `order_refunded` name the same one.
        paymentId: name.startsWith("order_") && event.data?.id != null ? String(event.data.id) : undefined,
        settled: name === "order_created" ? attrs.status === "paid" : undefined,
        partial: name === "order_refunded" ? attrs.status === "partial_refund" : undefined,
        metadata: event.meta?.custom_data ?? {},
        occurredAt: attrs.updated_at ?? new Date().toISOString(),
        raw: event,
      } satisfies PaymentEvent;
    },

    async createPortalSession(customerId) {
      // LS exposes the portal as a signed URL on the subscription resource.
      const res = await fetch(`${API}/subscriptions/${customerId}`, {
        signal: providerWait(),
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
      });
      const json: any = await res.json().catch(() => ({}));
      const url = json?.data?.attributes?.urls?.customer_portal;
      if (!url) throw new Error("Lemon Squeezy did not return a portal URL");
      return { url };
    },

    async cancelSubscription(subscriptionId) {
      const res = await fetch(`${API}/subscriptions/${subscriptionId}`, {
        signal: providerWait(),
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
      });
      if (!res.ok) throw new Error(`Lemon Squeezy cancel ${res.status}`);
    },
  };
}

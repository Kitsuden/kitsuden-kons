/**
 * Kitsuden Payments — Stripe
 * ============================================================================
 * Direct HTTP API (without the SDK): it is 3 endpoints and we avoid ~2 MB of
 * dependency. The signature is verified with Stripe's own scheme.
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

const API = "https://api.stripe.com/v1";

/** Stripe accepts form-urlencoded with `a[b][c]` notation. */
function toForm(obj: Record<string, unknown>, prefix = ""): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object" && !Array.isArray(value)) {
      parts.push(...toForm(value as Record<string, unknown>, name));
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (typeof v === "object") {
          parts.push(...toForm(v as Record<string, unknown>, `${name}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(v))}`);
        }
      });
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts;
}

const STATUS: Record<string, SubscriptionStatus> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  canceled: "canceled",
  paused: "paused",
  unpaid: "past_due",
  incomplete: "past_due",
  incomplete_expired: "expired",
};

export function stripeProvider(env = process.env): PaymentProvider {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;

  async function call(path: string, body?: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${API}${path}`, {
      signal: providerWait(),
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      ...(body ? { body: toForm(body).join("&") } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Stripe ${res.status}: ${(json as any)?.error?.message ?? "error"}`);
    }
    return json;
  }

  return {
    name: "stripe",

    isConfigured: () => Boolean(secretKey),

    async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
      const session = await call("/checkout/sessions", {
        mode: "subscription",
        success_url: input.successUrl,
        cancel_url: input.cancelUrl ?? input.successUrl,
        line_items: [{ price: input.planId, quantity: input.quantity ?? 1 }],
        ...(input.customerId ? { customer: input.customerId } : {}),
        ...(input.customerEmail && !input.customerId
          ? { customer_email: input.customerEmail }
          : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        // Also on the subscription: the session's metadata does not travel to the
        // renewal events, only to the initial checkout.
        ...(input.metadata ? { subscription_data: { metadata: input.metadata } } : {}),
      });
      return { url: session.url, id: session.id };
    },

    async createPaymentCheckout(input: PaymentCheckoutInput): Promise<CheckoutSession> {
      // Stripe keeps a payment page open between 30 minutes and 24 hours.
      const minutes = Math.min(Math.max(input.expiresInMinutes ?? 60, 30), 1440);
      const session = await call("/checkout/sessions", {
        mode: "payment",
        success_url: input.successUrl,
        cancel_url: input.cancelUrl ?? input.successUrl,
        line_items: input.lines.map((l) => ({
          quantity: l.quantity,
          price_data: {
            currency: input.currency.toLowerCase(),
            unit_amount: l.unitAmount,
            product_data: { name: l.name.slice(0, 250) },
          },
        })),
        ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
        metadata: input.metadata,
        // Also on the payment intent: a later `charge.refunded` carries the intent, not the session.
        payment_intent_data: { metadata: input.metadata },
        expires_at: Math.floor(Date.now() / 1000) + minutes * 60,
      });
      return { url: session.url, id: session.id };
    },

    async parseWebhook(rawBody, headers) {
      if (!webhookSecret) return null;

      // Format: t=<timestamp>,v1=<signature>
      const header = lowerHeaders(headers)["stripe-signature"];
      if (!header) return null;

      const parts = Object.fromEntries(
        header.split(",").map((p) => {
          const [k, ...v] = p.split("=");
          return [k.trim(), v.join("=")];
        })
      );
      const timestamp = parts.t;
      const signature = parts.v1;
      if (!timestamp || !signature) return null;

      // 5-minute window: without this, a captured signature can be resent
      // indefinitely (replay attack).
      const age = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (!Number.isFinite(age) || age > 300) return null;

      const expected = createHmac("sha256", webhookSecret)
        .update(`${timestamp}.${rawBody}`)
        .digest("hex");
      if (!timingSafeEqual(expected, signature)) return null;

      const event = JSON.parse(rawBody);
      const object = event.data?.object ?? {};

      const map: Record<string, PaymentEventType> = {
        "checkout.session.completed": "payment.succeeded",
        // A checkout paid by bank debit completes unpaid; this one arrives when the money does.
        "checkout.session.async_payment_succeeded": "payment.succeeded",
        "invoice.paid": "subscription.payment_succeeded",
        "invoice.payment_failed": "subscription.payment_failed",
        "customer.subscription.created": "subscription.created",
        "customer.subscription.updated": "subscription.updated",
        "customer.subscription.deleted": "subscription.canceled",
        "charge.refunded": "payment.refunded",
      };

      const type = map[event.type];
      if (!type) return undefined; // event we are not interested in

      return {
        type,
        provider: "stripe",
        externalId: event.id,
        customerId: object.customer ?? undefined,
        customerEmail: object.customer_email ?? object.customer_details?.email ?? undefined,
        // Only a real SUBSCRIPTION id. Before, without `subscription`,
        // `object.id` was used — in `charge.refunded` the CHARGE id — and the
        // service created an active «subscription» with it (an earlier audit).
        subscriptionId:
          typeof object.subscription === "string"
            ? object.subscription
            : object.object === "subscription"
              ? object.id
              : undefined,
        planId: object.items?.data?.[0]?.price?.id ?? object.lines?.data?.[0]?.price?.id,
        // A charged checkout is `active`; one with an asynchronous payment not yet
        // charged (`payment_status: "unpaid"`) does NOT give access (an earlier audit).
        status:
          object.object === "checkout.session"
            ? object.payment_status === "paid" || object.payment_status === "no_payment_required"
              ? "active"
              : "incomplete"
            : (STATUS[object.status] ?? undefined),
        money:
          object.amount_total != null || object.amount_paid != null
            ? {
                amount: object.amount_total ?? object.amount_paid,
                currency: String(object.currency ?? "usd").toUpperCase(),
              }
            : undefined,
        currentPeriodEnd: object.current_period_end
          ? new Date(object.current_period_end * 1000).toISOString()
          : undefined,
        // Only a subscription object carries the flag; other objects leave it unknown.
        cancelAtPeriodEnd:
          object.object === "subscription" ? object.cancel_at_period_end === true : undefined,
        // The payment intent names the same payment in the checkout and in its refund.
        paymentId: typeof object.payment_intent === "string" ? object.payment_intent : undefined,
        settled:
          object.object === "checkout.session"
            ? object.payment_status === "paid" || object.payment_status === "no_payment_required"
            : event.type === "charge.refunded"
              ? undefined
              : object.paid === true || object.status === "paid" || undefined,
        // A charge refunded only in part keeps `refunded: false`.
        partial: event.type === "charge.refunded" ? object.refunded === false : undefined,
        metadata: object.metadata ?? {},
        occurredAt: new Date((event.created ?? Date.now() / 1000) * 1000).toISOString(),
        raw: event,
      } satisfies PaymentEvent;
    },

    async createPortalSession(customerId, returnUrl) {
      const session = await call("/billing_portal/sessions", {
        customer: customerId,
        return_url: returnUrl,
      });
      return { url: session.url };
    },

    async cancelSubscription(subscriptionId, immediately = false) {
      if (immediately) {
        await fetch(`${API}/subscriptions/${subscriptionId}`, {
          signal: providerWait(),
          method: "DELETE",
          headers: { Authorization: `Bearer ${secretKey}` },
        });
      } else {
        await call(`/subscriptions/${subscriptionId}`, { cancel_at_period_end: true });
      }
    },
  };
}

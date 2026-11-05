/**
 * Kitsuden Payments — PayPal
 * ============================================================================
 * The most awkward of the four, and it is worth knowing why:
 *
 *  · OAuth2 authentication with a token that expires (it must be cached and renewed).
 *  · Signature verification is NOT a local HMAC: it requires a CALL to PayPal's
 *    API for every webhook. It is slower and adds a point of failure, but
 *    it is the only supported method — the alternative (verifying the certificate
 *    by hand) is fragile and PayPal advises against it.
 *  · Amounts come as a decimal string ("10.50"), not in cents.
 */

import {
  lowerHeaders,
  type CheckoutInput,
  type CheckoutSession,
  type PaymentEvent,
  type PaymentEventType,
  type PaymentProvider,
  type SubscriptionStatus,
} from "../payments.types";

import { providerWait } from "./wait";

// Audit: `APPROVAL_PENDING` was `trialing` (which gives access) and
// PayPal sends BILLING.SUBSCRIPTION.CREATED as soon as the checkout is created:
// opening a payment and not approving it gave paid access. Only ACTIVE gives it.
const STATUS: Record<string, SubscriptionStatus> = {
  APPROVAL_PENDING: "incomplete",
  APPROVED: "incomplete",
  ACTIVE: "active",
  SUSPENDED: "paused",
  CANCELLED: "canceled",
  EXPIRED: "expired",
};

/** "10.50" EUR → 1050 cents. The intermediate float is avoided. */
function toCents(value: string | number | undefined): number | undefined {
  if (value == null) return undefined;
  const str = String(value);
  const [whole, frac = ""] = str.split(".");
  const cents = `${whole}${frac.padEnd(2, "0").slice(0, 2)}`;
  const parsed = Number.parseInt(cents, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function paypalProvider(env = process.env): PaymentProvider {
  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  const webhookId = env.PAYPAL_WEBHOOK_ID;
  const api =
    env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

  /** Cached OAuth token: requesting one per request would be absurd. */
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt) return token.value;

    const res = await fetch(`${api}/v1/oauth2/token`, {
      signal: providerWait(),
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`PayPal auth ${res.status}`);

    // 60s of margin so as not to use a token that expires in flight.
    token = {
      value: json.access_token,
      expiresAt: Date.now() + (json.expires_in - 60) * 1000,
    };
    return token.value;
  }

  return {
    name: "paypal",

    isConfigured: () => Boolean(clientId && clientSecret),

    async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
      const res = await fetch(`${api}/v1/billing/subscriptions`, {
        signal: providerWait(),
        method: "POST",
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          plan_id: input.planId,
          ...(input.customerEmail ? { subscriber: { email_address: input.customerEmail } } : {}),
          // PayPal only accepts a string: the metadata is serialized.
          ...(input.metadata ? { custom_id: JSON.stringify(input.metadata).slice(0, 127) } : {}),
          application_context: {
            return_url: input.successUrl,
            cancel_url: input.cancelUrl ?? input.successUrl,
            user_action: "SUBSCRIBE_NOW",
          },
        }),
      });

      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`PayPal ${res.status}: ${json?.message ?? "error"}`);

      const approve = (json.links ?? []).find((l: any) => l.rel === "approve");
      if (!approve) throw new Error("PayPal did not return an approval link");
      return { url: approve.href, id: json.id };
    },

    async parseWebhook(rawBody, headers) {
      if (!webhookId) return null;
      const h = lowerHeaders(headers);

      const required = [
        "paypal-transmission-id",
        "paypal-transmission-time",
        "paypal-transmission-sig",
        "paypal-cert-url",
        "paypal-auth-algo",
      ];
      if (required.some((k) => !h[k])) return null;

      // REMOTE verification: PayPal does not offer a local HMAC signature.
      try {
        const res = await fetch(`${api}/v1/notifications/verify-webhook-signature`, {
          signal: providerWait(),
          method: "POST",
          headers: {
            Authorization: `Bearer ${await accessToken()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            transmission_id: h["paypal-transmission-id"],
            transmission_time: h["paypal-transmission-time"],
            cert_url: h["paypal-cert-url"],
            auth_algo: h["paypal-auth-algo"],
            transmission_sig: h["paypal-transmission-sig"],
            webhook_id: webhookId,
            webhook_event: JSON.parse(rawBody),
          }),
        });
        const json: any = await res.json().catch(() => ({}));
        if (json.verification_status !== "SUCCESS") return null;
      } catch {
        // If verification cannot be completed, it is REJECTED. Accepting an
        // unverified webhook would be worse than losing it.
        return null;
      }

      const event = JSON.parse(rawBody);
      const resource = event.resource ?? {};

      const map: Record<string, PaymentEventType> = {
        "PAYMENT.CAPTURE.COMPLETED": "payment.succeeded",
        "PAYMENT.CAPTURE.DENIED": "payment.failed",
        "PAYMENT.CAPTURE.REFUNDED": "payment.refunded",
        "BILLING.SUBSCRIPTION.CREATED": "subscription.created",
        "BILLING.SUBSCRIPTION.ACTIVATED": "subscription.created",
        "BILLING.SUBSCRIPTION.UPDATED": "subscription.updated",
        "BILLING.SUBSCRIPTION.CANCELLED": "subscription.canceled",
        "BILLING.SUBSCRIPTION.EXPIRED": "subscription.canceled",
        "PAYMENT.SALE.COMPLETED": "subscription.payment_succeeded",
      };

      const type = map[event.event_type];
      if (!type) return undefined;

      // The metadata travels serialized in custom_id.
      let metadata: Record<string, string> = {};
      if (resource.custom_id) {
        try {
          metadata = JSON.parse(resource.custom_id);
        } catch {
          metadata = { custom_id: String(resource.custom_id) };
        }
      }

      const amount = resource.amount?.value ?? resource.amount?.total;

      return {
        type,
        provider: "paypal",
        externalId: event.id,
        customerId: resource.subscriber?.payer_id ?? undefined,
        customerEmail: resource.subscriber?.email_address ?? undefined,
        subscriptionId:
          resource.billing_agreement_id ??
          (event.event_type.startsWith("BILLING") ? resource.id : undefined),
        planId: resource.plan_id ?? undefined,
        status: STATUS[resource.status] ?? undefined,
        money:
          amount != null
            ? {
                amount: toCents(amount) ?? 0,
                currency: String(
                  resource.amount?.currency_code ?? resource.amount?.currency ?? "USD"
                ).toUpperCase(),
              }
            : undefined,
        currentPeriodEnd: resource.billing_info?.next_billing_time ?? undefined,
        metadata,
        occurredAt: event.create_time ?? new Date().toISOString(),
        raw: event,
      } satisfies PaymentEvent;
    },

    async cancelSubscription(subscriptionId) {
      const res = await fetch(`${api}/v1/billing/subscriptions/${subscriptionId}/cancel`, {
        signal: providerWait(),
        method: "POST",
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "Canceled by the user" }),
      });
      if (!res.ok && res.status !== 204) throw new Error(`PayPal cancel ${res.status}`);
    },
  };
}

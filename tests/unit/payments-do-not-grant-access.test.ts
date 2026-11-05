/**
 * Payments: no unpaid event grants access (audit 2026-10-25)
 * ============================================================================
 *
 *   · PayPal: `APPROVAL_PENDING` was `trialing` (grants access) and CREATED arrives on
 *     opening checkout. Now it is `incomplete`.
 *   · Lemon Squeezy: in `subscription_payment_*` the resource is the INVOICE; its
 *     id was used as the subscription → orphan `active` row forever.
 *   · An unrecognized status is no longer taken as `active`.
 *   · Stripe: a checkout with unpaid asynchronous payment grants no access.
 */
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { statusAfterEvent } from "../../kons/kon-payments/payments.service";
import type { PaymentEvent } from "../../kons/kon-payments/payments.types";
import { lemonSqueezyProvider } from "../../kons/kon-payments/providers/lemonsqueezy";
import { stripeProvider } from "../../kons/kon-payments/providers/stripe";

const event = (type: PaymentEvent["type"], status?: PaymentEvent["status"]) =>
  ({ type, status, provider: "x", externalId: "e", metadata: {}, occurredAt: "", raw: {} }) as unknown as PaymentEvent;

describe("estadoTrasEvento", () => {
  it("an unknown status grants no access; a charge does", () => {
    expect(statusAfterEvent(event("subscription.created"))).toBe("incomplete");
    expect(statusAfterEvent(event("subscription.updated", "incomplete"))).toBe("incomplete");
    expect(statusAfterEvent(event("subscription.payment_succeeded"))).toBe("active");
    expect(statusAfterEvent(event("subscription.created", "active"))).toBe("active");
  });
});

describe("Lemon Squeezy", () => {
  const ls = lemonSqueezyProvider({ LEMONSQUEEZY_WEBHOOK_SECRET: "secreto" } as NodeJS.ProcessEnv);
  const sign = (body: string) => createHmac("sha256", "secreto").update(body).digest("hex");

  it("a renewal charge points to the SUBSCRIPTION, not to the invoice", async () => {
    const body = JSON.stringify({
      meta: { event_name: "subscription_payment_success", custom_data: { userId: "u1" } },
      data: { id: "factura-99", attributes: { subscription_id: 1234, status: "paid", updated_at: "2026-10-25" } },
    });
    const ev = (await ls.parseWebhook(body, { "x-signature": sign(body) })) as PaymentEvent;
    expect(ev.subscriptionId).toBe("1234");
    expect(statusAfterEvent(ev)).toBe("active");
  });
});

describe("Stripe", () => {
  const stripe = stripeProvider({ STRIPE_WEBHOOK_SECRET: "whsec" } as NodeJS.ProcessEnv);
  const send = (object: Record<string, unknown>) => {
    const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: object } });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", "whsec").update(`${t}.${body}`).digest("hex");
    return stripe.parseWebhook(body, { "stripe-signature": `t=${t},v1=${v1}` }) as Promise<PaymentEvent>;
  };

  it("unpaid checkout → incomplete; paid → active", async () => {
    const base = { object: "checkout.session", subscription: "sub_1", metadata: { userId: "u1" } };
    expect(statusAfterEvent(await send({ ...base, payment_status: "unpaid" }))).toBe("incomplete");
    expect(statusAfterEvent(await send({ ...base, payment_status: "paid" }))).toBe("active");
  });
});

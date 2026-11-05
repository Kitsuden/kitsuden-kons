/**
 * Payments — signature verification and normalization
 * ============================================================================
 *
 * The webhook is a PUBLIC endpoint: the signature is its only authentication. If
 * it fails, anyone can declare payments. That is why the tests focus there and
 * on normalization to a common event.
 *
 * All local: valid signatures are generated with the same key, without touching the network.
 */

import { createHmac } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  stripeProvider,
  lemonSqueezyProvider,
  paddleProvider,
  paypalProvider,
} from "../../kons/kon-payments";

// ── Stripe ───────────────────────────────────────────────────────────────────

describe("Stripe", () => {
  const env = { STRIPE_SECRET_KEY: "sk_test", STRIPE_WEBHOOK_SECRET: "whsec_test" };
  const provider = stripeProvider(env as never);

  function sign(body: string, secret = "whsec_test", ts = Math.floor(Date.now() / 1000)) {
    const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    return { "stripe-signature": `t=${ts},v1=${sig}` };
  }

  const event = JSON.stringify({
    id: "evt_1",
    type: "checkout.session.completed",
    created: 1700000000,
    data: {
      object: {
        customer: "cus_1",
        customer_email: "ada@example.com",
        subscription: "sub_1",
        amount_total: 1050,
        currency: "eur",
        metadata: { userId: "user-42" },
      },
    },
  });

  test("accepts and normalizes a VALID signature", async () => {
    const result = await provider.parseWebhook(event, sign(event));
    expect(result).toBeTruthy();
    expect(result!.type).toBe("payment.succeeded");
    expect(result!.externalId).toBe("evt_1");
    expect(result!.money).toEqual({ amount: 1050, currency: "EUR" });
    expect(result!.metadata.userId).toBe("user-42");
  });

  test("REJECTS an invalid signature (returns null, does not throw)", async () => {
    expect(await provider.parseWebhook(event, { "stripe-signature": "t=1,v1=falsa" })).toBeNull();
  });

  test("REJECTS a signature from another key", async () => {
    expect(await provider.parseWebhook(event, sign(event, "whsec_otra"))).toBeNull();
  });

  test("REJECTS an expired signature (replay defense)", async () => {
    const old = Math.floor(Date.now() / 1000) - 600; // 10 min
    expect(await provider.parseWebhook(event, sign(event, "whsec_test", old))).toBeNull();
  });

  test("REJECTS if the body changed even if the signature is from the same key", async () => {
    const headers = sign(event);
    const tampered = event.replace("1050", "1");
    expect(await provider.parseWebhook(tampered, headers)).toBeNull();
  });

  test("ignores (undefined) events that are not of interest", async () => {
    const other = JSON.stringify({ id: "evt_2", type: "customer.created", data: { object: {} } });
    expect(await provider.parseWebhook(other, sign(other))).toBeUndefined();
  });

  test("with no secret configured it rejects everything", async () => {
    const noSecret = stripeProvider({ STRIPE_SECRET_KEY: "sk" } as never);
    expect(await noSecret.parseWebhook(event, sign(event))).toBeNull();
  });
});

// ── Lemon Squeezy ────────────────────────────────────────────────────────────

describe("Lemon Squeezy", () => {
  const env = {
    LEMONSQUEEZY_API_KEY: "k",
    LEMONSQUEEZY_STORE_ID: "1",
    LEMONSQUEEZY_WEBHOOK_SECRET: "ls_secret",
  };
  const provider = lemonSqueezyProvider(env as never);

  const event = JSON.stringify({
    meta: { event_name: "subscription_created", custom_data: { userId: "user-7" } },
    data: {
      id: "sub_9",
      attributes: {
        customer_id: 55,
        user_email: "ada@example.com",
        variant_id: 101,
        status: "active",
        total: 2900,
        currency: "USD",
        renews_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      },
    },
  });

  const sign = (body: string, secret = "ls_secret") => ({
    "x-signature": createHmac("sha256", secret).update(body).digest("hex"),
  });

  test("normalizes a created subscription", async () => {
    const result = await provider.parseWebhook(event, sign(event));
    expect(result!.type).toBe("subscription.created");
    expect(result!.status).toBe("active");
    expect(result!.money).toEqual({ amount: 2900, currency: "USD" });
    expect(result!.metadata.userId).toBe("user-7");
    expect(result!.currentPeriodEnd).toBe("2026-09-01T00:00:00Z");
  });

  test("REJECTS an invalid signature", async () => {
    expect(await provider.parseWebhook(event, sign(event, "otra"))).toBeNull();
  });

  test("the externalId is stable (idempotency without its own event id)", async () => {
    const a = await provider.parseWebhook(event, sign(event));
    const b = await provider.parseWebhook(event, sign(event));
    expect(a!.externalId).toBe(b!.externalId);
  });
});

// ── Paddle ───────────────────────────────────────────────────────────────────

describe("Paddle", () => {
  const provider = paddleProvider({
    PADDLE_API_KEY: "k",
    PADDLE_WEBHOOK_SECRET: "pdl_secret",
  } as never);

  const event = JSON.stringify({
    event_id: "evt_pdl_1",
    event_type: "subscription.created",
    occurred_at: "2026-08-01T10:00:00Z",
    data: {
      id: "sub_pdl",
      customer_id: "ctm_1",
      status: "active",
      currency_code: "EUR",
      custom_data: { userId: "user-3" },
      items: [{ price: { id: "pri_1" } }],
      current_billing_period: { ends_at: "2026-09-01T10:00:00Z" },
      details: { totals: { total: "1500" } },
    },
  });

  function sign(body: string, secret = "pdl_secret", ts = Math.floor(Date.now() / 1000)) {
    const sig = createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
    return { "paddle-signature": `ts=${ts};h1=${sig}` };
  }

  test("normalizes and converts the amount (string → number)", async () => {
    const result = await provider.parseWebhook(event, sign(event));
    expect(result!.type).toBe("subscription.created");
    expect(result!.money).toEqual({ amount: 1500, currency: "EUR" });
    expect(result!.metadata.userId).toBe("user-3");
  });

  test("REJECTS an invalid and expired signature", async () => {
    expect(await provider.parseWebhook(event, sign(event, "otra"))).toBeNull();
    const old = Math.floor(Date.now() / 1000) - 600;
    expect(await provider.parseWebhook(event, sign(event, "pdl_secret", old))).toBeNull();
  });
});

// ── PayPal ───────────────────────────────────────────────────────────────────

describe("PayPal", () => {
  const provider = paypalProvider({
    PAYPAL_CLIENT_ID: "id",
    PAYPAL_CLIENT_SECRET: "secret",
    PAYPAL_WEBHOOK_ID: "wh_1",
  } as never);

  test("REJECTS if signature headers are missing (without calling the network)", async () => {
    expect(await provider.parseWebhook("{}", {})).toBeNull();
    expect(await provider.parseWebhook("{}", { "paypal-transmission-id": "solo-una" })).toBeNull();
  });

  test("isConfigured reflects the credentials", () => {
    expect(provider.isConfigured()).toBe(true);
    expect(paypalProvider({} as never).isConfigured()).toBe(false);
  });
});

// ── Provider registry ────────────────────────────────────────────────────────

describe("buildProviders", () => {
  test("only includes those that have credentials", async () => {
    const { buildProviders } = await import("../../kons/kon-payments");

    const only = buildProviders({ STRIPE_SECRET_KEY: "sk" } as never);
    expect([...only.keys()]).toEqual(["stripe"]);

    const dos = buildProviders({
      STRIPE_SECRET_KEY: "sk",
      LEMONSQUEEZY_API_KEY: "k",
      LEMONSQUEEZY_STORE_ID: "1",
    } as never);
    expect([...dos.keys()].sort()).toEqual(["lemonsqueezy", "stripe"]);

    expect(buildProviders({} as never).size).toBe(0);
  });
});

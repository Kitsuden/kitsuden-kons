/**
 * kon-payments: one-time payments for the shop
 * ============================================================================
 *
 * What the provider is asked to charge, and what is read back from its webhook, decide whether a
 * shop order gets marked paid. `fetch` is replaced: nothing leaves the machine.
 */

import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openOrderCheckout, orderProviderNames } from "../../kons/kon-payments/payments.orders";
import type { PaymentCheckoutInput, PaymentProvider } from "../../kons/kon-payments/payments.types";
import { lemonSqueezyProvider } from "../../kons/kon-payments/providers/lemonsqueezy";
import { stripeProvider } from "../../kons/kon-payments/providers/stripe";

const input: PaymentCheckoutInput = {
  lines: [
    { name: "Guia", unitAmount: 900, quantity: 2 },
    { name: "Shipping", unitAmount: 500, quantity: 1 },
  ],
  currency: "EUR",
  successUrl: "https://shop.example/ok",
  customerEmail: "a@b.com",
  metadata: { shopOrderId: "o1", shopOrderNumber: "2026-000001" },
  expiresInMinutes: 10,
};

function captureFetch(response: unknown) {
  const calls: Array<{ url: string; body: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: string }) => {
      calls.push({ url, body: String(init?.body ?? "") });
      return new Response(JSON.stringify(response), { status: 200 });
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Stripe", () => {
  const stripe = stripeProvider({
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
  });

  it("charges the given lines once, in payment mode, with the metadata on the payment intent too", async () => {
    const calls = captureFetch({ id: "cs_1", url: "https://checkout.stripe.com/c/1" });
    const s = await stripe.createPaymentCheckout?.(input);
    expect(s).toEqual({ id: "cs_1", url: "https://checkout.stripe.com/c/1" });
    const form = new URLSearchParams(calls[0].body);
    expect(form.get("mode")).toBe("payment");
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("900");
    expect(form.get("line_items[0][quantity]")).toBe("2");
    expect(form.get("line_items[0][price_data][currency]")).toBe("eur");
    expect(form.get("line_items[1][price_data][unit_amount]")).toBe("500");
    expect(form.get("metadata[shopOrderId]")).toBe("o1");
    expect(form.get("payment_intent_data[metadata][shopOrderId]")).toBe("o1");
    // Stripe's minimum is 30 minutes: the 10 asked for become 30.
    const expires = Number(form.get("expires_at"));
    expect(expires - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(29 * 60);
  });

  const signed = (payload: unknown) => {
    const raw = JSON.stringify(payload);
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", "whsec_x").update(`${t}.${raw}`).digest("hex");
    return { raw, headers: { "stripe-signature": `t=${t},v1=${v1}` } };
  };

  it("reads the payment intent, and whether the money is in", async () => {
    const done = signed({
      id: "evt_1",
      type: "checkout.session.completed",
      created: 1,
      data: {
        object: {
          object: "checkout.session",
          payment_intent: "pi_1",
          payment_status: "unpaid",
          amount_total: 2300,
          currency: "eur",
          metadata: { shopOrderId: "o1" },
        },
      },
    });
    const e = await stripe.parseWebhook(done.raw, done.headers);
    expect(e).toMatchObject({ type: "payment.succeeded", paymentId: "pi_1", settled: false });

    const later = signed({
      id: "evt_2",
      type: "checkout.session.async_payment_succeeded",
      created: 2,
      data: {
        object: {
          object: "checkout.session",
          payment_intent: "pi_1",
          payment_status: "paid",
          amount_total: 2300,
          currency: "eur",
          metadata: {},
        },
      },
    });
    expect(await stripe.parseWebhook(later.raw, later.headers)).toMatchObject({
      settled: true,
      paymentId: "pi_1",
    });

    const partial = signed({
      id: "evt_3",
      type: "charge.refunded",
      created: 3,
      data: { object: { object: "charge", payment_intent: "pi_1", refunded: false, metadata: {} } },
    });
    expect(await stripe.parseWebhook(partial.raw, partial.headers)).toMatchObject({
      type: "payment.refunded",
      paymentId: "pi_1",
      partial: true,
    });
  });
});

describe("Lemon Squeezy", () => {
  it("charges the total as a custom price on the variant set aside for orders", async () => {
    const env = {
      LEMONSQUEEZY_API_KEY: "k",
      LEMONSQUEEZY_STORE_ID: "7",
      LEMONSQUEEZY_ORDER_VARIANT_ID: "99",
    };
    const calls = captureFetch({
      data: { id: "co_1", attributes: { url: "https://x.lemonsqueezy.com/c/1" } },
    });
    const s = await lemonSqueezyProvider(env).createPaymentCheckout?.(input);
    expect(s?.url).toBe("https://x.lemonsqueezy.com/c/1");
    const body = JSON.parse(calls[0].body);
    expect(body.data.attributes.custom_price).toBe(2300);
    expect(body.data.attributes.checkout_data.custom).toEqual(input.metadata);
    expect(body.data.relationships.variant.data.id).toBe("99");
  });

  it("refuses without that variant instead of charging another product", async () => {
    const ls = lemonSqueezyProvider({ LEMONSQUEEZY_API_KEY: "k", LEMONSQUEEZY_STORE_ID: "7" });
    await expect(ls.createPaymentCheckout?.(input)).rejects.toThrow(
      /LEMONSQUEEZY_ORDER_VARIANT_ID/
    );
  });
});

describe("openOrderCheckout", () => {
  const fake = (over: Partial<PaymentProvider> = {}): PaymentProvider => ({
    name: "fake",
    isConfigured: () => true,
    createCheckout: async () => ({ url: "", id: "" }),
    parseWebhook: async () => undefined,
    createPaymentCheckout: async () => ({ url: "https://pay/1", id: "1" }),
    ...over,
  });
  const env = { PAYMENTS_RETURN_ORIGINS: "https://shop.example" };

  it("lists only providers that can charge a one-time amount", () => {
    const providers = new Map([
      ["fake", fake()],
      ["subs-only", fake({ name: "subs-only", createPaymentCheckout: undefined })],
    ]);
    expect(orderProviderNames(providers)).toEqual(["fake"]);
  });

  it("refuses return URLs off the site, negative amounts and unknown providers", async () => {
    const providers = new Map([["fake", fake()]]);
    expect(await openOrderCheckout(providers, "fake", input, env)).toMatchObject({ ok: true });
    expect(
      await openOrderCheckout(
        providers,
        "fake",
        { ...input, successUrl: "https://evil.example/" },
        env
      )
    ).toMatchObject({
      ok: false,
      status: 422,
    });
    expect(
      await openOrderCheckout(
        providers,
        "fake",
        { ...input, lines: [{ name: "x", unitAmount: -1, quantity: 1 }] },
        env
      )
    ).toMatchObject({ ok: false, status: 422 });
    expect(await openOrderCheckout(providers, "nope", input, env)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("turns a provider failure into a 502", async () => {
    const providers = new Map([
      ["fake", fake({ createPaymentCheckout: async () => Promise.reject(new Error("down")) })],
    ]);
    expect(await openOrderCheckout(providers, "fake", input, env)).toMatchObject({
      ok: false,
      status: 502,
    });
  });
});

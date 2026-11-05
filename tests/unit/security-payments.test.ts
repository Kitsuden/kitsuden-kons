/**
 * kon-payments — each person's billing, and no client-supplied amounts
 * ============================================================================
 *
 * Audit 2026-10-15. What there was:
 *
 *   · `POST /portal` opened the billing portal of whatever `customerId` the
 *     client sent: view invoices, change card or cancel someone else's.
 *   · `returnUrl`/`successUrl` accepted any domain (an open redirector
 *     with the payment provider's branding).
 *   · A refund (`charge.refunded`) created an ACTIVE subscription with the
 *     charge's id: requesting the refund gave free access. `payment.failed`,
 *     the same.
 *   · A payment without metadata was attributed BY EMAIL to the first account that
 *     had paid with that email (unverified).
 *   · The webhook's 500 returned the database message.
 *
 * Against PGlite with the real migration, with two users and a fake provider
 * that records which ids it receives.
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { registerPaymentsPolicy } from "../../kons/kon-payments/payments.policy";
import { createPaymentsRouter } from "../../kons/kon-payments/payments.routes";
import type {
  PaymentEvent,
  PaymentProvider,
} from "../../kons/kon-payments/payments.types";
import { stripeProvider } from "../../kons/kon-payments/providers/stripe";

const here = dirname(fileURLToPath(import.meta.url));

let client: PGlite;
let app: Hono;
let session: { id: string; role: string; scopes?: string[] } | null = null;
let nextEvent: PaymentEvent | null = null;
const calls: { portal: string[]; cancel: string[]; checkout: unknown[] } = {
  portal: [],
  cancel: [],
  checkout: [],
};

const fake: PaymentProvider = {
  name: "stripe",
  isConfigured: () => true,
  async createCheckout(input) {
    calls.checkout.push(input);
    return { url: "https://checkout.example/s/1", id: "cs_1" };
  },
  async parseWebhook() {
    return nextEvent ?? undefined;
  },
  async createPortalSession(customerId) {
    calls.portal.push(customerId);
    return { url: `https://billing.example/${customerId}` };
  },
  async cancelSubscription(id) {
    calls.cancel.push(id);
  },
};

const ANA = { id: "u-ana", role: "user" };
const BEA = { id: "u-bea", role: "user" };

beforeAll(async () => {
  client = await PGlite.create();
  await client.exec(
    readFileSync(
      resolve(here, "../../kons/kon-payments/migrations/0000_initial.sql"),
      "utf8"
    )
  );
  registerPaymentsPolicy();
  const ctx = createTestKonContext({
    db: {
      instance: drizzle(client),
      execute: async () => undefined,
      tableExists: async () => true,
    },
    auth: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono middleware double
      requireAuth: (c: any, next: any) => {
        if (!session) return c.json({ error: "no session" }, 401);
        c.set("user", session);
        return next();
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
  } as any);
  app = new Hono();
  app.route("/", createPaymentsRouter(ctx, new Map([["stripe", fake]])));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  session = null;
  nextEvent = null;
  calls.portal = [];
  calls.cancel = [];
  calls.checkout = [];
  process.env.PAYMENTS_RETURN_ORIGINS = "https://sitio.example";
  delete process.env.ALLOWED_ORIGINS;
  delete process.env.PAYMENTS_ALLOWED_PLANS;
  await client.exec(`
    DELETE FROM pay_customers; DELETE FROM pay_subscriptions; DELETE FROM pay_events;
    INSERT INTO pay_customers (user_id, provider, external_id, email) VALUES
      ('u-ana', 'stripe', 'cus_ANA', 'ana@ejemplo.com');
    INSERT INTO pay_subscriptions (user_id, provider, external_id, status) VALUES
      ('u-ana', 'stripe', 'sub_ANA', 'active');
  `);
});

const post = (route: string, body: unknown) =>
  app.request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("portal: only your own", () => {
  it("Bea cannot open Ana's portal by passing her customerId", async () => {
    session = BEA;
    const r = await post("/portal", { provider: "stripe", customerId: "cus_ANA" });
    expect(r.status).toBe(422);
    expect(calls.portal).toEqual([]);
  });

  it("Bea without billing of her own gets 404 (not anyone's portal)", async () => {
    session = BEA;
    expect((await post("/portal", { provider: "stripe" })).status).toBe(404);
    expect(calls.portal).toEqual([]);
  });

  it("Ana opens HER OWN, with the id read from the database", async () => {
    session = ANA;
    const r = await post("/portal", {
      provider: "stripe",
      returnUrl: "https://sitio.example/cuenta",
    });
    expect(r.status).toBe(200);
    expect(calls.portal).toEqual(["cus_ANA"]);
  });

  it("the return URL cannot be from another domain", async () => {
    session = ANA;
    const r = await post("/portal", { provider: "stripe", returnUrl: "https://phishing.example/" });
    expect(r.status).toBe(422);
    expect(calls.portal).toEqual([]);
  });
});

describe("checkout: the server decides", () => {
  const base = { provider: "stripe", planId: "price_pro", successUrl: "https://sitio.example/ok" };

  it("the metadata's userId is set by the server; the client's is rejected", async () => {
    session = BEA;
    expect((await post("/checkout", { ...base, metadata: { userId: "u-ana" } })).status).toBe(422);
    expect((await post("/checkout", { ...base, metadata: { user_id: "u-ana" } })).status).toBe(422);

    expect((await post("/checkout", { ...base, metadata: { campaña: "x" } })).status).toBe(422);
    const ok = await post("/checkout", { ...base, metadata: { ref: "newsletter" } });
    expect(ok.status).toBe(200);
    expect((calls.checkout[0] as { metadata: Record<string, string> }).metadata).toEqual({
      ref: "newsletter",
      userId: "u-bea",
    });
  });

  it("does not accept amounts, customerId or fields that are not on the list", async () => {
    session = BEA;
    for (const extra of [{ amount: 1 }, { price: 1 }, { customerId: "cus_ANA" }]) {
      expect((await post("/checkout", { ...base, ...extra })).status).toBe(422);
    }
    expect(calls.checkout).toEqual([]);
  });

  it("successUrl/cancelUrl outside our own origins → 422", async () => {
    session = BEA;
    expect((await post("/checkout", { ...base, successUrl: "https://evil.example/" })).status).toBe(
      422
    );
    expect(
      (await post("/checkout", { ...base, cancelUrl: "https://sitio.example.evil.example/" }))
        .status
    ).toBe(422);
  });

  it("without configured origins no URL is accepted (fails closed)", async () => {
    delete process.env.PAYMENTS_RETURN_ORIGINS;
    session = BEA;
    expect((await post("/checkout", base)).status).toBe(422);
  });

  it("with PAYMENTS_ALLOWED_PLANS, a plan outside the list is not sold", async () => {
    process.env.PAYMENTS_ALLOWED_PLANS = "price_pro,price_basic";
    session = BEA;
    expect((await post("/checkout", { ...base, planId: "price_interno_0eur" })).status).toBe(422);
    expect((await post("/checkout", base)).status).toBe(200);
  });

  it("Ana reuses HER provider customer", async () => {
    session = ANA;
    await post("/checkout", base);
    expect((calls.checkout[0] as { customerId?: string }).customerId).toBe("cus_ANA");
  });
});

describe("agents: an agent key does not pay by itself", () => {
  const base = { provider: "stripe", planId: "price_pro", successUrl: "https://sitio.example/ok" };

  it("an agent with only mcp:connect does not open a checkout (phase D)", async () => {
    session = { id: "agente-1", role: "agent", scopes: ["mcp:connect"] };
    expect((await post("/checkout", base)).status).toBe(403);
    expect(calls.checkout).toHaveLength(0);
  });

  it("with the explicit payments:checkout scope, it does", async () => {
    session = { id: "agente-1", role: "agent", scopes: ["payments:checkout"] };
    expect((await post("/checkout", base)).status).toBe(200);
    expect(calls.checkout).toHaveLength(1);
  });
});

describe("cancel: only your own and from the same provider", () => {
  it("Bea does not cancel Ana's subscription", async () => {
    session = BEA;
    expect((await post("/cancel", { provider: "stripe", subscriptionId: "sub_ANA" })).status).toBe(
      404
    );
    expect(calls.cancel).toEqual([]);
  });

  it("Ana does", async () => {
    session = ANA;
    expect((await post("/cancel", { provider: "stripe", subscriptionId: "sub_ANA" })).status).toBe(
      200
    );
    expect(calls.cancel).toEqual(["sub_ANA"]);
  });
});

describe("/subscription: each one their own", () => {
  it("Bea does not see Ana's subscription", async () => {
    session = BEA;
    const body = await (await app.request("/subscription")).json();
    expect(body.hasAccess).toBe(false);
    expect(body.subscriptions).toEqual([]);
  });
});

describe("webhook: negative events do not grant access", () => {
  const event = (over: Partial<PaymentEvent>): PaymentEvent => ({
    type: "payment.succeeded",
    provider: "stripe",
    externalId: `evt_${Math.random()}`,
    metadata: {},
    occurredAt: new Date().toISOString(),
    raw: {},
    ...over,
  });

  const accessOf = async (userId: string) =>
    (
      await client.query<{ status: string }>(
        `SELECT status FROM pay_subscriptions WHERE user_id = '${userId}' ORDER BY created_at`
      )
    ).rows.map((r) => r.status);

  it("a refund does NOT create an active subscription", async () => {
    nextEvent = event({
      type: "payment.refunded",
      subscriptionId: "sub_BEA",
      metadata: { userId: "u-bea" },
    });
    await post("/webhook/stripe", {});
    expect(await accessOf("u-bea")).toEqual(["canceled"]);
  });

  it("a failed payment leaves past_due, not active", async () => {
    nextEvent = event({
      type: "payment.failed",
      subscriptionId: "sub_ANA",
      metadata: { userId: "u-ana" },
      status: "active",
    });
    await post("/webhook/stripe", {});
    expect(await accessOf("u-ana")).toEqual(["past_due"]);
  });

  it("a payment without metadata is NOT attributed by email to another account", async () => {
    // Someone paid with Ana's email without being Ana: it is given neither to Ana nor to anyone.
    nextEvent = event({
      type: "subscription.created",
      subscriptionId: "sub_X",
      customerEmail: "ana@ejemplo.com",
      customerId: "cus_X",
    });
    await post("/webhook/stripe", {});
    const ev = await client.query<{ user_id: string | null }>("SELECT user_id FROM pay_events");
    expect(ev.rows[0].user_id).toBeNull();
    expect(await accessOf("u-ana")).toEqual(["active"]);
  });

  it("an internal failure responds 500 WITHOUT the database message", async () => {
    nextEvent = event({ externalId: "x".repeat(400) }); // varchar(191)
    const r = await post("/webhook/stripe", {});
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(text).not.toMatch(/varchar|character varying|pay_events|value too long/i);
  });

  it("a body over 1 MB is rejected without processing it", async () => {
    const r = await app.request("/webhook/stripe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1_000_001),
    });
    expect(r.status).toBe(413);
  });
});

describe("Stripe: a charge id is not a subscription", () => {
  it("charge.refunded without `subscription` carries no subscriptionId", async () => {
    const env = { STRIPE_SECRET_KEY: "sk_test", STRIPE_WEBHOOK_SECRET: "whsec_test" };
    const body = JSON.stringify({
      id: "evt_r",
      type: "charge.refunded",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "ch_123", object: "charge", amount_total: 900, currency: "eur" } },
    });
    const ts = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", "whsec_test").update(`${ts}.${body}`).digest("hex");
    const ev = await stripeProvider(env as never).parseWebhook(body, {
      "stripe-signature": `t=${ts},v1=${signature}`,
    });
    expect(ev?.type).toBe("payment.refunded");
    expect(ev?.subscriptionId).toBeUndefined();
  });
});

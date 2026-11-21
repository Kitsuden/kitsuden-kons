/**
 * kon-payments: Tilopay and Yappy, and one-time payments opened over HTTP
 * ============================================================================
 *
 * Neither provider signs its result the way Stripe does. Tilopay sends the buyer back with a
 * query string anyone can type, and does not publish its hash: the payment is confirmed by asking
 * Tilopay. Yappy notifies by GET with an HMAC: the amount is not in it. Both come back to
 * `GET /return/:provider` and are matched to `pay_checkouts`, never trusted from the request.
 *
 * PGlite with the kon's migrations; the providers' HTTP is a double. Nothing leaves the machine.
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
import { newReference, openOrderCheckout, orderProviderNames } from "../../kons/kon-payments/payments.orders";
import { registerPaymentsPolicy } from "../../kons/kon-payments/payments.policy";
import { createPaymentsRouter } from "../../kons/kon-payments/payments.routes";
import type { PaymentProvider } from "../../kons/kon-payments/payments.types";
import { stripeProvider } from "../../kons/kon-payments/providers/stripe";
import { tilopayProvider } from "../../kons/kon-payments/providers/tilopay";
import { yappyProvider, yappySignature } from "../../kons/kon-payments/providers/yappy";

const here = dirname(fileURLToPath(import.meta.url));

// Yappy's secret is base64 of "<hmac key>.<something else>".
const YAPPY_SECRET = Buffer.from("hmac-key-0123456789.second-part").toString("base64");

const env = {
  TILOPAY_API_USER: "user",
  TILOPAY_API_PASSWORD: "pass",
  TILOPAY_API_KEY: "key-123",
  TILOPAY_RETURN_URL: "https://api.shop.example/api/payments/return/tilopay",
  YAPPY_MERCHANT_ID: "MERCH1",
  YAPPY_SECRET_KEY: YAPPY_SECRET,
  YAPPY_DOMAIN: "https://shop.example",
  YAPPY_IPN_URL: "https://api.shop.example/api/payments/return/yappy",
  YAPPY_ENV: "test",
  YAPPY_TEST_ALIAS: "60000000",
};

type Call = { url: string; body: any; headers: Record<string, string> };
const calls: Call[] = [];
let answer: (call: Call) => { status?: number; body: unknown } = () => ({ body: {} });
const http = async (url: string, init?: RequestInit) => {
  const call = {
    url,
    body: init?.body ? JSON.parse(String(init.body)) : null,
    headers: (init?.headers ?? {}) as Record<string, string>,
  };
  calls.push(call);
  const { status = 200, body } = answer(call);
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
};

/** Tilopay as its docs show it: a token, a payment page, and the transactions of an order. */
function tilopayAnswers(consult: Array<Record<string, unknown>>) {
  answer = (call) => {
    if (call.url.endsWith("/login")) return { body: { access_token: "tok", token_type: "bearer", expires_in: 86400 } };
    if (call.url.endsWith("/processPayment")) {
      return { body: { type: "100", html: "Use url redirect", url: `https://secure.tilopay.com/htmls/${call.body.orderNumber}.html` } };
    }
    if (call.url.endsWith("/consult")) return { body: { type: "200", message: "", response: consult } };
    return { status: 404, body: {} };
  };
}

/** Yappy as its docs show it: the merchant validated, then the order. */
function yappyAnswers() {
  answer = (call) => {
    if (call.url.endsWith("/payments/validate/merchant")) {
      return { body: { status: { code: "0000", description: "ok" }, body: { epochTime: 1, token: "yappy-session" } } };
    }
    if (call.url.endsWith("/payments/payment-wc")) {
      return { body: { status: { code: "0000", description: "ok" }, body: { transactionId: "T-1", token: "btn-token", documentName: "doc-1" } } };
    }
    return { status: 404, body: {} };
  };
}

const billing = {
  firstName: "Ana",
  lastName: "Pérez",
  email: "ana@example.com",
  phone: "60000000",
  address: "Calle 1",
  city: "Panamá",
  state: "PA-8",
  zip: "0801",
  country: "PA",
};

let client: PGlite;
let app: Hono;
let session: { id: string; role: string; scopes?: string[] } | null = null;
const emitted: Array<{ name: string; data: Record<string, any> }> = [];

beforeAll(async () => {
  client = await PGlite.create();
  for (const file of ["0000_initial.sql", "0002_one_time_checkouts.sql"]) {
    await client.exec(readFileSync(resolve(here, `../../kons/kon-payments/migrations/${file}`), "utf8"));
  }
  registerPaymentsPolicy();
  const ctx = createTestKonContext({
    db: { instance: drizzle(client), execute: async () => undefined, tableExists: async () => true },
    events: { emit: (name: string, data: Record<string, unknown>) => emitted.push({ name, data }), on: () => {}, off: () => {} },
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
  const providers = new Map<string, PaymentProvider>([
    ["tilopay", tilopayProvider(env, http)],
    ["yappy", yappyProvider(env, http)],
  ]);
  app = new Hono();
  app.route("/", createPaymentsRouter(ctx, providers));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  session = null;
  calls.length = 0;
  emitted.length = 0;
  process.env.PAYMENTS_RETURN_ORIGINS = "https://shop.example";
  await client.exec("DELETE FROM pay_checkouts; DELETE FROM pay_events;");
});

const post = (route: string, body: unknown) =>
  app.request(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const order = (provider: string, extra: Record<string, unknown> = {}) => ({
  provider,
  lines: [
    { name: "Camiseta", unitAmount: 1999, quantity: 2 },
    { name: "Envío", unitAmount: 500, quantity: 1 },
  ],
  currency: "USD",
  successUrl: "https://shop.example/gracias",
  cancelUrl: "https://shop.example/carrito",
  customerEmail: "ana@example.com",
  metadata: { odooOrderId: "8f1f6c0e-3a7d-4c58-9d4a-0b5c2e1d9f00" },
  ...extra,
});

const ADMIN = { id: "u-admin", role: "admin" };

describe("POST /orders/checkout", () => {
  it("is for the shop's backend or the team, not a visitor", async () => {
    tilopayAnswers([]);
    expect((await post("/orders/checkout", order("tilopay", { billing }))).status).toBe(401);
    session = { id: "u-ana", role: "user" };
    expect((await post("/orders/checkout", order("tilopay", { billing }))).status).toBe(403);
    session = { id: "agent-1", role: "agent", scopes: ["blog:*"] };
    expect((await post("/orders/checkout", order("tilopay", { billing }))).status).toBe(403);
  });

  it("opens Tilopay's payment page for the order's total, and keeps the payment", async () => {
    tilopayAnswers([]);
    session = { id: "agent-1", role: "agent", scopes: ["payments:*"] };
    const response = await post("/orders/checkout", order("tilopay", { billing }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reference).toMatch(/^[A-Z0-9]{15}$/);
    expect(body.url).toBe(`https://secure.tilopay.com/htmls/${body.reference}.html`);

    const page = calls.find((c) => c.url.endsWith("/processPayment"))!;
    expect(page.headers.Authorization).toBe("bearer tok");
    expect(page.body).toMatchObject({
      key: "key-123",
      amount: "44.98",
      currency: "USD",
      orderNumber: body.reference,
      capture: "1",
      redirect: env.TILOPAY_RETURN_URL,
      billToCountry: "PA",
      billToEmail: "ana@example.com",
    });

    const [kept] = (await client.query(`SELECT provider, amount, currency, metadata, success_url FROM pay_checkouts`)).rows as any[];
    expect(kept).toMatchObject({ provider: "tilopay", amount: 4498, currency: "USD", success_url: "https://shop.example/gracias" });
    expect(kept.metadata).toEqual({ odooOrderId: "8f1f6c0e-3a7d-4c58-9d4a-0b5c2e1d9f00" });
  });

  it("refuses Tilopay without a billing address, return URLs off the site, and unknown providers", async () => {
    tilopayAnswers([]);
    session = ADMIN;
    expect((await post("/orders/checkout", order("tilopay"))).status).toBe(502);
    expect((await post("/orders/checkout", order("tilopay", { billing, successUrl: "https://evil.example/" }))).status).toBe(422);
    expect((await post("/orders/checkout", order("nope", { billing }))).status).toBe(404);
    expect((await post("/orders/checkout", order("tilopay", { billing, metadata: { userId: "u-x" } }))).status).toBe(422);
  });

  it("answers Yappy's button instead of a URL", async () => {
    yappyAnswers();
    session = ADMIN;
    const response = await post("/orders/checkout", order("yappy"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.url).toBe("");
    expect(body.button).toEqual({
      script: "https://bt-cdn-uat.yappycloud.com/v1/cdn/web-component-btn-yappy.js",
      params: { transactionId: "T-1", token: "btn-token", documentName: "doc-1" },
    });
    const [validate, create] = calls;
    expect(validate.url).toBe("https://api-comecom-uat.yappycloud.com/payments/validate/merchant");
    expect(validate.body).toEqual({ merchantId: "MERCH1", urlDomain: "https://shop.example" });
    expect(create.headers.Authorization).toBe("yappy-session");
    expect(create.body).toMatchObject({
      merchantId: "MERCH1",
      orderId: body.reference,
      domain: "https://shop.example",
      aliasYappy: "60000000",
      ipnUrl: env.YAPPY_IPN_URL,
      subtotal: "44.98",
      total: "44.98",
      taxes: "0.00",
      discount: "0.00",
    });
  });

  it("Yappy charges dollars only", async () => {
    yappyAnswers();
    session = ADMIN;
    expect((await post("/orders/checkout", order("yappy", { currency: "CRC" }))).status).toBe(502);
  });
});

describe("Tilopay's return", () => {
  async function open(): Promise<string> {
    tilopayAnswers([]);
    session = ADMIN;
    return (await (await post("/orders/checkout", order("tilopay", { billing }))).json()).reference;
  }

  it("a code=1 the buyer typed is not a payment: Tilopay is asked, and says no", async () => {
    const reference = await open();
    tilopayAnswers([{ id_tilopay: 1, orderNumber: reference, amount: "44.98", currency: "USD", code: "0" }]);
    const response = await app.request(`/return/tilopay?code=1&order=${reference}&description=Approved`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://shop.example/carrito");
    expect(emitted.filter((e) => e.name === "payment:payment.succeeded")).toHaveLength(0);
  });

  it("an approved payment, confirmed with Tilopay, is announced with the order's metadata", async () => {
    const reference = await open();
    tilopayAnswers([{ id_tilopay: 4300, orderNumber: reference, amount: "44.98", currency: "USD", code: "1" }]);
    const response = await app.request(`/return/tilopay?code=1&order=${reference}&tilopay-transaction=4300`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://shop.example/gracias");

    const [event] = emitted.filter((e) => e.name === "payment:payment.succeeded");
    expect(event.data.event).toMatchObject({
      provider: "tilopay",
      externalId: "tilopay:4300",
      settled: true,
      money: { amount: 4498, currency: "USD" },
      metadata: { odooOrderId: "8f1f6c0e-3a7d-4c58-9d4a-0b5c2e1d9f00" },
    });
    const consult = calls.find((c) => c.url.endsWith("/consult"))!;
    expect(consult.body).toMatchObject({ key: "key-123", orderNumber: reference });

    // The buyer reloads the page: the same payment is not announced twice.
    emitted.length = 0;
    await app.request(`/return/tilopay?code=1&order=${reference}`);
    expect(emitted.filter((e) => e.name === "payment:payment.succeeded")).toHaveLength(0);
  });

  it("an order number this kon never opened is refused", async () => {
    tilopayAnswers([{ id_tilopay: 9, orderNumber: "KNOTOURS", amount: "1.00", currency: "USD", code: "1" }]);
    expect((await app.request("/return/tilopay?code=1&order=KNOTOURS")).status).toBe(400);
  });
});

describe("Yappy's notification", () => {
  async function open(): Promise<string> {
    yappyAnswers();
    session = ADMIN;
    return (await (await post("/orders/checkout", order("yappy"))).json()).reference;
  }
  const notify = (orderId: string, status: string, hash: string, domain = env.YAPPY_DOMAIN) =>
    app.request(`/return/yappy?orderId=${orderId}&status=${status}&hash=${hash}&domain=${encodeURIComponent(domain)}`);

  it("computes the hash as Yappy's own samples do", () => {
    // HMAC-SHA256 with the first part of the decoded secret, over orderId + status + domain, hex.
    const expected = createHmac("sha256", "hmac-key-0123456789").update("K1EshopX" + "E" + "https://shop.example").digest("hex");
    expect(yappySignature(YAPPY_SECRET, "K1EshopX", "E", "https://shop.example")).toBe(expected);
  });

  it("an executed payment, correctly signed, is announced with the amount this kon asked for", async () => {
    const reference = await open();
    const response = await notify(reference, "E", yappySignature(YAPPY_SECRET, reference, "E", env.YAPPY_DOMAIN));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, applied: true });
    const [event] = emitted.filter((e) => e.name === "payment:payment.succeeded");
    expect(event.data.event).toMatchObject({
      provider: "yappy",
      externalId: `yappy:${reference}:E`,
      settled: true,
      money: { amount: 4498, currency: "USD" },
      metadata: { odooOrderId: "8f1f6c0e-3a7d-4c58-9d4a-0b5c2e1d9f00" },
    });

    // Yappy notifies again: acknowledged, not applied twice.
    const again = await notify(reference, "E", yappySignature(YAPPY_SECRET, reference, "E", env.YAPPY_DOMAIN));
    expect(await again.json()).toEqual({ received: true, applied: false });
  });

  it("a forged or altered notification is refused", async () => {
    const reference = await open();
    const good = yappySignature(YAPPY_SECRET, reference, "R", env.YAPPY_DOMAIN);
    // Same hash, status changed to "executed".
    expect((await notify(reference, "E", good)).status).toBe(400);
    expect((await notify(reference, "E", "0".repeat(64))).status).toBe(400);
    expect((await notify(reference, "Z", good)).status).toBe(400);
    expect((await app.request(`/return/yappy?orderId=${reference}`)).status).toBe(400);
    expect(emitted.filter((e) => e.name === "payment:payment.succeeded")).toHaveLength(0);
  });

  it("rejected, cancelled and expired are failures, not payments", async () => {
    for (const status of ["R", "C", "X"]) {
      const reference = await open();
      const response = await notify(reference, status, yappySignature(YAPPY_SECRET, reference, status, env.YAPPY_DOMAIN));
      expect(response.status).toBe(200);
    }
    expect(emitted.filter((e) => e.name === "payment:payment.failed")).toHaveLength(3);
    expect(emitted.filter((e) => e.name === "payment:payment.succeeded")).toHaveLength(0);
  });

  it("a signed notification for an order this kon did not open is acknowledged and ignored", async () => {
    const response = await notify("KUNKNOWN1", "E", yappySignature(YAPPY_SECRET, "KUNKNOWN1", "E", env.YAPPY_DOMAIN));
    expect(await response.json()).toEqual({ ignored: true });
  });
});

describe("whose books a payment belongs in", () => {
  it("a payment for an Odoo order, or one another system claims, is not posted to the ledger", async () => {
    const { booksKeptElsewhere } = await import("../../kons/kon-payments/index");
    expect(booksKeptElsewhere({ metadata: { odooOrderId: "8f1f6c0e-3a7d-4c58-9d4a-0b5c2e1d9f00" } })).toBe("odoo");
    expect(booksKeptElsewhere({ metadata: { booksKeptBy: "erp" } })).toBe("erp");
    expect(booksKeptElsewhere({ metadata: { shopOrderId: "o1" } })).toBeNull();
    expect(booksKeptElsewhere({ metadata: {} })).toBeNull();
  });
});

describe("openOrderCheckout for kons that load it", () => {
  it("lists button providers only to a caller that can render them", () => {
    const providers = new Map<string, PaymentProvider>([
      ["stripe", stripeProvider({ STRIPE_SECRET_KEY: "sk_test" })],
      ["tilopay", tilopayProvider(env, http)],
      ["yappy", yappyProvider(env, http)],
    ]);
    expect(orderProviderNames(providers)).toEqual(["stripe", "tilopay"]);
    expect(orderProviderNames(providers, ["redirect", "button"])).toEqual(["stripe", "tilopay", "yappy"]);
  });

  it("refuses a provider that reports by order number when there is nowhere to keep it", async () => {
    const providers = new Map<string, PaymentProvider>([["yappy", yappyProvider(env, http)]]);
    const result = await openOrderCheckout(providers, "yappy", { ...order("yappy"), lines: order("yappy").lines } as never, {
      PAYMENTS_RETURN_ORIGINS: "https://shop.example",
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("references are Yappy-shaped and do not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, newReference));
    expect(seen.size).toBe(500);
    for (const reference of seen) expect(reference).toMatch(/^[A-Z0-9]{15}$/);
  });
});

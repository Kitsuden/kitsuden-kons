/**
 * kon-payments — `cancel_at_period_end` is recorded, and the emitted event carries the state
 * ============================================================================
 *
 * The column existed and `GET /subscription` returned it, but nothing ever wrote it: a
 * subscription cancelled at period end still read `cancelAtPeriodEnd: false`. Now the cancel
 * operation sets it, the providers' subscription webhooks set it, and an event that does not say
 * (an invoice) leaves it as it was.
 *
 * Against PGlite with the real migrations and a fake provider.
 */

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
import type { PaymentEvent, PaymentProvider } from "../../kons/kon-payments/payments.types";
import { paddleProvider } from "../../kons/kon-payments/providers/paddle";

const here = dirname(fileURLToPath(import.meta.url));

let client: PGlite;
let app: Hono;
let session: { id: string; role: string } | null = null;
let nextEvent: PaymentEvent | null = null;
const emitted: { name: string; data: any }[] = [];

const fake: PaymentProvider = {
  name: "stripe",
  isConfigured: () => true,
  async createCheckout() {
    return { url: "https://checkout.example/s/1", id: "cs_1" };
  },
  async parseWebhook() {
    return nextEvent ?? undefined;
  },
  async cancelSubscription() {},
};

const ANA = { id: "u-ana", role: "user" };

beforeAll(async () => {
  client = await PGlite.create();
  for (const f of ["0000_initial.sql", "0001_english_names.sql"]) {
    await client.exec(readFileSync(resolve(here, `../../kons/kon-payments/migrations/${f}`), "utf8"));
  }
  registerPaymentsPolicy();
  const ctx = createTestKonContext({
    db: { instance: drizzle(client), execute: async () => undefined, tableExists: async () => true },
    events: {
      emit: (name: string, data: unknown) => void emitted.push({ name, data }),
      on: () => {},
      off: () => {},
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
  emitted.length = 0;
  await client.exec(`
    DELETE FROM pay_customers; DELETE FROM pay_subscriptions; DELETE FROM pay_events;
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

const flag = async () =>
  (
    await client.query<{ cancel_at_period_end: boolean }>(
      "SELECT cancel_at_period_end FROM pay_subscriptions WHERE external_id = 'sub_ANA'"
    )
  ).rows[0]?.cancel_at_period_end;

const event = (over: Partial<PaymentEvent>): PaymentEvent => ({
  type: "subscription.updated",
  provider: "stripe",
  externalId: `evt_${Math.random()}`,
  subscriptionId: "sub_ANA",
  status: "active",
  metadata: { userId: "u-ana" },
  occurredAt: new Date().toISOString(),
  raw: {},
  ...over,
});

describe("cancel operation", () => {
  it("cancelling at period end records cancel_at_period_end", async () => {
    session = ANA;
    expect((await post("/cancel", { provider: "stripe", subscriptionId: "sub_ANA" })).status).toBe(200);
    expect(await flag()).toBe(true);
    const body = await (await app.request("/subscription")).json();
    expect(body.subscriptions[0].cancelAtPeriodEnd).toBe(true);
  });

  it("an immediate cancellation leaves it to the provider's webhook", async () => {
    session = ANA;
    expect(
      (await post("/cancel", { provider: "stripe", subscriptionId: "sub_ANA", immediately: true })).status
    ).toBe(200);
    expect(await flag()).toBe(false);
  });
});

describe("webhooks", () => {
  it("a subscription event with the flag sets it, and the emitted event carries the state", async () => {
    const end = new Date(Date.now() + 10 * 86_400_000).toISOString();
    nextEvent = event({ cancelAtPeriodEnd: true, currentPeriodEnd: end, planId: "price_pro" });
    expect((await post("/webhook/stripe", {})).status).toBe(200);
    expect(await flag()).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].name).toBe("payment:subscription.updated");
    expect(emitted[0].data.subscription).toEqual({
      id: "sub_ANA",
      status: "active",
      planId: "price_pro",
      currentPeriodEnd: end,
      cancelAtPeriodEnd: true,
    });
  });

  it("an event without the flag keeps the stored value; one that clears it clears it", async () => {
    await client.exec("UPDATE pay_subscriptions SET cancel_at_period_end = true");
    nextEvent = event({ type: "subscription.payment_succeeded" });
    await post("/webhook/stripe", {});
    expect(await flag()).toBe(true);

    nextEvent = event({ cancelAtPeriodEnd: false });
    await post("/webhook/stripe", {});
    expect(await flag()).toBe(false);
  });
});

describe("providers report it", () => {
  it("Paddle: a scheduled cancel is cancelAtPeriodEnd", async () => {
    const { createHmac } = await import("node:crypto");
    const secret = "pdl_secret";
    const p = paddleProvider({ PADDLE_API_KEY: "k", PADDLE_WEBHOOK_SECRET: secret } as any);
    const raw = JSON.stringify({
      event_id: "evt_1",
      event_type: "subscription.updated",
      occurred_at: new Date().toISOString(),
      data: { id: "sub_1", status: "active", scheduled_change: { action: "cancel" }, custom_data: {} },
    });
    const ts = Math.floor(Date.now() / 1000);
    const h1 = createHmac("sha256", secret).update(`${ts}:${raw}`).digest("hex");
    const parsed = await p.parseWebhook(raw, { "paddle-signature": `ts=${ts};h1=${h1}` });
    expect(parsed?.cancelAtPeriodEnd).toBe(true);
  });
});

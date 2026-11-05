/**
 * The shop's own scenario, end to end: pay, deliver, discount, tell the buyer
 * ============================================================================
 *
 * Against PGlite with the real migrations (0001, 0002, 0008). What is checked is what would cost
 * money or leak a buyer's data if it broke:
 *
 *   · the buyer reaches THEIR order only with its token, and a wrong token looks like no order;
 *   · the payment page gets the order's total, never an amount from the caller;
 *   · a payment marks the order paid only if it matches the total, and delivers its files and keys
 *     once, however many times the webhook is repeated;
 *   · downloads are counted and stop at the limit, and a refund revokes them;
 *   · a discount code is computed by the server, used once per order and given back on cancel;
 *   · a payment that arrives after the reservation expired retakes the units, or flags a refund;
 *   · "my orders" answers the same for any email and only mails the one that bought.
 */

import { PGlite } from "@electric-sql/pglite";
import { AppError, mail } from "@kitsuden/engine";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readSqlFile } from "../../.kitsuden/apps/api/src/lib/sql-file";
import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { generateLicenseKey } from "../../kons/kon-ecommerce/shop.delivery";
import { releaseExpiredReservations } from "../../kons/kon-ecommerce/shop.orders";
import {
  onPaymentRefunded,
  onPaymentSucceeded,
  type OrderPaymentInput,
  type ShopPaymentGateway,
} from "../../kons/kon-ecommerce/shop.payments";
import { registerShopPolicies } from "../../kons/kon-ecommerce/shop.policy";
import { computeDiscount, type PromotionLike } from "../../kons/kon-ecommerce/shop.promotions";
import { createShopRouter } from "../../kons/kon-ecommerce/shop.routes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let app: Hono;
let session: { id: string; role: string } | null = null;

/** What the fake payment gateway was asked to charge. */
const opened: Array<{ provider: string; input: OrderPaymentInput }> = [];
let gatewayInstalled = true;
const gateway: ShopPaymentGateway = {
  providers: () => ["stripe"],
  open: async (provider, input) => {
    opened.push({ provider, input });
    return {
      ok: true,
      session: { url: `https://pay.example/${opened.length}`, id: `cs_${opened.length}` },
    };
  },
};

/** Emails sent through the core's Mailer. */
const sent: Array<{ to: string[]; subject: string; html: string }> = [];

const rows = <T>(r: unknown): T[] =>
  (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];
const q = async <T = Record<string, unknown>>(text: string): Promise<T[]> =>
  rows<T>(await db.execute(sql.raw(text)));

beforeAll(async () => {
  const client = await PGlite.create();
  db = drizzle(client);
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { readFileSync } = await import("node:fs");
  const MIG = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../kons/kon-ecommerce/migrations"
  );
  for (const stmt of readSqlFile(resolve(MIG, "0001_shop.sql"), "0001_shop").statements) {
    await client.exec(stmt);
  }
  await client.exec(readFileSync(resolve(MIG, "0002_secure_orders.sql"), "utf8"));
  await client.exec(readFileSync(resolve(MIG, "0008_checkout_delivery_coupons.sql"), "utf8"));
  // The core's media library, only the columns the shop reads.
  await client.exec(
    "CREATE TABLE media (id uuid PRIMARY KEY, original_name text NOT NULL, key text NOT NULL)"
  );

  registerShopPolicies();
  mail.setDriver({
    name: "capture",
    send: async (m: { to: string[]; subject: string; html: string }) => {
      sent.push({ to: m.to, subject: m.subject, html: m.html });
      return { messageId: `m${sent.length}` };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double of the driver
  } as any);

  const ctx = createTestKonContext({
    db: { instance: db, execute: async () => undefined, tableExists: async () => true },
    auth: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono middleware double
      requireAuth: (c: any, next: any) => {
        if (!session) return c.json({ error: "no session" }, 401);
        c.set("user", session);
        return next();
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    storage: {
      getSignedDownloadUrl: async (key: string, seconds: number) =>
        `https://files.example/${key}?ttl=${seconds}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    konConfig: {
      "kon-ecommerce": { shippingFlatCents: 500, pickupNote: "Taller, L-V de 10 a 14" },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
  } as any);

  app = new Hono();
  app.onError((err) =>
    err instanceof AppError
      ? Response.json({ error: err.message, details: err.details }, { status: err.status })
      : Response.json({ error: String(err) }, { status: 500 })
  );
  app.route(
    "/",
    createShopRouter(ctx, {
      get payments() {
        return gatewayInstalled ? gateway : null;
      },
    })
  );
});

beforeEach(async () => {
  session = null;
  gatewayInstalled = true;
  opened.length = 0;
  sent.length = 0;
  for (const t of [
    "shop_entitlements",
    "shop_license_keys",
    "shop_product_files",
    "shop_order_items",
    "shop_orders",
    "shop_variants",
    "shop_products",
    "shop_promotions",
    "shop_order_links",
    "media",
  ]) {
    await q(`DELETE FROM ${t}`);
  }
  await q("ALTER SEQUENCE shop_order_number_seq RESTART WITH 1");
  await q(`INSERT INTO shop_products (id, slug, name, kind, active) VALUES
    ('p-guia', 'guia', 'Guia de esmaltes', 'digital', true),
    ('p-soft', 'soft', 'Programa', 'digital', true),
    ('p-taza', 'taza', 'Taza', 'physical', true)`);
  await q(`INSERT INTO shop_variants (id, product_id, name, price_cents, stock, license_mode, download_limit) VALUES
    ('v-guia', 'p-guia', 'Unica', 900, NULL, 'generate', 2),
    ('v-soft', 'p-soft', 'Unica', 3000, NULL, 'pool', NULL),
    ('v-taza', 'p-taza', 'Grande', 2500, 1, 'none', NULL)`);
  await q(`INSERT INTO media (id, original_name, key) VALUES
    ('11111111-1111-4111-8111-111111111111', 'guia.pdf', 'media/guia.pdf')`);
  await q(`INSERT INTO shop_product_files (id, product_id, media_id, filename) VALUES
    ('f-guia', 'p-guia', '11111111-1111-4111-8111-111111111111', 'guia.pdf')`);
});

const call = (
  method: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {}
) =>
  app.request(route, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function buy(
  extra: Record<string, unknown> = {},
  items = [{ variantId: "v-guia", quantity: 1 }]
) {
  const res = await call("POST", "/orders", {
    items,
    customerEmail: "Compradora@Ejemplo.com",
    fulfillmentType: "digital",
    ...extra,
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

const paid = (orderId: string, amount: number, extra: Record<string, unknown> = {}) => ({
  type: "payment.succeeded",
  provider: "stripe",
  externalId: `evt_${orderId}`,
  paymentId: `pi_${orderId}`,
  settled: true,
  money: { amount, currency: "EUR" },
  metadata: { shopOrderId: orderId },
  ...extra,
});

/** Lets the emails sent without waiting arrive. */
const flush = () => new Promise((r) => setTimeout(r, 20));

// ════════════════════════════════════════════════════════════════════════════

describe("the buyer's token", () => {
  it("is given once at purchase, and opens only that order", async () => {
    const { res, body } = await buy();
    expect(res.status).toBe(201);
    expect(typeof body.accessToken).toBe("string");
    const id = body.orderId as string;

    expect((await call("GET", `/orders/${id}`)).status).toBe(404);
    expect(
      (await call("GET", `/orders/${id}`, undefined, { "x-order-token": "x".repeat(43) })).status
    ).toBe(404);

    const ok = await call("GET", `/orders/${id}?token=${body.accessToken}`);
    expect(ok.status).toBe(200);
    const { order } = await ok.json();
    expect(order.number).toBe(body.number);
    expect(order.paymentProviders).toEqual(["stripe"]);
    // Internal columns never reach the buyer.
    for (const k of ["accessTokenHash", "idempotencyKey", "ownerId", "paymentRef"])
      expect(order).not.toHaveProperty(k);
    // A token for another order does not open this one.
    const other = await buy();
    expect((await call("GET", `/orders/${id}?token=${other.body.accessToken}`)).status).toBe(404);
  });

  it("is stored only as a hash", async () => {
    const { body } = await buy();
    const [row] = await q<{ access_token_hash: string }>(
      `SELECT access_token_hash FROM shop_orders`
    );
    expect(row.access_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.access_token_hash).not.toContain(body.accessToken as string);
  });

  it("is not handed out again on a retry with the same Idempotency-Key", async () => {
    const headers = { "idempotency-key": "retry-key-0001" };
    const body = {
      items: [{ variantId: "v-guia", quantity: 1 }],
      customerEmail: "a@b.com",
      fulfillmentType: "digital",
    };
    const first = await call("POST", "/orders", body, headers);
    const again = await call("POST", "/orders", body, headers);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect((await again.json()).accessToken).toBeUndefined();
  });

  it("is in the confirmation email, with the order page link", async () => {
    const { body } = await buy();
    await flush();
    const received = sent.find((m) => m.subject.includes(body.number as string));
    expect(received?.to).toEqual(["Compradora@Ejemplo.com"]);
    expect(received?.html).toContain(`token=${body.accessToken}`);
  });
});

describe("paying", () => {
  it("opens the payment with the order's own total and lines, never the caller's", async () => {
    const { body } = await buy({}, [{ variantId: "v-guia", quantity: 2 }]);
    const res = await call(
      "POST",
      `/orders/${body.orderId}/checkout`,
      { provider: "stripe", successUrl: "https://shop.example/ok", amount: 1, totalCents: 1 },
      { "x-order-token": body.accessToken as string }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe("https://pay.example/1");
    const { input } = opened[0];
    expect(input.lines).toEqual([
      { name: "Guia de esmaltes (Unica)", unitAmount: 900, quantity: 2 },
    ]);
    expect(input.currency).toBe("EUR");
    expect(input.metadata).toEqual({ shopOrderId: body.orderId, shopOrderNumber: body.number });
  });

  it("refuses without the token, after paying, and without a payment kon", async () => {
    const { body } = await buy();
    const id = body.orderId as string;
    const t = { "x-order-token": body.accessToken as string };
    const pay = { provider: "stripe", successUrl: "https://shop.example/ok" };
    expect((await call("POST", `/orders/${id}/checkout`, pay)).status).toBe(404);

    gatewayInstalled = false;
    expect((await call("POST", `/orders/${id}/checkout`, pay, t)).status).toBe(503);
    gatewayInstalled = true;

    await onPaymentSucceeded(db, paid(id, 900));
    expect((await call("POST", `/orders/${id}/checkout`, pay, t)).status).toBe(409);
  });

  it("a matching payment marks it paid and delivers the file and a key, once", async () => {
    const { body } = await buy();
    const id = body.orderId as string;
    const first = await onPaymentSucceeded(db, paid(id, 900));
    expect(first.outcome).toBe("paid");
    // Digital: paid goes on to delivered.
    expect(first.order?.status).toBe("delivered");
    expect(first.order?.paymentRef).toBe(`pi_${id}`);

    const again = await onPaymentSucceeded(db, paid(id, 900));
    expect(again.outcome).toBe("already");
    const ents = await q<{ kind: string }>(
      `SELECT kind FROM shop_entitlements WHERE order_id = '${id}' ORDER BY kind`
    );
    expect(ents.map((e) => e.kind)).toEqual(["download", "license"]);
  });

  it("a payment that does not match the total leaves the order pending", async () => {
    const { body } = await buy();
    const id = body.orderId as string;
    expect((await onPaymentSucceeded(db, paid(id, 1))).outcome).toBe("mismatch");
    expect(
      (await onPaymentSucceeded(db, paid(id, 900, { money: { amount: 900, currency: "USD" } })))
        .outcome
    ).toBe("mismatch");
    expect((await onPaymentSucceeded(db, paid(id, 900, { settled: false }))).outcome).toBe(
      "not-settled"
    );
    const [row] = await q<{ status: string }>(`SELECT status FROM shop_orders WHERE id = '${id}'`);
    expect(row.status).toBe("pending");
  });

  it("ignores payments the shop did not open", async () => {
    expect(
      (await onPaymentSucceeded(db, paid("x", 1, { metadata: { userId: "u1" } }))).outcome
    ).toBe("ignored");
  });
});

describe("downloads and keys", () => {
  it("counts downloads, stops at the limit, and a refund revokes", async () => {
    const { body } = await buy();
    const id = body.orderId as string;
    const t = { "x-order-token": body.accessToken as string };
    await onPaymentSucceeded(db, paid(id, 900));

    const { order } = await (await call("GET", `/orders/${id}`, undefined, t)).json();
    const file = order.entitlements.find((e: { kind: string }) => e.kind === "download");
    const key = order.entitlements.find((e: { kind: string }) => e.kind === "license");
    expect(key.licenseKey).toMatch(/^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/);

    const url = `/orders/${id}/downloads/${file.id}`;
    const one = await call("GET", url, undefined, t);
    expect(one.status).toBe(302);
    expect(one.headers.get("location")).toBe("https://files.example/media/guia.pdf?ttl=300");
    expect((await call("GET", url, undefined, t)).status).toBe(302);
    // download_limit = 2
    expect((await call("GET", url, undefined, t)).status).toBe(410);
    // Without the token, nothing.
    expect((await call("GET", url)).status).toBe(404);

    const refund = await onPaymentRefunded(db, {
      type: "payment.refunded",
      provider: "stripe",
      externalId: "evt_r",
      paymentId: `pi_${id}`,
    });
    expect(refund.outcome).toBe("refunded");
    const after = await (await call("GET", `/orders/${id}`, undefined, t)).json();
    expect(after.order.status).toBe("refunded");
    expect(
      after.order.entitlements.every(
        (e: { revoked: boolean; licenseKey: unknown }) => e.revoked && !e.licenseKey
      )
    ).toBe(true);
  });

  it("a partial refund changes nothing", async () => {
    const { body } = await buy();
    const id = body.orderId as string;
    await onPaymentSucceeded(db, paid(id, 900));
    const r = await onPaymentRefunded(db, {
      type: "payment.refunded",
      provider: "stripe",
      externalId: "evt_p",
      paymentId: `pi_${id}`,
      partial: true,
    });
    expect(r.outcome).toBe("partial-refund");
    const [row] = await q<{ status: string }>(`SELECT status FROM shop_orders WHERE id = '${id}'`);
    expect(row.status).toBe("delivered");
  });

  it("a full refund the order cannot show (in production) is reported, not dropped", async () => {
    const res = await call("POST", "/orders", {
      items: [{ variantId: "v-taza", quantity: 1 }],
      customerEmail: "c@d.com",
      fulfillmentType: "pickup",
    });
    const { orderId } = await res.json();
    await onPaymentSucceeded(db, paid(orderId, 2500));
    const r = await onPaymentRefunded(db, {
      type: "payment.refunded",
      provider: "stripe",
      externalId: "evt_r2",
      paymentId: `pi_${orderId}`,
    });
    expect(r.outcome).toBe("refund-unapplied");
    expect(r.order?.status).toBe("in_production");
  });

  it("a pool short of keys delivers what it has, and the rest after uploading", async () => {
    await q(
      `INSERT INTO shop_license_keys (id, variant_id, license_key) VALUES ('k1', 'v-soft', 'KEY-ONE')`
    );
    const { body } = await buy({}, [{ variantId: "v-soft", quantity: 2 }]);
    const id = body.orderId as string;
    const r = await onPaymentSucceeded(db, paid(id, 6000));
    expect(r.delivery).toEqual({ granted: 1, keysMissing: 1 });

    session = { id: "u-editor", role: "editor" };
    const up = await call("POST", "/admin/variants/v-soft/license-keys", {
      keys: ["KEY-TWO", "KEY-ONE"],
    });
    expect(await up.json()).toEqual({ added: 1, available: 1 });
    const d = await (await call("POST", `/admin/orders/${id}/deliver`)).json();
    expect(d.granted).toBe(1);
    expect(d.keysMissing).toBe(0);
    expect(d.entitlements.map((e: { licenseKey: string }) => e.licenseKey).sort()).toEqual([
      "KEY-ONE",
      "KEY-TWO",
    ]);
    // Delivering again hands out nothing new.
    expect((await (await call("POST", `/admin/orders/${id}/deliver`)).json()).granted).toBe(0);
  });

  it("generated keys use an alphabet without look-alike characters", () => {
    for (let i = 0; i < 50; i++) expect(generateLicenseKey()).not.toMatch(/[01ILO]/);
  });
});

describe("discount codes", () => {
  const promo = (over: Partial<PromotionLike> = {}): PromotionLike => ({
    id: "pr",
    code: "X",
    active: true,
    applicationType: "percentage",
    applicationTarget: "order",
    value: 10,
    currency: null,
    minSubtotalCents: null,
    productIds: null,
    startsAt: null,
    endsAt: null,
    usageLimit: null,
    usageCount: 0,
    ...over,
  });
  const line = (productId: string, cents: number) => ({
    variantId: `v-${productId}`,
    productId,
    productName: productId,
    variantName: null,
    unitPriceCents: cents,
    quantity: 1,
    subtotalCents: cents,
    kind: "digital" as const,
  });

  it("computes on the server, rounding down, within its rules", () => {
    const lines = [line("a", 999), line("b", 1000)];
    expect(computeDiscount(promo(), lines, "EUR", 0)).toMatchObject({
      ok: true,
      totalDiscountCents: 199,
    });
    expect(computeDiscount(promo({ productIds: ["b"] }), lines, "EUR", 0)).toMatchObject({
      totalDiscountCents: 100,
    });
    expect(
      computeDiscount(
        promo({ applicationType: "fixed", value: 5000, currency: "EUR" }),
        lines,
        "EUR",
        0
      )
    ).toMatchObject({ totalDiscountCents: 1999 });
    expect(
      computeDiscount(
        promo({ applicationType: "fixed", value: 5, currency: "USD" }),
        lines,
        "EUR",
        0
      ).ok
    ).toBe(false);
    expect(computeDiscount(promo({ minSubtotalCents: 5000 }), lines, "EUR", 0).ok).toBe(false);
    expect(
      computeDiscount(promo({ endsAt: new Date(Date.now() - 1000) }), lines, "EUR", 0).ok
    ).toBe(false);
    expect(computeDiscount(promo({ usageLimit: 1, usageCount: 1 }), lines, "EUR", 0).ok).toBe(
      false
    );
    expect(computeDiscount(promo({ active: false }), lines, "EUR", 0).ok).toBe(false);
    expect(
      computeDiscount(promo({ applicationTarget: "shipping", value: 100 }), lines, "EUR", 0).ok
    ).toBe(false);
    expect(
      computeDiscount(promo({ applicationTarget: "shipping", value: 100 }), lines, "EUR", 500)
    ).toMatchObject({
      shippingDiscountCents: 500,
    });
  });

  it("an order with a code is cheaper, uses it once, and gives it back on cancel", async () => {
    session = { id: "u-editor", role: "editor" };
    const created = await call("POST", "/admin/promotions", {
      code: "Verano",
      applicationType: "percentage",
      value: 50,
      usageLimit: 1,
    });
    expect(created.status).toBe(201);
    expect(
      (
        await call("POST", "/admin/promotions", {
          code: "VERANO",
          applicationType: "percentage",
          value: 5,
        })
      ).status
    ).toBe(409);
    session = null;

    const { res, body } = await buy({ couponCode: "verano" });
    expect(res.status).toBe(201);
    expect(body.totalCents).toBe(450);
    expect(body.discountCents).toBe(450);

    const second = await buy({ couponCode: "VERANO" });
    expect(second.res.status).toBe(422);
    expect(second.body.problems).toEqual(["This discount code has been used up."]);
    expect((await buy({ couponCode: "NOPE" })).body.problems).toEqual([
      "This discount code is not valid.",
    ]);

    session = { id: "u-editor", role: "editor" };
    const cancel = await call("POST", `/admin/orders/${body.orderId}/status`, {
      status: "cancelled",
    });
    expect(cancel.status).toBe(200);
    const [p] = await q<{ usage_count: number }>(`SELECT usage_count FROM shop_promotions`);
    expect(p.usage_count).toBe(0);
  });

  it("the payment page gets one line with the discounted total", async () => {
    await q(
      `INSERT INTO shop_promotions (id, code, application_type, value) VALUES ('pr1', 'TEN', 'percentage', 10)`
    );
    const { body } = await buy({ couponCode: "ten" });
    await call(
      "POST",
      `/orders/${body.orderId}/checkout`,
      { provider: "stripe", successUrl: "https://shop.example/ok" },
      { "x-order-token": body.accessToken as string }
    );
    expect(opened[0].input.lines).toEqual([
      { name: `Order ${body.number}`, unitAmount: 810, quantity: 1 },
    ]);
  });

  it("a code that takes everything off pays and delivers the order at once", async () => {
    await q(`INSERT INTO shop_promotions (id, code, application_type, value) VALUES ('pr2', 'GRATIS', 'percentage', 100)`);
    const { res, body } = await buy({ couponCode: "gratis" });
    expect(res.status).toBe(201);
    expect(body.totalCents).toBe(0);
    const [row] = await q<{ status: string; payment_ref: string }>(
      `SELECT status, payment_ref FROM shop_orders WHERE id = '${body.orderId}'`
    );
    expect(row).toEqual({ status: "delivered", payment_ref: "free" });
    const ents = await q(`SELECT kind FROM shop_entitlements WHERE order_id = '${body.orderId}'`);
    expect(ents).toHaveLength(2);
    // Nothing to pay.
    const pay = await call(
      "POST",
      `/orders/${body.orderId}/checkout`,
      { provider: "stripe", successUrl: "https://shop.example/ok" },
      { "x-order-token": body.accessToken as string }
    );
    expect(pay.status).toBe(409);
  });

  it("only the team manages codes", async () => {
    expect((await call("GET", "/admin/promotions")).status).toBe(401);
    session = { id: "u1", role: "user" };
    expect((await call("GET", "/admin/promotions")).status).toBe(403);
  });
});

describe("a payment that arrives after the reservation expired", () => {
  const physical = async () => {
    const res = await call("POST", "/orders", {
      items: [{ variantId: "v-taza", quantity: 1 }],
      customerEmail: "c@d.com",
      fulfillmentType: "pickup",
    });
    return (await res.json()) as { orderId: string };
  };

  it("retakes the units if they are still there", async () => {
    const { orderId } = await physical();
    await releaseExpiredReservations(db, 5, new Date(Date.now() + 3_600_000));
    const r = await onPaymentSucceeded(db, paid(orderId, 2500));
    expect(r.outcome).toBe("paid");
    expect(r.order?.status).toBe("in_production");
    const [v] = await q<{ stock: number }>(`SELECT stock FROM shop_variants WHERE id = 'v-taza'`);
    expect(v.stock).toBe(0);
  });

  it("asks for a refund if they were sold meanwhile", async () => {
    const { orderId } = await physical();
    await releaseExpiredReservations(db, 5, new Date(Date.now() + 3_600_000));
    await physical(); // someone else buys the only mug
    const r = await onPaymentSucceeded(db, paid(orderId, 2500));
    expect(r.outcome).toBe("paid-but-unavailable");
    const [row] = await q<{ status: string; payment_ref: string }>(
      `SELECT status, payment_ref FROM shop_orders WHERE id = '${orderId}'`
    );
    expect(row).toEqual({ status: "cancelled", payment_ref: `pi_${orderId}` });
  });
});

describe("my orders", () => {
  it("answers 202 for any email, and mails only one that bought", async () => {
    await buy();
    const unknown = await call("POST", "/my-orders/link", { email: "nadie@ejemplo.com" });
    expect(unknown.status).toBe(202);
    const known = await call("POST", "/my-orders/link", { email: "compradora@ejemplo.com" });
    expect(known.status).toBe(202);
    expect(await q(`SELECT email FROM shop_order_links`)).toEqual([
      { email: "compradora@ejemplo.com" },
    ]);

    await flush();
    const link = sent.find(
      (m) => m.to[0] === "compradora@ejemplo.com" && m.html.includes("/shop/orders?token=")
    );
    expect(link).toBeTruthy();
    expect(sent.some((m) => m.to[0] === "nadie@ejemplo.com")).toBe(false);
  });

  it("the link lists that email's orders and opens each of them", async () => {
    const { body } = await buy();
    await call("POST", "/my-orders/link", { email: "compradora@ejemplo.com" });
    await flush();
    const html = sent.find((m) => m.html.includes("/shop/orders?token="))?.html ?? "";
    const token = /token=([A-Za-z0-9_-]+)/.exec(html)?.[1] as string;

    const list = await (await call("GET", `/my-orders?token=${token}`)).json();
    expect(list.orders.map((o: { id: string }) => o.id)).toEqual([body.orderId]);
    expect((await call("GET", `/orders/${body.orderId}?token=${token}`)).status).toBe(200);
    expect((await call("GET", "/my-orders?token=" + "y".repeat(43))).status).toBe(404);
  });
});

describe("the kon listens to kon-payments", () => {
  it("a payment:payment.succeeded on the bus marks the order paid and emails the buyer", async () => {
    const { kon } = await import("../../kons/kon-ecommerce/index");
    const handlers = new Map<string, Array<(d: unknown) => void>>();
    const emitted: string[] = [];
    const events = {
      on: (name: string, h: (d: unknown) => void) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
      emit: (name: string) => emitted.push(name),
    };
    const ctx = createTestKonContext({
      db: { instance: db, execute: async () => undefined, tableExists: async () => true },
      events,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
    } as any);
    await kon.hooks?.onStartup?.(ctx);
    // A second start (a kon reactivated) does not listen twice.
    await kon.hooks?.onStartup?.(ctx);
    expect(handlers.get("payment:payment.succeeded")).toHaveLength(1);

    const { body } = await buy();
    sent.length = 0;
    handlers.get("payment:payment.succeeded")?.[0]({ event: paid(body.orderId as string, 900) });
    await new Promise((r) => setTimeout(r, 200));

    const [row] = await q<{ status: string }>(`SELECT status FROM shop_orders WHERE id = '${body.orderId}'`);
    expect(row.status).toBe("delivered");
    expect(emitted).toContain("shop:order.paid");
    expect(sent.some((m) => m.subject.includes("paid") && /[A-Z0-9]{5}-[A-Z0-9]{5}/.test(m.html))).toBe(true);
  });
});

describe("the team's status change", () => {
  it("records tracking and emails the buyer; refuses a non-http tracking link", async () => {
    const res = await call("POST", "/orders", {
      items: [{ variantId: "v-taza", quantity: 1 }],
      customerEmail: "c@d.com",
      fulfillmentType: "shipping",
      shippingAddress: { line1: "Calle 1", city: "Lima", postalCode: "15001", country: "PE" },
    });
    const { orderId } = await res.json();
    session = { id: "u-editor", role: "editor" };
    await call("POST", `/admin/orders/${orderId}/status`, { status: "paid" });
    await call("POST", `/admin/orders/${orderId}/status`, { status: "ready" });
    const bad = await call("POST", `/admin/orders/${orderId}/status`, {
      status: "shipped",
      trackingUrl: "javascript:alert(1)",
    });
    expect(bad.status).toBe(422);
    sent.length = 0;
    const ok = await call("POST", `/admin/orders/${orderId}/status`, {
      status: "shipped",
      trackingNumber: "TRK123",
      trackingUrl: "https://carrier.example/TRK123",
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).order.trackingNumber).toBe("TRK123");
    await flush();
    expect(sent[0]?.html).toContain("TRK123");
    expect(sent[0]?.html).toContain("https://carrier.example/TRK123");
  });
});

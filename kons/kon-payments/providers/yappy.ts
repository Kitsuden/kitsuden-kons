/**
 * Kitsuden Payments — Yappy (Banco General, Panama): the payment button, v2
 * ============================================================================
 * From Banco General's "Documentación para nueva integración del Botón de Pago Yappy"
 * (yappy.com.pa/comercial/desarrolladores, read 2026-11-20):
 *
 *   POST <api>/payments/validate/merchant   { merchantId, urlDomain }           → body.token
 *   POST <api>/payments/payment-wc          Authorization: <token>
 *        { merchantId, orderId, domain, paymentDate, aliasYappy, ipnUrl,
 *          discount, taxes, subtotal, total }                                   → body.{transactionId, token, documentName}
 *
 *   api   production  https://apipagosbg.bgeneral.cloud
 *         test        https://api-comecom-uat.yappycloud.com
 *
 * The buyer pays inside a web component on the merchant's page (`<btn-yappy>`, loaded from
 * Yappy's CDN); the page hands it the three values above (`eventPayment`). So this provider
 * answers a `button`, not a URL.
 *
 * The result comes as a GET to `ipnUrl`: `orderId`, `status`, `hash`, `domain`. Status: E
 * executed, R rejected (not confirmed within five minutes), C cancelled by the buyer, X
 * expired. The hash, as Yappy's own samples compute it: the secret key is base64; decoded, it
 * is split on "." and the first part is the HMAC-SHA256 key over `orderId + status + domain`,
 * in hex.
 *
 * The notification carries no amount: the amount is the one this kon sent for that order
 * (`pay_checkouts`). An order id is at most 15 letters and digits.
 *
 *   YAPPY_MERCHANT_ID    "ID de comercio", from Yappy Comercial
 *   YAPPY_SECRET_KEY     "Clave secreta", same place
 *   YAPPY_DOMAIN         the site URL configured for the button in Yappy Comercial
 *   YAPPY_IPN_URL        this API's `GET /api/payments/return/yappy`, public
 *   YAPPY_ENV            `production` (default) or `test`
 *   YAPPY_TEST_ALIAS     test only: the phone registered in Yappy's test program
 */

import { createHmac } from "node:crypto";

import {
  timingSafeEqual,
  type CheckoutInput,
  type CheckoutSession,
  type PaymentCheckoutInput,
  type PaymentEvent,
  type PaymentProvider,
  type ReturnResult,
} from "../payments.types";

import { providerWait } from "./wait";

const HOSTS = {
  production: { api: "https://apipagosbg.bgeneral.cloud", script: "https://bt-cdn.yappy.cloud/v1/cdn/web-component-btn-yappy.js" },
  test: { api: "https://api-comecom-uat.yappycloud.com", script: "https://bt-cdn-uat.yappycloud.com/v1/cdn/web-component-btn-yappy.js" },
} as const;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Yappy's own reference rule: 1 to 15 letters and digits. */
export const YAPPY_ORDER_ID = /^[A-Za-z0-9]{1,15}$/;

const decimal = (cents: number) => (cents / 100).toFixed(2);

/** The HMAC key inside Yappy's secret: base64, then the part before the first ".". */
export function yappyHashKey(secretKey: string): string {
  return Buffer.from(secretKey, "base64").toString("utf-8").split(".")[0];
}

export function yappySignature(secretKey: string, orderId: string, status: string, domain: string): string {
  return createHmac("sha256", yappyHashKey(secretKey)).update(orderId + status + domain).digest("hex");
}

const STATUS = { E: "executed", R: "rejected", C: "cancelled", X: "expired" } as const;

export function yappyProvider(env = process.env, http: Fetch = (url, init) => fetch(url, init)): PaymentProvider {
  const merchantId = env.YAPPY_MERCHANT_ID;
  const secretKey = env.YAPPY_SECRET_KEY;
  const domain = env.YAPPY_DOMAIN;
  const ipnUrl = env.YAPPY_IPN_URL;
  const hosts = env.YAPPY_ENV === "test" ? HOSTS.test : HOSTS.production;

  async function post(path: string, body: Record<string, unknown>, authorization?: string): Promise<any> {
    const res = await http(`${hosts.api}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(body),
      signal: providerWait(),
      redirect: "error",
    });
    const json = await res.json().catch(() => ({}));
    const code = json?.status?.code;
    if (!res.ok || !json?.body) {
      const description = typeof json?.status?.description === "string" ? json.status.description : "";
      throw new Error(`Yappy ${path} ${res.status}${code ? ` ${code}` : ""}${description ? `: ${description}` : ""}`);
    }
    return json.body;
  }

  return {
    name: "yappy",
    checkoutStyle: "button",

    isConfigured: () => Boolean(merchantId && secretKey && domain && ipnUrl),

    async createCheckout(_input: CheckoutInput): Promise<CheckoutSession> {
      throw new Error("Yappy charges one-time amounts only");
    },

    async createPaymentCheckout(input: PaymentCheckoutInput): Promise<CheckoutSession> {
      const orderId = input.reference ?? "";
      if (!YAPPY_ORDER_ID.test(orderId)) throw new Error("Yappy needs an order id of 1 to 15 letters and digits");
      if (input.currency.toUpperCase() !== "USD") throw new Error("Yappy charges in USD");
      const total = input.lines.reduce((sum, line) => sum + line.unitAmount * line.quantity, 0);
      if (total < 1) throw new Error("Yappy needs a total of at least 0.01");

      const { token } = await post("/payments/validate/merchant", { merchantId, urlDomain: domain });
      if (typeof token !== "string") throw new Error("Yappy did not validate the merchant");

      const alias = env.YAPPY_ENV === "test" ? (env.YAPPY_TEST_ALIAS ?? input.customerPhone ?? "") : (input.customerPhone ?? "");
      const order = await post(
        "/payments/payment-wc",
        {
          merchantId,
          orderId,
          domain,
          paymentDate: Math.floor(Date.now() / 1000),
          aliasYappy: alias,
          ipnUrl,
          discount: "0.00",
          taxes: "0.00",
          subtotal: decimal(total),
          total: decimal(total),
        },
        token
      );
      for (const field of ["transactionId", "token", "documentName"]) {
        if (order?.[field] === undefined || order?.[field] === null) throw new Error(`Yappy's order answered no ${field}`);
      }
      return {
        url: "",
        id: orderId,
        button: {
          script: hosts.script,
          params: {
            transactionId: String(order.transactionId),
            token: String(order.token),
            documentName: String(order.documentName),
          },
        },
      };
    },

    // Yappy notifies by GET (`parseReturn`), never by a signed POST.
    async parseWebhook() {
      return null;
    },

    async parseReturn(query, find): Promise<ReturnResult> {
      const { orderId = "", status = "", hash = "", domain: sentDomain = "" } = query;
      if (!YAPPY_ORDER_ID.test(orderId) || !(status in STATUS) || !/^[0-9a-f]{64}$/i.test(hash)) return { event: null };
      if (!timingSafeEqual(yappySignature(secretKey ?? "", orderId, status, sentDomain), hash.toLowerCase())) {
        return { event: null };
      }

      const pending = await find(orderId);
      // Signed, but not a payment this kon opened: acknowledged, nothing to record.
      if (!pending) return { event: undefined };

      const base = {
        provider: "yappy",
        paymentId: orderId,
        money: { amount: pending.amount, currency: pending.currency },
        metadata: pending.metadata,
        occurredAt: new Date().toISOString(),
        raw: { orderId, status, domain: sentDomain },
      };
      // One event per order and outcome: Yappy may notify again, and the dedupe index drops it.
      const event: PaymentEvent =
        status === "E"
          ? { ...base, type: "payment.succeeded", externalId: `yappy:${orderId}:E`, status: "active", settled: true }
          : { ...base, type: "payment.failed", externalId: `yappy:${orderId}:${status}` };
      return { event };
    },
  };
}

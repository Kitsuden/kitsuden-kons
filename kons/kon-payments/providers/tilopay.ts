/**
 * Kitsuden Payments — Tilopay (Costa Rica and Central America, cards)
 * ============================================================================
 * From Tilopay's developer docs (tilopay.com/developers, verified 2026-11-20):
 *
 *   POST https://app.tilopay.com/api/v1/login            { apiuser, password } → access_token (24 h)
 *   POST https://app.tilopay.com/api/v1/processPayment   hosted payment page → { type: "100", url }
 *   POST https://app.tilopay.com/api/v1/consult          { key, orderNumber } → the transaction(s)
 *
 * One host for test and production: the mode is a setting of the merchant account.
 *
 * HOW A PAYMENT IS CONFIRMED. Tilopay sends the buyer back to `redirect` with `code=1` when it
 * approved, and an `OrderHash` whose algorithm it does not publish. A query string the buyer
 * can type is not proof, so it is never believed: on every return this provider asks Tilopay
 * itself (`consult`) for the order, and only a transaction with `code: "1"` for the amount and
 * currency this kon opened counts as paid.
 *
 *   TILOPAY_API_USER, TILOPAY_API_PASSWORD   from Tilopay's panel (Integración con plataformas)
 *   TILOPAY_API_KEY                          the integration key, same place
 *   TILOPAY_RETURN_URL                       this API's `GET /api/payments/return/tilopay`, public
 */

import type {
  CheckoutInput,
  CheckoutSession,
  PaymentCheckoutInput,
  PaymentEvent,
  PaymentProvider,
  PendingCheckout,
  ReturnResult,
} from "../payments.types";

import { providerWait } from "./wait";

export const TILOPAY_API = "https://app.tilopay.com/api/v1";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Cents to the decimal string Tilopay takes. */
const decimal = (cents: number) => (cents / 100).toFixed(2);

/** Tilopay's amount (a decimal string) to cents, or null. */
function cents(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

interface ConsultItem {
  id_tilopay?: string | number;
  orderNumber?: string;
  amount?: string;
  currency?: string;
  code?: string | number;
  auth?: string;
  date?: string;
}

export function tilopayProvider(env = process.env, http: Fetch = (url, init) => fetch(url, init)): PaymentProvider {
  const apiUser = env.TILOPAY_API_USER;
  const password = env.TILOPAY_API_PASSWORD;
  const key = env.TILOPAY_API_KEY;
  const returnUrl = env.TILOPAY_RETURN_URL;

  let token: { value: string; until: number } | null = null;

  async function post(path: string, body: Record<string, unknown>, auth = true): Promise<any> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (auth) headers.Authorization = `bearer ${await bearer()}`;
    const res = await http(`${TILOPAY_API}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: providerWait(),
      redirect: "error",
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && auth) token = null;
    if (!res.ok) {
      const message = typeof json?.message === "string" ? json.message : typeof json?.error === "string" ? json.error : "";
      throw new Error(`Tilopay ${path} ${res.status}${message ? `: ${message}` : ""}`);
    }
    return json;
  }

  async function bearer(): Promise<string> {
    if (token && token.until > Date.now()) return token.value;
    const json = await post("/login", { apiuser: apiUser, password }, false);
    if (typeof json?.access_token !== "string") throw new Error("Tilopay login answered no token");
    const seconds = Number(json.expires_in);
    // Renewed a minute early: a token that expires in flight fails the payment.
    const life = (Number.isFinite(seconds) && seconds > 120 ? seconds : 3600) - 60;
    token = { value: json.access_token, until: Date.now() + life * 1000 };
    return token.value;
  }

  /** The approved transaction for this order, as Tilopay reports it, or null. */
  async function approved(orderNumber: string): Promise<ConsultItem | null> {
    const json = await post("/consult", { key, orderNumber, merchantId: "" });
    const items: ConsultItem[] = Array.isArray(json?.response) ? json.response : [];
    return items.find((item) => String(item.code) === "1" && String(item.orderNumber ?? orderNumber) === orderNumber) ?? null;
  }

  return {
    name: "tilopay",
    checkoutStyle: "redirect",

    isConfigured: () => Boolean(apiUser && password && key && returnUrl),

    async createCheckout(_input: CheckoutInput): Promise<CheckoutSession> {
      throw new Error("Tilopay here charges one-time amounts only; subscriptions are not wired");
    },

    async createPaymentCheckout(input: PaymentCheckoutInput): Promise<CheckoutSession> {
      if (!input.reference) throw new Error("Tilopay needs the payment's reference");
      const billing = input.billing;
      if (!billing) throw new Error("Tilopay requires the buyer's billing address");
      const total = input.lines.reduce((sum, line) => sum + line.unitAmount * line.quantity, 0);

      const json = await post("/processPayment", {
        redirect: returnUrl,
        key,
        amount: decimal(total),
        currency: input.currency.toUpperCase(),
        orderNumber: input.reference,
        capture: "1",
        subscription: "0",
        platform: "api",
        billToFirstName: billing.firstName,
        billToLastName: billing.lastName,
        billToAddress: billing.address,
        billToAddress2: billing.address2 ?? "",
        billToCity: billing.city,
        billToState: billing.state,
        billToZipPostCode: billing.zip,
        billToCountry: billing.country,
        billToTelephone: billing.phone,
        billToEmail: billing.email,
        token_version: "v2",
      });
      if (String(json?.type) !== "100" || typeof json?.url !== "string") {
        throw new Error(`Tilopay did not open the payment page${json?.message ? `: ${json.message}` : ""}`);
      }
      return { url: json.url, id: input.reference };
    },

    // Tilopay's server notification for hosted payments is not publicly specified, and its
    // signature algorithm is not published: nothing posted here is believed.
    async parseWebhook() {
      return null;
    },

    async parseReturn(query, find): Promise<ReturnResult> {
      const reference = query.order ?? "";
      const pending = reference ? await find(reference) : null;
      // Not one of ours: nothing to say, and nowhere safe to send the browser.
      if (!pending) return { event: null };

      const back = (ok: boolean) => (ok ? pending.successUrl : (pending.cancelUrl ?? pending.successUrl));
      const paid = await approved(reference);
      if (!paid) {
        return {
          event: query.code && query.code !== "1" ? failed(pending, query) : undefined,
          redirect: back(false),
        };
      }

      // The amount is Tilopay's, not this kon's: if it charged something else than was asked,
      // the event says so, and the kon that asked refuses it on its own check.
      const amount = cents(paid.amount);
      const currency = String(paid.currency ?? "").toUpperCase();
      const event: PaymentEvent = {
        type: "payment.succeeded",
        provider: "tilopay",
        externalId: `tilopay:${paid.id_tilopay ?? reference}`,
        paymentId: String(paid.id_tilopay ?? reference),
        status: "active",
        money: { amount: amount ?? 0, currency: currency || pending.currency },
        settled: true,
        metadata: pending.metadata,
        occurredAt: new Date().toISOString(),
        raw: { consult: paid },
      };
      return { event, redirect: back(true) };
    },
  };
}

function failed(pending: PendingCheckout, query: Record<string, string>): PaymentEvent {
  return {
    type: "payment.failed",
    provider: "tilopay",
    externalId: `tilopay:${pending.reference}:declined:${(query["tilopay-transaction"] ?? query.tpt ?? "").slice(0, 40)}`,
    paymentId: pending.reference,
    money: { amount: pending.amount, currency: pending.currency },
    metadata: pending.metadata,
    occurredAt: new Date().toISOString(),
    raw: { code: query.code ?? null, description: (query.description ?? "").slice(0, 200) },
  };
}

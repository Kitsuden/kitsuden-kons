/**
 * The shop's emails
 * ============================================================================
 *
 * The buyer has no account, so email is the only channel: without these, a seller who makes
 * things by hand answered "where is my order?" one message at a time.
 *
 *   shop.order-received  — right after buying: what, how much, and the link to pay and follow it.
 *   shop.order-paid      — the payment arrived: downloads and keys, or "we are making it".
 *   shop.order-status    — ready (for pickup or to ship), shipped (with tracking), delivered,
 *                          cancelled, refunded.
 *   shop.my-orders       — the "my orders" link the buyer asked for with their email.
 *
 * They go through the core's shared Mailer, like kon-members' sign-in link. Sending never blocks
 * or breaks the operation that caused it, and `SHOP_MAILS=off` turns them off when another
 * channel (a webhook to your own mailer, say) replaces them; the `shop:*` events still fire.
 *
 * Every text goes through `ctx.t` and the template helpers, which escape it: a product called
 * `<script>` arrives as text.
 */

import { button, heading, layout, mail, panel, paragraph, type Mailable } from "@kitsuden/engine";

export interface MailLine {
  name: string;
  quantity: number;
  /** Already formatted, `25.00 EUR`. */
  amount: string;
}

export interface OrderMailData {
  to: string;
  number: string;
  name?: string | null;
  /** The site page that shows the order, with a token that opens it. */
  orderUrl: string;
  lines: MailLine[];
  total: string;
  discount?: string | null;
  fulfillmentType: "digital" | "shipping" | "pickup";
  pickupNote?: string | null;
  licenseKeys?: string[];
  hasDownloads?: boolean;
  /** For `shop.order-status`. */
  status?: string;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
}

export interface MyOrdersMailData {
  to: string;
  url: string;
  minutes: number;
}

/** `2500, "EUR"` → `25.00 EUR`. Amounts are cents everywhere else. */
export function money(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function linesBlock(
  data: OrderMailData,
  t: (k: string, v?: Record<string, string | number>) => string
): string {
  const lines = data.lines
    .map((l) => paragraph(`${l.quantity} × ${l.name} — ${l.amount}`))
    .join("");
  const discount = data.discount
    ? paragraph(t("shop.mail.discount", { amount: data.discount }))
    : "";
  return lines + discount + paragraph(t("shop.mail.total", { total: data.total }));
}

export const orderReceived: Mailable<OrderMailData> = {
  name: "shop.order-received",
  envelope: (data, ctx) => ({
    to: data.to,
    subject: ctx.t("shop.received.subject", { number: data.number }),
    tag: "shop-order-received",
  }),
  content: (data, ctx) => ({
    html: layout({
      preheader: ctx.t("shop.received.heading", { number: data.number }),
      body:
        heading(ctx.t("shop.received.heading", { number: data.number })) +
        paragraph(ctx.t("shop.received.body")) +
        linesBlock(data, ctx.t) +
        button(ctx.t("shop.mail.view"), data.orderUrl) +
        panel(ctx.t("shop.mail.keep-link")),
    }),
  }),
};

export const orderPaid: Mailable<OrderMailData> = {
  name: "shop.order-paid",
  envelope: (data, ctx) => ({
    to: data.to,
    subject: ctx.t("shop.paid.subject", { number: data.number }),
    tag: "shop-order-paid",
  }),
  content: (data, ctx) => {
    const keys = data.licenseKeys?.length
      ? paragraph(ctx.t("shop.paid.keys")) + data.licenseKeys.map((k) => panel(k)).join("")
      : "";
    const next =
      data.fulfillmentType === "digital"
        ? paragraph(ctx.t(data.hasDownloads ? "shop.paid.downloads" : "shop.paid.digital"))
        : paragraph(ctx.t("shop.paid.making"));
    return {
      html: layout({
        preheader: ctx.t("shop.paid.heading", { number: data.number }),
        body:
          heading(ctx.t("shop.paid.heading", { number: data.number })) +
          next +
          keys +
          linesBlock(data, ctx.t) +
          button(ctx.t("shop.mail.view"), data.orderUrl),
      }),
    };
  },
};

export const orderStatus: Mailable<OrderMailData> = {
  name: "shop.order-status",
  envelope: (data, ctx) => ({
    to: data.to,
    subject: ctx.t(`shop.status.${data.status}.subject`, { number: data.number }),
    tag: `shop-order-${data.status}`,
  }),
  content: (data, ctx) => {
    const status = data.status ?? "";
    const body =
      status === "ready"
        ? data.fulfillmentType === "pickup"
          ? paragraph(ctx.t("shop.status.ready.pickup")) +
            (data.pickupNote ? panel(data.pickupNote) : "")
          : paragraph(ctx.t("shop.status.ready.shipping"))
        : status === "shipped"
          ? paragraph(ctx.t("shop.status.shipped.body")) +
            (data.trackingNumber
              ? panel(ctx.t("shop.status.shipped.tracking", { tracking: data.trackingNumber }))
              : "") +
            (data.trackingUrl ? button(ctx.t("shop.status.shipped.track"), data.trackingUrl) : "")
          : paragraph(ctx.t(`shop.status.${status}.body`));
    return {
      html: layout({
        preheader: ctx.t(`shop.status.${status}.subject`, { number: data.number }),
        body:
          heading(ctx.t(`shop.status.${status}.subject`, { number: data.number })) +
          body +
          button(ctx.t("shop.mail.view"), data.orderUrl),
      }),
    };
  },
};

export const myOrders: Mailable<MyOrdersMailData> = {
  name: "shop.my-orders",
  envelope: (data, ctx) => ({
    to: data.to,
    subject: ctx.t("shop.my-orders.subject"),
    tag: "shop-my-orders",
  }),
  content: (data, ctx) => ({
    html: layout({
      preheader: ctx.t("shop.my-orders.subject"),
      body:
        heading(ctx.t("shop.my-orders.subject")) +
        paragraph(ctx.t("shop.my-orders.body", { minutes: data.minutes })) +
        button(ctx.t("shop.my-orders.cta"), data.url) +
        panel(ctx.t("shop.my-orders.ignore")),
    }),
  }),
};

/** The statuses that send `shop.order-status`. `paid` has its own email; `pending` none. */
export const STATUSES_WITH_MAIL = new Set([
  "ready",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
]);

export const shopTranslations: Record<string, Record<string, string>> = {
  en: {
    "shop.mail.view": "View your order",
    "shop.mail.total": "Total: {total}",
    "shop.mail.discount": "Discount: −{amount}",
    "shop.mail.keep-link":
      "Keep this email: its link is how you pay, follow and download your order.",
    "shop.received.subject": "Order {number} received",
    "shop.received.heading": "We have your order {number}",
    "shop.received.body":
      "Thank you. This is what you ordered; it is reserved for you until it is paid.",
    "shop.paid.subject": "Order {number} paid",
    "shop.paid.heading": "Order {number} is paid",
    "shop.paid.downloads": "Your downloads are ready on your order page.",
    "shop.paid.digital": "Your purchase is ready.",
    "shop.paid.making": "We have started on it. We will write again when it is ready.",
    "shop.paid.keys": "Your license keys:",
    "shop.status.ready.subject": "Order {number} is ready",
    "shop.status.ready.pickup": "Your order is ready for pickup:",
    "shop.status.ready.shipping": "Your order is ready and leaves soon.",
    "shop.status.shipped.subject": "Order {number} is on its way",
    "shop.status.shipped.body": "Your order has been shipped.",
    "shop.status.shipped.tracking": "Tracking number: {tracking}",
    "shop.status.shipped.track": "Track the shipment",
    "shop.status.delivered.subject": "Order {number} delivered",
    "shop.status.delivered.body": "Your order has been delivered. Enjoy it.",
    "shop.status.cancelled.subject": "Order {number} cancelled",
    "shop.status.cancelled.body":
      "Your order has been cancelled. Nothing was charged for it, or what was charged will be returned.",
    "shop.status.refunded.subject": "Order {number} refunded",
    "shop.status.refunded.body":
      "Your order has been refunded. The money goes back the way it was paid.",
    "shop.my-orders.subject": "Your orders",
    "shop.my-orders.body": "Open the link to see your orders. It works for {minutes} minutes.",
    "shop.my-orders.cta": "See my orders",
    "shop.my-orders.ignore": "If you did not ask for this, ignore this email.",
  },
  es: {
    "shop.mail.view": "Ver tu pedido",
    "shop.mail.total": "Total: {total}",
    "shop.mail.discount": "Descuento: −{amount}",
    "shop.mail.keep-link": "Guarda este correo: con su enlace pagas, sigues y descargas tu pedido.",
    "shop.received.subject": "Pedido {number} recibido",
    "shop.received.heading": "Tenemos tu pedido {number}",
    "shop.received.body":
      "Gracias. Esto es lo que pediste; queda reservado para ti hasta que se pague.",
    "shop.paid.subject": "Pedido {number} pagado",
    "shop.paid.heading": "El pedido {number} está pagado",
    "shop.paid.downloads": "Tus descargas están listas en la página del pedido.",
    "shop.paid.digital": "Tu compra está lista.",
    "shop.paid.making": "Ya nos hemos puesto con él. Te escribimos cuando esté listo.",
    "shop.paid.keys": "Tus claves de licencia:",
    "shop.status.ready.subject": "El pedido {number} está listo",
    "shop.status.ready.pickup": "Tu pedido está listo para recoger:",
    "shop.status.ready.shipping": "Tu pedido está listo y sale pronto.",
    "shop.status.shipped.subject": "El pedido {number} va en camino",
    "shop.status.shipped.body": "Tu pedido ha salido.",
    "shop.status.shipped.tracking": "Número de seguimiento: {tracking}",
    "shop.status.shipped.track": "Seguir el envío",
    "shop.status.delivered.subject": "Pedido {number} entregado",
    "shop.status.delivered.body": "Tu pedido está entregado. Que lo disfrutes.",
    "shop.status.cancelled.subject": "Pedido {number} cancelado",
    "shop.status.cancelled.body":
      "Tu pedido se ha cancelado. No se cobró nada, o lo cobrado se devolverá.",
    "shop.status.refunded.subject": "Pedido {number} reembolsado",
    "shop.status.refunded.body": "Tu pedido se ha reembolsado. El dinero vuelve por donde se pagó.",
    "shop.my-orders.subject": "Tus pedidos",
    "shop.my-orders.body":
      "Abre el enlace para ver tus pedidos. Funciona durante {minutes} minutos.",
    "shop.my-orders.cta": "Ver mis pedidos",
    "shop.my-orders.ignore": "Si no lo pediste, ignora este correo.",
  },
};

/** Registers the emails and their texts once (the router and `onStartup` both call it). */
export function registerShopMails(): void {
  for (const m of [orderReceived, orderPaid, orderStatus, myOrders] as Mailable<unknown>[]) {
    if (!mail.has(m.name)) mail.register(m);
  }
  for (const [locale, entries] of Object.entries(shopTranslations)) {
    mail.addTranslations(locale, entries);
  }
}

export const shopMailsActive = (env = process.env) =>
  (env.SHOP_MAILS ?? "").toLowerCase() !== "off";

/**
 * The site page that shows one order (`SHOP_ORDER_URL`, by default `<site>/shop/order`), with
 * the order id and a token that opens it. A site PAGE and not an API GET: link previewers in
 * mail clients open every link, and a page that reads the order is harmless where a download
 * would spend one of the buyer's attempts.
 */
export function orderPageUrl(
  siteUrl: string,
  orderId: string,
  token: string,
  env = process.env
): string {
  const base = env.SHOP_ORDER_URL || `${(siteUrl || "").replace(/\/$/, "")}/shop/order`;
  const url = new URL(base);
  url.searchParams.set("id", orderId);
  url.searchParams.set("token", token);
  return url.toString();
}

/** The site page that lists a buyer's orders (`SHOP_MY_ORDERS_URL`, by default `<site>/shop/orders`). */
export function myOrdersPageUrl(siteUrl: string, token: string, env = process.env): string {
  const base = env.SHOP_MY_ORDERS_URL || `${(siteUrl || "").replace(/\/$/, "")}/shop/orders`;
  const url = new URL(base);
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * The events kon-odoo emits, for other kons, automation rules and agents (docs/kons/events.md)
 * ============================================================================
 *
 * This is how another kon learns what happened in Odoo without importing this one: kon-conta
 * turns a confirmed order into an invoice and a payment into a receipt by listening here.
 *
 * Delivery is after commit, in-process and at most once: an event notifies. A listener that must
 * not miss one has to be able to do the work again: every payload carries the Odoo id of what it
 * is about, which is a stable key to deduplicate on.
 */

import type { KonEventsDeclaration } from "@kitsuden/shared";

const product = {
  products: "array of { odooId, productId, slug, kinds }; kinds: created, product, price, stock, retired",
};

const partner = "{ odooId, name, email, vat } of the customer (res.partner)";

export const odooEvents: KonEventsDeclaration = {
  emits: {
    "odoo:product.changed": {
      description: "Products in the mirror changed after reading them from Odoo. Carries every change, whatever its kind.",
      payload: product,
    },
    "odoo:price.changed": {
      description: "The price of these products, or of one of their variants, changed in Odoo.",
      payload: product,
    },
    "odoo:stock.changed": {
      description: "The free-to-use quantity of these products, or whether they can be bought, changed in Odoo.",
      payload: product,
    },
    "odoo:sale_order.created": {
      description: "An order made through this kon now exists in Odoo, as a quotation or already confirmed.",
      payload: {
        orderId: "kon-odoo order id",
        clientRef: "the caller's reference",
        odooId: "sale.order id",
        name: "Odoo's order number (S00042)",
        status: "created | confirmed",
        amountTotal: "decimal string",
        currency: "ISO 4217",
      },
    },
    "odoo:sale_order.confirmed": {
      description:
        "A sales order is confirmed in Odoo, whoever made it (this kon, the Odoo backend, the point of sale's sales). May repeat for the same order: deduplicate on odooId.",
      payload: {
        odooId: "sale.order id",
        name: "Odoo's order number (S00042)",
        orderId: "kon-odoo order id, or null when the order was not made here",
        clientRef: "the caller's reference, or null",
        date: "ISO date of the order",
        partner,
        lines: "array of { name, quantity, unitPrice, subtotal, total, odooProductId, sku }",
        amountUntaxed: "decimal string",
        amountTax: "decimal string",
        amountTotal: "decimal string",
        currency: "ISO 4217",
      },
    },
    "odoo:sale_order.cancelled": {
      description: "A sales order was cancelled in Odoo. May repeat: deduplicate on odooId.",
      payload: { odooId: "sale.order id", name: "Odoo's order number", orderId: "kon-odoo order id or null" },
    },
    "odoo:payment.received": {
      description:
        "A customer payment is registered in Odoo. May repeat for the same payment: deduplicate on paymentId.",
      payload: {
        paymentId: "account.payment id",
        amount: "decimal string",
        currency: "ISO 4217",
        date: "YYYY-MM-DD",
        reference: "the payment's memo or reference, or null",
        partner,
        orders: "array of { odooId, name } of the sales orders its invoices came from; may be empty",
      },
    },
    "odoo:order.paid": {
      description: "A payment for an order of this kon arrived from kon-payments and matched what the order owes. Odoo is asked to confirm it next.",
      payload: { orderId: "kon-odoo order id", provider: "payment provider", reference: "the payment at the provider", amount: "decimal string", currency: "ISO 4217" },
    },
    "odoo:order.expired": {
      description: "An order was not paid before its held units ran out: they are back on sale, and Odoo is asked to cancel the quotation.",
      payload: { orderId: "kon-odoo order id", clientRef: "the caller's reference", odooId: "sale.order id or null" },
    },
    "odoo:payment.mismatch": {
      description: "A payment named an order but not for what it owes (amount or currency). Nothing was settled; a person must look.",
      payload: { orderId: "kon-odoo order id", provider: "payment provider", reference: "the payment at the provider", reason: "what did not match" },
    },
    "odoo:order.paid_unavailable": {
      description: "A payment arrived for an order whose units were no longer there (it had expired and they were sold). The money was taken: a person decides.",
      payload: { orderId: "kon-odoo order id", provider: "payment provider", reference: "the payment at the provider", reason: "what was missing" },
    },
    "odoo:order.settle_failed": {
      description: "Odoo refused to confirm a paid order. The money was taken: a person must look.",
      payload: { orderId: "kon-odoo order id", reason: "Odoo's words" },
    },
    "odoo:sync.completed": {
      description: "A full walk of the catalog finished.",
      payload: { runId: "sync run id", products: "number read", variants: "number read", retired: "number hidden because Odoo no longer has them" },
    },
    "odoo:key.expiring": {
      description: "The Odoo API key stops working soon and someone must store a new one.",
      payload: { expiresOn: "YYYY-MM-DD", daysLeft: "number" },
    },
  },
  listens: ["payment:payment.succeeded", "connections:connection.created", "connections:connection.expired", "connections:connection.revoked"],
};

/**
 * Odoo — orders, customers, payments and store credit
 * ============================================================================
 *
 * An order is taken here and made in Odoo, which stays the place where it lives: its number,
 * its taxes, its total and its state are Odoo's, read back after every step.
 *
 *   1. `takeOrder` checks the lines against the mirror and stores the order as `pending`. The
 *      caller's reference makes it idempotent: the same reference twice is the same order.
 *   2. The queue runs `pushOrder`: finds or creates the customer in Odoo, then creates the
 *      order. With the bridge module that is ONE call, in one Odoo transaction. Without it, it
 *      is `create` on `sale.order` and the order stays a quotation for a person, or Odoo's own
 *      payment page, to confirm; the caller's reference is stored on the order in Odoo so a
 *      retry finds it instead of making a second one.
 *   3. When Odoo says an order changed, `refreshOrders` reads it and announces what it became.
 *
 * Every Odoo call is its own transaction. Nothing here pretends that two calls are atomic.
 */

import { AppError, queue, withSavepoint } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, eq, inArray, or } from "drizzle-orm";

import { OdooError, type OdooClient } from "./odoo.client";
import { BRIDGE_MODEL } from "./odoo.connection";
import { decimal, m2oId, m2oName, reportConflict, text, type Many2one } from "./odoo.mirror";
import {
  odooOrders,
  odooPartners,
  odooProducts,
  odooVariants,
  type OdooOrder,
  type OdooPartner,
  type OrderCustomer,
  type OrderLine,
  type OrderStatus,
} from "./odoo.schema";
import { placeHolds, releaseHolds } from "./odoo.holds";
import { capabilitiesOf, dbOf, loadSettings, QUEUES } from "./odoo.state";

// ── Taking an order ───────────────────────────────────────────────────────────

export interface OrderRequest {
  clientRef: string;
  customer: OrderCustomer;
  lines: Array<{ variantId?: string; sku?: string; quantity: number }>;
  note?: string;
  /** Ask Odoo to confirm it at once. Only the bridge module can; without it the order stays a quotation */
  confirm?: boolean;
  /**
   * Store credit to take from the customer's eWallet when the order is paid. The caller checked
   * the balance; only the bridge module can take it, in the same Odoo transaction as the rest.
   */
  walletAmount?: number;
}

/** Stores the order and queues it for Odoo. Answers the existing order for a known reference. */
export async function takeOrder(
  ctx: KonContext,
  request: OrderRequest,
  createdBy: string | null
): Promise<{ order: OdooOrder; created: boolean }> {
  const db = dbOf(ctx);
  const [existing] = await db.select().from(odooOrders).where(eq(odooOrders.clientRef, request.clientRef)).limit(1);
  if (existing) return { order: existing, created: false };

  const settings = await loadSettings(db);
  const wallet = request.walletAmount ?? 0;
  if (wallet > 0 && !settings.capabilities?.bridge) {
    throw AppError.conflict("Paying with store credit needs the bridge module in Odoo.");
  }

  const lines: OrderLine[] = [];
  for (const [index, line] of request.lines.entries()) {
    const where = line.variantId
      ? eq(odooVariants.id, line.variantId)
      : line.sku
        ? eq(odooVariants.sku, line.sku)
        : null;
    if (!where) throw AppError.validation(`Line ${index + 1} names no variant: give variantId or sku.`);
    const found = await db
      .select({ variant: odooVariants, name: odooProducts.name })
      .from(odooVariants)
      .innerJoin(odooProducts, eq(odooProducts.id, odooVariants.productId))
      .where(and(where, eq(odooVariants.active, true), eq(odooVariants.visible, true)))
      .limit(2);
    if (found.length === 0) throw AppError.validation(`Line ${index + 1}: that variant is not for sale.`);
    // A reference on two variants cannot name one of them.
    if (found.length > 1) throw AppError.validation(`Line ${index + 1}: reference "${line.sku}" names more than one variant.`);
    const { variant, name } = found[0];
    const options = Object.values(variant.options).join(", ");
    lines.push({
      odooProductId: variant.odooId,
      variantId: variant.id,
      sku: variant.sku,
      name: options ? `${name} (${options})` : name,
      quantity: String(line.quantity),
      unitPrice: null,
    });
  }

  // All or none, inside a savepoint: a line that cannot be held answers 409 and takes the order
  // and the holds already placed with it, whatever the host then does with the request.
  const order = await withSavepoint(async () => {
    const [row] = await db
      .insert(odooOrders)
      .values({
        clientRef: request.clientRef,
        customer: { ...request.customer, email: request.customer.email.trim().toLowerCase() },
        lines,
        note: request.note ?? null,
        walletAmount: wallet.toFixed(4),
        holdExpiresAt: new Date(Date.now() + settings.holdMinutes * 60_000),
        createdBy,
      })
      .onConflictDoNothing({ target: odooOrders.clientRef })
      .returning();
    if (!row) return null;
    await placeHolds(
      ctx,
      db,
      row.id,
      lines.map((line) => ({ variantId: line.variantId as string, quantity: Number(line.quantity), name: line.name })),
      row.holdExpiresAt as Date
    );
    return row;
  });
  if (!order) {
    // Two requests with the same reference at once: the other one won.
    const [winner] = await db.select().from(odooOrders).where(eq(odooOrders.clientRef, request.clientRef)).limit(1);
    return { order: winner, created: false };
  }
  await queue.dispatch(
    QUEUES.push,
    "order",
    { orderId: order.id, confirm: request.confirm === true },
    { dedupeKey: `order:${order.id}`, attempts: 8 }
  );
  return { order, created: true };
}

// ── Customers ─────────────────────────────────────────────────────────────────

interface PartnerRecord {
  id: number;
  name?: string | false;
  email?: string | false;
  phone?: string | false;
  vat?: string | false;
}

async function rememberPartner(ctx: KonContext, record: PartnerRecord): Promise<OdooPartner> {
  const values = {
    name: text(record.name) ?? `Partner ${record.id}`,
    email: text(record.email)?.toLowerCase() ?? null,
    phone: text(record.phone),
    vat: text(record.vat),
    syncedAt: new Date(),
  };
  const [row] = await dbOf(ctx)
    .insert(odooPartners)
    .values({ ...values, odooId: record.id })
    .onConflictDoUpdate({ target: odooPartners.odooId, set: values })
    .returning();
  return row;
}

/** The customer's partner in Odoo: the one with that e-mail, or a new one. */
export async function ensurePartner(ctx: KonContext, client: OdooClient, customer: OrderCustomer): Promise<OdooPartner> {
  const email = customer.email.trim().toLowerCase();
  const fields = ["name", "email", "phone", "vat"];
  const [found] = await client.searchRead<PartnerRecord>("res.partner", {
    domain: [["email", "=ilike", email]],
    fields,
    limit: 1,
    order: "id",
  });
  if (found) return rememberPartner(ctx, found);

  const values: Record<string, unknown> = { name: customer.name, email };
  if (customer.phone) values.phone = customer.phone;
  if (customer.vat) values.vat = customer.vat;
  if (customer.street) values.street = customer.street;
  if (customer.city) values.city = customer.city;
  if (customer.zip) values.zip = customer.zip;
  if (customer.countryCode) {
    const [country] = await client.searchRead<{ id: number }>("res.country", {
      domain: [["code", "=", customer.countryCode.toUpperCase()]],
      fields: ["id"],
      limit: 1,
    });
    if (country) values.country_id = country.id;
  }
  const id = await client.create("res.partner", values);
  return rememberPartner(ctx, { id, name: customer.name, email, phone: customer.phone, vat: customer.vat });
}

// ── Reading an order back ─────────────────────────────────────────────────────

interface SaleOrderRecord {
  id: number;
  name?: string | false;
  state?: string;
  partner_id?: Many2one;
  date_order?: string | false;
  client_order_ref?: string | false;
  amount_untaxed?: number;
  amount_tax?: number;
  amount_total?: number;
  currency_id?: Many2one;
  order_line?: number[];
  access_url?: string | false;
  access_token?: string | false;
}

interface SaleLineRecord {
  id: number;
  name?: string | false;
  product_id?: Many2one;
  product_uom_qty?: number;
  price_unit?: number;
  price_subtotal?: number;
  price_total?: number;
  display_type?: string | false;
}

/** Odoo's order states, as this kon's. A quotation, sent or not, is an order that exists. */
function statusOf(state: string | undefined): OrderStatus {
  if (state === "sale" || state === "done") return "confirmed";
  if (state === "cancel") return "cancelled";
  return "created";
}

function paymentUrlOf(record: SaleOrderRecord, baseUrl: string | null): string | null {
  const path = text(record.access_url);
  const token = text(record.access_token);
  if (!baseUrl || !path || !token) return null;
  return `${baseUrl}${path}?access_token=${encodeURIComponent(token)}`;
}

async function readOrders(
  client: OdooClient,
  fields: string[],
  lineFields: string[],
  ids: number[]
): Promise<Array<{ order: SaleOrderRecord; lines: SaleLineRecord[] }>> {
  if (ids.length === 0) return [];
  const orders = await client.searchRead<SaleOrderRecord>("sale.order", { domain: [["id", "in", ids]], fields });
  const lineIds = orders.flatMap((order) => order.order_line ?? []);
  const lines = lineIds.length > 0 ? await client.read<SaleLineRecord>("sale.order.line", lineIds, lineFields) : [];
  const byId = new Map(lines.map((line) => [line.id, line]));
  return orders.map((order) => ({
    order,
    // Section and note lines are layout, not goods.
    lines: (order.order_line ?? []).flatMap((id) => {
      const line = byId.get(id);
      return line && !line.display_type ? [line] : [];
    }),
  }));
}

// ── Making the order in Odoo ──────────────────────────────────────────────────

/** What the bridge module's `create_order` answers. */
interface BridgeOrder {
  id: number;
}

/**
 * Makes a stored order in Odoo. A refusal from Odoo (a value it does not accept, a right the
 * key lacks) fails the order with Odoo's words and is not retried; a silence is thrown, so the
 * queue tries again.
 */
export async function pushOrder(
  ctx: KonContext,
  client: OdooClient,
  job: { orderId: string; confirm?: boolean },
  baseUrl: string | null
): Promise<void> {
  const db = dbOf(ctx);
  const [order] = await db.select().from(odooOrders).where(eq(odooOrders.id, job.orderId)).limit(1);
  if (!order || order.status === "failed" || order.status === "cancelled" || order.status === "expired") return;

  try {
    const { capabilities } = await capabilitiesOf(db, client);
    const partner = await ensurePartner(ctx, client, order.customer);
    let odooId = order.odooId;

    if (odooId === null) {
      // A previous attempt may have made it and died before saying so.
      const [made] = await client.searchRead<{ id: number }>("sale.order", {
        domain: [["client_order_ref", "=", order.clientRef]],
        fields: ["id"],
        limit: 1,
        order: "id",
      });
      odooId = made?.id ?? null;
    }

    if (odooId === null) {
      const lines = order.lines.map((line) => ({ product_id: line.odooProductId, quantity: Number(line.quantity) }));
      if (capabilities.bridge) {
        const made = await client.call<BridgeOrder>(BRIDGE_MODEL, "create_order", {
          client_ref: order.clientRef,
          partner_id: partner.odooId,
          lines,
          note: order.note ?? "",
          confirm: job.confirm === true,
        });
        odooId = made.id;
      } else {
        odooId = await client.create("sale.order", {
          partner_id: partner.odooId,
          client_order_ref: order.clientRef,
          ...(order.note ? { note: order.note } : {}),
          // (0, 0, values): create a line with the order.
          order_line: lines.map((line) => [0, 0, { product_id: line.product_id, product_uom_qty: line.quantity }]),
        });
      }
    }

    await db
      .update(odooOrders)
      .set({ odooId, partnerId: partner.id, updatedAt: new Date() })
      .where(eq(odooOrders.id, order.id));
    await refreshOrders(ctx, client, [odooId], baseUrl);
  } catch (error) {
    if (error instanceof OdooError && !error.retryable && error.kind !== "auth") {
      await db
        .update(odooOrders)
        .set({ status: "failed", error: error.message.slice(0, 2000), updatedAt: new Date() })
        .where(eq(odooOrders.id, order.id));
      await releaseHolds(ctx, db, [order.id]);
      ctx.logger.warn("kon-odoo: Odoo refused an order", { orderId: order.id, reason: error.message });
      return;
    }
    throw error;
  }
}

/**
 * Reads these sales orders from Odoo, brings the ones made here up to date, and announces what
 * each became. An order that was not made here (the backend, another channel) is announced too:
 * a listener that keeps books wants every sale, not only the web's.
 */
export async function refreshOrders(
  ctx: KonContext,
  client: OdooClient,
  odooIds: number[],
  baseUrl: string | null
): Promise<void> {
  const ids = [...new Set(odooIds)];
  if (ids.length === 0) return;
  const db = dbOf(ctx);
  const settings = await loadSettings(db);
  const { capabilities } = await capabilitiesOf(db, client, { settings });
  const fields = capabilities.fields["sale.order"];
  const lineFields = capabilities.fields["sale.order.line"];
  if (!fields || !lineFields) return;

  const read = await readOrders(client, fields, lineFields, ids);
  if (read.length === 0) return;

  const partnerIds = [...new Set(read.map((entry) => m2oId(entry.order.partner_id)).filter((id): id is number => id !== null))];
  const partners = new Map<number, OdooPartner>();
  if (partnerIds.length > 0) {
    const records = await client.read<PartnerRecord>("res.partner", partnerIds, ["name", "email", "phone", "vat"]);
    for (const record of records) partners.set(record.id, await rememberPartner(ctx, record));
  }

  const references = read.map((entry) => text(entry.order.client_order_ref)).filter((ref): ref is string => ref !== null);
  const local = await db
    .select()
    .from(odooOrders)
    .where(
      references.length > 0
        ? or(inArray(odooOrders.odooId, ids), inArray(odooOrders.clientRef, references))
        : inArray(odooOrders.odooId, ids)
    );

  const productIds = [...new Set(read.flatMap((entry) => entry.lines.map((line) => m2oId(line.product_id))).filter((id): id is number => id !== null))];
  const skus = new Map<number, { id: string; sku: string | null }>();
  if (productIds.length > 0) {
    const rows = await db
      .select({ id: odooVariants.id, odooId: odooVariants.odooId, sku: odooVariants.sku })
      .from(odooVariants)
      .where(inArray(odooVariants.odooId, productIds));
    for (const row of rows) skus.set(row.odooId, { id: row.id, sku: row.sku });
  }

  for (const { order: record, lines } of read) {
    const status = statusOf(record.state);
    const currency = m2oName(record.currency_id);
    const partner = partners.get(m2oId(record.partner_id) ?? -1) ?? null;
    const mine = local.find((row) => row.odooId === record.id || row.clientRef === text(record.client_order_ref)) ?? null;
    const name = text(record.name) ?? `Order ${record.id}`;

    const orderLines = lines.map((line) => {
      const productId = m2oId(line.product_id);
      const known = productId !== null ? skus.get(productId) : undefined;
      return {
        name: text(line.name) ?? m2oName(line.product_id) ?? "",
        quantity: decimal(line.product_uom_qty) ?? "0.0000",
        unitPrice: decimal(line.price_unit) ?? "0.0000",
        subtotal: decimal(line.price_subtotal) ?? "0.0000",
        total: decimal(line.price_total) ?? "0.0000",
        odooProductId: productId,
        sku: known?.sku ?? null,
        variantId: known?.id ?? null,
      };
    });

    const amounts = {
      amountUntaxed: decimal(record.amount_untaxed),
      amountTax: decimal(record.amount_tax),
      amountTotal: decimal(record.amount_total),
      currency,
    };

    const before = mine?.status ?? null;
    if (mine) {
      await db
        .update(odooOrders)
        .set({
          ...amounts,
          // What the customer still pays: Odoo's total less the store credit, never below zero.
          // Fixed once paid: the bridge then puts the store credit on the order as a discount
          // line, Odoo's total drops by it, and subtracting it again would be wrong.
          amountDue: mine.paidAt
            ? mine.amountDue
            : amounts.amountTotal !== null
              ? Math.max(0, Number(amounts.amountTotal) - Number(mine.walletAmount)).toFixed(4)
              : mine.amountDue,
          odooId: record.id,
          odooName: name,
          // An order this kon let expire stays expired, whatever Odoo still calls it.
          status: mine.status === "expired" && status === "created" ? "expired" : status,
          partnerId: partner?.id ?? mine.partnerId,
          paymentUrl: paymentUrlOf(record, baseUrl),
          error: null,
          lines: orderLines.map((line) => ({
            odooProductId: line.odooProductId ?? 0,
            variantId: line.variantId,
            sku: line.sku,
            name: line.name,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
          })),
          updatedAt: new Date(),
        })
        .where(eq(odooOrders.id, mine.id));

      // Odoo counts its own reservation from here on; this kon's claim would count them twice.
      if (status === "confirmed" || status === "cancelled") await releaseHolds(ctx, db, [mine.id]);

      if (before === "pending") {
        ctx.events.emit("odoo:sale_order.created", {
          orderId: mine.id,
          clientRef: mine.clientRef,
          odooId: record.id,
          name,
          status,
          amountTotal: amounts.amountTotal,
          currency,
        });
      }
    }

    // For an order made here, only the step into the state is news. For one made elsewhere
    // there is no "before" to compare with, so it is announced on every notice and the
    // listener deduplicates on the Odoo id.
    if (status === "confirmed" && before !== "confirmed") {
      if (settings.currency && currency && currency !== settings.currency) {
        await reportConflict(db, "currency_mismatch", `sale.order:${record.id}`, {
          order: name,
          currency,
          company: settings.currency,
        });
      }
      ctx.events.emit("odoo:sale_order.confirmed", {
        odooId: record.id,
        name,
        orderId: mine?.id ?? null,
        clientRef: mine?.clientRef ?? null,
        date: text(record.date_order)?.slice(0, 10) ?? null,
        partner: partner
          ? { odooId: partner.odooId, name: partner.name, email: partner.email, vat: partner.vat }
          : null,
        lines: orderLines,
        ...amounts,
      });
    }
    if (status === "cancelled" && before !== "cancelled") {
      ctx.events.emit("odoo:sale_order.cancelled", { odooId: record.id, name, orderId: mine?.id ?? null });
    }
  }
}

// ── Payments ──────────────────────────────────────────────────────────────────

interface PaymentRecord {
  id: number;
  amount?: number;
  currency_id?: Many2one;
  partner_id?: Many2one;
  date?: string | false;
  state?: string;
  payment_type?: string;
  memo?: string | false;
  ref?: string | false;
  reconciled_invoice_ids?: number[];
}

/** States in which a payment is not money received: not yet posted, or undone. */
const NOT_RECEIVED = new Set(["draft", "cancel", "canceled", "cancelled", "rejected"]);

/** Reads these payments and announces the customer payments among them. */
export async function announcePayments(ctx: KonContext, client: OdooClient, paymentIds: number[]): Promise<void> {
  const ids = [...new Set(paymentIds)];
  if (ids.length === 0) return;
  const db = dbOf(ctx);
  const { capabilities } = await capabilitiesOf(db, client);
  const fields = capabilities.fields["account.payment"];
  if (!capabilities.payments || !fields) return;

  const payments = await client.searchRead<PaymentRecord>("account.payment", { domain: [["id", "in", ids]], fields });
  for (const payment of payments) {
    if (payment.payment_type !== undefined && payment.payment_type !== "inbound") continue;
    if (payment.state !== undefined && NOT_RECEIVED.has(payment.state)) continue;

    // Payment → the invoices it settled → the sales orders those came from, by their number.
    const orders: Array<{ odooId: number; name: string }> = [];
    const invoiceIds = payment.reconciled_invoice_ids ?? [];
    if (invoiceIds.length > 0) {
      const invoices = await client.read<{ id: number; invoice_origin?: string | false }>("account.move", invoiceIds, [
        "invoice_origin",
      ]);
      const names = [
        ...new Set(
          invoices
            .flatMap((invoice) => (text(invoice.invoice_origin) ?? "").split(","))
            .map((name) => name.trim())
            .filter(Boolean)
        ),
      ];
      if (names.length > 0) {
        const found = await client.searchRead<{ id: number; name: string }>("sale.order", {
          domain: [["name", "in", names]],
          fields: ["name"],
        });
        for (const order of found) orders.push({ odooId: order.id, name: order.name });
      }
    }
    // A payment the bridge recorded before the order could be invoiced (invoicing on delivered
    // quantities) is reconciled with no invoice yet: its memo starts with the order's number.
    if (orders.length === 0) {
      const first = (text(payment.memo) ?? text(payment.ref) ?? "").trim().split(/\s+/)[0];
      if (first) {
        const found = await client.searchRead<{ id: number; name: string }>("sale.order", {
          domain: [["name", "=", first]],
          fields: ["name"],
          limit: 1,
        });
        for (const order of found) orders.push({ odooId: order.id, name: order.name });
      }
    }

    let partner: OdooPartner | null = null;
    const partnerId = m2oId(payment.partner_id);
    if (partnerId !== null) {
      const [record] = await client.read<PartnerRecord>("res.partner", [partnerId], ["name", "email", "phone", "vat"]);
      if (record) partner = await rememberPartner(ctx, record);
    }

    ctx.events.emit("odoo:payment.received", {
      paymentId: payment.id,
      amount: decimal(payment.amount) ?? "0.0000",
      currency: m2oName(payment.currency_id),
      date: text(payment.date)?.slice(0, 10) ?? null,
      reference: text(payment.memo) ?? text(payment.ref),
      partner: partner
        ? { odooId: partner.odooId, name: partner.name, email: partner.email, vat: partner.vat }
        : null,
      orders,
    });
  }
}

// ── Store credit ──────────────────────────────────────────────────────────────

export interface Wallet {
  balance: string;
  currency: string | null;
  cards: Array<{ id: number; balance: string; expiresOn: string | null }>;
}

/**
 * A customer's eWallet balance. The card codes are never read: a code spends the balance, and
 * nothing here needs it.
 */
export async function walletOf(ctx: KonContext, client: OdooClient, email: string): Promise<Wallet | null> {
  const db = dbOf(ctx);
  const settings = await loadSettings(db);
  const { capabilities } = await capabilitiesOf(db, client, { settings });
  if (!capabilities.loyalty) throw AppError.conflict("This Odoo has no loyalty module: there is no store credit to read.");

  const [partner] = await client.searchRead<{ id: number }>("res.partner", {
    domain: [["email", "=ilike", email.trim().toLowerCase()]],
    fields: ["id"],
    limit: 1,
    order: "id",
  });
  if (!partner) return null;

  const cards = await client.searchRead<{ id: number; points?: number; expiration_date?: string | false }>(
    "loyalty.card",
    {
      domain: [
        ["partner_id", "=", partner.id],
        ["program_id.program_type", "=", "ewallet"],
      ],
      fields: ["points", "expiration_date"],
    }
  );
  const today = new Date().toISOString().slice(0, 10);
  const usable = cards.filter((card) => !card.expiration_date || card.expiration_date >= today);
  const total = usable.reduce((sum, card) => sum + (card.points ?? 0), 0);
  return {
    balance: total.toFixed(4),
    currency: settings.currency,
    cards: usable.map((card) => ({
      id: card.id,
      balance: (card.points ?? 0).toFixed(4),
      expiresOn: text(card.expiration_date),
    })),
  };
}

// ── Products made on demand ───────────────────────────────────────────────────

export interface ProvisionRequest {
  sku: string;
  name: string;
  price: number;
  barcode?: string;
  categoryOdooId?: number;
}

/**
 * Makes sure Odoo has a product with this internal reference, creating it if it does not.
 * This is how a large catalog stays out of Odoo until an item is actually stocked: the product
 * is created the day there is one to sell. Answers the template's id.
 */
export async function provisionProduct(client: OdooClient, request: ProvisionRequest): Promise<number> {
  const [existing] = await client.searchRead<{ id: number; product_tmpl_id?: Many2one }>("product.product", {
    domain: [["default_code", "=", request.sku]],
    fields: ["product_tmpl_id"],
    limit: 1,
    order: "id",
    context: { active_test: false },
  });
  const template = m2oId(existing?.product_tmpl_id);
  if (template !== null) return template;

  return client.create("product.template", {
    name: request.name,
    default_code: request.sku,
    list_price: request.price,
    sale_ok: true,
    ...(request.barcode ? { barcode: request.barcode } : {}),
    ...(request.categoryOdooId ? { categ_id: request.categoryOdooId } : {}),
  });
}

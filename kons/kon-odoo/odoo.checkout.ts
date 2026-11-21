/**
 * Odoo — carts, paying an order, and what happens when nobody pays
 * ============================================================================
 *
 *   cart ── checkout ──▶ order (pending) + holds ──queue──▶ Odoo quotation, total, `amountDue`
 *                                                                  │
 *   shop backend ── POST /api/payments/orders/checkout (metadata.odooOrderId, amountDue) ──▶ pay
 *                                                                  │
 *   kon-payments ── payment:payment.succeeded ──▶ here: amount checked, order marked paid
 *                                                                  │
 *                                                 queue "settle" ──▶ Odoo confirms the order
 *                                                 (with the bridge: and records the payment and
 *                                                  takes the store credit, in one transaction)
 *
 * kon-payments is not imported. It announces payments on the event bus, and the metadata this
 * kon asked the shop to put on the payment (`odooOrderId`) says which order it was for. The amount
 * in the event is compared with what the order owes before anything is believed.
 *
 * An unpaid order whose holds run out expires: its units go back on sale and Odoo is asked to
 * cancel the quotation. A payment that arrives after that is kept as a conflict for a person:
 * the money was taken, and the units may be gone.
 */

import { AppError, queue } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { OdooError, type OdooClient } from "./odoo.client";
import { BRIDGE_MODEL } from "./odoo.connection";
import { extendHolds, placeHolds, releaseHolds } from "./odoo.holds";
import { reportConflict, type OdooDb } from "./odoo.mirror";
import { refreshOrders, takeOrder, type OrderRequest } from "./odoo.orders";
import {
  odooCartLines,
  odooCarts,
  odooHolds,
  odooOrders,
  odooProducts,
  odooVariants,
  type OdooOrder,
} from "./odoo.schema";
import { capabilitiesOf, dbOf, QUEUES } from "./odoo.state";

const asSystemOf = (ctx: KonContext) => ctx.db.asSystem ?? (<T>(fn: () => Promise<T>) => fn());

// ── Carts ─────────────────────────────────────────────────────────────────────

export interface CartLineView {
  variantId: string;
  productSlug: string;
  name: string;
  sku: string | null;
  options: Record<string, string>;
  quantity: string;
  unitPrice: string | null;
  subtotal: string | null;
  currency: string | null;
  /** Units that can be bought now: Odoo's free quantity less what is held. Null when not counted */
  available: string | null;
  /** The line can be ordered as it is */
  orderable: boolean;
}

export interface CartView {
  id: string;
  orderId: string | null;
  lines: CartLineView[];
  /** Before tax, from the mirror's prices. Odoo computes the order's real total */
  estimatedTotal: string;
  currency: string | null;
  orderable: boolean;
  updatedAt: string;
}

export async function createCart(db: OdooDb): Promise<CartView> {
  const [cart] = await db.insert(odooCarts).values({}).returning();
  return viewCart(db, cart.id) as Promise<CartView>;
}

export async function viewCart(db: OdooDb, cartId: string): Promise<CartView | null> {
  const [cart] = await db.select().from(odooCarts).where(eq(odooCarts.id, cartId)).limit(1);
  if (!cart) return null;
  const rows = await db
    .select({ line: odooCartLines, variant: odooVariants, product: odooProducts })
    .from(odooCartLines)
    .innerJoin(odooVariants, eq(odooVariants.id, odooCartLines.variantId))
    .innerJoin(odooProducts, eq(odooProducts.id, odooVariants.productId))
    .where(eq(odooCartLines.cartId, cartId))
    .orderBy(asc(odooCartLines.addedAt));

  let total = 0;
  let currency: string | null = null;
  const lines = rows.map(({ line, variant, product }) => {
    const available = variant.qtyFree === null ? null : Math.max(0, Number(variant.qtyFree) - Number(variant.qtyHeld));
    const quantity = Number(line.quantity);
    const price = variant.price === null ? null : Number(variant.price);
    const forSale = variant.active && variant.visible && product.published && product.active;
    if (price !== null) total += price * quantity;
    currency ??= product.currency;
    return {
      variantId: variant.id,
      productSlug: product.slug,
      name: product.name,
      sku: variant.sku,
      options: variant.options,
      quantity: quantity.toFixed(4),
      unitPrice: variant.price,
      subtotal: price === null ? null : (price * quantity).toFixed(4),
      currency: product.currency,
      available: available === null ? null : available.toFixed(4),
      orderable: forSale && (available === null || available >= quantity),
    };
  });
  return {
    id: cart.id,
    orderId: cart.orderId,
    lines,
    estimatedTotal: total.toFixed(4),
    currency,
    orderable: lines.length > 0 && lines.every((line) => line.orderable) && cart.orderId === null,
    updatedAt: cart.updatedAt.toISOString(),
  };
}

/** Sets how many of a variant the cart has; zero takes it out. A cart that became an order is closed. */
export async function setCartLine(
  db: OdooDb,
  cartId: string,
  line: { variantId?: string; sku?: string; quantity: number }
): Promise<CartView | null> {
  const [cart] = await db.select().from(odooCarts).where(eq(odooCarts.id, cartId)).limit(1);
  if (!cart) return null;
  if (cart.orderId) throw AppError.conflict("This cart is already an order.");

  const where = line.variantId ? eq(odooVariants.id, line.variantId) : line.sku ? eq(odooVariants.sku, line.sku) : null;
  if (!where) throw AppError.validation("Name the variant: variantId or sku.");
  const found = await db
    .select({ id: odooVariants.id })
    .from(odooVariants)
    .where(and(where, eq(odooVariants.active, true), eq(odooVariants.visible, true)))
    .limit(2);
  if (found.length === 0) throw AppError.validation("That variant is not for sale.");
  if (found.length > 1) throw AppError.validation(`Reference "${line.sku}" names more than one variant.`);
  const variantId = found[0].id;

  if (line.quantity <= 0) {
    await db.delete(odooCartLines).where(and(eq(odooCartLines.cartId, cartId), eq(odooCartLines.variantId, variantId)));
  } else {
    const quantity = line.quantity.toFixed(4);
    await db
      .insert(odooCartLines)
      .values({ cartId, variantId, quantity })
      .onConflictDoUpdate({ target: [odooCartLines.cartId, odooCartLines.variantId], set: { quantity } });
  }
  await db.update(odooCarts).set({ updatedAt: new Date() }).where(eq(odooCarts.id, cartId));
  return viewCart(db, cartId);
}

/**
 * Turns a cart into an order, holding its units. The same `clientRef` twice answers the same
 * order. A line that cannot be held answers 409 and nothing is ordered.
 */
export async function checkoutCart(
  ctx: KonContext,
  cartId: string,
  request: Omit<OrderRequest, "lines">,
  createdBy: string | null
): Promise<{ order: OdooOrder; created: boolean } | null> {
  const db = dbOf(ctx);
  const [cart] = await db.select().from(odooCarts).where(eq(odooCarts.id, cartId)).limit(1);
  if (!cart) return null;
  if (cart.orderId) {
    const [order] = await db.select().from(odooOrders).where(eq(odooOrders.id, cart.orderId)).limit(1);
    if (order && order.clientRef === request.clientRef) return { order, created: false };
    throw AppError.conflict("This cart is already an order.");
  }
  const lines = await db.select().from(odooCartLines).where(eq(odooCartLines.cartId, cartId));
  if (lines.length === 0) throw AppError.validation("The cart is empty.");

  const result = await takeOrder(
    ctx,
    { ...request, lines: lines.map((line) => ({ variantId: line.variantId, quantity: Number(line.quantity) })) },
    createdBy
  );
  await db.update(odooCarts).set({ orderId: result.order.id, updatedAt: new Date() }).where(eq(odooCarts.id, cartId));
  return result;
}

// ── A payment arrives ─────────────────────────────────────────────────────────

/** The part of kon-payments' event this kon reads. Structural: no import of that kon. */
interface PaymentAnnouncement {
  provider?: string;
  event?: {
    type?: string;
    provider?: string;
    externalId?: string;
    paymentId?: string;
    settled?: boolean;
    money?: { amount?: number; currency?: string };
    metadata?: Record<string, string>;
  };
}

export type PaymentOutcome =
  | { status: "paid"; orderId: string }
  | { status: "exists"; orderId: string }
  | { status: "refused"; orderId: string; reason: string }
  | { status: "skipped"; reason: string };

/** How long a paid order keeps its units while Odoo is asked to confirm it. */
const PAID_HOLD_MS = 24 * 60 * 60 * 1000;

/**
 * A payment for an order of this kon. Idempotent: an order is paid once, and the same payment
 * twice is the same payment (a unique index says so). Runs as the system.
 */
export async function applyOrderPayment(ctx: KonContext, db: OdooDb, payload: unknown): Promise<PaymentOutcome> {
  const announcement = (payload ?? {}) as PaymentAnnouncement;
  const event = announcement.event;
  const orderId = event?.metadata?.odooOrderId;
  if (!event || typeof orderId !== "string" || !/^[0-9a-f-]{36}$/i.test(orderId)) {
    return { status: "skipped", reason: "not a payment for an Odoo order" };
  }
  // Money that is not in yet (a bank debit that has not cleared) pays nothing.
  if (event.settled !== true) return { status: "skipped", reason: "the money is not in yet" };

  const [order] = await db.select().from(odooOrders).where(eq(odooOrders.id, orderId)).limit(1);
  if (!order) return { status: "skipped", reason: `no order ${orderId}` };
  if (order.paidAt) return { status: "exists", orderId };

  const provider = String(event.provider ?? announcement.provider ?? "unknown").slice(0, 32);
  const reference = String(event.paymentId ?? event.externalId ?? "").slice(0, 191);
  const cents = event.money?.amount;
  const currency = String(event.money?.currency ?? "").toUpperCase();
  const due = order.amountDue === null ? null : Math.round(Number(order.amountDue) * 100);

  const refuse = async (reason: string) => {
    await reportConflict(db, "payment_mismatch", `order:${order.id}`, {
      order: order.odooName ?? order.clientRef,
      provider,
      reference,
      paid: cents ?? null,
      currency,
      due,
      dueCurrency: order.currency,
      reason,
    });
    ctx.events.emit("odoo:payment.mismatch", { orderId: order.id, provider, reference, reason });
    return { status: "refused" as const, orderId, reason };
  };

  if (due === null) return refuse("the order had no total from Odoo yet when it was paid");
  if (typeof cents !== "number" || cents !== due) return refuse(`paid ${cents ?? "nothing"} cents, the order owes ${due}`);
  if (order.currency && currency !== order.currency) return refuse(`paid in ${currency}, the order is in ${order.currency}`);

  const now = new Date();
  await db
    .update(odooOrders)
    .set({
      paidAt: now,
      paidAmount: (cents / 100).toFixed(4),
      paymentProvider: provider,
      paymentRef: reference || null,
      updatedAt: now,
    })
    .where(eq(odooOrders.id, order.id));

  // The units must still be held. An order that expired before the money arrived tries to take
  // them again; if they are gone, a person decides (a refund, a substitute).
  const [active] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(odooHolds)
    .where(and(eq(odooHolds.orderId, order.id), isNull(odooHolds.releasedAt)));
  const needsHolds = (active?.count ?? 0) === 0 && order.status !== "confirmed";
  if (needsHolds) {
    try {
      await placeHolds(
        ctx,
        db,
        order.id,
        order.lines
          .filter((line) => line.variantId)
          .map((line) => ({ variantId: line.variantId as string, quantity: Number(line.quantity), name: line.name })),
        new Date(now.getTime() + PAID_HOLD_MS)
      );
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await reportConflict(db, "paid_unavailable", `order:${order.id}`, {
        order: order.odooName ?? order.clientRef,
        provider,
        reference,
        reason: error.message,
      });
      ctx.events.emit("odoo:order.paid_unavailable", { orderId: order.id, provider, reference, reason: error.message });
      return { status: "refused", orderId, reason: error.message };
    }
  } else {
    await extendHolds(ctx, db, order.id, new Date(now.getTime() + PAID_HOLD_MS));
  }
  if (order.status === "expired") {
    await db.update(odooOrders).set({ status: order.odooId ? "created" : "pending" }).where(eq(odooOrders.id, order.id));
  }

  ctx.events.emit("odoo:order.paid", { orderId: order.id, provider, reference, amount: (cents / 100).toFixed(4), currency });
  await queue.dispatch(QUEUES.push, "settle", { orderId: order.id }, { dedupeKey: `settle:${order.id}`, attempts: 8 });
  return { status: "paid", orderId };
}

const listening = new WeakSet<object>();

/**
 * Subscribes once per event bus to kon-payments' announcements. Without kon-payments it sits idle.
 * A failure is logged and dropped: kon-payments must not break because this kon could not record.
 */
export function listenToPayments(ctx: KonContext): void {
  if (!ctx.events?.on || listening.has(ctx.events)) return;
  listening.add(ctx.events);
  ctx.events.on("payment:payment.succeeded", (payload: unknown) => {
    const run = () =>
      asSystemOf(ctx)(() => (ctx.db.instance as OdooDb).transaction((tx) => applyOrderPayment(ctx, tx as OdooDb, payload)))
        .then((outcome) => {
          if (outcome.status === "refused") ctx.logger.warn(`kon-odoo: payment not applied: ${outcome.reason}`);
        })
        .catch((error: unknown) =>
          ctx.logger.error("kon-odoo: a payment could not be recorded", {
            error: error instanceof Error ? error.message : String(error),
          })
        );
    void (ctx.db.background ? ctx.db.background(run) : run());
  });
}

// ── Settling a paid order in Odoo ─────────────────────────────────────────────

/**
 * Asks Odoo to confirm a paid order. With the bridge module, one call does it all in one Odoo
 * transaction: confirms the order, records the payment, takes the store credit. Without it, the
 * order is confirmed with `action_confirm` and the payment stays in kon-payments: Odoo has no
 * record of the money.
 */
export async function settleOrder(ctx: KonContext, client: OdooClient, orderId: string, baseUrl: string | null): Promise<void> {
  const db = dbOf(ctx);
  const [order] = await db.select().from(odooOrders).where(eq(odooOrders.id, orderId)).limit(1);
  if (!order || !order.paidAt || order.settledAt) return;
  // Odoo has not answered for the order yet: the queue tries again later.
  if (order.odooId === null) throw new Error(`order ${order.id} is not in Odoo yet`);

  const { capabilities } = await capabilitiesOf(db, client);
  try {
    if (capabilities.bridge) {
      await client.call(BRIDGE_MODEL, "confirm_payment", {
        order_id: order.odooId,
        client_ref: order.clientRef,
        amount: order.paidAmount,
        provider: order.paymentProvider,
        reference: order.paymentRef,
        wallet_amount: order.walletAmount,
      });
    } else {
      await client.call("sale.order", "action_confirm", {}, { ids: [order.odooId] });
    }
  } catch (error) {
    if (error instanceof OdooError && !error.retryable && error.kind !== "auth") {
      await reportConflict(db, "settle_failed", `order:${order.id}`, {
        order: order.odooName ?? order.clientRef,
        reason: error.message,
      });
      ctx.events.emit("odoo:order.settle_failed", { orderId: order.id, reason: error.message });
      return;
    }
    throw error;
  }
  await db.update(odooOrders).set({ settledAt: new Date(), updatedAt: new Date() }).where(eq(odooOrders.id, order.id));
  // Read back: the order is confirmed now, its holds go, and the books hear of it.
  await refreshOrders(ctx, client, [order.odooId], baseUrl);
}

// ── Nobody paid ───────────────────────────────────────────────────────────────

/** Orders whose holds ran out unpaid: expired, units back on sale, Odoo asked to cancel. */
export async function expireUnpaid(ctx: KonContext, now = new Date()): Promise<number> {
  const db = dbOf(ctx);
  const expired = await db
    .update(odooOrders)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        isNull(odooOrders.paidAt),
        inArray(odooOrders.status, ["pending", "created"]),
        lt(odooOrders.holdExpiresAt, now)
      )
    )
    .returning({ id: odooOrders.id, odooId: odooOrders.odooId, clientRef: odooOrders.clientRef });
  if (expired.length === 0) return 0;

  await releaseHolds(ctx, db, expired.map((order) => order.id));
  for (const order of expired) {
    ctx.events.emit("odoo:order.expired", { orderId: order.id, clientRef: order.clientRef, odooId: order.odooId });
    if (order.odooId !== null) {
      await queue.dispatch(QUEUES.push, "cancel", { orderId: order.id }, { dedupeKey: `cancel:${order.id}`, attempts: 5 });
    }
  }
  return expired.length;
}

/** Asks Odoo to cancel the quotation of an order that expired, unless it was paid since. */
export async function cancelInOdoo(ctx: KonContext, client: OdooClient, orderId: string): Promise<void> {
  const db = dbOf(ctx);
  const [order] = await db.select().from(odooOrders).where(eq(odooOrders.id, orderId)).limit(1);
  if (!order || order.paidAt || order.status !== "expired" || order.odooId === null) return;
  await client.call("sale.order", "action_cancel", {}, { ids: [order.odooId] });
}

/** Carts nobody touched for this long, and that never became an order, are deleted. */
const CART_DAYS = 30;

export async function forgetCarts(ctx: KonContext, now = new Date()): Promise<void> {
  await asSystemOf(ctx)(() =>
    dbOf(ctx)
      .delete(odooCarts)
      .where(and(isNull(odooCarts.orderId), lt(odooCarts.updatedAt, new Date(now.getTime() - CART_DAYS * 86_400_000))))
  );
}


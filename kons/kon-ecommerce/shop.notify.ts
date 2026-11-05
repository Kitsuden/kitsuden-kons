/**
 * Telling the buyer, and the rest of the system, that an order moved
 * ============================================================================
 *
 * Builds each email's data from the order (inside the request or the webhook, while the database
 * is at hand) and sends it WITHOUT waiting: a slow mail server must not slow down, or break, a
 * purchase or a status change. It also emits the `shop:*` events, so a CRM, a chat or a webhook
 * can react without the shop knowing about them.
 */

import { mail } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { asc, eq } from "drizzle-orm";

import { issueLink, STATUS_LINK_DAYS } from "./shop.access";
import { entitlementsOf } from "./shop.delivery";
import {
  money,
  orderPageUrl,
  registerShopMails,
  shopMailsActive,
  STATUSES_WITH_MAIL,
  type OrderMailData,
} from "./shop.mails";
import { PAID_STATUSES } from "./shop.payments";
import { shopOrderItems, type ShopOrder } from "./shop.schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a Drizzle instance or transaction
type Db = any;

/** The address the buyer sees: the panel's public site, else the configured one. */
export async function publicSite(ctx: KonContext): Promise<string> {
  try {
    const url = await ctx.site?.publicUrl();
    if (url) return url;
  } catch {
    /* without a panel setting, the configured URL */
  }
  return ctx.config.siteUrl || process.env.SITE_URL || "http://localhost:4321";
}

async function mailData(db: Db, order: ShopOrder, orderUrl: string): Promise<OrderMailData> {
  const lines = (await db
    .select()
    .from(shopOrderItems)
    .where(eq(shopOrderItems.orderId, order.id))
    .orderBy(asc(shopOrderItems.createdAt))) as Array<{
    productName: string;
    variantName: string | null;
    quantity: number;
    subtotalCents: number;
  }>;
  const entitlements = await entitlementsOf(db, order.id);
  return {
    to: order.customerEmail,
    number: order.number,
    name: order.customerName,
    orderUrl,
    lines: lines.map((l) => ({
      name:
        l.variantName && l.variantName !== "Standard"
          ? `${l.productName} (${l.variantName})`
          : l.productName,
      quantity: l.quantity,
      amount: money(l.subtotalCents, order.currency),
    })),
    total: money(order.totalCents, order.currency),
    discount: order.discountCents > 0 ? money(order.discountCents, order.currency) : null,
    fulfillmentType: order.fulfillmentType,
    pickupNote: order.pickupNote,
    licenseKeys: entitlements
      .filter((e) => e.kind === "license" && e.licenseKey)
      .map((e) => e.licenseKey as string),
    hasDownloads: entitlements.some((e) => e.kind === "download" && !e.revoked),
    status: order.status,
    trackingNumber: order.trackingNumber,
    trackingUrl: order.trackingUrl,
  };
}

function sendLater(ctx: KonContext, name: string, data: OrderMailData): void {
  if (!shopMailsActive()) return;
  registerShopMails();
  void mail
    .send(name, data)
    .then((r) => {
      if (!r.ok)
        ctx.logger.error("[shop] email was not sent", { mail: name, err: String(r.error) });
    })
    .catch((err) =>
      ctx.logger.error("[shop] failure sending an email", { mail: name, err: String(err) })
    );
}

/**
 * Runs the database part of a notice as the SYSTEM and in its own savepoint: a notice that fails
 * (an agent's identity that may not write links, a missing table) must not abort the transaction
 * of the change it reports.
 */
async function quietly<T>(ctx: KonContext, db: Db, fn: (db: Db) => Promise<T>): Promise<T | null> {
  const asSystem = ctx.db.asSystem ?? (<R>(f: () => Promise<R>) => f());
  try {
    return await asSystem(() => (db.transaction ? db.transaction((tx: Db) => fn(tx)) : fn(db)));
  } catch (err) {
    ctx.logger.warn("[shop] could not prepare a notice", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Right after buying: the email carries the order's own token, the only time it is known. */
export async function notifyReceived(
  ctx: KonContext,
  db: Db,
  order: ShopOrder,
  token: string
): Promise<void> {
  ctx.events.emit("shop:order.created", {
    orderId: order.id,
    number: order.number,
    totalCents: order.totalCents,
  });
  const site = await publicSite(ctx);
  const data = await quietly(ctx, db, (tx) =>
    mailData(tx, order, orderPageUrl(site, order.id, token))
  );
  if (data) sendLater(ctx, "shop.order-received", data);
}

/**
 * After a status change. Later emails cannot carry the order token (only its hash is kept), so
 * they carry a fresh "my orders" link for the order's own email, valid for a week.
 */
export async function notifyStatus(
  ctx: KonContext,
  db: Db,
  order: ShopOrder,
  from: string
): Promise<void> {
  ctx.events.emit("shop:order.status-changed", {
    orderId: order.id,
    number: order.number,
    from,
    to: order.status,
  });
  // Paid just now: it came from unpaid (pending, or cancelled and reopened by a late payment).
  const paidNow = (from === "pending" || from === "cancelled") && PAID_STATUSES.has(order.status);
  if (paidNow) ctx.events.emit("shop:order.paid", { orderId: order.id, number: order.number });

  const mailName = paidNow
    ? "shop.order-paid"
    : STATUSES_WITH_MAIL.has(order.status)
      ? "shop.order-status"
      : null;
  if (!mailName) return;

  const site = await publicSite(ctx);
  const data = await quietly(ctx, db, async (tx) => {
    const token = await issueLink(tx, order.customerEmail, new Date(), {
      throttle: false,
      minutes: STATUS_LINK_DAYS * 24 * 60,
    });
    return token ? mailData(tx, order, orderPageUrl(site, order.id, token)) : null;
  });
  if (data) sendLater(ctx, mailName, data);
}

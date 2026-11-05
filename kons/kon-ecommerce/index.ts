/**
 * kon-ecommerce — store for digital products and made-to-order items.
 *
 * Deliberately does NOT include: persistent cart, per-carrier rates,
 * warehouse management or per-jurisdiction taxes. That is Shopify.
 *
 * To sell digital goods internationally, charge through Lemon Squeezy or
 * Paddle from `kon-payments`: they are *merchant of record* and take on European
 * VAT, which is the really hard part of selling bits outside your country.
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonContext, KonDefinition } from "@kitsuden/shared";

import { KON_ID } from "./operations";
import { registerShopMails } from "./shop.mails";
import { notifyStatus } from "./shop.notify";
import { onPaymentRefunded, onPaymentSucceeded, type PaymentEventLike } from "./shop.payments";
import { shopOperations } from "./shop.routes";

export {
  shopProducts,
  shopVariants,
  shopOrders,
  shopOrderItems,
  shopProductKind,
  shopOrderStatus,
  shopFulfillmentType,
} from "./shop.schema";

export type { ShopProduct, ShopVariant, ShopOrder, ShopOrderItem } from "./shop.schema";

export {
  validateCompliance,
  freezeLines,
  calculateTotals,
  orderNumber,
  deductStock,
  restoreStock,
  restockOrder,
  releaseExpiredReservations,
  reserveStock,
  canTransition,
  statusAfterPayment,
  TRANSITIONS,
} from "./shop.orders";

export type {
  FulfillmentType,
  OrderLine,
  VariantLike,
  OrderData,
  FrozenLine,
} from "./shop.orders";

// Importing registers the policies (deny-by-default).
import "./shop.policy";
export { registerShopPolicies } from "./shop.policy";
export type { ProductResource, OrderResource } from "./shop.policy";

export { createOrder, idempotencyFingerprint } from "./shop.service";
export type { OrderResult } from "./shop.service";

export { createShopRouter, shopOperations } from "./shop.routes";
export type { ShopDependencies } from "./shop.routes";

export { computeDiscount, claimPromotion, releasePromotion, promotionByCode } from "./shop.promotions";
export type { PromotionLike, DiscountResult } from "./shop.promotions";
export { grantEntitlements, revokeEntitlements, entitlementsOf, takeDownload, generateLicenseKey } from "./shop.delivery";
export {
  applyStatus,
  onPaymentSucceeded,
  onPaymentRefunded,
  loadPaymentGateway,
  PAID_STATUSES,
} from "./shop.payments";
export type { PaymentEventLike, PaymentHandling, ShopPaymentGateway } from "./shop.payments";
export { newToken, hashToken, tokenOpensOrder, issueLink, emailOfLink } from "./shop.access";
export { registerShopMails, shopTranslations } from "./shop.mails";
export {
  shopProductFiles,
  shopLicenseKeys,
  shopEntitlements,
  shopPromotions,
  shopOrderLinks,
} from "./shop.schema";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));
export type { ShopProductFile, ShopEntitlement, ShopPromotion, LicenseMode } from "./shop.schema";

/**
 * Listens to kon-payments: a payment the shop opened marks its order paid (and delivers it), a
 * refund marks it refunded (and revokes the downloads). Outside any request, with the system
 * connection: the webhook's transaction is already committed when kon events are delivered.
 *
 * Once per event bus: a kon reactivated without restarting runs `onStartup` again, and a second
 * listener would apply every payment twice (harmless, it is idempotent, but noisy).
 */
const listening = new WeakSet<object>();

function listenToPayments(ctx: KonContext): void {
  if (listening.has(ctx.events)) return;
  listening.add(ctx.events);
  const handle =
    (kind: "succeeded" | "refunded") =>
    (data: unknown): void => {
      const event = (data as { event?: PaymentEventLike } | null)?.event;
      if (!event) return;
      const run = async () => {
        const db = ctx.db.instance;
        try {
          const r =
            kind === "succeeded" ? await onPaymentSucceeded(db, event) : await onPaymentRefunded(db, event);
          if ((r.outcome === "paid" || r.outcome === "refunded") && r.order && r.from) {
            ctx.logger.info("[shop] order moved by a payment", { number: r.order.number, to: r.order.status });
            if (r.delivery?.keysMissing) {
              ctx.logger.warn("[shop] paid order is short of license keys", {
                number: r.order.number,
                missing: r.delivery.keysMissing,
              });
            }
            await notifyStatus(ctx, db, r.order, r.from);
          } else if (r.outcome === "mismatch" && r.order) {
            ctx.logger.error("[shop] a payment does not match its order: left pending", {
              number: r.order.number,
              expected: r.order.totalCents,
              got: event.money?.amount,
            });
            ctx.events.emit("shop:order.payment-mismatch", {
              orderId: r.order.id,
              number: r.order.number,
              provider: event.provider,
              money: event.money ?? null,
            });
          } else if (r.outcome === "paid-but-unavailable" && r.order) {
            ctx.logger.error("[shop] an order was paid after its units were sold: refund it", {
              number: r.order.number,
            });
            ctx.events.emit("shop:order.paid-but-unavailable", { orderId: r.order.id, number: r.order.number });
          } else if (r.outcome === "partial-refund" && r.order) {
            ctx.events.emit("shop:order.partially-refunded", { orderId: r.order.id, number: r.order.number });
          } else if (r.outcome === "refund-unapplied" && r.order) {
            ctx.logger.warn("[shop] refunded at the provider, but the order cannot be marked refunded", {
              number: r.order.number,
              status: r.order.status,
            });
            ctx.events.emit("shop:order.refunded-at-provider", {
              orderId: r.order.id,
              number: r.order.number,
              status: r.order.status,
            });
          }
        } catch (err) {
          ctx.logger.error("[shop] could not apply a payment event", {
            provider: event.provider,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };
      void (ctx.db.background ? ctx.db.background(run) : run());
    };
  ctx.events.on("payment:payment.succeeded", handle("succeeded"));
  ctx.events.on("payment:payment.refunded", handle("refunded"));
}

/**
 * Kon definition.
 *
 * Without this the loader finds nothing to mount: it looks for `mod.kon` or
 * `mod.default`, and if there is none — no loose router, no `init*` —
 * it registers the kon as failed. Exporting tables and functions turns this
 * folder into a library, not an installable kon.
 *
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`shopOperations`), with its OpenAPI, its MCP tool and its fine-grained scope
 * `kon:ecommerce:<id>`. The router is generated by `defineKonSdk`.
 */
export const kon: KonDefinition = defineKonSdk({
  id: KON_ID,
  name: "Shop",
  version: manifest.version,
  description:
    "Sale of digital products and made-to-order items: catalog, orders, finite stock, local pickup, online payment, downloads and license keys, discount codes and order emails.",
  icon: "ShoppingBag",

  mountPath: "/api/shop",
  operations: (ctx: KonContext) => shopOperations(ctx),

  // Buying is anonymous and reserves stock. Without a brake, a loop of unpaid
  // orders holds stock (it expires after `reservationMinutes`, but meanwhile
  // the item cannot be sold). fail-closed: without a counter, better to reject.
  rateLimits: [
    {
      path: "/orders",
      limit: 10,
      window: 60,
      message: "Too many orders in a row. Wait a minute.",
      failClosed: true,
    },
    // Each one opens a payment at the provider, which costs a call and may cost a fee.
    {
      path: "/orders/:id/checkout",
      limit: 10,
      window: 60,
      message: "Too many payment attempts in a row. Wait a minute.",
      failClosed: true,
    },
    // Each one can send an email: without a brake it is a way to mail-bomb someone.
    {
      path: "/my-orders/link",
      limit: 5,
      window: 60,
      message: "Too many requests in a row. Wait a minute.",
      failClosed: true,
    },
  ],

  hooks: {
    onStartup: async (ctx: KonContext) => {
      registerShopMails();
      listenToPayments(ctx);
    },
  },

  // kon.json `admin` is the one list of admin views; the definition copies it.
  admin: {
    category: manifest.admin.category as "content",
    views: manifest.admin.views.map((v) => ({
      id: v.id,
      type: v.type as "grid",
      title: v.title,
      table: v.table,
    })),
  },

  tables: konTables,

  dependencies: {
    kons: ["kon-media"],
    core: ["auth"],
  },
});

export default kon;

/**
 * Discount codes
 * ============================================================================
 *
 * Shaped after Medusa's promotions (MIT, github.com/medusajs/medusa): a promotion has an
 * APPLICATION — what is taken off (`percentage` or `fixed`) and from what (`order` lines or
 * `shipping`) — and RULES that decide whether it applies (dates, minimum, products, uses). The
 * computation is a pure function, so the order and its tests agree on every cent.
 *
 * ── THREE DECISIONS ────────────────────────────────────────────────────────
 *
 * 1. The discount is computed by the SERVER from the frozen lines, like the prices. The buyer
 *    sends a code, never an amount.
 * 2. A use is CLAIMED inside the order's transaction with a conditional UPDATE, like the stock:
 *    two buyers on the last use of a code cannot both get it.
 * 3. Cancelling an order (by hand or because nobody paid it in time) gives the use back. A refund
 *    does not: the code was used.
 */

import { sql } from "drizzle-orm";

import type { Executor, FrozenLine } from "./shop.orders";

export interface PromotionLike {
  id: string;
  code: string;
  active: boolean;
  applicationType: "percentage" | "fixed";
  applicationTarget: "order" | "shipping";
  value: number;
  currency: string | null;
  minSubtotalCents: number | null;
  productIds: string[] | null;
  startsAt: Date | string | null;
  endsAt: Date | string | null;
  usageLimit: number | null;
  usageCount: number;
}

export type DiscountResult =
  | {
      ok: true;
      orderDiscountCents: number;
      shippingDiscountCents: number;
      totalDiscountCents: number;
    }
  | { ok: false; problem: string };

/** The answer for a code that does not exist or is switched off: the same for both. */
export const INVALID_CODE = "This discount code is not valid.";

const time = (d: Date | string | null): number | null =>
  d === null ? null : (d instanceof Date ? d : new Date(d)).getTime();

/**
 * What a promotion takes off this order, or why it does not apply.
 *
 * `lines` are the FROZEN lines (prices already copied from the catalog), so the discount is
 * computed on what is being charged.
 */
export function computeDiscount(
  promo: PromotionLike | null,
  lines: FrozenLine[],
  currency: string,
  shippingCents: number,
  now: Date = new Date()
): DiscountResult {
  if (!promo || !promo.active) return { ok: false, problem: INVALID_CODE };

  const at = now.getTime();
  const start = time(promo.startsAt);
  const end = time(promo.endsAt);
  if (start !== null && at < start)
    return { ok: false, problem: "This discount code is not active yet." };
  if (end !== null && at >= end) return { ok: false, problem: "This discount code has expired." };
  if (promo.usageLimit !== null && promo.usageCount >= promo.usageLimit) {
    return { ok: false, problem: "This discount code has been used up." };
  }

  const subtotal = lines.reduce((n, l) => n + l.subtotalCents, 0);
  if (promo.minSubtotalCents !== null && subtotal < promo.minSubtotalCents) {
    return {
      ok: false,
      problem: `This discount code needs an order of at least ${(promo.minSubtotalCents / 100).toFixed(2)} ${currency}.`,
    };
  }
  // A fixed amount in another currency would take off a number that means nothing here.
  if (
    promo.applicationType === "fixed" &&
    promo.currency?.toUpperCase() !== currency.toUpperCase()
  ) {
    return { ok: false, problem: `This discount code is for orders in ${promo.currency}.` };
  }

  const take = (base: number): number =>
    promo.applicationType === "percentage"
      ? // Rounded DOWN: the shop never gives away more than the percentage promised.
        Math.floor((base * promo.value) / 100)
      : Math.min(promo.value, base);

  if (promo.applicationTarget === "shipping") {
    if (shippingCents <= 0) {
      return { ok: false, problem: "This discount code only applies to shipping costs." };
    }
    const off = take(shippingCents);
    return { ok: true, orderDiscountCents: 0, shippingDiscountCents: off, totalDiscountCents: off };
  }

  const only = promo.productIds;
  const eligible = only?.length ? lines.filter((l) => only.includes(l.productId)) : lines;
  const base = eligible.reduce((n, l) => n + l.subtotalCents, 0);
  if (base <= 0) {
    return { ok: false, problem: "None of the products in this order qualify for this code." };
  }
  const off = take(base);
  return { ok: true, orderDiscountCents: off, shippingDiscountCents: 0, totalDiscountCents: off };
}

function rows<T>(res: unknown): T[] {
  return (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** The promotion with that code, compared without case; `null` if there is none. */
export async function promotionByCode(db: Executor, code: string): Promise<PromotionLike | null> {
  const res = await db.execute(sql`
    SELECT id, code, active, application_type AS "applicationType",
           application_target AS "applicationTarget", value, currency,
           min_subtotal_cents AS "minSubtotalCents", product_ids AS "productIds",
           starts_at AS "startsAt", ends_at AS "endsAt", usage_limit AS "usageLimit",
           usage_count AS "usageCount"
    FROM shop_promotions WHERE lower(code) = lower(${code.trim()}) LIMIT 1
  `);
  const row = rows<PromotionLike>(res)[0];
  if (!row) return null;
  return {
    ...row,
    value: Number(row.value),
    usageCount: Number(row.usageCount),
    usageLimit: row.usageLimit === null ? null : Number(row.usageLimit),
    minSubtotalCents: row.minSubtotalCents === null ? null : Number(row.minSubtotalCents),
    productIds: Array.isArray(row.productIds) ? row.productIds : null,
  };
}

/**
 * Takes one use of the promotion, or none.
 *
 * The condition travels INSIDE the UPDATE, as with the stock: with one use left and two buyers
 * at once, one gets the row and the other gets nothing. `false` = it was used up, switched off or
 * expired between reading it and claiming it.
 */
export async function claimPromotion(db: Executor, promotionId: string): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE shop_promotions
    SET usage_count = usage_count + 1, updated_at = now()
    WHERE id = ${promotionId}
      AND active = true
      AND (usage_limit IS NULL OR usage_count < usage_limit)
      AND (starts_at IS NULL OR starts_at <= now())
      AND (ends_at IS NULL OR ends_at > now())
    RETURNING id
  `);
  return rows(res).length > 0;
}

/** Gives back the use an order took (on cancelling it). Never below zero. */
export async function releasePromotion(db: Executor, orderId: string): Promise<void> {
  await db.execute(sql`
    UPDATE shop_promotions p
    SET usage_count = GREATEST(p.usage_count - 1, 0), updated_at = now()
    FROM shop_orders o
    WHERE o.id = ${orderId} AND o.promotion_id = p.id
  `);
}

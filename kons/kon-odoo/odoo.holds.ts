/**
 * Odoo — stock held while a customer pays
 * ============================================================================
 *
 * Odoo reserves nothing for a quotation. Without a hold, two customers paying at once could both
 * be sold the last unit. A hold is this kon's claim on units of a variant, for a few minutes:
 *
 *   · taken when an order is placed, in ONE conditional UPDATE per variant
 *     (`qty_held = qty_held + n WHERE qty_free - qty_held >= n`), which two checkouts cannot both
 *     win;
 *   · released when Odoo confirms the order (Odoo's own reservation then counts those units, and
 *     counting them twice would hide stock), when the order fails or is cancelled, and when an
 *     unpaid order runs out of time;
 *   · never seen by Odoo's point of sale: a sale at the counter can still take a held unit.
 *
 * What the public catalog shows as available is `qty_free - qty_held`.
 *
 * Holds are written as the system: the caller was authorized to place the order, and the
 * variants (the catalog's rows) are not theirs to write.
 */

import { AppError } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { OdooDb } from "./odoo.mirror";
import { odooHolds, odooProducts, odooVariants } from "./odoo.schema";

export interface HoldLine {
  variantId: string;
  quantity: number;
  /** For the error: what the customer would recognise */
  name: string;
}

const asSystemOf = (ctx: KonContext) => ctx.db.asSystem ?? (<T>(fn: () => Promise<T>) => fn());

/**
 * Whether each product can be bought, from its variants' free quantity less what is held. A
 * product Odoo does not count (no quantity) can always be bought.
 */
export async function recomputeStock(db: OdooDb, productIds: string[]): Promise<void> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return;
  await db
    .update(odooProducts)
    .set({
      inStock: sql`${odooProducts.qtyFree} IS NULL OR EXISTS (
        SELECT 1 FROM ${odooVariants} v
         WHERE v.product_id = ${odooProducts.id} AND v.active
           AND (v.qty_free IS NULL OR v.qty_free - v.qty_held > 0))`,
    })
    .where(inArray(odooProducts.id, ids));
}

/**
 * Holds the units of these lines for an order, all or none: a line that cannot be held throws a
 * 409 naming it, and the request's transaction undoes the ones held before it.
 */
export async function placeHolds(
  ctx: KonContext,
  db: OdooDb,
  orderId: string,
  lines: HoldLine[],
  expiresAt: Date
): Promise<void> {
  // The same variant on two lines is one claim.
  const wanted = new Map<string, HoldLine>();
  for (const line of lines) {
    const seen = wanted.get(line.variantId);
    wanted.set(line.variantId, seen ? { ...seen, quantity: seen.quantity + line.quantity } : { ...line });
  }

  await asSystemOf(ctx)(async () => {
    const products: string[] = [];
    for (const line of wanted.values()) {
      const quantity = line.quantity.toFixed(4);
      const [held] = await db
        .update(odooVariants)
        .set({ qtyHeld: sql`${odooVariants.qtyHeld} + ${quantity}::numeric` })
        .where(
          and(
            eq(odooVariants.id, line.variantId),
            eq(odooVariants.active, true),
            eq(odooVariants.visible, true),
            // Not counted by Odoo: always available, and holding it means nothing.
            sql`${odooVariants.qtyFree} IS NOT NULL`,
            sql`${odooVariants.qtyFree} - ${odooVariants.qtyHeld} >= ${quantity}::numeric`
          )
        )
        .returning({ id: odooVariants.id, productId: odooVariants.productId });
      if (held) {
        await db.insert(odooHolds).values({ orderId, variantId: line.variantId, quantity, expiresAt });
        products.push(held.productId);
        continue;
      }
      // Either Odoo does not count it (fine) or there is not enough of it (not fine).
      const [variant] = await db
        .select({ qtyFree: odooVariants.qtyFree, qtyHeld: odooVariants.qtyHeld, active: odooVariants.active, visible: odooVariants.visible })
        .from(odooVariants)
        .where(eq(odooVariants.id, line.variantId))
        .limit(1);
      if (variant && variant.active && variant.visible && variant.qtyFree === null) continue;
      const left = variant ? Math.max(0, Number(variant.qtyFree ?? 0) - Number(variant.qtyHeld)) : 0;
      throw AppError.conflict(`Not enough of "${line.name}": ${left} available, ${line.quantity} asked.`, {
        variantId: line.variantId,
        available: left,
      });
    }
    await recomputeStock(db, products);
  });
}

/** Gives back what an order holds. Safe to call twice: a released hold is not released again. */
export async function releaseHolds(ctx: KonContext, db: OdooDb, orderIds: string[]): Promise<number> {
  const ids = [...new Set(orderIds)];
  if (ids.length === 0) return 0;
  return asSystemOf(ctx)(async () => {
    const released = await db
      .update(odooHolds)
      .set({ releasedAt: new Date() })
      .where(and(inArray(odooHolds.orderId, ids), isNull(odooHolds.releasedAt)))
      .returning({ variantId: odooHolds.variantId, quantity: odooHolds.quantity });
    if (released.length === 0) return 0;

    const byVariant = new Map<string, number>();
    for (const hold of released) byVariant.set(hold.variantId, (byVariant.get(hold.variantId) ?? 0) + Number(hold.quantity));
    const products: string[] = [];
    for (const [variantId, quantity] of byVariant) {
      const [row] = await db
        .update(odooVariants)
        .set({ qtyHeld: sql`GREATEST(0, ${odooVariants.qtyHeld} - ${quantity.toFixed(4)}::numeric)` })
        .where(eq(odooVariants.id, variantId))
        .returning({ productId: odooVariants.productId });
      if (row) products.push(row.productId);
    }
    await recomputeStock(db, products);
    return released.length;
  });
}

/** Moves the end of an order's holds (a paid order keeps them until Odoo confirms it). */
export async function extendHolds(ctx: KonContext, db: OdooDb, orderId: string, until: Date): Promise<void> {
  await asSystemOf(ctx)(() =>
    db
      .update(odooHolds)
      .set({ expiresAt: until })
      .where(and(eq(odooHolds.orderId, orderId), isNull(odooHolds.releasedAt)))
  );
}

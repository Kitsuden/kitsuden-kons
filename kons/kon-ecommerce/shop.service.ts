import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import {
  calculateTotals,
  freezeLines,
  orderNumber,
  reserveStock,
  validateCompliance,
  type OrderData,
  type OrderLine,
  type TransactionalExecutor,
  type VariantLike,
} from "./shop.orders";
import { claimPromotion, computeDiscount, promotionByCode } from "./shop.promotions";

/**
 * Creating an order, from start to finish
 * ============================================================================
 *
 * WHY EVERYTHING GOES IN ONE TRANSACTION
 *
 * `reserveStock` knows how to compensate by hand if a line fails, because it cannot
 * impose on the caller how it handles its transactions. But here it IS
 * controlled, and a transaction is strictly better than compensation:
 *
 *   · If the order insert fails after deducting, Postgres returns
 *     the stock on its own. Manual compensation does not cover that case — it only
 *     covers ANOTHER line failing, not what comes afterward failing.
 *   · And if the process dies midway, the transaction is not committed. With
 *     manual compensation, dying between the deduction and the compensation leaves
 *     units locked forever.
 *
 * Compensation stays as a net for whoever calls `reserveStock`
 * on their own, outside here.
 */

// The type lives in shop.orders.ts: a single declaration with `any`, justified
// once, instead of a copy per file.
type Executor = TransactionalExecutor;

function rows<T>(res: unknown): T[] {
  return (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as T[];
}

export interface OrderResult {
  ok: boolean;
  orderId?: string;
  number?: string;
  totalCents?: number;
  /** Validation problems, in the buyer's language. */
  problems?: string[];
  /** Name of the product that sold out, if that was it. */
  soldOut?: string;
  /** true if it is the response to a retry with the same Idempotency-Key. */
  repeated?: boolean;
  /** What the discount code took off, already out of `totalCents`. */
  discountCents?: number;
  currency?: string;
}

/**
 * Fingerprint of an `Idempotency-Key`: sha256(normalized email + key).
 *
 * Tied to the email so that a key guessed (or reused) by another person does not
 * return to them the number and amount of someone else's order: with another email the
 * fingerprint is different and a new order is simply created.
 */
export function idempotencyFingerprint(email: string, key: string): string {
  return createHash("sha256")
    .update(
      `${email.trim().toLowerCase()}
${key}`
    )
    .digest("hex");
}

async function orderByFingerprint(db: Executor, fingerprint: string): Promise<OrderResult | null> {
  const res = await db.execute(sql`
    SELECT id, number, total_cents AS "totalCents"
    FROM shop_orders WHERE idempotency_key = ${fingerprint} LIMIT 1
  `);
  const row = rows<{ id: string; number: string; totalCents: number }>(res)[0];
  if (!row) return null;
  return {
    ok: true,
    orderId: row.id,
    number: row.number,
    totalCents: Number(row.totalCents),
    repeated: true,
  };
}

/** Is it a uniqueness violation? (23505 in Postgres, also via drizzle). */
function isDuplicate(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string }; message?: string };
  return (
    err?.code === "23505" ||
    err?.cause?.code === "23505" ||
    /duplicate key|unique constraint/i.test(String(err?.message ?? ""))
  );
}

/**
 * Loads the requested variants with their product's name.
 *
 * It is done in ONE query and not one per line: an order of ten lines would be
 * ten trips to the database to build an object that fits in one.
 */
async function loadVariants(ids: string[], db: Executor): Promise<Map<string, VariantLike>> {
  if (ids.length === 0) return new Map();

  const res = await db.execute(sql`
    SELECT v.id, v.product_id AS "productId", p.name AS "productName", v.name,
           v.price_cents AS "priceCents", v.currency, v.stock, p.kind,
           (v.active AND p.active) AS active
    FROM shop_variants v
    JOIN shop_products p ON p.id = v.product_id
    WHERE v.id IN (${sql.join(
      ids.map((i) => sql`${i}`),
      sql`, `
    )})
  `);

  return new Map(rows<VariantLike>(res).map((v) => [v.id, v]));
}

/**
 * Requests the next number from the Postgres SEQUENCE.
 *
 * Not `MAX(number) + 1`: two simultaneous purchases would read the same maximum and
 * generate the same number, which has a unique index — and one of the two
 * would fail in front of the buyer, after having charged them.
 */
async function nextNumber(db: Executor, date: Date): Promise<string> {
  const res = await db.execute(sql`SELECT nextval('shop_order_number_seq') AS n`);
  const n = Number(rows<{ n: string | number }>(res)[0]?.n ?? 1);
  return orderNumber(n, date);
}

/**
 * Creates an order: validates, freezes prices, reserves stock and writes.
 *
 * Order matters. Validating before reserving avoids locking units for an
 * order that is going to be rejected anyway; and reserving before writing avoids
 * confirming an order that cannot be served.
 */
export async function createOrder(
  requestedLines: OrderLine[],
  data: OrderData,
  db: Executor,
  now: Date = new Date()
): Promise<OrderResult> {
  // A retry with the same key returns the SAME order: neither another number
  // nor another stock deduction.
  if (data.idempotencyKey) {
    const prior = await orderByFingerprint(db, data.idempotencyKey);
    if (prior) return prior;
  }

  const variants = await loadVariants(
    requestedLines.map((l) => l.variantId),
    db
  );

  const missingOnes = requestedLines.filter((l) => !variants.has(l.variantId));
  if (missingOnes.length > 0) {
    return { ok: false, problems: [`Some products no longer exist in the catalog.`] };
  }

  const lines = freezeLines(requestedLines, variants);

  const problems = validateCompliance(data, [...variants.values()]);
  if (problems.length > 0) return { ok: false, problems };

  const totals = calculateTotals(lines, data.shippingCents ?? 0);
  const currency =
    lines.length > 0 ? (variants.get(lines[0].variantId)?.currency ?? "EUR") : "EUR";

  // The discount, computed by the server from the frozen lines (shop.promotions.ts). A code that
  // does not apply is a 422 with the reason, before reserving anything.
  const code = data.couponCode?.trim() || null;
  const promotion = code ? await promotionByCode(db, code) : null;
  let discountCents = 0;
  if (code) {
    const d = computeDiscount(promotion, lines, currency, totals.shippingCents, now);
    if (!d.ok) return { ok: false, problems: [d.problem] };
    discountCents = d.totalDiscountCents;
  }
  const totalCents = Math.max(totals.totalCents - discountCents, 0);

  const run = async (tx: Executor): Promise<OrderResult> => {
    const reservation = await reserveStock(lines, tx);
    if (!reservation.ok) {
      // Throw and do not return: inside a transaction it has to be aborted so
      // that what was already deducted is undone. The message travels in the error.
      throw Object.assign(new Error("soldOut"), { soldOut: reservation.soldOut });
    }
    // The use is claimed like the stock: with one left and two buyers, one gets it.
    if (promotion && !(await claimPromotion(tx, promotion.id))) {
      throw Object.assign(new Error("promotionGone"), { promotionGone: true });
    }

    const number = await nextNumber(tx, now);

    const res = await tx.execute(sql`
      INSERT INTO shop_orders (
        id, number, status, fulfillment_type, customer_email, customer_name,
        subtotal_cents, shipping_cents, total_cents, currency,
        shipping_address, pickup_note, notes, placed_at, owner_id, idempotency_key,
        discount_cents, promotion_id, promotion_code, access_token_hash
      ) VALUES (
        gen_random_uuid()::text, ${number}, 'pending', ${data.fulfillmentType},
        ${data.customerEmail}, ${data.customerName ?? null},
        ${totals.subtotalCents}, ${totals.shippingCents}, ${totalCents}, ${currency},
        ${data.shippingAddress ? JSON.stringify(data.shippingAddress) : null}::jsonb,
        ${data.pickupNote ?? null}, ${data.notes ?? null}, ${now.toISOString()},
        ${data.ownerId ?? null}, ${data.idempotencyKey ?? null},
        ${discountCents}, ${promotion?.id ?? null}, ${promotion ? code : null},
        ${data.accessTokenHash ?? null}
      )
      RETURNING id
    `);

    const orderId = rows<{ id: string }>(res)[0]?.id;
    if (!orderId) throw new Error("shop: the order could not be created");

    for (const l of lines) {
      await tx.execute(sql`
        INSERT INTO shop_order_items (
          id, order_id, variant_id, product_name, variant_name,
          unit_price_cents, quantity, subtotal_cents, kind
        ) VALUES (
          gen_random_uuid()::text, ${orderId}, ${l.variantId}, ${l.productName},
          ${l.variantName}, ${l.unitPriceCents}, ${l.quantity}, ${l.subtotalCents}, ${l.kind}
        )
      `);
    }

    return { ok: true, orderId, number, totalCents, discountCents, currency };
  };

  try {
    // Without `transaction` (some executors do not expose it) it runs anyway: the
    // manual compensation of `reserveStock` is the net in that case.
    return db.transaction ? await db.transaction(run) : await run(db);
  } catch (e) {
    const exhausted = (e as { soldOut?: string }).soldOut;
    if (exhausted) return { ok: false, soldOut: exhausted, problems: [`"${exhausted}" has sold out.`] };
    if ((e as { promotionGone?: boolean }).promotionGone) {
      return { ok: false, problems: ["This discount code has been used up."] };
    }
    // Two simultaneous retries with the same key: the second collides with the
    // unique index, its transaction is rolled back (with its deduction) and it returns the
    // order that won.
    if (data.idempotencyKey && isDuplicate(e)) {
      const prior = await orderByFingerprint(db, data.idempotencyKey);
      if (prior) return prior;
    }
    throw e;
  }
}

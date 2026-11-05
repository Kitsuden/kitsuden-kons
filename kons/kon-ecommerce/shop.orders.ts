import { sql } from "drizzle-orm";

/**
 * Order creation: the three things that must be done right
 * ============================================================================
 *
 * 1. FREEZE THE PRICE at purchase. An order is a historical document.
 * 2. DEDUCT STOCK WITHOUT RACES. Two buyers at once on the
 *    last mug is the normal case, not the rare one.
 * 3. REQUIRE THE DATA THAT FULFILLMENT NEEDS. A shipment without an address is
 *    an order that cannot be served, and discovering it at packing time is too late.
 */

// ── Input types ─────────────────────────────────────────────────────────────

export type FulfillmentType = "digital" | "shipping" | "pickup";

export interface OrderLine {
  variantId: string;
  quantity: number;
}

/** Minimal shape of a variant. Structural: it does not matter where it comes from. */
export interface VariantLike {
  id: string;
  productId: string;
  productName: string;
  name: string | null;
  priceCents: number;
  currency: string;
  /** `null` = infinite stock (a file is sold a thousand times). */
  stock: number | null;
  kind: "digital" | "physical";
  active: boolean;
}

export interface OrderData {
  customerEmail: string;
  customerName?: string | null;
  fulfillmentType: FulfillmentType;
  shippingAddress?: Record<string, unknown> | null;
  pickupNote?: string | null;
  shippingCents?: number;
  notes?: string | null;
  ownerId?: string | null;
  /**
   * Idempotency fingerprint ALREADY computed by the route (see `idempotencyFingerprint`
   * in shop.service.ts). Never the client's raw key.
   */
  idempotencyKey?: string | null;
  /** A discount code as the buyer typed it (0008). The discount is computed by the server. */
  couponCode?: string | null;
  /** sha256 of the order token the route generated (0008). Never the token itself. */
  accessTokenHash?: string | null;
}

// ── Validation ──────────────────────────────────────────────────────────────

const ADDRESS_FIELDS = ["line1", "city", "postalCode", "country"] as const;

/**
 * Checks that the order carries what its fulfillment type needs.
 *
 * Returns ALL the problems, not the first: whoever fills in a form should not
 * discover the errors one at a time.
 */
export function validateCompliance(data: OrderData, lines: VariantLike[]): string[] {
  const problems: string[] = [];

  if (!data.customerEmail?.includes("@")) {
    problems.push("A valid contact email is required.");
  }

  const hasPhysical = lines.some((l) => l.kind === "physical");

  switch (data.fulfillmentType) {
    case "digital":
      // A digital order with a mug in it cannot be delivered by email.
      if (hasPhysical) {
        problems.push("The order is digital but includes physical products.");
      }
      break;

    case "shipping": {
      const dir = data.shippingAddress ?? {};
      const areMissing = ADDRESS_FIELDS.filter((c) => !String(dir[c] ?? "").trim());
      if (areMissing.length > 0) {
        problems.push(`The shipping address is missing: ${areMissing.join(", ")}.`);
      }
      break;
    }

    case "pickup":
      // Pickup needs no address — that is exactly its advantage. But without
      // saying where and when, the buyer does not know what to do.
      if (!data.pickupNote?.trim()) {
        problems.push("Pickup requires a location and schedule.");
      }
      break;
  }

  if (lines.length === 0) problems.push("The order has no lines.");
  if (lines.some((l) => !l.active)) problems.push("Some products are no longer for sale.");

  // Mixing currencies in an order gives a total that means nothing.
  const currencies = new Set(lines.map((l) => l.currency));
  if (currencies.size > 1) {
    problems.push(`The order mixes currencies: ${[...currencies].join(", ")}.`);
  }

  return problems;
}

// ── Calculation ─────────────────────────────────────────────────────────────

export interface FrozenLine {
  variantId: string;
  /** Which product: a discount code limited to some products looks at it. */
  productId: string;
  productName: string;
  variantName: string | null;
  unitPriceCents: number;
  quantity: number;
  subtotalCents: number;
  kind: "digital" | "physical";
}

/**
 * Freezes prices and names at the moment of purchase.
 *
 * From here on the order no longer depends on the catalog: changing the price of
 * a mug tomorrow does not alter what was charged today, and deleting the product does not
 * destroy the accounting.
 */
export function freezeLines(
  requestedOnes: OrderLine[],
  variants: Map<string, VariantLike>
): FrozenLine[] {
  return requestedOnes.map((p) => {
    const v = variants.get(p.variantId);
    if (!v) throw new Error(`shop: variant ${p.variantId} does not exist`);
    if (!Number.isInteger(p.quantity) || p.quantity < 1) {
      throw new Error(`shop: invalid quantity for ${p.variantId}: ${p.quantity}`);
    }
    return {
      variantId: v.id,
      productId: v.productId,
      productName: v.productName,
      variantName: v.name,
      unitPriceCents: v.priceCents,
      quantity: p.quantity,
      subtotalCents: v.priceCents * p.quantity,
      kind: v.kind,
    };
  });
}

export function calculateTotals(lines: FrozenLine[], shippingCents = 0) {
  const subtotalCents = lines.reduce((s, l) => s + l.subtotalCents, 0);
  return { subtotalCents, shippingCents, totalCents: subtotalCents + shippingCents };
}

/**
 * Readable, sortable order number: `2026-000042`.
 *
 * It carries the year first so counters can be reset each fiscal year
 * without colliding, and zero padding so it sorts the same as text as
 * as a number.
 */
export function orderNumber(sequenceNumber: number, date: Date): string {
  return `${date.getUTCFullYear()}-${String(sequenceNumber).padStart(6, "0")}`;
}

// ── Stock ───────────────────────────────────────────────────────────────────

/**
 * SQL executor. Structural on purpose: it accepts the global `db`, a
 * transaction or a test client without knowing any of them.
 *
 * It is defined HERE and re-exported so that `shop.service.ts` does not have its own
 * copy — two declarations with `any` instead of one, and the one there was left
 * unjustified as soon as prettier split it into several lines (an
 * `eslint-disable-next-line` only covers the next line).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Executor = { execute: (q: any) => Promise<any> };

/** Executor that also knows how to open a transaction. */
export interface TransactionalExecutor extends Executor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction?: (fn: (tx: any) => Promise<any>) => Promise<any>;
}

/**
 * Deducts stock ATOMICALLY and conditionally.
 *
 * The naive version — read stock, check, subtract — has a window between
 * the read and the write through which another purchase slips in. With six mugs and
 * two simultaneous buyers, seven are sold.
 *
 * Here the condition travels INSIDE the UPDATE: Postgres locks the row, and if the
 * `WHERE` is not met it updates nothing and returns no row. No row = there was no
 * stock, and it is known without having read first.
 *
 * `stock IS NULL` (infinite) passes the filter and `NULL - quantity` is still
 * NULL, so digital goods are served without branching the code.
 */
export async function deductStock(
  variantId: string,
  quantity: number,
  db: Executor
): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE shop_variants
    SET stock = stock - ${quantity}
    WHERE id = ${variantId}
      AND active = true
      AND (stock IS NULL OR stock >= ${quantity})
    RETURNING id
  `);
  const rows = (
    Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])
  ) as unknown[];
  return rows.length > 0;
}

/** Returns stock on cancel or refund. No cap: it never fails. */
export async function restoreStock(
  variantId: string,
  quantity: number,
  db: Executor
): Promise<void> {
  await db.execute(sql`
    UPDATE shop_variants
    SET stock = stock + ${quantity}
    WHERE id = ${variantId} AND stock IS NOT NULL
  `);
}

/**
 * Reserves the stock of a whole order, or none.
 *
 * If the third line runs out of stock, the first two were already deducted and
 * have to be returned — otherwise those units stay locked by an order
 * that never existed, and are only recovered by hand.
 *
 * Ideally this would be a transaction; it is compensated explicitly because this
 * module does not impose on the caller how it handles its own.
 */
export async function reserveStock(
  lines: FrozenLine[],
  db: Executor
): Promise<{ ok: true } | { ok: false; soldOut: string }> {
  const done: FrozenLine[] = [];

  for (const l of lines) {
    const ok = await deductStock(l.variantId, l.quantity, db);
    if (!ok) {
      for (const h of done) await restoreStock(h.variantId, h.quantity, db);
      return { ok: false, soldOut: l.productName };
    }
    done.push(l);
  }

  return { ok: true };
}

/**
 * Returns to the catalog the units of ONE order (on cancelling it).
 *
 * It is read from its lines, not from the client: what is restored is exactly what
 * was deducted when it was created.
 */
export async function restockOrder(orderId: string, db: Executor): Promise<void> {
  await db.execute(sql`
    UPDATE shop_variants v
    SET stock = v.stock + x.q
    FROM (
      SELECT variant_id, SUM(quantity)::int AS q
      FROM shop_order_items
      WHERE order_id = ${orderId} AND variant_id IS NOT NULL
      GROUP BY variant_id
    ) x
    WHERE v.id = x.variant_id AND v.stock IS NOT NULL
  `);
}

/**
 * Cancels `pending` orders older than `minutos` and restores their stock.
 *
 * WHY: creating an order is anonymous and RESERVES stock (deducts it)
 * before charging. Without expiry, a loop of orders that are never paid leaves
 * a unique piece at zero forever. With it, at most it blocks it for
 * the period, and the kon's request limit bounds how many times.
 *
 * Safe under concurrency: the `UPDATE … WHERE status = 'pending'` locks the
 * row; a second simultaneous sweep re-evaluates it as already `cancelled` and does not
 * return it, so nothing is restored twice.
 *
 * Returns how many orders it has released.
 */
export async function releaseExpiredReservations(
  db: Executor,
  minutes: number,
  now: Date = new Date()
): Promise<number> {
  const limit = new Date(now.getTime() - minutes * 60_000).toISOString();
  // The discount-code uses those orders took go back too (0008), in the same statement.
  const res = await db.execute(sql`
    WITH caducados AS (
      UPDATE shop_orders
      SET status = 'cancelled', updated_at = now()
      WHERE status = 'pending' AND placed_at < ${limit}::timestamptz
      RETURNING id, promotion_id
    ),
    usos AS (
      UPDATE shop_promotions p
      SET usage_count = GREATEST(p.usage_count - x.n, 0), updated_at = now()
      FROM (
        SELECT promotion_id, count(*)::int AS n
        FROM caducados WHERE promotion_id IS NOT NULL
        GROUP BY promotion_id
      ) x
      WHERE p.id = x.promotion_id
      RETURNING p.id
    ),
    repuesto AS (
      UPDATE shop_variants v
      SET stock = v.stock + x.q
      FROM (
        SELECT i.variant_id, SUM(i.quantity)::int AS q
        FROM shop_order_items i
        JOIN caducados c ON c.id = i.order_id
        WHERE i.variant_id IS NOT NULL
        GROUP BY i.variant_id
      ) x
      WHERE v.id = x.variant_id AND v.stock IS NOT NULL
      RETURNING v.id
    )
    SELECT (SELECT count(*) FROM caducados)::int AS n
  `);
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as {
    n: number;
  }[];
  return Number(rows[0]?.n ?? 0);
}

// ── States ──────────────────────────────────────────────────────────────────

/**
 * Allowed transitions.
 *
 * Declared instead of checked by hand in each route: a refunded order
 * going back to "paid" is the kind of thing only discovered by auditing.
 */
export const TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["paid", "cancelled"],
  // `delivered` is here because of DIGITAL goods: a file is delivered at the same
  // instant it is charged, and `statusAfterPayment("digital")` returns exactly that.
  // Without this edge the two functions contradicted each other — one proposed a destination
  // that the other forbade — and the order got stuck in "paid" forever.
  // Physical goods do go through production; no real step is skipped.
  paid: ["in_production", "ready", "shipped", "delivered", "cancelled", "refunded"],
  in_production: ["ready", "cancelled"],
  ready: ["shipped", "delivered", "cancelled"],
  shipped: ["delivered", "refunded"],
  delivered: ["refunded"],
  cancelled: [],
  refunded: [],
};

export function canTransition(from: string, until: string): boolean {
  return TRANSITIONS[from]?.includes(until) ?? false;
}

/**
 * Next natural state after charging, depending on fulfillment.
 *
 * Digital goods deliver themselves; physical ones enter production, which is the state
 * that exists because here whoever sells also manufactures.
 */
export function statusAfterPayment(type: FulfillmentType): "delivered" | "in_production" {
  return type === "digital" ? "delivered" : "in_production";
}

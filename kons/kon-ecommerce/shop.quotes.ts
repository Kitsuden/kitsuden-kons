/**
 * A quote accepted in the CRM becomes an order here
 * ============================================================================
 *
 * kon-crm announces `crm:quote.accepted` with `then: "order"` and the quote's lines. The lines that point
 * at this shop (`productType: "shop_variants"`) become a pending order for the deal's contact, through the
 * same `createOrder` a buyer goes through: the shop's own catalog prices, stock reserved, codes and
 * compliance checked. Then the order is linked to the deal (`related`), so the deal's timeline shows it.
 *
 * Refused, and announced as `shop:order.quote-refused` with the reason, when:
 *   - a line is not a shop product (a service written by hand cannot be sold by the shop);
 *   - the quote has no contact email (an order needs a buyer);
 *   - the fulfillment is shipping or pickup: their cost and place are set by the shop's settings at
 *     checkout, so those orders are made in the shop. A digital order is made here.
 *
 * The same quote twice is one order: the idempotency fingerprint is the quote's id.
 */

import { link } from "@kitsuden/engine";

import { createOrder, idempotencyFingerprint } from "./shop.service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a Drizzle instance or transaction
type Db = any;

export type QuoteOrderOutcome =
  | { outcome: "created"; orderId: string; number: string; repeated: boolean }
  | { outcome: "refused"; reason: string }
  | { outcome: "ignored" };

export async function orderFromQuote(db: Db, payload: unknown): Promise<QuoteOrderOutcome> {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (p.then !== "order" || typeof p.quoteId !== "string" || typeof p.dealId !== "string") return { outcome: "ignored" };
  const lines = Array.isArray(p.lines) ? (p.lines as Array<Record<string, unknown>>) : [];
  if (lines.length === 0) return { outcome: "refused", reason: "The quote has no lines" };
  const foreign = lines.filter((l) => l.productType !== "shop_variants" || typeof l.productId !== "string");
  if (foreign.length > 0) {
    return { outcome: "refused", reason: `Not shop products: ${foreign.map((l) => String(l.name)).join(", ")}` };
  }
  const email = typeof p.customerEmail === "string" && p.customerEmail ? p.customerEmail : null;
  if (!email) return { outcome: "refused", reason: "The deal has no contact email to order for" };
  const fulfillment = (p.fulfillmentType as string | null) ?? "digital";
  if (fulfillment !== "digital") {
    return { outcome: "refused", reason: "Shipping and pickup orders are made in the shop, where their cost and place are set" };
  }

  const result = await createOrder(
    lines.map((l) => ({ variantId: String(l.productId), quantity: Math.max(1, Math.round(Number(l.quantity))) })),
    {
      customerEmail: email,
      customerName: (p.customerName as string | null) ?? null,
      fulfillmentType: "digital",
      notes: `From CRM quote ${String(p.number ?? p.quoteId)}`,
      ownerId: null,
      idempotencyKey: idempotencyFingerprint(email, `crm-quote:${p.quoteId}`),
    },
    db
  );
  if (!result.ok || !result.orderId) return { outcome: "refused", reason: (result.problems ?? ["The order could not be made"]).join("; ") };
  await link(
    { type: "shop_orders", id: result.orderId },
    { type: "crm_deals", id: p.dealId },
    { relation: "related", metadata: { kind: "quote-order", quoteId: p.quoteId, number: result.number ?? null } },
    db
  );
  return { outcome: "created", orderId: result.orderId, number: result.number ?? "", repeated: Boolean((result as { repeated?: boolean }).repeated) };
}

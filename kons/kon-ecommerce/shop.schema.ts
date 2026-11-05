import { createId } from "@paralleldrive/cuid2";
import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";

/**
 * Store — sale of digital products and made-to-order items
 * ============================================================================
 *
 * It is NOT a large-catalog ecommerce. There is no persistent cart, no
 * per-carrier shipping gateways, no warehouse management. That is Shopify,
 * and competing there is a bad idea.
 *
 * This covers two concrete scenarios that Shopify makes expensive and Etsy does in
 * exchange for keeping your customer:
 *
 *   · DIGITAL products — guides, packs, courses, premium access
 *   · objects MADE by the seller — ceramics, crafts, local commissions
 *
 * ── THE DIFFERENCE BETWEEN THE TWO IS NOT IN THE ORDER ─────────────────────
 *
 * It is FULFILLMENT. Catalog, price, order and payment are identical; what
 * changes is what happens afterward and what data is needed:
 *
 *   digital  → needs no address; delivered by granting access
 *   shipping → needs an address; goes through production and transport
 *   pickup   → needs no address; goes through production and waits in the shop
 *
 * That is why there is ONE order type with a `fulfillmentType`, and not three tables.
 *
 * ── NO DEPENDENCY ON CRM ───────────────────────────────────────────────────
 *
 * An order stores the buyer's email and name and works alone with that.
 * If whoever installs it ALSO has CRM, it is linked with `kitsuden_links`
 * (`link(order, contact, { relation: "ordered_by" })`). The store never
 * imports anything from the CRM.
 */

export const shopProductKind = pgEnum("shop_product_kind", ["digital", "physical"]);

/**
 * Order states.
 *
 * `in_production` exists because this is the case of someone who MANUFACTURES: between paying and
 * shipping there are days of work, and the buyer asks. Without that state, the
 * seller answers emails by hand.
 */
export const shopOrderStatus = pgEnum("shop_order_status", [
  "pending", // created, not yet charged
  "paid",
  "in_production", // physical only: being manufactured
  "ready", // ready for pickup or shipping
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
]);

export const shopFulfillmentType = pgEnum("shop_fulfillment_type", [
  "digital",
  "shipping",
  "pickup",
]);

// ── Catalog ─────────────────────────────────────────────────────────────────

export const shopProducts = pgTable(
  "shop_products",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    kind: shopProductKind("kind").notNull().default("digital"),

    /** Main image. Reference to `kon-media`, with no FK so as not to couple. */
    mediaId: text("media_id"),

    active: boolean("active").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),

    ownerId: text("owner_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shop_products_slug_idx").on(t.slug),
    index("shop_products_active_idx").on(t.active),
  ]
);

/**
 * Variant: what is actually bought and what actually has stock.
 *
 * It ALWAYS exists, even if the product has only one — if price and stock
 * lived on the product, adding "large mug" would force migrating data. A default
 * variant costs one row and avoids that migration forever.
 */
export const shopVariants = pgTable(
  "shop_variants",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    productId: text("product_id")
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),

    name: text("name").notNull().default("Standard"),
    sku: text("sku"),

    /** ALWAYS in whole cents. Never float: 0.1 + 0.2 is not 0.3. */
    priceCents: integer("price_cents").notNull(),
    currency: text("currency").notNull().default("EUR"),

    /**
     * NULL = infinite stock. It is what distinguishes a file (it can be
     * sold a thousand times) from a mug (you made six).
     *
     * It is modeled as absence and not as a huge number so that "0 left"
     * and "not applicable" are never confused: selling below zero is a bug
     * that is only seen when an angry customer arrives.
     */
    stock: integer("stock"),

    /** Size, color, glaze… whatever distinguishes this variant. */
    attributes: jsonb("attributes").$type<Record<string, string>>().default({}),

    active: boolean("active").notNull().default(true),

    /**
     * How a paid unit of this variant is delivered beyond its files (0008): `none`, `generate`
     * (a random key per unit) or `pool` (keys the team uploaded to `shop_license_keys`).
     */
    licenseMode: text("license_mode").$type<LicenseMode>().notNull().default("none"),
    /** Downloads per file and order; NULL is no limit. */
    downloadLimit: integer("download_limit"),
    /** Days the downloads stay open after paying; NULL is forever. */
    downloadDays: integer("download_days"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("shop_variants_product_idx").on(t.productId),
    uniqueIndex("shop_variants_sku_idx").on(t.sku),
  ]
);

// ── Orders ──────────────────────────────────────────────────────────────────

export const shopOrders = pgTable(
  "shop_orders",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),

    /** Readable number for talking to the customer. Never reused. */
    number: text("number").notNull(),

    status: shopOrderStatus("status").notNull().default("pending"),
    fulfillmentType: shopFulfillmentType("fulfillment_type").notNull(),

    /**
     * The buyer, stored in the order and not by reference.
     *
     * An order is a historical document: if the customer changes their email
     * tomorrow, yesterday's order still has to say where it was sent.
     */
    customerEmail: text("customer_email").notNull(),
    customerName: text("customer_name"),

    subtotalCents: integer("subtotal_cents").notNull().default(0),
    shippingCents: integer("shipping_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    currency: text("currency").notNull().default("EUR"),

    /** Only for `shipping`. A copy, not a reference, for the same reason. */
    shippingAddress: jsonb("shipping_address").$type<Record<string, unknown>>(),

    /** Only for `pickup`: where and when to collect. */
    pickupNote: text("pickup_note"),

    notes: text("notes"),

    /** Opaque reference to the payment in `kon-payments`. No FK: the store works without it. */
    paymentRef: text("payment_ref"),

    placedAt: timestamp("placed_at", { withTimezone: true }),
    ownerId: text("owner_id"),
    /**
     * Fingerprint of the buyer's `Idempotency-Key` (sha256 of email + key).
     * Retrying the same POST /orders returns the SAME order instead of
     * deducting stock twice. Migration 0002.
     */
    idempotencyKey: text("idempotency_key"),

    // ── 0008 ──
    /** sha256 of the buyer's order token. The token itself is given once and never stored. */
    accessTokenHash: text("access_token_hash"),
    /** What the discount code took off, already included in `totalCents`. */
    discountCents: integer("discount_cents").notNull().default(0),
    promotionId: text("promotion_id"),
    /** The code as the buyer typed it, frozen like the prices. */
    promotionCode: text("promotion_code"),
    /** Which kon-payments provider charged it (`stripe`, `lemonsqueezy`…). */
    paymentProvider: text("payment_provider"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    trackingNumber: text("tracking_number"),
    trackingUrl: text("tracking_url"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shop_orders_number_idx").on(t.number),
    uniqueIndex("shop_orders_idempotency_idx").on(t.idempotencyKey),
    index("shop_orders_status_idx").on(t.status),
    index("shop_orders_email_idx").on(t.customerEmail),
  ]
);

/**
 * Order line, with the price and name FROZEN.
 *
 * It is the most important decision in this schema. If the line only stored
 * `variantId`, computing the total of an order from a year ago would use today's
 * price — and the order would say a different figure from what was charged. With a
 * price change or a deleted product, the accounting stops balancing and
 * there is no way to rebuild it.
 *
 * `variantId` is kept only as a hint for restocking or analysis, and that is why
 * it is nullable and without cascade delete: deleting a product cannot delete
 * the history of what was sold.
 */
export const shopOrderItems = pgTable(
  "shop_order_items",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    orderId: text("order_id")
      .notNull()
      .references(() => shopOrders.id, { onDelete: "cascade" }),

    variantId: text("variant_id"),

    productName: text("product_name").notNull(),
    variantName: text("variant_name"),
    unitPriceCents: integer("unit_price_cents").notNull(),
    quantity: integer("quantity").notNull(),
    subtotalCents: integer("subtotal_cents").notNull(),

    /** Copy of the type: decides whether this line deducts stock and how it is delivered. */
    kind: shopProductKind("kind").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shop_order_items_order_idx").on(t.orderId)]
);

// ── Delivery (0008) ─────────────────────────────────────────────────────────

export type LicenseMode = "none" | "generate" | "pool";

/**
 * A file a purchase delivers. The file lives in the core's media library; this row says which
 * product, or only which variant of it, delivers it.
 */
export const shopProductFiles = pgTable(
  "shop_product_files",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    productId: text("product_id")
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    /** NULL: every variant of the product delivers it. */
    variantId: text("variant_id").references(() => shopVariants.id, { onDelete: "cascade" }),
    mediaId: text("media_id").notNull(),
    /** What the buyer sees. The storage key is read from the media row when downloading. */
    filename: text("filename").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shop_product_files_product_idx").on(t.productId)]
);

/** License keys the team uploaded for a variant in `pool` mode. */
export const shopLicenseKeys = pgTable(
  "shop_license_keys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    variantId: text("variant_id")
      .notNull()
      .references(() => shopVariants.id, { onDelete: "cascade" }),
    licenseKey: text("license_key").notNull(),
    /** Set when a paid order takes it; a taken key is never handed out twice. */
    orderItemId: text("order_item_id"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("shop_license_keys_unique_idx").on(t.variantId, t.licenseKey)]
);

/** What a paid order gives its buyer: one row per file and per license key. */
export const shopEntitlements = pgTable(
  "shop_entitlements",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    orderId: text("order_id")
      .notNull()
      .references(() => shopOrders.id),
    /** No foreign key: what was delivered outlives the catalog, like the order lines. */
    orderItemId: text("order_item_id"),
    kind: text("kind").$type<"download" | "license">().notNull(),
    fileId: text("file_id").references(() => shopProductFiles.id, { onDelete: "set null" }),
    filename: text("filename"),
    licenseKey: text("license_key"),
    downloadsUsed: integer("downloads_used").notNull().default(0),
    downloadLimit: integer("download_limit"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** A refund revokes; the row stays as the record of what was delivered and taken back. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shop_entitlements_order_idx").on(t.orderId)]
);

// ── Discount codes (0008) ───────────────────────────────────────────────────

/**
 * A discount code, shaped after Medusa's promotions (MIT): an APPLICATION (what is taken off and
 * from what) and RULES (when it applies). Small on purpose; the shape lets it grow.
 */
export const shopPromotions = pgTable("shop_promotions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  /** Compared without case (unique index on `lower(code)`). */
  code: text("code").notNull(),
  description: text("description"),
  active: boolean("active").notNull().default(true),
  /** `percentage`: `value` is 1-100. `fixed`: `value` is cents, in `currency`. */
  applicationType: text("application_type").$type<"percentage" | "fixed">().notNull(),
  /** `order`: off the eligible lines. `shipping`: off the shipping cost. */
  applicationTarget: text("application_target").$type<"order" | "shipping">().notNull().default("order"),
  value: integer("value").notNull(),
  currency: text("currency"),
  minSubtotalCents: integer("min_subtotal_cents"),
  /** Only these products count; NULL is every product. */
  productIds: jsonb("product_ids").$type<string[] | null>(),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  usageLimit: integer("usage_limit"),
  usageCount: integer("usage_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** "My orders" links: a buyer asks with their email and gets one by email. */
export const shopOrderLinks = pgTable(
  "shop_order_links",
  {
    /** sha256 of the token; the token travels only by email. */
    tokenHash: text("token_hash").primaryKey(),
    email: text("email").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shop_order_links_email_idx").on(t.email, t.createdAt)]
);

export type ShopProduct = typeof shopProducts.$inferSelect;
export type ShopVariant = typeof shopVariants.$inferSelect;
export type ShopOrder = typeof shopOrders.$inferSelect;
export type ShopOrderItem = typeof shopOrderItems.$inferSelect;
export type ShopProductFile = typeof shopProductFiles.$inferSelect;
export type ShopEntitlement = typeof shopEntitlements.$inferSelect;
export type ShopPromotion = typeof shopPromotions.$inferSelect;

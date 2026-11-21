/**
 * Odoo — Drizzle schema
 * ============================================================================
 *
 * Only to TYPE the queries. The tables are created by `migrations/0000_initial.sql`
 * (kon.json: `schema.strategy = "sql"`), so this file and the migrations change together.
 *
 * Odoo owns every fact in the mirror tables (products, variants, categories, partners). They
 * are a copy kept for reading: nothing here is edited by hand, and a row that disagrees with
 * Odoo is wrong until the next sync puts it right.
 *
 * Money is `numeric(19,4)` and travels as a decimal string, never as a float.
 */

import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const money = (name: string) => numeric(name, { precision: 19, scale: 4 });
const quantity = (name: string) => numeric(name, { precision: 19, scale: 4 });
const at = (name: string) => timestamp(name, { withTimezone: true });

/** A value sealed by the host (`ctx.secrets.seal`): never readable from a query. */
export interface SealedValue {
  v: number;
  kon: string;
  valueEncrypted: string;
  iv: string;
  authTag: string;
}

/** What this Odoo instance has installed, found by asking it (`fields_get`), never assumed. */
export interface OdooCapabilities {
  /** Inventory: variants carry `free_qty` and `qty_available` */
  stock: boolean;
  /** eCommerce: templates carry `is_published` */
  website: boolean;
  /** Variants: `product_template_attribute_value_ids` */
  variants: boolean;
  /** Loyalty: `loyalty.card` exists (eWallet, gift cards) */
  loyalty: boolean;
  /** Invoicing: `account.payment` exists */
  payments: boolean;
  /** The bridge module: one method that creates and confirms an order in one transaction */
  bridge: boolean;
  /** Field names present on each model that the sync may ask for */
  fields: Record<string, string[]>;
  checkedAt: string;
}

// ── Settings: one row ─────────────────────────────────────────────────────────

export const odooSettings = pgTable("odoo_settings", {
  id: integer("id").primaryKey().default(1),
  capabilities: jsonb("capabilities").$type<OdooCapabilities | null>(),
  /** ISO 4217 of the Odoo company, read from it */
  currency: varchar("currency", { length: 3 }),
  /** Language of translatable fields (`es_ES`). Null: the key user's language */
  lang: varchar("lang", { length: 10 }),
  /** Shared with Odoo: signs the change notices it sends. Sealed. */
  webhookSecret: jsonb("webhook_secret").$type<SealedValue | null>(),
  /** Where the site's cache is told what changed */
  purgeUrl: text("purge_url"),
  /** Shared with the site: signs the purge notices. Sealed. */
  purgeSecret: jsonb("purge_secret").$type<SealedValue | null>(),
  /** Name of this catalog on the site */
  purgeSource: varchar("purge_source", { length: 60 }).notNull().default("odoo"),
  /** Odoo API keys made by hand last three months at most; the day this one stops working */
  keyExpiresOn: date("key_expires_on"),
  lastFullSyncAt: at("last_full_sync_at"),
  /** When Odoo last told us something changed: the freshness of the mirror */
  lastNoticeAt: at("last_notice_at"),
  /** How long stock stays held for an order waiting to be paid */
  holdMinutes: integer("hold_minutes").notNull().default(10),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

// ── Mirror ────────────────────────────────────────────────────────────────────

export const odooCategories = pgTable("odoo_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  odooId: integer("odoo_id").notNull().unique(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  parentOdooId: integer("parent_odoo_id"),
  /** `/1/5/9/`: the ids from the root down to this one, so a subtree is a prefix */
  path: text("path").notNull().default("/"),
  syncedAt: at("synced_at").notNull().defaultNow(),
});

export const odooProducts = pgTable("odoo_products", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** `product.template` id */
  odooId: integer("odoo_id").notNull().unique(),
  /** `<name>-<odoo id>`: the id at the end is what is looked up, so a rename keeps old links */
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  /** Odoo's internal reference */
  sku: text("sku"),
  barcode: text("barcode"),
  listPrice: money("list_price"),
  /** Lowest and highest price among the variants that can be sold */
  minPrice: money("min_price"),
  maxPrice: money("max_price"),
  currency: varchar("currency", { length: 3 }),
  categoryOdooId: integer("category_odoo_id"),
  /** `{ Color: ["Red", "Blue"] }`, from the variants' options */
  attributes: jsonb("attributes").$type<Record<string, string[]>>().notNull().default({}),
  /** Free-to-use units across the variants. Null when Odoo does not track this product's stock */
  qtyFree: quantity("qty_free"),
  /** Can be bought now: free units above zero, or stock is not tracked */
  inStock: boolean("in_stock").notNull().default(true),
  /** Visible to the public: active, can be sold, and published when Odoo has that switch */
  published: boolean("published").notNull().default(false),
  active: boolean("active").notNull().default(true),
  /** The template's last write in Odoo: when it moves, the image is fetched again */
  imageVersion: text("image_version"),
  /** Where the product's image is kept in this Kitsuden's storage. Null: no image, or not fetched yet */
  imageKey: text("image_key"),
  odooWriteDate: at("odoo_write_date"),
  syncedAt: at("synced_at").notNull().defaultNow(),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

export const odooVariants = pgTable("odoo_variants", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** `product.product` id. Odoo deletes and recreates variants: this one can change */
  odooId: integer("odoo_id").notNull().unique(),
  productId: uuid("product_id")
    .notNull()
    .references(() => odooProducts.id, { onDelete: "cascade" }),
  /** Internal reference: what survives when Odoo recreates the variant */
  sku: text("sku"),
  barcode: text("barcode"),
  /** `{ Condition: "Near Mint", Finish: "Foil" }` */
  options: jsonb("options").$type<Record<string, string>>().notNull().default({}),
  price: money("price"),
  /** On hand and not reserved. Null when stock is not tracked */
  qtyFree: quantity("qty_free"),
  qtyOnHand: quantity("qty_on_hand"),
  /** Units held here for orders being paid. What can be sold is `qtyFree - qtyHeld` */
  qtyHeld: quantity("qty_held").notNull().default("0"),
  active: boolean("active").notNull().default(true),
  /** The product's `published`, copied so row security needs no join */
  visible: boolean("visible").notNull().default(false),
  /** Ids this variant had before Odoo recreated it */
  previousOdooIds: integer("previous_odoo_ids").array().notNull().default([]),
  odooWriteDate: at("odoo_write_date"),
  syncedAt: at("synced_at").notNull().defaultNow(),
});

/** An Odoo partner (`res.partner`) and, when known, the Kitsuden account it belongs to. */
export const odooPartners = pgTable("odoo_partners", {
  id: uuid("id").primaryKey().defaultRandom(),
  odooId: integer("odoo_id").notNull().unique(),
  /** Lower case */
  email: text("email"),
  name: text("name").notNull(),
  phone: text("phone"),
  vat: text("vat"),
  userId: text("user_id"),
  syncedAt: at("synced_at").notNull().defaultNow(),
});

// ── Orders ────────────────────────────────────────────────────────────────────

export const ORDER_STATUSES = ["pending", "created", "confirmed", "cancelled", "failed", "expired"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderLine {
  /** `product.product` id at the time of the order */
  odooProductId: number;
  variantId: string | null;
  sku: string | null;
  name: string;
  quantity: string;
  /** Unit price before tax, as Odoo answered it. Null until Odoo has the order */
  unitPrice: string | null;
}

export interface OrderCustomer {
  email: string;
  name: string;
  phone?: string;
  vat?: string;
  street?: string;
  city?: string;
  zip?: string;
  countryCode?: string;
}

export const odooOrders = pgTable("odoo_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The caller's own reference: the same one twice is the same order */
  clientRef: varchar("client_ref", { length: 120 }).notNull().unique(),
  /** `sale.order` id, once Odoo has it */
  odooId: integer("odoo_id").unique(),
  /** `S00042` */
  odooName: text("odoo_name"),
  partnerId: uuid("partner_id").references(() => odooPartners.id, { onDelete: "set null" }),
  customer: jsonb("customer").$type<OrderCustomer>().notNull(),
  lines: jsonb("lines").$type<OrderLine[]>().notNull(),
  note: text("note"),
  status: varchar("status", { length: 20 }).$type<OrderStatus>().notNull().default("pending"),
  amountUntaxed: money("amount_untaxed"),
  amountTax: money("amount_tax"),
  amountTotal: money("amount_total"),
  currency: varchar("currency", { length: 3 }),
  /** Where the customer pays in Odoo's portal, when Odoo gave one */
  paymentUrl: text("payment_url"),
  /** Store credit to take from the customer's eWallet when the order is settled */
  walletAmount: money("wallet_amount").notNull().default("0"),
  /** What the customer still pays: Odoo's total less the store credit. Null until Odoo has the order */
  amountDue: money("amount_due"),
  /** Until when the order's units are held. Unpaid by then, the order expires */
  holdExpiresAt: at("hold_expires_at"),
  paidAt: at("paid_at"),
  paidAmount: money("paid_amount"),
  paymentProvider: varchar("payment_provider", { length: 32 }),
  paymentRef: varchar("payment_ref", { length: 191 }),
  /** When Odoo confirmed the paid order (and, with the bridge, recorded the payment) */
  settledAt: at("settled_at"),
  /** Why Odoo refused it, in Odoo's words */
  error: text("error"),
  createdBy: text("created_by"),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

// ── Operation ─────────────────────────────────────────────────────────────────

/** One row per change notice from Odoo: the same notice twice is processed once. */
export const odooNotices = pgTable("odoo_notices", {
  id: uuid("id").primaryKey().defaultRandom(),
  noticeId: varchar("notice_id", { length: 120 }).notNull().unique(),
  changes: integer("changes").notNull().default(0),
  receivedAt: at("received_at").notNull().defaultNow(),
});

export const SYNC_STATUSES = ["running", "done", "failed"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** A full walk of the catalog, a page per job. */
export const odooSyncRuns = pgTable("odoo_sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: varchar("status", { length: 20 }).$type<SyncStatus>().notNull().default("running"),
  /** Last `product.template` id read: the walk resumes after it */
  cursor: integer("cursor").notNull().default(0),
  products: integer("products").notNull().default(0),
  variants: integer("variants").notNull().default(0),
  /** Templates in the mirror that Odoo no longer has, hidden by this run */
  retired: integer("retired").notNull().default(0),
  error: text("error"),
  startedAt: at("started_at").notNull().defaultNow(),
  finishedAt: at("finished_at"),
});

export const CONFLICT_KINDS = [
  "duplicate_reference", // two variants that can be sold share one internal reference
  "variant_recreated", // Odoo gave a variant a new id; the mirror followed it by reference
  "currency_mismatch", // a document in a currency that is not the company's
  "payment_mismatch", // a payment for an order, of another amount or currency than it owes
  "paid_unavailable", // a payment arrived for an order whose units are no longer there
  "settle_failed", // Odoo refused to confirm a paid order
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export const odooConflicts = pgTable("odoo_conflicts", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: varchar("kind", { length: 40 }).$type<ConflictKind>().notNull(),
  /** What it is about: an internal reference, an Odoo id */
  reference: text("reference").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  /** Null while someone still has to look at it */
  resolvedAt: at("resolved_at"),
  resolvedBy: text("resolved_by"),
  createdAt: at("created_at").notNull().defaultNow(),
});

// ── Holds and carts ───────────────────────────────────────────────────────────

/** Units of a variant claimed by an order until it is paid or the hold runs out. */
export const odooHolds = pgTable("odoo_holds", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => odooOrders.id, { onDelete: "cascade" }),
  variantId: uuid("variant_id")
    .notNull()
    .references(() => odooVariants.id, { onDelete: "cascade" }),
  quantity: quantity("quantity").notNull(),
  expiresAt: at("expires_at").notNull(),
  releasedAt: at("released_at"),
  createdAt: at("created_at").notNull().defaultNow(),
});

export const odooCarts = pgTable("odoo_carts", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The order the cart became; a cart that has one takes no more changes */
  orderId: uuid("order_id").references(() => odooOrders.id, { onDelete: "set null" }),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

export const odooCartLines = pgTable("odoo_cart_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  cartId: uuid("cart_id")
    .notNull()
    .references(() => odooCarts.id, { onDelete: "cascade" }),
  variantId: uuid("variant_id")
    .notNull()
    .references(() => odooVariants.id, { onDelete: "cascade" }),
  quantity: quantity("quantity").notNull(),
  addedAt: at("added_at").notNull().defaultNow(),
});

export type OdooSettings = typeof odooSettings.$inferSelect;
export type OdooHold = typeof odooHolds.$inferSelect;
export type OdooCart = typeof odooCarts.$inferSelect;
export type OdooCategory = typeof odooCategories.$inferSelect;
export type OdooProduct = typeof odooProducts.$inferSelect;
export type OdooVariant = typeof odooVariants.$inferSelect;
export type OdooPartner = typeof odooPartners.$inferSelect;
export type OdooOrder = typeof odooOrders.$inferSelect;
export type OdooSyncRun = typeof odooSyncRuns.$inferSelect;
export type OdooConflict = typeof odooConflicts.$inferSelect;

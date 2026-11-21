/**
 * Odoo — operations (kon SDK, Kitsuden's docs/kons/README.md)
 * ============================================================================
 *
 * Public, read from the mirror (no call to Odoo):
 *   GET    /api/odoo/catalog/products          list-products
 *   GET    /api/odoo/catalog/products/:slug    get-product
 *   GET    /api/odoo/catalog/categories        list-categories
 *   GET    /api/odoo/catalog/summaries         list-product-summaries   (the sitemap)
 *
 * From Odoo, signed:
 *   POST   /api/odoo/webhook                   receive-notice
 *
 * The kon's team:
 *   GET    /api/odoo/status                    get-status
 *   POST   /api/odoo/connection/check          check-connection
 *   POST   /api/odoo/sync                      start-sync
 *   GET    /api/odoo/settings                  get-settings
 *   PATCH  /api/odoo/settings                  update-settings
 *   GET    /api/odoo/conflicts                 list-conflicts
 *   POST   /api/odoo/conflicts/:id/resolve     resolve-conflict
 *   GET    /api/odoo/orders                    list-orders
 *   POST   /api/odoo/orders                    create-order
 *   GET    /api/odoo/orders/:id                get-order
 *   POST   /api/odoo/carts                     create-cart
 *   GET    /api/odoo/carts/:id                 get-cart
 *   PUT    /api/odoo/carts/:id/lines           set-cart-line
 *   POST   /api/odoo/carts/:id/checkout        checkout-cart
 *   GET    /api/odoo/wallet                    get-wallet
 *   POST   /api/odoo/products/provision        provision-product
 *
 * Each operation is declared ONCE with `defineOperation`: from the declaration come the REST
 * route (422 validation, permission, idempotency and row security inherited), its OpenAPI 3.1
 * operation and its MCP tool (`odoo__<id>`).
 *
 * Rules for handlers (they run inside the request's RLS transaction):
 *   · queries IN SERIES (no `Promise.all` over the request's transaction);
 *   · a call to Odoo is slow and can fail: only the few operations that exist to ask Odoo
 *     something now (`check-connection`, `get-wallet`) make one. Everything else queues it.
 */

import { AppError, defineOperation, isUuid, operationsRouter, queue, type AnyOperation } from "@kitsuden/engine";
import { z } from "@kitsuden/engine/zod";
import type { KonContext } from "@kitsuden/shared";
import { desc, eq, isNull, sql } from "drizzle-orm";
import type { Hono } from "hono";

import { getProduct, listCategories, listProducts, listSummaries, MAX_PAGE_SIZE, SORTS } from "./odoo.catalog";
import { OdooError } from "./odoo.client";
import { KON_ID, odooLocation, OdooNotConnected } from "./odoo.connection";
import { checkoutCart, createCart, setCartLine, viewCart } from "./odoo.checkout";
import { takeOrder, walletOf } from "./odoo.orders";
import { registerOdooPolicy } from "./odoo.policy";
import { daysUntil } from "./odoo.queues";
import { odooConflicts, odooOrders, odooSettings, odooSyncRuns, CONFLICT_KINDS, ORDER_STATUSES, SYNC_STATUSES } from "./odoo.schema";
import { capabilitiesOf, clientFor, dbOf, loadSettings, QUEUES, sealSecret } from "./odoo.state";
import { mirrorCounts, startFullSync } from "./odoo.sync";
import { purgeUrlProblem, receiveNotice, SIGNATURE_HEADER } from "./odoo.webhook";

registerOdooPolicy();

export { KON_ID };

// ── Schemas: those of the route, the OpenAPI and the MCP tool ─────────────────

const Decimal = z.string().describe("Decimal number as a string, four decimals");
const Timestamp = z.string().datetime({ offset: true });
const Flag = z.enum(["true", "false"]);

const Price = z.object({ amount: Decimal, max: Decimal, currency: z.string().nullable() });
const CategoryRef = z.object({ id: z.string(), slug: z.string(), title: z.string() });
const Availability = z.enum(["InStock", "OutOfStock"]);

const Item = z.object({
  id: z.string().describe("Odoo's product template id"),
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  price: Price.nullable(),
  availability: Availability,
  quantity: Decimal.nullable().describe("Free-to-use units; null when Odoo does not count this product"),
  category: CategoryRef.nullable(),
  attributes: z.record(z.string(), z.array(z.string())),
  image: z.string().nullable(),
  updatedAt: Timestamp,
});

const Variant = z.object({
  id: z.guid(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  options: z.record(z.string(), z.string()),
  price: z.object({ amount: Decimal, currency: z.string().nullable() }).nullable(),
  availability: Availability,
  quantity: Decimal.nullable(),
});

const Facet = z.object({
  name: z.string(),
  values: z.array(z.object({ value: z.string(), label: z.string(), count: z.number().int() })),
});

const ProductQuery = z.object({
  search: z.string().trim().max(120).optional().describe("Text in the name or the internal reference"),
  category: z.string().max(200).optional().describe("A category's slug or Odoo id; its subcategories are included"),
  attributes: z
    .string()
    .max(1000)
    .optional()
    .describe('Attribute filters as "Name:Value" joined by commas: "Color:Red,Color:Blue,Size:M"'),
  priceMin: z.coerce.number().min(0).optional(),
  priceMax: z.coerce.number().min(0).optional(),
  inStock: Flag.optional(),
  sort: z.enum(SORTS).optional(),
  page: z.coerce.number().int().min(1).max(100_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  facets: Flag.optional().describe("Also count the matches in each category"),
});

/** `"Color:Red,Color:Blue,Size:M"` → `{ Color: ["Red", "Blue"], Size: ["M"] }` */
export function parseAttributes(value: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const pair of (value ?? "").split(",")) {
    const at = pair.indexOf(":");
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const option = pair.slice(at + 1).trim();
    if (name && option) (out[name] ??= []).push(option);
  }
  return out;
}

const Capabilities = z.object({
  stock: z.boolean(),
  website: z.boolean(),
  variants: z.boolean(),
  loyalty: z.boolean(),
  payments: z.boolean(),
  bridge: z.boolean(),
  checkedAt: Timestamp,
});

const SyncRun = z.object({
  id: z.guid(),
  status: z.enum(SYNC_STATUSES),
  products: z.number().int(),
  variants: z.number().int(),
  retired: z.number().int(),
  error: z.string().nullable(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});

const Settings = z.object({
  lang: z.string().nullable(),
  currency: z.string().nullable(),
  purgeUrl: z.string().nullable(),
  purgeSource: z.string(),
  keyExpiresOn: z.string().nullable(),
  hasWebhookSecret: z.boolean(),
  hasPurgeSecret: z.boolean(),
  holdMinutes: z.number().int(),
});

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A day as YYYY-MM-DD");

const SettingsEdit = z.object({
  lang: z
    .string()
    .regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "An Odoo language code such as es_ES")
    .nullable()
    .optional(),
  purgeUrl: z.string().max(2000).nullable().optional(),
  purgeSource: z.string().regex(/^[a-z][a-z0-9-]{0,59}$/).optional(),
  keyExpiresOn: Day.nullable().optional().describe("The last day the Odoo API key works"),
  webhookSecret: z.string().min(24).max(256).optional().describe("Write-only. Shared with Odoo, signs its notices"),
  purgeSecret: z.string().min(24).max(256).optional().describe("Write-only. Shared with the site, signs purge notices"),
  holdMinutes: z.number().int().min(2).max(120).optional().describe("How long an unpaid order holds its units"),
});

function settingsView(settings: Awaited<ReturnType<typeof loadSettings>>) {
  return {
    lang: settings.lang,
    currency: settings.currency,
    purgeUrl: settings.purgeUrl,
    purgeSource: settings.purgeSource,
    keyExpiresOn: settings.keyExpiresOn,
    hasWebhookSecret: settings.webhookSecret !== null,
    hasPurgeSecret: settings.purgeSecret !== null,
    holdMinutes: settings.holdMinutes,
  };
}

const Conflict = z.object({
  id: z.guid(),
  kind: z.enum(CONFLICT_KINDS),
  reference: z.string(),
  details: z.record(z.string(), z.unknown()),
  resolvedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});

const Customer = z.object({
  email: z.string().email().max(254),
  name: z.string().trim().min(1).max(200),
  phone: z.string().max(40).optional(),
  vat: z.string().max(40).optional(),
  street: z.string().max(200).optional(),
  city: z.string().max(120).optional(),
  zip: z.string().max(20).optional(),
  countryCode: z.string().length(2).optional().describe("ISO 3166-1 alpha-2"),
});

const OrderCreate = z.object({
  clientRef: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{3,119}$/)
    .describe("Your own reference for this order. The same one twice is the same order"),
  customer: Customer,
  lines: z
    .array(
      z.object({
        variantId: z.guid().optional(),
        sku: z.string().max(120).optional(),
        quantity: z.number().positive().max(100_000),
      })
    )
    .min(1)
    .max(200),
  note: z.string().max(2000).optional(),
  confirm: z.boolean().optional().describe("Confirm it in Odoo at once. Needs the bridge module; otherwise it stays a quotation"),
  walletAmount: z
    .number()
    .min(0)
    .max(1_000_000)
    .optional()
    .describe("Store credit to take from the customer's eWallet. Checked against Odoo now; needs the bridge module"),
});

/** Checks in Odoo that the customer has the store credit asked for. */
async function checkWallet(ctx: KonContext, email: string, amount: number | undefined): Promise<void> {
  if (!amount) return;
  let wallet;
  try {
    wallet = await walletOf(ctx, await clientFor(ctx, "check a customer's store credit before an order"), email);
  } catch (error) {
    asHttp(error);
  }
  if (!wallet || Number(wallet.balance) < amount) {
    throw AppError.conflict(`The customer has ${wallet?.balance ?? "no"} store credit; ${amount.toFixed(2)} was asked.`);
  }
}

const CheckoutCart = OrderCreate.omit({ lines: true });

const CartLine = z.object({
  variantId: z.guid(),
  productSlug: z.string(),
  name: z.string(),
  sku: z.string().nullable(),
  options: z.record(z.string(), z.string()),
  quantity: Decimal,
  unitPrice: Decimal.nullable(),
  subtotal: Decimal.nullable(),
  currency: z.string().nullable(),
  available: Decimal.nullable(),
  orderable: z.boolean(),
});

const Cart = z.object({
  id: z.guid(),
  orderId: z.string().nullable(),
  lines: z.array(CartLine),
  estimatedTotal: Decimal,
  currency: z.string().nullable(),
  orderable: z.boolean(),
  updatedAt: Timestamp,
});

const Order = z.object({
  id: z.guid(),
  clientRef: z.string(),
  odooId: z.number().int().nullable(),
  odooName: z.string().nullable(),
  status: z.enum(ORDER_STATUSES),
  customer: Customer,
  lines: z.array(
    z.object({
      odooProductId: z.number().int(),
      variantId: z.string().nullable(),
      sku: z.string().nullable(),
      name: z.string(),
      quantity: z.string(),
      unitPrice: z.string().nullable(),
    })
  ),
  note: z.string().nullable(),
  amountUntaxed: Decimal.nullable(),
  amountTax: Decimal.nullable(),
  amountTotal: Decimal.nullable(),
  currency: z.string().nullable(),
  paymentUrl: z.string().nullable(),
  walletAmount: Decimal,
  amountDue: Decimal.nullable().describe("What the customer still pays: Odoo's total less the store credit. Null until Odoo has the order"),
  holdExpiresAt: Timestamp.nullable(),
  paidAt: Timestamp.nullable(),
  paidAmount: Decimal.nullable(),
  paymentProvider: z.string().nullable(),
  paymentRef: z.string().nullable(),
  settledAt: Timestamp.nullable(),
  error: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

const ParamId = z.object({ id: z.string().describe("Id (uuid; anything else is a 404)") });
const Paging = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

/** One row more than asked is read, to know whether another page exists without counting. */
function paged<T>(rows: T[], limit: number): { docs: T[]; hasMore: boolean } {
  return { docs: rows.slice(0, limit), hasMore: rows.length > limit };
}

/** An Odoo failure as an HTTP one, in words a person setting this up can act on. */
function asHttp(error: unknown): never {
  if (error instanceof OdooNotConnected) throw AppError.conflict(error.message);
  if (error instanceof OdooError) {
    throw AppError.conflict(
      error.kind === "auth"
        ? "Odoo refused the API key: store a new connection."
        : error.retryable
          ? "Odoo did not answer. Try again in a moment."
          : `Odoo: ${error.message}`
    );
  }
  throw error;
}

/** The kon's operations, with their injected context. */
export function odooOperations(ctx: KonContext): AnyOperation[] {
  const db = dbOf(ctx);

  return [
    // ── Public catalog ───────────────────────────────────────────────────────
    defineOperation({
      id: "list-products",
      method: "GET",
      route: "/catalog/products",
      summary: "List the catalog",
      description:
        "Published products from the mirror of Odoo, a page at a time, with filters. Never calls Odoo. `total` counts every match, not the page.",
      access: "public",
      input: { query: ProductQuery },
      output: {
        schema: z.object({
          docs: z.array(Item),
          total: z.number().int(),
          page: z.number().int(),
          pageSize: z.number().int(),
          pages: z.number().int(),
          facets: z.array(Facet).optional(),
        }),
      },
      handle: async ({ query }, { c }) => {
        c.header("Cache-Control", "public, max-age=30, stale-while-revalidate=300");
        return listProducts(ctx, db, {
          search: query.search,
          category: query.category,
          attributes: parseAttributes(query.attributes),
          priceMin: query.priceMin,
          priceMax: query.priceMax,
          inStock: query.inStock === "true",
          sort: query.sort,
          page: query.page,
          pageSize: query.pageSize,
          facets: query.facets === "true",
        });
      },
    }),

    defineOperation({
      id: "get-product",
      method: "GET",
      route: "/catalog/products/:slug",
      summary: "Get one product",
      description:
        "One published product with its variants. The Odoo id at the end of the slug is what is looked up, so a link made before a rename still works; the answer carries the current slug.",
      access: "public",
      input: { params: z.object({ slug: z.string().max(200) }) },
      output: { schema: Item.extend({ variants: z.array(Variant) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }, { c }) => {
        const product = await getProduct(ctx, db, params.slug);
        if (!product) throw AppError.notFound("Not found");
        c.header("Cache-Control", "public, max-age=30, stale-while-revalidate=300");
        return product;
      },
    }),

    defineOperation({
      id: "list-categories",
      method: "GET",
      route: "/catalog/categories",
      summary: "List the categories",
      description: "Every product category, parents before children, with the published products directly in each.",
      access: "public",
      unpaginated: "A shop's category tree is small and is needed whole to draw a menu.",
      output: { schema: z.object({ docs: z.array(CategoryRef.extend({ parentId: z.string().nullable(), count: z.number().int() })) }) },
      handle: async (_input, { c }) => {
        c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
        return { docs: await listCategories(db) };
      },
    }),

    defineOperation({
      id: "list-product-summaries",
      method: "GET",
      route: "/catalog/summaries",
      summary: "List slugs and dates for a sitemap",
      description:
        "Every published product's slug and last change, in a stable order. Pass the last `id` you got as `after` to read on; an answer shorter than `limit` is the end.",
      access: "public",
      input: {
        query: z.object({
          after: z.coerce.number().int().min(0).optional(),
          limit: z.coerce.number().int().min(1).max(5000).optional(),
        }),
      },
      output: { schema: z.object({ docs: z.array(z.object({ id: z.string(), slug: z.string(), updatedAt: Timestamp })) }) },
      handle: async ({ query }) => ({ docs: await listSummaries(db, query.after ?? 0, query.limit ?? 1000) }),
    }),

    // ── From Odoo ────────────────────────────────────────────────────────────
    defineOperation({
      id: "receive-notice",
      method: "POST",
      route: "/webhook",
      summary: "Receive a change notice from Odoo",
      description: `Odoo says which records changed; they are read back from Odoo through the queue. The raw body must be signed: \`${SIGNATURE_HEADER}: sha256=<HMAC-SHA256 hex>\` with the webhook secret. A notice already seen is acknowledged and dropped.`,
      access: "public",
      mcp: { exclude: "Called by Odoo with a signature over the raw body, not by an agent." },
      output: { schema: z.object({ accepted: z.number().int(), duplicate: z.boolean() }) },
      errors: ["KITSUDEN_E_UNAUTHENTICATED", "KITSUDEN_E_BAD_REQUEST", "KITSUDEN_E_CONFLICT"],
      // No `input.body`: the signature is over the bytes Odoo sent, so they are read untouched.
      handle: async (_input, { c }) => receiveNotice(ctx, await c.req.text(), c.req.header(SIGNATURE_HEADER)),
    }),

    // ── State and settings ───────────────────────────────────────────────────
    defineOperation({
      id: "get-status",
      method: "GET",
      route: "/status",
      summary: "See the state of the Odoo connection",
      description:
        "Where Odoo is, what it has installed, how fresh the mirror is, the last full walk, open conflicts, and how long the API key has left. Does not call Odoo.",
      access: "session",
      permission: { policy: { resource: "odoo-admin", action: "view" } },
      output: {
        schema: z.object({
          configured: z.boolean(),
          problem: z.string().nullable(),
          host: z.string().nullable(),
          capabilities: Capabilities.nullable(),
          currency: z.string().nullable(),
          mirror: z.object({ products: z.number().int(), published: z.number().int(), variants: z.number().int() }),
          lastNoticeAt: Timestamp.nullable(),
          lastFullSyncAt: Timestamp.nullable(),
          lastRun: SyncRun.nullable(),
          openConflicts: z.number().int(),
          pendingOrders: z.number().int(),
          failedOrders: z.number().int(),
          keyExpiresOn: z.string().nullable(),
          keyDaysLeft: z.number().int().nullable(),
        }),
      },
      handle: async () => {
        const location = odooLocation();
        const settings = await loadSettings(db);
        const mirror = await mirrorCounts(ctx);
        const [lastRun] = await db.select().from(odooSyncRuns).orderBy(desc(odooSyncRuns.startedAt)).limit(1);
        const [conflicts] = await db
          .select({ open: sql<number>`count(*)::int` })
          .from(odooConflicts)
          .where(isNull(odooConflicts.resolvedAt));
        const [orders] = await db
          .select({
            pending: sql<number>`count(*) FILTER (WHERE ${odooOrders.status} = 'pending')::int`,
            failed: sql<number>`count(*) FILTER (WHERE ${odooOrders.status} = 'failed')::int`,
          })
          .from(odooOrders);
        const { fields: _fields, ...capabilities } = settings.capabilities ?? { fields: {} };
        return {
          configured: !("problem" in location),
          problem: "problem" in location ? location.problem : null,
          host: "problem" in location ? null : location.host,
          capabilities: settings.capabilities ? capabilities : null,
          currency: settings.currency,
          mirror,
          lastNoticeAt: settings.lastNoticeAt,
          lastFullSyncAt: settings.lastFullSyncAt,
          lastRun: lastRun ?? null,
          openConflicts: conflicts?.open ?? 0,
          pendingOrders: orders?.pending ?? 0,
          failedOrders: orders?.failed ?? 0,
          keyExpiresOn: settings.keyExpiresOn,
          keyDaysLeft: settings.keyExpiresOn ? daysUntil(settings.keyExpiresOn, new Date()) : null,
        };
      },
    }),

    defineOperation({
      id: "check-connection",
      method: "POST",
      route: "/connection/check",
      summary: "Ask Odoo what it has installed",
      description:
        "Calls Odoo with the stored connection and records which modules and fields this instance has (stock, eCommerce, variants, loyalty, invoicing, the bridge module). Run it after storing the connection or installing a module in Odoo.",
      access: "session",
      permission: { policy: { resource: "odoo-admin", action: "update" } },
      output: { schema: z.object({ capabilities: Capabilities, currency: z.string().nullable() }) },
      errors: ["KITSUDEN_E_CONFLICT"],
      handle: async () => {
        try {
          const client = await clientFor(ctx, "check the Odoo connection");
          const found = await capabilitiesOf(db, client, { refresh: true });
          const { fields: _fields, ...capabilities } = found.capabilities;
          return { capabilities, currency: found.currency };
        } catch (error) {
          return asHttp(error);
        }
      },
    }),

    defineOperation({
      id: "start-sync",
      method: "POST",
      route: "/sync",
      summary: "Walk the whole catalog",
      description:
        "Queues a full read of Odoo's products into the mirror, a page per job. Answers the walk already running if there is one. It also runs every night by itself.",
      access: "session",
      permission: { policy: { resource: "odoo-admin", action: "update" } },
      output: { status: 202, schema: z.object({ run: SyncRun, started: z.boolean() }) },
      handle: async () => startFullSync(ctx),
    }),

    defineOperation({
      id: "get-settings",
      method: "GET",
      route: "/settings",
      summary: "Read the settings",
      description: "The kon's settings. Secrets are never returned: only whether one is stored.",
      access: "session",
      permission: { policy: { resource: "odoo-admin", action: "view" } },
      output: { schema: Settings },
      handle: async () => {
        return settingsView(await loadSettings(db));
      },
    }),

    defineOperation({
      id: "update-settings",
      method: "PATCH",
      route: "/settings",
      summary: "Change the settings",
      description:
        "Changes the given settings. `webhookSecret` and `purgeSecret` are write-only and stored sealed; they need the host's secrets key. The Odoo address and its API key are not here: the address is the ODOO_URL environment variable and the key is a connection.",
      access: "session",
      permission: { policy: { resource: "odoo-admin", action: "update" } },
      sensitive: true,
      input: { body: SettingsEdit },
      output: { schema: Settings },
      errors: ["KITSUDEN_E_CONFLICT", "KITSUDEN_E_VALIDATION"],
      handle: async ({ body }) => {
        if (typeof body.purgeUrl === "string") {
          const problem = purgeUrlProblem(body.purgeUrl);
          if (problem) throw AppError.validation(problem);
        }
        const { webhookSecret, purgeSecret, ...plain } = body;
        await db
          .update(odooSettings)
          .set({
            ...plain,
            ...(webhookSecret ? { webhookSecret: sealSecret(ctx, webhookSecret) } : {}),
            ...(purgeSecret ? { purgeSecret: sealSecret(ctx, purgeSecret) } : {}),
            updatedAt: new Date(),
          })
          .where(eq(odooSettings.id, 1));
        return settingsView(await loadSettings(db));
      },
    }),

    // ── Conflicts ────────────────────────────────────────────────────────────
    defineOperation({
      id: "list-conflicts",
      method: "GET",
      route: "/conflicts",
      summary: "List what the sync could not settle",
      description:
        "Problems a person has to look at in Odoo: one internal reference on two variants, a document in a currency that is not the company's. Open ones first.",
      access: "session",
      permission: { policy: { resource: "odoo-admin", action: "view" } },
      input: { query: Paging },
      output: { schema: z.object({ docs: z.array(Conflict), hasMore: z.boolean() }) },
      handle: async ({ query }) => {
        const limit = query.limit ?? 50;
        const rows = await db
          .select()
          .from(odooConflicts)
          .orderBy(sql`${odooConflicts.resolvedAt} IS NOT NULL`, desc(odooConflicts.createdAt), desc(odooConflicts.id))
          .limit(limit + 1)
          .offset(query.offset ?? 0);
        return paged(rows, limit);
      },
    }),

    defineOperation({
      id: "resolve-conflict",
      method: "POST",
      route: "/conflicts/:id/resolve",
      summary: "Mark a conflict as looked at",
      description: "Closes a conflict. If the cause is still in Odoo, the next sync opens it again.",
      access: "session",
      permission: { policy: { resource: "odoo-admin", action: "update" } },
      input: { params: ParamId },
      output: { schema: Conflict },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }, { user }) => {
        if (!isUuid(params.id)) throw AppError.notFound("Not found");
        const [row] = await db
          .update(odooConflicts)
          .set({ resolvedAt: new Date(), resolvedBy: user?.id ?? null })
          .where(eq(odooConflicts.id, params.id))
          .returning();
        if (!row) throw AppError.notFound("Not found");
        return row;
      },
    }),

    // ── Orders ───────────────────────────────────────────────────────────────
    defineOperation({
      id: "list-orders",
      method: "GET",
      route: "/orders",
      summary: "List orders taken here",
      description: "Orders made through this kon, newest first, with what Odoo answered for each.",
      access: "session",
      permission: { policy: { resource: "odoo-order", action: "view" } },
      input: { query: Paging.extend({ status: z.enum(ORDER_STATUSES).optional() }) },
      output: { schema: z.object({ docs: z.array(Order), hasMore: z.boolean() }) },
      handle: async ({ query }) => {
        const limit = query.limit ?? 50;
        const rows = await db
          .select()
          .from(odooOrders)
          .where(query.status ? eq(odooOrders.status, query.status) : undefined)
          .orderBy(desc(odooOrders.createdAt), desc(odooOrders.id))
          .limit(limit + 1)
          .offset(query.offset ?? 0);
        return paged(rows, limit);
      },
    }),

    defineOperation({
      id: "create-order",
      method: "POST",
      route: "/orders",
      summary: "Take an order and make it in Odoo",
      description:
        "Checks the lines against the catalog, HOLDS their units (409 naming the line when there are not enough), stores the order as `pending` and queues it for Odoo. Read it again for its number, total and `amountDue`, then open the payment with kon-payments (metadata `odooOrderId`). Unpaid when the hold runs out, it expires. Idempotent on `clientRef`: the same reference answers the same order (200 instead of 201).",
      access: "session",
      permission: { policy: { resource: "odoo-order", action: "create" } },
      input: { body: OrderCreate },
      output: { status: 201, schema: Order, otherStatuses: [200] },
      errors: ["KITSUDEN_E_VALIDATION", "KITSUDEN_E_CONFLICT"],
      handle: async ({ body }, { c, user }) => {
        await checkWallet(ctx, body.customer.email, body.walletAmount);
        const { order, created } = await takeOrder(ctx, body, user?.id ?? null);
        return created ? order : c.json(order, 200);
      },
    }),

    // ── Carts ────────────────────────────────────────────────────────────────
    defineOperation({
      id: "create-cart",
      method: "POST",
      route: "/carts",
      summary: "Open a cart",
      description: "An empty cart. For the shop's backend, which keeps the cart id in the visitor's session.",
      access: "session",
      permission: { policy: { resource: "odoo-order", action: "create" } },
      output: { status: 201, schema: Cart },
      handle: async () => createCart(db),
    }),

    defineOperation({
      id: "get-cart",
      method: "GET",
      route: "/carts/:id",
      summary: "Read a cart",
      description:
        "The cart with each line's current price and what is available now (Odoo's free quantity less what other orders hold). `orderable` says whether it can be checked out as it is.",
      access: "session",
      permission: { policy: { resource: "odoo-order", action: "view" } },
      input: { params: ParamId },
      output: { schema: Cart },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }) => {
        const cart = isUuid(params.id) ? await viewCart(db, params.id) : null;
        if (!cart) throw AppError.notFound("Not found");
        return cart;
      },
    }),

    defineOperation({
      id: "set-cart-line",
      method: "PUT",
      route: "/carts/:id/lines",
      summary: "Set how many of a variant the cart has",
      description: "Sets the quantity of a variant, by id or internal reference; 0 takes it out. A cart that became an order is closed (409).",
      access: "session",
      permission: { policy: { resource: "odoo-order", action: "create" } },
      input: {
        params: ParamId,
        body: z.object({
          variantId: z.guid().optional(),
          sku: z.string().max(120).optional(),
          quantity: z.number().min(0).max(100_000),
        }),
      },
      output: { schema: Cart },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_VALIDATION", "KITSUDEN_E_CONFLICT"],
      handle: async ({ params, body }) => {
        const cart = isUuid(params.id) ? await setCartLine(db, params.id, body) : null;
        if (!cart) throw AppError.notFound("Not found");
        return cart;
      },
    }),

    defineOperation({
      id: "checkout-cart",
      method: "POST",
      route: "/carts/:id/checkout",
      summary: "Turn a cart into an order, holding its units",
      description:
        "Like `create-order` with the cart's lines: holds the units (409 naming the line when there are not enough), stores the order and queues it for Odoo. The cart closes. Idempotent on `clientRef`.",
      access: "session",
      permission: { policy: { resource: "odoo-order", action: "create" } },
      input: { params: ParamId, body: CheckoutCart },
      output: { status: 201, schema: Order, otherStatuses: [200] },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_VALIDATION", "KITSUDEN_E_CONFLICT"],
      handle: async ({ params, body }, { c, user }) => {
        if (!isUuid(params.id)) throw AppError.notFound("Not found");
        await checkWallet(ctx, body.customer.email, body.walletAmount);
        const result = await checkoutCart(ctx, params.id, body, user?.id ?? null);
        if (!result) throw AppError.notFound("Not found");
        return result.created ? result.order : c.json(result.order, 200);
      },
    }),

    defineOperation({
      id: "get-order",
      method: "GET",
      route: "/orders/:id",
      summary: "Get one order",
      description: "One order by id, with its state, Odoo's number and totals, and the payment page when Odoo gave one.",
      access: "session",
      permission: { policy: { resource: "odoo-order", action: "view" } },
      input: { params: ParamId },
      output: { schema: Order },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }) => {
        if (!isUuid(params.id)) throw AppError.notFound("Not found");
        const [row] = await db.select().from(odooOrders).where(eq(odooOrders.id, params.id)).limit(1);
        if (!row) throw AppError.notFound("Not found");
        return row;
      },
    }),

    // ── Store credit and products on demand ──────────────────────────────────
    defineOperation({
      id: "get-wallet",
      method: "GET",
      route: "/wallet",
      summary: "Read a customer's store credit",
      description:
        "The eWallet balance of the Odoo customer with that e-mail, asked from Odoo now. Card codes are never returned. Needs Odoo's loyalty module.",
      access: "session",
      permission: { policy: { resource: "odoo-order", action: "view" } },
      input: { query: z.object({ email: z.string().email().max(254) }) },
      output: {
        schema: z.object({
          balance: Decimal,
          currency: z.string().nullable(),
          cards: z.array(z.object({ id: z.number().int(), balance: Decimal, expiresOn: z.string().nullable() })),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      handle: async ({ query }) => {
        let wallet;
        try {
          wallet = await walletOf(ctx, await clientFor(ctx, "read a customer's store credit"), query.email);
        } catch (error) {
          return asHttp(error);
        }
        if (!wallet) throw AppError.notFound("No customer with that e-mail in Odoo");
        return wallet;
      },
    }),

    defineOperation({
      id: "provision-product",
      method: "POST",
      route: "/products/provision",
      summary: "Create a product in Odoo if it is not there",
      description:
        "Queues the creation of a product with this internal reference, unless Odoo already has one, and then reads it into the mirror. For catalogs too large to keep whole in Odoo: a product is created the day there is one to sell.",
      access: "session",
      permission: { policy: { resource: "odoo-admin", action: "update" } },
      input: {
        body: z.object({
          sku: z.string().trim().min(1).max(120),
          name: z.string().trim().min(1).max(300),
          price: z.number().min(0).max(1_000_000_000),
          barcode: z.string().max(60).optional(),
          categoryOdooId: z.number().int().positive().optional(),
        }),
      },
      output: { status: 202, schema: z.object({ queued: z.boolean() }) },
      handle: async ({ body }) => {
        await queue.dispatch(QUEUES.push, "provision", body, { dedupeKey: `provision:${body.sku}`, attempts: 5 });
        return { queued: true };
      },
    }),
  ];
}

/** The REST router, generated from the operations. */
export function createOdooRouter(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, odooOperations(ctx), ctx);
}

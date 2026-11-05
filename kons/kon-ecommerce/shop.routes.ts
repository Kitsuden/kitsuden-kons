/**
 * Store — HTTP API
 * ============================================================================
 *
 * ── THE DIVISION THAT MATTERS ──────────────────────────────────────────────
 *
 * There are TWO audiences and they are separated by route prefix, not by
 * scattered checks inside the handlers:
 *
 *   `/products`, `/orders`  → PUBLIC. The catalog is what is sold and the
 *                             purchase is made by someone without an account.
 *   `/admin/*`              → TEAM. A single `requireAuth` covers the whole
 *                             prefix and each route also asks for its policy.
 *
 * At a glance you can see what is accessible without a session. With mixed routes,
 * adding a new one and forgetting the middleware goes unnoticed until someone listed
 * everyone's orders.
 *
 * ── WHAT THE BUYER CANNOT DECIDE ───────────────────────────────────────────
 *
 * `POST /orders` does NOT accept from the body: prices, `shippingCents`, `ownerId` or
 * `status`. Prices are re-read from the catalog by `createOrder`; the rest is set
 * here. The least obvious case is shipping: `calculateTotals` does
 * `subtotal + shippingCents` without checking the sign, so a `-9900` from the
 * client would be a discount. The amount comes from the kon's configuration.
 *
 * ── STATE IS NOT ASSIGNED, IT IS TRANSITIONED ──────────────────────────────
 *
 * `POST /admin/orders/:id/status` goes through `canTransition`. Without that, a normal
 * PATCH would allow taking a refunded order back to "paid", and
 * that is only discovered by auditing the accounting months later.
 *
 * ── THE BUYER'S OWN ROUTES (0008) ──────────────────────────────────────────
 *
 * `/orders/:id`, `/orders/:id/checkout`, `/orders/:id/downloads/:item` and `/my-orders` are
 * public, and each one opens ONE buyer's data only with a token (shop.access.ts): the order's own,
 * or a "my orders" link sent to the order's email. A missing or wrong token answers 404, the same
 * as an order that does not exist, so the routes say nothing about which orders exist.
 */

import {
  AppError,
  mail,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { konSetting } from "@kitsuden/shared";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { require, KON_ID, policy, registry, onTheRow } from "./operations";

import { emailOfLink, hashToken, issueLink, LINK_MINUTES, newToken, tokenOpensOrder } from "./shop.access";
import { entitlementsOf, grantEntitlements, takeDownload, type DeliveryResult } from "./shop.delivery";
import { myOrdersPageUrl, registerShopMails, shopMailsActive } from "./shop.mails";
import { notifyReceived, notifyStatus, publicSite } from "./shop.notify";
import { releaseExpiredReservations, canTransition } from "./shop.orders";
import {
  applyStatus,
  loadPaymentGateway,
  PAID_STATUSES,
  type ShopPaymentGateway,
} from "./shop.payments";
import {
  shopLicenseKeys,
  shopOrderItems,
  shopOrders,
  shopProductFiles,
  shopProducts,
  shopPromotions,
  shopVariants,
  type ShopOrder,
} from "./shop.schema";
import { createOrder, idempotencyFingerprint } from "./shop.service";

/**
 * `c.get(k)` on a Hono without typed `Variables` resolves to `never`, and the
 * public signature the loader requires is a bare `Hono`. It is typed here instead
 * of scattering an `as any` over every handler.
 */
function userOf(c: unknown): AuthzUser | null {
  return ((c as { get(k: string): unknown }).get("user") ?? null) as AuthzUser | null;
}

// ── Input ───────────────────────────────────────────────────────────────────

const STATUSES = [
  "pending",
  "paid",
  "in_production",
  "ready",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
] as const;

/**
 * Shipping address: ALLOWLIST with lengths. Before it was
 * `z.record(z.unknown())`: any shape and any size ended up in a
 * jsonb that the team later reads in the panel.
 */
const AddressInput = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(120),
  postalCode: z.string().trim().min(1).max(20),
  region: z.string().trim().max(120).optional(),
  country: z.string().trim().min(2).max(56),
  phone: z.string().trim().max(40).optional(),
});

/**
 * Maximum units per variant in ONE order, adding up repeated lines, and in
 * total. It used to be 999 × 50 variants: with unpaid anonymous orders, a few
 * per minute left the store without stock (an earlier audit). A
 * store that sells wholesale raises it with `SHOP_MAX_UNITS_PER_VARIANT`.
 */
const MAX_UNITS_PER_VARIANT = Math.max(
  1,
  Number(process.env.SHOP_MAX_UNITS_PER_VARIANT) || 20
);
const MAX_UNITS_PER_ORDER = MAX_UNITS_PER_VARIANT * 5;

const OrderInput = z.object({
  items: z
    .array(
      z.object({
        variantId: z.string().min(1).max(64),
        // The cap is not bureaucracy: without it, a single request can ask for
        // millions of units and lock the whole store's stock.
        quantity: z.number().int().min(1).max(MAX_UNITS_PER_VARIANT),
      })
    )
    .min(1)
    .max(50)
    .refine((items) => items.reduce((n, i) => n + i.quantity, 0) <= MAX_UNITS_PER_ORDER, {
      message: `At most ${MAX_UNITS_PER_ORDER} units per order`,
    }),
  customerEmail: z.string().email().max(320),
  customerName: z.string().max(200).optional(),
  fulfillmentType: z.enum(["digital", "shipping", "pickup"]),
  shippingAddress: AddressInput.optional(),
  notes: z.string().max(2000).optional(),
  /** A discount code. Only the code: the amount is the server's (shop.promotions.ts). */
  couponCode: z.string().trim().min(1).max(64).optional(),
});

/**
 * Merges the lines that repeat a variant. Without this, `[{v,999},{v,999},…]`
 * skipped the per-line cap: fifty lines of the same mug were 49,950
 * units in one order.
 */
export function groupLines(
  items: { variantId: string; quantity: number }[]
): { variantId: string; quantity: number }[] | null {
  const sum = new Map<string, number>();
  for (const i of items) sum.set(i.variantId, (sum.get(i.variantId) ?? 0) + i.quantity);
  const lines = [...sum].map(([variantId, quantity]) => ({ variantId, quantity }));
  return lines.some((l) => l.quantity > MAX_UNITS_PER_VARIANT) ? null : lines;
}

/** `Idempotency-Key`: opaque, short, with no odd characters. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

const ProductInput = z.object({
  // The slug goes in a public URL: it is restricted instead of escaped afterward.
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Only lowercase letters, numbers and hyphens."),
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  kind: z.enum(["digital", "physical"]).default("digital"),
  mediaId: z.string().max(64).optional(),
  active: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const VariantInput = z.object({
  name: z.string().min(1).max(120).default("Standard"),
  sku: z.string().max(80).optional(),
  priceCents: z.number().int().min(0),
  currency: z.string().length(3).default("EUR"),
  // `null` is infinite stock — what distinguishes a file from a mug.
  // `.nullable()` without `.optional()` would force sending it always.
  stock: z.number().int().min(0).nullable().optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  active: z.boolean().default(true),
  /** How a paid unit is delivered beyond its files: none, a generated key, or one from the pool. */
  licenseMode: z.enum(["none", "generate", "pool"]).optional(),
  /** Downloads per file and order; null is no limit. */
  downloadLimit: z.number().int().min(1).max(1000).nullable().optional(),
  /** Days downloads stay open after paying; null is forever. */
  downloadDays: z.number().int().min(1).max(3650).nullable().optional(),
});

const StatusChange = z.object({
  status: z.enum(STATUSES),
  /** Opaque payment reference, if the transition comes from charging. */
  paymentRef: z.string().max(200).optional(),
  /** For `shipped`: what the carrier gave. The URL must be http(s). */
  trackingNumber: z.string().trim().max(120).optional(),
  trackingUrl: z
    .string()
    .url()
    .max(500)
    .refine((u) => /^https?:\/\//i.test(u), "Only http(s) links")
    .optional(),
});

/** The order token: a header (preferred) or `?token=` (links in emails). Never in the body. */
const TokenQuery = z.object({ token: z.string().max(200).optional() }).passthrough();

const CheckoutInput = z.object({
  provider: z.string().min(1).max(32),
  successUrl: z.string().url().max(2000),
  cancelUrl: z.string().url().max(2000).optional(),
});

const LinkRequest = z.object({ email: z.string().trim().email().max(320) });

const FileInput = z.object({
  /** A file of the core's media library. */
  mediaId: z.string().min(1).max(64),
  /** Only this variant delivers it; absent, every variant of the product does. */
  variantId: z.string().min(1).max(64).optional(),
  /** What the buyer sees; by default, the media's original name. */
  filename: z.string().trim().min(1).max(200).optional(),
});

const LicenseKeysInput = z.object({
  keys: z.array(z.string().trim().min(1).max(200)).min(1).max(1000),
});

const PromotionInput = z
  .object({
    code: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, "Letters, numbers, - and _ only."),
    description: z.string().max(500).optional(),
    active: z.boolean().default(true),
    applicationType: z.enum(["percentage", "fixed"]),
    applicationTarget: z.enum(["order", "shipping"]).default("order"),
    value: z.number().int().min(1),
    currency: z.string().length(3).optional(),
    minSubtotalCents: z.number().int().min(0).nullable().optional(),
    productIds: z.array(z.string().min(1).max(64)).max(200).nullable().optional(),
    startsAt: z.string().datetime({ offset: true }).nullable().optional(),
    endsAt: z.string().datetime({ offset: true }).nullable().optional(),
    usageLimit: z.number().int().min(1).nullable().optional(),
  })
  .refine((p) => p.applicationType !== "percentage" || p.value <= 100, {
    message: "A percentage is at most 100.",
    path: ["value"],
  })
  .refine((p) => p.applicationType !== "fixed" || !!p.currency, {
    message: "A fixed amount needs its currency.",
    path: ["currency"],
  });

/** The editable part of a promotion: everything but the code, which orders have frozen. */
const PromotionPatch = z.object({
  description: z.string().max(500).optional(),
  active: z.boolean().optional(),
  minSubtotalCents: z.number().int().min(0).nullable().optional(),
  productIds: z.array(z.string().min(1).max(64)).max(200).nullable().optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  usageLimit: z.number().int().min(1).nullable().optional(),
});

/** Validates the body or throws a 422 with ALL the problems, not just the first. */
function read<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw AppError.validation(
      "The form data is not valid.",
      r.error.issues.map((i) => ({ field: i.path.join("."), problem: i.message }))
    );
  }
  return r.data;
}

// ── Declared input and output (OpenAPI and MCP) ─────────────────────────────
//
// The BODIES are still validated by the handler with `read()` (`validatesHandler`):
// so the 422 is the usual one ("The form data is not valid." with
// ALL the problems), extra fields are still discarded without error
// — a buyer who sends `shippingCents` or `ownerId` gets nothing, but
// does not get a 422 either — and the panel's policy goes BEFORE the body, as before.

const ParamId = z.object({ id: z.string() });
const ItemParams = z.object({ id: z.string(), item: z.string() });
const ParamSlug = z.object({ slug: z.string() });
const PageQuery = z
  .object({ limit: z.string().optional(), offset: z.string().optional() })
  .passthrough();
const OrdersQuery = z
  .object({ status: z.string().optional(), limit: z.string().optional() })
  .passthrough();

/** The TRIMMED shape of the catalog (`withVariants`). */
const PublicProduct = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    variants: z.array(z.object({ id: z.string() }).passthrough()),
  })
  .passthrough();
const Row = z.object({ id: z.string() }).passthrough();
const CreatedOrder = z.object({
  ok: z.literal(true),
  orderId: z.string(),
  number: z.unknown(),
  totalCents: z.number(),
  discountCents: z.number().optional(),
  /** The buyer's token for this order: shown once, keep it (also in the confirmation email). */
  accessToken: z.string().optional(),
});

/** 201 when creating the order, 200 on a retry with the same `Idempotency-Key`. */
const ORDER_OUTPUT = {
  schema: CreatedOrder,
  status: 201 as const,
  otherStatuses: [200 as const],
  description: "Created (201) or repeated with the same Idempotency-Key (200)",
};

// ── Router ──────────────────────────────────────────────────────────────────

/** What the router can be given instead of finding it itself: tests pass a fake payment gateway. */
export interface ShopDependencies {
  /** `null`: no payments (orders are marked paid by hand). Absent: kon-payments, loaded at runtime. */
  payments?: ShopPaymentGateway | null;
}

export function createShopRouter(ctx: KonContext, deps: ShopDependencies = {}): Hono {
  return operationsRouter(KON_ID, shopOperations(ctx, deps), ctx);
}

export function shopOperations(ctx: KonContext, deps: ShopDependencies = {}): AnyOperation[] {
  const shop = registry();
  const db = ctx.db.instance;
  registerShopMails();

  let gateway: Promise<ShopPaymentGateway | null> | null = null;
  const payments = (): Promise<ShopPaymentGateway | null> =>
    "payments" in deps ? Promise.resolve(deps.payments ?? null) : (gateway ??= loadPaymentGateway());

  /** The buyer's token: `X-Order-Token`, or `?token=` from a link in an email. */
  const tokenOf = (c: { req: { header(n: string): string | undefined; query(n: string): string | undefined } }) =>
    c.req.header("x-order-token") ?? c.req.query("token") ?? undefined;

  /**
   * The order this token opens, or a 404 — the same 404 for an order that does not exist and for
   * a wrong token, so the route says nothing about which orders exist.
   */
  const orderForBuyer = async (c: Parameters<typeof tokenOf>[0], id: string): Promise<ShopOrder> => {
    const order = await asSystem(async () => {
      const [row] = await db.select().from(shopOrders).where(eq(shopOrders.id, id)).limit(1);
      if (!row) return null;
      return (await tokenOpensOrder(db, row, tokenOf(c))) ? (row as ShopOrder) : null;
    });
    if (!order) throw AppError.notFound("Order not found");
    return order;
  };
  /**
   * The buyer is not a system account (or, if they have one, not on the
   * team): orders (`shop_orders`, with email and address) are read only by
   * the system and the team (0002/0003). Creating the buyer's order is
   * the system's job, once the body is validated.
   */
  const asSystem = ctx.db.asSystem ?? (<T>(fn: () => Promise<T>) => fn());

  /**
   * Pickup location and schedule, and flat shipping rate.
   *
   * They are declared by whoever sets up the store, not by whoever buys. If no pickup
   * is configured, `validateCompliance` rejects `pickup` orders
   * with its own message — which is the right answer: that store does not
   * offer pickup.
   */
  const pickupPoint = () => konSetting<string>(ctx, KON_ID, "pickupNote") ?? null;
  const shippingCost = () => {
    const v = konSetting<number>(ctx, KON_ID, "shippingFlatCents", "number") ?? 0;
    // A badly written setting cannot become a discount.
    return Number.isInteger(v) && v >= 0 ? v : 0;
  };
  /** Minutes an unpaid order holds stock (5 min – 1 day). */
  const reservationMinutes = () => {
    const v = konSetting<number>(ctx, KON_ID, "reservationMinutes", "number") ?? 30;
    return Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 5), 1440) : 30;
  };

  // ══ PUBLIC ════════════════════════════════════════════════════════════════

  /**
   * Published catalog.
   *
   * Returns a shape TRIMMED by hand instead of the whole row: `ownerId`,
   * `metadata` and internal dates have no reason to leave the system just
   * because they are in the same table.
   */
  shop.get(
    "/products",
    {
      id: "list-products",
      summary: "List the published catalogue",
      description:
        "The active products, by name, each with its active variants (price in cents, currency, stock — null is unlimited). Trimmed shape: no owner, metadata or internal dates. `limit` up to 100 (default 50) and `offset`. Public.",
      access: "public",
      input: { query: PageQuery },
      output: { schema: z.object({ products: z.array(PublicProduct) }) },
    },
    async (c) => {
      const limit = Math.min(Number(c.req.query("limit")) || 50, 100);
      const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

      const products = await db
        .select()
        .from(shopProducts)
        .where(eq(shopProducts.active, true))
        .orderBy(asc(shopProducts.name))
        .limit(limit)
        .offset(offset);

      return c.json({ products: await withVariants(products) });
    }
  );

  shop.get(
    "/products/:slug",
    {
      id: "get-product",
      summary: "Read a published product",
      description:
        "One active product by slug, with its active variants. 404 for an unknown or inactive (draft) product. Public.",
      access: "public",
      input: { params: ParamSlug },
      output: { schema: z.object({ product: PublicProduct }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const [product] = await db
        .select()
        .from(shopProducts)
        .where(and(eq(shopProducts.slug, c.req.param("slug")), eq(shopProducts.active, true)))
        .limit(1);

      // An inactive product answers 404, not 403: the existence of a draft
      // called "limited edition 2027" is none of the business of someone passing by the website.
      if (!product) throw AppError.notFound("Product not found");

      const [withTheir] = await withVariants([product]);
      return c.json({ product: withTheir });
    }
  );

  /**
   * Buy.
   *
   * Open on purpose — the `shop-order` policy's `create` returns `true` —
   * because the buyer is not a system user. The barrier here is not
   * authorization but validation and the fact that the amounts are not
   * decided by the caller.
   */
  shop.post(
    "/orders",
    {
      id: "create-order",
      summary: "Place an order",
      description:
        "Buys, no account needed. Takes the lines (variantId + quantity), the buyer's email and name, the fulfilment (digital, shipping with an address, or pickup), notes and an optional `couponCode`; prices, discount, shipping cost and status are set by the server from the catalogue, the code and the shop settings (other fields are ignored). Reserves stock until paid. 201 with the order id, number, total and `accessToken` (the buyer's key to this order, shown once and also emailed); a retry with the same `Idempotency-Key` makes no second order — behind the core it gets 409 KITSUDEN_E_IDEMPOTENCY_NOT_REPLAYABLE (a response with a token is never stored; the token is in the email), mounted alone it gets 200 without the token; 409 with `problems` when something sold out; 422 with every problem at once (a code that does not apply included). Does not charge anything: pay with POST /orders/:id/checkout.",
      access: "public",
      // The handler validates (`read`): see the note on the schemas.
      input: { body: OrderInput, validatesHandler: true },
      output: ORDER_OUTPUT,
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const body = read(OrderInput, await c.req.json().catch(() => ({})));

      const lines = groupLines(body.items);
      if (!lines) {
        throw AppError.validation("The form data is not valid.", [
          {
            field: "items",
            problem: `At most ${MAX_UNITS_PER_VARIANT} units of each product.`,
          },
        ]);
      }

      // Two layers, on purpose. In the real API, the core's generic
      // middleware (apps/api/src/middleware/idempotency.ts) already handles this
      // header BEFORE getting here: it repeats the exact response of a
      // retry (201 with `Idempotent-Replayed: true`) for 24 h and stops
      // simultaneous ones with 409. This one, in the database and tied to the email, is the
      // durable net underneath: without expiry, and also valid if the kon is mounted
      // without the core. Same key format in both.
      const key = c.req.header("idempotency-key");
      if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) {
        throw AppError.validation("The Idempotency-Key header is not valid.", [
          { field: "Idempotency-Key", problem: "8-128 characters: letters, numbers, _ . : -" },
        ]);
      }

      // Before reserving: return to the catalog what is held by orders that
      // nobody paid in time. See `releaseExpiredReservations`.
      //
      // In a SAVEPOINT: the request runs in a transaction, and a failure here without
      // it would leave it aborted for the `createOrder` below, which is what
      // matters. This way, if it fails, only this is undone and it carries on.
      try {
        await asSystem(() =>
          db.transaction((sp: typeof db) => releaseExpiredReservations(sp, reservationMinutes()))
        );
      } catch (e) {
        ctx.logger.warn("[shop] could not release expired reservations", {
          error: e instanceof Error ? e.message : String(e),
        });
      }

      // The buyer's key to THIS order (shop.access.ts). Only its hash is stored; the token goes in
      // this response and in the confirmation email, and nowhere else.
      const accessToken = newToken();

      const result = await asSystem(() =>
        createOrder(
          lines,
          {
            customerEmail: body.customerEmail,
            customerName: body.customerName ?? null,
            fulfillmentType: body.fulfillmentType,
            shippingAddress: body.shippingAddress ?? null,
            notes: body.notes ?? null,
            // The three fields that do NOT come from the body. See the header.
            pickupNote: body.fulfillmentType === "pickup" ? pickupPoint() : null,
            shippingCents: body.fulfillmentType === "shipping" ? shippingCost() : 0,
            ownerId: null,
            idempotencyKey: key ? idempotencyFingerprint(body.customerEmail, key) : null,
            couponCode: body.couponCode ?? null,
            accessTokenHash: hashToken(accessToken),
          },
          db
        )
      );

      if (!result.ok) {
        // 409 and not 422 when something sold out: the order was valid, what changed
        // was the world. The client can retry with fewer units.
        const status = result.soldOut ? 409 : 422;
        return c.json({ ok: false, problems: result.problems ?? [] }, status);
      }

      if (!result.repeated && result.orderId) {
        ctx.logger.info("[shop] order created", { number: result.number });
        const created = await asSystem(async () => {
          const [row] = await db
            .select()
            .from(shopOrders)
            .where(eq(shopOrders.id, result.orderId as string))
            .limit(1);
          return row as ShopOrder | undefined;
        });
        if (created) await notifyReceived(ctx, db, created, accessToken);
        // A code that takes everything off leaves nothing to charge — and providers refuse a
        // payment of 0. The order is paid as it is, and delivered.
        if (created && created.totalCents === 0) {
          const free = await asSystem(() => applyStatus(db, created, "paid", { paymentRef: "free" }));
          if (free.order) await notifyStatus(ctx, db, free.order, "pending");
        }
      }
      return c.json(
        {
          ok: true,
          orderId: result.orderId,
          number: result.number,
          totalCents: result.totalCents,
          ...(result.discountCents ? { discountCents: result.discountCents } : {}),
          // A retry does not get a token: the first response and the confirmation email have it,
          // and handing out a new one to whoever repeats the key would be a second door.
          ...(result.repeated ? {} : { accessToken }),
        },
        // 200 on a retry: nothing new has been created.
        result.repeated ? 200 : 201
      );
    }
  );

  // ══ THE BUYER, WITH A TOKEN ═══════════════════════════════════════════════

  shop.get(
    "/orders/:id",
    {
      id: "get-my-order",
      summary: "Read my order (buyer, with its token)",
      description:
        "The buyer's view of one order: number, status, totals, lines, tracking, and once paid its downloads and license keys. Needs the order's token (`X-Order-Token` header, or `?token=` from the email link) or a live \"my orders\" token of the same email; without it, 404 like an order that does not exist. While pending it also lists the payment providers that can charge it. Public.",
      access: "public",
      input: { params: ParamId, query: TokenQuery },
      output: { schema: z.object({ order: Row }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      mcp: { exclude: "Opened by the buyer with a token from their email, never by an agent" },
    },
    async (c) => {
      const order = await orderForBuyer(c, c.req.param("id"));
      const view = await asSystem(() => buyerView(order));
      const gate = order.status === "pending" ? await payments() : null;
      return c.json({ order: { ...view, paymentProviders: gate ? gate.providers() : [] } });
    }
  );

  shop.post(
    "/orders/:id/checkout",
    {
      id: "pay-my-order",
      summary: "Open the payment page for my order (buyer)",
      description:
        "Opens a one-time payment for a pending order through kon-payments (`provider`: one of the order's `paymentProviders`) and returns the provider's URL. The amount is the order's total, never the caller's; return URLs must be on the site's own origins. Needs the order's token. 404 for a wrong token or an unknown provider, 409 if the order is no longer pending, 422 for a return URL that is not allowed, 502 if the provider does not answer, 503 if no payment kon is installed. Public.",
      access: "public",
      input: { params: ParamId, query: TokenQuery, body: CheckoutInput, validatesHandler: true },
      output: { schema: z.object({ url: z.string(), id: z.string() }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      mcp: { exclude: "The buyer pays in their own browser; an agent never opens a payment" },
    },
    async (c) => {
      const order = await orderForBuyer(c, c.req.param("id"));
      const body = read(CheckoutInput, await c.req.json().catch(() => ({})));
      if (order.status !== "pending" || order.totalCents === 0) {
        throw AppError.conflict(`This order is ${order.status}: there is nothing to pay.`);
      }
      const gate = await payments();
      if (!gate) {
        return c.json({ error: "Online payment is not available in this shop." }, 503);
      }

      const lines = await asSystem(
        () =>
          db
            .select()
            .from(shopOrderItems)
            .where(eq(shopOrderItems.orderId, order.id))
            .orderBy(asc(shopOrderItems.createdAt)) as Promise<Array<typeof shopOrderItems.$inferSelect>>
      );
      // The provider gets ONE line with the order's total when there is a discount: discounting
      // line by line at the provider would round differently from the order.
      const name = `Order ${order.number}`;
      const paymentLines =
        order.discountCents > 0
          ? [{ name, unitAmount: order.totalCents, quantity: 1 }]
          : [
              ...lines.map((l) => ({
                name: l.variantName && l.variantName !== "Standard" ? `${l.productName} (${l.variantName})` : l.productName,
                unitAmount: l.unitPriceCents,
                quantity: l.quantity,
              })),
              ...(order.shippingCents > 0
                ? [{ name: "Shipping", unitAmount: order.shippingCents, quantity: 1 }]
                : []),
            ];

      const opened = await gate.open(body.provider, {
        lines: paymentLines,
        currency: order.currency,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
        customerEmail: order.customerEmail,
        metadata: { shopOrderId: order.id, shopOrderNumber: order.number },
        // The page should not outlive the reservation; what is paid late is handled anyway.
        expiresInMinutes: reservationMinutes(),
      });
      if (!opened.ok) {
        if (opened.status === 502) {
          ctx.logger.error("[shop] the payment provider did not open a payment", {
            provider: body.provider,
            error: opened.message,
          });
          return c.json({ error: "The payment provider did not respond." }, 502);
        }
        if (opened.status === 404) throw AppError.notFound(opened.message);
        throw AppError.validation(opened.message, []);
      }
      return c.json({ url: opened.session.url, id: opened.session.id });
    }
  );

  shop.get(
    "/orders/:id/downloads/:item",
    {
      id: "download-my-file",
      summary: "Download a file I bought (buyer)",
      description:
        "Counts one download of a file of a paid order and redirects (302) to a storage URL signed for five minutes. Needs the order's token. 404 for a wrong token or an unknown file; 410 when the download was revoked (refund), expired or ran out of attempts. Public.",
      access: "public",
      input: { params: ItemParams, query: TokenQuery },
      output: { status: 302, description: "Redirect to a storage URL signed for five minutes" },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      mcp: { exclude: "A file download for the buyer's browser" },
    },
    async (c) => {
      const order = await orderForBuyer(c, c.req.param("id"));
      const answer = await asSystem(() => takeDownload(db, order.id, c.req.param("item")));
      if (!answer.ok) {
        if (answer.reason === "not-found") throw AppError.notFound("File not found");
        const why = {
          revoked: "This download was revoked.",
          expired: "This download has expired.",
          limit: "This download has no attempts left.",
        }[answer.reason];
        return c.json({ error: why }, 410);
      }
      const url = await ctx.storage.getSignedDownloadUrl(answer.storageKey, 300);
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      return c.redirect(url, 302);
    }
  );

  shop.post(
    "/my-orders/link",
    {
      id: "request-my-orders-link",
      summary: "Email me a link to my orders",
      description:
        "Sends, to that email only, a link that lists its orders for 30 minutes. Always 202, whether or not the email has orders and whether or not a link was sent a moment ago (one per 2 minutes): the answer says nothing about who has bought here. Public.",
      access: "public",
      input: { body: LinkRequest, validatesHandler: true },
      output: { status: 202, schema: z.object({ ok: z.literal(true) }) },
      mcp: { exclude: "Sends an email to whoever asks; only a buyer at a site asks for it" },
    },
    async (c) => {
      const { email } = read(LinkRequest, await c.req.json().catch(() => ({})));
      try {
        const token = await asSystem(async () => {
          const [has] = await db
            .select({ id: shopOrders.id })
            .from(shopOrders)
            .where(sql`lower(${shopOrders.customerEmail}) = ${email.toLowerCase()}`)
            .limit(1);
          // No orders, no email: nothing to show, and nobody gets mail they did not cause.
          return has ? db.transaction((sp: typeof db) => issueLink(sp, email)) : null;
        });
        if (token && shopMailsActive()) {
          const url = myOrdersPageUrl(await publicSite(ctx), token);
          // Without waiting: the mail server's time must not tell "sent" from "not sent".
          void mail
            .send("shop.my-orders", { to: email, url, minutes: LINK_MINUTES })
            .then((r) => {
              if (!r.ok) ctx.logger.error("[shop] my-orders email was not sent", { err: String(r.error) });
            })
            .catch((err) => ctx.logger.error("[shop] failure sending my-orders email", { err: String(err) }));
        }
      } catch (err) {
        // Not even a failure changes the answer: the difference would be the oracle.
        ctx.logger.error("[shop] failure issuing a my-orders link", { err: String(err) });
      }
      return c.json({ ok: true as const }, 202);
    }
  );

  shop.get(
    "/my-orders",
    {
      id: "list-my-orders",
      summary: "List my orders (buyer, with a link token)",
      description:
        "The orders placed with the email a \"my orders\" token was sent to, newest first (number, status, total, date). Use each order's id with the same token on GET /orders/:id. 404 for a missing or expired token. Public.",
      access: "public",
      input: { query: TokenQuery },
      output: { schema: z.object({ orders: z.array(Row) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      mcp: { exclude: "Opened by the buyer with a token from their email, never by an agent" },
    },
    async (c) => {
      const token = tokenOf(c);
      const email = token ? await asSystem(() => emailOfLink(db, token)) : null;
      if (!email) throw AppError.notFound("Link not found or expired");
      const orders = await asSystem(
        () =>
          db
            .select({
              id: shopOrders.id,
              number: shopOrders.number,
              status: shopOrders.status,
              totalCents: shopOrders.totalCents,
              currency: shopOrders.currency,
              placedAt: shopOrders.placedAt,
            })
            .from(shopOrders)
            .where(sql`lower(${shopOrders.customerEmail}) = ${email}`)
            .orderBy(desc(shopOrders.createdAt))
            .limit(100) as Promise<Array<{ id: string }>>
      );
      return c.json({ orders });
    }
  );

  // ══ TEAM ══════════════════════════════════════════════════════════════════

  // The old `shop.use("/admin/*", requireAuth)` is now the `acceso:
  // "sesion"` of each operation below.

  shop.get(
    "/admin/products",
    {
      id: "list-panel-products",
      summary: "List all products (staff)",
      description:
        "Every product, drafts included, most recently changed first, with all its variants. `limit` up to 200 (default 100). Shop staff only (admin, editor, or an agent with the ecommerce or shop-product scope).",
      access: "session",
      // It was `authorize(user, "update", { id: "*" }, "shop-product")`, before everything.
      permission: policy("shop-product", "update"),
      input: { query: PageQuery },
      output: { schema: z.object({ products: z.array(PublicProduct) }) },
    },
    async (c) => {
      const products = await db
        .select()
        .from(shopProducts)
        .orderBy(desc(shopProducts.updatedAt))
        .limit(Math.min(Number(c.req.query("limit")) || 100, 200));

      return c.json({ products: await withVariants(products, { includeInactive: true }) });
    }
  );

  shop.post(
    "/admin/products",
    {
      id: "create-product",
      summary: "Create a product (staff)",
      description:
        "Creates a catalogue product (slug, name, description, kind digital|physical, mediaId, active, metadata); variants are added separately. 201 with the row; 409 if the slug is taken. Shop staff only.",
      access: "session",
      // It was `authorize(user, "create", { id: "nuevo" }, "shop-product")`, before the body.
      permission: policy("shop-product", "create"),
      input: { body: ProductInput, validatesHandler: true },
      output: { status: 201, schema: z.object({ product: Row }) },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const data = read(ProductInput, await c.req.json().catch(() => ({})));

      const [createdItem] = await db
        .insert(shopProducts)
        .values({ ...data, ownerId: userOf(c)?.id ?? null })
        .returning();

      return c.json({ product: createdItem }, 201);
    }
  );

  shop.patch(
    "/admin/products/:id",
    {
      id: "update-product",
      summary: "Edit a product (staff)",
      description:
        "Changes any field of a product (partial update). 404 if it does not exist; 409 if the new slug is taken. Shop staff only.",
      access: "session",
      permission: onTheRow("shop-product"),
      input: { params: ParamId, body: ProductInput.partial(), validatesHandler: true },
      output: { schema: z.object({ product: Row }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN", "KITSUDEN_E_CONFLICT"],
    },
    async (c, _input, h) => {
      const product = await productById(c.req.param("id"));
      await require(h, product, "update", "shop-product");

      const data = read(ProductInput.partial(), await c.req.json().catch(() => ({})));

      const [updatedValue] = await db
        .update(shopProducts)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(shopProducts.id, product.id))
        .returning();

      return c.json({ product: updatedValue });
    }
  );

  shop.delete(
    "/admin/products/:id",
    {
      id: "delete-product",
      summary: "Delete a product (admin)",
      description:
        "Deletes a product and its variants. Past orders survive: their lines keep the frozen name and price. 404 if it does not exist. Shop admin only.",
      access: "session",
      permission: onTheRow("shop-product"),
      input: { params: ParamId },
      output: { schema: z.object({ ok: z.literal(true) }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
    },
    async (c, _input, h) => {
      const product = await productById(c.req.param("id"));
      await require(h, product, "delete", "shop-product");

      await db.delete(shopProducts).where(eq(shopProducts.id, product.id));
      // Orders survive: the line stores a frozen name and price and its
      // `variantId` is nullable with no cascade, precisely so that deleting the catalog does not
      // delete the accounting.
      return c.json({ ok: true });
    }
  );

  shop.post(
    "/admin/products/:id/variants",
    {
      id: "create-variant",
      summary: "Add a variant to a product (staff)",
      description:
        "Adds a variant (name, sku, priceCents, currency, stock — null or absent is unlimited —, attributes, active) to a product. 201 with the row. 404 if the product does not exist; 409 if the sku is taken. Shop staff only.",
      access: "session",
      permission: onTheRow("shop-product"),
      input: { params: ParamId, body: VariantInput, validatesHandler: true },
      output: { status: 201, schema: z.object({ variant: Row }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN", "KITSUDEN_E_CONFLICT"],
    },
    async (c, _input, h) => {
      const product = await productById(c.req.param("id"));
      await require(h, product, "update", "shop-product");

      const data = read(VariantInput, await c.req.json().catch(() => ({})));

      const [createdOne] = await db
        .insert(shopVariants)
        .values({ ...data, stock: data.stock ?? null, productId: product.id })
        .returning();

      return c.json({ variant: createdOne }, 201);
    }
  );

  shop.patch(
    "/admin/variants/:id",
    {
      id: "update-variant",
      summary: "Edit a variant (staff)",
      description:
        "Changes any field of a variant (partial update): price, stock, attributes, active… The permission is the product's. 404 if the variant does not exist; 409 if the new sku is taken. Shop staff only.",
      access: "session",
      permission: onTheRow("shop-product"),
      input: { params: ParamId, body: VariantInput.partial(), validatesHandler: true },
      output: { schema: z.object({ variant: Row }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN", "KITSUDEN_E_CONFLICT"],
    },
    async (c, _input, h) => {
      const [variant] = await db
        .select()
        .from(shopVariants)
        .where(eq(shopVariants.id, c.req.param("id")))
        .limit(1);
      if (!variant) throw AppError.notFound("Variant not found");

      // The policy is the PRODUCT's: a variant is not administered on its
      // own, and duplicating rules is how they end up diverging.
      await require(h, await productById(variant.productId), "update", "shop-product");

      const data = read(VariantInput.partial(), await c.req.json().catch(() => ({})));

      const [updated] = await db
        .update(shopVariants)
        .set(data)
        .where(eq(shopVariants.id, variant.id))
        .returning();

      return c.json({ variant: updated });
    }
  );

  shop.get(
    "/admin/orders",
    {
      id: "list-orders",
      summary: "List orders (staff)",
      description:
        "The orders, newest first, with the buyer's email, name and address. `status` filters (pending, paid, in_production, ready, shipped, delivered, cancelled, refunded; another value is ignored), `limit` up to 200 (default 50). Shop staff only: buyers never list orders.",
      access: "session",
      // It was `authorize(user, "view", { id: "*" }, "shop-order")`, before everything.
      permission: policy("shop-order", "view"),
      input: { query: OrdersQuery },
      output: { schema: z.object({ orders: z.array(Row) }) },
    },
    async (c) => {
      const statusValue = c.req.query("status");
      // Conditions accumulate and `.where()` is called ONCE: chaining two
      // `.where()` on the same Drizzle builder does not add them, it REPLACES the
      // first, and the lost filter gives no error — it returns too much.
      const conditions = [];
      if (statusValue && (STATUSES as readonly string[]).includes(statusValue)) {
        conditions.push(eq(shopOrders.status, statusValue as (typeof STATUSES)[number]));
      }

      const requests = await db
        .select()
        .from(shopOrders)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(shopOrders.createdAt))
        .limit(Math.min(Number(c.req.query("limit")) || 50, 200));

      return c.json({ orders: requests });
    }
  );

  shop.get(
    "/admin/orders/:id",
    {
      id: "get-order",
      summary: "Read an order (staff)",
      description:
        "One order (buyer, address, totals, status) with its lines (frozen name and price). 404 if it does not exist. Shop staff only.",
      access: "session",
      permission: onTheRow("shop-order"),
      input: { params: ParamId },
      output: { schema: z.object({ order: Row, items: z.array(Row) }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
    },
    async (c, _input, h) => {
      const request = await orderById(c.req.param("id"));
      await require(h, request, "view", "shop-order");

      const lines = await db
        .select()
        .from(shopOrderItems)
        .where(eq(shopOrderItems.orderId, request.id));

      return c.json({ order: request, items: lines });
    }
  );

  /**
   * Operating the store: manufacture, mark ready, ship, cancel.
   *
   * There is no generic order PATCH on purpose. The state is the only
   * field the team changes after the purchase, and it is precisely the one that
   * cannot accept any value.
   */
  shop.post(
    "/admin/orders/:id/status",
    {
      id: "change-order-status",
      summary: "Move an order to another status (staff)",
      description:
        "Moves an order along its allowed transitions (pending, paid, in_production, ready, shipped, delivered, cancelled, refunded); `paid` goes on by itself to delivered (digital) or in_production (physical) and delivers the digital lines' files and keys, cancelling returns the reserved stock and the discount-code use, refunding revokes downloads and keys. `paymentRef` records a payment made outside kon-payments (a bank transfer); `trackingNumber`/`trackingUrl` go with `shipped`. The buyer gets an email. The same status is a no-op. 404 if it does not exist; 409 for a transition that is not allowed or if the order changed meanwhile. Shop staff only.",
      access: "session",
      permission: onTheRow("shop-order"),
      // Cancelling or refunding touches money and stock: a human should confirm it.
      sensitive: true,
      idempotent: true,
      input: { params: ParamId, body: StatusChange, validatesHandler: true },
      output: { schema: z.object({ order: Row }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN", "KITSUDEN_E_CONFLICT"],
    },
    async (c, _input, h) => {
      const request = await orderById(c.req.param("id"));
      await require(h, request, "update", "shop-order");

      const { status, paymentRef, trackingNumber, trackingUrl } = read(
        StatusChange,
        await c.req.json().catch(() => ({}))
      );

      if (status === request.status) return c.json({ order: request });

      if (!canTransition(request.status, status)) {
        throw AppError.conflict(`An order "${request.status}" cannot move to "${status}".`);
      }

      // `applyStatus` (shop.payments.ts): the UPDATE is CONDITIONAL on the status read, so two
      // operators at once (or a webhook, or the expired-reservations sweep) cannot overwrite
      // each other; and the side effects go in the same transaction — `paid` goes on to
      // delivered or in production and delivers the digital lines, cancelling restores the
      // units and the discount-code use, refunding revokes the downloads.
      //
      // As the SYSTEM, once the policy above said yes: the side effects touch tables (license
      // keys, discount codes) that an agent allowed to operate orders may not reach on its own.
      const { order: updatedValue, delivery } = await asSystem(() =>
        applyStatus(db, request as ShopOrder, status, {
          paymentRef: paymentRef ?? null,
          trackingNumber: trackingNumber ?? null,
          trackingUrl: trackingUrl ?? null,
        })
      );

      if (!updatedValue) {
        throw AppError.conflict("The order changed in the meantime. Reload it.");
      }

      ctx.logger.info("[shop] order changes status", {
        number: request.number,
        from: request.status,
        to: updatedValue.status,
      });
      if (delivery?.keysMissing) {
        ctx.logger.warn("[shop] the order is paid but some license keys are missing", {
          number: request.number,
          missing: delivery.keysMissing,
        });
      }
      await notifyStatus(ctx, db, updatedValue, request.status);
      return c.json({ order: updatedValue });
    }
  );

  // ══ TEAM: WHAT A DIGITAL PURCHASE DELIVERS ════════════════════════════════

  shop.get(
    "/admin/products/:id/files",
    {
      id: "list-product-files",
      summary: "List the files a product delivers (staff)",
      description:
        "The files a paid order of this product receives (id, media id, variant — null is every variant —, filename). 404 if the product does not exist. Shop staff only.",
      access: "session",
      permission: onTheRow("shop-product"),
      input: { params: ParamId },
      output: { schema: z.object({ files: z.array(Row) }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
    },
    async (c, _input, h) => {
      const product = await productById(c.req.param("id"));
      await require(h, product, "update", "shop-product");
      const files = await db
        .select()
        .from(shopProductFiles)
        .where(eq(shopProductFiles.productId, product.id))
        .orderBy(asc(shopProductFiles.createdAt));
      return c.json({ files });
    }
  );

  shop.post(
    "/admin/products/:id/files",
    {
      id: "attach-product-file",
      summary: "Attach a file a product delivers (staff)",
      description:
        "Makes a file of the media library part of what a paid order of this product receives, for every variant or only `variantId`. Orders already paid get it with POST /admin/orders/:id/deliver. 201 with the row; 404 if the product does not exist; 422 if the media file or the variant is not found. Shop staff only.",
      access: "session",
      permission: onTheRow("shop-product"),
      input: { params: ParamId, body: FileInput, validatesHandler: true },
      output: { status: 201, schema: z.object({ file: Row }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
    },
    async (c, _input, h) => {
      const product = await productById(c.req.param("id"));
      await require(h, product, "update", "shop-product");
      const data = read(FileInput, await c.req.json().catch(() => ({})));

      const media = await asSystem(async () => {
        const res = await db.execute(
          sql`SELECT original_name AS "name" FROM media WHERE id::text = ${data.mediaId} LIMIT 1`
        );
        return ((Array.isArray(res) ? res : (res.rows ?? [])) as Array<{ name: string }>)[0] ?? null;
      });
      if (!media) {
        throw AppError.validation("The form data is not valid.", [
          { field: "mediaId", problem: "There is no such file in the media library." },
        ]);
      }
      if (data.variantId) {
        const [variant] = await db
          .select({ id: shopVariants.id })
          .from(shopVariants)
          .where(and(eq(shopVariants.id, data.variantId), eq(shopVariants.productId, product.id)))
          .limit(1);
        if (!variant) {
          throw AppError.validation("The form data is not valid.", [
            { field: "variantId", problem: "That variant is not of this product." },
          ]);
        }
      }

      const [file] = await db
        .insert(shopProductFiles)
        .values({
          productId: product.id,
          variantId: data.variantId ?? null,
          mediaId: data.mediaId,
          filename: data.filename ?? media.name,
        })
        .returning();
      return c.json({ file }, 201);
    }
  );

  shop.delete(
    "/admin/files/:id",
    {
      id: "detach-product-file",
      summary: "Stop delivering a file (staff)",
      description:
        "Removes a file from what future orders receive. Orders that already have it keep their entitlement but its download stops working. The media file itself is not deleted. 404 if it does not exist. Shop staff only.",
      access: "session",
      permission: onTheRow("shop-product"),
      input: { params: ParamId },
      output: { schema: z.object({ ok: z.literal(true) }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
    },
    async (c, _input, h) => {
      const [file] = await db
        .select()
        .from(shopProductFiles)
        .where(eq(shopProductFiles.id, c.req.param("id")))
        .limit(1);
      if (!file) throw AppError.notFound("File not found");
      await require(h, await productById(file.productId), "update", "shop-product");
      await db.delete(shopProductFiles).where(eq(shopProductFiles.id, file.id));
      return c.json({ ok: true as const });
    }
  );

  shop.post(
    "/admin/variants/:id/license-keys",
    {
      id: "add-license-keys",
      summary: "Upload license keys for a variant (staff)",
      description:
        "Adds keys to the pool a variant in `pool` mode hands out, one per unit paid (repeated keys are skipped). Returns how many were added and how many are free. Orders that were short of keys get them with POST /admin/orders/:id/deliver. 404 if the variant does not exist. Shop staff only.",
      access: "session",
      permission: onTheRow("shop-product"),
      // License keys are what a buyer pays for: a person should confirm an agent uploading them.
      sensitive: true,
      input: { params: ParamId, body: LicenseKeysInput, validatesHandler: true },
      output: { schema: z.object({ added: z.number(), available: z.number() }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
    },
    async (c, _input, h) => {
      const [variant] = await db
        .select()
        .from(shopVariants)
        .where(eq(shopVariants.id, c.req.param("id")))
        .limit(1);
      if (!variant) throw AppError.notFound("Variant not found");
      await require(h, await productById(variant.productId), "update", "shop-product");
      const { keys } = read(LicenseKeysInput, await c.req.json().catch(() => ({})));

      const added = await db
        .insert(shopLicenseKeys)
        .values([...new Set(keys)].map((licenseKey) => ({ variantId: variant.id, licenseKey })))
        .onConflictDoNothing()
        .returning({ id: shopLicenseKeys.id });
      const [free] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(shopLicenseKeys)
        .where(and(eq(shopLicenseKeys.variantId, variant.id), isNull(shopLicenseKeys.orderItemId)));
      return c.json({ added: added.length, available: Number(free?.n ?? 0) });
    }
  );

  shop.post(
    "/admin/orders/:id/deliver",
    {
      id: "deliver-order",
      summary: "Deliver what a paid order is missing (staff)",
      description:
        "Gives a paid order's digital lines the files and license keys they do not have yet — after attaching a new file or uploading keys a pool was short of. Never hands out a second copy. Returns what was granted, the keys still missing and the order's entitlements. 404 if it does not exist; 409 if the order is not paid. Shop staff only.",
      access: "session",
      permission: onTheRow("shop-order"),
      idempotent: true,
      input: { params: ParamId },
      output: {
        schema: z.object({ granted: z.number(), keysMissing: z.number(), entitlements: z.array(Row) }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN", "KITSUDEN_E_CONFLICT"],
    },
    async (c, _input, h) => {
      const order = await orderById(c.req.param("id"));
      await require(h, order, "update", "shop-order");
      if (!PAID_STATUSES.has(order.status)) {
        throw AppError.conflict(`An order "${order.status}" has nothing to deliver.`);
      }
      const result: DeliveryResult = await asSystem(() =>
        db.transaction((tx: typeof db) => grantEntitlements(tx, order.id))
      );
      const entitlements = await asSystem(() => entitlementsOf(db, order.id));
      return c.json({ granted: result.granted, keysMissing: result.keysMissing, entitlements });
    }
  );

  // ══ TEAM: DISCOUNT CODES ══════════════════════════════════════════════════

  shop.get(
    "/admin/promotions",
    {
      id: "list-promotions",
      summary: "List discount codes (staff)",
      description:
        "Every discount code, newest first, with its application (percentage or fixed, on the order or on shipping), rules (dates, minimum, products, limit) and how many times it was used. Shop staff only.",
      access: "session",
      permission: policy("shop-promotion", "view"),
      output: { schema: z.object({ promotions: z.array(Row) }) },
    },
    async (c) => {
      const promotions = await db.select().from(shopPromotions).orderBy(desc(shopPromotions.createdAt)).limit(500);
      return c.json({ promotions });
    }
  );

  shop.post(
    "/admin/promotions",
    {
      id: "create-promotion",
      summary: "Create a discount code (staff)",
      description:
        "Creates a code: `applicationType` percentage (value 1-100) or fixed (value in cents, with `currency`), `applicationTarget` order or shipping, and optional rules: `minSubtotalCents`, `productIds`, `startsAt`/`endsAt`, `usageLimit`. Codes are compared without case. 201 with the row; 409 if the code exists; 422 with every problem. Shop staff only.",
      access: "session",
      permission: policy("shop-promotion", "create"),
      // A code is money off every order that uses it: a person should confirm an agent's.
      sensitive: true,
      input: { body: PromotionInput, validatesHandler: true },
      output: { status: 201, schema: z.object({ promotion: Row }) },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const data = read(PromotionInput, await c.req.json().catch(() => ({})));
      const [taken] = await db
        .select({ id: shopPromotions.id })
        .from(shopPromotions)
        .where(sql`lower(${shopPromotions.code}) = ${data.code.toLowerCase()}`)
        .limit(1);
      if (taken) throw AppError.conflict(`The code "${data.code}" already exists.`);
      const [promotion] = await db
        .insert(shopPromotions)
        .values({
          ...data,
          currency: data.currency?.toUpperCase() ?? null,
          startsAt: data.startsAt ? new Date(data.startsAt) : null,
          endsAt: data.endsAt ? new Date(data.endsAt) : null,
        })
        .returning();
      return c.json({ promotion }, 201);
    }
  );

  shop.patch(
    "/admin/promotions/:id",
    {
      id: "update-promotion",
      summary: "Change or switch off a discount code (staff)",
      description:
        "Changes a code's rules or switches it off (`active: false`). The code, its kind and its value cannot change: orders have them frozen — create another code instead. Codes are never deleted, for the same reason. 404 if it does not exist. Shop staff only.",
      access: "session",
      permission: onTheRow("shop-promotion"),
      sensitive: true,
      input: { params: ParamId, body: PromotionPatch, validatesHandler: true },
      output: { schema: z.object({ promotion: Row }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
    },
    async (c, _input, h) => {
      const [found] = await db
        .select()
        .from(shopPromotions)
        .where(eq(shopPromotions.id, c.req.param("id")))
        .limit(1);
      if (!found) throw AppError.notFound("Discount code not found");
      await require(h, found, "update", "shop-promotion");
      const data = read(PromotionPatch, await c.req.json().catch(() => ({})));
      const [promotion] = await db
        .update(shopPromotions)
        .set({
          ...data,
          ...(data.startsAt !== undefined ? { startsAt: data.startsAt ? new Date(data.startsAt) : null } : {}),
          ...(data.endsAt !== undefined ? { endsAt: data.endsAt ? new Date(data.endsAt) : null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(shopPromotions.id, found.id))
        .returning();
      return c.json({ promotion });
    }
  );

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * What the buyer sees of their order: no owner, no idempotency fingerprint, no token hash, no
   * internal notes of the team (there are none yet, and this keeps it so).
   */
  async function buyerView(order: ShopOrder) {
    const lines = await db
      .select()
      .from(shopOrderItems)
      .where(eq(shopOrderItems.orderId, order.id))
      .orderBy(asc(shopOrderItems.createdAt));
    const paid = PAID_STATUSES.has(order.status) || order.status === "refunded";
    return {
      id: order.id,
      number: order.number,
      status: order.status,
      fulfillmentType: order.fulfillmentType,
      customerEmail: order.customerEmail,
      customerName: order.customerName,
      currency: order.currency,
      subtotalCents: order.subtotalCents,
      shippingCents: order.shippingCents,
      discountCents: order.discountCents,
      promotionCode: order.promotionCode,
      totalCents: order.totalCents,
      shippingAddress: order.shippingAddress,
      pickupNote: order.pickupNote,
      trackingNumber: order.trackingNumber,
      trackingUrl: order.trackingUrl,
      placedAt: order.placedAt,
      paidAt: order.paidAt,
      lines: lines.map((l: typeof shopOrderItems.$inferSelect) => ({
        productName: l.productName,
        variantName: l.variantName,
        unitPriceCents: l.unitPriceCents,
        quantity: l.quantity,
        subtotalCents: l.subtotalCents,
        kind: l.kind,
      })),
      entitlements: paid ? await entitlementsOf(db, order.id) : [],
    };
  }

  async function productById(id: string) {
    const [p] = await db.select().from(shopProducts).where(eq(shopProducts.id, id)).limit(1);
    if (!p) throw AppError.notFound("Product not found");
    return p;
  }

  async function orderById(id: string) {
    const [p] = await db.select().from(shopOrders).where(eq(shopOrders.id, id)).limit(1);
    if (!p) throw AppError.notFound("Order not found");
    return p;
  }

  /**
   * Attaches the variants to a list of products with ONE query.
   *
   * A `SELECT` per product turns a catalog of fifty items into
   * fifty-one queries; with pagination of a hundred, into one hundred and one.
   */
  async function withVariants(
    products: Array<typeof shopProducts.$inferSelect>,
    options: { includeInactive?: boolean } = {}
  ) {
    if (products.length === 0) return [];

    const ids = products.map((p) => p.id);
    const filter = options.includeInactive
      ? inArray(shopVariants.productId, ids)
      : and(inArray(shopVariants.productId, ids), eq(shopVariants.active, true));

    const variants = await db.select().from(shopVariants).where(filter);

    const byProduct = new Map<string, Array<typeof shopVariants.$inferSelect>>();
    for (const v of variants) {
      const list = byProduct.get(v.productId) ?? [];
      list.push(v);
      byProduct.set(v.productId, list);
    }

    return products.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      kind: p.kind,
      mediaId: p.mediaId,
      active: p.active,
      variants: (byProduct.get(p.id) ?? []).map((v) => ({
        id: v.id,
        name: v.name,
        sku: v.sku,
        priceCents: v.priceCents,
        currency: v.currency,
        stock: v.stock,
        attributes: v.attributes,
      })),
    }));
  }

  return shop.ops;
}

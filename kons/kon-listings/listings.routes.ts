/**
 * Listings — operations (kon SDK, Kitsuden's docs/kons/README.md)
 * ============================================================================
 *
 *   GET    /api/listings/verticals           the kinds of listing and their fields      (anyone)
 *   GET    /api/listings/portals             the portals a feed can be built for        (team)
 *   GET    /api/listings/feeds               feeds, with their public URL               (team)
 *   POST   /api/listings/feeds               create a feed for a portal and vertical    (team)
 *   PATCH  /api/listings/feeds/:id           change or switch off a feed, rotate token  (team)
 *   DELETE /api/listings/feeds/:id           delete a feed                              (team)
 *   GET    /api/listings/feeds/:id/check     what the feed would include and leave out  (team)
 *   GET    /api/listings/feed/:token         the XML a portal reads                     (anyone with the URL)
 *   GET    /api/listings/inquiries           what visitors asked                        (team)
 *   DELETE /api/listings/inquiries/:id       delete an inquiry                          (team)
 *   GET    /api/listings/by-slug/:slug       one listing by its slug                    (published: anyone)
 *   GET    /api/listings                     search                                     (published: anyone)
 *   POST   /api/listings                     create                                     (team)
 *   GET    /api/listings/:id                 one listing                                (published: anyone)
 *   PATCH  /api/listings/:id                 update                                     (team)
 *   DELETE /api/listings/:id                 delete                                     (team)
 *   POST   /api/listings/:id/inquiries       a visitor asks about a published listing   (anyone)
 *
 * The literal routes are declared before `/:id`, so `/feeds` never reads as an id.
 *
 * Rules for handlers (they run inside the request's RLS transaction):
 *   · queries IN SERIES (no `Promise.all` over the request's transaction);
 *   · `asSystem(fn)` only AFTER the application has decided the action is allowed: a portal reading
 *     its feed by token, an anonymous visitor's inquiry.
 */

import { randomBytes } from "node:crypto";

import {
  AppError,
  asSystem,
  defineOperation,
  isUuid,
  operationsRouter,
  type AnyOperation,
} from "@kitsuden/engine";
import { z } from "@kitsuden/engine/zod";
import type { KonContext } from "@kitsuden/shared";
import { and, asc, desc, eq, gte, ilike, lte, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Hono } from "hono";

import { buildFeed, portals, type FeedListing } from "./listings.feeds";
import { isStaff, registerListingsPolicy } from "./listings.policy";
import * as schema from "./listings.schema";
import {
  listingsFeeds,
  listingsInquiries,
  listingsItems,
  STATUSES,
  type ListingsFeed,
  type ListingsItem,
} from "./listings.schema";
import { attributeIssues, publishIssues, verticals, type AttributeIssue } from "./listings.verticals";

registerListingsPolicy();

export type ListingsDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/** The kon's id: part of the fine scope of each operation (`kon:listings:<op>`). */
export const KON_ID = "kon-listings";
/** Where the kon is mounted (kon.json → mount.path): the public feed URL is built from it. */
export const MOUNT_PATH = "/api/listings";

const ITEM = "listings-item";
const FEED = "listings-feed";
const INQUIRY = "listings-inquiry";

/** The event another kon (the CRM) can listen to, to turn an inquiry into a lead. */
export const INQUIRY_EVENT = "listings:inquiry.received";

const MAX_FEED_ITEMS = 20_000;

// ── Schemas: those of the route, the OpenAPI and the MCP tool ─────────────────

const Image = z.object({
  url: z
    .string()
    .url()
    .max(1000)
    .refine((u) => u.startsWith("https://"), "image URLs must be https: portals only download public https images"),
  title: z.string().max(200).nullable().optional(),
});

const Attributes = z
  .record(z.string(), z.unknown())
  .describe("The vertical's fields (GET /verticals). `null` clears one on update.");

const Location = {
  country: z.string().regex(/^[A-Z]{2}$/, "ISO country code, two capital letters").nullable().optional(),
  region: z.string().trim().max(120).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  district: z.string().trim().max(120).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  postcode: z.string().trim().max(20).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
};

const Editable = {
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).nullable().optional(),
  reference: z.string().trim().max(100).nullable().optional(),
  status: z.enum(STATUSES).optional(),
  price: z.number().min(0).max(999_999_999_999).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, "ISO currency code, three capital letters").nullable().optional(),
  ...Location,
  attributes: Attributes.optional(),
  images: z.array(Image).max(50).optional(),
};

/** Strict: a field that is not here is a 422 with `didYouMean`. */
const Create = z.object({
  vertical: z.string().describe("A vertical id from GET /verticals: real-estate, vehicles, jobs"),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(160)
    .optional()
    .describe("Part of the listing's public URL. Made from the title when omitted."),
  ...Editable,
});
const Edit = z.object({ ...Editable, title: Editable.title.optional() });

const ParamId = z.object({ id: z.string().describe("Listing id (uuid; anything else is a 404)") });
const ParamSlug = z.object({ slug: z.string().max(160) });

const ListQuery = z.object({
  vertical: z.string().max(30).optional(),
  status: z.enum(STATUSES).optional().describe("The team only; everyone else sees published listings"),
  city: z.string().max(120).optional(),
  region: z.string().max(120).optional(),
  q: z.string().max(100).optional().describe("Words in the title"),
  priceMin: z.coerce.number().min(0).optional(),
  priceMax: z.coerce.number().min(0).optional(),
  attr: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}:[^:]{1,100}$/, "key:value, for example operation:rent")
    .optional()
    .describe("One attribute equal to a value: `operation:rent`, `make:Toyota`"),
  sort: z.enum(["newest", "price-asc", "price-desc"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

const Listing = z.object({
  id: z.guid(),
  vertical: z.string(),
  slug: z.string(),
  reference: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(STATUSES),
  price: z.number().nullable(),
  currency: z.string().nullable(),
  country: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  district: z.string().nullable(),
  address: z.string().nullable(),
  postcode: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  attributes: z.record(z.string(), z.unknown()),
  images: z.array(z.object({ url: z.string(), title: z.string().nullable().optional() })),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const Issue = z.object({ field: z.string(), message: z.string() });

const FeedSettings = z.object({
  agencyName: z.string().trim().max(120).optional(),
  contactPhone: z.string().trim().max(40).optional(),
  contactEmail: z.string().email().max(254).optional(),
});

const ListingUrl = z
  .string()
  .url()
  .max(500)
  .refine((u) => u.startsWith("https://"), "the listing URL must be https")
  .refine((u) => u.includes("{slug}") || u.includes("{id}"), "the listing URL needs {slug} or {id}")
  .describe("Where a listing lives on your site, with {slug} or {id}: https://example.com/homes/{slug}");

const Feed = z.object({
  id: z.guid(),
  portal: z.string(),
  vertical: z.string(),
  enabled: z.boolean(),
  listingUrl: z.string(),
  settings: FeedSettings,
  /** Relative to the API's origin: give the portal `https://<your API>` + this path. */
  path: z.string(),
  lastReadAt: z.string().nullable(),
  createdAt: z.string(),
});

const Inquiry = z.object({
  id: z.guid(),
  listingId: z.guid(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  message: z.string(),
  createdAt: z.string(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function num(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The row as the API returns it: numbers as numbers, times as ISO strings. */
function view(row: ListingsItem): z.infer<typeof Listing> {
  return {
    id: row.id,
    vertical: row.vertical,
    slug: row.slug,
    reference: row.reference,
    title: row.title,
    description: row.description,
    status: row.status,
    price: num(row.price),
    currency: row.currency,
    country: row.country,
    region: row.region,
    city: row.city,
    district: row.district,
    address: row.address,
    postcode: row.postcode,
    latitude: num(row.latitude),
    longitude: num(row.longitude),
    attributes: row.attributes ?? {},
    images: row.images ?? [],
    publishedAt: iso(row.publishedAt),
    createdAt: iso(row.createdAt) as string,
    updatedAt: iso(row.updatedAt) as string,
  };
}

function feedView(row: ListingsFeed): z.infer<typeof Feed> {
  return {
    id: row.id,
    portal: row.portal,
    vertical: row.vertical,
    enabled: row.enabled,
    listingUrl: row.listingUrl,
    settings: row.settings ?? {},
    path: `${MOUNT_PATH}/feed/${row.token}`,
    lastReadAt: iso(row.lastReadAt),
    createdAt: iso(row.createdAt) as string,
  };
}

function slugFrom(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140)
    .replace(/-+$/g, "");
  // A short random tail: two listings called "Apartment in Panama City" must not collide.
  return `${base || "listing"}-${randomBytes(3).toString("hex")}`;
}

function newToken(): string {
  return randomBytes(24).toString("hex");
}

function invalid(message: string, issues: AttributeIssue[]): never {
  const detail = issues.map((i) => `${i.field}: ${i.message}`).join("; ");
  throw AppError.validation(`${message}: ${detail}`, { issues });
}

function verticalOrFail(id: string) {
  const vertical = verticals().get(id);
  if (!vertical) {
    throw AppError.validation(
      `"${id}" is not a vertical; use one of ${[...verticals().keys()].join(", ")}`,
      { issues: [{ field: "vertical", message: "unknown vertical" }] }
    );
  }
  return vertical;
}

/** `{slug}` and `{id}` in the feed's listing URL, URL-encoded. */
function listingUrl(template: string, row: ListingsItem): string {
  return template.replace(/\{slug\}/g, encodeURIComponent(row.slug)).replace(/\{id\}/g, encodeURIComponent(row.id));
}

function toFeedListing(row: ListingsItem, template: string): FeedListing {
  return {
    id: row.id,
    reference: row.reference,
    url: listingUrl(template, row),
    title: row.title,
    description: row.description,
    price: row.price,
    currency: row.currency,
    country: row.country,
    region: row.region,
    city: row.city,
    district: row.district,
    address: row.address,
    postcode: row.postcode,
    latitude: row.latitude,
    longitude: row.longitude,
    images: row.images ?? [],
    attributes: row.attributes ?? {},
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
  };
}

/** The operations, with their injected context. */
export function listingsOperations(ctx: KonContext): AnyOperation[] {
  const db = ctx.db.instance as ListingsDb;

  async function load(id: string): Promise<ListingsItem | null> {
    if (!isUuid(id)) return null;
    const [row] = await db.select().from(listingsItems).where(eq(listingsItems.id, id)).limit(1);
    return row ?? null;
  }

  async function loadFeed(id: string): Promise<ListingsFeed | null> {
    if (!isUuid(id)) return null;
    const [row] = await db.select().from(listingsFeeds).where(eq(listingsFeeds.id, id)).limit(1);
    return row ?? null;
  }

  async function publishedOf(vertical: string): Promise<ListingsItem[]> {
    return db
      .select()
      .from(listingsItems)
      .where(and(eq(listingsItems.vertical, vertical), eq(listingsItems.status, "published")))
      .orderBy(desc(listingsItems.publishedAt))
      .limit(MAX_FEED_ITEMS);
  }

  return [
    // ── Verticals and portals ──────────────────────────────────────────────────
    defineOperation({
      id: "list-verticals",
      method: "GET",
      route: "/verticals",
      summary: "The kinds of listing",
      description:
        "Each vertical (real-estate, vehicles, jobs) with the attributes a listing of that kind carries and what it needs before it can be published. Use it to build a form or a search filter.",
      access: "optional",
      output: { schema: z.object({ docs: z.array(z.object({}).passthrough()) }) },
      handle: async () => ({
        docs: [...verticals().values()].map(({ id, name, fields, publish }) => ({ id, name, fields, publish })),
      }),
    }),

    defineOperation({
      id: "list-portals",
      method: "GET",
      route: "/portals",
      summary: "The portals a feed can be built for",
      description:
        "Each portal with the verticals it takes and whether its mapping was checked against the portal's own specification (`verified`). An unverified mapping follows the format integrators describe; confirm it with the portal before relying on it.",
      access: "session",
      permission: { policy: { resource: FEED, action: "view" } },
      output: {
        schema: z.object({
          docs: z.array(z.object({ id: z.string(), name: z.string(), verified: z.boolean(), verticals: z.array(z.string()) })),
        }),
      },
      handle: async () => ({
        docs: [...portals().values()].map((p) => ({
          id: p.id,
          name: p.name,
          verified: p.verified,
          verticals: Object.keys(p.verticals),
        })),
      }),
    }),

    // ── Feeds ──────────────────────────────────────────────────────────────────
    defineOperation({
      id: "list-feeds",
      method: "GET",
      route: "/feeds",
      summary: "List the portal feeds",
      description: "Every feed with its public path. Give the portal your API's origin followed by `path`. Team only.",
      access: "session",
      permission: { policy: { resource: FEED, action: "view" } },
      output: { schema: z.object({ docs: z.array(Feed) }) },
      handle: async () => ({
        docs: (await db.select().from(listingsFeeds).orderBy(asc(listingsFeeds.portal))).map(feedView),
      }),
    }),

    defineOperation({
      id: "create-feed",
      method: "POST",
      route: "/feeds",
      summary: "Create a portal feed",
      description:
        "One feed per portal and vertical. It answers with the public path the portal reads (the token in it is the only access). `listingUrl` says where each listing lives on your site.",
      access: "session",
      permission: { policy: { resource: FEED, action: "create" } },
      input: {
        body: z.object({
          portal: z.string().max(30),
          vertical: z.string().max(30),
          listingUrl: ListingUrl,
          settings: FeedSettings.optional(),
          enabled: z.boolean().optional(),
        }),
      },
      output: { status: 201, schema: Feed },
      errors: ["KITSUDEN_E_CONFLICT"],
      handle: async ({ body }) => {
        const portal = portals().get(body.portal);
        if (!portal) {
          throw AppError.validation(`"${body.portal}" is not a portal; use one of ${[...portals().keys()].join(", ")}`);
        }
        verticalOrFail(body.vertical);
        if (!portal.verticals[body.vertical]) {
          throw AppError.validation(`${portal.name} takes ${Object.keys(portal.verticals).join(", ")}, not ${body.vertical}`);
        }
        const [existing] = await db
          .select({ id: listingsFeeds.id })
          .from(listingsFeeds)
          .where(and(eq(listingsFeeds.portal, body.portal), eq(listingsFeeds.vertical, body.vertical)))
          .limit(1);
        if (existing) throw AppError.conflict(`There is already a ${portal.name} feed for ${body.vertical}`);
        const [row] = await db
          .insert(listingsFeeds)
          .values({
            portal: body.portal,
            vertical: body.vertical,
            token: newToken(),
            listingUrl: body.listingUrl,
            settings: body.settings ?? {},
            enabled: body.enabled ?? true,
          })
          .returning();
        return feedView(row);
      },
    }),

    defineOperation({
      id: "update-feed",
      method: "PATCH",
      route: "/feeds/:id",
      summary: "Change a portal feed",
      description:
        "Switches the feed on or off, changes its listing URL or agency details, or gives it a new token (`rotateToken`): the old URL stops working at once, so give the portal the new one.",
      access: "session",
      permission: { policy: { resource: FEED, action: "update" } },
      input: {
        params: ParamId,
        body: z.object({
          enabled: z.boolean().optional(),
          listingUrl: ListingUrl.optional(),
          settings: FeedSettings.optional(),
          rotateToken: z.boolean().optional(),
        }),
      },
      output: { schema: Feed },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params, body }) => {
        const row = await loadFeed(params.id);
        if (!row) throw AppError.notFound("Not found");
        const [updated] = await db
          .update(listingsFeeds)
          .set({
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
            ...(body.listingUrl !== undefined ? { listingUrl: body.listingUrl } : {}),
            ...(body.settings !== undefined ? { settings: body.settings } : {}),
            ...(body.rotateToken ? { token: newToken() } : {}),
            updatedAt: new Date(),
          })
          .where(eq(listingsFeeds.id, row.id))
          .returning();
        return feedView(updated);
      },
    }),

    defineOperation({
      id: "delete-feed",
      method: "DELETE",
      route: "/feeds/:id",
      summary: "Delete a portal feed",
      description: "The portal's URL stops working; the listings are not touched. Team only.",
      access: "session",
      permission: { policy: { resource: FEED, action: "delete" } },
      sensitive: true,
      input: { params: ParamId },
      output: { status: 204 },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }) => {
        const row = await loadFeed(params.id);
        if (!row) throw AppError.notFound("Not found");
        await db.delete(listingsFeeds).where(eq(listingsFeeds.id, row.id));
      },
    }),

    defineOperation({
      id: "check-feed",
      method: "GET",
      route: "/feeds/:id/check",
      summary: "What a feed would include and leave out",
      description:
        "Builds the feed now and says how many published listings go in and which are left out, with the portal elements each one is missing. Fix those before the portal reads it: a portal drops an incomplete ad without saying why.",
      access: "session",
      permission: { policy: { resource: FEED, action: "view" } },
      input: { params: ParamId },
      output: {
        schema: z.object({
          portal: z.string(),
          verified: z.boolean(),
          included: z.number(),
          skipped: z.array(z.object({ id: z.string(), title: z.string(), missing: z.array(z.string()) })),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }) => {
        const row = await loadFeed(params.id);
        if (!row) throw AppError.notFound("Not found");
        const portal = portals().get(row.portal);
        if (!portal) throw AppError.notFound(`The portal "${row.portal}" is no longer shipped with this kon`);
        const rows = await publishedOf(row.vertical);
        const built = buildFeed(portal, row.vertical, rows.map((r) => toFeedListing(r, row.listingUrl)), row.settings ?? {});
        return { portal: portal.id, verified: portal.verified, included: built.included, skipped: built.skipped };
      },
    }),

    defineOperation({
      id: "feed",
      method: "GET",
      route: "/feed/:token",
      summary: "The XML a portal reads",
      description:
        "The published listings of the feed's vertical, in the portal's format. The token in the path is the only access; it shows nothing that is not already published. A wrong token or a switched-off feed is a 404.",
      access: "optional",
      input: { params: z.object({ token: z.string().max(100) }) },
      output: { type: "application/xml", description: "The portal's XML document" },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      mcp: { exclude: "An XML document for portals to download, not a tool for agents" },
      handle: async ({ params }) => {
        if (!/^[a-f0-9]{48}$/.test(params.token)) throw AppError.notFound("Not found");
        // The token IS the authorization: looking it up needs the system, since feeds are the team's.
        const feed = await asSystem(async () => {
          const [row] = await db.select().from(listingsFeeds).where(eq(listingsFeeds.token, params.token)).limit(1);
          return row ?? null;
        });
        if (!feed || !feed.enabled) throw AppError.notFound("Not found");
        const portal = portals().get(feed.portal);
        if (!portal) throw AppError.notFound("Not found");
        // Published listings are public: read them as whoever asks, under row security.
        const rows = await publishedOf(feed.vertical);
        const built = buildFeed(portal, feed.vertical, rows.map((r) => toFeedListing(r, feed.listingUrl)), feed.settings ?? {});
        await asSystem(() =>
          db.update(listingsFeeds).set({ lastReadAt: new Date() }).where(eq(listingsFeeds.id, feed.id))
        );
        return new Response(built.xml, {
          status: 200,
          headers: {
            "content-type": "application/xml; charset=utf-8",
            "cache-control": "public, max-age=300",
            "x-listings-included": String(built.included),
            "x-listings-skipped": String(built.skipped.length),
          },
        });
      },
    }),

    // ── Inquiries ──────────────────────────────────────────────────────────────
    defineOperation({
      id: "list-inquiries",
      method: "GET",
      route: "/inquiries",
      summary: "What visitors asked",
      description: "Newest first, optionally for one listing. Names, emails and phones: personal data. Team only.",
      access: "session",
      permission: { policy: { resource: INQUIRY, action: "view" } },
      input: {
        query: z.object({
          listingId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      output: { schema: z.object({ docs: z.array(Inquiry) }) },
      handle: async ({ query }) => {
        if (query.listingId !== undefined && !isUuid(query.listingId)) return { docs: [] };
        const rows = await db
          .select()
          .from(listingsInquiries)
          .where(query.listingId ? eq(listingsInquiries.listingId, query.listingId) : undefined)
          .orderBy(desc(listingsInquiries.createdAt))
          .limit(query.limit ?? 50);
        return { docs: rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) as string })) };
      },
    }),

    defineOperation({
      id: "delete-inquiry",
      method: "DELETE",
      route: "/inquiries/:id",
      summary: "Delete an inquiry",
      description: "Removes a visitor's inquiry, for example when they ask to be forgotten. Team only.",
      access: "session",
      permission: { policy: { resource: INQUIRY, action: "delete" } },
      sensitive: true,
      input: { params: z.object({ id: z.string() }) },
      output: { status: 204 },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }) => {
        if (!isUuid(params.id)) throw AppError.notFound("Not found");
        const removed = await db
          .delete(listingsInquiries)
          .where(eq(listingsInquiries.id, params.id))
          .returning({ id: listingsInquiries.id });
        if (removed.length === 0) throw AppError.notFound("Not found");
      },
    }),

    // ── Listings ───────────────────────────────────────────────────────────────
    defineOperation({
      id: "get-by-slug",
      method: "GET",
      route: "/by-slug/:slug",
      summary: "One listing by its slug",
      description: "For a public page at /<something>/<slug>. A listing that is not published answers 404 to everyone but the team.",
      access: "optional",
      permission: { policy: { resource: ITEM, action: "view", inHandler: true } },
      input: { params: ParamSlug },
      output: { schema: Listing },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }, { can }) => {
        const [row] = await db.select().from(listingsItems).where(eq(listingsItems.slug, params.slug)).limit(1);
        if (!row || !(await can(row))) throw AppError.notFound("Not found");
        return view(row);
      },
    }),

    defineOperation({
      id: "list",
      method: "GET",
      route: "/",
      summary: "Search listings",
      description:
        "Published listings, newest first, filtered by vertical, city, region, words in the title, price range and one attribute (`attr=operation:rent`). The team also sees drafts, paused and closed listings, and can filter by status.",
      access: "optional",
      input: { query: ListQuery },
      output: { schema: z.object({ docs: z.array(Listing), limit: z.number(), offset: z.number() }) },
      handle: async ({ query }, { user }) => {
        const team = isStaff(user);
        const conditions: SQL[] = [];
        if (!team) conditions.push(eq(listingsItems.status, "published"));
        else if (query.status) conditions.push(eq(listingsItems.status, query.status));
        if (query.vertical) conditions.push(eq(listingsItems.vertical, query.vertical));
        if (query.city) conditions.push(sql`lower(${listingsItems.city}) = lower(${query.city})`);
        if (query.region) conditions.push(sql`lower(${listingsItems.region}) = lower(${query.region})`);
        if (query.q) {
          const words = query.q.replace(/[\\%_]/g, (c) => `\\${c}`);
          conditions.push(ilike(listingsItems.title, `%${words}%`));
        }
        if (query.priceMin !== undefined) conditions.push(gte(listingsItems.price, String(query.priceMin)));
        if (query.priceMax !== undefined) conditions.push(lte(listingsItems.price, String(query.priceMax)));
        if (query.attr) {
          const at = query.attr.indexOf(":");
          const key = query.attr.slice(0, at);
          const value = query.attr.slice(at + 1);
          // The key is bound as a value, not an identifier: `->>` takes text.
          conditions.push(sql`(${listingsItems.attributes} ->> ${key}) = ${value}`);
        }
        const order =
          query.sort === "price-asc"
            ? [sql`${listingsItems.price} ASC NULLS LAST`]
            : query.sort === "price-desc"
              ? [sql`${listingsItems.price} DESC NULLS LAST`]
              : [sql`${listingsItems.publishedAt} DESC NULLS LAST`, desc(listingsItems.createdAt)];
        const limit = query.limit ?? 24;
        const offset = query.offset ?? 0;
        const rows = await db
          .select()
          .from(listingsItems)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(...order)
          .limit(limit)
          .offset(offset);
        return { docs: rows.map(view), limit, offset };
      },
    }),

    defineOperation({
      id: "create",
      method: "POST",
      route: "/",
      summary: "Create a listing",
      description:
        "A listing of one vertical (GET /verticals for its fields). It starts as a draft unless `status` says otherwise; publishing needs what the vertical requires (a 422 lists what is missing). Team only.",
      access: "session",
      permission: { policy: { resource: ITEM, action: "create" } },
      input: { body: Create },
      output: { status: 201, schema: Listing },
      handle: async ({ body }, { user }) => {
        const vertical = verticalOrFail(body.vertical);
        const attributes = Object.fromEntries(
          Object.entries(body.attributes ?? {}).filter(([, v]) => v !== null && v !== undefined)
        );
        const status = body.status ?? "draft";
        const candidate = {
          price: body.price ?? null,
          currency: body.currency ?? null,
          city: body.city ?? null,
          region: body.region ?? null,
          address: body.address ?? null,
          images: body.images ?? [],
          description: body.description ?? null,
          attributes,
        };
        const issues =
          status === "published" ? publishIssues(vertical, candidate) : attributeIssues(vertical, attributes, false);
        if (issues.length > 0) {
          invalid(status === "published" ? "The listing cannot be published yet" : "The attributes do not fit the vertical", issues);
        }
        const [row] = await db
          .insert(listingsItems)
          .values({
            vertical: vertical.id,
            slug: body.slug ?? slugFrom(body.title),
            reference: body.reference ?? null,
            title: body.title,
            description: body.description ?? null,
            status,
            price: body.price === null || body.price === undefined ? null : String(body.price),
            currency: body.currency ?? null,
            country: body.country ?? null,
            region: body.region ?? null,
            city: body.city ?? null,
            district: body.district ?? null,
            address: body.address ?? null,
            postcode: body.postcode ?? null,
            latitude: body.latitude === null || body.latitude === undefined ? null : String(body.latitude),
            longitude: body.longitude === null || body.longitude === undefined ? null : String(body.longitude),
            attributes,
            images: body.images ?? [],
            createdBy: (user as { id?: string } | null)?.id ?? null,
            publishedAt: status === "published" ? new Date() : null,
          })
          .returning();
        return view(row);
      },
    }),

    defineOperation({
      id: "get",
      method: "GET",
      route: "/:id",
      summary: "One listing",
      description: "A listing by id. One that is not published answers like one that does not exist (404), except to the team.",
      access: "optional",
      permission: { policy: { resource: ITEM, action: "view", inHandler: true } },
      input: { params: ParamId },
      output: { schema: Listing },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }, { can }) => {
        const row = await load(params.id);
        if (!row || !(await can(row))) throw AppError.notFound("Not found");
        return view(row);
      },
    }),

    defineOperation({
      id: "update",
      method: "PATCH",
      route: "/:id",
      summary: "Update a listing",
      description:
        "Changes the given fields. `attributes` are merged into what is stored (`null` clears one). Publishing checks what the vertical requires, and so does any change to a listing that is already published. Team only.",
      access: "session",
      permission: { policy: { resource: ITEM, action: "update", inHandler: true } },
      input: { params: ParamId, body: Edit },
      output: { schema: Listing },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params, body }, { authorize }) => {
        const row = await load(params.id);
        if (!row) throw AppError.notFound("Not found");
        await authorize(row);
        const vertical = verticalOrFail(row.vertical);

        const attributes: Record<string, unknown> = { ...(row.attributes ?? {}) };
        for (const [key, value] of Object.entries(body.attributes ?? {})) {
          if (value === null) delete attributes[key];
          else attributes[key] = value;
        }
        const status = body.status ?? row.status;
        const pick = <K extends keyof typeof body>(key: K, current: unknown) =>
          body[key] === undefined ? current : body[key];
        const candidate = {
          price: pick("price", num(row.price)),
          currency: pick("currency", row.currency),
          city: pick("city", row.city),
          region: pick("region", row.region),
          address: pick("address", row.address),
          images: pick("images", row.images ?? []),
          description: pick("description", row.description),
          attributes,
        };
        const issues =
          status === "published" ? publishIssues(vertical, candidate) : attributeIssues(vertical, attributes, false);
        if (issues.length > 0) {
          invalid(status === "published" ? "The listing cannot be published as it is" : "The attributes do not fit the vertical", issues);
        }

        const decimal = (v: number | null | undefined) => (v === undefined ? undefined : v === null ? null : String(v));
        const changes = {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.reference !== undefined ? { reference: body.reference } : {}),
          ...(body.price !== undefined ? { price: decimal(body.price) } : {}),
          ...(body.currency !== undefined ? { currency: body.currency } : {}),
          ...(body.country !== undefined ? { country: body.country } : {}),
          ...(body.region !== undefined ? { region: body.region } : {}),
          ...(body.city !== undefined ? { city: body.city } : {}),
          ...(body.district !== undefined ? { district: body.district } : {}),
          ...(body.address !== undefined ? { address: body.address } : {}),
          ...(body.postcode !== undefined ? { postcode: body.postcode } : {}),
          ...(body.latitude !== undefined ? { latitude: decimal(body.latitude) } : {}),
          ...(body.longitude !== undefined ? { longitude: decimal(body.longitude) } : {}),
          ...(body.images !== undefined ? { images: body.images } : {}),
        };
        const [updated] = await db
          .update(listingsItems)
          .set({
            ...changes,
            attributes,
            status,
            // The first time it goes live; pausing and publishing again keeps the original date.
            ...(status === "published" && !row.publishedAt ? { publishedAt: new Date() } : {}),
            updatedAt: new Date(),
          })
          .where(eq(listingsItems.id, row.id))
          .returning();
        return view(updated);
      },
    }),

    defineOperation({
      id: "delete",
      method: "DELETE",
      route: "/:id",
      summary: "Delete a listing",
      description: "Deletes the listing and its inquiries. Cannot be undone; to take it off the portals, set status `paused` or `closed` instead. Team only.",
      access: "session",
      permission: { policy: { resource: ITEM, action: "delete", inHandler: true } },
      sensitive: true,
      input: { params: ParamId },
      output: { status: 204 },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }, { authorize }) => {
        const row = await load(params.id);
        if (!row) throw AppError.notFound("Not found");
        await authorize(row);
        await db.delete(listingsItems).where(eq(listingsItems.id, row.id));
      },
    }),

    defineOperation({
      id: "create-inquiry",
      method: "POST",
      route: "/:id/inquiries",
      summary: "Ask about a listing",
      description:
        "A visitor's question about a published listing, from the agency's site. It is stored for the team and announced as the `listings:inquiry.received` event, so a CRM can turn it into a lead. Rate-limited per address.",
      access: "optional",
      input: {
        params: ParamId,
        body: z.object({
          name: z.string().trim().min(1).max(120),
          email: z.string().trim().email().max(254),
          phone: z.string().trim().max(40).optional(),
          message: z.string().trim().min(1).max(4000),
          website: z.string().max(200).optional().describe("Leave empty. A form field hidden from people, so bots fill it."),
        }),
      },
      output: { status: 202, schema: z.object({ received: z.boolean() }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      mcp: { exclude: "A form for visitors of the agency's site, not a tool for agents" },
      handle: async ({ params, body }) => {
        // A bot filled the hidden field: answer the same as for a person, store nothing.
        if (body.website && body.website.trim() !== "") return { received: true };
        // Read as whoever asks: a visitor only finds a published listing.
        const row = await load(params.id);
        if (!row || row.status !== "published") throw AppError.notFound("Not found");
        // Inquiries are the team's; the visitor may create one but not read the table.
        const [inquiry] = await asSystem(() =>
          db
            .insert(listingsInquiries)
            .values({
              listingId: row.id,
              name: body.name,
              email: body.email,
              phone: body.phone ?? null,
              message: body.message,
            })
            .returning()
        );
        ctx.events.emit(INQUIRY_EVENT, {
          inquiryId: inquiry.id,
          listingId: row.id,
          listingTitle: row.title,
          listingReference: row.reference,
          vertical: row.vertical,
          name: inquiry.name,
          email: inquiry.email,
          phone: inquiry.phone,
        });
        return { received: true };
      },
    }),
  ];
}

/** The REST router, generated from the operations. */
export function createListingsRouter(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, listingsOperations(ctx), ctx);
}

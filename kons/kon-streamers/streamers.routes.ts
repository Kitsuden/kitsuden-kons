/**
 * Kitsuden CMS — Streamers Module Routes (kon SDK operations)
 *
 * REST API for streamer management with Twitch/YouTube/Kick sync.
 *
 * Each route is a declared operation (`operations.ts`, docs/kons/README.md):
 * the handler is the usual one; the access, the policy and the schemas are declared.
 *
 * ⚠️ CRITICAL: Route order matters in Hono!
 * Specific routes must be registered BEFORE parameterized routes.
 */

import { eqEnum, operationsRouter, sqlstateOf, type AnyOperation } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { eq, desc, asc, and, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { OF_TEAM, KON_ID, registry } from "./operations";
import { registerStreamersPolicy } from "./streamers.policy";
import type { StreamersDb } from "./streamers.db";
import { streamers, gamesToStreamers } from "./streamers.schema";

/**
 * Columns by which the public listing can be sorted.
 *
 * Before, `?sort=` indexed the model with whatever arrived: a name that was not a
 * column (`?sort=x`) reached Drizzle as `undefined` and the public home page
 * responded 500. Anything unknown falls back to the default order.
 */
const SORTABLE = new Set([
  "followerCount",
  "viewerCount",
  "displayName",
  "slug",
  "createdAt",
  "updatedAt",
  "lastSyncedAt",
]);

/**
 * `streamers_slug_idx` (slug) and `streamers_channel_idx` (platform + channel, migration 0002) are
 * unique: a write that repeats either answers 409 with this message, not a 500.
 */
const DUPLICATE = "A streamer with that slug, or with that platform and channel, already exists";

function isUniqueViolation(err: unknown): boolean {
  return sqlstateOf(err) === "23505";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORMS = ["twitch", "youtube", "kick"] as const;

/**
 * What can be written of a streamer, and how.
 *
 * `PATCH` did `.set({ ...body })`: any column was writable (`id`,
 * `createdAt`) and a `channelUrl` could be `javascript:` —and the site renders it
 * as a link—. Returns the clean patch or the first problem.
 */
function cleanStreamer(
  body: Record<string, unknown>,
  partial: boolean
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};
  const text = (k: string, max: number, required = false) => {
    const v = body[k];
    if (v === undefined) {
      if (required && !partial) throw new Error(`\`${k}\` is required`);
      return;
    }
    if (v === null && !required) {
      out[k] = null;
      return;
    }
    if (typeof v !== "string" || !v.trim() || v.length > max) {
      throw new Error(`\`${k}\` must be text of 1 to ${max} characters`);
    }
    out[k] = v.trim();
  };
  const fileIdOf = (k: string) => {
    const v = body[k];
    if (v === undefined) return;
    if (v !== null && (typeof v !== "string" || !UUID.test(v))) {
      throw new Error(`\`${k}\` must be a file id`);
    }
    out[k] = v;
  };
  const integer = (k: string) => {
    const v = body[k];
    if (v === undefined) return;
    if (!Number.isInteger(v) || (v as number) < 0)
      throw new Error(`\`${k}\` must be an integer >= 0`);
    out[k] = v;
  };

  try {
    text("displayName", 200, true);
    text("slug", 200);
    text("channelId", 200, true);
    text("bio", 5000);
    text("currentStreamTitle", 500);
    if (body.platform !== undefined) {
      if (!PLATFORMS.includes(body.platform as (typeof PLATFORMS)[number])) {
        throw new Error("`platform` must be twitch, youtube or kick");
      }
      out.platform = body.platform;
    } else if (!partial) {
      throw new Error("`platform` is required");
    }
    if (body.channelUrl !== undefined) {
      const v = body.channelUrl;
      if (
        v !== null &&
        (typeof v !== "string" || !/^https?:\/\//i.test(v.trim()) || v.length > 2000)
      ) {
        throw new Error("`channelUrl` must be an http(s) link");
      }
      out.channelUrl = typeof v === "string" ? v.trim() : null;
    }
    fileIdOf("avatarId");
    fileIdOf("thumbnailId");
    fileIdOf("currentGameId");
    integer("viewerCount");
    integer("followerCount");
    if (body.isLive !== undefined) {
      if (typeof body.isLive !== "boolean") throw new Error("`isLive` must be true or false");
      out.isLive = body.isLive;
    }
    if (body.socialLinks !== undefined) {
      out.socialLinks =
        body.socialLinks && typeof body.socialLinks === "object"
          ? JSON.stringify(body.socialLinks)
          : typeof body.socialLinks === "string"
            ? body.socialLinks
            : null;
    }
    if (body.gameIds !== undefined) {
      if (
        !Array.isArray(body.gameIds) ||
        body.gameIds.length > 50 ||
        !body.gameIds.every((g) => typeof g === "string" && UUID.test(g))
      ) {
        throw new Error("`gameIds` is a list of game ids");
      }
      out.gameIds = body.gameIds;
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true, value: out };
}

// ── Schemas (OpenAPI and MCP) ────────────────────────────────────────────────

/** Listing query: all text and optional; anything odd falls back to the default value. */
const ListQuery = z
  .object({
    limit: z.string().optional().describe("Page size, max 200 (default 50)"),
    page: z.string().optional().describe("Page number, from 1"),
    platform: z.string().optional().describe("twitch | youtube | kick"),
    live: z.string().optional().describe("`true`: only streamers live now"),
    sort: z
      .string()
      .optional()
      .describe(
        `Column to sort by, \`-\` prefix for descending (default -followerCount): ${[...SORTABLE].join(", ")}`
      ),
  })
  .passthrough();

const ParamId = z.object({ id: z.string().describe("Streamer id (uuid)") });
const ParamSlug = z.object({ slug: z.string().describe("Streamer slug") });

/**
 * What is written of a streamer. It is validated by the handler (`cleanStreamer`,
 * `validatesHandler`): its 400s with the failing field are the usual
 * contract, and what it does not know it ignores (the panel sends the whole row
 * when editing). This schema PUBLISHES it (OpenAPI, MCP).
 */
const NewStreamer = z
  .object({
    displayName: z.string().min(1).max(200),
    slug: z.string().min(1).max(200).nullable().optional().describe("Default: from displayName"),
    platform: z.enum(PLATFORMS),
    channelId: z.string().min(1).max(200),
    channelUrl: z.string().max(2000).nullable().optional().describe("http(s) link"),
    bio: z.string().max(5000).nullable().optional(),
    currentStreamTitle: z.string().max(500).nullable().optional(),
    avatarId: z.string().nullable().optional().describe("Media file id (uuid)"),
    thumbnailId: z.string().nullable().optional().describe("Media file id (uuid)"),
    currentGameId: z.string().nullable().optional().describe("Game id (uuid)"),
    viewerCount: z.number().int().min(0).optional(),
    followerCount: z.number().int().min(0).optional(),
    isLive: z.boolean().optional(),
    socialLinks: z.unknown().optional().describe("Object of links; stored as JSON"),
    gameIds: z
      .array(z.string())
      .max(50)
      .optional()
      .describe("Game ids (uuid); the first one is the primary game"),
  })
  .passthrough();

/**
 * The sync job's batch. It is validated by the handler: its 400s («updates
 * must be an array», «At most 500…») are the usual ones.
 */
const LiveBatch = z
  .object({
    updates: z
      .array(
        z
          .object({
            channelId: z.string(),
            platform: z.enum(PLATFORMS),
            isLive: z.boolean().optional(),
            viewerCount: z.number().int().min(0).optional(),
            currentStreamTitle: z.string().nullable().optional(),
            thumbnailId: z.string().nullable().optional().describe("Media file id (uuid)"),
          })
          .passthrough()
      )
      .max(500),
  })
  .passthrough();

const StreamerOut = z
  .object({
    id: z.string(),
    displayName: z.string(),
    slug: z.string(),
    platform: z.string(),
    channelId: z.string(),
  })
  .passthrough();

const ListOut = z.object({
  docs: z.array(StreamerOut),
  totalDocs: z.number().int(),
  totalPages: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
  hasNextPage: z.boolean(),
  hasPrevPage: z.boolean(),
});

/**
 * The kon's operations (docs/kons/README.md). The order is the usual one:
 * literals (`/live`, `/slug/:slug`, `/sync/status`) before `/:id`.
 */
export function streamersOperations(ctx: KonContext): AnyOperation[] {
  registerStreamersPolicy();
  const app = registry();
  const { db } = ctx;

  const dbInstance = db.instance as StreamersDb;

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC/SPECIFIC ROUTES (must come before parameterized routes)
  // ═══════════════════════════════════════════════════════════════════════════

  // ── List Streamers ──
  app.get(
    "/",
    {
      id: "list-streamers",
      summary: "List streamers",
      description:
        "The site's streamers, paginated (default 50, max 200), most followed first. Filters: `platform`, `live=true`. Public. Returns `docs` plus pagination totals.",
      access: "public",
      input: { query: ListQuery },
      output: { schema: ListOut },
    },
    async (c) => {
      const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
      const page = Math.max(Number(c.req.query("page")) || 1, 1);
      const offset = (page - 1) * limit;
      const platform = c.req.query("platform");
      const liveOnly = c.req.query("live") === "true";
      const request = c.req.query("sort") || "-followerCount";
      const sort = SORTABLE.has(request.replace(/^-/, "")) ? request : "-followerCount";

      const conditions = [];
      if (platform) {
        conditions.push(eqEnum(streamers.platform, platform));
      }
      if (liveOnly) {
        conditions.push(eq(streamers.isLive, true));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const orderBy = sort.startsWith("-")
        ? desc(streamers[sort.slice(1) as keyof typeof streamers.$inferSelect] as any)
        : asc(streamers[sort as keyof typeof streamers.$inferSelect] as any);

      // In series, not with `Promise.all`: both queries go through the SAME
      // request transaction, which is one connection and one query at a time.
      const docs = await dbInstance
        .select()
        .from(streamers)
        .where(where)
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset);
      const countResult = await dbInstance
        .select({ count: sql<number>`count(*)` })
        .from(streamers)
        .where(where);

      const totalDocs = Number(countResult[0]?.count ?? 0);
      const totalPages = Math.ceil(totalDocs / limit);

      return c.json({
        docs,
        totalDocs,
        totalPages,
        page,
        limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      });
    }
  );

  // ── Get Live Streamers ──
  app.get(
    "/live",
    {
      id: "list-live",
      summary: "List live streamers",
      description:
        "Up to 20 streamers that are live now, most viewers first, as last reported by the sync job. Public.",
      access: "public",
      output: { schema: z.object({ docs: z.array(StreamerOut), totalDocs: z.number().int() }) },
    },
    async (c) => {
      const docs = await dbInstance
        .select()
        .from(streamers)
        .where(eq(streamers.isLive, true))
        .orderBy(desc(streamers.viewerCount))
        .limit(20);

      return c.json({
        docs,
        totalDocs: docs.length,
      });
    }
  );

  // ── Get Streamer by Slug ──
  app.get(
    "/slug/:slug",
    {
      id: "get-streamer-by-slug",
      summary: "Read a streamer by slug",
      description:
        "One streamer by its slug, with `games`: the associated game ids and which one is primary. Public. 404 if no streamer has that slug.",
      access: "public",
      input: { params: ParamSlug },
      output: {
        schema: StreamerOut.extend({
          games: z.array(z.object({ gameId: z.string(), isPrimary: z.boolean().nullable() })),
        }).passthrough(),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { slug } = c.req.param();

      const result = await dbInstance
        .select()
        .from(streamers)
        .where(eq(streamers.slug, slug))
        .limit(1);

      if (!result.length) return c.json({ error: "Streamer not found" }, 404);

      const streamer = result[0];

      // Get associated games
      const streamerGames = await dbInstance
        .select({ gameId: gamesToStreamers.gameId, isPrimary: gamesToStreamers.isPrimary })
        .from(gamesToStreamers)
        .where(eq(gamesToStreamers.streamerId, streamer.id));

      return c.json({
        ...streamer,
        games: streamerGames,
      });
    }
  );

  // ── Bulk Update Live Status (for sync jobs) ──
  // SPECIFIC ROUTE: must come before /:id
  app.post(
    "/sync/status",
    {
      id: "sync-live",
      summary: "Bulk update live status",
      description:
        "For the sync job: up to 500 updates, each matched by `platform` + `channelId`, setting live flag, viewers, stream title and thumbnail. Unmatched channels are skipped. Site staff, or an agent with streamer:sync. Returns how many streamers were updated.",
      access: "session",
      permission: OF_TEAM("sync"),
      // Rewrites in bulk the «live» status that the site shows.
      sensitive: true,
      input: { body: LiveBatch, validatesHandler: true },
      output: { schema: z.object({ synced: z.number().int(), total: z.number().int() }) },
    },
    async (c, input) => {
      // The body was already read by the SDK (a broken JSON is its 400). An empty one reached
      // `c.req.json()` and came out as a 500; now it is the 400 of `updates`.
      const body = (input.body ?? {}) as { updates?: unknown };
      const { updates } = body;

      if (!Array.isArray(updates)) {
        return c.json({ error: "updates must be an array" }, 400);
      }
      if (updates.length > 500) {
        return c.json({ error: "At most 500 updates per call" }, 400);
      }
      // An element that is not an object (`null`, `3`) broke on `update.isLive`
      // with a 500.
      if (!updates.every((u) => u !== null && typeof u === "object" && !Array.isArray(u))) {
        return c.json({ error: "updates must be an array of objects" }, 400);
      }

      let updated = 0;

      for (const update of updates as Record<string, any>[]) {
        const result = await dbInstance
          .update(streamers)
          .set({
            isLive: update.isLive ?? false,
            viewerCount: update.viewerCount ?? 0,
            currentStreamTitle: update.currentStreamTitle || null,
            thumbnailId: update.thumbnailId || null,
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(eq(streamers.channelId, update.channelId), eq(streamers.platform, update.platform))
          )
          .returning();

        if (result.length > 0) updated++;
      }

      return c.json({ synced: updated, total: updates.length });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // PARAMETERIZED ROUTES (must come AFTER specific routes)
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Get Streamer by ID ──
  app.get(
    "/:id",
    {
      id: "get-streamer",
      summary: "Read a streamer",
      description: "One streamer by id. Public. 404 if it does not exist or the id is not a uuid.",
      access: "public",
      input: { params: ParamId },
      output: { schema: StreamerOut },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { id } = c.req.param();
      if (!UUID.test(id)) return c.json({ error: "Streamer not found" }, 404);

      const result = await dbInstance.select().from(streamers).where(eq(streamers.id, id)).limit(1);

      if (!result.length) return c.json({ error: "Streamer not found" }, 404);

      return c.json(result[0]);
    }
  );

  // ── Create Streamer ──
  app.post(
    "/",
    {
      id: "create-streamer",
      summary: "Create a streamer",
      description:
        "Adds a streamer to the site (displayName, platform and channelId required; slug defaults to one made from displayName), optionally with its games (`gameIds`, first = primary). Site staff, or an agent with streamer:create. 400 names the invalid field; 409 if the slug or the platform+channel already exist.",
      access: "session",
      permission: OF_TEAM("create"),
      input: { body: NewStreamer, validatesHandler: true },
      output: { status: 201, schema: StreamerOut },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const raw = input.body ?? null;
      const clean = cleanStreamer((raw ?? {}) as Record<string, unknown>, false);
      if (!clean.ok) return c.json({ error: clean.error }, 400);
      const body = clean.value as Record<string, any>;

      let streamer: typeof streamers.$inferSelect;
      try {
        [streamer] = await dbInstance
          .insert(streamers)
          .values({
            displayName: body.displayName,
            slug: body.slug || body.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            platform: body.platform,
            channelId: body.channelId,
            channelUrl: body.channelUrl ?? null,
            bio: body.bio ?? null,
            avatarId: body.avatarId ?? null,
            thumbnailId: body.thumbnailId ?? null,
            socialLinks: body.socialLinks ?? null,
            // The live fields the body accepts are stored too (the sync job overwrites them later).
            isLive: body.isLive ?? false,
            viewerCount: body.viewerCount ?? 0,
            followerCount: body.followerCount ?? 0,
            currentStreamTitle: body.currentStreamTitle ?? null,
            currentGameId: body.currentGameId ?? null,
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err)) return c.json({ error: DUPLICATE }, 409);
        throw err;
      }

      // Handle game associations
      if (body.gameIds?.length) {
        await dbInstance.insert(gamesToStreamers).values(
          body.gameIds.map((gameId: string, idx: number) => ({
            streamerId: streamer.id,
            gameId,
            isPrimary: idx === 0,
          }))
        );
      }

      return c.json(streamer, 201);
    }
  );

  // ── Update Streamer ──
  app.patch(
    "/:id",
    {
      id: "update-streamer",
      summary: "Update a streamer",
      description:
        "Partial update: only the fields sent change (unknown fields are ignored). `gameIds` replaces the streamer's games. Site staff, or an agent with streamer:update. 404 if it does not exist; 400 names the invalid field; 409 on a duplicated slug or platform+channel.",
      access: "session",
      permission: OF_TEAM("update"),
      input: { params: ParamId, body: NewStreamer.partial(), validatesHandler: true },
      output: { schema: StreamerOut },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const { id } = c.req.param();
      if (!UUID.test(id)) return c.json({ error: "Streamer not found" }, 404);
      const raw = input.body ?? null;
      const clean = cleanStreamer((raw ?? {}) as Record<string, unknown>, true);
      if (!clean.ok) return c.json({ error: clean.error }, 400);

      // `socialLinks` already arrives serialized from `cleanStreamer`.
      const { gameIds, ...columnUpdates } = clean.value as Record<string, any>;

      let updated: typeof streamers.$inferSelect | undefined;
      try {
        [updated] = await dbInstance
          .update(streamers)
          .set({ ...columnUpdates, updatedAt: new Date() })
          .where(eq(streamers.id, id))
          .returning();
      } catch (err) {
        if (isUniqueViolation(err)) return c.json({ error: DUPLICATE }, 409);
        throw err;
      }

      if (!updated) return c.json({ error: "Streamer not found" }, 404);

      // Sync game associations if provided
      if (gameIds !== undefined) {
        await dbInstance.delete(gamesToStreamers).where(eq(gamesToStreamers.streamerId, id));
        if (gameIds.length > 0) {
          await dbInstance.insert(gamesToStreamers).values(
            gameIds.map((gameId: string, idx: number) => ({
              streamerId: id,
              gameId,
              isPrimary: idx === 0,
            }))
          );
        }
      }

      return c.json(updated);
    }
  );

  // ── Delete Streamer ──
  app.delete(
    "/:id",
    {
      id: "delete-streamer",
      summary: "Delete a streamer",
      description:
        "Deletes a streamer and its game associations. Cannot be undone. Site staff, or an agent with streamer:delete. 404 if it does not exist.",
      access: "session",
      permission: OF_TEAM("delete"),
      input: { params: ParamId },
      output: { schema: z.object({ deleted: z.literal(true), id: z.string() }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { id } = c.req.param();
      if (!UUID.test(id)) return c.json({ error: "Streamer not found" }, 404);

      const [deleted] = await dbInstance
        .delete(streamers)
        .where(eq(streamers.id, id))
        .returning({ id: streamers.id });

      if (!deleted) return c.json({ error: "Streamer not found" }, 404);

      return c.json({ deleted: true, id: deleted.id });
    }
  );

  return app.ops;
}

/**
 * Factory function that creates Streamers routes with dependency injection:
 * the operations router (what `createRouter` mounted before the SDK).
 */
export function createStreamersRouter(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, streamersOperations(ctx), ctx);
}

// Legacy export for backward compatibility
export { createStreamersRouter as streamersRoutes };

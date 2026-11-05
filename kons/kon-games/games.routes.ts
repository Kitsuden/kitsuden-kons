/**
 * Kitsuden CMS — Games Module Routes (DI Version)
 *
 * REST API for game library management with IGDB sync support.
 *
 * MIGRATED: Now uses Dependency Injection via KonContext
 * ENHANCED: Now includes the core media library's transform URLs (/api/media) for cover art and screenshots
 * SDK: each route is a declared OPERATION (see operations.ts):
 * id, schemas, access and permission; each handler's body is the same as always.
 *
 * ⚠️ CRITICAL: Route order matters in Hono!
 * Specific routes must be registered BEFORE parameterized routes. (The SDK,
 * moreover, refuses to mount an operation shadowed by an earlier one.)
 */

import {
  repo,
  can,
  eqEnum,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import {
  readReservedSegments,
  invalidGameSlugReason,
  gameSlug,
  spanishKeysError,
  type KonContext,
  type OperationPermission,
} from "@kitsuden/shared";

/**
 * The own routes of the site that serves the games (besides the common ones from
 * `@kitsuden/shared`): `KITSUDEN_RESERVED_SEGMENTS=tournaments,shop`. It is read
 * on every check so that an environment change in tests does not depend on
 * import order.
 */
const siteSegments = () => readReservedSegments(process.env.KITSUDEN_RESERVED_SEGMENTS);
import {
  eq,
  desc,
  asc,
  sql,
  ilike,
  and,
  inArray,
  getTableColumns,
  type AnyColumn,
} from "drizzle-orm";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { z } from "zod";

// Registers the "game" policy (side-effect).
import "./games.policy";
import type { GamesDb } from "./games.db";
import {
  failureResponse,
  gameToServe,
  isUuid,
  oldKeysInBlocks,
  sqlMergeEditorial,
  sqlBlocksWithEditorial,
  sqlSortBlocks,
  validateOrder,
  validateEditorialPatch,
} from "./games.editorial";
import {
  games,
  gamesToPlatforms,
  gamesToTags,
  platforms,
  tags,
  gameCollections,
  gameCollectionEntries,
} from "./games.schema";
import {
  ANY_ACCOUNT,
  Row,
  KON_ID,
  List,
  query,
  idOf,
  registry,
  text,
} from "./operations";

// ═══════════════════════════════════════════════════════════════════════════
// OPERATION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════
//
// `passthrough` on the bodies: the routes always ignored what they do not know
// (or passed it to the row), and closing them now would break whoever already uses them.
// What is declared is validated: a wrong type reached the code or the column
// and came out as a 500 (`body.name.toLowerCase()` without `name`, `platformIds` that is not
// a list…).

const ParamId = z.object({ id: idOf("Game id (uuid)") });
const CollectionParam = z.object({
  id: idOf("Collection id (uuid; anything else is a 404)"),
});
const ParamSlug = z.object({ slug: z.string().describe("Game slug (its address on the site)") });
const BlockIdParam = z.object({
  id: idOf("Game id (uuid; anything else is a 404)"),
  blockId: z.string().describe("Block id inside the game's `blocks` (e.g. cd-tier-list-2)"),
});

const WithMedia = query({
  includeMedia: text("`false` leaves out the `media` transform URLs (included by default)"),
});

const GameList = z
  .object({
    docs: z.array(Row),
    totalDocs: z.number(),
    totalPages: z.number(),
    page: z.number(),
    limit: z.number(),
    hasNextPage: z.boolean(),
    hasPrevPage: z.boolean(),
  })
  .passthrough();

const ids = (that: string) => z.array(z.string()).describe(that);
const nullableText = (max: number) => z.string().max(max).nullable().optional();

/** What is written for a game (create and edit). */
const GameFields = {
  title: z.string().max(500).optional(),
  slug: z
    .string()
    .max(500)
    .optional()
    .describe("Address of the game on the site (/<slug>/); derived from the title when missing"),
  subtitle: nullableText(500),
  description: z.unknown().optional().describe("Lexical rich text JSON"),
  excerpt: z.string().nullable().optional(),
  releaseDate: z.string().nullable().optional().describe("YYYY-MM-DD"),
  status: z.string().optional().describe("draft (default), published or archived"),
  developer: nullableText(200),
  publisher: nullableText(200),
  metacriticScore: z.number().int().nullable().optional(),
  userRating: z.number().nullable().optional(),
  coverArtId: z.string().nullable().optional().describe("Media id (uuid) of the cover art"),
  coverFocalPoint: z.unknown().optional().describe("{ x, y } focal point of the cover"),
  trailerUrl: z.string().nullable().optional(),
  externalIds: z.unknown().optional().describe("Object of external ids (igdb, steam…)"),
  specs: z.unknown().optional().describe("Object; specs.coverUrl / specs.heroUrl as external art"),
  screenshots: z.unknown().optional().describe("Array of { mediaId, caption?, focalPoint? }"),
  blocks: z.unknown().optional().describe("Array of page blocks (replaced as a whole)"),
  isFeaturedOnHome: z.boolean().optional(),
  platformIds: ids("Platform ids (GET /api/games/platforms); replaces the links").optional(),
  tagIds: ids("Tag ids (GET /api/games/tags); replaces the links").optional(),
};
const NewGame = z.object(GameFields).passthrough();
const GameEdit = z.object(GameFields).passthrough();

/**
 * Collections: `title` and `gameIds` are validated by the handler, with its usual
 * 400 (`field`), which tests/unit/games-collections-validation.test.ts pins down.
 * Optional body: the handler answered 400 "title is required" for an
 * empty body too.
 */
const CollectionFields = {
  title: z.unknown().optional().describe("Text (required on create, not empty)"),
  slug: z.string().max(200).optional().describe("Derived from the title when missing"),
  displayOrder: z.number().int().optional(),
  gameIds: z
    .unknown()
    .optional()
    .describe("Array of game ids (uuid), in order; on edit it replaces the entries"),
};
const NewCollection = z.object(CollectionFields).passthrough().optional();
const CollectionEdit = z.object(CollectionFields).passthrough().optional();

const NewPlatform = z
  .object({
    name: z.string().min(1).max(100),
    slug: z.string().max(100).optional().describe("Derived from the name when missing"),
    shortName: nullableText(20),
    manufacturer: nullableText(100),
    iconId: z.string().nullable().optional().describe("Media id (uuid) of the icon"),
  })
  .passthrough();

const NewTag = z
  .object({
    name: z.string().min(1).max(100),
    slug: z.string().max(100).optional().describe("Derived from the name when missing"),
    color: nullableText(7).describe("#rrggbb"),
    category: z.string().nullable().optional().describe("genre, feature, topic, series…"),
  })
  .passthrough();

/**
 * The editorial layer (Inti). It is validated by the handler (`validateEditorialPatch`,
 * `validateOrder`) with its usual 400; this is what gets published.
 */
const EditorialPatch = z
  .object({
    title: z.string().max(500).nullable().optional(),
    description: z.string().max(5000).nullable().optional(),
    hidden: z.boolean().nullable().optional(),
  })
  .strict()
  .describe(
    "Only title, description, hidden; null removes the field. A 0.8 name (titulo, descripcion, oculto) is a 422."
  );
const BlockOrder = z
  .object({
    ids: z
      .array(z.string().min(1).max(500))
      .min(1)
      .describe("Every block id of the game, in the new order"),
  })
  .strict();

/** Inti's scope: it also opens the editorial layer (like the core's gate). */
const EDITORIAL_LAYER: OperationPermission = {
  scopes: ["content:edit"],
  ...ANY_ACCOUNT,
};

/**
 * A collection id that is not a uuid does not exist: 404 BEFORE querying (a
 * Postgres 22P02 error left the RLS transaction aborted and a 500 came out).
 * It used to be a router `use("*")` (one more `ALL` route in the authorization
 * matrix); now it goes in `before` of the three operations with `:id`.
 */
const collectionWithUuid: MiddlewareHandler = async (c, next) => {
  if (!isUuid(c.req.param("id") ?? "")) return c.json({ error: "Collection not found" }, 404);
  await next();
};

/**
 * The kon's operations (see operations.ts). They are declared in the usual
 * order: literals before `/:id`.
 */
export function gamesOperations(ctx: KonContext): AnyOperation[] {
  const gamesRoutes = registry();
  const { db } = ctx;

  // Helper to get db instance
  const dbInstance = db.instance as GamesDb;

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC/SPECIFIC ROUTES (must come before parameterized routes)
  // ═══════════════════════════════════════════════════════════════════════════

  // ── List Games ──
  gamesRoutes.get(
    "/",
    {
      id: "list-games",
      summary: "List games",
      description:
        "Paginated games (`limit` up to 100, `page`), sorted by `sort` (a column, `-` for descending; `-metacriticScore` by default, title as tie-break), filtered by `search` (title) and `featured=true`. Only published games unless the caller is staff and asks for another `status`. Each game carries `media` transform URLs unless `includeMedia=false`.",
      access: "optional",
      input: {
        query: query({
          limit: text("Page size (default 24, max 100)"),
          page: text("Page number (from 1)"),
          sort: text("Column to sort by; prefix with - for descending"),
          status: text("draft, published or archived (staff only; others always get published)"),
          search: text("Text in the title"),
          featured: text("`true` = only games featured on the home page"),
          includeMedia: text("`false` leaves out the `media` transform URLs"),
        }),
      },
      output: { schema: GameList },
    },
    async (c) => {
      const limit = Math.min(Number(c.req.query("limit")) || 24, 100);
      const page = Math.max(Number(c.req.query("page")) || 1, 1);
      const offset = (page - 1) * limit;
      const sort = c.req.query("sort") || "-metacriticScore";
      /**
       * ── STATUS IS NEGOTIATED, NOT ACCEPTED ──────────────────────────────────
       *
       * Here it said `c.req.query("status") || "published"` and used it as is.
       * Verified without any cookie:
       *
       *     GET /api/games?status=draft  →  200 with the whole draft
       *
       * The default was `published`, so the route looked right as long as
       * nobody wrote another value. A safe default is not a permission.
       *
       * The `game.view` policy already says who can see a draft; it is asked
       * with a sample resource instead of repeating the role rule here, which
       * is how the two copies end up diverging.
       */
      const userValue = (c.get("user") ?? null) as AuthzUser | null;
      const canViewUnpublished = await can(userValue, "view", { id: "*", status: "draft" }, "game");

      const request = c.req.query("status");
      const status = canViewUnpublished && request ? request : "published";
      const search = c.req.query("search");
      const featured = c.req.query("featured");
      // Query param to include media transform URLs
      const includeMedia = c.req.query("includeMedia") !== "false";

      /**
       * `sort` was `games[sort]` unchecked: a column that does not exist gave
       * `desc(undefined)` and a 500. Now it is a 400 that says which one fails.
       */
      const field = sort.startsWith("-") ? sort.slice(1) : sort;
      const columns = getTableColumns(games) as Record<string, AnyColumn>;
      if (!Object.hasOwn(columns, field)) {
        return c.json(
          { error: `«sort» does not accept «${field}»: not a column`, field: "sort" },
          400
        );
      }
      const column = columns[field]!;

      const where = and(
        eqEnum(games.status, status),
        search ? ilike(games.title, `%${search}%`) : undefined,
        featured === "true" ? eq(games.isFeaturedOnHome, true) : undefined
      );

      /**
       * The default order is `-metacriticScore`, and almost no game has a
       * score: without a second criterion, Postgres breaks ties as it likes and the "Popular
       * games" row comes out in a different order on every request. The
       * title breaks ties in a stable way.
       */
      const orderBy = [sort.startsWith("-") ? desc(column) : asc(column), asc(games.title)];

      // In series: one connection (the request transaction), one query at a time.
      const docs = await dbInstance
        .select()
        .from(games)
        .where(where)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset);
      const countResult = await dbInstance
        .select({ count: sql<number>`count(*)` })
        .from(games)
        .where(where);

      const totalDocs = Number(countResult[0]?.count ?? 0);
      const totalPages = Math.ceil(totalDocs / limit);

      // Enrich with media transform URLs if requested
      // `gameToServe`: blocks with English keys even if a 0.8 one is stored (Remove in 0.10).
      const served = docs.map((game) => gameToServe(game));
      const enrichedDocs = includeMedia
        ? served.map((game) => enrichGameWithMediaUrls(game))
        : served;

      return c.json({
        docs: enrichedDocs,
        totalDocs,
        totalPages,
        page,
        limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      });
    }
  );

  // ── Get Game by Slug ──
  // SPECIFIC ROUTE: must come before /:id
  gamesRoutes.get(
    "/slug/:slug",
    {
      id: "get-game-by-slug",
      summary: "Read a game by slug",
      description:
        "The game at that slug with its platforms and tags, and `media` transform URLs unless `includeMedia=false`. A draft is a 404 unless the caller is staff.",
      access: "optional",
      input: { params: ParamSlug, query: WithMedia },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { slug } = c.req.param();
      // Query param to include media transform URLs
      const includeMedia = c.req.query("includeMedia") !== "false";

      const result = await dbInstance.select().from(games).where(eq(games.slug, slug)).limit(1);

      if (!result.length) return c.json({ error: "Game not found" }, 404);

      const game = result[0];

      /**
       * ── THE SAME POLICY AS `/:id`, WHICH WAS MISSING HERE ───────────────────
       *
       * `GET /:id` already asked `can(user, "view", …)` and returned 404. This
       * route asked NOTHING: guessing the slug was enough to read a whole
       * draft game, without a session. Verified against the real installation
       * by creating a draft and requesting it without a cookie: 200 with the content.
       *
       * And guessing a slug is easy —it is the title—, much more than a uuid. The
       * open door was the wider of the two.
       *
       * 404 and not 403, as in `/:id`: a 403 confirms the game exists, and
       * with that the unpublished catalog is guessed by trying titles.
       */
      const user = (c.get("user") ?? null) as AuthzUser | null;
      if (!(await can(user, "view", game, "game"))) {
        return c.json({ error: "Game not found" }, 404);
      }

      // In series: one connection (the request transaction), one query at a time.
      const gamePlatforms = await dbInstance
        .select({ platform: platforms })
        .from(gamesToPlatforms)
        .innerJoin(platforms, eq(gamesToPlatforms.platformId, platforms.id))
        .where(eq(gamesToPlatforms.gameId, game.id));
      const gameTags = await dbInstance
        .select({ tag: tags })
        .from(gamesToTags)
        .innerJoin(tags, eq(gamesToTags.tagId, tags.id))
        .where(eq(gamesToTags.gameId, game.id));

      // Build response (`gameToServe`: blocks with English keys, see games.editorial.ts)
      const response: any = {
        ...gameToServe(game),
        platforms: gamePlatforms.map((r) => r.platform),
        tags: gameTags.map((r) => r.tag),
      };

      // Enrich with media URLs if requested
      if (includeMedia) {
        response.media = buildGameMediaUrls(game);
      }

      return c.json(response);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ROUTES WITH A LITERAL PREFIX — they go BEFORE `/:id`
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // The notice "PARAMETERIZED ROUTES (must come AFTER specific routes)" was already
  // written further down, and yet these routes were added AFTER `/:id`.
  //
  // Hono resolves by registration order: `/:id` captured `/collections`,
  // `/platforms` and `/tags` with `id="collections"`, the query did
  // `WHERE games.id = 'collections'` and Postgres answered
  //
  //     invalid input syntax for type uuid: "collections"
  //
  // a 500 on `GET /api/games/collections` — not a 404, which would at least have
  // pointed at the route. It is watched by `the core's tests/unit/shadowed-routes.test.ts` (and
  // now also by the SDK, which does not mount an operation shadowed by another).

  // ═══════════════════════════════════════════════════════════════════════════
  // COLLECTIONS CRUD (migrated from apps/api/src/routes/collections.ts)
  // ═══════════════════════════════════════════════════════════════════════════

  // ── List all collections (with games) ──
  gamesRoutes.get(
    "/collections",
    {
      id: "list-collections",
      summary: "List game collections",
      description:
        "Every curated collection in display order, each with its published games (in entry order) and the tag and platform slugs of each game. Cached for two minutes.",
      access: "public",
      output: { schema: List },
    },
    async (c) => {
      const cacheKey = "collections:list";
      const cached = await ctx.cache.get(cacheKey);
      if (cached) return c.json(cached);

      const collections = await dbInstance
        .select()
        .from(gameCollections)
        .orderBy(asc(gameCollections.displayOrder));

      // Fetch entries + games for each collection (in series: one connection, the
      // request transaction, one query at a time)
      const result: any[] = [];
      for (const col of collections as any[]) {
        const entries = await dbInstance
          .select({
            sortOrder: gameCollectionEntries.sortOrder,
            game: games,
          })
          .from(gameCollectionEntries)
          .innerJoin(games, eq(gameCollectionEntries.gameId, games.id))
          // Published only: the list is public (and cached for everyone), and
          // a draft put in a collection came out whole (an earlier
          // audit). The team sees drafts through /api/games.
          .where(and(eq(gameCollectionEntries.collectionId, col.id), eq(games.status, "published")))
          .orderBy(asc(gameCollectionEntries.sortOrder));

        /**
         * The tags and platforms of each game, by SLUG. The sites filter
         * their shelf with them ("Free", "Co-op", "Switch"…) and without
         * this they would have to request each game's record, one request per
         * card. Two queries for the whole collection.
         */
        const ids = entries.map((e) => e.game.id);
        const tagsValue = ids.length
          ? await dbInstance
              .select({ gameId: gamesToTags.gameId, slug: tags.slug })
              .from(gamesToTags)
              .innerJoin(tags, eq(gamesToTags.tagId, tags.id))
              .where(inArray(gamesToTags.gameId, ids))
          : [];
        const platformsOf = ids.length
          ? await dbInstance
              .select({ gameId: gamesToPlatforms.gameId, slug: platforms.slug })
              .from(gamesToPlatforms)
              .innerJoin(platforms, eq(gamesToPlatforms.platformId, platforms.id))
              .where(inArray(gamesToPlatforms.gameId, ids))
          : [];
        const slugsDe = (rows: Array<{ gameId: string; slug: string }>, id: string) =>
          rows.filter((f) => f.gameId === id).map((f) => f.slug);

        const gamesWithCovers = entries.map((e) => ({
          ...gameToServe(e.game),
          tagSlugs: slugsDe(tagsValue, e.game.id),
          platformSlugs: slugsDe(platformsOf, e.game.id),
          _sortOrder: e.sortOrder,
        }));

        result.push({ ...col, games: gamesWithCovers });
      }

      const response = { docs: result, totalDocs: result.length };
      await ctx.cache.set(cacheKey, response, 120);
      return c.json(response);
    }
  );

  // ── Get single collection ──
  gamesRoutes.get(
    "/collections/:id",
    {
      id: "get-collection",
      summary: "Read a game collection",
      description:
        "The collection with its published games and their entries (sortOrder, gameId), in entry order.",
      access: "public",
      before: [collectionWithUuid],
      input: { params: CollectionParam },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const [col] = await dbInstance
        .select()
        .from(gameCollections)
        .where(eq(gameCollections.id, c.req.param("id")))
        .limit(1);

      if (!col) return c.json({ error: "Collection not found" }, 404);

      const entries = await dbInstance
        .select({
          sortOrder: gameCollectionEntries.sortOrder,
          gameId: gameCollectionEntries.gameId,
        })
        .from(gameCollectionEntries)
        .where(eq(gameCollectionEntries.collectionId, col.id))
        .orderBy(asc(gameCollectionEntries.sortOrder));

      // Fetch full game data for each entry (in series: the request
      // transaction is a single connection)
      const gameIds = entries.map((e) => e.gameId);
      const gameRows: Array<typeof games.$inferSelect | null> = [];
      for (const gid of gameIds) {
        const [g] = await dbInstance.select().from(games).where(eq(games.id, gid)).limit(1);
        gameRows.push(g || null);
      }

      // Published only (see the list of collections)
      const publishedItems = gameRows.filter(
        (g): g is NonNullable<typeof g> =>
          Boolean(g) && (g as { status?: string }).status === "published"
      );
      const visible = new Set(publishedItems.map((g) => (g as { id: string }).id));
      return c.json({
        ...col,
        games: publishedItems.map((g) => gameToServe(g)),
        entries: entries.filter((e) => visible.has(e.gameId)),
      });
    }
  );

  // ── Create collection ──
  gamesRoutes.post(
    "/collections",
    {
      id: "create-collection",
      summary: "Create a game collection",
      description:
        "Creates a curated collection (`title` required; slug derived from it when missing) and, with `gameIds`, its entries in that order. Staff only. Returns the collection row.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: NewCollection },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const body = await c.req.json().catch(() => null);
      // Without a title there is no collection: before, `body.title.toLowerCase()` blew up
      // (or the INSERT with title NULL) and the response was a 500 with the SQL inside.
      if (!body || typeof body.title !== "string" || !body.title.trim()) {
        return c.json({ error: "«title» is required", field: "title" }, 400);
      }
      if (body.gameIds !== undefined && !Array.isArray(body.gameIds)) {
        return c.json({ error: "«gameIds» must be a list", field: "gameIds" }, 400);
      }
      const slug =
        body.slug ||
        body.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");

      const [row] = await dbInstance
        .insert(gameCollections)
        .values({
          title: body.title,
          slug,
          displayOrder: body.displayOrder ?? 0,
        })
        .returning();

      // Add games if provided
      if (body.gameIds?.length) {
        await dbInstance.insert(gameCollectionEntries).values(
          body.gameIds.map((gameId: string, i: number) => ({
            collectionId: row.id,
            gameId,
            sortOrder: i,
          }))
        );
      }

      await ctx.cache.invalidate("collections:*");
      return c.json(row, 201);
    }
  );

  // ── Update collection ──
  gamesRoutes.patch(
    "/collections/:id",
    {
      id: "update-collection",
      summary: "Update a game collection",
      description:
        "Changes the given fields (title, slug, displayOrder) and, if `gameIds` is sent, replaces the entries with that list in order. Staff only. Returns the collection row.",
      access: "session",
      permission: ANY_ACCOUNT,
      before: [collectionWithUuid],
      input: { params: CollectionParam, body: CollectionEdit },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const id = c.req.param("id");
      if (!body || typeof body !== "object") {
        return c.json({ error: "The body must be a JSON object" }, 400);
      }
      if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim())) {
        return c.json({ error: "«title» cannot be empty", field: "title" }, 400);
      }
      if (body.gameIds !== undefined && !Array.isArray(body.gameIds)) {
        return c.json({ error: "«gameIds» must be a list", field: "gameIds" }, 400);
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.title !== undefined) updates.title = body.title;
      if (body.slug !== undefined) updates.slug = body.slug;
      if (body.displayOrder !== undefined) updates.displayOrder = body.displayOrder;

      const [updated] = await dbInstance
        .update(gameCollections)
        .set(updates)
        .where(eq(gameCollections.id, id))
        .returning();

      if (!updated) return c.json({ error: "Collection not found" }, 404);

      // Replace games if provided
      if (body.gameIds !== undefined) {
        await dbInstance
          .delete(gameCollectionEntries)
          .where(eq(gameCollectionEntries.collectionId, id));

        if (body.gameIds.length > 0) {
          await dbInstance.insert(gameCollectionEntries).values(
            body.gameIds.map((gameId: string, i: number) => ({
              collectionId: id,
              gameId,
              sortOrder: i,
            }))
          );
        }
      }

      await ctx.cache.invalidate("collections:*");
      return c.json(updated);
    }
  );

  // ── Delete collection ──
  gamesRoutes.delete(
    "/collections/:id",
    {
      id: "delete-collection",
      summary: "Delete a game collection",
      description:
        "Deletes the collection and its entries (the games stay). Staff only. Returns { success, id }.",
      access: "session",
      permission: ANY_ACCOUNT,
      before: [collectionWithUuid],
      input: { params: CollectionParam },
      output: { schema: z.object({ success: z.literal(true), id: z.string() }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const [deleted] = await dbInstance
        .delete(gameCollections)
        .where(eq(gameCollections.id, c.req.param("id")))
        .returning();
      if (!deleted) return c.json({ error: "Collection not found" }, 404);
      await ctx.cache.invalidate("collections:*");
      return c.json({ success: true, id: deleted.id });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // PLATFORMS & TAGS CRUD (migrated from apps/api/src/routes/crud.ts)
  // ═══════════════════════════════════════════════════════════════════════════

  // ── List Platforms ──
  gamesRoutes.get(
    "/platforms",
    {
      id: "list-platforms",
      summary: "List platforms",
      description: "Every gaming platform (PC, consoles, mobile…) by name, with its id and slug.",
      access: "public",
      output: { schema: List },
    },
    async (c) => {
      const docs = await dbInstance.select().from(platforms).orderBy(platforms.name);
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  // ── Create Platform ──
  gamesRoutes.post(
    "/platforms",
    {
      id: "create-platform",
      summary: "Create a platform",
      description:
        "Creates a gaming platform (`name` required; slug derived from it when missing). Staff only. Returns the row; 409 if the slug exists.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: NewPlatform },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const body = await c.req.json();
      const [row] = await dbInstance
        .insert(platforms)
        .values({
          name: body.name,
          slug: body.slug || body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          shortName: body.shortName,
          manufacturer: body.manufacturer,
          iconId: body.iconId,
        })
        .returning();
      return c.json(row, 201);
    }
  );

  // ── List Tags ──
  gamesRoutes.get(
    "/tags",
    {
      id: "list-tags",
      summary: "List game tags",
      description: "Every game tag (genre, feature, topic, series…) by name, with its id and slug.",
      access: "public",
      output: { schema: List },
    },
    async (c) => {
      const docs = await dbInstance.select().from(tags).orderBy(tags.name);
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  // ── Create Tag ──
  gamesRoutes.post(
    "/tags",
    {
      id: "create-tag",
      summary: "Create a game tag",
      description:
        "Creates a game tag (`name` required; slug derived from it when missing). Staff only. Returns the row; 409 if the slug exists.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: NewTag },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const body = await c.req.json();
      const [row] = await dbInstance
        .insert(tags)
        .values({
          name: body.name,
          slug: body.slug || body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          color: body.color,
          category: body.category,
        })
        .returning();
      return c.json(row, 201);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // PARAMETERIZED ROUTES (must come AFTER specific routes)
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Get Game by ID ──
  gamesRoutes.get(
    "/:id",
    {
      id: "get-game",
      summary: "Read a game",
      description:
        "The game row with `media` transform URLs unless `includeMedia=false`. A draft is a 404 unless the caller is staff.",
      access: "optional",
      input: { params: ParamId, query: WithMedia },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { id } = c.req.param();
      // Query param to include media transform URLs
      const includeMedia = c.req.query("includeMedia") !== "false";

      // ── Reference for the new stack ──
      // 1) repo() instead of select().from().where().limit(1): more readable and, inside
      //    a request with transactional RLS, it runs under the tx automatically.
      const game = await repo(games, { db: dbInstance }).find(id);
      if (!game) return c.json({ error: "Game not found" }, 404);

      // 2) Authorization policy: a draft is only seen by the team. We return
      //    404 (not 403) so as not to leak the resource's existence.
      const user = (c.get("user") ?? null) as AuthzUser | null;
      if (!(await can(user, "view", game, "game"))) {
        return c.json({ error: "Game not found" }, 404);
      }

      // Build response (`gameToServe`: blocks with English keys, see games.editorial.ts)
      const response: any = { ...gameToServe(game) };

      // Enrich with media URLs if requested
      if (includeMedia) {
        response.media = buildGameMediaUrls(game);
      }

      return c.json(response);
    }
  );

  /**
   * ── CREATE AND EDIT: THE POLICY, NOT JUST THE GATE ───────────────────────
   *
   * Games have no owner (owner decision): creating and
   * editing belong to the TEAM (`game.create` / `game.update`, admin + editor) and
   * deleting, to the admin (`game.delete`). Before, these two routes did not ask
   * the policy —only the core's gate decided— and the policy said "admin or
   * owner" for editing: two different rules for the same thing. The blocks'
   * editorial layer (below) is separate: it is also opened by Inti's content
   * scope at the core's gate (auth-guard.ts).
   *
   * With the SDK, the create and edit policy is checked by the declaration
   * (`permission`), BEFORE reading the body, as the handler used to. And the handler
   * asks it again with `h.can`: that way a DENIAL on the key
   * (`!game:update` over `games:*`) still closes, which is what
   * `can()` did and what the SDK's scope-based permission alone does not see.
   */
  const prohibited = (c: Context, that: string) =>
    c.json(
      { error: "Forbidden", message: `Only the team (admin or editor) can ${that} a game` },
      403
    );

  // ── Create Game ──
  gamesRoutes.post(
    "/",
    {
      id: "create-game",
      summary: "Create a game",
      description:
        "Creates a game (draft by default) and, with `platformIds` / `tagIds`, its links. The slug (derived from the title when missing) is its address on the site, so a slug taken by a site route is a 400. Staff only. Returns the game row; 409 if the slug exists.",
      access: "session",
      permission: {
        policy: { resource: "game", action: "create" },
        resourceScope: () => "game:create",
      },
      input: { body: NewGame },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, _input, h) => {
      if (!(await h.can({ id: "*" }))) return prohibited(c, "create");
      const body = await c.req.json();

      /**
       * ── THE SLUG IS THE GAME'S ADDRESS ────────────────────────────────────
       *
       * The frontend serves each game at `/<slug>/`, and the site's fixed routes
       * win over dynamic ones. A game with slug `blog` gave no error: it was created
       * fine and nobody ever reached it. It is prevented here because it is the only
       * moment when whoever creates it can choose another. The rule lives in
       * `@kitsuden/shared` alongside the frontend's.
       */
      const slug = body.slug ? String(body.slug) : gameSlug(String(body.title ?? ""));
      const reason = invalidGameSlugReason(slug, siteSegments());
      if (reason) return c.json({ error: reason, field: "slug" }, 400);
      const oldKeys = oldKeysInBlocks(body.blocks);
      if (oldKeys.length) return c.json(spanishKeysError(oldKeys, "game's blocks"), 422);

      const [game] = await dbInstance
        .insert(games)
        .values({
          title: body.title,
          slug,
          subtitle: body.subtitle,
          description: body.description,
          excerpt: body.excerpt,
          releaseDate: body.releaseDate,
          status: body.status || "draft",
          developer: body.developer,
          publisher: body.publisher,
          metacriticScore: body.metacriticScore,
          userRating: body.userRating,
          coverArtId: body.coverArtId,
          coverFocalPoint: body.coverFocalPoint,
          trailerUrl: body.trailerUrl,
          externalIds: body.externalIds,
          specs: body.specs,
          screenshots: body.screenshots,
          blocks: body.blocks || [],
          isFeaturedOnHome: body.isFeaturedOnHome ?? false,
        } as any)
        .returning();

      // Handle platform relations
      if (body.platformIds?.length) {
        await dbInstance.insert(gamesToPlatforms).values(
          body.platformIds.map((platformId: string) => ({
            gameId: game.id,
            platformId,
          }))
        );
      }

      // Handle tag relations
      if (body.tagIds?.length) {
        await dbInstance.insert(gamesToTags).values(
          body.tagIds.map((tagId: string) => ({
            gameId: game.id,
            tagId,
          }))
        );
      }

      return c.json(game, 201);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // EDITORIAL LAYER OF THE BLOCKS (Inti, agents with `content:edit`)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // `PATCH /:id` replaces `blocks` WHOLE: two editors touching different
  // blocks at the same time clobbered each other, and what was edited lived in `data`, which the
  // loader regenerates. These two routes write only the `editorial` layer of
  // each block, merging on the server in ONE statement (see
  // `games.editorial.ts`). Who can: the gate in `auth-guard.ts`
  // (`ADMIN_ONLY_ROUTES`): staff, or an agent with `content:edit` or `admin`.
  // The declaration repeats the same for the agent (`EDITORIAL_LAYER`): the SDK
  // does not apply the host's "a key is not an account" rule.

  const rowsOf = (r: unknown): Array<Record<string, unknown>> =>
    Array.isArray(r)
      ? (r as Array<Record<string, unknown>>)
      : Array.isArray((r as { rows?: unknown })?.rows)
        ? (r as { rows: Array<Record<string, unknown>> }).rows
        : [];

  const gameExists = async (id: string) =>
    (await dbInstance.select({ id: games.id }).from(games).where(eq(games.id, id)).limit(1))
      .length > 0;

  /** JSON body or `undefined` if it is not one (validation turns it into a 400). */
  const jsonBody = async (c: { req: { json: () => Promise<unknown> } }) => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };

  // ── Edit the editorial layer of a block ──
  gamesRoutes.patch(
    "/:id/blocks/:blockId/editorial",
    {
      id: "update-editorial-layer",
      summary: "Edit a game block's editorial layer",
      description:
        "Merges title / description / hidden (null removes one) into the `editorial` layer of one block of the game, atomically, without touching its `data` or the other blocks. A key from Kitsuden 0.8 (titulo, descripcion, oculto) is a 422 whose hint names the English one. Staff, or an agent with `content:edit`. Returns { id, editorial }.",
      access: "session",
      permission: EDITORIAL_LAYER,
      // The usual 400 (the `{ error }` of `validateEditorialPatch`), and its 422 for a 0.8 key,
      // which Inti's contract tests pin down: the SDK publishes the body but does not validate it.
      input: { params: BlockIdParam, body: EditorialPatch, validatesHandler: true },
      output: {
        schema: z.object({ id: z.string(), editorial: z.record(z.string(), z.unknown()) }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { id, blockId } = c.req.param();
      const patch = validateEditorialPatch(await jsonBody(c));
      if (!patch.ok) return c.json(...failureResponse(patch));
      if (!isUuid(id)) return c.json({ error: "Game not found" }, 404);

      const [rowValue] = rowsOf(
        await dbInstance.execute(sqlMergeEditorial(id, blockId, patch.value))
      );
      if (!rowValue) {
        return (await gameExists(id))
          ? c.json({ error: "Block not found", blockId }, 404)
          : c.json({ error: "Game not found" }, 404);
      }

      await ctx.cache.invalidate("collections:*");
      return c.json({ id: blockId, editorial: rowValue.editorial ?? {} });
    }
  );

  // ── Reorder the blocks (writes editorial.order) ──
  gamesRoutes.put(
    "/:id/blocks/order",
    {
      id: "reorder-blocks",
      summary: "Reorder a game's blocks",
      description:
        "Writes `editorial.order` of every block from `ids` (exactly the game's block ids, in the new order) without moving the array or touching `data`. Staff, or an agent with `content:edit`. Returns { id, ids }.",
      access: "session",
      permission: EDITORIAL_LAYER,
      // The usual 400 (`validateOrder`): the SDK publishes it but does not validate it.
      input: {
        params: z.object({ id: idOf("Game id (uuid; anything else is a 404)") }),
        body: BlockOrder,
        validatesHandler: true,
      },
      output: { schema: z.object({ id: z.string(), ids: z.array(z.string()) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { id } = c.req.param();
      const order = validateOrder(await jsonBody(c));
      if (!order.ok) return c.json(...failureResponse(order));
      if (!isUuid(id)) return c.json({ error: "Game not found" }, 404);

      const [rowValue] = rowsOf(await dbInstance.execute(sqlSortBlocks(id, order.value)));
      if (!rowValue) {
        return (await gameExists(id))
          ? c.json(
              { error: "«ids» must be exactly the set of ids of the game's blocks" },
              400
            )
          : c.json({ error: "Game not found" }, 404);
      }

      await ctx.cache.invalidate("collections:*");
      return c.json({ id, ids: order.value });
    }
  );

  // ── Update Game ──
  gamesRoutes.patch(
    "/:id",
    {
      id: "update-game",
      summary: "Update a game",
      description:
        "Changes the given columns and, if sent, replaces its platform and tag links (`platformIds`, `tagIds`). `blocks` replaces the whole array but keeps each block's editorial layer (by block id). Renaming the slug follows the same rule as creating. Staff only. Returns the game row.",
      access: "session",
      permission: {
        policy: { resource: "game", action: "update" },
        resourceScope: () => "game:update",
      },
      input: { params: ParamId, body: GameEdit },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, _input, h) => {
      const { id } = c.req.param();
      if (!(await h.can({ id }))) return prohibited(c, "edit");
      const body = await c.req.json();

      /**
       * Server fields are not written: `id` moved the primary key, and
       * a `createdAt` as text (what a GET returns) blew up Drizzle with
       * `value.toISOString is not a function` — a 500. `updatedAt` is set
       * by the route.
       */
      const {
        platformIds,
        tagIds,
        id: _id,
        createdAt: _created,
        updatedAt: _edited,
        ...columnUpdates
      } = body;

      // Renaming the slug is MOVING the game's address: same rule as when creating it
      if (columnUpdates.slug !== undefined) {
        const reason = invalidGameSlugReason(String(columnUpdates.slug), siteSegments());
        if (reason) return c.json({ error: reason, field: "slug" }, 400);
      }

      // Blocks speak the 0.9 contract: a 0.8 key (`titulo`…) would be saved and never read.
      const oldKeys = oldKeysInBlocks(columnUpdates.blocks);
      if (oldKeys.length) return c.json(spanishKeysError(oldKeys, "game's blocks"), 422);

      // Whoever saves the whole game (the panel) does not bring Inti's `editorial`
      // layer: the one from each block with the same id is preserved, as in reloads.
      if (Array.isArray(columnUpdates.blocks)) {
        columnUpdates.blocks = sqlBlocksWithEditorial(columnUpdates.blocks);
      }

      const [updated] = await dbInstance
        .update(games)
        .set({ ...columnUpdates, updatedAt: new Date() })
        .where(eq(games.id, id))
        .returning();

      if (!updated) return c.json({ error: "Game not found" }, 404);

      // Sync platform relations if provided
      if (platformIds !== undefined) {
        await dbInstance.delete(gamesToPlatforms).where(eq(gamesToPlatforms.gameId, id));
        if (platformIds.length > 0) {
          await dbInstance
            .insert(gamesToPlatforms)
            .values(platformIds.map((platformId: string) => ({ gameId: id, platformId })));
        }
      }

      // Sync tag relations if provided
      if (tagIds !== undefined) {
        await dbInstance.delete(gamesToTags).where(eq(gamesToTags.gameId, id));
        if (tagIds.length > 0) {
          await dbInstance
            .insert(gamesToTags)
            .values(tagIds.map((tagId: string) => ({ gameId: id, tagId })));
        }
      }

      // Collections carry the game's data (and its tags): do not let them serve the old version
      await ctx.cache.invalidate("collections:*");

      return c.json(updated);
    }
  );

  // ── Delete Game ──
  // Admin only (`game.delete` policy). Before, the route did not consult it: the
  // core's gate lets the team WRITE (admin and editor) and with that an
  // editor deleted any game, with its collections and its editorial layer.
  // `inHandler`: with no body to validate, the order does not change and the 403 keeps
  // its message. `resourceScope` makes `!game:delete` also close on an
  // agent with `games:*` (as `can()` did).
  gamesRoutes.delete(
    "/:id",
    {
      id: "delete-game",
      summary: "Delete a game",
      description:
        "Deletes the game with its platform/tag links and collection entries. Admin only (or an agent with the whole kon or `game:delete`). Returns { deleted, id }.",
      access: "session",
      permission: {
        policy: { resource: "game", action: "delete", inHandler: true },
        resourceScope: () => "game:delete",
      },
      input: { params: ParamId },
      output: { schema: z.object({ deleted: z.literal(true), id: z.string() }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, _input, h) => {
      const { id } = c.req.param();
      if (!(await h.can({ id }))) {
        return c.json(
          { error: "Forbidden", message: "Only an administrator can delete a game" },
          403
        );
      }

      const [deleted] = await dbInstance
        .delete(games)
        .where(eq(games.id, id))
        .returning({ id: games.id });

      if (!deleted) return c.json({ error: "Game not found" }, 404);

      return c.json({ deleted: true, id: deleted.id });
    }
  );

  return gamesRoutes.ops;
}

/**
 * The operations router (what the kon mounts and the tests use).
 */
export function createGamesRouter(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, gamesOperations(ctx), ctx);
}

// ═══════════════════════════════════════════════════════════════════════════
// MEDIA URL HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Enrich a game record with media transform URLs
 */
/**
 * Structural typing: what these functions READ, not the whole row — they are
 * called both with the full row and with partial projections.
 */
type GameMediaFields = Pick<
  typeof games.$inferSelect,
  "coverArtId" | "coverFocalPoint" | "screenshots"
> & { specs?: unknown };

/**
 * External art: `specs.coverUrl` and, for the header, `specs.heroUrl`.
 *
 * A newly created game has no image in the media library, and the site
 * drew empty cards and headers. With this an import can point
 * to the official art without downloading it; as soon as the editor uploads a cover to the
 * media library, that one wins. http(s) only: this value ends up in a `src`.
 *
 * The HEADER wants a landscape image and the CARD a vertical one, and they are not the
 * same: using the cover for both stretched a 600×900 capsule across
 * the width of a 1920 banner. If `heroUrl` is not there, it still falls back to the
 * cover, which is better than a gap.
 */
function externalArt(
  specs: unknown,
  preset: "hero" | "card" | "thumbnail" | "original"
): string | null {
  const s = specs as { coverUrl?: unknown; heroUrl?: unknown } | null;
  const url = preset === "hero" ? (s?.heroUrl ?? s?.coverUrl) : s?.coverUrl;
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

function enrichGameWithMediaUrls<T extends GameMediaFields>(
  game: T
): T & {
  media: ReturnType<typeof buildGameMediaUrls>;
} {
  return {
    ...game,
    media: buildGameMediaUrls(game),
  };
}

/**
 * Build all media URLs for a game
 */
function buildGameMediaUrls(game: GameMediaFields): {
  cover: {
    hero: string | null;
    card: string | null;
    thumbnail: string | null;
    original: string | null;
  };
  screenshots: Array<{
    mediaId: string;
    caption?: string;
    urls: {
      gallery: string | null;
      thumbnail: string | null;
      original: string | null;
    };
  }> | null;
} {
  // Build cover art URLs with focal point support
  const coverFocalPoint = game.coverFocalPoint as { x: number; y: number } | undefined;

  const external = (preset: "hero" | "card" | "thumbnail" | "original") =>
    game.coverArtId ? null : externalArt(game.specs, preset);
  const cover = {
    hero: buildCoverArtUrl(game.coverArtId, "hero", coverFocalPoint) ?? external("hero"),
    card: buildCoverArtUrl(game.coverArtId, "card", coverFocalPoint) ?? external("card"),
    thumbnail:
      buildCoverArtUrl(game.coverArtId, "thumbnail", coverFocalPoint) ?? external("thumbnail"),
    original: buildCoverArtUrl(game.coverArtId, "original", coverFocalPoint) ?? external("original"),
  };

  // Build screenshot URLs
  const screenshots =
    game.screenshots?.map((screenshot) => ({
      mediaId: screenshot.mediaId,
      caption: screenshot.caption,
      urls: {
        gallery: buildScreenshotUrl(screenshot.mediaId, "gallery", screenshot.focalPoint),
        thumbnail: buildScreenshotUrl(screenshot.mediaId, "thumbnail", screenshot.focalPoint),
        original: buildScreenshotUrl(screenshot.mediaId, "original", screenshot.focalPoint),
      },
    })) || null;

  return { cover, screenshots };
}

/**
 * Build cover art transform URL
 * Uses the core media library's preset endpoint: /api/media/preset/{id}/{preset}
 */
function buildCoverArtUrl(
  mediaId: string | null | undefined,
  preset: "hero" | "card" | "thumbnail" | "original",
  focalPoint?: { x: number; y: number }
): string | null {
  if (!mediaId) return null;

  // For original, use transform endpoint without preset
  if (preset === "original") {
    const params = new URLSearchParams();
    if (focalPoint) {
      params.append("fpx", focalPoint.x.toString());
      params.append("fpy", focalPoint.y.toString());
    }
    const query = params.toString();
    return query ? `/api/media/transform/${mediaId}?${query}` : `/api/media/transform/${mediaId}`;
  }

  // Use preset endpoint for transforms
  // Note: Focal point would be handled by the core media library if configured
  return `/api/media/preset/${mediaId}/${preset}`;
}

/**
 * Build screenshot transform URL
 * Uses the core media library's preset endpoint: /api/media/preset/{id}/{preset}
 */
function buildScreenshotUrl(
  mediaId: string | null | undefined,
  preset: "gallery" | "thumbnail" | "original",
  focalPoint?: { x: number; y: number }
): string | null {
  if (!mediaId) return null;

  // For original, use transform endpoint
  if (preset === "original") {
    const params = new URLSearchParams();
    if (focalPoint) {
      params.append("fpx", focalPoint.x.toString());
      params.append("fpy", focalPoint.y.toString());
    }
    const query = params.toString();
    return query ? `/api/media/transform/${mediaId}?${query}` : `/api/media/transform/${mediaId}`;
  }

  // Use preset endpoint for transforms
  return `/api/media/preset/${mediaId}/${preset}`;
}

// Legacy export for backward compatibility
export { createGamesRouter as gamesRoutes };

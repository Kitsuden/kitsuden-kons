/**
 * @kitsuden/kon-wiki
 * ============================================================================
 *
 * Wikis with HISTORY. What separates a wiki from a blog is not the content,
 * it is that every edit is recorded, the diff can be read and it can be
 * reverted — and that is what makes it possible to open editing to the community.
 *
 * ── ONE WIKI PER GAME, INSIDE THE GAME ─────────────────────────────────────
 *
 * Each wiki is its own space: its pages live INSIDE it and their slug is
 * unique there, not across the whole installation. All page routes carry
 * `/wikis/:wiki/` for that reason.
 *
 * On the public site it is read at `/<game>/wiki/`, inside the site that serves
 * its game. Until 2026-09-21 each wiki had its own subdomain
 * (`<wiki>.<domain>`), and this kon generated that URL. It no longer generates any:
 * the address comes from the GAME and the site that serves it, and the
 * frontend knows that, not the API. That is why a new wiki requires a game, and a game has
 * only one: two wikis of the same game would fight over `/<game>/wiki/`.
 */

import {
  defineKonSdk,
  repo,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import { invalidWikiSlugReason, type KonContext, type KonDefinition } from "@kitsuden/shared";
import { and, count, desc, eq, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "@kitsuden/engine/zod";

import "./wiki.policy.js";
import {
  diffLines,
  diffStats,
  extractLinks,
  isMeaningfulEdit,
  prepareRevert,
  slugify,
} from "./wiki.engine.js";
import { wikiLinks, wikiPages, wikiRevisions, wikis, type Wiki } from "./wiki.schema.js";
import {
  Row,
  KON_ID,
  query,
  registry,
  onThePage,
  onTheWikis,
  text,
} from "./operations.js";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

export * from "./wiki.engine.js";
export * from "./wiki.schema.js";

const EditPage = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(500_000),
  summary: z.string().max(200).optional(),
});

/**
 * The catalog game something belongs to: its slug in kon-games (`/api/games`). Every gaming kon
 * takes it as `game`, stores it in a `game` column and filters its list with `?game=`.
 */
const GameSlug = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "game: a game slug (lowercase letters, numbers and hyphens)");

/** A uuid, the way the catalog numbers its games (`gameId`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NewWiki = z
  .object({
    title: z.string().trim().min(1).max(200),
    /** If missing, it is derived from the title with the same rule as pages */
    slug: z.string().trim().max(63).optional(),
    description: z.string().max(2000).optional(),
    /** The game by its catalog uuid (what the panel's game picker sends). */
    gameId: z.guid({ message: "Choose the game: the wiki is published inside it." }).optional(),
    /** The game by its slug: the field every gaming kon shares. */
    game: GameSlug.optional().describe("Slug of the catalog game the wiki belongs to"),
  })
  // The wiki is published at `/<game>/wiki/`: it needs its game, named either way.
  .refine((w) => w.gameId !== undefined || w.game !== undefined, {
    message: "Choose the game: the wiki is published inside it.",
    path: ["gameId"],
  });

/** `[[…]]` links indexed per page (backlinks and requested pages). */
export const MAX_LINKS_PER_PAGE = 1000;

/** Revision number from the URL, or `null` if it is not a positive integer. */
function revisionNumber(rawValue: string | undefined): number | null {
  if (!rawValue || !/^[0-9]{1,9}$/.test(rawValue)) return null;
  const n = Number(rawValue);
  return n >= 1 ? n : null;
}

// ── Parameters and outputs (OpenAPI and MCP) ─────────────────────────────────

const pWiki = z.string().describe("Wiki slug (e.g. elden-ring)");
const pPage = z.string().describe("Page slug inside that wiki");
const ParamWiki = z.object({ wiki: pWiki });
const PageParam = z.object({ wiki: pWiki, slug: pPage });
const ParamDiff = z.object({
  wiki: pWiki,
  slug: pPage,
  from: z.string().describe("Revision number (older)"),
  to: z.string().describe("Revision number (newer)"),
});
const RevertParam = z.object({
  wiki: pWiki,
  slug: pPage,
  number: z.string().describe("Revision number to bring back"),
});

/** A wiki: id, slug, title… and whatever grows. */
const WikiOut = Row;
/** A page: without its content (that goes separately, from its current revision). */
const PageOut = Row;
const PageSummary = z
  .object({ slug: z.string(), title: z.string(), currentRevision: z.number().int() })
  .passthrough();

export function wikiOperations(ctx: KonContext): AnyOperation[] {
  const app = registry();
  const db = ctx.db.instance;

  // A wiki is READ without a session — that is its reason for being: reads are
  // `access: "publico"`. Writing requires one (`access: "session"`). This used to
  // be done by an `app.use("/wikis/*")` that let GETs through and asked for a session
  // for the rest.

  /** The wiki of the route, or `null`. All page routes start here. */
  async function wikiOfRoute(c: Context): Promise<Wiki | null> {
    return repo(wikis, { db })
      .filter({ slug: c.req.param("wiki") })
      .first();
  }

  /**
   * Why a wiki cannot be created with this slug for this game, or `null`.
   *
   * The preview and the registration both use it: that way the form shows exactly
   * what the server will accept.
   */
  async function reasonNotToCreate(
    slug: string,
    gameId: string | null,
    game: string | null = null
  ): Promise<{ reason: string; field: string; status: 400 | 409 } | null> {
    const invalid = invalidWikiSlugReason(slug);
    if (invalid) return { reason: invalid, field: "slug", status: 400 };
    if (await repo(wikis, { db }).filter({ slug }).exists()) {
      return { reason: `A wiki with the slug "${slug}" already exists.`, field: "slug", status: 409 };
    }
    if (gameId && (await repo(wikis, { db }).filter({ gameId }).exists())) {
      return {
        reason: "That game already has its wiki: each game has one, at /<game>/wiki/.",
        field: "gameId",
        status: 409,
      };
    }
    if (game && (await repo(wikis, { db }).filter({ game }).exists())) {
      return {
        reason: "That game already has its wiki: each game has one, at /<game>/wiki/.",
        field: "game",
        status: 409,
      };
    }
    return null;
  }

  /**
   * The slug of a catalog game, from its uuid. kon-games may not be installed (a kon does not
   * import another): then there is no `games` table and the answer is null.
   */
  async function slugOfGame(gameId: string): Promise<string | null> {
    type Rows = { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const rowsOf = (r: Rows) => (Array.isArray(r) ? r : (r.rows ?? []));
    try {
      // Asked first, and never by querying a table that may not exist: a failed statement would
      // abort the request's transaction, and the wiki could not be created after it.
      const there = rowsOf(
        (await db.execute(sql`SELECT to_regclass('games') IS NOT NULL AS ok`)) as unknown as Rows
      );
      if (there[0]?.ok !== true) return null;
      const rows = rowsOf(
        (await db.execute(
          sql`SELECT slug FROM games WHERE id = ${gameId}::uuid LIMIT 1`
        )) as unknown as Rows
      );
      const slug = rows[0]?.slug;
      return typeof slug === "string" && GameSlug.safeParse(slug).success ? slug : null;
    } catch {
      return null;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // WIKIS
  // ════════════════════════════════════════════════════════════════════════

  /** All wikis, or those of one game (`?game=<slug>`, or its catalog uuid as before). */
  app.get(
    "/wikis",
    {
      id: "list-wikis",
      summary: "List wikis",
      description:
        "Every wiki (one per game, read on the public site at /<game>/wiki/), most recently updated first, or only the wiki of `game`: the game's slug (the field every gaming kon shares) or its catalog uuid. Each wiki carries both, `game` and `gameId`. Without `limit`, all of them (as always); with `limit` and `offset`, one page, and `hasMore` says whether there are more. `total` counts every matching wiki. Public.",
      access: "public",
      input: {
        query: query({
          game: text("Only the wiki of this game (its slug, or its uuid)"),
          limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(500)
            .optional()
            .describe("Wikis per page (1-500). Without it, every wiki."),
          offset: z.coerce
            .number()
            .int()
            .min(0)
            .default(0)
            .describe("Wikis to skip (with `limit`)."),
        }),
      },
      output: {
        schema: z.object({
          docs: z.array(WikiOut),
          total: z.number().int(),
          hasMore: z.boolean(),
        }),
      },
    },
    async (c, input) => {
      const game = c.req.query("game");
      const { limit, offset } = input.query as { limit?: number; offset: number };
      // A uuid is the catalog's id (what the panel sends); anything else is the game's slug.
      const where = game ? (UUID.test(game) ? eq(wikis.gameId, game) : eq(wikis.game, game)) : undefined;

      // The id breaks ties between wikis updated in the same instant.
      const base = db.select().from(wikis).where(where).orderBy(desc(wikis.updatedAt), desc(wikis.id));
      if (limit === undefined) {
        // What the list always answered: every wiki.
        const rows = await base;
        return c.json({ docs: rows as Wiki[], total: rows.length, hasMore: false });
      }
      const rows = await base.limit(limit + 1).offset(offset);
      const [{ value: total }] = await db.select({ value: count() }).from(wikis).where(where);
      return c.json({
        docs: rows.slice(0, limit) as Wiki[],
        total: Number(total),
        hasMore: rows.length > limit,
      });
    }
  );

  /**
   * Preview for the creator: which slug would result and whether it can be created.
   *
   * It exists so the panel does NOT reimplement the rule. The form sends the
   * title (and the game), and what it shows is exactly what the server will
   * accept. Registered before `/wikis/:wiki` so that "sugerencia" is not
   * taken for the name of a wiki.
   */
  app.get(
    "/wikis/suggestion",
    {
      id: "suggest-wiki",
      summary: "Preview the slug of a new wiki",
      description:
        "What slug a new wiki would get (from `slug`, or derived from `title`) and whether it can be created for `game`: `valid` and, if not, the reason (`reason`: taken, invalid, or the game already has its wiki). Use it before create-wiki. Public; creates nothing.",
      access: "public",
      input: {
        query: query({
          slug: text("Wanted slug"),
          title: text("Wiki title (the slug is derived from it when `slug` is absent)"),
          game: text("The game: its slug, or its catalog uuid"),
        }),
      },
      output: {
        schema: z.object({
          slug: z.string(),
          valid: z.boolean(),
          reason: z.string().nullable(),
        }),
      },
    },
    async (c) => {
      const request = c.req.query("slug")?.trim();
      const title = c.req.query("title")?.trim() ?? "";
      const slug = request ? request.toLowerCase() : slugify(title);
      const game = c.req.query("game")?.trim() || null;

      const byId = game && UUID.test(game) ? game : null;
      const problem = await reasonNotToCreate(slug, byId, byId ? null : game);
      return c.json({ slug, valid: problem === null, reason: problem?.reason ?? null });
    }
  );

  /** Creates a wiki. Admin only (policy `wiki-space`). */
  app.post(
    "/wikis",
    {
      id: "create-wiki",
      summary: "Create a game's wiki",
      description:
        "Creates the wiki of a game, named by `game` (its slug in the catalog, the field every gaming kon shares) or by `gameId` (its catalog uuid); one of the two is required: it is published at /<game>/wiki/. With only `gameId`, `game` is filled from the catalog when kon-games is installed. The slug is `slug` or derived from `title`. 409 if the slug is taken or the game already has a wiki, 400 if the slug is invalid. Admin only (or an agent with wiki-space:create). Check first with suggest-wiki.",
      access: "session",
      permission: onTheWikis,
      input: { body: NewWiki },
      output: { status: 201, schema: z.object({ data: WikiOut }) },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      if (!(await h.can({ id: "*" }))) {
        return c.json({ error: "Only an administrator can create a wiki" }, 403);
      }

      const data = input.body as z.infer<typeof NewWiki>;
      const slug = data.slug ? data.slug.toLowerCase() : slugify(data.title);

      // Both names of the same game are stored: the slug is looked up when only the uuid came.
      const game = data.game ?? (data.gameId ? await slugOfGame(data.gameId) : null);
      const problem = await reasonNotToCreate(slug, data.gameId ?? null, game);
      if (problem) return c.json({ error: problem.reason, field: problem.field }, problem.status);

      const createdOne = await repo(wikis, { db }).create({
        slug,
        title: data.title,
        description: data.description ?? "",
        gameId: data.gameId ?? null,
        game,
      });

      return c.json({ data: createdOne }, 201);
    }
  );

  /** A wiki and how many pages it has. */
  app.get(
    "/wikis/:wiki",
    {
      id: "get-wiki",
      summary: "Read a wiki",
      description: "The wiki and how many pages it has (`pages`). Public.",
      access: "public",
      input: { params: ParamWiki },
      output: { schema: z.object({ data: WikiOut.extend({ pages: z.number().int() }) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const wiki = await wikiOfRoute(c);
      if (!wiki) return c.json({ error: "Wiki not found" }, 404);

      const [{ total }] = await db
        .select({ total: count() })
        .from(wikiPages)
        .where(eq(wikiPages.wikiId, wiki.id));

      return c.json({ data: { ...wiki, pages: Number(total) } });
    }
  );

  // ════════════════════════════════════════════════════════════════════════
  // PAGES OF A WIKI
  // ════════════════════════════════════════════════════════════════════════

  /** Index of the wiki's pages, newest first. */
  app.get(
    "/wikis/:wiki/pages",
    {
      id: "list-pages",
      summary: "List the pages of a wiki",
      description:
        "The page index of the wiki (slug, title, current revision, last update), most recently updated first, in pages of `limit` (up to 500, 100 by default) from `offset`; `hasMore` says whether more pages follow and `total` is the size of this page. Public.",
      access: "public",
      input: {
        params: ParamWiki,
        query: query({
          limit: text("How many, up to 500 (100 by default)"),
          offset: z.coerce
            .number()
            .int()
            .min(0)
            .default(0)
            .describe("Pages to skip; `hasMore` says whether more follow."),
        }),
      },
      output: {
        schema: z.object({
          wiki: WikiOut,
          docs: z.array(PageSummary),
          total: z.number().int().describe("Pages in this response"),
          hasMore: z.boolean().describe("More pages follow: ask with `offset` + `limit`"),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const wiki = await wikiOfRoute(c);
      if (!wiki) return c.json({ error: "Wiki not found" }, 404);

      // `limit` keeps its lenient parsing (a non-number is the default); rows past
      // it were unreachable until `offset` (api-contract, 2026-11-18). At least 1:
      // a negative `limit` reached Postgres as an error.
      const limit = Math.max(Math.min(Number(c.req.query("limit")) || 100, 500), 1);
      const { offset } = input.query as { offset: number };

      const rows = await db
        .select({
          slug: wikiPages.slug,
          title: wikiPages.title,
          updatedAt: wikiPages.updatedAt,
          currentRevision: wikiPages.currentRevision,
        })
        .from(wikiPages)
        .where(eq(wikiPages.wikiId, wiki.id))
        // The id breaks ties between pages updated in the same instant (an import).
        .orderBy(desc(wikiPages.updatedAt), desc(wikiPages.id))
        .limit(limit + 1)
        .offset(offset);

      const hasMore = rows.length > limit;
      const docs = hasMore ? rows.slice(0, limit) : rows;
      return c.json({ wiki, docs, total: docs.length, hasMore });
    }
  );

  /** Page with its current revision. */
  app.get(
    "/wikis/:wiki/pages/:slug",
    {
      id: "get-page",
      summary: "Read a wiki page",
      description:
        "A page with the content of its current revision and its backlinks (slugs of the pages of the same wiki that link to it). Public.",
      access: "public",
      input: { params: PageParam },
      output: {
        schema: z.object({
          wiki: WikiOut,
          data: PageOut,
          content: z.string(),
          backlinks: z.array(z.string()),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const wiki = await wikiOfRoute(c);
      if (!wiki) return c.json({ error: "Wiki not found" }, 404);

      const page = await repo(wikiPages, { db })
        .filter({ wikiId: wiki.id, slug: c.req.param("slug") })
        .first();
      if (!page) return c.json({ error: "Not found" }, 404);

      const revision = await repo(wikiRevisions, { db })
        .filter({ pageId: page.id, number: page.currentRevision })
        .first();

      // Backlinks go in the SAME response: they are navigation, and asking for them
      // separately would make half the web skip them.
      const backlinks = await repo(wikiLinks, { db })
        .filter({ wikiId: wiki.id, toSlug: page.slug })
        .all();

      return c.json({
        wiki,
        data: page,
        content: revision?.content ?? "",
        backlinks: backlinks.map((l) => l.fromSlug),
      });
    }
  );

  /** History. Without the content of each revision: it is megabytes and not all are read. */
  app.get(
    "/wikis/:wiki/pages/:slug/history",
    {
      id: "page-history",
      summary: "Read the revision history of a page",
      description:
        "The revisions of a page, newest first (up to 1000): number, summary, date and size in characters, without the content (read it with get-page or compare-revisions). Public.",
      access: "public",
      input: { params: PageParam },
      output: {
        schema: z.object({
          data: z.array(
            z.object({
              number: z.number().int(),
              summary: z.string(),
              createdAt: z.string(),
              size: z.number().int(),
            })
          ),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const wiki = await wikiOfRoute(c);
      if (!wiki) return c.json({ error: "Wiki not found" }, 404);

      const page = await repo(wikiPages, { db })
        .filter({ wikiId: wiki.id, slug: c.req.param("slug") })
        .first();
      if (!page) return c.json({ error: "Not found" }, 404);

      // Without fetching the content: before, ALL revisions were loaded with
      // their text (up to 500 KB each) just to return their size.
      const revisions = await db
        .select({
          number: wikiRevisions.number,
          summary: wikiRevisions.summary,
          authorId: wikiRevisions.authorId,
          createdAt: wikiRevisions.createdAt,
          size: sql<number>`char_length(${wikiRevisions.content})`,
        })
        .from(wikiRevisions)
        .where(eq(wikiRevisions.pageId, page.id))
        .orderBy(desc(wikiRevisions.number))
        .limit(1000);

      return c.json({
        data: revisions.map(
          (r: {
            number: number;
            summary: string;
            authorId: string | null;
            createdAt: Date;
            size: number;
          }) => ({
            number: r.number,
            summary: r.summary,
            // No `authorId`: the history is public and the account's internal
            // id is not shown (as in comments; earlier audit).
            createdAt: r.createdAt,
            size: Number(r.size),
          })
        ),
      });
    }
  );

  /** Diff between two revisions. By lines: the history is READ. */
  app.get(
    "/wikis/:wiki/pages/:slug/diff/:from/:to",
    {
      id: "compare-revisions",
      summary: "Diff two revisions of a page",
      description:
        "Line diff between revision `from` and revision `to` of a page (ops `eq`/`add`/`del`) and its stats. 404 if a revision does not exist or is not a positive integer. Public.",
      access: "public",
      input: { params: ParamDiff },
      output: {
        schema: z.object({
          data: z.array(z.record(z.string(), z.unknown())),
          stats: z.record(z.string(), z.unknown()),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const wiki = await wikiOfRoute(c);
      if (!wiki) return c.json({ error: "Wiki not found" }, 404);

      const page = await repo(wikiPages, { db })
        .filter({ wikiId: wiki.id, slug: c.req.param("slug") })
        .first();
      if (!page) return c.json({ error: "Not found" }, 404);

      const fromValue = revisionNumber(c.req.param("from"));
      const until = revisionNumber(c.req.param("to"));
      if (fromValue === null || until === null) return c.json({ error: "Revision not found" }, 404);

      const load = (n: string) =>
        repo(wikiRevisions, { db })
          .filter({ pageId: page.id, number: Number(n) })
          .first();

      const from = await load(c.req.param("from"));
      const to = await load(c.req.param("to"));
      if (!from || !to) return c.json({ error: "Revision not found" }, 404);

      const ops = diffLines(from.content, to.content);
      return c.json({ data: ops, stats: diffStats(ops) });
    }
  );

  /**
   * Creates or edits. Each save is a NEW REVISION; the previous content
   * is not touched — the history only grows.
   */
  app.put(
    "/wikis/:wiki/pages/:slug",
    {
      id: "save-page",
      summary: "Create or edit a wiki page",
      description:
        "Saves `content` as a NEW revision of the page (creating it if it does not exist; the slug is normalised). History only grows. A save identical to the current revision changes nothing and answers `unchanged: true`. Editorial team (admin/editor), or an agent with wiki:update / wiki:create; a `locked` page only an admin (403).",
      access: "session",
      permission: onThePage,
      input: { params: PageParam, body: EditPage },
      output: {
        schema: z
          .object({
            data: PageOut,
            revision: z.number().int().optional(),
            unchanged: z.literal(true).optional(),
          })
          .describe("`revision` when a revision was written, `unchanged` when nothing changed"),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const user = (c.get("user") ?? null) as AuthzUser | null;
      const wiki = await wikiOfRoute(c);
      if (!wiki) return c.json({ error: "Wiki not found" }, 404);

      const slug = slugify(c.req.param("slug"));
      const data = input.body as z.infer<typeof EditPage>;

      let page = await repo(wikiPages, { db }).filter({ wikiId: wiki.id, slug }).first();

      // `h.can` = the `wiki` policy plus the SDK's fine-grained scopes.
      if (page && !(await h.can(page))) {
        return c.json({ error: "This page is protected" }, 403);
      }
      if (!page && !(await h.can({}, "create"))) {
        return c.json({ error: "Forbidden" }, 403);
      }

      if (page) {
        const current = await repo(wikiRevisions, { db })
          .filter({ pageId: page.id, number: page.currentRevision })
          .first();
        // An identical revision pollutes the history with noise that then has
        // to be read. It is not an error: there is simply nothing to save.
        if (current && !isMeaningfulEdit(current.content, data.content)) {
          return c.json({ data: page, unchanged: true });
        }
      } else {
        page = await repo(wikiPages, { db }).create({
          wikiId: wiki.id,
          slug,
          title: data.title ?? slug,
          currentRevision: 0,
        });
      }

      const number = page.currentRevision + 1;
      await repo(wikiRevisions, { db }).create({
        pageId: page.id,
        number,
        content: data.content,
        summary: data.summary ?? "",
        authorId: user?.id ?? null,
      });

      const [updated] = await repo(wikiPages, { db })
        .filter({ id: page.id })
        .update({
          currentRevision: number,
          title: data.title ?? page.title,
          updatedAt: new Date(),
        });

      await reindexLinks(wiki.id, slug, data.content);
      return c.json({ data: updated, revision: number });
    }
  );

  /**
   * Reverts to an earlier revision by creating a NEW one with its content.
   *
   * It never deletes: if reverting deleted, a vandal with permissions could make
   * their traces disappear and the history would no longer prove anything.
   */
  app.post(
    "/wikis/:wiki/pages/:slug/revert/:number",
    {
      id: "revert-page",
      summary: "Revert a page to an earlier revision",
      description:
        "Brings back the content of revision `number` as a NEW revision (nothing is deleted: the history keeps proving what happened). 404 if the page or the revision does not exist, 409 if it is already the current one. Same permission as editing the page.",
      access: "session",
      permission: onThePage,
      // Republishes earlier content on the site.
      sensitive: true,
      input: { params: RevertParam },
      output: { schema: z.object({ data: PageOut, revision: z.number().int() }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, _input, h) => {
      const user = (c.get("user") ?? null) as AuthzUser | null;
      const wiki = await wikiOfRoute(c);
      if (!wiki) return c.json({ error: "Wiki not found" }, 404);

      const page = await repo(wikiPages, { db })
        .filter({ wikiId: wiki.id, slug: c.req.param("slug") })
        .first();
      if (!page) return c.json({ error: "Not found" }, 404);
      if (!(await h.can(page))) return c.json({ error: "Forbidden" }, 403);

      const numberValue = revisionNumber(c.req.param("number"));
      if (numberValue === null) return c.json({ error: "That revision does not exist" }, 404);
      const target = await repo(wikiRevisions, { db })
        .filter({ pageId: page.id, number: numberValue })
        .first();
      if (!target) return c.json({ error: "That revision does not exist" }, 404);

      let plan;
      try {
        plan = prepareRevert(target, page.currentRevision);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "Could not revert" }, 409);
      }

      await repo(wikiRevisions, { db }).create({
        pageId: page.id,
        number: plan.number,
        content: plan.content,
        summary: plan.summary,
        authorId: user?.id ?? null,
      });
      const [updated] = await repo(wikiPages, { db })
        .filter({ id: page.id })
        .update({ currentRevision: plan.number, updatedAt: new Date() });

      await reindexLinks(wiki.id, page.slug, plan.content);
      return c.json({ data: updated, revision: plan.number });
    }
  );

  /** Linked pages that do not exist yet IN THIS WIKI: the "requested pages". */
  app.get(
    "/wikis/:wiki/wanted",
    {
      id: "requested-pages",
      summary: "List the wanted pages of a wiki",
      description:
        "Slugs that pages of this wiki link to but that do not exist yet, most linked first, with how many links point to each. The to-do list of a wiki. Public.",
      access: "public",
      input: { params: ParamWiki },
      output: {
        schema: z.object({
          data: z.array(z.object({ slug: z.string(), links: z.number().int() })),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const wiki = await wikiOfRoute(c);
      if (!wiki) return c.json({ error: "Wiki not found" }, 404);

      const links = await repo(wikiLinks, { db }).filter({ wikiId: wiki.id }).all();
      const pages = await db
        .select({ slug: wikiPages.slug })
        .from(wikiPages)
        .where(and(eq(wikiPages.wikiId, wiki.id)));
      const existing = new Set(pages.map((p: { slug: string }) => p.slug));

      const counts = new Map<string, number>();
      for (const link of links) {
        if (existing.has(link.toSlug)) continue;
        counts.set(link.toSlug, (counts.get(link.toSlug) ?? 0) + 1);
      }

      return c.json({
        data: [...counts.entries()]
          // Most linked first: it is the one most needed.
          .sort((a, b) => b[1] - a[1])
          .map(([slug, links]) => ({ slug, links })),
      });
    }
  );

  /**
   * Reindexes the `[[links]]` of a page.
   *
   * It is deleted and rewritten whole instead of computing the delta: a page
   * has dozens of links, the delta would be more code for the same
   * result, and a badly computed delta leaves ghost backlinks that nobody
   * would know where they came from.
   *
   * Links do NOT cross wikis: `[[Armas]]` points to "armas" of the same wiki.
   */
  async function reindexLinks(wikiId: string, fromSlug: string, content: string): Promise<void> {
    await repo(wikiLinks, { db }).filter({ wikiId, fromSlug }).delete();
    // Cap and ONE insert: 500 KB of `[[a1]] [[a2]]…` was tens of thousands
    // of INSERTs in a row on every save.
    const links = extractLinks(content)
      .filter((link) => link.slug !== fromSlug) // a page does not link to itself
      .slice(0, MAX_LINKS_PER_PAGE);
    if (links.length === 0) return;
    await repo(wikiLinks, { db }).createMany(
      links.map((link) => ({ wikiId, fromSlug, toSlug: link.slug }))
    );
  }

  return app.ops;
}

export function createKonWiki(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, wikiOperations(ctx), ctx);
}

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`wikiOperations`), with its OpenAPI, its MCP tool and its fine-grained scope
 * `kon:wiki:<id>`.
 */
type AdminDeclaration = NonNullable<KonDefinition["admin"]>;

export const kon = defineKonSdk({
  id: KON_ID,
  name: "Wiki",
  version: manifest.version,
  description:
    "Wikis with history, one per game (/<game>/wiki/): revisions, diff, revert and backlinks",
  icon: "BookOpen",
  mountPath: "/api/wiki",
  operations: (ctx: KonContext) => wikiOperations(ctx),

  tables: konTables,

  // kon.json `admin` is the one source (the admin registry reads it); mirrored here so
  // the definition and the manifest never differ.
  admin: {
    category: manifest.admin.category as AdminDeclaration["category"],
    views: manifest.admin.views.map((v) => ({ ...v })) as AdminDeclaration["views"],
  },

  dependencies: { kons: [], core: ["auth"] },

  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info("📖 Wiki ready — one wiki per game, the history only grows");
    },
  },
});

export default kon;

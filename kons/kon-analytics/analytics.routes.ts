/**
 * Kitsuden — Analytics: routes (kon SDK operations)
 * ============================================================================
 *
 *   POST /api/analytics/hit                 adds a view (public)
 *   GET  /api/analytics/top?type=&days=     the most viewed (public)
 *   GET  /api/analytics/subject/:type/:id   one subject's series (public)
 *
 * ── A PUBLIC COUNTER CAN BE INFLATED ───────────────────────────────────────
 *
 * Anyone can call `hit` in a loop. That cannot be fully fixed without
 * identifying the caller —which is exactly what is not stored—, so here
 * we do what can be done without lying:
 *
 *   · known bots are discarded by their agent, which are half the
 *     traffic of a guides site and would skew the top with no ill intent;
 *   · one request adds ONE view, never a number that comes in the body;
 *   · the subject has to be a uuid of a known type.
 *
 * What is left is an indicative ranking, and the interface calls it that. For
 * auditable figures you would need server analytics over the logs, which
 * is a different tool.
 */

import { defineOperation, operationsRouter, type AnyOperation } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { analyticsViews, MEASURABLE_SUBJECTS, type MeasurableSubject } from "./analytics.schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Bots that announce themselves. The agent is not stored: it is only looked at and discarded.
 *
 * The list is short on purpose —the big four search engines, AI
 * crawlers and social networks' link previews—: a huge
 * list would give a sense of precision it does not have.
 */
const BOTS =
  /bot|crawler|spider|crawling|slurp|duckduck|yandex|baidu|bingpreview|facebookexternalhit|whatsapp|telegram|discordbot|preview|headless|lighthouse|pingdom|curl|wget|python-requests|axios/i;

export function isBot(agent: string | null | undefined): boolean {
  return BOTS.test(agent ?? "");
}

const isSubject = (v: string): v is MeasurableSubject =>
  (MEASURABLE_SUBJECTS as readonly string[]).includes(v);

/**
 * The table where each subject lives, to check it EXISTS before counting it.
 *
 * Without this, `hit` accepted any made-up uuid: each one is a new row
 * in `analytics_views`, and a loop of random uuids filled the table without
 * touching anything real. The table name comes from this literal, never from the
 * request. If the table is not there (that subject's kon is not installed) it is not
 * blocked: it is counted, as before, and the kon's per-IP limit stops it.
 */
export const SUBJECT_TABLE: Record<MeasurableSubject, string> = {
  game: "games",
  blog_post: "blog_posts",
  wiki_page: "wiki_pages",
  wiki: "wikis",
  dataset: "data_sets",
  tournament: "esports_tournaments",
  streamer: "streamers",
};

/**
 * Per-connection limit for `hit`, applied by the host with the real IP (it is
 * resolved by `client-ip`; a header written by the client does not count).
 *
 * The IP is NOT stored in any table: the limiter uses it as the key of a
 * counter that expires on its own in the cache, like for any other API route.
 * A person reading does not exceed a few views per minute; this
 * leaves room for tabs opened in a burst and takes the loop away from whoever inflates.
 */
export const ANALYTICS_LIMITS = [
  { path: "/hit", limit: 30, window: 60, message: "Too many views in a row." },
];

const rowsOf = (r: unknown): unknown[] => {
  if (Array.isArray(r)) return r;
  const c = r as { rows?: unknown };
  return Array.isArray(c?.rows) ? c.rows : [];
};

/** Does that subject exist? `true` also if its table is not installed. */
async function subjectExists(db: any, type: MeasurableSubject, id: string): Promise<boolean> {
  const table = SUBJECT_TABLE[type];
  try {
    // In a SAVEPOINT (`transaction` inside the request): if the query
    // fails and we continue, the request's transaction stays alive for the
    // view INSERT that follows.
    return await db.transaction(async (sp: any) => {
      const has = rowsOf(
        await sp.execute(sql`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS ok`)
      );
      if (!(has[0] as { ok?: boolean } | undefined)?.ok) return true;
      // The parameter goes untyped: Postgres converts it to the column's type, which is
      // `uuid` in some tables and `text` in others. The format has already been checked.
      const r = await sp.execute(
        sql`SELECT 1 FROM ${sql.raw(`"${table}"`)} WHERE id = ${id} LIMIT 1`
      );
      return rowsOf(r).length > 0;
    });
  } catch {
    // A table with a different shape cannot take down the page that counts.
    return true;
  }
}

/** Today's date as `YYYY-MM-DD`, which is what a `date` column expects. */
const hoy = () => new Date().toISOString().slice(0, 10);

/** `days` bounded: without a cap, `days=100000` would scan the whole table. */
const requestedDays = (v: string | undefined, defaultValue = 30) =>
  Math.min(Math.max(Number(v) || defaultValue, 1), 365);

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

export const KON_ID = "kon-analytics";

// ── Schemas (OpenAPI and MCP) ────────────────────────────────────────────────

/**
 * The body of `hit`. The handler still validates it (`validatesHandler`): its
 * 400 "invalid type or id" is the usual contract, and an extra field
 * (`views: 1000`) is ignored without error —the number of views never comes from the
 * client—. The SDK only publishes it.
 */
const HitBody = z
  .object({
    type: z.enum(MEASURABLE_SUBJECTS).describe("What was viewed"),
    id: z.string().describe("Uuid of the viewed subject"),
  })
  .passthrough();

/** All text and optional: odd values fall back to the defaults, as before. */
const QueryTop = z
  .object({
    type: z
      .string()
      .optional()
      .describe(`Subject type (default game): ${MEASURABLE_SUBJECTS.join(", ")}`),
    days: z.string().optional().describe("Window in days, 1-365 (default 30)"),
    limit: z.string().optional().describe("How many, 1-50 (default 5)"),
    ids: z
      .string()
      .optional()
      .describe("Comma-separated uuids: rank only inside this set (max 100)"),
  })
  .passthrough();

const SubjectParams = z.object({
  type: z.string().describe(`Subject type: ${MEASURABLE_SUBJECTS.join(", ")}`),
  id: z.string().describe("Subject uuid"),
});

const DaysQuery = z
  .object({ days: z.string().optional().describe("Window in days, 1-365 (default 30)") })
  .passthrough();

const TopOut = z.object({
  type: z.string(),
  days: z.number().int(),
  docs: z.array(z.object({ subjectId: z.string(), views: z.number().int() })),
});

const SeriesOut = z.object({
  type: z.string(),
  id: z.string(),
  days: z.number().int(),
  total: z.number().int(),
  docs: z.array(z.object({ day: z.string(), views: z.number().int() })),
});

export function analyticsOperations(ctx: KonContext): AnyOperation[] {
  const dbInstance = ctx.db.instance as any;

  return [
    // ── Add a view ───────────────────────────────────────────────────────────
    defineOperation({
      id: "add-view",
      method: "POST",
      route: "/hit",
      summary: "Count one page view",
      description:
        "Adds ONE view of a subject (game, blog post, wiki page, dataset, tournament, streamer) for today. Public and anonymous: no IP, cookie or user agent is stored. Known bots are dropped, and a subject that does not exist is not counted; both answer 204 like a counted view. 400 when type or id are not valid.",
      access: "public",
      input: { body: HitBody.optional(), validatesHandler: true },
      output: { status: 204 },
      // Adding a view is not idempotent, but what it does is count a
      // visit by a BROWSER: an agent reading a page is not a view.
      mcp: { exclude: "counts a browser page view; an agent reading a page is not a view" },
      handle: async (input, { c }) => {
        if (isBot(c.req.header("user-agent"))) return c.body(null, 204);

        const body = (input.body ?? null) as { type?: string; id?: string } | null;
        const type = String(body?.type ?? "");
        const id = String(body?.id ?? "");

        if (!isSubject(type) || !UUID.test(id)) {
          return c.json({ error: "invalid type or id" }, 400);
        }

        // What does not exist is not counted, and the response is THE SAME as if it were:
        // the response of `hit` cannot be used to ask which ids exist.
        if (!(await subjectExists(dbInstance, type, id))) return c.body(null, 204);

        await dbInstance
          .insert(analyticsViews)
          .values({ subjectType: type, subjectId: id, day: hoy(), views: 1 })
          .onConflictDoUpdate({
            target: [analyticsViews.subjectType, analyticsViews.subjectId, analyticsViews.day],
            set: { views: sql`${analyticsViews.views} + 1`, updatedAt: new Date() },
          });

        // 204: the page that counts the view has nothing to do with the response
        return c.body(null, 204);
      },
    }),

    // ── The most viewed ──────────────────────────────────────────────────────
    defineOperation({
      id: "get-most-viewed",
      method: "GET",
      route: "/top",
      summary: "Most viewed subjects",
      description:
        "The most viewed subjects of one type over the last `days` days (views, never unique visitors), most viewed first. `ids` ranks only inside a given set of uuids. Public. Returns subject ids and view counts; 400 when the type is unknown.",
      access: "public",
      input: { query: QueryTop },
      output: { schema: TopOut },
      handle: async (_input, { c }) => {
        const type = c.req.query("type") ?? "game";
        if (!isSubject(type)) return c.json({ error: "invalid type" }, 400);

        const days = requestedDays(c.req.query("days"));
        const limit = Math.min(Math.max(Number(c.req.query("limit")) || 5, 1), 50);

        /**
         * `?ids=a,b,c` — the ranking WITHIN a set.
         *
         * The esports "trends" are the most-read esports entries, not
         * the most-read of the blog: without this, the top fifty could be
         * all gacha guides and the section came out empty despite having reads.
         * Only uuids, and at most a hundred: it is a front-page list, not a dump.
         */
        const ids = (c.req.query("ids") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => UUID.test(s))
          .slice(0, 100);
        // A set was asked for and none of it is valid: the ranking inside it is empty. Dropping the
        // filter would answer with the GLOBAL ranking — subjects outside the set asked about.
        if ((c.req.query("ids") ?? "").trim() !== "" && ids.length === 0) {
          return { type: type, days: days, docs: [] };
        }

        const rows = await dbInstance
          .select({
            subjectId: analyticsViews.subjectId,
            views: sql<number>`sum(${analyticsViews.views})::int`,
          })
          .from(analyticsViews)
          .where(
            and(
              eq(analyticsViews.subjectType, type),
              gte(analyticsViews.day, daysAgo(days)),
              ids.length > 0 ? inArray(analyticsViews.subjectId, ids) : undefined
            )
          )
          .groupBy(analyticsViews.subjectId)
          .orderBy(desc(sql`sum(${analyticsViews.views})`))
          .limit(limit);

        return { type: type, days: days, docs: rows };
      },
    }),

    // ── A subject's series ───────────────────────────────────────────────────
    defineOperation({
      id: "get-subject-series",
      method: "GET",
      route: "/subject/:type/:id",
      summary: "Daily views of one subject",
      description:
        "The views per day of one subject over the last `days` days, oldest first, with the total. Public. 400 when type or id are not valid; a subject with no views returns an empty series.",
      access: "public",
      input: { params: SubjectParams, query: DaysQuery },
      output: { schema: SeriesOut },
      handle: async ({ params }, { c }) => {
        const type = params.type;
        const id = params.id;
        if (!isSubject(type) || !UUID.test(id))
          return c.json({ error: "invalid type or id" }, 400);

        const days = requestedDays(c.req.query("days"));
        const rows = await dbInstance
          .select({ day: analyticsViews.day, views: analyticsViews.views })
          .from(analyticsViews)
          .where(
            and(
              eq(analyticsViews.subjectType, type),
              eq(analyticsViews.subjectId, id),
              gte(analyticsViews.day, daysAgo(days))
            )
          )
          .orderBy(analyticsViews.day);

        const total = rows.reduce((n: number, f: { views: number }) => n + f.views, 0);
        return { type: type, id, days: days, total, docs: rows };
      },
    }),
  ];
}

/** The operations router (what `createRouter` mounted before the SDK). */
export function createAnalyticsRouter(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, analyticsOperations(ctx), ctx);
}

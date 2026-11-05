/**
 * Kon Blog — its operations (kon SDK; the pilot kon)
 *
 * Each route is a DECLARED operation (`defineOperation`): from it come the
 * REST route, its OpenAPI and its MCP tool (docs/kons/README.md). The permission
 * of each write (the `blog_post` / `blog_category` policy) is declared in
 * `permission`; the bodies are still validated by the handler with the schemas
 * below (`validatesHandler`: the `Validation failed` 400 is a published contract).
 *
 * ⚠️ Order matters: literals (`/source/:postId`, `/categories`) are
 * declared before `/:id`. The SDK checks this when mounting (`checkOperations`).
 */

import {
  agentCan,
  can,
  withSavepoint,
  defineOperation,
  postgresInputError,
  isAgent,
  isUuid,
  messageOf,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext, KonRouterFactory } from "@kitsuden/shared";
import {
  dateSchema,
  agentSignature,
  renderBlocks,
} from "@kitsuden/shared";
import { eq, and, asc, desc, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { isTeam, registerBlogPolicy } from "./blog.policy";
import { blogContentTarget } from "./content-target";
import {
  Category,
  Input,
  FullEntry,
  Generic,
  CategoryList,
  EntriesList,
  ParamId,
  ParamPost,
  ParamSlug,
  QueryBaseUrl,
  ListQuery,
  SiteQuery,
} from "./schemas";
import { validateBLUF, sanitizeHTML, sanitizeFAQText, buildAPIPayload } from "./geo-utils";
import { oldBlockKeysError, postToServe, sanitizeBlocks, sanitizeBody } from "./sanitize";
import {
  blogPosts,
  blogPostsToTags,
  blogPostsToGames,
  blogCategories,
  blogPostsToCategories,
} from "./schema";
import type { FAQItem } from "./schema";
import {
  generateSEOMetadata,
  ogLocale,
  validateSEO,
  validateWhatsAppImage,
  SEO_LIMITS,
  type SiteSEOConfig,
} from "./seo-utils";

// `c.get(k)` on a Hono without typed Variables resolves to `never`/{}.
// This helper types the access without changing the router's public signature
// (KonRouterFactory requires a bare `Hono`).
function ctxGet<T>(c: unknown, key: string): T | undefined {
  return (c as { get(k: string): unknown }).get(key) as T | undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// ZOD SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const focalPointSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .optional();

const faqItemSchema = z.object({
  q: z.string().min(1),
  a: z.string().min(1),
  order: z.number().optional(),
});

const createPostSchema = z.object({
  title: z.string().min(1).max(500),
  slug: z.string().max(500).optional(),
  content: z.any().optional(),
  excerpt: z.string().optional(),
  blufText: z.string().optional(),
  faqData: z.array(faqItemSchema).optional(),
  datasetUrl: z.string().url().optional().or(z.literal("")),
  metaTitle: z.string().max(70).optional(),
  metaDescription: z.string().max(170).optional(),
  ogImageId: z.guid().optional(),
  status: z.enum(["draft", "published", "scheduled", "archived"] as const).optional(),
  /**
   * ISO 8601 → `Date`. It was `z.string().datetime()`: the validated text reached
   * the timestamp column AS IS, and Drizzle blew up with
   * `value.toISOString is not a function` → publishing or scheduling when EDITING
   * a post answered 500 (saving a draft, which sends no date, did work).
   * `null` unschedules.
   */
  publishedAt: dateSchema().nullable().optional(),
  authorId: z.string().optional(),
  featuredImageId: z.guid().optional(),
  featuredImageFocalPoint: focalPointSchema,
  readingTime: z.number().int().positive().optional(),
  seoOverrides: z.record(z.string(), z.any()).optional(),
  blocks: z.array(z.any()).optional(),
  tagIds: z.array(z.guid()).optional(),
  gameIds: z.array(z.guid()).optional(),
  categoryIds: z.array(z.guid()).optional(),

  /**
   * Close this article's thread.
   *
   * It goes in the schema because Zod silently DROPS whatever it does not declare: without
   * this line, sending `commentsEnabled: false` gives no 400 — it saves the post with
   * comments open and does not warn. It is exactly what happened with `tags`
   * versus `tagIds`, and with categories.
   */
  commentsEnabled: z.boolean().optional(),

  /**
   * Article template: `article` or `tips` (numbered list with index).
   *
   * Enumerated here for the same reason as `commentsEnabled`: without this line,
   * choosing "tips" in the panel gives no error —it is saved as a normal article and
   * nobody notices—.
   */
  layout: z.enum(["article", "tips"] as const).optional(),

  /**
   * ── THE LANGUAGE AND THE TRANSLATION GROUP ────────────────────────────────
   *
   * They go here for the same reason as `commentsEnabled`: Zod silently drops
   * whatever it does not declare. Without these two lines, marking an entry as English in
   * the panel would save it as Spanish and nobody would notice until never seeing it
   * appear on the English site.
   *
   * `translationGroupId` is the uuid shared by the versions of the same
   * entry. The uuid of the group being translated into is sent; if it is not sent, the
   * entry is standalone and is its own group.
   */
  locale: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/, "The language is a code like \"es\", \"en\" or \"pt-BR\"")
    .optional(),
  translationGroupId: z.guid().nullable().optional(),
});

const updatePostSchema = createPostSchema.partial().extend({
  tagIds: z.array(z.guid()).optional(),
  gameIds: z.array(z.guid()).optional(),
  categoryIds: z.array(z.guid()).optional(),

  /**
   * Mark of the version the editor loaded, to detect simultaneous
   * edits. See `PATCH /:id`. Optional: a client that does not send it
   * keeps the usual behavior (last to save wins).
   */
  expectedUpdatedAt: z.string().datetime().optional(),
});

const categorySchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "The slug only allows lowercase letters, numbers and hyphens"),
  description: z.string().max(2000).optional(),
  parentId: z.guid().nullable().optional(),
  displayOrder: z.number().int().optional(),
});

const validateSeoSchema = z.object({
  title: z.string().optional(),
  metaDescription: z.string().optional(),
  excerpt: z.string().optional(),
  focusKeyword: z.string().optional(),
  content: z.any().optional(),
  imageUrl: z.string().url().optional(),
  imageWidth: z.number().optional(),
  imageHeight: z.number().optional(),
  imageFileSize: z.number().optional(),
  imageMimeType: z.string().optional(),
});

const validateImageSchema = z.object({
  imageUrl: z.string().url(),
  width: z.number().optional(),
  height: z.number().optional(),
  fileSize: z.number().optional(),
  mimeType: z.string().optional(),
});

const promoteFromSourceSchema = z.object({
  sourceType: z.enum(["dataset", "kon"]),
  datasetId: z.string().optional(),
  entryId: z.string().optional(),
  konId: z.string().optional(),
  table: z.string().optional(),
  recordId: z.string().optional(),
  titleTemplate: z.string().optional(),
  slugPrefix: z.string().optional(),
  autoPublish: z.boolean().optional(),
  authorId: z.string().optional(),
  tagIds: z.array(z.string()).optional(),
  gameIds: z.array(z.string()).optional(),
});

/**
 * Can the asker see posts that are not published?
 *
 * ── WHY IT IS A SINGLE FUNCTION ────────────────────────────────────────────
 *
 * Because the first time ONE door was closed and the house was considered closed.
 * `GET /` was changed to check the role… and the other four public reads
 * kept serving entire drafts to anyone. Measured against the real
 * installation, without any cookie:
 *
 *     GET /api/blog/slug/<slug>            → the whole draft
 *     GET /api/blog/<id>                   → the whole draft
 *     GET /api/blog/seo/<slug>?preview=true → the whole draft
 *     GET /api/blog/geo/<slug>?preview=true → the whole draft
 *
 * The last two are worse than an oversight: they checked the status and
 * ANNOUNCED the way around it in the error message itself —"Add
 * ?preview=true to see unpublished posts"—, without asking for a session. A preview
 * is a panel function; a URL parameter is not a credential.
 *
 * With the check spread across five handlers, closing four and missing
 * one is normal. With a single function, the question is always the same and
 * whoever adds the sixth route finds it already written.
 */
function canViewUnpublished(c: unknown): boolean {
  const user = ctxGet<AuthzUser>(c, "user");
  // Phase D (e2e, 2026-10-25): an agent with `admin` edited and published a
  // draft but could not READ it. Whoever can edit or publish an entry
  // has to see it before publishing it. A denial of any of these
  // wins (`!kon:blog:*` alongside `admin`). The scope rule is the engine's
  // common one (`agentCan`, effective-actor).
  if (!isAgent(user)) return isTeam(user);
  const THAT_ALLOW_VIEWING = [
    "blog_post:viewUnpublished",
    "blog:viewUnpublished",
    "kon:blog:update-post",
    "kon:blog:publish-post",
  ];
  return agentCan(user, THAT_ALLOW_VIEWING);
}

/**
 * Is it visible to the public? Published AND with the date already reached.
 *
 * Only the status was checked, so a `published` post with `publishedAt` in
 * the future came out ALREADY, before its time (and as the first on the front page, which
 * orders by that date). Without a date it counts as published: that is how the old
 * entries were.
 */
function alreadyPublic(post: { status?: string | null; publishedAt?: Date | string | null }): boolean {
  if (post.status !== "published") return false;
  if (!post.publishedAt) return true;
  return new Date(post.publishedAt).getTime() <= Date.now();
}

/** The same, in SQL, for lists (column, or with the `bp` alias). */
const SQL_DATE_REACHED = sql`(${blogPosts.publishedAt} is null or ${blogPosts.publishedAt} <= now())`;
const SQL_DATE_REACHED_BP = sql`(bp.published_at is null or bp.published_at <= now())`;

/** The request's user (person or agent), or null. */
function userOf(c: unknown): AuthzUser | null {
  return ctxGet<AuthzUser>(c, "user") ?? null;
}

/**
 * The authorization of each write, INSIDE the kon.
 *
 * It returns the rejection response, or `null` if it can continue. 401 without a session,
 * 403 with a session but without permission: "having an account" is not "being on the team".
 */
async function rejection(
  c: unknown,
  action: string,
  type: "blog_post" | "blog_category" = "blog_post"
): Promise<Response | null> {
  const u = userOf(c);
  if (await can(u, action, {}, type)) return null;
  const json = (c as { json: (bodyValue: unknown, statusValue: number) => Response }).json.bind(c);
  return u
    ? json({ error: "Forbidden", message: `Not authorized to '${action}' on ${type}` }, 403)
    : json({ error: "Unauthorized", message: "Session required" }, 401);
}

/**
 * Slugs: lowercase letters, digits and hyphens. The same as what the panel generates
 * (`slugify`) and what the 148 published entries satisfy.
 *
 * Before it was a bare `z.string().max(500)`: `../x`, `a/b`, spaces or
 * `?` fit, which break the site's URL (`/blog/<slug>`) and the sitemap.
 */
const RE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_SLUGS = new Set([
  "slug",
  "seo",
  "geo",
  "source",
  "categories",
  "validate-seo",
  "validate-image",
  "promote-from-source",
  "index",
  "page",
  "rss",
  "feed",
  "sitemap",
]);

/**
 * Tables that `promote-from-source` NEVER reads, not even for an admin: accounts,
 * sessions, keys, secrets, agents, audit. It is a net under the
 * real rule (admin only); a blocklist alone would not be enough.
 */
function bannedTable(tableValue: string): boolean {
  const t = tableValue.toLowerCase();
  return (
    /^(auth|agent|vault|secret|session|account|api_?key|oauth|webhook|audit)/.test(t) ||
    /(password|passwd|token|secret|session|credential|api_?key|verification|apikey)/.test(t) ||
    t.startsWith("pg_") ||
    t.includes("information_schema")
  );
}

function invalidSlug(slug: string): string | null {
  if (!RE_SLUG.test(slug)) return "The slug only allows lowercase letters, digits and hyphens";
  if (RESERVED_SLUGS.has(slug)) return `«${slug}» is a reserved address`;
  return null;
}

/**
 * Cuts off the reading of a post that is not published.
 *
 * It returns **404 and not 403** on purpose: a 403 confirms that the post exists, and
 * with a slug titles can be guessed ("is there a post about patch 1.2?"). From the
 * outside, a draft has to be indistinguishable from something that does not exist.
 */
function hiddenForThisVisitor(
  c: unknown,
  post: { status?: string | null; publishedAt?: Date | string | null }
): boolean {
  return !alreadyPublic(post) && !canViewUnpublished(c);
}

/**
 * The post's blocks, already as HTML, for whoever consumes the API.
 *
 * ── WHY THE SERVER DOES IT ─────────────────────────────────────────────────
 *
 * Because otherwise every frontend that wants to show a post with blocks has to
 * reimplement thirteen types, and as soon as there are two they diverge. Until now
 * `blocks` traveled as raw jsonb and NOBODY rendered it: the panel's builder
 * produced data that no page knew how to show.
 *
 * `blocks` still travels as is: a frontend that wants to build its own
 * rendering has it whole. `blocksHtml` is the convenience, not the only way.
 *
 * The sanitizer is this kon's own, the same one that already cleans the rest of the content.
 * Without passing it, the renderer ESCAPES the HTML instead of emitting it — it fails on the
 * safe side, but here it is given the go-ahead.
 */
function withRenderedBlocks<T extends { blocks?: unknown }>(post: T) {
  /**
   * WITHOUT OPTIONS, on purpose. See the note on `RenderOptions`.
   *
   * `sanitizeHtml: sanitizeHTML` used to be passed here, and that did two bad things at
   * once: this runtime has no `DOMParser`, so that sanitizer stripped
   * ALL the tags instead of sanitizing; and the panel passed nothing, so the
   * preview and what was published stopped matching without anything warning.
   *
   * Calling with no options is what guarantees that both sides produce
   * exactly the same HTML.
   */
  const render = renderBlocks(post.blocks as never);

  return {
    ...post,
    blocksHtml: render.html,
    /**
     * Those the site has to hydrate on its own: maps, grids over
     * datasets, filters. They are stated in the response so a frontend knows which
     * scripts it needs without having to dig through the HTML.
     */
    interactiveBlocks: render.interactive,
  };
}

/**
 * The article says where its thread hangs from, and how many comments it has
 * ============================================================================
 *
 * ── WHY THIS IS BACKEND AND THE THREAD IS NOT ──────────────────────────────
 *
 * Drawing the thread, replying and voting belong to the frontend: it is interactive, needs
 * the reader's session, and `kon-comments` already exposes the whole public API.
 * Redoing it here would duplicate `buildTree`, `ordenar` and `censurar`.
 *
 * What the frontend can NOT know on its own are three things, and they are
 * exactly the ones that were missing:
 *
 *   · **Which string to ask for.** `subjectType` was free text, so everyone
 *     invented their own (`post`, `blog_post`, `blogpost`) and each one opened a
 *     different thread on the same article, without error. Now it comes from here.
 *   · **How many there are.** A front page of twenty articles that wants to say "12
 *     comments" cannot make twenty calls. It is an aggregate, and
 *     aggregates are done where the data is.
 *   · **Whether it is open.** `commentsEnabled` belongs to the article; the polymorphic
 *     engine cannot know what "closed" means for each subject.
 *
 * ── THE COUNT WHEN THERE IS NO COMMENTS KON ────────────────────────────────
 *
 * `kon-comments` may not be installed, and then the table does not exist. In
 * that case `count` is `null`, NOT zero: zero means "I looked and there are none",
 * and saying it without looking is the kind of lie that makes someone spend
 * half an hour searching for why their comment does not count.
 */
const SUBJECT_TYPE = "blog_post";

/**
 * Categories of each post on the page, in ONE query.
 *
 * It returns an empty map on a read failure: the front page without labels can
 * still be drawn, and taking it all down because a label is missing would be worse
 * than the missing label.
 */
async function postCategories(
  db: KonContext["db"]["instance"],
  ids: string[]
): Promise<Map<string, Array<{ id: string; name: string; slug: string }>>> {
  const map = new Map<string, Array<{ id: string; name: string; slug: string }>>();
  if (ids.length === 0) return map;

  try {
    // In a SAVEPOINT: the `catch` below swallows the error on purpose (a
    // front page without labels can still be drawn), and without a savepoint a SQL
    // error would leave the whole request's transaction aborted.
    const rows = await withSavepoint(() =>
      db
        .select({
          postId: blogPostsToCategories.postId,
          id: blogCategories.id,
          name: blogCategories.name,
          slug: blogCategories.slug,
        })
        .from(blogPostsToCategories)
        .innerJoin(blogCategories, eq(blogPostsToCategories.categoryId, blogCategories.id))
        .where(inArray(blogPostsToCategories.postId, ids))
    );

    for (const rowValue of rows as Array<{
      postId: string;
      id: string;
      name: string;
      slug: string;
    }>) {
      const list = map.get(rowValue.postId) ?? [];
      list.push({ id: rowValue.id, name: rowValue.name, slug: rowValue.slug });
      map.set(rowValue.postId, list);
    }
  } catch {
    return map;
  }

  return map;
}

/**
 * The tags of each post on the page, in a single query.
 *
 * Ids only, for the same reason as the games: the `tags` table belongs to kon-games and
 * this kon does not read it. Whoever draws asks for the vocabulary once
 * (`GET /api/games/tags`) and resolves the name.
 *
 * The list did not return them, and without them a front page cannot filter by
 * tag: the esports one separates "news", "events" and "transfers", and the
 * scene's games (League of Legends, Valorant…) are not catalog
 * games, so they only exist as a tag.
 */
async function postTagsValue(
  db: KonContext["db"]["instance"],
  ids: string[]
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;

  try {
    // In a SAVEPOINT: the `catch` below swallows the error on purpose (a
    // front page without labels can still be drawn), and without a savepoint a SQL
    // error would leave the whole request's transaction aborted.
    const rows = await withSavepoint(() =>
      db
        .select({ postId: blogPostsToTags.postId, tagId: blogPostsToTags.tagId })
        .from(blogPostsToTags)
        .where(inArray(blogPostsToTags.postId, ids))
    );

    for (const rowValue of rows as Array<{ postId: string; tagId: string }>) {
      const list = map.get(rowValue.postId) ?? [];
      list.push(rowValue.tagId);
      map.set(rowValue.postId, list);
    }
  } catch {
    return map;
  }

  return map;
}

/**
 * The games of each post on the page, in a single query.
 *
 * Ids only: the bridge table stores `game_id` without a foreign key and this kon does NOT
 * read the kon-games tables. Whoever draws already has the catalog and resolves the
 * id, so the front page can put the game on each card without the blog
 * having to know what a game is.
 */
async function postGamesValue(
  db: KonContext["db"]["instance"],
  ids: string[]
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;

  try {
    // In a SAVEPOINT: the `catch` below swallows the error on purpose (a
    // front page without labels can still be drawn), and without a savepoint a SQL
    // error would leave the whole request's transaction aborted.
    const rows = await withSavepoint(() =>
      db
        .select({ postId: blogPostsToGames.postId, gameId: blogPostsToGames.gameId })
        .from(blogPostsToGames)
        .where(inArray(blogPostsToGames.postId, ids))
    );

    for (const rowValue of rows as Array<{ postId: string; gameId: string }>) {
      const list = map.get(rowValue.postId) ?? [];
      list.push(rowValue.gameId);
      map.set(rowValue.postId, list);
    }
  } catch {
    return map;
  }

  return map;
}

async function commentCounts(
  db: KonContext["db"]["instance"],
  ids: string[]
): Promise<Map<string, number> | null> {
  if (ids.length === 0) return new Map();

  /**
   * ── ONE PARAMETER PER ID, NOT THE WHOLE ARRAY ────────────────────────────
   *
   * `= ANY(${ids})` in a drizzle `sql` template sends the array as ONE scalar
   * parameter, and Postgres answers "malformed array literal". It looks
   * reasonable, it typechecks, and it blows up only with data in front of it — which is
   * exactly what happened the first time this was tried with real posts.
   */
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  );

  try {
    // In a SAVEPOINT: "the table does not exist" (42P01) is swallowed below, and without a
    // savepoint the request's transaction would be left aborted.
    const r = await withSavepoint(() =>
      db.execute(
        sql`SELECT subject_id, COUNT(*)::int AS n
          FROM comments
          WHERE subject_type = ${SUBJECT_TYPE}
            AND subject_id IN (${list})
            AND status = 'published'
          GROUP BY subject_id`
      )
    );

    const rows = (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as {
      subject_id: string;
      n: number;
    }[];

    return new Map(rows.map((f) => [f.subject_id, Number(f.n)]));
  } catch (err) {
    /**
     * ── THIS `catch` WAS ABOUT TO BE THE BUG ─────────────────────────────
     *
     * It started as a bare `catch { return null }`, with the reasoning
     * that "without a table there is no count". It sounds good and it is the trap: it swallowed a
     * REAL error —the badly parameterized array above— and presented it as
     * "kon-comments is not installed". The symptom was a silent `count: null`
     * on every post, pointing at a cause that did not exist.
     *
     * A `catch` that turns "this is broken" into "this does not apply" is the
     * costliest family of failure in this repo. So it only swallows what it
     * claims to be: a nonexistent table (42P01). Everything else propagates.
     */
    const e = err as { code?: string; cause?: { code?: string } };
    // Drizzle wraps the pg error, so the SQLSTATE may come in the
    // error o en su causa.
    if (e?.code === "42P01" || e?.cause?.code === "42P01") return null;
    throw err;
  }
}

/** Adds to the post what a frontend needs to ask for its thread. */
function withComments<T extends { id: string; commentsEnabled?: boolean | null }>(
  post: T,
  counts: Map<string, number> | null
) {
  return {
    ...post,
    comments: {
      subjectType: SUBJECT_TYPE,
      subjectId: post.id,
      /** The route already mounted: whoever draws the page does not have to compose it. */
      endpoint: `/api/comments/${SUBJECT_TYPE}/${post.id}`,
      /** `!== false` and not `=== true`: a post older than the column is open. */
      enabled: post.commentsEnabled !== false,
      /** `null` = no comments kon installed. See above. */
      count: counts ? (counts.get(post.id) ?? 0) : null,
    },
  };
}

/** The kon's id: it is part of each operation's fine-grained scope (`kon:blog:<op>`). */
export const KON_ID = "kon-blog";

/**
 * The blog's operations, with the kon's context injected.
 */
export function blogOperations(ctx: KonContext): AnyOperation[] {
  // The policy registry is global and a `resetAuthz()` empties it: it is
  // ensured when mounting the router, not just as a side effect of the import.
  registerBlogPolicy();
  const ops: AnyOperation[] = [];
  const { db, cache, events, realtime, auth } = ctx;

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC ROUTES - SPECIFIC FIRST (before parameterized routes)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/blog — List posts (public)
   */
  ops.push(
    defineOperation({
      id: "list-posts",
      method: "GET",
      route: "/",
      summary: "List blog posts",
      description:
        "Paginated posts, newest first, filterable by category (slug or uuid), game (uuid), text in title/excerpt and locale (one version per translation group: the asked locale, else English, else the newest). The public only sees published posts whose date has come; staff can ask for any status or 'all'.",
      tags: ["blog"],
      access: "optional",
      input: { query: ListQuery },
      output: { schema: EntriesList },
      handle: async (input, { c }) => {
        const limit = Math.min(Number(c.req.query("limit")) || 12, 100);
        const page = Math.max(Number(c.req.query("page")) || 1, 1);
        const offset = (page - 1) * limit;

        /**
         * ── WHOEVER HAS NO SESSION ONLY SEES WHAT IS PUBLISHED ────────────────────
         *
         * This route is PUBLIC and accepted `?status=` without looking at who was asking.
         * Checked against the real installation, without any cookie:
         *
         *     GET /api/blog?status=draft
         *     → {"docs":[{"title":"test post","content":"hello\nthis is…
         *
         * That is: anyone on the internet read ALL the drafts in full
         * —title, body, author— by changing one word in the URL. A draft is
         * exactly what must not yet be read: notes, half-finished things, embargoes.
         *
         * Nothing had to be broken to get there: the default value was
         * `published`, so the route looked right as long as nobody wrote
         * another. A safe default is not a permission.
         *
         * Now the status is NEGOTIATED with whoever asks:
         *
         *   · no session, or with the `user` role → always `published`, whatever is
         *     asked. It is not a 403 on purpose: the correct answer to "give me the
         *     drafts" from outside is the public list, not confirming that they exist.
         *   · `admin` or `editor` → any status, and also `all`, which is what
         *     a screen called "All Posts" needs to live up to its name.
         */
        const STATUSES = ["draft", "published", "scheduled", "archived"] as const;
        type Status = (typeof STATUSES)[number];

        // The SAME function used by the other four reads. There was a
        // copy of the role rule here: two places to change "who sees a
        // draft" is one place too many, and it is how one of the two goes stale.
        const canViewEverything = canViewUnpublished(c);

        const request = c.req.query("status");
        const status: Status | "all" = !canViewEverything
          ? "published"
          : request === "all"
            ? "all"
            : STATUSES.includes(request as Status)
              ? (request as Status)
              : "published";

        // The `all` filter does not filter. It is kept separate because `undefined` in a Drizzle
        // `.where()` means "no condition", and confusing that with "unknown
        // status" is how leaks get in.
        const statusCondition =
          status === "all"
            ? undefined
            : canViewEverything
              ? eq(blogPosts.status, status)
              : and(eq(blogPosts.status, status), SQL_DATE_REACHED);

        /**
         * ── FILTER BY CATEGORY ───────────────────────────────────────────────────
         *
         * Accepts slug or uuid, because a front page links by slug ("/guides") and the
         * panel by id.
         *
         * A category that does NOT exist returns empty, not "everything". Treating an unknown
         * filter as "no filter" is how a tab with a typo ends up
         * showing the entire front page and looking like it works.
         */
        const requestedCategory = c.req.query("category")?.trim() || undefined;
        let categoryCondition: SQL | undefined;

        if (requestedCategory) {
          const [category] = await db.instance
            .select({ id: blogCategories.id })
            .from(blogCategories)
            .where(
              isUuid(requestedCategory)
                ? eq(blogCategories.id, requestedCategory)
                : eq(blogCategories.slug, requestedCategory)
            )
            .limit(1);

          categoryCondition = category
            ? inArray(
                blogPosts.id,
                db.instance
                  .select({ id: blogPostsToCategories.postId })
                  .from(blogPostsToCategories)
                  .where(eq(blogPostsToCategories.categoryId, category.id))
              )
            : sql`false`;
        }

        /**
         * ── FILTER BY GAME ───────────────────────────────────────────────────────
         *
         * Accepts uuid only, on purpose. The bridge table stores `gameId` without a
         * foreign key and this kon does NOT import kon-games' schema: a kon does not read
         * another's tables. The caller already has the id because it just read the game.
         */
        const requestedGame = c.req.query("game")?.trim() || undefined;
        const gameCondition: SQL | undefined = !requestedGame
          ? undefined
          : isUuid(requestedGame)
            ? inArray(
                blogPosts.id,
                db.instance
                  .select({ id: blogPostsToGames.postId })
                  .from(blogPostsToGames)
                  .where(eq(blogPostsToGames.gameId, requestedGame))
              )
            : sql`false`;

        /**
         * Search by title or lead paragraph.
         *
         * The body is left out on purpose: it is JSONB of blocks and sweeping it on
         * every keystroke is expensive. With the title and lead paragraph a
         * guide is found by name, which is what is searched for from the game bar.
         */
        const requestedText = c.req.query("search")?.trim();
        const textCondition: SQL | undefined = requestedText
          ? or(
              ilike(blogPosts.title, `%${requestedText}%`),
              ilike(blogPosts.excerpt, `%${requestedText}%`)
            )
          : undefined;

        /**
         * ── ONE VERSION OF EACH ENTRY, THE ONE IN THE REQUESTED LANGUAGE ─────────
         *
         * With `?locale=pt` it does not simply filter "the ones in Portuguese": that
         * would leave the front page almost empty as soon as a site had three languages and
         * translations were arriving little by little. What is returned is
         * **one version per group**, choosing in this order:
         *
         *   1. the one in the requested language,
         *   2. the English one —the one most people can read—,
         *   3. the most recent in the group.
         *
         * This way nothing disappears for not being translated yet, and nothing shows up
         * twice in two languages. Whoever draws knows what language each entry is in
         * because `locale` travels in the response, and can flag it.
         *
         * `distinct on` is PostgreSQL's and does exactly this in one pass. The inner
         * `order by` is what picks the version; the outer one, the list
         * order.
         */
        const requestedLanguage = c.req.query("locale")?.trim().toLowerCase();

        /**
         * The SAME status filter, inside the subquery.
         *
         * Without it, a DRAFT won its group's election —it is the one in your language,
         * or the most recent— and then the outer filter discarded it: the whole
         * group disappeared from the list. That is, **starting to translate an
         * article erased it from the site** until the translation was published, with no
         * error and without anyone touching the original.
         */
        const statusInside: SQL =
          status === "all"
            ? sql`true`
            : canViewEverything
              ? sql`bp.status = ${status}`
              : sql`bp.status = ${status} and ${SQL_DATE_REACHED_BP}`;

        const languageCondition: SQL | undefined =
          requestedLanguage && /^[a-z]{2}$/.test(requestedLanguage)
            ? sql`${blogPosts.id} in (
            select distinct on (coalesce(bp.translation_group_id, bp.id)) bp.id
            from blog_posts bp
            where ${statusInside}
            order by coalesce(bp.translation_group_id, bp.id),
                     (bp.locale = ${requestedLanguage}) desc,
                     (bp.locale = 'en') desc,
                     bp.published_at desc nulls last
          )`
            : undefined;

        const condition = and(
          statusCondition,
          categoryCondition,
          gameCondition,
          textCondition,
          languageCondition
        );

        /**
         * The cache SEPARATES by privilege.
         *
         * Without the suffix, the first response that got cached would be served to
         * everyone: if an editor opens "All Posts" before anyone else, the public front page
         * would start serving drafts from the cache. The leak would come back through another
         * door, and this time leaving no trace in the route's code.
         */
        // The category goes into the key: without it, the first filtered response
        // would be served as if it were the complete front page.
        const cacheKey = `blog:list:${page}:${limit}:${status}:${requestedCategory ?? "-"}:${requestedGame ?? "-"}:${requestedText ?? "-"}:${requestedLanguage ?? "-"}:${canViewEverything ? "priv" : "pub"}`;

        // Try to read from cache
        const cached = await cache.get(cacheKey);
        if (cached) {
          return c.json(cached);
        }

        try {
          // Query principal
          // In series, not in `Promise.all`: both go through the SAME connection (the
          // request's RLS transaction), which serves one query at a time.
          const docs = await db.instance
            .select({
              post: blogPosts,
            })
            .from(blogPosts)
            .where(condition)
            .orderBy(desc(blogPosts.publishedAt))
            .limit(limit)
            .offset(offset);
          const countResult = await db.instance
            .select({ count: sql<number>`count(*)` })
            .from(blogPosts)
            .where(condition);

          const totalDocs = Number(countResult[0]?.count ?? 0);
          const totalPages = Math.ceil(totalDocs / limit);

          /**
           * A single aggregate for this page's posts. One per post would be
           * twenty queries to draw a front page — the classic N+1, and the reason
           * this is resolved here and not by calling the comments API
           * from the browser.
           */
          const counts = await commentCounts(
            db.instance,
            // Typed by hand and not `any`: `db.instance` arrives untyped here, and the
            // `any` ratchet counts —rightly— every annotation that is skipped.
            docs.map((row: { post: { id: string } }) => row.post.id)
          );

          /**
           * A single aggregate for the page's categories and games, for the
           * same reason as the comments: one query per post is twenty per
           * front page. In series: they share the request's connection.
           */
          const pageIds = docs.map((row: { post: { id: string } }) => row.post.id);
          const categories = await postCategories(db.instance, pageIds);
          const games = await postGamesValue(db.instance, pageIds);
          const tags = await postTagsValue(db.instance, pageIds);

          const response = {
            docs: docs.map((row: any) => ({
              ...withComments(postToServe({ ...row.post }, canViewEverything), counts),
              categories: categories.get(row.post.id) ?? [],
              // Same name as on the single post, so that whoever draws does not have
              // to look at which route it came from.
              gameIds: games.get(row.post.id) ?? [],
              tagIds: tags.get(row.post.id) ?? [],
            })),
            totalDocs,
            totalPages,
            page,
            limit,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
          };

          // Save to cache
          await cache.set(cacheKey, response, 60);

          return c.json(response);
        } catch (err: unknown) {
          ctx.logger.error("Failed to list blog posts", { error: messageOf(err) });
          return c.json({ error: "Failed to fetch posts" }, 500);
        }
      },
    })
  );

  /**
   * GET /api/blog/slug/:slug — Get post by slug (public)
   * SPECIFIC ROUTE - must come before /:id
   */
  ops.push(
    defineOperation({
      id: "get-by-slug",
      method: "GET",
      route: "/slug/:slug",
      summary: "Get a post by slug",
      description:
        "One post by slug with its author, tag and game ids, rendered blocks (blocksHtml), translations and comment thread info. Unpublished posts are a 404 for the public.",
      access: "optional",
      input: { params: ParamSlug },
      output: { schema: FullEntry },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const { slug } = input.params;

        try {
          const result = await db.instance
            .select()
            .from(blogPosts)
            .where(eq(blogPosts.slug, slug))
            .limit(1);

          if (!result.length) {
            return c.json({ error: "Post not found" }, 404);
          }

          const post = result[0];

          // Without a session, a post that is not published does not exist. This route did not
          // check the status at all: guessing the slug was enough.
          if (hiddenForThisVisitor(c, post)) {
            return c.json({ error: "Post not found" }, 404);
          }

          // Get related tags and games
          // In series: they share the request's connection (see the list).
          const postTags = await db.instance
            .select({
              tagId: blogPostsToTags.tagId,
            })
            .from(blogPostsToTags)
            .where(eq(blogPostsToTags.postId, post.id));
          const postGames = await db.instance
            .select({
              gameId: blogPostsToGames.gameId,
            })
            .from(blogPostsToGames)
            .where(eq(blogPostsToGames.postId, post.id));

          const counts = await commentCounts(db.instance, [post.id]);

          /**
           * The other versions of this entry.
           *
           * Without this, whoever opens a guide in Portuguese that only exists in English
           * has no way to know there is a version in their language: the bar's
           * language button reloads the same page and changes nothing, because
           * the translation is ANOTHER entry with another address.
           *
           * Published ones only: a half-done translation is not announced.
           */
          const group = post.translationGroupId;
          const translations = group
            ? await db.instance
                .select({
                  locale: blogPosts.locale,
                  slug: blogPosts.slug,
                  title: blogPosts.title,
                })
                .from(blogPosts)
                .where(
                  and(
                    eq(blogPosts.translationGroupId, group),
                    ne(blogPosts.id, post.id),
                    eq(blogPosts.status, "published"),
                    SQL_DATE_REACHED
                  )
                )
            : [];

          /**
           * Who signs the entry.
           *
           * Only the `authorId` was stored and nothing else, so the article came out WITHOUT an
           * author across the whole site: the page asked for `author.displayName` and no
           * `author` traveled here. The host (`ctx.auth`) is asked instead of
           * reading `auth_users`, which does not belong to this kon.
           *
           * If the account no longer exists, the entry goes out unsigned rather than with a
           * made-up signature.
           */
          const accounts = await ctx.auth.usersById([post.authorId]);
          const author = accounts.get(post.authorId);

          return c.json(
            withComments(
              withRenderedBlocks({
                ...postToServe(post, canViewUnpublished(c)),
                author: author
                  ? { id: author.id, displayName: author.name, image: author.image }
                  : null,
                tagIds: postTags.map((r: { tagId: string }) => r.tagId),
                gameIds: postGames.map((r: { gameId: string }) => r.gameId),
                translations: translations,
              }),
              counts
            )
          );
        } catch (err: unknown) {
          ctx.logger.error("Failed to get blog post", { slug, error: messageOf(err) });
          return c.json({ error: "Failed to fetch post" }, 500);
        }
      },
    })
  );

  /**
   * GET /api/blog/seo/:slug — Get a post's full SEO metadata
   * SPECIFIC ROUTE - must come before /:id
   */
  ops.push(
    defineOperation({
      id: "post-seo",
      method: "GET",
      route: "/seo/:slug",
      summary: "SEO metadata of a post",
      description:
        "Full SEO/Open Graph/structured-data metadata for a published post (404 if not visible).",
      access: "optional",
      input: { params: ParamSlug, query: SiteQuery },
      output: { schema: Generic },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const { slug } = input.params;
        const siteName = c.req.query("siteName") || "Kitsuden CMS";
        const baseUrl = c.req.query("baseUrl") || new URL(c.req.url).origin;

        try {
          // Get post
          const [post] = await db.instance
            .select()
            .from(blogPosts)
            .where(eq(blogPosts.slug, slug))
            .limit(1);

          if (!post) {
            return c.json({ error: "Post not found" }, 404);
          }

          // Only published posts have public SEO
          // `?preview=true` only works with an admin or editor session. Before, typing
          // it was enough —and the error message itself taught it.
          const isPreview = c.req.query("preview") === "true" && canViewUnpublished(c);
          // For whoever is not on the team, unpublished content does not exist (404, as in
          // `/slug/:slug`): a 403 confirmed that the slug was taken.
          if (hiddenForThisVisitor(c, post)) return c.json({ error: "Post not found" }, 404);
          if (!alreadyPublic(post) && !isPreview) {
            return c.json(
              {
                error: "Post not published",
                message:
                  "Drafts can only be read with an admin or editor session " +
                  "(and then with ?preview=true).",
              },
              403
            );
          }

          // Site configuration
          const siteConfig: SiteSEOConfig = {
            name: siteName,
            baseUrl,
            // og:locale from the post's own language (`locale`), else the site's
            // (`?language=`), else en_US.
            defaultLanguage: ogLocale(post.locale) ?? ogLocale(c.req.query("language")) ?? "en_US",
          };

          // Generate SEO metadata
          const seoMetadata = generateSEOMetadata({
            post,
            siteConfig,
            tags: [],
          });

          // Helper to escape HTML
          const escapeHtml = (text: string) =>
            text
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#039;");

          // Full response
          return c.json({
            success: true,
            post: {
              id: post.id,
              title: post.title,
              slug: post.slug,
              status: post.status,
              publishedAt: post.publishedAt,
            },
            seo: {
              title: seoMetadata.title,
              metaDescription: seoMetadata.metaDescription,
              canonicalUrl: seoMetadata.canonicalUrl,
              robots: seoMetadata.robots,
              keywords: seoMetadata.keywords,
              openGraph: seoMetadata.openGraph,
              twitterCard: seoMetadata.twitterCard,
              jsonLd: seoMetadata.jsonLd,
              readingTime: seoMetadata.readingTime,
              wordCount: seoMetadata.wordCount,
              score: seoMetadata.score,
              warnings: seoMetadata.warnings,
            },
            social: {
              // WhatsApp/Facebook/LinkedIn Open Graph
              openGraph: {
                title: seoMetadata.openGraph.title,
                description: seoMetadata.openGraph.description,
                image: seoMetadata.openGraph.image,
                url: seoMetadata.openGraph.url,
                type: seoMetadata.openGraph.type,
                whatsAppReady: seoMetadata.whatsAppValidation?.isValid ?? false,
                whatsAppWarnings: seoMetadata.whatsAppValidation?.warnings ?? [],
                whatsAppRecommendations: seoMetadata.whatsAppValidation?.recommendations ?? [],
              },
              // Twitter/X Card
              twitterCard: {
                card: seoMetadata.twitterCard.card,
                title: seoMetadata.twitterCard.title,
                description: seoMetadata.twitterCard.description,
                image: seoMetadata.twitterCard.image,
              },
            },
            html: {
              title: `<title>${escapeHtml(seoMetadata.title)}</title>`,
              metaTags: seoMetadata.metaTags,
              canonical: `<link rel="canonical" href="${escapeHtml(seoMetadata.canonicalUrl)}">`,
              jsonLd: seoMetadata.jsonLd.map(
                (schema) =>
                  `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`
              ),
            },
          });
        } catch (err: unknown) {
          ctx.logger.error("Failed to generate SEO metadata", { slug, error: messageOf(err) });
          return c.json({ error: "Failed to generate SEO metadata" }, 500);
        }
      },
    })
  );

  /**
   * GET /api/blog/geo/:slug — Full optimized SEO/GEO payload
   * SPECIFIC ROUTE - must come before /:id
   */
  ops.push(
    defineOperation({
      id: "post-geo",
      method: "GET",
      route: "/geo/:slug",
      summary: "GEO payload of a post",
      description:
        "The answer-engine payload of a published post: BLUF, FAQ and the API-friendly summary.",
      access: "optional",
      input: { params: ParamSlug, query: SiteQuery },
      output: { schema: Generic },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const { slug } = input.params;
        const siteName = c.req.query("siteName") || "Kitsuden CMS";
        const baseUrl = c.req.query("baseUrl") || new URL(c.req.url).origin;
        // See the note on `/seo/:slug`: the parameter is not a credential.
        const isPreview = c.req.query("preview") === "true" && canViewUnpublished(c);

        try {
          // Get post with GEO fields
          const [post] = await db.instance
            .select({
              id: blogPosts.id,
              slug: blogPosts.slug,
              title: blogPosts.title,
              content: blogPosts.content,
              excerpt: blogPosts.excerpt,
              blufText: blogPosts.blufText,
              faqData: blogPosts.faqData,
              datasetUrl: blogPosts.datasetUrl,
              metaTitle: blogPosts.metaTitle,
              metaDescription: blogPosts.metaDescription,
              ogImageId: blogPosts.ogImageId,
              status: blogPosts.status,
              publishedAt: blogPosts.publishedAt,
              updatedAt: blogPosts.updatedAt,
              authorId: blogPosts.authorId,
              readingTime: blogPosts.readingTime,
            })
            .from(blogPosts)
            .where(eq(blogPosts.slug, slug))
            .limit(1);

          if (!post) {
            return c.json({ error: "Post not found" }, 404);
          }

          // Only published posts (unless it is a preview). See `/seo/:slug`.
          if (hiddenForThisVisitor(c, post)) return c.json({ error: "Post not found" }, 404);
          if (!alreadyPublic(post) && !isPreview) {
            return c.json(
              {
                error: "Post not published",
                message:
                  "Drafts can only be read with an admin or editor session " +
                  "(and then with ?preview=true).",
              },
              403
            );
          }

          // Build optimized payload
          const payload = buildAPIPayload(
            { ...post, content: sanitizeBody(post.content) },
            {
              baseUrl,
              siteName,
            }
          );

          // GEO validations (non-blocking, informational only)
          const faqData = post.faqData as FAQItem[] | null;
          const geoValidation = {
            bluf: post.blufText ? validateBLUF(post.blufText) : null,
            faq: faqData
              ? {
                  count: faqData.length,
                  valid: faqData.every((f) => f.q && f.a),
                }
              : null,
          };

          return c.json({
            success: true,
            data: payload,
            _meta: {
              validation: geoValidation,
              generatedAt: new Date().toISOString(),
            },
          });
        } catch (err: unknown) {
          ctx.logger.error("Failed to get GEO payload", { slug, error: messageOf(err) });
          return c.json({ error: "Failed to fetch post" }, 500);
        }
      },
    })
  );

  /**
   * POST /api/blog/validate-seo — Validate SEO metadata (requires auth)
   * SPECIFIC ROUTE - must come before /:id
   */
  ops.push(
    defineOperation({
      id: "validate-seo",
      method: "POST",
      route: "/validate-seo",
      summary: "Validate SEO fields",
      description:
        "Scores title, description, excerpt, keyword and image against the SEO limits. Read-only; staff tool.",
      access: "session",
      permission: { policy: { resource: "blog_post", action: "useTools" } },
      idempotent: true,
      readOnly: true,
      input: { body: validateSeoSchema, validatesHandler: true },
      output: { schema: Generic },
      handle: async (input, { c }) => {
        try {
          const rawBody = input.body;
          const parseResult = validateSeoSchema.safeParse(rawBody);

          if (!parseResult.success) {
            return c.json(
              {
                error: "Validation failed",
                issues: parseResult.error.issues.map((i) => ({ path: i.path, message: i.message })),
              },
              400
            );
          }

          const body = parseResult.data;
          const title = body.title || "";
          const metaDescription = body.metaDescription || body.excerpt || "";
          const focusKeyword = body.focusKeyword;
          const content = body.content;

          const validation = {
            title: {
              current: title.length,
              min: SEO_LIMITS.title.min,
              optimal: SEO_LIMITS.title.optimal,
              max: SEO_LIMITS.title.max,
              isValid: title.length >= SEO_LIMITS.title.min && title.length <= SEO_LIMITS.title.max,
              isOptimal:
                title.length >= SEO_LIMITS.title.optimal && title.length <= SEO_LIMITS.title.max,
            },
            description: {
              current: metaDescription.length,
              min: SEO_LIMITS.description.min,
              optimal: SEO_LIMITS.description.optimal,
              max: SEO_LIMITS.description.max,
              isValid:
                metaDescription.length >= SEO_LIMITS.description.min &&
                metaDescription.length <= SEO_LIMITS.description.max,
              isOptimal:
                metaDescription.length >= SEO_LIMITS.description.optimal &&
                metaDescription.length <= SEO_LIMITS.description.max,
            },
          };

          const warnings = validateSEO(title, metaDescription, focusKeyword, content);

          // Validate OG Image for WhatsApp if provided
          let whatsAppValidation = null;
          if (body.imageUrl) {
            whatsAppValidation = validateWhatsAppImage(body.imageUrl, {
              width: body.imageWidth,
              height: body.imageHeight,
              fileSizeBytes: body.imageFileSize,
              mimeType: body.imageMimeType,
            });

            // Add WhatsApp warnings to general warnings
            if (!whatsAppValidation.isValid) {
              warnings.push(...whatsAppValidation.warnings.map((w: string) => `[WhatsApp] ${w}`));
            }
          }

          return c.json({
            valid: warnings.length === 0,
            validation,
            warnings,
            suggestions: [
              !validation.title.isOptimal &&
                `Adjust the title to ${SEO_LIMITS.title.optimal}-${SEO_LIMITS.title.max} characters`,
              !validation.description.isOptimal &&
                `Adjust the description to ${SEO_LIMITS.description.optimal}-${SEO_LIMITS.description.max} characters`,
              !focusKeyword && "Consider adding a main keyword",
            ].filter(Boolean),
            whatsApp: whatsAppValidation,
          });
        } catch (err: unknown) {
          ctx.logger.error("Failed to validate SEO", { error: messageOf(err) });
          return c.json({ error: "Failed to validate SEO" }, 500);
        }
      },
    })
  );

  /**
   * POST /api/blog/validate-image — Validate image for WhatsApp/OG (requires auth)
   * SPECIFIC ROUTE - must come before /:id
   */
  ops.push(
    defineOperation({
      id: "validate-image",
      method: "POST",
      route: "/validate-image",
      summary: "Validate a social image",
      description:
        "Checks an image (URL, size, weight, type) against what WhatsApp/Open Graph previews need. Read-only; staff tool.",
      access: "session",
      permission: { policy: { resource: "blog_post", action: "useTools" } },
      idempotent: true,
      readOnly: true,
      input: { body: validateImageSchema, validatesHandler: true },
      output: { schema: Generic },
      handle: async (input, { c }) => {
        try {
          const rawBody = input.body;
          const parseResult = validateImageSchema.safeParse(rawBody);

          if (!parseResult.success) {
            return c.json(
              {
                error: "Validation failed",
                issues: parseResult.error.issues.map((i) => ({ path: i.path, message: i.message })),
              },
              400
            );
          }

          const body = parseResult.data;
          const validation = validateWhatsAppImage(body.imageUrl, {
            width: body.width,
            height: body.height,
            fileSizeBytes: body.fileSize,
            mimeType: body.mimeType,
          });

          return c.json({
            valid: validation.isValid,
            whatsAppCompatible: validation.isValid,
            checks: validation.checks,
            warnings: validation.warnings,
            recommendations: validation.recommendations,
            metadata: validation.metadata,
            requirements: {
              maxFileSize: "300KB",
              idealDimensions: "1200x630px (1.91:1 ratio)",
              minDimensions: "400x400px",
              formats: ["JPG", "PNG"],
              avoid: ["WebP", "GIF", "SVG"],
            },
          });
        } catch (err: unknown) {
          ctx.logger.error("Failed to validate image", { error: messageOf(err) });
          return c.json({ error: "Failed to validate image" }, 500);
        }
      },
    })
  );

  /**
   * POST /api/blog/promote-from-source — Promote to Content
   * SPECIFIC ROUTE - must come before /:id
   */
  ops.push(
    defineOperation({
      id: "promote-from-source",
      method: "POST",
      route: "/promote-from-source",
      summary: "Create a post from a dataset entry",
      description:
        "Creates a draft (or published) post from a dataset entry, or from a kon table row (admin only, never account/secret tables).",
      access: "session",
      permission: { policy: { resource: "blog_post", action: "promote" } },
      input: { body: promoteFromSourceSchema, validatesHandler: true },
      output: { status: 201, schema: Generic },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        try {
          const rawBody = input.body;
          const parseResult = promoteFromSourceSchema.safeParse(rawBody);

          if (!parseResult.success) {
            return c.json(
              {
                error: "Validation failed",
                issues: parseResult.error.issues.map((i) => ({ path: i.path, message: i.message })),
              },
              400
            );
          }

          const body = parseResult.data;
          const currentUser = ctxGet<{ id?: string; role?: string }>(c, "user");

          // Get source data
          let sourceData: Record<string, unknown> | null = null;

          /**
           * ── READING "ANY TABLE" WAS READING THE PASSWORDS ─────────────────────
           *
           * `sourceType: "kon"` does `SELECT * FROM <table> WHERE id = <recordId>`
           * with the table name the client sends, and stores the WHOLE row
           * in `source.snapshot.rawData`, which `GET /api/blog` served to anyone.
           * With `autoPublish`, an editor (or whoever stole their session) put the admin's
           * `auth_users` row on the public site —their id comes out in every
           * entry as `authorId`—, or that of an account, session or key.
           *
           * Now: admin only, never account/secret/agent tables, and the
           * snapshot no longer goes out in public responses (`postToServe`).
           */
          if (body.sourceType === "kon") {
            const notTable = await rejection(c, "promoteFromTable");
            if (notTable) return notTable;
            if (body.table && bannedTable(body.table)) {
              return c.json({ error: "That table cannot be promoted to the blog" }, 403);
            }
          }

          if (body.sourceType === "dataset" && body.datasetId && body.entryId) {
            sourceData = await fetchDatasetEntry(ctx, body.datasetId, body.entryId);
          } else if (body.sourceType === "kon" && body.konId && body.table && body.recordId) {
            sourceData = await fetchKonRecord(ctx, body.konId, body.table, body.recordId);
          }

          if (!sourceData) {
            return c.json({ error: "Source record not found" }, 404);
          }

          // Use the ContentTarget directly
          const result = await blogContentTarget.publish(
            {
              source: {
                type: body.sourceType,
                konId: body.konId,
                table: body.table,
                recordId: body.recordId || body.entryId!,
                data: sourceData,
              },
              options: {
                title: body.titleTemplate
                  ? body.titleTemplate.replace(
                      /\{(\w+)\}/g,
                      // `sourceData[key]` is `unknown`, so `|| ""` returned
                      // `{}` and not a string. Also, with `??` a 0 is printed
                      // as "0": the "{games} games" template no longer
                      // comes out lame when the value is zero.
                      (_: string, key: string) => String(sourceData![key] ?? "")
                    )
                  : undefined,
                // With a hyphen and not a slash: a slug with `/` is not a valid
                // `/blog/<slug>` address (see `RE_SLUG`).
                slug: body.slugPrefix
                  ? aSlug(`${body.slugPrefix}-${String(sourceData.slug || sourceData.id)}`) ||
                    undefined
                  : undefined,
                autoPublish: body.autoPublish || false,
                // The author is whoever promotes. Sending another `authorId` is accepted
                // only if that account exists (see `validAuthor`).
                authorId: (await validAuthor(body.authorId, accountId(currentUser))) ?? "",
                targetConfig: {
                  tagIds: body.tagIds,
                  gameIds: body.gameIds,
                },
              },
            },
            ctx
          );

          await cache.invalidate("blog:list:*");

          events.emit("blog:post:promoted", {
            postId: result.contentId,
            slug: result.slug,
            sourceType: body.sourceType,
          });

          return c.json(
            {
              success: true,
              postId: result.contentId,
              slug: result.slug,
              message:
                "Entry promoted to blog post successfully (legacy endpoint - use /api/content/promote)",
            },
            201
          );
        } catch (err: unknown) {
          ctx.logger.error("Failed to promote entry to blog", { error: messageOf(err) });
          return c.json({ error: "Failed to promote entry" }, 500);
        }
      },
    })
  );

  /**
   * GET /api/blog/source/:postId — Get the original source data
   * SPECIFIC ROUTE - must come before /:id
   */
  ops.push(
    defineOperation({
      id: "post-source",
      method: "GET",
      route: "/source/:postId",
      summary: "Source of a promoted post",
      description:
        "The source record a post was promoted from (staff only: it carries the whole source row).",
      access: "session",
      permission: { policy: { resource: "blog_post", action: "viewUnpublished" } },
      input: { params: ParamPost },
      output: { schema: Generic },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        // The whole source row: the team's and nobody else's.
        try {
          const postId = input.params.postId;
          if (!isUuid(postId)) return c.json({ error: "Post not found" }, 404);

          const [post] = await db.instance
            .select({
              id: blogPosts.id,
              source: blogPosts.source,
              title: blogPosts.title,
              slug: blogPosts.slug,
            })
            .from(blogPosts)
            .where(eq(blogPosts.id, postId))
            .limit(1);

          if (!post) {
            return c.json({ error: "Post not found" }, 404);
          }

          if (!post.source) {
            return c.json({ error: "Post has no source data" }, 404);
          }

          return c.json({
            postId: post.id,
            title: post.title,
            slug: post.slug,
            source: post.source,
          });
        } catch (err: unknown) {
          ctx.logger.error("Failed to get source data", { error: messageOf(err) });
          return c.json({ error: "Failed to fetch source" }, 500);
        }
      },
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // PROTECTED ROUTES - PARAMETERIZED (must come AFTER specific routes)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/blog — Create post (requires auth)
   */
  ops.push(
    defineOperation({
      id: "create-post",
      method: "POST",
      route: "/",
      summary: "Create a post",
      description:
        "Creates a post (draft by default) with its tags, games and categories. Content and blocks are sanitized; the slug is derived from the title when missing. publishedAt is an ISO 8601 date.",
      access: "session",
      permission: { policy: { resource: "blog_post", action: "create" } },
      input: { body: createPostSchema, validatesHandler: true },
      output: { status: 201, schema: Input },
      errors: ["KITSUDEN_E_CONFLICT"],
      guide: {
        whenToUse:
          "To create a NEW post. To change one that exists use blog__update-post, and to publish a draft blog__publish-post: creating again makes a duplicate (or a 409 on the slug).",
        before: [
          "categoryIds come from blog__list-categories (uuids, not names).",
          "tagIds and gameIds are uuids from the games kon (GET /api/games/tags, GET /api/games).",
        ],
        examples: [
          {
            title: "A draft with only the essentials",
            args: {
              body: { title: "Beginner's guide", excerpt: "What to do in your first hour." },
              idempotency_key: "blog-guia-inicio-0001",
            },
          },
          {
            title: "Scheduled for a date",
            args: {
              body: { title: "Patch 2.1 notes", status: "scheduled", publishedAt: "2026-11-02T09:00:00Z" },
            },
          },
        ],
        traps: [
          { if: "you send `tags` or `categories` with names", then: "send `tagIds` / `categoryIds` with uuids." },
          {
            if: "`publishedAt` is rejected",
            then: "use ISO 8601 with time and zone (2026-11-02T09:00:00Z); `null` unschedules.",
          },
          {
            if: "409 on create",
            then: "the slug exists: send another `slug`, or edit the existing post instead.",
          },
        ],
      },
      handle: async (input, { c }) => {
        try {
          const rawBody = input.body;
          const parseResult = createPostSchema.safeParse(rawBody);

          if (!parseResult.success) {
            return c.json(
              {
                error: "Validation failed",
                issues: parseResult.error.issues.map((i) => ({ path: i.path, message: i.message })),
              },
              400
            );
          }

          const body = parseResult.data;
          const currentUser = ctxGet<{ id?: string; role?: string }>(c, "user");
          const oldKeys = oldBlockKeysError(body.blocks);
          if (oldKeys) return c.json(oldKeys, 422);

          // Validate BLUF (Bottom Line Up Front)
          if (body.blufText) {
            const blufValidation = validateBLUF(body.blufText);
            if (!blufValidation.isValid) {
              return c.json(
                {
                  error: "Validation failed",
                  field: "blufText",
                  message: "BLUF validation failed",
                  details: blufValidation.errors,
                  warnings: blufValidation.warnings,
                  metrics: blufValidation.metrics,
                },
                400
              );
            }
          }

          // Sanitizar FAQs
          let sanitizedFAQs: FAQItem[] | undefined;
          if (body.faqData && body.faqData.length > 0) {
            sanitizedFAQs = body.faqData.map((faq, index) => ({
              q: sanitizeHTML(faq.q, { stripAll: true }),
              a: sanitizeFAQText(faq.a),
              order: faq.order ?? index,
            }));
          }

          // Generate slug if not provided
          const slug =
            body.slug ||
            body.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "");

          // A title with only non-Latin characters gave an EMPTY slug, and it was
          // saved: an entry without an address.
          const errorDeSlug = invalidSlug(slug);
          if (errorDeSlug)
            return c.json({ error: "Validation failed", field: "slug", message: errorDeSlug }, 400);

          // Phase F (owner's decision): an agent with a human signer
          // writes AS that human; another authorId only with `admin`. Without a
          // signer, as always (it must send authorId). See
          // @kitsuden/shared firmante.ts.
          const signature = agentSignature(currentUser, body.authorId, "requested");
          if (!signature.ok) {
            return c.json({ error: "Forbidden", field: "authorId", message: signature.message, code: signature.code }, 403);
          }
          const author = await validAuthor(signature.author ?? undefined, accountId(currentUser));
          // An AGENT is not an account and `author_id` is required (FK to
          // auth_users): it writes on behalf of a person and names them in authorId.
          if (!author && currentUser?.role === "agent") {
            return c.json(
              {
                error: "Validation failed",
                field: "authorId",
                message:
                  "An agent key must send authorId: the id of an existing account the post is written for.",
              },
              400
            );
          }
          if (!author) {
            return c.json(
              { error: "Validation failed", field: "authorId", message: "That author does not exist" },
              400
            );
          }

          // Insert post and its relations in a SAVEPOINT: a repeated slug
          // (unique) is answered with 409 below, and without a savepoint that SQL error would leave
          // the request's transaction aborted (rule 2 of the kon SDK).
          const post = await withSavepoint(async () => {
            const [createdItem] = await db.instance
              .insert(blogPosts)
              .values({
                title: body.title,
                slug,
                content: sanitizeBody(body.content),
                excerpt: body.excerpt,
                blufText: body.blufText,
                faqData: sanitizedFAQs,
                datasetUrl: body.datasetUrl,
                metaTitle: body.metaTitle,
                metaDescription: body.metaDescription,
                ogImageId: body.ogImageId,
                status: body.status || "draft",
                publishedAt: body.status === "published" ? new Date() : body.publishedAt,
                authorId: author,
                featuredImageId: body.featuredImageId,
                featuredImageFocalPoint: body.featuredImageFocalPoint,
                readingTime: body.readingTime,
                seoOverrides: body.seoOverrides,
                blocks: sanitizeBlocks(body.blocks || []),
                /**
                 * The insert lists column by column —unlike the
                 * update, which forwards the rest with a spread— so whatever
                 * is not named here is silently lost. The column has DEFAULT
                 * true, so omitting this broke nothing visible: it only made
                 * it impossible to create an article with the thread already closed.
                 */
                commentsEnabled: body.commentsEnabled,
                // Same trap as the line above: the insert does not spread.
                layout: body.layout,
                /**
                 * The language and the group, for the same reason. And `locale` has DEFAULT
                 * 'es': omitting it here would make every translation be born marked as
                 * Spanish, with no error and no warning.
                 */
                locale: body.locale,
                translationGroupId: body.translationGroupId ?? undefined,
              })
              .returning();

            // Handle relations with tags
            if (body.tagIds?.length) {
              await db.instance
                .insert(blogPostsToTags)
                .values(body.tagIds.map((tagId: string) => ({ postId: createdItem.id, tagId })));
            }

            // Handle relations with games
            if (body.gameIds?.length) {
              await db.instance
                .insert(blogPostsToGames)
                .values(body.gameIds.map((gameId: string) => ({ postId: createdItem.id, gameId })));
            }

            if (body.categoryIds?.length) {
              await db.instance
                .insert(blogPostsToCategories)
                .values(
                  body.categoryIds.map((categoryId: string) => ({ postId: createdItem.id, categoryId }))
                );
            }

            return createdItem;
          });

          // Emit event
          events.emit("blog:post:created", { postId: post.id, title: post.title });
          // A post born published is a publication too: without this, kon-newsletter's
          // auto-send (which listens to `blog:post:published`) never fired for it.
          if (post.status === "published") {
            events.emit("blog:post:published", { postId: post.id, post });
          }

          // Invalidate cache
          await cache.invalidate("blog:list:*");

          ctx.logger.info("Blog post created", { postId: post.id, author: currentUser?.id });

          return c.json(post, 201);
        } catch (err: unknown) {
          // Handle duplicate slug error
          if (messageOf(err)?.includes("unique")) {
            return c.json({ error: "Slug already exists" }, 409);
          }
          // A value Postgres does not accept (duplicate, out of range, format) is
          // the entry's fault, not a 500 (Schemathesis, 2026-10-26).
          const ofInput = postgresInputError(err);
          if (ofInput) return c.json({ error: ofInput.message }, ofInput.status as 400 | 409 | 422);
          ctx.logger.error("Failed to create blog post", { error: messageOf(err) });
          return c.json({ error: "Failed to create post" }, 500);
        }
      },
    })
  );

  // ═════════════════════════════════════════════════════════════════════════
  // CATEGORIES
  // ═════════════════════════════════════════════════════════════════════════
  //
  // ⚠️ THEY GO HERE, BEFORE `/:id`, AND IT IS NOT STYLE.
  //
  // Hono resolves by REGISTRATION ORDER: if `/:id` were registered first,
  // it would capture "categories" as if it were an id and these routes would never
  // run. There is no error or warning — the wrong handler answers. It is
  // exactly the failure that left `/games/new` as a 404, and that is why there is a
  // test (`shadowed-routes`, in the core) that guards it.

  /**
   * GET /api/blog/categories — blog categories (public)
   *
   * Returns the FLAT list with `parentId`, not nested. The tree is built on the
   * client: nesting it here would force fixing a maximum depth, and the flat
   * list works just as well for the editor's selector and for a site menu.
   *
   * It includes `postCount` because the question that always follows "which categories
   * are there" is "how many things does each one have", and without this the panel would make N
   * queries to find out.
   */
  ops.push(
    defineOperation({
      id: "list-categories",
      method: "GET",
      route: "/categories",
      summary: "List blog categories",
      description:
        "Every category as a flat list with parentId and postCount (build the tree on the client).",
      access: "public",
      output: { schema: CategoryList },
      handle: async (_input, { c }) => {
        try {
          const categories = await db.instance
            .select({
              id: blogCategories.id,
              name: blogCategories.name,
              slug: blogCategories.slug,
              description: blogCategories.description,
              parentId: blogCategories.parentId,
              displayOrder: blogCategories.displayOrder,
              postCount: sql<number>`(
            SELECT count(*)::int FROM blog_posts_to_categories
            WHERE category_id = ${blogCategories.id}
          )`,
            })
            .from(blogCategories)
            .orderBy(asc(blogCategories.displayOrder), asc(blogCategories.name));

          return c.json({ docs: categories, total: categories.length });
        } catch (err: unknown) {
          ctx.logger.error("Failed to list blog categories", { error: messageOf(err) });
          return c.json({ error: "Failed to fetch categories" }, 500);
        }
      },
    })
  );

  /**
   * Would hanging `hijo` from `padre` create a cycle?
   *
   * Without this check, moving a category inside its own
   * descendant produces a ring: the table allows it —each row points to another
   * that exists— and whoever traverses the tree blows up, with an
   * infinite loop in the browser. A foreign key cannot prevent it, so it is
   * checked here.
   *
   * It climbs from the proposed parent toward the root. The hop limit is a
   * net in case a cycle already existed from before.
   */
  async function wouldCreateCycle(child: string, parent: string | null): Promise<boolean> {
    if (!parent) return false;
    if (parent === child) return true;

    let actual: string | null = parent;
    for (let breaks = 0; actual && breaks < 100; breaks++) {
      const [rowValue]: { parentId: string | null }[] = await db.instance
        .select({ parentId: blogCategories.parentId })
        .from(blogCategories)
        .where(eq(blogCategories.id, actual))
        .limit(1);

      if (!rowValue) return false;
      if (rowValue.parentId === child) return true;
      actual = rowValue.parentId;
    }
    return false;
  }

  /**
   * POST /api/blog/categories — create (requires auth)
   */
  ops.push(
    defineOperation({
      id: "create-category",
      method: "POST",
      route: "/categories",
      summary: "Create a blog category",
      description: "Creates a category (optionally under a parent).",
      access: "session",
      permission: { policy: { resource: "blog_category", action: "create" } },
      input: { body: categorySchema, validatesHandler: true },
      output: { status: 201, schema: Category },
      errors: ["KITSUDEN_E_CONFLICT"],
      handle: async (input, { c }) => {
        try {
          const parsed = categorySchema.safeParse(input.body);
          if (!parsed.success) {
            return c.json(
              {
                error: "Validation failed",
                issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
              },
              400
            );
          }

          const data = parsed.data;

          const [alreadyExists] = await db.instance
            .select({ id: blogCategories.id })
            .from(blogCategories)
            .where(eq(blogCategories.slug, data.slug))
            .limit(1);

          if (alreadyExists) {
            return c.json({ error: `There is already a category with the slug «${data.slug}»` }, 409);
          }

          if (data.parentId) {
            const [parent] = await db.instance
              .select({ id: blogCategories.id })
              .from(blogCategories)
              .where(eq(blogCategories.id, data.parentId))
              .limit(1);
            if (!parent) return c.json({ error: "The parent category does not exist" }, 400);
          }

          const [createdOne] = await db.instance
            .insert(blogCategories)
            .values({
              name: data.name,
              slug: data.slug,
              description: data.description ?? null,
              parentId: data.parentId ?? null,
              displayOrder: data.displayOrder ?? 0,
            })
            .returning();

          await cache.invalidate("blog:categories:*");
          return c.json(createdOne, 201);
        } catch (err: unknown) {
          // A value Postgres does not accept (duplicate, out of range, format) is
          // the entry's fault, not a 500 (Schemathesis, 2026-10-26).
          const ofInput = postgresInputError(err);
          if (ofInput) return c.json({ error: ofInput.message }, ofInput.status as 400 | 409 | 422);
          ctx.logger.error("Failed to create blog category", { error: messageOf(err) });
          return c.json({ error: "Failed to create category" }, 500);
        }
      },
    })
  );

  /**
   * PATCH /api/blog/categories/:id — rename, move or reorder (requires auth)
   */
  ops.push(
    defineOperation({
      id: "update-category",
      method: "PATCH",
      route: "/categories/:id",
      summary: "Update a blog category",
      description: "Renames, moves or reorders a category (a category cannot be its own ancestor).",
      access: "session",
      permission: { policy: { resource: "blog_category", action: "update" } },
      input: { params: ParamId, body: categorySchema.partial(), validatesHandler: true },
      output: { schema: Category },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      handle: async (input, { c }) => {
        try {
          const id = input.params.id;
          if (!isUuid(id)) return c.json({ error: "Category not found" }, 404);

          const parsed = categorySchema.partial().safeParse(input.body);
          if (!parsed.success) {
            return c.json(
              {
                error: "Validation failed",
                issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
              },
              400
            );
          }

          const data = parsed.data;

          if (data.parentId !== undefined && (await wouldCreateCycle(id, data.parentId ?? null))) {
            return c.json(
              {
                error: "That category cannot hang from one of its own descendants",
                message:
                  "The tree would become a ring and any traversal would loop. " +
                  "Move it to the root first and then to its new place.",
              },
              409
            );
          }

          if (data.slug) {
            const [other] = await db.instance
              .select({ id: blogCategories.id })
              .from(blogCategories)
              .where(eq(blogCategories.slug, data.slug))
              .limit(1);
            if (other && other.id !== id) {
              return c.json({ error: `There is already a category with the slug «${data.slug}»` }, 409);
            }
          }

          const [updatedValue] = await db.instance
            .update(blogCategories)
            .set({ ...data, updatedAt: new Date() })
            .where(eq(blogCategories.id, id))
            .returning();

          if (!updatedValue) return c.json({ error: "Category not found" }, 404);

          await cache.invalidate("blog:categories:*");
          return c.json(updatedValue);
        } catch (err: unknown) {
          // A value Postgres does not accept (duplicate, out of range, format) is
          // the entry's fault, not a 500 (Schemathesis, 2026-10-26).
          const ofInput = postgresInputError(err);
          if (ofInput) return c.json({ error: ofInput.message }, ofInput.status as 400 | 409 | 422);
          ctx.logger.error("Failed to update blog category", { error: messageOf(err) });
          return c.json({ error: "Failed to update category" }, 500);
        }
      },
    })
  );

  /**
   * DELETE /api/blog/categories/:id — delete (requires auth)
   *
   * The children MOVE UP TO ROOT (`ON DELETE SET NULL` in the database) and the posts lose
   * only this category, they are not deleted. Wiping out a whole branch with its
   * content with one click is not an operation that should exist behind a button.
   */
  ops.push(
    defineOperation({
      id: "delete-category",
      method: "DELETE",
      route: "/categories/:id",
      summary: "Delete a blog category",
      description: "Deletes a category. Its posts stay; they just lose the category.",
      access: "session",
      permission: { policy: { resource: "blog_category", action: "delete" } },
      input: { params: ParamId },
      output: { schema: Generic },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        try {
          const id = input.params.id;
          if (!isUuid(id)) return c.json({ error: "Category not found" }, 404);

          const [deletedOne] = await db.instance
            .delete(blogCategories)
            .where(eq(blogCategories.id, id))
            .returning();

          if (!deletedOne) return c.json({ error: "Category not found" }, 404);

          await cache.invalidate("blog:categories:*");
          return c.json({ success: true, id });
        } catch (err: unknown) {
          ctx.logger.error("Failed to delete blog category", { error: messageOf(err) });
          return c.json({ error: "Failed to delete category" }, 500);
        }
      },
    })
  );

  /**
   * GET /api/blog/:id — Get post by ID (public)
   * PARAMETERIZED ROUTE - must come AFTER all specific routes
   */
  ops.push(
    defineOperation({
      id: "get-post",
      method: "GET",
      route: "/:id",
      summary: "Get a post by id",
      description:
        "One post by uuid (same shape as by slug). Unpublished posts are a 404 for the public.",
      access: "optional",
      input: { params: ParamId },
      output: { schema: FullEntry },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        try {
          // An id that is not a UUID cannot exist, and passing it to the query makes
          // Postgres throw `invalid input syntax for type uuid`, which the
          // error handler turns into a 500. A mistyped URL is not a
          // server failure: 404 is the correct response.
          const id = input.params.id;
          if (!isUuid(id)) return c.json({ error: "Post not found" }, 404);

          const result = await db.instance
            .select()
            .from(blogPosts)
            .where(eq(blogPosts.id, id))
            .limit(1);

          if (!result.length) {
            return c.json({ error: "Post not found" }, 404);
          }

          // Same criterion as in `/slug/:slug`: without permission, it does not exist. An id is
          // harder to guess than a slug, but "hard to guess" is not
          // an access control — it is what leaks in a log or in a link.
          if (hiddenForThisVisitor(c, result[0])) {
            return c.json({ error: "Post not found" }, 404);
          }

          /**
           * Tags travel with the post.
           *
           * This endpoint returned the raw `blog_posts` row, and tags
           * are a relation in `blog_posts_to_tags`. The panel editor did
           * `tags = post.tags || []`, so opening an existing post ALWAYS
           * came out without tags, whatever it had: they could not be seen or
           * removed.
           *
           * The ids are returned and not the objects because the editor already loads the
           * full catalog with `GET /api/blog/tags`; joining them here would force
           * importing the `tags` table, which belongs to another kon.
           *
           * The public endpoint next door already ran this same query. It was missing
           * only in the panel's.
           */
          const tags = await db.instance
            .select({ tagId: blogPostsToTags.tagId })
            .from(blogPostsToTags)
            .where(eq(blogPostsToTags.postId, result[0].id));

          const categories = await db.instance
            .select({ categoryId: blogPostsToCategories.categoryId })
            .from(blogPostsToCategories)
            .where(eq(blogPostsToCategories.postId, result[0].id));

          const counts = await commentCounts(db.instance, [result[0].id]);

          return c.json(
            withComments(
              {
                ...postToServe(result[0], canViewUnpublished(c)),
                tagIds: tags.map((t: { tagId: string }) => t.tagId),
                categoryIds: categories.map((x: { categoryId: string }) => x.categoryId),
              },
              counts
            )
          );
        } catch (err: unknown) {
          ctx.logger.error("Failed to get blog post", { error: messageOf(err) });
          return c.json({ error: "Failed to fetch post" }, 500);
        }
      },
    })
  );

  /**
   * PATCH /api/blog/:id — Update post (requires auth)
   */
  ops.push(
    defineOperation({
      id: "update-post",
      method: "PATCH",
      route: "/:id",
      summary: "Update a post",
      description:
        "Changes the given fields and, if sent, replaces its tags/games/categories. publishedAt (ISO 8601, or null) schedules or unschedules it. Send expectedUpdatedAt (the updatedAt you loaded) to get a 409 instead of overwriting someone else's save.",
      access: "session",
      permission: { policy: { resource: "blog_post", action: "update" } },
      input: { params: ParamId, body: updatePostSchema, validatesHandler: true },
      output: { schema: Input },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      handle: async (input, { c }) => {
        try {
          const rawBody = input.body;
          const parseResult = updatePostSchema.safeParse(rawBody);

          if (!parseResult.success) {
            return c.json(
              {
                error: "Validation failed",
                issues: parseResult.error.issues.map((i) => ({ path: i.path, message: i.message })),
              },
              400
            );
          }

          const body = parseResult.data;
          const postId = input.params.id;
          if (!isUuid(postId)) return c.json({ error: "Post not found" }, 404);
          const oldKeys = oldBlockKeysError(body.blocks);
          if (oldKeys) return c.json(oldKeys, 422);

          if (body.slug !== undefined) {
            const errorDeSlug = invalidSlug(body.slug);
            if (errorDeSlug)
              return c.json(
                { error: "Validation failed", field: "slug", message: errorDeSlug },
                400
              );
          }
          if (body.authorId !== undefined) {
            const who = userOf(c);
            if (!(await validAuthor(body.authorId, who?.id))) {
              return c.json(
                { error: "Validation failed", field: "authorId", message: "That author does not exist" },
                400
              );
            }
          }

          // Separate column updates from relations. `expectedUpdatedAt`
          // is not a column either: it is the version mark the client sends.
          const { tagIds, gameIds, categoryIds, expectedUpdatedAt, ...columnUpdates } = body as any;

          // The body is saved already sanitized (see `sanitized.ts`).
          if ("content" in columnUpdates)
            columnUpdates.content = sanitizeBody(columnUpdates.content);
          if ("blocks" in columnUpdates) columnUpdates.blocks = sanitizeBlocks(columnUpdates.blocks);

          /**
           * ── CONCURRENT EDITING ────────────────────────────────────────────────
           *
           * If two people open the same post, the one who saved second overwrote the
           * first WITHOUT ANYONE NOTICING: the `UPDATE` went by plain `id` and
           * always found the row. The first person's work disappeared and
           * there was no trace or warning — there is no version history to
           * go back to.
           *
           * This is not a lock WordPress-style (which reserves the post
           * while someone has it open and needs client heartbeats and an
           * expiry). It is the cheapest thing that prevents the loss: if the client says
           * which version it starts from, the `UPDATE` requires the row to still be at that
           * version. If it is not, NOTHING is written and a 409 is answered with the
           * current mark, so the editor can warn.
           *
           * It is optional on purpose: whoever does not send `expectedUpdatedAt` —a script,
           * an integration, an old client— keeps the usual behavior.
           * Closing it off completely would force touching every consumer at once.
           */
          /**
           * ── WHY `date_trunc` AND NOT A PLAIN `=` ──────────────────────────────
           *
           * `updated_at` is `timestamptz(6)`: Postgres stores MICROSECONDS. When
           * leaving through the API it passes through a JavaScript `Date`, which only reaches
           * MILLISECONDS, so the mark the editor receives is truncated:
           *
           *     in the database 2026-08-28T23:05:45.919009Z
           *     in the editor   2026-08-28T23:05:45.919Z
           *
           * Comparing those two with `=` NEVER MATCHES. And the way it failed
           * is the worst possible: the `UPDATE` found no row, the code deduced
           * "someone changed it" and returned 409 — that is, ANY save, with
           * a single person editing and no conflict, was rejected. A
           * protection against loss of work that prevented saving.
           *
           * The column is truncated to the same precision that survives the trip. There
           * is no index cost: the row is already pinned by the primary key.
           */
          const condition = expectedUpdatedAt
            ? and(
                eq(blogPosts.id, postId),
                sql`date_trunc('milliseconds', ${blogPosts.updatedAt}) = ${new Date(expectedUpdatedAt)}`
              )
            : eq(blogPosts.id, postId);

          const [updated] = await db.instance
            .update(blogPosts)
            .set({
              ...columnUpdates,
              updatedAt: new Date(),
            })
            .where(condition)
            .returning();

          if (!updated) {
            // No rows can mean two very different things, and confusing them
            // sends the user looking for a post that does exist.
            if (expectedUpdatedAt) {
              const [actual] = await db.instance
                .select({ updatedAt: blogPosts.updatedAt })
                .from(blogPosts)
                .where(eq(blogPosts.id, postId))
                .limit(1);

              if (actual) {
                return c.json(
                  {
                    error: "The post has changed since you opened it",
                    message:
                      "Another person saved it while you were editing. Nothing was " +
                      "written so as not to erase their work. Open the post again " +
                      "and reapply your changes.",
                    currentUpdatedAt: actual.updatedAt,
                  },
                  409
                );
              }
            }
            return c.json({ error: "Post not found" }, 404);
          }

          // Sync tags if provided
          if (tagIds !== undefined) {
            await db.instance.delete(blogPostsToTags).where(eq(blogPostsToTags.postId, postId));

            if (tagIds.length > 0) {
              await db.instance
                .insert(blogPostsToTags)
                .values(tagIds.map((tagId: string) => ({ postId, tagId })));
            }
          }

          // Sync games if provided
          if (gameIds !== undefined) {
            await db.instance.delete(blogPostsToGames).where(eq(blogPostsToGames.postId, postId));

            if (gameIds.length > 0) {
              await db.instance
                .insert(blogPostsToGames)
                .values(gameIds.map((gameId: string) => ({ postId, gameId })));
            }
          }

          if (categoryIds !== undefined) {
            await db.instance
              .delete(blogPostsToCategories)
              .where(eq(blogPostsToCategories.postId, postId));

            if (categoryIds.length > 0) {
              await db.instance
                .insert(blogPostsToCategories)
                .values(categoryIds.map((categoryId: string) => ({ postId, categoryId })));
            }
          }

          // Invalidate cache
          await cache.invalidate("blog:list:*");
          await cache.invalidate(`blog:post:${postId}`);

          // Broadcast realtime
          realtime.broadcast(`blog:post:${postId}`, {
            type: "update",
            data: updated,
          });

          // Emit event if it was published
          if (updated.status === "published" && body.status === "published") {
            events.emit("blog:post:published", { postId: updated.id, post: updated });
          }

          ctx.logger.info("Blog post updated", { postId });

          return c.json(updated);
        } catch (err: unknown) {
          // A value Postgres does not accept (duplicate, out of range, format) is
          // the entry's fault, not a 500 (Schemathesis, 2026-10-26).
          const ofInput = postgresInputError(err);
          if (ofInput) return c.json({ error: ofInput.message }, ofInput.status as 400 | 409 | 422);
          ctx.logger.error("Failed to update blog post", { error: messageOf(err) });
          return c.json({ error: "Failed to update post" }, 500);
        }
      },
    })
  );

  /**
   * DELETE /api/blog/:id — Delete post (requires auth)
   */
  ops.push(
    defineOperation({
      id: "delete-post",
      method: "DELETE",
      route: "/:id",
      summary: "Delete a post",
      description: "Deletes a post and its tag/game links. Cannot be undone.",
      access: "session",
      permission: { policy: { resource: "blog_post", action: "delete" } },
      input: { params: ParamId },
      output: { schema: z.object({ deleted: z.literal(true), id: z.guid() }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        try {
          const postId = input.params.id;
          if (!isUuid(postId)) return c.json({ error: "Post not found" }, 404);

          const [deleted] = await db.instance
            .delete(blogPosts)
            .where(eq(blogPosts.id, postId))
            .returning({ id: blogPosts.id });

          if (!deleted) {
            return c.json({ error: "Post not found" }, 404);
          }

          // Clean up relations
          await db.instance.delete(blogPostsToTags).where(eq(blogPostsToTags.postId, postId));
          await db.instance.delete(blogPostsToGames).where(eq(blogPostsToGames.postId, postId));

          // Invalidate cache
          await cache.invalidate("blog:list:*");

          // Emit event
          events.emit("blog:post:deleted", { postId });

          ctx.logger.info("Blog post deleted", { postId });

          return c.json({ deleted: true, id: deleted.id });
        } catch (err: unknown) {
          ctx.logger.error("Failed to delete blog post", { error: messageOf(err) });
          return c.json({ error: "Failed to delete post" }, 500);
        }
      },
    })
  );

  /**
   * POST /api/blog/:id/publish — Publish a post quickly
   */
  ops.push(
    defineOperation({
      id: "publish-post",
      method: "POST",
      route: "/:id/publish",
      summary: "Publish a post now",
      description: "Sets the post to published with publishedAt = now.",
      access: "session",
      permission: { policy: { resource: "blog_post", action: "publish" } },
      sensitive: true,
      input: { params: ParamId },
      output: { schema: Input },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        try {
          const postId = input.params.id;
          if (!isUuid(postId)) return c.json({ error: "Post not found" }, 404);

          const [updated] = await db.instance
            .update(blogPosts)
            .set({
              status: "published",
              publishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(blogPosts.id, postId))
            .returning();

          if (!updated) {
            return c.json({ error: "Post not found" }, 404);
          }

          await cache.invalidate("blog:list:*");

          events.emit("blog:post:published", { postId: updated.id, post: updated });

          ctx.logger.info("Blog post published", { postId });

          return c.json(updated);
        } catch (err: unknown) {
          ctx.logger.error("Failed to publish blog post", { error: messageOf(err) });
          return c.json({ error: "Failed to publish post" }, 500);
        }
      },
    })
  );

  /**
   * POST /api/blog/:slug/refresh-og-cache — Refresh the Open Graph cache
   * PARAMETERIZED with :slug - must come AFTER all specific routes like /slug/:slug
   */
  ops.push(
    defineOperation({
      id: "refresh-og-cache",
      method: "POST",
      route: "/:slug/refresh-og-cache",
      summary: "Ask Facebook to re-scrape a post",
      description:
        "Asks the Facebook Graph API to refresh its Open Graph cache for the post URL (an outbound call).",
      access: "session",
      permission: { policy: { resource: "blog_post", action: "useTools" } },
      idempotent: true,
      input: { params: ParamSlug, query: QueryBaseUrl },
      output: { schema: Generic },
      errors: ["KITSUDEN_E_BAD_GATEWAY"],
      mcp: { exclude: "calls an external service (Facebook) with a caller-chosen base URL" },
      handle: async (input, { c }) => {
        try {
          const { slug } = input.params;
          const baseUrl = c.req.query("baseUrl") || new URL(c.req.url).origin;
          const postUrl = `${baseUrl.replace(/\/$/, "")}/blog/${slug}`;

          // Try to re-scrape with Facebook
          const fbResponse = await fetch(
            `https://graph.facebook.com/?id=${encodeURIComponent(postUrl)}&scrape=true`,
            { method: "POST" }
          );

          const fbResult = await fbResponse.json().catch(() => null);

          ctx.logger.info("Facebook OG cache refresh attempted", {
            slug,
            postUrl,
            status: fbResponse.status,
            result: fbResult,
          });

          return c.json({
            success: true,
            message: "Open Graph cache refresh requested",
            postUrl,
            facebook: {
              status: fbResponse.status,
              result: fbResult,
              debuggerUrl: `https://developers.facebook.com/tools/debug/?q=${encodeURIComponent(postUrl)}`,
            },
            notes: [
              "Facebook can take up to 24 hours to update the cache",
              "Use the Facebook Debugger to force the re-scrape manually",
              "LinkedIn has its own separate cache",
              "WhatsApp has no public API to refresh the cache",
            ],
          });
        } catch (err: unknown) {
          ctx.logger.error("Failed to refresh OG cache", { error: messageOf(err) });
          return c.json(
            {
              error: "Failed to refresh cache",
              message: messageOf(err),
            },
            500
          );
        }
      },
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function sanitizeIdentifier(name: string): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid SQL identifier: ${name}`);
    }
    return name;
  }

  /**
   * A dataset's entry, read from `data_entries` by its id AND its dataset.
   *
   * It used to use `datasetId` as a TABLE NAME (`SELECT * FROM <datasetId>`):
   * with the real id (a uuid, which is what the panel sends) it always failed, and
   * with an arbitrary name it was the same arbitrary table read as
   * `fetchKonRecord`. The entry's title and data are returned, nothing
   * of the internal columns (owner, status, dates).
   */
  async function fetchDatasetEntry(
    ctx: KonContext,
    datasetId: string,
    entryId: string
  ): Promise<Record<string, unknown> | null> {
    if (!isUuid(datasetId) || !isUuid(entryId)) return null;
    try {
      const result = await ctx.db.instance.execute(
        sql`SELECT id, title, data FROM data_entries
            WHERE id = ${entryId} AND data_set_id = ${datasetId} LIMIT 1`
      );
      const rowValue = ((result as any)?.rows?.[0] || (result as any)?.[0] || null) as {
        id: string;
        title: string;
        data: unknown;
      } | null;
      if (!rowValue) return null;
      const data =
        rowValue.data && typeof rowValue.data === "object" ? (rowValue.data as Record<string, unknown>) : {};
      return { ...data, id: rowValue.id, title: rowValue.title ?? data.title };
    } catch {
      return null;
    }
  }

  /**
   * Does that account exist? If no author is sent, it is whoever makes the request.
   *
   * `authorId` was free text: any string ended up signing an entry
   * (and the record came out without an author, or with another person's if their
   * id was guessed). Choosing ANOTHER existing author is a panel function and is respected.
   */
  /**
   * The id of the writer IF it is an account. An agent (phase E: it can create
   * entries with `kon:blog:create-post`) is not in auth_users and `author_id`
   * points there: its entry is left without an author instead of blowing up the FK.
   */
  function accountId(u: { id?: string; role?: unknown } | null | undefined): string | undefined {
    return u?.role === "agent" ? undefined : u?.id;
  }

  async function validAuthor(
    request: string | undefined,
    actual: string | undefined
  ): Promise<string | null> {
    const id = request || actual;
    if (!id) return null;
    if (id === actual) return id;
    const accounts = await ctx.auth.usersById([id]);
    return accounts.has(id) ? id : null;
  }

  function aSlug(textValue: string): string {
    return textValue
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  async function fetchKonRecord(
    ctx: KonContext,
    _konId: string,
    table: string,
    recordId: string
  ): Promise<Record<string, unknown> | null> {
    if (bannedTable(table)) return null;
    try {
      const safeTable = sanitizeIdentifier(table);
      const result = await ctx.db.instance.execute(
        sql`SELECT * FROM ${sql.identifier(safeTable)} WHERE id = ${recordId} LIMIT 1`
      );
      return (result as any)?.rows?.[0] || (result as any)?.[0] || null;
    } catch {
      return null;
    }
  }

  return ops;
}

/** The blog's REST router, generated from its operations. */
export const createBlogRouter: KonRouterFactory = (ctx: KonContext) =>
  operationsRouter(KON_ID, blogOperations(ctx), ctx);

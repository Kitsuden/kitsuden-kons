/**
 * @kitsuden/kon-comments
 * ============================================================================
 *
 * Comments that hang from anything: a wiki page, a catalog item, a
 * shared build, an article.
 *
 * It is what the set lacks to resemble a community game wiki, where half the
 * value of a boss page is the people below telling how they killed it.
 *
 * ── THE THREE DECISIONS THAT DEFINE IT ─────────────────────────────────────
 *
 * **Polymorphic.** `(subjectType, subjectId)` instead of a table per commentable
 * thing. No foreign key, in exchange for not repeating threads, votes and
 * moderation five times.
 *
 * **Moderating hides, it does not delete.** A removed comment stays in the tree with its
 * body replaced, because deleting it takes its replies along — which
 * exist, have content and have done nothing.
 *
 * **One vote per user, in its own table.** The `comments.score` counter
 * is denormalized for speed, but `comment_votes` is the source of truth
 * and allows recalculating it. A counter with no way to rebuild it would be a
 * mistake.
 */

import {
  defineKonSdk,
  isInvalidInputSyntax,
  repo,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import {
  isSubjectType,
  commentableSubject,
  COMMENTABLE_SUBJECTS,
  SUBJECT_TYPES,
  type KonContext,
} from "@kitsuden/shared";
import { inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import "./comments.policy.js";
import {
  censor,
  count,
  initialStatus,
  buildTree,
  sort,
  depthOf,
  CommentsError,
  STATUSES,
  MAX_DEPTH,
  type Order,
} from "./comments.engine.js";
import { comments, commentVotes } from "./comments.schema.js";
import { Row, KON_ID, query, registry, onTheComment, text } from "./operations.js";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

export * from "./comments.engine.js";
export * from "./comments.schema.js";

/**
 * Can this visitor see the subject the thread hangs from?
 * ============================================================================
 *
 * ── THE HOLE IT CLOSES ─────────────────────────────────────────────────────
 *
 * Reading threads is public and nobody checked that the subject existed.
 * With that you can hang comments from the id of a DRAFT and read them from
 * outside: the thread of an unpublished article, visible to anyone who
 * has the id. It is the same family that already showed up in blog, games and esports —
 * the fourth time.
 *
 * ── WHY IT IMPORTS NO KON ──────────────────────────────────────────────────
 *
 * Importing `kon-blog` from here would tie the polymorphic engine to one of its
 * subjects, and it would have to be repeated for every commentable thing. Instead, the
 * vocabulary of `@kitsuden/shared` declares the table and which states are
 * public, and it is queried generically here.
 *
 * ── AND THE TABLE DOES NOT COME FROM THE REQUEST ───────────────────────────
 *
 * It is the one thing to look at twice when reading this: the table name is
 * interpolated into the SQL. It comes from the `COMMENTABLE_SUBJECTS` literal, which is reached
 * only after `isSubjectType()`, so there is no client string in
 * that position. The id does come from outside and is parameterized.
 */
async function visibleSubject(
  db: KonContext["db"]["instance"],
  subjectType: string,
  subjectId: string,
  canViewAll: boolean
): Promise<boolean> {
  const subject = commentableSubject(subjectType);
  // A type outside the vocabulary has no thread to show. It is not an error:
  // there is simply nothing there.
  if (!subject) return false;

  const rowsValue = (r: unknown): unknown[] => {
    if (Array.isArray(r)) return r;
    const c = r as { rows?: unknown };
    return Array.isArray(c?.rows) ? c.rows : [];
  };

  const table = sql.raw(`"${subject.table}"`);

  try {
    // Whoever moderates sees a draft's thread; it only has to EXIST.
    if (canViewAll || !subject.statusColumn) {
      const r = await db.execute(sql`SELECT 1 FROM ${table} WHERE id = ${subjectId} LIMIT 1`);
      return rowsValue(r).length > 0;
    }

    const column = sql.raw(`"${subject.statusColumn}"`);

    /**
     * ── WHY IT IS NOT `= ANY(${estados})` ───────────────────────────────────
     *
     * Because it does not work, and it fails in production and not here. A drizzle `sql`
     * template serializes the array as ONE scalar parameter, so Postgres
     * receives the string `published` where it expects an array literal and answers:
     *
     *     malformed array literal: "published"
     *
     * Written that way it looks reasonable and typechecks. What it does is bring down
     * with a 500 the public read of ALL threads.
     *
     * `sql.join` emits one parameter per element, which is what an `IN` wants.
     */
    const statuses = sql.join(
      subject.publicStatuses.map((e) => sql`${e}`),
      sql`, `
    );

    const r = await db.execute(
      sql`SELECT 1 FROM ${table}
          WHERE id = ${subjectId} AND ${column} IN (${statuses})
          LIMIT 1`
    );
    return rowsValue(r).length > 0;
  } catch (e) {
    /**
     * ── A MISTYPED URL IS NOT A SERVER FAILURE ─────────────────────────────
     *
     * `blog_posts.id` and `block_pages.id` are `uuid`. Requesting
     * `/api/comments/blog_post/x` puts "x" in the comparison and Postgres throws
     * `invalid input syntax for type uuid` (22P02), which uncaught comes out as
     * **500**. Measured against the real installation before this.
     *
     * An impossible id identifies nothing, so the correct answer is the
     * same as for an id that does not exist: it is not visible. It is exactly the
     * case that was already closed in `Repository.find`, which is why its
     * check is reused instead of writing another that will drift.
     */
    if (isInvalidInputSyntax(e)) return false;
    throw e;
  }
}

/**
 * Adds to each comment the subject it hangs from: title and slug.
 * ============================================================================
 *
 * ── WHY IT IS NOT A QUERY PER COMMENT ──────────────────────────────────────
 *
 * Because it would be N+1, and the moderation queue is precisely the screen that is opened
 * when there are MANY. The ids are grouped by subject type and one
 * query per type is made: today two at most, and it grows not with the number of
 * comments but with the number of commentable things.
 *
 * ── AND WHY IT DOES NOT IMPORT `kon-blog` ──────────────────────────────────
 *
 * Table and columns come from the vocabulary of `@kitsuden/shared`, which is reached only
 * after `isSubjectType`. This kon still knows none of its
 * subjects, which is what makes adding one cost a single line there.
 */
async function withSubjects<T extends { subjectType: string; subjectId: string }>(
  db: KonContext["db"]["instance"],
  rowsValue: T[]
): Promise<(T & { subject: { title: string; slug: string } | null })[]> {
  const byType = new Map<string, Set<string>>();
  for (const f of rowsValue) {
    if (!isSubjectType(f.subjectType)) continue;
    if (!byType.has(f.subjectType)) byType.set(f.subjectType, new Set());
    byType.get(f.subjectType)!.add(f.subjectId);
  }

  /** `type::id` → subject data. */
  const foundItems = new Map<string, { title: string; slug: string }>();

  for (const [type, ids] of byType) {
    const subject = COMMENTABLE_SUBJECTS[type as keyof typeof COMMENTABLE_SUBJECTS];
    const table = sql.raw(`"${subject.table}"`);
    const titleCol = sql.raw(`"${subject.titleColumn}"`);
    const colSlug = sql.raw(`"${subject.slugColumn}"`);

    // One parameter per id: `= ANY(${array})` sends the array as a scalar and
    // Postgres answers "malformed array literal".
    const list = sql.join(
      [...ids].map((id) => sql`${id}`),
      sql`, `
    );

    try {
      const r = await db.execute(
        sql`SELECT id, ${titleCol} AS title, ${colSlug} AS slug
            FROM ${table} WHERE id IN (${list})`
      );
      const rows = (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as {
        id: string;
        title: string;
        slug: string;
      }[];
      for (const row of rows) {
        foundItems.set(`${type}::${row.id}`, { title: row.title, slug: row.slug });
      }
    } catch (e) {
      /**
       * An id with an impossible shape (22P02) identifies nothing: that comment
       * is left without a subject and the screen says so. What CANNOT happen is
       * the whole queue failing because one row points at a strange id.
       */
      if (!isInvalidInputSyntax(e)) throw e;
    }
  }

  return rowsValue.map((f) => ({
    ...f,
    // `null` is informative: it means "the article it hung from no longer
    // exists". It is a legitimate reason to delete the comment, and without saying so
    // it would look like a screen failure.
    subject: foundItems.get(`${f.subjectType}::${f.subjectId}`) ?? null,
  }));
}

/** How many comments there are in each state. Feeds the tabs. */
async function countsByStatus(db: KonContext["db"]["instance"]): Promise<Record<string, number>> {
  const r = await db.execute(sql`SELECT status, COUNT(*)::int AS n FROM comments GROUP BY status`);
  const rows = (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as {
    status: string;
    n: number;
  }[];

  // Everything starts at zero: if a state does not appear because there are none,
  // the tab has to say 0 and not disappear.
  const base: Record<string, number> = Object.fromEntries(STATUSES.map((e) => [e, 0]));
  for (const row of rows) base[row.status] = Number(row.n);
  return base;
}

const CreateSchema = z.object({
  /**
   * ── WHY THE SHAPE IS NOT ENOUGH ──────────────────────────────────────────
   *
   * It used to be a bare `.regex(/^[a-z0-9_]+$/)`, and with that `post`, `blog_post` and
   * `blogpost` were all three accepted: THREE different threads on the same
   * article, each invisible from where the other was written. No error and
   * nothing to search for, because both sides "work".
   *
   * The vocabulary lives in `@kitsuden/shared` so that the kon that publishes the
   * subject and the one that stores the thread cannot disagree. Closing WRITES
   * does not kill polymorphism: adding a type costs one line there, and what used to
   * be a silent typo becomes a deliberate act.
   */
  subjectType: z
    .string()
    .min(1)
    .max(60)
    .refine(isSubjectType, {
      message: `unknown subject type. Valid ones are: ${SUBJECT_TYPES.join(", ")}`,
    }),
  subjectId: z.string().min(1).max(200),
  parentId: z.string().min(1).max(80).nullable().optional(),
  body: z.string().min(1).max(10_000),
});

const EditSchema = z.object({ body: z.string().min(1).max(10_000) });
const ModerateSchema = z.object({ status: z.enum(STATUSES) });

/**
 * Moderate in batch.
 *
 * It exists because a spam streak arrives all at once: twenty comments in a
 * minute. One by one is twenty requests, twenty confirmations and twenty
 * chances to click the wrong thing. The limit of 200 is so that one request
 * does not become an uncontrolled `UPDATE`.
 */
const ModerateBatchSchema = z.object({
  ids: z.array(z.string().min(1).max(80)).min(1).max(200),
  status: z.enum(STATUSES),
});
const VoteSchema = z.object({ value: z.union([z.literal(1), z.literal(-1), z.literal(0)]) });

/**
 * A user's display name, if they have one.
 *
 * `AuthzUser` declares `id` and `role` and leaves the rest as `[key: string]:
 * unknown` — so `user.name` is NOT a string until it is checked.
 * Forcing it with a cast would write `[object Object]` into the author column of
 * each comment, and it would be seen in production, not here.
 */
function visibleName(user: AuthzUser | null): string | null {
  /**
   * NEVER the email. Before, the list ended in `"email"`: whoever registered without a
   * name (or with a blank one) published their address next to every
   * comment, in a read that asks for no session. Without a name, the thread says
   * "anonymous" and that is it.
   */
  for (const key of ["name", "displayName"]) {
    const v = user?.[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/**
 * How many comments an account can post in a window.
 *
 * Account sign-up is public, so "with a session" stops nobody: without a
 * cap, a script with one account fills any thread in seconds. It is counted
 * by AUTHOR and in the database, not by in-memory IP: changing IP resets nothing
 * and it works the same with several API replicas. Whoever moderates has no cap.
 */
export const COMMENT_LIMIT = { perWindow: 10, windowMs: 10 * 60_000, perDay: 100 };

/**
 * What is shown of a comment to someone who is NOT its author or a moderator.
 *
 * Without `authorId`: it is an account id, and a public thread has no reason to
 * hand out its users' ids (the same criterion as the builds gallery). In its
 * place goes `mine`, which is the only thing the interface needs to know.
 */
function forOutside<T extends { authorId: string | null }>(
  nodes: { comment: T; answers: unknown[] }[],
  user: AuthzUser | null,
  canModerate: boolean
): unknown[] {
  return nodes.map((n) => {
    const mine = Boolean(user?.id) && n.comment.authorId === user?.id;
    const { authorId: _authorId, ...rest } = n.comment;
    return {
      comment: canModerate ? { ...n.comment, mine } : { ...rest, mine },
      answers: forOutside(
        n.answers as { comment: T; answers: unknown[] }[],
        user,
        canModerate
      ),
    };
  });
}

/** Words that send a comment to the review queue. */
const BANNED = (process.env.KITSUDEN_COMMENT_BLOCKLIST ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

// ── Parameters and outputs (OpenAPI and MCP) ─────────────────────────────────

const ParamId = z.object({ id: z.string().describe("Comment id") });
const SubjectParam = z.object({
  subjectType: z.string().describe(`What the thread hangs from: ${SUBJECT_TYPES.join(", ")}`),
  subjectId: z.string().describe("Id of that subject (e.g. the blog post id)"),
});

/** A comment: database row (without `authorId` for non-moderators). */
const CommentOut = Row;
/** A thread node: the comment and its replies, recursive. */
const TreeNodeOut = z
  .object({ comment: CommentOut, answers: z.array(z.unknown()) })
  .passthrough();

export function commentsOperations(ctx: KonContext): AnyOperation[] {
  const app = registry();
  const db = ctx.db.instance;

  // Reading is public: a thread only registered users see adds nothing to a
  // wiki page. Everything else asks for a session (`access: "session"`).
  //
  // `access: "optional"` (`optionalAuth`) on reads and not "none": without a
  // resolved session the GET never knew who was asking, so neither whoever
  // moderates saw what they have to review nor could the interface know which is
  // yours. It used to be done by an `app.use("*")`.

  // Before `/:subjectType/:subjectId`, which read `moderation`/`queue` as
  // a comment subject and returned an empty list instead of the queue.
  /** Moderation queue: what the filter sent to review. */
  /**
   * The moderation queue.
   * ==========================================================================
   *
   * ── WHAT IT WAS MISSING ──────────────────────────────────────────────────
   *
   * It returned the raw rows with `status = "pending"`, and with that whoever moderates
   * sees a comment body next to a uuid. **The same text can be a legitimate
   * reply in one thread and spam in another**, so without knowing which
   * article it comes from, moderating is guessing. It is WordPress's "In response to"
   * column.
   *
   * It also ALWAYS brought everything pending, with no limit: over a table that
   * grows, that is a query that gets worse by itself until one day it brings down
   * the screen. And there was no way to see what was already hidden, which is where you look
   * when someone complains that a comment of theirs was deleted.
   *
   * ── HOW THE TITLE IS RESOLVED WITHOUT COUPLING ANYTHING ──────────────────
   *
   * One query per comment would be N+1. Instead the ids are grouped
   * by subject type and ONE query per type is made — two at most today.
   * The table and columns come from the vocabulary of `@kitsuden/shared`, never
   * from the request, so this kon still imports no other.
   */
  app.get(
    "/moderation/queue",
    {
      id: "moderation-queue",
      permission: onTheComment("moderate"),
      summary: "List comments by moderation state",
      description:
        "The comments in one state (`status`: pending by default, also published or hidden), newest first, each with the subject it hangs from (title and slug, or null if it is gone), plus `counts`: how many comments there are in each state. `limit` 1-200 (100 by default). 422 for an unknown state. Admin/editor (or an agent with comments:moderate).",
      // `optional` and not `session`: without permission, 403 for the anonymous too, as before.
      access: "optional",
      input: {
        query: query({
          status: text("pending (default) | published | hidden"),
          limit: text("How many, 1-200 (100 by default)"),
        }),
      },
      output: {
        schema: z.object({
          data: z.array(
            CommentOut.extend({
              subject: z.object({ title: z.string(), slug: z.string() }).nullable(),
            })
          ),
          total: z.number().int(),
          counts: z.record(z.string(), z.number().int()),
        }),
      },
    },
    async (c, _input, h) => {
      if (!(await h.can({}))) return c.json({ error: "Forbidden" }, 403);

      const rawValue = c.req.query("status") ?? "pending";
      /**
       * The type is narrowed HERE, in the check, instead of casting further
       * down: an `as` in the query would say the value is valid without having
       * looked, and that is exactly what needs looking at when it comes from the URL.
       */
      if (!(STATUSES as readonly string[]).includes(rawValue)) {
        return c.json({ error: `Unknown state. Valid: ${STATUSES.join(", ")}` }, 422);
      }
      const requestedStatus = rawValue as (typeof STATUSES)[number];

      // Hard cap in addition to what the client asks: a `?limit=999999` cannot
      // become an uncontrolled query.
      const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 200);

      const rowsValue = await repo(comments, { db })
        .filter({ status: requestedStatus })
        .orderBy("-createdAt")
        .limit(limit)
        .all();

      return c.json({
        data: await withSubjects(db, rowsValue),
        total: rowsValue.length,
        // How many there are of each state: it is what draws the tabs without requesting the
        // three full lists.
        counts: await countsByStatus(db),
      });
    }
  );

  /**
   * Moderate several at once.
   *
   * A spam streak arrives all at once. One by one is twenty requests and twenty
   * chances to click the wrong thing.
   */
  app.post(
    "/moderation/bulk",
    {
      id: "moderate-in-bulk",
      permission: onTheComment("moderate"),
      summary: "Set the moderation state of many comments",
      description:
        "Sets `status` (pending, published or hidden) on up to 200 comments at once, without touching their text. Returns how many were really updated (`moderated`, ids that no longer exist do not count) against how many were asked (`requested`). Admin/editor (or an agent with comments:moderate).",
      access: "session",
      // Changes at once what is seen in the public threads.
      sensitive: true,
      idempotent: true,
      input: { body: ModerateBatchSchema },
      output: {
        schema: z.object({
          moderated: z.number().int(),
          requested: z.number().int(),
          status: z.string(),
        }),
      },
    },
    async (c, input, h) => {
      if (!(await h.can({}))) return c.json({ error: "Forbidden" }, 403);

      const { ids, status } = input.body as z.infer<typeof ModerateBatchSchema>;

      const updatedOnes = await db
        .update(comments)
        .set({ status, updatedAt: new Date() })
        .where(inArray(comments.id, ids))
        .returning({ id: comments.id });

      /**
       * It returns how many were REALLY touched, not `ids.length`. If someone
       * sends ids that no longer exist, saying "20 moderated" when it was 18 means
       * nobody finds out that the list was out of date.
       */
      return c.json({ moderated: updatedOnes.length, requested: ids.length, status });
    }
  );

  /**
   * A subject's thread, already built into a tree.
   *
   * It is returned built and not flat: grouping by parent in each client would be
   * repeating in JS what is tested here, and the first version anyone
   * writes will lose the orphans.
   */
  app.get(
    "/:subjectType/:subjectId",
    {
      id: "get-thread",
      summary: "Read the comment thread of a subject",
      description:
        "The comments hanging from a subject (a blog post, a wiki page…) as a tree (`answers` nested up to `maxDepth`), ordered by `order` (best by default). Hidden or pending comments show their text only to moderators; nobody else gets account ids, only `mine` (whether it is yours). A subject that does not exist or that you cannot see returns an EMPTY thread, not a 404. Public.",
      access: "optional",
      input: {
        params: SubjectParam,
        query: query({ order: text("best (default) | newest | oldest") }),
      },
      output: {
        schema: z.object({
          data: z.array(TreeNodeOut),
          total: z.number().int(),
          maxDepth: z.number().int(),
        }),
      },
    },
    async (c) => {
      const user = (c.get("user") ?? null) as AuthzUser | null;
      const canModerate = user?.role === "admin" || user?.role === "editor";

      const rowsValue = await repo(comments, { db })
        .filter({
          subjectType: c.req.param("subjectType"),
          subjectId: c.req.param("subjectId"),
        })
        .all();

      /**
       * And first of all, that the subject exists and can be seen. An EMPTY
       * list is answered and not a 404: from outside, "this article has no
       * comments" and "this article does not exist yet" must read the
       * same. A 404 here would confirm that the id belongs to something real.
       */
      if (
        !(await visibleSubject(
          db,
          c.req.param("subjectType"),
          c.req.param("subjectId"),
          canModerate
        ))
      ) {
        return c.json({ data: [], total: 0, maxDepth: MAX_DEPTH });
      }

      const order = (c.req.query("order") ?? "best") as Order;
      const tree = sort(buildTree(rowsValue), order);
      const visible = censor(tree, canModerate);

      return c.json({
        data: forOutside(visible, user, canModerate),
        // `contar` walks the tree; `rows.length` counts what was loaded. With
        // pagination they are not the same, and the number next to the title is the first.
        total: count(visible),
        maxDepth: MAX_DEPTH,
      });
    }
  );

  app.post(
    "/",
    {
      id: "create-comment",
      permission: onTheComment("create"),
      summary: "Post a comment",
      description:
        "Posts a comment on a subject (`subjectType` + `subjectId`), optionally as a reply (`parentId`, same subject). A body with blocked words goes to the moderation queue (`status: pending`) instead of being published. 404 if the subject cannot be seen or the parent does not exist; 422 if the parent is from another subject or the thread is too deep; 429 after too many comments in a row. A signed-in person, or an agent with comments:create.",
      access: "session",
      input: { body: CreateSchema },
      output: { status: 201, schema: z.object({ data: CommentOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const user = (c.get("user") ?? null) as AuthzUser | null;
      if (!(await h.can({}))) return c.json({ error: "Forbidden" }, 403);

      const data = input.body as z.infer<typeof CreateSchema>;

      /**
       * Commenting on something that cannot be seen is the other half of the same hole: if
       * it is allowed, the thread is created and the next one to ask for that id
       * receives it. 404 and not 403, for the usual reason — a 403 confirms it
       * exists.
       */
      const moderator = user?.role === "admin" || user?.role === "editor";
      if (!(await visibleSubject(db, data.subjectType, data.subjectId, moderator))) {
        return c.json({ error: "You cannot comment on that" }, 404);
      }

      if (!moderator && user?.id) {
        const countFrom = async (ms: number) => {
          const r = await db.execute(
            sql`SELECT COUNT(*)::int AS n FROM comments
              WHERE author_id = ${user.id} AND created_at > ${new Date(Date.now() - ms)}`
          );
          const rowsValue = (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as {
            n: number;
          }[];
          return Number(rowsValue[0]?.n ?? 0);
        };
        if (
          (await countFrom(COMMENT_LIMIT.windowMs)) >=
            COMMENT_LIMIT.perWindow ||
          (await countFrom(86_400_000)) >= COMMENT_LIMIT.perDay
        ) {
          c.header("Retry-After", "600");
          return c.json({ error: "Too many comments in a row. Wait a few minutes." }, 429);
        }
      }

      let parent: typeof comments.$inferSelect | undefined;
      if (data.parentId) {
        [parent] = await repo(comments, { db }).filter({ id: data.parentId }).all();
        if (!parent) return c.json({ error: "The comment you are replying to does not exist" }, 404);
        // A thread cannot jump subjects: replying from another page would move
        // the conversation to a place where nobody wrote it.
        if (parent.subjectType !== data.subjectType || parent.subjectId !== data.subjectId) {
          return c.json({ error: "The parent belongs to another subject" }, 422);
        }
      }

      let depth: number;
      try {
        depth = depthOf(parent ?? null);
      } catch (e) {
        if (e instanceof CommentsError) return c.json({ error: e.message }, 422);
        throw e;
      }

      const rowValue = await repo(comments, { db }).create({
        subjectType: data.subjectType,
        subjectId: data.subjectId,
        parentId: data.parentId ?? null,
        depth,
        body: data.body,
        // Filter by sending to a queue, not rejecting: rejecting turns into a
        // game of typing with asterisks and tells the spammer whether it got through.
        status: initialStatus(data.body, BANNED),
        authorId: user?.id ?? null,
        // Copy of the name: if the user is deleted, the thread can still be read.
        authorName: visibleName(user),
      });

      return c.json({ data: rowValue }, 201);
    }
  );

  app.patch(
    "/:id",
    {
      id: "update-comment",
      permission: onTheComment("update"),
      summary: "Edit your comment",
      description:
        "Rewrites the text of a comment. Only its author, not even an admin (moderators hide, they do not rewrite): anyone else gets 403. If the new text has blocked words, a published comment goes back to the moderation queue.",
      access: "session",
      input: { params: ParamId, body: EditSchema },
      output: { schema: z.object({ data: CommentOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const [rowValue] = await repo(comments, { db })
        .filter({ id: c.req.param("id") })
        .all();
      if (!rowValue) return c.json({ error: "Not found" }, 404);

      // `update` belongs to the author and nobody else, not even the admin: a moderator who could
      // rewrite someone else's comment puts words in another's mouth.
      if (!(await h.can(rowValue))) return c.json({ error: "Forbidden" }, 403);

      const { body } = input.body as z.infer<typeof EditSchema>;

      /**
       * The filter also applies on EDIT. Otherwise something innocent is published and then
       * rewritten with what the filter would have sent to review: the
       * comment stays `published` with the new text. It only tightens — a
       * hidden or queued comment is not published by editing it—.
       */
      const status =
        rowValue.status === "published"
          ? initialStatus(body, BANNED)
          : (rowValue.status as typeof rowValue.status);

      const [updated] = await repo(comments, { db })
        .filter({ id: rowValue.id })
        .update({ body, status, updatedAt: new Date() });

      return c.json({ data: updated });
    }
  );

  /**
   * Changes the state without touching the text.
   *
   * It is the moderator's operation, separate from `PATCH` on purpose: hiding and
   * rewriting are different things and must not share a permission.
   */
  app.post(
    "/:id/moderate",
    {
      id: "moderate-comment",
      permission: onTheComment("moderate"),
      summary: "Set the moderation state of a comment",
      description:
        "Sets `status` (pending, published or hidden) on one comment without touching its text. Hiding keeps it in the thread with its text replaced, so its replies are not lost. Admin/editor (or an agent with comments:moderate).",
      access: "session",
      idempotent: true,
      input: { params: ParamId, body: ModerateSchema },
      output: { schema: z.object({ data: CommentOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      if (!(await h.can({}))) return c.json({ error: "Forbidden" }, 403);

      const { status } = input.body as z.infer<typeof ModerateSchema>;
      const [rowValue] = await repo(comments, { db })
        .filter({ id: c.req.param("id") })
        .update({ status, updatedAt: new Date() });

      if (!rowValue) return c.json({ error: "Not found" }, 404);
      return c.json({ data: rowValue });
    }
  );

  app.delete(
    "/:id",
    {
      id: "delete-comment",
      permission: onTheComment("delete"),
      summary: "Delete a comment",
      description:
        "Deletes a comment. If it has replies it is HIDDEN instead (`hidden: true`), so the replies keep their context. Its author, or admin/editor.",
      access: "session",
      input: { params: ParamId },
      output: {
        schema: z
          .object({
            ok: z.literal(true).optional(),
            data: CommentOut.optional(),
            hidden: z.literal(true).optional(),
          })
          .describe("`{ ok: true }` when deleted, `{ data, hidden: true }` when hidden"),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, _input, h) => {
      const [rowValue] = await repo(comments, { db })
        .filter({ id: c.req.param("id") })
        .all();
      if (!rowValue) return c.json({ error: "Not found" }, 404);
      if (!(await h.can(rowValue))) return c.json({ error: "Forbidden" }, 403);

      /**
       * Deleting a comment with replies HIDES it instead of deleting it.
       *
       * Deleting the row orphans its replies, which exist and have
       * content. The tree would promote them to the root — they are not lost — but
       * they would appear detached from the conversation that explains them.
       */
      const [response] = await repo(comments, { db }).filter({ parentId: rowValue.id }).all();
      if (response) {
        const [hidden] = await repo(comments, { db })
          .filter({ id: rowValue.id })
          .update({ status: "hidden", updatedAt: new Date() });
        return c.json({ data: hidden, hidden: true });
      }

      await repo(commentVotes, { db }).filter({ commentId: rowValue.id }).delete();
      await repo(comments, { db }).filter({ id: rowValue.id }).delete();
      return c.json({ ok: true });
    }
  );

  /**
   * Votes, changes the vote or withdraws it (`value: 0`).
   *
   * The counter is recalculated from `comment_votes` on every vote, not
   * incremented. Incrementing is faster and drifts as soon as two requests
   * arrive at once or one fails halfway; recalculating over the table that is already
   * indexed by comment costs one query and always gives the real number.
   */
  app.post(
    "/:id/vote",
    {
      id: "vote-comment",
      permission: onTheComment("vote"),
      summary: "Vote a comment",
      description:
        "Your vote on a published comment: 1 (up), -1 (down) or 0 (remove your vote). One vote per account; the score is recounted from the votes. Returns the new score and your vote. 404 if the comment does not exist or is not published. A signed-in person, or an agent with comments:vote.",
      access: "session",
      idempotent: true,
      input: { params: ParamId, body: VoteSchema },
      output: {
        schema: z.object({
          data: z.object({ id: z.string().optional(), score: z.number().int().optional() }),
          myVote: z.number().int(),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const user = (c.get("user") ?? null) as AuthzUser | null;
      /**
       * Without an `id` you cannot vote, and this is not a courtesy check.
       *
       * The unique index is `(comment_id, user_id)`. A user without an id would end up
       * writing the same key as any other user without an id, and the second vote
       * would collide with the index — or worse, if the column accepted empty, all
       * anonymous users would share a single vote.
       */
      if (!user?.id) return c.json({ error: "Forbidden" }, 403);
      // An agent votes only with a scope (`comments:vote`, `comments:*`): see the policy.
      if (!(await h.can({}))) return c.json({ error: "Forbidden" }, 403);
      const userId = user.id;

      const commentId = c.req.param("id");
      const [rowValue] = await repo(comments, { db }).filter({ id: commentId }).all();
      // You can vote only on what you can read: a queued or hidden comment has no
      // public text, and voting on it would serve to push it up before
      // anyone reviews it. And 404, not 403: it is not confirmed that it exists.
      if (!rowValue || rowValue.status !== "published") return c.json({ error: "Not found" }, 404);

      const { value } = input.body as z.infer<typeof VoteSchema>;

      if (value === 0) {
        await repo(commentVotes, { db }).filter({ commentId, userId }).delete();
      } else {
        /**
         * UPSERT and not "read and then create": two clicks in a row both arrived
         * with no previous vote, the second collided with the unique index and a 500 came out.
         * The index already prevented voting twice; this removes the error.
         */
        await db
          .insert(commentVotes)
          .values({ commentId, userId, value })
          .onConflictDoUpdate({
            target: [commentVotes.commentId, commentVotes.userId],
            set: { value },
          });
      }

      const votes = await repo(commentVotes, { db }).filter({ commentId }).all();
      const score = votes.reduce((n, v) => n + v.value, 0);
      const [updated] = await repo(comments, { db })
        .filter({ id: commentId })
        .update({ score });

      // Only the score: the whole row carried `authorId` and undid the
      // anonymity of threads; voting gave away the author's account
      // (an earlier audit).
      return c.json({ data: { id: updated?.id, score: updated?.score }, myVote: value });
    }
  );

  return app.ops;
}

export function createKonComments(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, commentsOperations(ctx), ctx);
}

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`commentsOperations`), with its OpenAPI, its MCP tool and its fine-grained scope
 * `kon:comments:<id>`.
 */
export const kon = defineKonSdk({
  id: KON_ID,
  name: "Comments",
  version: manifest.version,
  description:
    "Polymorphic comments with limited threads, one vote per user and moderation that " +
    "hides without breaking the thread",
  icon: "MessageSquare",
  mountPath: "/api/comments",
  operations: (ctx: KonContext) => commentsOperations(ctx),

  tables: konTables,

  // kon.json `admin` is the one list of admin views; the definition copies it.
  admin: {
    category: manifest.admin.category as "content",
    views: manifest.admin.views.map((v) => ({
      id: v.id,
      type: v.type as "grid" | "element",
      title: v.title,
      table: v.table,
      element: v.element,
      src: v.src,
    })),
  },

  dependencies: { kons: [], core: ["auth"] },

  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info(
        `💬 Comments ready — threads up to ${MAX_DEPTH} levels` +
          (BANNED.length ? `, ${BANNED.length} words sent to review` : "")
      );
    },
  },
});

export default kon;

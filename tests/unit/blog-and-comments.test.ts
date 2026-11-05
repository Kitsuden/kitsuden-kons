/**
 * The article and its thread speak the same language
 * ============================================================================
 *
 * ── THE STARTING POINT ─────────────────────────────────────────────────────
 *
 * `kon-comments` was complete —threads, votes with one vote per user
 * guaranteed by a unique index, moderation that hides without breaking the thread, a
 * moderation queue— and **nothing in the product called it**. Measured: `subjectType`
 * did not appear once outside the kon itself. Not the blog, not the panel, not the
 * page builder.
 *
 * It is the fifth time in this session that the same family appears —complete and
 * disconnected code— and the most expensive, because here it is a whole kon.
 *
 * ── THE THREE TRAPS THAT HAD TO BE CLOSED WHEN CONNECTING IT ───────────────
 *
 * **1. The string.** `subjectType` was validated only by shape (`^[a-z0-9_]+$`),
 * so `post`, `blog_post` and `blogpost` are all three accepted and open THREE
 * different threads on the same article. Whoever writes the page chooses one,
 * whoever writes the widget chooses another, and the comments do not appear where
 * expected. No error and nothing to search for: both sides "work".
 *
 * **2. The subject.** Nobody checked that it existed. Comments could be hung
 * on a draft's id, and since reading is public, the thread of an
 * unpublished article could be read from outside.
 *
 * **3. The count.** Without it, a front page of twenty articles that wants to say
 * "12 comments" makes twenty calls. And if it is resolved badly, a `0` when
 * `kon-comments` is not installed is worse than a `null`: it says "I looked and
 * there are none" without having looked.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isSubjectType,
  commentableSubject,
  COMMENTABLE_SUBJECTS,
  SUBJECT_TYPES,
} from "../../.kitsuden/packages/shared/src/comment-subjects";
import { withoutComments } from "../../.kitsuden/tests/unit/helpers/comments";

const ROOT = join(__dirname, "..", "..");
const COMMENTS = withoutComments(
  readFileSync(join(ROOT, "kons", "kon-comments", "index.ts"), "utf-8")
);
const BLOG = withoutComments(
  readFileSync(join(ROOT, "kons", "kon-blog", "src", "routes.ts"), "utf-8")
);
const BLOG_SCHEMA = readFileSync(
  join(ROOT, "kons", "kon-blog", "src", "schema.local.ts"),
  "utf-8"
);
const BLOCKS = readFileSync(join(ROOT, ".kitsuden", "packages", "admin", "src", "types", "blocks.ts"), "utf-8");

describe("the vocabulary lives in one place", () => {
  it("declares at least the blog article", () => {
    expect(SUBJECT_TYPES).toContain("blog_post");
    expect(isSubjectType("blog_post")).toBe(true);
  });

  it("tempting variants are NOT valid", () => {
    /**
     * This is the concrete case. If tomorrow someone "fixes" a bug by adding
     * `post` as an alias, this fails and forces them to see they are creating a
     * second thread on the same thing.
     */
    for (const invention of ["post", "blogpost", "blogPost", "posts", "articulo"]) {
      expect(isSubjectType(invention), `«${invention}» cannot be valid`).toBe(false);
    }
  });

  it("each subject says where it lives and when it is public", () => {
    for (const [type, subject] of Object.entries(COMMENTABLE_SUBJECTS)) {
      expect(subject.table, `${type} has no table`).toBeTruthy();
      expect(
        subject.statusColumn === null || subject.publicStatuses.length > 0,
        `${type} declares a status column but no public status: its thread ` +
          `would be invisible to everyone.`
      ).toBe(true);
    }
  });

  it("an unknown type returns null, it does not blow up", () => {
    expect(commentableSubject("lo_que_sea")).toBeNull();
  });
});

describe("kon-comments checks the subject", () => {
  it("the type is validated against the vocabulary, not just by its shape", () => {
    expect(
      /\.regex\(\/\^\[a-z0-9_\]\+\$\/,/.test(COMMENTS),
      "validating only the SHAPE lets `post`, `blog_post` and `blogpost` through as " +
        "three different subjects. It has to be checked against the vocabulary."
    ).toBe(false);

    expect(COMMENTS).toContain("isSubjectType");
  });

  it("the thread of something the visitor cannot see is not served", () => {
    // The routes are SDK operations: they are located by their declared `id`.
    const read = COMMENTS.slice(
      COMMENTS.indexOf('id: "get-thread"'),
      COMMENTS.indexOf('id: "create-comment"')
    );

    expect(read.length, "thread reading was not found").toBeGreaterThan(0);
    expect(
      read.includes("visibleSubject"),
      "reading is public: without checking the subject, the thread of a draft " +
        "is read from outside with just the id."
    ).toBe(true);
  });

  it("nor can you comment on something you cannot see", () => {
    const high = COMMENTS.slice(
      COMMENTS.indexOf('id: "create-comment"'),
      COMMENTS.indexOf('id: "update-comment"')
    );

    expect(high.length, "comment creation was not found").toBeGreaterThan(0);
    expect(
      high.includes("visibleSubject"),
      "if the comment is admitted, the thread is created and the next one that " +
        "asks for that id receives it: it is the other half of the same hole."
    ).toBe(true);
  });

  it("an impossible id is not a 500", () => {
    /**
     * ── THE FAILURE ───────────────────────────────────────────────────────
     *
     * `blog_posts.id` and `block_pages.id` are `uuid`. Requesting
     * `/api/comments/blog_post/x` puts "x" into the comparison and Postgres throws
     * `invalid input syntax for type uuid` (22P02). Uncaught it comes out as
     * **500**, measured against the real installation:
     *
     *     GET /api/comments/blog_post/x   →  500 Internal Server Error
     *
     * A mistyped URL is not a server failure. An impossible id identifies
     * nothing, so the correct response is that of an id that does not
     * exist: empty thread.
     *
     * It is the SAME class that was already closed in `Repository.find`, which is why
     * reusing its check is required: two versions of "this is a 22P02"
     * end up diverging, and the second is the one nobody remembers to update.
     */
    const fn = COMMENTS.slice(
      COMMENTS.indexOf("async function visibleSubject"),
      COMMENTS.indexOf("const CreateSchema")
    );

    expect(
      fn.includes("isInvalidInputSyntax"),
      "an id with an impossible shape has to read as \"does not exist\", not blow up."
    ).toBe(true);
  });

  it("the table name NEVER comes from the request", () => {
    /**
     * `visibleSubject` interpolates the table name into the SQL. It is the only thing in
     * this file to look at twice, so it is watched: the table
     * has to come from the vocabulary literal, which is only reached after
     * `isSubjectType`, and the id has to be parameterized.
     */
    const fn = COMMENTS.slice(
      COMMENTS.indexOf("async function visibleSubject"),
      COMMENTS.indexOf("const CreateSchema")
    );

    expect(fn.length, "`sujetoVisible` was not found").toBeGreaterThan(0);
    expect(fn).toContain("commentableSubject(subjectType)");
    expect(fn).toContain("if (!subject) return false;");

    for (const rawValue of ['sql.raw(`"${subjectType}', "sql.raw(subjectType", "${subjectId}`)"]) {
      expect(
        fn.includes(rawValue),
        `«${rawValue}» would put client text into the SQL without parameterizing.`
      ).toBe(false);
    }
  });
});

describe("the article says where its thread hangs", () => {
  it("all three post reads include it", () => {
    /**
     * List, by slug and by id. If tomorrow a fourth is added and forgotten,
     * that path returns a post without `comments` and the frontend that uses it
     * makes up the string — which is exactly the failure this comes to close.
     */
    expect(
      (BLOG.match(/withComments\(/g) ?? []).length,
      "post reads missing `conComentarios`"
    ).toBeGreaterThanOrEqual(3);
  });

  it("carries what the frontend needs, including the already-mounted route", () => {
    const fn = BLOG.slice(
      BLOG.indexOf("function withComments"),
      BLOG.indexOf("function withComments") + 1200
    );

    expect(fn.length, "`conComentarios` was not found").toBeGreaterThan(0);
    for (const key of ["subjectType", "subjectId", "endpoint", "enabled", "count"]) {
      expect(fn, `missing «${key}» in the response`).toContain(`${key}:`);
    }
  });

  it("without the comments kon the count is `null`, not zero", () => {
    /**
     * Zero means "I looked and there are none". Saying it without having looked makes
     * someone spend half an hour searching for why their comment does not count.
     */
    expect(BLOG).toContain("counts ? (counts.get(post.id) ?? 0) : null");
  });

  it("the list count is ONE aggregate, not one per post", () => {
    const list = BLOG.slice(
      BLOG.indexOf("const response = {") - 900,
      BLOG.indexOf("const response = {")
    );

    expect(
      list.includes("commentCounts("),
      "the front page count has to be resolved at once for the whole page"
    ).toBe(true);

    expect(
      /docs\.map\([^)]*\)\s*=>\s*[^)]*await commentCounts/.test(BLOG),
      "one count per post is twenty queries to render a front page"
    ).toBe(false);
  });

  it("the thread can be closed per article, and that field is stored", () => {
    expect(BLOG_SCHEMA).toContain('commentsEnabled: boolean("comments_enabled")');

    /**
     * Zod silently DISCARDS what it does not declare, and the creation enumerates column by
     * column. So it was missing in TWO different places and neither would
     * have given an error: the post was saved with comments open.
     * It is what happened with `tags` versus `tagIds`.
     */
    expect(BLOG, "the write schema has to declare it").toContain(
      "commentsEnabled: z.boolean().optional()"
    );
    expect(BLOG, "and the creation has to pass it to the insert").toContain(
      "commentsEnabled: body.commentsEnabled"
    );
  });

  it("the `enabled` of a post predating the column is \"open\"", () => {
    /**
     * `!== false` and not `=== true`: a row created before the migration carries
     * `undefined`, and with `=== true` all old articles would appear with
     * the thread closed without anyone having decided it.
     */
    expect(BLOG).toContain("post.commentsEnabled !== false");
  });
});

describe("the page builder can place a thread", () => {
  it("the block exists", () => {
    expect(BLOCKS).toContain('type: "comments"');
    expect(BLOCKS).toContain('| "comments"');
  });

  it("the subject type is a dropdown, not free text", () => {
    const block = BLOCKS.slice(
      BLOCKS.indexOf('type: "comments"'),
      BLOCKS.indexOf('type: "tier-list"')
    );

    expect(block.length, "the comments block was not found").toBeGreaterThan(0);

    const field = block.slice(block.indexOf('key: "subjectType"'));
    expect(
      field.slice(0, 200).includes('type: "select"'),
      "with free text we are back at the start: \"post\" and \"blog_post\" open two " +
        "different threads on the same article, without giving any error."
    ).toBe(true);
  });

  it("the dropdown options are those of the vocabulary", () => {
    const block = BLOCKS.slice(
      BLOCKS.indexOf('type: "comments"'),
      BLOCKS.indexOf('type: "tier-list"')
    );

    for (const type of SUBJECT_TYPES) {
      expect(
        block.includes(`value: "${type}"`),
        `«${type}» is in the vocabulary and the block does not offer it: it was declared as ` +
          `a commentable subject that nobody can choose from the panel.`
      ).toBe(true);
    }
  });
});

describe("an array is not passed as a single parameter", () => {
  /**
   * ── THE FAILURE, AND HOW IT WAS DISCOVERED ─────────────────────────────────
   *
   * In a drizzle `sql` template, `= ANY(${array})` sends the whole array
   * as ONE scalar parameter. Postgres receives `published` where it expects an
   * array literal and responds:
   *
   *     malformed array literal: "published"
   *
   * It typechecks, reads reasonably, and passed all 1857 tests. It blew up with a 500
   * the public read of ALL threads as soon as there was a real post to
   * query — seen by inserting two rows against the real installation, not
   * before.
   *
   * And there were two more cases already in production, in the vector search, that only
   * fail if someone uses the filter by fields or by datasets. They had been there without
   * anyone touching them.
   *
   * The correct form is `inArray(...)`, or `sql.join` with one parameter per
   * element.
   */
  const SOURCES = [
    join(ROOT, "kons", "kon-comments", "index.ts"),
    join(ROOT, "kons", "kon-blog", "src", "routes.ts"),
    join(ROOT, ".kitsuden", "packages", "core", "vector-search", "routes.ts"),
  ];

  for (const route of SOURCES) {
    it(`${route.split(/[\/]/).slice(-2).join("/")} does not interpolate an array into ANY()`, () => {
      const source = withoutComments(readFileSync(route, "utf-8"));

      const culprits = [...source.matchAll(/=\s*ANY\(\$\{[^}]+\}\)/g)].map((m) => m[0]);

      expect(
        culprits,
        `«${culprits.join(", ")}» sends the array as a scalar parameter and ` +
          `Postgres responds "malformed array literal". It does not fail when writing it ` +
          `or when typechecking: it fails as soon as there is data. Use \`inArray(col, xs)\` ` +
          `o \`sql.join(xs.map((x) => sql\`\${x}\`), sql\`, \`)\`.`
      ).toEqual([]);
    });
  }
});

describe("the moderation queue is usable", () => {
  /**
   * The view's SOURCES (Svelte + TS in admin-src/), not the built `admin/moderation.js`: the
   * bundle is minified, so its names say nothing. `tallao/` is the synced copy of the UI kit,
   * not this view's code.
   */
  const ADMIN_SRC = join(ROOT, "kons", "kon-comments", "admin-src");
  const MODERATION = readdirSync(ADMIN_SRC, { recursive: true, encoding: "utf-8" })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.startsWith("tallao/") && /\.(svelte|ts)$/.test(file))
    .map((file) => readFileSync(join(ADMIN_SRC, file), "utf-8"))
    .join("\n");

  it("each comment says which content it comes from", () => {
    /**
     * The queue returned raw rows, so whoever moderates saw a body
     * next to a uuid. **The same text can be a legitimate reply in one
     * thread and spam in another**, so without this moderating is guessing. It is the
     * "In response to" column of WordPress.
     */
    expect(COMMENTS).toContain("withSubjects(");
    expect(MODERATION).toContain("row.subject");
    expect(MODERATION).toContain("row.subject.title");
  });

  it("resolving the subject is not N+1", () => {
    /**
     * One query per comment on the screen that is opened precisely when there are
     * MANY. It is grouped by type: one query per subject type, not per row.
     */
    const fn = COMMENTS.slice(
      COMMENTS.indexOf("async function withSubjects"),
      COMMENTS.indexOf("async function countsByStatus")
    );

    expect(fn.length, "`conSujetos` was not found").toBeGreaterThan(0);
    expect(fn).toContain("byType");
    expect(
      /for \(const f of rows\)[\s\S]{0,400}await db\.execute/.test(fn),
      "there is an `await` inside the comments loop: that is one query per row."
    ).toBe(false);
  });

  it("the queue has a cap even if none is requested", () => {
    /**
     * `.all()` on a table that grows is a query that gets worse on its own until
     * one day it takes down the screen — and precisely the screen that is visited
     * when there is an avalanche.
     */
    const queue = COMMENTS.slice(
      COMMENTS.indexOf('id: "moderation-queue"'),
      COMMENTS.indexOf('id: "moderate-in-bulk"')
    );

    expect(queue.length, "the queue was not found").toBeGreaterThan(0);
    expect(queue).toContain(".limit(");
    expect(
      /Math\.min\(/.test(queue),
      "a `?limit=999999` cannot become an uncontrolled query."
    ).toBe(true);
  });

  it("the batch reports what it really touched", () => {
    const bulk = COMMENTS.slice(
      COMMENTS.indexOf('id: "moderate-in-bulk"'),
      COMMENTS.indexOf('id: "get-thread"')
    );

    expect(bulk.length, "the batch was not found").toBeGreaterThan(0);

    /**
     * Returning `ids.length` would say "20 moderated" when it was 18 because two no longer
     * existed, and nobody would find out the list was out of date.
     */
    expect(
      /moderados: ids\.length/.test(bulk),
      "the number has to come from what the UPDATE returned, not from what was requested."
    ).toBe(false);
    expect(bulk).toContain("updatedOnes.length");
  });

  it("both moderation routes require the permission", () => {
    // SDK operations: the permission is declared (`onTheComment("moderate")`)
    // and the handler checks it with `h.can(`.
    for (const [route, next] of [
      ['id: "moderation-queue"', 'id: "moderate-in-bulk"'],
      ['id: "moderate-in-bulk"', 'id: "get-thread"'],
    ]) {
      const i = COMMENTS.indexOf(route);
      expect(i, `could not find ${route}`).toBeGreaterThan(-1);
      const op = COMMENTS.slice(i, COMMENTS.indexOf(next));
      expect(
        op.includes('"moderate"') && op.includes("h.can("),
        `${route} must consult the policy: moderating is not a public read.`
      ).toBe(true);
    }
  });

  it("the screen does not render user text as HTML", () => {
    /**
     * The body and the name are written by anyone who can comment, and this
     * screen is opened by someone with an admin session. An `innerHTML` here is an
     * XSS with the worst possible audience.
     */
    expect(MODERATION.length, "the view's sources were not found").toBeGreaterThan(0);
    expect(
      /\{@html\b/.test(MODERATION),
      "Svelte escapes `{text}`; `{@html}` renders it as HTML."
    ).toBe(false);
    expect(/innerHTML/.test(MODERATION), "no `innerHTML` in the view: Svelte draws the markup.").toBe(false);
  });
});

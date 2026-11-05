import { createId } from "@paralleldrive/cuid2";
import { pgTable, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";

import type { CommentStatus } from "./comments.engine.js";

/**
 * Comments — polymorphic comments with threads, votes and moderation
 * ============================================================================
 *
 * TWO tables, and the second exists for a reason that is rarely seen until it fails.
 *
 * `comments.score` is DENORMALIZED: it is a counter maintained by hand.
 * It could be computed with a COUNT over `comment_votes` on every read, and it would be
 * always correct — but a thread of 200 comments would be 200 aggregates to draw
 * a page requested a thousand times a day.
 *
 * The price is that the counter can drift. This is accepted in exchange for
 * `comment_votes` being the source of truth and the counter being RECALCULABLE from
 * it. A denormalized counter with no way to rebuild it would be a mistake;
 * this one is fixed with a query.
 */
export const comments = pgTable(
  "comments",
  {
    id: text("id").primaryKey().$defaultFn(createId),

    /**
     * What it hangs from. Polymorphic: `wiki_page`, `game_entity`, `build`, `post`…
     *
     * No foreign key on purpose: a comments table for each commentable
     * thing would repeat threads, votes and moderation five times.
     */
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),

    parentId: text("parent_id"),
    /** Calculated on write. Deducing it on read is N queries per comment. */
    depth: integer("depth").default(0).notNull(),

    body: text("body").notNull(),
    status: text("status").$type<CommentStatus>().default("published").notNull(),

    /** Denormalized. `comment_votes` is the source of truth. */
    score: integer("score").default(0).notNull(),

    authorId: text("author_id"),
    /** Copy of the name at publish time: if the user is deleted, the thread is still readable. */
    authorName: text("author_name"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The index that matters: "give me this page's comments".
    index("comments_subject_idx").on(t.subjectType, t.subjectId, t.status),
    index("comments_parent_idx").on(t.parentId),
    index("comments_author_idx").on(t.authorId),
  ]
);

export const commentVotes = pgTable(
  "comment_votes",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    commentId: text("comment_id").notNull(),
    userId: text("user_id").notNull(),
    /** +1 or -1. There is no 0: removing the vote deletes the row. */
    value: integer("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // ONE vote per user and comment. It is the reason this table exists:
    // without it, the counter can be raised a thousand times from the same account.
    uniqueIndex("comment_votes_unique_idx").on(t.commentId, t.userId),
    index("comment_votes_comment_idx").on(t.commentId),
  ]
);

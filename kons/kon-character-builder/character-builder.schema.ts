import { createId } from "@paralleldrive/cuid2";
import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
  integer,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { Build, BuilderDefinition } from "./character-builder.engine.js";

/**
 * Builder — per-game definitions and user builds
 * ============================================================================
 *
 * Two tables with different owners, and the distinction is the RLS classification:
 *
 *   · The DEFINITION (which slots, which options, which formulas the game has) is
 *     EDITORIAL content: the site team publishes it and everyone
 *     reads it. No ownership column — there is nothing personal to isolate.
 *   · The BUILD is PERSONAL: "my Hunter build". It carries `owner_id` and is in
 *     rls-owned-tables.sql — your private build does not show up in other people's queries.
 */

export const builderDefinitions = pgTable(
  "builder_definitions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    /** Public slug: `/builder/throne-liberty`. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /**
     * The whole definition as a document. It is a DOCUMENT and not columns
     * because its shape is validated by `compileBuilder` on publish — the same pattern
     * as Broadcast profiles: the structure belongs to the domain, not to the SQL.
     */
    definition: jsonb("definition").$type<BuilderDefinition>().notNull(),
    /** A broken builder is not served: it is published only if it compiled. */
    published: text("published").default("draft").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("builder_definitions_slug_idx").on(t.slug)]
);

export const builderBuilds = pgTable(
  "builder_builds",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    builderId: text("builder_id").notNull(),
    name: text("name").default("My build").notNull(),
    build: jsonb("build").$type<Build>().notNull(),
    /** The shareable code, precomputed: it is read a thousand times more than it is written. */
    code: text("code").notNull(),
    /** `private` | `unlisted` | `public`. A build is shared when its owner wants. */
    visibility: text("visibility").default("private").notNull(),
    ownerId: text("owner_id"),
    /**
     * Whose build it is: the option in the slot the definition marks as
     * subject (`subjectSlot`). It is stored on write because the gallery is read
     * by subject ("all of Infergon's builds") and filtering inside the JSON on
     * every visit is a table scan.
     */
    subject: text("subject"),
    /**
     * Votes, counted here as well as in their table. Same deal as `code`:
     * the list is SORTED by votes on every visit and counting rows to sort
     * does not scale. The table rules; this column is its summary.
     */
    votes: integer("votes").default(0).notNull(),
    /** When it was made public. A private build has no publication date. */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("builder_builds_owner_idx").on(t.ownerId, t.builderId),
    index("builder_builds_public_idx").on(t.builderId, t.subject, t.votes),
  ]
);

/**
 * One vote per person and build.
 *
 * The primary key is the pair: voting twice does not add two, and removing
 * the vote is deleting the row. No voting without a session — a counter anyone can
 * raise by reloading orders nothing.
 */
export const builderBuildVotes = pgTable(
  "builder_build_votes",
  {
    buildId: text("build_id").notNull(),
    voterId: text("voter_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.buildId, t.voterId] })]
);

export type BuilderDefinitionRow = typeof builderDefinitions.$inferSelect;
export type BuilderBuildRow = typeof builderBuilds.$inferSelect;
export type BuilderBuildVoteRow = typeof builderBuildVotes.$inferSelect;

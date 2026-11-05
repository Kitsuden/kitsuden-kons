import { createId } from "@paralleldrive/cuid2";
import { pgTable, text, timestamp, integer, index, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Wiki — pages, immutable revisions and indexed links
 * ============================================================================
 *
 * The page is a POINTER; the content lives in the revisions. Storing the
 * "current" content in the page and the history separately is the recipe for them to
 * diverge — here the current revision IS one more revision, pointed to by number.
 *
 * `wiki_revisions.author_id` is AUTHORSHIP in a collaborative tool, not
 * personal ownership: a wiki that isolated revisions by author would have no
 * visible history, which is its only reason for being. Classified as
 * COLLABORATIVE in the RLS coverage test.
 */

/**
 * A wiki is a SPACE with its own subdomain: `<slug>.<domain>`.
 *
 * It exists because pages were flat and their slug unique across the whole
 * installation: you could not have "armas" in two games, nor serve each wiki at
 * its own address. The rule for which label is valid as a subdomain does NOT live here:
 * it is in `@kitsuden/shared` (sitio-publico), because the frontend has to
 * resolve the host with exactly the same one.
 */
export const wikis = pgTable(
  "wikis",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    /** Subdomain label. It is the wiki's identity. */
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").default("").notNull(),
    /** Game it belongs to, if any. No FK: `games` belongs to kon-games. */
    gameId: uuid("game_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("wikis_slug_idx").on(t.slug), index("wikis_game_idx").on(t.gameId)]
);

export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    /** Wiki it belongs to. The slug is unique WITHIN it, not global. */
    wikiId: text("wiki_id").notNull(),
    /** The slug is the IDENTITY within its wiki: two titles that normalize the same are the same page. */
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    /** Number of the current revision. */
    currentRevision: integer("current_revision").default(0).notNull(),
    /** `open` = any session edits; `locked` = admin only. Per page. */
    protection: text("protection").default("open").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("wiki_pages_wiki_slug_idx").on(t.wikiId, t.slug)]
);

export const wikiRevisions = pgTable(
  "wiki_revisions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    pageId: text("page_id").notNull(),
    /** 1-based, monotonic per page. The history only grows. */
    number: integer("number").notNull(),
    content: text("content").notNull(),
    /** "added drops table". Mandatory culturally, not by SQL. */
    summary: text("summary").default("").notNull(),
    authorId: text("author_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("wiki_revisions_page_number_idx").on(t.pageId, t.number)]
);

/**
 * Index of `[[wiki]]` links, rebuilt on saving each revision.
 *
 * It is what makes the wiki question par excellence O(1) — "what points here?" —
 * and also its inverse: links to pages that do not exist yet are the list
 * of "requested pages".
 */
export const wikiLinks = pgTable(
  "wiki_links",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    /** Links do not cross wikis: `[[Armas]]` in a wiki is ITS "armas" page. */
    wikiId: text("wiki_id").notNull(),
    /** Slug of the page that contains the link. */
    fromSlug: text("from_slug").notNull(),
    /** Slug of the target. It may not exist yet: that IS the data. */
    toSlug: text("to_slug").notNull(),
  },
  (t) => [
    index("wiki_links_wiki_to_idx").on(t.wikiId, t.toSlug),
    uniqueIndex("wiki_links_wiki_pair_idx").on(t.wikiId, t.fromSlug, t.toSlug),
  ]
);

export type Wiki = typeof wikis.$inferSelect;
export type WikiPage = typeof wikiPages.$inferSelect;
export type WikiRevision = typeof wikiRevisions.$inferSelect;

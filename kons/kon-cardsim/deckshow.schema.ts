import type { GoldfishQuery } from "./cardsim.goldfish.js";
import { createId } from "@paralleldrive/cuid2";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * DeckShow — deck showcase
 * ============================================================================
 *
 * Two tables, and not a single one for cards or decks.
 *
 * That is the important thing about the design: the catalog lives in `cardsim_cards` and the
 * lists in `cardsim_decks`. A showcase deck **is** a real deck,
 * so it can be played without exporting anything. Duplicating the catalog here would have
 * created two truths about what a card is, and the second always ages.
 *
 * What does belong to the showcase: who published it, how they tell it, whether it is
 * featured and whether it is visible. That has no place in a list of 60 ids.
 */

export const deckshowEntries = pgTable(
  "deckshow_entries",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    /** The real deck, in `cardsim_decks`. */
    deckId: text("deck_id").notNull(),
    /** Denormalized: the gallery filters by game on every listing. */
    gameId: text("game_id").notNull(),
    /** Public URL. Stable even if the title changes. */
    slug: text("slug").notNull(),

    title: text("title").notNull(),
    /** The author's text: why the deck does what it does. */
    description: text("description"),
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),

    /**
     * Goldfish queries saved WITH the deck.
     *
     * It is what separates a showcase from a list of cards: the author leaves written
     * what to look at ("how many times do I have ink and a 3-cost
     * creature on turn 3?"), and whoever visits runs it themselves instead of
     * trusting a screenshot.
     */
    goldfishQueries: jsonb("goldfish_queries").$type<GoldfishQuery[]>().default([]).notNull(),

    authorId: text("author_id"),

    /**
     * `published` appears in the gallery · `unlisted` only with the link ·
     * `hidden` was hidden by moderation and its author sees why.
     */
    status: text("status").default("published").notNull(),
    /** Reason for hiding. Hiding without saying why is what annoys people. */
    hiddenReason: text("hidden_reason"),

    /** Featured by whoever runs the site. It is curation. */
    featured: boolean("featured").default(false).notNull(),
    featuredAt: timestamp("featured_at", { withTimezone: true }),

    views: integer("views").default(0).notNull(),
    likes: integer("likes").default(0).notNull(),

    publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("deckshow_entries_slug_idx").on(t.slug),
    // The gallery: a game's published decks, featured first.
    index("deckshow_entries_gallery_idx").on(t.gameId, t.status, t.featured, t.publishedAt),
    index("deckshow_entries_author_idx").on(t.authorId),
    // A deck is shown once: without this, republishing creates duplicates.
    uniqueIndex("deckshow_entries_deck_idx").on(t.deckId),
  ]
);

/**
 * One "like" per person and entry.
 *
 * It exists as a table — and not as a simple counter — because without it you cannot
 * answer "have I liked it?", and without that answer the button cannot be drawn
 * nor can voting twice be prevented. The `deckshow_entries` counter is the fast
 * copy for ordering the gallery.
 */
export const deckshowLikes = pgTable(
  "deckshow_likes",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    entryId: text("entry_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("deckshow_likes_entry_user_idx").on(t.entryId, t.userId)]
);

export type DeckshowEntry = typeof deckshowEntries.$inferSelect;
export type DeckshowLike = typeof deckshowLikes.$inferSelect;

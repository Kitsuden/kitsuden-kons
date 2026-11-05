import { createId } from "@paralleldrive/cuid2";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * The hand generator (HandLab) — feed it a card dataset and it deals hands
 * ============================================================================
 *
 * Three tables and not a single idea of a game: no zones, no turns, no
 * sessions, no opponent. A dataset is **cards + four rules** (how many cards
 * in hand, how many in the deck, how many copies per card), and with that you
 * can already deal hands and get statistics.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY ITS OWN TABLES AND NOT CARDSIM'S GAMES
 *
 * Because the question "what hands does this deck make?" does not need a game.
 * To use a cardsim game you have to describe zones, phases and defeat
 * conditions — half an hour of work before seeing the first hand. Here you
 * upload a JSON and that's it.
 *
 * What is NOT duplicated is the engine: dealing and counting are cardsim's
 * functions, fed with a minimal definition synthesized on the fly. It was a kon
 * of its own and now lives inside CardSim, below `/hands`: the hand generator
 * for quick testing, the simulator when you want to play the whole game.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const handlabDatasets = pgTable(
  "handlab_datasets",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Where the cards came from. A dataset without provenance cannot be audited. */
    source: text("source"),

    /** Cards drawn at the start. It is THE generator rule. */
    handSize: integer("hand_size").default(7).notNull(),
    deckMin: integer("deck_min").default(1).notNull(),
    deckMax: integer("deck_max").default(250).notNull(),
    maxCopies: integer("max_copies").default(4).notNull(),
    /**
     * Per-card exceptions: `{"legendaria": 1}`. It is what lets Hearthstone
     * (2 copies, but 1 if legendary) be described without code.
     */
    copyLimits: jsonb("copy_limits").$type<Record<string, number>>().default({}).notNull(),

    cardCount: integer("card_count").default(0).notNull(),
    ownerId: text("owner_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("handlab_datasets_slug_idx").on(t.slug)]
);

export const handlabCards = pgTable(
  "handlab_cards",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    datasetId: text("dataset_id").notNull(),
    /** Stable id within the dataset: it is what decks reference. */
    cardId: text("card_id").notNull(),
    name: text("name").notNull(),
    imageUrl: text("image_url"),
    /** Everything else, as is: cost, type, color… Filters read from here. */
    data: jsonb("data").$type<Record<string, unknown>>().default({}).notNull(),
  },
  (t) => [
    uniqueIndex("handlab_cards_dataset_card_idx").on(t.datasetId, t.cardId),
    index("handlab_cards_name_idx").on(t.datasetId, t.name),
  ]
);

export const handlabDecks = pgTable(
  "handlab_decks",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    datasetId: text("dataset_id").notNull(),
    name: text("name").default("Deck").notNull(),
    /** List of `cardId`; repeated = copies. */
    cards: jsonb("cards").$type<string[]>().notNull(),
    ownerId: text("owner_id"),
    /** To share the deck by link without exposing its internal id. */
    shareId: text("share_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("handlab_decks_owner_idx").on(t.ownerId, t.datasetId),
    uniqueIndex("handlab_decks_share_idx").on(t.shareId),
  ]
);

export type HandlabDataset = typeof handlabDatasets.$inferSelect;
export type HandlabCard = typeof handlabCards.$inferSelect;
export type HandlabDeck = typeof handlabDecks.$inferSelect;

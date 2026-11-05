import { createId } from "@paralleldrive/cuid2";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { CompSlot, SetRules } from "./autobattler.types.js";

/**
 * Autobattler — sets, entities and compositions
 * ============================================================================
 *
 * Three tables, and the middle one is ONE on purpose.
 *
 * Units, traits, items and augments are four different things in the game
 * but the SAME thing to the database: `(set, id, name, a document)`. Separating them
 * would give four tables with the same columns, four importers and four identical
 * searchers — and the most common query ("give me the whole set to
 * draw the editor") would be a UNION of four. They are told apart with `kind`, just
 * as `kon-tierlist` tells a template from a personal list.
 */

export const autobattlerSets = pgTable(
  "autobattler_sets",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** `tft`, `underlords`… The engine is the same; the game changes the rules. */
    game: text("game").default("tft").notNull(),
    /** Board, items per unit, team size per level, augments. */
    rules: jsonb("rules").$type<SetRules>().notNull(),
    source: text("source"),
    /** Patch the data came from. A set without a patch cannot be dated. */
    patch: text("patch"),
    /** Only one per game is current: it is the one seen by whoever does not ask for another. */
    current: boolean("current").default(false).notNull(),
    ownerId: text("owner_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("autobattler_sets_slug_idx").on(t.slug),
    index("autobattler_sets_game_idx").on(t.game, t.current),
  ]
);

export const autobattlerEntities = pgTable(
  "autobattler_entities",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    setId: text("set_id").notNull(),
    /** `unit` · `trait` · `item` · `augment`. */
    kind: text("kind").notNull(),
    /** Id within the set (Riot's `apiName`). It is what comps reference. */
    entityId: text("entity_id").notNull(),
    name: text("name").notNull(),
    icon: text("icon"),
    /** Cost, traits, thresholds, recipe… whatever each `kind` needs. */
    data: jsonb("data").$type<Record<string, unknown>>().default({}).notNull(),
  },
  (t) => [
    uniqueIndex("autobattler_entities_unique_idx").on(t.setId, t.kind, t.entityId),
    index("autobattler_entities_kind_idx").on(t.setId, t.kind),
    index("autobattler_entities_name_idx").on(t.setId, t.name),
  ]
);

export const autobattlerComps = pgTable(
  "autobattler_comps",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    setId: text("set_id").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    /** The placed units, with their items and board position. */
    slots: jsonb("slots").$type<CompSlot[]>().notNull(),
    level: integer("level"),
    augments: jsonb("augments").$type<string[]>().default([]).notNull(),
    /** Difficulty, play style, the author's tags. */
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),

    /**
     * Carousel priority: components in the order they are picked.
     *
     * An ORDERED list because the order is the data. It is not deduced from the board:
     * it depends on which unit carries the item and which arrives first in the
     * game, which is the judgment of whoever writes the guide.
     */
    carousel: jsonb("carousel").$type<string[]>().default([]).notNull(),

    /**
     * The tier list tier (`S`, `A`, `B`…). It is an editorial OPINION and
     * that is why it lives here and not in `stats`: it is set by hand and does not come from any
     * calculation.
     */
    tier: text("tier"),
    /**
     * Meta statistics, if any: average placement, top 4 rate,
     * sample games. They are loose in a document because **they are not
     * computed here** — they come from outside (your own game ingestion), and
     * pretending the kon produces them would be lying about their provenance.
     */
    stats: jsonb("stats").$type<Record<string, number> | null>(),
    /** Where those figures came from. Without this they cannot be audited. */
    statsSource: text("stats_source"),
    statsUpdatedAt: timestamp("stats_updated_at", { withTimezone: true }),
    /** Gold cost to build it, precomputed so it can be sorted by. */
    goldCost: real("gold_cost"),

    authorId: text("author_id"),
    status: text("status").default("published").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("autobattler_comps_slug_idx").on(t.slug),
    index("autobattler_comps_list_idx").on(t.setId, t.status, t.tier),
    index("autobattler_comps_author_idx").on(t.authorId),
  ]
);

export type AutobattlerSet = typeof autobattlerSets.$inferSelect;
export type AutobattlerEntity = typeof autobattlerEntities.$inferSelect;
export type AutobattlerComp = typeof autobattlerComps.$inferSelect;

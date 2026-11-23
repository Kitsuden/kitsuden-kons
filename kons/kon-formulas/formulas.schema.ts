import { createId } from "@paralleldrive/cuid2";
import { index, pgTable, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

import type { StatDefinition } from "./formula.engine.js";

/**
 * Formulas — stored stat systems
 * ============================================================================
 * A "system" is the set of formulas of a game ("how damage is
 * calculated in X"). Editorial: published by the site, consumed by builders and
 * calculators. It is validated with `compileSystem` on save — a system with
 * cycles or broken formulas does not reach the table.
 */

export const formulaSystems = pgTable(
  "formula_systems",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** The catalog game it belongs to: its slug in kon-games. The same column in every gaming kon. */
    game: text("game"),
    stats: jsonb("stats").$type<StatDefinition[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("formula_systems_slug_idx").on(t.slug),
    index("formula_systems_game_idx").on(t.game),
  ]
);

export type FormulaSystem = typeof formulaSystems.$inferSelect;

import { createId } from "@paralleldrive/cuid2";
import { pgTable, text, timestamp, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";

import type { Tier, TierItem } from "./tierlist.engine.js";

/**
 * TierList — editorial templates and personal lists
 * ============================================================================
 *
 * ONE table, two natures distinguished by `kind`. They could be two tables,
 * but they share all the columns and 90% of the queries ("give me this tier
 * list") do not distinguish — separating them would force a UNION on every read.
 *
 *   · `template` — the one the site publishes. No owner, public.
 *   · `personal` — the one a reader makes (TierMaker). With `owner_id`, and therefore
 *     the table is in rls-owned-tables.sql: your private tier list does not appear
 *     in anyone else's queries.
 *
 * `owner_id` NULL on templates is correct and deliberate: this project's
 * RLS policy fails OPEN with an empty context, and a template must be
 * readable without a session from the public page.
 */
export const tierLists = pgTable(
  "tier_lists",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    /** `template` (editorial) | `personal` (a reader's). */
    kind: text("kind").default("template").notNull(),
    /** Only templates have a public slug. */
    slug: text("slug"),
    title: text("title").notNull(),

    tiers: jsonb("tiers").$type<Tier[]>().notNull(),
    items: jsonb("items").$type<TierItem[]>().notNull(),
    /** `itemId` → `tierId`. Whatever is absent is unranked. */
    placement: jsonb("placement").$type<Record<string, string>>().default({}).notNull(),

    /**
     * Dataset the catalog is synced from, if any.
     *
     * It is what makes a new character appear unranked instead of being
     * forgotten — the classic failure of hand-maintained tier lists.
     */
    catalogDatasetId: text("catalog_dataset_id"),

    /** Template a personal list came from. */
    templateId: text("template_id"),
    /** Patch or version: "5.4". Feeds the comparison between versions. */
    version: text("version"),

    /**
     * «Ordered by the team, not by the loader». With `true`, `upsertTierLists`
     * (the content loader) does NOT overwrite it: it respects the chips and
     * placement made by hand in the panel. It is the editorial override over
     * the computed tier list — reversible: when set back to `false`, the next
     * load brings back the computed one.
     */
    manual: boolean("manual").default(false).notNull(),

    ownerId: text("owner_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("tier_lists_slug_idx").on(t.slug),
    index("tier_lists_owner_idx").on(t.ownerId, t.kind),
  ]
);

export type TierListRow = typeof tierLists.$inferSelect;

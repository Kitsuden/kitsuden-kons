/**
 * Kitsuden — Analytics: schema
 * ============================================================================
 *
 * ONE table, and on purpose: **views per subject and per day**.
 *
 * ── WHAT IS NOT STORED, AND WHY ────────────────────────────────────────────
 *
 * No IP, no cookie, no session identifier, no browser agent.
 * There is no row per visit: there is a COUNTER that goes up. With that, nobody's
 * path can be reconstructed, which is exactly what we do not want to store,
 * and no consent banner is needed.
 *
 * The price is in the name: this counts **views**, not "unique visitors".
 * A unique cannot be known without identifying the viewer, so no
 * unique figure is published — the project rule is that a number that is
 * shown is a number that was counted.
 *
 * ── WHY `subject_type` IS TEXT AND NOT AN ENUM ─────────────────────────────
 *
 * A Postgres enum forces a migration for every new thing to be
 * measured (tournaments, decks, streamers…) and global enums have already clashed
 * between kons. The valid list lives in `MEASURABLE_SUBJECTS`, in the code, where
 * it is read and changed without touching the database.
 */

import {
  pgTable,
  uuid,
  varchar,
  integer,
  date,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * What can be counted. Adding one here is all that is needed: the table does not
 * change.
 */
export const MEASURABLE_SUBJECTS = [
  "game",
  "blog_post",
  "wiki_page",
  /**
   * The whole WIKI, not one of its pages.
   *
   * Adding up its pages' views would give the same number, but it would require
   * knowing which wiki each page belongs to when asking, and that is as many reads
   * as pages. A viewed wiki is a subject in its own right: it is what
   * orders the front page's "most viewed wikis".
   */
  "wiki",
  "dataset",
  "tournament",
  "streamer",
] as const;

export type MeasurableSubject = (typeof MEASURABLE_SUBJECTS)[number];

export const analyticsViews = pgTable(
  "analytics_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `game`, `blog_post`, `wiki_page`… Ver `MEASURABLE_SUBJECTS`. */
    subjectType: varchar("subject_type", { length: 40 }).notNull(),
    /** Id of the viewed row. There is no FK: each subject lives in its own kon. */
    subjectId: uuid("subject_id").notNull(),
    /** The day, in the server's time zone. The time is not stored: it is not needed. */
    day: date("day").notNull(),
    views: integer("views").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    /** The natural key: one row per subject and day, and the counter goes up with UPSERT. */
    uniqueIndex("analytics_views_subject_day_idx").on(t.subjectType, t.subjectId, t.day),
    /** For "the most viewed of the last N days", which is the front page query. */
    index("analytics_views_type_day_idx").on(t.subjectType, t.day),
  ]
);

export type AnalyticsView = typeof analyticsViews.$inferSelect;
export type NewAnalyticsView = typeof analyticsViews.$inferInsert;

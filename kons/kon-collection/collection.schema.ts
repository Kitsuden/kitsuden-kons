import { index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Collection — what each reader already has
 * ============================================================================
 *
 * One mark per person, index and record: "I have this one". It is the piece
 * that turns an index into a collection tracker, and it is PERSONAL — the table is in
 * `rls-owned-tables.sql` and its policy has no public read: someone's
 * collection is shown to nobody else unless they share it.
 *
 * ── WHY THE KEY IS THE RECORD'S SLUG ───────────────────────────────────────
 *
 * `entry_key` is the key the index uses to name each record
 * (`emberpup`), not the uuid of its row. It is what the page has in hand when
 * drawing the grid, and what goes in its address: storing the uuid would force
 * translating on every mark and every read.
 *
 * The price: if a record changed slug, its mark would be orphaned. This is
 * accepted on purpose — a slug is the record's public address and changing it
 * already breaks outside links, so it is not changed lightly.
 */
export const collectionMarks = pgTable(
  "collection_marks",
  {
    userId: text("user_id").notNull(),
    /** The index (dataset) the record belongs to */
    datasetId: text("dataset_id").notNull(),
    /** The record's key within that index */
    entryKey: text("entry_key").notNull(),
    /**
     * What relationship it has with it. Today only `caught`; the column exists because
     * "I want it" and "I'm breeding it" are the same table with another value, and
     * adding it later would force migrating the marks already saved.
     */
    state: text("state").default("caught").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.datasetId, t.entryKey] }),
    index("collection_marks_user_dataset_idx").on(t.userId, t.datasetId),
  ]
);

export type CollectionMarkRow = typeof collectionMarks.$inferSelect;

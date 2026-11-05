/**
 * kon-vekstudio — Schema
 *
 * Mirror/link table: each row references an OCR job that lives in
 * konusagi's Postgres (the pipeline's source of truth). Only what is
 * necessary to query from KITSUDEN (DataExplorer, Graphify) is stored here
 * and to link the document to any CMS entity.
 */
import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const ocrDocuments = pgTable("ocr_documents", {
  id: uuid("id").primaryKey().defaultRandom(),

  /** konusagi job_id (32-char hex) — correlation key */
  jobId: varchar("job_id", { length: 64 }).notNull().unique(),

  filename: text("filename"),
  /** PENDING | STARTED | RETRY | SUCCESS | FAILURE */
  state: varchar("state", { length: 16 }).notNull().default("PENDING"),
  engine: varchar("engine", { length: 64 }),
  confidence: doublePrecision("confidence"),
  processingTimeMs: integer("processing_time_ms"),
  error: text("error"),

  /** Optional polymorphic link to any KITSUDEN record */
  entityType: varchar("entity_type", { length: 64 }),
  entityId: varchar("entity_id", { length: 64 }),

  /** Marked when the document went through HITL review in the studio */
  reviewed: boolean("reviewed").notNull().default(false),

  createdBy: varchar("created_by", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OcrDocument = typeof ocrDocuments.$inferSelect;
export type NewOcrDocument = typeof ocrDocuments.$inferInsert;

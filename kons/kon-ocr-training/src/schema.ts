/**
 * kon-ocr-training — Schema
 *
 * Vision LLM configuration (last resort of the OCR cascade),
 * governed from KITSUDEN. It stores ONLY the NON-sensitive knobs: the provider
 * API key lives in KITSUDEN Secrets (encrypted AES-256-GCM), never here.
 *
 * Singleton table (one row): the operator edits it from the KITSUDEN admin.
 */
import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const ocrVisionConfig = pgTable("ocr_vision_config", {
  // Singleton: always id=1.
  id: integer("id").primaryKey().default(1),

  /** Enables escalation to the vision LLM. */
  enabled: boolean("enabled").notNull().default(false),

  /** "anthropic" | "openai" (openai = any compatible API via baseUrl). */
  provider: varchar("provider", { length: 32 }).notNull().default("anthropic"),

  /** Model (e.g. claude-sonnet-4-5, gpt-4o). Empty = provider default. */
  model: varchar("model", { length: 128 }),

  /** Endpoint for gateways/local (OpenRouter, vLLM, Ollama). Empty = official. */
  baseUrl: text("base_url"),

  /**
   * Fidelity threshold: if the OCR falls BELOW it, it is re-read with the LLM.
   * 0.0-1.0. null = use the engine's normal gate.
   */
  minConfidence: doublePrecision("min_confidence"),

  /**
   * "after_light" | "after_heavy" — informational only for the standalone engine;
   * in the KITSUDEN topology reprocessing is explicit (endpoint), not inline.
   */
  stage: varchar("stage", { length: 16 }).notNull().default("after_heavy"),

  /** Cap on pages sent to the LLM (cost control). */
  maxPages: integer("max_pages").notNull().default(3),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: varchar("updated_by", { length: 64 }),
});

export type OcrVisionConfig = typeof ocrVisionConfig.$inferSelect;
export type NewOcrVisionConfig = typeof ocrVisionConfig.$inferInsert;

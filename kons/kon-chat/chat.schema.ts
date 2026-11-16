import { boolean, integer, jsonb, numeric, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";

/**
 * kon-chat — chatbots over the core's agents
 * ============================================================================
 *
 * A bot is a channel to one agent identity of the core: the agent brings the model, its prompt, its scopes and
 * its tools. The bot decides who talks to it (`team`, some `members` of it, or `public`), which tool group it may
 * use (`toolset`, only for the team), what it knows (documents → chunks), what it may spend and its limits.
 * Row-level security is in the migration. `chat_chunks.embedding_vec` exists only where pgvector does, so it is
 * read and written with SQL, not through this schema.
 */

/** One piece of a message, in the order it happened. */
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input?: Record<string, unknown>; ok?: boolean }
  | { type: "approval"; toolCallId: string; name: string; proposalId: string }
  | { type: "source"; documentId: string; title: string; attachment: boolean };

export const chatBots = pgTable("chat_bots", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  agentId: text("agent_id").notNull(),
  audience: text("audience").$type<"team" | "public">().notNull().default("team"),
  toolset: text("toolset"),
  greeting: text("greeting"),
  members: jsonb("members").$type<string[]>().notNull().default([]),
  allowedOrigins: jsonb("allowed_origins").$type<string[]>().notNull().default([]),
  dailyLimit: integer("daily_limit").notNull().default(500),
  userDailyLimit: integer("user_daily_limit").notNull().default(200),
  visitorHourlyLimit: integer("visitor_hourly_limit").notNull().default(30),
  priceInPerMillion: numeric("price_in_per_million", { precision: 12, scale: 4 }).notNull().default("0"),
  priceOutPerMillion: numeric("price_out_per_million", { precision: 12, scale: 4 }).notNull().default("0"),
  dailyBudgetUsd: numeric("daily_budget_usd", { precision: 12, scale: 2 }),
  active: boolean("active").notNull().default(true),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const chatConversations = pgTable("chat_conversations", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull(),
  userId: text("user_id"),
  visitorKey: text("visitor_key"),
  forkedFrom: text("forked_from"),
  messageCount: integer("message_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastAt: timestamp("last_at", { withTimezone: true }).defaultNow().notNull(),
});

export const chatDocuments = pgTable("chat_documents", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull(),
  /** Set for an attachment: only that conversation searches it. */
  conversationId: text("conversation_id"),
  title: text("title").notNull(),
  content: text("content").notNull(),
  chunkCount: integer("chunk_count").notNull().default(0),
  embedded: boolean("embedded").notNull().default(false),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const chatChunks = pgTable("chat_chunks", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  botId: text("bot_id").notNull(),
  conversationId: text("conversation_id"),
  ordinal: integer("ordinal").notNull(),
  text: text("text").notNull(),
  embedding: jsonb("embedding").$type<number[] | null>(),
});

export const chatMessages = pgTable("chat_messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  botId: text("bot_id").notNull(),
  role: text("role").$type<"user" | "assistant">().notNull(),
  content: text("content").notNull(),
  parts: jsonb("parts").$type<MessagePart[]>().notNull().default([]),
  sources: jsonb("sources").$type<Array<{ documentId: string; title: string }>>().notNull().default([]),
  toolCalls: jsonb("tool_calls").$type<string[]>().notNull().default([]),
  traceId: text("trace_id"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
  feedback: smallint("feedback"),
  feedbackComment: text("feedback_comment"),
  feedbackAt: timestamp("feedback_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

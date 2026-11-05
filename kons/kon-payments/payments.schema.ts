/**
 * Kitsuden Payments — Schema
 * ============================================================================
 * Three tables, all with the `pay_` prefix so as not to collide with anything:
 *
 *   pay_customers     — the user ↔ provider customer bridge
 *   pay_subscriptions — the state that decides whether someone has access
 *   pay_events        — webhook log; also the IDEMPOTENCY KEY
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ── Customers ────────────────────────────────────────────────────────────────

export const payCustomers = pgTable(
  "pay_customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** App user. It is what allows answering "does this user pay?". */
    userId: text("user_id").notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    /** Customer id AT the provider. */
    externalId: varchar("external_id", { length: 128 }).notNull(),
    email: varchar("email", { length: 320 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // A user has ONE customer per provider (they can use Stripe and PayPal).
    uniqueIndex("pay_customers_user_provider_idx").on(t.userId, t.provider),
    uniqueIndex("pay_customers_external_idx").on(t.provider, t.externalId),
  ]
);

// ── Subscriptions ────────────────────────────────────────────────────────────

export const paySubscriptions = pgTable(
  "pay_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    externalId: varchar("external_id", { length: 128 }).notNull(),
    planId: varchar("plan_id", { length: 128 }),
    /** trialing | active | past_due | canceled | paused | expired */
    status: varchar("status", { length: 24 }).notNull(),
    /**
     * Until when it is paid. It is the field that decides access: it is compared
     * with `now()`, `status` is NOT trusted alone — a `canceled` one may still
     * have access until the already-charged period ends.
     */
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    metadata: jsonb("metadata").$type<Record<string, string>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("pay_subs_external_idx").on(t.provider, t.externalId),
    index("pay_subs_user_idx").on(t.userId),
    index("pay_subs_status_idx").on(t.status),
  ]
);

// ── Events (log + idempotency) ───────────────────────────────────────────────

export const payEvents = pgTable(
  "pay_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: varchar("provider", { length: 32 }).notNull(),
    /**
     * Event id at the provider. The UNIQUE index on (provider,
     * externalId) is the idempotency: providers retry webhooks,
     * and without this accounting entries and accesses would be duplicated.
     */
    externalId: varchar("external_id", { length: 191 }).notNull(),
    type: varchar("type", { length: 48 }).notNull(),
    userId: text("user_id"),
    subscriptionId: varchar("subscription_id", { length: 128 }),
    /** Amount in the minimum unit (cents). */
    amount: integer("amount"),
    currency: varchar("currency", { length: 3 }),
    /** Id of the entry generated in kon-conta, if the bridge is active. */
    journalId: uuid("journal_id"),
    payload: jsonb("payload").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("pay_events_dedupe_idx").on(t.provider, t.externalId),
    index("pay_events_type_idx").on(t.type),
    index("pay_events_user_idx").on(t.userId),
  ]
);

export type PayCustomer = typeof payCustomers.$inferSelect;
export type PaySubscription = typeof paySubscriptions.$inferSelect;
export type PayEvent = typeof payEvents.$inferSelect;

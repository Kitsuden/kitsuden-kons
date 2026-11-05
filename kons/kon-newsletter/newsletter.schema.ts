/**
 * Kitsuden Newsletter — Schema
 * ============================================================================
 * Eight tables with the `nl_` prefix. The model follows Ghost (members, several
 * newsletters, segments, campaigns) and adds the two pieces that Ghost solves
 * worse or delegates entirely:
 *
 *   nl_suppressions — GLOBAL suppression list. Ghost's is per
 *                     newsletter; a spam complaint should protect you in
 *                     ALL of them, because whoever reports you reports the domain.
 *
 *   nl_deliveries   — one row per recipient, with a unique index
 *                     (campaign, member). It is what makes sending RESUMABLE
 *                     and IDEMPOTENT: if the worker dies at email 30,000
 *                     of 50,000, resuming does not write to anyone again.
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

import type { CampaignStats } from "./newsletter.types";

// ── Newsletters ──────────────────────────────────────────────────────────────

/**
 * An installation can publish several newsletters (weekly, release
 * notes, paid-only). Ghost does the same and it is what avoids having to set up
 * an instance per newsletter.
 */
export const nlNewsletters = pgTable(
  "nl_newsletters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: varchar("slug", { length: 64 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    /** Own sender per newsletter; if missing, the Mailer's global one is used. */
    fromName: varchar("from_name", { length: 200 }),
    fromEmail: varchar("from_email", { length: 320 }),
    replyTo: varchar("reply_to", { length: 320 }),
    /** Offered on the public sign-up. An internal one is marked `false`. */
    publicSignup: boolean("public_signup").default(true).notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("nl_newsletters_slug_idx").on(t.slug)]
);

// ── Members ──────────────────────────────────────────────────────────────────

export const nlMembers = pgTable(
  "nl_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 320 }).notNull(),
    name: varchar("name", { length: 200 }),
    /** pending | subscribed | unsubscribed | cleaned */
    status: varchar("status", { length: 16 }).default("pending").notNull(),
    locale: varchar("locale", { length: 8 }).default("es").notNull(),

    /**
     * App user, if any. It is the bridge with kon-payments to
     * resolve the tier: a member can exist without an account (email only).
     */
    userId: text("user_id"),

    // ── Consent (GDPR) ───────────────────────────────────────────────────
    // It is not bureaucracy: in the face of a complaint you must be able to prove when,
    // from where and by what means this address was signed up.
    consentAt: timestamp("consent_at", { withTimezone: true }),
    consentIp: varchar("consent_ip", { length: 45 }),
    /** Where it came from: "web", "import", "api", "checkout"… */
    consentSource: varchar("consent_source", { length: 64 }),

    // ── Tokens ───────────────────────────────────────────────────────────
    /** Confirmation token (double opt-in). Deleted on confirmation. */
    confirmToken: varchar("confirm_token", { length: 128 }),
    confirmSentAt: timestamp("confirm_sent_at", { withTimezone: true }),
    /**
     * PERMANENT unsubscribe token. It goes in every email (List-Unsubscribe) and does not
     * expire: a broken unsubscribe link is a guaranteed spam complaint.
     */
    unsubToken: varchar("unsub_token", { length: 128 }).notNull(),

    /** Free-form data for segmenting (preferred game, plan, city…). */
    attributes: jsonb("attributes").$type<Record<string, unknown>>().default({}).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("nl_members_email_idx").on(t.email),
    uniqueIndex("nl_members_unsub_token_idx").on(t.unsubToken),
    index("nl_members_status_idx").on(t.status),
    index("nl_members_user_idx").on(t.userId),
  ]
);

// ── Member ↔ newsletter subscription ─────────────────────────────────────────

export const nlSubscriptions = pgTable(
  "nl_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id").notNull(),
    newsletterId: uuid("newsletter_id").notNull(),
    subscribedAt: timestamp("subscribed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("nl_subs_member_newsletter_idx").on(t.memberId, t.newsletterId),
    index("nl_subs_newsletter_idx").on(t.newsletterId),
  ]
);

// ── Suppression ──────────────────────────────────────────────────────────────

/**
 * The kon's most important table.
 *
 * Every address here is excluded from ANY send, forever and across
 * all newsletters. It is the difference between a healthy list and a domain
 * on blacklists. It is queried at send time, not when building the
 * segment: hours can pass between the two.
 */
export const nlSuppressions = pgTable(
  "nl_suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 320 }).notNull(),
    /** bounce | complaint | unsubscribe | manual */
    reason: varchar("reason", { length: 16 }).notNull(),
    /** Provider that reported it, or "local". */
    source: varchar("source", { length: 32 }).default("local").notNull(),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("nl_suppressions_email_idx").on(t.email),
    index("nl_suppressions_reason_idx").on(t.reason),
  ]
);

// ── Segments ─────────────────────────────────────────────────────────────────

export const nlSegments = pgTable(
  "nl_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: varchar("slug", { length: 64 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    /**
     * The declarative filter (`SegmentFilter`), NOT the resolved list. Storing
     * the query and not the result keeps the segment up to date on every send.
     */
    filter: jsonb("filter").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("nl_segments_slug_idx").on(t.slug)]
);

// ── Campaigns ────────────────────────────────────────────────────────────────

export const nlCampaigns = pgTable(
  "nl_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    newsletterId: uuid("newsletter_id").notNull(),
    segmentId: uuid("segment_id"),

    /** kon-blog post that originated it, if it came from publishing. */
    postId: text("post_id"),

    subject: varchar("subject", { length: 500 }).notNull(),
    /** The text the mail client shows after the subject. */
    previewText: varchar("preview_text", { length: 300 }),
    html: text("html").notNull(),
    text: text("text"),

    /** draft | scheduled | sending | sent | failed | canceled */
    status: varchar("status", { length: 16 }).default("draft").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),

    // `Partial` because a newly created campaign starts with `{}` and the
    // counters get filled in; the concrete type (and not a generic
    // Record<string,number>) is what prevents inventing a metric.
    stats: jsonb("stats").$type<Partial<CampaignStats>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("nl_campaigns_newsletter_idx").on(t.newsletterId),
    index("nl_campaigns_status_idx").on(t.status),
    index("nl_campaigns_scheduled_idx").on(t.scheduledAt),
    // A post publishes ONE campaign. Without this, republishing an article (or two
    // workers seeing the same event) resends the whole newsletter.
    uniqueIndex("nl_campaigns_post_idx")
      .on(t.postId)
      .where(sql`${t.postId} is not null`),
  ]
);

// ── Entregas ─────────────────────────────────────────────────────────────────

/**
 * One row per recipient and campaign.
 *
 * It costs space (50,000 rows per send) and is worth every byte: it is what makes
 * sending resumable, allows retrying only the failed ones, and gives metrics
 * per person instead of an aggregate counter.
 */
export const nlDeliveries = pgTable(
  "nl_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id").notNull(),
    memberId: uuid("member_id").notNull(),
    email: varchar("email", { length: 320 }).notNull(),

    /** pending | sent | failed | delivered | bounced | complained */
    status: varchar("status", { length: 16 }).default("pending").notNull(),
    messageId: varchar("message_id", { length: 255 }),
    error: text("error"),
    attempts: integer("attempts").default(0).notNull(),

    sentAt: timestamp("sent_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    clickedAt: timestamp("clicked_at", { withTimezone: true }),
  },
  (t) => [
    // THE idempotency guarantee: resuming a send does not duplicate emails.
    uniqueIndex("nl_deliveries_campaign_member_idx").on(t.campaignId, t.memberId),
    index("nl_deliveries_status_idx").on(t.campaignId, t.status),
    // The webhook arrives with the provider's messageId and the row must be located
    // by it.
    index("nl_deliveries_message_idx").on(t.messageId),
    index("nl_deliveries_email_idx").on(t.email),
  ]
);

// ── Feedback log ─────────────────────────────────────────────────────────────

export const nlEvents = pgTable(
  "nl_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: varchar("provider", { length: 32 }).notNull(),
    /** Event id at the provider — deduplication key. */
    externalId: varchar("external_id", { length: 255 }).notNull(),
    type: varchar("type", { length: 24 }).notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    messageId: varchar("message_id", { length: 255 }),
    detail: text("detail"),
    raw: jsonb("raw"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("nl_events_dedupe_idx").on(t.provider, t.externalId),
    index("nl_events_email_idx").on(t.email),
    index("nl_events_type_idx").on(t.type),
  ]
);

// ── Inferred types ───────────────────────────────────────────────────────────

export type NlNewsletter = typeof nlNewsletters.$inferSelect;
export type NlMember = typeof nlMembers.$inferSelect;
export type NlSegment = typeof nlSegments.$inferSelect;
export type NlCampaign = typeof nlCampaigns.$inferSelect;
export type NlDelivery = typeof nlDeliveries.$inferSelect;
export type NlSuppression = typeof nlSuppressions.$inferSelect;

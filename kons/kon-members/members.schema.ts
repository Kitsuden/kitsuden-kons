import { createId } from "@paralleldrive/cuid2";
import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";

/**
 * Memberships — the layer Kitsuden lacks to match Ghost
 * ============================================================================
 *
 * Ghost is not a blog CMS: it is a PAID MEMBERSHIPS platform with a blog in
 * front. Without tiers, members and access control, a blog is just a blog.
 *
 * Two design decisions worth understanding before touching this:
 *
 * **1. A member is NOT a CMS user.** Whoever subscribes to your newsletter
 * must not exist in `auth_users` with a role and permissions: that would be
 * giving a backoffice account to a reader. Members are their own entity, with
 * access by magic link. `authUserId` exists only for the case where a member
 * is ALSO a system user.
 *
 * **2. This is GENERIC, not the blog's.** An academy kon, a video kon or a
 * downloads kon need exactly the same access control. That is why the content
 * declares which tier it requires (`visibility`) and this layer resolves
 * whether a member meets it — without knowing what a "post" is.
 *
 * The bridge with `kon-payments` is a GRANT (`member_access`): an active
 * subscription grants access to a tier. That way payment accounting and access
 * control stay decoupled, and access can be gifted (comped) without inventing
 * a fake payment.
 */

// ── Enums ────────────────────────────────────────────────────────────────────

export const memberStatusEnum = pgEnum("member_status", [
  "free",
  "paid",
  /** Gifted access: press, contributors, support. No payment behind it. */
  "comped",
  /** Unsubscribed from everything. The row is kept for history and erasure. */
  "canceled",
]);

/**
 * Where an access grant comes from.
 * Knowing it is what allows revoking only what corresponds: if a subscription
 * expires, it cannot take with it an access gifted by hand.
 */
export const accessSourceEnum = pgEnum("member_access_source", [
  "subscription",
  "comp",
  "manual",
  "import",
]);

/** Visibility of a content item. Consumed by any kon, not just the blog. */
export const contentVisibilityEnum = pgEnum("content_visibility", [
  "public",
  /** Anyone registered, even on the free tier. */
  "members",
  /** Requires a specific paid tier or higher. */
  "paid",
]);

// ── Tiers ────────────────────────────────────────────────────────────────────

export const memberTiers = pgTable(
  "member_tiers",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),

    /**
     * Hierarchical order. Content that requires level 2 is seen by whoever has 2
     * or more: without this, upgrading a plan would not give access to the
     * lower plans' content and tiers would have to be enumerated on every
     * content item.
     */
    level: integer("level").default(0).notNull(),

    /** Prices in whole CENTS, as in kon-payments. Never float. */
    monthlyPriceCents: integer("monthly_price_cents"),
    yearlyPriceCents: integer("yearly_price_cents"),
    currency: text("currency").default("EUR").notNull(),

    benefits: jsonb("benefits").$type<string[]>().default([]).notNull(),

    /** A hidden tier keeps working but is not offered in the portal. */
    visible: boolean("visible").default(true).notNull(),
    active: boolean("active").default(true).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("member_tiers_slug_idx").on(t.slug),
    index("member_tiers_level_idx").on(t.level),
  ]
);

export type MemberTier = typeof memberTiers.$inferSelect;
export type NewMemberTier = typeof memberTiers.$inferInsert;

// ── Members ──────────────────────────────────────────────────────────────────

export const members = pgTable(
  "members",
  {
    id: text("id").primaryKey().$defaultFn(createId),

    /** A member's identity is their email: there is no password. */
    email: text("email").notNull(),
    name: text("name"),

    status: memberStatusEnum("status").default("free").notNull(),

    /** Only if they are also a CMS user. Normally it is null. */
    authUserId: text("auth_user_id"),

    /** Subscribed to the newsletter. Separate from access: one can pay and not want emails. */
    newsletterSubscribed: boolean("newsletter_subscribed").default(true).notNull(),

    /** Where they came from: import, portal, admin… Useful for attribution. */
    source: text("source").default("portal").notNull(),
    labels: jsonb("labels").$type<string[]>().default([]).notNull(),

    /** Internal team notes. Never sent to the member portal. */
    note: text("note"),

    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The email is the real key: two rows for the same address would split a
    // person's access history in two.
    uniqueIndex("members_email_idx").on(t.email),
    index("members_status_idx").on(t.status),
  ]
);

export type Member = typeof members.$inferSelect;
export type NewMember = typeof members.$inferInsert;

// ── Access grants ────────────────────────────────────────────────────────────

/**
 * Which tier a member has, since when, until when and why.
 *
 * It is a table of GRANTS and not a `tierId` field on `members` on purpose:
 * a person can have a paid subscription and a gifted access at the same time,
 * and when one expires it must not take the other with it. It also leaves a
 * historical trail, which is what allows answering "when did they stop paying?".
 */
export const memberAccess = pgTable(
  "member_access",
  {
    id: text("id").primaryKey().$defaultFn(createId),

    memberId: text("member_id").notNull(),
    tierId: text("tier_id").notNull(),

    source: accessSourceEnum("source").default("manual").notNull(),
    /** Id of the kon-payments subscription, if it comes from there. */
    subscriptionId: text("subscription_id"),

    startsAt: timestamp("starts_at", { withTimezone: true }).defaultNow().notNull(),
    /**
     * `null` = no expiry (indefinite gifted access).
     *
     * When it comes from a subscription, the END OF THE PAID PERIOD is set, not
     * the cancellation date: whoever cancels keeps what they already paid for
     * until it runs out. Charging and cutting off access the same day is fraud.
     */
    endsAt: timestamp("ends_at", { withTimezone: true }),

    /** Explicit revocation: cuts access without deleting the history. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("member_access_member_idx").on(t.memberId),
    index("member_access_subscription_idx").on(t.subscriptionId),
  ]
);

export type MemberAccess = typeof memberAccess.$inferSelect;
export type NewMemberAccess = typeof memberAccess.$inferInsert;

// ── Magic links ──────────────────────────────────────────────────────────────

/**
 * Passwordless access, like Ghost.
 *
 * The token HASH is stored, never the token: a leak of this table cannot turn
 * into member impersonation. Same criterion as the agent API keys in the core.
 */
export const memberSignins = pgTable(
  "member_signins",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    memberId: text("member_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("member_signins_token_idx").on(t.tokenHash),
    index("member_signins_member_idx").on(t.memberId),
  ]
);

export type MemberSignin = typeof memberSignins.$inferSelect;
export type NewMemberSignin = typeof memberSignins.$inferInsert;

// ── Member sessions ──────────────────────────────────────────────────────────

/**
 * A reader's session. **Separate from the CMS session on purpose.**
 *
 * A member must not be able to brush against the backoffice even by accident:
 * different cookies, different tables and different middleware. Mixing them
 * would be one `role` away from turning a subscriber into an editor.
 *
 * The token HASH is stored, same as magic links.
 */
export const memberSessions = pgTable(
  "member_sessions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    memberId: text("member_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("member_sessions_token_idx").on(t.tokenHash),
    index("member_sessions_member_idx").on(t.memberId),
  ]
);

export type MemberSession = typeof memberSessions.$inferSelect;
export type NewMemberSession = typeof memberSessions.$inferInsert;

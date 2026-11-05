/**
 * Members — service: tokens, sessions and access resolution
 * ============================================================================
 *
 * The logic of WHO SEES WHAT lives in `members.access.ts`, pure and already
 * tested. Here is what needs a database: issuing and consuming magic links,
 * opening reader sessions and translating payment subscriptions into grants.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq, gt, isNull, ne, or } from "drizzle-orm";

import {
  grantFromSubscription,
  type AccessGrant,
  type SubscriptionLike,
} from "./members.access.js";
import {
  memberAccess,
  memberSessions,
  memberSignins,
  memberTiers,
  members,
  type Member,
} from "./members.schema.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- the drizzle executor
   arrives typed as `any` from KonContext; narrowing it here would require exporting
   the host's full schema, which is exactly the coupling kons avoid. */
type Db = any;

// ── Tokens ───────────────────────────────────────────────────────────────────

/** 32 bytes of entropy: enough that it can't be guessed, short enough for a URL. */
const TOKEN_BYTES = 32;

/** Magic links expire soon: a forwarded email is not an eternal key. */
const SIGNIN_TTL_MS = 15 * 60 * 1000;

/** Long session: a reader should not have to re-authenticate every week. */
const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * SHA-256 and not argon2, unlike passwords and API keys.
 *
 * Argon2 is slow **on purpose** to resist brute force on low-entropy secrets.
 * A token of 32 random bytes is not guessable by brute force, and running it
 * through argon2 would add ~50 ms to EVERY authenticated request for no gain.
 * The hash here only protects against a leak of the table.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison, in case it is ever compared without an index. */
export function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ── Members ──────────────────────────────────────────────────────────────────

/** Normalizes the email: a member's identity cannot depend on casing. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findMemberByEmail(db: Db, email: string): Promise<Member | null> {
  const [row] = await db
    .select()
    .from(members)
    .where(eq(members.email, normalizeEmail(email)))
    .limit(1);
  return row ?? null;
}

/** Creates the member if it does not exist. Idempotent by email. */
export async function upsertMember(
  db: Db,
  input: { email: string; name?: string | null; source?: string; newsletterSubscribed?: boolean }
): Promise<Member> {
  const email = normalizeEmail(input.email);
  const existing = await findMemberByEmail(db, email);
  if (existing) return existing;

  const [created] = await db
    .insert(members)
    .values({
      email,
      name: input.name ?? null,
      source: input.source ?? "portal",
      // Requesting a sign-in link is NOT consenting to marketing email. The column
      // defaults to `true`, and with that anyone who typed someone else's email
      // into the portal signed them up to the newsletter without their knowledge.
      newsletterSubscribed: input.newsletterSubscribed ?? false,
    })
    .returning();
  return created;
}

// ── Magic links ──────────────────────────────────────────────────────────────

/**
 * Minimum wait between two links to the SAME person.
 *
 * The host's per-IP limit (5/hour) stops whoever hammers the endpoint, but not
 * whoever rotates IPs to fill a specific victim's mailbox. Within the wait
 * nothing is issued and the route responds exactly the same: from outside
 * «sent» cannot be told apart from «throttled».
 */
export const SIGNIN_COOLDOWN_MS = 60 * 1000;

/**
 * Issues a magic link. Returns the token IN CLEAR only once: it is what goes
 * in the email, and it can no longer be recovered from the database.
 *
 * Requesting a new link INVALIDATES the previous unused ones: if one leaked
 * (forwarded email, shared mailbox), the last one its owner requested is the
 * only one that opens. Returns `null` if there is one too recent.
 */
export async function issueSigninToken(db: Db, memberId: string): Promise<string | null> {
  const [recentOne] = await db
    .select({ id: memberSignins.id })
    .from(memberSignins)
    .where(
      and(
        eq(memberSignins.memberId, memberId),
        isNull(memberSignins.usedAt),
        gt(memberSignins.createdAt, new Date(Date.now() - SIGNIN_COOLDOWN_MS))
      )
    )
    .limit(1);
  if (recentOne) return null;

  // Pending ones are burned (`used_at`) instead of deleted: the access history
  // is what gets looked at when someone says «I didn't ask for that».
  await db
    .update(memberSignins)
    .set({ usedAt: new Date() })
    .where(and(eq(memberSignins.memberId, memberId), isNull(memberSignins.usedAt)));

  const token = generateToken();
  await db.insert(memberSignins).values({
    memberId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SIGNIN_TTL_MS),
  });
  return token;
}

/**
 * Consumes a magic link and opens a session.
 *
 * Single-use, and ATOMIC: before, the row was read and then `usedAt` was
 * marked, so two simultaneous requests with the same link (an email scanner
 * opening it at the same time as its owner) both passed the read and
 * came out with TWO sessions. Now the marking and the check are the same
 * `UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING`: only one
 * request can win that row.
 */
export async function consumeSigninToken(
  db: Db,
  token: string,
  meta: { userAgent?: string } = {}
): Promise<{ member: Member; sessionToken: string } | null> {
  const [row] = await db
    .update(memberSignins)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(memberSignins.tokenHash, hashToken(token)),
        isNull(memberSignins.usedAt),
        gt(memberSignins.expiresAt, new Date())
      )
    )
    .returning();

  if (!row) return null;

  const [member] = await db.select().from(members).where(eq(members.id, row.memberId)).limit(1);
  if (!member) return null;

  const sessionToken = await openSession(db, member.id, meta);
  await db.update(members).set({ lastSeenAt: new Date() }).where(eq(members.id, member.id));

  return { member, sessionToken };
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export async function openSession(
  db: Db,
  memberId: string,
  meta: { userAgent?: string } = {}
): Promise<string> {
  const token = generateToken();
  await db.insert(memberSessions).values({
    memberId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    userAgent: meta.userAgent ?? null,
  });
  return token;
}

/** Resolves the member of a live session. `null` if there is none or it expired. */
export async function memberFromSession(db: Db, token: string | undefined): Promise<Member | null> {
  if (!token) return null;

  const [session] = await db
    .select()
    .from(memberSessions)
    .where(
      and(
        eq(memberSessions.tokenHash, hashToken(token)),
        isNull(memberSessions.revokedAt),
        gt(memberSessions.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!session) return null;

  const [member] = await db.select().from(members).where(eq(members.id, session.memberId)).limit(1);
  return member ?? null;
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db
    .update(memberSessions)
    .set({ revokedAt: new Date() })
    .where(eq(memberSessions.tokenHash, hashToken(token)));
}

// ── Access ───────────────────────────────────────────────────────────────────

/** A member's grants, in the shape `members.access.ts` expects. */
export async function loadGrants(db: Db, memberId: string): Promise<AccessGrant[]> {
  const rows = await db.select().from(memberAccess).where(eq(memberAccess.memberId, memberId));

  return rows.map((r: typeof memberAccess.$inferSelect) => ({
    tierId: r.tierId,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    revokedAt: r.revokedAt,
  }));
}

export async function loadTiers(db: Db) {
  return db
    .select()
    .from(memberTiers)
    .where(eq(memberTiers.active, true))
    .orderBy(memberTiers.level);
}

/**
 * Syncs a `kon-payments` subscription with the access grants.
 *
 * Idempotent by `subscriptionId`: payment providers **retry webhooks
 * aggressively**, and processing twice would duplicate access or leave
 * orphaned grants on cancellation.
 *
 * If the subscription stops granting (non-payment), the existing grant is
 * revoked instead of deleted: the history is what allows answering later "when
 * did they stop paying?".
 */
export async function syncSubscriptionAccess(
  db: Db,
  input: { memberId: string; tierId: string; subscription: SubscriptionLike }
): Promise<{ action: "granted" | "updated" | "revoked" | "noop" }> {
  const { memberId, tierId, subscription } = input;
  const grant = grantFromSubscription(subscription, tierId);

  const [existing] = await db
    .select()
    .from(memberAccess)
    .where(
      and(eq(memberAccess.subscriptionId, subscription.id), eq(memberAccess.source, "subscription"))
    )
    .limit(1);

  // A canceled subscription may still grant until the paid period ends, but the member is no
  // longer a paying one: their status says so now, their access ends with the period.
  const canceled = subscription.status?.toLowerCase() === "canceled";

  if (!grant) {
    if (!existing || existing.revokedAt) {
      if (canceled) await settleStatusAfterSubscription(db, memberId, subscription.id, "canceled");
      return { action: "noop" };
    }
    await db
      .update(memberAccess)
      .set({ revokedAt: new Date() })
      .where(eq(memberAccess.id, existing.id));
    await settleStatusAfterSubscription(
      db,
      existing.memberId,
      subscription.id,
      canceled ? "canceled" : "free"
    );
    return { action: "revoked" };
  }

  if (existing) {
    await db
      .update(memberAccess)
      .set({ tierId, endsAt: grant.endsAt, revokedAt: null })
      .where(eq(memberAccess.id, existing.id));
    if (canceled)
      await settleStatusAfterSubscription(db, existing.memberId, subscription.id, "canceled");
    else await db.update(members).set({ status: "paid" }).where(eq(members.id, existing.memberId));
    return { action: "updated" };
  }

  await db.insert(memberAccess).values({
    memberId,
    tierId,
    source: "subscription",
    subscriptionId: subscription.id,
    startsAt: grant.startsAt,
    endsAt: grant.endsAt,
  });

  // The member's status reflects that they are now paying (or that they already cancelled).
  if (canceled) await settleStatusAfterSubscription(db, memberId, subscription.id, "canceled");
  else await db.update(members).set({ status: "paid" }).where(eq(members.id, memberId));

  return { action: "granted" };
}

/**
 * A member's status once a subscription stops paying: `paid` if another live subscription grant
 * remains, `comped` if a live gifted one does, otherwise `otherwise` (`canceled` when the
 * subscription was cancelled, `free` when it lapsed for non-payment). Grants of the subscription
 * that just stopped do not count, even while its paid period runs out.
 */
async function settleStatusAfterSubscription(
  db: Db,
  memberId: string,
  subscriptionId: string,
  otherwise: "canceled" | "free"
): Promise<void> {
  const now = new Date();
  const live = await db
    .select({ source: memberAccess.source, subscriptionId: memberAccess.subscriptionId })
    .from(memberAccess)
    .where(
      and(
        eq(memberAccess.memberId, memberId),
        isNull(memberAccess.revokedAt),
        or(isNull(memberAccess.endsAt), gt(memberAccess.endsAt, now)),
        or(isNull(memberAccess.subscriptionId), ne(memberAccess.subscriptionId, subscriptionId))
      )
    );
  const status = live.some((g: { source: string }) => g.source === "subscription")
    ? "paid"
    : live.some((g: { source: string }) => g.source === "comp")
      ? "comped"
      : otherwise;
  await db.update(members).set({ status, updatedAt: now }).where(eq(members.id, memberId));
}

// ── Payments bridge ──────────────────────────────────────────────────────────

/**
 * Which tier each payment plan grants: `MEMBERS_PLAN_TIERS`, comma-separated `planId:tierSlug`
 * pairs (`price_123:supporter,price_456:pro`). Read on each event. It lives on the server on
 * purpose: checkout metadata is chosen by the buyer, and a tier read from it would sell the top
 * tier at the price of the cheapest plan.
 */
export function planTiers(env: Record<string, string | undefined> = process.env): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of (env.MEMBERS_PLAN_TIERS ?? "").split(",")) {
    const at = pair.lastIndexOf(":");
    if (at <= 0) continue;
    const plan = pair.slice(0, at).trim();
    const slug = pair.slice(at + 1).trim();
    if (plan && slug) out.set(plan, slug);
  }
  return out;
}

/** The part of a kon-payments `payment:<type>` event this kon reads. Structural: no import of that kon. */
export interface PaymentSubscriptionEvent {
  /** CMS account that pays (kon-payments never attributes by e-mail). */
  userId?: string | null;
  subscription?: {
    id: string;
    status: string;
    planId?: string | null;
    currentPeriodEnd?: string | null;
  } | null;
}

export type PaymentSyncResult =
  | { action: "granted" | "updated" | "revoked" | "noop" }
  | { skipped: "no-subscription" | "no-member" | "unmapped-plan" };

/**
 * Follows a kon-payments subscription event into the member's grants.
 *
 * The member is the one linked to the paying CMS account (`members.auth_user_id`); a payment is
 * never matched to a member by e-mail. The tier comes from `MEMBERS_PLAN_TIERS`; an event that
 * names no plan (a cancellation, a refund) keeps the tier of the grant the subscription already has.
 */
export async function syncPaymentSubscription(
  db: Db,
  payload: PaymentSubscriptionEvent,
  plans: Map<string, string> = planTiers()
): Promise<PaymentSyncResult> {
  const sub = payload.subscription;
  if (!sub?.id || !payload.userId) return { skipped: "no-subscription" };

  const [member] = await db
    .select({ id: members.id })
    .from(members)
    .where(eq(members.authUserId, payload.userId))
    .limit(1);
  if (!member) return { skipped: "no-member" };

  let tierId: string | undefined;
  const slug = sub.planId ? plans.get(sub.planId) : undefined;
  if (slug) {
    const [tier] = await db
      .select({ id: memberTiers.id })
      .from(memberTiers)
      .where(eq(memberTiers.slug, slug))
      .limit(1);
    tierId = tier?.id;
  }
  if (!tierId) {
    const [existing] = await db
      .select({ tierId: memberAccess.tierId })
      .from(memberAccess)
      .where(and(eq(memberAccess.subscriptionId, sub.id), eq(memberAccess.source, "subscription")))
      .limit(1);
    tierId = existing?.tierId;
  }
  if (!tierId) return { skipped: "unmapped-plan" };

  return syncSubscriptionAccess(db, {
    memberId: member.id,
    tierId,
    subscription: {
      id: sub.id,
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null,
    },
  });
}

/** Gifts access with no payment behind it (press, contributors, support). */
export async function compAccess(
  db: Db,
  input: { memberId: string; tierId: string; endsAt?: Date | null }
): Promise<void> {
  await db.insert(memberAccess).values({
    memberId: input.memberId,
    tierId: input.tierId,
    source: "comp",
    endsAt: input.endsAt ?? null,
  });
  await db.update(members).set({ status: "comped" }).where(eq(members.id, input.memberId));
}

/** Revokes all of a member's live grants for a tier. */
export async function revokeAccess(db: Db, memberId: string, tierId: string): Promise<void> {
  await db
    .update(memberAccess)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(memberAccess.memberId, memberId),
        eq(memberAccess.tierId, tierId),
        or(isNull(memberAccess.revokedAt))
      )
    );
}

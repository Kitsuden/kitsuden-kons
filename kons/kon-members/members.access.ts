/**
 * Membership access control — pure, no database
 * ============================================================================
 *
 * Like the bracket engine: the logic that decides WHO SEES WHAT lives here,
 * separate from persistence, so it can be tested exhaustively. A bug in this
 * file is paid content given away or paying customers blocked; neither of
 * those should depend on an integration test.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THAT CANNOT BE BROKEN
 *
 * Paid content is **never sent to the client** of someone without access.
 * Hiding it with CSS or a `v-if` is the usual way to get it wrong: the full
 * text travels in the HTML and is read with Ctrl+U or by disabling
 * JavaScript. Here it is cut ON THE SERVER and only the excerpt travels.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ContentVisibility = "public" | "members" | "paid";
export type AccessDenialReason = "anonymous" | "needs-paid" | "needs-higher-tier";

/** Tier as the access decision needs it. */
export interface TierRef {
  id: string;
  slug: string;
  name: string;
  /** Hierarchy: content of level N is seen by whoever has N or more. */
  level: number;
}

/** Access grant, current or not — validity is decided by this layer. */
export interface AccessGrant {
  tierId: string;
  startsAt: Date;
  /** `null` = no expiry. */
  endsAt: Date | null;
  revokedAt: Date | null;
}

/** Who requests the content. `null` = anonymous. */
export interface Viewer {
  memberId: string;
  grants: AccessGrant[];
}

/** What the content requires. */
export interface ContentGate {
  visibility: ContentVisibility;
  /**
   * Minimum level when `visibility` is `paid`. If not given, any paid tier
   * (level > 0) is enough.
   */
  minTierLevel?: number;
}

export interface AccessDecision {
  allowed: boolean;
  reason?: AccessDenialReason;
  /** Level the visitor has right now. 0 = free or anonymous. */
  viewerLevel: number;
  /** Level that would be needed. Useful for telling the user what to buy. */
  requiredLevel: number;
}

// ── Vigencia ─────────────────────────────────────────────────────────────────

/**
 * Is this grant alive right now?
 *
 * `now` is passed as an argument instead of reading the clock inside: that way
 * the test can place itself at any instant without faking timers, and the
 * function is deterministic.
 */
export function isGrantActive(grant: AccessGrant, now: Date): boolean {
  if (grant.revokedAt && grant.revokedAt <= now) return false;
  if (grant.startsAt > now) return false;
  // `endsAt` null = indefinite. And the end instant itself NO LONGER grants access.
  if (grant.endsAt && grant.endsAt <= now) return false;
  return true;
}

/**
 * Effective level of a visitor: the highest of their live grants.
 *
 * The maximum is taken, not the sum or the last one: someone can have both a
 * paid subscription and a gifted access at once, and what should apply is the
 * better of the two.
 */
export function viewerLevel(viewer: Viewer | null, tiers: TierRef[], now: Date): number {
  if (!viewer) return 0;

  const levelById = new Map(tiers.map((t) => [t.id, t.level]));
  let best = 0;

  for (const grant of viewer.grants) {
    if (!isGrantActive(grant, now)) continue;
    best = Math.max(best, levelById.get(grant.tierId) ?? 0);
  }
  return best;
}

// ── Decision ─────────────────────────────────────────────────────────────────

/**
 * Can this visitor see this content?
 *
 * Deny-by-default in the sense that matters: an unknown visibility is treated
 * as `paid`, not as `public`. If someone introduces a new value and forgets to
 * handle it here, the failure is "too restrictive", which gets detected because
 * users complain — not "too permissive", which gets detected when the whole
 * archive has already been given away.
 */
export function canAccess(
  gate: ContentGate,
  viewer: Viewer | null,
  tiers: TierRef[],
  now: Date = new Date()
): AccessDecision {
  const level = viewerLevel(viewer, tiers, now);

  if (gate.visibility === "public") {
    return { allowed: true, viewerLevel: level, requiredLevel: 0 };
  }

  if (gate.visibility === "members") {
    // Being registered is enough, even on the free tier.
    return viewer
      ? { allowed: true, viewerLevel: level, requiredLevel: 0 }
      : { allowed: false, reason: "anonymous", viewerLevel: 0, requiredLevel: 0 };
  }

  // `paid` and any unrecognized value.
  const required = Math.max(1, gate.minTierLevel ?? 1);

  if (!viewer) {
    return { allowed: false, reason: "anonymous", viewerLevel: 0, requiredLevel: required };
  }
  if (level >= required) {
    return { allowed: true, viewerLevel: level, requiredLevel: required };
  }
  return {
    allowed: false,
    reason: level > 0 ? "needs-higher-tier" : "needs-paid",
    viewerLevel: level,
    requiredLevel: required,
  };
}

// ── Content trimming ─────────────────────────────────────────────────────────

export interface GatedContent<T> {
  /** Servable content: complete if there is access, trimmed if not. */
  content: T | null;
  /** Excerpt visible when there is no access. */
  excerpt: string;
  /** `true` when it has been trimmed. The client paints the wall with this. */
  gated: boolean;
  access: AccessDecision;
}

/**
 * Applies the paywall to a block document.
 *
 * Returns a NEW object without the hidden blocks. It is the difference between
 * a real wall and a decorative one: what cannot be seen is not serialized.
 *
 * `freeBlocks` lets the first N blocks be seen — the hook that turns readers
 * into subscribers. With 0, nothing of the body is seen.
 */
export function gateBlocks<B>(
  blocks: B[] | null | undefined,
  decision: AccessDecision,
  options: { freeBlocks?: number; excerpt?: string } = {}
): GatedContent<B[]> {
  const excerpt = options.excerpt ?? "";

  if (decision.allowed) {
    return { content: blocks ?? [], excerpt, gated: false, access: decision };
  }

  const free = Math.max(0, options.freeBlocks ?? 0);
  // `slice` on a copy: the original document is never mutated, as it could
  // come from a shared cache and would be left truncated for everyone.
  const teaser = (blocks ?? []).slice(0, free);

  return { content: teaser, excerpt, gated: true, access: decision };
}

/**
 * Same but for plain text or already rendered HTML.
 *
 * Cuts by paragraphs, not by characters, so as not to split a tag in half and
 * leave broken HTML on the page.
 */
export function gateHtml(
  html: string | null | undefined,
  decision: AccessDecision,
  options: { freeParagraphs?: number; excerpt?: string } = {}
): GatedContent<string> {
  const excerpt = options.excerpt ?? "";
  const source = html ?? "";

  if (decision.allowed) {
    return { content: source, excerpt, gated: false, access: decision };
  }

  const free = Math.max(0, options.freeParagraphs ?? 0);
  if (free === 0) {
    return { content: "", excerpt, gated: true, access: decision };
  }

  const paragraphs = source.split(/(?=<p[\s>])/i).filter(Boolean);
  return {
    content: paragraphs.slice(0, free).join(""),
    excerpt,
    gated: true,
    access: decision,
  };
}

// ── Bridge with kon-payments ────────────────────────────────────────────────

/** Subscription states that grant access, and until when. */
export interface SubscriptionLike {
  id: string;
  status: string;
  /** End of the ALREADY PAID period. */
  currentPeriodEnd: Date | null;
  canceledAt?: Date | null;
}

/**
 * Translates a `kon-payments` subscription into an access grant.
 *
 * The nuance that matters: a `canceled` subscription **still grants access**
 * until the end of the paid period. Cutting it off on the cancellation day is
 * keeping money for a service not provided.
 *
 * Returns `null` if the subscription grants nothing (unpaid, incomplete…).
 */
export function grantFromSubscription(
  subscription: SubscriptionLike,
  tierId: string,
  now: Date = new Date()
): AccessGrant | null {
  const status = subscription.status?.toLowerCase();

  if (status === "active" || status === "trialing") {
    return {
      tierId,
      startsAt: now,
      endsAt: subscription.currentPeriodEnd,
      revokedAt: null,
    };
  }

  if (status === "canceled" && subscription.currentPeriodEnd) {
    // Keeps what was paid for. If the period has already passed, `isGrantActive` discards it.
    return {
      tierId,
      startsAt: subscription.canceledAt ?? now,
      endsAt: subscription.currentPeriodEnd,
      revokedAt: null,
    };
  }

  // past_due, unpaid, incomplete, paused… do not grant access.
  return null;
}

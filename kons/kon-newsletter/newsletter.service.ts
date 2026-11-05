/**
 * Kitsuden Newsletter — Service
 * ============================================================================
 * All the logic that is not HTTP: sign-up with double opt-in, unsubscribe, suppression,
 * segment resolution and campaign sending.
 *
 * NON-NEGOTIABLE RULES (and why)
 *
 * 1. Never send to a suppressed address. It is checked AT THE TIME of
 *    sending, not when building the segment: hours pass between the two and
 *    in that gap a spam complaint can arrive.
 *
 * 2. Every campaign email carries List-Unsubscribe. No exceptions.
 *
 * 3. A SOFT bounce does not suppress. Only the hard one and the complaint do.
 *
 * 4. Sending is resumable: the `nl_deliveries` rows are created BEFORE
 *    sending anything, and only those in `pending` are processed. If the process
 *    dies midway, resuming continues where it left off without resending to anyone.
 */

import { randomBytes } from "node:crypto";

import { attemptSql, mail, background, type SentMessage } from "@kitsuden/engine";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { NewsletterDb } from "./newsletter.db";
import { unsubscribeHeaders } from "./newsletter.mails";
import {
  type NlCampaign,
  type NlMember,
  type NlNewsletter,
  nlCampaigns,
  nlDeliveries,
  nlEvents,
  nlMembers,
  nlNewsletters,
  nlSegments,
  nlSubscriptions,
  nlSuppressions,
} from "./newsletter.schema";
import {
  injectPixel,
  rewriteLinks,
  trackingConfigFromEnv,
  type TrackingConfig,
} from "./newsletter.tracking";
import {
  defaultLocale,
  emptyStats,
  normalizeEmail,
  type BulkTransport,
  type CampaignStats,
  type DeliveryFeedback,
  type SegmentFilter,
} from "./newsletter.types";

// The client typed with the kon's schema: it restores typing to the whole
// query chain instead of propagating `any`. See newsletter.db.ts.
type Db = NewsletterDb;

// ── Tokens ───────────────────────────────────────────────────────────────────

/**
 * Opaque 32-byte token.
 *
 * `randomBytes` and not `Math.random`: these tokens authenticate unsubscribe and
 * confirmation without a session, so guessing them would allow unsubscribing
 * third parties. base64url so it survives a URL without escaping.
 */
function newToken(): string {
  return randomBytes(32).toString("base64url");
}

// ── Sign-up and confirmation ─────────────────────────────────────────────────

export interface SubscribeInput {
  email: string;
  name?: string;
  locale?: string;
  /** Newsletter slugs. If omitted, the first active one. */
  newsletters?: string[];
  attributes?: Record<string, unknown>;
  /** For the consent record (GDPR). */
  ip?: string;
  source?: string;
  userId?: string;
}

export interface SubscribeResult {
  status: "confirmation_sent" | "already_subscribed" | "suppressed" | "throttled";
  memberId?: string;
}

/**
 * Minimum wait between confirmation emails to the SAME address.
 *
 * Defense against "subscription bombing": the sign-up endpoint is public and
 * sends one email per request, so without this anyone can make you
 * send thousands of confirmations from your domain to a victim — and burn your
 * reputation along the way. CORS protects nothing here: `curl` ignores it.
 *
 * Five minutes barely bother whoever truly did not receive the email, and
 * ruin the attack.
 */
const CONFIRM_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * How long a confirmation link lasts.
 *
 * It used to never expire: a confirmation email forgotten in a mailbox (or
 * forwarded) signed its recipient up to the list months later, and the
 * consent was stamped with that date. Three days cover whoever reads it
 * late; after that another is requested from the form.
 */
export const CONFIRM_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Sign-up with double opt-in.
 *
 * IMPORTANT: the response is deliberately ambiguous toward the public. If we
 * distinguished "you were already subscribed" from "we have sent you a confirmation",
 * the public form would become an oracle for finding out whether an
 * address is on the list. The route always returns the same message.
 */
export async function subscribe(
  db: Db,
  input: SubscribeInput,
  options: { appUrl: string }
): Promise<SubscribeResult> {
  const email = normalizeEmail(input.email);

  // A suppressed address does not get back in through the form. If someone
  // unsubscribed or reported spam, re-adding them from outside would be exactly what
  // suppression exists to prevent.
  const [suppressed] = await db
    .select({ id: nlSuppressions.id })
    .from(nlSuppressions)
    .where(eq(nlSuppressions.email, email))
    .limit(1);
  if (suppressed) return { status: "suppressed" };

  // Only the public sign-up ones: `publicSignup=false` was declared and not checked,
  // and anyone could join an internal list (an earlier audit).
  const newsletters = await resolveNewsletters(db, input.newsletters, { publicOnly: true });
  if (newsletters.length === 0) {
    throw new Error("There is no active newsletter to subscribe to");
  }

  const [existing] = await db.select().from(nlMembers).where(eq(nlMembers.email, email)).limit(1);

  if (existing?.status === "subscribed") {
    // Already confirmed: lists are added ONLY if their own account asks for it.
    // Before, anyone could add a confirmed subscriber to any active list
    // without their consent (an earlier audit). The public
    // response is the same in both cases.
    if (input.userId && existing.userId && input.userId === existing.userId) {
      await linkNewsletters(
        db,
        existing.id,
        newsletters.map((n) => n.id)
      );
    }
    return { status: "already_subscribed", memberId: existing.id };
  }

  // A confirmation was just sent: another is not sent. `throttled` is
  // returned, which the route translates to the SAME public message as success —
  // the attacker must not be able to tell the cases apart.
  if (existing?.confirmSentAt) {
    const elapsed = Date.now() - new Date(existing.confirmSentAt).getTime();
    if (elapsed < CONFIRM_COOLDOWN_MS) {
      return { status: "throttled", memberId: existing.id };
    }
  }

  const confirmToken = newToken();
  let memberId: string;

  if (existing) {
    // Confirmation resend: NEW token. Reusing the old one would extend
    // indefinitely the validity window of a leaked token.
    await db
      .update(nlMembers)
      .set({
        confirmToken,
        confirmSentAt: new Date(),
        name: input.name ?? existing.name,
        locale: input.locale ?? existing.locale,
        status: "pending",
        updatedAt: new Date(),
      })
      .where(eq(nlMembers.id, existing.id));
    memberId = existing.id;
  } else {
    const [created] = await db
      .insert(nlMembers)
      .values({
        email,
        name: input.name,
        locale: input.locale ?? defaultLocale(),
        status: "pending",
        userId: input.userId,
        confirmToken,
        confirmSentAt: new Date(),
        unsubToken: newToken(),
        attributes: input.attributes ?? {},
      })
      .returning({ id: nlMembers.id });
    memberId = created.id;
  }

  await linkNewsletters(
    db,
    memberId,
    newsletters.map((n) => n.id)
  );

  const confirmUrl = `${options.appUrl.replace(/\/$/, "")}/api/newsletter/confirm?token=${confirmToken}`;
  await mail.send(
    "newsletter.confirm",
    {
      to: email,
      name: input.name,
      confirmUrl,
      newsletterName: newsletters[0].name,
    },
    input.locale
  );

  return { status: "confirmation_sent", memberId };
}

/**
 * Confirms the double opt-in.
 *
 * This is where consent is sealed: date, IP and origin. That record
 * is what you show if someone claims they never signed up.
 */
export async function confirm(
  db: Db,
  token: string,
  meta: { ip?: string; source?: string; appUrl?: string } = {}
): Promise<{ ok: boolean; member?: NlMember; welcome?: Promise<unknown> }> {
  if (!token) return { ok: false };

  const [member] = await db
    .select()
    .from(nlMembers)
    .where(eq(nlMembers.confirmToken, token))
    .limit(1);

  if (!member) return { ok: false };

  // Idempotent: clicking the link twice must not give the user an error.
  if (member.status === "subscribed") return { ok: true, member };

  // Expired: the SAME result as a token that does not exist.
  const sent = member.confirmSentAt ? new Date(member.confirmSentAt).getTime() : 0;
  if (!sent || Date.now() - sent > CONFIRM_TTL_MS) return { ok: false };

  // The token is burned in the SAME statement that checks it: two clicks at once
  // (or an email scanner and its owner) cannot confirm or send the
  // welcome twice.
  const [updated] = await db
    .update(nlMembers)
    .set({
      status: "subscribed",
      confirmToken: null,
      consentAt: new Date(),
      consentIp: meta.ip,
      consentSource: meta.source ?? "web",
      updatedAt: new Date(),
    })
    .where(and(eq(nlMembers.id, member.id), eq(nlMembers.confirmToken, token)))
    .returning();
  if (!updated) return { ok: true, member };

  const [newsletter] = await db.select().from(nlNewsletters).limit(1);

  // The welcome, OUTSIDE the request's transaction and without waiting for it: a
  // slow SMTP (nodemailer waits up to 2 min to connect) would hold the
  // transaction open, Postgres would cut it at 60 s and the confirmation
  // above would be lost. Whoever wants to wait for it (a test) has `welcome`.
  const welcome = background(() =>
    mail.send(
      "newsletter.welcome",
      {
        to: member.email,
        name: member.name,
        newsletterName: newsletter?.name ?? "the newsletter",
        // With the site URL: with "" the welcome's unsubscribe link came out
        // relative (`/api/newsletter/unsubscribe?…`) and in an email it leads
        // nowhere.
        unsubscribeUrl: unsubscribeUrl(member.unsubToken, meta.appUrl ?? ""),
      },
      member.locale
    )
  ).catch((err: unknown) => {
    // `send` does not throw on a send failure; this is a broken Mailable.
    console.error("[Newsletter] The welcome could not be prepared:", err);
    return null;
  });

  return { ok: true, member: updated, welcome };
}

// ── Unsubscribe and suppression ──────────────────────────────────────────────

export function unsubscribeUrl(token: string, appUrl: string): string {
  return `${appUrl.replace(/\/$/, "")}/api/newsletter/unsubscribe?token=${token}`;
}

/**
 * Unsubscribe by token. It is the one the Gmail/Yahoo one-click runs.
 *
 * It requires no session on purpose: the token IS the authentication. Asking for login
 * to unsubscribe is exactly what turns an unsubscribe into a spam
 * report.
 */
export async function unsubscribeByToken(db: Db, token: string): Promise<boolean> {
  if (!token) return false;

  const [member] = await db
    .select()
    .from(nlMembers)
    .where(eq(nlMembers.unsubToken, token))
    .limit(1);

  if (!member) return false;

  await db
    .update(nlMembers)
    .set({ status: "unsubscribed", updatedAt: new Date() })
    .where(eq(nlMembers.id, member.id));

  await suppress(db, member.email, "unsubscribe", "local");
  return true;
}

/**
 * Adds an address to the suppression list.
 *
 * `onConflictDoNothing` because arriving twice is normal (the provider
 * retries) and must not fail. The first recorded reason wins: if someone
 * unsubscribed and then bounces, the original reason is more informative.
 */
export async function suppress(
  db: Db,
  email: string,
  reason: "bounce" | "complaint" | "unsubscribe" | "manual",
  source = "local",
  detail?: string
): Promise<void> {
  await db
    .insert(nlSuppressions)
    .values({ email: normalizeEmail(email), reason, source, detail })
    .onConflictDoNothing();
}

/** Removes a suppression. Only by explicit human action. */
export async function unsuppress(db: Db, email: string): Promise<void> {
  await db.delete(nlSuppressions).where(eq(nlSuppressions.email, normalizeEmail(email)));
}

// ── Segments ─────────────────────────────────────────────────────────────────

/**
 * Resolves a segment to the list of members to send to.
 *
 * `status` is forced to `subscribed` unless the filter asks for something else, and
 * suppressed addresses are ALWAYS excluded, even if the filter asks for them.
 * A segment cannot skip suppression: it would be the easiest way to
 * burn the domain by accident.
 */
export async function resolveSegment(
  db: Db,
  filter: SegmentFilter,
  newsletterId?: string
): Promise<
  { id: string; email: string; name: string | null; locale: string; unsubToken: string }[]
> {
  const conditions = [
    inArray(nlMembers.status, filter.status?.length ? filter.status : ["subscribed"]),
  ];

  if (filter.locales?.length) conditions.push(inArray(nlMembers.locale, filter.locales));

  if (filter.subscribedAfter) {
    conditions.push(sql`${nlMembers.consentAt} >= ${new Date(filter.subscribedAfter)}`);
  }
  if (filter.subscribedBefore) {
    conditions.push(sql`${nlMembers.consentAt} <= ${new Date(filter.subscribedBefore)}`);
  }

  // Attributes: jsonb containment. A GIN index on `attributes` makes it
  // cheap if the list grows.
  if (filter.attributes && Object.keys(filter.attributes).length > 0) {
    conditions.push(sql`${nlMembers.attributes} @> ${JSON.stringify(filter.attributes)}::jsonb`);
  }

  // The exclusion that can never be turned off.
  conditions.push(
    sql`not exists (
      select 1 from ${nlSuppressions}
      where ${nlSuppressions.email} = ${nlMembers.email}
    )`
  );

  // `newsletters` (slugs): subscribed to at least one of them — any-of, like
  // `status`, `locales` and `tiers`. It was accepted and silently ignored, so a
  // segment meant for one list's readers went to everyone.
  if (filter.newsletters?.length) {
    conditions.push(
      sql`exists (
        select 1 from ${nlSubscriptions}
        join ${nlNewsletters} on ${nlNewsletters.id} = ${nlSubscriptions.newsletterId}
        where ${nlSubscriptions.memberId} = ${nlMembers.id}
          and ${inArray(nlNewsletters.slug, filter.newsletters)}
      )`
    );
  }

  // Subscription to the specific newsletter being sent.
  if (newsletterId) {
    conditions.push(
      sql`exists (
        select 1 from ${nlSubscriptions}
        where ${nlSubscriptions.memberId} = ${nlMembers.id}
          and ${nlSubscriptions.newsletterId} = ${newsletterId}
      )`
    );
  }

  const rows = await db
    .select({
      id: nlMembers.id,
      email: nlMembers.email,
      name: nlMembers.name,
      locale: nlMembers.locale,
      unsubToken: nlMembers.unsubToken,
      userId: nlMembers.userId,
    })
    .from(nlMembers)
    .where(and(...conditions));

  // The tier filter needs kon-payments; it is applied separately so the
  // kon keeps working if payments is not installed.
  if (filter.tiers?.length) return filterByTier(db, rows, filter.tiers);

  return rows;
}

/**
 * Filters by paid tier by querying kon-payments.
 *
 * It is queried with raw SQL and NOT by importing `paySubscriptions` because
 * kon-payments is an OPTIONAL dependency: importing its schema would create a
 * compile-time coupling with a kon that may not be installed. The table may
 * not exist, and that is a normal case, not an error.
 *
 * (For a while there was a second reason —pnpm resolved drizzle-orm into two
 * instances and another kon's table objects were a different type— but that
 * is now fixed by pinning `pg` in the overrides. The remaining reason is
 * decoupling, which is enough by itself.)
 *
 * If payments is absent, `"free"` includes everyone and any paid tier
 * returns nobody — which is the correct answer without a billing system.
 */
async function filterByTier(db: Db, rows: any[], tiers: string[]): Promise<any[]> {
  const wantsFree = tiers.includes("free");
  const paidTiers = tiers.filter((t) => t !== "free");

  const activeByUser = new Map<string, string>();
  // Table missing (kon-payments not installed): nobody has a subscription. In a
  // SAVEPOINT: that expected failure cannot leave aborted the transaction of the
  // request that prepares the campaign.
  const result = await attemptSql(
    () =>
      db.execute(sql`
        select user_id, plan_id
        from pay_subscriptions
        where status in ('active', 'trialing')
          and (current_period_end is null or current_period_end > now())
      `),
    null
  );

  // `execute` returns `{rows}` with node-postgres and an array with postgres.js.
  const subs: any[] = Array.isArray(result) ? result : (result?.rows ?? []);
  for (const sub of subs) {
    if (sub.user_id) activeByUser.set(String(sub.user_id), sub.plan_id ?? "paid");
  }

  return rows.filter((row) => {
    const plan = row.userId ? activeByUser.get(row.userId) : undefined;
    if (!plan) return wantsFree;
    return paidTiers.includes(plan) || paidTiers.includes("paid");
  });
}

// ── Campaign sending ─────────────────────────────────────────────────────────

export interface SendOptions {
  transport: BulkTransport;
  appUrl: string;
  appName: string;
  /** Default sender if the newsletter does not define one. */
  from?: string;
  /**
   * Open and click tracking. If omitted it is read from the environment, where
   * it is DISABLED by default (see newsletter.tracking.ts).
   */
  tracking?: TrackingConfig;
  logger?: {
    info(m: string, meta?: Record<string, unknown>): void;
    warn(m: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * Prepares a campaign: resolves the segment and creates the delivery rows.
 *
 * Separate from sending on purpose. With the rows already created, sending can be
 * resumed, only the failed ones retried and real progress reported, and two
 * workers cannot duplicate emails: the unique index (campaign, member) prevents
 * it at the database level, not the code level.
 */
export async function prepareCampaign(db: Db, campaignId: string): Promise<number> {
  const [campaign] = await db
    .select()
    .from(nlCampaigns)
    .where(eq(nlCampaigns.id, campaignId))
    .limit(1);

  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  if (campaign.status === "sent" || campaign.status === "sending") {
    throw new Error(`The campaign is already in state "${campaign.status}"`);
  }

  let filter: SegmentFilter = {};
  if (campaign.segmentId) {
    const [segment] = await db
      .select()
      .from(nlSegments)
      .where(eq(nlSegments.id, campaign.segmentId))
      .limit(1);
    if (segment) filter = segment.filter as SegmentFilter;
  }

  const members = await resolveSegment(db, filter, campaign.newsletterId);
  if (members.length === 0) return 0;

  // Insert in batches: an INSERT of 50,000 rows blows past the limit of
  // parameter limit.
  const CHUNK = 1000;
  for (let i = 0; i < members.length; i += CHUNK) {
    const slice = members.slice(i, i + CHUNK);
    await db
      .insert(nlDeliveries)
      .values(
        slice.map((m) => ({
          campaignId,
          memberId: m.id,
          email: m.email,
          status: "pending" as const,
        }))
      )
      .onConflictDoNothing();
  }

  const stats: CampaignStats = { ...emptyStats(), recipients: members.length };
  await db
    .update(nlCampaigns)
    .set({ status: "scheduled", stats })
    .where(eq(nlCampaigns.id, campaignId));

  return members.length;
}

/**
 * Sends the pending deliveries of a campaign.
 *
 * It is resumable: calling it again continues where it left off. Throttling is
 * applied between batches according to `transport.ratePerSecond`.
 */
export async function sendCampaign(
  db: Db,
  campaignId: string,
  options: SendOptions
): Promise<CampaignStats> {
  const [campaign] = await db
    .select()
    .from(nlCampaigns)
    .where(eq(nlCampaigns.id, campaignId))
    .limit(1);

  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  const [newsletter] = await db
    .select()
    .from(nlNewsletters)
    .where(eq(nlNewsletters.id, campaign.newsletterId))
    .limit(1);

  await db
    .update(nlCampaigns)
    .set({ status: "sending", startedAt: campaign.startedAt ?? new Date() })
    .where(eq(nlCampaigns.id, campaignId));

  const stats: CampaignStats = { ...emptyStats(), ...(campaign.stats as object) };
  const { transport } = options;
  const pauseMs = transport.ratePerSecond > 0 ? 1000 / transport.ratePerSecond : 0;

  for (;;) {
    // The pending ones are re-read on every pass: if a webhook suppresses someone
    // midway through the send, they stop receiving in the next batch.
    const pending = await db
      .select({
        id: nlDeliveries.id,
        memberId: nlDeliveries.memberId,
        email: nlDeliveries.email,
      })
      .from(nlDeliveries)
      .where(and(eq(nlDeliveries.campaignId, campaignId), eq(nlDeliveries.status, "pending")))
      .limit(transport.batchSize);

    if (pending.length === 0) break;

    // Rule 1: suppression check AT THE TIME of sending.
    const emails = pending.map((d) => d.email);
    const blocked = new Set<string>(
      (
        await db
          .select({ email: nlSuppressions.email })
          .from(nlSuppressions)
          .where(inArray(nlSuppressions.email, emails))
      ).map((r) => r.email)
    );

    const deliverable = pending.filter((d) => !blocked.has(d.email));

    if (blocked.size > 0) {
      await db
        .update(nlDeliveries)
        .set({ status: "failed", error: "suprimido" })
        .where(
          and(
            eq(nlDeliveries.campaignId, campaignId),
            inArray(nlDeliveries.email, Array.from(blocked))
          )
        );
      stats.failed += blocked.size;
    }

    if (deliverable.length === 0) continue;

    const memberRows = await db
      .select({
        id: nlMembers.id,
        email: nlMembers.email,
        name: nlMembers.name,
        locale: nlMembers.locale,
        unsubToken: nlMembers.unsubToken,
      })
      .from(nlMembers)
      .where(
        inArray(
          nlMembers.id,
          deliverable.map((d) => d.memberId)
        )
      );

    type MemberRow = {
      id: string;
      email: string;
      name: string | null;
      locale: string;
      unsubToken: string;
    };
    const byId = new Map<string, MemberRow>((memberRows as MemberRow[]).map((m) => [m.id, m]));

    const messages: SentMessage[] = [];
    const order: any[] = [];
    for (const delivery of deliverable) {
      const member = byId.get(delivery.memberId);
      if (!member) continue;
      // The delivery id is what makes per-person tracking possible:
      // without it, an open would only say "someone opened the campaign".
      messages.push(renderCampaignMessage(campaign, newsletter, member, options, delivery.id));
      order.push(delivery);
    }

    const results = await transport.sendBatch(messages);

    for (let i = 0; i < order.length; i++) {
      const result = results[i];
      const delivery = order[i];
      if (result?.ok) {
        stats.sent++;
        await db
          .update(nlDeliveries)
          .set({ status: "sent", messageId: result.messageId, sentAt: new Date() })
          .where(eq(nlDeliveries.id, delivery.id));
      } else {
        stats.failed++;
        await db
          .update(nlDeliveries)
          .set({
            status: "failed",
            error: result?.error ?? "unknown error",
            attempts: sql`${nlDeliveries.attempts} + 1`,
          })
          .where(eq(nlDeliveries.id, delivery.id));
      }
    }

    await db.update(nlCampaigns).set({ stats }).where(eq(nlCampaigns.id, campaignId));

    if (pauseMs > 0) await sleep(pauseMs * messages.length);
  }

  await db
    .update(nlCampaigns)
    .set({ status: "sent", completedAt: new Date(), stats })
    .where(eq(nlCampaigns.id, campaignId));

  options.logger?.info("[Newsletter] Campaign sent", {
    campaignId,
    sent: stats.sent,
    failed: stats.failed,
  });

  return stats;
}

/**
 * Composes a recipient's `SentMessage`.
 *
 * It does not go through a Mailable because the content is dynamic (it comes from the DB).
 * It does reuse the same type, so transports and `mail.fake()` treat it
 * like any other email.
 */
export function renderCampaignMessage(
  campaign: NlCampaign,
  newsletter: NlNewsletter | undefined,
  member: { email: string; name: string | null; locale: string; unsubToken: string },
  options: SendOptions,
  /** Delivery id, for per-person tracking. Optional. */
  deliveryId?: string
): SentMessage {
  const unsubUrl = unsubscribeUrl(member.unsubToken, options.appUrl);
  const from =
    newsletter?.fromEmail && newsletter?.fromName
      ? `${newsletter.fromName} <${newsletter.fromEmail}>`
      : (newsletter?.fromEmail ?? options.from ?? `no-reply@${hostOf(options.appUrl)}`);

  // Rule 2: the unsubscribe ALWAYS travels, in the header and in the HTML footer.
  let html = appendUnsubscribeFooter(campaign.html, unsubUrl);

  // Tracking: disabled unless explicitly requested. The order
  // matters — first the links are rewritten (which ignores the unsubscribe) and
  // then the pixel is injected, so as not to rewrite the pixel's own URL.
  if (deliveryId) {
    const tracking = options.tracking ?? trackingConfigFromEnv(options.appUrl);
    html = rewriteLinks(html, deliveryId, tracking, unsubUrl);
    html = injectPixel(html, deliveryId, tracking);
  }

  return {
    mailable: `newsletter.campaign:${campaign.id}`,
    to: [member.email],
    from,
    cc: [],
    bcc: [],
    replyTo: newsletter?.replyTo ?? undefined,
    subject: campaign.subject,
    html,
    text: campaign.text ?? "",
    attachments: [],
    headers: unsubscribeHeaders(unsubUrl),
    locale: member.locale,
    tag: `campaign-${campaign.id}`,
    sentAt: new Date().toISOString(),
  };
}

/** Adds the unsubscribe link at the end of the HTML if it is not already there. */
function appendUnsubscribeFooter(html: string, url: string): string {
  if (html.includes(url)) return html;
  const footer = `<div style="margin-top:32px;font-size:12px;color:#6b7280;text-align:center">
<a href="${url}" style="color:#6b7280">Unsubscribe</a></div>`;
  return html.includes("</body>") ? html.replace("</body>", `${footer}</body>`) : html + footer;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "localhost";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 30_000)));
}

// ── Applying feedback ────────────────────────────────────────────────────────

/**
 * Applies an already verified and normalized delivery event.
 *
 * Idempotent through the unique index (provider, externalId): if the insert does not
 * return a row, the event was already processed and it exits without touching anything else. Without
 * this, provider retries would inflate the open metrics.
 */
export async function applyFeedback(db: Db, feedback: DeliveryFeedback): Promise<boolean> {
  const [inserted] = await db
    .insert(nlEvents)
    .values({
      provider: feedback.provider,
      externalId: feedback.externalId,
      type: feedback.type,
      email: feedback.email,
      messageId: feedback.messageId,
      detail: feedback.detail,
      raw: feedback.raw as Record<string, unknown>,
      occurredAt: new Date(feedback.occurredAt),
    })
    .onConflictDoNothing()
    .returning({ id: nlEvents.id });

  if (!inserted) return false;

  // Rule 3: only the hard bounce and the complaint suppress. A full mailbox is
  // temporary, and unsubscribing for that loses good subscribers.
  if (feedback.type === "bounced" && feedback.hard) {
    await suppress(db, feedback.email, "bounce", feedback.provider, feedback.detail);
    await db
      .update(nlMembers)
      .set({ status: "cleaned", updatedAt: new Date() })
      .where(eq(nlMembers.email, feedback.email));
  }

  if (feedback.type === "complained") {
    await suppress(db, feedback.email, "complaint", feedback.provider, feedback.detail);
    await db
      .update(nlMembers)
      .set({ status: "unsubscribed", updatedAt: new Date() })
      .where(eq(nlMembers.email, feedback.email));
  }

  if (feedback.type === "unsubscribed") {
    await suppress(db, feedback.email, "unsubscribe", feedback.provider);
    await db
      .update(nlMembers)
      .set({ status: "unsubscribed", updatedAt: new Date() })
      .where(eq(nlMembers.email, feedback.email));
  }

  await updateDeliveryFromFeedback(db, feedback);

  return true;
}

/**
 * Marks the specific delivery the event refers to.
 *
 * TWO-STEP CORRELATION, AND IT IS NOT PARANOIA
 *
 * The natural thing would be to match by `messageId`, but not all providers
 * return the same id they later report. The specific case: the batched
 * Mailgun transport delivers up to 1,000 emails in ONE call and responds with a single
 * batch id, while the webhook reports the `Message-ID` that Mailgun
 * generated for EACH recipient. They never match, so matching only by
 * messageId left the per-delivery status unupdated precisely on the transport
 * meant for volume.
 *
 * Hence: first by (messageId, email) —exact, when the provider is
 * consistent—; if nothing fits, by email among the already sent deliveries,
 * keeping the most recent.
 *
 * The fallback is bounded to `sentAt is not null` and a single row so as not to overwrite
 * deliveries of other campaigns to the same subscriber.
 */
async function updateDeliveryFromFeedback(db: Db, feedback: DeliveryFeedback): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (feedback.type === "delivered") patch.status = "delivered";
  if (feedback.type === "bounced") patch.status = "bounced";
  if (feedback.type === "complained") patch.status = "complained";
  if (feedback.type === "opened") patch.openedAt = new Date(feedback.occurredAt);
  if (feedback.type === "clicked") patch.clickedAt = new Date(feedback.occurredAt);

  if (Object.keys(patch).length === 0) return;

  // Step 1: exact match.
  if (feedback.messageId) {
    const matched = await db
      .update(nlDeliveries)
      .set(patch)
      .where(
        and(eq(nlDeliveries.messageId, feedback.messageId), eq(nlDeliveries.email, feedback.email))
      )
      .returning({ id: nlDeliveries.id });

    if (matched.length > 0) return;
  }

  // Step 2: fallback by email. It is what saves batched Mailgun.
  const [latest] = await db
    .select({ id: nlDeliveries.id })
    .from(nlDeliveries)
    .where(and(eq(nlDeliveries.email, feedback.email), isNotNull(nlDeliveries.sentAt)))
    .orderBy(desc(nlDeliveries.sentAt))
    .limit(1);

  if (!latest) return;

  await db.update(nlDeliveries).set(patch).where(eq(nlDeliveries.id, latest.id));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function resolveNewsletters(
  db: Db,
  slugs?: string[],
  optionsValue: { publicOnly?: boolean } = {}
): Promise<any[]> {
  const active = optionsValue.publicOnly
    ? and(eq(nlNewsletters.active, true), eq(nlNewsletters.publicSignup, true))
    : eq(nlNewsletters.active, true);
  if (slugs?.length) {
    return db
      .select()
      .from(nlNewsletters)
      .where(and(inArray(nlNewsletters.slug, slugs), active));
  }
  return db.select().from(nlNewsletters).where(active).limit(1);
}

async function linkNewsletters(db: Db, memberId: string, newsletterIds: string[]): Promise<void> {
  if (newsletterIds.length === 0) return;
  await db
    .insert(nlSubscriptions)
    .values(newsletterIds.map((newsletterId) => ({ memberId, newsletterId })))
    .onConflictDoNothing();
}

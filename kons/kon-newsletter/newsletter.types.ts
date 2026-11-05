/**
 * Kitsuden Newsletter — Contracts
 * ============================================================================
 *
 * STRATEGY: the same as kon-payments — connect, don't compete. And with
 * a precedent that validates it: **Ghost does not deliver its own emails either**.
 * Self-hosted Ghost requires connecting Mailgun; Ghost provides the members, the
 * tiers, the segmentation and the analytics, and delegates delivery and bounces.
 *
 * WHY THERE ARE TWO INTERFACES AND NOT ONE
 *
 * The problem splits asymmetrically, and that decides the design:
 *
 * · SENDING is generic. SMTP is a universal protocol: Mailgun, Resend,
 *   Postmark, SES, Listmonk and Postal all speak it. A single transport
 *   covers 100% of providers with ZERO per-provider code. Native
 *   transports exist only for speed (Resend accepts 100
 *   recipients per call; Mailgun, 1,000; SMTP goes one at a time).
 *
 * · RECEIVING bounces and complaints is NOT generic. Each provider signs its webhook
 *   its own way —Mailgun with HMAC over timestamp+token, Resend with Svix, SES
 *   wrapped in SNS with X.509, Postmark with basic auth— and there is no standard
 *   to unify. Here an adapter per provider is needed, but it is thin:
 *   verify the signature and normalize the payload.
 *
 * Hence `BulkTransport` (generic, with optional native implementations)
 * and `FeedbackAdapter` (one per provider, mandatorily).
 */

import type { SentMessage } from "@kitsuden/engine";

// ── Members ──────────────────────────────────────────────────────────────────

/**
 * Subscriber status. The names follow the industry convention
 * so that migrating from Mailchimp/Ghost is a direct mapping.
 *
 * · pending      — signed up but has NOT confirmed. Receives nothing.
 * · subscribed   — confirmed. The only status that is sent to.
 * · unsubscribed — unsubscribed. The row is kept (proof of unsubscribe).
 * · cleaned      — hard bounced. Kept so as never to retry.
 */
export type MemberStatus = "pending" | "subscribed" | "unsubscribed" | "cleaned";

/** Why an address is suppressed. Determines whether it is reversible. */
export type SuppressionReason = "bounce" | "complaint" | "unsubscribe" | "manual";

// ── Provider feedback ────────────────────────────────────────────────────────

export type FeedbackType =
  | "delivered"
  | "bounced"
  | "complained"
  | "opened"
  | "clicked"
  | "unsubscribed";

/**
 * An already normalized delivery event, whatever the provider.
 * It is the only thing the rest of the kon sees.
 */
export interface DeliveryFeedback {
  provider: string;
  /**
   * Event id AT THE PROVIDER. Idempotency key: providers
   * retry webhooks aggressively, and processing a hard bounce twice
   * breaks nothing, but processing an open twice skews the
   * metrics. When the provider gives no stable id, the adapter composes
   * a deterministic one (see `syntheticId`).
   */
  externalId: string;
  type: FeedbackType;
  /** Affected address, in lowercase. */
  email: string;
  /** Id of the message that originated the event, to match it with `nl_deliveries`. */
  messageId?: string;
  /**
   * Bounces only: is it permanent?
   *
   * A HARD bounce (nonexistent mailbox) suppresses instantly. A SOFT one (full
   * mailbox, server down) is temporary and must not cost anyone their subscription —
   * suppressing on a soft bounce is how valid subscribers are lost.
   */
  hard?: boolean;
  detail?: string;
  occurredAt: string;
  raw: unknown;
}

/**
 * Feedback adapter — one per provider, unavoidably.
 *
 * Same contract as `PaymentProvider.parseWebhook` in kon-payments, and for
 * the same reason: an unverified webhook is an endpoint where anyone
 * declares that your best customer unsubscribed.
 */
export interface FeedbackAdapter {
  readonly name: string;

  /** Does it have the signing secret configured? If not, it is not even registered. */
  isConfigured(): boolean;

  /**
   * Verifies the signature and normalizes. A single POST can carry several events
   * (SES and Mailgun group them), hence the array.
   *
   * · `null`      → invalid signature. The route responds 400 and nothing is processed.
   * · `undefined` → valid signature but the event is of no interest.
   */
  parse(
    rawBody: string,
    headers: Record<string, string>
  ): Promise<DeliveryFeedback[] | null | undefined>;
}

// ── Bulk transport ───────────────────────────────────────────────────────────

/** Result per recipient. The order matches the input's. */
export interface BulkSendResult {
  email: string;
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Bulk send transport.
 *
 * The unit is still `SentMessage` —what the engine's Mailer already produces— so
 * that Mailables, layout, localization and `mail.fake()`
 * keep working unchanged. A transport does NOT render: it only delivers.
 */
export interface BulkTransport {
  readonly name: string;

  isConfigured(): boolean;

  /**
   * Recipients per API call.
   *
   * 1 = one by one (SMTP and any `MailDriver`). Resend supports 100 per
   * batch; Mailgun up to 1,000 with `recipient-variables`. The service chunks
   * according to this number, so raising it is the only speed lever.
   */
  readonly batchSize: number;

  /**
   * Ceiling of sends per second.
   *
   * It is not cosmetic: exceeding the provider's limit returns 429, and a
   * spike against a large domain makes you look like a spammer even if the list
   * is legitimate. The service respects it by waiting between batches.
   */
  readonly ratePerSecond: number;

  sendBatch(messages: SentMessage[]): Promise<BulkSendResult[]>;
}

// ── Segments ─────────────────────────────────────────────────────────────────

/**
 * A segment is a declarative QUERY, not a frozen list.
 *
 * Ghost segments by tier and by label. Here you can also filter by
 * locale, by seniority and by arbitrary attributes (jsonb), which enables
 * things that in Ghost require code: "whoever plays Diablo IV and is on the paid
 * tier and reads in Spanish".
 *
 * Storing the query and not the result means the segment is
 * always up to date at send time.
 */
export interface SegmentFilter {
  /** Allowed statuses. By default only `subscribed` — it is never relaxed. */
  status?: MemberStatus[];
  /** Slugs of the newsletters they must be subscribed to. */
  newsletters?: string[];
  /** Languages. */
  locales?: string[];
  /**
   * Paid tiers. Requires kon-payments: resolved against the active
   * subscriptions. `"free"` means "no active subscription".
   */
  tiers?: string[];
  /** Sign-up before/after an ISO date. */
  subscribedBefore?: string;
  subscribedAfter?: string;
  /** Exact match on the attributes jsonb. */
  attributes?: Record<string, string | number | boolean>;
}

// ── Campaigns ────────────────────────────────────────────────────────────────

export type CampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "failed" | "canceled";

export interface CampaignStats {
  recipients: number;
  sent: number;
  failed: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
}

export function emptyStats(): CampaignStats {
  return {
    recipients: 0,
    sent: 0,
    failed: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    bounced: 0,
    complained: 0,
    unsubscribed: 0,
  };
}

// ── Shared utilities ─────────────────────────────────────────────────────────

/** Normalizes headers to lowercase (providers vary the casing). */
export function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Constant-time comparison for signatures.
 *
 * A `===` allows timing attacks: how long it takes to fail is measured
 * to deduce the signature byte by byte. Impractical over a network, but it is the
 * standard in webhook verification and costs nothing.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Canonicalizes an address: lowercase and no spaces. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Unsubscribe headers — RFC 2369 and RFC 8058.
 *
 * NOT OPTIONAL. Since February 2024, Gmail and Yahoo require one-click unsubscribe from
 * anyone sending more than 5,000 emails a day to their domains. Without these
 * two headers the email goes to spam no matter how clean the list is.
 *
 * `List-Unsubscribe-Post` is the one that enables the one-click: the client makes a
 * POST on its own, without opening the browser or asking for confirmation. Hence
 * the unsubscribe route MUST accept POST without a session — the token authenticates it.
 *
 * It lives here and not next to the Mailables on purpose: it is a pure function over
 * headers, with no dependency on the mail engine, and so it can be tested (and
 * reused) without dragging in the host runtime.
 */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/**
 * Synthetic, deterministic id for providers that do not send a stable one.
 *
 * It must be a pure function of (type, email, moment): so a retry of the same
 * event produces the same key and the unique index discards it, while
 * two real opens at different instants do count as two.
 */
export function syntheticId(
  provider: string,
  type: string,
  email: string,
  occurredAt: string
): string {
  return `${provider}:${type}:${normalizeEmail(email)}:${occurredAt}`;
}

/**
 * The language a member gets when the sign-up does not say one, and the one the
 * portal page and widget use: `NEWSLETTER_DEFAULT_LOCALE` (e.g. `es`, `pt-BR`),
 * else `en`. Mails are translated per member locale (`newsletterTranslations`).
 */
export function defaultLocale(env: Record<string, string | undefined> = process.env): string {
  const value = env.NEWSLETTER_DEFAULT_LOCALE?.trim();
  return value && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(value) ? value : "en";
}

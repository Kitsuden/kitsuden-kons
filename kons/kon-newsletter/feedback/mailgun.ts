/**
 * Mailgun feedback — HMAC-SHA256 over timestamp + token
 * ============================================================================
 * Configuration: MAILGUN_WEBHOOK_SIGNING_KEY
 */

import { createHmac } from "node:crypto";

import {
  normalizeEmail,
  timingSafeEqual,
  type DeliveryFeedback,
  type FeedbackAdapter,
  type FeedbackType,
} from "../newsletter.types";

/** Mailgun event → normalized event map. Anything not listed is of no interest. */
const EVENT_MAP: Record<string, FeedbackType> = {
  delivered: "delivered",
  failed: "bounced",
  complained: "complained",
  opened: "opened",
  clicked: "clicked",
  unsubscribed: "unsubscribed",
};

export function mailgunFeedback(env = process.env): FeedbackAdapter {
  const signingKey = env.MAILGUN_WEBHOOK_SIGNING_KEY;

  return {
    name: "mailgun",
    isConfigured: () => Boolean(signingKey),

    async parse(rawBody: string): Promise<DeliveryFeedback[] | null | undefined> {
      let payload: MailgunPayload;
      try {
        payload = JSON.parse(rawBody) as MailgunPayload;
      } catch {
        return null;
      }

      const sig = payload.signature;
      if (!sig?.timestamp || !sig.token || !sig.signature) return null;

      // The signature is HMAC(timestamp + token). The token is single-use on
      // Mailgun's side, so it need not be stored: dedupe is done afterwards
      // by the unique index on (provider, externalId).
      const expected = createHmac("sha256", signingKey!)
        .update(sig.timestamp + sig.token)
        .digest("hex");

      if (!timingSafeEqual(expected, sig.signature)) return null;

      // 15-minute window: a signed, captured webhook must not be able to be
      // replayed indefinitely.
      const ageSeconds = Math.abs(Date.now() / 1000 - Number(sig.timestamp));
      if (!Number.isFinite(ageSeconds) || ageSeconds > 900) return null;

      const data = payload["event-data"];
      if (!data) return undefined;

      const type = EVENT_MAP[data.event];
      if (!type) return undefined;

      const email = data.recipient;
      if (!email) return undefined;

      const occurredAt = new Date((data.timestamp ?? Date.now() / 1000) * 1000).toISOString();

      return [
        {
          provider: "mailgun",
          externalId: data.id ?? `${sig.token}:${data.event}`,
          type,
          email: normalizeEmail(email),
          messageId: data.message?.headers?.["message-id"],
          // "permanent" = nonexistent mailbox → immediate suppression.
          // "temporary" = full or server down → NOT suppressed.
          hard: data.severity === "permanent",
          detail: data["delivery-status"]?.message ?? data.reason,
          occurredAt,
          raw: data,
        },
      ];
    },
  };
}

interface MailgunPayload {
  signature?: { timestamp: string; token: string; signature: string };
  "event-data"?: {
    id?: string;
    event: string;
    timestamp?: number;
    recipient?: string;
    severity?: string;
    reason?: string;
    message?: { headers?: Record<string, string> };
    "delivery-status"?: { message?: string };
  };
}

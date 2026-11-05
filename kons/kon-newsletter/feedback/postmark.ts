/**
 * Postmark feedback — shared token in the URL/header
 * ============================================================================
 * Postmark does not sign its webhooks: the official recommendation is to
 * authenticate the URL. Here an own token is required in the `X-Kitsuden-Token`
 * header (or in the `?token=` query), configured when registering the webhook.
 *
 * It is weaker than HMAC —whoever sees the URL can forge events— so:
 * the token is compared in constant time, and it should be rotated if it leaks.
 *
 * Configuration: POSTMARK_WEBHOOK_TOKEN
 */

import {
  lowerHeaders,
  normalizeEmail,
  syntheticId,
  timingSafeEqual,
  type DeliveryFeedback,
  type FeedbackAdapter,
  type FeedbackType,
} from "../newsletter.types";

const EVENT_MAP: Record<string, FeedbackType> = {
  Delivery: "delivered",
  Bounce: "bounced",
  SpamComplaint: "complained",
  Open: "opened",
  Click: "clicked",
  SubscriptionChange: "unsubscribed",
};

/** Postmark bounce types that are PERMANENT. */
const HARD_BOUNCES = new Set([
  "HardBounce",
  "BadEmailAddress",
  "ManuallyDeactivated",
  "Unsubscribe",
  "SpamNotification",
]);

export function postmarkFeedback(env = process.env): FeedbackAdapter {
  const token = env.POSTMARK_WEBHOOK_TOKEN;

  return {
    name: "postmark",
    isConfigured: () => Boolean(token),

    async parse(
      rawBody: string,
      headers: Record<string, string>
    ): Promise<DeliveryFeedback[] | null | undefined> {
      const h = lowerHeaders(headers);
      const provided = h["x-kitsuden-token"] ?? "";
      if (!provided || !timingSafeEqual(provided, token!)) return null;

      let payload: PostmarkPayload;
      try {
        payload = JSON.parse(rawBody) as PostmarkPayload;
      } catch {
        return null;
      }

      const type = EVENT_MAP[payload.RecordType ?? ""];
      if (!type) return undefined;

      const email = payload.Email ?? payload.Recipient;
      if (!email) return undefined;

      const occurredAt =
        payload.DeliveredAt ?? payload.BouncedAt ?? payload.ReceivedAt ?? new Date().toISOString();

      // SubscriptionChange also arrives on REACTIVATION: if it is not suppressed,
      // it is not an unsubscribe and must not be treated as one.
      if (payload.RecordType === "SubscriptionChange" && payload.SuppressSending === false) {
        return undefined;
      }

      return [
        {
          provider: "postmark",
          externalId: payload.MessageID ?? syntheticId("postmark", type, email, occurredAt),
          type,
          email: normalizeEmail(email),
          messageId: payload.MessageID,
          hard: HARD_BOUNCES.has(payload.Type ?? ""),
          detail: payload.Description ?? payload.Details,
          occurredAt,
          raw: payload,
        },
      ];
    },
  };
}

interface PostmarkPayload {
  RecordType?: string;
  MessageID?: string;
  Email?: string;
  Recipient?: string;
  Type?: string;
  Description?: string;
  Details?: string;
  DeliveredAt?: string;
  BouncedAt?: string;
  ReceivedAt?: string;
  SuppressSending?: boolean;
}

/**
 * Resend feedback — Svix signature
 * ============================================================================
 * Resend delegates webhooks to Svix, whose scheme is:
 *
 *   signature = base64( HMAC-SHA256( secret, "id.timestamp.body" ) )
 *
 * and the secret travels as `whsec_<base64>` — it must be decoded before
 * using it as a key, not used as the string is. The header can carry
 * SEVERAL signatures separated by spaces (key rotation); it is enough for one
 * to validate.
 *
 * Configuration: RESEND_WEBHOOK_SECRET
 */

import { createHmac } from "node:crypto";

import {
  lowerHeaders,
  normalizeEmail,
  timingSafeEqual,
  type DeliveryFeedback,
  type FeedbackAdapter,
  type FeedbackType,
} from "../newsletter.types";

const EVENT_MAP: Record<string, FeedbackType> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.opened": "opened",
  "email.clicked": "clicked",
};

export function resendFeedback(env = process.env): FeedbackAdapter {
  const secret = env.RESEND_WEBHOOK_SECRET;

  return {
    name: "resend",
    isConfigured: () => Boolean(secret),

    async parse(
      rawBody: string,
      headers: Record<string, string>
    ): Promise<DeliveryFeedback[] | null | undefined> {
      const h = lowerHeaders(headers);
      const id = h["svix-id"];
      const timestamp = h["svix-timestamp"];
      const signatures = h["svix-signature"];

      if (!id || !timestamp || !signatures) return null;

      const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return null;

      // `whsec_` is a readable prefix, not part of the key.
      const key = Buffer.from(secret!.replace(/^whsec_/, ""), "base64");
      const expected = createHmac("sha256", key)
        .update(`${id}.${timestamp}.${rawBody}`)
        .digest("base64");

      // Format: "v1,<signature> v1,<another signature>"
      const valid = signatures
        .split(" ")
        .map((part) => part.split(",")[1] ?? "")
        .some((candidate) => candidate && timingSafeEqual(candidate, expected));

      if (!valid) return null;

      let payload: ResendPayload;
      try {
        payload = JSON.parse(rawBody) as ResendPayload;
      } catch {
        return null;
      }

      const type = EVENT_MAP[payload.type];
      if (!type) return undefined;

      const email = payload.data?.to?.[0];
      if (!email) return undefined;

      return [
        {
          provider: "resend",
          // `svix-id` identifies the webhook delivery attempt and is
          // stable across retries: it serves as an idempotency key.
          externalId: id,
          type,
          email: normalizeEmail(email),
          messageId: payload.data?.email_id,
          // Resend distinguishes the subtype in `bounce.type`. Without explicit data
          // it is assumed SOFT: over-suppressing loses valid subscribers, and
          // a real hard bounce will repeat and end up suppressing.
          hard: payload.data?.bounce?.type === "Permanent",
          detail: payload.data?.bounce?.message,
          occurredAt: payload.created_at ?? new Date().toISOString(),
          raw: payload,
        },
      ];
    },
  };
}

interface ResendPayload {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[];
    bounce?: { type?: string; message?: string };
  };
}

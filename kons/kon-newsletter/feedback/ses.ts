/**
 * Amazon SES feedback — via SNS, with X.509 signature
 * ============================================================================
 * SES is the odd case: it does not sign with a shared secret but with an AWS
 * PRIVATE key, and publishes through SNS. Verifying involves downloading the
 * certificate that the message itself indicates and checking an RSA-SHA1/256 signature.
 *
 * THE TRAP: if the certificate URL is trusted without validating it, anyone
 * can sign with their own certificate and point `SigningCertURL` at their
 * server. That is why here the host is required to be a legitimate
 * `sns.<region>.amazonaws.com` BEFORE downloading anything.
 *
 * In addition SNS requires answering `SubscriptionConfirmation` to activate the
 * subscription; it is handled here because otherwise no event arrives.
 *
 * Configuration: SES_FEEDBACK_ENABLED=true
 */

import { createVerify } from "node:crypto";

import {
  normalizeEmail,
  syntheticId,
  type DeliveryFeedback,
  type FeedbackAdapter,
} from "../newsletter.types";

/** Only certificates served by AWS on a legitimate SNS host are accepted. */
const CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

/** Fields that go into the signature, in the exact order SNS requires. */
const SIGNED_FIELDS: Record<string, string[]> = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: [
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ],
  UnsubscribeConfirmation: [
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ],
};

const certCache = new Map<string, string>();

export function sesFeedback(env = process.env): FeedbackAdapter {
  return {
    name: "ses",
    // The topic ARN is needed: the signature only proves AWS sent it, not
    // that it is YOUR topic. Anyone with an AWS account publishes on their own
    // «complaints» with the addresses of your list and unsubscribed them en masse
    // (an earlier audit). Without `SES_TOPIC_ARN` nothing is accepted.
    isConfigured: () => env.SES_FEEDBACK_ENABLED === "true" && allowedTopics(env).size > 0,

    async parse(rawBody: string): Promise<DeliveryFeedback[] | null | undefined> {
      let envelope: SnsEnvelope;
      try {
        envelope = JSON.parse(rawBody) as SnsEnvelope;
      } catch {
        return null;
      }

      if (!(await verifySns(envelope))) return null;
      // Nor the subscription confirmation of another topic.
      if (!envelope.TopicArn || !allowedTopics(env).has(envelope.TopicArn)) return null;

      // Without confirming the subscription, SNS never delivers notifications.
      // It is only confirmed AFTER validating the signature.
      if (envelope.Type === "SubscriptionConfirmation" && envelope.SubscribeURL) {
        if (isAwsUrl(envelope.SubscribeURL)) {
          // Bounded (like the certificate): the webhook runs in a transaction.
          await fetch(envelope.SubscribeURL, { signal: AbortSignal.timeout(10_000) }).catch(
            () => undefined
          );
        }
        return undefined;
      }

      if (envelope.Type !== "Notification") return undefined;

      let msg: SesMessage;
      try {
        msg = JSON.parse(envelope.Message) as SesMessage;
      } catch {
        return undefined;
      }

      const occurredAt = envelope.Timestamp ?? new Date().toISOString();
      const messageId = msg.mail?.messageId;

      if (msg.notificationType === "Bounce" && msg.bounce) {
        // "Permanent" = the address does not exist. "Transient" = temporary.
        const hard = msg.bounce.bounceType === "Permanent";
        return msg.bounce.bouncedRecipients.map((r) => ({
          provider: "ses",
          externalId: syntheticId("ses", "bounced", r.emailAddress, occurredAt),
          type: "bounced" as const,
          email: normalizeEmail(r.emailAddress),
          messageId,
          hard,
          detail: r.diagnosticCode ?? msg.bounce?.bounceSubType,
          occurredAt,
          raw: msg,
        }));
      }

      if (msg.notificationType === "Complaint" && msg.complaint) {
        return msg.complaint.complainedRecipients.map((r) => ({
          provider: "ses",
          externalId: syntheticId("ses", "complained", r.emailAddress, occurredAt),
          type: "complained" as const,
          email: normalizeEmail(r.emailAddress),
          messageId,
          detail: msg.complaint?.complaintFeedbackType,
          occurredAt,
          raw: msg,
        }));
      }

      if (msg.notificationType === "Delivery" && msg.delivery) {
        return msg.delivery.recipients.map((email) => ({
          provider: "ses",
          externalId: syntheticId("ses", "delivered", email, occurredAt),
          type: "delivered" as const,
          email: normalizeEmail(email),
          messageId,
          occurredAt,
          raw: msg,
        }));
      }

      return undefined;
    },
  };
}

/**
 * `SES_TOPIC_ARN`: the ARN of the SNS topic of the SES notifications (several,
 * separated by commas). There is no time window on `Timestamp` on
 * purpose: SNS retries for days with the ORIGINAL stamp, and repeating a
 * legitimate notice does no harm (each carries its `externalId`).
 */
function allowedTopics(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    (env.SES_TOPIC_ARN ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
  );
}

function isAwsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.endsWith(".amazonaws.com");
  } catch {
    return false;
  }
}

/** Verifies the message's RSA signature against the AWS certificate. */
async function verifySns(envelope: SnsEnvelope): Promise<boolean> {
  const fields = SIGNED_FIELDS[envelope.Type ?? ""];
  if (!fields || !envelope.Signature || !envelope.SigningCertURL) return false;

  // The check that prevents anyone from signing with their own certificate.
  let certUrl: URL;
  try {
    certUrl = new URL(envelope.SigningCertURL);
  } catch {
    return false;
  }
  if (certUrl.protocol !== "https:" || !CERT_HOST.test(certUrl.hostname)) return false;

  let pem = certCache.get(certUrl.href);
  if (!pem) {
    try {
      // Bounded: the webhook route runs in a Postgres transaction, and a
      // host that does not answer cannot leave it waiting (60 s and it cuts it).
      const res = await fetch(certUrl.href, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return false;
      pem = await res.text();
      certCache.set(certUrl.href, pem);
    } catch {
      return false;
    }
  }

  // The signed text is "field\nvalue\n" for each present field, in order.
  let signed = "";
  for (const field of fields) {
    const value = (envelope as unknown as Record<string, unknown>)[field];
    if (value === undefined || value === null) continue;
    signed += `${field}\n${String(value)}\n`;
  }

  const algorithm = envelope.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  try {
    return createVerify(algorithm).update(signed, "utf8").verify(pem, envelope.Signature, "base64");
  } catch {
    return false;
  }
}

interface SnsEnvelope {
  Type?: string;
  Message: string;
  MessageId?: string;
  Timestamp?: string;
  TopicArn?: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
  Signature?: string;
  SignatureVersion?: string;
  SigningCertURL?: string;
}

interface SesMessage {
  notificationType?: string;
  mail?: { messageId?: string };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients: { emailAddress: string; diagnosticCode?: string }[];
  };
  complaint?: {
    complaintFeedbackType?: string;
    complainedRecipients: { emailAddress: string }[];
  };
  delivery?: { recipients: string[] };
}

/**
 * Postal transport — the 100% open source, self-hosted option
 * ============================================================================
 * Postal (github.com/postalserver/postal) is a full mail server
 * that you self-host: it is the free equivalent of Mailgun/Sendgrid. Its HTTP API
 * is faster than its own SMTP and returns an id per recipient, which is
 * what is needed to match the webhooks afterwards.
 *
 * WHY IT IS HERE: Ghost forces you onto Mailgun, a paid third-party service. With
 * Postal, a Kitsuden installation sends newsletters without
 * depending on any company. It is the only one of the four transports that
 * allows that.
 *
 * Honest warning: self-hosting email means taking charge of SPF, DKIM,
 * DMARC, an IP with reputation and warm-up. It is real work. It is worth it for
 * volume or data sovereignty, not to save yourself €15/month.
 *
 * Configuration: POSTAL_URL, POSTAL_API_KEY
 */

import type { SentMessage } from "@kitsuden/engine";

import type { BulkSendResult, BulkTransport } from "../newsletter.types";

export function postalTransport(env = process.env): BulkTransport {
  const baseUrl = env.POSTAL_URL?.replace(/\/$/, "");
  const apiKey = env.POSTAL_API_KEY;

  return {
    name: "postal",
    isConfigured: () => Boolean(baseUrl && apiKey),

    // Postal supports up to 50 recipients per message, but each would see
    // the others in the To:. It is sent one at a time: the list's privacy
    // is not traded for performance.
    batchSize: 1,
    ratePerSecond: Number(env.POSTAL_RATE_PER_SECOND ?? 20),

    async sendBatch(messages: SentMessage[]): Promise<BulkSendResult[]> {
      return Promise.all(
        messages.map(async (m): Promise<BulkSendResult> => {
          const email = m.to[0] ?? "";
          try {
            const res = await fetch(`${baseUrl}/api/v1/send/message`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Server-API-Key": apiKey!,
              },
              body: JSON.stringify({
                to: [email],
                from: m.from,
                subject: m.subject,
                html_body: m.html,
                plain_body: m.text,
                reply_to: m.replyTo,
                headers: m.headers,
                tag: m.tag,
              }),
            });

            if (!res.ok) {
              return { email, ok: false, error: `Postal ${res.status}` };
            }

            // Postal responds 200 even on error: the real status is inside.
            const body = (await res.json().catch(() => null)) as {
              status?: string;
              data?: { message_id?: string; messages?: Record<string, { id: number }> };
            } | null;

            if (body?.status !== "success") {
              return { email, ok: false, error: `Postal: ${body?.status ?? "unreadable response"}` };
            }

            return { email, ok: true, messageId: body.data?.message_id };
          } catch (err) {
            return {
              email,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })
      );
    },
  };
}

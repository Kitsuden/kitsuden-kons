/**
 * Native Resend transport — batches of 100
 * ============================================================================
 * Optimization over the generic transport: `/emails/batch` accepts 100
 * messages per call, each with its own recipient and content. For
 * a list of 50,000 that is 500 calls instead of 50,000 SMTP connections.
 *
 * Configuration: RESEND_API_KEY
 */

import type { SentMessage } from "@kitsuden/engine";

import type { BulkSendResult, BulkTransport } from "../newsletter.types";

const BATCH_ENDPOINT = "https://api.resend.com/emails/batch";

export function resendTransport(env = process.env): BulkTransport {
  const apiKey = env.RESEND_API_KEY;

  return {
    name: "resend",
    isConfigured: () => Boolean(apiKey),
    batchSize: 100,
    ratePerSecond: Number(env.RESEND_RATE_PER_SECOND ?? 10),

    async sendBatch(messages: SentMessage[]): Promise<BulkSendResult[]> {
      const emails = messages.map((m) => m.to[0] ?? "");

      const payload = messages.map((m) => ({
        from: m.from,
        to: m.to,
        subject: m.subject,
        html: m.html,
        text: m.text,
        reply_to: m.replyTo,
        // List-Unsubscribe travels here. It is what makes the send
        // legitimate in the eyes of Gmail and Yahoo.
        headers: m.headers,
        tags: m.tag ? [{ name: "campaign", value: m.tag }] : undefined,
      }));

      let res: Response;
      try {
        res = await fetch(BATCH_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        // Network failure: the WHOLE batch stays pending, not lost. The service
        // retries only these rows because their status is still `pending`.
        const error = err instanceof Error ? err.message : String(err);
        return emails.map((email) => ({ email, ok: false, error }));
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const error = `Resend ${res.status}: ${detail.slice(0, 200)}`;
        return emails.map((email) => ({ email, ok: false, error }));
      }

      const body = (await res.json().catch(() => null)) as { data?: { id: string }[] } | null;
      const ids = body?.data ?? [];

      // Resend returns the ids in the same order they were sent.
      return emails.map((email, i) => ({
        email,
        ok: true,
        messageId: ids[i]?.id,
      }));
    },
  };
}

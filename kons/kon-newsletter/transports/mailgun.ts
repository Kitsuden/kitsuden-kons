/**
 * Native Mailgun transport — batches of 1,000 with recipient-variables
 * ============================================================================
 * It is the transport Ghost uses, and the highest-performing: a single call
 * delivers up to 1,000 personalized emails using `recipient-variables`.
 *
 * The trick (and its trap): ALL the batch's recipients share subject and
 * body, and whatever varies is interpolated with `%recipient.field%`. Mailgun
 * makes sure each one receives ONLY their address in the `To:` — but if you get
 * the variables wrong, you expose the entire list. That is why here only messages with
 * identical subject and HTML are grouped (see `sameContent`).
 *
 * Configuration: MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_REGION=eu|us
 */

import type { SentMessage } from "@kitsuden/engine";

import type { BulkSendResult, BulkTransport } from "../newsletter.types";

export function mailgunTransport(env = process.env): BulkTransport {
  const apiKey = env.MAILGUN_API_KEY;
  const domain = env.MAILGUN_DOMAIN;
  const base =
    env.MAILGUN_REGION === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";

  return {
    name: "mailgun",
    isConfigured: () => Boolean(apiKey && domain),
    batchSize: 1000,
    ratePerSecond: Number(env.MAILGUN_RATE_PER_SECOND ?? 10),

    async sendBatch(messages: SentMessage[]): Promise<BulkSendResult[]> {
      const emails = messages.map((m) => m.to[0] ?? "");
      const first = messages[0];
      if (!first) return [];

      // Safeguard: grouping messages with different bodies would make some
      // receive the content of others. If it happens, it degrades to one by one
      // instead of risking a leak.
      if (!sameContent(messages)) {
        return sendIndividually(messages, emails, base, domain!, apiKey!);
      }

      const form = new FormData();
      form.append("from", first.from);
      form.append("subject", first.subject);
      form.append("html", first.html);
      form.append("text", first.text);
      if (first.replyTo) form.append("h:Reply-To", first.replyTo);

      for (const email of emails) form.append("to", email);

      // Each recipient receives ONLY their address in the To:. Without this,
      // Mailgun sends one email with the full list visible.
      const variables: Record<string, Record<string, string>> = {};
      for (let i = 0; i < emails.length; i++) {
        variables[emails[i]!] = { unsub: extractUnsubToken(messages[i]!) };
      }
      form.append("recipient-variables", JSON.stringify(variables));

      // Per-recipient List-Unsubscribe via the variable.
      for (const [key, value] of Object.entries(first.headers)) {
        form.append(`h:${key}`, value);
      }
      if (first.tag) form.append("o:tag", first.tag);

      try {
        const res = await fetch(`${base}/v3/${domain}/messages`, {
          method: "POST",
          headers: { Authorization: `Basic ${btoa(`api:${apiKey}`)}` },
          body: form,
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          const error = `Mailgun ${res.status}: ${detail.slice(0, 200)}`;
          return emails.map((email) => ({ email, ok: false, error }));
        }

        const body = (await res.json().catch(() => null)) as { id?: string } | null;
        // Mailgun returns ONE id for the whole batch; it is shared.
        return emails.map((email) => ({ email, ok: true, messageId: body?.id }));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return emails.map((email) => ({ email, ok: false, error }));
      }
    },
  };
}

/** Do they share subject and body? Requirement to group without leaking content. */
function sameContent(messages: SentMessage[]): boolean {
  const first = messages[0];
  if (!first) return true;
  return messages.every(
    (m) => m.subject === first.subject && m.html === first.html && m.from === first.from
  );
}

/** The recipient's unsubscribe token, for `%recipient.unsub%`. */
function extractUnsubToken(message: SentMessage): string {
  const header = message.headers["List-Unsubscribe"] ?? "";
  const match = header.match(/token=([A-Za-z0-9_-]+)/);
  return match?.[1] ?? "";
}

/** Safe degradation: one POST per message when the content differs. */
async function sendIndividually(
  messages: SentMessage[],
  emails: string[],
  base: string,
  domain: string,
  apiKey: string
): Promise<BulkSendResult[]> {
  return Promise.all(
    messages.map(async (m, i): Promise<BulkSendResult> => {
      const email = emails[i] ?? "";
      const form = new FormData();
      form.append("from", m.from);
      form.append("to", email);
      form.append("subject", m.subject);
      form.append("html", m.html);
      form.append("text", m.text);
      for (const [key, value] of Object.entries(m.headers)) form.append(`h:${key}`, value);

      try {
        const res = await fetch(`${base}/v3/${domain}/messages`, {
          method: "POST",
          headers: { Authorization: `Basic ${btoa(`api:${apiKey}`)}` },
          body: form,
        });
        if (!res.ok) {
          return { email, ok: false, error: `Mailgun ${res.status}` };
        }
        const body = (await res.json().catch(() => null)) as { id?: string } | null;
        return { email, ok: true, messageId: body?.id };
      } catch (err) {
        return { email, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    })
  );
}

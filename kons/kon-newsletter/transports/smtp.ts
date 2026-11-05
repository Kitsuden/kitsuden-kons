/**
 * Generic transport — wraps any engine `MailDriver`
 * ============================================================================
 *
 * THIS IS THE TRANSPORT THAT MATTERS. The other three are optimizations.
 *
 * Every mail provider in the world speaks SMTP: Mailgun, Resend,
 * Postmark, SES, Sendgrid, Brevo, and the self-hosted OSS ones (Listmonk, Postal,
 * Haraka). By wrapping the `MailDriver` the engine already has, this single
 * file supports all of them without writing a line per provider — and along the way
 * inherits `mail.fake()`, so campaigns can be tested whole without
 * network and without SMTP.
 *
 * Ghost, by comparison, requires Mailgun specifically.
 *
 * The trade-off is speed: SMTP delivers one at a time (`batchSize`
 * 1). For small and medium lists it doesn't matter; from tens of thousands
 * on, a native batching transport pays off.
 */

import type { MailDriver, SentMessage } from "@kitsuden/engine";

import type { BulkSendResult, BulkTransport } from "../newsletter.types";

export interface DriverTransportOptions {
  /**
   * Sends per second. The default is deliberately conservative: a home
   * SMTP or a freshly set up Postal cannot take more, and exceeding it produces
   * disconnections that look like delivery failures.
   */
  ratePerSecond?: number;
  /** How many sends to launch in parallel. One by one, but not sequentially. */
  concurrency?: number;
}

/**
 * Adapts a `MailDriver` to `BulkTransport`.
 *
 * @param driver Any engine driver: smtp, resend, log or memory.
 */
export function driverTransport(
  driver: MailDriver,
  options: DriverTransportOptions = {}
): BulkTransport {
  const ratePerSecond = options.ratePerSecond ?? 10;
  const concurrency = Math.max(1, options.concurrency ?? 4);

  return {
    name: `driver:${driver.name}`,

    // A driver is always ready: if the user configured it wrong, it will fail
    // on send and that shows in `nl_deliveries.error`, which is where it should show.
    isConfigured: () => true,

    batchSize: 1,
    ratePerSecond,

    async sendBatch(messages: SentMessage[]): Promise<BulkSendResult[]> {
      const results: BulkSendResult[] = new Array(messages.length);

      // `concurrency` windows: neither sequential (painfully slow) nor all at once
      // (brings SMTP down). Throttling between batches is applied by the service.
      for (let i = 0; i < messages.length; i += concurrency) {
        const window = messages.slice(i, i + concurrency);

        const settled = await Promise.all(
          window.map(async (message, offset): Promise<BulkSendResult> => {
            const email = message.to[0] ?? "";
            try {
              const { messageId } = await driver.send(message);
              return { email, ok: true, messageId };
            } catch (err) {
              return {
                email,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              };
            } finally {
              void offset;
            }
          })
        );

        for (let j = 0; j < settled.length; j++) results[i + j] = settled[j]!;
      }

      return results;
    },
  };
}

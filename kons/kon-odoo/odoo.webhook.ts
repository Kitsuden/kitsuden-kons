/**
 * Odoo — change notices, in and out
 * ============================================================================
 *
 * IN. Odoo tells this kon what changed:
 *
 *   POST /api/odoo/webhook
 *   X-Odoo-Signature: sha256=<hex HMAC-SHA256 of the raw body, with the shared secret>
 *   { "id": "<unique per notice>",
 *     "changes": [ { "model": "product.template", "ids": [12, 13] },
 *                  { "model": "product.product",  "ids": [40] },
 *                  { "model": "sale.order",       "ids": [7] },
 *                  { "model": "account.payment",  "ids": [3] } ] }
 *
 * A notice says WHAT changed, never the new values: those are read back from Odoo with the
 * key, so a forged or replayed notice can only cause a read. It is still signed, because an
 * unsigned one would let anyone make this kon hammer Odoo.
 *
 * A stock change is a notice about the variant (`product.product`) whose quantity moved.
 *
 * OUT. The site's cache is told which products changed, signed the same way with its own
 * secret (`X-Inti-Signature`), as `{ "source": "<name>", "ids": ["12", "13"] }`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { AppError, PermanentError, queue } from "@kitsuden/engine";
import { z } from "@kitsuden/engine/zod";
import type { KonContext } from "@kitsuden/shared";
import { eq } from "drizzle-orm";

import { odooNotices, odooSettings } from "./odoo.schema";
import { dbOf, loadSettings, openSecret, QUEUES } from "./odoo.state";
import { BATCH } from "./odoo.sync";

export const SIGNATURE_HEADER = "x-odoo-signature";
export const PURGE_SIGNATURE_HEADER = "x-inti-signature";

/** A notice larger than this is refused before it is read as JSON. */
export const MAX_NOTICE_BYTES = 256 * 1024;

export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export function validSignature(body: string, header: string | null | undefined, secret: string): boolean {
  const given = /^sha256=([0-9a-f]{64})$/i.exec(header?.trim() ?? "")?.[1];
  if (!given) return false;
  const expected = createHmac("sha256", secret).update(body, "utf8").digest();
  return timingSafeEqual(Buffer.from(given, "hex"), expected);
}

/** Models a notice may name, and the job each one becomes. */
const JOBS = {
  "product.template": "templates",
  "product.product": "variants",
  "product.category": "categories",
  "sale.order": "orders",
  "account.payment": "payments",
} as const;

const Notice = z.object({
  id: z.string().min(1).max(120),
  changes: z
    .array(
      z.object({
        model: z.enum(Object.keys(JOBS) as [keyof typeof JOBS, ...(keyof typeof JOBS)[]]),
        ids: z.array(z.number().int().positive()).max(5000),
      })
    )
    .max(50),
});

export interface NoticeResult {
  accepted: number;
  duplicate: boolean;
}

/**
 * Checks a notice and queues the reads it asks for. Nothing is read from Odoo here: the answer
 * to Odoo is immediate, and a slow or failing read is the queue's to retry.
 */
export async function receiveNotice(
  ctx: KonContext,
  rawBody: string,
  signature: string | null | undefined
): Promise<NoticeResult> {
  if (Buffer.byteLength(rawBody, "utf8") > MAX_NOTICE_BYTES) {
    throw AppError.badRequest("The notice is too large.");
  }

  // The caller is nobody: the settings, the notice log and the queue are the system's.
  const asSystem = ctx.db.asSystem ?? (<T>(fn: () => Promise<T>) => fn());
  const sealed = await asSystem(async () => (await loadSettings(dbOf(ctx))).webhookSecret);
  const secret = await openSecret(ctx, sealed, "verify a change notice from Odoo");
  if (!secret) throw AppError.conflict("No webhook secret is stored: notices cannot be verified.");
  if (!validSignature(rawBody, signature, secret)) throw AppError.unauthenticated("Invalid signature.");

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw AppError.badRequest("The notice is not JSON.");
  }
  const parsed = Notice.safeParse(json);
  if (!parsed.success) throw AppError.badRequest("The notice does not have the expected shape.");
  const notice = parsed.data;

  return asSystem(async () => {
    const db = dbOf(ctx);
    const total = notice.changes.reduce((sum, change) => sum + change.ids.length, 0);
    const [fresh] = await db
      .insert(odooNotices)
      .values({ noticeId: notice.id, changes: total })
      .onConflictDoNothing()
      .returning({ id: odooNotices.id });
    // Odoo retries a notice it got no answer for: the second copy is acknowledged and dropped.
    if (!fresh) return { accepted: 0, duplicate: true };

    let part = 0;
    for (const change of notice.changes) {
      const ids = [...new Set(change.ids)];
      if (change.model === "product.category") {
        await queue.dispatch(QUEUES.sync, "categories", {}, { dedupeKey: `notice:${notice.id}:categories` });
        continue;
      }
      for (let i = 0; i < ids.length; i += BATCH) {
        await queue.dispatch(
          QUEUES.sync,
          JOBS[change.model],
          { ids: ids.slice(i, i + BATCH) },
          { dedupeKey: `notice:${notice.id}:${part++}`, attempts: 5 }
        );
      }
    }
    await db.update(odooSettings).set({ lastNoticeAt: new Date() }).where(eq(odooSettings.id, 1));
    return { accepted: total, duplicate: false };
  });
}

/** A purge address must be a plain http(s) URL with no credentials in it. */
export function purgeUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "The purge address is not a URL.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "The purge address must be http or https.";
  if (url.username || url.password) return "The purge address must not carry credentials.";
  return null;
}

type Send = (url: string, init: RequestInit) => Promise<Response>;
let send: Send = (url, init) => fetch(url, init);

/** Tests answer for the site here. `null` puts the network back. */
export function setPurgeNetworkForTests(next: Send | null): void {
  send = next ?? ((url, init) => fetch(url, init));
}

/**
 * Tells the site which products changed. Thrown errors are retried by the queue; a refusal that
 * will not change by trying again (a bad secret, a wrong address) is not.
 */
export async function sendPurge(ctx: KonContext, odooIds: number[]): Promise<void> {
  const settings = await loadSettings(dbOf(ctx));
  if (!settings.purgeUrl || odooIds.length === 0) return;
  const secret = await openSecret(ctx, settings.purgeSecret, "sign a purge notice for the site");
  if (!secret) throw new PermanentError("A purge address is set but no purge secret is stored.");

  const body = JSON.stringify({ source: settings.purgeSource, ids: [...new Set(odooIds)].map(String) });
  const response = await send(settings.purgeUrl, {
    method: "POST",
    headers: { "content-type": "application/json", [PURGE_SIGNATURE_HEADER]: signBody(body, secret) },
    body,
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (response.ok) return;
  if (response.status >= 400 && response.status < 500 && response.status !== 429 && response.status !== 408) {
    throw new PermanentError(`The site refused the purge notice (${response.status}).`);
  }
  throw new Error(`The site answered ${response.status} to the purge notice.`);
}

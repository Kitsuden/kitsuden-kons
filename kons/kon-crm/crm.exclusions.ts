/**
 * One "do not contact" for the whole installation
 * ============================================================================
 *
 * The CRM keeps its exclusion list (`crm_suppressions`) and the newsletter its suppression list
 * (`nl_suppressions`). Someone excluded here could still get a campaign there, and someone who
 * unsubscribed there could still be captured here. Neither kon imports the other, so they tell each other
 * through events:
 *
 *   this kon says   crm:address.suppressed           { kind, value }    email or domain
 *                   crm:address.unsuppressed         { kind, value }
 *   this kon hears  newsletter:address.suppressed    { email, reason }  unsubscribe, complaint or manual
 *                   newsletter:address.unsuppressed  { email }
 *
 * What comes from the newsletter is stored with `created_by: "kon-newsletter"`, and it is announced to
 * nobody (no loop). When the newsletter takes an address off its list, only a row that came from the
 * newsletter is removed here: an exclusion a person added in the CRM stays.
 */

import type { KonContext } from "@kitsuden/shared";
import { and, eq } from "drizzle-orm";

import type { CrmDb } from "./crm.db";
import { normalizeEmail } from "./crm.dedupe";
import { crmSuppressions } from "./crm.schema";

export const FROM_NEWSLETTER = "kon-newsletter";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `newsletter:address.suppressed` → excluded here too, marked as the newsletter's. */
export async function onNewsletterSuppressed(db: CrmDb, payload: unknown): Promise<boolean> {
  const p = (payload ?? {}) as { email?: string; reason?: string };
  const value = normalizeEmail(p.email);
  if (!EMAIL.test(value)) return false;
  await db
    .insert(crmSuppressions)
    .values({ kind: "email", value, reason: `newsletter: ${String(p.reason ?? "suppressed").slice(0, 40)}`, createdBy: FROM_NEWSLETTER })
    .onConflictDoNothing();
  return true;
}

/** `newsletter:address.unsuppressed` → off this list only if the newsletter is why it was on it. */
export async function onNewsletterUnsuppressed(db: CrmDb, payload: unknown): Promise<boolean> {
  const value = normalizeEmail((payload as { email?: string } | null)?.email);
  if (!value) return false;
  const removed = await db
    .delete(crmSuppressions)
    .where(and(eq(crmSuppressions.kind, "email"), eq(crmSuppressions.value, value), eq(crmSuppressions.createdBy, FROM_NEWSLETTER)))
    .returning();
  return removed.length > 0;
}

const listening = new WeakSet<object>();

export function listenToNewsletterExclusions(ctx: KonContext): void {
  if (!ctx.events?.on || listening.has(ctx.events)) return;
  listening.add(ctx.events);
  const run = (fn: (db: CrmDb) => Promise<unknown>) => {
    const job = async () => {
      const asSystem = ctx.db.asSystem ?? (<T>(f: () => Promise<T>) => f());
      try {
        await asSystem(() => fn(ctx.db.instance as CrmDb));
      } catch (err) {
        ctx.logger.warn("[CRM] could not mirror a newsletter suppression", { error: err instanceof Error ? err.message : String(err) });
      }
    };
    void (ctx.db.background ? ctx.db.background(job) : job());
  };
  ctx.events.on("newsletter:address.suppressed", (data: unknown) => run((db) => onNewsletterSuppressed(db, data)));
  ctx.events.on("newsletter:address.unsuppressed", (data: unknown) => run((db) => onNewsletterUnsuppressed(db, data)));
}

/**
 * One "do not contact" for the whole installation
 * ============================================================================
 *
 * The newsletter keeps its suppression list (`nl_suppressions`) and the CRM its exclusion list
 * (`crm_suppressions`). Someone who unsubscribed here could still be captured and written to there, and
 * the reverse. Neither kon imports the other, so they tell each other through events:
 *
 *   this kon says   newsletter:address.suppressed    { email, reason }    unsubscribe, complaint or manual
 *                   newsletter:address.unsuppressed  { email }            an admin took it off the list
 *   this kon hears  crm:address.suppressed           { kind, value }      only `kind: "email"`
 *                   crm:address.unsuppressed         { kind, value }
 *
 * What comes from the CRM is stored with `source: "kon-crm"`, and it is announced to nobody (no loop).
 * When the CRM takes an address off its list, only a row that came from the CRM is removed here: a real
 * unsubscribe or a bounce stays.
 *
 * A bounce is NOT announced: it says the mailbox does not work, not that the person asked to be left
 * alone. A domain excluded in the CRM is not mirrored either: this list is by address.
 */

import type { KonContext } from "@kitsuden/shared";
import { and, eq } from "drizzle-orm";

import { nlSuppressions } from "./newsletter.schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a Drizzle instance or transaction
type Db = any;

export const FROM_CRM = "kon-crm";
const ANNOUNCED = new Set(["unsubscribe", "complaint", "manual"]);

let sink: { emit(name: string, data: unknown): void } | null = null;

/** Set when the kon's routes are built and at startup. */
export function useNewsletterEvents(events: { emit(name: string, data: unknown): void } | undefined | null): void {
  sink = events ?? null;
}

export function announceSuppressed(email: string, reason: string, source: string): void {
  if (source === FROM_CRM || !ANNOUNCED.has(reason)) return;
  sink?.emit("newsletter:address.suppressed", { email, reason });
}

export function announceUnsuppressed(email: string): void {
  sink?.emit("newsletter:address.unsuppressed", { email });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** `crm:address.suppressed` → on this list too, marked as the CRM's. */
export async function onCrmSuppressed(db: Db, payload: unknown): Promise<boolean> {
  const p = (payload ?? {}) as { kind?: string; value?: string };
  const email = clean(p.value);
  if (p.kind !== "email" || !EMAIL.test(email)) return false;
  await db.insert(nlSuppressions).values({ email, reason: "manual", source: FROM_CRM, detail: "Excluded in the CRM" }).onConflictDoNothing();
  return true;
}

/** `crm:address.unsuppressed` → off this list only if the CRM is why it was on it. */
export async function onCrmUnsuppressed(db: Db, payload: unknown): Promise<boolean> {
  const p = (payload ?? {}) as { kind?: string; value?: string };
  const email = clean(p.value);
  if (p.kind !== "email" || !email) return false;
  const removed = await db
    .delete(nlSuppressions)
    .where(and(eq(nlSuppressions.email, email), eq(nlSuppressions.source, FROM_CRM)))
    .returning({ id: nlSuppressions.id });
  return removed.length > 0;
}

const listening = new WeakSet<object>();

export function listenToCrmExclusions(ctx: KonContext): void {
  if (!ctx.events?.on || listening.has(ctx.events)) return;
  listening.add(ctx.events);
  const run = (fn: (db: Db) => Promise<unknown>) => {
    const job = async () => {
      const asSystem = ctx.db.asSystem ?? (<T>(f: () => Promise<T>) => f());
      try {
        await asSystem(() => fn(ctx.db.instance));
      } catch (err) {
        ctx.logger.warn("[Newsletter] could not mirror a CRM exclusion", { error: err instanceof Error ? err.message : String(err) });
      }
    };
    void (ctx.db.background ? ctx.db.background(job) : job());
  };
  ctx.events.on("crm:address.suppressed", (data: unknown) => run((db) => onCrmSuppressed(db, data)));
  ctx.events.on("crm:address.unsuppressed", (data: unknown) => run((db) => onCrmUnsuppressed(db, data)));
}

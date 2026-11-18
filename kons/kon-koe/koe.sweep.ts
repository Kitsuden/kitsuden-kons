/**
 * The sweep: what happens because time passed
 * ============================================================================
 *
 * Once a minute, in every API process:
 *
 *   snoozes      a snoozed conversation whose date came wakes: to whoever had it, else to the queue
 *   windows      a free window closing within 2 h → a notice to the assignee and `koe:window.expiring`,
 *                once per window; a window that closed → `koe:window.closed`, once
 *   SLAs         first response or resolution past due → `sla_breached`, `koe:sla.breached`, notice to leads
 *   inactivity   open conversations quiet for the channel's `autoResolveHours` resolve themselves
 *   promises     payment promises past their date become broken (koe.sales.ts)
 *   campaigns    scheduled ones start; running ones get a batch job (koe.campaigns.ts)
 *   sequences    due steps get a job (koe.sequences.ts)
 *   housekeeping notices older than 30 days, processed webhook bodies older than 7 days
 *
 * Several API replicas run it at once, so every effect is CLAIMED before it happens: a conditional UPDATE
 * … RETURNING (window warned, SLA breached, promise broken, campaign started) or a row lock in a short
 * transaction around the state change (wake, auto-resolve: the second replica waits, then finds the
 * conversation already moved and the state machine refuses). Sending is left to queue jobs, which are
 * idempotent on their own. The interval is unref'd and never overlaps itself in one process.
 *
 * `sweepOnce(ctx, now)` is the whole thing, for tests and for a host that prefers its own scheduler.
 */

import { asSystem, queue } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, eq, inArray, isNotNull, isNull, lt, ne, notInArray, sql } from "drizzle-orm";

import { campaignTick } from "./koe.campaigns";
import { dbOf, emit, QUEUES, type Db } from "./koe.common";
import { autoAssign, changeState } from "./koe.conversations";
import { pruneNotices } from "./koe.notify";
import { breakOverduePromises } from "./koe.sales";
import { koeChannels, koeConversations, koeWebhookEvents, type ChannelKind, type ChannelSettings, type Conversation } from "./koe.schema";
import { sequenceTick, stopOnReply } from "./koe.sequences";
import { windowOf } from "./koe.window";

const HOUR = 3_600_000;
const WARN_BEFORE_MS = 2 * HOUR;
const BATCH = 200;
export const SWEEP_MS = 60_000;

export interface SweepReport {
  woken: number;
  windowsExpiring: number;
  windowsClosed: number;
  slaBreached: number;
  autoResolved: number;
  promisesBroken: number;
  campaigns: number;
  sequenceSteps: number;
  errors: string[];
}

/** A short transaction, so `changeState`'s row lock holds until the change is written. */
async function inTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return typeof db.transaction === "function" ? db.transaction((tx: Db) => fn(tx)) : fn(db);
}

const isConflict = (err: unknown) => (err as { status?: number } | null)?.status === 409 || (err as { status?: number } | null)?.status === 422;

async function wakeSnoozed(ctx: KonContext, db: Db, now: Date): Promise<number> {
  const due = (await db
    .select({ id: koeConversations.id, assigneeId: koeConversations.assigneeId })
    .from(koeConversations)
    .where(and(eq(koeConversations.state, "snoozed"), sql`${koeConversations.snoozedUntil} <= ${now.toISOString()}`))
    .limit(BATCH)) as Array<{ id: string; assigneeId: string | null }>;
  let n = 0;
  for (const d of due) {
    let woke: Conversation | null = null;
    for (const to of d.assigneeId ? (["human", "queued"] as const) : (["queued"] as const)) {
      try {
        woke = await inTransaction(db, (tx) => changeState(ctx, tx, d.id, { trigger: "wake", to, reason: "the snooze ended" }, { kind: "system" }));
        break;
      } catch (err) {
        // Another replica woke it, or the person who had it left koe: try the queue, else move on.
        if (!isConflict(err)) throw err;
      }
    }
    if (!woke) continue;
    n++;
    if (woke.state === "queued") woke = await autoAssign(ctx, db, woke);
    if (woke.state === "human" && woke.assigneeId) {
      await queue.dispatch(QUEUES.notify, "user", { userId: woke.assigneeId, kind: "snooze", title: "A snoozed conversation is back", conversationId: woke.id }, { attempts: 3 });
    } else if (woke.state === "queued") {
      await queue.dispatch(QUEUES.notify, "queued", { teamId: woke.teamId, conversationId: woke.id }, { attempts: 3 });
    }
  }
  return n;
}

async function windows(ctx: KonContext, db: Db, now: Date): Promise<{ expiring: number; closed: number }> {
  const out = { expiring: 0, closed: 0 };
  const kinds = new Map<string, ChannelKind>(((await db.select({ id: koeChannels.id, kind: koeChannels.kind }).from(koeChannels)) as Array<{ id: string; kind: ChannelKind }>).map((c) => [c.id, c.kind]));
  type Row = Pick<Conversation, "id" | "channelId" | "assigneeId" | "windowExpiresAt" | "lastInboundAt" | "freeEntryUntil">;
  const cols = { id: koeConversations.id, channelId: koeConversations.channelId, assigneeId: koeConversations.assigneeId, windowExpiresAt: koeConversations.windowExpiresAt, lastInboundAt: koeConversations.lastInboundAt, freeEntryUntil: koeConversations.freeEntryUntil };

  // Closing soon: warned once per window (an inbound message clears window_warned_at).
  const soon = (await db
    .select(cols)
    .from(koeConversations)
    .where(and(ne(koeConversations.state, "resolved"), isNull(koeConversations.windowWarnedAt), sql`${koeConversations.windowExpiresAt} > ${now.toISOString()}`, sql`${koeConversations.windowExpiresAt} <= ${new Date(now.getTime() + WARN_BEFORE_MS).toISOString()}`))
    .limit(BATCH)) as Row[];
  for (const c of soon) {
    const kind = kinds.get(c.channelId);
    if (!kind) continue;
    const w = windowOf(kind, c.lastInboundAt, c.freeEntryUntil, now);
    if (!w.open || !w.expiresAt || w.expiresAt.getTime() - now.getTime() > WARN_BEFORE_MS) continue; // a free-entry point keeps it open longer
    const claimed = (await db
      .update(koeConversations)
      .set({ windowWarnedAt: now })
      .where(and(eq(koeConversations.id, c.id), isNull(koeConversations.windowWarnedAt)))
      .returning({ id: koeConversations.id })) as unknown[];
    if (!claimed.length) continue;
    out.expiring++;
    emit(ctx, "window.expiring", { conversationId: c.id, channelId: c.channelId, expiresAt: w.expiresAt.toISOString(), assigneeId: c.assigneeId });
    if (c.assigneeId) {
      const minutes = Math.max(1, Math.round((w.expiresAt.getTime() - now.getTime()) / 60_000));
      await queue.dispatch(QUEUES.notify, "user", { userId: c.assigneeId, kind: "window", title: `The window to answer closes in ${minutes >= 60 ? `${Math.round(minutes / 60)} h` : `${minutes} min`}`, conversationId: c.id }, { attempts: 3 });
    }
  }

  // Closed: said once; clearing the reminder index is the claim (the next inbound message sets it again).
  const closed = (await db
    .select(cols)
    .from(koeConversations)
    .where(and(ne(koeConversations.state, "resolved"), isNotNull(koeConversations.windowExpiresAt), sql`${koeConversations.windowExpiresAt} <= ${now.toISOString()}`))
    .limit(BATCH)) as Row[];
  for (const c of closed) {
    const kind = kinds.get(c.channelId);
    if (kind && windowOf(kind, c.lastInboundAt, c.freeEntryUntil, now).open) continue;
    const claimed = (await db
      .update(koeConversations)
      .set({ windowExpiresAt: null })
      .where(and(eq(koeConversations.id, c.id), sql`${koeConversations.windowExpiresAt} = ${c.windowExpiresAt!.toISOString()}`))
      .returning({ id: koeConversations.id })) as unknown[];
    if (!claimed.length) continue;
    out.closed++;
    emit(ctx, "window.closed", { conversationId: c.id, channelId: c.channelId });
  }
  return out;
}

async function slas(ctx: KonContext, db: Db, now: Date): Promise<number> {
  const at = now.toISOString();
  const returning = { id: koeConversations.id, channelId: koeConversations.channelId, teamId: koeConversations.teamId, assigneeId: koeConversations.assigneeId };
  type Row = { id: string; channelId: string; teamId: string | null; assigneeId: string | null };
  const first = (await db
    .update(koeConversations)
    .set({ slaBreached: true })
    .where(and(eq(koeConversations.slaBreached, false), inArray(koeConversations.state, ["queued", "human"]), isNull(koeConversations.firstRespondedAt), sql`${koeConversations.firstResponseDueAt} <= ${at}`))
    .returning(returning)) as Row[];
  const resolution = (await db
    .update(koeConversations)
    .set({ slaBreached: true })
    .where(and(eq(koeConversations.slaBreached, false), notInArray(koeConversations.state, ["resolved", "snoozed"]), sql`${koeConversations.resolutionDueAt} <= ${at}`))
    .returning(returning)) as Row[];
  for (const [kind, rows] of [["first_response", first], ["resolution", resolution]] as const) {
    for (const r of rows) {
      emit(ctx, "sla.breached", { conversationId: r.id, channelId: r.channelId, teamId: r.teamId, kind, assigneeId: r.assigneeId });
      await queue.dispatch(QUEUES.notify, "leads", { kind: "sla", title: kind === "first_response" ? "A conversation missed its first-response time" : "A conversation missed its resolution time", conversationId: r.id }, { attempts: 3 });
    }
  }
  return first.length + resolution.length;
}

async function autoResolve(ctx: KonContext, db: Db, now: Date): Promise<number> {
  const channels = (await db.select({ id: koeChannels.id, settings: koeChannels.settings }).from(koeChannels).where(sql`(${koeChannels.settings}->>'autoResolveHours') IS NOT NULL`)) as Array<{ id: string; settings: ChannelSettings }>;
  let n = 0;
  for (const ch of channels) {
    const hours = Number(ch.settings.autoResolveHours);
    if (!Number.isFinite(hours) || hours <= 0) continue;
    const cutoff = new Date(now.getTime() - hours * HOUR).toISOString();
    const idle = (await db
      .select({ id: koeConversations.id })
      .from(koeConversations)
      .where(and(eq(koeConversations.channelId, ch.id), inArray(koeConversations.state, ["bot", "queued", "human"]), sql`coalesce(${koeConversations.lastMessageAt}, ${koeConversations.updatedAt}) < ${cutoff}`))
      .limit(BATCH)) as Array<{ id: string }>;
    for (const c of idle) {
      try {
        await inTransaction(db, (tx) => changeState(ctx, tx, c.id, { trigger: "resolve", reason: `no activity for ${hours} h` }, { kind: "system" }));
        n++;
      } catch (err) {
        if (!isConflict(err)) throw err;
      }
    }
  }
  return n;
}

async function housekeeping(db: Db, now: Date): Promise<void> {
  await pruneNotices(db);
  await db.delete(koeWebhookEvents).where(and(isNotNull(koeWebhookEvents.processedAt), lt(koeWebhookEvents.processedAt, new Date(now.getTime() - 7 * 24 * HOUR))));
}

/** One pass of everything time-driven. Each part fails on its own: the others still run. */
export async function sweepOnce(ctx: KonContext, now: Date = new Date()): Promise<SweepReport> {
  const db = dbOf(ctx);
  const report: SweepReport = { woken: 0, windowsExpiring: 0, windowsClosed: 0, slaBreached: 0, autoResolved: 0, promisesBroken: 0, campaigns: 0, sequenceSteps: 0, errors: [] };
  const part = async (name: string, fn: () => Promise<void>) => {
    try {
      await asSystem(fn);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.errors.push(`${name}: ${message}`);
      ctx.logger.warn(`koe: sweep ${name} failed`, { error: message });
    }
  };
  await part("snoozes", async () => void (report.woken = await wakeSnoozed(ctx, db, now)));
  await part("windows", async () => {
    const w = await windows(ctx, db, now);
    report.windowsExpiring = w.expiring;
    report.windowsClosed = w.closed;
  });
  await part("slas", async () => void (report.slaBreached = await slas(ctx, db, now)));
  await part("auto-resolve", async () => void (report.autoResolved = await autoResolve(ctx, db, now)));
  await part("promises", async () => void (report.promisesBroken = await breakOverduePromises(ctx, db, now)));
  await part("campaigns", async () => void (report.campaigns = await campaignTick(ctx, db, now)));
  await part("sequences", async () => void (report.sequenceSteps = await sequenceTick(db, now)));
  await part("housekeeping", () => housekeeping(db, now));
  return report;
}

// ── Listeners and the timer ────────────────────────────────────────────────

const listening = new WeakSet<object>();

/** `koe:message.received` stops the sequences that stop on reply, at once (the step job checks again). */
export function registerAutomationListeners(ctx: KonContext): void {
  if (listening.has(ctx)) return;
  listening.add(ctx);
  ctx.events.on("koe:message.received", (data) => {
    const conversationId = (data as { conversationId?: unknown } | null)?.conversationId;
    if (typeof conversationId !== "string") return;
    const run = () => stopOnReply(ctx, dbOf(ctx), conversationId);
    // Outside the request that emitted it: its transaction may be gone by now.
    const task = ctx.db.background ? ctx.db.background(run) : run();
    void Promise.resolve(task).catch((err) => ctx.logger.warn("koe: stopping sequences on reply failed", { error: err instanceof Error ? err.message : String(err) }));
  });
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

export function startSweep(ctx: KonContext): void {
  registerAutomationListeners(ctx);
  if (timer) return;
  timer = setInterval(() => {
    if (busy) return;
    busy = true;
    const run = () => sweepOnce(ctx);
    const task = ctx.db.background ? ctx.db.background(run) : run();
    void Promise.resolve(task)
      .catch((err) => ctx.logger.warn("koe: sweep failed", { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        busy = false;
      });
  }, SWEEP_MS);
  timer.unref?.();
}

export function stopSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
  busy = false;
}

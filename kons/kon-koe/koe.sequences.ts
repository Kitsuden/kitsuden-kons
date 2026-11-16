/**
 * Sequences: several messages over time that stop when the contact answers
 * ============================================================================
 *
 * A sequence is a list of steps, each `delayMinutes` after the previous one, each a text or an approved
 * template: "your payment is due tomorrow" → two days later "did you see this?" → a week later a
 * template. A run (`koe_sequence_runs`) follows one conversation through it.
 *
 *   start      POST /conversations/:id/sequences/:sequenceId (whoever sees the conversation), or the rule
 *              step `start-sequence`. Starting a sequence that already runs there changes nothing; one that
 *              finished or stopped starts again from the first step.
 *   a step     the sweep queues a `sequence` job for each run whose `next_at` came. The job sends with
 *              author `rule` and the idempotency key `sequence:<run>:<started>:<step>`, so a retried job
 *              never sends a step twice. A text step goes out only while the free window is open;
 *              otherwise it is skipped, with the reason in the conversation's history, and the run moves on.
 *   stop       on the contact's reply when the sequence says so: at once through `koe:message.received`,
 *              and again in the job (an event is at most once), which looks for an inbound message after
 *              the run started.
 *
 * Contact hours: a conversation of a collections team only gets a step inside the team's business hours
 * (in the contact's time zone when it has one). Outside them the step waits for the next sweep.
 */

import { AppError, asSystem, queue, withSavepoint } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";

import { koeCode } from "./koe.campaigns";
import { dbOf, emit, newId, QUEUES, type Db } from "./koe.common";
import { recordEvent } from "./koe.conversations";
import { contactTimeZone, inBusinessHours } from "./koe.hours";
import { requireLead, requireMember, USE } from "./koe.policy";
import { koeChannels, koeContacts, koeConversations, koeMessages, koeSequenceRuns, koeSequences, koeTeams, koeTemplates, type Channel, type Conversation, type SequenceStep } from "./koe.schema";
import { send } from "./koe.send";
import { windowOf } from "./koe.window";
import { Output, ParamId, type OperationsModule } from "./operations";

export type Sequence = typeof koeSequences.$inferSelect;
export type SequenceRun = typeof koeSequenceRuns.$inferSelect;

const MINUTE = 60_000;
/** A claimed step not finished after this long may be taken again (the worker died). */
const LEASE_MS = 10 * MINUTE;

const Step = z.union([
  z.object({ delayMinutes: z.number().int().min(0).max(60 * 24 * 90), text: z.string().trim().min(1).max(4096) }).strict(),
  z.object({ delayMinutes: z.number().int().min(0).max(60 * 24 * 90), templateId: z.string().min(1).max(100), variables: z.record(z.string(), z.string().max(1024)).optional() }).strict(),
]);

const SequenceFields = z.object({
  name: z.string().trim().min(1).max(200),
  channelId: z.string().min(1).max(100),
  steps: z.array(Step).min(1).max(20).describe('Each { delayMinutes, text } or { delayMinutes, templateId, variables }. Text steps only go out while the free window is open'),
  stopOnReply: z.boolean().optional(),
  active: z.boolean().optional(),
});

async function checkSteps(db: Db, channelId: string, steps: SequenceStep[]): Promise<void> {
  const [channel] = (await db.select().from(koeChannels).where(eq(koeChannels.id, channelId)).limit(1)) as Channel[];
  if (!channel) throw AppError.validation("Channel not found");
  for (const [i, s] of steps.entries()) {
    if ("templateId" in s) {
      if (channel.kind !== "whatsapp") throw AppError.validation(`Step ${i + 1}: only WhatsApp has templates`);
      const [t] = (await db.select({ id: koeTemplates.id }).from(koeTemplates).where(and(eq(koeTemplates.id, s.templateId), eq(koeTemplates.channelId, channelId))).limit(1)) as unknown[];
      if (!t) throw AppError.validation(`Step ${i + 1}: template not found on this channel`);
    }
  }
}

/**
 * Starts (or restarts) a sequence on a conversation. The caller authorized it; the run is written as the
 * system because runs are a lead-only table and an agent may start one on a conversation they handle.
 */
export async function startSequence(_ctx: KonContext, db: Db, conversationId: string, sequenceId: string, now = new Date()): Promise<{ run: SequenceRun; started: boolean }> {
  return asSystem(async () => {
    const [sequence] = (await db.select().from(koeSequences).where(eq(koeSequences.id, sequenceId)).limit(1)) as Sequence[];
    if (!sequence) throw AppError.notFound("Sequence not found");
    if (!sequence.active) throw AppError.conflict("This sequence is paused");
    const [conv] = (await db.select().from(koeConversations).where(eq(koeConversations.id, conversationId)).limit(1)) as Conversation[];
    if (!conv) throw AppError.notFound("Conversation not found");
    if (conv.channelId !== sequence.channelId) throw AppError.validation("The sequence belongs to another channel");
    const first = sequence.steps[0];
    if (!first) throw AppError.validation("The sequence has no steps");
    const nextAt = new Date(now.getTime() + first.delayMinutes * MINUTE);
    const [existing] = (await db.select().from(koeSequenceRuns).where(and(eq(koeSequenceRuns.sequenceId, sequenceId), eq(koeSequenceRuns.conversationId, conversationId))).limit(1)) as SequenceRun[];
    if (existing?.status === "running") return { run: existing, started: false };
    const [run] = (await db
      .insert(koeSequenceRuns)
      .values({ id: newId(), sequenceId, conversationId, step: 0, nextAt, status: "running", startedAt: now })
      .onConflictDoUpdate({ target: [koeSequenceRuns.sequenceId, koeSequenceRuns.conversationId], set: { step: 0, nextAt, status: "running", startedAt: now }, setWhere: sql`${koeSequenceRuns.status} <> 'running'` })
      .returning()) as SequenceRun[];
    await recordEvent(db, conversationId, "sequence", { kind: "system" }, { reason: "started", data: { sequenceId, name: sequence.name } });
    return { run: run ?? existing!, started: !!run };
  });
}

/** Stops the running sequences of a conversation (all, or one). */
export async function stopSequences(ctx: KonContext, db: Db, conversationId: string, reason: string, sequenceId?: string): Promise<number> {
  return asSystem(async () => {
    const stopped = (await db
      .update(koeSequenceRuns)
      .set({ status: "stopped", nextAt: null })
      .where(and(eq(koeSequenceRuns.conversationId, conversationId), eq(koeSequenceRuns.status, "running"), ...(sequenceId ? [eq(koeSequenceRuns.sequenceId, sequenceId)] : [])))
      .returning({ id: koeSequenceRuns.id, sequenceId: koeSequenceRuns.sequenceId })) as Array<{ id: string; sequenceId: string }>;
    for (const r of stopped) emit(ctx, "sequence.stopped", { runId: r.id, sequenceId: r.sequenceId, conversationId, reason });
    return stopped.length;
  });
}

/** The listener: the contact answered, so sequences that stop on reply stop. */
export async function stopOnReply(ctx: KonContext, db: Db, conversationId: string): Promise<number> {
  return asSystem(async () => {
    const runs = (await db
      .select({ id: koeSequenceRuns.id })
      .from(koeSequenceRuns)
      .innerJoin(koeSequences, eq(koeSequences.id, koeSequenceRuns.sequenceId))
      .where(and(eq(koeSequenceRuns.conversationId, conversationId), eq(koeSequenceRuns.status, "running"), eq(koeSequences.stopOnReply, true)))) as Array<{ id: string }>;
    let n = 0;
    for (const r of runs) {
      const done = (await db
        .update(koeSequenceRuns)
        .set({ status: "stopped", nextAt: null })
        .where(and(eq(koeSequenceRuns.id, r.id), eq(koeSequenceRuns.status, "running")))
        .returning({ id: koeSequenceRuns.id, sequenceId: koeSequenceRuns.sequenceId })) as Array<{ id: string; sequenceId: string }>;
      for (const d of done) emit(ctx, "sequence.stopped", { runId: d.id, sequenceId: d.sequenceId, conversationId, reason: "reply" });
      n += done.length;
    }
    return n;
  });
}

/** One due step of one run. Idempotent: the lease and the idempotency key keep a retry from sending twice. */
export async function runSequenceStep(ctx: KonContext, runId: string, at: Date = new Date()): Promise<"sent" | "skipped" | "stopped" | "done" | "waiting" | "noop"> {
  const db = dbOf(ctx);
  return asSystem(async () => {
    const [run] = (await db.select().from(koeSequenceRuns).where(eq(koeSequenceRuns.id, runId)).limit(1)) as SequenceRun[];
    if (!run || run.status !== "running" || !run.nextAt || run.nextAt.getTime() > at.getTime()) return "noop";
    const [sequence] = (await db.select().from(koeSequences).where(eq(koeSequences.id, run.sequenceId)).limit(1)) as Sequence[];
    const [conv] = (await db.select().from(koeConversations).where(eq(koeConversations.id, run.conversationId)).limit(1)) as Conversation[];
    if (!sequence || !conv) return "noop";

    const stop = async (reason: string) => {
      const done = (await db.update(koeSequenceRuns).set({ status: "stopped", nextAt: null }).where(and(eq(koeSequenceRuns.id, run.id), eq(koeSequenceRuns.status, "running"))).returning({ id: koeSequenceRuns.id })) as unknown[];
      if (done.length) emit(ctx, "sequence.stopped", { runId: run.id, sequenceId: sequence.id, conversationId: conv.id, reason });
      return "stopped" as const;
    };
    if (!sequence.active) return stop("sequence paused");
    // The event may have been lost: look for a reply ourselves.
    if (sequence.stopOnReply) {
      const [reply] = (await db
        .select({ id: koeMessages.id })
        .from(koeMessages)
        .where(and(eq(koeMessages.conversationId, conv.id), eq(koeMessages.direction, "in"), gt(koeMessages.createdAt, run.startedAt)))
        .limit(1)) as unknown[];
      if (reply) return stop("reply");
    }

    // Contact hours of a collections team.
    if (conv.teamId) {
      const [team] = (await db.select().from(koeTeams).where(eq(koeTeams.id, conv.teamId)).limit(1)) as Array<typeof koeTeams.$inferSelect>;
      if (team?.purpose === "collections") {
        const [contact] = (await db.select({ attributes: koeContacts.attributes }).from(koeContacts).where(eq(koeContacts.id, conv.contactId)).limit(1)) as Array<{ attributes: Record<string, unknown> }>;
        if (!inBusinessHours(at, team.businessHours, contactTimeZone(contact?.attributes) ?? team.timezone)) return "waiting";
      }
    }

    // Lease the step: a second worker finds next_at moved and does nothing.
    const leased = (await db
      .update(koeSequenceRuns)
      .set({ nextAt: new Date(at.getTime() + LEASE_MS) })
      .where(and(eq(koeSequenceRuns.id, run.id), eq(koeSequenceRuns.status, "running"), eq(koeSequenceRuns.step, run.step), sql`${koeSequenceRuns.nextAt} = ${run.nextAt.toISOString()}`))
      .returning({ id: koeSequenceRuns.id })) as unknown[];
    if (!leased.length) return "noop";

    const step = sequence.steps[run.step];
    let outcome: "sent" | "skipped" = "skipped";
    if (step) {
      const [channel] = (await db.select().from(koeChannels).where(eq(koeChannels.id, conv.channelId)).limit(1)) as Channel[];
      const key = `sequence:${run.id}:${run.startedAt.getTime()}:${run.step}`;
      let skipReason: string | null = null;
      if ("text" in step && channel && !windowOf(channel.kind, conv.lastInboundAt, conv.freeEntryUntil, at).open) {
        skipReason = "the free window is closed: a text step cannot go out";
      } else {
        try {
          await withSavepoint(() =>
            send(
              { ctx, db },
              "text" in step
                ? { conversationId: conv.id, author: { kind: "rule", id: `sequence:${sequence.id}` }, kind: "text", body: step.text, idempotencyKey: key }
                : { conversationId: conv.id, author: { kind: "rule", id: `sequence:${sequence.id}` }, kind: "template", template: { templateId: step.templateId, values: step.variables ?? {} }, idempotencyKey: key }
            )
          );
          outcome = "sent";
        } catch (err) {
          const code = koeCode(err);
          if (code === "OPTED_OUT" || code === "BLOCKED") {
            await recordEvent(db, conv.id, "sequence", { kind: "system" }, { reason: `stopped: ${code.toLowerCase()}`, data: { sequenceId: sequence.id, step: run.step } });
            return stop(code.toLowerCase());
          }
          if (!code) throw err; // not a refusal: let the queue retry (the lease expires)
          skipReason = err instanceof Error ? err.message : code;
        }
      }
      if (skipReason) await recordEvent(db, conv.id, "sequence", { kind: "system" }, { reason: `step ${run.step + 1} skipped: ${skipReason}`.slice(0, 500), data: { sequenceId: sequence.id, step: run.step } });
    }

    const nextIndex = run.step + 1;
    const next = sequence.steps[nextIndex];
    if (!next) {
      await db.update(koeSequenceRuns).set({ status: "done", step: nextIndex, nextAt: null }).where(eq(koeSequenceRuns.id, run.id));
      emit(ctx, "sequence.finished", { runId: run.id, sequenceId: sequence.id, conversationId: conv.id });
      return outcome === "sent" ? "sent" : "done";
    }
    await db
      .update(koeSequenceRuns)
      .set({ step: nextIndex, nextAt: new Date(at.getTime() + next.delayMinutes * MINUTE) })
      .where(eq(koeSequenceRuns.id, run.id));
    return outcome;
  });
}

/** For the sweep: a job for every run whose step is due. */
export async function sequenceTick(db: Db, now: Date): Promise<number> {
  const due = (await db
    .select({ id: koeSequenceRuns.id })
    .from(koeSequenceRuns)
    .where(and(eq(koeSequenceRuns.status, "running"), sql`${koeSequenceRuns.nextAt} <= ${now.toISOString()}`))
    .orderBy(asc(koeSequenceRuns.nextAt))
    .limit(500)) as Array<{ id: string }>;
  for (const r of due) await queue.dispatch(QUEUES.automation, "sequence", { runId: r.id, at: now.toISOString() }, { attempts: 3, reason: "koe sequence step" });
  return due.length;
}

// ── Operations ─────────────────────────────────────────────────────────────

export const sequenceOperations: OperationsModule = (app, ctx) => {
  const db = (): Db => dbOf(ctx);

  app.get(
    "/sequences",
    {
      id: "list-sequences",
      summary: "List sequences",
      description: "Follow-up sequences (messages over time that stop when the contact answers).",
      access: "session",
      permission: USE,
      input: { query: z.object({ channelId: z.string().max(100).optional() }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const where = input.query.channelId ? eq(koeSequences.channelId, input.query.channelId) : undefined;
      return c.json({ data: await db().select().from(koeSequences).where(where).orderBy(desc(koeSequences.createdAt)) });
    }
  );

  app.post(
    "/sequences",
    {
      id: "create-sequence",
      summary: "Create a sequence",
      description: "Steps with delays, each a text (only inside the free window) or an approved template. Supervisors and admins.",
      access: "session",
      permission: USE,
      input: { body: SequenceFields },
      output: { schema: Output, status: 201 },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      await checkSteps(db(), input.body.channelId, input.body.steps as SequenceStep[]);
      const [row] = (await db()
        .insert(koeSequences)
        .values({ id: newId(), name: input.body.name, channelId: input.body.channelId, steps: input.body.steps as SequenceStep[], stopOnReply: input.body.stopOnReply ?? true, active: input.body.active ?? true })
        .returning()) as Sequence[];
      return c.json({ data: row }, 201);
    }
  );

  app.patch(
    "/sequences/:id",
    {
      id: "update-sequence",
      summary: "Change a sequence",
      description: "Name, steps, stop-on-reply or active. Runs already going continue at their step number with the new steps.",
      access: "session",
      permission: USE,
      input: { params: ParamId, body: SequenceFields.omit({ channelId: true }).partial() },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const [current] = (await db().select().from(koeSequences).where(eq(koeSequences.id, input.params.id)).limit(1)) as Sequence[];
      if (!current) throw AppError.notFound("Sequence not found");
      if (input.body.steps) await checkSteps(db(), current.channelId, input.body.steps as SequenceStep[]);
      const [row] = (await db()
        .update(koeSequences)
        .set({ ...input.body, ...(input.body.steps ? { steps: input.body.steps as SequenceStep[] } : {}) })
        .where(eq(koeSequences.id, current.id))
        .returning()) as Sequence[];
      return c.json({ data: row });
    }
  );

  app.delete(
    "/sequences/:id",
    {
      id: "delete-sequence",
      summary: "Delete a sequence",
      description: "Deletes it and stops its runs.",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const rows = (await db().delete(koeSequences).where(eq(koeSequences.id, input.params.id)).returning({ id: koeSequences.id })) as unknown[];
      if (!rows.length) throw AppError.notFound("Sequence not found");
      return c.json({ data: { ok: true } });
    }
  );

  app.get(
    "/conversations/:id/sequences",
    {
      id: "list-conversation-sequences",
      summary: "Sequences of a conversation",
      description: "The sequences running (or that ran) in a conversation, with their step and next time.",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const [conv] = (await db().select({ id: koeConversations.id }).from(koeConversations).where(eq(koeConversations.id, input.params.id)).limit(1)) as unknown[];
      if (!conv) throw AppError.notFound("Conversation not found");
      const runs = await asSystem(() =>
        db()
          .select({ id: koeSequenceRuns.id, sequenceId: koeSequenceRuns.sequenceId, name: koeSequences.name, step: koeSequenceRuns.step, steps: sql<number>`jsonb_array_length(${koeSequences.steps})`, status: koeSequenceRuns.status, nextAt: koeSequenceRuns.nextAt, startedAt: koeSequenceRuns.startedAt })
          .from(koeSequenceRuns)
          .innerJoin(koeSequences, eq(koeSequences.id, koeSequenceRuns.sequenceId))
          .where(eq(koeSequenceRuns.conversationId, input.params.id))
      );
      return c.json({ data: runs });
    }
  );

  const RunParams = z.object({ id: z.string().min(1).max(100), sequenceId: z.string().min(1).max(100) });

  app.post(
    "/conversations/:id/sequences/:sequenceId",
    {
      id: "start-sequence",
      summary: "Start a sequence in a conversation",
      description: "Follow-ups over time (payment reminders, a lead that went quiet). Stops on the contact's reply when the sequence says so. Starting one already running there changes nothing.",
      access: "session",
      permission: USE,
      input: { params: RunParams },
      output: { schema: Output, status: 201 },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      // Row security answers whether the caller sees the conversation; then the run is written as the system.
      const [conv] = (await db().select({ id: koeConversations.id }).from(koeConversations).where(eq(koeConversations.id, input.params.id)).limit(1)) as unknown[];
      if (!conv) throw AppError.notFound("Conversation not found");
      const result = await startSequence(ctx, db(), input.params.id, input.params.sequenceId);
      return c.json({ data: result.run, started: result.started }, 201);
    }
  );

  app.delete(
    "/conversations/:id/sequences/:sequenceId",
    {
      id: "stop-sequence",
      summary: "Stop a sequence in a conversation",
      description: "Stops the run; nothing more of that sequence goes out in this conversation.",
      access: "session",
      permission: USE,
      sensitive: false,
      input: { params: RunParams },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const [conv] = (await db().select({ id: koeConversations.id }).from(koeConversations).where(eq(koeConversations.id, input.params.id)).limit(1)) as unknown[];
      if (!conv) throw AppError.notFound("Conversation not found");
      const n = await stopSequences(ctx, db(), input.params.id, "stopped by a person", input.params.sequenceId);
      return c.json({ data: { stopped: n } });
    }
  );
};

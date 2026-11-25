/**
 * koe's automation: rule steps, the automation queue, and the modules that run on their own
 * ============================================================================
 *
 * The core runs automation rules (docs/automation.md): WHEN an event (`koe:message.received`,
 * `koe:sla.breached`…) IF its payload matches THEN steps. koe contributes the steps that act on a
 * conversation; each one takes the conversation from its config or, by default, from the event
 * (`event.data.conversationId`), so most rules need no placeholder at all:
 *
 *   kon-koe:send-message     a text (only inside the free window; the bot rule still applies)
 *   kon-koe:send-template    an approved WhatsApp template (opens a closed window)
 *   kon-koe:assign           to a person, to a team (transfer), or automatically
 *   kon-koe:set-state        handoff to people, resolve, or snooze for N minutes
 *   kon-koe:add-label        labels on the conversation
 *   kon-koe:add-note         an internal note
 *   kon-koe:start-sequence   start a follow-up sequence
 *   kon-koe:record-outcome   record a sales/collections outcome
 *
 * Steps run after the triggering request committed, on the system connection. The account that answers
 * for the rule (`actorUserId`) is recorded as the author of notes and outcomes and as who assigned;
 * messages carry the rule as their author. A step may run twice for one event (a person re-runs the rule),
 * so the sending steps derive an idempotency key from the rule and the event.
 *
 * Everything else that runs on its own lives in its module and is wired here: flows (koe.flows.ts),
 * campaigns (koe.campaigns.ts), sequences (koe.sequences.ts), sales and collections (koe.sales.ts), the
 * sweep (koe.sweep.ts) and reports (koe.reports.ts).
 */

import { createHash } from "node:crypto";

import { AppError, asSystem, PermanentError, type QueueJob } from "@kitsuden/engine";
import type { AutomationHandlerDefinition, AutomationHandlerInput, KonContext } from "@kitsuden/shared";
import { eq } from "drizzle-orm";

import { campaignOperations, runCampaignBatch } from "./koe.campaigns";
import { dbOf, isString, newId, type Db } from "./koe.common";
import { autoAssign, changeState, transfer } from "./koe.conversations";
import { applySet, flowOperations, handOff } from "./koe.flows";
import { reportOperations } from "./koe.reports";
import { OUTCOME_KINDS, recordOutcome, salesOperations, type OutcomeKind } from "./koe.sales";
import { koeChannels, koeConversations, koeNotes, type ChannelKind, type Conversation } from "./koe.schema";
import { send } from "./koe.send";
import { runSequenceStep, sequenceOperations, startSequence } from "./koe.sequences";
import { windowOf } from "./koe.window";
import type { OperationsModule } from "./operations";

export { koeReports } from "./koe.reports";
export { hostSchedulesKons, startSweep, stopSweep, sweepOnce, sweepTick, registerAutomationListeners } from "./koe.sweep";

/** Flows, campaigns, sequences, sales and collections, reports: one module for index.ts. */
export const automationOperations: OperationsModule = (app, ctx) => {
  for (const add of [flowOperations, campaignOperations, sequenceOperations, salesOperations, reportOperations]) add(app, ctx);
};

/** The `koe-automation` queue: campaign batches and sequence steps. */
export async function processAutomation(ctx: KonContext, job: QueueJob<Record<string, unknown>>): Promise<void> {
  const p = job.payload ?? {};
  // The sweep's clock, unless the job ran late (a retry): then now, so the pace is counted from the real minute.
  const at = typeof p.at === "string" && !Number.isNaN(Date.parse(p.at)) ? new Date(Math.max(Date.parse(p.at), Date.now())) : new Date();
  // A job queued from a request runs as that person; these jobs act for the installation.
  await asSystem(async () => {
    switch (job.name) {
      case "campaign":
        if (!isString(p.campaignId)) throw new PermanentError("campaign job without campaignId");
        await runCampaignBatch(ctx, p.campaignId, at);
        return;
      case "sequence":
        if (!isString(p.runId)) throw new PermanentError("sequence job without runId");
        await runSequenceStep(ctx, p.runId, at);
        return;
      default:
        throw new PermanentError(`unknown koe automation job ${job.name}`);
    }
  });
}

// ── Rule steps ─────────────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/;
const isPlaceholder = (v: unknown) => typeof v === "string" && PLACEHOLDER.test(v);
const conversationIdOf = (input: AutomationHandlerInput): string => {
  const id = input.config.conversationId ?? input.event?.data?.conversationId;
  if (!isString(id)) throw new Error("No conversation: set config.conversationId, or fire the rule on a koe event that carries one");
  return id;
};
/** Same rule, same event, same step: the same key, so a re-run sends nothing new. */
const keyOf = (input: AutomationHandlerInput, step: string): string | undefined =>
  input.event ? `rule:${input.rule.id}:${step}:${createHash("sha256").update(JSON.stringify(input.event.data ?? {})).digest("hex").slice(0, 24)}` : undefined;

async function conversationOf(db: Db, id: string): Promise<Conversation> {
  const [c] = (await db.select().from(koeConversations).where(eq(koeConversations.id, id)).limit(1)) as Conversation[];
  if (!c) throw new Error(`Conversation ${id} not found`);
  return c;
}

const optionalString = (config: Record<string, unknown>, key: string, max = 200): string | null =>
  config[key] === undefined || (typeof config[key] === "string" && (config[key] as string).length > 0 && (config[key] as string).length <= max) ? null : `${key} must be a text of up to ${max} characters`;

const labelsOf = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((l) => String(l).trim()).filter(Boolean);

function stepWith(
  id: string,
  label: string,
  description: string,
  config: Record<string, string>,
  validate: (c: Record<string, unknown>) => string | null,
  run: (input: AutomationHandlerInput, ctx: KonContext, db: Db) => Promise<unknown>,
  preview: (input: AutomationHandlerInput, ctx: KonContext, db: Db) => Promise<unknown>
): AutomationHandlerDefinition {
  const conversationDoc = "Conversation id. Default: the event's conversationId";
  return {
    id,
    label,
    description,
    config: { conversationId: conversationDoc, ...config },
    validate: (c) => optionalString(c, "conversationId", 100) ?? validate(c),
    run: (input, ctx) => asSystem(() => run(input, ctx, dbOf(ctx))),
    preview: (input, ctx) => asSystem(() => preview(input, ctx, dbOf(ctx))),
  };
}

async function describe(db: Db, input: AutomationHandlerInput, would: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = input.config.conversationId ?? input.event?.data?.conversationId;
  const conv = isString(id) ? ((await db.select().from(koeConversations).where(eq(koeConversations.id, id)).limit(1)) as Conversation[])[0] : undefined;
  return { conversationId: isString(id) ? id : null, found: !!conv, state: conv?.state ?? null, assigneeId: conv?.assigneeId ?? null, ...would };
}

const RULE_AUTHOR = (input: AutomationHandlerInput) => ({ kind: "rule" as const, id: input.rule.id });

export const koeActionHandlers: AutomationHandlerDefinition[] = [
  stepWith(
    "send-message",
    "Send a text message",
    "Sends a text in the conversation, written by the rule. Only while the free window is open (outside it, use send-template); refused for contacts who opted out.",
    { text: "The text. Placeholders: {{event.text}}, {{event.contactId}}…" },
    (c) => (typeof c.text === "string" && c.text.trim() && c.text.length <= 4096 ? null : "text is required (up to 4096 characters)"),
    async (input, ctx, db) => {
      const message = await send({ ctx, db }, { conversationId: conversationIdOf(input), author: RULE_AUTHOR(input), kind: "text", body: String(input.config.text), idempotencyKey: keyOf(input, "send-message") });
      return { messageId: message.id, status: message.status };
    },
    async (input, _ctx, db) => {
      const d = await describe(db, input, { would: "send a text", text: input.config.text });
      if (d.found) {
        const conv = await conversationOf(db, d.conversationId as string);
        const [ch] = (await db.select({ kind: koeChannels.kind }).from(koeChannels).where(eq(koeChannels.id, conv.channelId)).limit(1)) as Array<{ kind: ChannelKind }>;
        d.windowOpen = ch ? windowOf(ch.kind, conv.lastInboundAt, conv.freeEntryUntil).open : null;
      }
      return d;
    }
  ),
  stepWith(
    "send-template",
    "Send a WhatsApp template",
    "Sends an approved template (works with the window closed). Refused for contacts who opted out, and for marketing templates to contacts without consent.",
    { templateId: "koe template id (approved)", values: 'Slot → value: {"1": "{{event.contactId}}"}; "{{contact.name}}" is the contact\'s name' },
    (c) => {
      if (!isString(c.templateId) || c.templateId.length > 100) return "templateId is required";
      if (c.values !== undefined && (typeof c.values !== "object" || c.values === null || Array.isArray(c.values))) return "values must be an object of slot → text";
      return null;
    },
    async (input, ctx, db) => {
      const values = Object.fromEntries(Object.entries((input.config.values ?? {}) as Record<string, unknown>).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)]));
      const message = await send(
        { ctx, db },
        { conversationId: conversationIdOf(input), author: RULE_AUTHOR(input), kind: "template", template: { templateId: String(input.config.templateId), values }, idempotencyKey: keyOf(input, "send-template") }
      );
      return { messageId: message.id, status: message.status };
    },
    (input, _ctx, db) => describe(db, input, { would: "send a template", templateId: input.config.templateId, values: input.config.values ?? {} })
  ),
  stepWith(
    "assign",
    "Assign the conversation",
    "To a person (`userId`), to a team (`teamId`: moves it to that team's queue, which may assign it automatically), or automatically (`auto: true`: from the bot to the queue, then the team's next free person).",
    { userId: "A koe member's user id", teamId: "A koe team id", auto: "true: let the team's assignment decide" },
    (c) => {
      const given = [c.userId, c.teamId, c.auto].filter((v) => v !== undefined && v !== false).length;
      if (given !== 1) return "give exactly one of userId, teamId or auto: true";
      return optionalString(c, "userId", 100) ?? optionalString(c, "teamId", 100);
    },
    async (input, ctx, db) => {
      const id = conversationIdOf(input);
      const conv = await conversationOf(db, id);
      const by = { kind: "rule" as const, id: input.actorUserId ?? input.rule.id };
      if (isString(input.config.userId)) {
        if (conv.state === "human" && conv.assigneeId === input.config.userId) return { state: conv.state, assigneeId: conv.assigneeId, changed: false };
        const updated = await changeState(ctx, db, id, { trigger: conv.state === "human" ? "reassign" : "assign", assigneeId: input.config.userId, reason: `rule ${input.rule.name}` }, by);
        return { state: updated.state, assigneeId: updated.assigneeId, changed: true };
      }
      if (isString(input.config.teamId)) {
        const updated = conv.state === "bot" ? await handOff(ctx, db, id, { teamId: input.config.teamId, reason: `rule ${input.rule.name}` }, by) : await transfer(ctx, db, id, input.config.teamId, by);
        return { state: updated.state, teamId: updated.teamId, assigneeId: updated.assigneeId, changed: true };
      }
      if (conv.state === "bot") {
        const updated = await handOff(ctx, db, id, { reason: `rule ${input.rule.name}` }, by);
        return { state: updated.state, assigneeId: updated.assigneeId, changed: true };
      }
      const updated = await autoAssign(ctx, db, conv);
      return { state: updated.state, assigneeId: updated.assigneeId, changed: updated.state !== conv.state };
    },
    (input, _ctx, db) => describe(db, input, { would: isString(input.config.userId) ? `assign to ${input.config.userId}` : isString(input.config.teamId) ? `move to team ${input.config.teamId}` : "assign automatically" })
  ),
  stepWith(
    "set-state",
    "Hand off, resolve or snooze",
    "`state`: `handoff` (from the bot, or from a person back to the queue), `resolve`, or `snooze` for `minutes`. A conversation already there is left as it is.",
    { state: "handoff | resolve | snooze", minutes: "For snooze: how long (1 to 43200)", teamId: "For handoff: the team to hand it to", reason: "Shown in the conversation's history" },
    (c) => {
      if (!["handoff", "resolve", "snooze"].includes(String(c.state))) return "state must be handoff, resolve or snooze";
      if (c.state === "snooze" && !isPlaceholder(c.minutes) && !(Number.isInteger(Number(c.minutes)) && Number(c.minutes) >= 1 && Number(c.minutes) <= 43_200)) return "snooze needs minutes from 1 to 43200";
      return optionalString(c, "teamId", 100) ?? optionalString(c, "reason", 500);
    },
    async (input, ctx, db) => {
      const id = conversationIdOf(input);
      const conv = await conversationOf(db, id);
      const reason = isString(input.config.reason) ? input.config.reason : `rule ${input.rule.name}`;
      const by = { kind: "rule" as const, id: input.actorUserId ?? input.rule.id };
      switch (input.config.state) {
        case "handoff": {
          if (conv.state === "bot") return { state: (await handOff(ctx, db, id, { teamId: isString(input.config.teamId) ? input.config.teamId : null, reason }, by)).state };
          if (conv.state === "human") return { state: (await transfer(ctx, db, id, isString(input.config.teamId) ? input.config.teamId : conv.teamId, by)).state };
          if (conv.state === "queued") return { state: conv.state, changed: false };
          throw new Error(`A ${conv.state} conversation cannot be handed off`);
        }
        case "resolve":
          if (conv.state === "resolved") return { state: conv.state, changed: false };
          return { state: (await changeState(ctx, db, id, { trigger: "resolve", reason }, by)).state };
        case "snooze": {
          if (conv.state === "snoozed") return { state: conv.state, changed: false };
          const until = new Date(Date.now() + Number(input.config.minutes) * 60_000);
          if (!Number.isFinite(until.getTime()) || until.getTime() <= Date.now()) throw new Error("minutes must be a positive number");
          return { state: (await changeState(ctx, db, id, { trigger: "snooze", snoozedUntil: until, reason }, by)).state, snoozedUntil: until.toISOString() };
        }
        default:
          throw new Error("state must be handoff, resolve or snooze");
      }
    },
    (input, _ctx, db) => describe(db, input, { would: String(input.config.state), minutes: input.config.minutes ?? null })
  ),
  stepWith(
    "add-label",
    "Add labels",
    "Adds labels to the conversation (kept once each).",
    { labels: 'A list, or a text with commas: "vip, debt-30"' },
    (c) => {
      const l = labelsOf(c.labels);
      if (!l.length || l.length > 10 || l.some((x) => x.length > 60)) return "labels: 1 to 10 labels of up to 60 characters";
      return null;
    },
    async (input, ctx, db) => {
      const id = conversationIdOf(input);
      await applySet(ctx, db, id, { labels: labelsOf(input.config.labels) }, (t) => t, input.actorUserId ?? `rule:${input.rule.id}`);
      return { labels: (await conversationOf(db, id)).labels };
    },
    (input, _ctx, db) => describe(db, input, { would: "add labels", labels: labelsOf(input.config.labels) })
  ),
  stepWith(
    "add-note",
    "Add an internal note",
    "An internal note in the conversation (never sent to the contact), authored by the rule's owner.",
    { body: "The note. Placeholders: {{event.text}}…" },
    (c) => (typeof c.body === "string" && c.body.trim() && c.body.length <= 4000 ? null : "body is required (up to 4000 characters)"),
    async (input, _ctx, db) => {
      const id = conversationIdOf(input);
      await conversationOf(db, id);
      const [note] = (await db.insert(koeNotes).values({ id: newId(), conversationId: id, authorKind: "rule", authorId: input.actorUserId, body: String(input.config.body).trim() }).returning({ id: koeNotes.id })) as Array<{ id: string }>;
      return { noteId: note!.id };
    },
    (input, _ctx, db) => describe(db, input, { would: "add a note", body: input.config.body })
  ),
  stepWith(
    "start-sequence",
    "Start a sequence",
    "Starts a follow-up sequence in the conversation; one already running there is left as it is.",
    { sequenceId: "koe sequence id" },
    (c) => (isString(c.sequenceId) && c.sequenceId.length <= 100 ? null : "sequenceId is required"),
    async (input, ctx, db) => {
      const { run, started } = await startSequence(ctx, db, conversationIdOf(input), String(input.config.sequenceId));
      return { runId: run.id, started };
    },
    (input, _ctx, db) => describe(db, input, { would: "start a sequence", sequenceId: input.config.sequenceId })
  ),
  stepWith(
    "record-outcome",
    "Record an outcome",
    "Records the outcome of a sales or collections attempt for the reports.",
    { kind: OUTCOME_KINDS.join(" | "), amountCents: "Optional, in cents", currency: "ISO 4217, required with an amount", note: "Optional" },
    (c) => {
      if (!OUTCOME_KINDS.includes(c.kind as OutcomeKind) && !isPlaceholder(c.kind)) return `kind must be one of ${OUTCOME_KINDS.join(", ")}`;
      if (c.amountCents !== undefined && !isPlaceholder(c.amountCents) && !(Number.isInteger(Number(c.amountCents)) && Number(c.amountCents) >= 0)) return "amountCents must be a whole number of cents";
      if (c.amountCents !== undefined && !(typeof c.currency === "string" && (/^[A-Z]{3}$/.test(c.currency) || isPlaceholder(c.currency)))) return "an amount needs its currency (ISO 4217)";
      return optionalString(c, "note", 2000);
    },
    async (input, ctx, db) => {
      const id = conversationIdOf(input);
      await conversationOf(db, id);
      const kind = String(input.config.kind) as OutcomeKind;
      if (!OUTCOME_KINDS.includes(kind)) throw AppError.validation(`Unknown outcome ${kind}`);
      const amount = input.config.amountCents === undefined || input.config.amountCents === null || input.config.amountCents === "" ? null : Number(input.config.amountCents);
      if (amount !== null && (!Number.isInteger(amount) || amount < 0)) throw AppError.validation("amountCents must be a whole number of cents");
      const currency = isString(input.config.currency) ? input.config.currency : null;
      if (amount !== null && (!currency || !/^[A-Z]{3}$/.test(currency))) throw AppError.validation("An amount needs its currency");
      const row = await recordOutcome(ctx, db, id, { kind, amountCents: amount, currency, note: isString(input.config.note) ? input.config.note : null }, input.actorUserId);
      return { outcomeId: row.id };
    },
    (input, _ctx, db) => describe(db, input, { would: "record an outcome", kind: input.config.kind, amountCents: input.config.amountCents ?? null })
  ),
];

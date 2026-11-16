/**
 * What the CRM does for Kitsuden's automation rules
 * ============================================================================
 *
 * A rule a person writes in the panel ("when a deal is won, create a task to send the invoice") is run by
 * the core. The steps that only the CRM knows how to do are contributed here, and the host exposes them as
 * `kon-crm:<id>`:
 *
 *   kon-crm:create-activity        a call, email, meeting or note on a deal or a contact
 *   kon-crm:create-task            a task, due in N days
 *   kon-crm:create-calendar-event  a meeting, in N days
 *   kon-crm:log-time               work on the deal, for kon-conta to bill
 *   kon-crm:update-field           probability, status, lostReason, campaign or a custom field
 *   kon-crm:move-stage             move a deal to another stage, through the same checks as a person
 *
 * The deal is `config.dealId`, or the triggering event's `dealId` (`crm:deal.moved`, `crm:deal.won`…). A step
 * may carry the condition a stage action had (`{ field, operator, value }` on the deal): it is checked on the
 * deal the step loads, so the event never has to carry the deal's amounts.
 *
 * ── STAGE ACTIONS BECOME RULES ─────────────────────────────────────────────
 *
 * A stage's `onEnterActions` / `onExitActions` were the CRM's own small engine (crm.automation.ts). With a
 * Kitsuden that runs rules (`ctx.automation` present), `syncStageRules` turns each stage's actions into two
 * rules of the kon (`stage-<id>-enter` on `crm:deal.moved` with `toStageId = <id>`, `-exit` with
 * `fromStageId`) and empties the stage's columns: one engine, one place to see what runs. A host without
 * `ctx.automation` keeps the CRM's runner, so the actions do not stop on an older Kitsuden.
 */

import type { KonContext } from "@kitsuden/shared";
import { eq } from "drizzle-orm";

import { conditionHolds, runOne, SUPPORTED_ACTIONS } from "./crm.automation";
import type { CrmDb } from "./crm.db";
import { moveDeal } from "./crm.moves";
import { crmActivities, crmDeals, crmPipelineStages, type StageAction } from "./crm.schema";

// ── The host's contract, structurally (Kitsuden's `AutomationHandlerDefinition`, `KonAutomation`) ──
// Declared here so the kon builds against a Kitsuden that does not have them yet.

export interface HandlerInput {
  config: Record<string, unknown>;
  event?: { name: string; data: Record<string, unknown> };
  rule: { id: string; name: string };
  actorUserId: string | null;
}

export interface CrmActionHandler {
  id: string;
  label: string;
  description: string;
  config?: Record<string, string>;
  validate?(config: Record<string, unknown>): string | null;
  run(input: HandlerInput, ctx: KonContext): Promise<unknown>;
  preview?(input: HandlerInput, ctx: KonContext): Promise<unknown> | unknown;
}

export interface KonRule {
  slug: string;
  name: string;
  event: string;
  conditions?: Array<{ field: string; op: string; value?: unknown }>;
  match?: "all" | "any";
  steps: Array<{ handler: string; config?: Record<string, unknown>; continueOnError?: boolean }>;
  enabled?: boolean;
  ownerUserId?: string | null;
}

export interface KonAutomation {
  upsertRule(konId: string, rule: KonRule): Promise<unknown>;
  removeRule(konId: string, slug: string): Promise<boolean>;
  listRules(konId: string): Promise<Array<{ id: string; slug: string; name: string; event: string; enabled: boolean }>>;
}

export function automationOf(ctx: KonContext): KonAutomation | null {
  return ((ctx as unknown as { automation?: KonAutomation }).automation ?? null) || null;
}

// ── The handlers ────────────────────────────────────────────────────────────

const KON_ID = "kon-crm";
const ACTIVITY_TYPES = new Set(["call", "email", "meeting", "note"]);
const CONDITION_OPERATORS = new Set(["==", "!=", ">", "<", ">=", "<=", "exists"]);

type Deal = typeof crmDeals.$inferSelect;

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function dealIdOf(input: HandlerInput): string | null {
  return text(input.config.dealId) ?? text(input.event?.data?.dealId);
}

function conditionProblem(config: Record<string, unknown>): string | null {
  const c = config.condition as StageAction["condition"] | undefined;
  if (c === undefined || c === null) return null;
  if (typeof c !== "object" || typeof c.field !== "string" || !CONDITION_OPERATORS.has(c.operator)) {
    return "condition must be { field, operator (==, !=, >, <, >=, <=, exists), value }";
  }
  return null;
}

async function inTransaction<T>(ctx: KonContext, fn: (db: CrmDb) => Promise<T>): Promise<T> {
  const db = ctx.db.instance as CrmDb;
  return db.transaction ? db.transaction((tx: CrmDb) => fn(tx)) : fn(db);
}

async function loadDeal(db: CrmDb, dealId: string): Promise<Deal> {
  const [deal] = await db.select().from(crmDeals).where(eq(crmDeals.id, dealId)).limit(1);
  if (!deal) throw new Error(`deal ${dealId} not found`);
  return deal;
}

/** A stage-action-shaped step: the deal is loaded, the condition checked, and the CRM's own code does it. */
function dealStep(
  id: string,
  type: StageAction["type"],
  label: string,
  description: string,
  config: Record<string, string>,
  validate?: (config: Record<string, unknown>) => string | null
): CrmActionHandler {
  return {
    id,
    label,
    description,
    config: {
      dealId: "the deal; default: the event's dealId",
      condition: "optional { field, operator, value } on the deal, as a stage action had",
      ...config,
    },
    validate: (c) => conditionProblem(c) ?? validate?.(c) ?? null,
    async run(input, ctx) {
      const dealId = dealIdOf(input);
      if (!dealId) throw new Error(`${id} needs a dealId (in its config or in the event)`);
      return inTransaction(ctx, async (db) => {
        const deal = await loadDeal(db, dealId);
        const action = { ...input.config, type } as StageAction;
        if (!conditionHolds(action, deal)) return { skipped: "condition not met", dealId };
        await runOne(db, action, deal, input.actorUserId);
        return { done: type, dealId };
      });
    },
    preview(input) {
      return { would: type, dealId: dealIdOf(input), config: input.config };
    },
  };
}

export const CRM_ACTION_HANDLERS: CrmActionHandler[] = [
  {
    id: "create-activity",
    label: "Create an activity",
    description: "Records a call, email, meeting or note on a deal or a contact.",
    config: {
      type: "call, email, meeting or note (note by default)",
      subject: "the activity's title; may use {{event.…}}",
      description: "optional body",
      dealId: "the deal; default: the event's dealId",
      contactId: "or a contact; default: the event's contactId",
      condition: "optional { field, operator, value } on the deal",
    },
    validate(config) {
      if (config.type !== undefined && !ACTIVITY_TYPES.has(String(config.type))) {
        return "type must be call, email, meeting or note";
      }
      if (!text(config.subject)) return "subject is required";
      return conditionProblem(config);
    },
    async run(input, ctx) {
      const dealId = dealIdOf(input);
      const contactIdGiven = text(input.config.contactId) ?? text(input.event?.data?.contactId);
      if (!dealId && !contactIdGiven) throw new Error("create-activity needs a dealId or a contactId");
      return inTransaction(ctx, async (db) => {
        const deal = dealId ? await loadDeal(db, dealId) : null;
        if (deal && !conditionHolds(input.config as unknown as StageAction, deal)) {
          return { skipped: "condition not met", dealId };
        }
        const [row] = await db
          .insert(crmActivities)
          .values({
            type: (text(input.config.type) ?? "note") as "note",
            subject: text(input.config.subject) ?? "Automation",
            description: text(input.config.description),
            dealId: deal?.id ?? null,
            contactId: contactIdGiven ?? deal?.contactId ?? null,
            companyId: deal?.companyId ?? null,
            assignedTo: deal?.assignedTo ?? null,
            createdBy: input.actorUserId,
            origin: "automation",
            metadata: { ruleId: input.rule.id, event: input.event?.name ?? null },
          })
          .returning({ id: crmActivities.id });
        return { activityId: row!.id };
      });
    },
  },
  dealStep(
    "create-task",
    "create_task",
    "Create a task",
    "Adds a task to the deal, assigned to whoever owns the deal, due in `value` days.",
    { title: "the task's title (default: the deal's)", value: "days until it is due" }
  ),
  dealStep(
    "create-calendar-event",
    "create_calendar_event",
    "Schedule a meeting",
    "Adds a meeting to the deal, in `value` days.",
    { title: "the meeting's title", value: "days from now" }
  ),
  dealStep(
    "log-time",
    "log_time",
    "Log time on the deal",
    "Records `value` hours of work on the deal, for kon-conta to bill.",
    { title: "what the work was", value: "hours, more than 0" },
    (c) => (typeof c.value === "number" && c.value > 0 ? null : "value must be a number of hours above 0")
  ),
  dealStep(
    "update-field",
    "update_field",
    "Update a deal field",
    "Sets probability, status, lostReason, campaign or `custom.<key>` on the deal. Closing it (status won or lost) emits crm:deal.won / crm:deal.lost.",
    { field: "probability, status, lostReason, campaign or custom.<key>", value: "the new value" },
    (c) => (text(c.field) ? null : "field is required")
  ),
  {
    id: "move-stage",
    label: "Move the deal to a stage",
    description:
      "Moves the deal to `stageId`, in its own pipeline, through the same entry requirements a person meets. A deal already there is left alone.",
    config: {
      stageId: "the target stage",
      dealId: "the deal; default: the event's dealId",
      reason: "optional, recorded on the move",
    },
    validate: (c) => (text(c.stageId) ? null : "stageId is required"),
    async run(input, ctx) {
      const dealId = dealIdOf(input);
      const stageId = text(input.config.stageId);
      if (!dealId || !stageId) throw new Error("move-stage needs a dealId and a stageId");
      return inTransaction(ctx, async (db) => {
        const moved = await moveDeal(db, {
          dealId,
          targetStageId: stageId,
          moveReason: text(input.config.reason) ?? `Rule: ${input.rule.name}`,
          userId: input.actorUserId,
        });
        return { dealId, moved: !moved.already, stageId };
      });
    },
  },
];

// ── Stage actions → rules ──────────────────────────────────────────────────

/** `create_task` → `kon-crm:create-task`. `webhook` and `send_email` were never runnable: they are dropped. */
export function stageActionToStep(action: StageAction): KonRule["steps"][number] | null {
  if (!(SUPPORTED_ACTIONS as readonly string[]).includes(action.type)) return null;
  const config: Record<string, unknown> = {};
  for (const key of ["title", "value", "field", "condition"] as const) {
    if (action[key] !== undefined) config[key] = action[key];
  }
  if (action.type === "create_activity") {
    config.subject = action.title ?? "Stage activity";
    config.type = "note";
  }
  // A failing step leaves the next ones running, as each stage action had its own savepoint.
  return { handler: `${KON_ID}:${action.type.replace(/_/g, "-")}`, config, continueOnError: true };
}

/** The two rules a stage's actions become, or `null` for a side without actions. */
export function rulesOfStage(stage: {
  id: string;
  name: string;
  onEnterActions?: unknown;
  onExitActions?: unknown;
}): { enter: KonRule | null; exit: KonRule | null } {
  const build = (side: "enter" | "exit", actions: unknown): KonRule | null => {
    const steps = (Array.isArray(actions) ? (actions as StageAction[]) : [])
      .map(stageActionToStep)
      .filter((s): s is NonNullable<typeof s> => s !== null);
    if (steps.length === 0) return null;
    return {
      slug: `stage-${stage.id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${side}`.slice(0, 100),
      name: `${side === "enter" ? "On entering" : "On leaving"} stage: ${stage.name}`,
      event: "crm:deal.moved",
      conditions: [{ field: side === "enter" ? "toStageId" : "fromStageId", op: "eq", value: stage.id }],
      match: "all",
      steps,
      enabled: true,
      ownerUserId: null,
    };
  };
  return { enter: build("enter", stage.onEnterActions), exit: build("exit", stage.onExitActions) };
}

export interface SyncResult {
  engine: boolean;
  rules: string[];
  stages: string[];
}

/**
 * Moves stage actions into the core's rules and empties the stage's columns. Only with `ctx.automation`;
 * without it nothing changes and the CRM's runner keeps running them. `stageIds` narrows it to some stages
 * (the stage editor); without it every stage is looked at (startup).
 */
export async function syncStageRules(ctx: KonContext, db: CrmDb, stageIds?: string[]): Promise<SyncResult> {
  const automation = automationOf(ctx);
  if (!automation) return { engine: false, rules: [], stages: [] };
  const stages = await db
    .select({
      id: crmPipelineStages.id,
      name: crmPipelineStages.name,
      onEnterActions: crmPipelineStages.onEnterActions,
      onExitActions: crmPipelineStages.onExitActions,
    })
    .from(crmPipelineStages);
  const result: SyncResult = { engine: true, rules: [], stages: [] };
  for (const stage of stages) {
    if (stageIds && !stageIds.includes(stage.id)) continue;
    const enterActions = Array.isArray(stage.onEnterActions) ? stage.onEnterActions : [];
    const exitActions = Array.isArray(stage.onExitActions) ? stage.onExitActions : [];
    if (enterActions.length === 0 && exitActions.length === 0) continue;
    const { enter, exit } = rulesOfStage(stage);
    // The columns only empty once BOTH sides are stored in the engine: half a migration would lose actions.
    for (const rule of [enter, exit]) {
      if (!rule) continue;
      await automation.upsertRule(KON_ID, rule);
      result.rules.push(rule.slug);
    }
    await db
      .update(crmPipelineStages)
      .set({ onEnterActions: [], onExitActions: [], updatedAt: new Date() })
      .where(eq(crmPipelineStages.id, stage.id));
    result.stages.push(stage.id);
  }
  return result;
}

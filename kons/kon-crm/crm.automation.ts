/**
 * What a stage does when a deal enters or leaves it
 * ============================================================================
 *
 * Stages could always store `onEnterActions` and `onExitActions`, and nothing ran them. Now `move-deal` does.
 *
 * Each action runs in its own savepoint: a broken rule must not stop a person from moving a deal, and it must
 * not undo the actions before it. A failure is written on the deal as a note, so it does not go unseen.
 *
 * `webhook` and `send_email` are refused when the stage is configured. A webhook needs protection against
 * reaching internal addresses, which this kon does not have, and email needs a template the core can check.
 * Emit-side integrations can listen to the `crm:deal:stage-changed` event instead.
 */

import { withSavepoint } from "@kitsuden/engine";
import { eq } from "drizzle-orm";

import { logDealWork } from "./crm.billing";
import type { CrmDb } from "./crm.db";
import { crmActivities, crmDeals, type StageAction } from "./crm.schema";

export const SUPPORTED_ACTIONS = [
  "create_task",
  "create_activity",
  "create_calendar_event",
  "log_time",
  "update_field",
] as const;

type Deal = typeof crmDeals.$inferSelect;

/** Fields a stage may change. Stage, owner and amount are decisions, not side effects. */
const UPDATABLE = new Set(["probability", "status", "lostReason", "campaign"]);

function fieldOf(deal: Deal, field: string): unknown {
  if (field.startsWith("custom.")) {
    return ((deal.customFields as Record<string, unknown> | null) ?? {})[field.slice("custom.".length)];
  }
  return (deal as unknown as Record<string, unknown>)[field];
}

export function conditionHolds(action: StageAction, deal: Deal): boolean {
  const c = action.condition;
  if (!c) return true;
  const actual = fieldOf(deal, c.field);
  switch (c.operator) {
    case "==":
      return actual === c.value;
    case "!=":
      return actual !== c.value;
    case ">":
      return Number(actual) > Number(c.value);
    case "<":
      return Number(actual) < Number(c.value);
    case ">=":
      return Number(actual) >= Number(c.value);
    case "<=":
      return Number(actual) <= Number(c.value);
    case "exists":
      return actual !== null && actual !== undefined && actual !== "";
    default:
      return false;
  }
}

async function runOne(db: CrmDb, action: StageAction, deal: Deal, userId: string | null): Promise<void> {
  const common = {
    subject: action.title ?? deal.title,
    dealId: deal.id,
    contactId: deal.contactId,
    companyId: deal.companyId,
    assignedTo: deal.assignedTo,
    createdBy: userId,
    origin: "automation" as const,
  };
  const dueInDays = typeof action.value === "number" ? action.value : null;
  const dueDate = dueInDays === null ? null : new Date(Date.now() + dueInDays * 86_400_000);
  switch (action.type) {
    case "create_task":
      await db.insert(crmActivities).values({ ...common, type: "task", dueDate });
      return;
    case "create_activity":
      await db.insert(crmActivities).values({ ...common, type: "note" });
      return;
    case "create_calendar_event":
      await db.insert(crmActivities).values({ ...common, type: "meeting", dueDate });
      return;
    case "log_time": {
      // `value` is the quantity in the resource's unit (hours by default); kon-conta keeps it as unbilled work.
      if (typeof action.value !== "number" || action.value <= 0) throw new Error("log_time needs the quantity in value");
      await logDealWork(db, deal, { quantity: action.value, description: action.title ?? `Stage work: ${deal.title}`, userId });
      return;
    }
    case "update_field": {
      if (!action.field) throw new Error("update_field needs a field");
      if (action.field.startsWith("custom.")) {
        const custom = { ...((deal.customFields as Record<string, unknown> | null) ?? {}) };
        custom[action.field.slice("custom.".length)] = action.value;
        await db.update(crmDeals).set({ customFields: custom }).where(eq(crmDeals.id, deal.id));
        deal.customFields = custom;
        return;
      }
      if (!UPDATABLE.has(action.field)) throw new Error(`A stage cannot change ${action.field}`);
      await db.update(crmDeals).set({ [action.field]: action.value }).where(eq(crmDeals.id, deal.id));
      return;
    }
    default:
      throw new Error(`Unsupported action: ${action.type}`);
  }
}

export interface AutomationResult {
  ran: string[];
  failed: { type: string; error: string }[];
}

export async function runStageActions(
  db: CrmDb,
  actions: StageAction[] | null | undefined,
  deal: Deal,
  userId: string | null
): Promise<AutomationResult> {
  const result: AutomationResult = { ran: [], failed: [] };
  for (const action of actions ?? []) {
    if (!conditionHolds(action, deal)) continue;
    try {
      await withSavepoint(async () => runOne(db, action, deal, userId));
      result.ran.push(action.type);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push({ type: action.type, error: message });
    }
  }
  if (result.failed.length > 0) {
    await db.insert(crmActivities).values({
      type: "note",
      subject: "A stage automation failed",
      dealId: deal.id,
      contactId: deal.contactId,
      createdBy: userId,
      origin: "automation",
      metadata: { failed: result.failed },
    });
  }
  return result;
}

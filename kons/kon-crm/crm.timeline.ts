/**
 * One contact's (or one deal's) story, in one list
 * ============================================================================
 *
 * `view-timeline` puts together what the CRM wrote and what the other kons linked:
 *
 *   activity   calls, emails, meetings, notes and tasks on the contact or on its deals
 *   stage      every move of its deals between stages, with who moved them and why
 *   link       whatever another kon tied to it through `kitsuden_links`: an order (shop), a payment, a
 *              newsletter membership, an email or meeting synced from a mailbox (kon-inbox)
 *
 * Newest first. A link shows the summary written when it was made (crm.connected.ts); the CRM never reads
 * another kon's tables, so it never shows more of them than the event said.
 *
 * ── WHAT IT DOES NOT SHOW ──────────────────────────────────────────────────
 *
 * A contact or deal the reader may not see answers 404, like reading it would (RLS on `crm_contacts` and
 * `crm_deals`). Notes and amounts go out through `registry()` like every CRM response: activity bodies are
 * nested as `activity` so `withoutNotes` recognizes them, and link amounts are `amountValue`, which
 * `withoutMoney` removes.
 */

import { AppError, neighbors } from "@kitsuden/engine";
import { desc, eq, inArray, or } from "drizzle-orm";
import { z } from "@kitsuden/engine/zod";

import { LINK_TYPE } from "./crm.connected";
import { dbDe } from "./crm.context";
import type { CrmDb } from "./crm.db";
import { crmActivities, crmContacts, crmDeals, crmPipelineStages, crmStageTransitions } from "./crm.schema";
import { VIEW, type registry } from "./operations";

export type TimelineItem =
  | { kind: "activity"; at: string; activity: Record<string, unknown> }
  | {
      kind: "stage";
      at: string;
      dealId: string;
      dealTitle: string;
      fromStage: string | null;
      toStage: string | null;
      movedBy: string | null;
      moveReason: string | null;
    }
  | {
      kind: "link";
      at: string;
      /** The other end: `shop_orders`, `pay_events`, `nl_members`, `inbox_messages`, `inbox_events`… */
      type: string;
      id: string;
      relation: string;
      /** Which CRM record it hangs from, when the timeline covers a contact and its deals. */
      on: { type: string; id: string };
      summary: Record<string, unknown>;
    };

const Query = z.object({
  contactId: z.string().min(1).max(64).optional().describe("Whose story: a contact (with its deals)"),
  dealId: z.string().min(1).max(64).optional().describe("Or one deal"),
  limit: z.coerce.number().int().min(1).max(500).optional().describe("At most this many items (100)"),
});

function iso(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value ?? 0));
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/** The story, newest first. Throws 404 when the reader cannot see the contact or deal. */
export async function timelineOf(
  db: CrmDb,
  target: { contactId?: string; dealId?: string },
  limit = 100
): Promise<TimelineItem[]> {
  let dealIds: string[];
  let anchors: Array<{ type: string; id: string }>;
  let activityWhere;

  if (target.contactId) {
    const [contact] = await db.select({ id: crmContacts.id }).from(crmContacts).where(eq(crmContacts.id, target.contactId)).limit(1);
    if (!contact) throw AppError.notFound("Contact not found");
    const deals = await db.select({ id: crmDeals.id }).from(crmDeals).where(eq(crmDeals.contactId, contact.id)).limit(500);
    dealIds = deals.map((d: { id: string }) => d.id);
    anchors = [{ type: LINK_TYPE.contact, id: contact.id }, ...dealIds.map((id) => ({ type: LINK_TYPE.deal, id }))];
    activityWhere =
      dealIds.length > 0
        ? or(eq(crmActivities.contactId, contact.id), inArray(crmActivities.dealId, dealIds))
        : eq(crmActivities.contactId, contact.id);
  } else if (target.dealId) {
    const [deal] = await db.select({ id: crmDeals.id }).from(crmDeals).where(eq(crmDeals.id, target.dealId)).limit(1);
    if (!deal) throw AppError.notFound("Deal not found");
    dealIds = [deal.id];
    anchors = [{ type: LINK_TYPE.deal, id: deal.id }];
    activityWhere = eq(crmActivities.dealId, deal.id);
  } else {
    throw AppError.validation("Give a contactId or a dealId");
  }

  const items: TimelineItem[] = [];

  const activities = await db.select().from(crmActivities).where(activityWhere).orderBy(desc(crmActivities.createdAt)).limit(limit);
  for (const a of activities) items.push({ kind: "activity", at: iso(a.completedAt ?? a.createdAt), activity: a });

  if (dealIds.length > 0) {
    const moves = await db
      .select({
        dealId: crmStageTransitions.dealId,
        fromStageId: crmStageTransitions.fromStageId,
        toStageId: crmStageTransitions.toStageId,
        enteredAt: crmStageTransitions.enteredAt,
        movedBy: crmStageTransitions.movedBy,
        moveReason: crmStageTransitions.moveReason,
      })
      .from(crmStageTransitions)
      .where(inArray(crmStageTransitions.dealId, dealIds))
      .orderBy(desc(crmStageTransitions.enteredAt))
      .limit(limit);
    const stageIds = [...new Set(moves.flatMap((m: { fromStageId: string | null; toStageId: string }) => [m.fromStageId, m.toStageId]).filter(Boolean))] as string[];
    const stages = stageIds.length
      ? await db.select({ id: crmPipelineStages.id, name: crmPipelineStages.name }).from(crmPipelineStages).where(inArray(crmPipelineStages.id, stageIds))
      : [];
    const stageName = new Map(stages.map((s: { id: string; name: string }) => [s.id, s.name]));
    const titles = await db.select({ id: crmDeals.id, title: crmDeals.title }).from(crmDeals).where(inArray(crmDeals.id, dealIds));
    const title = new Map(titles.map((d: { id: string; title: string }) => [d.id, d.title]));
    for (const m of moves) {
      items.push({
        kind: "stage",
        at: iso(m.enteredAt),
        dealId: m.dealId,
        dealTitle: title.get(m.dealId) ?? "",
        fromStage: m.fromStageId ? (stageName.get(m.fromStageId) ?? null) : null,
        toStage: stageName.get(m.toStageId) ?? null,
        movedBy: m.movedBy ?? null,
        moveReason: m.moveReason ?? null,
      });
    }
  }

  for (const anchor of anchors) {
    const rows = await neighbors(anchor, { limit }, db);
    for (const row of rows) {
      // A deal's own contact and the contact's deals are the CRM's, already above.
      if (row.type === LINK_TYPE.contact || row.type === LINK_TYPE.deal) continue;
      items.push({
        kind: "link",
        at: iso(row.createdAt),
        type: row.type,
        id: row.id,
        relation: row.relation,
        on: anchor,
        summary: row.metadata ?? {},
      });
    }
  }

  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}

export function timelineOperations(routes: ReturnType<typeof registry>): void {
  routes.get(
    "/timeline",
    {
      id: "view-timeline",
      summary: "A contact's or a deal's timeline",
      description:
        "Everything about one contact (with its deals) or one deal, newest first: `activity` (calls, emails, meetings, notes, tasks), `stage` (each move between stages, with who and why) and `link` (what another kon tied to it: a shop order, a payment or refund, a newsletter membership, a synced email or meeting), with the summary written when it was linked. Give `contactId` or `dealId`; `limit` up to 500 (100). 404 when the contact or deal does not exist or is not visible to you. Notes and amounts follow your CRM access. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { query: Query },
      output: { schema: z.object({}).passthrough() },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const q = input.query as z.infer<typeof Query>;
      const items = await timelineOf(dbDe(c), { contactId: q.contactId, dealId: q.dealId }, q.limit ?? 100);
      return c.json({ data: items });
    }
  );
}

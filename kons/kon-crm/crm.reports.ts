/**
 * The CRM's own reports: the funnel, conversion per stage, why deals are lost
 * ============================================================================
 *
 * Each report exists twice, on purpose:
 *
 *   - as a `ReportDefinition` (`CRM_REPORTS`) for Kitsuden's report engine: an aggregate query over this
 *     kon's own tables, listed next to the reports people save, as `kon:kon-crm/<id>`. A Kitsuden without
 *     that engine ignores the declaration.
 *   - as an operation of this kon, `get-report`, which answers on any Kitsuden and adds what an aggregate
 *     over one table cannot: stage names and order, and the conversion from one stage to the next.
 *
 * Both run under the reader's row security on `crm_deals` and `crm_stage_transitions`: someone who sees
 * only their assigned deals gets a funnel of their deals.
 */

import { AppError } from "@kitsuden/engine";
import { sql } from "drizzle-orm";
import { z } from "@kitsuden/engine/zod";

import { dbDe } from "./crm.context";
import type { CrmDb } from "./crm.db";
import { VIEW, type registry } from "./operations";

/** Kitsuden's `ReportDefinition`, structurally (declared here so the kon builds without it). */
export interface CrmReportDefinition {
  id: string;
  name: string;
  description?: string;
  query: {
    source: { table: string };
    measures: Array<{ fn: "count" | "count_distinct" | "sum" | "avg" | "min" | "max"; field?: string; as?: string }>;
    groupBy?: Array<{ field: string; bucket?: "day" | "week" | "month" | "quarter" | "year"; as?: string }>;
    filters?: Array<{ field: string; op: string; value?: unknown }>;
    orderBy?: Array<{ by: string; dir?: "asc" | "desc" }>;
    limit?: number;
  };
  chart?: { type: string; x?: string; y?: string | string[] };
}

export const CRM_REPORTS: CrmReportDefinition[] = [
  {
    id: "funnel",
    name: "Pipeline funnel",
    description: "Open deals per stage, with their value.",
    query: {
      source: { table: "crm_deals" },
      measures: [{ fn: "count", as: "deals" }, { fn: "sum", field: "value", as: "value" }],
      groupBy: [{ field: "stage_id", as: "stage" }],
      filters: [{ field: "status", op: "eq", value: "open" }],
      orderBy: [{ by: "deals", dir: "desc" }],
    },
    chart: { type: "bar", x: "stage", y: "deals" },
  },
  {
    id: "stage-entries",
    name: "Entries per stage",
    description: "How many deals entered each stage, per month: the raw material of conversion.",
    query: {
      source: { table: "crm_stage_transitions" },
      measures: [{ fn: "count_distinct", field: "deal_id", as: "deals" }],
      groupBy: [{ field: "to_stage_id", as: "stage" }, { field: "entered_at", bucket: "month", as: "month" }],
    },
    chart: { type: "line", x: "month", y: "deals" },
  },
  {
    id: "lost-reasons",
    name: "Why deals are lost",
    description: "Lost deals per reason, with the value lost.",
    query: {
      source: { table: "crm_deals" },
      measures: [{ fn: "count", as: "deals" }, { fn: "sum", field: "value", as: "value" }],
      groupBy: [{ field: "lost_reason", as: "reason" }],
      filters: [{ field: "status", op: "eq", value: "lost" }],
      orderBy: [{ by: "deals", dir: "desc" }],
    },
    chart: { type: "bar", x: "reason", y: "deals" },
  },
];

function rows(result: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<Record<string, unknown>>;
}

export async function funnel(db: CrmDb, pipelineId: string) {
  return rows(
    await db.execute(sql`
      SELECT s.id AS "stageId", s.name AS "stage", s."order" AS "position",
        count(d.id) FILTER (WHERE d.status = 'open')::int AS "deals",
        COALESCE(sum(d.value) FILTER (WHERE d.status = 'open'), 0)::bigint AS "value"
      FROM crm_pipeline_stages s
      LEFT JOIN crm_deals d ON d.stage_id = s.id
      WHERE s.pipeline_id = ${pipelineId}
      GROUP BY s.id, s.name, s."order"
      ORDER BY s."order"
    `)
  ).map((r) => ({ ...r, value: Number(r.value) }));
}

/**
 * Per stage: deals that ever entered it, how many moved on to a LATER stage, how many were won having been
 * in it. `conversion` is moved-on over entered, in percent. Ever-entered, not current: a deal that went back
 * still counts once where it was.
 */
export async function stageConversion(db: CrmDb, pipelineId: string) {
  return rows(
    await db.execute(sql`
      WITH entered AS (
        SELECT DISTINCT t.to_stage_id AS stage_id, t.deal_id FROM crm_stage_transitions t
        UNION
        SELECT d.stage_id, d.id FROM crm_deals d
      )
      SELECT s.id AS "stageId", s.name AS "stage", s."order" AS "position",
        count(DISTINCT e.deal_id)::int AS "entered",
        count(DISTINCT e.deal_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM crm_stage_transitions n
          JOIN crm_pipeline_stages ns ON ns.id = n.to_stage_id
          WHERE n.deal_id = e.deal_id AND n.from_stage_id = s.id AND ns."order" > s."order"
        ))::int AS "movedOn",
        count(DISTINCT e.deal_id) FILTER (WHERE d.status = 'won')::int AS "won"
      FROM crm_pipeline_stages s
      LEFT JOIN entered e ON e.stage_id = s.id
      LEFT JOIN crm_deals d ON d.id = e.deal_id
      WHERE s.pipeline_id = ${pipelineId}
      GROUP BY s.id, s.name, s."order"
      ORDER BY s."order"
    `)
  ).map((r) => ({
    ...r,
    conversion: Number(r.entered) > 0 ? Math.round((Number(r.movedOn) / Number(r.entered)) * 1000) / 10 : null,
  }));
}

export async function lostReasons(db: CrmDb) {
  return rows(
    await db.execute(sql`
      SELECT COALESCE(NULLIF(trim(lost_reason), ''), '(no reason)') AS "reason",
        count(*)::int AS "deals", COALESCE(sum(value), 0)::bigint AS "value"
      FROM crm_deals WHERE status = 'lost'
      GROUP BY 1 ORDER BY 2 DESC, 1
    `)
  ).map((r) => ({ ...r, value: Number(r.value) }));
}

const ReportParam = z.object({ id: z.enum(["funnel", "stage-conversion", "lost-reasons"]) });
const ReportQuery = z.object({ pipelineId: z.string().min(1).max(64).optional() });

export function reportOperations(routes: ReturnType<typeof registry>): void {
  routes.get(
    "/reports/:id",
    {
      id: "get-report",
      summary: "One of the CRM's reports",
      description:
        "`funnel`: open deals and their value per stage of `pipelineId`, in stage order. `stage-conversion`: per stage of `pipelineId`, deals that ever entered it, how many moved on to a later stage, how many were won, and the conversion (%). `lost-reasons`: lost deals and value per reason. Amounts in cents, hidden from whoever may not see money. Only deals you may see count. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { params: ReportParam, query: ReportQuery },
      output: { schema: z.object({}).passthrough() },
    },
    async (c, input) => {
      const id = (input.params as z.infer<typeof ReportParam>).id;
      const { pipelineId } = input.query as z.infer<typeof ReportQuery>;
      const db = dbDe(c);
      if (id === "lost-reasons") return c.json({ report: id, data: (await lostReasons(db)).map(renameMoney) });
      if (!pipelineId) throw AppError.validation("This report needs a pipelineId");
      const data = id === "funnel" ? (await funnel(db, pipelineId)).map(renameMoney) : await stageConversion(db, pipelineId);
      return c.json({ report: id, pipelineId, data });
    }
  );
}

/** `value` → `dealValue`, so the CRM's money filter (`withoutMoney`) removes it from whoever may not see amounts. */
function renameMoney(r: Record<string, unknown>) {
  const { value, ...rest } = r;
  return { ...rest, dealValue: value };
}

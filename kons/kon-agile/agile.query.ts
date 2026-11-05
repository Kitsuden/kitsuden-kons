/**
 * Issue filters and grouping, shared by the issue list, saved views, the calendar and the timeline.
 * A saved view stores exactly these filters (`agile_saved_views.filters`), so what a view shows is
 * what the list would show with the same query.
 */

import { AppError, isUuid } from "@kitsuden/engine";
import { and, eq, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  agileIssueLabels,
  agileIssues,
  agileModuleIssues,
  agileStates,
} from "./agile.schema";

export const TYPES = ["issue", "feature", "bug", "improvement", "epic", "sub_issue", "spike"] as const;
export const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export const GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
export const GROUP_BY = [
  "state",
  "stateGroup",
  "assignee",
  "priority",
  "type",
  "cycle",
  "module",
  "initiative",
  "label",
] as const;
export type GroupBy = (typeof GROUP_BY)[number];

const ids = z.array(z.guid()).max(100);
const isoDate = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

/** The filters a saved view keeps and the list accepts. */
export const IssueFilters = z
  .object({
    stateIds: ids.optional(),
    stateGroups: z.array(z.enum(GROUPS)).max(5).optional(),
    assigneeIds: z.array(z.string().min(1).max(128)).max(100).optional(),
    unassigned: z.boolean().optional(),
    labelIds: ids.optional(),
    priorities: z.array(z.enum(PRIORITIES)).max(4).optional(),
    types: z.array(z.enum(TYPES)).max(7).optional(),
    cycleId: z.guid().nullable().optional(),
    moduleId: z.guid().optional(),
    initiativeId: z.guid().nullable().optional(),
    parentId: z.guid().nullable().optional(),
    search: z.string().max(200).optional(),
    includeArchived: z.boolean().optional(),
    targetFrom: isoDate.optional(),
    targetTo: isoDate.optional(),
  })
  .strict();
export type IssueFiltersValue = z.infer<typeof IssueFilters>;

const list = (v: string | undefined) =>
  v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

/**
 * The list's query string (`stateId`, `assigneeId`… one value, or the plural with commas) as
 * filters. Ids that are not uuids are a 400, as before.
 */
export function filtersFromQuery(q: Record<string, string | undefined>): IssueFiltersValue {
  const uuidList = (field: string, v: string | undefined) => {
    const values = list(v);
    for (const x of values ?? []) if (!isUuid(x)) throw AppError.badRequest(`${field} is invalid`);
    return values;
  };
  const one = (field: string, v: string | undefined) => {
    if (v === undefined || v === "") return undefined;
    if (v === "none") return null;
    if (!isUuid(v)) throw AppError.badRequest(`${field} is invalid`);
    return v;
  };
  const raw = {
    stateIds: uuidList("stateId", q.stateIds ?? q.stateId),
    stateGroups: list(q.stateGroups ?? q.stateGroup),
    assigneeIds: list(q.assigneeIds ?? q.assigneeId),
    unassigned: q.unassigned === "true" ? true : undefined,
    labelIds: uuidList("labelId", q.labelIds ?? q.labelId),
    priorities: list(q.priorities ?? q.priority),
    types: list(q.types ?? q.type),
    cycleId: one("cycleId", q.cycleId),
    moduleId: one("moduleId", q.moduleId) ?? undefined,
    initiativeId: one("initiativeId", q.initiativeId),
    parentId: one("parentId", q.parentId),
    search: q.search?.slice(0, 200),
    includeArchived: q.includeArchived === "true" ? true : undefined,
    targetFrom: q.targetFrom,
    targetTo: q.targetTo,
  };
  // An unknown type, priority or group is ignored, as `eqEnum` did before: it does not filter.
  const known = (values: string[] | undefined, allowed: readonly string[]) => {
    const k = values?.filter((v) => allowed.includes(v));
    return k?.length ? k : undefined;
  };
  raw.types = known(raw.types, TYPES);
  raw.priorities = known(raw.priorities, PRIORITIES);
  raw.stateGroups = known(raw.stateGroups, GROUPS);
  const clean = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  const parsed = IssueFilters.safeParse(clean);
  if (!parsed.success) throw AppError.badRequest("Invalid filter");
  return parsed.data;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** The WHERE of the issues of `projectId` that match `f` (the query joins `agile_states`). */
export function issueConditions(projectId: string, f: IssueFiltersValue): SQL[] {
  const c: SQL[] = [eq(agileIssues.projectId, projectId)];
  const none = sql`false`;
  if (!f.includeArchived) c.push(isNull(agileIssues.archivedAt));
  if (f.stateIds) c.push(f.stateIds.length ? inArray(agileIssues.stateId, f.stateIds) : none);
  if (f.stateGroups) c.push(f.stateGroups.length ? inArray(agileStates.group, f.stateGroups) : none);
  if (f.assigneeIds || f.unassigned) {
    const parts: SQL[] = [];
    if (f.assigneeIds?.length) parts.push(inArray(agileIssues.assigneeId, f.assigneeIds));
    if (f.unassigned) parts.push(isNull(agileIssues.assigneeId));
    c.push(parts.length ? (or(...parts) as SQL) : none);
  }
  if (f.priorities) c.push(f.priorities.length ? inArray(agileIssues.priority, f.priorities) : none);
  if (f.types) c.push(f.types.length ? inArray(agileIssues.type, f.types) : none);
  if (f.cycleId !== undefined) {
    c.push(f.cycleId === null ? isNull(agileIssues.cycleId) : eq(agileIssues.cycleId, f.cycleId));
  }
  if (f.initiativeId !== undefined) {
    c.push(
      f.initiativeId === null
        ? isNull(agileIssues.initiativeId)
        : eq(agileIssues.initiativeId, f.initiativeId)
    );
  }
  if (f.parentId !== undefined) {
    c.push(f.parentId === null ? isNull(agileIssues.parentId) : eq(agileIssues.parentId, f.parentId));
  }
  if (f.moduleId) {
    const viaJunction = sql`exists (select 1 from ${agileModuleIssues} mi where mi.issue_id = ${agileIssues.id} and mi.module_id = ${f.moduleId})`;
    c.push(or(eq(agileIssues.moduleId, f.moduleId), viaJunction) as SQL);
  }
  if (f.labelIds) {
    c.push(
      f.labelIds.length
        ? sql`exists (select 1 from ${agileIssueLabels} il where il.issue_id = ${agileIssues.id} and il.label_id in (${sql.join(
            f.labelIds.map((id) => sql`${id}::uuid`),
            sql`, `
          )}))`
        : none
    );
  }
  if (f.search) {
    const term = `%${escapeLike(f.search)}%`;
    c.push(
      or(
        sql`${agileIssues.name} ILIKE ${term}`,
        sql`${agileIssues.key} ILIKE ${term}`
      ) as SQL
    );
  }
  if (f.targetFrom) c.push(gte(agileIssues.targetDate, new Date(f.targetFrom)));
  if (f.targetTo) c.push(lte(agileIssues.targetDate, endOfDay(f.targetTo)));
  return c;
}

/** `YYYY-MM-DD` as an upper bound covers the whole day. */
export function endOfDay(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T23:59:59.999Z`) : new Date(value);
}

export const hasTargetDate = isNotNull(agileIssues.targetDate);

/** Rows of the list, grouped by one key (and optionally a second one inside each group). */
export function groupRows<T extends Record<string, unknown>>(
  rows: T[],
  keyOf: (row: T) => string[],
  subKeyOf?: (row: T) => string[]
) {
  const groups = new Map<string, { key: string; issues: T[]; sub?: Map<string, T[]> }>();
  for (const row of rows) {
    for (const k of keyOf(row)) {
      let g = groups.get(k);
      if (!g) {
        g = { key: k, issues: [], sub: subKeyOf ? new Map() : undefined };
        groups.set(k, g);
      }
      g.issues.push(row);
      if (subKeyOf && g.sub) {
        for (const sk of subKeyOf(row)) {
          const list = g.sub.get(sk) ?? [];
          list.push(row);
          g.sub.set(sk, list);
        }
      }
    }
  }
  return [...groups.values()].map((g) => ({
    key: g.key,
    count: g.issues.length,
    issues: subKeyOf ? undefined : g.issues,
    groups: g.sub
      ? [...g.sub.entries()].map(([key, issues]) => ({ key, count: issues.length, issues }))
      : undefined,
  }));
}

/** Combines conditions; a single list is AND-ed. */
export const all = (conditions: SQL[]) => and(...conditions);

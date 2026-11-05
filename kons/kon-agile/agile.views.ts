/**
 * kon-agile — saved views, calendar, timeline and dashboard (1.3)
 * ============================================================================
 *
 * A saved view is a set of filters (agile.query.ts), a grouping and a layout. A private view is its
 * owner's; a shared one is the project's and only people with write rights share or change it
 * (agents never: the database says the same, migration 0005).
 *
 * The calendar, the timeline and the dashboard are read-only and computed from the issues as
 * they are: there is no stored snapshot, so the burn-up counts an issue in the cycle's scope from
 * the day it was created, not from the day it was moved into the cycle.
 */

import { AppError, isUuid, type AnyOperation } from "@kitsuden/engine";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";

import { isAgent, type AgileAccess } from "./agile.access";
import type { AgileDb } from "./agile.db";
import {
  GROUP_BY,
  IssueFilters,
  groupRows,
  issueConditions,
  type GroupBy,
} from "./agile.query";
import {
  agileComments,
  agileCycles,
  agileInitiatives,
  agileIssueLabels,
  agileIssues,
  agileModules,
  agileSavedViews,
  agileStates,
  VIEW_LAYOUTS,
} from "./agile.schema";
import { ANY_ACCOUNT, declareOp, ListWithTotal, ProjectParam, REST_ONLY, Row, Success, query, registry, text } from "./operations";

const ViewParam = z.object({ viewId: z.string().describe("Saved view id (uuid)") });
const Anything = z.object({}).passthrough();

const viewSchema = z.object({
  name: z.string().min(1).max(100),
  layout: z.enum(VIEW_LAYOUTS).optional(),
  filters: IssueFilters.optional(),
  groupBy: z.enum(GROUP_BY).nullable().optional(),
  subGroupBy: z.enum(GROUP_BY).nullable().optional(),
  display: z
    .object({
      fields: z.array(z.string().max(50)).max(30).optional(),
      showSubIssues: z.boolean().optional(),
      showEmptyGroups: z.boolean().optional(),
      orderBy: z.enum(["createdAt", "updatedAt", "priority", "targetDate", "sortOrder"]).optional(),
    })
    .strict()
    .optional(),
  isShared: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

const DAY = 86_400_000;
const MAX_RANGE_DAYS = 400;

/** `from`/`to` of a calendar or timeline: dates, in order, at most MAX_RANGE_DAYS apart. */
function range(q: Record<string, string | undefined>) {
  const from = q.from ? new Date(q.from) : null;
  const to = q.to ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(q.to) ? `${q.to}T23:59:59.999Z` : q.to) : null;
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw AppError.badRequest("from and to are required dates (YYYY-MM-DD)");
  }
  if (to < from) throw AppError.badRequest("to is before from");
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY) {
    throw AppError.badRequest(`The range is at most ${MAX_RANGE_DAYS} days`);
  }
  return { from, to };
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Monday 00:00 UTC of the week of `d`. */
function weekStart(d: Date) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
}

export function viewOperations(db: { instance: AgileDb }, access: AgileAccess): AnyOperation[] {
  const routes = registry();
  const { projectFor, userValue } = access;

  const declare: typeof declareOp = (id, summary, description, input, output = { schema: Anything }, errors) =>
    declareOp(id, summary, description, input, output, errors);

  const WHO_SEES = "Only for members of the project (and admin); anyone else gets 404.";

  /** The view, if the caller can see it (private views of others do not exist for them). */
  async function viewFor(c: Parameters<typeof projectFor>[0], viewId: string, write: boolean) {
    if (!isUuid(viewId)) throw AppError.notFound("View not found");
    const [view] = await db.instance.select().from(agileSavedViews).where(eq(agileSavedViews.id, viewId)).limit(1);
    if (!view) throw AppError.notFound("View not found");
    let found;
    try {
      found = await projectFor(c, view.projectId, "view");
    } catch (e) {
      if ((e as { status?: number }).status === 404) throw AppError.notFound("View not found");
      throw e;
    }
    const mine = view.ownerId === found.user.id;
    if (!view.isShared && !mine && found.user.role !== "admin") throw AppError.notFound("View not found");
    if (write && view.isShared) await requireSharer(c, view.projectId);
    if (write && !view.isShared && !mine && found.user.role !== "admin") {
      throw AppError.forbidden("Only its owner changes a private view");
    }
    return { view, ...found };
  }

  /** Sharing a view, or changing a shared one: write rights, and a person. */
  async function requireSharer(c: Parameters<typeof projectFor>[0], projectId: string) {
    const { user } = await projectFor(c, projectId, "write");
    if (isAgent(user)) throw AppError.forbidden("An agent does not change the project's shared views");
  }

  routes.get(
    "/:projectId/views",
    declare("list-views", "List my saved views of a project", `The project's shared views and the caller's private ones, in order. ${WHO_SEES}`, { params: ProjectParam }, { schema: ListWithTotal }),
    async (c, input) => {
      const { project, user } = await projectFor(c, input.params.projectId, "view");
      const docs = await db.instance
        .select()
        .from(agileSavedViews)
        .where(
          and(
            eq(agileSavedViews.projectId, project.id),
            or(eq(agileSavedViews.isShared, true), eq(agileSavedViews.ownerId, user.id))
          )
        )
        .orderBy(asc(agileSavedViews.sortOrder), asc(agileSavedViews.name));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  routes.post(
    "/:projectId/views",
    declare("create-view", "Save a view", `Filters (as the issue list takes them), grouping (\`groupBy\`, \`subGroupBy\`), layout (board, table, calendar, timeline) and display options. Any member saves a private view; \`isShared\` needs write rights and a person (403). ${WHO_SEES}`, { params: ProjectParam, body: viewSchema }, { status: 201, schema: Row }),
    async (c, input) => {
      const { project, user } = await projectFor(c, input.params.projectId, "view");
      const body: z.infer<typeof viewSchema> = input.body;
      if (body.isShared) await requireSharer(c, project.id);
      const [view] = await db.instance
        .insert(agileSavedViews)
        .values({
          projectId: project.id,
          name: body.name,
          layout: body.layout ?? "board",
          filters: body.filters ?? {},
          groupBy: body.groupBy ?? null,
          subGroupBy: body.subGroupBy ?? null,
          display: body.display ?? {},
          isShared: body.isShared ?? false,
          ownerId: user.id,
          sortOrder: body.sortOrder ?? 0,
        })
        .returning();
      return c.json(view, 201);
    }
  );

  routes.patch(
    "/views/:viewId",
    declare("update-view", "Change a saved view", `A private view is changed by its owner; a shared one (or sharing a private one) by people with write rights in the project (403). Someone else's private view is a 404.`, { params: ViewParam, body: viewSchema.partial() }, { schema: Row }),
    async (c, input) => {
      const { view } = await viewFor(c, input.params.viewId, true);
      const body: Partial<z.infer<typeof viewSchema>> = input.body;
      if (body.isShared && !view.isShared) await requireSharer(c, view.projectId);
      const [row] = await db.instance
        .update(agileSavedViews)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(agileSavedViews.id, view.id))
        .returning();
      return c.json(row);
    }
  );

  routes.delete(
    "/views/:viewId",
    declare("delete-view", "Delete a saved view", `Same rights as changing it.`, { params: ViewParam }, { schema: Success }),
    async (c, input) => {
      const { view } = await viewFor(c, input.params.viewId, true);
      await db.instance.delete(agileSavedViews).where(eq(agileSavedViews.id, view.id));
      return c.json({ success: true });
    }
  );

  /** The issues matching a set of filters, with what grouping needs. */
  async function matching(projectId: string, filters: z.infer<typeof IssueFilters>, limit: number) {
    const rows = await db.instance
      .select({
        id: agileIssues.id,
        key: agileIssues.key,
        name: agileIssues.name,
        type: agileIssues.type,
        priority: agileIssues.priority,
        assigneeId: agileIssues.assigneeId,
        estimate: agileIssues.estimate,
        stateId: agileIssues.stateId,
        stateName: agileStates.name,
        stateGroup: agileStates.group,
        cycleId: agileIssues.cycleId,
        moduleId: agileIssues.moduleId,
        initiativeId: agileIssues.initiativeId,
        parentId: agileIssues.parentId,
        targetDate: agileIssues.targetDate,
        startedAt: agileIssues.startedAt,
        completedAt: agileIssues.completedAt,
        createdAt: agileIssues.createdAt,
        updatedAt: agileIssues.updatedAt,
      })
      .from(agileIssues)
      .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
      .where(and(...issueConditions(projectId, filters)))
      .orderBy(asc(agileStates.sequence), asc(agileIssues.sortOrder), asc(agileIssues.createdAt))
      .limit(limit);
    const labels = rows.length
      ? await db.instance
          .select({ issueId: agileIssueLabels.issueId, labelId: agileIssueLabels.labelId })
          .from(agileIssueLabels)
          .where(inArray(agileIssueLabels.issueId, rows.map((r) => r.id)))
      : [];
    const byIssue = new Map<string, string[]>();
    for (const l of labels) byIssue.set(l.issueId, [...(byIssue.get(l.issueId) ?? []), l.labelId]);
    return rows.map((r) => ({ ...r, labelIds: byIssue.get(r.id) ?? [] }));
  }

  type Matched = Awaited<ReturnType<typeof matching>>[number];
  const keyOf = (by: GroupBy) => (r: Matched): string[] => {
    const v = (x: string | null | undefined) => [x ?? "none"];
    switch (by) {
      case "state":
        return v(r.stateId);
      case "stateGroup":
        return v(r.stateGroup);
      case "assignee":
        return v(r.assigneeId);
      case "priority":
        return v(r.priority);
      case "type":
        return v(r.type);
      case "cycle":
        return v(r.cycleId);
      case "module":
        return v(r.moduleId);
      case "initiative":
        return v(r.initiativeId);
      case "label":
        return r.labelIds.length ? r.labelIds : ["none"];
    }
  };

  routes.get(
    "/views/:viewId/issues",
    declare("run-view", "Show a saved view", `The issues that match the view's filters (up to 500), grouped by its \`groupBy\` (and \`subGroupBy\` inside each group; an issue with several labels appears under each). Without grouping, a flat list. Same visibility as the view.`, { params: ViewParam }),
    async (c, input) => {
      const { view } = await viewFor(c, input.params.viewId, false);
      const filters = IssueFilters.safeParse(view.filters);
      if (!filters.success) throw AppError.conflict("The view's filters are no longer valid: edit the view");
      const rows = await matching(view.projectId, filters.data, 500);
      const groupBy = view.groupBy as GroupBy | null;
      const subGroupBy = view.subGroupBy as GroupBy | null;
      return c.json({
        view,
        total: rows.length,
        groups: groupBy ? groupRows(rows, keyOf(groupBy), subGroupBy ? keyOf(subGroupBy) : undefined) : null,
        issues: groupBy ? undefined : rows,
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // CALENDAR AND TIMELINE
  // ═══════════════════════════════════════════════════════════════════════════════

  const rangeQuery = query({ from: text("First day (YYYY-MM-DD)"), to: text("Last day (YYYY-MM-DD)") });

  routes.get(
    "/:projectId/calendar",
    declare("get-calendar", "Read a project's calendar", `Between \`from\` and \`to\` (required, at most ${MAX_RANGE_DAYS} days): issues due each day (by \`targetDate\`, not archived), cycles that overlap the range, and modules and initiatives whose target date falls in it. ${WHO_SEES}`, { params: ProjectParam, query: rangeQuery }),
    async (c, input) => {
      const { project } = await projectFor(c, input.params.projectId, "view");
      const { from, to } = range(c.req.query());
      const issues = await db.instance
        .select({
          id: agileIssues.id,
          key: agileIssues.key,
          name: agileIssues.name,
          priority: agileIssues.priority,
          assigneeId: agileIssues.assigneeId,
          targetDate: agileIssues.targetDate,
          stateGroup: agileStates.group,
        })
        .from(agileIssues)
        .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
        .where(
          and(
            eq(agileIssues.projectId, project.id),
            isNull(agileIssues.archivedAt),
            gte(agileIssues.targetDate, from),
            lte(agileIssues.targetDate, to)
          )
        )
        .orderBy(asc(agileIssues.targetDate))
        .limit(1000);
      const days: Record<string, typeof issues> = {};
      for (const i of issues) (days[day(i.targetDate!)] ??= []).push(i);
      const cycles = await db.instance
        .select({ id: agileCycles.id, name: agileCycles.name, startDate: agileCycles.startDate, endDate: agileCycles.endDate, status: agileCycles.status })
        .from(agileCycles)
        .where(and(eq(agileCycles.projectId, project.id), lte(agileCycles.startDate, to), gte(agileCycles.endDate, from)));
      const modules = await db.instance
        .select({ id: agileModules.id, name: agileModules.name, targetDate: agileModules.targetDate, status: agileModules.status })
        .from(agileModules)
        .where(and(eq(agileModules.projectId, project.id), gte(agileModules.targetDate, from), lte(agileModules.targetDate, to)));
      const initiatives = await db.instance
        .select({ id: agileInitiatives.id, name: agileInitiatives.name, targetDate: agileInitiatives.targetDate, status: agileInitiatives.status })
        .from(agileInitiatives)
        .where(and(eq(agileInitiatives.projectId, project.id), gte(agileInitiatives.targetDate, from), lte(agileInitiatives.targetDate, to)));
      return c.json({ from: day(from), to: day(to), days, cycles, modules, initiatives });
    }
  );

  routes.get(
    "/:projectId/timeline",
    declare("get-timeline", "Read a project's timeline", `Bars between \`from\` and \`to\` (required, at most ${MAX_RANGE_DAYS} days): each issue from its start (started, else created) to its end (target date, else completed; open-ended bars have \`end: null\`), plus cycles, modules and initiatives with dates. Up to 500 issues, not archived. ${WHO_SEES}`, { params: ProjectParam, query: rangeQuery }),
    async (c, input) => {
      const { project } = await projectFor(c, input.params.projectId, "view");
      const { from, to } = range(c.req.query());
      const start = sql`coalesce(${agileIssues.startedAt}, ${agileIssues.createdAt})`;
      const end = sql`coalesce(${agileIssues.targetDate}, ${agileIssues.completedAt}, ${agileIssues.cancelledAt})`;
      const issues = await db.instance
        .select({
          id: agileIssues.id,
          key: agileIssues.key,
          name: agileIssues.name,
          assigneeId: agileIssues.assigneeId,
          cycleId: agileIssues.cycleId,
          moduleId: agileIssues.moduleId,
          initiativeId: agileIssues.initiativeId,
          stateGroup: agileStates.group,
          start: sql<Date>`${start}`,
          end: sql<Date | null>`${end}`,
        })
        .from(agileIssues)
        .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
        .where(
          and(
            eq(agileIssues.projectId, project.id),
            isNull(agileIssues.archivedAt),
            sql`${start} <= ${to}`,
            sql`(${end} is null or ${end} >= ${from})`
          )
        )
        .orderBy(sql`${start}`)
        .limit(500);
      const cycles = await db.instance
        .select({ id: agileCycles.id, name: agileCycles.name, start: agileCycles.startDate, end: agileCycles.endDate, status: agileCycles.status })
        .from(agileCycles)
        .where(and(eq(agileCycles.projectId, project.id), lte(agileCycles.startDate, to), gte(agileCycles.endDate, from)))
        .orderBy(asc(agileCycles.startDate));
      const modules = await db.instance
        .select({ id: agileModules.id, name: agileModules.name, start: agileModules.startDate, end: agileModules.targetDate, status: agileModules.status, initiativeId: agileModules.initiativeId })
        .from(agileModules)
        .where(and(eq(agileModules.projectId, project.id), or(isNotNull(agileModules.startDate), isNotNull(agileModules.targetDate))));
      const initiatives = await db.instance
        .select({ id: agileInitiatives.id, name: agileInitiatives.name, start: agileInitiatives.startDate, end: agileInitiatives.targetDate, status: agileInitiatives.status })
        .from(agileInitiatives)
        .where(and(eq(agileInitiatives.projectId, project.id), or(isNotNull(agileInitiatives.startDate), isNotNull(agileInitiatives.targetDate))));
      return c.json({ from: day(from), to: day(to), issues, cycles, modules, initiatives });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════════════════════════════════════════

  routes.get(
    "/:projectId/dashboard",
    declare(
      "get-dashboard",
      "Read a project's dashboard",
      `Numbers of the project, computed now: \`throughput\` (issues created and completed per week, last \`weeks\` weeks, default 12, max 52), \`burnup\` of a cycle (\`cycleId\`, default the active one, else the latest started) with scope and done per day and a projected end date from the pace so far, \`breakdown\` of open issues by state group, assignee, priority and type, and \`pulse\` (last 7 days: created, completed, comments; open, overdue and unassigned now). ${WHO_SEES}`,
      { params: ProjectParam, query: query({ weeks: text("Weeks of throughput, 1-52 (default 12)"), cycleId: text("Cycle for the burn-up (uuid)") }) }
    ),
    async (c, input) => {
      const { project } = await projectFor(c, input.params.projectId, "view");
      const q = c.req.query();
      const weeks = Math.min(Math.max(parseInt(q.weeks || "12", 10) || 12, 1), 52);
      const now = new Date();
      const since = new Date(weeks > 0 ? weekStart(now).getTime() - (weeks - 1) * 7 * DAY : now.getTime());

      // Throughput per week
      const weekOf = (col: AnyPgColumn) => sql<string>`to_char(date_trunc('week', ${col}), 'YYYY-MM-DD')`;
      const created = await db.instance
        .select({ week: weekOf(agileIssues.createdAt), n: sql<number>`count(*)::int` })
        .from(agileIssues)
        .where(and(eq(agileIssues.projectId, project.id), gte(agileIssues.createdAt, since)))
        .groupBy(sql`1`);
      const completed = await db.instance
        .select({ week: weekOf(agileIssues.completedAt), n: sql<number>`count(*)::int`, points: sql<number>`coalesce(sum(${agileIssues.estimate}), 0)::int` })
        .from(agileIssues)
        .where(and(eq(agileIssues.projectId, project.id), gte(agileIssues.completedAt, since)))
        .groupBy(sql`1`);
      const throughput = Array.from({ length: weeks }, (_, i) => {
        const w = day(new Date(since.getTime() + i * 7 * DAY));
        return {
          week: w,
          created: created.find((r) => r.week === w)?.n ?? 0,
          completed: completed.find((r) => r.week === w)?.n ?? 0,
          points: completed.find((r) => r.week === w)?.points ?? 0,
        };
      });

      // Burn-up
      let cycleId = q.cycleId;
      if (cycleId && !isUuid(cycleId)) throw AppError.badRequest("cycleId is invalid");
      if (!cycleId) {
        const [cy] = await db.instance
          .select({ id: agileCycles.id })
          .from(agileCycles)
          .where(and(eq(agileCycles.projectId, project.id), lte(agileCycles.startDate, now)))
          .orderBy(desc(agileCycles.isActive), desc(agileCycles.startDate))
          .limit(1);
        cycleId = cy?.id;
      }
      let burnup = null;
      if (cycleId) {
        const [cycle] = await db.instance
          .select()
          .from(agileCycles)
          .where(and(eq(agileCycles.id, cycleId), eq(agileCycles.projectId, project.id)))
          .limit(1);
        if (!cycle) throw AppError.notFound("Cycle not found");
        const issues = await db.instance
          .select({ createdAt: agileIssues.createdAt, completedAt: agileIssues.completedAt, cancelledAt: agileIssues.cancelledAt })
          .from(agileIssues)
          .where(eq(agileIssues.cycleId, cycle.id));
        const last = new Date(Math.min(now.getTime(), cycle.endDate.getTime()));
        const points = [];
        for (let t = cycle.startDate.getTime(); t <= last.getTime() + DAY - 1; t += DAY) {
          const end = new Date(Math.min(t + DAY - 1, last.getTime()));
          const scope = issues.filter((i) => i.createdAt <= end && !(i.cancelledAt && i.cancelledAt <= end)).length;
          const done = issues.filter((i) => i.completedAt && i.completedAt <= end).length;
          points.push({ day: day(new Date(t)), scope, done });
        }
        const latest = points[points.length - 1];
        const elapsedDays = Math.max((last.getTime() - cycle.startDate.getTime()) / DAY, 1);
        const perDay = latest ? latest.done / elapsedDays : 0;
        const remaining = latest ? latest.scope - latest.done : 0;
        const projectedEnd =
          remaining <= 0 ? (latest ? latest.day : null) : perDay > 0 ? day(new Date(last.getTime() + (remaining / perDay) * DAY)) : null;
        burnup = {
          cycle: { id: cycle.id, name: cycle.name, startDate: cycle.startDate, endDate: cycle.endDate, status: cycle.status },
          points,
          perDay,
          projectedEnd,
          onTime: projectedEnd ? new Date(projectedEnd) <= cycle.endDate : null,
        };
      }

      // Breakdown of open issues
      const open = and(eq(agileIssues.projectId, project.id), isNull(agileIssues.archivedAt));
      const by = async (col: typeof agileIssues.assigneeId | typeof agileIssues.priority | typeof agileIssues.type | typeof agileStates.group) =>
        db.instance
          .select({ key: sql<string | null>`${col}`, n: sql<number>`count(*)::int` })
          .from(agileIssues)
          .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
          .where(and(open, sql`${agileStates.group} not in ('completed', 'cancelled')`))
          .groupBy(sql`1`);
      const byGroup = await db.instance
        .select({ key: agileStates.group, n: sql<number>`count(*)::int` })
        .from(agileIssues)
        .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
        .where(open)
        .groupBy(agileStates.group);
      const breakdown = {
        stateGroup: byGroup,
        assignee: await by(agileIssues.assigneeId),
        priority: await by(agileIssues.priority),
        type: await by(agileIssues.type),
      };

      // Pulse
      const week = new Date(now.getTime() - 7 * DAY);
      const [pulse] = await db.instance
        .select({
          created: sql<number>`count(*) filter (where ${agileIssues.createdAt} >= ${week})::int`,
          completed: sql<number>`count(*) filter (where ${agileIssues.completedAt} >= ${week})::int`,
          open: sql<number>`count(*) filter (where ${agileStates.group} not in ('completed', 'cancelled') and ${agileIssues.archivedAt} is null)::int`,
          overdue: sql<number>`count(*) filter (where ${agileStates.group} not in ('completed', 'cancelled') and ${agileIssues.archivedAt} is null and ${agileIssues.targetDate} < ${now})::int`,
          unassigned: sql<number>`count(*) filter (where ${agileStates.group} not in ('completed', 'cancelled') and ${agileIssues.archivedAt} is null and ${agileIssues.assigneeId} is null)::int`,
        })
        .from(agileIssues)
        .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
        .where(eq(agileIssues.projectId, project.id));
      const [comments] = await db.instance
        .select({ n: sql<number>`count(*)::int` })
        .from(agileComments)
        .innerJoin(agileIssues, eq(agileComments.issueId, agileIssues.id))
        .where(and(eq(agileIssues.projectId, project.id), gte(agileComments.createdAt, week)));

      return c.json({
        throughput,
        burnup,
        breakdown,
        pulse: { ...pulse, comments: comments?.n ?? 0, since: day(week) },
      });
    }
  );

  void userValue;
  return routes.ops;
}

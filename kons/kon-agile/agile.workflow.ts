/**
 * What happens around an issue change, and the kon's periodic work.
 * ============================================================================
 *
 * Every route that creates or changes an issue goes through `prepareIssue` (before writing) and
 * `afterIssue` (after), so the same rules hold for the board, intake approval, hand-offs and agents:
 *
 *   · entering a state checks its `validations` (assignee, estimate, description) → 422;
 *   · the state's group stamps `startedAt`, `completedAt`, `cancelledAt`;
 *   · `config.autoAssign[stateId]` assigns the issue when it enters that state;
 *   · every changed field goes to `agile_activity_log`;
 *   · a new assignee gets a notification and, if it is an agent, a row of work.
 *
 * Agents and runs. The core gives a kon no way to start an agent run nor to wake an external
 * agent (2026-11-03): `runAgent` is internal and the only push to agents is the proposal webhook.
 * So the kon keeps its own queue, `agile_agent_work`: assigning, mentioning, handing off or a
 * schedule writes a row; the agent reads its queue over MCP (`agile_my_work`), does the work on
 * the board and closes the row with what it cost. `agile:agent_work` is also emitted on the
 * host's event bus for whoever wants to wake the agent sooner.
 *
 * Mentions notify inside the kon (`agile_notifications`), not by email: the host never gives a
 * kon the email address of an account.
 */

import { AppError } from "@kitsuden/engine";
import { and, asc, eq, gt, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";

import type { AgileAccess, User } from "./agile.access";
import type { AgileDb } from "./agile.db";
import {
  agileAgentSchedules,
  agileAgentWork,
  agileComments,
  agileCycles,
  agileIssues,
  agileNotifications,
  agileProjectMembers,
  agileProjects,
  agileStates,
  type AgileIssue,
  type AgileProject,
  WORK_TRIGGERS,
} from "./agile.schema";

export const SYSTEM_ACTOR = "system";
type Trigger = (typeof WORK_TRIGGERS)[number];
type IssueValues = Partial<typeof agileIssues.$inferInsert>;

/** Fields whose change goes to the history. */
const TRACKED = [
  "name",
  "type",
  "priority",
  "stateId",
  "assigneeId",
  "cycleId",
  "moduleId",
  "parentId",
  "initiativeId",
  "estimate",
  "targetDate",
  "archivedAt",
  "descriptionHtml",
] as const;

const comparable = (v: unknown) => (v instanceof Date ? v.toISOString() : (v ?? null));

export interface Hooks {
  emit?: (event: string, data: unknown) => void;
  logger?: { warn: (m: string, meta?: Record<string, unknown>) => void };
}

export function agileWorkflow(db: { instance: AgileDb }, access: AgileAccess, hooks: Hooks = {}) {
  const { logActivity, recountSubIssues, roleIn } = access;

  async function stateById(id: string) {
    const [s] = await db.instance.select().from(agileStates).where(eq(agileStates.id, id)).limit(1);
    return s ?? null;
  }

  /**
   * The values to write, with the state's rules applied. `before` is null for a new issue.
   * `explicitAssignee`: the request set the assignee itself (auto-assign does not override it).
   */
  async function prepareIssue(
    project: AgileProject,
    before: AgileIssue | null,
    values: IssueValues,
    explicitAssignee: boolean
  ): Promise<IssueValues> {
    const out: IssueValues = { ...values };
    const stateId = out.stateId ?? before?.stateId;
    const entering = !!stateId && (before === null || (out.stateId !== undefined && out.stateId !== before.stateId));
    if (!entering || !stateId) return out;

    const state = await stateById(stateId);
    if (!state) return out;

    const rule = project.config?.autoAssign?.[stateId];
    if (rule && !explicitAssignee && (await roleIn(project, rule))) out.assigneeId = rule;

    const final = { ...before, ...out };
    const v = state.validations ?? {};
    if (v.requireAssignee && !final.assigneeId) {
      throw AppError.validation(`"${state.name}" needs an assignee`, { field: "assigneeId" });
    }
    if (v.requireEstimate && (final.estimate === null || final.estimate === undefined)) {
      throw AppError.validation(`"${state.name}" needs an estimate`, { field: "estimate" });
    }
    if (v.requireDescription && !(final.descriptionText ?? "").trim()) {
      throw AppError.validation(`"${state.name}" needs a description`, { field: "descriptionHtml" });
    }

    const now = new Date();
    if (state.group === "started" && !before?.startedAt) out.startedAt = now;
    if (state.group === "completed") {
      out.completedAt = now;
      out.cancelledAt = null;
    } else if (state.group === "cancelled") {
      out.cancelledAt = now;
      out.completedAt = null;
    } else {
      out.completedAt = null;
      out.cancelledAt = null;
    }
    return out;
  }

  async function isAgentMember(projectId: string, userId: string) {
    const [row] = await db.instance
      .select({ isAgent: agileProjectMembers.isAgent })
      .from(agileProjectMembers)
      .where(and(eq(agileProjectMembers.projectId, projectId), eq(agileProjectMembers.userId, userId)))
      .limit(1);
    return row?.isAgent === true;
  }

  async function notify(n: {
    projectId: string;
    issueId?: string | null;
    commentId?: string | null;
    userId: string;
    actorId: string;
    kind: "mention" | "assigned" | "handoff" | "agent_work";
    message?: string;
  }) {
    if (n.userId === n.actorId) return;
    await db.instance.insert(agileNotifications).values({
      projectId: n.projectId,
      issueId: n.issueId ?? null,
      commentId: n.commentId ?? null,
      userId: n.userId,
      actorId: n.actorId,
      kind: n.kind,
      message: n.message,
    });
  }

  /**
   * One row of work for an agent. A row already queued for the same agent, issue and trigger is
   * not repeated (assigning twice, or two mentions before it picked the first one up).
   */
  async function queueAgentWork(w: {
    projectId: string;
    issueId?: string | null;
    agentId: string;
    trigger: Trigger;
    prompt?: string | null;
    requestedBy?: string | null;
    scheduleId?: string | null;
  }) {
    const [already] = await db.instance
      .select({ id: agileAgentWork.id })
      .from(agileAgentWork)
      .where(
        and(
          eq(agileAgentWork.agentId, w.agentId),
          eq(agileAgentWork.status, "queued"),
          eq(agileAgentWork.trigger, w.trigger),
          w.issueId ? eq(agileAgentWork.issueId, w.issueId) : isNull(agileAgentWork.issueId),
          w.scheduleId ? eq(agileAgentWork.scheduleId, w.scheduleId) : undefined
        )
      )
      .limit(1);
    if (already) return already;
    const [row] = await db.instance
      .insert(agileAgentWork)
      .values({
        projectId: w.projectId,
        issueId: w.issueId ?? null,
        agentId: w.agentId,
        trigger: w.trigger,
        prompt: w.prompt ?? null,
        requestedBy: w.requestedBy ?? null,
        scheduleId: w.scheduleId ?? null,
      })
      .returning();
    hooks.emit?.("agile:agent_work", {
      workId: row.id,
      projectId: row.projectId,
      issueId: row.issueId,
      agentId: row.agentId,
      trigger: row.trigger,
    });
    return row;
  }

  /** History, sub-issue counts, notifications and agent work after an issue was written. */
  async function afterIssue(
    project: AgileProject,
    actor: User | { id: string },
    before: AgileIssue | null,
    after: AgileIssue,
    opts: { handoffNote?: string; customFieldsChanged?: boolean } = {}
  ) {
    if (before === null) {
      await logActivity({
        actorId: actor.id,
        projectId: project.id,
        issueId: after.id,
        entityType: "issue",
        entityId: after.id,
        action: "created",
        description: after.name,
      });
    } else {
      const changes: Record<string, [unknown, unknown]> = {};
      for (const f of TRACKED) {
        if (comparable(before[f]) !== comparable(after[f])) {
          changes[f] = f === "descriptionHtml" ? ["…", "…"] : [comparable(before[f]), comparable(after[f])];
        }
      }
      if (opts.customFieldsChanged) {
        changes.customFields = [before.props?.customFields ?? {}, after.props?.customFields ?? {}];
      }
      if (Object.keys(changes).length) {
        await logActivity({
          actorId: actor.id,
          projectId: project.id,
          issueId: after.id,
          entityType: "issue",
          entityId: after.id,
          action: changes.stateId ? "state_changed" : "updated",
          changes,
        });
      }
    }

    if ((before?.parentId ?? null) !== (after.parentId ?? null)) {
      await recountSubIssues(before?.parentId);
      await recountSubIssues(after.parentId);
    }

    const newAssignee = after.assigneeId;
    if (newAssignee && newAssignee !== (before?.assigneeId ?? null)) {
      const kind = opts.handoffNote !== undefined ? "handoff" : "assigned";
      await notify({
        projectId: project.id,
        issueId: after.id,
        userId: newAssignee,
        actorId: actor.id,
        kind,
        message: opts.handoffNote || `${after.key}: ${after.name}`,
      });
      if (newAssignee !== actor.id && (await isAgentMember(project.id, newAssignee))) {
        await queueAgentWork({
          projectId: project.id,
          issueId: after.id,
          agentId: newAssignee,
          trigger: kind,
          prompt: opts.handoffNote || null,
          requestedBy: actor.id,
        });
      }
    }
  }

  /** A plain comment written by the kon itself (a hand-off note), counted and in the history. */
  async function comment(issue: AgileIssue, actorId: string, text: string) {
    const html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
    const [row] = await db.instance
      .insert(agileComments)
      .values({ issueId: issue.id, contentHtml: `<p>${html}</p>`, contentText: text, createdBy: actorId })
      .returning();
    await db.instance
      .update(agileIssues)
      .set({ commentsCount: sql`(select count(*)::int from agile_comments where issue_id = ${issue.id})` })
      .where(eq(agileIssues.id, issue.id));
    await logActivity({
      actorId,
      projectId: issue.projectId,
      issueId: issue.id,
      entityType: "comment",
      entityId: row.id,
      action: "commented",
    });
    return row;
  }

  /** Mentions in a comment: a notification each, and work for a mentioned agent. */
  async function mentioned(
    project: AgileProject,
    issue: AgileIssue,
    commentId: string,
    actorId: string,
    userIds: string[],
    excerpt: string
  ) {
    for (const userId of new Set(userIds)) {
      if (userId === actorId) continue;
      if (!(await roleIn(project, userId))) {
        throw AppError.validation(`mentions: ${userId} is not a member of the project`, { field: "mentions" });
      }
      await notify({ projectId: project.id, issueId: issue.id, commentId, userId, actorId, kind: "mention", message: excerpt });
      if (await isAgentMember(project.id, userId)) {
        await queueAgentWork({
          projectId: project.id,
          issueId: issue.id,
          agentId: userId,
          trigger: "mention",
          prompt: excerpt,
          requestedBy: actorId,
        });
      }
    }
  }

  /** Live numbers of a cycle from its issues. */
  function cycleStats(issues: { stateGroup: string | null; estimate: number | null }[]) {
    const done = issues.filter((i) => i.stateGroup === "completed");
    const cancelled = issues.filter((i) => i.stateGroup === "cancelled");
    const sum = (l: typeof issues) => l.reduce((n, i) => n + (i.estimate ?? 0), 0);
    return {
      totalIssues: issues.length,
      completedIssues: done.length,
      cancelledIssues: cancelled.length,
      totalEstimate: sum(issues),
      completedEstimate: sum(done),
      velocity: sum(done),
    };
  }

  /**
   * Closes a cycle: final numbers in `stats`, status completed, and its unfinished issues moved to
   * `carryOverTo` (undefined: the next cycle by start date; null: no cycle).
   */
  async function completeCycle(cycleId: string, actorId: string, carryOverTo?: string | null) {
    const [cycle] = await db.instance.select().from(agileCycles).where(eq(agileCycles.id, cycleId)).limit(1);
    if (!cycle) throw AppError.notFound("Cycle not found");
    if (cycle.status === "completed" || cycle.status === "cancelled") {
      throw AppError.conflict("The cycle is already closed");
    }
    let target = carryOverTo;
    if (target === undefined) {
      const [next] = await db.instance
        .select({ id: agileCycles.id })
        .from(agileCycles)
        .where(
          and(
            eq(agileCycles.projectId, cycle.projectId),
            gt(agileCycles.startDate, cycle.startDate),
            notInArray(agileCycles.status, ["completed", "cancelled"])
          )
        )
        .orderBy(asc(agileCycles.startDate))
        .limit(1);
      target = next?.id ?? null;
    }

    const issues = await db.instance
      .select({ id: agileIssues.id, estimate: agileIssues.estimate, stateGroup: agileStates.group })
      .from(agileIssues)
      .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
      .where(eq(agileIssues.cycleId, cycle.id));
    const stats = cycleStats(issues);
    const unfinished = issues.filter((i) => i.stateGroup !== "completed" && i.stateGroup !== "cancelled");

    if (unfinished.length) {
      await db.instance
        .update(agileIssues)
        .set({ cycleId: target, updatedAt: new Date() })
        .where(inArray(agileIssues.id, unfinished.map((i) => i.id)));
      for (const i of unfinished) {
        await logActivity({
          actorId,
          projectId: cycle.projectId,
          issueId: i.id,
          entityType: "issue",
          entityId: i.id,
          action: "carried_over",
          changes: { cycleId: [cycle.id, target] },
        });
      }
    }
    const [closed] = await db.instance
      .update(agileCycles)
      .set({
        status: "completed",
        isActive: false,
        completedAt: new Date(),
        carriedOverToId: target,
        stats: { ...stats, carriedOver: unfinished.length } as typeof cycle.stats,
        updatedAt: new Date(),
      })
      .where(eq(agileCycles.id, cycle.id))
      .returning();
    await logActivity({
      actorId,
      projectId: cycle.projectId,
      entityType: "cycle",
      entityId: cycle.id,
      action: "completed",
      description: `${unfinished.length} unfinished issue(s) carried over`,
    });
    return { cycle: closed, carriedOver: unfinished.length, carriedOverTo: target };
  }

  /**
   * The periodic work, as the system: auto-archive, auto-close of cycles, agent schedules. Every
   * step claims its rows with a conditional UPDATE, so two workers do not do the same thing twice.
   */
  async function tick(now = new Date()) {
    const done = { archived: 0, cyclesClosed: 0, scheduled: 0 };
    const projects = await db.instance
      .select({ id: agileProjects.id, config: agileProjects.config })
      .from(agileProjects)
      .where(eq(agileProjects.isArchived, false));

    for (const p of projects) {
      const days = p.config?.autoArchiveDays;
      if (typeof days === "number" && days > 0) {
        const cutoff = new Date(now.getTime() - days * 86_400_000);
        const archived = await db.instance
          .update(agileIssues)
          .set({ archivedAt: now })
          .where(
            and(
              eq(agileIssues.projectId, p.id),
              isNull(agileIssues.archivedAt),
              or(lte(agileIssues.completedAt, cutoff), lte(agileIssues.cancelledAt, cutoff))
            )
          )
          .returning({ id: agileIssues.id });
        for (const a of archived) {
          await logActivity({
            actorId: SYSTEM_ACTOR,
            projectId: p.id,
            issueId: a.id,
            entityType: "issue",
            entityId: a.id,
            action: "archived",
            description: `auto-archive after ${days} days`,
          });
        }
        done.archived += archived.length;
      }

      if (p.config?.autoCloseCycles) {
        const due = await db.instance
          .select({ id: agileCycles.id })
          .from(agileCycles)
          .where(
            and(
              eq(agileCycles.projectId, p.id),
              lte(agileCycles.endDate, now),
              notInArray(agileCycles.status, ["completed", "cancelled"])
            )
          )
          .orderBy(asc(agileCycles.endDate));
        for (const cy of due) {
          try {
            await completeCycle(cy.id, SYSTEM_ACTOR);
            done.cyclesClosed++;
          } catch (e) {
            if ((e as { status?: number }).status !== 409) throw e;
          }
        }
      }
    }

    const schedules = await db.instance
      .select()
      .from(agileAgentSchedules)
      .where(
        and(
          eq(agileAgentSchedules.isActive, true),
          or(isNull(agileAgentSchedules.nextRunAt), lte(agileAgentSchedules.nextRunAt, now))
        )
      )
      .limit(50);
    for (const s of schedules) {
      const next = new Date(now.getTime() + s.intervalMinutes * 60_000);
      const [claimed] = await db.instance
        .update(agileAgentSchedules)
        .set({ lastRunAt: now, nextRunAt: next, updatedAt: now })
        .where(
          and(
            eq(agileAgentSchedules.id, s.id),
            s.nextRunAt ? eq(agileAgentSchedules.nextRunAt, s.nextRunAt) : isNull(agileAgentSchedules.nextRunAt)
          )
        )
        .returning({ id: agileAgentSchedules.id });
      if (!claimed) continue;
      await queueAgentWork({
        projectId: s.projectId,
        agentId: s.agentId,
        trigger: "schedule",
        prompt: s.prompt,
        requestedBy: s.createdBy,
        scheduleId: s.id,
      });
      done.scheduled++;
    }
    return done;
  }

  return {
    prepareIssue,
    afterIssue,
    mentioned,
    comment,
    notify,
    queueAgentWork,
    isAgentMember,
    cycleStats,
    completeCycle,
    tick,
  };
}

export type AgileWorkflow = ReturnType<typeof agileWorkflow>;

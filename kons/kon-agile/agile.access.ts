/**
 * Who may do what in a project, shared by every route of the kon.
 * ============================================================================
 *
 *   1. membership: role in `agile_project_members` (or implicit owner for having created the
 *      project) + policy "agile_project" with `can()`. Without being able to SEE the project → 404
 *      (its existence is not confirmed); seeing it but without permission for the action → 403.
 *   2. agents (migration 0005, owner's decision 2026-11-03): an agent that is a member writes only
 *      on issues assigned to itself. As scrum master of a squad it also writes on the issues of that
 *      squad's members and on unassigned ones. It never changes the project's configuration nor
 *      decides intakes. The database enforces the same rule (`agile_agent_reach`); this file gives
 *      the clear 403 before the database would refuse.
 *   3. every reference of an issue (state, cycle, module, parent, initiative, assignee) has to be
 *      of the SAME project.
 */

import { AppError, can, isUuid, type AuthzUser } from "@kitsuden/engine";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";

import type { AgileDb } from "./agile.db";
import type { ProjectResource } from "./agile.policy";
import {
  agileActivityLog,
  agileCycles,
  agileInitiatives,
  agileIssues,
  agileModules,
  agileProjectMembers,
  agileProjects,
  agileSquadMembers,
  agileSquads,
  agileStates,
  type AgileIssue,
  type AgileProject,
  type ProjectRole,
} from "./agile.schema";

export type Action = "view" | "propose" | "write" | "manage";
export type User = AuthzUser & { id: string; role?: string };

/** What an agent may touch: the assignees in its reach, and whether unassigned issues are. */
export interface AgentReach {
  assignees: Set<string>;
  unassigned: boolean;
}

export const isAgent = (u: { role?: string } | null | undefined) => u?.role === "agent";

export function agileAccess(db: { instance: AgileDb }) {
  const userValue = (c: Context): User => {
    const u = c.get("user" as never) as User | null;
    if (!u?.id) throw AppError.unauthenticated();
    return u;
  };

  /** Role of `userId` in the project, or null. */
  async function roleIn(
    project: { id: string; createdBy: string | null },
    userId: string
  ): Promise<ProjectRole | null> {
    if (project.createdBy && project.createdBy === userId) return "owner";
    const [row] = await db.instance
      .select({ role: agileProjectMembers.role })
      .from(agileProjectMembers)
      .where(
        and(eq(agileProjectMembers.projectId, project.id), eq(agileProjectMembers.userId, userId))
      )
      .limit(1);
    return (row?.role as ProjectRole | undefined) ?? null;
  }

  /**
   * Loads the project and requires the action. 404 if they cannot see it (its existence
   * is not confirmed), 403 if they see it but it is not theirs to act on.
   */
  async function projectFor(c: Context, projectId: string | undefined, action: Action) {
    const user = userValue(c);
    if (!projectId || !isUuid(projectId)) throw AppError.notFound("Project not found");
    const [project] = await db.instance
      .select()
      .from(agileProjects)
      .where(eq(agileProjects.id, projectId))
      .limit(1);
    if (!project) throw AppError.notFound("Project not found");
    const resource: ProjectResource = { projectId, role: await roleIn(project, user.id) };
    if (!(await can(user, "view", resource, "agile_project"))) {
      throw AppError.notFound("Project not found");
    }
    if (action !== "view" && !(await can(user, action, resource, "agile_project"))) {
      throw AppError.forbidden("You do not have permission for this in this project");
    }
    return { project, resource, user };
  }

  /**
   * The project's configuration (states, cycles, modules, labels, fields, initiatives, squads,
   * schedules, intake decisions): people with write rights, never an agent.
   */
  async function projectToConfigure(c: Context, projectId: string | undefined) {
    const found = await projectFor(c, projectId, "write");
    if (isAgent(found.user)) {
      throw AppError.forbidden("An agent does not change the project's configuration");
    }
    return found;
  }

  async function issueFor(c: Context, key: string | undefined, action: Action) {
    if (!key || key.length > 64) throw AppError.notFound("Issue not found");
    const [issue] = await db.instance
      .select()
      .from(agileIssues)
      .where(eq(agileIssues.key, key))
      .limit(1);
    if (!issue) throw AppError.notFound("Issue not found");
    try {
      const { project, user } = await projectFor(c, issue.projectId, action);
      return { issue, project, user };
    } catch (e) {
      // An issue of a project you cannot see does NOT exist for you.
      if ((e as { status?: number }).status === 404) throw AppError.notFound("Issue not found");
      throw e;
    }
  }

  /** The reach of an agent in a project; null for a person (no limit beyond the role). */
  async function agentReach(projectId: string, user: User): Promise<AgentReach | null> {
    if (!isAgent(user)) return null;
    const reach: AgentReach = { assignees: new Set([user.id]), unassigned: false };
    const squads = await db.instance
      .select({ id: agileSquads.id })
      .from(agileSquads)
      .where(and(eq(agileSquads.projectId, projectId), eq(agileSquads.scrumMasterId, user.id)));
    if (squads.length > 0) {
      reach.unassigned = true;
      const members = await db.instance
        .select({ userId: agileSquadMembers.userId })
        .from(agileSquadMembers)
        .where(
          inArray(
            agileSquadMembers.squadId,
            squads.map((s) => s.id)
          )
        );
      for (const m of members) reach.assignees.add(m.userId);
    }
    return reach;
  }

  const inReach = (reach: AgentReach | null, assigneeId: string | null | undefined) =>
    reach === null || (assigneeId ? reach.assignees.has(assigneeId) : reach.unassigned);

  const OUT_OF_REACH =
    "An agent writes only on its own issues (or, as scrum master, on its squad's)";

  /** An issue the caller may write on: write rights in its project, and in reach for an agent. */
  async function issueToWrite(c: Context, key: string | undefined) {
    const found = await issueFor(c, key, "write");
    const reach = await agentReach(found.issue.projectId, found.user);
    if (!inReach(reach, found.issue.assigneeId)) throw AppError.forbidden(OUT_OF_REACH);
    return { ...found, reach };
  }

  /** For a new issue, or a reassignment by a scrum master: the assignee has to be in reach. */
  function requireReach(reach: AgentReach | null, assigneeId: string | null | undefined) {
    if (!inReach(reach, assigneeId)) throw AppError.forbidden(OUT_OF_REACH);
  }

  /** An agent hangs sub-issues only from issues in its reach (it updates the parent's count). */
  async function requireParentInReach(reach: AgentReach | null, parentId: string | null | undefined) {
    if (!reach || !parentId) return;
    const [parent] = await db.instance
      .select({ assigneeId: agileIssues.assigneeId })
      .from(agileIssues)
      .where(eq(agileIssues.id, parentId))
      .limit(1);
    requireReach(reach, parent?.assigneeId ?? null);
  }

  /** Every reference of an issue has to be of the SAME project. */
  async function checkReferences(
    projectId: string,
    refs: {
      stateId?: string | null;
      cycleId?: string | null;
      moduleId?: string | null;
      parentId?: string | null;
      initiativeId?: string | null;
      assigneeId?: string | null;
    },
    projectValue: { createdBy: string | null; id: string }
  ) {
    const of = async (
      table:
        | typeof agileStates
        | typeof agileCycles
        | typeof agileModules
        | typeof agileIssues
        | typeof agileInitiatives,
      id: string,
      field: string
    ) => {
      const [row] = isUuid(id)
        ? await db.instance
            .select({ id: table.id })
            .from(table)
            .where(and(eq(table.id, id), eq(table.projectId, projectId)))
            .limit(1)
        : [];
      if (!row) throw AppError.validation(`${field} does not belong to this project`, { field });
    };
    if (refs.stateId) await of(agileStates, refs.stateId, "stateId");
    if (refs.cycleId) await of(agileCycles, refs.cycleId, "cycleId");
    if (refs.moduleId) await of(agileModules, refs.moduleId, "moduleId");
    if (refs.parentId) await of(agileIssues, refs.parentId, "parentId");
    if (refs.initiativeId) await of(agileInitiatives, refs.initiativeId, "initiativeId");
    if (refs.assigneeId) await requireMember(projectValue, refs.assigneeId, "assigneeId");
  }

  async function requireMember(
    project: { createdBy: string | null; id: string },
    userId: string,
    field: string
  ) {
    if (!(await roleIn(project, userId))) {
      throw AppError.validation(`${field} is not a member of the project`, { field });
    }
  }

  /** One row of history. `changes` is field → [before, after]. */
  async function logActivity(entry: {
    actorId: string;
    projectId: string;
    issueId?: string | null;
    entityType: string;
    entityId: string;
    action: string;
    description?: string;
    changes?: Record<string, [unknown, unknown]>;
  }) {
    const base = {
      actorId: entry.actorId,
      projectId: entry.projectId,
      issueId: entry.issueId ?? null,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      description: entry.description,
    };
    const changes = Object.entries(entry.changes ?? {});
    if (changes.length === 0) {
      await db.instance.insert(agileActivityLog).values(base);
      return;
    }
    await db.instance.insert(agileActivityLog).values(
      changes.map(([field, [oldValue, newValue]]) => ({
        ...base,
        field,
        oldValue: (oldValue ?? null) as unknown,
        newValue: (newValue ?? null) as unknown,
      }))
    );
  }

  /** Recounts the sub-issues of a parent (after a sub-issue is created, moved or deleted). */
  async function recountSubIssues(parentId: string | null | undefined) {
    if (!parentId) return;
    await db.instance
      .update(agileIssues)
      .set({
        subIssuesCount: sql`(select count(*)::int from agile_issues where parent_id = ${parentId})`,
      })
      .where(eq(agileIssues.id, parentId));
  }

  return {
    userValue,
    roleIn,
    projectFor,
    projectToConfigure,
    issueFor,
    issueToWrite,
    agentReach,
    inReach,
    requireReach,
    requireParentInReach,
    checkReferences,
    requireMember,
    logActivity,
    recountSubIssues,
  };
}

export type AgileAccess = ReturnType<typeof agileAccess>;
export type { AgileIssue, AgileProject };

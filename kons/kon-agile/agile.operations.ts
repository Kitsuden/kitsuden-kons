/**
 * kon-agile — SDK operations (what an agent uses through MCP)
 * ============================================================================
 *
 * ── WHY (phase D fixes, 2026-10-25) ────────────────────────────────────────
 *
 * The kon declared two MCP tools in `mcp.ts` (`agile_read_board`,
 * `agile_submit_intake`) that the core NEVER published —`tools/list` did not
 * include them— and whose code did not check project membership either: wired
 * up as they were, any key could have read any board and proposed in
 * any project (and signed as "mcp-agent", not as the caller).
 *
 * They are now SDK OPERATIONS: from here the core generates the REST route, the
 * OpenAPI and the MCP tool, and passes them through the same gate, idempotency and
 * RLS as REST. Authorization is the rest of the kon's: project
 * MEMBERSHIP (policy `agile_project`, agile.policy.ts) and RLS by membership
 * (migration 0001). An agent gets in just like a person: as a member.
 *
 * The write boundary stays the same as with `mcp.ts`, on purpose: through here
 * an agent READS the board and PROPOSES (an intake that a human approves). To
 * write issues, the usual REST routes, as a member with permission.
 */

import { AppError, defineOperation, eqEnum, isUuid, type AnyOperation } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import type { AgileDb } from "./agile.db";
import type { ProjectResource } from "./agile.policy";
import {
  agileIntakes,
  agileIssues,
  agileProjectMembers,
  agileProjects,
  agileStates,
  type ProjectRole,
} from "./agile.schema";

const TYPES = ["issue", "feature", "bug", "improvement", "epic", "sub_issue", "spike"] as const;
const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
const GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;

/** The SAME body that the legacy route `POST /:projectId/intakes` accepted. */
export const IntakeBody = z
  .object({
    title: z.string().min(1).max(500).describe("Short title of the suggestion or bug"),
    description: z.string().max(50_000).optional().describe("Details for the human who triages it"),
    suggestedType: z.enum(TYPES).optional().describe("Suggested issue type"),
    suggestedPriority: z.enum(PRIORITIES).optional().describe("Suggested priority"),
    source: z
      .enum(["api", "slack", "email", "form", "ai_agent"])
      .optional()
      .describe("Where the suggestion comes from (default: api)"),
    sourceData: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Free JSON for the reviewer: logs, links, confidence…"),
  })
  .strict();

const ProjectParams = z.object({ projectId: z.string().describe("Project id (uuid)") });

const BoardQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50).describe("Max issues (1-100)"),
  stateGroup: z.enum(GROUPS).optional().describe("Only issues whose state is in this group"),
  assigneeId: z.string().max(128).optional().describe("Only issues assigned to this user id"),
});

const BoardIssue = z.object({
  id: z.string(),
  key: z.string().nullable(),
  name: z.string(),
  type: z.string().nullable(),
  priority: z.string().nullable(),
  assigneeId: z.string().nullable(),
  estimate: z.number().nullable(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
});

const Board = z.object({
  project: z.object({ id: z.string(), name: z.string(), identifier: z.string() }),
  summary: z.object({ total: z.number(), byGroup: z.record(z.string(), z.number()) }),
  board: z.array(
    z.object({
      state: z.object({
        id: z.string(),
        name: z.string(),
        color: z.string().nullable(),
        group: z.string().nullable(),
        isDefault: z.boolean().nullable(),
        isCompleted: z.boolean().nullable(),
      }),
      issues: z.array(BoardIssue),
    })
  ),
  totalIssues: z.number(),
  statesCount: z.number(),
});

const Intake = z
  .object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    status: z.string(),
  })
  .passthrough();

/** Role of `userId` in the project (implicit owner if they created it), or null. */
async function roleIn(
  db: AgileDb,
  project: { id: string; createdBy: string | null },
  userId: string
): Promise<ProjectRole | null> {
  if (project.createdBy && project.createdBy === userId) return "owner";
  const [row] = await db
    .select({ role: agileProjectMembers.role })
    .from(agileProjectMembers)
    .where(and(eq(agileProjectMembers.projectId, project.id), eq(agileProjectMembers.userId, userId)))
    .limit(1);
  return (row?.role as ProjectRole | undefined) ?? null;
}

export function agileOperationsList(ctx: KonContext): AnyOperation[] {
  // The request's `db`: the host resolves it to the RLS transaction.
  const db = () => ctx.db.instance as AgileDb;

  /**
   * The project, if the asker can `action` on it. As in the legacy routes:
   * 404 if they cannot SEE it (its existence is not confirmed), 403 if they see it but
   * it is not theirs to act on.
   */
  async function projectFor(
    projectId: string,
    userIdValue: string | undefined,
    can: (resource: ProjectResource, action: string) => Promise<boolean>,
    action: "view" | "propose"
  ) {
    if (!userIdValue) throw AppError.unauthenticated();
    if (!isUuid(projectId)) throw AppError.notFound("Project not found");
    const [project] = await db()
      .select()
      .from(agileProjects)
      .where(eq(agileProjects.id, projectId))
      .limit(1);
    if (!project) throw AppError.notFound("Project not found");
    const resource: ProjectResource = { projectId, role: await roleIn(db(), project, userIdValue) };
    if (!(await can(resource, "view"))) throw AppError.notFound("Project not found");
    if (action !== "view" && !(await can(resource, action))) {
      throw AppError.forbidden("You do not have permission for this in this project");
    }
    return project;
  }

  return [
    defineOperation({
      id: "get-board",
      method: "GET",
      route: "/projects/:projectId/board",
      summary: "Read a project's Kanban board",
      description:
        "READ-ONLY. The board of one agile project: its states (name, color, group) with the issues in each, newest first, and counts per state group. Only for members of the project (owner, member or viewer); anyone else gets 404. It never changes anything: to propose work use agile_submit_intake.",
      tags: ["agile"],
      access: "session",
      permission: { policy: { resource: "agile_project", action: "view", inHandler: true } },
      input: { params: ProjectParams, query: BoardQuery },
      output: { schema: Board },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      mcp: { name: "agile_read_board" },
      guide: {
        whenToUse:
          "To know what is pending, in progress or done in a project before proposing something.",
        before: ["The project id: GET /api/agile/projects lists the projects you are a member of."],
        traps: [
          {
            if: "404 Project not found",
            then: "This key is not a member of that project: ask its owner to add the agent.",
          },
        ],
      },
      handle: async (input, h) => {
        const { projectId } = input.params;
        const { limit, stateGroup, assigneeId } = input.query;
        const project = await projectFor(
          projectId,
          h.user?.id,
          (r, a) => h.can(r, a),
          "view"
        );

        const states = await db()
          .select({
            id: agileStates.id,
            name: agileStates.name,
            color: agileStates.color,
            group: agileStates.group,
            isDefault: agileStates.isDefault,
            isCompleted: agileStates.isCompleted,
          })
          .from(agileStates)
          .where(eq(agileStates.projectId, project.id))
          .orderBy(asc(agileStates.sequence));

        const conditions = [eq(agileIssues.projectId, project.id)];
        const byGroupValue = eqEnum(agileStates.group, stateGroup);
        if (byGroupValue) conditions.push(byGroupValue);
        if (assigneeId) conditions.push(eq(agileIssues.assigneeId, assigneeId));

        const issues = await db()
          .select({
            id: agileIssues.id,
            key: agileIssues.key,
            name: agileIssues.name,
            type: agileIssues.type,
            priority: agileIssues.priority,
            assigneeId: agileIssues.assigneeId,
            estimate: agileIssues.estimate,
            createdAt: agileIssues.createdAt,
            updatedAt: agileIssues.updatedAt,
            stateId: agileIssues.stateId,
            stateGroup: agileStates.group,
          })
          .from(agileIssues)
          .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
          .where(and(...conditions))
          .orderBy(desc(agileIssues.updatedAt))
          .limit(limit);

        const byGroup: Record<string, number> = {};
        for (const g of GROUPS) byGroup[g] = issues.filter((i) => i.stateGroup === g).length;

        return {
          project: { id: project.id, name: project.name, identifier: project.identifier },
          summary: { total: issues.length, byGroup },
          board: states.map((state) => ({
            state,
            issues: issues
              .filter((i) => i.stateId === state.id)
              .map(({ stateId: _s, stateGroup: _g, ...issue }) => issue),
          })),
          totalIssues: issues.length,
          statesCount: states.length,
        };
      },
    }),

    defineOperation({
      id: "propose-intake",
      method: "POST",
      route: "/:projectId/intakes",
      summary: "Propose work to a project's triage inbox",
      description:
        "Creates an intake (status 'pending') in the project's triage inbox. It does NOT create an issue: a human owner or member approves or declines it, and only then does an issue appear on the board. Any member of the project can propose, viewers included; anyone else gets 404. The intake is signed with the caller's id.",
      tags: ["agile"],
      access: "session",
      permission: { policy: { resource: "agile_project", action: "propose", inHandler: true } },
      input: { params: ProjectParams, body: IntakeBody },
      output: { status: 201, schema: Intake },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      mcp: { name: "agile_submit_intake" },
      guide: {
        whenToUse:
          "To report a bug or suggest work. It is the ONLY write an agent does here; a human decides.",
        before: ["The project id: GET /api/agile/projects (or agile_read_board to see it first)."],
        examples: [
          {
            title: "Report a bug",
            args: {
              projectId: "00000000-0000-0000-0000-000000000000",
              body: { title: "Login fails with 500", suggestedType: "bug", source: "ai_agent" },
            },
          },
        ],
      },
      handle: async (input, h) => {
        const { projectId } = input.params;
        const userIdValue = h.user?.id;
        const project = await projectFor(
          projectId,
          userIdValue,
          (r, a) => h.can(r, a),
          "propose"
        );
        const body = input.body;
        const [intake] = await db()
          .insert(agileIntakes)
          .values({
            projectId: project.id,
            title: body.title,
            description: body.description,
            suggestedType: body.suggestedType,
            suggestedPriority: body.suggestedPriority,
            source: body.source || "api",
            sourceData: body.sourceData || {},
            createdBy: userIdValue!,
          })
          .returning();
        return intake;
      },
    }),
  ];
}

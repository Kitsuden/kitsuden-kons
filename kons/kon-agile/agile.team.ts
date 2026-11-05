/**
 * kon-agile — squads, notifications and agents as teammates (1.3)
 * ============================================================================
 *
 * Squads. A squad is a team inside a project with an optional scrum master (a person or an agent).
 * For an agent, being scrum master widens what it may write (agile.access.ts): the issues of the
 * squad's members and unassigned ones. A squad can be just the agent itself or a whole team.
 * Squads are configured by people with write rights (owner decides, owner's decision 2026-11-03).
 *
 * Work for agents. The core cannot start an agent run for a kon (agile.workflow.ts), so assigning,
 * mentioning, handing off and schedules queue rows in `agile_agent_work`. An agent reads its queue
 * (`GET /work/mine`, MCP `agile_my_work`), claims a row, does the work on the board and closes it
 * with its result and what it cost (tokens, USD). People see every row of the project and the
 * totals per agent.
 */

import { AppError, isUuid, type AnyOperation } from "@kitsuden/engine";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { isAgent, type AgileAccess } from "./agile.access";
import type { AgileDb } from "./agile.db";
import {
  agileAgentSchedules,
  agileAgentWork,
  agileIssues,
  agileNotifications,
  agileProjects,
  agileSquadMembers,
  agileSquads,
  WORK_STATUSES,
} from "./agile.schema";
import type { AgileWorkflow } from "./agile.workflow";
import {
  ANY_ACCOUNT,
  declareOp,
  KeyParam,
  ListWithTotal,
  ProjectParam,
  REST_ONLY,
  Row,
  Success,
  query,
  registry,
  text,
} from "./operations";

const userIdValue = z.string().min(1).max(128);
const SquadParam = z.object({ squadId: z.string().describe("Squad id (uuid)") });
const SquadMemberParam = z.object({
  squadId: z.string().describe("Squad id (uuid)"),
  userId: z.string().describe("Member user or agent id"),
});
const WorkParam = z.object({ workId: z.string().describe("Agent work id (uuid)") });
const ScheduleParam = z.object({ scheduleId: z.string().describe("Agent schedule id (uuid)") });
const NotificationParam = z.object({ notificationId: z.string().describe("Notification id (uuid)") });
const Anything = z.object({}).passthrough();

const squadSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  scrumMasterId: userIdValue.nullable().optional().describe("Member (person or agent) who leads the squad"),
  memberIds: z.array(userIdValue).max(200).optional().describe("Members of the squad (project members)"),
});
const squadMemberSchema = z.object({ userId: userIdValue });

const handoffSchema = z.object({
  toUserId: userIdValue.describe("Member who takes the issue (person or agent)"),
  note: z.string().max(5000).optional().describe("What the next one needs to know"),
  stateId: z.guid().optional().describe("State to move the issue to while handing it off"),
});

const claimSchema = z.object({}).strict();
const finishSchema = z.object({
  status: z.enum(["done", "failed", "cancelled"]),
  result: z.string().max(20_000).optional().describe("What was done, or why it failed"),
  runId: z.string().max(200).optional().describe("Id of the run in the agent's own system"),
  inputTokens: z.number().int().min(0).max(1e10).optional(),
  outputTokens: z.number().int().min(0).max(1e10).optional(),
  costUsd: z.number().min(0).max(1e6).optional(),
});
const workRequestSchema = z.object({
  agentId: userIdValue,
  issueKey: z.string().max(64).optional(),
  prompt: z.string().min(1).max(10_000),
});

const scheduleSchema = z.object({
  agentId: userIdValue,
  name: z.string().min(1).max(100),
  prompt: z.string().min(1).max(10_000),
  intervalMinutes: z.number().int().min(15).max(43_200),
  isActive: z.boolean().optional(),
});

export function teamOperations(
  db: { instance: AgileDb },
  access: AgileAccess,
  workflow: AgileWorkflow
): AnyOperation[] {
  const routes = registry();
  const { projectFor, projectToConfigure, issueFor, issueToWrite, requireMember, checkReferences, userValue } = access;

  const declare: typeof declareOp = (id, summary, description, input, output = { schema: Row }, errors) =>
    declareOp(id, summary, description, input, output, errors);

  const WHO_SEES = "Only for members of the project (and admin); anyone else gets 404.";
  const WHO_CONFIGURES = "Owner or member of the project, never an agent (viewer or agent: 403; non-member: 404).";

  // ═══════════════════════════════════════════════════════════════════════════════
  // SQUADS
  // ═══════════════════════════════════════════════════════════════════════════════

  async function squadFor(c: Parameters<typeof projectFor>[0], squadId: string, configure: boolean) {
    if (!isUuid(squadId)) throw AppError.notFound("Squad not found");
    const [squad] = await db.instance.select().from(agileSquads).where(eq(agileSquads.id, squadId)).limit(1);
    if (!squad) throw AppError.notFound("Squad not found");
    try {
      const found = configure ? await projectToConfigure(c, squad.projectId) : await projectFor(c, squad.projectId, "view");
      return { squad, ...found };
    } catch (e) {
      if ((e as { status?: number }).status === 404) throw AppError.notFound("Squad not found");
      throw e;
    }
  }

  async function membersOf(squadIds: string[]) {
    if (!squadIds.length) return new Map<string, string[]>();
    const rows = await db.instance
      .select({ squadId: agileSquadMembers.squadId, userId: agileSquadMembers.userId })
      .from(agileSquadMembers)
      .where(inArray(agileSquadMembers.squadId, squadIds))
      .orderBy(asc(agileSquadMembers.createdAt));
    const map = new Map<string, string[]>();
    for (const r of rows) map.set(r.squadId, [...(map.get(r.squadId) ?? []), r.userId]);
    return map;
  }

  routes.get(
    "/:projectId/squads",
    declare("list-squads", "List a project's squads", `Each squad with its scrum master and members. ${WHO_SEES}`, { params: ProjectParam }, { schema: ListWithTotal }),
    async (c, input) => {
      const { project } = await projectFor(c, input.params.projectId, "view");
      const squads = await db.instance
        .select()
        .from(agileSquads)
        .where(eq(agileSquads.projectId, project.id))
        .orderBy(asc(agileSquads.name));
      const members = await membersOf(squads.map((s) => s.id));
      const docs = squads.map((s) => ({ ...s, memberIds: members.get(s.id) ?? [] }));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  routes.post(
    "/:projectId/squads",
    declare("create-squad", "Create a squad", `A team inside the project. \`scrumMasterId\` and \`memberIds\` must be project members (422). An agent as scrum master may then write on the issues of the squad's members and on unassigned issues; the name is unique in the project (409). ${WHO_CONFIGURES}`, { params: ProjectParam, body: squadSchema }, { status: 201, schema: Row }, ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"]),
    async (c, input) => {
      const { project, user } = await projectToConfigure(c, input.params.projectId);
      const body: z.infer<typeof squadSchema> = input.body;
      if (body.scrumMasterId) await requireMember(project, body.scrumMasterId, "scrumMasterId");
      for (const id of body.memberIds ?? []) await requireMember(project, id, "memberIds");
      const [squad] = await db.instance
        .insert(agileSquads)
        .values({
          projectId: project.id,
          name: body.name,
          description: body.description,
          scrumMasterId: body.scrumMasterId ?? null,
          createdBy: user.id,
        })
        .returning();
      const ids = [...new Set(body.memberIds ?? [])];
      if (ids.length) {
        await db.instance
          .insert(agileSquadMembers)
          .values(ids.map((userId) => ({ squadId: squad.id, userId, addedBy: user.id })));
      }
      await access.logActivity({ actorId: user.id, projectId: project.id, entityType: "squad", entityId: squad.id, action: "created", description: squad.name });
      return c.json({ ...squad, memberIds: ids }, 201);
    }
  );

  routes.patch(
    "/squads/:squadId",
    declare("update-squad", "Update a squad", `Name, description or scrum master (a project member, or null). ${WHO_CONFIGURES}`, { params: SquadParam, body: squadSchema.omit({ memberIds: true }).partial() }, { schema: Row }, ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"]),
    async (c, input) => {
      const { squad, project, user } = await squadFor(c, input.params.squadId, true);
      if (input.body.scrumMasterId) await requireMember(project, input.body.scrumMasterId, "scrumMasterId");
      const [row] = await db.instance
        .update(agileSquads)
        .set({ ...input.body, updatedAt: new Date() })
        .where(eq(agileSquads.id, squad.id))
        .returning();
      if (input.body.scrumMasterId !== undefined && input.body.scrumMasterId !== squad.scrumMasterId) {
        await access.logActivity({
          actorId: user.id,
          projectId: project.id,
          entityType: "squad",
          entityId: squad.id,
          action: "scrum_master_changed",
          changes: { scrumMasterId: [squad.scrumMasterId, input.body.scrumMasterId] },
        });
      }
      return c.json(row);
    }
  );

  routes.delete(
    "/squads/:squadId",
    declare("delete-squad", "Delete a squad", `Its scrum master loses the squad's reach. ${WHO_CONFIGURES}`, { params: SquadParam }, { schema: Success }),
    async (c, input) => {
      const { squad } = await squadFor(c, input.params.squadId, true);
      await db.instance.delete(agileSquads).where(eq(agileSquads.id, squad.id));
      return c.json({ success: true });
    }
  );

  routes.post(
    "/squads/:squadId/members",
    declare("add-squad-member", "Add a member to a squad", `A project member (422 otherwise); adding twice leaves the same state. ${WHO_CONFIGURES}`, { params: SquadParam, body: squadMemberSchema }, { status: 201, schema: Success }),
    async (c, input) => {
      const { squad, project, user } = await squadFor(c, input.params.squadId, true);
      await requireMember(project, input.body.userId, "userId");
      await db.instance
        .insert(agileSquadMembers)
        .values({ squadId: squad.id, userId: input.body.userId, addedBy: user.id })
        .onConflictDoNothing();
      return c.json({ success: true }, 201);
    }
  );

  routes.delete(
    "/squads/:squadId/members/:userId",
    declare("remove-squad-member", "Remove a member from a squad", `404 if it was not in the squad. ${WHO_CONFIGURES}`, { params: SquadMemberParam }, { schema: Success }),
    async (c, input) => {
      const { squad } = await squadFor(c, input.params.squadId, true);
      const [row] = await db.instance
        .delete(agileSquadMembers)
        .where(and(eq(agileSquadMembers.squadId, squad.id), eq(agileSquadMembers.userId, input.params.userId)))
        .returning();
      if (!row) throw AppError.notFound("Member not found");
      return c.json({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // HAND-OFF
  // ═══════════════════════════════════════════════════════════════════════════════

  routes.post(
    "/issues/:key/handoff",
    declare("handoff-issue", "Hand an issue to another member", `Reassigns the issue to \`toUserId\` (a project member, else 422) with a note for them: the note becomes a comment, the new assignee is notified, and an agent gets the issue in its work queue. Optionally moves it to \`stateId\`. Owner or member of its project; an agent only on issues in its reach (as scrum master, only to its squad). Viewer: 403; non-member: 404.`, { params: KeyParam, body: handoffSchema }, { schema: Row }),
    async (c, input) => {
      const { issue, project, user, reach } = await issueToWrite(c, input.params.key);
      const body: z.infer<typeof handoffSchema> = input.body;
      await requireMember(project, body.toUserId, "toUserId");
      if (body.stateId) await checkReferences(project.id, { stateId: body.stateId }, project);
      if (reach?.unassigned) access.requireReach(reach, body.toUserId);
      const note = body.note?.trim() || "";
      if (note) {
        await workflow.comment(issue, user.id, note);
      }
      const prepared = await workflow.prepareIssue(
        project,
        issue,
        { assigneeId: body.toUserId, ...(body.stateId ? { stateId: body.stateId } : {}), updatedAt: new Date() },
        true
      );
      const [updated] = await db.instance.update(agileIssues).set(prepared).where(eq(agileIssues.id, issue.id)).returning();
      await workflow.afterIssue(project, user, issue, updated, { handoffNote: note });
      return c.json(updated);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════════════════════════

  routes.get(
    "/notifications",
    declare("list-notifications", "My agile notifications", "The caller's notifications in every project (mentions, assignments, hand-offs), newest first, with the issue's key. `unread=true` only unread ones; `limit` 1-200 (default 50).", { query: query({ unread: text("`true`: only unread"), limit: text("1-200 (default 50)") }) }, { schema: Anything }),
    async (c) => {
      const user = userValue(c);
      const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1), 200);
      const docs = await db.instance
        .select({
          id: agileNotifications.id,
          kind: agileNotifications.kind,
          message: agileNotifications.message,
          actorId: agileNotifications.actorId,
          projectId: agileNotifications.projectId,
          issueKey: agileIssues.key,
          issueName: agileIssues.name,
          commentId: agileNotifications.commentId,
          readAt: agileNotifications.readAt,
          createdAt: agileNotifications.createdAt,
        })
        .from(agileNotifications)
        .leftJoin(agileIssues, eq(agileNotifications.issueId, agileIssues.id))
        .where(
          and(
            eq(agileNotifications.userId, user.id),
            c.req.query("unread") === "true" ? isNull(agileNotifications.readAt) : undefined
          )
        )
        .orderBy(desc(agileNotifications.createdAt))
        .limit(limit);
      const [{ unread }] = await db.instance
        .select({ unread: sql<number>`count(*)::int` })
        .from(agileNotifications)
        .where(and(eq(agileNotifications.userId, user.id), isNull(agileNotifications.readAt)));
      return c.json({ docs, unread });
    }
  );

  routes.post(
    "/notifications/:notificationId/read",
    declare("read-notification", "Mark a notification read", "Only the caller's own notifications (404 otherwise).", { params: NotificationParam }, { schema: Success }),
    async (c, input) => {
      const user = userValue(c);
      if (!isUuid(input.params.notificationId)) throw AppError.notFound("Notification not found");
      const [row] = await db.instance
        .update(agileNotifications)
        .set({ readAt: new Date() })
        .where(and(eq(agileNotifications.id, input.params.notificationId), eq(agileNotifications.userId, user.id)))
        .returning({ id: agileNotifications.id });
      if (!row) throw AppError.notFound("Notification not found");
      return c.json({ success: true });
    }
  );

  routes.post(
    "/notifications/read-all",
    declare("read-all-notifications", "Mark all my notifications read", "Every unread notification of the caller.", {}, { schema: Anything }),
    async (c) => {
      const user = userValue(c);
      const rows = await db.instance
        .update(agileNotifications)
        .set({ readAt: new Date() })
        .where(and(eq(agileNotifications.userId, user.id), isNull(agileNotifications.readAt)))
        .returning({ id: agileNotifications.id });
      return c.json({ success: true, marked: rows.length });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // AGENT WORK
  // ═══════════════════════════════════════════════════════════════════════════════

  const workColumns = {
    id: agileAgentWork.id,
    projectId: agileAgentWork.projectId,
    projectName: agileProjects.name,
    issueId: agileAgentWork.issueId,
    issueKey: agileIssues.key,
    issueName: agileIssues.name,
    agentId: agileAgentWork.agentId,
    trigger: agileAgentWork.trigger,
    status: agileAgentWork.status,
    prompt: agileAgentWork.prompt,
    requestedBy: agileAgentWork.requestedBy,
    result: agileAgentWork.result,
    runId: agileAgentWork.runId,
    inputTokens: agileAgentWork.inputTokens,
    outputTokens: agileAgentWork.outputTokens,
    costUsd: agileAgentWork.costUsd,
    startedAt: agileAgentWork.startedAt,
    finishedAt: agileAgentWork.finishedAt,
    createdAt: agileAgentWork.createdAt,
  };

  routes.get(
    "/work/mine",
    declare("list-my-work", "The caller's work queue", "Work asked of the caller (an agent, or a person) in every project: assignments, mentions, hand-offs and schedules. Default `status=queued`; also `running`, `done`, `failed`, `cancelled` or `all`. Oldest first, `limit` 1-100 (default 20).", { query: query({ status: text("queued (default), running, done, failed, cancelled or all"), limit: text("1-100 (default 20)") }) }, { schema: ListWithTotal }),
    async (c) => {
      const user = userValue(c);
      const status = c.req.query("status") || "queued";
      if (status !== "all" && !(WORK_STATUSES as readonly string[]).includes(status)) {
        throw AppError.badRequest("Unknown status");
      }
      const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "20", 10) || 20, 1), 100);
      const docs = await db.instance
        .select(workColumns)
        .from(agileAgentWork)
        .leftJoin(agileIssues, eq(agileAgentWork.issueId, agileIssues.id))
        .leftJoin(agileProjects, eq(agileAgentWork.projectId, agileProjects.id))
        .where(
          and(
            eq(agileAgentWork.agentId, user.id),
            status === "all" ? undefined : eq(agileAgentWork.status, status as (typeof WORK_STATUSES)[number])
          )
        )
        .orderBy(status === "queued" ? asc(agileAgentWork.createdAt) : desc(agileAgentWork.createdAt))
        .limit(limit);
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  async function ownWork(c: Parameters<typeof projectFor>[0], workId: string) {
    const user = userValue(c);
    if (!isUuid(workId)) throw AppError.notFound("Work not found");
    const [work] = await db.instance.select().from(agileAgentWork).where(eq(agileAgentWork.id, workId)).limit(1);
    if (!work) throw AppError.notFound("Work not found");
    await projectFor(c, work.projectId, "view").catch((e) => {
      if ((e as { status?: number }).status === 404) throw AppError.notFound("Work not found");
      throw e;
    });
    return { work, user };
  }

  routes.post(
    "/work/:workId/claim",
    declare("claim-work", "Start a piece of work", "The agent the work is for moves it from `queued` to `running` (only once: a second claim, or someone else's work, is a 409 or 403).", { params: WorkParam, body: claimSchema.optional(), validatesHandler: true }, { schema: Row }, ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"]),
    async (c, input) => {
      const { work, user } = await ownWork(c, input.params.workId);
      if (work.agentId !== user.id) throw AppError.forbidden("This work is for another member");
      const [row] = await db.instance
        .update(agileAgentWork)
        .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(agileAgentWork.id, work.id), eq(agileAgentWork.status, "queued")))
        .returning();
      if (!row) throw AppError.conflict("The work is not queued any more");
      return c.json(row);
    }
  );

  routes.post(
    "/work/:workId/finish",
    declare("finish-work", "Close a piece of work", "The agent the work is for closes it (`done`, `failed` or `cancelled`) with its result, its run id and what it cost (tokens, USD). People with write rights in the project may cancel it. Closing work already closed is a 409.", { params: WorkParam, body: finishSchema }, { schema: Row }, ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"]),
    async (c, input) => {
      const { work, user } = await ownWork(c, input.params.workId);
      const body: z.infer<typeof finishSchema> = input.body;
      if (work.agentId !== user.id) {
        if (body.status !== "cancelled" || isAgent(user)) throw AppError.forbidden("This work is for another member");
        await projectFor(c, work.projectId, "write");
      }
      const [row] = await db.instance
        .update(agileAgentWork)
        .set({
          status: body.status,
          result: body.result,
          runId: body.runId,
          inputTokens: body.inputTokens,
          outputTokens: body.outputTokens,
          costUsd: body.costUsd === undefined ? undefined : String(body.costUsd),
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(agileAgentWork.id, work.id), inArray(agileAgentWork.status, ["queued", "running"])))
        .returning();
      if (!row) throw AppError.conflict("The work is already closed");
      return c.json(row);
    }
  );

  routes.post(
    "/:projectId/work",
    declare("request-work", "Ask an agent for something", "Queues work for an agent member of the project (`isAgent`, else 422), optionally about one issue of the project. Owner or member, never an agent (403); non-member: 404.", { params: ProjectParam, body: workRequestSchema }, { status: 201, schema: Row }),
    async (c, input) => {
      const { project, user } = await projectToConfigure(c, input.params.projectId);
      const body: z.infer<typeof workRequestSchema> = input.body;
      if (!(await workflow.isAgentMember(project.id, body.agentId))) {
        throw AppError.validation("agentId is not an agent member of the project", { field: "agentId" });
      }
      let issueId: string | null = null;
      if (body.issueKey) {
        const { issue } = await issueFor(c, body.issueKey, "view");
        if (issue.projectId !== project.id) throw AppError.validation("issueKey is not of this project", { field: "issueKey" });
        issueId = issue.id;
      }
      const row = await workflow.queueAgentWork({
        projectId: project.id,
        issueId,
        agentId: body.agentId,
        trigger: "manual",
        prompt: body.prompt,
        requestedBy: user.id,
      });
      return c.json(row, 201);
    }
  );

  routes.get(
    "/:projectId/work",
    declare("list-project-work", "A project's agent work", `Every piece of work of the project, newest first (\`agentId\`, \`status\` filter; \`limit\` 1-200), and totals per agent: pieces by status, tokens and cost. ${WHO_SEES}`, { params: ProjectParam, query: query({ agentId: text("Only this agent"), status: text("Only this status"), limit: text("1-200 (default 50)") }) }, { schema: Anything }),
    async (c, input) => {
      const { project } = await projectFor(c, input.params.projectId, "view");
      const q = c.req.query();
      const limit = Math.min(Math.max(parseInt(q.limit || "50", 10) || 50, 1), 200);
      if (q.status && !(WORK_STATUSES as readonly string[]).includes(q.status)) throw AppError.badRequest("Unknown status");
      const docs = await db.instance
        .select(workColumns)
        .from(agileAgentWork)
        .leftJoin(agileIssues, eq(agileAgentWork.issueId, agileIssues.id))
        .leftJoin(agileProjects, eq(agileAgentWork.projectId, agileProjects.id))
        .where(
          and(
            eq(agileAgentWork.projectId, project.id),
            q.agentId ? eq(agileAgentWork.agentId, q.agentId) : undefined,
            q.status ? eq(agileAgentWork.status, q.status as (typeof WORK_STATUSES)[number]) : undefined
          )
        )
        .orderBy(desc(agileAgentWork.createdAt))
        .limit(limit);
      const agents = await db.instance
        .select({
          agentId: agileAgentWork.agentId,
          queued: sql<number>`count(*) filter (where ${agileAgentWork.status} = 'queued')::int`,
          running: sql<number>`count(*) filter (where ${agileAgentWork.status} = 'running')::int`,
          done: sql<number>`count(*) filter (where ${agileAgentWork.status} = 'done')::int`,
          failed: sql<number>`count(*) filter (where ${agileAgentWork.status} = 'failed')::int`,
          inputTokens: sql<number>`coalesce(sum(${agileAgentWork.inputTokens}), 0)::bigint`,
          outputTokens: sql<number>`coalesce(sum(${agileAgentWork.outputTokens}), 0)::bigint`,
          costUsd: sql<string>`coalesce(sum(${agileAgentWork.costUsd}), 0)::numeric(14,6)`,
        })
        .from(agileAgentWork)
        .where(eq(agileAgentWork.projectId, project.id))
        .groupBy(agileAgentWork.agentId);
      return c.json({
        docs,
        agents: agents.map((a) => ({
          ...a,
          inputTokens: Number(a.inputTokens),
          outputTokens: Number(a.outputTokens),
          costUsd: Number(a.costUsd),
        })),
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // AGENT SCHEDULES
  // ═══════════════════════════════════════════════════════════════════════════════

  async function scheduleFor(c: Parameters<typeof projectFor>[0], scheduleId: string) {
    if (!isUuid(scheduleId)) throw AppError.notFound("Schedule not found");
    const [s] = await db.instance.select().from(agileAgentSchedules).where(eq(agileAgentSchedules.id, scheduleId)).limit(1);
    if (!s) throw AppError.notFound("Schedule not found");
    try {
      return { schedule: s, ...(await projectToConfigure(c, s.projectId)) };
    } catch (e) {
      if ((e as { status?: number }).status === 404) throw AppError.notFound("Schedule not found");
      throw e;
    }
  }

  routes.get(
    "/:projectId/schedules",
    declare("list-agent-schedules", "List a project's agent schedules", `When each agent wakes up and with what prompt. ${WHO_SEES}`, { params: ProjectParam }, { schema: ListWithTotal }),
    async (c, input) => {
      const { project } = await projectFor(c, input.params.projectId, "view");
      const docs = await db.instance
        .select()
        .from(agileAgentSchedules)
        .where(eq(agileAgentSchedules.projectId, project.id))
        .orderBy(asc(agileAgentSchedules.name));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  routes.post(
    "/:projectId/schedules",
    declare("create-agent-schedule", "Wake an agent on a schedule", `Every \`intervalMinutes\` (15 to 43200) the agent gets a piece of work with \`prompt\` in its queue (once per interval, however many workers run). The agent must be an agent member of the project (422). ${WHO_CONFIGURES}`, { params: ProjectParam, body: scheduleSchema }, { status: 201, schema: Row }),
    async (c, input) => {
      const { project, user } = await projectToConfigure(c, input.params.projectId);
      const body: z.infer<typeof scheduleSchema> = input.body;
      if (!(await workflow.isAgentMember(project.id, body.agentId))) {
        throw AppError.validation("agentId is not an agent member of the project", { field: "agentId" });
      }
      const [row] = await db.instance
        .insert(agileAgentSchedules)
        .values({
          projectId: project.id,
          agentId: body.agentId,
          name: body.name,
          prompt: body.prompt,
          intervalMinutes: body.intervalMinutes,
          isActive: body.isActive ?? true,
          nextRunAt: new Date(Date.now() + body.intervalMinutes * 60_000),
          createdBy: user.id,
        })
        .returning();
      return c.json(row, 201);
    }
  );

  routes.patch(
    "/schedules/:scheduleId",
    declare("update-agent-schedule", "Change an agent schedule", `Name, prompt, interval (the next run moves to now + interval) or active flag. ${WHO_CONFIGURES}`, { params: ScheduleParam, body: scheduleSchema.omit({ agentId: true }).partial() }),
    async (c, input) => {
      const { schedule } = await scheduleFor(c, input.params.scheduleId);
      const body = input.body as Partial<z.infer<typeof scheduleSchema>>;
      const [row] = await db.instance
        .update(agileAgentSchedules)
        .set({
          ...body,
          ...(body.intervalMinutes ? { nextRunAt: new Date(Date.now() + body.intervalMinutes * 60_000) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(agileAgentSchedules.id, schedule.id))
        .returning();
      return c.json(row);
    }
  );

  routes.delete(
    "/schedules/:scheduleId",
    declare("delete-agent-schedule", "Delete an agent schedule", `Work it already queued stays. ${WHO_CONFIGURES}`, { params: ScheduleParam }, { schema: Success }),
    async (c, input) => {
      const { schedule } = await scheduleFor(c, input.params.scheduleId);
      await db.instance.delete(agileAgentSchedules).where(eq(agileAgentSchedules.id, schedule.id));
      return c.json({ success: true });
    }
  );

  return routes.ops;
}

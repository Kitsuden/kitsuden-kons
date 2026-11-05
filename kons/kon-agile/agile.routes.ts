/**
 * Kon Agile — API Routes
 *
 * Security (2026-10-15). Before: GETs required NOT EVEN a session (anyone
 * listed all the projects and read any issue by its key), and writes
 * only `requireAuth` —sign-up is public—, so any
 * account created issues in other people's projects, commented, approved intakes and
 * set whoever they wanted as author (`createdBy`/`decidedBy` came from the
 * body). State/cycle/module ids were not checked either: an issue could be
 * hung on another project's cycle.
 *
 * Now:
 *   1. session on ALL routes                              → 401
 *   2. per-request RLS context (from the host)            → the database filters
 *   3. membership: role in `agile_project_members` (or implicit owner for
 *      having created the project) + policy "agile_project" with `can()`.
 *      Without being able to SEE the project → 404 (its existence is not confirmed);
 *      seeing it but without permission for the action → 403.
 *   4. allowlisted bodies (`validateRequest`) and authorship from the session.
 *   5. every reference (state, cycle, module, parent, duplicate, assignee)
 *      has to be OF THE SAME project.
 *
 * Route order: the static ones before `/:projectId/*`.
 *
 * Since 2026-10-26 each route is a kon SDK OPERATION (operations.ts):
 * each handler's body is the old one; what were middlewares
 * (`requireAuth` on the whole router, `validateRequest`) is now its declaration.
 * The two that an agent uses through MCP remain in agile.operations.ts and are
 * registered BEFORE these, as when these were `legacyRoutes`.
 */

import {
  AppError,
  can,
  eqEnum,
  isUuid,
  searchUnknownFields,
  parseOrThrow,
  operationsRouter,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { eq, and, or, sql, asc, desc, inArray, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { agileAccess, isAgent, type AgileAccess, type User } from "./agile.access";
import type { AgileDb } from "./agile.db";
import { fieldsOf, mergeCustomFields } from "./agile.fields";
import { agileOperationsList } from "./agile.operations";
import { planningOperations } from "./agile.planning";
import { registerAgilePolicy } from "./agile.policy";
import { filtersFromQuery, issueConditions } from "./agile.query";
import {
  agileProjects,
  agileProjectMembers,
  agileStates,
  agileIssues,
  agileCycles,
  agileModules,
  agileIntakes,
  agileComments,
  PROJECT_ROLES,
  type AgileIssue,
} from "./agile.schema";
import { teamOperations } from "./agile.team";
import { viewOperations } from "./agile.views";
import { agileWorkflow, type AgileWorkflow } from "./agile.workflow";
import { respondWithError } from "./http-errors";
import {
  ANY_ACCOUNT,
  Success,
  Row,
  ApprovedIntake,
  KON_ID,
  ListWithTotal,
  Members,
  KeyParam,
  ParamId,
  ParamIntake,
  TableIntakeParam,
  MemberParam,
  ProjectParam,
  REST_ONLY,
  query,
  registry,
  text,
} from "./operations";

// ═══════════════════════════════════════════════════════════════════════════════
// Schemas (allowlist)
// ═══════════════════════════════════════════════════════════════════════════════

const uuid = z.guid();
const userIdValue = z.string().min(1).max(128);
const color = z.string().regex(/^#[0-9a-fA-F]{3,8}$/);
const TYPES = ["issue", "feature", "bug", "improvement", "epic", "sub_issue", "spike"] as const;
const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
const isoDate = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));
const props = z.record(z.string(), z.unknown());
const customFields = z
  .record(z.string(), z.unknown())
  .describe("Values of the project's custom fields by key (null clears one)");

const projectSchema = z.object({
  name: z.string().min(1).max(200),
  identifier: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/, "2-10 letters/numbers"),
  description: z.string().max(5000).optional(),
  emoji: z.string().max(16).optional(),
  color: color.optional(),
  leadId: userIdValue.optional(),
  defaultAssigneeId: userIdValue.optional(),
  coverImageId: uuid.optional(),
  config: z
    .object({
      estimateType: z.enum(["fibonacci", "linear", "tshirt", "days", "points"]).optional(),
      timezone: z.string().max(64).optional(),
      weekStartDay: z.number().int().min(0).max(6).optional(),
      autoAssign: z
        .record(uuid, userIdValue)
        .optional()
        .describe("state id → member id: entering that state assigns the issue to that member"),
      autoArchiveDays: z.number().int().min(1).max(3650).nullable().optional(),
      autoCloseCycles: z.boolean().optional(),
    })
    .strict()
    .optional(),
});

const patchProjectSchema = projectSchema
  .omit({ identifier: true })
  .partial()
  .extend({ isArchived: z.boolean().optional() });

const issueSchema = z.object({
  name: z.string().min(1).max(500),
  descriptionHtml: z.string().max(100_000).optional(),
  descriptionText: z.string().max(100_000).optional(),
  type: z.enum(TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  stateId: uuid.optional(),
  cycleId: uuid.nullable().optional(),
  moduleId: uuid.nullable().optional(),
  parentId: uuid.nullable().optional(),
  assigneeId: userIdValue.nullable().optional(),
  estimate: z.number().int().min(0).max(10_000).nullable().optional(),
  targetDate: isoDate.nullable().optional(),
  initiativeId: uuid.nullable().optional(),
  customFields: customFields.optional(),
  props: props.optional(),
});

const patchIssueSchema = issueSchema.partial();

const commentSchema = z.object({
  contentHtml: z.string().min(1).max(50_000),
  contentText: z.string().max(50_000).optional(),
  parentId: uuid.nullable().optional(),
  mentions: z
    .array(userIdValue)
    .max(50)
    .optional()
    .describe("Members to notify (user or agent ids); a mentioned agent gets the issue in its work queue"),
});

// The body of an intake lives in agile.operations.ts (`IntakeBody`).

const approveSchema = z.object({
  name: z.string().min(1).max(500).optional(),
  descriptionHtml: z.string().max(100_000).optional(),
  descriptionText: z.string().max(100_000).optional(),
  type: z.enum(TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  stateId: uuid.optional(),
  cycleId: uuid.optional(),
  moduleId: uuid.optional(),
  assigneeId: userIdValue.optional(),
  estimate: z.number().int().min(0).max(10_000).optional(),
  targetDate: isoDate.optional(),
  initiativeId: uuid.optional(),
  customFields: customFields.optional(),
  props: props.optional(),
  reason: z.string().max(2000).optional(),
});

const rejectSchema = z.object({ reason: z.string().max(2000).optional() });
const duplicateSchema = z.object({ duplicateOfId: uuid, reason: z.string().max(2000).optional() });

const cycleSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  startDate: isoDate,
  endDate: isoDate,
});

const moduleSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  color: color.optional(),
});

const memberSchema = z.object({
  userId: userIdValue,
  role: z.enum(PROJECT_ROLES),
  isAgent: z
    .boolean()
    .optional()
    .describe("The member is an agent (its agent id): work assigned to it goes to its queue"),
});

/**
 * OPTIONAL body with the same allowlist as `validateRequest`: intake actions
 * are often called without a body (empty POST = {}), but whatever comes in
 * is validated just as strictly.
 */
async function optionalBody<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  const text = await c.req.text();
  let rawValue: unknown = {};
  if (text.trim()) {
    try {
      rawValue = JSON.parse(text);
    } catch {
      throw AppError.badRequest("Invalid JSON body");
    }
  }
  const { unknownAll } = searchUnknownFields(schema, rawValue);
  if (unknownAll.length > 0) {
    throw AppError.validation("Unknown fields in the request", {
      unknownKeys: unknownAll.map((d) => d.key),
    });
  }
  return parseOrThrow(schema, rawValue);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════════════════════════════

/** What every group of routes shares: the request's db, access rules and issue workflow. */
export interface AgileShared {
  db: { instance: AgileDb };
  access: AgileAccess;
  workflow: AgileWorkflow;
}

export function agileShared(ctx: KonContext): AgileShared {
  // The request's RLS transaction is opened by the host (with
  // `set_config(..., true)` of user and role) and `ctx.db.instance` resolves to
  // it inside each route. Outside a request it is the system's connection.
  const db = { instance: ctx.db.instance as AgileDb };
  const access = agileAccess(db);
  const workflow = agileWorkflow(db, access, {
    emit: (event, data) => ctx.events?.emit?.(event, data),
    logger: ctx.logger,
  });
  return { db, access, workflow };
}

/**
 * The operations of the board routes, in the order in which they were registered
 * (the same resolution order as before). Without the two MCP ones: those go
 * first (`allAgileOperations`).
 */
export function agileOperations(
  ctx: KonContext,
  shared: AgileShared = agileShared(ctx)
): AnyOperation[] {
  registerAgilePolicy();
  const routes = registry();
  const { db, access, workflow } = shared;

  // It was `app.use("/*", ctx.auth.requireAuth)`: now each operation declares
  // `access: "session"` and `permission: ANY_ACCOUNT` (operations.ts). Errors
  // that are not `AppError` are translated by the `onError` of createAgileRouter.

  const { userValue, roleIn, projectFor, issueFor, issueToWrite, agentReach, requireReach, checkReferences } =
    access;
  const isAdmin = (u: User) => u.role === "admin";

  /**
   * Next issue key, atomic (before: read and add → duplicate keys
   * with two simultaneous creations). It also returns the number, which goes to `sequence`:
   * there is a UNIQUE index (project_id, sequence) and the route did not fill it in, so
   * with the default value (0) the SECOND issue of any project
   * always collided.
   */
  async function nextKey(projectId: string): Promise<{ key: string; sequence: number }> {
    const [row] = await db.instance
      .update(agileProjects)
      .set({ keyCounter: sql`coalesce(${agileProjects.keyCounter}, 0) + 1` })
      .where(eq(agileProjects.id, projectId))
      .returning({ identifier: agileProjects.identifier, keyCounter: agileProjects.keyCounter });
    if (!row) throw AppError.notFound("Project not found");
    const sequence = Number(row.keyCounter);
    return { key: `${row.identifier}-${sequence}`, sequence };
  }

  async function defaultStatus(projectId: string): Promise<string> {
    const [s] = await db.instance
      .select({ id: agileStates.id })
      .from(agileStates)
      .where(and(eq(agileStates.projectId, projectId), eq(agileStates.isDefault, true)))
      .limit(1);
    if (!s) throw AppError.conflict("The project has no default state");
    return s.id;
  }

  const withoutHtml = (html: string | undefined | null) => (html ?? "").replace(/<[^>]*>/g, "");

  const buildCoverImageUrls = (coverImageId: string | null | undefined) => {
    if (!coverImageId) return null;
    return {
      original: `/api/media/${coverImageId}`,
      large: `/api/media/preset/${coverImageId}/large`,
      small: `/api/media/preset/${coverImageId}/small`,
    };
  };

  // ═══════════════════════════════════════════════════════════════════════════════
  // 1. PROJECTS
  // ═══════════════════════════════════════════════════════════════════════════════

  /** GET /projects — only the projects you are in (admin: all). */
  routes.get(
    "/projects",
    {
      id: "list-projects",
      summary: "List my agile projects",
      description:
        "The projects the caller is a member of (owner, member or viewer; admin: all), by name, with cover image URLs. `isArchived=true|false` filters. An agent key needs `user:act` or an agile scope to act as an account here.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { query: query({ isArchived: text("`true` or `false`") }) },
      output: { schema: ListWithTotal },
    },
    async (c) => {
      const user = userValue(c);
      const query = c.req.query();
      const conditions: SQL[] = [];
      if (query.isArchived === "true" || query.isArchived === "false") {
        conditions.push(eq(agileProjects.isArchived, query.isArchived === "true"));
      }
      if (!isAdmin(user)) {
        const mine = db.instance
          .select({ id: agileProjectMembers.projectId })
          .from(agileProjectMembers)
          .where(eq(agileProjectMembers.userId, user.id));
        const visible = or(eq(agileProjects.createdBy, user.id), inArray(agileProjects.id, mine));
        if (visible) conditions.push(visible);
      }

      const projects = await db.instance
        .select({
          id: agileProjects.id,
          name: agileProjects.name,
          identifier: agileProjects.identifier,
          description: agileProjects.description,
          emoji: agileProjects.emoji,
          color: agileProjects.color,
          isArchived: agileProjects.isArchived,
          leadId: agileProjects.leadId,
          keyCounter: agileProjects.keyCounter,
          coverImageId: agileProjects.coverImageId,
          createdAt: agileProjects.createdAt,
        })
        .from(agileProjects)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(agileProjects.name));

      const docs = projects.map((p) => ({ ...p, coverImage: buildCoverImageUrls(p.coverImageId) }));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  /** POST /projects — staff (admin/editor); whoever creates it becomes owner. */
  routes.post(
    "/projects",
    {
      id: "create-project",
      summary: "Create an agile project",
      description:
        "Creates a project with five default states (Backlog, Todo, In Progress, Done, Cancelled); the caller becomes its owner. Only the team (admin or editor) may create projects: any other account gets 403 once its body is valid. The identifier is stored upper-case and must be unique (409).",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { body: projectSchema },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const user = userValue(c);
      if (!(await can(user, "agile:create-project"))) {
        throw AppError.forbidden("Only the team can create projects");
      }
      const body: z.infer<typeof projectSchema> = input.body;
      const identifier = body.identifier.toUpperCase();

      const [project] = await db.instance
        .insert(agileProjects)
        .values({
          name: body.name,
          identifier,
          description: body.description,
          emoji: body.emoji || "📁",
          color: body.color || "#6366f1",
          leadId: body.leadId,
          defaultAssigneeId: body.defaultAssigneeId,
          coverImageId: body.coverImageId,
          config: (body.config || { estimateType: "fibonacci" }) as typeof agileProjects.$inferInsert.config,
          createdBy: user.id,
        })
        .returning();

      await db.instance
        .insert(agileProjectMembers)
        .values({ projectId: project.id, userId: user.id, role: "owner", addedBy: user.id });

      const defaultStates = [
        { name: "Backlog", group: "backlog", color: "#94a3b8", sequence: 0, isDefault: true },
        { name: "Todo", group: "unstarted", color: "#3b82f6", sequence: 1 },
        { name: "In Progress", group: "started", color: "#f59e0b", sequence: 2 },
        { name: "Done", group: "completed", color: "#22c55e", sequence: 3, isCompleted: true },
        { name: "Cancelled", group: "cancelled", color: "#ef4444", sequence: 4, isCancelled: true },
      ] as const;
      await db.instance
        .insert(agileStates)
        .values(defaultStates.map((s) => ({ ...s, projectId: project.id })));

      return c.json(project, 201);
    }
  );

  routes.get(
    "/projects/:id",
    {
      id: "get-project",
      summary: "Read an agile project",
      description:
        "One project with its states (by sequence) and cover image URLs. Only for its members (and admin); anyone else gets 404.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: ParamId },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { project } = await projectFor(c, c.req.param("id"), "view");
      const states = await db.instance
        .select()
        .from(agileStates)
        .where(eq(agileStates.projectId, project.id))
        .orderBy(asc(agileStates.sequence));
      return c.json({ ...project, coverImage: buildCoverImageUrls(project.coverImageId), states });
    }
  );

  routes.patch(
    "/projects/:id",
    {
      id: "update-project",
      summary: "Update an agile project",
      description:
        "Name, description, look, lead, default assignee, archiving and automation (`config.autoAssign` state → member, `config.autoArchiveDays`, `config.autoCloseCycles`). Only the project owner (or admin); a member or viewer gets 403, a non-member 404. The identifier never changes. States and members named in `autoAssign` must be of the project (422).",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: ParamId, body: patchProjectSchema },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const { project, user } = await projectFor(c, c.req.param("id"), "manage");
      const body: z.infer<typeof patchProjectSchema> = input.body;
      for (const [field, id] of [
        ["leadId", body.leadId],
        ["defaultAssigneeId", body.defaultAssigneeId],
      ] as const) {
        if (id) await access.requireMember(project, id, field);
      }
      const { config, ...rest } = body;
      const set: Partial<typeof agileProjects.$inferInsert> = { ...rest, updatedAt: new Date() };
      if (config) {
        for (const [stateId, userId] of Object.entries(config.autoAssign ?? {})) {
          await checkReferences(project.id, { stateId }, project);
          await access.requireMember(project, userId, "config.autoAssign");
        }
        const merged: Record<string, unknown> = { ...(project.config ?? {}), ...config };
        if (config.autoArchiveDays === null) delete merged.autoArchiveDays;
        set.config = merged as typeof project.config;
      }
      const [updated] = await db.instance
        .update(agileProjects)
        .set(set)
        .where(eq(agileProjects.id, project.id))
        .returning();
      await access.logActivity({
        actorId: user.id,
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
        action: "updated",
        description: Object.keys(body).join(", "),
      });
      return c.json(updated);
    }
  );

  // ── Members ─────────────────────────────────────────────────────────────
  routes.get(
    "/projects/:id/members",
    {
      id: "list-project-members",
      summary: "List a project's members",
      description:
        "User id and role (owner, member, viewer) of each member, oldest first. Only for members of the project (and admin); anyone else gets 404.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: ParamId },
      output: { schema: Members },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { project } = await projectFor(c, c.req.param("id"), "view");
      const docs = await db.instance
        .select({
          userId: agileProjectMembers.userId,
          role: agileProjectMembers.role,
          isAgent: agileProjectMembers.isAgent,
          createdAt: agileProjectMembers.createdAt,
        })
        .from(agileProjectMembers)
        .where(eq(agileProjectMembers.projectId, project.id))
        .orderBy(asc(agileProjectMembers.createdAt));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  routes.post(
    "/projects/:id/members",
    {
      id: "add-project-member",
      summary: "Add or change a project member",
      description:
        "Adds a user (or an agent, with `isAgent: true` and its agent id) to the project with a role, or changes the role if already a member (repeating it leaves the same state). An agent member writes only on issues in its reach (its own, or its squad's as scrum master). Only the project owner (or admin); a member or viewer gets 403, a non-member 404.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: ParamId, body: memberSchema },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      idempotent: true,
    },
    async (c, input) => {
      const user = userValue(c);
      const { project } = await projectFor(c, c.req.param("id"), "manage");
      const body: z.infer<typeof memberSchema> = input.body;
      const [row] = await db.instance
        .insert(agileProjectMembers)
        .values({
          projectId: project.id,
          userId: body.userId,
          role: body.role,
          isAgent: body.isAgent ?? false,
          addedBy: user.id,
        })
        .onConflictDoUpdate({
          target: [agileProjectMembers.projectId, agileProjectMembers.userId],
          set:
            body.isAgent === undefined
              ? { role: body.role }
              : { role: body.role, isAgent: body.isAgent },
        })
        .returning();
      return c.json(row, 201);
    }
  );

  routes.delete(
    "/projects/:id/members/:userId",
    {
      id: "remove-project-member",
      summary: "Remove a project member",
      description:
        "Removes a user from the project. Only the project owner (or admin). The user who created the project cannot be removed (409); a user who is not a member is a 404.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: MemberParam },
      output: { schema: Success },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const { project } = await projectFor(c, c.req.param("id"), "manage");
      const userId = c.req.param("userId")!;
      if (project.createdBy === userId) {
        throw AppError.conflict("The creator of the project cannot be removed");
      }
      const [row] = await db.instance
        .delete(agileProjectMembers)
        .where(
          and(eq(agileProjectMembers.projectId, project.id), eq(agileProjectMembers.userId, userId))
        )
        .returning();
      if (!row) throw AppError.notFound("Member not found");
      return c.json({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // 2. ISSUES BY KEY
  // ═══════════════════════════════════════════════════════════════════════════════

  routes.get(
    "/issues/:key",
    {
      id: "get-issue",
      summary: "Read an issue by its key",
      description:
        "One issue by its key (e.g. PLAT-12), without its internal `props`. Only for members of its project (and admin); anyone else gets 404.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: KeyParam },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { issue } = await issueFor(c, c.req.param("key"), "view");
      const { props: _props, ...visible } = issue;
      return c.json(visible);
    }
  );

  routes.patch(
    "/issues/:key",
    {
      id: "update-issue",
      summary: "Update an issue",
      description:
        "Changes the given fields of an issue. Owner or member of its project (viewer: 403; non-member: 404); an agent only on issues in its reach (its own, or its squad's as scrum master: 403 otherwise). State, cycle, module, parent and initiative must belong to the same project, and the assignee must be a member (422). Entering a state checks its validations (422), stamps started/completed/cancelled dates and may auto-assign; `customFields` are checked against the project's fields. Every change goes to the history, and a new assignee is notified (an agent also gets the issue in its work queue).",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: KeyParam, body: patchIssueSchema },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const { issue: existing, project, user, reach } = await issueToWrite(c, c.req.param("key"));
      const body: z.infer<typeof patchIssueSchema> = input.body;
      await checkReferences(existing.projectId, body, project);
      if (body.parentId && body.parentId === existing.id) {
        throw AppError.validation("An issue cannot be its own parent", { field: "parentId" });
      }
      // A scrum master agent hands work only inside its squad; a plain agent may hand its own issue
      // to any member (a hand-off: the issue leaves its reach).
      if (reach?.unassigned && body.assigneeId !== undefined) requireReach(reach, body.assigneeId);
      await access.requireParentInReach(reach, body.parentId);

      const updates: Partial<typeof agileIssues.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.descriptionHtml !== undefined) {
        updates.descriptionHtml = body.descriptionHtml;
        updates.descriptionText = body.descriptionText || withoutHtml(body.descriptionHtml);
      }
      if (body.type !== undefined) updates.type = body.type;
      if (body.priority !== undefined) updates.priority = body.priority;
      if (body.stateId !== undefined) updates.stateId = body.stateId;
      if (body.cycleId !== undefined) updates.cycleId = body.cycleId;
      if (body.moduleId !== undefined) updates.moduleId = body.moduleId;
      if (body.parentId !== undefined) {
        updates.parentId = body.parentId;
        updates.isSubIssue = Boolean(body.parentId);
      }
      if (body.assigneeId !== undefined) updates.assigneeId = body.assigneeId;
      if (body.estimate !== undefined) updates.estimate = body.estimate;
      if (body.initiativeId !== undefined) updates.initiativeId = body.initiativeId;
      if (body.targetDate !== undefined) {
        updates.targetDate = body.targetDate ? new Date(body.targetDate) : null;
      }
      if (body.props !== undefined || body.customFields !== undefined) {
        const fields = await fieldsOf(db.instance, project.id);
        updates.props = {
          ...(body.props ?? existing.props ?? {}),
          customFields: mergeCustomFields(
            fields,
            existing.props?.customFields,
            body.customFields,
            false
          ),
        };
      }

      const prepared = await workflow.prepareIssue(
        project,
        existing,
        updates,
        body.assigneeId !== undefined
      );
      const [updated] = await db.instance
        .update(agileIssues)
        .set(prepared)
        .where(eq(agileIssues.id, existing.id))
        .returning();
      await workflow.afterIssue(project, user, existing, updated, {
        customFieldsChanged: body.customFields !== undefined,
      });
      return c.json(updated);
    }
  );

  routes.get(
    "/issues/:key/comments",
    {
      id: "list-issue-comments",
      summary: "List an issue's comments",
      description:
        "The comments of an issue, oldest first. Only for members of its project (and admin); anyone else gets 404.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: KeyParam },
      output: { schema: z.object({ docs: z.array(Row) }).passthrough() },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { issue } = await issueFor(c, c.req.param("key"), "view");
      const comments = await db.instance
        .select({
          id: agileComments.id,
          contentHtml: agileComments.contentHtml,
          createdBy: agileComments.createdBy,
          isEdited: agileComments.isEdited,
          parentId: agileComments.parentId,
          reactions: agileComments.reactions,
          createdAt: agileComments.createdAt,
        })
        .from(agileComments)
        .where(eq(agileComments.issueId, issue.id))
        .orderBy(asc(agileComments.createdAt));
      return c.json({ docs: comments });
    }
  );

  routes.post(
    "/issues/:key/comments",
    {
      id: "comment-issue",
      summary: "Comment on an issue",
      description:
        "Adds a comment (signed with the caller's id) and updates the issue's comment count. Owner or member of its project (viewer: 403; non-member: 404); an agent only on issues in its reach. A `parentId` must be a comment of the same issue (422). `mentions` (member ids, else 422) notifies each one; a mentioned agent gets the issue in its work queue.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: KeyParam, body: commentSchema },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const { issue, project, user } = await issueToWrite(c, c.req.param("key"));
      const body: z.infer<typeof commentSchema> = input.body;

      if (body.parentId) {
        // The parent has to be a comment of THIS issue.
        const [parent] = await db.instance
          .select({ id: agileComments.id })
          .from(agileComments)
          .where(and(eq(agileComments.id, body.parentId), eq(agileComments.issueId, issue.id)))
          .limit(1);
        if (!parent) throw AppError.validation("parentId is not a comment of this issue");
      }

      const [comment] = await db.instance
        .insert(agileComments)
        .values({
          issueId: issue.id,
          contentHtml: body.contentHtml,
          contentText: body.contentText || withoutHtml(body.contentHtml),
          createdBy: user.id,
          parentId: body.parentId ?? null,
        })
        .returning();

      await db.instance
        .update(agileIssues)
        .set({
          commentsCount: sql`(select count(*)::int from agile_comments where issue_id = ${issue.id})`,
        })
        .where(eq(agileIssues.id, issue.id));

      await access.logActivity({
        actorId: user.id,
        projectId: project.id,
        issueId: issue.id,
        entityType: "comment",
        entityId: comment.id,
        action: "commented",
      });
      if (body.mentions?.length) {
        const excerpt = (comment.contentText ?? "").slice(0, 280);
        await workflow.mentioned(project, issue, comment.id, user.id, body.mentions, excerpt);
      }

      return c.json(comment, 201);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // INTAKES (deciding = writing to the intake's project)
  // ═══════════════════════════════════════════════════════════════════════════════

  async function pendingIntake(c: Context) {
    const intakeId = c.req.param("intakeId") || c.req.param("id");
    if (!intakeId || !isUuid(intakeId)) throw AppError.notFound("Intake not found");
    const [intake] = await db.instance
      .select()
      .from(agileIntakes)
      .where(eq(agileIntakes.id, intakeId))
      .limit(1);
    if (!intake) throw AppError.notFound("Intake not found");
    try {
      const { project, user } = await projectFor(c, intake.projectId, "write");
      if (isAgent(user)) throw AppError.forbidden("Intakes are decided by people");
      if (intake.status !== "pending") throw AppError.conflict("Intake already processed");
      return { intake, project };
    } catch (e) {
      if ((e as { status?: number }).status === 404) throw AppError.notFound("Intake not found");
      throw e;
    }
  }

  async function handleApproveIntake(c: Context) {
    const user = userValue(c);
    const { intake, project } = await pendingIntake(c);
    const body = await optionalBody(c, approveSchema);
    await checkReferences(project.id, body, project);

    const stateId = body.stateId || intake.suggestedStateId || (await defaultStatus(project.id));
    if (!body.stateId && intake.suggestedStateId) {
      await checkReferences(project.id, { stateId: intake.suggestedStateId }, project);
    }
    const { key, sequence } = await nextKey(project.id);
    const description = body.descriptionHtml || intake.description || "";
    const fields = await fieldsOf(db.instance, project.id);

    const values = await workflow.prepareIssue(
      project,
      null,
      {
        key,
        sequence,
        name: body.name || intake.title,
        descriptionHtml: description,
        descriptionText: body.descriptionText || withoutHtml(description),
        type: body.type || intake.suggestedType || "issue",
        priority: body.priority || intake.suggestedPriority || "medium",
        projectId: project.id,
        stateId,
        cycleId: body.cycleId,
        moduleId: body.moduleId,
        initiativeId: body.initiativeId,
        assigneeId: body.assigneeId,
        createdBy: intake.createdBy || user.id,
        estimate: body.estimate,
        targetDate: body.targetDate ? new Date(body.targetDate) : null,
        props: {
          ...(body.props || {}),
          customFields: mergeCustomFields(fields, undefined, body.customFields, true),
        },
      },
      body.assigneeId !== undefined
    );
    const [issue] = await db.instance
      .insert(agileIssues)
      .values(values as typeof agileIssues.$inferInsert)
      .returning();
    await workflow.afterIssue(project, user, null, issue);

    await db.instance
      .update(agileIntakes)
      .set({
        status: "accepted",
        createdIssueId: issue.id,
        createdIssueKey: issue.key,
        decidedBy: user.id,
        decidedAt: new Date(),
        decisionReason: body.reason || "Approved via API",
        updatedAt: new Date(),
      })
      .where(eq(agileIntakes.id, intake.id));

    return c.json(
      {
        success: true,
        issue: { id: issue.id, key: issue.key, name: issue.name },
        intake: { id: intake.id, status: "accepted" },
      },
      201
    );
  }

  async function handleDeclineIntake(c: Context) {
    const user = userValue(c);
    const { intake } = await pendingIntake(c);
    const body = await optionalBody(c, rejectSchema);
    const [updated] = await db.instance
      .update(agileIntakes)
      .set({
        status: "declined",
        decidedBy: user.id,
        decidedAt: new Date(),
        decisionReason: body.reason,
        updatedAt: new Date(),
      })
      .where(eq(agileIntakes.id, intake.id))
      .returning();
    return c.json(updated);
  }

  async function handleDuplicateIntake(c: Context) {
    const user = userValue(c);
    const { intake, project } = await pendingIntake(c);
    const body = await optionalBody(c, duplicateSchema);
    // The original has to be an issue of the SAME project.
    await checkReferences(project.id, { parentId: body.duplicateOfId }, project);
    const [updated] = await db.instance
      .update(agileIntakes)
      .set({
        status: "duplicate",
        duplicateOfId: body.duplicateOfId,
        decidedBy: user.id,
        decidedAt: new Date(),
        decisionReason: body.reason || `Duplicate of issue ${body.duplicateOfId}`,
        updatedAt: new Date(),
      })
      .where(eq(agileIntakes.id, intake.id))
      .returning();
    return c.json(updated);
  }

  // The body of the intake actions is validated by the HANDLER (`optionalBody`,
  // with the same allowlist), AFTER loading the intake and checking
  // membership: 404/403/409 before 422, as always. That is why
  // `validatesHandler`: the SDK only publishes it.
  routes.post(
    "/intakes/:intakeId/approve",
    {
      id: "approve-intake",
      summary: "Approve an intake into an issue",
      description:
        "Turns a pending intake into an issue of its project (the optional body may override name, type, priority, state, cycle, module, assignee…) and marks the intake accepted, signed by the caller. Owner or member of the project (viewer: 403; non-member: 404); an intake already decided is a 409.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: ParamIntake, body: approveSchema.optional(), validatesHandler: true },
      output: { status: 201, schema: ApprovedIntake },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    handleApproveIntake
  );
  routes.post(
    "/intakes/:intakeId/decline",
    {
      id: "reject-intake",
      summary: "Decline an intake",
      description:
        "Marks a pending intake as declined, with an optional reason, signed by the caller. Owner or member of the project (viewer: 403; non-member: 404); an intake already decided is a 409. The body is optional.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: ParamIntake, body: rejectSchema.optional(), validatesHandler: true },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    handleDeclineIntake
  );
  routes.post(
    "/intakes/:intakeId/duplicate",
    {
      id: "mark-intake-duplicate",
      summary: "Mark an intake as a duplicate",
      description:
        "Marks a pending intake as a duplicate of an issue of the SAME project (`duplicateOfId`, else 422), signed by the caller. Owner or member of the project (viewer: 403; non-member: 404); an intake already decided is a 409.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: ParamIntake, body: duplicateSchema, validatesHandler: true },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    handleDuplicateIntake
  );

  // DataExplorer alias (full table name)
  routes.post(
    "/agile_intakes/:id/approve",
    {
      id: "approve-table-intake",
      summary: "Approve an intake (DataExplorer alias)",
      description:
        "Same as POST /intakes/:intakeId/approve, under the table name the admin DataExplorer uses for its row actions.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: {
        params: TableIntakeParam,
        body: approveSchema.optional(),
        validatesHandler: true,
      },
      output: { status: 201, schema: ApprovedIntake },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    handleApproveIntake
  );
  routes.post(
    "/agile_intakes/:id/decline",
    {
      id: "reject-table-intake",
      summary: "Decline an intake (DataExplorer alias)",
      description:
        "Same as POST /intakes/:intakeId/decline, under the table name the admin DataExplorer uses for its row actions.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: {
        params: TableIntakeParam,
        body: rejectSchema.optional(),
        validatesHandler: true,
      },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    handleDeclineIntake
  );
  routes.post(
    "/agile_intakes/:id/convert",
    {
      id: "convert-table-intake",
      summary: "Convert an intake into an issue (DataExplorer alias)",
      description:
        "Same as POST /intakes/:intakeId/approve (the DataExplorer's convert row action).",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: {
        params: TableIntakeParam,
        body: approveSchema.optional(),
        validatesHandler: true,
      },
      output: { status: 201, schema: ApprovedIntake },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    handleApproveIntake
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // 3. ROUTES PER PROJECT (at the end)
  // ═══════════════════════════════════════════════════════════════════════════════

  routes.get(
    "/:projectId/issues",
    {
      id: "list-issues",
      summary: "List a project's issues",
      description:
        "Issues of a project, oldest first, with their state; archived ones only with `includeArchived=true`. Filters (one value, or the plural with commas): `stateId(s)`, `stateGroup(s)`, `cycleId`, `moduleId`, `initiativeId`, `parentId` (uuids, else 400; `none` for no cycle/initiative/parent), `labelId(s)`, `assigneeId(s)`, `unassigned=true`, `type(s)`, `priority(ies)`, `targetFrom`/`targetTo`, `search` (name or key contains) and `limit` (1-200, default 50). Only for members (and admin); anyone else gets 404.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: {
        params: ProjectParam,
        query: query({
          stateId: text("State id (uuid)"),
          cycleId: text("Cycle id (uuid)"),
          moduleId: text("Module id (uuid)"),
          assigneeId: text("Assignee user id"),
          type: text("Issue type (issue, feature, bug…)"),
          priority: text("urgent, high, medium or low"),
          search: text("Text the name or key contains (max 200 chars)"),
          stateGroup: text("backlog, unstarted, started, completed or cancelled (commas for several)"),
          labelId: text("Label id (uuid; commas for several)"),
          initiativeId: text("Initiative id (uuid) or `none`"),
          parentId: text("Parent issue id (uuid) or `none`"),
          unassigned: text("`true`: also issues with no assignee"),
          includeArchived: text("`true`: archived issues too"),
          targetFrom: text("Target date from (YYYY-MM-DD)"),
          targetTo: text("Target date to (YYYY-MM-DD)"),
          limit: text("Max issues, 1-200 (default 50)"),
        }),
      },
      output: { schema: ListWithTotal },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { project } = await projectFor(c, c.req.param("projectId"), "view");
      const query = c.req.query();
      const conditions = issueConditions(project.id, filtersFromQuery(query));
      const limit = Math.min(Math.max(parseInt(query.limit || "50", 10) || 50, 1), 200);

      const issues = await db.instance
        .select({
          id: agileIssues.id,
          key: agileIssues.key,
          name: agileIssues.name,
          type: agileIssues.type,
          priority: agileIssues.priority,
          stateId: agileIssues.stateId,
          assigneeId: agileIssues.assigneeId,
          estimate: agileIssues.estimate,
          cycleId: agileIssues.cycleId,
          moduleId: agileIssues.moduleId,
          initiativeId: agileIssues.initiativeId,
          parentId: agileIssues.parentId,
          targetDate: agileIssues.targetDate,
          archivedAt: agileIssues.archivedAt,
          subIssuesCount: agileIssues.subIssuesCount,
          commentsCount: agileIssues.commentsCount,
          createdAt: agileIssues.createdAt,
          stateName: agileStates.name,
          stateColor: agileStates.color,
          stateGroup: agileStates.group,
        })
        .from(agileIssues)
        .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
        .where(and(...conditions))
        .orderBy(asc(agileIssues.createdAt))
        .limit(limit);

      return c.json({
        docs: issues.map((issue) => ({
          ...issue,
          state: issue.stateId
            ? {
                id: issue.stateId,
                name: issue.stateName,
                color: issue.stateColor,
                group: issue.stateGroup,
              }
            : null,
        })),
        totalDocs: issues.length,
      });
    }
  );

  routes.post(
    "/:projectId/issues",
    {
      id: "create-issue",
      summary: "Create an issue",
      description:
        "Creates an issue with the next key of the project (e.g. PLAT-13), in the given state or the default one, signed by the caller. Owner or member of the project (viewer: 403; non-member: 404). An agent creates only issues assigned to itself, or, as scrum master, to its squad or unassigned (403). State, cycle, module, parent and initiative must belong to the project, the assignee must be a member and `customFields` must fit the project's fields (422); a project with no default state is a 409.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: ProjectParam, body: issueSchema },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const { project, user } = await projectFor(c, c.req.param("projectId"), "write");
      const body: z.infer<typeof issueSchema> = input.body;
      await checkReferences(project.id, body, project);
      const reach = await agentReach(project.id, user);
      requireReach(reach, body.assigneeId ?? null);
      await access.requireParentInReach(reach, body.parentId);

      const stateId = body.stateId || (await defaultStatus(project.id));
      const { key, sequence } = await nextKey(project.id);
      const fields = await fieldsOf(db.instance, project.id);

      const values = await workflow.prepareIssue(
        project,
        null,
        {
          key,
          sequence,
          name: body.name,
          descriptionHtml: body.descriptionHtml,
          descriptionText: body.descriptionText || withoutHtml(body.descriptionHtml),
          type: body.type || "issue",
          priority: body.priority || "medium",
          projectId: project.id,
          stateId,
          cycleId: body.cycleId ?? null,
          moduleId: body.moduleId ?? null,
          parentId: body.parentId ?? null,
          initiativeId: body.initiativeId ?? null,
          isSubIssue: Boolean(body.parentId),
          assigneeId: body.assigneeId ?? null,
          createdBy: user.id,
          estimate: body.estimate ?? null,
          targetDate: body.targetDate ? new Date(body.targetDate) : null,
          props: {
            ...(body.props || {}),
            customFields: mergeCustomFields(fields, undefined, body.customFields, true),
          },
        },
        body.assigneeId !== undefined
      );
      const [issue] = await db.instance
        .insert(agileIssues)
        .values(values as typeof agileIssues.$inferInsert)
        .returning();
      await workflow.afterIssue(project, user, null, issue);

      return c.json(issue, 201);
    }
  );

  routes.get(
    "/:projectId/intakes",
    {
      id: "list-intakes",
      summary: "List a project's triage inbox",
      description:
        "The intakes of a project, newest first; `status` (pending, accepted, declined, duplicate…) filters. Only for members (and admin); anyone else gets 404.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: ProjectParam, query: query({ status: text("Intake status") }) },
      output: { schema: ListWithTotal },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { project } = await projectFor(c, c.req.param("projectId"), "view");
      const conditions: SQL[] = [eq(agileIntakes.projectId, project.id)];
      const statusFilter = eqEnum(agileIntakes.status, c.req.query("status"));
      if (statusFilter) conditions.push(statusFilter);

      const intakes = await db.instance
        .select({
          id: agileIntakes.id,
          title: agileIntakes.title,
          description: agileIntakes.description,
          status: agileIntakes.status,
          source: agileIntakes.source,
          suggestedType: agileIntakes.suggestedType,
          suggestedPriority: agileIntakes.suggestedPriority,
          createdIssueKey: agileIntakes.createdIssueKey,
          createdAt: agileIntakes.createdAt,
        })
        .from(agileIntakes)
        .where(and(...conditions))
        .orderBy(desc(agileIntakes.createdAt));
      return c.json({ docs: intakes, totalDocs: intakes.length });
    }
  );

  // POST /:projectId/intakes is now the SDK operation `propose-intake`
  // (agile.operations.ts): same route, same body, and also an MCP tool.

  routes.get(
    "/:projectId/cycles",
    {
      id: "list-cycles",
      summary: "List a project's sprints",
      description:
        "The cycles (sprints) of a project, latest start first. Only for members (and admin); anyone else gets 404.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: ProjectParam },
      output: { schema: ListWithTotal },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { project } = await projectFor(c, c.req.param("projectId"), "view");
      const cycles = await db.instance
        .select({
          id: agileCycles.id,
          name: agileCycles.name,
          startDate: agileCycles.startDate,
          endDate: agileCycles.endDate,
          status: agileCycles.status,
          isActive: agileCycles.isActive,
        })
        .from(agileCycles)
        .where(eq(agileCycles.projectId, project.id))
        .orderBy(desc(agileCycles.startDate));
      return c.json({ docs: cycles, totalDocs: cycles.length });
    }
  );

  routes.post(
    "/:projectId/cycles",
    {
      id: "create-cycle",
      summary: "Create a sprint",
      description:
        "Creates a cycle (sprint) in the project, signed by the caller. Owner or member, never an agent (viewer or agent: 403; non-member: 404). `endDate` before `startDate` is a 422.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: ProjectParam, body: cycleSchema },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const user = userValue(c);
      const { project } = await access.projectToConfigure(c, c.req.param("projectId"));
      const body: z.infer<typeof cycleSchema> = input.body;
      const start = new Date(body.startDate);
      const fin = new Date(body.endDate);
      if (fin < start) throw AppError.validation("endDate is before startDate");
      const [cycle] = await db.instance
        .insert(agileCycles)
        .values({
          projectId: project.id,
          name: body.name,
          description: body.description,
          startDate: start,
          endDate: fin,
          createdBy: user.id,
        })
        .returning();
      return c.json(cycle, 201);
    }
  );

  routes.get(
    "/:projectId/modules",
    {
      id: "list-modules",
      summary: "List a project's epics",
      description:
        "The modules (epics) of a project, by name. Only for members (and admin); anyone else gets 404.",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: ProjectParam },
      output: { schema: ListWithTotal },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { project } = await projectFor(c, c.req.param("projectId"), "view");
      const modules = await db.instance
        .select({
          id: agileModules.id,
          name: agileModules.name,
          description: agileModules.description,
          status: agileModules.status,
          color: agileModules.color,
        })
        .from(agileModules)
        .where(eq(agileModules.projectId, project.id))
        .orderBy(asc(agileModules.name));
      return c.json({ docs: modules, totalDocs: modules.length });
    }
  );

  routes.post(
    "/:projectId/modules",
    {
      id: "create-module",
      summary: "Create an epic",
      description:
        "Creates a module (epic) in the project, signed by the caller. Owner or member, never an agent (viewer or agent: 403; non-member: 404).",
      access: "session",
      permission: ANY_ACCOUNT,
      mcp: REST_ONLY,
      input: { params: ProjectParam, body: moduleSchema },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const user = userValue(c);
      const { project } = await access.projectToConfigure(c, c.req.param("projectId"));
      const body: z.infer<typeof moduleSchema> = input.body;
      const [module] = await db.instance
        .insert(agileModules)
        .values({
          projectId: project.id,
          name: body.name,
          description: body.description,
          color: body.color,
          createdBy: user.id,
        })
        .returning();
      return c.json(module, 201);
    }
  );

  return routes.ops;
}

/**
 * All of the kon's operations, in the usual resolution order: first
 * the two MCP ones (agile.operations.ts, which were mounted before the legacy
 * routes), then the board ones.
 */
export function allAgileOperations(ctx: KonContext): AnyOperation[] {
  const shared = agileShared(ctx);
  return [
    ...agileOperationsList(ctx),
    ...agileOperations(ctx, shared),
    ...planningOperations(shared.db, shared.access, shared.workflow),
    ...viewOperations(shared.db, shared.access),
    ...teamOperations(shared.db, shared.access, shared.workflow),
  ];
}

/**
 * The kon's router: the operations, with the errors that are not `AppError`
 * (Postgres SQLSTATE, Hono `HTTPException`) translated without internal
 * details (http-errors.ts), like the `app.onError` of before.
 */
export function createAgileRouter(ctx: KonContext): Hono {
  const router = new Hono();
  router.onError((err, c) => respondWithError(err, c, "agile"));
  router.route("/", operationsRouter(KON_ID, allAgileOperations(ctx), ctx));
  return router;
}

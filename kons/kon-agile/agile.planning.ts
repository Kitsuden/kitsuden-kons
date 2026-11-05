/**
 * kon-agile — planning routes (1.3)
 * ============================================================================
 *
 * What the tables already had and nothing could reach: labels, states, estimates, links between
 * issues, issues in modules, editing and closing cycles and modules, deleting and archiving issues,
 * history and sub-issues. Plus checklists, custom fields and initiatives.
 *
 * Access is the kon's (agile.access.ts): the project's configuration belongs to people with write
 * rights; what hangs from ONE issue (labels, links, checklist, archiving) follows the issue, so an
 * agent may do it on the issues in its reach.
 */

import { AppError, isUuid, type AnyOperation } from "@kitsuden/engine";
import { and, asc, desc, eq, inArray, isNull, lt, max, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { AgileAccess } from "./agile.access";
import type { AgileDb } from "./agile.db";
import { fieldsOf } from "./agile.fields";
import {
  agileActivityLog,
  agileChecklistItems,
  agileCustomFields,
  agileCycles,
  agileEstimates,
  agileInitiatives,
  agileIssueLabels,
  agileIssueLinks,
  agileIssues,
  agileLabels,
  agileModuleIssues,
  agileModules,
  agileStates,
  CUSTOM_FIELD_TYPES,
  INITIATIVE_STATUSES,
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

const uuid = z.guid();
const color = z.string().regex(/^#[0-9a-fA-F]{3,8}$/);
const isoDate = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));
const GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
const LINK_TYPES = [
  "blocks",
  "blocked_by",
  "relates_to",
  "duplicates",
  "duplicate_of",
  "parent_of",
  "child_of",
] as const;
const ESTIMATE_TYPES = ["fibonacci", "linear", "tshirt", "days", "points"] as const;
const CYCLE_STATUSES = ["draft", "started", "completed", "cancelled"] as const;
const MODULE_STATUSES = ["backlog", "planned", "in_progress", "paused", "completed", "cancelled"] as const;

const idParam = (name: string, what: string) =>
  z.object({ [name]: z.string().describe(`${what} id (uuid)`) });
const LabelParam = idParam("labelId", "Label");
const StateParam = idParam("stateId", "State");
const EstimateParam = idParam("estimateId", "Estimate");
const CycleParam = idParam("cycleId", "Cycle");
const ModuleParam = idParam("moduleId", "Module");
const FieldParam = idParam("fieldId", "Custom field");
const InitiativeParam = idParam("initiativeId", "Initiative");
const ModuleIssueParam = z.object({
  moduleId: z.string().describe("Module id (uuid)"),
  key: z.string().describe("Issue key"),
});
const LinkParam = z.object({
  key: z.string().describe("Issue key"),
  linkId: z.string().describe("Link id (uuid)"),
});
const ItemParam = z.object({
  key: z.string().describe("Issue key"),
  itemId: z.string().describe("Checklist item id (uuid)"),
});

const Docs = z.object({ docs: z.array(Row) }).passthrough();
const Anything = z.object({}).passthrough();

const labelSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  color: color.optional(),
});
const issueLabelsSchema = z.object({ labelIds: z.array(uuid).max(50) });

const stateSchema = z.object({
  name: z.string().min(1).max(100),
  group: z.enum(GROUPS),
  description: z.string().max(1000).optional(),
  color: color.optional(),
  isDefault: z.boolean().optional(),
  validations: z
    .object({
      requireAssignee: z.boolean().optional(),
      requireEstimate: z.boolean().optional(),
      requireDescription: z.boolean().optional(),
    })
    .strict()
    .optional(),
});
const stateOrderSchema = z.object({ stateIds: z.array(uuid).min(1).max(100) });

const estimateSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(ESTIMATE_TYPES),
  customPoints: z
    .array(
      z
        .object({ value: z.number(), label: z.string().min(1).max(50), color: color.optional() })
        .strict()
    )
    .max(30)
    .optional(),
  isDefault: z.boolean().optional(),
});

const linkSchema = z.object({
  targetKey: z.string().min(1).max(64),
  linkType: z.enum(LINK_TYPES),
});
const moduleIssueSchema = z.object({ issueKey: z.string().min(1).max(64) });

const cyclePatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  goal: z.string().max(5000).nullable().optional(),
  capacity: z.number().int().min(0).max(100_000).nullable().optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  status: z.enum(CYCLE_STATUSES).optional(),
  isActive: z.boolean().optional(),
});
const cycleCompleteSchema = z.object({
  carryOverTo: uuid
    .nullable()
    .optional()
    .describe("Cycle that takes the unfinished issues; omitted: the next one by start date; null: none (backlog)"),
});

const modulePatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  color: color.optional(),
  status: z.enum(MODULE_STATUSES).optional(),
  leadId: z.string().min(1).max(128).nullable().optional(),
  startDate: isoDate.nullable().optional(),
  targetDate: isoDate.nullable().optional(),
  initiativeId: uuid.nullable().optional(),
});

const checklistSchema = z.object({
  text: z.string().min(1).max(1000),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});
const checklistPatchSchema = z.object({
  text: z.string().min(1).max(1000).optional(),
  isDone: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});

const fieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/, "lower-case letters, digits and _, up to 50"),
  name: z.string().min(1).max(100),
  type: z.enum(CUSTOM_FIELD_TYPES),
  options: z.array(z.string().min(1).max(100)).max(100).optional(),
  isRequired: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
const fieldPatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  options: z.array(z.string().min(1).max(100)).max(100).optional(),
  isRequired: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

const initiativeSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  status: z.enum(INITIATIVE_STATUSES).optional(),
  leadId: z.string().min(1).max(128).optional(),
  color: color.optional(),
  startDate: isoDate.optional(),
  targetDate: isoDate.optional(),
});
const initiativePatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  status: z.enum(INITIATIVE_STATUSES).optional(),
  leadId: z.string().min(1).max(128).nullable().optional(),
  color: color.optional(),
  startDate: isoDate.nullable().optional(),
  targetDate: isoDate.nullable().optional(),
});

const date = (v: string | null | undefined) => (v ? new Date(v) : null);
const DONE_GROUPS = ["completed", "cancelled"] as const;

/** The opposite direction of a link, as read from the other issue. */
const INVERSE: Record<(typeof LINK_TYPES)[number], (typeof LINK_TYPES)[number]> = {
  blocks: "blocked_by",
  blocked_by: "blocks",
  relates_to: "relates_to",
  duplicates: "duplicate_of",
  duplicate_of: "duplicates",
  parent_of: "child_of",
  child_of: "parent_of",
};

/** Progress against time: done share vs elapsed share of [start, target]. */
export function pace(
  total: number,
  done: number,
  start: Date | null,
  target: Date | null,
  now = new Date()
) {
  const progress = total === 0 ? 0 : done / total;
  if (!start || !target || target <= start) {
    return { progress, elapsed: null as number | null, status: "no_dates" as const };
  }
  const elapsed = Math.min(Math.max((now.getTime() - start.getTime()) / (target.getTime() - start.getTime()), 0), 1);
  const status =
    total > 0 && done === total
      ? ("done" as const)
      : progress + 0.1 >= elapsed
        ? ("on_track" as const)
        : progress + 0.25 >= elapsed
          ? ("at_risk" as const)
          : ("off_track" as const);
  return { progress, elapsed, status };
}

export function planningOperations(
  db: { instance: AgileDb },
  access: AgileAccess,
  workflow: AgileWorkflow
): AnyOperation[] {
  const routes = registry();
  const {
    projectFor,
    projectToConfigure,
    issueFor,
    issueToWrite,
    checkReferences,
    requireMember,
    logActivity,
    recountSubIssues,
    userValue,
  } = access;

  /** A row of `table` by id, with its project configurable by the caller (404 otherwise). */
  async function configurable<
    T extends
      | typeof agileLabels
      | typeof agileStates
      | typeof agileEstimates
      | typeof agileCycles
      | typeof agileModules
      | typeof agileCustomFields
      | typeof agileInitiatives,
  >(c: Parameters<typeof projectFor>[0], table: T, id: string, what: string, action: "view" | "configure") {
    if (!isUuid(id)) throw AppError.notFound(`${what} not found`);
    const [row] = await db.instance
      .select({ projectId: table.projectId })
      .from(table as typeof agileLabels)
      .where(eq(table.id, id))
      .limit(1);
    if (!row) throw AppError.notFound(`${what} not found`);
    try {
      const found =
        action === "view"
          ? await projectFor(c, row.projectId, "view")
          : await projectToConfigure(c, row.projectId);
      return found;
    } catch (e) {
      if ((e as { status?: number }).status === 404) throw AppError.notFound(`${what} not found`);
      throw e;
    }
  }

  const declare: typeof declareOp = (id, summary, description, input, output = { schema: Row }, errors) =>
    declareOp(id, summary, description, input, output, errors);

  const WHO_CONFIGURES =
    "Owner or member of the project, never an agent (viewer or agent: 403; non-member: 404).";
  const WHO_SEES = "Only for members of the project (and admin); anyone else gets 404.";
  const WHO_WRITES_ISSUE =
    "Owner or member of its project; an agent only on issues in its reach (its own, or its squad's as scrum master). Viewer: 403; non-member: 404.";

  // ═══════════════════════════════════════════════════════════════════════════════
  // LABELS
  // ═══════════════════════════════════════════════════════════════════════════════

  routes.get(
    "/:projectId/labels",
    declare("list-labels", "List a project's labels", `Labels by name. ${WHO_SEES}`, { params: ProjectParam }, { schema: ListWithTotal }),
    async (c, input) => {
      const { project } = await projectFor(c, input.params.projectId, "view");
      const docs = await db.instance
        .select()
        .from(agileLabels)
        .where(eq(agileLabels.projectId, project.id))
        .orderBy(asc(agileLabels.name));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  routes.post(
    "/:projectId/labels",
    declare("create-label", "Create a label", `A label of the project; the name is unique in it (409). ${WHO_CONFIGURES}`, { params: ProjectParam, body: labelSchema }, { status: 201, schema: Row }, ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"]),
    async (c, input) => {
      const { project } = await projectToConfigure(c, input.params.projectId);
      const body: z.infer<typeof labelSchema> = input.body;
      const [label] = await db.instance
        .insert(agileLabels)
        .values({ projectId: project.id, name: body.name, description: body.description, color: body.color })
        .returning();
      return c.json(label, 201);
    }
  );

  routes.patch(
    "/labels/:labelId",
    declare("update-label", "Update a label", `Name, description or color. ${WHO_CONFIGURES}`, { params: LabelParam, body: labelSchema.partial() }, { schema: Row }, ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"]),
    async (c, input) => {
      await configurable(c, agileLabels, input.params.labelId, "Label", "configure");
      const [label] = await db.instance
        .update(agileLabels)
        .set(input.body)
        .where(eq(agileLabels.id, input.params.labelId))
        .returning();
      return c.json(label);
    }
  );

  routes.delete(
    "/labels/:labelId",
    declare("delete-label", "Delete a label", `Removes the label from the project and from every issue. ${WHO_CONFIGURES}`, { params: LabelParam }, { schema: Success }),
    async (c, input) => {
      await configurable(c, agileLabels, input.params.labelId, "Label", "configure");
      await db.instance.delete(agileLabels).where(eq(agileLabels.id, input.params.labelId));
      return c.json({ success: true });
    }
  );

  routes.put(
    "/issues/:key/labels",
    declare("set-issue-labels", "Set an issue's labels", `Replaces the labels of an issue with \`labelIds\` (labels of its project, else 422). ${WHO_WRITES_ISSUE}`, { params: KeyParam, body: issueLabelsSchema }, { schema: Docs }, ["KITSUDEN_E_NOT_FOUND"]),
    async (c, input) => {
      const { issue, user } = await issueToWrite(c, input.params.key);
      const wanted = [...new Set<string>(input.body.labelIds)];
      const valid = wanted.length
        ? await db.instance
            .select({ id: agileLabels.id })
            .from(agileLabels)
            .where(and(eq(agileLabels.projectId, issue.projectId), inArray(agileLabels.id, wanted)))
        : [];
      if (valid.length !== wanted.length) {
        throw AppError.validation("labelIds has labels of another project", { field: "labelIds" });
      }
      const before = await db.instance
        .select({ labelId: agileIssueLabels.labelId })
        .from(agileIssueLabels)
        .where(eq(agileIssueLabels.issueId, issue.id));
      await db.instance.delete(agileIssueLabels).where(eq(agileIssueLabels.issueId, issue.id));
      if (wanted.length) {
        await db.instance
          .insert(agileIssueLabels)
          .values(wanted.map((labelId) => ({ issueId: issue.id, labelId })));
      }
      await logActivity({
        actorId: user.id,
        projectId: issue.projectId,
        issueId: issue.id,
        entityType: "issue",
        entityId: issue.id,
        action: "labels_changed",
        changes: { labels: [before.map((b) => b.labelId).sort(), [...wanted].sort()] },
      });
      const docs = wanted.length
        ? await db.instance.select().from(agileLabels).where(inArray(agileLabels.id, wanted))
        : [];
      return c.json({ docs });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // STATES
  // ═══════════════════════════════════════════════════════════════════════════════

  routes.get(
    "/:projectId/states",
    declare("list-states", "List a project's states", `The board's columns, in order. ${WHO_SEES}`, { params: ProjectParam }, { schema: ListWithTotal }),
    async (c, input) => {
      const { project } = await projectFor(c, input.params.projectId, "view");
      const docs = await db.instance
        .select()
        .from(agileStates)
        .where(eq(agileStates.projectId, project.id))
        .orderBy(asc(agileStates.sequence));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  /** Only one default state per project. */
  async function clearDefault(projectId: string, except?: string) {
    await db.instance
      .update(agileStates)
      .set({ isDefault: false })
      .where(
        and(
          eq(agileStates.projectId, projectId),
          eq(agileStates.isDefault, true),
          except ? ne(agileStates.id, except) : undefined
        )
      );
  }

  const groupFlags = (group: (typeof GROUPS)[number]) => ({
    isCompleted: group === "completed",
    isCancelled: group === "cancelled",
  });

  routes.post(
    "/:projectId/states",
    declare("create-state", "Create a state", `A new column at the end of the board. \`group\` (backlog, unstarted, started, completed, cancelled) drives reports and timestamps; \`validations\` are checked when an issue enters it. ${WHO_CONFIGURES}`, { params: ProjectParam, body: stateSchema }, { status: 201, schema: Row }, ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"]),
    async (c, input) => {
      const { project } = await projectToConfigure(c, input.params.projectId);
      const body: z.infer<typeof stateSchema> = input.body;
      const [{ last }] = await db.instance
        .select({ last: max(agileStates.sequence) })
        .from(agileStates)
        .where(eq(agileStates.projectId, project.id));
      if (body.isDefault) await clearDefault(project.id);
      const [state] = await db.instance
        .insert(agileStates)
        .values({
          projectId: project.id,
          name: body.name,
          group: body.group,
          description: body.description,
          color: body.color,
          sequence: (last ?? -1) + 1,
          isDefault: body.isDefault ?? false,
          validations: body.validations ?? {},
          ...groupFlags(body.group),
        })
        .returning();
      return c.json(state, 201);
    }
  );

  routes.patch(
    "/states/:stateId",
    declare("update-state", "Update a state", `Name, group, color, description, default or entry validations. The default state cannot stop being the default without another one taking it (409). ${WHO_CONFIGURES}`, { params: StateParam, body: stateSchema.partial() }, { schema: Row }, ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"]),
    async (c, input) => {
      const { project } = await configurable(c, agileStates, input.params.stateId, "State", "configure");
      const body: Partial<z.infer<typeof stateSchema>> = input.body;
      const [current] = await db.instance.select().from(agileStates).where(eq(agileStates.id, input.params.stateId));
      if (body.isDefault === false && current.isDefault) {
        throw AppError.conflict("Make another state the default first");
      }
      if (body.isDefault) await clearDefault(project.id, current.id);
      const [state] = await db.instance
        .update(agileStates)
        .set({ ...body, ...(body.group ? groupFlags(body.group) : {}) })
        .where(eq(agileStates.id, current.id))
        .returning();
      return c.json(state);
    }
  );

  routes.put(
    "/:projectId/states/order",
    declare("reorder-states", "Reorder a project's states", `\`stateIds\` must be every state of the project exactly once (422 otherwise); the board shows them in that order. ${WHO_CONFIGURES}`, { params: ProjectParam, body: stateOrderSchema }, { schema: ListWithTotal }),
    async (c, input) => {
      const { project } = await projectToConfigure(c, input.params.projectId);
      const ids: string[] = input.body.stateIds;
      const existing = await db.instance
        .select({ id: agileStates.id })
        .from(agileStates)
        .where(eq(agileStates.projectId, project.id));
      const known = new Set(existing.map((s) => s.id));
      if (ids.length !== known.size || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) {
        throw AppError.validation("stateIds must list every state of the project once", { field: "stateIds" });
      }
      // (project_id, sequence) is unique: first out of the way, then into place.
      await db.instance
        .update(agileStates)
        .set({ sequence: sql`-1 - ${agileStates.sequence}` })
        .where(eq(agileStates.projectId, project.id));
      for (const [i, id] of ids.entries()) {
        await db.instance.update(agileStates).set({ sequence: i }).where(eq(agileStates.id, id));
      }
      const docs = await db.instance
        .select()
        .from(agileStates)
        .where(eq(agileStates.projectId, project.id))
        .orderBy(asc(agileStates.sequence));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  routes.delete(
    "/states/:stateId",
    declare("delete-state", "Delete a state", `Deletes a column. Its issues move to \`moveTo\` (a state of the same project); without it, a state that still has issues is a 409. The default state cannot be deleted (409). ${WHO_CONFIGURES}`, { params: StateParam, query: query({ moveTo: text("State that takes the issues (uuid)") }) }, { schema: Success }, ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"]),
    async (c, input) => {
      const { project, user } = await configurable(c, agileStates, input.params.stateId, "State", "configure");
      const [state] = await db.instance.select().from(agileStates).where(eq(agileStates.id, input.params.stateId));
      if (state.isDefault) throw AppError.conflict("The default state cannot be deleted");
      const moveTo = c.req.query("moveTo");
      const [{ n }] = await db.instance
        .select({ n: sql<number>`count(*)::int` })
        .from(agileIssues)
        .where(eq(agileIssues.stateId, state.id));
      if (n > 0) {
        if (!moveTo) throw AppError.conflict("The state still has issues: pass moveTo");
        if (moveTo === state.id) throw AppError.validation("moveTo is the state being deleted", { field: "moveTo" });
        await checkReferences(project.id, { stateId: moveTo }, project);
        const moved = await db.instance
          .update(agileIssues)
          .set({ stateId: moveTo, updatedAt: new Date() })
          .where(eq(agileIssues.stateId, state.id))
          .returning({ id: agileIssues.id });
        for (const m of moved) {
          await logActivity({
            actorId: user.id,
            projectId: project.id,
            issueId: m.id,
            entityType: "issue",
            entityId: m.id,
            action: "state_changed",
            changes: { stateId: [state.id, moveTo] },
          });
        }
      }
      await db.instance.delete(agileStates).where(eq(agileStates.id, state.id));
      return c.json({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // ESTIMATES
  // ═══════════════════════════════════════════════════════════════════════════════

  routes.get(
    "/:projectId/estimates",
    declare("list-estimates", "List a project's estimate scales", `Estimate systems (story points, t-shirt…). ${WHO_SEES}`, { params: ProjectParam }, { schema: ListWithTotal }),
    async (c, input) => {
      const { project } = await projectFor(c, input.params.projectId, "view");
      const docs = await db.instance
        .select()
        .from(agileEstimates)
        .where(eq(agileEstimates.projectId, project.id))
        .orderBy(desc(agileEstimates.isDefault), asc(agileEstimates.name));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  async function clearDefaultEstimate(projectId: string, except?: string) {
    await db.instance
      .update(agileEstimates)
      .set({ isDefault: false })
      .where(
        and(
          eq(agileEstimates.projectId, projectId),
          except ? ne(agileEstimates.id, except) : undefined
        )
      );
  }

  routes.post(
    "/:projectId/estimates",
    declare("create-estimate", "Create an estimate scale", `\`customPoints\` lists the values of a \`points\` scale. \`isDefault\` makes it the project's scale. ${WHO_CONFIGURES}`, { params: ProjectParam, body: estimateSchema }, { status: 201, schema: Row }),
    async (c, input) => {
      const { project } = await projectToConfigure(c, input.params.projectId);
      const body: z.infer<typeof estimateSchema> = input.body;
      if (body.isDefault) await clearDefaultEstimate(project.id);
      const [row] = await db.instance
        .insert(agileEstimates)
        .values({ projectId: project.id, ...body, isDefault: body.isDefault ?? false })
        .returning();
      return c.json(row, 201);
    }
  );

  routes.patch(
    "/estimates/:estimateId",
    declare("update-estimate", "Update an estimate scale", `Name, type, points or default. ${WHO_CONFIGURES}`, { params: EstimateParam, body: estimateSchema.partial() }),
    async (c, input) => {
      const { project } = await configurable(c, agileEstimates, input.params.estimateId, "Estimate", "configure");
      if (input.body.isDefault) await clearDefaultEstimate(project.id, input.params.estimateId);
      const [row] = await db.instance
        .update(agileEstimates)
        .set(input.body)
        .where(eq(agileEstimates.id, input.params.estimateId))
        .returning();
      return c.json(row);
    }
  );

  routes.delete(
    "/estimates/:estimateId",
    declare("delete-estimate", "Delete an estimate scale", `Issues keep their numbers. ${WHO_CONFIGURES}`, { params: EstimateParam }, { schema: Success }),
    async (c, input) => {
      await configurable(c, agileEstimates, input.params.estimateId, "Estimate", "configure");
      await db.instance.delete(agileEstimates).where(eq(agileEstimates.id, input.params.estimateId));
      return c.json({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // LINKS BETWEEN ISSUES
  // ═══════════════════════════════════════════════════════════════════════════════

  routes.get(
    "/issues/:key/links",
    declare("list-issue-links", "List an issue's links", `Links in both directions, each as seen from this issue (a \`blocks\` stored on the other issue reads \`blocked_by\` here), with the other issue's key, name and state. ${WHO_SEES}`, { params: KeyParam }, { schema: Docs }),
    async (c, input) => {
      const { issue } = await issueFor(c, input.params.key, "view");
      const rows = await db.instance
        .select({
          id: agileIssueLinks.id,
          sourceId: agileIssueLinks.sourceId,
          targetId: agileIssueLinks.targetId,
          linkType: agileIssueLinks.linkType,
          createdAt: agileIssueLinks.createdAt,
        })
        .from(agileIssueLinks)
        .where(or(eq(agileIssueLinks.sourceId, issue.id), eq(agileIssueLinks.targetId, issue.id)));
      const otherIds = rows.map((r) => (r.sourceId === issue.id ? r.targetId : r.sourceId));
      const others = otherIds.length
        ? await db.instance
            .select({
              id: agileIssues.id,
              key: agileIssues.key,
              name: agileIssues.name,
              stateName: agileStates.name,
              stateGroup: agileStates.group,
            })
            .from(agileIssues)
            .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
            .where(inArray(agileIssues.id, otherIds))
        : [];
      const byId = new Map(others.map((o) => [o.id, o]));
      const docs = rows.map((r) => {
        const outgoing = r.sourceId === issue.id;
        return {
          id: r.id,
          linkType: outgoing ? r.linkType : INVERSE[r.linkType],
          direction: outgoing ? "outgoing" : "incoming",
          issue: byId.get(outgoing ? r.targetId : r.sourceId) ?? null,
          createdAt: r.createdAt,
        };
      });
      return c.json({ docs });
    }
  );

  routes.post(
    "/issues/:key/links",
    declare("link-issues", "Link two issues", `Links this issue to \`targetKey\` (same project, not itself: 422) with \`linkType\`. The same link twice is a 409. ${WHO_WRITES_ISSUE}`, { params: KeyParam, body: linkSchema }, { status: 201, schema: Row }, ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"]),
    async (c, input) => {
      const { issue, user } = await issueToWrite(c, input.params.key);
      const body: z.infer<typeof linkSchema> = input.body;
      const [target] = await db.instance
        .select({ id: agileIssues.id, projectId: agileIssues.projectId })
        .from(agileIssues)
        .where(eq(agileIssues.key, body.targetKey))
        .limit(1);
      if (!target || target.projectId !== issue.projectId) {
        throw AppError.validation("targetKey is not an issue of this project", { field: "targetKey" });
      }
      if (target.id === issue.id) throw AppError.validation("An issue cannot link to itself", { field: "targetKey" });
      const [link] = await db.instance
        .insert(agileIssueLinks)
        .values({ sourceId: issue.id, targetId: target.id, linkType: body.linkType, createdBy: user.id })
        .returning();
      await logActivity({
        actorId: user.id,
        projectId: issue.projectId,
        issueId: issue.id,
        entityType: "issue",
        entityId: issue.id,
        action: "linked",
        description: `${body.linkType} ${body.targetKey}`,
      });
      return c.json(link, 201);
    }
  );

  routes.delete(
    "/issues/:key/links/:linkId",
    declare("unlink-issues", "Remove a link", `Removes a link of this issue (either direction; 404 if it is not one of its links). ${WHO_WRITES_ISSUE}`, { params: LinkParam }, { schema: Success }),
    async (c, input) => {
      const { issue, user } = await issueToWrite(c, input.params.key);
      if (!isUuid(input.params.linkId)) throw AppError.notFound("Link not found");
      const [row] = await db.instance
        .delete(agileIssueLinks)
        .where(
          and(
            eq(agileIssueLinks.id, input.params.linkId),
            or(eq(agileIssueLinks.sourceId, issue.id), eq(agileIssueLinks.targetId, issue.id))
          )
        )
        .returning();
      if (!row) throw AppError.notFound("Link not found");
      await logActivity({
        actorId: user.id,
        projectId: issue.projectId,
        issueId: issue.id,
        entityType: "issue",
        entityId: issue.id,
        action: "unlinked",
        description: row.linkType,
      });
      return c.json({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // CYCLES: read, edit, close with carry-over, delete
  // ═══════════════════════════════════════════════════════════════════════════════

  routes.get(
    "/cycles/:cycleId",
    declare("get-cycle", "Read a sprint with its numbers", `One cycle with live counts (issues and estimate, total and done) and its issues. ${WHO_SEES}`, { params: CycleParam }, { schema: Row }),
    async (c, input) => {
      await configurable(c, agileCycles, input.params.cycleId, "Cycle", "view");
      const [cycle] = await db.instance.select().from(agileCycles).where(eq(agileCycles.id, input.params.cycleId));
      const issues = await db.instance
        .select({
          id: agileIssues.id,
          key: agileIssues.key,
          name: agileIssues.name,
          priority: agileIssues.priority,
          assigneeId: agileIssues.assigneeId,
          estimate: agileIssues.estimate,
          stateId: agileIssues.stateId,
          stateGroup: agileStates.group,
        })
        .from(agileIssues)
        .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
        .where(eq(agileIssues.cycleId, cycle.id))
        .orderBy(asc(agileIssues.sortOrder), asc(agileIssues.createdAt));
      return c.json({ ...cycle, liveStats: workflow.cycleStats(issues), issues });
    }
  );

  routes.patch(
    "/cycles/:cycleId",
    declare("update-cycle", "Update a sprint", `Name, dates, goal, capacity, status or active flag (only one active cycle per project: activating one deactivates the others). \`endDate\` before \`startDate\` is a 422. ${WHO_CONFIGURES}`, { params: CycleParam, body: cyclePatchSchema }),
    async (c, input) => {
      const { project } = await configurable(c, agileCycles, input.params.cycleId, "Cycle", "configure");
      const body: z.infer<typeof cyclePatchSchema> = input.body;
      const [current] = await db.instance.select().from(agileCycles).where(eq(agileCycles.id, input.params.cycleId));
      const start = body.startDate ? new Date(body.startDate) : current.startDate;
      const end = body.endDate ? new Date(body.endDate) : current.endDate;
      if (end < start) throw AppError.validation("endDate is before startDate");
      if (body.isActive) {
        await db.instance
          .update(agileCycles)
          .set({ isActive: false })
          .where(and(eq(agileCycles.projectId, project.id), ne(agileCycles.id, current.id)));
      }
      const { startDate: _s, endDate: _e, ...rest } = body;
      const [cycle] = await db.instance
        .update(agileCycles)
        .set({ ...rest, startDate: start, endDate: end, updatedAt: new Date() })
        .where(eq(agileCycles.id, current.id))
        .returning();
      return c.json(cycle);
    }
  );

  routes.post(
    "/cycles/:cycleId/complete",
    declare("complete-cycle", "Close a sprint and carry over its unfinished work", `Marks the cycle completed, keeps its final numbers in \`stats\`, and moves every issue not completed or cancelled to \`carryOverTo\` (default: the next cycle of the project by start date; \`null\`: out of any cycle). A cycle already closed is a 409. ${WHO_CONFIGURES}`, { params: CycleParam, body: cycleCompleteSchema.optional(), validatesHandler: true }, { schema: Anything }, ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"]),
    async (c, input) => {
      const { project, user } = await configurable(c, agileCycles, input.params.cycleId, "Cycle", "configure");
      const raw = await c.req.text();
      let body: z.infer<typeof cycleCompleteSchema> = {};
      if (raw.trim()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw AppError.badRequest("Invalid JSON body");
        }
        const r = cycleCompleteSchema.strict().safeParse(parsed);
        if (!r.success) throw AppError.validation("Invalid body", { issues: r.error.issues });
        body = r.data;
      }
      if (body.carryOverTo) {
        if (body.carryOverTo === input.params.cycleId) {
          throw AppError.validation("carryOverTo is the cycle being closed", { field: "carryOverTo" });
        }
        await checkReferences(project.id, { cycleId: body.carryOverTo }, project);
      }
      const result = await workflow.completeCycle(input.params.cycleId, user.id, body.carryOverTo);
      return c.json(result);
    }
  );

  routes.delete(
    "/cycles/:cycleId",
    declare("delete-cycle", "Delete a sprint", `Its issues stay, out of any cycle. ${WHO_CONFIGURES}`, { params: CycleParam }, { schema: Success }),
    async (c, input) => {
      await configurable(c, agileCycles, input.params.cycleId, "Cycle", "configure");
      await db.instance.delete(agileCycles).where(eq(agileCycles.id, input.params.cycleId));
      return c.json({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // MODULES (epics): read, edit, delete, and their issues
  // ═══════════════════════════════════════════════════════════════════════════════

  /** Issues of a module: those with `module_id` and those added through `agile_module_issues`. */
  const inModule = (moduleId: string) =>
    or(
      eq(agileIssues.moduleId, moduleId),
      sql`exists (select 1 from ${agileModuleIssues} mi where mi.issue_id = ${agileIssues.id} and mi.module_id = ${moduleId})`
    );

  routes.get(
    "/modules/:moduleId",
    declare("get-module", "Read an epic with its progress", `One module with its issues and progress (done share). ${WHO_SEES}`, { params: ModuleParam }),
    async (c, input) => {
      await configurable(c, agileModules, input.params.moduleId, "Module", "view");
      const [module] = await db.instance.select().from(agileModules).where(eq(agileModules.id, input.params.moduleId));
      const issues = await db.instance
        .select({
          id: agileIssues.id,
          key: agileIssues.key,
          name: agileIssues.name,
          assigneeId: agileIssues.assigneeId,
          estimate: agileIssues.estimate,
          stateGroup: agileStates.group,
        })
        .from(agileIssues)
        .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
        .where(inModule(module.id));
      const done = issues.filter((i) => i.stateGroup === "completed").length;
      return c.json({
        ...module,
        issues,
        progress: { total: issues.length, completed: done, ratio: issues.length ? done / issues.length : 0 },
      });
    }
  );

  routes.patch(
    "/modules/:moduleId",
    declare("update-module", "Update an epic", `Name, description, color, status, lead, dates or initiative. ${WHO_CONFIGURES}`, { params: ModuleParam, body: modulePatchSchema }),
    async (c, input) => {
      const { project } = await configurable(c, agileModules, input.params.moduleId, "Module", "configure");
      const body: z.infer<typeof modulePatchSchema> = input.body;
      if (body.initiativeId) await checkReferences(project.id, { initiativeId: body.initiativeId }, project);
      if (body.leadId) await requireMember(project, body.leadId, "leadId");
      const { startDate, targetDate, ...rest } = body;
      const set: Partial<typeof agileModules.$inferInsert> = { ...rest, updatedAt: new Date() };
      if (startDate !== undefined) set.startDate = date(startDate);
      if (targetDate !== undefined) set.targetDate = date(targetDate);
      if (body.status === "in_progress") set.startedAt = new Date();
      if (body.status === "completed") set.completedAt = new Date();
      const [module] = await db.instance
        .update(agileModules)
        .set(set)
        .where(eq(agileModules.id, input.params.moduleId))
        .returning();
      return c.json(module);
    }
  );

  routes.delete(
    "/modules/:moduleId",
    declare("delete-module", "Delete an epic", `Its issues stay, out of the module. ${WHO_CONFIGURES}`, { params: ModuleParam }, { schema: Success }),
    async (c, input) => {
      await configurable(c, agileModules, input.params.moduleId, "Module", "configure");
      await db.instance.delete(agileModules).where(eq(agileModules.id, input.params.moduleId));
      return c.json({ success: true });
    }
  );

  routes.get(
    "/modules/:moduleId/issues",
    declare("list-module-issues", "List an epic's issues", `Issues whose module is this one, or that were added to it. ${WHO_SEES}`, { params: ModuleParam }, { schema: ListWithTotal }),
    async (c, input) => {
      await configurable(c, agileModules, input.params.moduleId, "Module", "view");
      const docs = await db.instance
        .select({
          id: agileIssues.id,
          key: agileIssues.key,
          name: agileIssues.name,
          priority: agileIssues.priority,
          assigneeId: agileIssues.assigneeId,
          stateId: agileIssues.stateId,
          stateName: agileStates.name,
          stateGroup: agileStates.group,
        })
        .from(agileIssues)
        .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
        .where(inModule(input.params.moduleId))
        .orderBy(asc(agileIssues.createdAt));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  routes.post(
    "/modules/:moduleId/issues",
    declare("add-module-issue", "Add an issue to an epic", `An issue can be in several modules. Adding it twice leaves the same state. The issue must be of the module's project (422). ${WHO_WRITES_ISSUE}`, { params: ModuleParam, body: moduleIssueSchema }, { status: 201, schema: Success }),
    async (c, input) => {
      const { issue, user } = await issueToWrite(c, input.body.issueKey);
      const { project } = await configurable(c, agileModules, input.params.moduleId, "Module", "view");
      if (project.id !== issue.projectId) {
        throw AppError.validation("The issue is not of the module's project", { field: "issueKey" });
      }
      await db.instance
        .insert(agileModuleIssues)
        .values({ moduleId: input.params.moduleId, issueId: issue.id })
        .onConflictDoNothing();
      await logActivity({
        actorId: user.id,
        projectId: issue.projectId,
        issueId: issue.id,
        entityType: "issue",
        entityId: issue.id,
        action: "added_to_module",
        changes: { moduleIds: [null, input.params.moduleId] },
      });
      return c.json({ success: true }, 201);
    }
  );

  routes.delete(
    "/modules/:moduleId/issues/:key",
    declare("remove-module-issue", "Remove an issue from an epic", `Takes the issue out of the module (also when it was its main \`moduleId\`). ${WHO_WRITES_ISSUE}`, { params: ModuleIssueParam }, { schema: Success }),
    async (c, input) => {
      const { issue, user } = await issueToWrite(c, input.params.key);
      if (!isUuid(input.params.moduleId)) throw AppError.notFound("Module not found");
      await db.instance
        .delete(agileModuleIssues)
        .where(and(eq(agileModuleIssues.moduleId, input.params.moduleId), eq(agileModuleIssues.issueId, issue.id)));
      if (issue.moduleId === input.params.moduleId) {
        await db.instance.update(agileIssues).set({ moduleId: null, updatedAt: new Date() }).where(eq(agileIssues.id, issue.id));
      }
      await logActivity({
        actorId: user.id,
        projectId: issue.projectId,
        issueId: issue.id,
        entityType: "issue",
        entityId: issue.id,
        action: "removed_from_module",
        changes: { moduleIds: [input.params.moduleId, null] },
      });
      return c.json({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // ISSUES: delete, archive, sub-issues, history
  // ═══════════════════════════════════════════════════════════════════════════════

  routes.delete(
    "/issues/:key",
    declare("delete-issue", "Delete an issue", `Deletes the issue with its comments, checklist and links; its sub-issues stay, without a parent. Owner or member of its project, never an agent (archive instead). Viewer or agent: 403; non-member: 404.`, { params: KeyParam }, { schema: Success }),
    async (c, input) => {
      const { issue } = await issueFor(c, input.params.key, "write");
      await projectToConfigure(c, issue.projectId);
      await db.instance
        .update(agileIssues)
        .set({ parentId: null, isSubIssue: false })
        .where(eq(agileIssues.parentId, issue.id));
      await db.instance.delete(agileIssues).where(eq(agileIssues.id, issue.id));
      await recountSubIssues(issue.parentId);
      return c.json({ success: true });
    }
  );

  for (const archive of [true, false]) {
    routes.post(
      archive ? "/issues/:key/archive" : "/issues/:key/unarchive",
      declare(
        archive ? "archive-issue" : "unarchive-issue",
        archive ? "Archive an issue" : "Bring back an archived issue",
        archive
          ? `An archived issue leaves the board and the lists (\`includeArchived=true\` shows it). ${WHO_WRITES_ISSUE}`
          : `The issue comes back to the board. ${WHO_WRITES_ISSUE}`,
        { params: KeyParam }
      ),
      async (c, input) => {
        const { issue, user } = await issueToWrite(c, input.params.key);
        const archivedAt = archive ? new Date() : null;
        const [row] = await db.instance
          .update(agileIssues)
          .set({ archivedAt, updatedAt: new Date() })
          .where(eq(agileIssues.id, issue.id))
          .returning();
        await logActivity({
          actorId: user.id,
          projectId: issue.projectId,
          issueId: issue.id,
          entityType: "issue",
          entityId: issue.id,
          action: archive ? "archived" : "unarchived",
        });
        return c.json(row);
      }
    );
  }

  routes.get(
    "/issues/:key/sub-issues",
    declare("list-sub-issues", "List an issue's sub-issues", `Its children, oldest first, with their state. ${WHO_SEES}`, { params: KeyParam }, { schema: ListWithTotal }),
    async (c, input) => {
      const { issue } = await issueFor(c, input.params.key, "view");
      const docs = await db.instance
        .select({
          id: agileIssues.id,
          key: agileIssues.key,
          name: agileIssues.name,
          priority: agileIssues.priority,
          assigneeId: agileIssues.assigneeId,
          stateId: agileIssues.stateId,
          stateName: agileStates.name,
          stateGroup: agileStates.group,
          archivedAt: agileIssues.archivedAt,
        })
        .from(agileIssues)
        .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
        .where(eq(agileIssues.parentId, issue.id))
        .orderBy(asc(agileIssues.createdAt));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  const historyQuery = query({
    limit: text("Max rows, 1-200 (default 50)"),
    before: text("Only rows older than this ISO date (paging)"),
  });
  const historyLimit = (v: string | undefined) => Math.min(Math.max(parseInt(v || "50", 10) || 50, 1), 200);
  const beforeDate = (v: string | undefined) => {
    if (!v) return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw AppError.badRequest("before is not a date");
    return d;
  };

  routes.get(
    "/issues/:key/activity",
    declare("list-issue-activity", "Read an issue's history", `Who changed what and when, newest first (\`limit\`, \`before\` to page). ${WHO_SEES}`, { params: KeyParam, query: historyQuery }, { schema: ListWithTotal }),
    async (c, input) => {
      const { issue } = await issueFor(c, input.params.key, "view");
      const before = beforeDate(c.req.query("before"));
      const docs = await db.instance
        .select()
        .from(agileActivityLog)
        .where(and(eq(agileActivityLog.issueId, issue.id), before ? lt(agileActivityLog.createdAt, before) : undefined))
        .orderBy(desc(agileActivityLog.createdAt))
        .limit(historyLimit(c.req.query("limit")));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  routes.get(
    "/:projectId/activity",
    declare("list-project-activity", "Read a project's history", `Every change in the project, newest first (\`limit\`, \`before\` to page). ${WHO_SEES}`, { params: ProjectParam, query: historyQuery }, { schema: ListWithTotal }),
    async (c, input) => {
      const { project } = await projectFor(c, input.params.projectId, "view");
      const before = beforeDate(c.req.query("before"));
      const docs = await db.instance
        .select()
        .from(agileActivityLog)
        .where(and(eq(agileActivityLog.projectId, project.id), before ? lt(agileActivityLog.createdAt, before) : undefined))
        .orderBy(desc(agileActivityLog.createdAt))
        .limit(historyLimit(c.req.query("limit")));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // CHECKLIST
  // ═══════════════════════════════════════════════════════════════════════════════

  routes.get(
    "/issues/:key/checklist",
    declare("list-checklist", "Read an issue's checklist", `Its steps in order, with how many are done. ${WHO_SEES}`, { params: KeyParam }, { schema: Anything }),
    async (c, input) => {
      const { issue } = await issueFor(c, input.params.key, "view");
      const docs = await db.instance
        .select()
        .from(agileChecklistItems)
        .where(eq(agileChecklistItems.issueId, issue.id))
        .orderBy(asc(agileChecklistItems.sortOrder), asc(agileChecklistItems.createdAt));
      return c.json({ docs, total: docs.length, done: docs.filter((d) => d.isDone).length });
    }
  );

  routes.post(
    "/issues/:key/checklist",
    declare("add-checklist-item", "Add a checklist step", `A step at the end (or at \`sortOrder\`). ${WHO_WRITES_ISSUE}`, { params: KeyParam, body: checklistSchema }, { status: 201, schema: Row }),
    async (c, input) => {
      const { issue, user } = await issueToWrite(c, input.params.key);
      const [{ last }] = await db.instance
        .select({ last: max(agileChecklistItems.sortOrder) })
        .from(agileChecklistItems)
        .where(eq(agileChecklistItems.issueId, issue.id));
      const [item] = await db.instance
        .insert(agileChecklistItems)
        .values({
          issueId: issue.id,
          text: input.body.text,
          sortOrder: input.body.sortOrder ?? (last ?? -1) + 1,
          createdBy: user.id,
        })
        .returning();
      return c.json(item, 201);
    }
  );

  async function checklistItem(issueId: string, itemId: string) {
    if (!isUuid(itemId)) throw AppError.notFound("Checklist item not found");
    const [item] = await db.instance
      .select()
      .from(agileChecklistItems)
      .where(and(eq(agileChecklistItems.id, itemId), eq(agileChecklistItems.issueId, issueId)))
      .limit(1);
    if (!item) throw AppError.notFound("Checklist item not found");
    return item;
  }

  routes.patch(
    "/issues/:key/checklist/:itemId",
    declare("update-checklist-item", "Tick or edit a checklist step", `\`isDone\` ticks it (signed with the caller and the time); text and order can change too. ${WHO_WRITES_ISSUE}`, { params: ItemParam, body: checklistPatchSchema }),
    async (c, input) => {
      const { issue, user } = await issueToWrite(c, input.params.key);
      const item = await checklistItem(issue.id, input.params.itemId);
      const body: z.infer<typeof checklistPatchSchema> = input.body;
      const set: Partial<typeof agileChecklistItems.$inferInsert> = { ...body, updatedAt: new Date() };
      if (body.isDone !== undefined && body.isDone !== item.isDone) {
        set.doneBy = body.isDone ? user.id : null;
        set.doneAt = body.isDone ? new Date() : null;
        await logActivity({
          actorId: user.id,
          projectId: issue.projectId,
          issueId: issue.id,
          entityType: "checklist_item",
          entityId: item.id,
          action: body.isDone ? "checked" : "unchecked",
          description: item.text,
        });
      }
      const [row] = await db.instance
        .update(agileChecklistItems)
        .set(set)
        .where(eq(agileChecklistItems.id, item.id))
        .returning();
      return c.json(row);
    }
  );

  routes.delete(
    "/issues/:key/checklist/:itemId",
    declare("delete-checklist-item", "Delete a checklist step", WHO_WRITES_ISSUE, { params: ItemParam }, { schema: Success }),
    async (c, input) => {
      const { issue } = await issueToWrite(c, input.params.key);
      const item = await checklistItem(issue.id, input.params.itemId);
      await db.instance.delete(agileChecklistItems).where(eq(agileChecklistItems.id, item.id));
      return c.json({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // CUSTOM FIELDS
  // ═══════════════════════════════════════════════════════════════════════════════

  routes.get(
    "/:projectId/fields",
    declare("list-custom-fields", "List a project's custom fields", `Definitions in order. Issue values live in \`props.customFields[key]\`. ${WHO_SEES}`, { params: ProjectParam }, { schema: ListWithTotal }),
    async (c, input) => {
      const { project } = await projectFor(c, input.params.projectId, "view");
      const docs = await fieldsOf(db.instance, project.id);
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  const needsOptions = (type: string) => type === "select" || type === "multi_select";

  routes.post(
    "/:projectId/fields",
    declare("create-custom-field", "Create a custom field", `\`key\` is unique in the project (409) and never changes; \`select\` and \`multi_select\` need \`options\` (422). ${WHO_CONFIGURES}`, { params: ProjectParam, body: fieldSchema }, { status: 201, schema: Row }, ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"]),
    async (c, input) => {
      const { project } = await projectToConfigure(c, input.params.projectId);
      const body: z.infer<typeof fieldSchema> = input.body;
      if (needsOptions(body.type) && !body.options?.length) {
        throw AppError.validation("A select field needs options", { field: "options" });
      }
      const [row] = await db.instance
        .insert(agileCustomFields)
        .values({
          projectId: project.id,
          key: body.key,
          name: body.name,
          type: body.type,
          options: body.options ?? [],
          isRequired: body.isRequired ?? false,
          sortOrder: body.sortOrder ?? 0,
        })
        .returning();
      return c.json(row, 201);
    }
  );

  routes.patch(
    "/fields/:fieldId",
    declare("update-custom-field", "Update a custom field", `Name, options, required or order (the key and type do not change: create another field). ${WHO_CONFIGURES}`, { params: FieldParam, body: fieldPatchSchema }),
    async (c, input) => {
      await configurable(c, agileCustomFields, input.params.fieldId, "Custom field", "configure");
      const [current] = await db.instance.select().from(agileCustomFields).where(eq(agileCustomFields.id, input.params.fieldId));
      if (input.body.options && needsOptions(current.type) && input.body.options.length === 0) {
        throw AppError.validation("A select field needs options", { field: "options" });
      }
      const [row] = await db.instance
        .update(agileCustomFields)
        .set(input.body)
        .where(eq(agileCustomFields.id, current.id))
        .returning();
      return c.json(row);
    }
  );

  routes.delete(
    "/fields/:fieldId",
    declare("delete-custom-field", "Delete a custom field", `Removes the definition; values already stored in issues are dropped from them too. ${WHO_CONFIGURES}`, { params: FieldParam }, { schema: Success }),
    async (c, input) => {
      const { project } = await configurable(c, agileCustomFields, input.params.fieldId, "Custom field", "configure");
      const [field] = await db.instance
        .delete(agileCustomFields)
        .where(eq(agileCustomFields.id, input.params.fieldId))
        .returning();
      await db.instance
        .update(agileIssues)
        .set({ props: sql`jsonb_set(${agileIssues.props}, '{customFields}', coalesce(${agileIssues.props}->'customFields', '{}'::jsonb) - ${field.key})` })
        .where(and(eq(agileIssues.projectId, project.id), sql`${agileIssues.props}->'customFields' ? ${field.key}`));
      return c.json({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // INITIATIVES
  // ═══════════════════════════════════════════════════════════════════════════════

  /** Issue counts per initiative (including those of its modules). */
  async function initiativeCounts(ids: string[]) {
    if (!ids.length) return new Map<string, { total: number; done: number }>();
    const rows = await db.instance
      .select({
        initiativeId: sql<string>`coalesce(${agileIssues.initiativeId}, ${agileModules.initiativeId})`,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${agileStates.group} = 'completed')::int`,
      })
      .from(agileIssues)
      .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
      .leftJoin(agileModules, eq(agileIssues.moduleId, agileModules.id))
      .where(
        and(
          isNull(agileIssues.archivedAt),
          sql`coalesce(${agileIssues.initiativeId}, ${agileModules.initiativeId}) in (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `
          )})`,
          sql`${agileStates.group} <> 'cancelled'`
        )
      )
      .groupBy(sql`1`);
    return new Map(rows.map((r) => [r.initiativeId, { total: r.total, done: r.done }]));
  }

  const withPace = (i: typeof agileInitiatives.$inferSelect, counts?: { total: number; done: number }) => {
    const total = counts?.total ?? 0;
    const done = counts?.done ?? 0;
    return { ...i, issues: { total, completed: done }, pace: pace(total, done, i.startDate ?? i.createdAt, i.targetDate) };
  };

  routes.get(
    "/:projectId/initiatives",
    declare("list-initiatives", "List a project's initiatives", `Each initiative with its issue counts (directly or through its modules, cancelled ones left out) and its pace: done share against elapsed share of [startDate, targetDate] → on_track, at_risk, off_track, done or no_dates. ${WHO_SEES}`, { params: ProjectParam }, { schema: ListWithTotal }),
    async (c, input) => {
      const { project } = await projectFor(c, input.params.projectId, "view");
      const rows = await db.instance
        .select()
        .from(agileInitiatives)
        .where(eq(agileInitiatives.projectId, project.id))
        .orderBy(asc(agileInitiatives.targetDate), asc(agileInitiatives.name));
      const counts = await initiativeCounts(rows.map((r) => r.id));
      const docs = rows.map((r) => withPace(r, counts.get(r.id)));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  routes.post(
    "/:projectId/initiatives",
    declare("create-initiative", "Create an initiative", `A goal with a target date that issues and modules point to (\`initiativeId\`). ${WHO_CONFIGURES}`, { params: ProjectParam, body: initiativeSchema }, { status: 201, schema: Row }),
    async (c, input) => {
      const { project, user } = await projectToConfigure(c, input.params.projectId);
      const body: z.infer<typeof initiativeSchema> = input.body;
      if (body.leadId) await requireMember(project, body.leadId, "leadId");
      const start = date(body.startDate);
      const target = date(body.targetDate);
      if (start && target && target < start) throw AppError.validation("targetDate is before startDate");
      const [row] = await db.instance
        .insert(agileInitiatives)
        .values({
          projectId: project.id,
          name: body.name,
          description: body.description,
          status: body.status ?? "planned",
          leadId: body.leadId,
          color: body.color,
          startDate: start,
          targetDate: target,
          createdBy: user.id,
        })
        .returning();
      return c.json(row, 201);
    }
  );

  routes.get(
    "/initiatives/:initiativeId",
    declare("get-initiative", "Read an initiative with its pace", `The initiative, its modules and issues, and its pace. ${WHO_SEES}`, { params: InitiativeParam }),
    async (c, input) => {
      await configurable(c, agileInitiatives, input.params.initiativeId, "Initiative", "view");
      const [row] = await db.instance.select().from(agileInitiatives).where(eq(agileInitiatives.id, input.params.initiativeId));
      const counts = await initiativeCounts([row.id]);
      const modules = await db.instance
        .select({ id: agileModules.id, name: agileModules.name, status: agileModules.status })
        .from(agileModules)
        .where(eq(agileModules.initiativeId, row.id));
      const issues = await db.instance
        .select({
          id: agileIssues.id,
          key: agileIssues.key,
          name: agileIssues.name,
          assigneeId: agileIssues.assigneeId,
          stateGroup: agileStates.group,
          targetDate: agileIssues.targetDate,
        })
        .from(agileIssues)
        .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
        .leftJoin(agileModules, eq(agileIssues.moduleId, agileModules.id))
        .where(
          and(
            isNull(agileIssues.archivedAt),
            or(eq(agileIssues.initiativeId, row.id), eq(agileModules.initiativeId, row.id))
          )
        )
        .orderBy(asc(agileIssues.createdAt));
      return c.json({ ...withPace(row, counts.get(row.id)), modules, issueList: issues });
    }
  );

  routes.patch(
    "/initiatives/:initiativeId",
    declare("update-initiative", "Update an initiative", `Name, description, status, lead, color or dates. ${WHO_CONFIGURES}`, { params: InitiativeParam, body: initiativePatchSchema }),
    async (c, input) => {
      const { project } = await configurable(c, agileInitiatives, input.params.initiativeId, "Initiative", "configure");
      const body: z.infer<typeof initiativePatchSchema> = input.body;
      if (body.leadId) await requireMember(project, body.leadId, "leadId");
      const { startDate, targetDate, ...rest } = body;
      const set: Partial<typeof agileInitiatives.$inferInsert> = { ...rest, updatedAt: new Date() };
      if (startDate !== undefined) set.startDate = date(startDate);
      if (targetDate !== undefined) set.targetDate = date(targetDate);
      const [row] = await db.instance
        .update(agileInitiatives)
        .set(set)
        .where(eq(agileInitiatives.id, input.params.initiativeId))
        .returning();
      if (row.startDate && row.targetDate && row.targetDate < row.startDate) {
        throw AppError.validation("targetDate is before startDate");
      }
      return c.json(row);
    }
  );

  routes.delete(
    "/initiatives/:initiativeId",
    declare("delete-initiative", "Delete an initiative", `Its issues and modules stay, without an initiative. ${WHO_CONFIGURES}`, { params: InitiativeParam }, { schema: Success }),
    async (c, input) => {
      await configurable(c, agileInitiatives, input.params.initiativeId, "Initiative", "configure");
      await db.instance.delete(agileInitiatives).where(eq(agileInitiatives.id, input.params.initiativeId));
      return c.json({ success: true });
    }
  );

  void userValue;
  void DONE_GROUPS;
  return routes.ops;
}

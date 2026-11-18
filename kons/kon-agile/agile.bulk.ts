/**
 * kon-agile — one change on many issues (1.4)
 * ============================================================================
 *
 * Moving forty issues to "Done", or out of a sprint, was forty requests; for an agent, forty tool
 * calls and forty answers in its context. `POST /:projectId/issues/bulk` does it in one.
 *
 * All or nothing. The host rolls a request back only when it fails with a 5xx, so a 403 or a 422
 * halfway would leave half the issues changed. Everything is checked first (each issue exists, is in
 * the project and in the caller's reach; the references belong to the project; every state's
 * validations pass), and only then is anything written. Each issue then goes through the same
 * `prepareIssue`/`afterIssue` as a single update: history, notifications, agent work and events.
 */

import { AppError, type AnyOperation } from "@kitsuden/engine";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "@kitsuden/engine/zod";

import type { AgileAccess } from "./agile.access";
import type { AgileDb } from "./agile.db";
import { agileIssueLabels, agileIssues, agileLabels, type AgileIssue } from "./agile.schema";
import type { AgileWorkflow } from "./agile.workflow";
import { declareOp, ProjectParam, registry } from "./operations";

const uuid = z.guid();
const isoDate = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

export const bulkSchema = z
  .object({
    keys: z.array(z.string().min(1).max(64)).min(1).max(100).describe("Issue keys of this project, e.g. [\"PLAT-12\", \"PLAT-13\"] (1 to 100)"),
    set: z
      .object({
        stateId: uuid.optional(),
        assigneeId: z.string().min(1).max(128).nullable().optional(),
        priority: z.enum(["urgent", "high", "medium", "low"]).optional(),
        cycleId: uuid.nullable().optional(),
        moduleId: uuid.nullable().optional(),
        initiativeId: uuid.nullable().optional(),
        estimate: z.number().int().min(0).max(10_000).nullable().optional(),
        targetDate: isoDate.nullable().optional(),
      })
      .strict()
      .optional()
      .describe("Fields to set on every issue (same rules as a single update)"),
    addLabelIds: z.array(uuid).max(50).optional().describe("Labels of the project to add"),
    removeLabelIds: z.array(uuid).max(50).optional().describe("Labels to remove"),
    archive: z.boolean().optional().describe("true archives them, false restores them"),
  })
  .strict();

const BulkResult = z
  .object({ updated: z.number().int(), keys: z.array(z.string()) })
  .passthrough();

export function bulkOperations(
  db: { instance: AgileDb },
  access: AgileAccess,
  workflow: AgileWorkflow
): AnyOperation[] {
  const routes = registry();
  const { projectFor, agentReach, inReach, requireReach, checkReferences } = access;

  routes.post(
    "/:projectId/issues/bulk",
    declareOp(
      "bulk-update-issues",
      "Change many issues at once",
      "Applies the same change to up to 100 issues of the project: fields in `set` (state, assignee, priority, sprint, epic, initiative, estimate, target date), labels to add or remove, archive or restore. All or nothing: if one issue is missing (404), out of the caller's reach (403) or fails a state's validation (422), nothing is changed and the error names it. Each issue then gets its history, notifications, agent work and events as with a single update. Owner or member of the project; an agent only on issues in its reach (as scrum master, it assigns only inside its squad).",
      { params: ProjectParam, body: bulkSchema },
      { schema: BulkResult },
      ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"]
    ),
    async (c, input) => {
      const { project, user } = await projectFor(c, input.params.projectId, "write");
      const body: z.infer<typeof bulkSchema> = input.body;
      const set = body.set ?? {};
      const keys = [...new Set(body.keys)];
      if (!Object.keys(set).length && !body.addLabelIds?.length && !body.removeLabelIds?.length && body.archive === undefined) {
        throw AppError.validation("Nothing to change: give set, addLabelIds, removeLabelIds or archive");
      }

      // ── 1. Check everything ────────────────────────────────────────────────
      const issues = await db.instance
        .select()
        .from(agileIssues)
        .where(and(eq(agileIssues.projectId, project.id), inArray(agileIssues.key, keys)));
      const byKey = new Map(issues.map((i) => [i.key, i]));
      const missing = keys.filter((k) => !byKey.has(k));
      if (missing.length) throw AppError.notFound(`Issues not found in this project: ${missing.join(", ")}`);

      const reach = await agentReach(project.id, user);
      const outOfReach = issues.filter((i) => !inReach(reach, i.assigneeId)).map((i) => i.key);
      if (outOfReach.length) {
        throw AppError.forbidden(`Out of your reach (an agent writes only on its own issues, or its squad's): ${outOfReach.join(", ")}`);
      }
      await checkReferences(project.id, set, project);
      if (reach?.unassigned && set.assigneeId !== undefined) requireReach(reach, set.assigneeId);

      const labelIds = [...new Set([...(body.addLabelIds ?? []), ...(body.removeLabelIds ?? [])])];
      if (labelIds.length) {
        const valid = await db.instance
          .select({ id: agileLabels.id })
          .from(agileLabels)
          .where(and(eq(agileLabels.projectId, project.id), inArray(agileLabels.id, labelIds)));
        if (valid.length !== labelIds.length) {
          throw AppError.validation("addLabelIds/removeLabelIds has labels of another project", { field: "addLabelIds" });
        }
      }

      const now = new Date();
      const values: Partial<typeof agileIssues.$inferInsert> = { updatedAt: now };
      if (set.stateId !== undefined) values.stateId = set.stateId;
      if (set.assigneeId !== undefined) values.assigneeId = set.assigneeId;
      if (set.priority !== undefined) values.priority = set.priority;
      if (set.cycleId !== undefined) values.cycleId = set.cycleId;
      if (set.moduleId !== undefined) values.moduleId = set.moduleId;
      if (set.initiativeId !== undefined) values.initiativeId = set.initiativeId;
      if (set.estimate !== undefined) values.estimate = set.estimate;
      if (set.targetDate !== undefined) values.targetDate = set.targetDate ? new Date(set.targetDate) : null;
      if (body.archive !== undefined) values.archivedAt = body.archive ? now : null;

      // prepareIssue only reads: a state validation that fails throws here, before any write.
      const prepared: { before: AgileIssue; values: Partial<typeof agileIssues.$inferInsert> }[] = [];
      for (const key of keys) {
        const before = byKey.get(key)!;
        try {
          prepared.push({ before, values: await workflow.prepareIssue(project, before, values, set.assigneeId !== undefined) });
        } catch (e) {
          if (e instanceof AppError) throw AppError.validation(`${key}: ${e.message}`, { key });
          throw e;
        }
      }

      // ── 2. Write ───────────────────────────────────────────────────────────
      for (const { before, values: v } of prepared) {
        const [after] = await db.instance.update(agileIssues).set(v).where(eq(agileIssues.id, before.id)).returning();
        if (body.removeLabelIds?.length) {
          await db.instance
            .delete(agileIssueLabels)
            .where(and(eq(agileIssueLabels.issueId, before.id), inArray(agileIssueLabels.labelId, body.removeLabelIds)));
        }
        if (body.addLabelIds?.length) {
          await db.instance
            .insert(agileIssueLabels)
            .values(body.addLabelIds.map((labelId) => ({ issueId: before.id, labelId })))
            .onConflictDoNothing();
        }
        if (body.addLabelIds?.length || body.removeLabelIds?.length) {
          await access.logActivity({
            actorId: user.id,
            projectId: project.id,
            issueId: before.id,
            entityType: "issue",
            entityId: before.id,
            action: "labels_changed",
            changes: { labels: [{ removed: body.removeLabelIds ?? [] }, { added: body.addLabelIds ?? [] }] },
          });
        }
        await workflow.afterIssue(project, user, before, after);
      }
      return c.json({ updated: prepared.length, keys });
    }
  );

  return routes.ops;
}

/**
 * kon-agile — attachments, subscribers and reactions (1.4)
 * ============================================================================
 *
 * Attachments. The file is uploaded to the core's media library (`POST /api/media`, kon-media) and
 * hung on an issue by its id. The row copies the name, type and size, so listing does not depend on
 * another battery's table; the media library keeps the file and its access rules. Removing the
 * attachment does not delete the file (it may be used elsewhere).
 *
 * Subscribers. Whoever follows an issue hears about its comments and state changes (agile.workflow.ts).
 * The creator, every assignee and every commenter follow it on their own; anyone in the project may
 * follow or stop following it.
 *
 * Reactions. Any member (viewers and agents too) reacts to a comment for themselves. Editing a
 * comment stays with writers, so the toggle is the database function `agile_toggle_reaction`
 * (migration 0006), which only touches the caller's own id.
 */

import { AppError, isUuid, type AnyOperation } from "@kitsuden/engine";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "@kitsuden/engine/zod";

import type { AgileAccess } from "./agile.access";
import type { AgileDb } from "./agile.db";
import { agileIssueAttachments, agileIssues, agileIssueSubscribers } from "./agile.schema";
import type { AgileWorkflow } from "./agile.workflow";
import { declareOp, KeyParam, ListWithTotal, Row, Success, registry } from "./operations";

const AttachmentParam = z.object({
  key: z.string().describe("Issue key, e.g. PLAT-12"),
  attachmentId: z.string().describe("Attachment id (uuid)"),
});
const CommentParam = z.object({ commentId: z.string().describe("Comment id (uuid)") });

const attachSchema = z.object({
  mediaId: z.guid().describe("Id of a file in the media library (upload it first with POST /api/media)"),
  name: z.string().min(1).max(500).optional().describe("Name to show; by default the file's original name"),
});
const reactionSchema = z.object({
  emoji: z.string().min(1).max(32).describe("The reaction, e.g. 👍 or `+1`; sending it again removes it"),
});

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return ((result as { rows?: unknown[] } | null)?.rows ?? []) as Record<string, unknown>[];
}

export function collabOperations(
  db: { instance: AgileDb },
  access: AgileAccess,
  workflow: AgileWorkflow
): AnyOperation[] {
  const routes = registry();
  const { issueFor, issueToWrite, userValue } = access;

  const WHO_SEES = "Only for members of the issue's project (and admin); anyone else gets 404.";
  const WHO_WRITES =
    "Owner or member of the issue's project; an agent only on issues in its reach (viewer or agent out of reach: 403; non-member: 404).";

  /** The file in the media library, or null when it is not there (or the caller cannot see it). */
  async function mediaFile(mediaId: string) {
    const installed = rowsOf(await db.instance.execute(sql`SELECT to_regclass('public.media') IS NOT NULL AS installed`));
    if (!installed[0]?.installed) return null;
    const rows = rowsOf(
      await db.instance.execute(
        sql`SELECT id, original_name AS name, mime_type AS "mimeType", size FROM media WHERE id = ${mediaId}::uuid LIMIT 1`
      )
    );
    const row = rows[0];
    return row
      ? {
          name: String(row.name ?? ""),
          mimeType: row.mimeType == null ? null : String(row.mimeType),
          size: row.size == null ? null : Number(row.size),
        }
      : null;
  }

  async function recountAttachments(issueId: string) {
    await db.instance
      .update(agileIssues)
      .set({ attachmentsCount: sql`(select count(*)::int from agile_issue_attachments where issue_id = ${issueId})` })
      .where(eq(agileIssues.id, issueId));
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // ATTACHMENTS
  // ═══════════════════════════════════════════════════════════════════════════════

  routes.get(
    "/issues/:key/attachments",
    declareOp("list-attachments", "List an issue's attachments", `Each file with its media id, name, type, size and who attached it, oldest first. The file is served by the media library. ${WHO_SEES}`, { params: KeyParam }, { schema: ListWithTotal }),
    async (c, input) => {
      const { issue } = await issueFor(c, input.params.key, "view");
      const docs = await db.instance
        .select()
        .from(agileIssueAttachments)
        .where(eq(agileIssueAttachments.issueId, issue.id))
        .orderBy(asc(agileIssueAttachments.createdAt));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  routes.post(
    "/issues/:key/attachments",
    declareOp("attach-file", "Attach a file to an issue", `Hangs a file of the media library on the issue (upload it first with \`POST /api/media\`). 422 if the media id does not exist; 409 if it is already attached. Updates the issue's attachment count and its history. ${WHO_WRITES}`, { params: KeyParam, body: attachSchema }, { status: 201, schema: Row }, ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"]),
    async (c, input) => {
      const { issue, project, user } = await issueToWrite(c, input.params.key);
      const body: z.infer<typeof attachSchema> = input.body;
      const file = await mediaFile(body.mediaId);
      if (!file) throw AppError.validation("mediaId is not a file of the media library", { field: "mediaId" });
      const [already] = await db.instance
        .select({ id: agileIssueAttachments.id })
        .from(agileIssueAttachments)
        .where(and(eq(agileIssueAttachments.issueId, issue.id), eq(agileIssueAttachments.mediaId, body.mediaId)))
        .limit(1);
      if (already) throw AppError.conflict("That file is already attached to the issue");
      const [row] = await db.instance
        .insert(agileIssueAttachments)
        .values({
          issueId: issue.id,
          mediaId: body.mediaId,
          name: body.name ?? (file.name || "file"),
          mimeType: file.mimeType,
          size: file.size,
          createdBy: user.id,
        })
        .returning();
      await recountAttachments(issue.id);
      await access.logActivity({ actorId: user.id, projectId: project.id, issueId: issue.id, entityType: "attachment", entityId: row.id, action: "attached", description: row.name });
      await workflow.subscribe(issue.id, [user.id]);
      return c.json(row, 201);
    }
  );

  routes.delete(
    "/issues/:key/attachments/:attachmentId",
    declareOp("remove-attachment", "Remove an attachment", `Unhooks the file from the issue; the file stays in the media library. 404 if it is not an attachment of this issue. ${WHO_WRITES}`, { params: AttachmentParam }, { schema: Success }),
    async (c, input) => {
      const { issue, project, user } = await issueToWrite(c, input.params.key);
      if (!isUuid(input.params.attachmentId)) throw AppError.notFound("Attachment not found");
      const [row] = await db.instance
        .delete(agileIssueAttachments)
        .where(and(eq(agileIssueAttachments.id, input.params.attachmentId), eq(agileIssueAttachments.issueId, issue.id)))
        .returning();
      if (!row) throw AppError.notFound("Attachment not found");
      await recountAttachments(issue.id);
      await access.logActivity({ actorId: user.id, projectId: project.id, issueId: issue.id, entityType: "attachment", entityId: row.id, action: "detached", description: row.name });
      return c.json({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // SUBSCRIBERS
  // ═══════════════════════════════════════════════════════════════════════════════

  const Subscribers = z
    .object({ docs: z.array(z.object({ userId: z.string() }).passthrough()), totalDocs: z.number().int(), subscribed: z.boolean() })
    .passthrough();

  routes.get(
    "/issues/:key/subscribers",
    declareOp("list-subscribers", "Who follows an issue", `The members who hear about the issue's comments and state changes, and whether the caller is one of them. ${WHO_SEES}`, { params: KeyParam }, { schema: Subscribers }),
    async (c, input) => {
      const { issue, user } = await issueFor(c, input.params.key, "view");
      const docs = await db.instance
        .select({ userId: agileIssueSubscribers.userId, createdAt: agileIssueSubscribers.createdAt })
        .from(agileIssueSubscribers)
        .where(eq(agileIssueSubscribers.issueId, issue.id))
        .orderBy(asc(agileIssueSubscribers.createdAt));
      return c.json({ docs, totalDocs: docs.length, subscribed: docs.some((d) => d.userId === user.id) });
    }
  );

  routes.post(
    "/issues/:key/subscribe",
    declareOp("subscribe-issue", "Follow an issue", `The caller hears about the issue's comments and state changes. Following twice changes nothing. Any member of the project, viewers and agents included. ${WHO_SEES}`, { params: KeyParam }, { schema: Success }),
    async (c, input) => {
      const { issue, user } = await issueFor(c, input.params.key, "view");
      await workflow.subscribe(issue.id, [user.id]);
      return c.json({ success: true });
    }
  );

  routes.delete(
    "/issues/:key/subscribe",
    declareOp("unsubscribe-issue", "Stop following an issue", `The caller no longer hears about the issue (until it is assigned to them or comments again). ${WHO_SEES}`, { params: KeyParam }, { schema: Success }),
    async (c, input) => {
      const { issue, user } = await issueFor(c, input.params.key, "view");
      await db.instance
        .delete(agileIssueSubscribers)
        .where(and(eq(agileIssueSubscribers.issueId, issue.id), eq(agileIssueSubscribers.userId, user.id)));
      return c.json({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // REACTIONS
  // ═══════════════════════════════════════════════════════════════════════════════

  routes.post(
    "/comments/:commentId/reactions",
    declareOp("toggle-reaction", "React to a comment", "Adds the caller's reaction to a comment, or removes it when it was already there. Answers the comment's reactions (emoji → ids). Any member of the comment's project, viewers and agents included; anyone else gets 404.", { params: CommentParam, body: reactionSchema }, { schema: z.object({ reactions: z.record(z.string(), z.array(z.string())) }).passthrough() }),
    async (c, input) => {
      userValue(c);
      if (!isUuid(input.params.commentId)) throw AppError.notFound("Comment not found");
      const rows = rowsOf(
        await db.instance.execute(sql`SELECT agile_toggle_reaction(${input.params.commentId}::uuid, ${input.body.emoji}) AS reactions`)
      );
      const reactions = rows[0]?.reactions;
      if (reactions === null || reactions === undefined) throw AppError.notFound("Comment not found");
      const value = typeof reactions === "string" ? JSON.parse(reactions) : reactions;
      return c.json({ reactions: value });
    }
  );

  return routes.ops;
}

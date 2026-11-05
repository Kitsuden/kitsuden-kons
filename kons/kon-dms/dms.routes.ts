/**
 * Kitsuden DMS - Document Management System Routes
 *
 * REST API for versioned document management with:
 * - Complete CRUD of documents and versions
 * - Semantic versioning (major.minor.patch)
 * - Approval workflow
 * - Hierarchical categorization
 * - File management
 * - Complete audit trail
 *
 * ── Security ────────────────────────────────────────────────────────────────
 *
 * Before, the ONLY check was `requireAuth` (sign-up is public) and an ACL
 * that only looked at `/render/:slug`. Any account: listed and read all
 * documents and their drafts by id, version, file or comment; edited
 * or archived other people's documents and changed their owner and ACL; reviewed and
 * published versions (their own included); rewrote published versions
 * with `force`; read the audit log and the read confirmations
 * of everyone; and exported unescaped HTML served as `text/html` from the
 * API origin (stored XSS). File upload used a method that
 * `KonStorage` does not have (it always failed) and put the client's name into the
 * storage path.
 *
 * Now, on each route:
 *   1. session                                       → 401
 *   2. the request's RLS context (from the host)      → the database filters the same
 *   3. "dms_document" policy with `can()` (rules in dms.acceso.ts):
 *        unable to SEE the document/version/file → 404 (it is not confirmed
 *        that it exists); seeing it but without permission → 403
 *   4. allowlisted bodies (each operation's `input`) and authorship from the session
 *   5. every cross reference (version, parent comment, target document)
 *      has to belong to the SAME document or be visible to whoever uses it
 *   6. errors without internal details (http-errors.ts)
 *
 * Each route is now an OPERATION of the kon SDK (operations.ts):
 * each handler's body is the old one; what used to be middlewares
 * (`requireAuth`, `validateRequest`) is now its declaration, in the same
 * order: session → (agent that can act as an account) → body → handler.
 */

import { randomUUID } from "node:crypto";

import {
  AppError,
  can,
  isUuid,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import {
  eq,
  and,
  or,
  sql,
  desc,
  asc,
  like,
  isNull,
  inArray,
  gte,
  lte,
  type SQL,
} from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";

import {
  VISIBILITIES,
  isAdmin,
  readFilter,
  permissions,
  canViewVersion,
  type DocAcl,
  type Permissions,
  type DmsUser,
} from "./dms.access";
import type { DmsDb } from "./dms.db";
import { registerDmsPolicy, type DocumentResource } from "./dms.policy";
import {
  dmsCategories,
  dmsDocuments,
  dmsDocumentVersions,
  dmsDocumentFiles,
  dmsDocumentRelations,
  dmsDocumentAcknowledgments,
  dmsAccessLog,
  dmsWorkflowNotifications,
  dmsDocumentSlugHistory,
  dmsDocumentComments,
  dmsDocumentDiagrams,
  type DmsDocument,
  type DmsDocumentVersion,
} from "./dms.schema";
import { respondWithError } from "./http-errors";
import { ANY_ACCOUNT, KON_ID, registry } from "./operations";

// ═══════════════════════════════════════════════════════════════════════════
// Enum filters by query string (an unknown value is ignored)
// ═══════════════════════════════════════════════════════════════════════════

const DOC_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "published",
  "archived",
  "deprecated",
] as const;
const DOC_TYPES = [
  "manual",
  "policy",
  "procedure",
  "template",
  "guide",
  "training",
  "report",
  "other",
] as const;

type DocStatus = (typeof DOC_STATUSES)[number];
type DocType = (typeof DOC_TYPES)[number];

const docStatus = (v: string | undefined): DocStatus | null =>
  DOC_STATUSES.includes(v as DocStatus) ? (v as DocStatus) : null;
const docType = (v: string | undefined): DocType | null =>
  DOC_TYPES.includes(v as DocType) ? (v as DocType) : null;

// ═══════════════════════════════════════════════════════════════════════════
// Schemas (allowlist: a field that is not here is a 422)
// ═══════════════════════════════════════════════════════════════════════════

const uuid = z.guid();
const userIdValue = z.string().min(1).max(128);
const ids = z.array(userIdValue).max(200);
/**
 * A date that `new Date()` understands. Without the `refine`, "2026-13-45" passed the
 * pattern, arrived as `Invalid Date` at the column and Drizzle blew up in
 * `toISOString()`: a 500 (SDK migration). Now, 422.
 */
const date = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
  .refine((s) => !Number.isNaN(new Date(s).getTime()), "Invalid date");
const slug = z
  .string()
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug: lowercase letters, numbers and hyphens");
const nullish = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();
/** The panel's forms send "" in empty fields (dates, slug). */
const emptyIsNothing = <T extends z.ZodTypeAny>(t: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), t.optional());

const categorySchema = z.object({
  name: z.string().min(1).max(255),
  slug: slug.optional(),
  description: nullish(z.string().max(5000)),
  icon: nullish(z.string().max(50)),
  color: nullish(z.string().regex(/^#[0-9a-fA-F]{6}$/)),
  parentId: nullish(uuid),
  metadataSchema: z.record(z.string(), z.unknown()).optional(),
  allowedRoles: z.array(z.string().min(1).max(50)).max(50).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});

const baseDocument = {
  title: z.string().min(1).max(500),
  slug: emptyIsNothing(slug),
  description: nullish(z.string().max(10_000)),
  type: z.enum(DOC_TYPES).optional(),
  categoryId: emptyIsNothing(uuid.nullable()),
  tags: z.array(z.string().max(100)).max(100).optional(),
  ownerId: userIdValue.optional(),
  reviewerIds: ids.optional(),
  approverIds: ids.optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  allowedUserIds: ids.optional(),
  allowedRoleIds: z.array(z.string().min(1).max(50)).max(50).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  effectiveDate: emptyIsNothing(date.nullable()),
  reviewDueDate: emptyIsNothing(date.nullable()),
  expirationDate: emptyIsNothing(date.nullable()),
  requiresAcknowledgment: z.boolean().optional(),
};

const createDocumentSchema = z.object({
  ...baseDocument,
  code: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
  isTemplate: z.boolean().optional(),
  content: z.string().max(2_000_000).optional(),
  contentFormat: z.enum(["markdown", "html", "raw"]).optional(),
  changelog: z.string().max(5000).optional(),
});

const patchDocumentSchema = z.object({
  ...baseDocument,
  title: baseDocument.title.optional(),
  status: z.enum(DOC_STATUSES).optional(),
});

/** Fields that change WHO can do what: only the owner (or admin). */
const ACL_FIELDS = [
  "ownerId",
  // The folder also decides who reads (the category's `allowedRoles`): an
  // author who was not the owner opened a restricted document to any account
  // by moving it to another folder (an earlier audit).
  "categoryId",
  "reviewerIds",
  "approverIds",
  "visibility",
  "allowedUserIds",
  "allowedRoleIds",
] as const;

const versionSchema = z.object({
  changeType: z.enum(["major", "minor", "patch"]).optional(),
  changelog: z.string().min(1).max(5000),
  content: z.string().max(2_000_000).optional(),
  contentFormat: z.enum(["markdown", "html", "raw"]).optional(),
});

const patchVersionSchema = z.object({
  content: z.string().max(2_000_000).optional(),
  contentFormat: z.enum(["markdown", "html", "raw"]).optional(),
  changelog: z.string().min(1).max(5000).optional(),
});

const revisionSchema = z.object({
  decision: z.enum(["approved", "changes_requested"]),
  notes: nullish(z.string().max(5000)),
});

const relationSchema = z.object({
  targetDocumentId: uuid,
  relationType: z.enum(["related", "replaces", "requires", "supersedes"]),
  description: nullish(z.string().max(2000)),
});

const ackSchema = z.object({ notes: nullish(z.string().max(2000)) });

const commentSchema = z.object({
  content: z.string().min(1).max(20_000),
  versionId: nullish(uuid),
  parentId: nullish(uuid),
});

const patchCommentSchema = z.object({ content: z.string().min(1).max(20_000) });

const diagramSchema = z.object({
  name: z.string().min(1).max(255),
  sourceXml: nullish(z.string().max(2_000_000)),
  sourceJson: nullish(z.string().max(2_000_000)),
  renderedSvg: nullish(z.string().max(2_000_000)),
  mediaId: nullish(uuid),
});

const importSchema = z.object({
  manifest: z.record(z.string(), z.unknown()),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(600),
        content: z.string().max(2_000_000),
        contentType: z.string().max(100).optional(),
      })
    )
    .max(1000),
});

// ═══════════════════════════════════════════════════════════════════════════
// Files: size, types and name
// ═══════════════════════════════════════════════════════════════════════════

const MAX_FILE = 25 * 1024 * 1024;

/**
 * Accepted types. Nothing a browser executes (HTML, SVG, XML, JS): the
 * store serves objects from the API origin with the stored type,
 * so an uploaded `text/html` would be a stored XSS.
 */
const FILE_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/zip",
  "text/plain",
  "text/csv",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Name for DISPLAY: no paths or control characters. It never goes into the key. */
function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const clean = [...base]
    .filter((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127)
    .join("")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200);
  return clean || "file";
}

/** An SVG with anything executable is rejected (no attempt is made to "clean" it). */
function dangerousSvg(svg: string): boolean {
  return /<\s*script|\bon[a-z]+\s*=|javascript:|<\s*foreignObject|<\s*iframe|<\s*embed|<\s*object|<\s*(?:image|use)\b[^>]*href\s*=\s*["']?\s*(?:data:|https?:|\/\/)/i.test(
    svg
  );
}

/**
 * Content in HTML format with anything executable: rejected on save. The
 * panel draws `/render` content with `{@html}` unsanitized, so a
 * `<script>` or an `onerror=` in a document would run in the session of
 * whoever opens it (admin included). It does not apply to markdown: technical
 * manuals quote `<script>` in code blocks with full legitimacy — there
 * sanitizing is up to whoever draws it (see report).
 */
function requireSafeHtml(content: string | undefined | null, formatValue: string | undefined | null) {
  if (formatValue === "html" && content && dangerousSvg(content)) {
    throw AppError.validation("The HTML content contains executable code", { field: "content" });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Removes from the file what the client does not need to know: where it lives. */
function publicFile<
  T extends { storagePath?: unknown; publicUrl?: unknown; storageBucket?: unknown },
>(f: T) {
  const { storagePath: _p, publicUrl: _u, storageBucket: _b, ...rest } = f;
  return rest;
}

/**
 * Before reading an upload (`before` of `upload-file`). The SDK reads the
 * WHOLE form to validate it before the handler; the usual handler
 * cut off by `content-length` BEFORE reading it. This way a body over 25 MB is still
 * not read into memory (same response: 400 "File too large",
 * now before looking at the version). And a broken multipart form
 * was a 500 (`formData()` threw a TypeError): now it is the 422 of "No file
 * provided".
 */
const readableUpload: MiddlewareHandler = async (c, next) => {
  const long = Number(c.req.header("content-length") || 0);
  if (long > MAX_FILE + 64 * 1024) throw AppError.badRequest("File too large");
  try {
    await c.req.parseBody({ all: true });
  } catch {
    throw AppError.validation("No file provided");
  }
  await next();
};

// ═══════════════════════════════════════════════════════════════════════════
// Declaration schemas (parameters, query and outputs)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Path ids are declared as text: the handler answers 404 to one that
 * is not a uuid (`isUuid`), so the contract is "uuid, or 404", not a 422.
 */
const idOf = (that: string) => z.string().describe(`${that} (uuid; anything else is a 404)`);
const DocumentParam = z.object({ id: idOf("Document id") });
const TemplateParam = z.object({ templateId: idOf("Template document id") });
const ParamVersion = z.object({ versionId: idOf("Version id") });
const FileParam = z.object({ fileId: idOf("File id") });
const CommentParam = z.object({ commentId: idOf("Comment id") });
const DiagramParam = z.object({ diagramId: idOf("Diagram id") });
const FolderParam = z.object({ id: idOf("Folder (category) id") });
const NoticeParam = z.object({ id: idOf("Notification id") });
const ParamSlug = z.object({ slug: z.string().describe("Document slug (an old slug redirects)") });
const CodeParam = z.object({ code: z.string().describe("Document code") });

/** Free-text query: whatever is not declared is ignored, as always. */
const queryValue = <S extends z.ZodRawShape>(shape: S) => z.object(shape).passthrough();
const textValue = (that: string) => z.string().optional().describe(that);

/** The upload: the `file` field. Lax: what is missing or extra is reported by the handler (422). */
const Upload = z
  .object({ file: z.unknown().describe("The file, in the multipart field `file`") })
  .passthrough()
  .optional();

/** A database row: it carries `id`, and the rest as is. */
const Row = z.object({ id: z.string() }).passthrough();
const List = z.object({ docs: z.array(Row) });
const PaginatedList = z.object({
  docs: z.array(Row),
  pagination: z.object({
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
  }),
});
const Success = z.object({ success: z.literal(true) });
const Confirmation = z.union([Row, z.object({ alreadyAcknowledged: z.literal(true) })]);
const Export = z.object({
  manifest: z.object({ format: z.string(), documentCount: z.number() }).passthrough(),
  files: z.array(z.object({ path: z.string(), content: z.string(), contentType: z.string() })),
});
const ImportResult = z.object({
  success: z.literal(true),
  results: z.object({
    categoriesCreated: z.number(),
    documentsCreated: z.number(),
    versionsCreated: z.number(),
    errors: z.array(z.string()),
  }),
});
const Read = z
  .object({
    document: Row,
    content: z.string(),
    toc: z.array(z.object({ id: z.string(), text: z.string(), level: z.number() })),
  })
  .passthrough();
const Stats = z
  .object({
    documents: z.record(z.string(), z.unknown()),
    versions: z.record(z.string(), z.unknown()),
    byType: z.array(z.record(z.string(), z.unknown())),
    upcomingReviews: z.array(Row),
    pendingApprovals: z.number(),
  })
  .passthrough();
const Search = z.object({
  documents: z.array(Row),
  categories: z.array(Row),
  total: z.number(),
  searchType: z.enum(["fulltext", "fallback"]),
});

// ═══════════════════════════════════════════════════════════════════════════
// Operations
// ═══════════════════════════════════════════════════════════════════════════

type DocAction = "view" | "viewDrafts" | "edit" | "manage" | "review" | "publish";

/**
 * The kon's operations, in the order in which the routes were registered (the
 * same resolution order as before). Each handler is the usual one; what
 * used to be middlewares (`requireAuth`, `validateRequest`) is its declaration.
 */
export function dmsOperations(ctx: KonContext): AnyOperation[] {
  registerDmsPolicy();
  const app = registry();
  const { storage } = ctx;
  // The request's RLS transaction is opened by the host; `ctx.db.instance`
  // resolves to it inside each route (before: its own `rls-context.ts`).
  const dbInstance = ctx.db.instance as DmsDb;
  /** As system inside the request's transaction (see KonDatabase). */
  const asSystem = ctx.db.asSystem ?? (<T>(fn: () => Promise<T>) => fn());

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function user(c: Context): DmsUser {
    const u = c.get("user" as never) as DmsUser | null | undefined;
    if (!u?.id) throw AppError.unauthenticated();
    return { id: String(u.id), role: u.role, scopes: u.scopes };
  }

  function generateDocumentCode(type: string): string {
    const prefix = type.substring(0, 3).toUpperCase();
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = randomUUID().slice(0, 4).toUpperCase();
    return `${prefix}-${timestamp}${random}`;
  }

  function slugOf(textValue: string): string {
    return (
      textValue
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .substring(0, 100) || "document"
    );
  }

  function incrementVersion(version: string, changeType: "major" | "minor" | "patch"): string {
    const [major, minor, patch] = version.split(".").map((n) => Number(n) || 0);
    if (changeType === "major") return `${major + 1}.0.0`;
    if (changeType === "minor") return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
  }

  async function logAction(
    action: string,
    resourceType: string,
    resourceId: string | undefined,
    userId: string,
    details?: Record<string, unknown>,
    documentId?: string
  ) {
    // No try/catch: inside the request's transaction a failure here
    // leaves it aborted, and swallowing it would make the NEXT query fail with
    // an error that has nothing to do with it.
    await dbInstance.insert(dmsAccessLog).values({
      action,
      resourceType,
      resourceId,
      documentId,
      userId,
      details: details || {},
    });
  }

  async function folderRoles(categoryId: string | null): Promise<string[]> {
    if (!categoryId) return [];
    const [cat] = await dbInstance
      .select({ allowedRoles: dmsCategories.allowedRoles })
      .from(dmsCategories)
      .where(eq(dmsCategories.id, categoryId))
      .limit(1);
    return Array.isArray(cat?.allowedRoles) ? (cat!.allowedRoles as string[]) : [];
  }

  async function resourceOf(doc: DocAcl & { categoryId: string | null }): Promise<DocumentResource> {
    return { doc, folderRoles: await folderRoles(doc.categoryId) };
  }

  async function canValue(u: DmsUser, actionValue: DocAction, resource: DocumentResource) {
    return can(u as AuthzUser, actionValue, resource, "dms_document");
  }

  /** Effective permissions (for decisions that are not a route's yes/no). */
  async function permissionsOf(u: DmsUser, resource: DocumentResource): Promise<Permissions> {
    const p = permissions(resource.doc, u, resource.folderRoles);
    // Agent scopes widen what `can()` grants.
    for (const actionValue of Object.keys(p) as (keyof Permissions)[]) {
      if (!p[actionValue]) p[actionValue] = await canValue(u, actionValue, resource);
    }
    return p;
  }

  /**
   * Loads a document and requires the action. 404 if they cannot see it (it is not
   * confirmed that it exists); 403 if they see it but it is not theirs to do.
   */
  async function documentFor(c: Context, id: string | undefined, actionValue: DocAction) {
    const u = user(c);
    if (!id || !isUuid(id)) throw AppError.notFound("Document not found");
    const [doc] = await dbInstance
      .select()
      .from(dmsDocuments)
      .where(eq(dmsDocuments.id, id))
      .limit(1);
    if (!doc) throw AppError.notFound("Document not found");
    const resource = await resourceOf(doc);
    if (!(await canValue(u, "view", resource))) throw AppError.notFound("Document not found");
    if (actionValue !== "view" && !(await canValue(u, actionValue, resource))) {
      throw AppError.forbidden("You do not have permission for this on this document");
    }
    return { doc, resource, p: await permissionsOf(u, resource) };
  }

  /** Version + its document. A version you cannot see does not exist (404). */
  async function versionFor(c: Context, versionId: string | undefined, actionValue: DocAction) {
    if (!versionId || !isUuid(versionId)) throw AppError.notFound("Version not found");
    const [version] = await dbInstance
      .select()
      .from(dmsDocumentVersions)
      .where(eq(dmsDocumentVersions.id, versionId))
      .limit(1);
    if (!version) throw AppError.notFound("Version not found");
    let r: Awaited<ReturnType<typeof documentFor>>;
    try {
      r = await documentFor(c, version.documentId, "view");
    } catch (e) {
      if ((e as { status?: number }).status === 404) throw AppError.notFound("Version not found");
      throw e;
    }
    if (!canViewVersion(r.p, version)) throw AppError.notFound("Version not found");
    if (actionValue !== "view" && !r.p[actionValue]) {
      throw AppError.forbidden("You do not have permission for this on this document");
    }
    return { version, ...r };
  }

  /** Versions that can be MODIFIED: those not yet published or rejected. */
  function requireEditable(version: DmsDocumentVersion) {
    if (!["draft", "changes_requested"].includes(version.status)) {
      throw AppError.conflict("Only a draft version or one with requested changes can be modified");
    }
  }

  async function createWorkflowNotification(
    c: Context,
    documentId: string,
    versionId: string | null,
    userIds: string[],
    type: string,
    message: string
  ) {
    const unique = [...new Set(userIds.filter((x) => typeof x === "string" && x))];
    if (!unique.length) return;
    // The row belongs to the RECIPIENT, not to whoever writes: personal RLS would not
    // let it be inserted. It is done as system, with the action already authorized.
    await asSystem(() =>
      dbInstance
        .insert(dmsWorkflowNotifications)
        .values(unique.map((uid) => ({ documentId, versionId, userId: uid, type, message })))
    );
  }

  async function countView(c: Context, documentId: string, userId: string) {
    const [recentView] = await dbInstance
      .select({ id: dmsAccessLog.id })
      .from(dmsAccessLog)
      .where(
        and(
          eq(dmsAccessLog.documentId, documentId),
          eq(dmsAccessLog.userId, userId),
          eq(dmsAccessLog.action, "view"),
          gte(dmsAccessLog.createdAt, sql`NOW() - INTERVAL '5 minutes'`)
        )
      )
      .limit(1);
    if (recentView) return;
    // A reader cannot edit the document (RLS): the counter is raised by the system.
    await asSystem(() =>
      dbInstance
        .update(dmsDocuments)
        .set({ viewCount: sql`${dmsDocuments.viewCount} + 1` })
        .where(eq(dmsDocuments.id, documentId))
    );
    await logAction("view", "document", documentId, userId, {}, documentId);
  }

  async function validateWikiLinks(u: DmsUser, content: string | null | undefined) {
    if (!content) return [];
    const matches = content.match(/\[\[(.*?)\]\]/g);
    if (!matches) return [];
    const targets = [...new Set(matches.map((m) => m.slice(2, -2).trim()))].slice(0, 100);
    const read = readFilter(u);
    const warnings = [];
    for (const target of targets) {
      // Only what the user can see "exists": otherwise this would be an
      // oracle for discovering codes and slugs of other people's documents.
      const conditionsValue = [
        eq(dmsDocuments.isActive, true),
        or(eq(dmsDocuments.code, target), eq(dmsDocuments.slug, target)),
      ];
      if (read) conditionsValue.push(read);
      const [found] = await dbInstance
        .select({ id: dmsDocuments.id })
        .from(dmsDocuments)
        .where(and(...conditionsValue))
        .limit(1);
      warnings.push({ target, exists: !!found });
    }
    return warnings;
  }

  function computeRequiresReview(doc: { reviewDueDate: Date | null; expirationDate: Date | null }) {
    const now = new Date();
    return Boolean(
      (doc.reviewDueDate && new Date(doc.reviewDueDate) < now) ||
      (doc.expirationDate && new Date(doc.expirationDate) < now)
    );
  }

  function titleId(text: string, i: number) {
    return (
      text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || `section-${i}`
    );
  }

  function generateToc(content: string | null, format: string = "markdown") {
    if (!content) return [];
    const toc: { id: string; text: string; level: number }[] = [];
    if (format === "html") {
      const headerRegex = /<h([1-6])[^>]*>(.*?)<\/h\1>/gi;
      let match;
      while ((match = headerRegex.exec(content)) !== null) {
        const text = match[2].replace(/<[^>]+>/g, "").trim();
        toc.push({ id: titleId(text, toc.length), text, level: parseInt(match[1]) });
      }
    } else {
      for (const line of content.split("\n")) {
        const match = line.match(/^(#{1,6})\s+(.+)$/);
        if (match) {
          const text = match[2].trim();
          toc.push({ id: titleId(text, toc.length), text, level: match[1].length });
        }
      }
    }
    return toc;
  }

  function injectHeaderIds(content: string): string {
    let counter = 0;
    return content.replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gi, (_m, level, text) => {
      const plain = String(text)
        .replace(/<[^>]+>/g, "")
        .trim();
      return `<h${level} id="${titleId(plain, counter++)}">${text}</h${level}>`;
    });
  }

  async function buildBreadcrumb(categoryId: string | null) {
    const breadcrumb: { id: string; name: string; slug: string }[] = [];
    let currentId = categoryId;
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const [cat] = await dbInstance
        .select({
          id: dmsCategories.id,
          name: dmsCategories.name,
          slug: dmsCategories.slug,
          parentId: dmsCategories.parentId,
        })
        .from(dmsCategories)
        .where(eq(dmsCategories.id, currentId))
        .limit(1);
      if (!cat) break;
      breadcrumb.unshift({ id: cat.id, name: cat.name, slug: cat.slug });
      currentId = cat.parentId;
    }
    return breadcrumb;
  }

  async function injectDiagrams(content: string | null, versionId: string): Promise<string> {
    if (!content) return "";
    const diagramRegex = /\[\[diagram:(.*?)\]\]/g;
    const ids = [...content.matchAll(diagramRegex)].map((m) => m[1]).filter((x) => isUuid(x));
    if (!ids.length) return content;
    const diagrams = await dbInstance
      .select()
      .from(dmsDocumentDiagrams)
      .where(
        and(inArray(dmsDocumentDiagrams.id, ids), eq(dmsDocumentDiagrams.versionId, versionId))
      );
    const map = new Map(diagrams.map((d) => [d.id, d]));
    return content.replace(diagramRegex, (_match, id: string) => {
      const diagram = map.get(id);
      if (!diagram) return "<!-- diagram not found -->";
      // Dangerous SVGs are rejected on save; this covers the old ones.
      if (diagram.renderedSvg && !dangerousSvg(diagram.renderedSvg)) return diagram.renderedSvg;
      if (diagram.mediaId && isUuid(diagram.mediaId)) {
        return `<img src="/api/media/${diagram.mediaId}" alt="${escapeHtml(diagram.name)}" />`;
      }
      return `<!-- diagram: ${escapeHtml(diagram.name).replace(/--/g, "")} -->`;
    });
  }

  /** Visible category ids: the team sees all; the rest, their role or what contains something of theirs. */
  async function visibleCategories(u: DmsUser): Promise<Set<string> | null> {
    if (isAdmin(u) || u.role === "editor") return null; // null = all
    const allValue = await dbInstance
      .select({
        id: dmsCategories.id,
        parentId: dmsCategories.parentId,
        allowedRoles: dmsCategories.allowedRoles,
      })
      .from(dmsCategories)
      .where(eq(dmsCategories.isActive, true));
    const read = readFilter(u);
    const withDocs = await dbInstance
      .selectDistinct({ categoryId: dmsDocuments.categoryId })
      .from(dmsDocuments)
      .where(and(eq(dmsDocuments.isActive, true), read));
    const visible = new Set<string>();
    const byId = new Map(allValue.map((c) => [c.id, c]));
    const withAncestors = (id: string | null) => {
      let actual = id;
      const seen = new Set<string>();
      while (actual && !seen.has(actual)) {
        seen.add(actual);
        visible.add(actual);
        actual = byId.get(actual)?.parentId ?? null;
      }
    };
    for (const cat of allValue) {
      if (
        Array.isArray(cat.allowedRoles) &&
        (cat.allowedRoles as string[]).includes(u.role ?? "")
      ) {
        withAncestors(cat.id);
      }
    }
    for (const row of withDocs) withAncestors(row.categoryId);
    return visible;
  }

  // The old `router.use("/*", auth.requireAuth)` is now the declaration of
  // each operation: `access: "session"` and `permission: ANY_ACCOUNT`
  // (operations.ts), checked before validating the body, as then.

  // ═══════════════════════════════════════════════════════════════════════════
  // CATEGORIES (folders)
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    "/categories",
    {
      id: "list-folders",
      summary: "List document folders",
      description:
        "Active folders (categories) the caller can see, ordered by sortOrder and name. The team (admin/editor) sees every folder; any other account sees the folders opened to its role and those holding a document it can read. `parentId` filters by parent (`null` = top level; a value that is not a uuid gives an empty list); `stats=true` adds `documentCount` (published documents the caller can read).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: {
        query: queryValue({
          parentId: textValue("Parent folder uuid, or `null` for top-level folders"),
          stats: textValue("`true` adds documentCount to each folder"),
        }),
      },
      output: { schema: List },
    },
    async (c) => {
      const u = user(c);
      const parentId = c.req.query("parentId");
      const withStats = c.req.query("stats") === "true";

      const conditionsValue: SQL[] = [eq(dmsCategories.isActive, true)];
      if (parentId) {
        if (parentId === "null") conditionsValue.push(isNull(dmsCategories.parentId));
        else if (isUuid(parentId)) conditionsValue.push(eq(dmsCategories.parentId, parentId));
        else return c.json({ docs: [] });
      }
      const visible = await visibleCategories(u);
      let categories = await dbInstance
        .select()
        .from(dmsCategories)
        .where(and(...conditionsValue))
        .orderBy(asc(dmsCategories.sortOrder), asc(dmsCategories.name));
      if (visible) categories = categories.filter((cat) => visible.has(cat.id));

      if (withStats && categories.length > 0) {
        const read = readFilter(u);
        const docCounts = await dbInstance
          .select({ categoryId: dmsDocuments.categoryId, count: sql<number>`count(*)::int` })
          .from(dmsDocuments)
          .where(
            and(
              inArray(
                dmsDocuments.categoryId,
                categories.map((cat) => cat.id)
              ),
              eq(dmsDocuments.isActive, true),
              eq(dmsDocuments.status, "published"),
              read
            )
          )
          .groupBy(dmsDocuments.categoryId);
        const countMap = new Map(docCounts.map((x) => [x.categoryId, x.count]));
        return c.json({
          docs: categories.map((cat) => ({ ...cat, documentCount: countMap.get(cat.id) || 0 })),
        });
      }
      return c.json({ docs: categories });
    }
  );

  app.post(
    "/categories",
    {
      id: "create-folder",
      summary: "Create a document folder",
      description:
        "Creates a folder (category). Admin only (403 otherwise): folders carry an ACL, `allowedRoles` = roles that may read the documents inside. `slug` defaults from the name; `parentId` must exist (422). Returns the folder (201); 409 when the slug is taken.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: categorySchema },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const u = user(c);
      if (!(await can(u as AuthzUser, "dms:folders"))) {
        throw AppError.forbidden("Only an admin creates folders (they carry permissions)");
      }
      const body = input.body as z.infer<typeof categorySchema>;
      const slugFinal = body.slug || slugOf(body.name);

      let level = 0;
      let path = slugFinal;
      if (body.parentId) {
        const [parent] = await dbInstance
          .select({ level: dmsCategories.level, path: dmsCategories.path })
          .from(dmsCategories)
          .where(eq(dmsCategories.id, body.parentId))
          .limit(1);
        if (!parent) throw AppError.validation("parentId does not exist", { field: "parentId" });
        level = parent.level + 1;
        path = `${parent.path}/${slugFinal}`;
      }

      const [category] = await dbInstance
        .insert(dmsCategories)
        .values({
          name: body.name,
          slug: slugFinal,
          description: body.description ?? null,
          icon: body.icon ?? undefined,
          color: body.color ?? undefined,
          parentId: body.parentId ?? null,
          level,
          path,
          metadataSchema: body.metadataSchema || {},
          allowedRoles: body.allowedRoles || [],
          sortOrder: body.sortOrder || 0,
          createdById: u.id,
        })
        .returning();

      await logAction("create", "category", category.id, u.id, { name: category.name });
      return c.json(category, 201);
    }
  );

  app.get(
    "/categories/tree",
    {
      id: "get-folder-tree",
      summary: "Folder tree",
      description:
        "The folders the caller can see as a tree (`docs`: top-level folders, each with `children`). A folder whose parent the caller cannot see hangs from the top level.",
      access: "session",
      permission: ANY_ACCOUNT,
      output: { schema: List },
    },
    async (c) => {
      const u = user(c);
      const visible = await visibleCategories(u);
      let all = await dbInstance
        .select()
        .from(dmsCategories)
        .where(eq(dmsCategories.isActive, true))
        .orderBy(asc(dmsCategories.sortOrder), asc(dmsCategories.name));
      if (visible) all = all.filter((cat) => visible.has(cat.id));

      type TreeNode = (typeof all)[number] & { children: TreeNode[] };
      const buildTree = (parentId: string | null, depth = 0): TreeNode[] =>
        depth > 50
          ? []
          : all
              .filter((cat) => cat.parentId === parentId)
              .map((cat) => ({ ...cat, children: buildTree(cat.id, depth + 1) }));
      // A folder whose parent you cannot see hangs from the root (it is not lost).
      const ids = new Set(all.map((x) => x.id));
      const roots = all.filter((x) => !x.parentId || !ids.has(x.parentId)).map((x) => x.id);
      const docs = all
        .filter((x) => roots.includes(x.id))
        .map((cat) => ({ ...cat, children: buildTree(cat.id) }));
      return c.json({ docs });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // DOCUMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    "/documents",
    {
      id: "list-documents",
      summary: "List documents",
      description:
        "Active documents the caller can read (owner, author, reviewer, approver, shared by user/role/folder, or published public/internal), newest update first, paginated (`limit` 1-100, default 50; `page`). Filters: `categoryId`, `status`, `type`, `ownerId`, `tags` (comma-separated, all required) and `search` (title, code, description). Each row adds `requiresReview` and `categoryName`. Metadata only: the content is in the versions.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: {
        query: queryValue({
          limit: textValue("1-100, default 50"),
          page: textValue("Page number, from 1"),
          categoryId: textValue("Folder uuid"),
          status: textValue("draft | in_review | approved | published | archived | deprecated"),
          type: textValue("manual | policy | procedure | template | guide | training | report | other"),
          ownerId: textValue("Owner user id"),
          tags: textValue("Comma-separated tags; the document must have all of them"),
          search: textValue("Text in title, code or description"),
        }),
      },
      output: { schema: PaginatedList },
    },
    async (c) => {
      const u = user(c);
      const query = c.req.query();
      const limit = Math.min(Math.max(parseInt(query.limit || "50", 10) || 50, 1), 100);
      const page = Math.max(parseInt(query.page || "1", 10) || 1, 1);
      const offset = (page - 1) * limit;

      const conditions: SQL[] = [eq(dmsDocuments.isActive, true)];
      const read = readFilter(u);
      if (read) conditions.push(read);

      if (query.categoryId && isUuid(query.categoryId)) {
        conditions.push(eq(dmsDocuments.categoryId, query.categoryId));
      }
      const est = docStatus(query.status);
      if (est) conditions.push(eq(dmsDocuments.status, est));
      const tip = docType(query.type);
      if (tip) conditions.push(eq(dmsDocuments.type, tip));
      if (query.ownerId) conditions.push(eq(dmsDocuments.ownerId, query.ownerId));
      if (query.tags) {
        const tags = query.tags.split(",").slice(0, 20);
        conditions.push(sql`${dmsDocuments.tags} @> ${JSON.stringify(tags)}::jsonb`);
      }
      if (query.search) {
        const searchTerm = `%${query.search.toLowerCase().slice(0, 200)}%`;
        const search = or(
          like(sql`LOWER(${dmsDocuments.title})`, searchTerm),
          like(sql`LOWER(${dmsDocuments.code})`, searchTerm),
          like(sql`LOWER(${dmsDocuments.description})`, searchTerm)
        );
        if (search) conditions.push(search);
      }

      const [countResult] = await dbInstance
        .select({ count: sql<number>`count(*)::int` })
        .from(dmsDocuments)
        .where(and(...conditions));
      const total = countResult?.count || 0;

      const docs = await dbInstance
        .select({
          id: dmsDocuments.id,
          code: dmsDocuments.code,
          title: dmsDocuments.title,
          slug: dmsDocuments.slug,
          description: dmsDocuments.description,
          type: dmsDocuments.type,
          status: dmsDocuments.status,
          categoryId: dmsDocuments.categoryId,
          tags: dmsDocuments.tags,
          currentVersionNumber: dmsDocuments.currentVersionNumber,
          ownerId: dmsDocuments.ownerId,
          departmentId: dmsDocuments.departmentId,
          visibility: dmsDocuments.visibility,
          versionCount: dmsDocuments.versionCount,
          viewCount: dmsDocuments.viewCount,
          createdAt: dmsDocuments.createdAt,
          updatedAt: dmsDocuments.updatedAt,
          publishedAt: dmsDocuments.publishedAt,
          effectiveDate: dmsDocuments.effectiveDate,
          reviewDueDate: dmsDocuments.reviewDueDate,
          expirationDate: dmsDocuments.expirationDate,
        })
        .from(dmsDocuments)
        .where(and(...conditions))
        .orderBy(desc(dmsDocuments.updatedAt))
        .limit(limit)
        .offset(offset);

      const categoryIds = [...new Set(docs.map((d) => d.categoryId).filter(Boolean))] as string[];
      const categories = categoryIds.length
        ? await dbInstance
            .select({ id: dmsCategories.id, name: dmsCategories.name })
            .from(dmsCategories)
            .where(inArray(dmsCategories.id, categoryIds))
        : [];
      const categoryMap = new Map(categories.map((x) => [x.id, x.name]));

      return c.json({
        docs: docs.map((d) => ({
          ...d,
          requiresReview: computeRequiresReview(d),
          categoryName: d.categoryId ? categoryMap.get(d.categoryId) : null,
        })),
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
      });
    }
  );

  app.post(
    "/documents",
    {
      id: "create-document",
      summary: "Create a document",
      description:
        "Creates a document (metadata and ACL); with `content` or `changelog` also its first draft version 1.0.0. Team only (admin/editor; 403 otherwise). The owner is the caller (only an admin may set another `ownerId`); `visibility` defaults to `restricted`. HTML content with executable code is refused (422). Returns the document (201); 409 when `code` is taken.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: createDocumentSchema },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const u = user(c);
      if (!(await can(u as AuthzUser, "dms:create"))) {
        throw AppError.forbidden("Only the team creates documents");
      }
      const body = input.body as z.infer<typeof createDocumentSchema>;
      requireSafeHtml(body.content, body.contentFormat);
      if (body.ownerId && body.ownerId !== u.id && !isAdmin(u)) {
        throw AppError.forbidden("Only an admin creates documents in another's name");
      }
      if (body.categoryId) {
        const [cat] = await dbInstance
          .select({ id: dmsCategories.id })
          .from(dmsCategories)
          .where(eq(dmsCategories.id, body.categoryId))
          .limit(1);
        if (!cat) throw AppError.validation("categoryId does not exist", { field: "categoryId" });
      }

      const code = body.code || generateDocumentCode(body.type || "manual");
      const [existing] = await dbInstance
        .select({ id: dmsDocuments.id })
        .from(dmsDocuments)
        .where(eq(dmsDocuments.code, code))
        .limit(1);
      if (existing) throw AppError.conflict("Document code already exists");

      const [document] = await dbInstance
        .insert(dmsDocuments)
        .values({
          code,
          title: body.title,
          slug: body.slug || slugOf(body.title),
          description: body.description ?? null,
          type: body.type || "manual",
          categoryId: body.categoryId ?? null,
          tags: body.tags || [],
          ownerId: body.ownerId || u.id,
          reviewerIds: body.reviewerIds || [],
          approverIds: body.approverIds || [],
          visibility: body.visibility || "restricted",
          allowedUserIds: body.allowedUserIds || [],
          allowedRoleIds: body.allowedRoleIds || [],
          metadata: body.metadata || {},
          effectiveDate: body.effectiveDate ? new Date(body.effectiveDate) : null,
          reviewDueDate: body.reviewDueDate ? new Date(body.reviewDueDate) : null,
          expirationDate: body.expirationDate ? new Date(body.expirationDate) : null,
          requiresAcknowledgment: body.requiresAcknowledgment || false,
          isTemplate: body.isTemplate || false,
          createdById: u.id,
        })
        .returning();

      await logAction(
        "create",
        "document",
        document.id,
        u.id,
        { title: document.title },
        document.id
      );

      if (body.content || body.changelog) {
        await dbInstance.insert(dmsDocumentVersions).values({
          documentId: document.id,
          versionNumber: "1.0.0",
          changeType: "minor",
          content: body.content || "",
          contentFormat: body.contentFormat || "markdown",
          changelog: body.changelog || "Initial version",
          status: "draft",
          createdById: u.id,
        });
        await dbInstance
          .update(dmsDocuments)
          .set({ versionCount: 1, nextVersionNumber: "1.0.1" })
          .where(eq(dmsDocuments.id, document.id));
      }

      return c.json(document, 201);
    }
  );

  app.get(
    "/documents/:id",
    {
      id: "get-document",
      summary: "Get a document",
      description:
        "A document the caller can read, with `requiresReview` and its `category`. `versions=true` adds its versions (readers: only published ones) and `currentVersion`; `relations=true` adds the relations to documents the caller can read. Readers do not get the ACL fields. Counts a view. 404 when it does not exist or the caller cannot read it.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: {
        params: DocumentParam,
        query: queryValue({
          versions: textValue("`true` adds the versions"),
          relations: textValue("`true` adds the relations"),
        }),
      },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const u = user(c);
      const { doc, p } = await documentFor(c, c.req.param("id"), "view");
      const includeVersions = c.req.query("versions") === "true";
      const includeRelations = c.req.query("relations") === "true";

      await countView(c, doc.id, u.id);

      const result: Record<string, unknown> = {
        ...doc,
        requiresReview: computeRequiresReview(doc),
      };
      // A reader is not shown the full ACL (who else it is shared with).
      if (!p.edit) {
        for (const field of [
          "allowedUserIds",
          "allowedRoleIds",
          "reviewerIds",
          "approverIds",
          "metadata",
        ]) {
          delete result[field];
        }
      }

      if (doc.categoryId) {
        const [category] = await dbInstance
          .select({ id: dmsCategories.id, name: dmsCategories.name, slug: dmsCategories.slug })
          .from(dmsCategories)
          .where(eq(dmsCategories.id, doc.categoryId))
          .limit(1);
        result.category = category;
      }

      if (includeVersions) {
        const conditionsValue: SQL[] = [eq(dmsDocumentVersions.documentId, doc.id)];
        if (!p.viewDrafts) conditionsValue.push(eq(dmsDocumentVersions.status, "published"));
        const versions = await dbInstance
          .select({
            id: dmsDocumentVersions.id,
            versionNumber: dmsDocumentVersions.versionNumber,
            changeType: dmsDocumentVersions.changeType,
            status: dmsDocumentVersions.status,
            changelog: dmsDocumentVersions.changelog,
            content: dmsDocumentVersions.content,
            contentFormat: dmsDocumentVersions.contentFormat,
            createdAt: dmsDocumentVersions.createdAt,
            createdById: dmsDocumentVersions.createdById,
            approvedById: dmsDocumentVersions.approvedById,
            approvedAt: dmsDocumentVersions.approvedAt,
            publishedAt: dmsDocumentVersions.publishedAt,
            isLatest: dmsDocumentVersions.isLatest,
            fileCount: dmsDocumentVersions.fileCount,
          })
          .from(dmsDocumentVersions)
          .where(and(...conditionsValue))
          .orderBy(desc(dmsDocumentVersions.createdAt));
        result.versions = versions;
        result.currentVersion = versions.find((v) => v.isLatest) || versions[0] || null;
      }

      if (includeRelations) {
        // Only relations to documents they can also see.
        const read = readFilter(u);
        const relations = await dbInstance
          .select({
            id: dmsDocumentRelations.id,
            sourceDocumentId: dmsDocumentRelations.sourceDocumentId,
            targetDocumentId: dmsDocumentRelations.targetDocumentId,
            relationType: dmsDocumentRelations.relationType,
            description: dmsDocumentRelations.description,
            createdAt: dmsDocumentRelations.createdAt,
          })
          .from(dmsDocumentRelations)
          .innerJoin(dmsDocuments, eq(dmsDocuments.id, dmsDocumentRelations.targetDocumentId))
          .where(and(eq(dmsDocumentRelations.sourceDocumentId, doc.id), read));
        result.relations = relations;
      }

      return c.json(result);
    }
  );

  app.patch(
    "/documents/:id",
    {
      id: "update-document",
      summary: "Update a document",
      description:
        "Updates a document's metadata. Owner or author; the ACL fields (owner, folder, reviewers, approvers, visibility, allowed users/roles) only the owner or an admin; `status` only an admin, or the owner to `archived`/`deprecated` (the workflow moves it otherwise). A new `slug` keeps the old one as a redirect. 404 when the caller cannot read it, 403 when it may read but not do this.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: DocumentParam, body: patchDocumentSchema },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const u = user(c);
      const { doc: existing, p } = await documentFor(c, c.req.param("id"), "edit");
      const body = input.body as z.infer<typeof patchDocumentSchema>;

      const changesAcl = ACL_FIELDS.some(
        (field) =>
          body[field] !== undefined &&
          JSON.stringify(body[field]) !==
            JSON.stringify((existing as Record<string, unknown>)[field])
      );
      if (changesAcl && !p.manage) {
        throw AppError.forbidden("Only the owner changes who can view or approve the document");
      }
      if (
        body.ownerId &&
        body.ownerId !== existing.ownerId &&
        !isAdmin(u) &&
        existing.ownerId !== u.id
      ) {
        throw AppError.forbidden("Only the owner transfers the document");
      }
      if (body.status !== undefined && body.status !== existing.status) {
        // The state is moved by the approval flow (submit/review/publish). The
        // owner can archive it or mark it obsolete; the rest, admin only.
        const allowed =
          isAdmin(u) || (p.manage && ["archived", "deprecated"].includes(body.status));
        if (!allowed) throw AppError.forbidden("The state changes with the approval flow");
      }

      const updates: Partial<typeof dmsDocuments.$inferInsert> = { updatedAt: new Date() };
      const copy = [
        "title",
        "description",
        "type",
        "categoryId",
        "tags",
        "metadata",
        "requiresAcknowledgment",
        "status",
        "slug",
        ...ACL_FIELDS,
      ] as const;
      for (const field of copy) {
        if (body[field] !== undefined) (updates as Record<string, unknown>)[field] = body[field];
      }
      for (const field of ["effectiveDate", "reviewDueDate", "expirationDate"] as const) {
        if (body[field] !== undefined) updates[field] = body[field] ? new Date(body[field]!) : null;
      }
      if (body.categoryId) {
        const [cat] = await dbInstance
          .select({ id: dmsCategories.id })
          .from(dmsCategories)
          .where(eq(dmsCategories.id, body.categoryId))
          .limit(1);
        if (!cat) throw AppError.validation("categoryId does not exist", { field: "categoryId" });
      }

      if (body.slug && body.slug !== existing.slug) {
        const [busy] = await dbInstance
          .select({ id: dmsDocumentSlugHistory.id })
          .from(dmsDocumentSlugHistory)
          .where(eq(dmsDocumentSlugHistory.oldSlug, existing.slug))
          .limit(1);
        if (!busy) {
          await dbInstance
            .insert(dmsDocumentSlugHistory)
            .values({ documentId: existing.id, oldSlug: existing.slug });
        }
      }

      const [updated] = await dbInstance
        .update(dmsDocuments)
        .set(updates)
        .where(eq(dmsDocuments.id, existing.id))
        .returning();

      await logAction(
        "update",
        "document",
        existing.id,
        u.id,
        { fields: Object.keys(updates) },
        existing.id
      );
      return c.json({ ...updated, requiresReview: computeRequiresReview(updated) });
    }
  );

  app.delete(
    "/documents/:id",
    {
      id: "archive-document",
      summary: "Archive a document",
      description:
        "Archives a document (soft delete: inactive and `archived`; nothing is erased). Owner or admin. 404 when the caller cannot read it, 403 when it may read but is not the owner.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: DocumentParam },
      output: { schema: Success },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const u = user(c);
      const { doc } = await documentFor(c, c.req.param("id"), "manage");
      await dbInstance
        .update(dmsDocuments)
        .set({ isActive: false, status: "archived", archivedAt: new Date() })
        .where(eq(dmsDocuments.id, doc.id));
      await logAction("delete", "document", doc.id, u.id, {}, doc.id);
      return c.json({ success: true });
    }
  );

  app.post(
    "/documents/from-template/:templateId",
    {
      id: "create-document-from-template",
      summary: "Create a document from a template",
      description:
        "Copies a template document (one with `isTemplate`) the caller can read into a new PRIVATE document owned by the caller, with a draft 1.0.0 cloned from the latest template version the caller can see. Team only (admin/editor). Returns the new document (201); 404 when the template does not exist, is not a template or cannot be read.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: TemplateParam },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const u = user(c);
      if (!(await can(u as AuthzUser, "dms:create"))) {
        throw AppError.forbidden("Only the team creates documents");
      }
      const { doc: template, p } = await documentFor(c, c.req.param("templateId"), "view");
      if (!template.isTemplate || !template.isActive) throw AppError.notFound("Template not found");

      const code = generateDocumentCode(template.type || "manual");
      const [newDoc] = await dbInstance
        .insert(dmsDocuments)
        .values({
          code,
          title: `${template.title} (Copy)`,
          slug: `${template.slug}-copy-${Date.now().toString(36)}`,
          description: template.description,
          type: template.type,
          categoryId: template.categoryId,
          tags: template.tags,
          // The copy belongs to whoever makes it, and starts PRIVATE: the template's
          // ACL belongs to the template, not to each document that comes out of it.
          ownerId: u.id,
          reviewerIds: [],
          approverIds: [],
          visibility: "private",
          allowedUserIds: [],
          allowedRoleIds: [],
          metadata: p.edit ? template.metadata || {} : {},
          effectiveDate: template.effectiveDate,
          reviewDueDate: template.reviewDueDate,
          expirationDate: template.expirationDate,
          requiresAcknowledgment: template.requiresAcknowledgment || false,
          isTemplate: false,
          createdById: u.id,
        })
        .returning();

      // The latest version that WHOEVER CLONES can see is cloned.
      const conditionsValue: SQL[] = [eq(dmsDocumentVersions.documentId, template.id)];
      if (!p.viewDrafts) conditionsValue.push(eq(dmsDocumentVersions.status, "published"));
      const [latestVersion] = await dbInstance
        .select()
        .from(dmsDocumentVersions)
        .where(and(...conditionsValue))
        .orderBy(desc(dmsDocumentVersions.createdAt))
        .limit(1);

      if (latestVersion) {
        await dbInstance.insert(dmsDocumentVersions).values({
          documentId: newDoc.id,
          versionNumber: "1.0.0",
          changeType: "minor",
          content: latestVersion.content,
          contentFormat: latestVersion.contentFormat,
          changelog: `Cloned from template ${template.code}`,
          status: "draft",
          createdById: u.id,
        });
        await dbInstance
          .update(dmsDocuments)
          .set({ versionCount: 1, nextVersionNumber: "1.0.1" })
          .where(eq(dmsDocuments.id, newDoc.id));
      }

      await logAction(
        "create_from_template",
        "document",
        newDoc.id,
        u.id,
        { templateId: template.id },
        newDoc.id
      );
      return c.json({ ...newDoc, requiresReview: computeRequiresReview(newDoc) }, 201);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // VERSIONS
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    "/documents/:id/versions",
    {
      id: "list-versions",
      summary: "List a document's versions",
      description:
        "The versions of a document, newest first, with their content. Readers only get published versions; owner, author, reviewers and approvers get drafts too. 404 when the caller cannot read the document.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: DocumentParam },
      output: { schema: List },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { doc, p } = await documentFor(c, c.req.param("id"), "view");
      const conditionsValue: SQL[] = [eq(dmsDocumentVersions.documentId, doc.id)];
      if (!p.viewDrafts) conditionsValue.push(eq(dmsDocumentVersions.status, "published"));
      const versions = await dbInstance
        .select()
        .from(dmsDocumentVersions)
        .where(and(...conditionsValue))
        .orderBy(desc(dmsDocumentVersions.createdAt));
      return c.json({ docs: versions });
    }
  );

  app.post(
    "/documents/:id/versions",
    {
      id: "create-version",
      summary: "Create a draft version",
      description:
        "Adds a draft version to a document (owner or author). The number is the next semantic version by `changeType` (major | minor | patch, default minor). HTML content with executable code is refused (422). Returns the version (201) with `warnings.wikiLinks` ([[code-or-slug]] links and whether each exists for the caller).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: DocumentParam, body: versionSchema },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const u = user(c);
      const { doc } = await documentFor(c, c.req.param("id"), "edit");
      const body = input.body as z.infer<typeof versionSchema>;
      requireSafeHtml(body.content, body.contentFormat);

      const changeType = body.changeType || "minor";
      const versionNumber = incrementVersion(doc.nextVersionNumber ?? "1.0.0", changeType);

      const [version] = await dbInstance
        .insert(dmsDocumentVersions)
        .values({
          documentId: doc.id,
          versionNumber,
          changeType,
          content: body.content || "",
          contentFormat: body.contentFormat || "markdown",
          changelog: body.changelog,
          status: "draft",
          createdById: u.id,
        })
        .returning();

      await dbInstance
        .update(dmsDocuments)
        .set({
          versionCount: sql`${dmsDocuments.versionCount} + 1`,
          nextVersionNumber: incrementVersion(versionNumber, "patch"),
          updatedAt: new Date(),
        })
        .where(eq(dmsDocuments.id, doc.id));

      await logAction(
        "create",
        "version",
        version.id,
        u.id,
        { documentId: doc.id, versionNumber },
        doc.id
      );
      const wikiLinkWarnings = await validateWikiLinks(u, body.content);
      return c.json({ ...version, warnings: { wikiLinks: wikiLinkWarnings } }, 201);
    }
  );

  app.get(
    "/versions/:versionId",
    {
      id: "get-version",
      summary: "Get a version",
      description:
        "A version with its content. Published versions: anyone who can read the document; drafts: owner, author, reviewers and approvers (404 otherwise). `files=true` adds its attached files (without storage location).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: {
        params: ParamVersion,
        query: queryValue({ files: textValue("`true` adds the attached files") }),
      },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { version } = await versionFor(c, c.req.param("versionId"), "view");
      const result: Record<string, unknown> = { ...version };
      if (c.req.query("files") === "true") {
        const files = await dbInstance
          .select()
          .from(dmsDocumentFiles)
          .where(eq(dmsDocumentFiles.versionId, version.id))
          .orderBy(asc(dmsDocumentFiles.sortOrder));
        result.files = files.map(publicFile);
      }
      return c.json(result);
    }
  );

  app.patch(
    "/versions/:versionId",
    {
      id: "update-version",
      summary: "Update a draft version",
      description:
        "Updates the content, format or changelog of a version in `draft` or `changes_requested` (owner or author). A published version is immutable (409). HTML content with executable code is refused (422). Returns the version with `warnings.wikiLinks`.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamVersion, body: patchVersionSchema },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const u = user(c);
      const { version, doc } = await versionFor(c, c.req.param("versionId"), "edit");
      // `force` no longer exists: a published version is IMMUTABLE (before,
      // anyone rewrote it by sending `force: true`).
      requireEditable(version);
      const body = input.body as z.infer<typeof patchVersionSchema>;
      requireSafeHtml(
        body.content ?? version.content,
        body.contentFormat ?? version.contentFormat
      );

      const updates: Partial<typeof dmsDocumentVersions.$inferInsert> = { updatedAt: new Date() };
      if (body.content !== undefined) updates.content = body.content;
      if (body.contentFormat !== undefined) updates.contentFormat = body.contentFormat;
      if (body.changelog !== undefined) updates.changelog = body.changelog;

      const [updated] = await dbInstance
        .update(dmsDocumentVersions)
        .set(updates)
        .where(eq(dmsDocumentVersions.id, version.id))
        .returning();

      await logAction("update", "version", version.id, u.id, {}, doc.id);
      const wikiLinkWarnings = await validateWikiLinks(u, updates.content);
      return c.json({ ...updated, warnings: { wikiLinks: wikiLinkWarnings } });
    }
  );

  app.post(
    "/versions/:versionId/submit",
    {
      id: "submit-version-for-review",
      summary: "Submit a version for review",
      description:
        "Moves a `draft` or `changes_requested` version to `review_pending` and notifies the document's reviewers (owner or author; 409 in any other state).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamVersion },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const u = user(c);
      const { version, doc } = await versionFor(c, c.req.param("versionId"), "edit");
      requireEditable(version);

      const [updated] = await dbInstance
        .update(dmsDocumentVersions)
        .set({ status: "review_pending", updatedAt: new Date() })
        .where(eq(dmsDocumentVersions.id, version.id))
        .returning();

      const reviewers = Array.isArray(doc.reviewerIds) ? (doc.reviewerIds as string[]) : [];
      await createWorkflowNotification(
        c,
        doc.id,
        version.id,
        reviewers,
        "review_requested",
        `Document "${doc.title}" version ${version.versionNumber} is pending your review`
      );

      await logAction("submit_review", "version", version.id, u.id, {}, doc.id);
      return c.json(updated);
    }
  );

  app.post(
    "/versions/:versionId/review",
    {
      id: "review-version",
      summary: "Review a version",
      description:
        "Approves a `review_pending` version or requests changes (`decision`, optional `notes`), and notifies author and owner. Reviewers and approvers of the document who are on the team (admin/editor); never the version's author nor the document's owner (except an admin). 409 when it is not pending review.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamVersion, body: revisionSchema },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const u = user(c);
      const { version, doc } = await versionFor(c, c.req.param("versionId"), "review");
      const body = input.body as z.infer<typeof revisionSchema>;
      if (version.status !== "review_pending") {
        throw AppError.conflict("Version not pending review");
      }
      // Segregation of duties: nobody approves their own version (except admin).
      if (version.createdById === u.id && !isAdmin(u)) {
        throw AppError.forbidden("You cannot review a version you wrote yourself");
      }
      // …nor their own document with ANOTHER account of theirs: the owner added
      // a second account (sign-up is open) as reviewer and approved with it.
      // Reviewing belongs to the team (admin/editor), and never to the document's owner
      // (an earlier audit).
      if (!isAdmin(u)) {
        if ((u as { role?: string }).role !== "editor") {
          throw AppError.forbidden("Only the team (admin or editor) reviews and approves versions");
        }
        if (doc.ownerId === u.id) {
          throw AppError.forbidden("You cannot review a document you own");
        }
      }

      const [updated] = await dbInstance
        .update(dmsDocumentVersions)
        .set({
          status: body.decision,
          reviewedById: u.id,
          reviewedAt: new Date(),
          reviewNotes: body.notes ?? null,
          ...(body.decision === "approved" ? { approvedById: u.id, approvedAt: new Date() } : {}),
        })
        .where(
          and(
            eq(dmsDocumentVersions.id, version.id),
            eq(dmsDocumentVersions.status, "review_pending")
          )
        )
        .returning();
      if (!updated) throw AppError.conflict("Version not pending review");

      const recipients = [doc.createdById, doc.ownerId].filter(Boolean) as string[];
      await createWorkflowNotification(
        c,
        doc.id,
        version.id,
        recipients,
        body.decision === "approved" ? "approved" : "changes_requested",
        body.decision === "approved"
          ? `Document "${doc.title}" version ${version.versionNumber} has been approved`
          : `Changes requested on "${doc.title}" version ${version.versionNumber}: ${body.notes || ""}`
      );

      await logAction(
        body.decision,
        "version",
        version.id,
        u.id,
        { notes: body.notes ?? null },
        doc.id
      );
      return c.json(updated);
    }
  );

  app.post(
    "/versions/:versionId/publish",
    {
      id: "publish-version",
      summary: "Publish an approved version",
      description:
        "Publishes an `approved` version: it becomes the document's current version, the document becomes `published` and author and owner are notified. Approvers or the owner. 409 when the version is not approved.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamVersion },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      sensitive: true,
    },
    async (c) => {
      const u = user(c);
      const { version, doc } = await versionFor(c, c.req.param("versionId"), "publish");
      if (version.status !== "approved") {
        throw AppError.conflict("Version must be approved before publishing");
      }

      await dbInstance
        .update(dmsDocumentVersions)
        .set({ isActive: false, isLatest: false })
        .where(eq(dmsDocumentVersions.documentId, doc.id));

      const [published] = await dbInstance
        .update(dmsDocumentVersions)
        .set({
          status: "published",
          publishedById: u.id,
          publishedAt: new Date(),
          isActive: true,
          isLatest: true,
        })
        .where(eq(dmsDocumentVersions.id, version.id))
        .returning();

      await dbInstance
        .update(dmsDocuments)
        .set({
          currentVersionId: version.id,
          currentVersionNumber: version.versionNumber,
          status: "published",
          publishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(dmsDocuments.id, doc.id));

      const recipients = [doc.createdById, doc.ownerId].filter(Boolean) as string[];
      await createWorkflowNotification(
        c,
        doc.id,
        version.id,
        recipients,
        "published",
        `Document "${doc.title}" version ${version.versionNumber} has been published`
      );

      await logAction("publish", "version", version.id, u.id, {}, doc.id);
      return c.json(published);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // FILES
  // ═══════════════════════════════════════════════════════════════════════════

  app.post(
    "/versions/:versionId/files",
    {
      id: "upload-file",
      summary: "Attach a file to a draft version",
      description:
        "Uploads one file (multipart field `file`, up to 25 MB) to a version in `draft` or `changes_requested` (owner or author; 409 otherwise). Office documents, PDF, ZIP, text, CSV, Markdown and raster images only (HTML, SVG, scripts: 422). The client's file name is only displayed, never used as the storage key. Returns the file row (201), without its storage location.",
      access: "session",
      permission: ANY_ACCOUNT,
      before: [readableUpload],
      input: { params: ParamVersion, body: Upload, format: "multipart" },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      mcp: { exclude: "multipart file upload: MCP tool arguments are JSON, not file streams" },
    },
    async (c) => {
      const u = user(c);
      const { version, doc } = await versionFor(c, c.req.param("versionId"), "edit");
      requireEditable(version);

      const long = Number(c.req.header("content-length") || 0);
      if (long > MAX_FILE + 64 * 1024) throw AppError.badRequest("File too large");
      // A body that is not a form (JSON, empty) made
      // `formData()` throw a TypeError: it was a 500. It means the file is not present.
      let formData: FormData;
      try {
        formData = await c.req.formData();
      } catch {
        throw AppError.validation("No file provided");
      }
      const file = formData.get("file");
      if (!file || typeof file === "string") throw AppError.validation("No file provided");
      if (file.size > MAX_FILE) throw AppError.badRequest("File too large");
      const typeValue = (file.type || "").split(";")[0].trim().toLowerCase();
      if (!FILE_TYPES.has(typeValue)) {
        throw AppError.validation("File type not allowed", { mimeType: typeValue || null });
      }
      if (!storage?.put) throw AppError.internal();

      const name = safeName(file.name);
      // The key carries NOTHING from the client (no name or path): no path
      // traversal and no names that give away the content in a URL.
      const extension = (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "bin").toLowerCase();
      const storagePath = `dms/${randomUUID()}/${randomUUID()}.${extension}`;
      const buffer = Buffer.from(await file.arrayBuffer());
      await storage.put(storagePath, buffer, typeValue);

      const [docFile] = await dbInstance
        .insert(dmsDocumentFiles)
        .values({
          versionId: version.id,
          documentId: doc.id,
          filename: name,
          originalName: name,
          mimeType: typeValue,
          sizeBytes: file.size,
          storageProvider: "kon-storage",
          storagePath,
          createdById: u.id,
        })
        .returning();

      await dbInstance
        .update(dmsDocumentVersions)
        .set({
          fileCount: sql`${dmsDocumentVersions.fileCount} + 1`,
          totalSizeBytes: sql`${dmsDocumentVersions.totalSizeBytes} + ${file.size}`,
        })
        .where(eq(dmsDocumentVersions.id, version.id));

      await logAction("upload", "file", docFile.id, u.id, { filename: name }, doc.id);
      return c.json(publicFile(docFile), 201);
    }
  );

  app.get(
    "/files/:fileId/download",
    {
      id: "download-file",
      summary: "Download an attached file",
      description:
        "302 redirect to a signed storage URL valid for 5 minutes. Follows its version: a draft's file only for owner, author, reviewers and approvers. Counts a download. 404 when the caller cannot see it.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: FileParam },
      output: { status: 302, description: "Redirect to a signed download URL" },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      mcp: { exclude: "browser redirect to a signed storage URL; no JSON result" },
    },
    async (c) => {
      const u = user(c);
      const fileId = c.req.param("fileId");
      if (!fileId || !isUuid(fileId)) throw AppError.notFound("File not found");
      const [file] = await dbInstance
        .select()
        .from(dmsDocumentFiles)
        .where(eq(dmsDocumentFiles.id, fileId))
        .limit(1);
      if (!file) throw AppError.notFound("File not found");
      try {
        // The file follows its VERSION: a draft's file cannot be downloaded by a reader.
        await versionFor(c, file.versionId, "view");
      } catch (e) {
        if ((e as { status?: number }).status === 404) throw AppError.notFound("File not found");
        throw e;
      }
      // Defense in depth: only keys with the shape this kon generates.
      if (!/^dms\/[A-Za-z0-9/_.-]+$/.test(file.storagePath) || file.storagePath.includes("..")) {
        throw AppError.notFound("File not found");
      }

      await asSystem(() =>
        dbInstance
          .update(dmsDocuments)
          .set({ downloadCount: sql`${dmsDocuments.downloadCount} + 1` })
          .where(eq(dmsDocuments.id, file.documentId))
      );
      await logAction("download", "file", file.id, u.id, {}, file.documentId);

      const url = storage?.getSignedDownloadUrl
        ? await storage.getSignedDownloadUrl(file.storagePath, 300)
        : null;
      if (!url) throw AppError.notFound("File not found");
      c.header("Cache-Control", "no-store");
      return c.redirect(url, 302);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // RELATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  app.post(
    "/documents/:id/relations",
    {
      id: "create-relation",
      summary: "Relate two documents",
      description:
        "Links a document (owner or author) to another one the caller can read (`related`, `replaces`, `requires`, `supersedes`). A target the caller cannot read is a 422, never a 404 (no oracle). 409 when the relation already exists.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: DocumentParam, body: relationSchema },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const u = user(c);
      const { doc } = await documentFor(c, c.req.param("id"), "edit");
      const body = input.body as z.infer<typeof relationSchema>;
      if (body.targetDocumentId === doc.id)
        throw AppError.validation("A document cannot be related to itself");
      try {
        // The target has to be visible to whoever links: otherwise the
        // response (201 / 404) would say whether a document exists that they cannot see.
        await documentFor(c, body.targetDocumentId, "view");
      } catch (e) {
        if ((e as { status?: number }).status === 404) {
          throw AppError.validation("targetDocumentId does not exist", { field: "targetDocumentId" });
        }
        throw e;
      }

      const [already] = await dbInstance
        .select({ id: dmsDocumentRelations.id })
        .from(dmsDocumentRelations)
        .where(
          and(
            eq(dmsDocumentRelations.sourceDocumentId, doc.id),
            eq(dmsDocumentRelations.targetDocumentId, body.targetDocumentId),
            eq(dmsDocumentRelations.relationType, body.relationType)
          )
        )
        .limit(1);
      if (already) throw AppError.conflict("The relation already exists");

      const [relation] = await dbInstance
        .insert(dmsDocumentRelations)
        .values({
          sourceDocumentId: doc.id,
          targetDocumentId: body.targetDocumentId,
          relationType: body.relationType,
          description: body.description ?? null,
        })
        .returning();

      await logAction("create", "relation", relation.id, u.id, {}, doc.id);
      return c.json(relation, 201);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ACKNOWLEDGMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  app.post(
    "/documents/:id/acknowledge",
    {
      id: "acknowledge-read",
      summary: "Acknowledge reading a document",
      description:
        "Records that the caller has read the document's current published version (optional `notes`). Repeating it answers `{ alreadyAcknowledged: true }`. 409 when the document has no published version.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: DocumentParam, body: ackSchema },
      output: { schema: Confirmation },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      idempotent: true,
    },
    async (c, input) => {
      const u = user(c);
      const { doc } = await documentFor(c, c.req.param("id"), "view");
      const body = input.body as z.infer<typeof ackSchema>;
      if (!doc.currentVersionId) throw AppError.conflict("No published version");

      const [ack] = await dbInstance
        .insert(dmsDocumentAcknowledgments)
        .values({
          documentId: doc.id,
          versionId: doc.currentVersionId,
          userId: u.id,
          notes: body.notes ?? null,
          ipAddress: null,
          userAgent: c.req.header("user-agent")?.slice(0, 500) ?? null,
        })
        .onConflictDoNothing()
        .returning();

      return c.json(ack || { alreadyAcknowledged: true });
    }
  );

  app.get(
    "/documents/:id/acknowledgments",
    {
      id: "list-read-acknowledgments",
      summary: "Who acknowledged a document",
      description:
        "The reading acknowledgments of a document, newest first. Owner or author (403 for a mere reader).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: DocumentParam },
      output: { schema: List },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      // Who has read what: seen by whoever runs the document, not any reader.
      const { doc } = await documentFor(c, c.req.param("id"), "edit");
      // Personal RLS only lets you see your own rows: with the action already
      // authorized, they are read as system.
      const acks = await asSystem(() =>
        dbInstance
          .select()
          .from(dmsDocumentAcknowledgments)
          .where(eq(dmsDocumentAcknowledgments.documentId, doc.id))
          .orderBy(desc(dmsDocumentAcknowledgments.acknowledgedAt))
      );
      return c.json({ docs: acks });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // COMMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Ids of versions of this document that the user CANNOT see. */
  async function hiddenVersions(docId: string, p: Permissions): Promise<string[]> {
    if (p.viewDrafts) return [];
    const rows = await dbInstance
      .select({ id: dmsDocumentVersions.id })
      .from(dmsDocumentVersions)
      .where(
        and(
          eq(dmsDocumentVersions.documentId, docId),
          sql`${dmsDocumentVersions.status} <> 'published'`
        )
      );
    return rows.map((f) => f.id);
  }

  app.get(
    "/documents/:id/comments",
    {
      id: "list-comments",
      summary: "List a document's comments",
      description:
        "Top-level comments of a document with their `replies`, oldest first, paginated (`limit` 1-100, `page`). `resolved=true|false` filters. Readers do not see comments made on versions they cannot see.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: {
        params: DocumentParam,
        query: queryValue({
          limit: textValue("1-100, default 50"),
          page: textValue("Page number, from 1"),
          resolved: textValue("`true` or `false`"),
        }),
      },
      output: { schema: PaginatedList },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { doc, p } = await documentFor(c, c.req.param("id"), "view");
      const query = c.req.query();
      const limit = Math.min(Math.max(parseInt(query.limit || "50", 10) || 50, 1), 100);
      const page = Math.max(parseInt(query.page || "1", 10) || 1, 1);
      const offset = (page - 1) * limit;

      const hiddenItems = await hiddenVersions(doc.id, p);
      const deVersionVisible = hiddenItems.length
        ? or(
            isNull(dmsDocumentComments.versionId),
            sql`${dmsDocumentComments.versionId} NOT IN (${sql.join(
              hiddenItems.map((x) => sql`${x}::uuid`),
              sql`, `
            )})`
          )
        : undefined;

      const conditions: SQL[] = [
        eq(dmsDocumentComments.documentId, doc.id),
        isNull(dmsDocumentComments.parentId),
      ];
      if (deVersionVisible) conditions.push(deVersionVisible);
      if (query.resolved === "true")
        conditions.push(sql`${dmsDocumentComments.resolvedAt} IS NOT NULL`);
      else if (query.resolved === "false")
        conditions.push(sql`${dmsDocumentComments.resolvedAt} IS NULL`);

      const [countResult] = await dbInstance
        .select({ count: sql<number>`count(*)::int` })
        .from(dmsDocumentComments)
        .where(and(...conditions));
      const total = countResult?.count || 0;

      const comments = await dbInstance
        .select()
        .from(dmsDocumentComments)
        .where(and(...conditions))
        .orderBy(asc(dmsDocumentComments.createdAt))
        .limit(limit)
        .offset(offset);

      const commentIds = comments.map((x) => x.id);
      const replies = commentIds.length
        ? await dbInstance
            .select()
            .from(dmsDocumentComments)
            .where(
              and(
                inArray(dmsDocumentComments.parentId, commentIds),
                eq(dmsDocumentComments.documentId, doc.id),
                deVersionVisible
              )
            )
            .orderBy(asc(dmsDocumentComments.createdAt))
        : [];

      const repliesMap = new Map<string, typeof replies>();
      for (const reply of replies) {
        if (!reply.parentId) continue;
        const list = repliesMap.get(reply.parentId) || [];
        list.push(reply);
        repliesMap.set(reply.parentId, list);
      }

      return c.json({
        docs: comments.map((x) => ({ ...x, replies: repliesMap.get(x.id) || [] })),
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
      });
    }
  );

  app.post(
    "/documents/:id/comments",
    {
      id: "create-comment",
      summary: "Comment on a document",
      description:
        "Adds a comment to a document the caller can read, optionally on one of its versions the caller can see (`versionId`) or as a reply (`parentId`, a comment of the same document); otherwise 422. Returns the comment (201).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: DocumentParam, body: commentSchema },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const u = user(c);
      const { doc, p } = await documentFor(c, c.req.param("id"), "view");
      const body = input.body as z.infer<typeof commentSchema>;

      if (body.versionId) {
        // The version has to belong to THIS document and be visible to whoever comments.
        const [v] = await dbInstance
          .select({ id: dmsDocumentVersions.id, status: dmsDocumentVersions.status })
          .from(dmsDocumentVersions)
          .where(
            and(
              eq(dmsDocumentVersions.id, body.versionId),
              eq(dmsDocumentVersions.documentId, doc.id)
            )
          )
          .limit(1);
        if (!v || !canViewVersion(p, v)) {
          throw AppError.validation("versionId is not a version of this document", {
            field: "versionId",
          });
        }
      }
      if (body.parentId) {
        const [parentValue] = await dbInstance
          .select({ id: dmsDocumentComments.id })
          .from(dmsDocumentComments)
          .where(
            and(
              eq(dmsDocumentComments.id, body.parentId),
              eq(dmsDocumentComments.documentId, doc.id)
            )
          )
          .limit(1);
        if (!parentValue) {
          throw AppError.validation("parentId is not a comment of this document", {
            field: "parentId",
          });
        }
      }

      const [comment] = await dbInstance
        .insert(dmsDocumentComments)
        .values({
          documentId: doc.id,
          versionId: body.versionId ?? null,
          parentId: body.parentId ?? null,
          userId: u.id,
          content: body.content,
        })
        .returning();
      return c.json(comment, 201);
    }
  );

  /** Comment + its document; a comment on a document you cannot see does not exist. */
  async function commentFor(c: Context, commentId: string | undefined) {
    if (!commentId || !isUuid(commentId)) throw AppError.notFound("Comment not found");
    const [comment] = await dbInstance
      .select()
      .from(dmsDocumentComments)
      .where(eq(dmsDocumentComments.id, commentId))
      .limit(1);
    if (!comment) throw AppError.notFound("Comment not found");
    try {
      const r = await documentFor(c, comment.documentId, "view");
      if (
        comment.versionId &&
        (await hiddenVersions(comment.documentId, r.p)).includes(comment.versionId)
      ) {
        throw AppError.notFound("Comment not found");
      }
      return { comment, ...r };
    } catch (e) {
      if ((e as { status?: number }).status === 404) throw AppError.notFound("Comment not found");
      throw e;
    }
  }

  app.patch(
    "/comments/:commentId",
    {
      id: "update-comment",
      summary: "Edit a comment",
      description:
        "Changes the text of a comment. Only its author (403 otherwise); 404 when the caller cannot see it.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: CommentParam, body: patchCommentSchema },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const u = user(c);
      const { comment } = await commentFor(c, c.req.param("commentId"));
      if (comment.userId !== u.id) throw AppError.forbidden("Only the author edits their comment");
      const body = input.body as z.infer<typeof patchCommentSchema>;
      const [updated] = await dbInstance
        .update(dmsDocumentComments)
        .set({ content: body.content, updatedAt: new Date() })
        .where(eq(dmsDocumentComments.id, comment.id))
        .returning();
      return c.json(updated);
    }
  );

  app.delete(
    "/comments/:commentId",
    {
      id: "delete-comment",
      summary: "Delete a comment",
      description:
        "Deletes a comment: its author, or whoever edits the document (moderation). 404 when the caller cannot see it.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: CommentParam },
      output: { schema: Success },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const u = user(c);
      const { comment, p } = await commentFor(c, c.req.param("commentId"));
      // The author, or whoever runs the document (moderation).
      if (comment.userId !== u.id && !p.edit)
        throw AppError.forbidden("You cannot delete this comment");
      await dbInstance.delete(dmsDocumentComments).where(eq(dmsDocumentComments.id, comment.id));
      return c.json({ success: true });
    }
  );

  app.post(
    "/comments/:commentId/resolve",
    {
      id: "resolve-comment",
      summary: "Resolve a comment",
      description:
        "Marks a comment as resolved: its author, or whoever edits the document. Returns the comment.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: CommentParam },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const u = user(c);
      const { comment, p } = await commentFor(c, c.req.param("commentId"));
      if (comment.userId !== u.id && !p.edit)
        throw AppError.forbidden("You cannot resolve this comment");
      const [updated] = await dbInstance
        .update(dmsDocumentComments)
        .set({ resolvedAt: new Date(), updatedAt: new Date() })
        .where(eq(dmsDocumentComments.id, comment.id))
        .returning();
      return c.json(updated);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // BACKLINKS
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    "/documents/:id/backlinks",
    {
      id: "list-incoming-links",
      summary: "Documents linking to this one",
      description:
        "Active documents the caller can read whose published content links to this document as [[code]] or [[slug]].",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: DocumentParam },
      output: { schema: List },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const u = user(c);
      const { doc } = await documentFor(c, c.req.param("id"), "view");
      const escape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
      const read = readFilter(u);
      const backlinks = await dbInstance
        .selectDistinct({
          id: dmsDocuments.id,
          code: dmsDocuments.code,
          title: dmsDocuments.title,
          slug: dmsDocuments.slug,
          currentVersionNumber: dmsDocuments.currentVersionNumber,
        })
        .from(dmsDocuments)
        .innerJoin(dmsDocumentVersions, eq(dmsDocumentVersions.documentId, dmsDocuments.id))
        .where(
          and(
            eq(dmsDocuments.isActive, true),
            eq(dmsDocumentVersions.status, "published"),
            read,
            or(
              like(dmsDocumentVersions.content, `%[[${escape(doc.code)}]]%`),
              like(dmsDocumentVersions.content, `%[[${escape(doc.slug)}]]%`)
            )
          )
        );
      return c.json({ docs: backlinks });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPORT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Exported HTML: it is served from the API origin, so it goes with a CSP
   * `sandbox` (opaque origin, no scripts), without `sniff` and with everything that is not
   * the document's own HTML content escaped.
   */
  app.get(
    "/versions/:versionId/export/html",
    {
      id: "export-version-html",
      summary: "Export a version as HTML",
      description:
        "A standalone HTML page of the version (markdown/raw content escaped inside <pre>), served with a sandbox Content-Security-Policy. Same visibility as get-version.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamVersion },
      output: { type: "text/html", description: "Standalone HTML document" },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      mcp: {
        exclude: "standalone HTML page for the browser; agents read the content with get-version",
      },
    },
    async (c) => {
      const { version, doc } = await versionFor(c, c.req.param("versionId"), "view");
      const bodyValue =
        version.contentFormat === "html"
          ? version.content || ""
          : `<pre>${escapeHtml(version.content || "")}</pre>`;
      const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(doc.title || "Document")}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;max-width:800px;margin:2rem auto;padding:0 1rem;color:#333}
h1,h2,h3,h4,h5,h6{color:#111;margin-top:1.5rem}
pre{background:#f4f4f4;padding:1rem;border-radius:4px;overflow-x:auto;white-space:pre-wrap}
blockquote{border-left:4px solid #ddd;margin:0;padding-left:1rem;color:#666}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}
</style>
</head>
<body>
${bodyValue}
</body>
</html>`;
      c.header("Content-Type", "text/html; charset=utf-8");
      c.header(
        "Content-Security-Policy",
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
      );
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Cache-Control", "no-store");
      return c.body(html);
    }
  );

  app.get(
    "/versions/:versionId/export/md",
    {
      id: "export-version-markdown",
      summary: "Export a version as Markdown",
      description:
        "The version's content as a Markdown attachment (other formats are prefixed with a comment naming the original format). Same visibility as get-version.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamVersion },
      output: { type: "text/markdown", description: "The content (attachment document.md)" },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { version } = await versionFor(c, c.req.param("versionId"), "view");
      const markdown =
        version.contentFormat === "markdown"
          ? version.content
          : `<!-- Original format: ${String(version.contentFormat).replace(/--/g, "")} -->\n\n${version.content}`;
      c.header("Content-Type", "text/markdown; charset=utf-8");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Content-Disposition", 'attachment; filename="document.md"');
      c.header("Cache-Control", "no-store");
      return c.body(markdown || "");
    }
  );

  app.get(
    "/categories/:id/export/zip",
    {
      id: "export-folder",
      summary: "Export a folder",
      description:
        "The published documents of a folder the caller can read, as a JSON manifest plus `files` (`<slug>/metadata.json` and `<slug>/content.md` per document); the same shape import-documents takes. 404 when the folder does not exist or is not visible.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: FolderParam },
      output: { schema: Export },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      cost: 5,
    },
    async (c) => {
      const u = user(c);
      const id = c.req.param("id");
      if (!id || !isUuid(id)) throw AppError.notFound("Category not found");
      const visible = await visibleCategories(u);
      if (visible && !visible.has(id)) throw AppError.notFound("Category not found");
      const [category] = await dbInstance
        .select()
        .from(dmsCategories)
        .where(eq(dmsCategories.id, id))
        .limit(1);
      if (!category) throw AppError.notFound("Category not found");

      const read = readFilter(u);
      const docs = await dbInstance
        .select()
        .from(dmsDocuments)
        .where(
          and(
            eq(dmsDocuments.categoryId, id),
            eq(dmsDocuments.isActive, true),
            eq(dmsDocuments.status, "published"),
            read
          )
        );

      const files: { path: string; content: string; contentType: string }[] = [];
      for (const doc of docs) {
        const [version] = await dbInstance
          .select()
          .from(dmsDocumentVersions)
          .where(
            and(
              eq(dmsDocumentVersions.documentId, doc.id),
              eq(dmsDocumentVersions.isLatest, true),
              eq(dmsDocumentVersions.status, "published")
            )
          )
          .limit(1);
        if (!version) continue;
        files.push({
          path: `${doc.slug}/metadata.json`,
          content: JSON.stringify(
            {
              id: doc.id,
              code: doc.code,
              title: doc.title,
              slug: doc.slug,
              type: doc.type,
              versionNumber: version.versionNumber,
              publishedAt: doc.publishedAt,
            },
            null,
            2
          ),
          contentType: "application/json",
        });
        files.push({
          path: `${doc.slug}/content.md`,
          content: version.content || "",
          contentType: "text/markdown",
        });
      }

      const { allowedRoles: _r, metadataSchema: _m, ...publicCategory } = category;
      return c.json({
        manifest: {
          format: "kitsuden-dms-export",
          version: "1.0.0",
          exportedAt: new Date().toISOString(),
          category: publicCategory,
          documentCount: files.length / 2,
        },
        files,
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // DIAGRAMS
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    "/versions/:versionId/diagrams",
    {
      id: "list-diagrams",
      summary: "List a version's diagrams",
      description: "The diagrams embedded in a version, by name. Same visibility as get-version.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamVersion },
      output: { schema: List },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const { version } = await versionFor(c, c.req.param("versionId"), "view");
      const diagrams = await dbInstance
        .select()
        .from(dmsDocumentDiagrams)
        .where(eq(dmsDocumentDiagrams.versionId, version.id))
        .orderBy(asc(dmsDocumentDiagrams.name));
      return c.json({ docs: diagrams });
    }
  );

  app.post(
    "/versions/:versionId/diagrams",
    {
      id: "create-diagram",
      summary: "Add a diagram to a draft version",
      description:
        "Adds a diagram (source XML/JSON, rendered SVG or a media id) to a version in `draft` or `changes_requested` (owner or author; 409 otherwise). An SVG with executable code is refused (422). Embed it in the content as [[diagram:<id>]]. Returns the diagram (201).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamVersion, body: diagramSchema },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const { version } = await versionFor(c, c.req.param("versionId"), "edit");
      requireEditable(version);
      const body = input.body as z.infer<typeof diagramSchema>;
      if (body.renderedSvg && dangerousSvg(body.renderedSvg)) {
        throw AppError.validation("The SVG contains executable code", { field: "renderedSvg" });
      }
      const [diagram] = await dbInstance
        .insert(dmsDocumentDiagrams)
        .values({
          versionId: version.id,
          name: body.name,
          sourceXml: body.sourceXml || null,
          sourceJson: body.sourceJson || null,
          renderedSvg: body.renderedSvg || null,
          mediaId: body.mediaId || null,
        })
        .returning();
      return c.json(diagram, 201);
    }
  );

  /** Diagram + its version (editable) + document (editable by the caller). */
  async function editableDiagram(c: Context, diagramId: string | undefined) {
    if (!diagramId || !isUuid(diagramId)) throw AppError.notFound("Diagram not found");
    const [diagram] = await dbInstance
      .select()
      .from(dmsDocumentDiagrams)
      .where(eq(dmsDocumentDiagrams.id, diagramId))
      .limit(1);
    if (!diagram) throw AppError.notFound("Diagram not found");
    try {
      const { version } = await versionFor(c, diagram.versionId, "edit");
      requireEditable(version);
      return diagram;
    } catch (e) {
      if ((e as { status?: number }).status === 404) throw AppError.notFound("Diagram not found");
      throw e;
    }
  }

  app.patch(
    "/diagrams/:diagramId",
    {
      id: "update-diagram",
      summary: "Update a diagram",
      description:
        "Updates a diagram of an editable version (owner or author; 409 when the version is no longer a draft). An SVG with executable code is refused (422).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: DiagramParam, body: diagramSchema.partial() },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const diagram = await editableDiagram(c, c.req.param("diagramId"));
      const body = input.body as Partial<z.infer<typeof diagramSchema>>;
      if (body.renderedSvg && dangerousSvg(body.renderedSvg)) {
        throw AppError.validation("The SVG contains executable code", { field: "renderedSvg" });
      }
      const updates: Partial<typeof dmsDocumentDiagrams.$inferInsert> = { updatedAt: new Date() };
      for (const field of ["name", "sourceXml", "sourceJson", "renderedSvg", "mediaId"] as const) {
        if (body[field] !== undefined) (updates as Record<string, unknown>)[field] = body[field];
      }
      const [updated] = await dbInstance
        .update(dmsDocumentDiagrams)
        .set(updates)
        .where(eq(dmsDocumentDiagrams.id, diagram.id))
        .returning();
      return c.json(updated);
    }
  );

  app.delete(
    "/diagrams/:diagramId",
    {
      id: "delete-diagram",
      summary: "Delete a diagram",
      description:
        "Deletes a diagram of an editable version (owner or author; 409 when the version is no longer a draft).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: DiagramParam },
      output: { schema: Success },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const diagram = await editableDiagram(c, c.req.param("diagramId"));
      await dbInstance.delete(dmsDocumentDiagrams).where(eq(dmsDocumentDiagrams.id, diagram.id));
      return c.json({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // IMPORT
  // ═══════════════════════════════════════════════════════════════════════════

  app.post(
    "/import",
    {
      id: "import-documents",
      summary: "Import documents",
      description:
        "Imports the output of export-folder: one PRIVATE draft document per `<slug>/metadata.json` (owned by the caller), with a draft 1.0.0 from its `content.md`. Team only (admin/editor). Files that fail are listed in `results.errors` (invalid JSON, code taken); the rest are imported.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: importSchema },
      output: { schema: ImportResult },
      errors: ["KITSUDEN_E_CONFLICT"],
      sensitive: true,
    },
    async (c, input) => {
      const u = user(c);
      if (!(await can(u as AuthzUser, "dms:create"))) {
        throw AppError.forbidden("Only the team imports documents");
      }
      const body = input.body as z.infer<typeof importSchema>;
      const results = {
        categoriesCreated: 0,
        documentsCreated: 0,
        versionsCreated: 0,
        errors: [] as string[],
      };

      for (const file of body.files) {
        if (!file.path.endsWith("/metadata.json")) continue;
        const parts = file.path.split("/");
        const docSlug = slugOf(parts[parts.length - 2] || "document");
        let meta: Record<string, unknown>;
        try {
          meta = JSON.parse(file.content) as Record<string, unknown>;
        } catch {
          results.errors.push(`${file.path}: metadata.json is not valid JSON`);
          continue;
        }
        const typeValue = docType(typeof meta.type === "string" ? meta.type : undefined) ?? "manual";
        const orderCode =
          typeof meta.code === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(meta.code)
            ? meta.code
            : null;
        const code = orderCode ?? generateDocumentCode(typeValue);
        const [busy] = await dbInstance
          .select({ id: dmsDocuments.id })
          .from(dmsDocuments)
          .where(eq(dmsDocuments.code, code))
          .limit(1);
        if (busy) {
          results.errors.push(`${file.path}: the code already exists`);
          continue;
        }

        // What is imported belongs to whoever imports it, as a draft and PRIVATE.
        const [doc] = await dbInstance
          .insert(dmsDocuments)
          .values({
            code,
            title: typeof meta.title === "string" ? meta.title.slice(0, 500) : docSlug,
            slug: docSlug,
            type: typeValue,
            status: "draft",
            ownerId: u.id,
            createdById: u.id,
            visibility: "private",
          })
          .returning();
        results.documentsCreated++;

        const contentFile = body.files.find(
          (f) => f.path === `${parts.slice(0, -1).join("/")}/content.md`
        );
        if (contentFile) {
          await dbInstance.insert(dmsDocumentVersions).values({
            documentId: doc.id,
            versionNumber: "1.0.0",
            content: contentFile.content,
            contentFormat: "markdown",
            changelog: "Imported",
            status: "draft",
            createdById: u.id,
          });
          results.versionsCreated++;
        }
      }

      return c.json({ success: true, results });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // AUDIT LOG
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    "/audit-log",
    {
      id: "get-audit",
      summary: "Audit log",
      description:
        "Access and change log, newest first, paginated (`limit` 1-100, `page`). The whole log: admin only; anyone else must pass `documentId` of a document they own or authored (403 otherwise). Filters: `documentId`, `userId`, `action`.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: {
        query: queryValue({
          limit: textValue("1-100, default 50"),
          page: textValue("Page number, from 1"),
          documentId: textValue("Document uuid (required unless admin)"),
          userId: textValue("User id"),
          action: textValue("Action: view, create, update, upload, download, publish…"),
        }),
      },
      output: { schema: List },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const u = user(c);
      const query = c.req.query();
      const limit = Math.min(Math.max(parseInt(query.limit || "50", 10) || 50, 1), 100);
      const page = Math.max(parseInt(query.page || "1", 10) || 1, 1);
      const offset = (page - 1) * limit;

      const conditions: SQL[] = [];
      const auditorGlobal = await can(u as AuthzUser, "dms:auditoria");
      if (!auditorGlobal) {
        // Without being admin, only the audit of ONE document that you run.
        if (!query.documentId) throw AppError.forbidden("The full audit is for admin only");
        await documentFor(c, query.documentId, "edit");
      }
      if (query.documentId) {
        if (!isUuid(query.documentId)) throw AppError.notFound("Document not found");
        conditions.push(eq(dmsAccessLog.documentId, query.documentId));
      }
      if (query.userId) conditions.push(eq(dmsAccessLog.userId, query.userId));
      if (query.action) conditions.push(eq(dmsAccessLog.action, query.action.slice(0, 50)));

      // RLS only lets you see your own trail: authorized above, it is read as system.
      const logs = await asSystem(() =>
        dbInstance
          .select()
          .from(dmsAccessLog)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(dmsAccessLog.createdAt))
          .limit(limit)
          .offset(offset)
      );
      return c.json({ docs: logs });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // WORKFLOW NOTIFICATIONS (your own)
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    "/notifications",
    {
      id: "list-notices",
      summary: "My workflow notifications",
      description:
        "The caller's own workflow notifications (review requested, approved, changes requested, published), newest first, paginated. `unreadOnly=true` filters.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: {
        query: queryValue({
          limit: textValue("1-100, default 50"),
          page: textValue("Page number, from 1"),
          unreadOnly: textValue("`true` for unread only"),
        }),
      },
      output: { schema: PaginatedList },
    },
    async (c) => {
      const u = user(c);
      const query = c.req.query();
      const limit = Math.min(Math.max(parseInt(query.limit || "50", 10) || 50, 1), 100);
      const page = Math.max(parseInt(query.page || "1", 10) || 1, 1);
      const offset = (page - 1) * limit;

      const conditions: SQL[] = [eq(dmsWorkflowNotifications.userId, u.id)];
      if (query.unreadOnly === "true") conditions.push(eq(dmsWorkflowNotifications.read, false));

      const [countResult] = await dbInstance
        .select({ count: sql<number>`count(*)::int` })
        .from(dmsWorkflowNotifications)
        .where(and(...conditions));
      const total = countResult?.count || 0;

      const notifications = await dbInstance
        .select()
        .from(dmsWorkflowNotifications)
        .where(and(...conditions))
        .orderBy(desc(dmsWorkflowNotifications.createdAt))
        .limit(limit)
        .offset(offset);

      return c.json({
        docs: notifications,
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
      });
    }
  );

  app.post(
    "/notifications/:id/read",
    {
      id: "mark-notice-read",
      summary: "Mark a notification as read",
      description:
        "Marks one of the caller's notifications as read. 404 when it is not the caller's.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: NoticeParam },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      idempotent: true,
    },
    async (c) => {
      const u = user(c);
      const id = c.req.param("id");
      if (!id || !isUuid(id)) throw AppError.notFound("Notification not found");
      const [updated] = await dbInstance
        .update(dmsWorkflowNotifications)
        .set({ read: true })
        .where(and(eq(dmsWorkflowNotifications.id, id), eq(dmsWorkflowNotifications.userId, u.id)))
        .returning();
      if (!updated) throw AppError.notFound("Notification not found");
      return c.json(updated);
    }
  );

  app.post(
    "/notifications/read-all",
    {
      id: "mark-notices-read",
      summary: "Mark all my notifications as read",
      description: "Marks every unread notification of the caller as read.",
      access: "session",
      permission: ANY_ACCOUNT,
      output: { schema: Success },
      idempotent: true,
    },
    async (c) => {
      const u = user(c);
      await dbInstance
        .update(dmsWorkflowNotifications)
        .set({ read: true })
        .where(
          and(eq(dmsWorkflowNotifications.userId, u.id), eq(dmsWorkflowNotifications.read, false))
        );
      return c.json({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER (reader)
  // ═══════════════════════════════════════════════════════════════════════════

  async function documentBySlug(u: DmsUser, searchedSlug: string): Promise<DmsDocument | null> {
    const read = readFilter(u);
    const [doc] = await dbInstance
      .select()
      .from(dmsDocuments)
      .where(and(eq(dmsDocuments.slug, searchedSlug), eq(dmsDocuments.isActive, true), read))
      .orderBy(desc(dmsDocuments.updatedAt))
      .limit(1);
    return doc ?? null;
  }

  app.get(
    "/render/:slug",
    {
      id: "read-document",
      summary: "Read a published document",
      description:
        "The reader view of a document by slug: its current published version with header ids, embedded diagrams, table of contents, wiki-link check, breadcrumb and previous/next documents of the same folder. An old slug answers 308 to the current one (only for a document the caller can read). 404 when it does not exist, is not readable or has no published version.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamSlug },
      output: { schema: Read, otherStatuses: [308] },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const u = user(c);
      const requestedSlug = c.req.param("slug")!;
      if (requestedSlug.length > 500) throw AppError.notFound("Document not found");

      const document = await documentBySlug(u, requestedSlug);
      if (!document) {
        // Redirect by old slug, but ONLY to a document they can see:
        // otherwise the redirect would reveal the new slug of someone else's.
        const [history] = await dbInstance
          .select({ documentId: dmsDocumentSlugHistory.documentId })
          .from(dmsDocumentSlugHistory)
          .where(eq(dmsDocumentSlugHistory.oldSlug, requestedSlug))
          .limit(1);
        if (history) {
          const read = readFilter(u);
          const [doc] = await dbInstance
            .select({ slug: dmsDocuments.slug })
            .from(dmsDocuments)
            .where(
              and(eq(dmsDocuments.id, history.documentId), eq(dmsDocuments.isActive, true), read)
            )
            .limit(1);
          if (doc) return c.redirect(`/api/dms/render/${encodeURIComponent(doc.slug)}`, 308);
        }
        throw AppError.notFound("Document not found");
      }

      const { p } = await documentFor(c, document.id, "view");

      const [version] = await dbInstance
        .select()
        .from(dmsDocumentVersions)
        .where(
          and(
            eq(dmsDocumentVersions.documentId, document.id),
            eq(dmsDocumentVersions.status, "published"),
            eq(dmsDocumentVersions.isLatest, true)
          )
        )
        .limit(1);
      if (!version) throw AppError.notFound("No published version available");

      const toc = generateToc(version.content, version.contentFormat || "markdown");
      let renderedContent = version.content || "";
      if (version.contentFormat === "html") renderedContent = injectHeaderIds(renderedContent);
      renderedContent = await injectDiagrams(renderedContent, version.id);
      const wikiLinks = await validateWikiLinks(u, version.content);

      const read = readFilter(u);
      const siblings = await dbInstance
        .select({ id: dmsDocuments.id, slug: dmsDocuments.slug, title: dmsDocuments.title })
        .from(dmsDocuments)
        .where(
          and(
            document.categoryId === null
              ? isNull(dmsDocuments.categoryId)
              : eq(dmsDocuments.categoryId, document.categoryId),
            eq(dmsDocuments.isActive, true),
            eq(dmsDocuments.status, "published"),
            read
          )
        )
        .orderBy(asc(dmsDocuments.publishedAt));
      const currentIndex = siblings.findIndex((s) => s.id === document.id);
      const prev = currentIndex > 0 ? siblings[currentIndex - 1] : null;
      const next =
        currentIndex >= 0 && currentIndex < siblings.length - 1 ? siblings[currentIndex + 1] : null;

      const breadcrumb = await buildBreadcrumb(document.categoryId);
      await countView(c, document.id, u.id);

      return c.json({
        document: {
          id: document.id,
          code: document.code,
          title: document.title,
          slug: document.slug,
          description: document.description,
          type: document.type,
          publishedAt: document.publishedAt,
          versionNumber: version.versionNumber,
          changelog: version.changelog,
          requiresReview: computeRequiresReview(document),
          canEdit: p.edit,
        },
        category: document.categoryId
          ? {
              id: document.categoryId,
              name: breadcrumb[breadcrumb.length - 1]?.name || null,
              slug: breadcrumb[breadcrumb.length - 1]?.slug || null,
              breadcrumb,
            }
          : null,
        content: renderedContent,
        contentFormat: version.contentFormat,
        toc,
        wikiLinks,
        navigation: { prev, next },
      });
    }
  );

  app.get(
    "/render/code/:code",
    {
      id: "open-document-by-code",
      summary: "Open a document by code",
      description:
        "307 redirect to the reader view (/api/dms/render/<slug>) of the document with this code, if the caller can read it; 404 otherwise.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: CodeParam },
      output: { status: 307, description: "Redirect to /api/dms/render/<slug>" },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      mcp: {
        exclude: "browser redirect to the reader view; agents use read-document with the slug",
      },
    },
    async (c) => {
      const u = user(c);
      const code = c.req.param("code")!;
      const read = readFilter(u);
      const [document] = await dbInstance
        .select({ slug: dmsDocuments.slug })
        .from(dmsDocuments)
        .where(
          and(eq(dmsDocuments.code, code.slice(0, 100)), eq(dmsDocuments.isActive, true), read)
        )
        .limit(1);
      if (!document) throw AppError.notFound("Document not found");
      return c.redirect(`/api/dms/render/${encodeURIComponent(document.slug)}`, 307);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // STATS (over what the asker sees)
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    "/stats",
    {
      id: "get-stats",
      summary: "DMS statistics",
      description:
        "Counts over the documents the caller can read: by status, versions and stored bytes, by type, the reviews due in the next 30 days and how many versions are pending the caller's review (admin: all).",
      access: "session",
      permission: ANY_ACCOUNT,
      output: { schema: Stats },
    },
    async (c) => {
      const u = user(c);
      const read = readFilter(u);
      const active = and(eq(dmsDocuments.isActive, true), read);

      const [docStats] = await dbInstance
        .select({
          total: sql<number>`count(*)::int`,
          published: sql<number>`count(*) filter (where ${dmsDocuments.status} = 'published')::int`,
          draft: sql<number>`count(*) filter (where ${dmsDocuments.status} = 'draft')::int`,
          archived: sql<number>`count(*) filter (where ${dmsDocuments.status} = 'archived')::int`,
        })
        .from(dmsDocuments)
        .where(active);

      /**
       * The sum goes in `bigint`: with `::int` the total overflowed as soon as the
       * files went over 2 GB across all versions (error 22003, which
       * brought the panel down). `pg` returns the `bigint` as text; `Number` leaves
       * it as an exact number up to 9 PB.
       */
      const [versionStats] = await dbInstance
        .select({
          total: sql<number>`count(*)::int`,
          totalSize: sql<number>`coalesce(sum(${dmsDocumentVersions.totalSizeBytes}), 0)::bigint`.mapWith(
            Number
          ),
        })
        .from(dmsDocumentVersions)
        .innerJoin(dmsDocuments, eq(dmsDocuments.id, dmsDocumentVersions.documentId))
        .where(active);

      const byType = await dbInstance
        .select({ type: dmsDocuments.type, count: sql<number>`count(*)::int` })
        .from(dmsDocuments)
        .where(active)
        .groupBy(dmsDocuments.type);

      const upcomingReviews = await dbInstance
        .select({
          id: dmsDocuments.id,
          code: dmsDocuments.code,
          title: dmsDocuments.title,
          reviewDueDate: dmsDocuments.reviewDueDate,
        })
        .from(dmsDocuments)
        .where(
          and(
            active,
            eq(dmsDocuments.status, "published"),
            gte(dmsDocuments.reviewDueDate, new Date()),
            lte(dmsDocuments.reviewDueDate, sql`NOW() + INTERVAL '30 days'`)
          )
        )
        .orderBy(asc(dmsDocuments.reviewDueDate))
        .limit(10);

      // Pending review: those THIS user is meant to review (admin: all).
      const [pendingApprovals] = await dbInstance
        .select({ count: sql<number>`count(*)::int` })
        .from(dmsDocumentVersions)
        .innerJoin(dmsDocuments, eq(dmsDocuments.id, dmsDocumentVersions.documentId))
        .where(
          and(
            eq(dmsDocumentVersions.status, "review_pending"),
            isAdmin(u)
              ? undefined
              : or(
                  sql`${dmsDocuments.reviewerIds} @> jsonb_build_array(${u.id}::text)`,
                  sql`${dmsDocuments.approverIds} @> jsonb_build_array(${u.id}::text)`
                )
          )
        );

      return c.json({
        documents: docStats,
        versions: versionStats,
        byType,
        upcomingReviews,
        pendingApprovals: pendingApprovals?.count || 0,
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // SEARCH
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    "/search",
    {
      id: "search-documents",
      summary: "Search documents",
      description:
        "Full-text search (Spanish) in the current published versions of the documents the caller can read, with a highlighted `snippet`; when nothing matches, falls back to title/code/description (`searchType: fallback`). Also returns up to 10 matching folders. `q` 2-200 characters (400 otherwise); filters `categoryId`, `type`, `status`; `limit` 1-50, default 20.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: {
        query: queryValue({
          q: textValue("Search text, 2-200 characters"),
          limit: textValue("1-50, default 20"),
          categoryId: textValue("Folder uuid"),
          type: textValue("Document type"),
          status: textValue("Document status"),
        }),
      },
      output: { schema: Search },
    },
    async (c) => {
      const u = user(c);
      const q = c.req.query("q");
      if (!q || q.length < 2) throw AppError.badRequest("Query must be at least 2 characters");
      if (q.length > 200) throw AppError.badRequest("Query too long");

      const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "20", 10) || 20, 1), 50);
      const queryFilters = c.req.query();
      const read = readFilter(u);

      const searchTerm = `%${q.toLowerCase()}%`;
      const likeConditions = or(
        like(sql`LOWER(${dmsDocuments.title})`, searchTerm),
        like(sql`LOWER(${dmsDocuments.code})`, searchTerm),
        like(sql`LOWER(${dmsDocuments.description})`, searchTerm)
      );

      const docFilters: SQL[] = [eq(dmsDocuments.isActive, true)];
      if (read) docFilters.push(read);
      if (queryFilters.categoryId && isUuid(queryFilters.categoryId)) {
        docFilters.push(eq(dmsDocuments.categoryId, queryFilters.categoryId));
      }
      const tip = docType(queryFilters.type);
      if (tip) docFilters.push(eq(dmsDocuments.type, tip));
      const est = docStatus(queryFilters.status);
      if (est) docFilters.push(eq(dmsDocuments.status, est));

      // Full text ONLY in published versions and of visible documents.
      const range = sql<number>`ts_rank(to_tsvector('spanish', COALESCE(${dmsDocumentVersions.content}, '')), plainto_tsquery('spanish', ${q}))`;
      const ftsResults = await dbInstance
        .select({
          id: dmsDocuments.id,
          code: dmsDocuments.code,
          title: dmsDocuments.title,
          slug: dmsDocuments.slug,
          description: dmsDocuments.description,
          type: dmsDocuments.type,
          status: dmsDocuments.status,
          currentVersionNumber: dmsDocuments.currentVersionNumber,
          versionNumber: dmsDocumentVersions.versionNumber,
          rank: range,
          snippet: sql<string>`ts_headline('spanish', COALESCE(${dmsDocumentVersions.content}, ''), plainto_tsquery('spanish', ${q}), 'StartSel=<mark>,StopSel=</mark>,MaxWords=35,MinWords=15')`,
        })
        .from(dmsDocuments)
        .innerJoin(dmsDocumentVersions, eq(dmsDocumentVersions.documentId, dmsDocuments.id))
        .where(
          and(
            ...docFilters,
            eq(dmsDocumentVersions.status, "published"),
            eq(dmsDocumentVersions.isLatest, true),
            sql`to_tsvector('spanish', COALESCE(${dmsDocumentVersions.content}, '')) @@ plainto_tsquery('spanish', ${q})`
          )
        )
        .orderBy(desc(range))
        .limit(limit);

      let documentResults: Record<string, unknown>[] = ftsResults;
      let searchType: "fulltext" | "fallback" = "fulltext";
      if (documentResults.length === 0) {
        searchType = "fallback";
        documentResults = await dbInstance
          .select({
            id: dmsDocuments.id,
            code: dmsDocuments.code,
            title: dmsDocuments.title,
            slug: dmsDocuments.slug,
            description: dmsDocuments.description,
            type: dmsDocuments.type,
            status: dmsDocuments.status,
            currentVersionNumber: dmsDocuments.currentVersionNumber,
          })
          .from(dmsDocuments)
          .where(and(...docFilters, likeConditions))
          .limit(limit);
      }

      const visible = await visibleCategories(u);
      let categories = await dbInstance
        .select({
          id: dmsCategories.id,
          name: dmsCategories.name,
          description: dmsCategories.description,
        })
        .from(dmsCategories)
        .where(
          and(
            eq(dmsCategories.isActive, true),
            or(
              like(sql`LOWER(${dmsCategories.name})`, searchTerm),
              like(sql`LOWER(${dmsCategories.description})`, searchTerm)
            )
          )
        )
        .limit(50);
      if (visible) categories = categories.filter((cat) => visible.has(cat.id));
      categories = categories.slice(0, 10);

      return c.json({
        documents: documentResults,
        categories,
        total: documentResults.length + categories.length,
        searchType,
      });
    }
  );

  return app.ops;
}

/**
 * The kon's router: the operations, with errors that are not `AppError`
 * (Postgres, body too large…) translated without internal details
 * (http-errors.ts), as always.
 */
export function createDMSRouter(ctx: KonContext): Hono {
  const router = new Hono();
  router.onError((err, c) => respondWithError(err, c, "dms"));
  router.route("/", operationsRouter(KON_ID, dmsOperations(ctx), ctx));
  return router;
}

export { createDMSRouter as dmsRoutes };

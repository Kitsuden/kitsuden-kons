/**
 * Who can do what with a DMS document.
 * ============================================================================
 *
 * ONE single definition, in two forms that have to say the same thing:
 *   · `permissions(doc, user, folderRoles)` — for the policy (one document)
 *   · `readFilter(user)` — SQL for the listings (many documents)
 * and a third, the RLS of migration 0005, which repeats the READ rule
 * in the database. If you change one, change all three (the tests watch it).
 *
 * Roles over a document:
 *   owner (`ownerId`) · author (`createdById`) → edit
 *   owner                                      → also manages ACL, deletes
 *   reviewers (`reviewerIds`)                  → review pending versions
 *   approvers (`approverIds`)                  → review and publish
 *   readers                                    → see the document and ONLY its
 *                                                published versions
 *
 * Who is a reader, according to `visibility`:
 *   private    → only `allowedUserIds`
 *   restricted → `allowedUserIds`, the group (`allowedRoleIds` ∋ the account's
 *                role) or the FOLDER (`dms_categories.allowedRoles` ∋ role)
 *   internal   → the above and, once published, the team (admin/editor)
 *   public     → the above and, once published, any account
 *
 * `public` is NOT "without a session": the entire DMS requires a session. And since account
 * sign-up is public, `public` means "anyone who registers" — which is
 * why it is only valid for PUBLISHED documents and the owner decides it.
 *
 * The admin can do everything: the human and an AGENT with `admin`, `dms:*` or
 * `kon:dms:*` (common engine rule, effective actor; in the database,
 * `kitsuden_effective_admin('dms')` inside `dms_is_system()`, migration 0007).
 */

import { isEffectiveAdmin } from "@kitsuden/engine";
import { sql, type SQL } from "drizzle-orm";

import { dmsDocuments } from "./dms.schema";

export interface DmsUser {
  id: string;
  role?: string;
  scopes?: string[];
}

export interface DocAcl {
  ownerId: string | null;
  createdById: string | null;
  reviewerIds: unknown;
  approverIds: unknown;
  allowedUserIds: unknown;
  allowedRoleIds: unknown;
  visibility: string;
  status: string;
}

export interface Permissions {
  view: boolean;
  /** See unpublished versions (drafts, in review…). */
  viewDrafts: boolean;
  edit: boolean;
  manage: boolean;
  review: boolean;
  publish: boolean;
}

export const VISIBILITIES = ["public", "internal", "restricted", "private"] as const;
export const TEAM_ROLES = ["admin", "editor"];

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export const isAdmin = (u: DmsUser | null | undefined) => isEffectiveAdmin(u, "dms");

export function permissions(
  doc: DocAcl,
  u: DmsUser | null | undefined,
  folderRoles: string[] = []
): Permissions {
  if (!u?.id) {
    return {
      view: false,
      viewDrafts: false,
      edit: false,
      manage: false,
      review: false,
      publish: false,
    };
  }
  if (isAdmin(u)) {
    return {
      view: true,
      viewDrafts: true,
      edit: true,
      manage: true,
      review: true,
      publish: true,
    };
  }
  const role = u.role ?? "";
  const owner = doc.ownerId === u.id;
  const author = doc.createdById === u.id;
  const reviewer = list(doc.reviewerIds).includes(u.id);
  const approver = list(doc.approverIds).includes(u.id);
  const edit = owner || author;
  const participates = edit || reviewer || approver;

  const published = doc.status === "published";
  const reader =
    list(doc.allowedUserIds).includes(u.id) ||
    (doc.visibility !== "private" &&
      (list(doc.allowedRoleIds).includes(role) ||
        folderRoles.includes(role) ||
        (published && doc.visibility === "public") ||
        (published && doc.visibility === "internal" && TEAM_ROLES.includes(role))));

  return {
    view: participates || reader,
    viewDrafts: participates,
    edit,
    manage: owner,
    review: reviewer || approver,
    publish: approver || owner,
  };
}

const json = (v: string) => sql`jsonb_build_array(${v}::text)`;

/**
 * SQL condition "the user can SEE this document" (the same as
 * `permissions().view`). `undefined` for the admin: no filtering.
 */
export function readFilter(u: DmsUser): SQL | undefined {
  if (isAdmin(u)) return undefined;
  const role = u.role ?? "";
  const d = dmsDocuments;
  return sql`(
    ${d.ownerId} = ${u.id}
    OR ${d.createdById} = ${u.id}
    OR ${d.reviewerIds} @> ${json(u.id)}
    OR ${d.approverIds} @> ${json(u.id)}
    OR ${d.allowedUserIds} @> ${json(u.id)}
    OR (${d.visibility} <> 'private' AND (
          ${d.allowedRoleIds} @> ${json(role)}
       OR (${d.categoryId} IS NOT NULL AND EXISTS (
             SELECT 1 FROM dms_categories c
             WHERE c.id = ${d.categoryId} AND c.allowed_roles @> ${json(role)}))
       OR (${d.status} = 'published' AND ${d.visibility} = 'public')
       OR (${d.status} = 'published' AND ${d.visibility} = 'internal'
           AND ${sql.raw(TEAM_ROLES.includes(role) ? "TRUE" : "FALSE")})
    ))
  )`;
}

/** Can they see THIS version? Published ones, whoever sees the document; the rest, whoever participates. */
export function canViewVersion(p: Permissions, version: { status: string }): boolean {
  return version.status === "published" ? p.view : p.viewDrafts;
}

/**
 * Policy "dms_document" and DMS gates.
 * ============================================================================
 *
 * The rules live in `dms.access.ts` (shared with the SQL filter of the
 * listings); here they are only registered in the engine's `can()`.
 *
 *   view · viewDrafts · edit · manage · review · publish
 *
 * Gates:
 *   dms:create      → admin or editor. Account sign-up is public: an
 *                    arbitrary account does not upload documents or files to the team's
 *                    DMS; it READS what is shared with it.
 *   dms:folders   → admin (folders carry an ACL: `allowedRoles`).
 *   dms:auditoria  → admin (the access log of the whole DMS).
 *
 * An agent passes with scopes `dms_document:view`, `gate:dms:create`…; without them,
 * nothing. With `admin`, `dms:*` or `kon:dms:*` it is DMS ADMIN (also in the
 * RLS, migration 0007); with individual scopes, the RLS only shows it the rows
 * shared with it by id, just like a person.
 */

import { actsAsUserIn, defineGate, definePolicy, isEffectiveAdmin, isEffectiveStaff } from "@kitsuden/engine";


import { permissions, type DocAcl, type DmsUser } from "./dms.access";

export interface DocumentResource {
  doc: DocAcl;
  folderRoles: string[];
}

const rule =
  (action: "view" | "viewDrafts" | "edit" | "manage" | "review" | "publish") =>
  (u: unknown, r: DocumentResource) =>
    Boolean(r?.doc) && permissions(r.doc, u as DmsUser | null, r.folderRoles)[action];

export function registerDmsPolicy(): void {
  definePolicy<DocumentResource>("dms_document", {
    view: rule("view"),
    viewDrafts: rule("viewDrafts"),
    edit: rule("edit"),
    manage: rule("manage"),
    review: rule("review"),
    publish: rule("publish"),
    /**
     * Enter the DMS as an account (all its operations). Before, the host's
     * `requireAuth` decided this, which lets an AGENT through only as an
     * account with `user:act`, `admin` or some scope of the kon (`dms:…`,
     * `kon:dms:…`; `agent-as-user.ts`). SDK operations do not go
     * through that rule, so it is repeated here, as is. Note: `dms_document:view`
     * or `gate:dms:create` are NOT of that family (they do not start with `dms:`); they
     * were not for the host either, and it is not widened on migrating.
     */
    actAsUser: actsAsUserIn("dms"),
  });
  defineGate("dms:create", (u) => isEffectiveStaff(u, "dms"));
  defineGate("dms:folders", (u) => isEffectiveAdmin(u, "dms"));
  defineGate("dms:auditoria", (u) => isEffectiveAdmin(u, "dms"));
}

registerDmsPolicy();

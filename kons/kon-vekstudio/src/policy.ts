/**
 * kon-vekstudio — authorization policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "vekstudio" policy.
 *
 * The proxy injects the SERVER's OCR gateway key. With only
 * `requireAuth` (and public sign-up) any account used that key to list
 * everyone's jobs, download their documents, retrain the model or change
 * which model is active. Now:
 *
 *   · `submit`  — upload documents to OCR: the team (admin, editor).
 *   · `view` / `edit` on ONE document: admin, or whoever sent it.
 *   · `operate`  — everything global on the gateway (job list, live events,
 *     corrections, training, models): admin only.
 */
import { actsAsUserIn, type AuthzUser, can, definePolicy } from "@kitsuden/engine";

export interface OcrDocumentRecord {
  jobId?: string;
  createdBy?: string | null;
}

const isAdmin = (u: AuthzUser | null) => u?.role === "admin";
const isTeam = (u: AuthzUser | null) => u?.role === "admin" || u?.role === "editor";
const isTheirs = (u: AuthzUser | null, d: OcrDocumentRecord) =>
  Boolean(u?.id) && Boolean(d?.createdBy) && d.createdBy === u?.id;

/**
 * The sender rule for EVERY caller, agents included. The engine's `can` lets a scope stand in for
 * a failed rule (`vekstudio:view`, `vekstudio:edit`, the fine `kon:vekstudio:get-document`), so
 * on its own the policy above binds human editors only: an agent with one of those scopes opened
 * anyone's document. The routes on one document ask this too, after the policy: the caller sent
 * the document, or may `operate` the whole gateway (human admin, an agent with `admin`,
 * `vekstudio:*` or `vekstudio:operate`). A job missing from the mirror has no sender, so only an
 * operator reaches it.
 */
export async function ownsOrOperates(
  u: AuthzUser | null,
  d: OcrDocumentRecord | null | undefined
): Promise<boolean> {
  if (!u?.id) return false;
  if (d && isTheirs(u, d)) return true;
  return can(u, "operate", {}, "vekstudio");
}

export function registerVekstudioPolicy(): void {
  definePolicy<OcrDocumentRecord>("vekstudio", {
    submit: (u) => isTeam(u),
    view: (u, d) => isAdmin(u) || (isTeam(u) && isTheirs(u, d)),
    edit: (u, d) => isAdmin(u) || (isTeam(u) && isTheirs(u, d)),
    operate: (u) => isAdmin(u),

    /**
     * The routes on ONE document (`/documents/:jobId`). They used to be opened by the host's
     * `requireAuth`, which lets an AGENT through only as an
     * account with `user:act`, `admin` or some vekstudio scope
     * (`agent-as-user.ts`); `view`/`edit` are checked afterwards, on the
     * row. SDK operations do not go through that rule, so it is repeated
     * here, as is.
     */
    actAsUser: actsAsUserIn("vekstudio"),
  });
}

registerVekstudioPolicy();

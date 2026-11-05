/**
 * CRM — Authorization policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "crm" policy.
 *
 * A CRM is the sales team's client portfolio: emails, phones,
 * amounts and notes of people who are NOT Kitsuden users and who have not
 * agreed to be seen by anyone with an account. And sign-up is public: before
 * this review, registering was enough to read, edit or delete the entire CRM
 * (all routes used only `requireAuth`).
 *
 *   · anonymous, user  → nothing.
 *   · team (admin, editor) → works the portfolio: view, create, edit,
 *     move deals, activities and documents.
 *   · admin → in addition DELETES contacts/companies/deals (destroys
 *     history; it is the action of a right to erasure) and touches
 *     CONFIGURATION: pipelines, stages, stage requirements, entities. And is
 *     the only one who moves a deal skipping the stage requirements.
 *   · an activity or a document is deleted by whoever created it, or an admin.
 *
 * An agent with scope `crm:<action>` passes the corresponding rule (the engine
 * grants it only for actions this policy defines).
 */
import { definePolicy, isEffectiveAdmin, isEffectiveStaff, type AuthzUser } from "@kitsuden/engine";

/**
 * Team = human admin or editor, or an AGENT with the scope of the whole CRM
 * (`admin`, `crm:*`, `kon:crm:*`): the engine's common rule (effective actor).
 */
export function isCrmTeam(user: AuthzUser | null): boolean {
  return isEffectiveStaff(user, "crm");
}

function isAdmin(user: AuthzUser | null): boolean {
  return isEffectiveAdmin(user, "crm");
}

/** Resource with an author (activity: `createdBy`; document: `uploadedBy`). */
export interface WithAuthor {
  author: string | null;
}

export function registerCrmPolicy(): void {
  definePolicy<unknown>("crm", {
    view: (user) => isCrmTeam(user),
    edit: (user) => isCrmTeam(user),
    delete: (user) => isAdmin(user),
    configure: (user) => isAdmin(user),
    skipValidation: (user) => isAdmin(user),
    // What this grants is applied by `crm_access()`; this line makes `crm:read-all` a scope the engine accepts.
    "read-all": (user) => isAdmin(user),
  });

  definePolicy<WithAuthor>("crm-authorship", {
    delete: (user, r) => isAdmin(user) || (isCrmTeam(user) && !!r.author && r.author === user?.id),
  });
}

registerCrmPolicy();

/**
 * Directory — Authorization policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the policies.
 *
 * A directory is meant to be SEEN, but not everything in a record is directory:
 * the date of birth, the emergency contact, the salary band or the ID number
 * of a document are HR data. The model:
 *
 *   · anonymous / user without a record → "public record" of active, visible
 *     employees: name, photo, position, department, bio and links the employee
 *     publishes themselves. No emails or phones.
 *   · colleague (user with an ACTIVE record in the same organization) → in addition
 *     work email, phone and time zone of those in THEIR organization.
 *   · the employee themselves → their whole record; they edit ONLY the personal parts (bio,
 *     photo, phones, links, emergency contact, visibility); they see their
 *     non-confidential documents.
 *   · admin = HR → everything. An `editor` is on the CONTENT team, not on
 *     staff: here they have no more than any user.
 *
 * Account sign-up is public: "having a session" gives nothing by itself.
 */
import { definePolicy, isEffectiveAdmin, type AuthzUser } from "@kitsuden/engine";

/** HR: the human admin or an agent with the whole kon (`admin`, `directory:*`). */
export function isHr(user: AuthzUser | null): boolean {
  return isEffectiveAdmin(user, "directory");
}

export interface EmployeeResource {
  userId: string | null;
  organizationId: string;
  isActive: boolean;
  visibleInDirectory: boolean | null;
}

/** Who asks, seen from the directory: their organizations as an employee. */
export interface Viewer {
  user: AuthzUser | null;
  /** Organizations where the user has an active record. */
  organizations: Set<string>;
}

export interface DocumentResourceRow {
  isConfidential: boolean | null;
  employee: EmployeeResource;
}

function isSame(user: AuthzUser | null, e: EmployeeResource): boolean {
  return !!user?.id && !!e.userId && e.userId === user.id;
}

export function registerDirectoryPolicy(): void {
  definePolicy<EmployeeResource>("directory-employee", {
    viewPublic: (user, e) =>
      isHr(user) || isSame(user, e) || (e.isActive && e.visibleInDirectory !== false),
    viewFull: (user, e) => isHr(user) || isSame(user, e),
    updateSelf: (user, e) => isSame(user, e) && e.isActive,
    manage: (user) => isHr(user),
  });

  // Organizations, departments and positions: the structure is public; HR
  // writes it.
  definePolicy<unknown>("directory-structure", {
    view: () => true,
    manage: (user) => isHr(user),
  });

  definePolicy<DocumentResourceRow>("directory-document", {
    view: (user, d) => isHr(user) || (isSame(user, d.employee) && d.isConfidential !== true),
    manage: (user) => isHr(user),
  });

  // Statistics of an organization (how many on leave, etc.).
  definePolicy<{ organizationId: string; visor: Viewer }>("directory-stats", {
    view: (user, r) => isHr(user) || r.visor.organizations.has(r.organizationId),
  });
}

registerDirectoryPolicy();

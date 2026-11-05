/**
 * Academy LMS — authorization policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "academy" policy.
 *
 * ── THE ROLE THAT DECIDES IS THE ACADEMY'S ──────────────────────────────────
 * The routes asked the host's middleware for `requireRole(["administrator", "supervisor"])`,
 * which compares against the account's GLOBAL role
 * (`admin`/`editor`/`user`). No user has a global "supervisor" role, so
 * all management answered 403 even to the admin… while the routes WITHOUT
 * `requireRole` (module and quiz detail with the correct answers,
 * groups with their members, completing topics of any course) were left
 * open to any account: sign-up is public.
 *
 * Now the actor carries `academyRole`, read from `training_user_profiles`
 * (and only if the profile is `active`). That profile is created by an administrator:
 * nobody assigns it to themselves.
 *
 *   · manage      — content, assignments, reports: global admin,
 *                   academy administrator or supervisor.
 *   · administer  — deleting, learning paths, groups, profiles and roles,
 *                   synchronization: global admin or administrator.
 *   · viewCourse    — viewing a course's content: whoever manages, or the
 *                   ASSIGNED student (directly or by group).
 *   · actAsUser — the "any account" routes (see my courses,
 *                   complete topics, answer quizzes…). See the action.
 */
import { actsAsUserIn, agentCanInKon, type AuthzUser, definePolicy } from "@kitsuden/engine";

export type AcademyRole = "administrator" | "supervisor" | "student";

export interface AcademyActor extends AuthzUser {
  academyRole?: AcademyRole | null;
}

export interface CourseForStudent {
  id: string;
  assigned: boolean;
  active?: boolean;
}

/** The kon's short name, the one its scopes use (`academy-lms:*`, `kon:academy-lms:*`). */
const SHORT_NAME = "academy-lms";

/**
 * An AGENT that administers the academy: `academy:administer` (or `academy:*`), or a scope that
 * opens the whole kon (`admin`, `academy-lms:*`, `kon:academy-lms:*`), and no denial. The same
 * rule as `academy_agent_administers()` in `migrations/0009_agent_scopes_rls.sql`.
 */
export const agentAdministersAcademy = (u: AcademyActor | null): boolean =>
  agentCanInKon(u, SHORT_NAME, "academy:administer");

/**
 * An AGENT that manages the academy: `academy:manage`, or administers it. It manages every
 * learner: an agent has no groups to be limited to. SQL: `academy_agent_manages()`.
 */
export const agentManagesAcademy = (u: AcademyActor | null): boolean =>
  agentCanInKon(u, SHORT_NAME, "academy:manage") || agentAdministersAcademy(u);

export const managesAcademy = (u: AcademyActor | null): boolean =>
  u?.role === "admin" ||
  u?.academyRole === "administrator" ||
  u?.academyRole === "supervisor" ||
  agentManagesAcademy(u);

export const administersAcademy = (u: AcademyActor | null): boolean =>
  u?.role === "admin" || u?.academyRole === "administrator" || agentAdministersAcademy(u);

export function registerAcademyPolicy(): void {
  definePolicy<unknown>("academy", {
    manage: (u) => managesAcademy(u as AcademyActor | null),
    administer: (u) => administersAcademy(u as AcademyActor | null),
    /**
     * The "any account" routes. A person always gets in; an AGENT
     * only with the host's usual rule (`agent-as-user.ts`):
     * `user:act`, `admin` or some academy scope. SDK operations
     * do not go through that rule, so it is repeated here, as is.
     */
    actAsUser: actsAsUserIn("academy-lms"),
  });
  definePolicy<CourseForStudent>("academy-course", {
    view: (u, course) =>
      managesAcademy(u as AcademyActor | null) ||
      (Boolean(u?.id) && course.assigned && course.active !== false),
  });
}

registerAcademyPolicy();

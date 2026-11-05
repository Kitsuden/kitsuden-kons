/**
 * Policy "agile_project" — project membership.
 * ============================================================================
 *
 *   view       → admin, or any role in the project (owner/member/viewer)
 *   propose    → same as view: an intake is a PROPOSAL that someone with
 *                write rights will approve or not
 *   write      → admin, owner or member (issues, comments, cycles,
 *                modules, deciding intakes)
 *   manage     → admin or owner (project members)
 *
 * Gate "agile:create-project": admin or editor. Account sign-up is public:
 * an arbitrary account does not open projects on the team's board (nor take up
 * identifiers); whoever runs a project ADDS it to the project.
 *
 * The role in the project is computed by the route (row in `agile_project_members`,
 * or implicit owner if they created the project) and travels in the resource. An agent
 * gets in just like a person: as a project MEMBER; an `agile_project:*`
 * scope would open the policy to it, but RLS would still deny it the
 * rows, so the right way is to add it as a member.
 *
 * Policy "agile" — `actAsUser` (2026-10-26, when the routes moved to the SDK):
 * the board routes asked for a session with the host's `requireAuth`, which lets
 * an AGENT through only as an account with `user:act`, `admin` or
 * some agile scope (`agent-as-user.ts`). SDK operations do not
 * go through that rule, so it is repeated here, as is (operations.ts,
 * `ANY_ACCOUNT`). The resource is named like the kon (`agile`) so that the
 * scope that grants it is the family's (`agile:…`), not `agile_project:…`.
 */

import { actsAsUserIn, type AuthzUser, defineGate, definePolicy } from "@kitsuden/engine";

import type { ProjectRole } from "./agile.schema";

export interface ProjectResource {
  projectId: string;
  role: ProjectRole | null;
}

type User = { role?: unknown } | null;

const isAdmin = (u: User) => u?.role === "admin";

export function registerAgilePolicy(): void {
  definePolicy<ProjectResource>("agile_project", {
    view: (u, p) => isAdmin(u) || p?.role != null,
    propose: (u, p) => isAdmin(u) || p?.role != null,
    write: (u, p) => isAdmin(u) || p?.role === "owner" || p?.role === "member",
    manage: (u, p) => isAdmin(u) || p?.role === "owner",
  });
  definePolicy<unknown>("agile", {
    actAsUser: actsAsUserIn("agile"),
  });
  defineGate("agile:create-project", (u) => u?.role === "admin" || u?.role === "editor");
}

registerAgilePolicy();

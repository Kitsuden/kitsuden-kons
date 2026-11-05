/**
 * Policy "conta" — who gets into the accounting.
 * ============================================================================
 *
 * Accounting has no rows "belonging to someone": it is ONE general ledger. The question
 * is not "is this entry yours?" but "are you on the accounting team?".
 *
 *   view        → admin, or conta role `accountant` / `viewer`
 *   write       → admin, or conta role `accountant`
 *   administer  → admin only (grant permissions, seed the chart of accounts)
 *
 * The conta role is NOT `auth_users.role` (admin/editor/user, and sign-up is
 * public): it comes from the `conta_permissions` table and travels in the resource. A
 * website `editor` does not see the accounting just for being one.
 *
 * An agent passes with the scope `conta:view` / `conta:write` / `conta:*`
 * (resolved by `can()`). The fine scope of one operation (`kon:conta:<operation>`) is
 * accepted by the route next to this policy (`grantedByFineScope`, conta.routes.ts).
 */

import { definePolicy, isEffectiveAdmin } from "@kitsuden/engine";

import type { ContaRole } from "./conta.schema";

export interface ContaResource {
  /** Role in `conta_permissions` of the asker, or null if they have none. */
  contaRole: ContaRole | null;
}

type User = { role?: unknown; scopes?: unknown; contaRole?: unknown } | null;

/** Human admin or agent with the whole kon (`admin`, `conta:*`): common engine rule. */
const isAdmin = (u: User) => isEffectiveAdmin(u, "conta");

/**
 * The conta role: the resource's if it arrives, and otherwise the one the router left on the
 * user (`withContaRole`, conta.routes.ts). Since the move to the kon SDK,
 * each operation's declared permission is checked with an EMPTY
 * resource before validating; the role then travels on the user, read from
 * `conta_permissions` in the same request. It is never set by the client: the user
 * comes from the session and the router always overwrites the field.
 */
function roleOf(u: User, r: Partial<ContaResource> | null | undefined): unknown {
  if (r && r.contaRole !== undefined) return r.contaRole;
  return u?.contaRole ?? null;
}

export function registerContaPolicy(): void {
  definePolicy<Partial<ContaResource>>("conta", {
    view: (u, r) => isAdmin(u) || roleOf(u, r) === "accountant" || roleOf(u, r) === "viewer",
    write: (u, r) => isAdmin(u) || roleOf(u, r) === "accountant",
    administer: (u) => isAdmin(u),
  });
}

registerContaPolicy();

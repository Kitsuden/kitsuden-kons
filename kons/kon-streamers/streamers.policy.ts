/**
 * Streamers — authorization policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "streamer" policy.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * This kon's writes asked only for `requireAuth`, and account sign-up is
 * public: anyone with a session could add, rename or delete the
 * streamers shown on the site, or mark
 * anyone «live» with `POST /sync/status`. A prefix rule in
 * `auth-guard.ts` covered it («staff only for writes to /api/streamers»).
 * With this policy the kon defends itself and that rule stops being the only
 * line.
 *
 * Reading stays public: it is the site's showcase.
 *
 * An agent needs `streamer:<action>` (or `streamer:*`); the content scope
 * (`content:edit`) is not enough, just as today in the prefix rule.
 */

import { definePolicy, type AuthzUser } from "@kitsuden/engine";

function isStaff(user: AuthzUser | null): boolean {
  return user?.role === "admin" || user?.role === "editor";
}

/**
 * Exported so it can be re-registered: the policy registry is a
 * process singleton and `resetAuthz()` (typical between tests) empties it.
 */
export function registerStreamersPolicy(): void {
  definePolicy("streamer", {
    create: (user) => isStaff(user),
    update: (user) => isStaff(user),
    delete: (user) => isStaff(user),
    /** The sync job (or whoever launches it by hand) updates the live status. */
    sync: (user) => isStaff(user),
  });
}

registerStreamersPolicy();

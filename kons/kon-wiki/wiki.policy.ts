/**
 * Wiki — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "wiki" policy.
 *
 * It is READ without a session, EDITED by the team (see below), and `protection: "locked"`
 * reserves a specific page to management.
 *
 * Deleting is admin-only and on purpose: in a wiki you do not delete, you revert —
 * and deleting a page takes its history with it, which is the irreplaceable part.
 */
import { definePolicy, type AuthzUser } from "@kitsuden/engine";

export interface WikiResource {
  id: string;
  protection?: string | null;
}

/**
 * ── WHO EDITS (2026-10-15) ─────────────────────────────────────────────────
 *
 * Until then "any session" could edit, and account registration is public: with
 * a freshly created account any `open` page of the wikis the team writes
 * (all of them in production) could be rewritten, and the change went live
 * immediately, without moderation. An agent with ANY scope also
 * got through, because the rule only checked that there was a user.
 *
 * Now the TEAM (`admin`/`editor`) edits; `locked` is still `admin` only. An
 * agent needs the `wiki:create` / `wiki:update` scope. Opening editing to the
 * community is a product decision that first requires moderation (revision queue,
 * per-account limit); the public site has no edit form today, so this takes nothing from it.
 */
const isStaff = (user: AuthzUser | null | undefined): boolean =>
  user?.role === "admin" || user?.role === "editor";

export function registerWikiPolicy(): void {
  definePolicy<WikiResource>("wiki", {
    view: () => true,
    create: (user: AuthzUser | null) => isStaff(user),
    update: (user, item) =>
      user?.role === "admin" || (isStaff(user) && item?.protection !== "locked"),
    delete: (user) => user?.role === "admin",
  });
}

/**
 * Creating a whole WIKI is different from creating a page.
 *
 * A wiki is a subdomain: part of the site's identity and, in production,
 * a TLS certificate issued on demand. Opening it to any session would allow
 * filling the domain with subdomains with whatever name each person wanted. The
 * PAGES inside remain open to the community.
 */
export function registerWikiSpacePolicy(): void {
  definePolicy<{ id: string }>("wiki-space", {
    view: () => true,
    create: (user) => user?.role === "admin",
    update: (user) => user?.role === "admin",
    delete: (user) => user?.role === "admin",
  });
}

registerWikiPolicy();
registerWikiSpacePolicy();

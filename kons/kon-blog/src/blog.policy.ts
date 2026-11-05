/**
 * Blog — authorization policy
 * ============================================================================
 *
 * Until 2026-10-15 blog writes only required `requireAuth`: with
 * open sign-up, "having an account" was enough to create, rewrite, publish or
 * delete any entry. It was covered by a prefix rule in
 * `apps/api/src/middleware/auth-guard.ts` (`/api/blog` → staff). This policy
 * makes the kon authorize ITSELF: removing that prefix no longer opens anything.
 *
 * Deny-by-default (`can()` denies whatever has no rule). An agent gets through with
 * its scope `blog_post:<action>` / `blog_category:<action>` or `admin` (resolved
 * by the engine); NOT through `content:edit`, which the blog gate never
 * admitted.
 *
 * `registerBlogPolicy()` is exported because the registry is a process
 * singleton and `resetAuthz()` (tests) empties it. See kon-broadcast.
 */
import { definePolicy, isEffectiveStaff, type AuthzUser } from "@kitsuden/engine";

/** The team that writes the site. The same roles as `requireStaff`. */
/** Human admin/editor, or an agent with the whole blog (`admin`, `blog:*`, `kon:blog:*`). */
export function isTeam(user: AuthzUser | null | undefined): boolean {
  return isEffectiveStaff(user, "blog");
}

export function registerBlogPolicy(): void {
  definePolicy("blog_post", {
    /** See drafts, scheduled and archived (and the source row). */
    viewUnpublished: (u) => isTeam(u),
    create: (u) => isTeam(u),
    update: (u) => isTeam(u),
    publish: (u) => isTeam(u),
    delete: (u) => isTeam(u),
    /** Promote from a dataset entry. */
    promote: (u) => isTeam(u),
    /**
     * Promote from ANY TABLE (`sourceType: "kon"`): reads the
     * whole row with `SELECT *`. Admin only, and also with a list of banned tables
     * in the route.
     */
    promoteFromTable: (u) => u?.role === "admin",
    /** Editor tools (validate SEO, image, refresh the OG cache). */
    useTools: (u) => isTeam(u),
  });

  definePolicy("blog_category", {
    create: (u) => isTeam(u),
    update: (u) => isTeam(u),
    delete: (u) => isTeam(u),
  });
}

registerBlogPolicy();

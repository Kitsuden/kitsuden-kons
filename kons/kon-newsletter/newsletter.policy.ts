/**
 * Kitsuden Newsletter — authorization policy
 * ============================================================================
 * Importing this module registers the "newsletter" policy.
 *
 * A single action, `administer`: everything that is not public (members,
 * suppressions, segments, campaigns) belongs to the administrator. It is the rule
 * the router's `admin.use("*")` used to apply by hand —the human admin, or an
 * agent with `admin`, `newsletter:*` or `kon:newsletter:*` (common engine
 * rule; in the database, 0003_effective_admin.sql)— and now each SDK
 * operation declares it in its `permission`.
 */

import { definePolicy, isEffectiveAdmin } from "@kitsuden/engine";

/**
 * Exported so it can be re-registered: the policy registry is a
 * process singleton and `resetAuthz()` (typical between tests) empties it.
 */
export function registerNewsletterPolicy(): void {
  definePolicy("newsletter", {
    administer: (user) => isEffectiveAdmin(user, "newsletter"),
  });
}

registerNewsletterPolicy();

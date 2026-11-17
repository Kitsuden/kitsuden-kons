/**
 * Listings — authorization policy
 * ============================================================================
 * Deny-by-default: an action with no rule is denied. Importing this module registers the policies.
 * `registerListingsPolicy()` exists because tests call `resetAuthz()`.
 *
 *   listings-item     anyone (anonymous too) sees what is PUBLISHED; the kon's team sees every
 *                     status and creates, edits and deletes.
 *   listings-feed     the team only: a feed's token is what lets a portal read it.
 *   listings-inquiry  the team only: names, emails and phones of people who asked.
 *
 * "The team" is a human admin or editor, or an agent that opens the whole kon (`listings:*`,
 * `kon:listings:*`, `admin`): `isEffectiveStaff`. `actsAsUserIn("listings")` is the core's rule for
 * an agent using routes meant for any signed-in account.
 */
import { actsAsUserIn, definePolicy, isEffectiveStaff, type AuthzUser } from "@kitsuden/engine";

export function isStaff(user: AuthzUser | null): boolean {
  return isEffectiveStaff(user, "listings");
}

export interface ListingsResource {
  status: string;
}

export function registerListingsPolicy(): void {
  definePolicy<ListingsResource | null>("listings-item", {
    view: (user, item) => isStaff(user) || item?.status === "published",
    create: (user) => isStaff(user),
    update: (user) => isStaff(user),
    delete: (user) => isStaff(user),
    actAsUser: actsAsUserIn("listings"),
  });
  definePolicy<null>("listings-feed", {
    view: (user) => isStaff(user),
    create: (user) => isStaff(user),
    update: (user) => isStaff(user),
    delete: (user) => isStaff(user),
    actAsUser: actsAsUserIn("listings"),
  });
  definePolicy<null>("listings-inquiry", {
    view: (user) => isStaff(user),
    delete: (user) => isStaff(user),
    actAsUser: actsAsUserIn("listings"),
  });
}

registerListingsPolicy();

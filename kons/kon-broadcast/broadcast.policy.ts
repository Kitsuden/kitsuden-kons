/**
 * Broadcast — Authorization Policy
 * ============================================================================
 * Deny-by-default: an action without a rule is denied. Importing this module
 * registers the "broadcast" policy.
 *
 * Model of a real tournament: the operator who creates the set is its owner and operates it;
 * admins (production management) can touch any set. The overlay
 * does NOT go through here — it is a public read-only route, see broadcast.routes.ts.
 */
import { actsAsUserIn, type AuthzUser, definePolicy } from "@kitsuden/engine";

export interface BroadcastResource {
  id: string;
  status?: string | null;
  ownerId?: string | null;
}

/**
 * Registers the "broadcast" policy.
 *
 * It is invoked on importing the module, but exported on purpose: the policy
 * registry is a process singleton, and whoever empties it (`resetAuthz()`, typical
 * between tests) would leave this kon without rules — and deny-by-default would turn
 * every operation into a 403. Being able to re-register avoids depending on the import
 * effect surviving.
 */
export function registerBroadcastPolicy(): void {
  definePolicy<BroadcastResource>("broadcast", {
    // A "live" set is visible to the whole authenticated production team:
    // the scoreboard that goes on air is a secret to nobody on staff.
    view: (user: AuthzUser | null, item) =>
      item.status === "live" ||
      user?.role === "admin" ||
      (!!item.ownerId && item.ownerId === user?.id),

    // Any operator can build a set; you do not need to be admin to
    // work at a production station.
    create: (user) => user?.role === "admin" || user?.role === "editor",

    // Operating the live scoreboard: only its owner or management. It prevents two
    // stations from overwriting each other's score of the same set.
    update: (user, item) => user?.role === "admin" || (!!item.ownerId && item.ownerId === user?.id),

    // Deleting set history stays with management.
    delete: (user) => user?.role === "admin",

    /**
     * The routes that used to require only a session (list and view sets, games,
     * adapters). They were opened by the host's `requireAuth`, which lets an AGENT through
     * only as an account with `user:act`, `admin` or some
     * broadcast scope (`agent-as-user.ts`). SDK operations do not
     * go through that rule, so it is repeated here, as is.
     */
    actAsUser: actsAsUserIn("broadcast"),
  });
}

registerBroadcastPolicy();

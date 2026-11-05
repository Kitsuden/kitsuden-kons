/**
 * Autobattler — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "autobattler" policy.
 *
 * The SET is editorial (uploaded by whoever administers, queried by everyone without an
 * account). The COMP belongs to its author. And `rank` is separate: setting the tier list
 * tier is site curation, not a permission the author has over their
 * own comp — if it were the same, everyone would put themselves in S.
 */
import { actsAsUserIn, type AuthzUser, definePolicy } from "@kitsuden/engine";

export interface AutobattlerResource {
  id: string;
  authorId?: string | null;
  ownerId?: string | null;
  status?: string | null;
}

const isAdmin = (u: AuthzUser | null) => u?.role === "admin" || u?.role === "editor";
const isMine = (u: AuthzUser | null, r: AutobattlerResource) => {
  const owner = r.authorId ?? r.ownerId;
  return Boolean(owner) && owner === u?.id;
};

export function registerAutobattlerPolicy(): void {
  definePolicy<AutobattlerResource>("autobattler", {
    // Checking synergies and looking at comps should not require an account: it is what
    // people come to a comps site for.
    view: (user, item) => item.status !== "hidden" || isAdmin(user) || isMine(user, item),
    create: (user: AuthzUser | null) => Boolean(user?.id),
    /**
     * Uploading or rewriting a SET (POST /sets/import) is editorial: it is the
     * game data everyone consults. Before, the route asked for
     * `create` —any account, and sign-up is open— and it was only covered by the
     * prefix rule in `auth-guard.ts`. An agent gets through with
     * `autobattler:import` (or `autobattler:*`).
     */
    import: (user) => isAdmin(user),
    update: (user, item) => isAdmin(user) || isMine(user, item),
    delete: (user, item) => isAdmin(user) || isMine(user, item),
    /** Tier list tier and hide: the site's, not the author's. */
    rank: (user) => isAdmin(user),

    /**
     * The routes that require a session. Before, the host's `requireAuth` opened them,
     * which lets an AGENT through only as an account with
     * `user:act`, `admin` or some autobattler scope
     * (`agent-as-user.ts`). SDK operations do not go through that
     * rule, so it is repeated here, as is (as in kon-esports).
     */
    actAsUser: actsAsUserIn("autobattler"),
  });
}

registerAutobattlerPolicy();

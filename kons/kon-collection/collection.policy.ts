/**
 * Collection — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "collection" policy.
 *
 * There are no two natures here: EVERY mark belongs to someone. There is no public
 * read — not even read-only — because what someone has or lacks
 * is theirs: whoever wants to show their collection will do so by sharing it, and that
 * will be another thing with its own decision.
 *
 * An admin can see them for support and to delete them if someone asks; not
 * to show them on any page.
 */
import { actsAsUserIn, type AuthzUser, definePolicy } from "@kitsuden/engine";

export interface CollectionResource {
  userId?: string | null;
}

const theirs = (user: AuthzUser | null, item: CollectionResource) =>
  user?.role === "admin" || (!!item.userId && item.userId === user?.id);

export function registerCollectionPolicy(): void {
  definePolicy<CollectionResource>("collection", {
    view: theirs,
    // A PERSON with a session. An agent (`role: "agent"`) needs its scope
    // (`collection:create`, `collection:*`, `admin`), which `can()` grants:
    // before, an agent with only `mcp:connect` could mark (phase D).
    create: (user) => Boolean(user?.id) && user?.role !== "agent",
    update: theirs,
    delete: theirs,

    /**
     * Read or empty MY collection: what used to ask only for `requireAuth`. People
     * with a session, all of them. An AGENT, only with the host's rule
     * for `requireAuth` — `user:act`, `admin` or some scope of the kon
     * (`agent-as-user.ts`)—. SDK operations do not go through that
     * rule, so it is repeated here, as is.
     */
    actAsUser: actsAsUserIn("collection"),
  });
}

registerCollectionPolicy();

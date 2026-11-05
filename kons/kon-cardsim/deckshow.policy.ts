/**
 * DeckShow — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "deckshow" policy.
 *
 * Four actions and one that is not obvious: `moderate`. Featuring and hiding are NOT
 * "update with more permissions" — they belong to whoever runs the site, never to the author.
 * If they were the same action, anyone could feature themselves.
 */
import { actsAsUserIn, type AuthzUser, definePolicy } from "@kitsuden/engine";

export interface DeckshowResource {
  id: string;
  status?: string | null;
  authorId?: string | null;
}

const isAdmin = (user: AuthzUser | null) => user?.role === "admin" || user?.role === "editor";
const isAuthor = (user: AuthzUser | null, item: DeckshowResource) =>
  Boolean(item.authorId) && item.authorId === user?.id;

export function registerDeckshowPolicy(): void {
  definePolicy<DeckshowResource>("deckshow", {
    /**
     * A showcase is viewed without an account: that is its reason for being. What is hidden is seen only
     * by its author and moderation — and the author must be able to see it to
     * read why it was hidden.
     */
    view: (user, item) => item.status !== "hidden" || isAdmin(user) || isAuthor(user, item),

    // A PERSON with a session. An agent (`role: "agent"`) needs its scope
    // (`deckshow:create`, `deckshow:*`, `admin`), which `can()` grants:
    // before, one with only `mcp:connect` saved decks (phase D).
    create: (user: AuthzUser | null) => Boolean(user?.id) && user?.role !== "agent",
    update: (user, item) => isAdmin(user) || isAuthor(user, item),
    delete: (user, item) => isAdmin(user) || isAuthor(user, item),

    /** Feature and hide. The site's, not the author's. */
    moderate: (user) => isAdmin(user),

    /**
     * The routes that ask for a session. They used to be opened by the host's
     * `requireAuth`, which lets an AGENT through only as an account with
     * `user:act`, `admin` or some deckshow scope
     * (`agent-as-user.ts`). SDK operations do not go through that
     * rule, so it is repeated here, as is (as in kon-esports).
     */
    actAsUser: actsAsUserIn("deckshow"),
  });
}

registerDeckshowPolicy();

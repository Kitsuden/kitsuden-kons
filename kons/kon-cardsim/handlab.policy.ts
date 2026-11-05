/**
 * HandLab — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "handlab" policies
 * (datasets) and "handlab-deck" (decks).
 *
 * A DATASET is editorial: whoever administers uploads it and everyone queries
 * it. A DECK is personal. They are two different natures, and that is why the
 * kon does not have a single rule for both.
 *
 * Audit: dataset `create` was `Boolean(user?.id)` — any account (public
 * sign-up) published catalogs of up to 30,000 cards with names and `imageUrl`
 * of its choosing, which are then served to everyone. Now creating, editing
 * and deleting datasets belongs to the team.
 */
import { actsAsUserIn, type AuthzUser, definePolicy } from "@kitsuden/engine";

export interface HandlabResource {
  id: string;
  ownerId?: string | null;
}

const isTeam = (user: AuthzUser | null) => user?.role === "admin" || user?.role === "editor";

export function registerHandlabPolicy(): void {
  definePolicy<HandlabResource>("handlab", {
    // Dealing hands from a public dataset should not require an account: it is the
    // reason the tool exists.
    view: () => true,
    create: (user) => isTeam(user),
    update: (user) => isTeam(user),
    delete: (user) => isTeam(user),

    /**
     * The routes that used to require only a session (see my decks). They were
     * opened by the host's `requireAuth`, which lets an AGENT through only as an
     * account with `user:act`, `admin` or some handlab scope
     * (`agent-as-user.ts`). SDK operations do not go through that rule,
     * so it is repeated here, as is.
     */
    actAsUser: actsAsUserIn("handlab"),
  });

  definePolicy<HandlabResource>("handlab-deck", {
    // Testing a deck's hands is seeing all of it: a deck with an owner is opened
    // only by its owner. Those with no owner (from before a session was required)
    // belong to nobody and can be used.
    view: (user, deck) => !deck.ownerId || deck.ownerId === user?.id,
    // A PERSON with a session. An agent (`role: "agent"`) needs its scope
    // (`handlab-deck:create`, `handlab-deck:*`, `admin`), which `can()` grants:
    // before, one with only `mcp:connect` saved decks (phase D).
    create: (user) => Boolean(user?.id) && user?.role !== "agent",
  });
}

registerHandlabPolicy();

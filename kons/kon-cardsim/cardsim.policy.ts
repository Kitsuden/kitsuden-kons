/**
 * CardSim — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "cardsim" policy.
 *
 * Mind what this policy does NOT do: it does not decide which CARDS each player sees.
 * That is resolved by `viewFor` in the engine, per seat, and it is a different layer
 * — the policy says whether you can touch the SESSION, `viewFor` says what of it
 * you can see. Confusing them would lead to sending the whole deck to someone who has
 * read permission.
 */
import { actsAsUserIn, type AuthzUser, definePolicy } from "@kitsuden/engine";

export interface CardsimResource {
  id: string;
  status?: string | null;
  ownerId?: string | null;
}

export function registerCardsimPolicy(): void {
  definePolicy<CardsimResource>("cardsim", {
    // A game can be watched: spectators are part of the product.
    // What they will see is trimmed by `viewFor`.
    view: () => true,

    // Creating games and decks requires a session, but not a role: setting up a table
    // is what a normal simulator user does.
    // A PERSON with a session. An agent (`role: "agent"`) needs its scope
    // (`cardsim:create`, `cardsim:*`, `admin`), which `can()` grants:
    // before, one with only `mcp:connect` saved decks (phase D).
    create: (user: AuthzUser | null) => Boolean(user?.id) && user?.role !== "agent",

    /**
     * Publishing a game's DEFINITION and its card catalog (PUT /games,
     * POST /games/:slug/cards, /sync-catalog) is editorial: what is published
     * is played by everyone. Before, those routes asked for `create`, which
     * lets any account through (sign-up is open), and they were only covered by a
     * prefix rule in `auth-guard.ts`. An agent gets through with the scope
     * `cardsim:manageCatalog` (or `cardsim:*`).
     */
    manageCatalog: (user: AuthzUser | null) => user?.role === "admin" || user?.role === "editor",

    /**
     * The "any account" routes (my decks, rooms, games, queue). Before, they
     * were opened by the host's `requireAuth`, which lets an AGENT through only
     * as an account with `user:act`, `admin` or some cardsim scope
     * (`agent-as-user.ts`). SDK operations do not go through that
     * rule, so it is repeated here, as is. Whatever each route requires AFTERWARDS
     * (`create`, `update`, the own seat…) is still checked by the handler.
     */
    actAsUser: actsAsUserIn("cardsim"),

    update: (user, item) => user?.role === "admin" || (!!item.ownerId && item.ownerId === user?.id),
    delete: (user, item) => user?.role === "admin" || (!!item.ownerId && item.ownerId === user?.id),
  });
}

registerCardsimPolicy();

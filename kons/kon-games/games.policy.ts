/**
 * Games — Authorization Policy (migration reference to the new stack)
 * ============================================================================
 *
 * Canonical example of how a KON defines its own policies using the engine's
 * authorization layer. Deny-by-default: an action without a rule is denied.
 *
 * Importing this module (side-effect) registers the "game" policy.
 *
 * ── GAMES HAVE NO OWNER ─────────────────────────────────────────────────────
 *
 * Owner decision: a game belongs to the CATALOG, not to whoever
 * created it. The old rule said "admin or owner" for editing and viewing a
 * draft, but the `games` table never had an owner column (nobody
 * filled it in) and the edit route did not consult the rule: the core's
 * gate let the whole team edit. Now the rule says what happens:
 *
 *   · view     a published game, anyone; a draft, the team;
 *   · create   the team (admin + editor, or an agent with the whole kon);
 *   · edit     the team;
 *   · delete   ONLY the admin (or an agent with the whole kon or `game:delete`).
 */

import {
  actsAsUserIn,
  type AuthzUser,
  definePolicy,
  isEffectiveAdmin,
  isEffectiveStaff,
} from "@kitsuden/engine";

export interface GameResource {
  id: string;
  status?: string | null;
}

/**
 * EFFECTIVE admin and team: the human role, or an agent with the whole kon
 * (`admin`, `games:*`, `kon:games:*`). Common engine rule (effective-actor).
 */
const isAdmin = (user: AuthzUser | null) => isEffectiveAdmin(user, "games");
const isTeam = (user: AuthzUser | null) => isEffectiveStaff(user, "games");

definePolicy<GameResource>("game", {
  // A published game is public; a draft is seen by whoever can edit it.
  view: (user: AuthzUser | null, game) => game.status === "published" || isTeam(user),
  create: (user) => isTeam(user),
  update: (user) => isTeam(user),
  // Deleting a game is ADMIN only, and the route checks it (fixes from an
  // earlier audit: before, `DELETE /api/games/:id` did not consult this rule
  // and an `editor` deleted any game).
  delete: (user) => isAdmin(user),

  /**
   * The routes that used to ask only for a session (collections, platforms,
   * tags, the editorial layer). They were opened by the host's
   * `requireAuth`, which lets an AGENT through only as an account with
   * `user:act`, `admin` or some games scope
   * (`agent-as-user.ts`). The SDK operations do not go through that
   * rule, so it is repeated here, as is (like in kon-esports).
   */
  actAsUser: actsAsUserIn("games"),
});

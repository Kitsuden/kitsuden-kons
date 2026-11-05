/**
 * Esports — authorization policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "esports" policy.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS DID NOT EXIST AND WHY IT IS NEEDED NOW
 *
 * While registering required a CMS session, "has an account" and "is part of
 * the organization" were the same thing, and `requireAuth` was enough for
 * everything. When public registration opened, that equivalence broke: now
 * **everyone who plays has an account**, and `requireAuth` stopped meaning
 * anything.
 *
 * Without this layer, any registrant could —with their normal session— remove
 * a rival's check-in right before the cutoff, delete all the absentees,
 * decide a disputed set, or read the Discord handles of all the participants
 * of all the tournaments.
 *
 * It was not a prior design flaw: it was an assumption that stopped being true
 * the day registration opened. It is the typical price of opening a door
 * that only staff used before.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two levels, and neither inherits from the other by accident:
 *
 *   · `manage`      — run the tournament. Belongs to the organization. It also covers
 *                     REMOVING a check-in (`undo-check-in`): there is no legitimate reason to
 *                     undo your own confirmation, and it is how a rival would be taken out
 *                     right before the window closes.
 *   · `selfCheckIn` — confirm MY presence. Belongs to each person.
 *
 * Withdrawing yourself (`delete-my-registration`) needs no action here: the route only ever
 * finds the caller's own registration (`registeredByUserId = user.id`). The actions
 * `revokeCheckIn` and `selfWithdraw` were declared and checked by no route; they were removed
 * so the policy lists only what is enforced.
 */

import { actsAsUserIn, type AuthzUser, definePolicy } from "@kitsuden/engine";

/**
 * What the policy needs to know about a participant row.
 *
 * `registeredByUserId` is the account that signed up. An imported or
 * manually created participant does not have one, and therefore **nobody** can act on their behalf
 * except the organization — which is correct: nobody has proven to be that
 * person.
 */
export interface EsportsParticipantResource {
  registeredByUserId?: string | null;
  /**
   * Tournament status, for the read rule. Optional because the other
   * rules operate on participants, not on tournaments.
   */
  status?: string | null;
}

/** Who "the organization" is. */
function isStaff(user: AuthzUser | null): boolean {
  return user?.role === "admin" || user?.role === "editor";
}

export function registerEsportsPolicy(): void {
  definePolicy<EsportsParticipantResource>("esports", {
    /**
     * Run the tournament: generate the bracket, resolve disputes, remove absentees,
     * assign rooms, move the broadcast queue, import, and read the notice inbox
     * (which carries everyone's contact details).
     */
    manage: (user) => isStaff(user),

    /**
     * Write the SCENE calendar (`/pro-matches`): matches of other
     * teams that appear on the front page of the esports blog.
     *
     * A separate action from `manage` on purpose: keeping the blog calendar
     * is not running tournaments, and an agent can receive `esports:editScene` without
     * being able to generate brackets or resolve disputes.
     *
     * It used to ask only for a session (and sign-up is public); a prefix rule
     * in `auth-guard.ts` covered for it. With this rule the kon defends itself.
     */
    editScene: (user) => isStaff(user),

    /**
     * VIEW a tournament.
     *
     * ── WHY IT WAS NEEDED ───────────────────────────────────────────────────
     *
     * `esports_tournaments` has a `Draft` status, and both reads —the list
     * and the by-id one— were public and did not look at it. So a
     * half-built tournament could be read in full from outside: title, rules,
     * prize, dates. With `?status=Draft` they all came out at once.
     *
     * It is the same family that was already closed in the blog and in games: a status
     * called "draft" that filters nothing is a draft in name only. And
     * in a tournament it matters: the schedule and the prize before announcing them
     * are exactly what you do not want leaked.
     *
     * Everything that is not `Draft` is public — an open, ongoing or finished
     * tournament is queried without an account, which is the goal.
     */
    view: (user, resource) => resource?.status !== "Draft" || isStaff(user),

    /**
     * Confirm MY presence.
     *
     * The organization can also, and it is needed: in an online tournament there is
     * always someone who gets confirmed by hand because they wrote on
     * Discord instead of pressing the button.
     */
    selfCheckIn: (user, participant) =>
      isStaff(user) ||
      (!!participant?.registeredByUserId && participant.registeredByUserId === user?.id),

    /**
     * The "any account" routes (register, teams, invitations, the own
     * check-in). They used to be opened by the host's `requireAuth`, which lets an
     * AGENT through only as an account with `user:act`, `admin` or
     * some esports scope (`agent-as-user.ts`). The SDK operations
     * do not go through that rule, so it is repeated here, as is.
     */
    actAsUser: actsAsUserIn("esports"),
  });
}

registerEsportsPolicy();

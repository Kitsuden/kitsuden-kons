/**
 * Is this player record THIS account's?
 * ============================================================================
 *
 * ── WHAT WAS HAPPENING ─────────────────────────────────────────────────────
 *
 * Creating a team (`POST /public/teams`) and accepting an invitation
 * (`POST /invites/:token/accept`) did:
 *
 *   insert players (alias) on conflict do nothing
 *   → if it collided, `select id from players where alias = <alias>`
 *
 * That is: if the alias already existed, they KEPT that record, whoever
 * it belonged to. With a freshly created account you could put a well-known player's record
 * on the roster of your own team, or become captain with it:
 * their name, their country and their history appearing on a roster they did not choose.
 * 1v1 registration already rejected this (`AliasTakenError`); these two routes did not.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * An existing record is only reused if there is PROOF that it belongs to the account:
 *
 *   1. it registered with it in some tournament (`registered_by_user_id`), or
 *   2. it is the captain of a team that account created, or
 *   3. it is on the roster of a team whose invitation that account ACCEPTED.
 *
 * `players.core_user_id` will not do: it is `uuid` and Better-Auth ids are
 * free text (see the registration notes). That is why it is deduced from what the
 * account has already done, with no new columns.
 *
 * What remains: rule 3 trusts the roster of a team the account
 * joined by invitation. Abusing it would require ALREADY being on the same
 * team as the victim, which requires their captain to have invited you.
 */

import { and, eq } from "drizzle-orm";

import type { EsportsDb } from "./esports.db";
import {
  players,
  teamInvites,
  teams,
  tournamentParticipants,
} from "./esports.schema";

export type AliasOwnership =
  | { status: "free" }
  | { status: "mine"; playerId: string }
  | { status: "taken" };

export async function aliasOwnership(
  db: EsportsDb,
  alias: string,
  userId: string
): Promise<AliasOwnership> {
  const [player] = await db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.alias, alias))
    .limit(1);
  if (!player) return { status: "free" };

  const [byRegistration] = await db
    .select({ id: tournamentParticipants.id })
    .from(tournamentParticipants)
    .where(
      and(
        eq(tournamentParticipants.playerId, player.id),
        eq(tournamentParticipants.registeredByUserId, userId)
      )
    )
    .limit(1);
  if (byRegistration) return { status: "mine", playerId: player.id };

  const [byCaptaincy] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.captainId, player.id), eq(teams.createdByUserId, userId)))
    .limit(1);
  if (byCaptaincy) return { status: "mine", playerId: player.id };

  const [byInvitation] = await db
    .select({ id: teamInvites.id })
    .from(teamInvites)
    .where(
      and(
        // The player THIS account accepted with, not just anyone on the team:
        // otherwise a guest would take the captain's alias
        // (an earlier audit).
        eq(teamInvites.acceptedPlayerId, player.id),
        eq(teamInvites.invitedUserId, userId),
        eq(teamInvites.status, "accepted")
      )
    )
    .limit(1);
  if (byInvitation) return { status: "mine", playerId: player.id };

  return { status: "taken" };
}

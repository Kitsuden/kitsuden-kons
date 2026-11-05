/**
 * Leaderboard: who wins the most, adding up ALL the tournaments
 * ============================================================================
 *
 * `/tournament/:id/standings` answers "who is winning THIS tournament". This
 * answers another question —"who wins here, overall"— and that is why it cannot be
 * taken from that one: the finished sets of all the tournaments have to be cross-referenced.
 *
 * ── WHERE EACH NUMBER COMES FROM ───────────────────────────────────────────
 *
 * A set (`esports_matches`) pits two PARTICIPANTS against each other, and a participant
 * is the registration of a team or a person in a tournament. So sets are
 * counted per participant and grouped by the team (or player) that is
 * behind it: the same team in five tournaments is five registrations and a
 * single row here.
 *
 * Only `Completed` sets count. A `Bye` is not a win —it was not played—
 * and a `Void` does not exist: including them would inflate the percentage of whoever had good
 * seeding, which is exactly the opposite of what the table claims to measure.
 *
 * ── WHY IT IS NOT SORTED BY PERCENTAGE ─────────────────────────────────────
 *
 * Because winning one and never playing again gives 100 % and would put at the top someone who has
 * done nothing. WINS rule and the percentage breaks ties; the row shows
 * both figures ("7-3 · 70 %") so the order explains itself, without a
 * legend to tell it (DESIGNRULES §6.6).
 */

import type { KonContext } from "@kitsuden/shared";
import { and, eq, or, sql } from "drizzle-orm";
import type { AnyOperation } from "@kitsuden/engine";
import { z } from "zod";

import type { EsportsDb } from "./esports.db";
import { query, text } from "./schemas";
import { isUuid } from "./valid-ids";
import { registry } from "./operations";
import { matches, players, teams, tournamentParticipants, tournaments } from "./esports.schema";

/** A leaderboard row, ready to be drawn. */
export interface ClassificationRow {
  id: string;
  name: string;
  /** Media id (team logo or player avatar), if it has one */
  imageId: string | null;
  played: number;
  won: number;
  /** 0-100, integer: a decimal here helps nobody */
  percent: number;
}

interface Tally {
  id: string;
  name: string;
  imageId: string | null;
  played: number;
  won: number;
}

/**
 * The counts, sorted and trimmed.
 *
 * It is the only real logic in this file, and it is separate so it can be
 * tested without a database.
 */
export function sortClassification(tallies: Tally[], limit = 5): ClassificationRow[] {
  return tallies
    .filter((r) => r.played > 0)
    .map((r) => ({
      ...r,
      percent: Math.round((r.won / r.played) * 100),
    }))
    .sort(
      (a, b) =>
        b.won - a.won ||
        b.percent - a.percent ||
        b.played - a.played ||
        a.name.localeCompare(b.name, "es")
    )
    .slice(0, Math.max(1, limit));
}

const RowOut = z.object({
  id: z.string(),
  name: z.string(),
  imageId: z.string().nullable(),
  played: z.number().int(),
  won: z.number().int(),
  percent: z.number().int(),
});

export function leaderboardOperations(ctx: KonContext): AnyOperation[] {
  const app = registry("/leaderboard");
  const db = ctx.db.instance as EsportsDb;

  /**
   * `GET /leaderboard?type=teams|players&limit=5&game=<uuid>`
   *
   * Public: it is the table of a public page. With no finished sets it returns
   * an empty list, which is what the page needs to show its placeholder —
   * not a 404 or an error.
   */
  app.get(
    "/",
    {
      id: "overall-standings",
      summary: "All-time leaderboard",
      description:
        "Who wins most across ALL tournaments: completed sets played and won, and the win percentage. `type` = teams (default) or players, `limit` 1-50 (default 5), `game` = a game uuid. No completed sets = an empty list.",
      access: "public",
      input: {
        query: query({
          type: text("teams | players (default teams)"),
          limit: text("1-50, default 5"),
          game: text("Game uuid"),
        }),
      },
      output: { schema: z.object({ data: z.array(RowOut) }) },
    },
    async (c) => {
      const type = c.req.query("type") === "players" ? "players" : "teams";
      const limit = Math.min(Number(c.req.query("limit") ?? 5) || 5, 50);
      const game = c.req.query("game");
      // A `game` that is not a uuid reached the uuid column: 500 and the request
      // transaction aborted (an earlier audit). Empty list, like "no data".
      if (game && !isUuid(game)) return c.json({ data: [] });

      // A set counts for its TWO participants: it is joined through either of the two
      const isParticipant = or(
        eq(matches.participant1Id, tournamentParticipants.id),
        eq(matches.participant2Id, tournamentParticipants.id)
      );
      const played = sql<number>`count(*)::int`;
      const won = sql<number>`count(*) filter (where ${matches.winnerId} = ${tournamentParticipants.id})::int`;
      const conditions = [
        eq(matches.status, "Completed"),
        ...(game ? [eq(tournaments.gameId, game)] : []),
      ];

      const tallies: Tally[] =
        type === "teams"
          ? await db
              .select({
                id: teams.id,
                name: teams.name,
                imageId: teams.logoId,
                played,
                won,
              })
              .from(matches)
              .innerJoin(tournamentParticipants, isParticipant)
              .innerJoin(teams, eq(teams.id, tournamentParticipants.teamId))
              .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
              .where(and(...conditions))
              .groupBy(teams.id, teams.name, teams.logoId)
          : await db
              .select({
                id: players.id,
                name: players.alias,
                imageId: players.avatarId,
                played,
                won,
              })
              .from(matches)
              .innerJoin(tournamentParticipants, isParticipant)
              .innerJoin(players, eq(players.id, tournamentParticipants.playerId))
              .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
              .where(and(...conditions))
              .groupBy(players.id, players.alias, players.avatarId);

      return c.json({ data: sortClassification(tallies, limit) });
    }
  );

  return app.ops;
}

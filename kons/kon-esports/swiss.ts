/**
 * Swiss system
 * ============================================================================
 *
 * The format that was missing, and the one most used online: everyone plays
 * ALL the rounds, nobody goes home after two games, and with ~log2(n)
 * rounds a reliable ranking comes out without playing a round robin.
 *
 * It is the format of Magic, Pokémon and Hearthstone — the same people for whom
 * `kon-cardsim` and `kon-tierlist` already exist.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TIEBREAKERS ARE MAGIC'S, AND NOT OUT OF NOSTALGIA
 *
 * In Swiss, half the table ends up with the same number of wins: in 5 rounds
 * with 32 people there are six tied at 4-1. Who makes the quarterfinals is decided by
 * the tiebreaker, so the tiebreaker IS the result of the tournament.
 *
 * Magic's have been subjected to real complaints for thirty years, in this
 * order: **win percentage of your OPPONENTS**, then **your own game
 * percentage**, then **percentage of your OPPONENTS' OPPONENTS**. The idea
 * is to measure the toughness of the path: 4-1 against the best is worth more than 4-1
 * against the worst.
 *
 * Two details that seem arbitrary and are not:
 *
 *   · **33% floor.** An opponent who lost everything and left would drag your
 *     tiebreakers to zero over something you did not do. The floor bounds that punishment.
 *   · **Whoever WITHDRAWS keeps their record.** If it disappeared, everyone who
 *     beat them would lose the credit for that win. Withdrawing cannot
 *     change anyone else's standings.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export class SwissError extends Error {}

/** Win 3, draw 1, loss 0. The standard split. */
const POINTS_WIN = 3;
const POINTS_DRAW = 1;

/**
 * Floor of the tiebreaker percentages.
 *
 * Without it, an opponent who quits at 0-3 sinks you over something outside your control.
 */
const MIN_PERCENTAGE = 1 / 3;

export interface SwissResult {
  /** `null` = bye: there was no opponent. */
  opponentId: string | null;
  outcome: "win" | "loss" | "draw";
  /** Games won and lost WITHIN the set, if tracked. */
  gamesWon?: number;
  gamesLost?: number;
}

export interface SwissPlayer {
  participantId: string;
  /** Results in round order. */
  results: SwissResult[];
  /**
   * `true` if withdrawn.
   *
   * It still counts toward the others' tiebreakers; the only thing that changes is
   * that they are no longer paired.
   */
  dropped?: boolean;
  /** Initial seeding, to break ties that nothing else breaks. */
  seed?: number | null;
}

// ── Rounds ───────────────────────────────────────────────────────────────────

/**
 * Recommended rounds: `ceil(log2(n))`.
 *
 * It is the minimum with which a single player can remain undefeated. With fewer, a
 * 32-player tournament ends with three people at 4-0 and the champion is decided by a
 * tiebreaker instead of a game.
 */
export function recommendedRounds(playerCount: number): number {
  if (playerCount < 2) return 0;
  return Math.ceil(Math.log2(playerCount));
}

// ── Record and tiebreakers ───────────────────────────────────────────────────

export interface SwissRecord {
  wins: number;
  losses: number;
  draws: number;
  byes: number;
  points: number;
  /** Rounds played, byes included. */
  played: number;
}

export function recordOf(player: SwissPlayer): SwissRecord {
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let byes = 0;

  for (const result of player.results) {
    if (result.opponentId === null) byes += 1;
    if (result.outcome === "win") wins += 1;
    else if (result.outcome === "loss") losses += 1;
    else draws += 1;
  }

  return {
    wins,
    losses,
    draws,
    byes,
    points: wins * POINTS_WIN + draws * POINTS_DRAW,
    played: player.results.length,
  };
}

/** Percentage of points over those possible, with a floor. */
export function matchWinPercentage(player: SwissPlayer): number {
  const record = recordOf(player);
  if (record.played === 0) return MIN_PERCENTAGE;
  return Math.max(MIN_PERCENTAGE, record.points / (record.played * POINTS_WIN));
}

/**
 * Percentage of GAMES won.
 *
 * If nobody tracks scores, it falls back to the set percentage. Returning 0 would make
 * this tiebreaker sort at random as soon as a tournament does not record games.
 */
export function gameWinPercentage(player: SwissPlayer): number {
  let won = 0;
  let total = 0;

  for (const result of player.results) {
    if (result.gamesWon === undefined || result.gamesLost === undefined) continue;
    won += result.gamesWon;
    total += result.gamesWon + result.gamesLost;
  }

  if (total === 0) return matchWinPercentage(player);
  return Math.max(MIN_PERCENTAGE, won / total);
}

/**
 * Average of your opponents' win percentage. **The main tiebreaker.**
 *
 * BYES are excluded: there was no opponent to measure, and counting it as an
 * imaginary 33% opponent would punish whoever received a bye they did not ask for.
 */
export function opponentMatchWinPercentage(
  player: SwissPlayer,
  byId: Map<string, SwissPlayer>
): number {
  const opponents = player.results
    .map((r) => r.opponentId)
    .filter((id): id is string => id !== null)
    .map((id) => byId.get(id))
    .filter((p): p is SwissPlayer => p !== undefined);

  if (opponents.length === 0) return MIN_PERCENTAGE;

  const total = opponents.reduce((sum, opponent) => sum + matchWinPercentage(opponent), 0);
  return total / opponents.length;
}

/** Average of your opponents' OMW%. Breaks what the previous one leaves tied. */
export function opponentOpponentMatchWinPercentage(
  player: SwissPlayer,
  byId: Map<string, SwissPlayer>
): number {
  const opponents = player.results
    .map((r) => r.opponentId)
    .filter((id): id is string => id !== null)
    .map((id) => byId.get(id))
    .filter((p): p is SwissPlayer => p !== undefined);

  if (opponents.length === 0) return MIN_PERCENTAGE;

  const total = opponents.reduce(
    (sum, opponent) => sum + opponentMatchWinPercentage(opponent, byId),
    0
  );
  return total / opponents.length;
}

export interface SwissStanding {
  participantId: string;
  place: number;
  record: SwissRecord;
  /** Opponents' win percentage. */
  omw: number;
  /** Own game percentage. */
  gw: number;
  /** Win percentage of the opponents' opponents. */
  oomw: number;
  dropped: boolean;
}

/**
 * The standings.
 *
 * It includes the WITHDRAWN: they still count toward the others' tiebreakers, and
 * hiding them from the table would be hiding why someone is where they are.
 */
export function swissStandings(players: SwissPlayer[]): SwissStanding[] {
  const byId = new Map(players.map((p) => [p.participantId, p]));

  const rows = players.map((player) => ({
    participantId: player.participantId,
    place: 0,
    record: recordOf(player),
    omw: opponentMatchWinPercentage(player, byId),
    gw: gameWinPercentage(player),
    oomw: opponentOpponentMatchWinPercentage(player, byId),
    dropped: player.dropped === true,
    seed: player.seed ?? Number.MAX_SAFE_INTEGER,
  }));

  rows.sort(
    (a, b) =>
      b.record.points - a.record.points ||
      b.omw - a.omw ||
      b.gw - a.gw ||
      b.oomw - a.oomw ||
      // Last resort: the seeding. Deterministic, so that two loads of the
      // same table do not come out in a different order.
      a.seed - b.seed ||
      a.participantId.localeCompare(b.participantId)
  );

  return rows.map(({ seed: _seed, ...row }, index) => ({ ...row, place: index + 1 }));
}

// ── Pairing ──────────────────────────────────────────────────────────────────

export interface SwissPairing {
  /** `S3M2` = round 3, table 2. Same style as `W2M1` and `RR2M1`. */
  id: string;
  round: number;
  table: number;
  participant1: string;
  /** `null` = bye. */
  participant2: string | null;
}

/** Who each one has already played. It is what prevents repeating a pairing. */
function playedAgainst(players: SwissPlayer[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const player of players) {
    map.set(
      player.participantId,
      new Set(player.results.map((r) => r.opponentId).filter((id): id is string => id !== null))
    );
  }
  return map;
}

/**
 * Pairs the next round.
 *
 * By score groups and avoiding rematches, which is what defines
 * Swiss. The algorithm is greedy with a local swap: the standings are walked
 * from top to bottom and, when the next two have already faced each other,
 * one is swapped with the next available.
 *
 * It is not a globally optimal pairing —that is a maximum-weight matching problem— and
 * on purpose: for a community tournament the greedy approach produces the same
 * result 99% of the time, and when it cannot avoid a rematch it
 * SAYS so instead of failing. A tournament stalled because the pairer did not find
 * the perfect solution is worse than an announced rematch.
 */
export function pairSwissRound(
  players: SwissPlayer[],
  round: number
): { pairings: SwissPairing[]; warnings: string[] } {
  const warnings: string[] = [];
  const active = players.filter((p) => !p.dropped);

  if (active.length < 2) {
    throw new SwissError("At least two active participants are needed to pair.");
  }

  const history = playedAgainst(players);
  const standings = swissStandings(players);
  const order = standings
    .map((s) => s.participantId)
    .filter((id) => active.some((p) => p.participantId === id));

  // ── The bye, first ──
  // It goes to the LAST in the table who has not yet had one. Giving it to the first
  // would hand the round to whoever is winning; repeating it on the same person would
  // leave them without playing twice.
  let byePlayer: string | null = null;
  if (order.length % 2 === 1) {
    const byId = new Map(players.map((p) => [p.participantId, p]));
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const candidate = byId.get(order[i]);
      if (candidate && recordOf(candidate).byes === 0) {
        byePlayer = order[i];
        break;
      }
    }
    if (!byePlayer) {
      // Everyone has already had a bye: the last one gets it anyway.
      byePlayer = order[order.length - 1];
      warnings.push("All participants have had a bye; it is repeated on the last-placed one.");
    }
  }

  const queue = order.filter((id) => id !== byePlayer);
  const pairings: SwissPairing[] = [];
  let table = 1;

  while (queue.length > 0) {
    const first = queue.shift()!;
    const alreadyPlayed = history.get(first) ?? new Set<string>();

    // The next one they have not played. Since the table is walked already sorted
    // by points, the first that fits is also the most similar opponent.
    let index = queue.findIndex((id) => !alreadyPlayed.has(id));

    if (index === -1) {
      // There is no one new left: it pairs with the next and WARNS. It is the
      // "tournament that keeps going" decision versus "perfect pairer".
      index = 0;
      warnings.push(
        `Round ${round}: unavoidable repeat pairing with the remaining participants.`
      );
    }

    const second = queue.splice(index, 1)[0];
    pairings.push({
      id: `S${round}M${table}`,
      round,
      table,
      participant1: first,
      participant2: second,
    });
    table += 1;
  }

  if (byePlayer) {
    // The bye goes LAST in the table list: it is not a game, and putting it
    // in the middle throws off the numbering the TO calls out loud.
    pairings.push({
      id: `S${round}M${table}`,
      round,
      table,
      participant1: byePlayer,
      participant2: null,
    });
  }

  return { pairings, warnings };
}

/**
 * Is it over?
 *
 * It is compared against the ANNOUNCED rounds, not against "no undefeated players remain":
 * in Swiss all the rounds are played even if first place is decided, because
 * what is being played below is the standing for the cut.
 */
export function isSwissComplete(players: SwissPlayer[], totalRounds: number): boolean {
  const active = players.filter((p) => !p.dropped);
  if (active.length === 0) return true;
  return active.every((p) => p.results.length >= totalRounds);
}

/**
 * The N who make the cut.
 *
 * The withdrawn do NOT make it, even if their points left them on top: they have gone.
 * But they remain in the standings and in the others' tiebreakers.
 */
export function swissCut(standings: SwissStanding[], size: number): SwissStanding[] {
  return standings.filter((s) => !s.dropped).slice(0, Math.max(0, size));
}

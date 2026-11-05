/**
 * Round robin — pure engine
 * ============================================================================
 *
 * Everyone against everyone. It is the format of groups ("pools" with advancement by
 * points), regular leagues and exhibition round robins.
 *
 * Same contract as `bracket.ts`: pure, no database, a state goes in and
 * another comes out. Round robin arithmetic seems trivial until
 * the win ties arrive — and the tiebreaker is EXACTLY what gets argued
 * over at the top of everyone's lungs in a real tournament, so here it is written and tested, not improvised
 * on the night of the event.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PAIRING BY THE CIRCLE METHOD
 *
 * The standard: one participant is fixed and the rest rotate. It guarantees that everyone
 * plays everyone exactly once, in `n-1` matchdays (or `n` if there are an
 * odd number, with one rest per matchday). Matchups are not generated "by eye":
 * a manual pairing with 7 players always ends with someone playing
 * twice on the same matchday.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface RoundRobinMatch {
  /** Readable, stable id: `RR2M1` = matchday 2, table 1. */
  id: string;
  round: number;
  order: number;
  /** `null` = rest (odd groups). That "set" is not played. */
  participants: [string | null, string | null];
  winnerId: string | null;
  /** Score of the set, informational. The game tiebreaker uses it. */
  scores: [number, number] | null;
  status: "pending" | "done" | "bye";
}

export interface RoundRobin {
  participants: string[];
  matches: RoundRobinMatch[];
}

/**
 * Generates the complete schedule.
 *
 * The input order matters and is respected: whoever seeds the group has already decided
 * the order, and shuffling here would make it impossible to reproduce the published schedule.
 */
export function createRoundRobin(participants: string[]): RoundRobin {
  const ids = [...participants];
  if (new Set(ids).size !== ids.length) {
    throw new Error("[roundrobin] there are duplicate participants");
  }
  if (ids.length < 2) {
    throw new Error("[roundrobin] at least 2 participants are needed");
  }

  // With an odd number a gap is added: whoever draws it rests that matchday.
  const field: (string | null)[] = ids.length % 2 === 0 ? ids : [...ids, null];
  const n = field.length;
  const rounds = n - 1;

  const matches: RoundRobinMatch[] = [];

  // Circle method: field[0] fixed, the rest rotate one position per matchday.
  const rotating = field.slice(1);
  for (let r = 0; r < rounds; r++) {
    const lineup = [field[0], ...rotating];
    let order = 1;

    for (let i = 0; i < n / 2; i++) {
      const a = lineup[i];
      const b = lineup[n - 1 - i];
      const isBye = a === null || b === null;

      matches.push({
        id: `RR${r + 1}M${order}`,
        round: r + 1,
        order,
        participants: [a, b],
        winnerId: null,
        scores: null,
        status: isBye ? "bye" : "pending",
      });
      order++;
    }

    rotating.unshift(rotating.pop() as string | null);
  }

  return { participants: ids, matches };
}

export interface RoundRobinReport {
  winnerId: string;
  /** Score [side0, side1] as it is in the set's `participants`. */
  scores?: [number, number];
}

/**
 * Reports a result. Returns a NEW round robin, without mutating.
 *
 * Reporting the same set twice is allowed and OVERWRITES the previous result:
 * in a group, wrongly entered scores are corrected, and unlike an elimination
 * bracket, correcting here un-advances nobody.
 */
export function reportRoundRobin(
  rr: RoundRobin,
  matchId: string,
  result: RoundRobinReport
): RoundRobin {
  const match = rr.matches.find((m) => m.id === matchId);
  if (!match) throw new Error(`[roundrobin] set "${matchId}" does not exist`);
  if (match.status === "bye") throw new Error(`[roundrobin] "${matchId}" es un descanso`);
  if (!match.participants.includes(result.winnerId)) {
    throw new Error(`[roundrobin] "${result.winnerId}" does not play set "${matchId}"`);
  }
  if (result.scores) {
    const winnerIndex = match.participants.indexOf(result.winnerId) as 0 | 1;
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    if (result.scores[winnerIndex] <= result.scores[loserIndex]) {
      throw new Error(
        `[roundrobin] the score ${result.scores.join("-")} contradicts the declared winner`
      );
    }
  }

  return {
    ...rr,
    matches: rr.matches.map((m) =>
      m.id === matchId
        ? { ...m, winnerId: result.winnerId, scores: result.scores ?? null, status: "done" }
        : m
    ),
  };
}

export interface RoundRobinStanding {
  participantId: string;
  played: number;
  wins: number;
  losses: number;
  /** Games for and against, from the reported scores. */
  gamesWon: number;
  gamesLost: number;
  /** Final position, 1-based. Shared only if the tie is unbreakable. */
  position: number;
}

/**
 * Standings with tiebreakers, in this order and for these reasons:
 *
 *   1. **Wins.** Always first.
 *   2. **Head-to-head** (only between TWO tied): if they already played,
 *      their set decides. It is the rule every player expects and the first one
 *      asked about in a tie.
 *   3. **Game differential.** With three or more tied, head-to-head stops
 *      being transitive (A>B>C>A), so it falls back to the overall differential.
 *
 * If after all that they are still tied, they SHARE a position — the engine does not invent
 * an order. Breaking ties by coin flip or by an extra set is a TO decision, and a
 * number that looks objective but comes out of an unstable `sort` is worse than
 * saying "tie".
 */
export function roundRobinStandings(rr: RoundRobin): RoundRobinStanding[] {
  const table = new Map<string, RoundRobinStanding>(
    rr.participants.map((id) => [
      id,
      { participantId: id, played: 0, wins: 0, losses: 0, gamesWon: 0, gamesLost: 0, position: 0 },
    ])
  );

  for (const m of rr.matches) {
    if (m.status !== "done" || !m.winnerId) continue;
    const [p0, p1] = m.participants;
    if (!p0 || !p1) continue;

    const winner = table.get(m.winnerId)!;
    const loser = table.get(m.winnerId === p0 ? p1 : p0)!;
    winner.played++;
    loser.played++;
    winner.wins++;
    loser.losses++;

    if (m.scores) {
      const winnerIndex = m.participants.indexOf(m.winnerId) as 0 | 1;
      const loserIndex = winnerIndex === 0 ? 1 : 0;
      winner.gamesWon += m.scores[winnerIndex];
      winner.gamesLost += m.scores[loserIndex];
      loser.gamesWon += m.scores[loserIndex];
      loser.gamesLost += m.scores[winnerIndex];
    }
  }

  const rows = [...table.values()];

  /** Winner of the head-to-head between two, or `null` if they did not play or there is no result. */
  const headToHead = (a: string, b: string): string | null => {
    const met = rr.matches.find(
      (m) => m.status === "done" && m.participants.includes(a) && m.participants.includes(b)
    );
    return met?.winnerId ?? null;
  };

  rows.sort((x, y) => {
    if (y.wins !== x.wins) return y.wins - x.wins;

    // Head-to-head ONLY if the tie is between exactly two: with more, it is circular.
    const tied = rows.filter((r) => r.wins === x.wins);
    if (tied.length === 2) {
      const winner = headToHead(x.participantId, y.participantId);
      if (winner === x.participantId) return -1;
      if (winner === y.participantId) return 1;
    }

    const diffX = x.gamesWon - x.gamesLost;
    const diffY = y.gamesWon - y.gamesLost;
    if (diffY !== diffX) return diffY - diffX;

    return 0; // unbreakable tie: they share a position
  });

  // Positions: equal on everything → same position (style 1, 2, 2, 4).
  rows.forEach((row, i) => {
    if (i === 0) {
      row.position = 1;
      return;
    }
    const prev = rows[i - 1];
    const sameRecord =
      row.wins === prev.wins &&
      row.gamesWon - row.gamesLost === prev.gamesWon - prev.gamesLost &&
      // If head-to-head ordered them, they do NOT share a position even if tied on everything.
      (rows.filter((r) => r.wins === row.wins).length !== 2 ||
        headToHead(row.participantId, prev.participantId) === null);
    row.position = sameRecord ? prev.position : i + 1;
  });

  return rows;
}

/** Were all the sets played? Rests do not count. */
export function isRoundRobinComplete(rr: RoundRobin): boolean {
  return rr.matches.every((m) => m.status !== "pending");
}

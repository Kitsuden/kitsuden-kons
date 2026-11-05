/**
 * Swiss system — pairing and tiebreakers
 * ============================================================================
 *
 * In Swiss, half the table ends with the same number of wins: in 5 rounds
 * with 32 people there are six tied at 4-1. Who makes the cut is decided by the
 * tiebreaker, so **the tiebreaker IS the tournament result** — and that is why
 * it is what is tested most here.
 *
 * What is pinned down:
 *
 *   · The sign and order of the three Magic tiebreakers.
 *   · That an opponent who dropped does not sink whoever beat them (33% floor).
 *   · That whoever withdraws KEEPS their record.
 *   · That pairings are not repeated, and that when it is unavoidable it is SAID
 *     instead of failing and leaving the tournament stalled.
 *   · That the bye is not given to the first place nor repeated for the same person.
 */

import { describe, expect, test } from "vitest";

import {
  gameWinPercentage,
  isSwissComplete,
  matchWinPercentage,
  opponentMatchWinPercentage,
  pairSwissRound,
  recommendedRounds,
  recordOf,
  swissCut,
  swissStandings,
  SwissError,
  type SwissPlayer,
} from "../../kons/kon-esports/swiss";

const player = (id: string, results: SwissPlayer["results"], over: Partial<SwissPlayer> = {}) => ({
  participantId: id,
  results,
  ...over,
});

const win = (opponentId: string | null, gamesWon = 2, gamesLost = 0) => ({
  opponentId,
  outcome: "win" as const,
  gamesWon,
  gamesLost,
});
const loss = (opponentId: string, gamesWon = 0, gamesLost = 2) => ({
  opponentId,
  outcome: "loss" as const,
  gamesWon,
  gamesLost,
});

// ── Rounds ───────────────────────────────────────────────────────────────────

describe("how many rounds", () => {
  test("ceil(log2(n)): the minimum with which only one can remain undefeated", () => {
    // With fewer, a 32-player tournament ends with three at 4-0 and the champion is decided by
    // a tiebreaker instead of a game.
    expect(recommendedRounds(8)).toBe(3);
    expect(recommendedRounds(16)).toBe(4);
    expect(recommendedRounds(32)).toBe(5);
  });

  test("numbers that are not a power of two round up", () => {
    expect(recommendedRounds(9)).toBe(4);
    expect(recommendedRounds(20)).toBe(5);
  });

  test("with fewer than two there is no tournament", () => {
    expect(recommendedRounds(1)).toBe(0);
    expect(recommendedRounds(0)).toBe(0);
  });
});

// ── Record ───────────────────────────────────────────────────────────────────

describe("record", () => {
  test("win 3, draw 1, loss 0", () => {
    const record = recordOf(
      player("a", [win("b"), loss("c"), { opponentId: "d", outcome: "draw" }])
    );
    expect(record).toMatchObject({ wins: 1, losses: 1, draws: 1, points: 4, played: 3 });
  });

  test("a bye counts as a win AND as a bye", () => {
    const record = recordOf(player("a", [win(null)]));
    expect(record).toMatchObject({ wins: 1, byes: 1, points: 3 });
  });
});

// ── Desempates ───────────────────────────────────────────────────────────────

describe("Magic tiebreakers", () => {
  test("the player's own percentage is points over possible", () => {
    // 2 wins out of 3 rounds = 6 of 9 points.
    const p = player("a", [win("b"), win("c"), loss("d")]);
    expect(matchWinPercentage(p)).toBeCloseTo(6 / 9, 5);
  });

  test("33% FLOOR: a sunk opponent does not sink you", () => {
    // Whoever lost everything would have 0%, and would drag down the tiebreakers of all
    // who beat them for something they did not do.
    const loser = player("z", [loss("a"), loss("b"), loss("c")]);
    expect(matchWinPercentage(loser)).toBeCloseTo(1 / 3, 5);
  });

  test("the MAIN TIEBREAKER measures the toughness of the path", () => {
    // Two players at 1-0. The one who beat the strong opponent comes out ahead: it is the whole idea
    // of Swiss, that 4-1 against the best is worth more than 4-1 against the worst.
    const strong = player("strong", [win("x"), win("y"), win("z")]);
    const weak = player("weak", [loss("x"), loss("y"), loss("z")]);
    const beatStrong = player("beatStrong", [win("strong")]);
    const beatWeak = player("beatWeak", [win("weak")]);

    const byId = new Map(
      [strong, weak, beatStrong, beatWeak].map((p) => [p.participantId, p as SwissPlayer])
    );

    expect(opponentMatchWinPercentage(beatStrong as SwissPlayer, byId)).toBeGreaterThan(
      opponentMatchWinPercentage(beatWeak as SwissPlayer, byId)
    );
  });

  test("BYES are excluded from the tiebreaker", () => {
    // There was no opponent to measure. Counting it as an imaginary 33% opponent
    // would punish whoever got a bye they did not ask for.
    const rival = player("rival", [win("x"), win("y")]);
    const withBye = player("me", [win(null), win("rival")]);
    const byId = new Map([rival, withBye].map((p) => [p.participantId, p as SwissPlayer]));

    // Only `rival` counts, who is 2-0 → 100%.
    expect(opponentMatchWinPercentage(withBye as SwissPlayer, byId)).toBeCloseTo(1, 5);
  });

  test("without scores, the game percentage falls back to the set percentage", () => {
    // Returning 0 would make this tiebreaker sort randomly as soon as a tournament
    // does not record games, which is most community ones.
    const p: SwissPlayer = {
      participantId: "a",
      results: [{ opponentId: "b", outcome: "win" }],
    };
    expect(gameWinPercentage(p)).toBeCloseTo(matchWinPercentage(p), 5);
  });

  test("with scores, it counts games and not sets", () => {
    const p = player("a", [win("b", 2, 1), win("c", 2, 1)]);
    // 4 games won out of 6.
    expect(gameWinPercentage(p as SwissPlayer)).toBeCloseTo(4 / 6, 5);
  });
});

// ── Standings ────────────────────────────────────────────────────────────────

describe("standings", () => {
  test("sorts by points first", () => {
    const players: SwissPlayer[] = [
      player("b", [loss("a")]),
      player("a", [win("b")]),
    ] as SwissPlayer[];
    expect(swissStandings(players).map((s) => s.participantId)).toEqual(["a", "b"]);
  });

  test("when points are equal the tiebreaker rules, not the order of arrival", () => {
    const players: SwissPlayer[] = [
      player("easy", [win("weak")]),
      player("hard", [win("strong")]),
      player("strong", [win("x"), win("y"), loss("hard")]),
      player("weak", [loss("a"), loss("b"), loss("easy")]),
    ] as SwissPlayer[];

    const standings = swissStandings(players);
    const easy = standings.findIndex((s) => s.participantId === "easy");
    const hard = standings.findIndex((s) => s.participantId === "hard");
    expect(hard).toBeLessThan(easy);
  });

  test("WHOEVER WITHDRAWS stays in the table", () => {
    // If they disappeared, everyone who beat them would lose the credit for that
    // win and their tiebreakers would change over something they did not do.
    const players: SwissPlayer[] = [
      player("a", [win("b")]),
      player("b", [loss("a")], { dropped: true }),
    ] as SwissPlayer[];

    const standings = swissStandings(players);
    expect(standings).toHaveLength(2);
    expect(standings.find((s) => s.participantId === "b")?.dropped).toBe(true);
  });

  test("the order is DETERMINISTIC with everything tied", () => {
    // Two loads of the same table cannot come out in a different order: people
    // refresh and would think something has changed.
    const players: SwissPlayer[] = [
      player("z", [], { seed: 2 }),
      player("a", [], { seed: 1 }),
    ] as SwissPlayer[];
    expect(swissStandings(players).map((s) => s.participantId)).toEqual(["a", "z"]);
    expect(swissStandings([...players].reverse()).map((s) => s.participantId)).toEqual(["a", "z"]);
  });
});

describe("the cut", () => {
  const standings = swissStandings([
    player("a", [win("b"), win("c")]),
    player("b", [loss("a"), win("c")]),
    player("c", [win("d"), loss("b")], { dropped: true }),
    player("d", [loss("c"), loss("a")]),
  ] as SwissPlayer[]);

  test("the WITHDRAWN do not advance, even if their points put them on top", () => {
    expect(swissCut(standings, 3).map((s) => s.participantId)).not.toContain("c");
  });

  test("a cut bigger than the table does not invent people", () => {
    expect(swissCut(standings, 99).length).toBeLessThanOrEqual(standings.length);
  });
});

// ── Pairing ──────────────────────────────────────────────────────────────────

describe("pair the next round", () => {
  test("first round: everyone against someone, nobody left over", () => {
    const players = ["a", "b", "c", "d"].map((id, i) => player(id, [], { seed: i + 1 }));
    const { pairings } = pairSwissRound(players as SwissPlayer[], 1);

    expect(pairings).toHaveLength(2);
    const paired = pairings.flatMap((p) => [p.participant1, p.participant2]);
    expect(new Set(paired).size).toBe(4);
  });

  test("pairs by SCORE: those doing well, among themselves", () => {
    const players: SwissPlayer[] = [
      player("a", [win("c")]),
      player("b", [win("d")]),
      player("c", [loss("a")]),
      player("d", [loss("b")]),
    ] as SwissPlayer[];

    const { pairings } = pairSwissRound(players, 2);
    const top = pairings.find((p) => p.participant1 === "a" || p.participant2 === "a")!;
    expect([top.participant1, top.participant2].sort()).toEqual(["a", "b"]);
  });

  test("does NOT repeat an already played pairing", () => {
    // It is the rule that defines Swiss: repeating a pairing wastes a round.
    const players: SwissPlayer[] = [
      player("a", [win("b")]),
      player("b", [loss("a")]),
      player("c", [win("d")]),
      player("d", [loss("c")]),
    ] as SwissPlayer[];

    const { pairings } = pairSwissRound(players, 2);
    for (const pairing of pairings) {
      expect([pairing.participant1, pairing.participant2].sort()).not.toEqual(["a", "b"]);
      expect([pairing.participant1, pairing.participant2].sort()).not.toEqual(["c", "d"]);
    }
  });

  test("when the rematch is UNAVOIDABLE, it is flagged and the process continues", () => {
    // A tournament stalled because the pairer did not find the perfect solution
    // is worse than an announced rematch.
    const players: SwissPlayer[] = [
      player("a", [win("b")]),
      player("b", [loss("a")]),
    ] as SwissPlayer[];

    const { pairings, warnings } = pairSwissRound(players, 2);
    expect(pairings).toHaveLength(1);
    expect(warnings.join(" ")).toMatch(/repeat pairing/i);
  });

  test("with an odd number, the bye goes to the LAST in the table", () => {
    // Giving it to the first would hand the round to whoever is already winning.
    //
    // The three have DIFFERENT points on purpose: with two tied at zero
    // the order is decided by the last tiebreaker, and this test would be checking
    // the tiebreaker criterion instead of who gets the bye.
    const players: SwissPlayer[] = [
      player("first", [win("mid"), win("last")]),
      player("mid", [loss("first"), win("last")]),
      player("last", [loss("first"), loss("mid")]),
    ] as SwissPlayer[];

    const { pairings } = pairSwissRound(players, 3);
    const bye = pairings.find((p) => p.participant2 === null)!;
    expect(bye.participant1).toBe("last");
  });

  test("the bye is NOT repeated for the same person", () => {
    // It would leave someone without playing twice in a format whose argument is
    // that everyone plays every round.
    const players: SwissPlayer[] = [
      player("a", [win("b")]),
      player("b", [loss("a")]),
      player("hadBye", [win(null)]),
    ] as SwissPlayer[];

    const { pairings } = pairSwissRound(players, 2);
    expect(pairings.find((p) => p.participant2 === null)?.participant1).not.toBe("hadBye");
  });

  test("if EVERYONE has already had a bye, it is repeated but flagged", () => {
    const players: SwissPlayer[] = [
      player("a", [win(null)]),
      player("b", [win(null)]),
      player("c", [win(null)]),
    ] as SwissPlayer[];

    const { pairings, warnings } = pairSwissRound(players, 2);
    expect(pairings.some((p) => p.participant2 === null)).toBe(true);
    expect(warnings.join(" ")).toMatch(/have had a bye/i);
  });

  test("the WITHDRAWN get no opponent", () => {
    const players: SwissPlayer[] = [
      player("a", []),
      player("b", []),
      player("gone", [], { dropped: true }),
    ] as SwissPlayer[];

    const { pairings } = pairSwissRound(players, 1);
    const involved = pairings.flatMap((p) => [p.participant1, p.participant2]);
    expect(involved).not.toContain("gone");
    // And without them there are two left: no bye needed.
    expect(pairings.some((p) => p.participant2 === null)).toBe(false);
  });

  test("with fewer than two active players, it refuses instead of generating garbage", () => {
    const players: SwissPlayer[] = [
      player("a", []),
      player("gone", [], { dropped: true }),
    ] as SwissPlayer[];
    expect(() => pairSwissRound(players, 1)).toThrow(SwissError);
  });

  test("table ids follow the style of the rest (`S3M1`)", () => {
    const players = ["a", "b"].map((id) => player(id, []));
    expect(pairSwissRound(players as SwissPlayer[], 3).pairings[0].id).toBe("S3M1");
  });

  test("the bye goes on the LAST table", () => {
    // It is not a game, and putting it in the middle throws off the numbering the TO
    // calls out loud.
    const players = ["a", "b", "c"].map((id) => player(id, []));
    const { pairings } = pairSwissRound(players as SwissPlayer[], 1);
    expect(pairings.at(-1)!.participant2).toBeNull();
  });
});

describe("when it ends", () => {
  test("it is compared with the ANNOUNCED rounds", () => {
    // In Swiss all rounds are played even if first place is decided: what is
    // played below is the ranking for the cut.
    const players: SwissPlayer[] = [
      player("a", [win("b"), win("c")]),
      player("b", [loss("a"), win("c")]),
    ] as SwissPlayer[];

    expect(isSwissComplete(players, 2)).toBe(true);
    expect(isSwissComplete(players, 3)).toBe(false);
  });

  test("the withdrawn do not prevent it from finishing", () => {
    const players: SwissPlayer[] = [
      player("a", [win("b"), win("c")]),
      player("gone", [loss("a")], { dropped: true }),
    ] as SwissPlayer[];
    expect(isSwissComplete(players, 2)).toBe(true);
  });
});

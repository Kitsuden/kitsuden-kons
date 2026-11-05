/**
 * Round robin — schedule, results and tiebreakers
 * ============================================================================
 *
 * The tiebreaker is EXACTLY what is fought over loudly at a real tournament,
 * so here it is written down and tested, not improvised on the night of the event.
 */

import { describe, expect, test } from "vitest";

import {
  createRoundRobin,
  isRoundRobinComplete,
  reportRoundRobin,
  roundRobinStandings,
  type RoundRobin,
} from "../../kons/kon-esports/roundrobin";

/** Reports a list of (winner, loser[, score]) looking up its set. */
function play(
  rr: RoundRobin,
  results: Array<[string, string] | [string, string, [number, number]]>
): RoundRobin {
  let next = rr;
  for (const [winner, loser, scores] of results) {
    const match = next.matches.find(
      (m) => m.status !== "bye" && m.participants.includes(winner) && m.participants.includes(loser)
    );
    if (!match) throw new Error(`there is no set ${winner} vs ${loser}`);
    let ordered = scores;
    if (scores) {
      // The helper's score arrives as [winner, loser]; the engine
      // expects it in the order of `participants`.
      const wIndex = match.participants.indexOf(winner);
      ordered = wIndex === 0 ? scores : [scores[1], scores[0]];
    }
    next = reportRoundRobin(next, match.id, { winnerId: winner, scores: ordered });
  }
  return next;
}

// ── Schedule ─────────────────────────────────────────────────────────────────

describe("schedule by the circle method", () => {
  test("with N even: N-1 matchdays and everyone against everyone exactly once", () => {
    const rr = createRoundRobin(["a", "b", "c", "d"]);
    expect(Math.max(...rr.matches.map((m) => m.round))).toBe(3);
    expect(rr.matches).toHaveLength(6); // C(4,2)

    // Each pair appears exactly once.
    const pairs = rr.matches.map((m) => [...m.participants].sort().join("-"));
    expect(new Set(pairs).size).toBe(6);
  });

  test("with N odd: N matchdays and one rest per matchday", () => {
    const rr = createRoundRobin(["a", "b", "c", "d", "e"]);
    expect(Math.max(...rr.matches.map((m) => m.round))).toBe(5);

    const byes = rr.matches.filter((m) => m.status === "bye");
    expect(byes).toHaveLength(5); // one per matchday
    // Everyone rests exactly once.
    const resting = byes.map((m) => m.participants.find((p) => p !== null));
    expect(new Set(resting).size).toBe(5);
  });

  test("nobody plays twice on the same matchday", () => {
    // It is the mistake of "by eye" pairing with odd groups.
    const rr = createRoundRobin(["a", "b", "c", "d", "e", "f", "g"]);
    for (let round = 1; round <= 7; round++) {
      const inRound = rr.matches
        .filter((m) => m.round === round)
        .flatMap((m) => m.participants)
        .filter(Boolean);
      expect(new Set(inRound).size).toBe(inRound.length);
    }
  });

  test("duplicates and groups of one are rejected on creation", () => {
    expect(() => createRoundRobin(["a", "a", "b"])).toThrow(/duplicate participants/);
    expect(() => createRoundRobin(["a"])).toThrow(/at least 2 participants/);
  });
});

// ── Results ──────────────────────────────────────────────────────────────────

describe("result reporting", () => {
  test("reporting overwrites the previous result: correcting is legal", () => {
    // Unlike the bracket, correcting here does not un-advance anyone.
    let rr = createRoundRobin(["a", "b"]);
    rr = reportRoundRobin(rr, "RR1M1", { winnerId: "a" });
    rr = reportRoundRobin(rr, "RR1M1", { winnerId: "b" });
    expect(roundRobinStandings(rr)[0].participantId).toBe("b");
  });

  test("a winner who is not playing that set is rejected", () => {
    const rr = createRoundRobin(["a", "b", "c", "d"]);
    expect(() => reportRoundRobin(rr, "RR1M1", { winnerId: "zz" })).toThrow(/does not play/);
  });

  test("a score that contradicts the winner is rejected", () => {
    // 1-3 with side 0 as winner is a fat-finger, and letting it through would break the game
    // tiebreaker later on — where nobody would know where it came from.
    const rr = createRoundRobin(["a", "b"]);
    expect(() => reportRoundRobin(rr, "RR1M1", { winnerId: "a", scores: [1, 3] })).toThrow(
      /contradicts/
    );
  });

  test("a rest cannot be reported", () => {
    const rr = createRoundRobin(["a", "b", "c"]);
    const bye = rr.matches.find((m) => m.status === "bye")!;
    expect(() => reportRoundRobin(rr, bye.id, { winnerId: "a" })).toThrow(/descanso/);
  });

  test("complete = all sets played; rests do not count", () => {
    let rr = createRoundRobin(["a", "b", "c"]);
    expect(isRoundRobinComplete(rr)).toBe(false);
    rr = play(rr, [
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
    expect(isRoundRobinComplete(rr)).toBe(true);
  });
});

// ── Desempates ───────────────────────────────────────────────────────────────

describe("standings and tiebreakers", () => {
  test("wins rule", () => {
    const rr = play(createRoundRobin(["a", "b", "c"]), [
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
    const table = roundRobinStandings(rr);
    expect(table.map((s) => s.participantId)).toEqual(["a", "b", "c"]);
    expect(table.map((s) => s.position)).toEqual([1, 2, 3]);
  });

  test("tie between TWO: the head-to-head decides", () => {
    // b and c tie at 1 win; c beat b, so c ends up ahead
    // EVEN IF b has a better game differential. Head-to-head goes first because
    // it is the rule every player expects.
    const rr = play(createRoundRobin(["a", "b", "c"]), [
      ["a", "b", [3, 0]],
      ["c", "b", [3, 2]],
      ["a", "c", [3, 0]],
    ]);
    const table = roundRobinStandings(rr);
    expect(table.map((s) => s.participantId)).toEqual(["a", "c", "b"]);
    expect(table[1].position).toBe(2);
  });

  test("tie between THREE: head-to-head is circular and falls back to game differential", () => {
    // a>b, b>c, c>a — all 1-1. Head-to-head does not order a cycle; the game
    // differential does: a = 5-3 (+2), c = 5-5 (0), b = 3-5 (−2).
    const rr = play(createRoundRobin(["a", "b", "c"]), [
      ["a", "b", [3, 0]],
      ["b", "c", [3, 2]],
      ["c", "a", [3, 2]],
    ]);
    const table = roundRobinStandings(rr);
    expect(table.map((s) => s.participantId)).toEqual(["a", "c", "b"]);
  });

  test("unbreakable tie: they SHARE position, the engine does not invent an order", () => {
    // A number that looks objective but comes from an unstable sort is worse
    // than saying "tie": the final tiebreak is the TO's decision.
    const rr = play(createRoundRobin(["a", "b", "c"]), [
      ["a", "b", [3, 1]],
      ["b", "c", [3, 1]],
      ["c", "a", [3, 1]],
    ]);
    const table = roundRobinStandings(rr);
    expect(table.map((s) => s.position)).toEqual([1, 1, 1]);
  });

  test("the game differential comes from the reported scores", () => {
    const rr = play(createRoundRobin(["a", "b"]), [["a", "b", [3, 1]]]);
    const [first, second] = roundRobinStandings(rr);
    expect(first.gamesWon - first.gamesLost).toBe(2);
    expect(second.gamesWon - second.gamesLost).toBe(-2);
  });
});

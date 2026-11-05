/**
 * Bracket engine — seeding, byes, single and double elimination, DQ
 * ============================================================================
 *
 * The tests go against the properties a TO would check on paper: that
 * 1 and 2 do not meet before the final, that byes fall on the best
 * seeds, that nobody survives two defeats, and that a complete tournament always
 * ends with exactly one champion.
 */

import { describe, expect, test } from "vitest";

import {
  createBracket,
  getStandings,
  isComplete,
  playableMatches,
  reportResult,
  seedParticipants,
  standardSeedOrder,
  type Bracket,
  type Participant,
} from "../../kons/kon-esports/bracket";

function players(n: number): Participant[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    name: `Player ${i + 1}`,
    rating: 1000 - i, // p1 is the best
  }));
}

/** Plays the whole tournament: the occupant of slot 0 always wins. */
function playOut(bracket: Bracket): Bracket {
  let b = bracket;
  let guard = 0;
  while (!isComplete(b) && guard++ < 500) {
    const ready = playableMatches(b);
    if (ready.length === 0) break;
    b = reportResult(b, ready[0].id, { winnerId: ready[0].participants[0]! });
  }
  return b;
}

// ── Seeding ──────────────────────────────────────────────────────────────────

describe("standard seeding", () => {
  test("the order reflects the classic bracket", () => {
    expect(standardSeedOrder(2)).toEqual([1, 2]);
    expect(standardSeedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(standardSeedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  test("1 and 2 can only meet in the final", () => {
    const b = createBracket(players(8), { format: "single_elimination" });
    const finalMatch = b.matches.find((m) => m.side === "winners" && m.round === 3)!;

    // No earlier round pits them against each other.
    const earlier = b.matches.filter((m) => m.side === "winners" && m.round < 3);
    for (const m of earlier) {
      expect(m.participants.includes("p1") && m.participants.includes("p2")).toBe(false);
    }
    expect(finalMatch).toBeDefined();
  });

  test("by_rating sorts by score, not by registration order", () => {
    const unordered: Participant[] = [
      { id: "c", name: "C", rating: 500 },
      { id: "a", name: "A", rating: 900 },
      { id: "b", name: "B", rating: 700 },
    ];
    expect(seedParticipants(unordered, "by_rating").map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  test("the random draw is reproducible with the same seed", () => {
    const p = players(16);
    const a = seedParticipants(p, "random", 42).map((x) => x.id);
    const b = seedParticipants(p, "random", 42).map((x) => x.id);
    const c = seedParticipants(p, "random", 7).map((x) => x.id);

    expect(a).toEqual(b); // auditable in the face of a complaint
    expect(a).not.toEqual(c);
  });
});

// ── Byes ─────────────────────────────────────────────────────────────────────

describe("byes", () => {
  test("6 participants → bracket of 8 with 2 byes for the best seeds", () => {
    const b = createBracket(players(6), { format: "single_elimination" });
    expect(b.size).toBe(8);

    const byes = b.matches.filter((m) => m.status === "bye");
    expect(byes).toHaveLength(2);

    // The byes go to seeds 1 and 2, not to the last ones.
    const advanced = byes.map((m) => m.winnerId).sort();
    expect(advanced).toEqual(["p1", "p2"]);
  });

  test("whoever gets a bye already appears placed in round 2", () => {
    const b = createBracket(players(6), { format: "single_elimination" });
    const round2 = b.matches.filter((m) => m.side === "winners" && m.round === 2);
    const placed = round2.flatMap((m) => m.participants).filter(Boolean);
    expect(placed).toContain("p1");
    expect(placed).toContain("p2");
  });

  test("a bracket with an exact power of two has no byes", () => {
    const b = createBracket(players(8), { format: "single_elimination" });
    expect(b.matches.filter((m) => m.status === "bye")).toHaveLength(0);
  });

  test("with fewer than 2 participants it is rejected", () => {
    expect(() => createBracket(players(1))).toThrow(/At least 2 participants/);
  });
});

// ── Single elimination ───────────────────────────────────────────────────────

describe("single elimination", () => {
  test("8 players → 7 sets and a champion", () => {
    let b = createBracket(players(8), { format: "single_elimination" });
    expect(b.matches).toHaveLength(7); // 4 + 2 + 1

    b = playOut(b);
    expect(isComplete(b)).toBe(true);
    expect(b.championId).toBe("p1");
  });

  test("a single defeat eliminates", () => {
    let b = createBracket(players(4), { format: "single_elimination" });
    const first = playableMatches(b)[0];
    const loser = first.participants[1]!;

    b = reportResult(b, first.id, { winnerId: first.participants[0]! });

    const standing = getStandings(b).find((s) => s.participantId === loser)!;
    expect(standing.status).toBe("eliminated");
    expect(standing.losses).toBe(1);
  });
});

// ── Double elimination ───────────────────────────────────────────────────────

describe("double elimination", () => {
  test("structure of 8: winners 7, losers 6, plus grand final", () => {
    const b = createBracket(players(8), { format: "double_elimination" });

    expect(b.matches.filter((m) => m.side === "winners")).toHaveLength(7);
    // LB of a bracket of 8: 2 + 2 + 1 + 1 = 6 sets in 4 rounds.
    expect(b.matches.filter((m) => m.side === "losers")).toHaveLength(6);
    expect(b.matches.filter((m) => m.side === "losers" && m.round === 4)).toHaveLength(1);
    expect(b.matches.filter((m) => m.side === "grand_final")).toHaveLength(2);
  });

  test("losing in winners sends to losers, not home", () => {
    let b = createBracket(players(4), { format: "double_elimination" });
    const first = playableMatches(b).find((m) => m.side === "winners")!;
    const loser = first.participants[1]!;

    b = reportResult(b, first.id, { winnerId: first.participants[0]! });

    // Still alive with one defeat, and already placed in the losers bracket.
    const standing = getStandings(b).find((s) => s.participantId === loser)!;
    expect(standing.status).toBe("active");
    expect(standing.losses).toBe(1);

    const inLosers = b.matches
      .filter((m) => m.side === "losers")
      .some((m) => m.participants.includes(loser));
    expect(inLosers).toBe(true);
  });

  test("the second defeat does eliminate", () => {
    let b = createBracket(players(4), { format: "double_elimination" });
    const w1 = playableMatches(b).filter((m) => m.side === "winners");

    b = reportResult(b, w1[0].id, { winnerId: w1[0].participants[0]! });
    b = reportResult(b, w1[1].id, { winnerId: w1[1].participants[0]! });

    const lb = playableMatches(b).find((m) => m.side === "losers")!;
    const doomed = lb.participants[1]!;
    b = reportResult(b, lb.id, { winnerId: lb.participants[0]! });

    const standing = getStandings(b).find((s) => s.participantId === doomed)!;
    expect(standing.losses).toBe(2);
    expect(standing.status).toBe("eliminated");
  });

  test("a complete tournament of 8 ends with exactly one champion", () => {
    const b = playOut(createBracket(players(8), { format: "double_elimination" }));
    expect(isComplete(b)).toBe(true);

    const champions = getStandings(b).filter((s) => s.status === "champion");
    expect(champions).toHaveLength(1);
  });

  test("nobody survives with three defeats", () => {
    const b = playOut(createBracket(players(8), { format: "double_elimination" }));
    for (const s of getStandings(b)) {
      expect(s.losses).toBeLessThanOrEqual(2);
    }
  });

  test("also works with 16 and with non-power-of-two sizes", () => {
    for (const n of [5, 7, 11, 16]) {
      const b = playOut(createBracket(players(n), { format: "double_elimination" }));
      expect(isComplete(b), `n=${n} did not finish`).toBe(true);
      expect(getStandings(b).filter((s) => s.status === "champion")).toHaveLength(1);
    }
  });
});

// ── Grand final y bracket reset ──────────────────────────────────────────────

describe("grand final", () => {
  test("if the undefeated player wins, it ends without a reset", () => {
    let b = createBracket(players(4), { format: "double_elimination" });
    b = playOut(b);

    expect(b.championId).not.toBeNull();
    const reset = b.matches.find((m) => m.id === "GFR")!;
    expect(reset.winnerId).toBeNull(); // was never played
  });

  test("if the losers player wins there is a bracket reset, because the other had not lost yet", () => {
    let b = createBracket(players(4), { format: "double_elimination" });

    // Play everything except the grand final.
    let guard = 0;
    while (guard++ < 50) {
      const ready = playableMatches(b).filter((m) => m.side !== "grand_final");
      if (ready.length === 0) break;
      b = reportResult(b, ready[0].id, { winnerId: ready[0].participants[0]! });
    }

    const gf = b.matches.find((m) => m.id === "GF")!;
    expect(gf.status).toBe("ready");

    const fromLosers = gf.participants[1]!;
    b = reportResult(b, "GF", { winnerId: fromLosers });

    // There is no champion yet: the reset is played.
    expect(b.championId).toBeNull();
    const reset = b.matches.find((m) => m.id === "GFR")!;
    expect(reset.status).toBe("ready");
    expect(reset.participants).toEqual(gf.participants);

    b = reportResult(b, "GFR", { winnerId: fromLosers });
    expect(b.championId).toBe(fromLosers);
  });
});

// ── DQ / no-show ─────────────────────────────────────────────────────────────

describe("DQ and no-show", () => {
  test("a single DQ loses the set but keeps their life in losers", () => {
    let b = createBracket(players(4), { format: "double_elimination" });
    const m = playableMatches(b)[0];
    const dq = m.participants[1]!;

    b = reportResult(b, m.id, { winnerId: m.participants[0]!, dqId: dq });

    expect(b.matches.find((x) => x.id === m.id)!.dqId).toBe(dq);
    expect(getStandings(b).find((s) => s.participantId === dq)!.status).toBe("active");
  });

  test("a total DQ removes them from the tournament even if they had losers left", () => {
    let b = createBracket(players(4), { format: "double_elimination" });
    const m = playableMatches(b)[0];
    const gone = m.participants[1]!;

    b = reportResult(b, m.id, { winnerId: m.participants[0]!, dqId: gone, eliminate: true });

    expect(b.eliminated).toContain(gone);
    expect(getStandings(b).find((s) => s.participantId === gone)!.status).toBe("eliminated");

    // And they are NOT placed in the losers bracket.
    const inLosers = b.matches
      .filter((x) => x.side === "losers")
      .some((x) => x.participants.includes(gone));
    expect(inLosers).toBe(false);
  });

  test("the tournament still ends correctly after a total DQ", () => {
    let b = createBracket(players(8), { format: "double_elimination" });
    const m = playableMatches(b)[0];
    b = reportResult(b, m.id, {
      winnerId: m.participants[0]!,
      dqId: m.participants[1]!,
      eliminate: true,
    });
    b = playOut(b);
    expect(isComplete(b)).toBe(true);
  });
});

// ── Validations ──────────────────────────────────────────────────────────────

describe("validations when reporting", () => {
  test("the same set cannot be reported twice", () => {
    let b = createBracket(players(4), { format: "single_elimination" });
    const m = playableMatches(b)[0];
    b = reportResult(b, m.id, { winnerId: m.participants[0]! });
    expect(() => reportResult(b, m.id, { winnerId: m.participants[1]! })).toThrow(/already has a result/);
  });

  test("you cannot declare as winner someone who does not play the set", () => {
    const b = createBracket(players(4), { format: "single_elimination" });
    const m = playableMatches(b)[0];
    expect(() => reportResult(b, m.id, { winnerId: "intruso" })).toThrow(/does not play/);
  });

  test("a set cannot be reported without both participants", () => {
    const b = createBracket(players(4), { format: "single_elimination" });
    const pending = b.matches.find((m) => m.status === "pending")!;
    expect(() => reportResult(b, pending.id, { winnerId: "p1" })).toThrow(/does not yet have both participants/);
  });

  test("properties: every size from 2 to 32 ends with a single champion", () => {
    // Exhaustive sweep. Routing bugs in the losers bracket do not
    // show up with 8 participants: they show up with 11, 13 or 22, where the byes
    // leave orphan branches. This is what gives confidence to use it in a real
    // tournament.
    for (let n = 2; n <= 32; n++) {
      for (const format of ["single_elimination", "double_elimination"] as const) {
        const label = `n=${n} ${format}`;
        const done = playOut(createBracket(players(n), { format }));

        expect(isComplete(done), `${label}: did not finish`).toBe(true);

        const standings = getStandings(done);
        expect(
          standings.filter((s) => s.status === "champion"),
          `${label}: champions != 1`
        ).toHaveLength(1);

        // Nobody survives above the format's defeat limit.
        const maxLosses = format === "double_elimination" ? 2 : 1;
        for (const s of standings) {
          expect(s.losses, `${label}: ${s.name} con ${s.losses} derrotas`).toBeLessThanOrEqual(
            maxLosses
          );
        }

        // No playable set is left pending.
        expect(playableMatches(done), `${label}: sets were left unplayed`).toHaveLength(0);
      }
    }
  });

  test("properties: nobody appears twice in the same set", () => {
    for (let n = 2; n <= 24; n++) {
      const b = createBracket(players(n), { format: "double_elimination" });
      for (const m of b.matches) {
        const [a, x] = m.participants;
        if (a !== null && x !== null) {
          expect(a, `n=${n} ${m.id}: same player in both slots`).not.toBe(x);
        }
      }
    }
  });

  test("reporting does not mutate the original bracket", () => {
    const b = createBracket(players(4), { format: "single_elimination" });
    const m = playableMatches(b)[0];
    const after = reportResult(b, m.id, { winnerId: m.participants[0]! });

    expect(b.matches.find((x) => x.id === m.id)!.winnerId).toBeNull();
    expect(after.matches.find((x) => x.id === m.id)!.winnerId).not.toBeNull();
  });
});

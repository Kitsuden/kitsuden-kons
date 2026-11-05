/**
 * Check-in and chained phases
 * ============================================================================
 *
 * The two pieces that separate "my tournament tool" from "my tournament
 * platform". What is pinned here are the decisions that get paid for live:
 *
 *   · `drop` vs `dq` — choosing wrong reorders pairings that people already
 *     have on their phones.
 *   · The snake distribution — distribution by blocks makes one pool a walk in the park
 *     and another a slaughterhouse.
 *   · Interleaved seeding — without it, the 1st and 2nd of the same pool
 *     meet in the first round of finals, which is what people complain about.
 */

import { describe, expect, test } from "vitest";

import {
  canCheckIn,
  checkInCountdown,
  checkInState,
  checkInSummary,
  planNoShows,
  validateNoShowPlan,
  type CheckInParticipant,
} from "../../kons/kon-esports/checkin";
import {
  computeAdvancement,
  fgcTemplate,
  snakeDraw,
  totalAdvancing,
  validatePhasePlan,
} from "../../kons/kon-esports/phases";

const at = (iso: string) => new Date(iso);
const OPEN = { opensAt: at("2026-08-03T18:00:00Z"), closesAt: at("2026-08-03T19:00:00Z") };

const participant = (id: string, over: Partial<CheckInParticipant> = {}): CheckInParticipant => ({
  id,
  status: "Approved",
  checkedInAt: null,
  eliminated: false,
  ...over,
});

// ── Window ───────────────────────────────────────────────────────────────────

describe("check-in window", () => {
  test("goes scheduled → open → closed", () => {
    expect(checkInState(OPEN, at("2026-08-03T17:30:00Z"))).toBe("scheduled");
    expect(checkInState(OPEN, at("2026-08-03T18:30:00Z"))).toBe("open");
    expect(checkInState(OPEN, at("2026-08-03T19:30:00Z"))).toBe("closed");
  });

  test("without an opening time, the tournament does NOT use check-in", () => {
    expect(checkInState({ opensAt: null, closesAt: null }, new Date())).toBe("disabled");
  });

  test("without a closing time the window does not close by itself", () => {
    // Some TOs close by hand when they see the room full; forcing a time
    // would oblige them to invent one.
    const noClose = { opensAt: at("2026-08-03T18:00:00Z"), closesAt: null };
    expect(checkInState(noClose, at("2026-08-04T10:00:00Z"))).toBe("open");
  });

  test("the countdown points to what will happen next", () => {
    expect(checkInCountdown(OPEN, at("2026-08-03T17:55:00Z"))).toBe(300); // until opening
    expect(checkInCountdown(OPEN, at("2026-08-03T18:55:00Z"))).toBe(300); // until closing
    expect(checkInCountdown(OPEN, at("2026-08-03T19:30:00Z"))).toBeNull();
  });
});

describe("who can confirm", () => {
  test("with the window open, yes", () => {
    expect(canCheckIn(OPEN, participant("a"), at("2026-08-03T18:30:00Z")).ok).toBe(true);
  });

  test("before and after, no — and it says why", () => {
    const early = canCheckIn(OPEN, participant("a"), at("2026-08-03T17:00:00Z"));
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toMatch(/has not opened yet/);

    const late = canCheckIn(OPEN, participant("a"), at("2026-08-03T20:00:00Z"));
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toMatch(/has already closed/);
  });

  test("a rejected player does not confirm", () => {
    // If allowed, they would appear among those present and someone would put them
    // in the bracket.
    const result = canCheckIn(
      OPEN,
      participant("a", { status: "Rejected" }),
      at("2026-08-03T18:30:00Z")
    );
    expect(result.ok).toBe(false);
  });

  test("confirming twice is accepted, not rejected", () => {
    // Someone who presses twice because they did not see the change does not deserve an error.
    const already = participant("a", { checkedInAt: at("2026-08-03T18:10:00Z") });
    expect(canCheckIn(OPEN, already, at("2026-08-03T18:30:00Z")).ok).toBe(true);
  });
});

// ── Absentees ────────────────────────────────────────────────────────────────

describe("summary and absentees", () => {
  const roster = [
    participant("a", { checkedInAt: at("2026-08-03T18:05:00Z") }),
    participant("b", { checkedInAt: at("2026-08-03T18:07:00Z") }),
    participant("c"),
    participant("d", { status: "Rejected" }),
  ];

  test("REJECTED players do not count as absentees", () => {
    // They were never going to play; counting them would inflate the number with which the TO decides
    // whether to wait five more minutes.
    const s = checkInSummary(roster);
    expect(s.total).toBe(3);
    expect(s.checkedIn).toBe(2);
    expect(s.missing).toBe(1);
    expect(s.missingIds).toEqual(["c"]);
  });

  test("it also says WHO is present, not just how many", () => {
    /**
     * `DELETE /participant/:id/check-in` has existed from the start, but the
     * summary only brought the absentees: the panel had no way of knowing
     * to whom to offer the "undo", so one extra click at the table was
     * permanent and the TO ended up counting by hand.
     *
     * And the rejected one does not enter here either: they do not play, so a check-in
     * they do not have cannot be removed.
     */
    const s = checkInSummary(roster);
    expect(s.checkedInIds).toEqual(["a", "b"]);
    expect(s.checkedInIds).toHaveLength(s.checkedIn);
    expect(
      [...s.checkedInIds, ...s.missingIds].sort(),
      "present and absent together must include ALL eligible players: if " +
        "someone falls out of both lists, they vanish from the TO's screen."
    ).toEqual(["a", "b", "c"]);
  });

  test("the plan says who it affects and how many would remain", () => {
    const plan = planNoShows(roster, "drop");
    expect(plan.participantIds).toEqual(["c"]);
    expect(plan.remaining).toBe(2);
  });

  test("a plan that would leave the tournament without a bracket is rejected BEFORE running", () => {
    // Discovering it after deleting registrations is irreversible.
    const only = [
      participant("a", { checkedInAt: new Date() }),
      participant("b"),
      participant("c"),
    ];
    const plan = planNoShows(only, "drop");
    const valid = validateNoShowPlan(plan);
    expect(valid.ok).toBe(false);
    if (!valid.ok) expect(valid.reason).toMatch(/no possible bracket/);
  });

  test("with no absentees there is nothing to run", () => {
    const all = [participant("a", { checkedInAt: new Date() })];
    expect(validateNoShowPlan(planNoShows(all, "dq")).ok).toBe(false);
  });
});

// ── Pool distribution ────────────────────────────────────────────────────────

describe("snake distribution", () => {
  test("distributes balanced, not by blocks", () => {
    // By blocks, the 4 best would go to different pools but the 4 worst
    // would end up together: one pool a walk in the park and another a slaughterhouse.
    const draw = snakeDraw(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"], 4);

    const group = (id: string) => draw.find((d) => d.participantId === id)!.group;
    // Row 1: 1,2,3,4 → groups 1,2,3,4. Row 2 reversed: 5,6,7,8 → 4,3,2,1.
    expect(group("s1")).toBe(1);
    expect(group("s8")).toBe(1); // the worst goes with the best
    expect(group("s4")).toBe(4);
    expect(group("s5")).toBe(4); // the 5th with the 4th
  });

  test("all groups end up the same size (±1)", () => {
    const draw = snakeDraw(
      Array.from({ length: 23 }, (_, i) => `p${i}`),
      4
    );
    const sizes = [1, 2, 3, 4].map((g) => draw.filter((d) => d.group === g).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  test("seeds within each group start at 1 and are consecutive", () => {
    const draw = snakeDraw(["a", "b", "c", "d", "e", "f"], 2);
    for (const g of [1, 2]) {
      const seeds = draw
        .filter((d) => d.group === g)
        .map((d) => d.seed)
        .sort((x, y) => x - y);
      expect(seeds).toEqual([1, 2, 3]);
    }
  });

  test("more groups than participants is rejected", () => {
    expect(() => snakeDraw(["a", "b"], 4)).toThrow(/cannot make 4 groups/);
  });
});

// ── Advancing between phases ─────────────────────────────────────────────────

describe("who advances and with what seed", () => {
  const pools = [
    { group: 1, participantIds: ["a1", "a2", "a3", "a4"] },
    { group: 2, participantIds: ["b1", "b2", "b3", "b4"] },
    { group: 3, participantIds: ["c1", "c2", "c3"] },
  ];

  test("interleaves BY POSITION: all the firsts first", () => {
    // Without this, the 1st and 2nd of the same pool meet in the first round
    // of the finals — which is exactly what people complain about.
    const advancing = computeAdvancement(pools, 2);
    expect(advancing.map((a) => a.participantId)).toEqual([
      "a1",
      "b1",
      "c1", // the firsts
      "a2",
      "b2",
      "c2", // the seconds
    ]);
  });

  test("seeds come out consecutive from 1", () => {
    const advancing = computeAdvancement(pools, 2);
    expect(advancing.map((a) => a.seed)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("keeps where each one came from", () => {
    // The panel shows it: "2nd of pool C" is information the TO uses.
    const advancing = computeAdvancement(pools, 2);
    const c2 = advancing.find((a) => a.participantId === "c2")!;
    expect(c2).toMatchObject({ fromGroup: 3, fromPosition: 2 });
  });

  test("a group smaller than the spots adds no empty slots", () => {
    // Pool C has 3; asking for 4 must not generate an `undefined` qualifier.
    const advancing = computeAdvancement(pools, 4);
    expect(advancing.every((a) => Boolean(a.participantId))).toBe(true);
    expect(totalAdvancing(pools, 4)).toBe(11);
  });
});

// ── Plan validation ──────────────────────────────────────────────────────────

describe("sequence validation", () => {
  const phase = (over: Record<string, unknown>) => ({
    order: 1,
    name: "Fase",
    format: "double_elimination" as const,
    groups: 1,
    advancesPerGroup: 1,
    ...over,
  });

  test("an empty sequence is not a tournament", () => {
    expect(validatePhasePlan([], 16)[0].level).toBe("error");
  });

  test("two phases with the same order is an error", () => {
    const issues = validatePhasePlan([phase({}), phase({ name: "Otra" })], 16);
    expect(issues.some((i) => i.message.includes("same order"))).toBe(true);
  });

  test("more groups than participants is an error", () => {
    const issues = validatePhasePlan([phase({ groups: 8 })], 4);
    expect(issues.some((i) => i.level === "error")).toBe(true);
  });

  test("a phase that eliminates nobody is an error", () => {
    // Pools of 4 that advance 4: playing for nothing.
    const issues = validatePhasePlan([phase({ groups: 4, advancesPerGroup: 4 })], 16);
    expect(issues.some((i) => i.message.includes("would eliminate nobody"))).toBe(true);
  });

  test("a huge round robin warns, but does not block", () => {
    // 16 in a group is 120 sets: legal, but the TO must know beforehand.
    const issues = validatePhasePlan([phase({ format: "round_robin", groups: 1 })], 16);
    expect(issues.some((i) => i.level === "warning")).toBe(true);
    expect(issues.some((i) => i.level === "error")).toBe(false);
  });

  test("a sequence that does not end in a champion warns", () => {
    const issues = validatePhasePlan([phase({ groups: 4, advancesPerGroup: 2 })], 32);
    expect(issues.some((i) => i.message.includes("not a champion"))).toBe(true);
  });

  test("the FGC template is valid for a typical tournament", () => {
    const issues = validatePhasePlan(fgcTemplate(64), 64);
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  test("the template scales the number of pools with the registrants", () => {
    // Pools of ~8: fits on one station in an hour.
    expect(fgcTemplate(64)[0].groups).toBe(8);
    expect(fgcTemplate(16)[0].groups).toBe(2);
    // And with very few it does not generate zero pools.
    expect(fgcTemplate(3)[0].groups).toBeGreaterThanOrEqual(1);
  });
});

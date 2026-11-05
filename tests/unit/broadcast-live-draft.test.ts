/**
 * MOBA draft — turn order and Fearless
 * ============================================================================
 *
 * The draft is a twenty-step state machine that only runs in full
 * live. Here it runs in full in milliseconds.
 *
 * What is pinned:
 *
 *   1. The standard order is the competitive one, not an invented symmetric one.
 *   2. A champion cannot appear twice in the same draft.
 *   3. Fearless: `global` and `team` block the RIGHT party. Confusing them
 *      invalidates the whole series, not one screen.
 *   4. Skipping a ban is valid; undoing, too.
 */

import { describe, expect, test } from "vitest";

import {
  applySelection,
  draftView,
  draftedChampions,
  emptyDraft,
  fearlessLocked,
  STANDARD_DRAFT_ORDER,
  undoSelection,
  type DraftState,
} from "../../kons/kon-broadcast/live/draft";

/** Runs the whole draft with generated names. */
function playFullDraft(): DraftState {
  let state = emptyDraft();
  for (let i = 0; i < STANDARD_DRAFT_ORDER.length; i++) {
    const result = applySelection(state, `champ-${i}`);
    if (!result.ok) throw new Error(`paso ${i}: ${result.reason}`);
    state = result.state;
  }
  return state;
}

describe("standard draft order", () => {
  test("there are 20 steps: 10 bans and 10 picks", () => {
    expect(STANDARD_DRAFT_ORDER).toHaveLength(20);
    expect(STANDARD_DRAFT_ORDER.filter((s) => s.action === "ban")).toHaveLength(10);
    expect(STANDARD_DRAFT_ORDER.filter((s) => s.action === "pick")).toHaveLength(10);
  });

  test("each team bans 5 and picks 5", () => {
    for (const team of ["blue", "red"] as const) {
      const mine = STANDARD_DRAFT_ORDER.filter((s) => s.team === team);
      expect(mine.filter((s) => s.action === "ban")).toHaveLength(5);
      expect(mine.filter((s) => s.action === "pick")).toHaveLength(5);
    }
  });

  test("blue opens the draft and red closes the counter-pick", () => {
    // It is not symmetric on purpose: it compensates for the first-pick advantage. A
    // "fair" order would break the reading for anyone who follows esports.
    expect(STANDARD_DRAFT_ORDER[0]).toMatchObject({ team: "blue", action: "ban" });
    expect(STANDARD_DRAFT_ORDER[6]).toMatchObject({ team: "blue", action: "pick" });
    expect(STANDARD_DRAFT_ORDER[19]).toMatchObject({ team: "red", action: "pick" });
  });

  test("the second ban phase is opened by RED", () => {
    expect(STANDARD_DRAFT_ORDER[12]).toMatchObject({ team: "red", action: "ban", phase: 2 });
  });

  test("the indexes are consecutive with no gaps", () => {
    STANDARD_DRAFT_ORDER.forEach((step, i) => expect(step.index).toBe(i));
  });
});

describe("transitions", () => {
  test("the complete draft advances the 20 steps and ends", () => {
    const state = playFullDraft();
    expect(state.complete).toBe(true);
    expect(state.current).toBeNull();
    expect(state.selections).toHaveLength(20);
  });

  test("it cannot continue after completing", () => {
    const state = playFullDraft();
    const result = applySelection(state, "otro");
    expect(result.ok).toBe(false);
  });

  test("a champion does not appear twice in the same draft", () => {
    const first = applySelection(emptyDraft(), "ahri");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const again = applySelection(first.state, "ahri");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toMatch(/is already out in this draft/);
  });

  test("a BANNED champion cannot be picked afterwards either", () => {
    // It is the case that slips through if only the picks are checked.
    let state = emptyDraft();
    const ban = applySelection(state, "yasuo");
    expect(ban.ok).toBe(true);
    if (!ban.ok) return;
    state = ban.state;

    // Advance to the pick phase.
    for (let i = 1; i < 6; i++) {
      const r = applySelection(state, `ban-${i}`);
      if (!r.ok) throw new Error(r.reason);
      state = r.state;
    }
    expect(state.current?.action).toBe("pick");

    const pick = applySelection(state, "yasuo");
    expect(pick.ok).toBe(false);
  });

  test("skipping a ban is valid and consumes the turn", () => {
    const result = applySelection(emptyDraft(), null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.selections[0].championId).toBeNull();
    expect(result.state.current?.index).toBe(1);
  });

  test("undo returns the turn to the previous step", () => {
    const first = applySelection(emptyDraft(), "ahri");
    if (!first.ok) throw new Error(first.reason);

    const back = undoSelection(first.state);
    expect(back.selections).toHaveLength(0);
    expect(back.current?.index).toBe(0);
    // And the champion becomes available again.
    expect(applySelection(back, "ahri").ok).toBe(true);
  });

  test("undoing in an empty draft breaks nothing", () => {
    expect(undoSelection(emptyDraft()).selections).toHaveLength(0);
  });
});

describe("Fearless", () => {
  const history = { blue: ["ahri", "lee"], red: ["jinx"] };

  test("off blocks nothing", () => {
    expect(fearlessLocked("off", history, "blue").size).toBe(0);
  });

  test("global blocks what BOTH teams played", () => {
    const locked = fearlessLocked("global", history, "blue");
    expect(locked.has("ahri")).toBe(true);
    expect(locked.has("jinx")).toBe(true); // the rival played it and it is still out
  });

  test("team blocks ONLY its own", () => {
    // The difference between the two modes is the one that invalidates a series if
    // confused: in `team`, the rival CAN take what you played.
    const blue = fearlessLocked("team", history, "blue");
    expect(blue.has("ahri")).toBe(true);
    expect(blue.has("jinx")).toBe(false);

    const red = fearlessLocked("team", history, "red");
    expect(red.has("jinx")).toBe(true);
    expect(red.has("ahri")).toBe(false);
  });

  test("a burned champion is rejected with the reason, not silently", () => {
    let state = emptyDraft();
    // Reach the first pick (index 6, blue).
    for (let i = 0; i < 6; i++) {
      const r = applySelection(state, `ban-${i}`);
      if (!r.ok) throw new Error(r.reason);
      state = r.state;
    }

    const result = applySelection(state, "ahri", {
      fearless: { mode: "global", history },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/ahri/);
      expect(result.reason).toMatch(/Fearless/);
    }
  });

  test("only PICKS burn, not bans", () => {
    // Banning a champion in game 1 does not burn it for the series: only playing it does.
    const ban = applySelection(emptyDraft(), "zed");
    if (!ban.ok) throw new Error(ban.reason);
    expect(draftedChampions(ban.state).blue).toEqual([]);
  });
});

describe("view for the overlay", () => {
  test("groups by team and separates bans from picks", () => {
    const state = playFullDraft();
    const view = draftView(state);

    expect(view.picks.blue).toHaveLength(5);
    expect(view.picks.red).toHaveLength(5);
    expect(view.bans.blue).toHaveLength(5);
    expect(view.complete).toBe(true);
  });

  test("a skipped ban is kept as null, not discarded", () => {
    // The graphic must be able to tell "skipped the ban" from "not their turn yet".
    const passed = applySelection(emptyDraft(), null);
    if (!passed.ok) throw new Error(passed.reason);
    expect(draftView(passed.state).bans.blue).toEqual([null]);
  });

  test("`awaiting` marks the turn so it can be highlighted", () => {
    const view = draftView(emptyDraft());
    expect(view.awaiting).toMatchObject({ index: 0, team: "blue", action: "ban" });
  });
});

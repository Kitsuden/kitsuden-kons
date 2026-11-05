/**
 * Macros — automating the paperwork without interpreting the cards
 * ============================================================================
 *
 * A macro is a named sequence of things the player could already do
 * by hand, with the decisions where they fall. What must be watched is not that
 * it "works" —that is the easy part— but the four ways of breaking it:
 *
 *   1. **The table stops.** With a pending decision NOBODY else plays, or the
 *      result would depend on who sent their request first.
 *   2. **No choosing outside the candidates.** The client sends `instanceId`;
 *      without checking it, "discard 1 from your hand" would discard from the rival's deck.
 *   3. **No leaking.** Candidates only travel to whoever decides.
 *   4. **Still reproducible.** The decision is one more action, so
 *      replay and undo have to keep working the same.
 */

import { describe, expect, test } from "vitest";

import {
  applyAction,
  createSession,
  replay,
  validateGameDefinition,
  viewFor,
  type Action,
  type GameDefinition,
} from "../../kons/kon-cardsim/cardsim.engine";

const GAME: GameDefinition = {
  id: "macro-tcg",
  name: "Macro TCG",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
    { id: "board", name: "Mesa", visibility: "all", capacity: 5 },
    { id: "discard", name: "Discard", visibility: "all" },
  ],
  resources: [{ id: "life", name: "Life", initial: 20, min: 0, max: 20 }],
  globals: [{ id: "cycle", name: "Cycle", initial: "day", values: ["day", "night"] }],
  deckRules: { minSize: 20, maxSize: 40, maxCopies: 3 },
  deckZone: "deck",
  handZone: "hand",
  openingHand: 5,
  phases: ["main", "end"],
  macros: [
    {
      id: "draw2discard1",
      name: "Roba 2 y descarta 1",
      steps: [
        { kind: "draw", count: 2 },
        { kind: "chooseCards", prompt: "Discard 1", from: "hand", to: "discard", count: 1 },
      ],
    },
    {
      id: "search",
      name: "Busca 1 en el mazo",
      steps: [
        { kind: "chooseCards", prompt: "Elige 1", from: "deck", to: "hand", count: 1 },
        // Shuffling afterwards is NOT cosmetic: it erases what was seen while searching.
        { kind: "shuffle", zone: "deck" },
      ],
    },
    {
      id: "burn",
      name: "2 de daño",
      steps: [{ kind: "resource", resource: "life", delta: -2, target: "opponent" }],
    },
    {
      id: "nightfall",
      name: "Cae la noche",
      steps: [{ kind: "setGlobal", id: "cycle", value: "night" }],
    },
    {
      id: "rivalDiscards",
      name: "El rival descarta 1",
      steps: [
        {
          kind: "chooseCards",
          prompt: "Discard 1",
          from: "hand",
          to: "discard",
          count: 1,
          fromOpponent: true,
          toOpponent: true,
          by: "opponent",
        },
      ],
    },
    {
      id: "showdown",
      name: "Confirmar orden de combate",
      steps: [
        { kind: "confirm", prompt: "¿De acuerdo con el orden?", by: "opponent" },
        { kind: "note", text: "orden de combate acordado" },
      ],
    },
    {
      id: "pickMode",
      name: "Elige modo",
      steps: [{ kind: "chooseOption", prompt: "¿Qué modo?", options: ["robar", "quemar"] }],
    },
    {
      id: "sacrifice",
      name: "Gira esta carta y roba",
      steps: [{ kind: "tapSource" }, { kind: "draw", count: 1 }],
    },
    {
      id: "upToTwo",
      name: "Descarta hasta 2",
      steps: [
        {
          kind: "chooseCards",
          prompt: "Descarta hasta 2",
          from: "hand",
          to: "discard",
          count: 2,
          upTo: true,
        },
      ],
    },
    {
      id: "emptyPile",
      name: "Coge del descarte",
      steps: [
        { kind: "chooseCards", prompt: "Coge 1", from: "discard", to: "hand", count: 1 },
        { kind: "draw", count: 1 },
      ],
    },
  ],
};

const deck = (p: string) => Array.from({ length: 24 }, (_, i) => `${p}-${Math.floor(i / 3)}`);
const DECKS = [deck("a"), deck("b")];
const fresh = () => createSession(GAME, DECKS, 4242);

// ── The basics ───────────────────────────────────────────────────────────────

describe("a macro chains steps and stops where a decision is needed", () => {
  test("draws 2 and stops asking for the discard", () => {
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "draw2discard1" }, 4242);

    expect(state.players[0].zones.hand).toHaveLength(7);
    expect(state.pending?.prompt).toBe("Discard 1");
    expect(state.pending?.player).toBe(0);
    expect(state.pending?.count).toBe(1);
    // It has not discarded anything yet: the macro is half-done.
    expect(state.players[0].zones.discard).toHaveLength(0);
  });

  test("on deciding, the macro finishes by itself", () => {
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "draw2discard1" }, 4242);
    const chosen = state.pending!.candidates![0];
    applyAction(state, { type: "decide", player: 0, instanceIds: [chosen] }, 4242);

    expect(state.pending).toBeNull();
    expect(state.players[0].zones.hand).toHaveLength(6);
    expect(state.players[0].zones.discard[0].instanceId).toBe(chosen);
    expect(state.log.some((e) => e.type === "macroEnd")).toBe(true);
  });

  test("a macro without decisions runs entirely at once", () => {
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "burn" }, 4242);
    expect(state.pending).toBeNull();
    expect(state.players[1].resources.life).toBe(18);
  });

  test("the steps reach the global state", () => {
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "nightfall" }, 4242);
    expect(state.globals.cycle).toBe("night");
  });

  test("`tapSource` taps the card that launched the macro", () => {
    const state = fresh();
    const card = state.players[0].zones.hand[0];
    applyAction(
      state,
      { type: "macro", player: 0, macroId: "sacrifice", sourceInstanceId: card.instanceId },
      4242
    );
    expect(card.tapped).toBe(true);
    expect(state.players[0].zones.hand).toHaveLength(6);
  });

  test("a macro that does not exist is rejected", () => {
    expect(() => applyAction(fresh(), { type: "macro", player: 0, macroId: "nope" }, 4242)).toThrow(
      /does not exist/
    );
  });
});

// ── The table stops ──────────────────────────────────────────────────────────

describe("with a pending decision, the table is stopped", () => {
  const pending = () => {
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "draw2discard1" }, 4242);
    return state;
  };

  test("the rival cannot play while you wait", () => {
    // Without this, the result would depend on who sent their request first.
    const state = pending();
    expect(() => applyAction(state, { type: "draw", player: 1, count: 1 }, 4242)).toThrow(
      /pending decision/
    );
  });

  test("you cannot do anything else before deciding either", () => {
    const state = pending();
    expect(() => applyAction(state, { type: "draw", player: 0, count: 1 }, 4242)).toThrow(
      /pending decision/
    );
  });

  test("but you can still talk and resign", () => {
    const state = pending();
    applyAction(state, { type: "chat", player: 1, text: "tranquilo, piensa" }, 4242);
    expect(state.log.at(-1)?.text).toBe("tranquilo, piensa");
    applyAction(state, { type: "concede", player: 1 }, 4242);
    expect(state.result?.winners).toEqual([0]);
  });

  test("whoever's turn it is not cannot decide", () => {
    const state = pending();
    expect(() => applyAction(state, { type: "decide", player: 1, instanceIds: [1] }, 4242)).toThrow(
      /belongs to player 1/
    );
  });

  test("deciding with nothing pending is rejected", () => {
    expect(() => applyAction(fresh(), { type: "decide", player: 0, confirm: true }, 4242)).toThrow(
      /There is no pending decision/
    );
  });

  test("cancelling frees the table and announces it", () => {
    // Cancelling leaves what was already done applied: the rival has to see it.
    const state = pending();
    applyAction(state, { type: "cancelMacro", player: 0 }, 4242);
    expect(state.pending).toBeNull();
    expect(state.players[0].zones.hand).toHaveLength(7);
    expect(state.log.some((e) => e.type === "cancelMacro")).toBe(true);
    applyAction(state, { type: "draw", player: 0, count: 1 }, 4242);
  });
});

// ── No choosing outside the candidates ───────────────────────────────────────

describe("the choice is checked against the candidates", () => {
  test("a card that is not among the candidates is rejected", () => {
    // The client sends instanceId: without this check, "discard from your
    // hand" would discard from the rival's deck.
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "draw2discard1" }, 4242);
    const ofRival = state.players[1].zones.hand[0].instanceId;
    expect(() =>
      applyAction(state, { type: "decide", player: 0, instanceIds: [ofRival] }, 4242)
    ).toThrow(/is not a valid option/);
  });

  test("choosing fewer or more is rejected", () => {
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "draw2discard1" }, 4242);
    const [a, b] = state.pending!.candidates!;
    expect(() => applyAction(state, { type: "decide", player: 0, instanceIds: [] }, 4242)).toThrow(
      /exactly 1/
    );
    expect(() =>
      applyAction(state, { type: "decide", player: 0, instanceIds: [a, b] }, 4242)
    ).toThrow(/exactly 1/);
  });

  test("the same card cannot be chosen twice", () => {
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "upToTwo" }, 4242);
    const [a] = state.pending!.candidates!;
    expect(() =>
      applyAction(state, { type: "decide", player: 0, instanceIds: [a, a] }, 4242)
    ).toThrow(/same card cannot be chosen twice/);
  });

  test("`upTo` allows choosing fewer, even none", () => {
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "upToTwo" }, 4242);
    applyAction(state, { type: "decide", player: 0, instanceIds: [] }, 4242);
    expect(state.pending).toBeNull();
    expect(state.players[0].zones.discard).toHaveLength(0);
  });

  test("an empty zone is skipped instead of leaving you stuck", () => {
    // A dialog with no options would be a dead end: the game would
    // stay blocked waiting for something impossible.
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "emptyPile" }, 4242);
    expect(state.pending).toBeNull();
    expect(state.players[0].zones.hand).toHaveLength(6); // only the final `draw`
    expect(state.log.some((e) => e.type === "macroSkip")).toBe(true);
  });
});

// ── No leaking ───────────────────────────────────────────────────────────────

describe("the candidates are seen only by whoever decides", () => {
  test("the rival sees THAT there is a decision, not between what", () => {
    // The instanceIds go in deck construction order: showing them to
    // someone who knows your list would reveal positions.
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "search" }, 4242);

    const mine = viewFor(state, 0).pending!;
    expect(mine.candidates).toHaveLength(19);

    const theirs = viewFor(state, 1).pending!;
    expect(theirs.prompt).toBe("Elige 1");
    expect(theirs.player).toBe(0);
    expect(theirs.candidates).toBeUndefined();

    expect(viewFor(state, null).pending?.candidates).toBeUndefined();
  });

  test("searching the deck shows the cards to you and nobody else", () => {
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "search" }, 4242);
    expect(viewFor(state, 0).players[0].zones.deck).toHaveLength(19);
    expect(viewFor(state, 1).players[0].zones.deck).toHaveLength(0);
  });

  test("the final `shuffle` erases what you saw while searching", () => {
    // It is the reason the macro carries the shuffle: without it, searching would leave
    // the deck marked for the rest of the game.
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "search" }, 4242);
    applyAction(
      state,
      { type: "decide", player: 0, instanceIds: [state.pending!.candidates![0]] },
      4242
    );
    expect(state.pending).toBeNull();
    expect(viewFor(state, 0).players[0].zones.deck).toHaveLength(0);
    expect(viewFor(state, 0).players[0].hiddenCounts.deck).toBe(18);
  });
});

// ── Rival's decisions ────────────────────────────────────────────────────────

describe("decisions that fall to the rival", () => {
  test("'the rival discards 1' is chosen by THEM, from THEIR hand", () => {
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "rivalDiscards" }, 4242);
    expect(state.pending?.player).toBe(1);

    const theirOwn = state.players[1].zones.hand.map((c) => c.instanceId);
    expect(state.pending!.candidates!.every((id) => theirOwn.includes(id))).toBe(true);

    applyAction(state, { type: "decide", player: 1, instanceIds: [theirOwn[2]] }, 4242);
    expect(state.players[1].zones.discard.map((c) => c.instanceId)).toEqual([theirOwn[2]]);
    expect(state.players[0].zones.discard).toHaveLength(0);
  });

  test("the 'showdown assist': the rival confirms before continuing", () => {
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "showdown" }, 4242);
    expect(state.pending?.kind).toBe("confirm");
    expect(state.pending?.player).toBe(1);

    applyAction(state, { type: "decide", player: 1, confirm: true }, 4242);
    expect(state.pending).toBeNull();
    expect(state.log.some((e) => e.text === "orden de combate acordado")).toBe(true);
  });

  test("if the rival says NO, the macro does not continue", () => {
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "showdown" }, 4242);
    expect(() => applyAction(state, { type: "decide", player: 1, confirm: false }, 4242)).toThrow(
      /Rejected/
    );
    // And since the action was illegal, it does not enter the log: the decision stays alive.
    expect(state.pending?.kind).toBe("confirm");
  });

  test("choose option: only one from the list is valid", () => {
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "pickMode" }, 4242);
    expect(() => applyAction(state, { type: "decide", player: 0, option: "volar" }, 4242)).toThrow(
      /is not one of the options/
    );
    applyAction(state, { type: "decide", player: 0, option: "quemar" }, 4242);
    expect(state.log.some((e) => e.data?.option === "quemar")).toBe(true);
  });
});

// ── Still reproducible ───────────────────────────────────────────────────────

describe("macros do not break replay or undo", () => {
  const script = (): Action[] => {
    const state = fresh();
    applyAction(state, { type: "macro", player: 0, macroId: "draw2discard1" }, 4242);
    return [
      { type: "macro", player: 0, macroId: "draw2discard1" },
      { type: "decide", player: 0, instanceIds: [state.pending!.candidates![3]] },
      { type: "macro", player: 0, macroId: "burn" },
    ];
  };

  test("same seed + same actions = same game, exact", () => {
    const actions = script();
    const a = replay(GAME, DECKS, 4242, actions);
    const b = replay(GAME, DECKS, 4242, actions);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.players[1].resources.life).toBe(18);
  });

  test("undoing mid-macro leaves the decision pending again", () => {
    // Truncating right after the `macro` returns the state to "waiting", which
    // is exactly where it was. No inverse actions are needed.
    const actions = script();
    const averages = replay(GAME, DECKS, 4242, actions.slice(0, 1));
    expect(averages.pending?.prompt).toBe("Discard 1");
    expect(averages.players[0].zones.hand).toHaveLength(7);
  });

  test("undoing the whole macro erases it without a trace in the state", () => {
    const clean = replay(GAME, DECKS, 4242, []);
    const after = replay(GAME, DECKS, 4242, script().slice(0, 2));
    expect(clean.pending).toBeNull();
    expect(after.players[0].zones.hand).toHaveLength(6);
    expect(clean.players[0].zones.hand).toHaveLength(5);
  });
});

// ── Validation on publishing ─────────────────────────────────────────────────

describe("a broken macro is rejected when publishing the game, not mid-game", () => {
  const withValue = (macros: GameDefinition["macros"]) => validateGameDefinition({ ...GAME, macros });

  test("the sample definition is valid", () => {
    expect(validateGameDefinition(GAME)).toEqual([]);
  });

  test("a nonexistent zone is caught on publishing", () => {
    // Otherwise it would blow up in the middle of a real game with half an effect applied.
    const errors = withValue([
      {
        id: "x",
        name: "X",
        steps: [{ kind: "chooseCards", prompt: "p", from: "limbo", to: "hand", count: 1 }],
      },
    ]);
    expect(errors.some((e) => e.includes("limbo"))).toBe(true);
  });

  test("a nonexistent resource or global too", () => {
    expect(
      withValue([{ id: "x", name: "X", steps: [{ kind: "resource", resource: "mana", delta: 1 }] }]).some(
        (e) => e.includes("mana")
      )
    ).toBe(true);
    expect(
      withValue([{ id: "y", name: "Y", steps: [{ kind: "setGlobal", id: "clima", value: "sol" }] }]).some(
        (e) => e.includes("clima")
      )
    ).toBe(true);
  });

  test("an empty or duplicate macro is rejected", () => {
    expect(withValue([{ id: "x", name: "X", steps: [] }]).some((e) => e.includes("has no steps"))).toBe(
      true
    );
    const dup = withValue([
      { id: "x", name: "X", steps: [{ kind: "draw", count: 1 }] },
      { id: "x", name: "Otra", steps: [{ kind: "draw", count: 1 }] },
    ]);
    expect(dup.some((e) => e.includes("Duplicate macro"))).toBe(true);
  });

  test("a choice with a single option is rejected", () => {
    const errors = withValue([
      { id: "x", name: "X", steps: [{ kind: "chooseOption", prompt: "p", options: ["solo"] }] },
    ]);
    expect(errors.some((e) => e.includes("at least two options"))).toBe(true);
  });
});

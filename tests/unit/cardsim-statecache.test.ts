/**
 * State cache — taking the shortcut must give the same as the long way
 * ============================================================================
 *
 * A stale state cache is not slowness: it is two players seeing different
 * boards. Everything here compares the shortcut against the truth
 * (`replay` from scratch) and checks that the cache gives up when it should.
 */

import { beforeEach, describe, expect, test } from "vitest";

import {
  applyAction,
  createSession,
  replay,
  type Action,
  type GameDefinition,
} from "../../kons/kon-cardsim/cardsim.engine";
import {
  cloneState,
  SessionStateCache,
  type CacheableSession,
} from "../../kons/kon-cardsim/cardsim.statecache";

const GAME: GameDefinition = {
  id: "cache-tcg",
  name: "Cache TCG",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
    { id: "board", name: "Mesa", visibility: "all", capacity: 5, attachable: true },
    { id: "discard", name: "Discard", visibility: "all" },
  ],
  resources: [{ id: "life", name: "Life", initial: 20, min: 0, max: 20 }],
  globals: [{ id: "cycle", name: "Cycle", initial: "day", values: ["day", "night"] }],
  deckRules: { minSize: 20, maxSize: 40, maxCopies: 3 },
  deckZone: "deck",
  handZone: "hand",
  openingHand: 5,
  phases: ["main", "end"],
};

const deck = (p: string) => Array.from({ length: 24 }, (_, i) => `${p}-${Math.floor(i / 3)}`);
const DECKS = [deck("a"), deck("b")];
const SEED = 31337;

/** A long and varied script: shuffle, look, move, resources, turns, chat. */
function script(): Action[] {
  const state = createSession(GAME, DECKS, SEED);
  const actions: Action[] = [];
  const push = (a: Action) => {
    applyAction(state, a, SEED);
    actions.push(a);
  };

  for (let turn = 0; turn < 12; turn++) {
    const seat = state.activePlayer;
    push({ type: "draw", player: seat, count: 1 });
    push({ type: "peek", player: seat, zone: "deck", targetPlayer: seat, count: 2 });
    const card = state.players[seat].zones.hand[0];
    push({
      type: "move",
      player: seat,
      instanceId: card.instanceId,
      toZone: "discard",
      toPlayer: seat,
    });
    push({ type: "resource", player: seat, target: 1 - seat, resource: "life", delta: -1 });
    push({ type: "roll", player: seat, sides: 6, count: 1 });
    push({ type: "chat", player: seat, text: `turno ${turn}` });
    push({ type: "shuffleZone", player: seat, zone: "deck" });
    push({ type: "endTurn", player: seat });
  }
  return actions;
}

const ACTIONS = script();

const session = (actions: Action[], stateEpoch = 0): CacheableSession => ({
  id: "s1",
  seed: SEED,
  decks: DECKS,
  actions,
  stateEpoch,
});

let cache: SessionStateCache;
beforeEach(() => {
  cache = new SessionStateCache();
});

// ── The shortcut gives the same as the long way ──────────────────────────────

describe("incremental == replay from scratch", () => {
  test("the whole script, action by action, always matches", () => {
    // Real use is simulated: each request adds an action and reads again.
    for (let n = 0; n <= ACTIONS.length; n++) {
      const partial = ACTIONS.slice(0, n);
      const byCache = cache.stateFor(session(partial), GAME);
      const truth = replay(GAME, DECKS, SEED, partial);
      expect(JSON.stringify(byCache)).toBe(JSON.stringify(truth));
    }
    // And it really went through the shortcut, not replaying each time.
    const stats = cache.snapshot();
    expect(stats.hits).toBe(ACTIONS.length);
    expect(stats.misses).toBe(1);
  });

  test("skipping many actions at once also adds up", () => {
    cache.stateFor(session(ACTIONS.slice(0, 8)), GAME);
    const byCache = cache.stateFor(session(ACTIONS), GAME);
    expect(JSON.stringify(byCache)).toBe(JSON.stringify(replay(GAME, DECKS, SEED, ACTIONS)));
  });

  test("the saving is real: the new ones are applied, not all of them", () => {
    for (let n = 0; n <= ACTIONS.length; n++) cache.stateFor(session(ACTIONS.slice(0, n)), GAME);
    const { applied, avoided } = cache.snapshot();
    // One action per read, instead of the whole game each time.
    expect(applied).toBe(ACTIONS.length);
    expect(avoided).toBeGreaterThan(ACTIONS.length * 10);
  });
});

// ── When it has to give up ───────────────────────────────────────────────────

describe("the cache gives up when the prefix is no longer valid", () => {
  test("undo raises the epoch and discards what is cached", () => {
    // Without this, undo would leave clients seeing the previous board.
    cache.stateFor(session(ACTIONS), GAME);
    const truncated = ACTIONS.slice(0, 20);

    const withEpoch = cache.stateFor(session(truncated, 1), GAME);
    expect(JSON.stringify(withEpoch)).toBe(JSON.stringify(replay(GAME, DECKS, SEED, truncated)));
    expect(cache.snapshot().misses).toBe(2);
  });

  test("a SHORTER list in the same epoch is not extended either", () => {
    // It should not happen (undo raises the epoch), but if it did, extending
    // from a longer prefix would give a state from the future.
    cache.stateFor(session(ACTIONS), GAME);
    const shortOne = ACTIONS.slice(0, 5);
    const state = cache.stateFor(session(shortOne), GAME);
    expect(JSON.stringify(state)).toBe(JSON.stringify(replay(GAME, DECKS, SEED, shortOne)));
  });

  test("forgetting a game forces replaying it", () => {
    cache.stateFor(session(ACTIONS), GAME);
    cache.forget("s1");
    cache.stateFor(session(ACTIONS), GAME);
    expect(cache.snapshot().misses).toBe(2);
  });

  test("each game has its own entry", () => {
    cache.stateFor(session(ACTIONS), GAME);
    cache.stateFor({ ...session(ACTIONS), id: "s2" }, GAME);
    expect(cache.size).toBe(2);
    expect(cache.snapshot().hits).toBe(0);
  });
});

// ── The inner object is never lent out ───────────────────────────────────────

describe("whoever receives the state can mutate it without spoiling the cache", () => {
  test("applying an action on what was returned does not contaminate what is cached", () => {
    const partial = ACTIONS.slice(0, 10);
    const mine = cache.stateFor(session(partial), GAME);
    // The action route does exactly this: takes the state and applies one more to it.
    applyAction(mine, { type: "chat", player: 0, text: "hola" }, SEED);
    applyAction(mine, { type: "resource", player: 0, target: 1, resource: "life", delta: -5 }, SEED);

    const other = cache.stateFor(session(partial), GAME);
    expect(JSON.stringify(other)).toBe(JSON.stringify(replay(GAME, DECKS, SEED, partial)));
  });

  test("mutating a state saved with `remember` does not contaminate it either", () => {
    const state = replay(GAME, DECKS, SEED, ACTIONS.slice(0, 10));
    cache.remember("s1", 0, 10, state);
    state.players[0].resources.life = 1;
    state.players[0].zones.hand.length = 0;

    const read = cache.stateFor(session(ACTIONS.slice(0, 10)), GAME);
    expect(read.players[0].resources.life).toBe(20);
    expect(read.players[0].zones.hand.length).toBeGreaterThan(0);
  });

  test("two reads return independent objects", () => {
    const a = cache.stateFor(session(ACTIONS.slice(0, 10)), GAME);
    const b = cache.stateFor(session(ACTIONS.slice(0, 10)), GAME);
    expect(a).not.toBe(b);
    a.players[0].resources.life = 3;
    expect(b.players[0].resources.life).toBe(20);
  });
});

// ── The copy ─────────────────────────────────────────────────────────────────

describe("cloneState copies what is mutable and shares what does not change", () => {
  const state = replay(GAME, DECKS, SEED, ACTIONS.slice(0, 15));

  test("it is identical in content", () => {
    expect(JSON.stringify(cloneState(state))).toBe(JSON.stringify(state));
  });

  test("the definition is shared: it is immutable and the heaviest part", () => {
    expect(cloneState(state).definition).toBe(state.definition);
  });

  test("zones, counters and `knownTo` are real copies", () => {
    const copy = cloneState(state);
    const card = copy.players[0].zones.hand[0];
    card.counters.damage = 3;
    card.knownTo = [0, 1];
    copy.players[0].zones.hand.push(card);
    copy.globals.cycle = "night";

    expect(state.players[0].zones.hand[0].counters.damage).toBeUndefined();
    expect(state.players[0].zones.hand[0].knownTo).not.toEqual([0, 1]);
    expect(state.players[0].zones.hand.length).toBe(copy.players[0].zones.hand.length - 1);
    expect(state.globals.cycle).toBe("day");
  });

  test("a half-done macro is copied without sharing the candidates", () => {
    const withMacro: GameDefinition = {
      ...GAME,
      macros: [
        {
          id: "m",
          name: "Discard 1",
          steps: [
            { kind: "chooseCards", prompt: "Discard 1", from: "hand", to: "discard", count: 1 },
          ],
        },
      ],
    };
    const live = createSession(withMacro, DECKS, SEED);
    applyAction(live, { type: "macro", player: 0, macroId: "m" }, SEED);
    const copy = cloneState(live);
    copy.pending!.candidates!.push(9999);
    expect(live.pending!.candidates).not.toContain(9999);
  });
});

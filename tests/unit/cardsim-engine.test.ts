/**
 * Card simulator engine — determinism, replay and secrecy
 * ============================================================================
 *
 * Three properties this engine promises and which, if broken, go unnoticed until
 * someone loses a game:
 *
 *   1. **Determinism.** The same seed and the same actions ALWAYS give the
 *      same game. Without that, the replay silently reconstructs a different game.
 *   2. **Legality.** An illegal action does not enter the log. The log only
 *      contains what happened.
 *   3. **Secrecy.** `viewFor` does not leak other players' hands or the deck order. It is
 *      THE security function of the simulator.
 *
 * All three break SILENTLY, so each one has its own block here.
 */

import { describe, expect, test } from "vitest";

import {
  applyAction,
  CardSimError,
  createRng,
  createSession,
  replay,
  shuffle,
  validateDeck,
  validateGameDefinition,
  viewFor,
  type Action,
  type GameDefinition,
} from "../../kons/kon-cardsim/cardsim.engine";
import {
  CYBERPUNK_TCG,
  NARUTO_CARD_GAME,
  ONEPIECE_CARD_GAME,
  PALWORLD_TCG,
  PRESETS,
  RIFTBOUND_TCG,
  YUGIOH_ADVANCED,
} from "../../kons/kon-cardsim/cardsim.presets";

const GAME: GameDefinition = {
  id: "test-tcg",
  name: "Test TCG",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
    { id: "board", name: "Mesa", visibility: "all", capacity: 5 },
    { id: "discard", name: "Discard", visibility: "all" },
  ],
  resources: [
    { id: "life", name: "Life", initial: 20, min: 0, max: 20 },
    { id: "mana", name: "Maná", initial: 0, min: 0 },
  ],
  deckRules: { minSize: 20, maxSize: 40, maxCopies: 3 },
  deckZone: "deck",
  handZone: "hand",
  openingHand: 5,
  phases: ["untap", "main", "combat", "end"],
};

const deck = (prefix: string) =>
  Array.from({ length: 24 }, (_, i) => `${prefix}-card-${Math.floor(i / 3)}`);

const DECKS = [deck("a"), deck("b")];

// ── RNG y barajadura ─────────────────────────────────────────────────────────

describe("deterministic RNG", () => {
  test("the same seed gives the same sequence", () => {
    const a = createRng(42);
    const b = createRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  test("different seeds diverge", () => {
    expect(createRng(1)()).not.toBe(createRng(2)());
  });

  test("shuffling is reproducible and does NOT lose cards", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const first = shuffle(items, createRng(7));
    const second = shuffle(items, createRng(7));
    expect(first).toEqual(second);
    // Fisher-Yates: permutation, not sampling.
    expect([...first].sort((x, y) => x - y)).toEqual(items);
    // And it really shuffles.
    expect(first).not.toEqual(items);
  });
});

// ── Definition and decks ─────────────────────────────────────────────────────

describe("definition validation", () => {
  test("a healthy definition passes", () => {
    expect(validateGameDefinition(GAME)).toHaveLength(0);
  });

  test("a VISIBLE deck is rejected: it would be playing face up", () => {
    const errors = validateGameDefinition({
      ...GAME,
      zones: GAME.zones.map((z) => (z.id === "deck" ? { ...z, visibility: "all" as const } : z)),
    });
    expect(errors.some((e) => e.includes("visibility"))).toBe(true);
  });

  test("an UNORDERED deck is rejected: 'draw the top one' would be undefined", () => {
    const errors = validateGameDefinition({
      ...GAME,
      zones: GAME.zones.map((z) => (z.id === "deck" ? { ...z, ordered: false } : z)),
    });
    expect(errors.some((e) => e.includes("ordered"))).toBe(true);
  });

  test("an initial hand larger than the minimum deck is rejected", () => {
    expect(validateGameDefinition({ ...GAME, openingHand: 25 }).length).toBeGreaterThan(0);
  });

  test("a defeat that looks at a nonexistent resource is rejected", () => {
    // A game with a condition that can never be met NEVER ENDS, and that
    // is not discovered until the first long game.
    const errors = validateGameDefinition({
      ...GAME,
      lossConditions: [
        {
          id: "x",
          name: "sin vida",
          when: { kind: "resourceAtOrBelow", resource: "hp", value: 0 },
        },
      ],
    });
    expect(errors.some((e) => e.includes("hp"))).toBe(true);
  });

  test("if there are sections, one has to start in the deck", () => {
    const errors = validateGameDefinition({
      ...GAME,
      sections: [{ id: "side", name: "Side", zone: "discard", minSize: 0, maxSize: 15 }],
    });
    expect(errors.some((e) => e.includes("deckZone"))).toBe(true);
  });
});

describe("deck validation", () => {
  test("a legal deck passes", () => {
    expect(validateDeck(GAME, DECKS[0])).toHaveLength(0);
  });

  test("too many copies are rejected WITH the card's name", () => {
    const errors = validateDeck(
      GAME,
      Array.from({ length: 24 }, () => "spam")
    );
    expect(errors.some((e) => e.includes("spam") && e.includes("24 copies"))).toBe(true);
  });

  test("a short deck is rejected", () => {
    expect(validateDeck(GAME, ["a", "b"]).some((e) => e.includes("minimum"))).toBe(true);
  });

  test("copyLimits IS the banlist: 0 bans the card", () => {
    const banned: GameDefinition = {
      ...GAME,
      deckRules: { ...GAME.deckRules, copyLimits: { "a-card-0": 0, "a-card-1": 1 } },
    };
    const errors = validateDeck(banned, DECKS[0]);
    expect(errors.some((e) => e.includes("a-card-0") && e.includes("banned"))).toBe(true);
    expect(errors.some((e) => e.includes("a-card-1") && e.includes("maximum 1"))).toBe(true);
  });

  test("copies are counted across ALL sections, not per section", () => {
    // Four in the main plus four in the side are eight of the same card.
    const withSide: GameDefinition = {
      ...GAME,
      sections: [
        { id: "main", name: "Main", zone: "deck", minSize: 20, maxSize: 40, shuffle: true },
        { id: "side", name: "Side", zone: "discard", minSize: 0, maxSize: 15 },
      ],
    };
    const errors = validateDeck(withSide, {
      main: deck("a"),
      side: ["a-card-0", "a-card-0"],
    });
    expect(errors.some((e) => e.includes("a-card-0") && e.includes("5 copies"))).toBe(true);
  });

  test("a section with its own cap is counted SEPARATELY from the rest", () => {
    // Some sections are a fixed pile of the same card —the ten DON!!
    // of ONE PIECE, the twelve runes of Riftbound—: with the general cap of 4
    // no legal deck of those games could pass.
    const withPile: GameDefinition = {
      ...GAME,
      sections: [
        { id: "main", name: "Main", zone: "deck", minSize: 20, maxSize: 40, shuffle: true },
        { id: "stack", name: "Pila", zone: "discard", minSize: 10, maxSize: 10, maxCopies: 10 },
      ],
    };
    expect(
      validateDeck(withPile, { main: deck("a"), stack: Array.from({ length: 10 }, () => "entry") })
    ).toHaveLength(0);

    // And its own cap applies: eleven is already too many.
    const once = validateDeck(withPile, {
      main: deck("a"),
      stack: Array.from({ length: 11 }, () => "entry"),
    });
    expect(once.some((e) => e.includes("entry") && e.includes('in "Pila"'))).toBe(true);
  });

  test("a banned card stays banned inside a section with its own cap", () => {
    // The section's cap lifts the general one, not the banned list.
    const withPile: GameDefinition = {
      ...GAME,
      deckRules: { ...GAME.deckRules, copyLimits: { entry: 0 } },
      sections: [
        { id: "main", name: "Main", zone: "deck", minSize: 20, maxSize: 40, shuffle: true },
        { id: "stack", name: "Pila", zone: "discard", minSize: 0, maxSize: 10, maxCopies: 10 },
      ],
    };
    const errors = validateDeck(withPile, { main: deck("a"), stack: ["entry"] });
    expect(errors.some((e) => e.includes("banned"))).toBe(true);
  });

  test("GROUP caps need a catalog and are skipped without one", () => {
    const def: GameDefinition = {
      ...GAME,
      deckRules: {
        ...GAME.deckRules,
        groupLimits: [{ name: "Lucky", property: "isLucky", value: true, max: 2 }],
      },
    };
    const catalog = Object.fromEntries(DECKS[0].map((id) => [id, { isLucky: true }]));
    // Without a catalog the deck passes: nobody is blocked because data is missing.
    expect(validateDeck(def, DECKS[0])).toHaveLength(0);
    expect(validateDeck(def, DECKS[0], catalog).some((e) => e.includes("Lucky"))).toBe(true);
  });

  test("the cap on DISTINCT values counts colors, not cards", () => {
    const def: GameDefinition = {
      ...GAME,
      deckRules: {
        ...GAME.deckRules,
        distinctLimits: [{ name: "Colors", property: "colors", max: 2, ignore: ["Colorless"] }],
      },
    };
    // The catalog goes by DISTINCT card: if the deck is walked with repeats,
    // each copy overwrites the color of the previous one and the deck ends up monocolor.
    const catalog: Record<string, Record<string, unknown>> = {};
    [...new Set(DECKS[0])].forEach((id, i) => {
      catalog[id] = { colors: [["Red", "Blue", "Green"][i % 3], "Colorless"] };
    });
    const errors = validateDeck(def, DECKS[0], catalog);
    // Three real colors: rejected. And Colorless has not counted.
    expect(errors.some((e) => e.includes("3 distinct values"))).toBe(true);
    expect(errors.some((e) => e.includes("Colorless"))).toBe(false);
  });
});

// ── Session ──────────────────────────────────────────────────────────────────

describe("creating the session", () => {
  test("shuffles and deals the initial hand", () => {
    const state = createSession(GAME, DECKS, 123);
    expect(state.players).toHaveLength(2);
    for (const player of state.players) {
      expect(player.zones.hand).toHaveLength(5);
      expect(player.zones.deck).toHaveLength(19);
      expect(player.resources.life).toBe(20);
    }
  });

  test("cards in hand are face-up to their owner", () => {
    const state = createSession(GAME, DECKS, 123);
    expect(state.players[0].zones.hand.every((c) => !c.faceDown)).toBe(true);
  });

  test("each card has a UNIQUE instance", () => {
    // Two copies of the same card are two objects: tapping one does not tap the other.
    const state = createSession(GAME, DECKS, 123);
    const ids = state.players.flatMap((p) =>
      Object.values(p.zones)
        .flat()
        .map((c) => c.instanceId)
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("an out-of-range number of players is rejected", () => {
    expect(() => createSession(GAME, [DECKS[0]], 1)).toThrow(/2-2 players/);
  });

  test("an illegal deck is rejected at creation, not mid-game", () => {
    expect(() => createSession(GAME, [DECKS[0], ["x"]], 1)).toThrow(/Deck of player 1/);
  });
});

// ── Determinism and replay ───────────────────────────────────────────────────

describe("replay: the state is reconstructed, not stored", () => {
  const actions: Action[] = [
    { type: "draw", player: 0, count: 2 },
    { type: "resource", player: 0, target: 1, resource: "life", delta: -3 },
    { type: "endTurn", player: 0 },
    { type: "draw", player: 1, count: 1 },
  ];

  test("same seed + same actions = same game, exact", () => {
    const a = replay(GAME, DECKS, 999, actions);
    const b = replay(GAME, DECKS, 999, actions);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("another seed gives another game", () => {
    const a = replay(GAME, DECKS, 1, []);
    const b = replay(GAME, DECKS, 2, []);
    expect(a.players[0].zones.hand.map((c) => c.cardId)).not.toEqual(
      b.players[0].zones.hand.map((c) => c.cardId)
    );
  });

  test("the replay applies accumulated effects", () => {
    const state = replay(GAME, DECKS, 999, actions);
    expect(state.players[1].resources.life).toBe(17);
    expect(state.players[0].zones.hand).toHaveLength(7);
    expect(state.activePlayer).toBe(1);
  });

  test("undo is truncating and replaying", () => {
    // No inverse actions or intermediate states are needed: THAT is the reason
    // for storing the list instead of the state.
    const full = replay(GAME, DECKS, 999, actions);
    const undone = replay(GAME, DECKS, 999, actions.slice(0, -1));
    const redone = replay(GAME, DECKS, 999, actions);
    expect(undone.players[1].zones.hand).toHaveLength(5);
    expect(JSON.stringify(redone)).toBe(JSON.stringify(full));
  });
});

// ── Legality of actions ──────────────────────────────────────────────────────

describe("illegal actions: they do not enter the log", () => {
  const fresh = () => createSession(GAME, DECKS, 555);

  test("drawing more than there is in the deck is rejected", () => {
    expect(() => applyAction(fresh(), { type: "draw", player: 0, count: 99 }, 555)).toThrow(
      /tries to draw 99/
    );
  });

  test("only the ACTIVE player changes phase or ends the turn", () => {
    const state = fresh();
    expect(() => applyAction(state, { type: "nextPhase", player: 1 }, 555)).toThrow(
      /active player/
    );
    expect(() => applyAction(state, { type: "endTurn", player: 1 }, 555)).toThrow(/active player/);
  });

  test("a full zone rejects the card, with its capacity in the message", () => {
    const state = fresh();
    const hand = state.players[0].zones.hand;
    // The table admits 5.
    for (let i = 0; i < 5; i++) {
      applyAction(
        state,
        { type: "move", player: 0, instanceId: hand[0].instanceId, toZone: "board", toPlayer: 0 },
        555
      );
    }
    applyAction(state, { type: "draw", player: 0, count: 1 }, 555);
    expect(() =>
      applyAction(
        state,
        {
          type: "move",
          player: 0,
          instanceId: state.players[0].zones.hand[0].instanceId,
          toZone: "board",
          toPlayer: 0,
        },
        555
      )
    ).toThrow(/is full/);
  });

  test("shuffling an UNORDERED zone is rejected", () => {
    expect(() =>
      applyAction(fresh(), { type: "shuffleZone", player: 0, zone: "board" }, 555)
    ).toThrow(/is not an ordered zone/);
  });

  test("a card that is not in play is rejected", () => {
    expect(() => applyAction(fresh(), { type: "flip", player: 0, instanceId: 99999 }, 555)).toThrow(
      CardSimError
    );
  });

  test("once the game is over there is no more playing, only talking", () => {
    const state = fresh();
    applyAction(state, { type: "concede", player: 0 }, 555);
    expect(state.result?.winners).toEqual([1]);
    expect(() => applyAction(state, { type: "draw", player: 1, count: 1 }, 555)).toThrow(
      /already ended/
    );
    // The chat continues: the game ended, the conversation did not.
    applyAction(state, { type: "chat", player: 1, text: "gg" }, 555);
    expect(state.log.at(-1)?.text).toBe("gg");
  });
});

describe("resources: they are clamped, not rejected", () => {
  test("healing above the maximum leaves the maximum", () => {
    // "Heal 5" at 18/20 is legal in every game and must leave 20.
    const state = createSession(GAME, DECKS, 1);
    applyAction(state, { type: "resource", player: 0, target: 0, resource: "life", delta: 5 }, 1);
    expect(state.players[0].resources.life).toBe(20);
  });

  test("going below the minimum leaves the minimum", () => {
    const state = createSession(GAME, DECKS, 1);
    applyAction(state, { type: "resource", player: 0, target: 0, resource: "life", delta: -99 }, 1);
    expect(state.players[0].resources.life).toBe(0);
  });

  test("a nonexistent resource is rejected", () => {
    const state = createSession(GAME, DECKS, 1);
    expect(() =>
      applyAction(state, { type: "resource", player: 0, target: 0, resource: "xp", delta: 1 }, 1)
    ).toThrow(/does not exist/);
  });
});

describe("turnos", () => {
  const THREE: GameDefinition = { ...GAME, players: { min: 3, max: 3 } };
  const THREE_DECKS = [deck("a"), deck("b"), deck("c")];

  test("the turn advances and skips those who are out", () => {
    const state = createSession(THREE, THREE_DECKS, 1);
    applyAction(state, { type: "concede", player: 1 }, 1);
    applyAction(state, { type: "endTurn", player: 0 }, 1);
    // Player 1 resigned: the turn skips to 2.
    expect(state.activePlayer).toBe(2);
  });

  test("phases rotate in the order of the definition", () => {
    const state = createSession(GAME, DECKS, 1);
    applyAction(state, { type: "nextPhase", player: 0 }, 1);
    expect(viewFor(state, 0).phase).toBe("main");
  });
});

// ── Secrecy ──────────────────────────────────────────────────────────────────

describe("viewFor: the simulator's security function", () => {
  const state = createSession(GAME, DECKS, 777);

  test("a player sees THEIR hand", () => {
    const view = viewFor(state, 0);
    expect(view.players[0].zones.hand).toHaveLength(5);
    expect(view.players[0].zones.hand.every((c) => c.cardId !== null)).toBe(true);
  });

  test("does NOT see the rival's hand, but does see how many cards they have", () => {
    // It is exactly what is seen at a real table.
    const view = viewFor(state, 0);
    expect(view.players[1].zones.hand).toHaveLength(0);
    expect(view.players[1].hiddenCounts.hand).toBe(5);
  });

  test("the deck order travels to NOBODY, not even the owner", () => {
    // It is what makes cheating structurally impossible: even if a
    // client reads all its traffic, it does not know what it will draw.
    const view = viewFor(state, 0);
    expect(view.players[0].zones.deck).toHaveLength(0);
    expect(view.players[0].hiddenCounts.deck).toBe(19);
  });

  test("the spectator sees NO hand", () => {
    const view = viewFor(state, null);
    expect(view.players[0].zones.hand).toHaveLength(0);
    expect(view.players[1].zones.hand).toHaveLength(0);
    expect(view.players[0].hiddenCounts.hand).toBe(5);
  });

  test("a face-down card in a public zone shows THAT it is there, not WHICH", () => {
    const live = createSession(GAME, DECKS, 777);
    const card = live.players[0].zones.hand[0];
    applyAction(
      live,
      { type: "move", player: 0, instanceId: card.instanceId, toZone: "board", toPlayer: 0 },
      777
    );
    applyAction(live, { type: "flip", player: 0, instanceId: card.instanceId }, 777);

    const rival = viewFor(live, 1).players[0].zones.board[0];
    expect(rival.faceDown).toBe(true);
    expect(rival.cardId).toBeNull(); // the rival does not know which it is

    const owner = viewFor(live, 0).players[0].zones.board[0];
    expect(owner.cardId).not.toBeNull(); // its owner does: they placed it
  });

  test("resources are public: life is seen on the table", () => {
    expect(viewFor(state, null).players[0].resources.life).toBe(20);
  });
});

// ── Information: look, reveal, forget ────────────────────────────────────────

describe("look and reveal without breaking secrecy", () => {
  test("looking at your deck shows you the top ones and nobody else", () => {
    const state = createSession(GAME, DECKS, 31);
    applyAction(state, { type: "peek", player: 0, zone: "deck", targetPlayer: 0, count: 3 }, 31);

    const mine = viewFor(state, 0).players[0];
    expect(mine.zones.deck).toHaveLength(3);
    expect(mine.zones.deck.every((c) => c.cardId !== null)).toBe(true);
    // And the rest of the deck remains unknown even to me.
    expect(mine.hiddenCounts.deck).toBe(16);

    // The rival sees THAT I looked, not WHAT I saw.
    const theirs = viewFor(state, 1).players[0];
    expect(theirs.zones.deck).toHaveLength(0);
    expect(theirs.hiddenCounts.deck).toBe(19);
  });

  test("SHUFFLING erases what each one had seen", () => {
    // It is the invariant that breaks most easily: without it, looking at the deck and
    // shuffling it would leave the seen cards marked for the rest of the game.
    const state = createSession(GAME, DECKS, 31);
    applyAction(state, { type: "peek", player: 0, zone: "deck", targetPlayer: 0, count: 3 }, 31);
    expect(viewFor(state, 0).players[0].zones.deck).toHaveLength(3);

    applyAction(state, { type: "shuffleZone", player: 0, zone: "deck" }, 31);
    expect(viewFor(state, 0).players[0].zones.deck).toHaveLength(0);
    expect(viewFor(state, 0).players[0].hiddenCounts.deck).toBe(19);
  });

  test("returning a revealed card to the deck hides it again", () => {
    const state = createSession(GAME, DECKS, 31);
    const card = state.players[0].zones.hand[0];
    applyAction(state, { type: "reveal", player: 0, instanceIds: [card.instanceId] }, 31);
    // The rival knows it while it is in hand.
    expect(
      viewFor(state, 1).players[0].zones.hand.find((c) => c.instanceId === card.instanceId)?.cardId
    ).toBe(card.cardId);

    applyAction(
      state,
      { type: "move", player: 0, instanceId: card.instanceId, toZone: "deck", toPlayer: 0 },
      31
    );
    expect(viewFor(state, 1).players[0].zones.deck).toHaveLength(0);
    expect(viewFor(state, 0).players[0].zones.deck).toHaveLength(0);
  });

  test("revealing to ONE player does not show it to the others", () => {
    const state = createSession(GAME, DECKS, 31);
    const card = state.players[0].zones.hand[0];
    applyAction(state, { type: "reveal", player: 0, instanceIds: [card.instanceId], to: [1] }, 31);
    // The recipient sees it in the log; the spectator only sees that something happened.
    expect(viewFor(state, 1).log.some((e) => e.type === "reveal")).toBe(true);
    expect(viewFor(state, null).log.some((e) => e.type === "reveal")).toBe(false);
  });
});

// ── Chance: dice, coins and random selection ─────────────────────────────────

describe("chance is also reproducible", () => {
  test("a die roll comes out the same in the replay", () => {
    const actions: Action[] = [{ type: "roll", player: 0, sides: 6, count: 3 }];
    const a = replay(GAME, DECKS, 4242, actions);
    const b = replay(GAME, DECKS, 4242, actions);
    const results = a.log.find((e) => e.type === "roll")?.data?.results as number[];
    expect(results).toHaveLength(3);
    expect(results.every((r) => r >= 1 && r <= 6)).toBe(true);
    expect(b.log.find((e) => e.type === "roll")?.data?.results).toEqual(results);
  });

  test("two consecutive rolls do not give the same", () => {
    // If the cursor did not advance, all the rolls of the game would come out the same.
    const state = replay(GAME, DECKS, 4242, [
      { type: "roll", player: 0, sides: 1000, count: 5 },
      { type: "roll", player: 0, sides: 1000, count: 5 },
    ]);
    const [first, second] = state.log.filter((e) => e.type === "roll");
    expect(first.data?.results).not.toEqual(second.data?.results);
  });

  test("a coin only gives heads or tails", () => {
    const state = replay(GAME, DECKS, 9, [{ type: "roll", player: 0, sides: 2, count: 10 }]);
    const results = state.log.find((e) => e.type === "roll")?.data?.results as number[];
    expect(results.every((r) => r === 1 || r === 2)).toBe(true);
  });

  test("an impossible die is rejected", () => {
    const state = createSession(GAME, DECKS, 9);
    expect(() => applyAction(state, { type: "roll", player: 0, sides: 1, count: 1 }, 9)).toThrow(
      /between 2 and 1000/
    );
  });

  test("'discard one at random' is chosen by the SERVER and is reproducible", () => {
    // If the client chose, "at random" would be "the one that hurts me least".
    const actions: Action[] = [
      {
        type: "randomMove",
        player: 0,
        fromZone: "hand",
        fromPlayer: 0,
        toZone: "discard",
        toPlayer: 0,
        count: 2,
      },
    ];
    const a = replay(GAME, DECKS, 8080, actions);
    const b = replay(GAME, DECKS, 8080, actions);
    expect(a.players[0].zones.hand).toHaveLength(3);
    expect(a.players[0].zones.discard).toHaveLength(2);
    expect(a.players[0].zones.discard.map((c) => c.instanceId)).toEqual(
      b.players[0].zones.discard.map((c) => c.instanceId)
    );
  });

  test("who starts is drawn and stays in the log", () => {
    const def: GameDefinition = { ...GAME, firstPlayer: "random" };
    const a = createSession(def, DECKS, 12345);
    const b = createSession(def, DECKS, 12345);
    expect(a.activePlayer).toBe(b.activePlayer);
    expect(a.log.some((e) => e.type === "firstPlayer")).toBe(true);
  });
});

// ── Placement: position, slots and shared zones ──────────────────────────────

describe("exactly where a card goes in", () => {
  test("'top of the deck' is the top, not the end", () => {
    const state = createSession(GAME, DECKS, 5);
    const card = state.players[0].zones.hand[0];
    applyAction(
      state,
      {
        type: "move",
        player: 0,
        instanceId: card.instanceId,
        toZone: "deck",
        toPlayer: 0,
        position: "top",
      },
      5
    );
    expect(state.players[0].zones.deck[0].instanceId).toBe(card.instanceId);
    // And drawing takes it out first.
    applyAction(state, { type: "draw", player: 0, count: 1 }, 5);
    expect(state.players[0].zones.hand.at(-1)?.instanceId).toBe(card.instanceId);
  });

  test("numbered slots are respected and not overwritten", () => {
    const def: GameDefinition = {
      ...GAME,
      zones: GAME.zones.map((z) =>
        z.id === "board" ? { ...z, capacity: undefined, slots: 3 } : z
      ),
    };
    const state = createSession(def, DECKS, 5);
    const [a, b] = state.players[0].zones.hand;
    applyAction(
      state,
      { type: "move", player: 0, instanceId: a.instanceId, toZone: "board", toPlayer: 0, slot: 2 },
      5
    );
    expect(state.players[0].zones.board[0].slot).toBe(2);
    expect(() =>
      applyAction(
        state,
        {
          type: "move",
          player: 0,
          instanceId: b.instanceId,
          toZone: "board",
          toPlayer: 0,
          slot: 2,
        },
        5
      )
    ).toThrow(/occupied/);
    // Without asking for a slot, it takes the first free one.
    applyAction(
      state,
      { type: "move", player: 0, instanceId: b.instanceId, toZone: "board", toPlayer: 0 },
      5
    );
    expect(state.players[0].zones.board.find((c) => c.instanceId === b.instanceId)?.slot).toBe(0);
  });

  test("a shared zone belongs to nobody: both see the same cards", () => {
    const def: GameDefinition = {
      ...GAME,
      zones: [
        ...GAME.zones,
        { id: "missions", name: "Misiones", visibility: "all", shared: true, slots: 3 },
      ],
    };
    const state = createSession(def, DECKS, 5);
    const card = state.players[0].zones.hand[0];
    applyAction(
      state,
      { type: "move", player: 0, instanceId: card.instanceId, toZone: "missions", toPlayer: 1 },
      5
    );
    // "To player 1" was requested, but a shared zone ignores the owner.
    expect(state.board.missions).toHaveLength(1);
    expect(viewFor(state, 0).board.missions).toHaveLength(1);
    expect(viewFor(state, 1).board.missions).toHaveLength(1);
    expect(viewFor(state, null).board.missions[0].cardId).toBe(card.cardId);
  });
});

// ── Attachments ──────────────────────────────────────────────────────────────

describe("attached cards: energies, materials and equipment", () => {
  const ATTACH: GameDefinition = {
    ...GAME,
    zones: GAME.zones.map((z) => (z.id === "board" ? { ...z, attachable: true } : z)),
  };

  const withTwoOnBoard = () => {
    const state = createSession(ATTACH, DECKS, 61);
    const [a, b] = state.players[0].zones.hand;
    for (const card of [a, b]) {
      applyAction(
        state,
        { type: "move", player: 0, instanceId: card.instanceId, toZone: "board", toPlayer: 0 },
        61
      );
    }
    return { state, parent: a, child: b };
  };

  test("an attachment does NOT take a table slot", () => {
    // An XYZ with two materials is one card on the table, not three.
    const { state, parent, child } = withTwoOnBoard();
    applyAction(
      state,
      { type: "attach", player: 0, instanceId: child.instanceId, toInstanceId: parent.instanceId },
      61
    );
    // The table admits 5; with the attachment it only counts 1, so 4 more fit.
    for (let i = 0; i < 4; i++) {
      applyAction(state, { type: "draw", player: 0, count: 1 }, 61);
      applyAction(
        state,
        {
          type: "move",
          player: 0,
          instanceId: state.players[0].zones.hand.at(-1)!.instanceId,
          toZone: "board",
          toPlayer: 0,
        },
        61
      );
    }
    expect(state.players[0].zones.board.filter((c) => c.attachedTo === null)).toHaveLength(5);
  });

  test("attachments FOLLOW their card to the graveyard", () => {
    const { state, parent, child } = withTwoOnBoard();
    applyAction(
      state,
      { type: "attach", player: 0, instanceId: child.instanceId, toInstanceId: parent.instanceId },
      61
    );
    applyAction(
      state,
      { type: "move", player: 0, instanceId: parent.instanceId, toZone: "discard", toPlayer: 0 },
      61
    );
    expect(state.players[0].zones.board).toHaveLength(0);
    expect(state.players[0].zones.discard.map((c) => c.instanceId).sort()).toEqual(
      [parent.instanceId, child.instanceId].sort()
    );
    // The discard does not admit attachments: they arrive loose.
    expect(state.players[0].zones.discard.every((c) => c.attachedTo === null)).toBe(true);
  });

  test("a zone that does not admit attachments rejects them", () => {
    const state = createSession(GAME, DECKS, 61);
    const [a, b] = state.players[0].zones.hand;
    for (const card of [a, b]) {
      applyAction(
        state,
        { type: "move", player: 0, instanceId: card.instanceId, toZone: "board", toPlayer: 0 },
        61
      );
    }
    expect(() =>
      applyAction(
        state,
        { type: "attach", player: 0, instanceId: b.instanceId, toInstanceId: a.instanceId },
        61
      )
    ).toThrow(/does not accept attached cards/);
  });

  test("detaching returns the card to the table on its own", () => {
    const { state, parent, child } = withTwoOnBoard();
    applyAction(
      state,
      { type: "attach", player: 0, instanceId: child.instanceId, toInstanceId: parent.instanceId },
      61
    );
    applyAction(state, { type: "detach", player: 0, instanceId: child.instanceId }, 61);
    expect(state.players[0].zones.board.filter((c) => c.attachedTo === null)).toHaveLength(2);
  });
});

// ── Tokens ───────────────────────────────────────────────────────────────────

describe("tokens: cards that do not come from the deck", () => {
  const WITH_TOKENS: GameDefinition = { ...GAME, tokens: [{ cardId: "sheep", name: "Oveja" }] };

  test("they are created on the table and cease to exist when destroyed", () => {
    const state = createSession(WITH_TOKENS, DECKS, 3);
    applyAction(
      state,
      { type: "token", player: 0, cardId: "sheep", toZone: "board", toPlayer: 0 },
      3
    );
    const token = state.players[0].zones.board[0];
    expect(token.token).toBe(true);
    applyAction(state, { type: "destroyToken", player: 0, instanceId: token.instanceId }, 3);
    expect(state.players[0].zones.board).toHaveLength(0);
    // And it does not appear in the discard: a token does not go to the graveyard, it ceases to exist.
    expect(state.players[0].zones.discard).toHaveLength(0);
  });

  test("a token the game does not declare is rejected", () => {
    const state = createSession(WITH_TOKENS, DECKS, 3);
    expect(() =>
      applyAction(
        state,
        { type: "token", player: 0, cardId: "dragon", toZone: "board", toPlayer: 0 },
        3
      )
    ).toThrow(/is not a token/);
  });

  test("a real card cannot be 'destroyed': it is moved", () => {
    const state = createSession(WITH_TOKENS, DECKS, 3);
    const card = state.players[0].zones.hand[0];
    expect(() =>
      applyAction(state, { type: "destroyToken", player: 0, instanceId: card.instanceId }, 3)
    ).toThrow(/Only tokens are destroyed/);
  });
});

// ── Global state and mulligan ────────────────────────────────────────────────

describe("global game state", () => {
  const CYCLE: GameDefinition = {
    ...GAME,
    globals: [{ id: "cycle", name: "Cycle", initial: "day", values: ["day", "night"] }],
  };

  test("day/night belongs to the GAME, not to a player", () => {
    const state = createSession(CYCLE, DECKS, 2);
    applyAction(state, { type: "setGlobal", player: 0, id: "cycle", value: "night" }, 2);
    // Both see it the same: there cannot be one player in day and another in night.
    expect(viewFor(state, 0).globals.cycle).toBe("night");
    expect(viewFor(state, 1).globals.cycle).toBe("night");
    expect(viewFor(state, null).globals.cycle).toBe("night");
  });

  test("a value outside the list is rejected", () => {
    const state = createSession(CYCLE, DECKS, 2);
    expect(() =>
      applyAction(state, { type: "setGlobal", player: 0, id: "cycle", value: "dusk" }, 2)
    ).toThrow(/is not a valid value/);
  });
});

describe("mulligan", () => {
  const MULL: GameDefinition = {
    ...GAME,
    mulligan: { mode: "redraw", maxTimes: 1, penalty: 0 },
  };

  test("returns the hand, shuffles and draws again", () => {
    const state = createSession(MULL, DECKS, 77);
    const before = state.players[0].zones.hand.map((c) => c.cardId);
    applyAction(state, { type: "mulligan", player: 0 }, 77);
    expect(state.players[0].zones.hand).toHaveLength(5);
    expect(state.players[0].zones.deck).toHaveLength(19);
    expect(state.players[0].zones.hand.map((c) => c.cardId)).not.toEqual(before);
  });

  test("it cannot be done more times than allowed", () => {
    const state = createSession(MULL, DECKS, 77);
    applyAction(state, { type: "mulligan", player: 0 }, 77);
    expect(() => applyAction(state, { type: "mulligan", player: 0 }, 77)).toThrow(/already used/);
  });

  test("with a penalty one fewer is drawn", () => {
    const penalty: GameDefinition = {
      ...GAME,
      mulligan: { mode: "redraw", maxTimes: 2, penalty: 1 },
    };
    const state = createSession(penalty, DECKS, 77);
    applyAction(state, { type: "mulligan", player: 0 }, 77);
    expect(state.players[0].zones.hand).toHaveLength(4);
  });

  test("a game without mulligan rejects it", () => {
    const state = createSession(GAME, DECKS, 77);
    expect(() => applyAction(state, { type: "mulligan", player: 0 }, 77)).toThrow(
      /has no mulligan/
    );
  });
});

// ── Win conditions ───────────────────────────────────────────────────────────

describe("when the game ends", () => {
  test("life at zero loses, and the rival wins", () => {
    const def: GameDefinition = {
      ...GAME,
      lossConditions: [
        {
          id: "life",
          name: "se queda sin vida",
          when: { kind: "resourceAtOrBelow", resource: "life", value: 0 },
        },
      ],
    };
    const state = createSession(def, DECKS, 11);
    applyAction(
      state,
      { type: "resource", player: 0, target: 1, resource: "life", delta: -20 },
      11
    );
    expect(state.players[1].lost).toBe(true);
    expect(state.result).toEqual({ winners: [0], reason: "se queda sin vida" });
  });

  test("being unable to draw loses WITHOUT throwing an error", () => {
    // It is the difference with `zoneEmpty`: in these games you lose when you TRY to
    // draw with no cards, not when you run out. Confusing them brings the
    // defeat forward a whole turn.
    const def: GameDefinition = {
      ...GAME,
      lossConditions: [{ id: "deckout", name: "cannot draw", when: { kind: "cannotDraw" } }],
    };
    const state = createSession(def, DECKS, 11);
    applyAction(state, { type: "draw", player: 0, count: 19 }, 11);
    expect(state.players[0].zones.deck).toHaveLength(0);
    expect(state.result).toBeNull(); // vaciarlo no basta

    applyAction(state, { type: "draw", player: 0, count: 1 }, 11);
    expect(state.players[0].lost).toBe(true);
    expect(state.result?.winners).toEqual([1]);
  });

  test("winning by accumulating the rival's rewards", () => {
    const def: GameDefinition = {
      ...GAME,
      zones: [...GAME.zones, { id: "rewards", name: "Recompensas", visibility: "all" }],
      lossConditions: [
        {
          id: "rewards",
          name: "the opponent completed their rewards",
          when: { kind: "zoneAtLeast", zone: "rewards", count: 3, ofOpponent: true },
        },
      ],
    };
    const state = createSession(def, DECKS, 11);
    for (let i = 0; i < 3; i++) {
      applyAction(state, { type: "draw", player: 0, count: 1 }, 11);
      applyAction(
        state,
        {
          type: "move",
          player: 0,
          instanceId: state.players[0].zones.hand.at(-1)!.instanceId,
          toZone: "rewards",
          toPlayer: 0,
        },
        11
      );
    }
    // The loser is player 1, and the message comes out on the right player.
    expect(state.players[1].lost).toBe(true);
    expect(state.players[0].lost).toBe(false);
    expect(state.result?.winners).toEqual([0]);
  });
});

// ── The four real games ──────────────────────────────────────────────────────

describe("presets: seven TCGs described only with data", () => {
  test.each(Object.entries(PRESETS))("the definition of %s is valid", (_id, def) => {
    expect(validateGameDefinition(def)).toEqual([]);
  });

  /** Three copies per name: legal in all four presets (Yu-Gi-Oh is the strictest). */
  const fill = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => `${prefix}-${Math.floor(i / 3)}`);

  test("Palworld: 50 + 10 souls, two sections that are distributed to their zone", () => {
    const decks = [
      { main: fill(50, "p"), soul: fill(10, "s") },
      { main: fill(50, "q"), soul: fill(10, "t") },
    ];
    const state = createSession(PALWORLD_TCG, decks, 100);
    expect(state.players[0].zones.deck).toHaveLength(45); // 50 - 5 for the hand
    expect(state.players[0].zones.soulDeck).toHaveLength(10);
    expect(state.players[0].resources.hp).toBe(10);
    expect(state.globals.cycle).toBe("day");
  });

  test("ONE PIECE: a LEGAL deck passes validation", () => {
    /**
     * It looks obvious and was not: the ten DON!! are ten copies of the same
     * card and the general cap of 4 rejected them, so the validator
     * declared *any* ONE PIECE deck illegal. A validator that
     * rejects what is correct is worse than having none.
     */
    const legal = {
      leader: ["leader-a"],
      main: fill(50, "op"),
      don: Array.from({ length: 10 }, () => "DON!!"),
    };
    expect(validateDeck(ONEPIECE_CARD_GAME, legal)).toEqual([]);

    const state = createSession(ONEPIECE_CARD_GAME, [legal, legal], 300);
    expect(state.players[0].zones.donDeck).toHaveLength(10);
    expect(state.players[0].zones.leader).toHaveLength(1);
    expect(state.players[0].zones.deck).toHaveLength(45); // 50 − 5 for the hand
  });

  test("Riftbound: twelve of the same rune is legal", () => {
    const legal = {
      legend: ["legend-a"],
      main: fill(40, "rb"),
      runes: Array.from({ length: 12 }, () => "runa-fuego"),
    };
    expect(validateDeck(RIFTBOUND_TCG, legal)).toEqual([]);
  });

  test("Palworld: the cap of 8 Lucky and the 2-color one really apply", () => {
    const cards = fill(50, "p");
    const catalog = Object.fromEntries(
      [...new Set(cards)].map((id, i) => [
        id,
        { isLucky: true, colors: [["Red", "Blue", "Green"][i % 3]] },
      ])
    );
    const errors = validateDeck(PALWORLD_TCG, { main: cards, soul: fill(10, "s") }, catalog);
    expect(errors.some((e) => e.includes("Lucky"))).toBe(true);
    expect(errors.some((e) => e.includes("Colors"))).toBe(true);
  });

  test("Naruto: missions belong to the board and rewards decide the game", () => {
    const decks = [
      { leader: ["leader-a"], main: fill(50, "n") },
      { leader: ["leader-b"], main: fill(50, "m") },
    ];
    const state = createSession(NARUTO_CARD_GAME, decks, 200);
    expect(state.players[0].zones.leader).toHaveLength(1);
    expect(state.board.missions).toEqual([]);
    expect(state.players[0].zones.deck).toHaveLength(45);
  });

  test("Cyberpunk: gear attaches to the unit and follows it", () => {
    const decks = [
      { legend: ["legend-a"], main: fill(50, "c") },
      { legend: ["legend-b"], main: fill(50, "d") },
    ];
    const state = createSession(CYBERPUNK_TCG, decks, 300);
    const [unit, gear] = state.players[0].zones.hand;
    for (const card of [unit, gear]) {
      applyAction(
        state,
        { type: "move", player: 0, instanceId: card.instanceId, toZone: "units", toPlayer: 0 },
        300
      );
    }
    applyAction(
      state,
      { type: "attach", player: 0, instanceId: gear.instanceId, toInstanceId: unit.instanceId },
      300
    );
    applyAction(
      state,
      { type: "move", player: 0, instanceId: unit.instanceId, toZone: "trash", toPlayer: 0 },
      300
    );
    expect(state.players[0].zones.units).toHaveLength(0);
    expect(state.players[0].zones.trash).toHaveLength(2);
  });

  test("Yu-Gi-Oh: main + extra + side, and the side is NOT played", () => {
    const decks = [
      { main: fill(40, "y"), extra: fill(15, "e"), side: fill(15, "s") },
      { main: fill(40, "z"), extra: [], side: [] },
    ];
    const state = createSession(YUGIOH_ADVANCED, decks, 400);
    expect(state.players[0].zones.deck).toHaveLength(35);
    expect(state.players[0].zones.extra).toHaveLength(15);
    expect(state.players[0].zones.side).toHaveLength(15);
    expect(state.players[0].resources.lp).toBe(8000);
    // Not even the owner sees their side deck from the table: it is not in play.
    expect(viewFor(state, 0).players[0].zones.side).toHaveLength(0);
    expect(viewFor(state, 0).players[0].hiddenCounts.side).toBe(15);
  });

  test("Yu-Gi-Oh: five monster slots and not one more", () => {
    const decks = [
      { main: fill(40, "y"), extra: [], side: [] },
      { main: fill(40, "z"), extra: [], side: [] },
    ];
    const state = createSession(YUGIOH_ADVANCED, decks, 400);
    for (let i = 0; i < 5; i++) {
      applyAction(state, { type: "draw", player: 0, count: 1 }, 400);
      applyAction(
        state,
        {
          type: "move",
          player: 0,
          instanceId: state.players[0].zones.hand.at(-1)!.instanceId,
          toZone: "monsters",
          toPlayer: 0,
        },
        400
      );
    }
    expect(state.players[0].zones.monsters).toHaveLength(5);
    expect(() =>
      applyAction(
        state,
        {
          type: "move",
          player: 0,
          instanceId: state.players[0].zones.hand[0].instanceId,
          toZone: "monsters",
          toPlayer: 0,
        },
        400
      )
    ).toThrow(/full/);
  });

  test("an entire game of each preset is reproducible to the byte", () => {
    const script = (seat: number): Action[] => [
      { type: "roll", player: seat, sides: 6, count: 2 },
      { type: "draw", player: seat, count: 1 },
      { type: "peek", player: seat, zone: "deck", targetPlayer: seat, count: 2 },
      { type: "shuffleZone", player: seat, zone: "deck" },
      { type: "endTurn", player: seat },
      { type: "chat", player: seat, text: "voy" },
    ];
    const decks: Record<string, Record<string, string[]>[]> = {
      "palworld-tcg": [
        { main: fill(50, "p"), soul: fill(10, "s") },
        { main: fill(50, "q"), soul: fill(10, "t") },
      ],
      "naruto-cardgame": [
        { leader: ["la"], main: fill(50, "n") },
        { leader: ["lb"], main: fill(50, "m") },
      ],
      "cyberpunk-tcg": [
        { legend: ["ga"], main: fill(50, "c") },
        { legend: ["gb"], main: fill(50, "d") },
      ],
      "yugioh-advanced": [
        { main: fill(40, "y"), extra: [], side: [] },
        { main: fill(40, "z"), extra: [], side: [] },
      ],
      "onepiece-cardgame": [
        { leader: ["ol-a"], main: fill(50, "o"), don: fill(10, "don") },
        { leader: ["ol-b"], main: fill(50, "u"), don: fill(10, "don") },
      ],
      "riftbound-tcg": [
        { legend: ["rl-a"], main: fill(40, "r"), runes: fill(12, "rune") },
        { legend: ["rl-b"], main: fill(40, "s"), runes: fill(12, "rune") },
      ],
      // Lorcana declares no sections: its deck is a list and goes to "main".
      lorcana: [{ main: fill(60, "lo") }, { main: fill(60, "lp") }],
    };

    for (const [id, def] of Object.entries(PRESETS)) {
      // All four draw who starts, so the script is sent from the
      // seat whose turn it is — and that seat is already reproducible in itself.
      const seed = 5150;
      const first = createSession(def, decks[id], seed).activePlayer;
      const actions = script(first);
      const a = replay(def, decks[id], seed, actions);
      const b = replay(def, decks[id], seed, actions);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.log.length).toBeGreaterThan(0);
    }
  });
});

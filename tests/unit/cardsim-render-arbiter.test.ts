/**
 * kon-cardsim: the drawing contract and the arbiter contract
 * ============================================================================
 *
 * `./render` lays a table out and picks the card under a pointer, so any renderer (the Svelte
 * boards, a canvas, Estella) only draws. `./arbiter` lets a rules engine veto actions and add
 * follow-ups that are logged as ordinary actions — which is why a game played with an arbiter
 * must replay without it.
 */

import { describe, expect, test } from "vitest";

import {
  applyAction,
  createSession,
  replay,
  viewFor,
  type Action,
  type GameDefinition,
} from "../../kons/kon-cardsim/cardsim.engine";
import { hitTest, sceneFor, zoneAt } from "../../kons/kon-cardsim/cardsim.render";
import { arbitrate, ArbiterRefusal, MAX_FOLLOW_UPS, type Arbiter } from "../../kons/kon-cardsim/cardsim.arbiter";

const GAME: GameDefinition = {
  id: "contract-tcg",
  name: "Contract TCG",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
    { id: "board", name: "Board", visibility: "all", capacity: 6 },
    { id: "discard", name: "Discard", visibility: "all" },
  ],
  resources: [{ id: "life", name: "Life", initial: 20, min: 0, max: 20 }],
  deckRules: { minSize: 20, maxSize: 40, maxCopies: 3 },
  deckZone: "deck",
  handZone: "hand",
  openingHand: 5,
  phases: ["main", "end"],
};
const DECK = Array.from({ length: 30 }, (_, i) => `k-${i % 10}`);
const SEED = 4242;

function newGame() {
  return createSession(GAME, [DECK, [...DECK]], SEED);
}

// ── Drawing ──────────────────────────────────────────────────────────────────

describe("sceneFor", () => {
  test("your hand at the bottom with its cards; the rival's hand at the top as backs", () => {
    const state = newGame();
    const scene = sceneFor(viewFor(state, 0), GAME, 0, { width: 900 });
    const myHand = scene.cards.filter((c) => c.seat === 0 && c.zone === "hand");
    const theirHand = scene.cards.filter((c) => c.seat === 1 && c.zone === "hand");
    expect(myHand).toHaveLength(5);
    expect(myHand.every((c) => c.cardKey !== null && c.mine)).toBe(true);
    expect(theirHand).toHaveLength(5);
    expect(theirHand.every((c) => c.cardKey === null && !c.mine)).toBe(true);
    expect(Math.min(...myHand.map((c) => c.y))).toBeGreaterThan(Math.max(...theirHand.map((c) => c.y)));
  });

  test("every card stays inside its zone, even when the zone overflows", () => {
    const state = newGame();
    applyAction(state, { type: "draw", player: 0, count: 12 } as Action, SEED);
    const scene = sceneFor(viewFor(state, 0), GAME, 0, { width: 420 });
    for (const c of scene.cards) {
      const zone = scene.zones.find((z) => z.seat === c.seat && z.zone === c.zone)!;
      expect(c.x).toBeGreaterThanOrEqual(zone.x);
      expect(c.x + c.w).toBeLessThanOrEqual(zone.x + zone.w + 0.001);
    }
  });

  test("a pile is one stack with its count, and never shows the top card's face", () => {
    const scene = sceneFor(viewFor(newGame(), 0), GAME, 0, { width: 900 });
    const decks = scene.cards.filter((c) => c.zone === "deck");
    expect(decks).toHaveLength(2);
    expect(decks.every((c) => c.cardKey === null)).toBe(true);
    expect(scene.zones.find((z) => z.zone === "deck" && z.seat === 0)).toMatchObject({ pile: true, count: 25 });
  });

  test("a spectator sees seat 0 at the bottom and no card is theirs", () => {
    const scene = sceneFor(viewFor(newGame(), null), GAME, null, { width: 900 });
    expect(scene.cards.some((c) => c.mine)).toBe(false);
    const bottomHand = scene.zones.filter((z) => z.zone === "hand").at(-1)!;
    expect(bottomHand.seat).toBe(0);
  });

  test("the same view gives the same scene", () => {
    const view = viewFor(newGame(), 1);
    expect(sceneFor(view, GAME, 1, { width: 700 })).toEqual(sceneFor(view, GAME, 1, { width: 700 }));
  });
});

describe("hitTest and zoneAt", () => {
  test("the topmost card under the point; nothing between cards", () => {
    const scene = sceneFor(viewFor(newGame(), 0), GAME, 0, { width: 900 });
    const card = scene.cards.filter((c) => c.zone === "hand" && c.seat === 0)[2];
    const hit = hitTest(scene, card.x + card.w - 2, card.y + card.h / 2);
    expect(hit?.z).toBeGreaterThanOrEqual(card.z);
    expect(hit?.seat).toBe(0);
    expect(hitTest(scene, scene.width - 1, scene.height - 1)).toBeNull();
  });

  test("a tapped card is hit by its turned footprint", () => {
    const state = newGame();
    const id = state.players[0].zones.hand[0].instanceId;
    applyAction(state, { type: "move", player: 0, instanceId: id, toZone: "board", toPlayer: 0 } as Action, SEED);
    applyAction(state, { type: "tap", player: 0, instanceId: id, tapped: true } as Action, SEED);
    const scene = sceneFor(viewFor(state, 0), GAME, 0, { width: 900 });
    const c = scene.cards.find((x) => x.instanceId === id)!;
    expect(c.rotation).toBe(90);
    // Inside the turned card, outside the upright one.
    expect(hitTest(scene, c.x + c.w / 2 - c.h / 2 + 2, c.y + c.h / 2)?.instanceId).toBe(id);
    expect(hitTest(scene, c.x + c.w / 2, c.y + 2)?.instanceId).not.toBe(id);
  });

  test("zoneAt says where a dragged card would land", () => {
    const scene = sceneFor(viewFor(newGame(), 0), GAME, 0, { width: 900 });
    const board = scene.zones.find((z) => z.zone === "board" && z.seat === 0)!;
    expect(zoneAt(scene, board.x + 5, board.y + 5)).toMatchObject({ zone: "board", seat: 0 });
  });
});

// ── The arbiter ──────────────────────────────────────────────────────────────

/** Toy rules: one draw per turn (the opening hand aside); ending a turn makes the next seat draw. */
const toyRules: Arbiter = {
  id: "toy",
  games: ["contract-tcg"],
  check({ state, action }) {
    if (action.type !== "draw") return { allow: true };
    const drewThisTurn = state.log.some((l) => l.type === "draw" && l.player === action.player && (l.data as any)?.turn === state.turn);
    return drewThisTurn ? { allow: false, reason: "One draw per turn" } : { allow: true };
  },
  after({ state, action }) {
    if (action.type !== "endTurn") return [];
    return [{ type: "draw", player: state.activePlayer, count: 1 } as Action];
  },
};

describe("arbitrate", () => {
  test("a refused action is not applied", async () => {
    const state = newGame();
    const before = JSON.stringify(viewFor(state, 0));
    const strict: Arbiter = { id: "no", games: ["contract-tcg"], check: () => ({ allow: false, reason: "Not now" }) };
    await expect(
      arbitrate(strict, { definition: GAME, state, action: { type: "draw", player: 0, count: 1 } as Action, seed: SEED })
    ).rejects.toThrow(ArbiterRefusal);
    expect(JSON.stringify(viewFor(state, 0))).toBe(before);
  });

  test("follow-ups are applied and returned as ordinary actions, and the game replays without the arbiter", async () => {
    const state = newGame();
    const log: Action[] = [];
    log.push(...(await arbitrate(toyRules, { definition: GAME, state, action: { type: "endTurn", player: 0 } as Action, seed: SEED })));
    expect(log.map((a) => a.type)).toEqual(["endTurn", "draw"]);
    expect((log[1] as any).player).toBe(1);
    const replayed = replay(GAME, [DECK, [...DECK]], SEED, log);
    expect(viewFor(replayed, 1)).toEqual(viewFor(state, 1));
  });

  test("an arbiter for another game refuses; one that loops is stopped", async () => {
    const other: Arbiter = { ...toyRules, id: "other", games: ["something-else"] };
    await expect(
      arbitrate(other, { definition: GAME, state: newGame(), action: { type: "endTurn", player: 0 } as Action, seed: SEED })
    ).rejects.toThrow(/does not know/);
    const looping: Arbiter = {
      id: "loop",
      games: ["contract-tcg"],
      check: () => ({ allow: true }),
      after: () => [{ type: "resource", player: 0, target: 0, resource: "life", delta: 0 } as Action],
    };
    await expect(
      arbitrate(looping, { definition: GAME, state: newGame(), action: { type: "endTurn", player: 0 } as Action, seed: SEED })
    ).rejects.toThrow(new RegExp(`more than ${MAX_FOLLOW_UPS}`));
  });
});

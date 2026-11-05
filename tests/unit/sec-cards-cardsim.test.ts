/**
 * kon-cardsim security — real routes against real SQL (PGlite)
 * ============================================================================
 *
 * `viewFor` is the simulator's secrecy layer, but the secret can be
 * broken BEFORE reaching it: by choosing the seed, seating someone
 * else's deck, sending an action that reveals the opponent's hand, or asking for the replay
 * of a private room. And the catalog (game definitions, cards) was only
 * protected by a prefix rule in `auth-guard.ts`: the kon asked about
 * `create`, which any account grants.
 *
 * Each block here failed before the fix it names.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { respondError } from "@kitsuden/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createKonCardsim, kon as konCardsim } from "../../kons/kon-cardsim/index";
import { registerCardsimPolicy } from "../../kons/kon-cardsim/cardsim.policy";
import {
  applyAction,
  checkSecrecy,
  createSession,
  type GameDefinition,
} from "../../kons/kon-cardsim/cardsim.engine";

const ROOT = resolve(__dirname, "../..");

const ANA = { id: "u-ana", role: "user" };
const BEA = { id: "u-bea", role: "user" };
const EVA = { id: "u-eva", role: "user" };
const EDITOR = { id: "u-ed", role: "editor" };
const CATALOG_AGENT = { id: "ag-1", role: "agent", scopes: ["cardsim:manageCatalog"] };
const CONTENT_AGENT = { id: "ag-2", role: "agent", scopes: ["content:edit"] };

const GAME: GameDefinition = {
  id: "seg-tcg",
  name: "Seg TCG",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
    { id: "board", name: "Mesa", visibility: "all", capacity: 5 },
    { id: "discard", name: "Discard", visibility: "all" },
  ],
  resources: [{ id: "life", name: "Life", initial: 20, min: 0, max: 20 }],
  deckRules: { minSize: 20, maxSize: 40, maxCopies: 3 },
  deckZone: "deck",
  handZone: "hand",
  openingHand: 5,
  phases: ["main", "end"],
};

const deck = (prefix: string) =>
  Array.from({ length: 24 }, (_, i) => `${prefix}-card-${Math.floor(i / 3)}`);

let client: PGlite;
let app: ReturnType<typeof createKonCardsim>;
let gameId: string;

/** Identity travels in a header: the real auth is not what is tested here. */
function userFrom(c: any) {
  const raw = c.req.header("x-test-user");
  return raw ? JSON.parse(raw) : null;
}
const fakeAuth = {
  requireAuth: (c: any, next: any) => {
    const u = userFrom(c);
    if (!u) return c.json({ error: "Unauthorized" }, 401);
    c.set("user", u);
    return next();
  },
  optionalAuth: (c: any, next: any) => {
    const u = userFrom(c);
    if (u) c.set("user", u);
    return next();
  },
};

async function call(method: string, path: string, user: object | null, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = JSON.stringify(user);
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* 204 */
  }
  return { status: res.status, json };
}

async function deckOf(user: object, prefix: string): Promise<string> {
  const r = await call("POST", "/decks", user, { gameId, name: prefix, cards: deck(prefix) });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.data.id;
}

/** Ana creates, Bea sits down: a two-player game in progress. */
async function twoPlayerGame(opts: { allowSpectators?: boolean } = {}) {
  const deckAna = await deckOf(ANA, "a");
  const deckBea = await deckOf(BEA, "b");
  const created = await call("POST", "/sessions", ANA, {
    gameId,
    deckIds: [deckAna],
    allowSpectators: opts.allowSpectators ?? true,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.data.id as string;
  const joined = await call("POST", `/sessions/${id}/join`, BEA, { seat: 1, deckId: deckBea });
  expect(joined.status, JSON.stringify(joined.json)).toBe(200);
  return id;
}

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client);
  const dir = join(ROOT, "kons/kon-cardsim/migrations");
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  const ctx = createTestKonContext({
    db: { instance: db } as any,
    auth: fakeAuth as any,
    realtime: { broadcast: () => {}, sendToUser: () => {} } as any,
  });
  app = createKonCardsim(ctx);
  app.onError((err, c) => respondError(c, err));
  registerCardsimPolicy();

  const r = await call("PUT", "/games", EDITOR, { slug: "seg-tcg", definition: GAME });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  gameId = r.json.data.id;
  // Separate game for the catalog tests: putting cards into `seg-tcg`
  // would make the test decks stop validating.
  expect((await call("PUT", "/games", EDITOR, { slug: "seg-cat", definition: GAME })).status).toBe(
    201
  );
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerCardsimPolicy();
});

// ── Catalog: policy, not prefix ─────────────────────────────────────────────

describe("the catalog is editorial (before: any account, only auth-guard covered it)", () => {
  test("a normal account does NOT publish or rewrite a game's definition", async () => {
    const r = await call("PUT", "/games", EVA, { slug: "seg-cat", definition: GAME });
    expect(r.status).toBe(403);
  });

  test("a normal account does NOT add cards or sync the catalog", async () => {
    const cards = await call("POST", "/games/seg-cat/cards", EVA, {
      cards: [{ cardId: "x", name: "X" }],
    });
    expect(cards.status).toBe(403);
    const sync = await call("POST", "/games/seg-cat/sync-catalog", EVA, { datasetId: "d" });
    expect(sync.status).toBe(403);
  });

  test("editing does; and an agent with `cardsim:manageCatalog` too", async () => {
    const ed = await call("POST", "/games/seg-cat/cards", EDITOR, {
      cards: [{ cardId: "a-card-0", name: "Carta A0" }],
    });
    expect(ed.status).toBe(201);
    const ag = await call("POST", "/games/seg-cat/cards", CATALOG_AGENT, {
      cards: [{ cardId: "a-card-1", name: "Carta A1" }],
    });
    expect(ag.status).toBe(201);
  });

  test("the `content:edit` scope does NOT open the simulator's catalog", async () => {
    const r = await call("PUT", "/games", CONTENT_AGENT, { slug: "seg-cat", definition: GAME });
    expect(r.status).toBe(403);
  });
});

// ── Sealing: DoS ────────────────────────────────────────────────────────────

describe("POST /games/:slug/sealed", () => {
  test("a pack of a billion cards is rejected, not attempted", async () => {
    const r = await call("POST", "/games/seg-tcg/sealed", EVA, { slots: { "": 1_000_000_000 } });
    expect(r.status).toBe(422);
  });

  test("a normal pack keeps working", async () => {
    const r = await call("POST", "/games/seg-cat/sealed", EVA, { packs: 2, packSize: 3 });
    expect(r.status).toBe(200);
    expect(r.json.data.pool).toHaveLength(6);
  });
});

// ── Create room: seed and other people's decks ──────────────────────────────

describe("create room", () => {
  test("in a two-player game the client does NOT choose the seed", async () => {
    const d = await deckOf(ANA, "a");
    const r = await call("POST", "/sessions", ANA, { gameId, deckIds: [d], seed: 1234 });
    expect(r.status).toBe(422);
  });

  test("solo it does (to reproduce and debug)", async () => {
    const d = await deckOf(ANA, "a");
    const r = await call("POST", "/sessions", ANA, {
      gameId,
      deckIds: [d],
      seed: 1234,
      solo: true,
    });
    expect(r.status).toBe(201);
  });

  test("another person's PRIVATE deck cannot be seated", async () => {
    const foreign = await deckOf(BEA, "b");
    const r = await call("POST", "/sessions", EVA, { gameId, deckIds: [foreign], solo: true });
    expect(r.status).toBe(404);
  });

  test("nor a deck from another game", async () => {
    const other = await call("PUT", "/games", EDITOR, { slug: "seg-otro", definition: GAME });
    const d = await call("POST", "/decks", ANA, {
      gameId: other.json.data.id,
      cards: deck("a"),
    });
    const r = await call("POST", "/sessions", ANA, { gameId, deckIds: [d.json.data.id] });
    expect(r.status).toBe(422);
  });

  test("decks carry size caps", async () => {
    const r = await call("POST", "/decks", ANA, {
      gameId,
      cards: Array.from({ length: 5000 }, () => "a-card-0"),
    });
    expect(r.status).toBe(422);
  });
});

// ── The action customs ──────────────────────────────────────────────────────

describe("an action over the network does not reveal the opponent's secrets", () => {
  test("looking at the opponent's hand or deck: 409", async () => {
    const id = await twoPlayerGame();
    for (const zone of ["hand", "deck"]) {
      const r = await call("POST", `/sessions/${id}/action`, ANA, {
        seat: 0,
        action: { type: "peek", zone, targetPlayer: 1, count: 5 },
      });
      expect(r.status, zone).toBe(409);
    }
    // Looking at your own is still legal.
    const own = await call("POST", `/sessions/${id}/action`, ANA, {
      seat: 0,
      action: { type: "peek", zone: "deck", targetPlayer: 0, count: 2 },
    });
    expect(own.status).toBe(200);
  });

  test("moving a card from the opponent's deck to the table: 409, and it does not enter the log", async () => {
    const id = await twoPlayerGame();
    // Since the secret seed (audit 2026-10-25) the instanceIds are handed out
    // at random: you can no longer count on "seat 1's are 25..48". A
    // HIDDEN opponent card that Ana cannot see: the first in Bea's hand (seen
    // de Bea).
    const deBea = await call("GET", `/sessions/${id}`, BEA);
    const hiddenOne = deBea.json.data.players[1].zones.hand[0].instanceId as number;
    const r = await call("POST", `/sessions/${id}/action`, ANA, {
      seat: 0,
      action: { type: "move", instanceId: hiddenOne, toZone: "board", toPlayer: 0 },
    });
    expect(r.status).toBe(409);
    const view = await call("GET", `/sessions/${id}`, ANA);
    expect(view.json.actionCount).toBe(0);
    expect(view.json.data.players[0].zones.board).toHaveLength(0);
  });

  test("emptying the opponent's hand into their discard (public): 409", async () => {
    const id = await twoPlayerGame();
    const r = await call("POST", `/sessions/${id}/action`, ANA, {
      seat: 0,
      action: { type: "moveZone", fromZone: "hand", fromPlayer: 1, toZone: "discard", toPlayer: 1 },
    });
    expect(r.status).toBe(409);
    const random = await call("POST", `/sessions/${id}/action`, ANA, {
      seat: 0,
      action: {
        type: "randomMove",
        fromZone: "deck",
        fromPlayer: 1,
        toZone: "board",
        toPlayer: 0,
        count: 5,
      },
    });
    expect(random.status).toBe(409);
  });

  test("revealing to everyone a hidden card of the opponent: 409", async () => {
    const id = await twoPlayerGame();
    // random instanceId (secret seed): a card from Bea's hand
    const deBea = await call("GET", `/sessions/${id}`, BEA);
    const hiddenOne = deBea.json.data.players[1].zones.hand[0].instanceId as number;
    const r = await call("POST", `/sessions/${id}/action`, ANA, {
      seat: 0,
      action: { type: "reveal", instanceIds: [hiddenOne] },
    });
    expect(r.status).toBe(409);
  });

  test("and with their own things, the player keeps playing normally", async () => {
    const id = await twoPlayerGame();
    const view = await call("GET", `/sessions/${id}`, ANA);
    const mine = view.json.data.players[0].zones.hand[0].instanceId;
    const r = await call("POST", `/sessions/${id}/action`, ANA, {
      seat: 0,
      action: { type: "move", instanceId: mine, toZone: "board", toPlayer: 0 },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // The opponent sees it (public table) and does not see Ana's hand.
    const deBea = await call("GET", `/sessions/${id}`, BEA);
    expect(deBea.json.data.players[0].zones.board[0].cardId).toMatch(/^a-card/);
    expect(deBea.json.data.players[0].zones.hand).toHaveLength(0);
    expect(deBea.json.data.players[0].hiddenCounts.hand).toBe(4);
    // And the response never carries a seed or decks.
    expect(JSON.stringify(deBea.json)).not.toMatch(/"seed"|"decks"/);
  });

  test("acting from the opponent's seat is still forbidden", async () => {
    const id = await twoPlayerGame();
    const r = await call("POST", `/sessions/${id}/action`, ANA, {
      seat: 1,
      action: { type: "concede" },
    });
    expect(r.status).toBe(403);
  });
});

describe("checkSecrecy (engine)", () => {
  test("flipping or counting on someone else's face-down card on a public table does NOT reveal: passes", () => {
    const state = createSession(GAME, [deck("a"), deck("b")], 7);
    const bea = state.players[1].zones.hand[0];
    applyAction(
      state,
      {
        type: "move",
        player: 1,
        instanceId: bea.instanceId,
        toZone: "board",
        toPlayer: 1,
        faceDown: true,
      },
      7
    );
    expect(() =>
      checkSecrecy(state, { type: "tap", player: 0, instanceId: bea.instanceId, tapped: true })
    ).not.toThrow();
    // But turning it over or moving it does reveal.
    expect(() =>
      checkSecrecy(state, { type: "flip", player: 0, instanceId: bea.instanceId })
    ).toThrow();
    expect(() =>
      checkSecrecy(state, {
        type: "move",
        player: 0,
        instanceId: bea.instanceId,
        toZone: "discard",
        toPlayer: 1,
      })
    ).toThrow();
  });

  test("what the opponent has already shown can be touched", () => {
    const state = createSession(GAME, [deck("a"), deck("b")], 7);
    const bea = state.players[1].zones.hand[0];
    applyAction(state, { type: "reveal", player: 1, instanceIds: [bea.instanceId], to: [0] }, 7);
    expect(() =>
      checkSecrecy(state, {
        type: "move",
        player: 0,
        instanceId: bea.instanceId,
        toZone: "discard",
        toPlayer: 1,
      })
    ).not.toThrow();
  });
});

// ── Replay ──────────────────────────────────────────────────────────────────

describe("GET /sessions/:id/replay", () => {
  test("a room without spectators does not publish its decks to third parties, even when finished", async () => {
    const id = await twoPlayerGame({ allowSpectators: false });
    const fin = await call("POST", `/sessions/${id}/action`, BEA, {
      seat: 1,
      action: { type: "concede" },
    });
    expect(fin.status).toBe(200);
    expect((await call("GET", `/sessions/${id}/replay`, null)).status).toBe(403);
    expect((await call("GET", `/sessions/${id}/replay`, EVA)).status).toBe(403);
    // Those who played, yes.
    const ana = await call("GET", `/sessions/${id}/replay`, ANA);
    expect(ana.status).toBe(200);
    expect(ana.json.data.decks).toHaveLength(2);
  });

  test("a room with spectators still publishes it when finished", async () => {
    const id = await twoPlayerGame();
    await call("POST", `/sessions/${id}/action`, BEA, { seat: 1, action: { type: "concede" } });
    expect((await call("GET", `/sessions/${id}/replay`, null)).status).toBe(200);
  });
});

// ── Elo y revanchas ─────────────────────────────────────────────────────────

describe("a rematch does not move the Elo of a closed match again", () => {
  test("ranked queue → surrender → rematch → surrender: the Elo moves ONCE", async () => {
    const dA = await deckOf(ANA, "a");
    const dB = await deckOf(BEA, "b");
    expect((await call("POST", "/queue", ANA, { gameId, deckId: dA, rated: true })).status).toBe(
      202
    );
    const m = await call("POST", "/queue", BEA, { gameId, deckId: dB, rated: true });
    expect(m.status).toBe(201);
    const sid = m.json.data.sessionId;

    await call("POST", `/sessions/${sid}/action`, BEA, { seat: 1, action: { type: "concede" } });
    const after1 = (await call("GET", "/ratings/seg-tcg", null)).json.data;
    const ana1 = after1.find((r: any) => r.userId === ANA.id).rating;

    const re = await call("POST", `/sessions/${sid}/rematch`, BEA);
    expect(re.status).toBe(201);
    await call("POST", `/sessions/${re.json.data.id}/action`, BEA, {
      seat: 1,
      action: { type: "concede" },
    });
    const after2 = (await call("GET", "/ratings/seg-tcg", null)).json.data;
    const ana2 = after2.find((r: any) => r.userId === ANA.id);
    expect(ana2.rating).toBe(ana1);
    expect(ana2.wins).toBe(1);
  });
});

describe("room password: brake against brute force", () => {
  // Audit 2026-10-18: `/sessions/:id/join` checks the room's
  // password and only had the global limit (300/min, and open without Valkey).
  test("POST /sessions/:id/join declares a fail-closed limit", () => {
    const rule = konCardsim.rateLimits?.find((r) => r.path === "/sessions/:id/join");
    expect(rule).toBeDefined();
    expect(rule!.limit).toBeLessThanOrEqual(20);
    expect(rule!.failClosed).toBe(true);
  });
});

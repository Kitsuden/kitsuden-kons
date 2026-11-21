/**
 * kon-cardsim: the two-player table's realtime relay
 * ============================================================================
 *
 * The table syncs over the host's WebSocket. These tests play whole games against the real routes
 * (PGlite) with a realtime host that records every message, and hold the relay to its contract
 * (`cardsim.relay.ts`):
 *
 *   1. Zero assets: no message carries a card, a deck, an image or an image link — only "what
 *      happened, and its number". The one exception is a player explicitly sharing their image
 *      source, and that goes only to the players.
 *   2. Its own namespace (`kon:cardsim:`), the only one the host lets players hear. Before, the kon
 *      broadcast on `cardsim:session:<id>`, which the host keeps for admins: no player ever got an
 *      event.
 *   3. Who may listen: players; spectators only where the room admits them.
 *   4. A retried action is never applied twice (`expectActionCount`), and a rematch pressed by both
 *      players is one game.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { respondError } from "@kitsuden/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createKonCardsim } from "../../kons/kon-cardsim/index";
import { registerCardsimPolicy } from "../../kons/kon-cardsim/cardsim.policy";
import type { GameDefinition } from "../../kons/kon-cardsim/cardsim.engine";
import { isImageKey, looksLikeImageUrl } from "../../kons/kon-cardsim/cardsim.images";
import { EVENT_KEYS, parseTableEvent } from "../../kons/kon-cardsim/cardsim.relay";

const ROOT = resolve(__dirname, "../..");

const ANA = { id: "u-ana", role: "user" };
const BEA = { id: "u-bea", role: "user" };
const EVA = { id: "u-eva", role: "user" };
const EDITOR = { id: "u-ed", role: "editor" };

const GAME: GameDefinition = {
  id: "relay-tcg",
  name: "Relay TCG",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
    { id: "board", name: "Board", visibility: "all", capacity: 5 },
    { id: "discard", name: "Discard", visibility: "all" },
  ],
  resources: [{ id: "life", name: "Life", initial: 20, min: 0, max: 20 }],
  deckRules: { minSize: 20, maxSize: 40, maxCopies: 3 },
  deckZone: "deck",
  handZone: "hand",
  openingHand: 5,
  phases: ["main", "end"],
};

const CARDS = Array.from({ length: 10 }, (_, i) => ({
  cardId: `rc-${i}`,
  name: `Relay Card ${i}`,
  imageUrl: `https://cdn.example.org/relay/rc-${i}.webp`,
  data: { cost: i, image_url: `/media/cartas/rc-${i}.webp` },
}));
const DECK = CARDS.flatMap((c) => [c.cardId, c.cardId, c.cardId]);

let client: PGlite;
let app: ReturnType<typeof createKonCardsim>;
let gameId: string;

/** Every message the kon asked the host to send. */
const sent: { channel: string; event: any }[] = [];
let authorize: (rest: string, user: { id: string | null; role: string | null }) => Promise<boolean>;

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

async function deckOf(user: object): Promise<string> {
  const r = await call("POST", "/decks", user, { gameId, name: "d", cards: DECK });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.data.id;
}

async function table(opts: { allowSpectators?: boolean; timeControlSeconds?: number; bestOf?: number } = {}) {
  const created = await call("POST", "/sessions", ANA, {
    gameId,
    deckIds: [await deckOf(ANA)],
    allowSpectators: opts.allowSpectators ?? false,
    ...(opts.timeControlSeconds ? { timeControlSeconds: opts.timeControlSeconds } : {}),
    ...(opts.bestOf ? { bestOf: opts.bestOf } : {}),
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.data.id as string;
  const joined = await call("POST", `/sessions/${id}/join`, BEA, { seat: 1, deckId: await deckOf(BEA) });
  expect(joined.status, JSON.stringify(joined.json)).toBe(200);
  return id;
}

const actionCount = async (id: string) => (await call("GET", `/sessions/${id}`, ANA)).json.actionCount as number;
const handOf = async (id: string, user: object) =>
  (await call("GET", `/sessions/${id}`, user)).json.data.players.find((p: any) => p.zones?.hand)?.zones.hand;

beforeAll(async () => {
  client = new PGlite();
  const dir = join(ROOT, "kons/kon-cardsim/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: fakeAuth as any,
    realtime: {
      broadcast: (channel: string, event: unknown) => sent.push({ channel, event }),
      sendToUser: () => {},
      channels: (fn: typeof authorize) => (authorize = fn),
    } as any,
  });
  app = createKonCardsim(ctx);
  app.onError((err, c) => respondError(c, err));
  registerCardsimPolicy();

  const g = await call("PUT", "/games", EDITOR, { slug: "relay-tcg", definition: GAME });
  expect(g.status).toBe(201);
  gameId = g.json.data.id;
  // A HOSTED game, with images: the relay must not carry them even when the API may.
  expect((await call("POST", "/games/relay-tcg/cards", EDITOR, { cards: CARDS })).status).toBe(201);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerCardsimPolicy();
});

// ── 1 and 2: a whole game, every message checked ────────────────────────────

describe("a whole game over the relay", () => {
  let id: string;
  let rematch: string;

  beforeAll(async () => {
    sent.length = 0;
    id = await table({ bestOf: 3 });
    expect((await call("POST", `/sessions/${id}/action`, ANA, { seat: 0, action: { type: "draw", count: 1 } })).status).toBe(200);
    const hand = await handOf(id, ANA);
    const card = hand[0];
    expect(
      (await call("POST", `/sessions/${id}/action`, ANA, {
        seat: 0,
        action: { type: "move", instanceId: card.instanceId, toZone: "board", toPlayer: 0 },
      })).status
    ).toBe(200);
    await call("POST", `/sessions/${id}/action`, ANA, { seat: 0, action: { type: "tap", instanceId: card.instanceId, tapped: true } });
    await call("POST", `/sessions/${id}/action`, ANA, { seat: 0, action: { type: "endTurn" } });
    // Undo: asked by Bea, accepted by Ana with the same count.
    const n = await actionCount(id);
    await call("POST", `/sessions/${id}/undo`, BEA, { toActionCount: n - 1 });
    await call("DELETE", `/sessions/${id}/undo`, BEA);
    await call("POST", `/sessions/${id}/undo`, BEA, { toActionCount: n - 1 });
    expect((await call("POST", `/sessions/${id}/undo`, ANA, { toActionCount: n - 1 })).status).toBe(200);
    // Ana shares her template with Bea.
    const shared = await call("POST", `/sessions/${id}/share-source`, ANA, {
      source: { kind: "template", label: "Mirror", url: "https://img.example.org/{id}.webp" },
    });
    expect(shared.status, JSON.stringify(shared.json)).toBe(202);
    await call("POST", `/sessions/${id}/action`, BEA, { seat: 1, action: { type: "concede" } });
    // Both press rematch.
    const a = await call("POST", `/sessions/${id}/rematch`, ANA);
    const b = await call("POST", `/sessions/${id}/rematch`, BEA);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.json.data.id).toBe(a.json.data.id);
    rematch = a.json.data.id;
  });

  test("every message went out, and only on the kon's own channels", () => {
    const types = sent.map((m) => m.event.type);
    for (const t of ["join", "action", "undoRequest", "undoCancelled", "undo", "sourceShared", "rematch"]) {
      expect(types, t).toContain(t);
    }
    for (const m of sent) expect(m.channel).toMatch(new RegExp(`^kon:cardsim:session:${id}(:players)?$`));
  });

  test("each message is a known event with only its own keys", () => {
    for (const m of sent) {
      expect(parseTableEvent(m.event), JSON.stringify(m.event)).not.toBeNull();
      expect(Object.keys(m.event).sort()).toEqual([...EVENT_KEYS[m.event.type as keyof typeof EVENT_KEYS]].sort());
    }
  });

  test("no message carries a card, an instance or an image", () => {
    const cardIds = new Set(CARDS.map((c) => c.cardId));
    const walk = (v: unknown, path: string): string | null => {
      if (typeof v === "string") {
        if (cardIds.has(v)) return `${path} names a card`;
        if (looksLikeImageUrl(v)) return `${path} is an image link`;
        return null;
      }
      if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`)).find(Boolean) ?? null;
      if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (isImageKey(k) || k === "instanceId" || k === "cardId" || k === "zones" || k === "decks") {
            return `${path}.${k}`;
          }
          const hit = walk(x, `${path}.${k}`);
          if (hit) return hit;
        }
      }
      return null;
    };
    const game = sent.filter((m) => m.event.type !== "sourceShared");
    expect(game.map((m) => walk(m.event, m.event.type)).filter(Boolean)).toEqual([]);
  });

  test("a shared source goes only to the players, and is the player's own link", () => {
    const shared = sent.filter((m) => m.event.type === "sourceShared");
    expect(shared).toHaveLength(1);
    expect(shared[0].channel).toBe(`kon:cardsim:session:${id}:players`);
    expect(shared[0].event.source).toEqual({ kind: "template", label: "Mirror", url: "https://img.example.org/{id}.webp" });
  });

  test("the rematch is one table for both players", async () => {
    const r = await call("GET", `/sessions/${rematch}`, BEA);
    expect(r.status).toBe(200);
    expect(r.json.seat).toBe(1);
    expect(sent.filter((m) => m.event.type === "rematch")).toHaveLength(1);
  });
});

// ── 3: who may listen ────────────────────────────────────────────────────────

describe("who may listen to a table", () => {
  test("players always; nobody else when the room has no spectators", async () => {
    const id = await table({ allowSpectators: false });
    expect(await authorize(`session:${id}`, { id: ANA.id, role: "user" })).toBe(true);
    expect(await authorize(`session:${id}`, { id: BEA.id, role: "user" })).toBe(true);
    expect(await authorize(`session:${id}`, { id: EVA.id, role: "user" })).toBe(false);
    expect(await authorize(`session:${id}`, { id: null, role: null })).toBe(false);
    // Not even an admin: the kon decides, and the room said no spectators.
    expect(await authorize(`session:${id}`, { id: "u-adm", role: "admin" })).toBe(false);
  });

  test("anyone where the room admits spectators, but the players' channel stays the players'", async () => {
    const id = await table({ allowSpectators: true });
    expect(await authorize(`session:${id}`, { id: EVA.id, role: "user" })).toBe(true);
    expect(await authorize(`session:${id}`, { id: null, role: null })).toBe(true);
    expect(await authorize(`session:${id}:players`, { id: EVA.id, role: "user" })).toBe(false);
    expect(await authorize(`session:${id}:players`, { id: null, role: null })).toBe(false);
    expect(await authorize(`session:${id}:players`, { id: BEA.id, role: "user" })).toBe(true);
  });

  test("anything that is not a table is denied", async () => {
    for (const rest of ["session:nope", "session:", "decks", "session:a/b", "session:x:players:more", "queue"]) {
      expect(await authorize(rest, { id: ANA.id, role: "user" }), rest).toBe(false);
    }
  });
});

// ── 4: retries and the clock ─────────────────────────────────────────────────

describe("an action is applied once", () => {
  test("a stale count is refused and nothing is applied", async () => {
    const id = await table();
    const n = await actionCount(id);
    const ok = await call("POST", `/sessions/${id}/action`, ANA, { seat: 0, action: { type: "draw", count: 1 }, expectActionCount: n });
    expect(ok.status).toBe(200);
    // The response was "lost" and the client retries the same action with the same count.
    const retry = await call("POST", `/sessions/${id}/action`, ANA, { seat: 0, action: { type: "draw", count: 1 }, expectActionCount: n });
    expect(retry.status).toBe(409);
    expect(retry.json).toMatchObject({ stale: true, actionCount: n + 1 });
    expect(await actionCount(id)).toBe(n + 1);
  });

  test("without the count it behaves as before", async () => {
    const id = await table();
    const n = await actionCount(id);
    expect((await call("POST", `/sessions/${id}/action`, ANA, { seat: 0, action: { type: "draw", count: 1 } })).status).toBe(200);
    expect(await actionCount(id)).toBe(n + 1);
  });
});

describe("the clock runs out", () => {
  test("reading the table enforces it and tells the table", async () => {
    const id = await table({ timeControlSeconds: 60 });
    await client.query("UPDATE cardsim_sessions SET clock_started_at = now() - interval '10 minutes' WHERE id = $1", [id]);
    sent.length = 0;
    const r = await call("GET", `/sessions/${id}`, BEA);
    expect(r.json.timedOut).toBe(0);
    expect(r.json.status).toBe("finished");
    expect(sent.map((m) => m.event)).toContainEqual({ type: "timeout", seat: 0 });
  });
});

// ── Sharing a source ─────────────────────────────────────────────────────────

describe("sharing an image source", () => {
  test("only seated players, only templates and packs, only public https links", async () => {
    const id = await table({ allowSpectators: true });
    const share = (user: object, source: unknown) => call("POST", `/sessions/${id}/share-source`, user, { source });
    expect((await share(EVA, { kind: "pack", label: "P", url: "https://e.org/p.json" })).status).toBe(403);
    expect((await share(ANA, { kind: "folder", label: "My scans" })).status).toBe(422);
    expect((await share(ANA, { kind: "cardUrls", label: "L", urls: { a: "https://e.org/a.png" } })).status).toBe(422);
    expect((await share(ANA, { kind: "pack", label: "P", url: "https://192.168.0.2/p.json" })).status).toBe(422);
    expect((await share(ANA, { kind: "pack", label: "P", url: "http://e.org/p.json" })).status).toBe(422);
    expect((await share(BEA, { kind: "pack", label: "P", url: "https://e.org/p.json" })).status).toBe(202);
  });
});

// ── Card names for the board ─────────────────────────────────────────────────

describe("lookup-cards", () => {
  test("names and data in the order asked, unknown ids left out", async () => {
    const r = await call("POST", "/games/relay-tcg/cards/lookup", null, { ids: ["rc-2", "nope", "rc-0", "rc-2"] });
    expect(r.status).toBe(200);
    expect(r.json.data.map((c: any) => c.cardId)).toEqual(["rc-2", "rc-0"]);
    expect(r.json.data[0].name).toBe("Relay Card 2");
  });

  test("in byod no image; and at most 200 ids", async () => {
    await call("PUT", "/games/relay-tcg/image-mode", EDITOR, { imageMode: "byod" });
    const r = await call("POST", "/games/relay-tcg/cards/lookup", null, { ids: ["rc-1"] });
    expect(r.json.data[0]).toEqual({ cardId: "rc-1", name: "Relay Card 1", data: { cost: 1 } });
    await call("PUT", "/games/relay-tcg/image-mode", EDITOR, { imageMode: "hosted" });
    const many = await call("POST", "/games/relay-tcg/cards/lookup", null, { ids: Array.from({ length: 201 }, (_, i) => `x${i}`) });
    expect(many.status).toBe(422);
  });
});

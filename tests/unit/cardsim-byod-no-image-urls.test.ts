/**
 * kon-cardsim in `byod`: no response names a card image
 * ============================================================================
 *
 * "Bring your own data" only protects anyone if it holds on EVERY route. A single operation that
 * still hydrated `imageUrl` (the showcase used to, in three places) would put the server back in
 * the business of naming images it does not own.
 *
 * So this walks the kon's operations, ALL of them: each one is either called below in a `byod`
 * game and its whole response scanned, or listed in `NOT_SCANNED` with the reason. A new
 * operation that is in neither list fails the coverage test, which is the point: whoever adds it
 * has to decide.
 *
 * The control: the same catalog in a `hosted` game DOES return `imageUrl`, and switching the
 * `byod` game back brings them back. Without it, a test that only checks for absence would also
 * pass if the cards had no images at all.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { respondError } from "@kitsuden/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { allOperations, createKonCardsim } from "../../kons/kon-cardsim/index";
import { registerCardsimPolicy } from "../../kons/kon-cardsim/cardsim.policy";
import { registerDeckshowPolicy } from "../../kons/kon-cardsim/deckshow.policy";
import { registerHandlabPolicy } from "../../kons/kon-cardsim/handlab.policy";
import { isImageKey, looksLikeImageUrl } from "../../kons/kon-cardsim/cardsim.images";
import type { GameDefinition } from "../../kons/kon-cardsim/cardsim.engine";

const ROOT = resolve(__dirname, "../..");

const ANA = { id: "u-ana", role: "user" };
const BEA = { id: "u-bea", role: "user" };
const EVA = { id: "u-eva", role: "user" };
const EDITOR = { id: "u-ed", role: "editor" };

const GAME: GameDefinition = {
  id: "byod-tcg",
  name: "BYOD TCG",
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

/** Ten cards that name their image in every way a real catalog does. */
const CARDS = Array.from({ length: 10 }, (_, i) => ({
  cardId: `c-${i}`,
  name: `Card ${i}`,
  imageUrl: `https://cdn.example.org/cards/c-${i}.webp`,
  data: {
    cost: i,
    color: "Red",
    text: "Draw 2 cards.",
    artist: "Someone",
    image_url: `/media/cartas/c-${i}.webp`,
    art: { large: `https://cdn.example.org/art/c-${i}.png` },
    thumbnailKey: `cartas/c-${i}.webp`,
    // Not images: they must survive.
    links: { buy: `https://shop.example.org/c-${i}` },
    gallery: [`https://cdn.example.org/alt/c-${i}.jpg`, "promo"],
  },
}));

/** 30 cards, three of each. */
const DECK = CARDS.flatMap((c) => [c.cardId, c.cardId, c.cardId]);

const QUERIES = [
  {
    id: "red",
    label: "A red card",
    turn: 1,
    require: [{ label: "red", filters: [{ property: "color", equals: "Red" }], count: 1 }],
  },
];

let client: PGlite;
let app: ReturnType<typeof createKonCardsim>;
let operationIds: string[];

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
  const raw = await res.text();
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = raw; // text exports (deck lists)
  }
  return { status: res.status, json };
}

/**
 * Where a response names an image, or `null`. A string that looks like an image link anywhere,
 * or an image key (`imageUrl`, `art`, `thumbnailKey`…) holding a value. `imageMode` is the
 * game's setting, not a picture.
 */
function namesAnImage(value: unknown, path = "$"): string | null {
  if (typeof value === "string") return looksLikeImageUrl(value) ? `${path} = ${value}` : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = namesAnImage(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (key !== "imageMode" && isImageKey(key) && inner !== null && inner !== undefined) {
        return `${path}.${key}`;
      }
      const hit = namesAnImage(inner, `${path}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}

/** Every operation called, with what it answered. */
const responses = new Map<string, { status: number; json: any }>();
async function op(id: string, method: string, path: string, user: object | null, body?: unknown) {
  const r = await call(method, path, user, body);
  responses.set(id, r);
  return r;
}

/**
 * Operations whose responses are not scanned, and why. Everything else must be called below.
 */
const NOT_SCANNED: Record<string, string> = {
  "get-image-prefs": "echoes the caller's OWN links (tested in cardsim-image-prefs.test.ts)",
  "put-image-prefs": "echoes the caller's OWN links (tested in cardsim-image-prefs.test.ts)",
  "delete-image-prefs": "answers 204 with no body",
  // The hand generator is a separate tool over datasets its owners upload; it has no cardsim
  // game and so no image mode. BYOD is for the simulator only (the owner's decision).
  "list-datasets": "hand generator: datasets uploaded by their owners, no cardsim game",
  "get-dataset": "hand generator: datasets uploaded by their owners, no cardsim game",
  "import-dataset": "hand generator: datasets uploaded by their owners, no cardsim game",
  "create-dataset": "hand generator: datasets uploaded by their owners, no cardsim game",
  "upload-cards": "hand generator: datasets uploaded by their owners, no cardsim game",
  "hands-search-cards": "hand generator: datasets uploaded by their owners, no cardsim game",
  "delete-dataset": "hand generator: datasets uploaded by their owners, no cardsim game",
  "hands-list-my-decks": "hand generator: datasets uploaded by their owners, no cardsim game",
  "hands-save-deck": "hand generator: datasets uploaded by their owners, no cardsim game",
  "random-deck": "hand generator: datasets uploaded by their owners, no cardsim game",
  "hands-validate-deck": "hand generator: datasets uploaded by their owners, no cardsim game",
  "hands-deal-hands": "hand generator: datasets uploaded by their owners, no cardsim game",
  "hands-simulate-goldfish": "hand generator: datasets uploaded by their owners, no cardsim game",
};

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client);
  const dir = join(ROOT, "kons/kon-cardsim/migrations");
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  // The core's dataset table, as much of it as sync-catalog reads: without it the route cannot
  // even answer "that dataset does not exist".
  await client.exec(
    "CREATE TABLE data_sets (id text PRIMARY KEY, name text, schema jsonb, policy_json jsonb)"
  );
  const ctx = createTestKonContext({
    db: { instance: db } as any,
    auth: fakeAuth as any,
    realtime: { broadcast: () => {}, sendToUser: () => {} } as any,
  });
  app = createKonCardsim(ctx);
  app.onError((err, c) => respondError(c, err));
  operationIds = allOperations(ctx).map((o: any) => o.id as string);
  registerCardsimPolicy();
  registerDeckshowPolicy();
  registerHandlabPolicy();

  for (const slug of ["byod-tcg", "hosted-tcg"]) {
    const g = await call("PUT", "/games", EDITOR, { slug, definition: GAME });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    const imported = await call("POST", `/games/${slug}/cards`, EDITOR, { cards: CARDS });
    expect(imported.status, JSON.stringify(imported.json)).toBe(201);
  }
  const mode = await call("PUT", "/games/byod-tcg/image-mode", EDITOR, { imageMode: "byod" });
  expect(mode.status, JSON.stringify(mode.json)).toBe(200);
  expect(mode.json.data.imageMode).toBe("byod");

  await walkEveryOperation();
}, 120_000);

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerCardsimPolicy();
  registerDeckshowPolicy();
  registerHandlabPolicy();
});

/** Calls every scanned operation once, in a `byod` game, in an order where each one can work. */
async function walkEveryOperation() {
  const game = (await call("GET", "/games/byod-tcg", null)).json.data;
  const gameId = game.id as string;

  // ── Catalog ──
  await op("list-presets", "GET", "/presets", null);
  await op("list-games", "GET", "/games", null);
  await op("get-game", "GET", "/games/byod-tcg", null);
  await op("search-cards", "GET", "/games/byod-tcg/cards", null);
  await op("lookup-cards", "POST", "/games/byod-tcg/cards/lookup", null, { ids: ["c-1", "c-2"] });
  await op("set-image-mode", "PUT", "/games/byod-tcg/image-mode", EDITOR, { imageMode: "byod" });
  await op("publish-game", "PUT", "/games", EDITOR, { slug: "byod-tcg", definition: GAME });
  await op("import-cards", "POST", "/games/byod-tcg/cards", EDITOR, { cards: CARDS });
  await op("sync-catalog", "POST", "/games/byod-tcg/sync-catalog", EDITOR, { datasetId: "none" });
  await op("generate-sealed", "POST", "/games/byod-tcg/sealed", EVA, { packs: 1, packSize: 5 });

  // ── Decks ──
  const created = await op("create-deck", "POST", "/decks", ANA, { gameId, name: "A", cards: DECK });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const deckA = created.json.data.id as string;
  await op("list-my-decks", "GET", "/decks", ANA);
  await op("get-deck", "GET", `/decks/${deckA}`, ANA);
  await op("update-deck", "PUT", `/decks/${deckA}`, ANA, { gameId, name: "A2", cards: DECK });
  await op("import-deck", "POST", "/decks/import", ANA, {
    gameId,
    content: CARDS.map((c) => `3 ${c.cardId}`).join("\n"),
  });
  await op("export-deck", "GET", `/decks/${deckA}/export`, ANA);
  await op("simulate-goldfish", "POST", "/goldfish", ANA, {
    deckId: deckA,
    iterations: 100,
    sampleHands: 2,
    queries: QUERIES,
  });
  const spare = await call("POST", "/decks", ANA, { gameId, name: "spare", cards: DECK });
  await op("delete-deck", "DELETE", `/decks/${spare.json.data.id}`, ANA);

  // ── A room, a game, its end ──
  const deckB = (await call("POST", "/decks", BEA, { gameId, name: "B", cards: DECK })).json.data
    .id as string;
  const room = await op("create-room", "POST", "/sessions", ANA, {
    gameId,
    deckIds: [deckA],
    allowSpectators: true,
    bestOf: 3,
  });
  expect(room.status, JSON.stringify(room.json)).toBe(201);
  const sessionId = room.json.data.id as string;
  await op("list-rooms", "GET", "/sessions", null);
  await op("find-room-by-code", "GET", `/rooms/${room.json.data.code ?? "none"}`, ANA);
  const seated = await op("take-seat", "POST", `/sessions/${sessionId}/join`, BEA, {
    seat: 1,
    deckId: deckB,
  });
  expect(seated.status, JSON.stringify(seated.json)).toBe(200);
  await op("get-session", "GET", `/sessions/${sessionId}`, ANA);
  await op("send-action", "POST", `/sessions/${sessionId}/action`, ANA, {
    seat: 0,
    action: { type: "draw", count: 1 },
  });
  await op("request-undo", "POST", `/sessions/${sessionId}/undo`, ANA, { toActionCount: 0 });
  await op("cancel-undo", "DELETE", `/sessions/${sessionId}/undo`, ANA);
  await op("share-image-source", "POST", `/sessions/${sessionId}/share-source`, ANA, {
    source: { kind: "pack", label: "P", url: "https://friend.example.net/pack.json" },
  });
  await call("POST", `/sessions/${sessionId}/action`, BEA, { seat: 1, action: { type: "concede" } });
  const replay = await op("get-replay", "GET", `/sessions/${sessionId}/replay`, ANA);
  expect(replay.status, JSON.stringify(replay.json)).toBe(200);
  await op("request-rematch", "POST", `/sessions/${sessionId}/rematch`, BEA);
  await op("get-match", "GET", `/matches/${room.json.data.matchId ?? "none"}`, ANA);

  // ── Queue and ranking ──
  await op("join-queue", "POST", "/queue", ANA, { gameId, deckId: deckA });
  await call("POST", "/queue", BEA, { gameId, deckId: deckB });
  await op("leave-queue", "DELETE", "/queue", ANA);
  await op("get-ranking", "GET", "/ratings/byod-tcg", null);

  // ── Showcase ──
  await op("showcase-list-games", "GET", "/showcase/games", null);
  await op("showcase-search-cards", "GET", "/showcase/games/byod-tcg/cards", null);
  await op("showcase-validate-deck", "POST", "/showcase/validate", null, { gameId, cards: DECK });
  await op("showcase-deal-hands", "POST", "/showcase/hands", null, { gameId, cards: DECK, count: 2 });
  await op("showcase-simulate-goldfish", "POST", "/showcase/goldfish", null, {
    gameId,
    cards: DECK,
    iterations: 100,
    queries: QUERIES,
  });
  const saved = await op("showcase-save-deck", "POST", "/showcase/decks", ANA, {
    gameId,
    name: "Show",
    cards: DECK,
  });
  const post = await op("publish-post", "POST", "/showcase/entries", ANA, {
    deckId: saved.json?.data?.id ?? deckA,
    title: "A byod deck",
  });
  expect(post.status, JSON.stringify(post.json)).toBe(201);
  const postId = post.json.data.id as string;
  await op("list-posts", "GET", "/showcase/entries", null);
  await op("get-post", "GET", `/showcase/entries/${post.json.data.slug}`, null);
  await op("update-post", "PUT", `/showcase/entries/${postId}`, ANA, { title: "A byod deck, v2" });
  await op("like", "POST", `/showcase/entries/${postId}/like`, BEA);
  await op("unlike", "DELETE", `/showcase/entries/${postId}/like`, BEA);
  await op("moderate-post", "POST", `/showcase/entries/${postId}/moderate`, EDITOR, { featured: true });
  await op("delete-post", "DELETE", `/showcase/entries/${postId}`, ANA);
}

describe("every operation is either scanned or excused", () => {
  test("no operation is left out", () => {
    const unaccounted = operationIds.filter((id) => !responses.has(id) && !(id in NOT_SCANNED));
    expect(
      unaccounted,
      "Call these in walkEveryOperation (a byod game) or list them in NOT_SCANNED with the reason"
    ).toEqual([]);
  });

  test("each one did its job (a scan of error bodies proves nothing)", () => {
    // The only planned refusal: the walk syncs from a dataset that does not exist.
    const expectedRefusals = new Set(["sync-catalog"]);
    const failed = [...responses.entries()]
      .filter(([id, r]) => r.status >= 400 && !expectedRefusals.has(id))
      .map(([id, r]) => `${id}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    expect(failed).toEqual([]);
    expect(responses.get("sync-catalog")!.status).toBe(404);
  });

  test("the excuse list names no operation that does not exist", () => {
    expect(Object.keys(NOT_SCANNED).filter((id) => !operationIds.includes(id))).toEqual([]);
  });
});

describe("in a byod game no response names an image", () => {
  test("not one of the scanned responses", () => {
    const leaks = [...responses.entries()]
      .map(([id, r]) => [id, namesAnImage(r.json)] as const)
      .filter(([, hit]) => hit !== null);
    expect(leaks).toEqual([]);
  });

  test("the card-returning routes did answer with cards (the scan is not of empty bodies)", () => {
    const search = responses.get("search-cards")!;
    expect(search.status).toBe(200);
    expect(search.json.data).toHaveLength(10);
    const card = search.json.data.find((c: any) => c.cardId === "c-3");
    expect(card.name).toBe("Card 3");
    // What is not a picture survives.
    expect(card.data).toMatchObject({
      cost: 3,
      color: "Red",
      artist: "Someone",
      text: "Draw 2 cards.",
      links: { buy: "https://shop.example.org/c-3" },
      gallery: ["promo"],
    });

    expect(responses.get("showcase-search-cards")!.json.data).toHaveLength(10);
    expect(responses.get("lookup-cards")!.json.data.map((c: any) => c.name)).toEqual(["Card 1", "Card 2"]);
    const hands = responses.get("showcase-deal-hands")!;
    expect(hands.status).toBe(200);
    expect(hands.json.data.hands[0].opening[0].name).toMatch(/^Card \d$/);
    const entry = responses.get("get-post")!;
    expect(entry.status).toBe(200);
    expect(JSON.stringify(entry.json)).toContain("Card 0");
  });
});

describe("the control: hosted games keep their images", () => {
  test("a hosted game returns imageUrl", async () => {
    const r = await call("GET", "/games/hosted-tcg/cards", null);
    expect(r.json.data[0].imageUrl).toMatch(/^https:\/\/cdn\.example\.org\/cards\//);
    expect(r.json.data[0].data.image_url).toMatch(/^\/media\/cartas\//);
  });

  test("switching byod back to hosted brings them back without a re-import", async () => {
    const back = await call("PUT", "/games/byod-tcg/image-mode", EDITOR, { imageMode: "hosted" });
    expect(back.status).toBe(200);
    const r = await call("GET", "/games/byod-tcg/cards", null);
    expect(r.json.data[0].imageUrl).toMatch(/^https:\/\/cdn\.example\.org\/cards\//);
    await call("PUT", "/games/byod-tcg/image-mode", EDITOR, { imageMode: "byod" });
  });
});

describe("set-image-mode is editorial", () => {
  test("a normal account cannot switch it", async () => {
    const r = await call("PUT", "/games/byod-tcg/image-mode", EVA, { imageMode: "hosted" });
    expect(r.status).toBe(403);
  });

  test("an unknown mode is refused", async () => {
    const r = await call("PUT", "/games/byod-tcg/image-mode", EDITOR, { imageMode: "maybe" });
    expect(r.status).toBe(422);
  });

  test("an unknown game is a 404", async () => {
    const r = await call("PUT", "/games/nope/image-mode", EDITOR, { imageMode: "byod" });
    expect(r.status).toBe(404);
  });
});

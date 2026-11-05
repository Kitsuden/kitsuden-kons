/**
 * Card simulators — an agent needs its scope to save its own things
 * ============================================================================
 *
 * Phase D (2026-10-25), seen over HTTP against a real Kitsuden: an agent with
 * ONLY `mcp:connect` saved decks in kon-cardsim, its showcase and its hand
 * generator (then kons of their own), entered the scored queue and gave "likes". Those routes
 * asked for "a session", and an agent key is a session (`role: "agent"`).
 *
 * The rule is kon-tierlist's: creating something personal is done by a PERSON with
 * a session; an agent needs the scope of that action (`cardsim:create`,
 * `deckshow:create`, `handlab-deck:create`, or `<kon>:*` / `admin`), which
 * `can()` grants. People do not change.
 *
 * Since the merge, the showcase lives at `/showcase/...` and the hand generator at
 * `/hands/...` of the same kon, and the fine scopes of their operations are
 * `kon:cardsim:<id>` (migration 0012 rewrites the stored ones).
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
import { registerDeckshowPolicy } from "../../kons/kon-cardsim/deckshow.policy";
import { registerHandlabPolicy } from "../../kons/kon-cardsim/handlab.policy";

const ROOT = resolve(__dirname, "../..");

const ANA = { id: "u-ana", role: "user" };
const NULL_VALUE = { id: "ag-nulo", role: "agent", scopes: ["mcp:connect"] };
const CARDSIM = { id: "ag-cs", role: "agent", scopes: ["mcp:connect", "cardsim:create"] };
const DECKSHOW = { id: "ag-ds", role: "agent", scopes: ["mcp:connect", "deckshow:*"] };
const HANDLAB = { id: "ag-hl", role: "agent", scopes: ["mcp:connect", "handlab-deck:create"] };
const ALL = { id: "ag-admin", role: "agent", scopes: ["admin"] };
/** What migration 0012 leaves of `kon:deckshow:save-deck`, `kon:deckshow:like` and `kon:handlab:save-deck`. */
const MIGRATED = {
  id: "ag-mig",
  role: "agent",
  scopes: ["mcp:connect", "kon:cardsim:showcase-save-deck", "kon:cardsim:like", "kon:cardsim:hands-save-deck"],
};

let client: PGlite;
let cardsim: ReturnType<typeof createKonCardsim>;

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

async function call(app: any, method: string, path: string, user: object | null, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = JSON.stringify(user);
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

const GAME = {
  id: "ag-tcg",
  name: "Ag TCG",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
  ],
  resources: [],
  deckRules: { minSize: 20, maxSize: 40, maxCopies: 3 },
  deckZone: "deck",
  handZone: "hand",
  openingHand: 5,
  phases: ["main"],
};
const DECK = Array.from({ length: 24 }, (_, i) => `c-${Math.floor(i / 3)}`);
const GAME_ID = "g-ag";
let datasetId = "";
let entryId = "";

beforeAll(async () => {
  client = new PGlite();
  const dir = join(ROOT, "kons", "kon-cardsim", "migrations");
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  await client.query(
    `insert into cardsim_games (id, slug, name, definition, published) values ($1, 'ag-tcg', 'Ag TCG', $2, 'published')`,
    [GAME_ID, JSON.stringify(GAME)]
  );
  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: fakeAuth as any,
    realtime: { broadcast: () => {}, sendToUser: () => {} } as any,
  });
  cardsim = createKonCardsim(ctx);
  cardsim.onError((err, c) => respondError(c, err));

  registerCardsimPolicy();
  registerDeckshowPolicy();
  registerHandlabPolicy();
  const ds = await call(cardsim, "POST", "/hands/datasets/import", { id: "u-ed", role: "editor" }, {
    slug: "ag-ds",
    name: "Ag",
    deckMin: 20,
    deckMax: 40,
    maxCopies: 4,
    cards: Array.from({ length: 10 }, (_, i) => ({ cardId: `h${i}`, name: `H ${i}` })),
  });
  expect(ds.status).toBe(201);
  datasetId = ds.json.data.id;
  const deckAna = await call(cardsim, "POST", "/showcase/decks", ANA, { gameId: GAME_ID, name: "Ana", cards: DECK });
  const pub = await call(cardsim, "POST", "/showcase/entries", ANA, { deckId: deckAna.json.data.id, title: "Mazo de Ana" });
  expect(pub.status).toBe(201);
  entryId = pub.json.data.id;
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerCardsimPolicy();
  registerDeckshowPolicy();
  registerHandlabPolicy();
});

const HL_DECK = Array.from({ length: 20 }, (_, i) => `h${i % 10}`);

describe("an agent with only mcp:connect saves nothing of its own", () => {
  test("cardsim: deck, list import, room and queue", async () => {
    expect((await call(cardsim, "POST", "/decks", NULL_VALUE, { gameId: GAME_ID, cards: DECK })).status).toBe(403);
    expect(
      (await call(cardsim, "POST", "/decks/import", NULL_VALUE, { gameId: GAME_ID, content: "3 c-0" })).status
    ).toBe(403);
    expect((await call(cardsim, "POST", "/queue", NULL_VALUE, { gameId: GAME_ID, deckId: "x" })).status).toBe(403);
  });

  test("showcase: deck and \"like\"", async () => {
    expect(
      (await call(cardsim, "POST", "/showcase/decks", NULL_VALUE, { gameId: GAME_ID, name: "x", cards: DECK })).status
    ).toBe(403);
    expect((await call(cardsim, "POST", `/showcase/entries/${entryId}/like`, NULL_VALUE)).status).toBe(403);
  });

  test("hand generator: deck", async () => {
    expect(
      (await call(cardsim, "POST", "/hands/decks", NULL_VALUE, { datasetId, name: "x", cards: HL_DECK })).status
    ).toBe(403);
  });
});

describe("with the action's scope, yes", () => {
  test("cardsim:create saves a cardsim deck (and not a hand generator one)", async () => {
    expect((await call(cardsim, "POST", "/decks", CARDSIM, { gameId: GAME_ID, cards: DECK })).status).toBe(201);
    expect(
      (await call(cardsim, "POST", "/hands/decks", CARDSIM, { datasetId, name: "x", cards: HL_DECK })).status
    ).toBe(403);
  });

  test("deckshow:* (the showcase policy's resource scope) saves and gives \"like\"", async () => {
    expect(
      (await call(cardsim, "POST", "/showcase/decks", DECKSHOW, { gameId: GAME_ID, name: "x", cards: DECK })).status
    ).toBe(201);
    expect((await call(cardsim, "POST", `/showcase/entries/${entryId}/like`, DECKSHOW)).status).toBe(200);
  });

  test("handlab-deck:create saves a hand generator deck", async () => {
    expect(
      (await call(cardsim, "POST", "/hands/decks", HANDLAB, { datasetId, name: "x", cards: HL_DECK })).status
    ).toBe(201);
  });

  test("the scopes migration 0012 leaves still open the same operations", async () => {
    expect(
      (await call(cardsim, "POST", "/showcase/decks", MIGRATED, { gameId: GAME_ID, name: "x", cards: DECK })).status
    ).toBe(201);
    expect((await call(cardsim, "POST", `/showcase/entries/${entryId}/like`, MIGRATED)).status).toBe(200);
    expect(
      (await call(cardsim, "POST", "/hands/decks", MIGRATED, { datasetId, name: "x", cards: HL_DECK })).status
    ).toBe(201);
    // And not the simulator's: a fine scope of the showcase is not cardsim:create.
    expect((await call(cardsim, "POST", "/decks", MIGRATED, { gameId: GAME_ID, cards: DECK })).status).toBe(403);
  });

  test("admin, in all three", async () => {
    expect((await call(cardsim, "POST", "/decks", ALL, { gameId: GAME_ID, cards: DECK })).status).toBe(201);
    expect(
      (await call(cardsim, "POST", "/showcase/decks", ALL, { gameId: GAME_ID, name: "x", cards: DECK })).status
    ).toBe(201);
    expect((await call(cardsim, "POST", "/hands/decks", ALL, { datasetId, name: "x", cards: HL_DECK })).status).toBe(
      201
    );
  });
});

test("people with a session do not change", async () => {
  expect((await call(cardsim, "POST", "/decks", ANA, { gameId: GAME_ID, cards: DECK })).status).toBe(201);
  expect((await call(cardsim, "POST", "/hands/decks", ANA, { datasetId, name: "x", cards: HL_DECK })).status).toBe(201);
  expect((await call(cardsim, "POST", "/decks", null, { gameId: GAME_ID, cards: DECK })).status).toBe(401);
});

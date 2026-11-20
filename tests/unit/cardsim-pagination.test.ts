/**
 * kon-cardsim — pages of list-my-decks and list-rooms, and `/showcase/entries/{ref}`
 * ============================================================================
 *
 * `list-rooms` stopped at the latest 50 open rooms with no sign, and
 * `list-my-decks` returned every deck (api-contract, 2026-11-18). They take
 * `limit` and `offset` now and answer `hasMore` next to `data`; with no `limit`
 * they return what they always returned.
 *
 * `/showcase/entries/{slug}` (GET) and `/showcase/entries/{id}` (PUT, DELETE)
 * became `/showcase/entries/{ref}`: the URLs and what each route accepts did
 * not change, which is what the last block checks.
 *
 * Same harness as sec-cards-cardsim.test.ts: real routes on PGlite.
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

const ROOT = resolve(__dirname, "../..");

const ANA = { id: "u-ana", role: "user" };
const EDITOR = { id: "u-ed", role: "editor" };

const GAME: GameDefinition = {
  id: "page-tcg",
  name: "Page TCG",
  players: { min: 2, max: 2 },
  zones: [
    { id: "deck", name: "Deck", visibility: "none", ordered: true },
    { id: "hand", name: "Hand", visibility: "owner" },
  ],
  resources: [{ id: "life", name: "Life", initial: 20, min: 0, max: 20 }],
  deckRules: { minSize: 20, maxSize: 40, maxCopies: 3 },
  deckZone: "deck",
  handZone: "hand",
  openingHand: 5,
  phases: ["main"],
};

const deck = (prefix: string) =>
  Array.from({ length: 24 }, (_, i) => `${prefix}-card-${Math.floor(i / 3)}`);

let client: PGlite;
let app: ReturnType<typeof createKonCardsim>;
let gameId: string;
const deckIds: string[] = [];

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

beforeAll(async () => {
  client = new PGlite();
  const dir = join(ROOT, "kons/kon-cardsim/migrations");
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: fakeAuth as any,
    realtime: { broadcast: () => {}, sendToUser: () => {} } as any,
  });
  app = createKonCardsim(ctx);
  app.onError((err, c) => respondError(c, err));
  registerCardsimPolicy();

  const g = await call("PUT", "/games", EDITOR, { slug: "page-tcg", definition: GAME });
  expect(g.status, JSON.stringify(g.json)).toBe(201);
  gameId = g.json.data.id;

  for (const prefix of ["a", "b"]) {
    const d = await call("POST", "/decks", ANA, { gameId, name: prefix, cards: deck(prefix) });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    deckIds.push(d.json.data.id);
    const room = await call("POST", "/sessions", ANA, { gameId, deckIds: [d.json.data.id] });
    expect(room.status, JSON.stringify(room.json)).toBe(201);
  }
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerCardsimPolicy();
});

describe.each([
  ["list-my-decks", "/decks"],
  ["list-rooms", "/sessions"],
])("%s pages", (_id, path) => {
  test("limit=1 returns one row and hasMore: true; the next page is the other row", async () => {
    const first = await call("GET", `${path}?gameId=${gameId}&limit=1`, ANA);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.data).toHaveLength(1);
    expect(first.json.hasMore).toBe(true);
    const second = await call("GET", `${path}?gameId=${gameId}&limit=1&offset=1`, ANA);
    expect(second.json.data).toHaveLength(1);
    expect(second.json.data[0].id).not.toBe(first.json.data[0].id);
    expect(second.json.hasMore).toBe(false);
  });

  test("without limit it returns every row, hasMore: false", async () => {
    const all = await call("GET", `${path}?gameId=${gameId}`, ANA);
    expect(all.json.data).toHaveLength(2);
    expect(all.json.hasMore).toBe(false);
  });
});

test("list-rooms: a limit above the old cap of 50 is a 422", async () => {
  expect((await call("GET", "/sessions?limit=51", null)).status).toBe(422);
});

describe("/showcase/entries/{ref}: same URLs, same lookups", () => {
  test("GET by slug, PUT and DELETE by id", async () => {
    const pub = await call("POST", "/showcase/entries", ANA, {
      deckId: deckIds[0],
      title: "Mazo de Ana",
    });
    expect(pub.status, JSON.stringify(pub.json)).toBe(201);
    const { id, slug } = pub.json.data;

    expect((await call("GET", `/showcase/entries/${slug}`, null)).status).toBe(200);
    // The GET looks up by slug only, as before: the id is not a slug.
    expect((await call("GET", `/showcase/entries/${id}`, null)).status).toBe(404);

    const put = await call("PUT", `/showcase/entries/${id}`, ANA, { title: "Mazo nuevo" });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json.data.title).toBe("Mazo nuevo");

    expect((await call("DELETE", `/showcase/entries/${id}`, ANA)).status).toBe(204);
    expect((await call("GET", `/showcase/entries/${slug}`, null)).status).toBe(404);
  });
});

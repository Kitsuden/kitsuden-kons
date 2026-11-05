/**
 * Security of kon-autobattler and the kon-cardsim showcase — real routes (PGlite)
 * ============================================================================
 *
 *   · `POST /api/autobattler/sets/import` rewrites the data of a game that
 *     everyone queries. The kon asked about `create` (any account)
 *     and only the prefix rule in `auth-guard.ts` covered it. Now it is the
 *     `import` action of its policy.
 *   · Icons end up in a `src`: `javascript:` does not get in.
 *   · The showcase: a "like" on a deck hidden by moderation confirmed that
 *     it existed (and counted it); card lists had no size cap on
 *     routes that do not ask for an account.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { respondError } from "@kitsuden/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createKonAutobattler } from "../../kons/kon-autobattler/index";
import { registerAutobattlerPolicy } from "../../kons/kon-autobattler/autobattler.policy";
import { createKonCardsim } from "../../kons/kon-cardsim/index";
import { registerDeckshowPolicy } from "../../kons/kon-cardsim/deckshow.policy";

const ROOT = resolve(__dirname, "../..");

const ANA = { id: "u-ana", role: "user" };
const EVA = { id: "u-eva", role: "user" };
const EDITOR = { id: "u-ed", role: "editor" };
const AGENT = { id: "ag-1", role: "agent", scopes: ["autobattler:import"] };

let client: PGlite;
let autobattler: ReturnType<typeof createKonAutobattler>;
let deckshow: ReturnType<typeof createKonCardsim>;

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

async function call(
  app: { request: (p: string, i: RequestInit) => Response | Promise<Response> },
  method: string,
  path: string,
  user: object | null,
  body?: unknown
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = JSON.stringify(user);
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

const SET = {
  slug: "seg-set",
  name: "Set de prueba",
  rules: {
    boardRows: 4,
    boardCols: 7,
    itemsPerUnit: 3,
    teamSizeByLevel: { "1": 1, "9": 9 },
    augmentSlots: 3,
    costs: [1, 2, 3, 4, 5],
  },
  entities: [{ kind: "unit", id: "u1", name: "Unidad", data: { cost: 1, traits: [] } }],
};

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client);
  for (const kon of ["kon-cardsim", "kon-autobattler"]) {
    const dir = join(ROOT, "kons", kon, "migrations");
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await client.exec(readFileSync(join(dir, f), "utf8"));
    }
  }
  const ctx = createTestKonContext({ db: { instance: db } as any, auth: fakeAuth as any });
  autobattler = createKonAutobattler(ctx);
  autobattler.onError((err, c) => respondError(c, err));
  deckshow = createKonCardsim(ctx);
  deckshow.onError((err, c) => respondError(c, err));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerAutobattlerPolicy();
  registerDeckshowPolicy();
});

describe("autobattler: importing a set is editorial", () => {
  test("a normal account cannot", async () => {
    const r = await call(autobattler, "POST", "/sets/import", EVA, SET);
    expect(r.status).toBe(403);
  });

  test("editing can, and an agent with `autobattler:import` too", async () => {
    expect((await call(autobattler, "POST", "/sets/import", EDITOR, SET)).status).toBe(201);
    expect((await call(autobattler, "POST", "/sets/import", AGENT, SET)).status).toBe(201);
  });

  test("a `javascript:` icon does not get in", async () => {
    const r = await call(autobattler, "POST", "/sets/import", EDITOR, {
      ...SET,
      entities: [{ kind: "unit", id: "u2", name: "Mala", icon: "javascript:alert(1)" }],
    });
    expect(r.status).toBe(422);
  });

  test("and an http(s) or own-path one does", async () => {
    const r = await call(autobattler, "POST", "/sets/import", EDITOR, {
      ...SET,
      entities: [
        { kind: "unit", id: "u3", name: "Buena", icon: "https://raw.communitydragon.org/x.png" },
        { kind: "unit", id: "u4", name: "Local", icon: "/media/tft/u4.png" },
      ],
    });
    expect(r.status).toBe(201);
  });
});

describe("deckshow", () => {
  test("you cannot \"like\" a deck hidden by moderation", async () => {
    await client.exec(`
      INSERT INTO cardsim_games (id, slug, name, definition, published)
        VALUES ('g1', 'g1', 'G1', '{}'::jsonb, 'published');
      INSERT INTO cardsim_decks (id, game_id, name, cards, owner_id)
        VALUES ('d1', 'g1', 'Deck', '[]'::jsonb, 'u-ana');
      INSERT INTO deckshow_entries (id, deck_id, game_id, slug, title, author_id, status, hidden_reason)
        VALUES ('e1', 'd1', 'g1', 'oculto-1', 'Oculto', 'u-ana', 'hidden', 'spam');
    `);
    const r = await call(deckshow, "POST", "/showcase/entries/e1/like", EVA);
    expect(r.status).toBe(404);
    const row = await client.query<{ likes: number }>(
      "SELECT likes FROM deckshow_entries WHERE id = 'e1'"
    );
    expect(row.rows[0].likes).toBe(0);
  });

  test("its author can (they see it)", async () => {
    expect((await call(deckshow, "POST", "/showcase/entries/e1/like", ANA)).status).toBe(200);
  });

  test("card lists have a cap even without an account", async () => {
    const r = await call(deckshow, "POST", "/showcase/validate", null, {
      gameId: "g1",
      cards: Array.from({ length: 50_000 }, () => "x"),
    });
    expect(r.status).toBe(422);
  });
});

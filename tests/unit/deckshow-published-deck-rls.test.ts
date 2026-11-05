/**
 * Showcase — the deck of a published entry is visible, with real RLS
 * ============================================================================
 *
 * Phase D (2026-10-25), tested over HTTP against a real Kitsuden: decks
 * live in `cardsim_decks`, which the core isolates by owner
 * (`cardsim_decks_owner_isolation`, from `rls-owned-tables.sql`). The showcase read
 * an entry's deck with the request's connection, so for everyone
 * except its author the deck "did not exist":
 *
 *   GET  /api/cardsim/showcase/entries/:slug   → 409 «The deck no longer exists»
 *   POST /api/cardsim/showcase/hands {deckId}  → 404 «That deck does not exist»
 *
 * That is, the showcase published records that nobody could open. The tests
 * that existed mounted the kon without RLS (PGlite superuser) and did not see it.
 *
 * Here: PGlite with kon-cardsim's migrations (the showcase's included), the core's owner
 * policy, a NON-superuser role and the request context in
 * `app.current_user_id`. `asSystem` goes back to the role that migrated, like the
 * host's.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { respondError } from "@kitsuden/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createKonCardsim } from "../../kons/kon-cardsim/index";
import { registerDeckshowPolicy } from "../../kons/kon-cardsim/deckshow.policy";

const ROOT = resolve(__dirname, "../..");
const ROLE = "deckshow_rls_app";

const ANA = { id: "Aq7kL2mP9zX4nT8vB1cD3eF5gH6jK0wQ", role: "user" };
const EVA = { id: "Bw2E4rT6yU8iO0pA1sD3fG5hJ7kL9zXc", role: "user" };
const EDITOR = { id: "Ss9zX7cV5bN3mQ1wE2rT4yU6iO8pA0lK", role: "editor" };

let client: PGlite;
let app: ReturnType<typeof createKonCardsim>;

/** The request's RLS context, as the host sets it. */
async function context(user: { id: string; role: string } | null) {
  await client.query(
    `select set_config('app.current_user_id', $1, false), set_config('app.current_user_role', $2, false)`,
    [user?.id ?? "", user?.role ?? "anon"]
  );
}

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

async function call(method: string, path: string, user: { id: string; role: string } | null, body?: unknown) {
  await context(user);
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
  id: "rls-tcg",
  name: "RLS TCG",
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
let gameId = "";
let input: { id: string; slug: string; deckId: string };

beforeAll(async () => {
  client = new PGlite();
  const dir = join(ROOT, "kons", "kon-cardsim", "migrations");
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  // The owner policy that the core puts on every table with `owner_id`
  // (apps/api/src/db/rls-owned-tables.sql), exactly as it stays in the database.
  await client.exec(`
    ALTER TABLE cardsim_decks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE cardsim_decks FORCE ROW LEVEL SECURITY;
    CREATE POLICY cardsim_decks_owner_isolation ON cardsim_decks FOR ALL TO PUBLIC USING (
      ((current_setting('app.current_user_id', true) = '' OR current_setting('app.current_user_id', true) IS NULL)
        AND COALESCE(current_setting('app.current_user_role', true), '') = '')
      OR current_setting('app.current_user_role', true) = 'admin'
      OR owner_id = current_setting('app.current_user_id', true)
    );
    CREATE ROLE ${ROLE} NOLOGIN;
    GRANT USAGE ON SCHEMA public TO ${ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE};
  `);
  const g = await client.query<{ id: string }>(
    `insert into cardsim_games (id, slug, name, definition, published) values ('g-rls', 'rls-tcg', 'RLS TCG', $1, 'published') returning id`,
    [JSON.stringify(GAME)]
  );
  gameId = g.rows[0].id;
  for (let i = 0; i < 8; i++) {
    await client.query(`insert into cardsim_cards (id, game_id, card_id, name, data) values ($2 || '-id', $1, $2, $3, '{}')`, [
      gameId,
      `c-${i}`,
      `Carta ${i}`,
    ]);
  }
  await client.exec(`SET ROLE ${ROLE}`);
  const su = await client.query<{ su: boolean }>(
    `SELECT rolsuper OR rolbypassrls AS su FROM pg_roles WHERE rolname = current_user`
  );
  if (su.rows[0]?.su !== false) throw new Error("the test role skips RLS");

  // Like the host: as system = the role that migrated, with no user context.
  const asSystem = async <T>(fn: () => Promise<T>): Promise<T> => {
    await client.exec(`RESET ROLE`);
    try {
      return await fn();
    } finally {
      await client.exec(`SET ROLE ${ROLE}`);
    }
  };
  const ctx = createTestKonContext({
    db: { instance: drizzle(client), asSystem } as any,
    auth: fakeAuth as any,
  });
  app = createKonCardsim(ctx);
  app.onError((err, c) => respondError(c, err));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerDeckshowPolicy();
});

describe("RLS on cardsim_decks is really in effect", () => {
  test("Eva does not see Ana's private deck (not even to deal hands)", async () => {
    const saved = await call("POST", "/showcase/decks", ANA, { gameId, name: "Privado", cards: DECK });
    expect(saved.status).toBe(201);
    const r = await call("POST", "/showcase/hands", EVA, { deckId: saved.json.data.id, count: 1 });
    expect(r.status).toBe(404);
  });
});

describe("a published entry shows its deck to everyone", () => {
  beforeAll(async () => {
    const deck = await call("POST", "/showcase/decks", ANA, { gameId, name: "Publicable", cards: DECK });
    const pub = await call("POST", "/showcase/entries", ANA, { deckId: deck.json.data.id, title: "Mazo de Ana" });
    expect(pub.status).toBe(201);
    input = pub.json.data;
  });

  test("the record opens without an account, with the deck hydrated", async () => {
    const r = await call("GET", `/showcase/entries/${input.slug}`, null);
    expect(r.status).toBe(200);
    expect(r.json.deck.sections[0].total).toBe(24);
  });

  test("and with another account", async () => {
    expect((await call("GET", `/showcase/entries/${input.slug}`, EVA)).status).toBe(200);
  });

  test("dealing hands and goldfish of the published deck, by its id", async () => {
    const hands = await call("POST", "/showcase/hands", EVA, { deckId: input.deckId, count: 2, seed: 1 });
    expect(hands.status).toBe(200);
    expect(hands.json.data.hands).toHaveLength(2);
    const gf = await call("POST", "/showcase/goldfish", null, {
      deckId: input.deckId,
      iterations: 100,
      queries: [{ id: "q", label: "q", turn: 1, require: [{ label: "c", filters: [{ property: "name", equals: "Carta 1" }], count: 1 }] }],
    });
    expect(gf.json?.error ?? null).toBeNull();
    expect(gf.status).toBe(200);
  });

  test("hidden by moderation: the deck stops existing for the others again", async () => {
    expect((await call("POST", `/showcase/entries/${input.id}/moderate`, EDITOR, { hide: "spam" })).status).toBe(200);
    expect((await call("GET", `/showcase/entries/${input.slug}`, EVA)).status).toBe(404);
    expect((await call("POST", "/showcase/hands", EVA, { deckId: input.deckId, count: 1 })).status).toBe(404);
    // Its author does: they must be able to read why.
    expect((await call("GET", `/showcase/entries/${input.slug}`, ANA)).status).toBe(200);
  });
});

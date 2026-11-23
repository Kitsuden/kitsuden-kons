/**
 * One name for the game, in every gaming kon
 * ============================================================================
 *
 * A site asks each kon "what do you have for this game?". Before, each one answered a different
 * question: the wiki wanted the catalog's uuid, the autobattler a free text, and maps, tier lists,
 * builders, formula systems and simulator games stored no game at all.
 *
 * Now each takes `game` (the game's slug in kon-games), stores it in a `game` column and filters
 * its list with `?game=`. Real routes on real SQL (PGlite), every kon's migrations applied:
 *
 *   · saved with a game, it is listed under that game and not under another;
 *   · left out on a rewrite, the game stays; `null` clears it;
 *   · something that is not a slug is refused, on the body and on the filter;
 *   · the wiki keeps its uuid: created by slug or by uuid, listed by either, and its migration
 *     fills `game` from the catalog where the catalog is installed.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { respondError } from "@kitsuden/engine";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { registerAutobattlerPolicy } from "../../kons/kon-autobattler/autobattler.policy";
import { createKonAutobattler } from "../../kons/kon-autobattler/index";
import { registerCardsimPolicy } from "../../kons/kon-cardsim/cardsim.policy";
import { createKonCardsim } from "../../kons/kon-cardsim/index";
import { registerBuilderPolicy } from "../../kons/kon-character-builder/character-builder.policy";
import { createKonBuilder } from "../../kons/kon-character-builder/index";
import { registerFormulasPolicy } from "../../kons/kon-formulas/formulas.policy";
import { createKonFormulas } from "../../kons/kon-formulas/index";
import { createKonMaps } from "../../kons/kon-maps/index";
import { registerMapsPolicy } from "../../kons/kon-maps/maps.policy";
import { createKonTierlist } from "../../kons/kon-tierlist/index";
import { registerTierlistPolicy } from "../../kons/kon-tierlist/tierlist.policy";
import { createKonWiki } from "../../kons/kon-wiki/index";
import { registerWikiPolicy } from "../../kons/kon-wiki/wiki.policy";

const ADMIN = { id: "u-admin", role: "admin" };
const KONS = "../../kons";
const GAME_UUID = "11111111-2222-4333-8444-555555555555";

let client: PGlite;
const apps: Record<string, Hono> = {};

function mount(router: Hono): Hono {
  const app = new Hono();
  app.onError((err, c) => respondError(c, err));
  app.use("*", async (c, next) => {
    const raw = c.req.header("x-test-user");
    c.set("user" as never, (raw ? JSON.parse(raw) : null) as never);
    await next();
  });
  app.route("/", router);
  return app;
}

async function call(kon: string, method: string, route: string, body?: unknown, user: object | null = ADMIN) {
  const res = await apps[kon]!.request(route, {
    method,
    headers: {
      "content-type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

function migrationsOf(kon: string): Array<{ name: string; sql: string }> {
  const dir = join(__dirname, KONS, kon, "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

function registerPolicies() {
  registerFormulasPolicy();
  registerMapsPolicy();
  registerTierlistPolicy();
  registerBuilderPolicy();
  registerCardsimPolicy();
  registerWikiPolicy();
  registerAutobattlerPolicy();
}

beforeAll(async () => {
  client = new PGlite();
  // The catalog's own table, as kon-games creates it (only what the wiki's migration reads).
  await client.exec(`CREATE TABLE games (id uuid PRIMARY KEY, slug varchar(500) NOT NULL)`);
  await client.query(`INSERT INTO games (id, slug) VALUES ($1, 'elden-ring')`, [GAME_UUID]);

  for (const kon of [
    "kon-formulas",
    "kon-maps",
    "kon-tierlist",
    "kon-character-builder",
    "kon-cardsim",
    "kon-autobattler",
  ]) {
    for (const m of migrationsOf(kon)) await client.exec(m.sql);
  }
  // The wiki, up to the migration before `game`, with a wiki that only knows its game's uuid…
  const wikiMigrations = migrationsOf("kon-wiki");
  for (const m of wikiMigrations.filter((x) => x.name < "0004")) await client.exec(m.sql);
  await client.query(
    `INSERT INTO wikis (id, slug, title, game_id) VALUES ('w-old', 'elden', 'Elden Ring', $1), ('w-none', 'loose', 'No game', NULL)`,
    [GAME_UUID]
  );
  // …and then the rest: `game` arrives and is filled from the catalog.
  for (const m of wikiMigrations.filter((x) => x.name >= "0004")) await client.exec(m.sql);

  const who = (c: any) => {
    const raw = c.req.header("x-test-user");
    return raw ? JSON.parse(raw) : null;
  };
  const auth = {
    requireAuth: (c: any, next: any) => {
      const u = who(c);
      if (!u) return c.json({ error: "Unauthorized" }, 401);
      c.set("user", u);
      return next();
    },
    optionalAuth: (c: any, next: any) => {
      const u = who(c);
      if (u) c.set("user", u);
      return next();
    },
  };
  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: auth as any,
    realtime: { broadcast: () => {}, sendToUser: () => {} } as any,
  });
  registerPolicies();
  apps.formulas = mount(createKonFormulas(ctx));
  apps.maps = mount(createKonMaps(ctx));
  apps.tierlist = mount(createKonTierlist(ctx));
  apps.builder = mount(createKonBuilder(ctx));
  apps.cardsim = mount(createKonCardsim(ctx));
  apps.wiki = mount(createKonWiki(ctx));
  apps.autobattler = mount(createKonAutobattler(ctx));
});

beforeEach(registerPolicies);

afterAll(async () => {
  await client?.close();
});

/**
 * The same four checks for each kon that saves by upsert. `body(slug)` is a valid body WITHOUT
 * a game; `rows(json)` reads the list out of the answer.
 */
const UPSERTS: Array<{
  kon: string;
  save: [method: string, route: string];
  list: string;
  body: (slug: string) => Record<string, unknown>;
  rows: (json: any) => Array<{ slug: string; game?: string | null }>;
}> = [
  {
    kon: "formulas",
    save: ["PUT", "/systems"],
    list: "/systems",
    body: (slug) => ({ slug, name: slug, stats: [{ name: "total", formula: "atk * 2" }] }),
    rows: (j) => j.data,
  },
  {
    kon: "maps",
    save: ["PUT", "/maps"],
    list: "/maps",
    body: (slug) => ({
      slug,
      definition: {
        name: slug,
        imageUrl: "/media/m.webp",
        aspectRatio: 1.5,
        layers: [{ id: "l", name: "L" }],
      },
    }),
    rows: (j) => j.data,
  },
  {
    kon: "tierlist",
    save: ["PUT", "/templates"],
    list: "/templates",
    body: (slug) => ({ slug, title: slug, items: [{ id: "a", label: "Alfa" }] }),
    rows: (j) => j.data,
  },
  {
    kon: "builder",
    save: ["PUT", "/definitions"],
    list: "/definitions",
    body: (slug) => ({
      slug,
      definition: {
        id: slug,
        name: slug,
        baseStats: { atk: 1 },
        slots: [{ id: "p", name: "P", capacity: 1, options: [{ id: "a", name: "A", modifiers: [] }] }],
        budgets: [],
        derived: [{ name: "total", formula: "atk * 2" }],
      },
    }),
    rows: (j) => j.data,
  },
  {
    kon: "cardsim",
    save: ["PUT", "/games"],
    list: "/games",
    body: (slug) => ({ slug, preset: "lorcana" }),
    rows: (j) => j.data,
  },
];

describe.each(UPSERTS)("$kon: `game` is the catalog game's slug", ({ kon, save, list, body, rows }) => {
  const [method, route] = save;
  const slugs = (json: any) =>
    rows(json)
      .map((r) => r.slug)
      .sort();

  it("lists under its game, and only there", async () => {
    const a = await call(kon, method, route, { ...body(`${kon}-a`), game: "elden-ring" });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    expect(a.json.data.game).toBe("elden-ring");
    const b = await call(kon, method, route, { ...body(`${kon}-b`), game: "palworld" });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    const none = await call(kon, method, route, body(`${kon}-c`));
    expect(none.status, JSON.stringify(none.json)).toBe(201);
    expect(none.json.data.game ?? null).toBeNull();

    expect(slugs((await call(kon, "GET", `${list}?game=elden-ring`)).json)).toEqual([`${kon}-a`]);
    expect(slugs((await call(kon, "GET", `${list}?game=palworld`)).json)).toEqual([`${kon}-b`]);
    expect(slugs((await call(kon, "GET", `${list}?game=nobody`)).json)).toEqual([]);
    const all = (await call(kon, "GET", list)).json;
    expect(slugs(all)).toEqual([`${kon}-a`, `${kon}-b`, `${kon}-c`]);
    // The list itself says the game of each row.
    expect(rows(all).find((r) => r.slug === `${kon}-a`)!.game).toBe("elden-ring");
  });

  it("a rewrite without `game` keeps it; null clears it", async () => {
    const kept = await call(kon, method, route, body(`${kon}-a`));
    expect(kept.status, JSON.stringify(kept.json)).toBe(200);
    expect(kept.json.data.game).toBe("elden-ring");
    const cleared = await call(kon, method, route, { ...body(`${kon}-a`), game: null });
    expect(cleared.status).toBe(200);
    expect(cleared.json.data.game).toBeNull();
    expect(slugs((await call(kon, "GET", `${list}?game=elden-ring`)).json)).toEqual([]);
  });

  it("refuses a game that is not a slug, on the body and on the filter", async () => {
    for (const bad of ["Elden Ring", "elden_ring", "-elden", "elden--ring", "ELDEN", "elden/ring", ""]) {
      const r = await call(kon, method, route, { ...body(`${kon}-bad`), game: bad });
      expect([400, 422], `${kon} body ${JSON.stringify(bad)}`).toContain(r.status);
    }
    expect((await call(kon, "GET", list)).json && slugs((await call(kon, "GET", list)).json)).not.toContain(
      `${kon}-bad`
    );
    const filter = await call(kon, "GET", `${list}?game=${encodeURIComponent("Elden Ring")}`);
    expect([400, 422]).toContain(filter.status);
  });
});

describe("wiki: the game by slug, next to the uuid it already had", () => {
  it("the migration fills `game` from the catalog, and leaves a wiki without a game alone", async () => {
    const { rows } = await client.query<{ id: string; game: string | null }>(
      `SELECT id, game FROM wikis WHERE id IN ('w-old', 'w-none') ORDER BY id`
    );
    expect(rows).toEqual([
      { id: "w-none", game: null },
      { id: "w-old", game: "elden-ring" },
    ]);
  });

  it("running the migration again changes nothing", async () => {
    const m = migrationsOf("kon-wiki").find((x) => x.name.startsWith("0004"))!;
    await client.query(`UPDATE wikis SET game = 'renamed-by-hand' WHERE id = 'w-old'`);
    await client.exec(m.sql);
    const { rows } = await client.query<{ game: string }>(`SELECT game FROM wikis WHERE id = 'w-old'`);
    expect(rows[0]!.game).toBe("renamed-by-hand");
    await client.query(`UPDATE wikis SET game = 'elden-ring' WHERE id = 'w-old'`);
  });

  it("lists by the slug and, as before, by the uuid", async () => {
    const bySlug = await call("wiki", "GET", "/wikis?game=elden-ring", undefined, null);
    expect(bySlug.json.docs.map((w: any) => w.id)).toEqual(["w-old"]);
    const byUuid = await call("wiki", "GET", `/wikis?game=${GAME_UUID}`, undefined, null);
    expect(byUuid.json.docs.map((w: any) => w.id)).toEqual(["w-old"]);
    expect(byUuid.json.docs[0]).toMatchObject({ game: "elden-ring", gameId: GAME_UUID });
    expect((await call("wiki", "GET", "/wikis?game=nobody", undefined, null)).json.docs).toEqual([]);
  });

  it("creates a wiki by slug alone: no catalog needed", async () => {
    const r = await call("wiki", "POST", "/wikis", { title: "Palworld", game: "palworld" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.data).toMatchObject({ slug: "palworld", game: "palworld", gameId: null });
  });

  it("created by uuid, it learns the slug from the catalog", async () => {
    const other = "99999999-2222-4333-8444-555555555555";
    await client.query(`INSERT INTO games (id, slug) VALUES ($1, 'hades-ii')`, [other]);
    const r = await call("wiki", "POST", "/wikis", { title: "Hades II", gameId: other });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.data).toMatchObject({ game: "hades-ii", gameId: other });
  });

  it("one wiki per game, whichever way the game is named", async () => {
    const bySlug = await call("wiki", "POST", "/wikis", { title: "Otra de Elden", slug: "elden-2", game: "elden-ring" });
    expect(bySlug.status).toBe(409);
    expect(bySlug.json.field).toBe("game");
    const byUuid = await call("wiki", "POST", "/wikis", { title: "Otra", slug: "elden-3", gameId: GAME_UUID });
    expect(byUuid.status).toBe(409);
    const preview = await call("wiki", "GET", "/wikis/suggestion?title=Nueva&game=elden-ring", undefined, null);
    expect(preview.json).toMatchObject({ valid: false });
    const free = await call("wiki", "GET", "/wikis/suggestion?title=Nueva&game=grim-dawn", undefined, null);
    expect(free.json).toMatchObject({ valid: true, slug: "nueva" });
  });

  it("still needs its game: neither name is a 4xx, and nothing is created", async () => {
    const r = await call("wiki", "POST", "/wikis", { title: "Sin juego" });
    expect([400, 422]).toContain(r.status);
    const bad = await call("wiki", "POST", "/wikis", { title: "Mala", game: "Not A Slug" });
    expect([400, 422]).toContain(bad.status);
    const { rows } = await client.query(`SELECT 1 FROM wikis WHERE title IN ('Sin juego', 'Mala')`);
    expect(rows).toHaveLength(0);
  });
});

describe("autobattler: it already called it `game`", () => {
  it("has the column and filters its sets by it", async () => {
    const { rows } = await client.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'autobattler_sets' AND column_name = 'game'`
    );
    expect(rows).toEqual([{ data_type: "text" }]);
    const r = await call("autobattler", "GET", "/sets?game=tft", undefined, null);
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual([]);
  });
});

describe("the column is the same everywhere", () => {
  it("`game`, text and nullable, with an index, in each kon's table", async () => {
    for (const table of [
      "formula_systems",
      "game_maps",
      "tier_lists",
      "builder_definitions",
      "cardsim_games",
      "wikis",
    ]) {
      const { rows } = await client.query<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = 'game'`,
        [table]
      );
      expect(rows, table).toEqual([{ data_type: "text", is_nullable: "YES" }]);
      const idx = await client.query(
        `SELECT 1 FROM pg_indexes WHERE tablename = $1 AND indexdef ~ '\\(game[,)]'`,
        [table]
      );
      expect(idx.rows.length, `${table} index`).toBeGreaterThan(0);
    }
  });
});

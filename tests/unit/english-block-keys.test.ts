/**
 * Kitsuden 0.9: the block contract in English, on the kons' side
 * ============================================================================
 *
 * - kon-games `0003_english_block_keys.sql` and kon-blog `0010_english_block_keys.sql` on PGlite:
 *   rows in the 0.8 shape, in the 0.9 shape and with both keys. The result must be exactly what
 *   `readBlockData` / `readEditorial` (`@kitsuden/shared` block-keys.ts) read, other JSON and
 *   columns are untouched, and a second run changes nothing.
 * - kon-games' real router (tables from the Drizzle schema): a game stored with 0.8 keys is served
 *   in English until 0.10, and a write of `blocks` with a 0.8 key is a 422 naming the English key.
 */

import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { readBlockData, readEditorial } from "@kitsuden/shared";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readSqlFile } from "../../.kitsuden/apps/api/src/lib/sql-file";
import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createGamesRouter } from "../../kons/kon-games/games.routes";
import * as gamesSchema from "../../kons/kon-games/games.schema";

const ROOT = resolve(__dirname, "../..");
const GAMES_MIGRATION = resolve(ROOT, "kons/kon-games/migrations/0003_english_block_keys.sql");
const BLOG_MIGRATION = resolve(ROOT, "kons/kon-blog/migrations/0010_english_block_keys.sql");

async function run(pg: PGlite, path: string, name: string) {
  const file = readSqlFile(path, name);
  await pg.transaction(async (tx) => {
    for (const statement of file.statements) await tx.exec(statement);
  });
}

/** A game block as `readGameBlocks` serves it: the reference for the migration's output. */
function english(b: any) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return b;
  const out = { ...b };
  if ("data" in b) out.data = readBlockData(b.type, b.data);
  if (b.editorial && typeof b.editorial === "object" && !Array.isArray(b.editorial))
    out.editorial = readEditorial(b.editorial);
  return out;
}

const OLD_BLOCKS = [
  {
    id: "a",
    type: "smart-grid",
    order: 0,
    data: { titulo: "Armas", descripcion: "Todas", datasetId: "d" },
    editorial: { titulo: "Las armas", orden: 2, oculto: false },
  },
  {
    id: "b",
    type: "dex",
    order: 1,
    data: {
      titulo: "Aniidex",
      segmento: "aniidex",
      campos: { clave: "slug", nombre: "name" },
      facetas: [{ campo: "elements", etiqueta: "Element" }],
      habilidades: { datasetId: "s", grupos: [{ campo: "skills", etiqueta: "Skills" }] },
    },
    editorial: { oculto: true },
  },
  {
    id: "c",
    type: "deck",
    order: 2,
    data: { juego: "op", vista: "resumen", titulo: "Meta" },
  },
  // Both names: the English one wins, in data and in the layer
  {
    id: "d",
    type: "comments",
    order: 3,
    data: { orden: "mejores", order: "newest", titulo: "x", title: "y" },
    editorial: { orden: 9, order: 1 },
  },
  // Not objects: left alone
  "junk",
  { id: "e", type: "callout", order: 4, data: null, editorial: "junk" },
];
const NEW_BLOCKS = [
  { id: "x", type: "dex", order: 0, data: { title: "T", fields: { key: "k" } }, editorial: { hidden: true } },
];

describe("kon-games/0003_english_block_keys.sql", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE games (
        id text PRIMARY KEY, blocks jsonb DEFAULT '[]'::jsonb, specs jsonb,
        updated_at timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z'
      );`);
  });
  afterAll(async () => {
    await pg?.close();
  });

  it("rewrites data and editorial of every block exactly as the readers read them; idempotent", async () => {
    const specs = { titulo: "not a block: kept" };
    await pg.query("INSERT INTO games (id, blocks, specs) VALUES ('old', $1::jsonb, $2::jsonb)", [
      JSON.stringify(OLD_BLOCKS),
      JSON.stringify(specs),
    ]);
    await pg.query("INSERT INTO games (id, blocks) VALUES ('new', $1::jsonb)", [
      JSON.stringify(NEW_BLOCKS),
    ]);
    await pg.query("INSERT INTO games (id, blocks) VALUES ('null', NULL), ('empty', '[]'::jsonb), ('object', '{\"titulo\":1}'::jsonb)");

    await run(pg, GAMES_MIGRATION, "kon-games/0003_english_block_keys.sql");

    const rows = Object.fromEntries(
      (await pg.query<{ id: string; blocks: unknown; specs: unknown; updated_at: string }>(
        "SELECT id, blocks, specs, updated_at::text FROM games"
      )).rows.map((r) => [r.id, r])
    );
    expect(rows.old!.blocks).toEqual(OLD_BLOCKS.map(english));
    expect((rows.old!.blocks as any[])[0]).toEqual({
      id: "a",
      type: "smart-grid",
      order: 0,
      data: { title: "Armas", description: "Todas", datasetId: "d" },
      editorial: { title: "Las armas", order: 2, hidden: false },
    });
    expect((rows.old!.blocks as any[])[3].editorial).toEqual({ order: 1 });
    expect((rows.old!.blocks as any[])[3].data).toEqual({ order: "newest", title: "y" });
    expect(rows.old!.specs).toEqual(specs);
    expect(rows.new!.blocks).toEqual(NEW_BLOCKS);
    expect(rows.null!.blocks).toBeNull();
    expect(rows.empty!.blocks).toEqual([]);
    expect(rows.object!.blocks).toEqual({ titulo: 1 });
    // A data migration does not pretend the game was edited
    expect(rows.old!.updated_at).toBe(rows.new!.updated_at);
    expect((await pg.query("SELECT 1 FROM pg_proc WHERE proname LIKE 'kitsuden_games_0003%'")).rows).toEqual([]);

    const before = (await pg.query("SELECT id, blocks FROM games ORDER BY id")).rows;
    await run(pg, GAMES_MIGRATION, "kon-games/0003_english_block_keys.sql");
    expect((await pg.query("SELECT id, blocks FROM games ORDER BY id")).rows).toEqual(before);
  });
});

describe("kon-blog/0010_english_block_keys.sql", () => {
  it("rewrites the data of every post block; no editorial, other columns untouched; idempotent", async () => {
    const pg = new PGlite();
    await pg.exec(`CREATE TABLE blog_posts (id text PRIMARY KEY, blocks jsonb, seo_overrides jsonb);`);
    const postBlocks = [
      { id: "1", type: "card-browser", order: 0, data: { juegoDeCartas: "op", facetas: [{ campo: "cost" }] } },
      { id: "2", type: "hero", order: 1, data: { title: "Already English" } },
      { id: "3", type: "comments", order: 2, data: { orden: "antiguos" }, editorial: { titulo: "not a game" } },
    ];
    await pg.query("INSERT INTO blog_posts VALUES ('p', $1::jsonb, $2::jsonb)", [
      JSON.stringify(postBlocks),
      JSON.stringify({ titulo: "kept" }),
    ]);
    await pg.query("INSERT INTO blog_posts VALUES ('n', NULL, NULL)");

    await run(pg, BLOG_MIGRATION, "kon-blog/0010_english_block_keys.sql");
    const [post] = (await pg.query<{ blocks: any[]; seo_overrides: unknown }>(
      "SELECT blocks, seo_overrides FROM blog_posts WHERE id = 'p'"
    )).rows;
    expect(post!.blocks).toEqual([
      { id: "1", type: "card-browser", order: 0, data: { cardGame: "op", facets: [{ field: "cost" }] } },
      postBlocks[1],
      // Posts have no editorial layer: only `data` is the contract here
      { id: "3", type: "comments", order: 2, data: { order: "oldest" }, editorial: { titulo: "not a game" } },
    ]);
    expect(post!.blocks.map((b) => b.data)).toEqual(postBlocks.map((b) => readBlockData(b.type, b.data)));
    expect(post!.seo_overrides).toEqual({ titulo: "kept" });

    const before = (await pg.query("SELECT * FROM blog_posts ORDER BY id")).rows;
    await run(pg, BLOG_MIGRATION, "kon-blog/0010_english_block_keys.sql");
    expect((await pg.query("SELECT * FROM blog_posts ORDER BY id")).rows).toEqual(before);
    await pg.close();
  });
});

describe("kon-games' router: 0.8 keys are read until 0.10 and never written", () => {
  const GAME = "0a6e1c2e-0000-4000-8000-0000000000aa";
  let pg: PGlite;
  let app: Hono;

  beforeAll(async () => {
    pg = new PGlite();
    const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
    const full = generateDrizzleJson({
      contentStatusEnum: gamesSchema.contentStatusEnum,
      tagCategoryEnum: gamesSchema.tagCategoryEnum,
      games: gamesSchema.games,
      platforms: gamesSchema.platforms,
      tags: gamesSchema.tags,
      gamesToPlatforms: gamesSchema.gamesToPlatforms,
      gamesToTags: gamesSchema.gamesToTags,
    });
    for (const s of await generateMigration(generateDrizzleJson({}), full)) await pg.exec(s);
    await pg.query(
      `INSERT INTO games (id, title, slug, status, blocks) VALUES ($1, 'Old', 'old', 'published', $2::jsonb)`,
      [GAME, JSON.stringify(OLD_BLOCKS.slice(0, 3))]
    );
    const ctx = createTestKonContext({
      db: { instance: drizzle(pg) } as any,
      auth: { requireAuth: async (_c: any, next: any) => next() } as any,
      cache: { get: async () => null, set: async () => {}, del: async () => {}, invalidate: async () => {} } as any,
    });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user" as never, { id: "admin-1", role: "admin" } as never);
      await next();
    });
    app.route("/api/games", createGamesRouter(ctx) as unknown as Hono);
  }, 60_000);
  afterAll(async () => {
    await pg?.close();
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  it("GET by id, by slug and in the list serve the blocks in English", async () => {
    const expected = OLD_BLOCKS.slice(0, 3).map(english);
    for (const path of [`/api/games/${GAME}`, "/api/games/slug/old"]) {
      const r = await call("GET", path);
      expect(r.status, path).toBe(200);
      expect(r.body.blocks, path).toEqual(expected);
    }
    const list = await call("GET", "/api/games?includeMedia=false");
    expect(list.body.docs[0].blocks).toEqual(expected);
    // The row itself is untouched by a read
    const stored = await pg.query<{ blocks: unknown }>("SELECT blocks FROM games WHERE id = $1", [GAME]);
    expect(stored.rows[0]!.blocks).toEqual(OLD_BLOCKS.slice(0, 3));
  });

  it("POST / and PATCH /:id with 0.8 keys in blocks: 422 naming the English key; nothing saved", async () => {
    const patch = await call("PATCH", `/api/games/${GAME}`, {
      blocks: [{ id: "a", type: "deck", order: 0, data: { juego: "op" }, editorial: { oculto: true } }],
    });
    expect(patch.status).toBe(422);
    expect(patch.body.renamed).toEqual([
      { path: "blocks[0].data.juego", use: "blocks[0].data.game" },
      { path: "blocks[0].editorial.oculto", use: "blocks[0].editorial.hidden" },
    ]);
    expect(patch.body.hint).toContain("«blocks[0].data.juego» → «blocks[0].data.game»");

    const post = await call("POST", "/api/games", {
      title: "New one",
      blocks: [{ id: "z", type: "hero", order: 0, data: { titulo: "x" } }],
    });
    expect(post.status).toBe(422);
    expect((await pg.query("SELECT 1 FROM games WHERE slug = 'new-one'")).rows).toEqual([]);

    // In English it goes through, and the stored 0.8 layer of the same block id comes out English
    const ok = await call("PATCH", `/api/games/${GAME}`, {
      blocks: [{ id: "a", type: "smart-grid", order: 0, data: { title: "New" } }],
    });
    expect(ok.status).toBe(200);
    const stored = await pg.query<{ blocks: any[] }>("SELECT blocks FROM games WHERE id = $1", [GAME]);
    expect(stored.rows[0]!.blocks).toEqual([
      {
        id: "a",
        type: "smart-grid",
        order: 0,
        data: { title: "New" },
        editorial: { title: "Las armas", order: 2, hidden: false },
      },
    ]);
  });
});

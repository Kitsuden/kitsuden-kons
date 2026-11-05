/**
 * Editorial layer of a game's blocks (Inti)
 * ============================================================================
 *
 * Contract (2026-10-14): edits NEVER touch `data` (it belongs to the
 * loaders); they go in `editorial` per block, are written through two
 * atomic routes (jsonb merge in a single statement) and reloads keep them
 * by `id`. Written by staff or an agent with `content:edit` (or `admin`), and
 * that scope opens nothing else.
 *
 * Real SQL with PGlite (jsonb included), with no Docker and no one's database. It lives in
 * vitest and not in bun because of `mock.module` (see the test-suite notes).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { invalidScopeReason } from "@kitsuden/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import {
  adminGate,
  ruleFor,
  ADMIN_ONLY_ROUTES,
  EARLY_ADMIN_ONLY_ROUTES,
  SCOPE_CONTENT,
} from "../../.kitsuden/apps/api/src/middleware/auth-guard";
import {
  keepEditorial,
  sqlBlocksWithEditorial,
  validateOrder,
  validateEditorialPatch,
} from "../../kons/kon-games/games.editorial";
import { createGamesRouter } from "../../kons/kon-games/games.routes";

const ROOT = resolve(__dirname, "../..");
const GAME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const MISSING = "33333333-3333-4333-8333-333333333333";

const BLOCKS = [
  {
    id: "cd-smart-grid-1",
    type: "smart-grid",
    order: 0,
    data: { title: "Armas", datasetId: "x" },
  },
  { id: "cd-tier-list-2", type: "tier-list", order: 1, data: { title: "Tier", description: "D" } },
  { id: "cd-dex-3", type: "dex", order: 2, data: { label: "Índice" } },
];

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let games: Hono;
const invalidated: string[] = [];

async function blocksOf(id: string): Promise<any[]> {
  const r = await client.query<{ blocks: any[] }>("SELECT blocks FROM games WHERE id = $1", [id]);
  return r.rows[0]!.blocks;
}

async function request(method: string, path: string, body?: unknown, rawValue?: string) {
  const res = await games.request(path, {
    method: method,
    headers: { "content-type": "application/json" },
    body: rawValue ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client);
  await client.exec(`
    CREATE TABLE games (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title varchar(500) NOT NULL,
      slug varchar(500) NOT NULL UNIQUE,
      status text NOT NULL DEFAULT 'published',
      blocks jsonb DEFAULT '[]'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );`);

  const ctx = createTestKonContext({
    db: { instance: db } as any,
    // As in the host, `requireAuth` lets through whoever asks: Inti, an agent
    // with `content:edit` (from the SDK the operation requires it: `EDITORIAL_LAYER`).
    auth: {
      requireAuth: async (c: any, next: any) => {
        c.set("user", { id: "agent-inti", role: "agent", scopes: ["content:edit"] });
        await next();
      },
    } as any,
    cache: {
      get: async () => null,
      set: async () => {},
      del: async () => {},
      invalidate: async (p: string) => {
        invalidated.push(p);
      },
    } as any,
  });
  games = new Hono();
  games.route("/api/games", createGamesRouter(ctx) as unknown as Hono);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  invalidated.length = 0;
  await client.exec("DELETE FROM games");
  await client.query(
    "INSERT INTO games (id, title, slug, blocks) VALUES ($1, 'Crimson', 'crimson', $2::jsonb)",
    [GAME, JSON.stringify(BLOCKS)]
  );
  await client.query(
    "INSERT INTO games (id, title, slug, blocks) VALUES ($1, 'Other', 'otro', $2::jsonb)",
    [OTHER, JSON.stringify([{ id: "cd-smart-grid-1", type: "smart-grid", order: 0, data: {} }])]
  );
});

// ═══════════════════════════════════════════════════════════════════════════

describe("validation of the bodies", () => {
  it("patch: only title/description/hidden, with their types and limits", () => {
    expect(validateEditorialPatch({ title: "x", description: null, hidden: true }).ok).toBe(true);
    expect(validateEditorialPatch({ title: "a".repeat(500) }).ok).toBe(true);
    expect(validateEditorialPatch({ description: "a".repeat(5000) }).ok).toBe(true);
    for (const bad of [
      null,
      [],
      "text",
      {},
      { order: 1 },
      { titulo: "x" },
      { title: 3 },
      { title: "a".repeat(501) },
      { description: "a".repeat(5001) },
      { hidden: "true" },
      { title: "ok", extra: 1 },
    ]) {
      expect(validateEditorialPatch(bad).ok, JSON.stringify(bad)?.slice(0, 40)).toBe(false);
    }
  });

  it("order: exactly { ids: string[] } with no repeats", () => {
    expect(validateOrder({ ids: ["a", "b"] }).ok).toBe(true);
    for (const bad of [
      null,
      { ids: [] },
      { ids: "a" },
      { ids: ["a", "a"] },
      { ids: ["a", 1] },
      { ids: ["a"], x: 1 },
    ]) {
      expect(validateOrder(bad).ok).toBe(false);
    }
  });
});

describe("PATCH /api/games/:id/blocks/:blockId/editorial", () => {
  const route = (block = "cd-tier-list-2", game = GAME) =>
    `/api/games/${game}/blocks/${block}/editorial`;

  it("merges into the layer without touching data or the other blocks, and invalidates the cache", async () => {
    const r = await request("PATCH", route(), { title: "Mejores armas" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: "cd-tier-list-2", editorial: { title: "Mejores armas" } });
    expect(invalidated).toContain("collections:*");

    const r2 = await request("PATCH", route(), { description: "Nueva", hidden: true });
    expect(r2.body.editorial).toEqual({
      title: "Mejores armas",
      description: "Nueva",
      hidden: true,
    });

    const blocks = await blocksOf(GAME);
    expect(blocks.map((b) => b.id)).toEqual(BLOCKS.map((b) => b.id));
    expect(blocks[1].data).toEqual(BLOCKS[1]!.data);
    expect(blocks[1].order).toBe(1);
    expect(blocks[0]).toEqual(BLOCKS[0]);
    expect(blocks[2]).toEqual(BLOCKS[2]);
    // The other game with a block of the same id, untouched
    expect((await blocksOf(OTHER))[0].editorial).toBeUndefined();
  });

  it("null removes the field; if the layer ends up empty, it disappears", async () => {
    await request("PATCH", route(), { title: "T", hidden: false });
    const r = await request("PATCH", route(), { title: null });
    expect(r.body.editorial).toEqual({ hidden: false });
    const r2 = await request("PATCH", route(), { hidden: null });
    expect(r2.status).toBe(200);
    expect(r2.body.editorial).toEqual({});
    expect("editorial" in (await blocksOf(GAME))[1]).toBe(false);
  });

  it("keeps editorial.order (not touched from here)", async () => {
    await request("PUT", `/api/games/${GAME}/blocks/order`, {
      ids: ["cd-dex-3", "cd-smart-grid-1", "cd-tier-list-2"],
    });
    const r = await request("PATCH", route(), { title: "x" });
    expect(r.body.editorial).toEqual({ order: 2, title: "x" });
  });

  it("two edits of different blocks at once do not overwrite each other", async () => {
    await Promise.all([
      request("PATCH", route("cd-smart-grid-1"), { title: "A" }),
      request("PATCH", route("cd-dex-3"), { title: "B" }),
      request("PATCH", route("cd-tier-list-2"), { hidden: true }),
    ]);
    const blocks = await blocksOf(GAME);
    expect(blocks.map((b) => b.editorial)).toEqual([
      { title: "A" },
      { hidden: true },
      { title: "B" },
    ]);
  });

  it("400 for an invalid body; 404 if the game or the block does not exist", async () => {
    expect((await request("PATCH", route(), { order: 3 })).status).toBe(400);
    expect((await request("PATCH", route(), { title: "a".repeat(501) })).status).toBe(400);
    expect((await request("PATCH", route(), { description: 5 })).status).toBe(400);
    expect((await request("PATCH", route(), undefined, "{no es json")).status).toBe(400);
    expect((await request("PATCH", route("no-existe"), { title: "x" })).status).toBe(404);
    expect((await request("PATCH", route("cd-dex-3", MISSING), { title: "x" })).status).toBe(404);
    expect((await request("PATCH", route("cd-dex-3", "crimson"), { title: "x" })).status).toBe(404);
    expect(invalidated).toEqual([]);
    expect(await blocksOf(GAME)).toEqual(BLOCKS);
  });
});

describe("PUT /api/games/:id/blocks/order", () => {
  const route = (game = GAME) => `/api/games/${game}/blocks/order`;

  it("writes editorial.order = index without moving the array or touching data/order", async () => {
    const ids = ["cd-dex-3", "cd-smart-grid-1", "cd-tier-list-2"];
    await request("PATCH", `/api/games/${GAME}/blocks/cd-dex-3/editorial`, { title: "Primero" });
    const r = await request("PUT", route(), { ids });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: GAME, ids });
    expect(invalidated).toContain("collections:*");

    const blocks = await blocksOf(GAME);
    expect(blocks.map((b) => b.id)).toEqual(BLOCKS.map((b) => b.id));
    expect(blocks.map((b) => b.order)).toEqual([0, 1, 2]);
    expect(blocks.map((b) => b.data)).toEqual(BLOCKS.map((b) => b.data));
    expect(blocks.map((b) => b.editorial)).toEqual([
      { order: 1 },
      { order: 2 },
      { title: "Primero", order: 0 },
    ]);
  });

  it("400 if the list is not exactly the set of ids (incomplete, extra or foreign)", async () => {
    for (const ids of [
      ["cd-dex-3", "cd-smart-grid-1"],
      ["cd-dex-3", "cd-smart-grid-1", "cd-tier-list-2", "otro"],
      ["cd-dex-3", "cd-smart-grid-1", "x"],
      ["cd-dex-3", "cd-dex-3", "cd-smart-grid-1"],
    ]) {
      expect((await request("PUT", route(), { ids })).status, ids.join(",")).toBe(400);
    }
    expect((await request("PUT", route(), { ids: [] })).status).toBe(400);
    expect((await request("PUT", route(), ["cd-dex-3"])).status).toBe(400);
    expect(await blocksOf(GAME)).toEqual(BLOCKS);
    expect(invalidated).toEqual([]);
  });

  it("404 if the game does not exist", async () => {
    expect((await request("PUT", route(MISSING), { ids: ["cd-dex-3"] })).status).toBe(404);
    expect((await request("PUT", route("crimson"), { ids: ["cd-dex-3"] })).status).toBe(404);
  });
});

describe("0.8 (Spanish) editorial keys: 422 on write, read in English until 0.10", () => {
  const route = (block = "cd-tier-list-2") => `/api/games/${GAME}/blocks/${block}/editorial`;

  it("PATCH with a 0.8 key: 422 whose hint names the English key; nothing is written", async () => {
    const r = await request("PATCH", route(), { titulo: "x", oculto: true });
    expect(r.status).toBe(422);
    expect(r.body.error).toContain("«titulo»");
    expect(r.body.hint).toBe("Use the English names: «titulo» → «title», «oculto» → «hidden».");
    expect(r.body.renamed).toEqual([
      { path: "titulo", use: "title" },
      { path: "oculto", use: "hidden" },
    ]);
    // Mixed with English keys it is still a 422: no half write
    expect((await request("PATCH", route(), { title: "ok", descripcion: "x" })).status).toBe(422);
    expect(await blocksOf(GAME)).toEqual(BLOCKS);
    expect(invalidated).toEqual([]);
  });

  it("the 0.8 routes are gone (404), not silently served", async () => {
    const raw = (method: string, path: string, body: unknown) =>
      games.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const patch = await raw("PATCH", `/api/games/${GAME}/bloques/cd-dex-3/editorial`, { title: "x" });
    expect(patch.status).toBe(404);
    const put = await raw("PUT", `/api/games/${GAME}/bloques/orden`, { ids: ["cd-dex-3"] });
    expect(put.status).toBe(404);
    expect(await blocksOf(GAME)).toEqual(BLOCKS);
  });

  it("a layer stored with 0.8 keys is merged, sorted and kept by reloads in English", async () => {
    const old = structuredClone(BLOCKS) as any[];
    old[0].editorial = { titulo: "old", title: "new" };
    old[1].editorial = { titulo: "Viejo", orden: 5, oculto: false };
    await client.query("UPDATE games SET blocks = $1::jsonb WHERE id = $2", [JSON.stringify(old), GAME]);

    const r = await request("PATCH", route(), { description: "D" });
    expect(r.status).toBe(200);
    expect(r.body.editorial).toEqual({ title: "Viejo", order: 5, hidden: false, description: "D" });

    await request("PUT", `/api/games/${GAME}/blocks/order`, {
      ids: ["cd-tier-list-2", "cd-smart-grid-1", "cd-dex-3"],
    });
    let blocks = await blocksOf(GAME);
    expect(blocks.map((b) => b.editorial)).toEqual([
      { title: "new", order: 1 },
      { title: "Viejo", order: 0, hidden: false, description: "D" },
      { order: 2 },
    ]);

    // A loader reload carries an old 0.8 layer over in English too
    old[2].editorial = { oculto: true };
    await client.query("UPDATE games SET blocks = $1::jsonb WHERE id = $2", [JSON.stringify(old), GAME]);
    await db.execute(
      sql`UPDATE games SET blocks = ${sqlBlocksWithEditorial(BLOCKS)} WHERE id = ${GAME}`
    );
    blocks = await blocksOf(GAME);
    expect(blocks.map((b) => b.editorial)).toEqual([
      { title: "new" },
      { title: "Viejo", order: 5, hidden: false },
      { hidden: true },
    ]);
    expect(keepEditorial(old, BLOCKS).map((b: any) => b.editorial)).toEqual([
      { title: "new" },
      { title: "Viejo", order: 5, hidden: false },
      { hidden: true },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe("reloads keep the editorial layer", () => {
  it("cargar(): same id → same layer; a block that disappears loses it; a new one has none", async () => {
    await request("PATCH", `/api/games/${GAME}/blocks/cd-tier-list-2/editorial`, {
      title: "Editado",
      hidden: true,
    });
    await request("PATCH", `/api/games/${GAME}/blocks/cd-dex-3/editorial`, {
      description: "Se va",
    });

    // What a loader generates: new data, no editorial, one block fewer and one new
    const newOnes = [
      { id: "cd-tier-list-2", type: "tier-list", order: 0, data: { title: "Tier v2" } },
      { id: "cd-smart-grid-1", type: "smart-grid", order: 1, data: { title: "Armas v2" } },
      { id: "cd-mesa-4", type: "mesa", order: 2, data: {} },
    ];
    await db.execute(
      sql`UPDATE games SET blocks = ${sqlBlocksWithEditorial(newOnes)}, updated_at = now() WHERE id = ${GAME}`
    );

    const blocks = await blocksOf(GAME);
    expect(blocks).toEqual([
      { ...newOnes[0], editorial: { title: "Editado", hidden: true } },
      newOnes[1],
      newOnes[2],
    ]);
    // The other game does not lend its layer even if it shares an id
    expect((await blocksOf(OTHER))[0].editorial).toBeUndefined();
  });

  it("game without blocks (or blocks NULL) → the new ones are written as is", async () => {
    await client.query("UPDATE games SET blocks = NULL WHERE id = $1", [GAME]);
    await db.execute(
      sql`UPDATE games SET blocks = ${sqlBlocksWithEditorial(BLOCKS)} WHERE id = ${GAME}`
    );
    expect(await blocksOf(GAME)).toEqual(BLOCKS);
    await db.execute(
      sql`UPDATE games SET blocks = ${sqlBlocksWithEditorial([])} WHERE id = ${GAME}`
    );
    expect(await blocksOf(GAME)).toEqual([]);
  });

  it("keepEditorial (in memory) does the same", () => {
    const oldOnes = [
      { id: "a", editorial: { title: "T" } },
      { id: "b", editorial: "basura" },
      { id: "c" },
    ];
    const newOnes = [
      { id: "a", type: "x", order: 0, data: {} },
      { id: "b", type: "x", order: 1, data: {} },
      { id: "d", type: "x", order: 2, data: {}, editorial: { title: "it does not come from the database" } },
    ];
    expect(keepEditorial(oldOnes, newOnes)).toEqual([
      { id: "a", type: "x", order: 0, data: {}, editorial: { title: "T" } },
      { id: "b", type: "x", order: 1, data: {} },
      { id: "d", type: "x", order: 2, data: {} },
    ]);
  });

  it("no script writes games.blocks without going through sqlBlocksWithEditorial", () => {
    const scripts = join(ROOT, ".kitsuden/apps/api/scripts");
    const files = [
      ...readdirSync(scripts).map((f) => join(scripts, f)),
      ...readdirSync(join(scripts, "lib")).map((f) => join(scripts, "lib", f)),
    ].filter((f) => f.endsWith(".ts"));
    const culprits = files.filter((f) =>
      /UPDATE\s+games\s+SET\s+blocks\s*=\s*\$\{(?!(?:sqlBlocksWithEditorial|bloquesConEditorial)\()/.test(
        readFileSync(f, "utf8")
      )
    );
    expect(culprits).toEqual([]);
    // The games loader lives outside this repo: in a clone of the product
    // alone it is not there and only the generic part is checked.
    const loader = join(scripts, "lib/cargador.ts");
    if (existsSync(loader)) {
      expect(readFileSync(loader, "utf8")).toContain(
        "UPDATE games SET blocks = ${bloquesConEditorial(blocks)}"
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe("permissions: staff, or an agent with content:edit (and nothing else opens with it)", () => {
  type Who = { role?: string | null; scopes?: string[] };

  /**
   * As in production: the global middleware in index.ts, with a valid agent
   * key, leaves `agent` AND a `user` with role `agent`.
   */
  function app(q: Who) {
    const a = new Hono();
    a.use("*", async (c, next) => {
      if (q.scopes) {
        (c as any).set("agent", { scopes: q.scopes });
        (c as any).set("user", { id: "ag", role: "agent", scopes: q.scopes });
      } else if (q.role) (c as any).set("user", { id: "u1", role: q.role });
      await next();
    });
    a.use("*", adminGate([...EARLY_ADMIN_ONLY_ROUTES, ...ADMIN_ONLY_ROUTES]));
    a.all("*", (c) => c.text("dentro"));
    return a;
  }
  const status = async (q: Who, method: string, path: string) =>
    (await app(q).request(path, { method: method })).status;

  const EDITORIAL = `/api/games/${GAME}/blocks/cd-dex-3/editorial`;
  const ORDER = `/api/games/${GAME}/blocks/order`;
  const NEW_ONES: Array<[string, string]> = [
    ["PATCH", EDITORIAL],
    ["PUT", ORDER],
    ["POST", "/api/page-builder/pages"],
    ["PATCH", "/api/page-builder/pages/abc"],
    ["PATCH", "/api/page-builder/blocks/abc"],
    ["POST", "/api/page-builder/pages/abc/blocks/reorder"],
  ];

  it("the scope is named content:edit and meets the format that /api/admin/agents accepts", () => {
    expect(SCOPE_CONTENT).toBe("content:edit");
    // The scope validation for creating and editing agents (phase E: the one in
    // @kitsuden/shared, which no longer silently drops the fine-grained ones) accepts it.
    expect(invalidScopeReason(SCOPE_CONTENT)).toBeNull();
    const source = readFileSync(join(ROOT, ".kitsuden/apps/api/src/routes/agents.ts"), "utf8");
    expect(source).toContain("normalizeScopes(");
  });

  it("the new routes fall under the staff (write) rule of /api/games", () => {
    for (const [m, p] of [
      ["PATCH", EDITORIAL],
      ["PUT", ORDER],
    ] as const) {
      expect(ruleFor(ADMIN_ONLY_ROUTES, m, p)).toMatchObject({
        prefix: "/api/games",
        role: "staff",
      });
    }
  });

  it("anonymous 401; user without role 403; editor and admin pass", async () => {
    for (const [m, p] of NEW_ONES) {
      expect(await status({}, m, p), `${m} ${p}`).toBe(401);
      expect(await status({ role: "user" }, m, p), `${m} ${p}`).toBe(403);
      expect(await status({ role: "editor" }, m, p), `${m} ${p}`).toBe(200);
      expect(await status({ role: "admin" }, m, p), `${m} ${p}`).toBe(200);
    }
  });

  it("agent with content:edit passes; without it, 403; with admin, passes", async () => {
    for (const [m, p] of NEW_ONES) {
      expect(await status({ scopes: [SCOPE_CONTENT] }, m, p), `${m} ${p}`).toBe(200);
      expect(await status({ scopes: ["datasets:read"] }, m, p), `${m} ${p}`).toBe(403);
      expect(await status({ scopes: [] }, m, p), `${m} ${p}`).toBe(403);
      expect(await status({ scopes: ["content:*"] }, m, p), `${m} ${p}`).toBe(403);
      expect(await status({ scopes: ["admin"] }, m, p), `${m} ${p}`).toBe(200);
    }
  });

  it("agent without user in context (unverified key) → 401", async () => {
    const a = new Hono();
    a.use("*", async (c, next) => {
      (c as any).set("agent", { scopes: ["datasets:read"] });
      await next();
    });
    a.use("*", adminGate(ADMIN_ONLY_ROUTES));
    a.all("*", (c) => c.text("dentro"));
    expect((await a.request(EDITORIAL, { method: "PATCH" })).status).toBe(401);
  });

  it("content:edit opens NOTHING else", async () => {
    for (const [m, p] of [
      ["PATCH", `/api/games/${GAME}`],
      ["DELETE", `/api/games/${GAME}`],
      ["POST", "/api/games"],
      ["POST", "/api/games/collections"],
      ["PATCH", `/api/games/${GAME}/blocks/order`],
      ["PUT", EDITORIAL],
      ["DELETE", EDITORIAL],
      ["POST", "/api/blog"],
      ["POST", "/api/media/upload"],
      ["PATCH", "/api/settings"],
      ["GET", "/api/items/authSessions"],
      ["POST", "/api/streamers"],
      ["DELETE", "/api/modules/kon-blog"],
      ["GET", "/admin/logs"],
    ] as const) {
      expect(await status({ scopes: [SCOPE_CONTENT] }, m, p), `${m} ${p}`).toBe(403);
    }
    // No other rule mentions the scope
    const withScope = [...EARLY_ADMIN_ONLY_ROUTES, ...ADMIN_ONLY_ROUTES].filter(
      (r) => r.agentScope
    );
    expect(withScope.map((r) => r.prefix)).toEqual([
      "/api/page-builder",
      "/api/games",
      "/api/games",
    ]);
  });

  it("end to end: the gate in front of the real router", async () => {
    const a = new Hono();
    a.use("*", async (c, next) => {
      const scopes = c.req.header("x-scopes");
      if (scopes !== undefined) {
        (c as any).set("agent", { scopes: scopes ? scopes.split(",") : [] });
        (c as any).set("user", { id: "ag", role: "agent" });
      }
      await next();
    });
    a.use("*", adminGate(ADMIN_ONLY_ROUTES));
    a.route("/", games);
    const requestAs = (scopes: string | undefined) =>
      a.request(EDITORIAL, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...(scopes === undefined ? {} : { "x-scopes": scopes }),
        },
        body: JSON.stringify({ title: "Por agente" }),
      });
    expect((await requestAs(undefined)).status).toBe(401);
    expect((await requestAs("datasets:read")).status).toBe(403);
    expect((await blocksOf(GAME))[2].editorial).toBeUndefined();
    const ok = await requestAs(SCOPE_CONTENT);
    expect(ok.status).toBe(200);
    expect((await blocksOf(GAME))[2].editorial).toEqual({ title: "Por agente" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════

/**
 * Real concurrency: PGlite has a single connection and serializes everything. With
 * `KITSUDEN_TEST_PG_URL` pointing to a DISPOSABLE Postgres (the database name
 * has to contain `test`), writes are launched in parallel through a
 * pool of several connections. Without the variable, it is skipped.
 */
const URL_PG = process.env.KITSUDEN_TEST_PG_URL ?? "";
describe.skipIf(!URL_PG || !/\/[^/]*test[^/]*$/.test(URL_PG))(
  "Real Postgres: concurrent writes",
  () => {
    let pool: import("pg").Pool;
    let pdb: any;
    const N = 40;
    const ids = Array.from({ length: N }, (_, i) => `b-${i}`);

    beforeAll(async () => {
      const { Pool } = await import("pg");
      const { drizzle: drizzlePg } = await import("drizzle-orm/node-postgres");
      pool = new Pool({ connectionString: URL_PG, max: 12 });
      pdb = drizzlePg(pool);
      await pool.query(`DROP TABLE IF EXISTS games;
      CREATE TABLE games (id uuid PRIMARY KEY, title text, slug text UNIQUE, status text DEFAULT 'published',
        blocks jsonb DEFAULT '[]'::jsonb, updated_at timestamptz DEFAULT now());`);
    });
    afterAll(async () => {
      await pool?.query("DROP TABLE IF EXISTS games");
      await pool?.end();
    });

    it("40 edits of different blocks in parallel: none is lost", async () => {
      const { sqlMergeEditorial } =
        await import("../../kons/kon-games/games.editorial");
      const blocks = ids.map((id, i) => ({ id, type: "t", order: i, data: { title: id } }));
      await pool.query(
        "INSERT INTO games (id, title, slug, blocks) VALUES ($1, 'x', 'x', $2::jsonb)",
        [GAME, JSON.stringify(blocks)]
      );
      await Promise.all(
        ids.map((id) => pdb.execute(sqlMergeEditorial(GAME, id, { title: `E-${id}` })))
      );
      const { rows } = await pool.query("SELECT blocks FROM games WHERE id = $1", [GAME]);
      expect(rows[0].blocks.map((b: any) => b.editorial?.title)).toEqual(
        ids.map((id) => `E-${id}`)
      );
      expect(rows[0].blocks.map((b: any) => b.data)).toEqual(blocks.map((b) => b.data));
    });

    it("interleaved reloads and edits: the layer survives all the reloads", async () => {
      const { sqlMergeEditorial, sqlBlocksWithEditorial } =
        await import("../../kons/kon-games/games.editorial");
      const reload = (v: number) =>
        pdb.execute(
          sql`UPDATE games SET blocks = ${sqlBlocksWithEditorial(
            ids.map((id, i) => ({ id, type: "t", order: i, data: { v } }))
          )} WHERE id = ${GAME}`
        );
      await Promise.all([
        ...ids.map((id) =>
          pdb.execute(sqlMergeEditorial(GAME, id, { description: `D-${id}` }))
        ),
        ...Array.from({ length: 10 }, (_, v) => reload(v)),
      ]);
      const { rows } = await pool.query("SELECT blocks FROM games WHERE id = $1", [GAME]);
      expect(rows[0].blocks.map((b: any) => b.editorial)).toEqual(
        ids.map((id) => ({ title: `E-${id}`, description: `D-${id}` }))
      );
    });
  }
);

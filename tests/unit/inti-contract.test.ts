/**
 * Kitsuden ↔ Inti contract (`@intijs/adapter-kitsuden`)
 * ============================================================================
 *
 * The REFERENCE RESPONSES live in a single file read by both
 * suites:
 *
 *   packages/shared/contracts/inti/reference-responses.json (in the Kitsuden core)
 *
 * - Here (provider): the real API is mounted —the actual routers of
 *   page-builder, games and /api/version— on PGlite with a fixed seed, each
 *   request in the file is repeated and the real response is required to
 *   CONTAIN the reference one: same status, and each field of the reference
 *   present with the same JSON type (extra fields are allowed: adding
 *   is compatible; removing, renaming or changing type is not).
 * - In Inti (consumer): the adapter is tested against those same responses
 *   (`packages/adapter-kitsuden/tests/contract.test.ts`), so if this
 *   file changes, the adapter has to keep understanding it.
 *
 * Regenerate (only when an API change is intentional; if a contract
 * changes, bump its number first in packages/shared/src/contracts.ts):
 *
 *   UPDATE_INTI_CONTRACT=1 npx vitest run tests/unit/inti-contract.test.ts
 *
 * and copy the file to the adapter's copy (inti/packages/adapter-kitsuden/
 * tests/contract/reference-responses.json), whose test warns if the two copies differ.
 *
 * Real SQL with PGlite (like game-blocks-editorial.test.ts). The tables
 * are generated from the real Drizzle schemas, so a new column
 * enters the test on its own.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { CONTRACTS, SDKS, KITSUDEN_VERSION } from "@kitsuden/shared";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { httpProblems } from "../../.kitsuden/apps/api/src/middleware/problems-http";
import {
  CONTRACT_KON,
  versionResponse,
  versionRoutes,
} from "../../.kitsuden/apps/api/src/routes/version";
import { createBlocksRouter } from "../../.kitsuden/packages/core/blocks/blocks.routes";
import * as blocksSchema from "../../.kitsuden/packages/core/blocks/blocks.schema";
import { createGamesRouter } from "../../kons/kon-games/games.routes";
import * as gamesSchema from "../../kons/kon-games/games.schema";

const ROOT = resolve(__dirname, "../..");
export const FILE = resolve(
  ROOT,
  ".kitsuden/packages/shared/contracts/inti/reference-responses.json"
);
const UPDATE = process.env.UPDATE_INTI_CONTRACT === "1";

// ── Fixed seed: ids and dates come out as-is in the responses ───────────────

const GAME = "0a6e1c2e-0000-4000-8000-000000000001";
const PAGE = "0b6e1c2e-0000-4000-8000-000000000002";
const BLOCK_1 = "0c6e1c2e-0000-4000-8000-000000000003";
const BLOCK_2 = "0c6e1c2e-0000-4000-8000-000000000004";
const HIDDEN_BLOCK = "0c6e1c2e-0000-4000-8000-000000000005";
const DATE = "2026-10-01T10:00:00.000Z";

/**
 * Three game blocks that exercise the index rule shared by the web and the
 * adapter: one hidden by the editorial layer, one reordered with
 * `editorial.order`, and one with a title edited on top of `data` (contract v2: English keys).
 */
const GAME_BLOCKS = [
  {
    id: "cd-table-1",
    type: "smart-grid",
    order: 0,
    data: { title: "Weapons", datasetId: "weapons" },
    editorial: { order: 2 },
  },
  {
    id: "cd-tier-2",
    type: "tier-list",
    order: 1,
    data: { title: "Tier list", description: "From the loader" },
    editorial: { title: "The team's tier list" },
  },
  {
    id: "cd-dex-3",
    type: "dex",
    order: 2,
    data: { title: "Index" },
    editorial: { hidden: true },
  },
  { id: "cd-map-4", type: "habitat-map", order: 3, data: { title: "Map" } },
];

interface Scenario {
  name: string;
  contract: string;
  /** Documentary template: `GET /api/games/slug/:slug` */
  template: string;
  method: string;
  path: string;
  request?: unknown;
  status: number;
  body: unknown;
}

/** The requests, IN ORDER (writes change the database for the following ones) */
const REQUESTS: Omit<Scenario, "status" | "body">[] = [
  {
    name: "version",
    contract: "version",
    template: "GET /api/version",
    method: "GET",
    path: "/api/version",
  },
  {
    name: "gameBySlug",
    contract: "games",
    template: "GET /api/games/slug/:slug",
    method: "GET",
    path: "/api/games/slug/crimson-desert",
  },
  {
    name: "gameById",
    contract: "games",
    template: "GET /api/games/:id",
    method: "GET",
    path: `/api/games/${GAME}`,
  },
  {
    name: "pageById",
    contract: "page-builder",
    template: "GET /api/page-builder/pages/:id",
    method: "GET",
    path: `/api/page-builder/pages/${PAGE}`,
  },
  {
    name: "pageBySlug",
    contract: "page-builder",
    template: "GET /api/page-builder/pages/:slug",
    method: "GET",
    path: "/api/page-builder/pages/home",
  },
  {
    name: "pageList",
    contract: "page-builder",
    template: "GET /api/page-builder/pages?status=&limit=&offset=",
    method: "GET",
    path: "/api/page-builder/pages?status=published&limit=100&offset=0",
  },
  {
    name: "blockTypes",
    contract: "page-builder",
    template: "GET /api/page-builder/block-types",
    method: "GET",
    path: "/api/page-builder/block-types",
  },
  {
    name: "editGameBlock",
    contract: "games-editorial",
    template: "PATCH /api/games/:id/blocks/:blockId/editorial",
    method: "PATCH",
    path: `/api/games/${GAME}/blocks/cd-map-4/editorial`,
    request: { title: "Map of Pywel", description: null },
  },
  {
    name: "reorderGameBlocks",
    contract: "games-editorial",
    template: "PUT /api/games/:id/blocks/order",
    method: "PUT",
    path: `/api/games/${GAME}/blocks/order`,
    request: { ids: ["cd-tier-2", "cd-table-1", "cd-dex-3", "cd-map-4"] },
  },
  {
    name: "createBlock",
    contract: "page-builder",
    template: "POST /api/page-builder/pages/:pageId/blocks",
    method: "POST",
    path: `/api/page-builder/pages/${PAGE}/blocks`,
    request: { type: "text", content: { body: "New" } },
  },
  {
    name: "editBlock",
    contract: "page-builder",
    template: "PATCH /api/page-builder/blocks/:id",
    method: "PATCH",
    path: `/api/page-builder/blocks/${BLOCK_1}`,
    request: { content: { headline: "Welcome" } },
  },
  {
    name: "reorderBlocks",
    contract: "page-builder",
    template: "POST /api/page-builder/pages/:pageId/blocks/reorder",
    method: "POST",
    path: `/api/page-builder/pages/${PAGE}/blocks/reorder`,
    request: {
      blockOrders: [
        { id: BLOCK_2, sortOrder: 0 },
        { id: BLOCK_1, sortOrder: 10 },
      ],
    },
  },
  {
    name: "duplicateBlock",
    contract: "page-builder",
    template: "POST /api/page-builder/blocks/:id/duplicate",
    method: "POST",
    path: `/api/page-builder/blocks/${BLOCK_2}/duplicate`,
  },
  {
    name: "deleteBlock",
    contract: "page-builder",
    template: "DELETE /api/page-builder/blocks/:id",
    method: "DELETE",
    path: `/api/page-builder/blocks/${BLOCK_2}`,
  },
];

// ── "Contains" comparison ──────────────────────────────────────────────────

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Differences by which `real` does NOT meet the reference. Objects: each key
 * of the reference has to exist with the same type (recursive). Arrays:
 * each element of the reference has to match SOME real element.
 * Primitives: same JSON type (values change: new uuids, dates);
 * a `null` in the reference only requires the key to exist.
 */
export function differences(real: unknown, ref: unknown, route = "$"): string[] {
  const tr = jsonType(real);
  const tf = jsonType(ref);
  // `null` in the reference = nullable field: it has to EXIST, whatever it holds
  if (tf === "null") return [];
  if (tr !== tf) return [`${route}: expected ${tf} and got ${tr}`];
  if (tf === "array") {
    const r = real as unknown[];
    const output: string[] = [];
    (ref as unknown[]).forEach((element, i) => {
      if (!r.some((candidate) => differences(candidate, element).length === 0)) {
        const closest = r.length
          ? differences(r[Math.min(i, r.length - 1)], element, `${route}[${i}]`)
          : [];
        output.push(
          `${route}[${i}]: no real element matches the reference`,
          ...closest.slice(0, 3)
        );
      }
    });
    return output;
  }
  if (tf === "object") {
    const r = real as Record<string, unknown>;
    return Object.entries(ref as Record<string, unknown>).flatMap(([key, value]) =>
      key in r ? differences(r[key], value, `${route}.${key}`) : [`${route}.${key}: missing`]
    );
  }
  return [];
}

// ── The real API on PGlite ─────────────────────────────────────────────────

let client: PGlite;
let app: Hono;

async function createTables(pg: PGlite) {
  // From the real Drizzle schemas: a new column enters on its own
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  const empty = generateDrizzleJson({});
  const filledUp = generateDrizzleJson({
    pageStatusEnum: blocksSchema.pageStatusEnum,
    pages: blocksSchema.pages,
    blocks: blocksSchema.blocks,
    contentStatusEnum: gamesSchema.contentStatusEnum,
    tagCategoryEnum: gamesSchema.tagCategoryEnum,
    games: gamesSchema.games,
    platforms: gamesSchema.platforms,
    tags: gamesSchema.tags,
    gamesToPlatforms: gamesSchema.gamesToPlatforms,
    gamesToTags: gamesSchema.gamesToTags,
  });
  for (const statement of await generateMigration(empty, filledUp)) await pg.exec(statement);
}

async function seed(pg: PGlite) {
  await pg.query(
    `INSERT INTO games (id, title, slug, excerpt, status, blocks, created_at, updated_at)
     VALUES ($1, 'Crimson Desert', 'crimson-desert', 'Open world in Pywel', 'published', $2::jsonb, $3, $3)`,
    [GAME, JSON.stringify(GAME_BLOCKS), DATE]
  );
  await pg.query(
    `INSERT INTO block_pages (id, title, slug, description, status, is_homepage, published_at, created_at, updated_at)
     VALUES ($1, 'Home', 'home', 'Cover page', 'published', true, $2, $2, $2)`,
    [PAGE, DATE]
  );
  const block = (id: string, type: string, order: number, content: unknown, visible = true) =>
    pg.query(
      `INSERT INTO block_contents (id, page_id, type, sort_order, content, is_visible, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $7)`,
      [id, PAGE, type, order, JSON.stringify(content), visible, DATE]
    );
  await block(BLOCK_1, "hero", 0, { headline: "Hello" });
  // The hidden one shares the sortOrder scale (that is why Inti permutes, not renumbers)
  await block(HIDDEN_BLOCK, "text", 5, { body: "Draft" }, false);
  await block(BLOCK_2, "text", 10, { body: "Text" });
}

async function request(
  scenario: Omit<Scenario, "status" | "body">
): Promise<{ status: number; body: unknown }> {
  const res = await app.request(scenario.path, {
    method: scenario.method,
    headers: scenario.request === undefined ? {} : { "content-type": "application/json" },
    body: scenario.request === undefined ? undefined : JSON.stringify(scenario.request),
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  client = new PGlite();
  await createTables(client);
  await seed(client);

  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    // Authorization is NOT part of this contract (auth-guard covers it): here
    // the shape of the responses is tested.
    // Only lets through whoever asks, like the host: Inti, an agent with
    // `content:edit` (SDK operations require an account).
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
      invalidate: async () => {},
    } as any,
  });
  app = new Hono();
  // As in index.ts: errors come out as problem+json. Correct responses
  // are not touched, so the contract does not change because of this.
  app.use("*", httpProblems());
  app.route("/api/version", versionRoutes);
  app.route("/api/games", createGamesRouter(ctx) as unknown as Hono);
  // Since 2026-10-15 the page builder authorizes its writes INSIDE the kon
  // (not only in auth-guard): it is entered the way Inti does, an agent with the
  // scope `content:edit`.
  app.use("/api/page-builder/*", async (c, next) => {
    c.set(
      "user" as never,
      { id: "agent-inti", role: "agent", scopes: ["content:edit"] } as never
    );
    await next();
  });
  app.route("/api/page-builder", createBlocksRouter(ctx) as unknown as Hono);
}, 60_000);

afterAll(async () => {
  await client?.close();
});

// ═══════════════════════════════════════════════════════════════════════════

describe("declared version and contracts", () => {
  it("VERSION_DE_KITSUDEN matches the package.json files", () => {
    for (const file of ["package.json", ".kitsuden/apps/api/package.json"]) {
      const { version } = JSON.parse(readFileSync(resolve(ROOT, file), "utf8"));
      expect(version, file).toBe(KITSUDEN_VERSION);
    }
  });

  it("GET /api/version publishes the version and the contracts of @kitsuden/shared", async () => {
    const res = await versionRoutes.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      product: "kitsuden",
      version: KITSUDEN_VERSION,
      contracts: CONTRACTS,
      // CODE contracts (the kon SDK): own field, Inti does not read them
      sdk: SDKS,
    });
    expect((await versionResponse()).contracts).toEqual(CONTRACTS);
  });

  it("does not announce the contracts of a kon that is not mounted (kon-games turned off)", async () => {
    const withoutGames = await versionResponse((kon) => kon !== "kon-games");
    expect(withoutGames.contracts).not.toHaveProperty("games");
    expect(withoutGames.contracts).not.toHaveProperty("games-editorial");
    expect(withoutGames.contracts["page-builder"]).toBe(CONTRACTS["page-builder"]);
    // The core's do not depend on any kon
    expect(withoutGames.contracts["admin-registry"]).toBe(CONTRACTS["admin-registry"]);
    const nothing = await versionResponse(() => false);
    expect(Object.keys(nothing.contracts)).toEqual(["admin-registry"]);
  });

  // The adapter names the kon in its error when a contract is missing (a kon
  // turned off, almost always): its map has to be this one. Only if Inti is
  // alongside (sibling repo); in a standalone clone of Kitsuden it is skipped.
  const ADAPTER = resolve(ROOT, "../inti/packages/adapter-kitsuden/src/index.ts");
  it.skipIf(!existsSync(ADAPTER))(
    "the Inti adapter attributes each contract to the same kon",
    () => {
      const source = readFileSync(ADAPTER, "utf8");
      const block = source.match(/export const CONTRACT_KON[^=]*=\s*\{([^}]*)\}/)?.[1] ?? "";
      const ofAdapter = Object.fromEntries(
        [...block.matchAll(/'?([a-z-]+)'?\s*:\s*'([a-z-]+)'/g)].map((m) => [m[1], m[2]])
      );
      expect(ofAdapter).toEqual(CONTRACT_KON);
    }
  );

  it("contracts are positive integers (major version), with kebab-case names", () => {
    for (const [name, version] of Object.entries(CONTRACTS)) {
      expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(Number.isInteger(version) && version >= 1, name).toBe(true);
    }
  });
});

// Errors are not in the reference file (Inti only reads their text,
// the first 300 characters, see the adapter's `request()`): it is required that
// the usual reason stays in `error` and at the start of the body.
describe.skipIf(UPDATE)("errors Inti sees: problem+json without losing `error`", () => {
  it("nonexistent page: 404 NOT_FOUND with `error: Page not found`", async () => {
    const res = await app.request("/api/page-builder/pages/no-existe-esta-pagina");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const text = await res.text();
    expect(text.slice(0, 300)).toContain("Page not found");
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      error: "Page not found",
      code: "KITSUDEN_E_NOT_FOUND",
      status: 404,
      retryable: false,
    });
  });

  it("nonexistent block when editing: 404 with `error: Block not found`", async () => {
    const res = await app.request("/api/page-builder/blocks/no-es-un-uuid", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: { headline: "x" } }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Block not found");
    expect(body.code).toBe("KITSUDEN_E_NOT_FOUND");
  });
});

describe.runIf(UPDATE)("regenerate the reference responses", () => {
  it("writes the file with the real responses", async () => {
    const cases: Scenario[] = [];
    for (const requestValue of REQUESTS) cases.push({ ...requestValue, ...(await request(requestValue)) });
    const content = {
      $comment:
        "REAL responses from the Kitsuden API (generated by the kons repository's tests/unit/inti-contract.test.ts with UPDATE_INTI_CONTRACT=1). " +
        "They are read by the Kitsuden suite (the API still responds this way) and by the @intijs/adapter-kitsuden one (the adapter still understands them). " +
        "Do not edit by hand. Policy: docs/install/versions.md.",
      kitsuden: KITSUDEN_VERSION,
      contracts: CONTRACTS,
      cases,
    };
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(content, null, 2) + "\n", "utf8");
    expect(existsSync(FILE)).toBe(true);
  });
});

describe.skipIf(UPDATE)("the API still responds like the reference responses", () => {
  // Read inside the tests: when regenerating, the file does not exist yet
  let reference: { contracts: Record<string, number>; cases: Scenario[] };
  beforeAll(() => {
    reference = JSON.parse(readFileSync(FILE, "utf8"));
  });

  it("the file matches the current contracts (if you bumped one, regenerate)", () => {
    expect(reference.contracts).toEqual(CONTRACTS);
  });

  it("covers the routes the Inti adapter uses", () => {
    expect(reference.cases.map((c) => c.name)).toEqual(REQUESTS.map((p) => p.name));
  });

  // In order and in a single test: the writes set up the state for the following ones
  it("each request: same status and the response contains the reference one", async () => {
    const failures: string[] = [];
    for (const scenario of reference.cases) {
      const real = await request(scenario);
      if (real.status !== scenario.status)
        failures.push(`${scenario.template}: status ${real.status}, expected ${scenario.status}`);
      for (const d of differences(real.body, scenario.body))
        failures.push(`${scenario.template} → ${d}`);
    }
    expect(failures).toEqual([]);
  });

  it("the comparison detects a removed, renamed or retyped field", () => {
    const ref = { id: "x", blocks: [{ id: "a", order: 0, editorial: { title: "t" } }] };
    expect(
      differences(
        { id: "y", blocks: [{ id: "b", order: 1, editorial: { title: "u" } }], extra: 1 },
        ref
      )
    ).toEqual([]);
    expect(
      differences({ id: "y", blocks: [{ id: "b", ordr: 1, editorial: { title: "u" } }] }, ref)
        .length
    ).toBeGreaterThan(0);
    expect(
      differences({ id: "y", blocks: [{ id: "b", order: "1", editorial: { title: "u" } }] }, ref)
        .length
    ).toBeGreaterThan(0);
    expect(differences({ id: "y", blocks: { id: "b" } }, ref).length).toBeGreaterThan(0);
    expect(differences({ id: "y" }, { id: "x", name: null })).toEqual(["$.name: missing"]);
    expect(differences({ id: "y", name: "copia" }, { id: "x", name: null })).toEqual([]);
  });
});

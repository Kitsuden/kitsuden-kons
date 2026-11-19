/**
 * kon-games: `GET /api/games/tags` pages on request, and only then
 * ============================================================================
 *
 * `list-tags` returned every tag with no way to page. Now `limit` and `offset`
 * give one page and `hasMore`; without `limit` the answer is what it always was
 * (every tag), plus `hasMore: false`. Real SQL on PGlite, the table built from
 * the kon's Drizzle schema (as in inti-contract.test.ts).
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createGamesRouter } from "../../kons/kon-games/games.routes";
import * as gamesSchema from "../../kons/kon-games/games.schema";

let client: PGlite;
let app: Hono;

const get = async (path: string) => {
  const res = await app.request(`/api/games${path}`);
  return { status: res.status, body: (await res.json()) as any };
};

beforeAll(async () => {
  client = new PGlite();
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  const empty = generateDrizzleJson({});
  const filled = generateDrizzleJson({
    tagCategoryEnum: gamesSchema.tagCategoryEnum,
    tags: gamesSchema.tags,
  });
  for (const statement of await generateMigration(empty, filled)) await client.exec(statement);
  for (const name of ["Action", "Co-op", "Free"]) {
    await client.query(`INSERT INTO tags (name, slug) VALUES ($1, $2)`, [name, name.toLowerCase()]);
  }

  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: { requireAuth: async (_c: any, next: any) => next() } as any,
    cache: { get: async () => null, set: async () => {}, del: async () => {}, invalidate: async () => {} } as any,
  });
  app = new Hono();
  app.route("/api/games", createGamesRouter(ctx) as unknown as Hono);
});

afterAll(async () => {
  await client?.close();
});

describe("GET /api/games/tags", () => {
  it("without `limit`, every tag by name, as before, and `hasMore: false`", async () => {
    const { status, body } = await get("/tags");
    expect(status).toBe(200);
    expect(body.docs.map((t: { name: string }) => t.name)).toEqual(["Action", "Co-op", "Free"]);
    expect(body.totalDocs).toBe(3);
    expect(body.hasMore).toBe(false);
  });

  it("`limit=1` gives one tag and `hasMore: true`; the pages do not overlap", async () => {
    const first = await get("/tags?limit=1");
    expect(first.status).toBe(200);
    expect(first.body.docs).toHaveLength(1);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.totalDocs).toBe(3);

    const seen: string[] = [];
    for (let offset = 0; offset < 3; offset++) {
      const page = await get(`/tags?limit=1&offset=${offset}`);
      seen.push(page.body.docs[0].name);
      expect(page.body.hasMore).toBe(offset < 2);
    }
    expect(seen).toEqual(["Action", "Co-op", "Free"]);
  });

  it("a page size outside 1-500 is a 4xx, not a silent cap", async () => {
    expect((await get("/tags?limit=0")).status).toBeGreaterThanOrEqual(400);
    expect((await get("/tags?limit=501")).status).toBeGreaterThanOrEqual(400);
  });
});

/**
 * kon-streamers: `GET /api/streamers/live` pages
 * ============================================================================
 *
 * The list stopped at 20 live streamers with no sign. Now `limit` (1-20, the
 * default is the old cap) and `offset` give one page and `hasMore` says whether
 * more are live. Real migrations on PGlite, as in streamers-unique-channel.test.ts.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { MiddlewareHandler } from "hono";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerStreamersPolicy } from "../../kons/kon-streamers/streamers.policy";
import { createStreamersRouter } from "../../kons/kon-streamers/streamers.routes";

const DIR = resolve(__dirname, "../../kons/kon-streamers/migrations");

let client: PGlite;
let get: (path: string) => Promise<{ status: number; body: any }>;

beforeAll(async () => {
  client = new PGlite();
  await client.exec("CREATE TABLE media (id uuid PRIMARY KEY DEFAULT gen_random_uuid());");
  for (const file of readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()) {
    await client.exec(readFileSync(resolve(DIR, file), "utf8"));
  }
  await client.exec(`
    INSERT INTO streamers (display_name, slug, platform, channel_id, is_live, viewer_count) VALUES
      ('Big', 'big', 'twitch', 'big', true, 900),
      ('Mid', 'mid', 'twitch', 'mid', true, 500),
      ('Small', 'small', 'twitch', 'small', true, 10),
      ('Off', 'off', 'twitch', 'off', false, 0);
  `);
  const auth = {
    requireAuth: (async (_c, next) => next()) as MiddlewareHandler,
  };
  const app = createStreamersRouter({ db: { instance: drizzle(client) }, auth } as any);
  get = async (path) => {
    const res = await app.request(path);
    return { status: res.status, body: await res.json() };
  };
});

afterAll(async () => client?.close());

beforeEach(() => registerStreamersPolicy());

describe("GET /live", () => {
  it("without `limit`, every live streamer (up to the old 20), most viewers first, and `hasMore: false`", async () => {
    const { status, body } = await get("/live");
    expect(status).toBe(200);
    expect(body.docs.map((s: { slug: string }) => s.slug)).toEqual(["big", "mid", "small"]);
    expect(body.totalDocs).toBe(3);
    expect(body.hasMore).toBe(false);
  });

  it("`limit=1` gives one streamer and `hasMore: true`; the last page says there is no more", async () => {
    const first = await get("/live?limit=1");
    expect(first.body.docs.map((s: { slug: string }) => s.slug)).toEqual(["big"]);
    expect(first.body.hasMore).toBe(true);
    const last = await get("/live?limit=1&offset=2");
    expect(last.body.docs.map((s: { slug: string }) => s.slug)).toEqual(["small"]);
    expect(last.body.hasMore).toBe(false);
  });

  it("a page size over the old cap is refused, not silently cut", async () => {
    expect((await get("/live?limit=21")).status).toBeGreaterThanOrEqual(400);
  });
});

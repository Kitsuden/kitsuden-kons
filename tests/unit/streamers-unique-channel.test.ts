/**
 * kon-streamers — a duplicated channel is a 409, and create stores the live fields it accepts
 * ============================================================================
 *
 * Create and update promised 409 on a repeated platform + channel, but no migration created the
 * unique index the schema declared (`streamers_channel_idx`): the duplicate went in. And a slug
 * clash came out as a 500 from the kon. Migration 0002 adds the index (and refuses to run over
 * existing duplicates); the handlers map the unique violation to 409.
 *
 * Create also validated `isLive`, `viewerCount`, `followerCount`, `currentStreamTitle` and
 * `currentGameId` and then dropped them; now it stores them.
 *
 * Real Postgres (PGlite) with the kon's whole migration chain.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { MiddlewareHandler } from "hono";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { registerStreamersPolicy } from "../../kons/kon-streamers/streamers.policy";
import { createStreamersRouter } from "../../kons/kon-streamers/streamers.routes";

const DIR = resolve(__dirname, "../../kons/kon-streamers/migrations");
const CHAIN = readdirSync(DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

/** A database with the core's `media` table (0000 references it) and the chain up to `until`. */
async function database(until?: string, seed?: string): Promise<PGlite> {
  const client = new PGlite();
  await client.exec("CREATE TABLE media (id uuid PRIMARY KEY DEFAULT gen_random_uuid());");
  for (const file of CHAIN) {
    if (until && file >= until) break;
    await client.exec(readFileSync(resolve(DIR, file), "utf8"));
  }
  if (seed) await client.exec(seed);
  return client;
}

const auth = {
  requireAuth: (async (c, next) => {
    c.set("user" as never, { id: "u-admin", role: "admin" } as never);
    await next();
  }) as MiddlewareHandler,
};

let client: PGlite;
let request: (method: string, path: string, body?: unknown) => Promise<Response>;

beforeAll(async () => {
  client = await database();
  const app = createStreamersRouter({ db: { instance: drizzle(client) }, auth } as any);
  request = (method, path, body) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
});

afterAll(async () => client?.close());

beforeEach(() => registerStreamersPolicy());

describe("duplicates answer 409", () => {
  test("the same platform + channel twice: 409 on create (before: 201)", async () => {
    const first = await request("POST", "/", {
      displayName: "Alpha",
      platform: "twitch",
      channelId: "alpha",
    });
    expect(first.status).toBe(201);
    const again = await request("POST", "/", {
      displayName: "Alpha again",
      platform: "twitch",
      channelId: "alpha",
    });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/already exists/);

    // The same channel id on another platform is another channel.
    const other = await request("POST", "/", {
      displayName: "Alpha YT",
      platform: "youtube",
      channelId: "alpha",
    });
    expect(other.status).toBe(201);
  });

  test("a repeated slug is 409, not 500", async () => {
    const res = await request("POST", "/", {
      displayName: "Alpha",
      platform: "kick",
      channelId: "alpha-kick",
    });
    expect(res.status).toBe(409);
  });

  test("update to a channel another streamer has: 409", async () => {
    const res = await request("POST", "/", {
      displayName: "Beta",
      platform: "twitch",
      channelId: "beta",
    });
    const id = (await res.json()).id;
    expect((await request("PATCH", `/${id}`, { channelId: "alpha" })).status).toBe(409);
    expect((await request("PATCH", `/${id}`, { channelId: "beta-2" })).status).toBe(200);
  });
});

describe("create stores the live fields it accepts", () => {
  test("isLive, viewerCount, followerCount, currentStreamTitle and currentGameId", async () => {
    const gameId = "11111111-1111-4111-8111-111111111111";
    const res = await request("POST", "/", {
      displayName: "Gamma",
      platform: "twitch",
      channelId: "gamma",
      isLive: true,
      viewerCount: 42,
      followerCount: 1000,
      currentStreamTitle: "Ranked",
      currentGameId: gameId,
    });
    expect(res.status).toBe(201);
    const row = await res.json();
    expect(row).toMatchObject({
      isLive: true,
      viewerCount: 42,
      followerCount: 1000,
      currentStreamTitle: "Ranked",
      currentGameId: gameId,
    });
  });

  test("without them, the defaults: offline, zero counts", async () => {
    const res = await request("POST", "/", {
      displayName: "Delta",
      platform: "twitch",
      channelId: "delta",
    });
    expect(await res.json()).toMatchObject({ isLive: false, viewerCount: 0, followerCount: 0 });
  });
});

describe("migration 0002 over existing duplicates", () => {
  test("stops with a message that names them, and adds nothing", async () => {
    const seed = `
      INSERT INTO streamers (display_name, slug, platform, channel_id) VALUES
        ('One', 'one', 'twitch', 'same'), ('Two', 'two', 'twitch', 'same');`;
    const db = await database("0002_unique_channel.sql", seed);
    try {
      await expect(
        db.exec(readFileSync(resolve(DIR, "0002_unique_channel.sql"), "utf8"))
      ).rejects.toThrow(/duplicated platform \+ channel.*twitch\/same \(2 rows\)/);
      const idx = await db.query(
        `SELECT 1 FROM pg_indexes WHERE indexname = 'streamers_channel_idx'`
      );
      expect(idx.rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});

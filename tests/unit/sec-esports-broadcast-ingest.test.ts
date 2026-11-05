/**
 * Security of kon-broadcast: the ingest token and who sees what
 * ============================================================================
 *
 * ── WHAT USED TO HAPPEN ────────────────────────────────────────────────────
 *
 *   · The local agent's token was stored in the clear and compared with `!==`.
 *   · And it came out in the game's row: `GET /games/:id` returned it whole, and
 *     the policy lets ANY session VIEW a live set (sign-up is
 *     public). Reading the game was enough to push fake frames into the overlay
 *     that is on air.
 *   · `GET /matches` listed ALL sets to any session, even though
 *     `GET /matches/:id` already required `view`.
 *
 * The real router runs on PGlite with the kon's migrations.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import {
  createMemoryStateStore,
  resetSyncedState,
  respondError,
  setStateStore,
  setStateTransport,
} from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import type { MiddlewareHandler } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { registerBroadcastPolicy } from "../../kons/kon-broadcast/broadcast.policy";
import { createKonBroadcast } from "../../kons/kon-broadcast/index";
import {
  hashIngestToken,
  ingestTokenMatches,
} from "../../kons/kon-broadcast/live/ingest-token";

const ROOT = resolve(__dirname, "../..");

const OPERATOR = { id: "op-1", role: "editor" };
const OTHER_EDITOR = { id: "op-2", role: "editor" };
const ANYONE = { id: "u-random", role: "user" };

let client: PGlite;
let app: ReturnType<typeof createKonBroadcast>;

/** Session by header: `x-test-user` with the user's JSON, or nothing. */
const testAuth: MiddlewareHandler = async (c, next) => {
  const raw = c.req.header("x-test-user");
  if (!raw) return c.json({ error: "Unauthorized" }, 401);
  c.set("user" as never, JSON.parse(raw) as never);
  await next();
};

async function request(
  method: string,
  path: string,
  user: object | null,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  const res = await app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** Minimal raw frame of the Live Client Data API: one player per side. */
const RAW = {
  gameData: { gameTime: 61 },
  allPlayers: [
    { summonerName: "a", team: "ORDER", championName: "Ahri", items: [], scores: {} },
    { summonerName: "b", team: "CHAOS", championName: "Zed", items: [], scores: {} },
  ],
  events: { Events: [] },
};

beforeAll(async () => {
  client = new PGlite();
  const dir = join(ROOT, "kons/kon-broadcast/migrations");
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  setStateTransport({ broadcast() {} });
  setStateStore(createMemoryStateStore());

  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: { requireAuth: testAuth, optionalAuth: testAuth } as any,
    konConfig: { "kon-broadcast": { enableGames: true, enableLive: true } } as any,
  });
  app = createKonBroadcast(ctx);
  app.onError((err, c) => respondError(c, err));
});

afterAll(async () => {
  await client?.close();
  resetSyncedState();
});

beforeEach(() => {
  registerBroadcastPolicy();
});

describe("ingest token comparison", () => {
  test("accepts the good token against its hash, and against an old token stored in the clear", () => {
    expect(ingestTokenMatches("abc", hashIngestToken("abc"))).toBe(true);
    // Tokens issued before this change are in the clear in the database.
    expect(
      ingestTokenMatches("0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef")
    ).toBe(true);
  });

  test("rejects everything else, including the hash used as a token and empty ones", () => {
    const h = hashIngestToken("abc");
    expect(ingestTokenMatches("abd", h)).toBe(false);
    expect(ingestTokenMatches(h, h)).toBe(false);
    expect(ingestTokenMatches("", h)).toBe(false);
    expect(ingestTokenMatches("abc", null)).toBe(false);
    expect(ingestTokenMatches("abc", "")).toBe(false);
  });
});

describe("the ingest token does not leave the API and is not stored in the clear", () => {
  let matchId: string;
  let gameId: string;
  let token: string;

  test("the operator creates set, game and token", async () => {
    const m = await request("POST", "/matches", OPERATOR, { eventTitle: "Copa" });
    expect(m.status, JSON.stringify(m.json)).toBe(201);
    matchId = m.json.data.id;

    const g = await request("POST", `/matches/${matchId}/games`, OPERATOR, {});
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    gameId = g.json.data.id;

    const t = await request("POST", `/games/${gameId}/ingest/push-token`, OPERATOR, {});
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    token = t.json.data.token;
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  test("the HASH is in the database, not the token", async () => {
    const r = await client.query<{ ingest_token: string }>(
      "SELECT ingest_token FROM broadcast_games WHERE id = $1",
      [gameId]
    );
    expect(r.rows[0].ingest_token).not.toBe(token);
    expect(r.rows[0].ingest_token).toBe(hashIngestToken(token));
  });

  test("with the set LIVE, any session can see the game… but without the token", async () => {
    await client.query("UPDATE broadcast_matches SET status = 'live' WHERE id = $1", [matchId]);

    const one = await request("GET", `/games/${gameId}`, ANYONE);
    expect(one.status).toBe(200);
    expect(one.json.data).not.toHaveProperty("ingestToken");

    const list = await request("GET", `/matches/${matchId}/games`, ANYONE);
    expect(list.status).toBe(200);
    for (const g of list.json.data) expect(g).not.toHaveProperty("ingestToken");
  });

  test("push with the wrong token: 401; with the good one: accepted", async () => {
    const bad = await request(
      "POST",
      `/games/${gameId}/ingest/push`,
      null,
      { raw: RAW },
      {
        "x-broadcast-ingest-token": `${token}x`,
      }
    );
    expect(bad.status).toBe(401);

    const withoutToken = await request("POST", `/games/${gameId}/ingest/push`, null, { raw: RAW });
    expect(withoutToken.status).toBe(401);

    const good = await request(
      "POST",
      `/games/${gameId}/ingest/push`,
      null,
      { raw: RAW },
      {
        "x-broadcast-ingest-token": token,
      }
    );
    expect(good.status, JSON.stringify(good.json)).toBe(200);
  });

  test("the stored HASH does not work as a token", async () => {
    const r = await request(
      "POST",
      `/games/${gameId}/ingest/push`,
      null,
      { raw: RAW },
      {
        "x-broadcast-ingest-token": hashIngestToken(token),
      }
    );
    expect(r.status).toBe(401);
  });

  test("who operates the live session: neither another editor nor an arbitrary account", async () => {
    for (const who of [OTHER_EDITOR, ANYONE]) {
      for (const [methodValue, route] of [
        ["POST", `/games/${gameId}/ingest/push-token`],
        ["POST", `/games/${gameId}/ingest/start`],
        ["POST", `/games/${gameId}/ingest/stop`],
        ["POST", `/games/${gameId}/finish`],
      ] as const) {
        const r = await request(
          methodValue,
          route,
          who,
          methodValue === "POST" && route.endsWith("finish") ? { winner: "blue" } : {}
        );
        expect(r.status, `${who.id} ${route}`).toBe(404);
      }
    }
  });
});

describe("GET /matches goes through the same rule as GET /matches/:id", () => {
  test("an arbitrary account does not see others' sets that are not live", async () => {
    const createdItem = await request("POST", "/matches", OPERATOR, { eventTitle: "Privado" });
    expect(createdItem.status).toBe(201);
    const id = createdItem.json.data.id;

    const foreign = await request("GET", "/matches", ANYONE);
    expect(foreign.status).toBe(200);
    expect(foreign.json.docs.map((m: any) => m.id)).not.toContain(id);

    const own = await request("GET", "/matches", OPERATOR);
    expect(own.json.docs.map((m: any) => m.id)).toContain(id);
  });
});

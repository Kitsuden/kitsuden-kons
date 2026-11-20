/**
 * kon-esports — pages of list-players, list-teams and list-sets
 * ============================================================================
 *
 * `list-players` and `list-teams` stopped at 500 rows with no sign, and
 * `list-sets` returned every set of every tournament (api-contract,
 * 2026-11-18). They take `limit` and `offset` now. The body stays the bare
 * array every client reads; `X-Has-More` says whether more follow. With no
 * `limit` the players and teams still come up to 500, and the sets all of them.
 * `list-tournaments` (default 50) and `list-scene-matches` (default 12, an
 * object body, so `hasMore` goes in it) kept their `limit` and took `offset`.
 *
 * Real router on PGlite with the kon's migrations, like
 * sec-esports-tournaments.test.ts.
 */

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { resetAuthz, respondError } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { registerEsportsPolicy } from "../../kons/kon-esports/esports.policy";
import { createKonEsports } from "../../kons/kon-esports/index";

const ROOT = resolve(__dirname, "../..");

let client: PGlite;
let app: Hono;
let tournament: string;

const optional: MiddlewareHandler = async (c, next) => {
  const raw = c.req.header("x-test-user");
  if (raw) c.set("user" as never, JSON.parse(raw) as never);
  await next();
};
const mandatory: MiddlewareHandler = async (c, next) => {
  const raw = c.req.header("x-test-user");
  if (!raw) return c.json({ error: "Unauthorized" }, 401);
  c.set("user" as never, JSON.parse(raw) as never);
  await next();
};

async function get(path: string) {
  const res = await app.request(path);
  return { status: res.status, hasMore: res.headers.get("x-has-more"), json: await res.json() };
}

async function q<T = any>(sql: string, params: unknown[] = []) {
  return (await client.query<T>(sql, params)).rows;
}

beforeAll(async () => {
  client = new PGlite();
  const dir = join(ROOT, "kons/kon-esports/migrations");
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: { requireAuth: mandatory, optionalAuth: optional, requireRole: () => mandatory } as any,
  });
  app = new Hono();
  app.onError((err, c) => respondError(c, err));
  app.use("*", optional);
  app.route("/", createKonEsports(ctx));

  const [p1] = await q<{ id: string }>(
    "INSERT INTO esports_players (alias) VALUES ('Uno') RETURNING id"
  );
  const [p2] = await q<{ id: string }>(
    "INSERT INTO esports_players (alias) VALUES ('Dos') RETURNING id"
  );
  await q("INSERT INTO esports_teams (name) VALUES ('Equipo A'), ('Equipo B')");

  [{ id: tournament }] = await q<{ id: string }>(
    `INSERT INTO esports_tournaments (title, game_id, status, format, bracket_format, max_participants)
     VALUES ('Copa', $1, 'Open', '1v1', 'single_elimination', 16) RETURNING id`,
    [randomUUID()]
  );
  // A second tournament created at the same instant: only the id orders the two.
  await q(
    `INSERT INTO esports_tournaments (title, game_id, status, format, bracket_format, max_participants, created_at)
     SELECT 'Liga', $1, 'Open', '1v1', 'single_elimination', 16, created_at
     FROM esports_tournaments WHERE id = $2`,
    [randomUUID(), tournament]
  );
  // Three scene matches, two at the same time.
  await q(
    `INSERT INTO esports_pro_matches (game_name, team_one, team_two, status, scheduled_at) VALUES
       ('Valorant', 'A', 'B', 'scheduled', '2030-01-01T10:00:00Z'),
       ('Valorant', 'C', 'D', 'scheduled', '2030-01-01T10:00:00Z'),
       ('Valorant', 'E', 'F', 'scheduled', '2030-01-02T10:00:00Z')`
  );
  const part = async (playerId: string) =>
    (
      await q<{ id: string }>(
        `INSERT INTO esports_tournament_participants (tournament_id, player_id, status)
         VALUES ($1, $2, 'Approved') RETURNING id`,
        [tournament, playerId]
      )
    )[0].id;
  const a = await part(p1.id);
  const b = await part(p2.id);
  for (const order of [1, 2]) {
    await q(
      `INSERT INTO esports_matches
         (tournament_id, round, match_order, bracket_match_id, participant_1_id, participant_2_id)
       VALUES ($1, 1, $2, $3, $4, $5)`,
      [tournament, order, `W1M${order}`, a, b]
    );
  }
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  resetAuthz();
  registerEsportsPolicy();
});

describe.each([
  ["list-players", "/players"],
  ["list-teams", "/teams"],
  ["list-sets", `/matches?tournamentId=`],
])("%s pages", (_id, base) => {
  const path = () => (base.endsWith("=") ? `${base}${tournament}` : base);
  const join = (p: string) => (p.includes("?") ? "&" : "?");

  test("limit=1 returns one row and X-Has-More: true; the next page is the other row", async () => {
    const first = await get(`${path()}${join(path())}limit=1`);
    expect(first.status).toBe(200);
    expect(first.json).toHaveLength(1);
    expect(first.hasMore).toBe("true");
    const second = await get(`${path()}${join(path())}limit=1&offset=1`);
    expect(second.json).toHaveLength(1);
    expect(second.json[0].id).not.toBe(first.json[0].id);
    expect(second.hasMore).toBe("false");
  });

  test("without limit it returns every row, as a bare array, X-Has-More: false", async () => {
    const all = await get(path());
    expect(Array.isArray(all.json)).toBe(true);
    expect(all.json).toHaveLength(2);
    expect(all.hasMore).toBe("false");
  });
});

test("a limit above the cap is a 422", async () => {
  expect((await get("/players?limit=501")).status).toBe(422);
});

describe("list-tournaments pages", () => {
  test("without parameters: both tournaments, as before, X-Has-More: false", async () => {
    const all = await get("/tournaments");
    expect(all.status).toBe(200);
    expect(Array.isArray(all.json)).toBe(true);
    expect(all.json.map((t: any) => t.title).sort()).toEqual(["Copa", "Liga"]);
    expect(all.hasMore).toBe("false");
  });

  test("limit=1 has more; limit=1&offset=1 is the second row of the whole list", async () => {
    const all = await get("/tournaments");
    const first = await get("/tournaments?limit=1");
    expect(first.json).toHaveLength(1);
    expect(first.hasMore).toBe("true");
    expect(first.json[0].id).toBe(all.json[0].id);
    const second = await get("/tournaments?limit=1&offset=1");
    expect(second.json).toHaveLength(1);
    expect(second.json[0].id).toBe(all.json[1].id);
    expect(second.hasMore).toBe("false");
  });

  test("a lenient limit still works: limit=abc is the default page", async () => {
    const res = await get("/tournaments?limit=abc");
    expect(res.status).toBe(200);
    expect(res.json).toHaveLength(2);
  });

  test("a negative offset is a 422", async () => {
    expect((await get("/tournaments?offset=-1")).status).toBe(422);
  });
});

describe("list-scene-matches pages", () => {
  test("without parameters: the same body as before plus hasMore: false", async () => {
    const all = await get("/pro-matches");
    expect(all.status).toBe(200);
    expect(all.json.docs).toHaveLength(3);
    expect(all.json.totalDocs).toBe(3);
    expect(all.json.hasMore).toBe(false);
  });

  test("limit=1 has more; walking offset visits each match once, in the full order", async () => {
    const all = await get("/pro-matches");
    const first = await get("/pro-matches?limit=1");
    expect(first.json.docs).toHaveLength(1);
    expect(first.json.totalDocs).toBe(1);
    expect(first.json.hasMore).toBe(true);
    const second = await get("/pro-matches?limit=1&offset=1");
    expect(second.json.docs[0].id).toBe(all.json.docs[1].id);
    expect(second.json.hasMore).toBe(true);
    const third = await get("/pro-matches?limit=1&offset=2");
    expect(third.json.docs[0].id).toBe(all.json.docs[2].id);
    expect(third.json.hasMore).toBe(false);
    const walked = [first, second, third].map((p) => p.json.docs[0].id);
    expect(walked).toEqual(all.json.docs.map((d: any) => d.id));
  });
});

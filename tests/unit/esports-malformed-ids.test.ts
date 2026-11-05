/**
 * kon-esports: an id that is not a uuid is a 404, not a 500
 * ============================================================================
 *
 * Phase D (e2e against the real API, 2026-10-25):
 *
 *     GET /api/esports/tournaments/no-uuid          → 500
 *     GET /api/esports/matches/no-uuid              → 500
 *     GET /api/esports/public/tournament/no-uuid    → 500
 *     GET /api/esports/public/teams/no-uuid/roster  → 500
 *
 * Postgres: `invalid input syntax for type uuid` (22P02). See valid-ids.ts.
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
const ADMIN = { id: "u-admin", role: "admin" };

let client: PGlite;
let app: Hono;
let tournament: string;

const user: MiddlewareHandler = async (c, next) => {
  const raw = c.req.header("x-test-user");
  if (raw) c.set("user" as never, JSON.parse(raw) as never);
  await next();
};

const request = async (route: string, method = "GET") =>
  (
    await app.request(route, {
      method: method,
      headers: { "content-type": "application/json", "x-test-user": JSON.stringify(ADMIN) },
      ...(method === "GET" ? {} : { body: "{}" }),
    })
  ).status;

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
    auth: { requireAuth: user, optionalAuth: user, requireRole: () => user } as any,
  });
  app = new Hono();
  app.onError((err, c) => respondError(c, err));
  app.route("/", createKonEsports(ctx));
  const [t] = (
    await client.query<{ id: string }>(
      `INSERT INTO esports_tournaments (title, game_id, status, format, bracket_format, max_participants)
       VALUES ('Copa', $1, 'Open', '1v1', 'single_elimination', 8) RETURNING id`,
      [randomUUID()]
    )
  ).rows;
  tournament = t.id;
}, 60_000);

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  resetAuthz();
  registerEsportsPolicy();
});

describe("malformed ids", () => {
  test.each([
    "/tournaments/no-uuid",
    "/matches/no-uuid",
    "/players/no-uuid",
    "/teams/no-uuid",
    "/public/tournament/no-uuid",
    "/public/teams/no-uuid/roster",
    "/matches/tournament/no-uuid/bracket",
    "/tournament/no-uuid/phases",
    "/tournament/no-uuid/check-in",
  ])("GET %s → 404", async (route) => {
    expect(await request(route)).toBe(404);
  });

  test("also on writes (PATCH/DELETE with a malformed id)", async () => {
    expect(await request("/tournaments/no-uuid", "PATCH")).toBe(404);
    expect(await request("/tournaments/no-uuid", "DELETE")).toBe(404);
  });

  test("a valid id still works, and literal and token routes are not touched", async () => {
    expect(await request(`/tournaments/${tournament}`)).toBe(200);
    expect(await request("/tournaments")).toBe(200);
    expect(await request(`/matches/tournament/${tournament}`)).toBe(200);
    // `:token` is not a uuid and is not validated as one: nonexistent invitation = 404 from the handler
    expect(await request("/invites/un-token-cualquiera")).toBe(404);
    expect(await request("/leaderboard")).toBeLessThan(500);
  });
});

/**
 * Validation is ONE middleware (`*`), not one per pattern. Each `use(pattern)`
 * of Hono shows up as one more `ALL` route, and the host's authorization matrix
 * required classifying all 46 one by one (phase D).
 */
describe("no ALL routes per pattern", () => {
  test("the router only adds a wildcard middleware", () => {
    const all = (createKonEsports(createTestKonContext({ db: { instance: drizzle(client) } as any, auth: { requireAuth: user, optionalAuth: user, requireRole: () => user } as any })) as Hono).routes;
    const byPattern = all.filter((r) => r.method === "ALL" && /:(id|tournamentId|matchId|participantId|phaseId)\b/.test(r.path));
    expect(byPattern.map((r) => r.path)).toEqual([]);
  });
});

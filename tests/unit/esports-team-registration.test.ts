/**
 * kon-esports: registering a TEAM follows the same rules as registering an individual
 * ============================================================================
 *
 * Phase D (e2e against the real API, 2026-10-25): with the team tournament at
 * `registration_mode = 'closed'` (the default),
 *
 *     POST /api/esports/public/tournament/:id/register-team  { teamId }
 *     → 201 {"data":{"status":"Approved", …}}
 *
 * `register-team` only checked that the tournament was `Team` and that the caller
 * was the captain. It did not go through `planRegistration`: a captain got into a
 * tournament with registration closed, before it opened, after it closed,
 * with the bracket already generated, without accepting the rules or over the cap.
 * Individual registration (`/register`) did check everything.
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
const CAPTAIN = { id: "u-capitan", role: "user", name: "Capi" };

let client: PGlite;
let app: Hono;
let team: string;

const user: MiddlewareHandler = async (c, next) => {
  const raw = c.req.header("x-test-user");
  if (!raw) return c.json({ error: "Unauthorized" }, 401);
  c.set("user" as never, JSON.parse(raw) as never);
  await next();
};

async function q<T = any>(sql: string, params: unknown[] = []) {
  return (await client.query<T>(sql, params)).rows;
}

async function tournament(extra: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    title: "Liga",
    game_id: randomUUID(),
    status: "Open",
    format: "Team",
    bracket_format: "single_elimination",
    max_participants: 8,
    registration_mode: "open",
    ...extra,
  };
  const cols = Object.keys(base);
  const [r] = await q<{ id: string }>(
    `INSERT INTO esports_tournaments (${cols.join(",")})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
    Object.values(base)
  );
  return r.id;
}

const register = async (t: string, body: Record<string, unknown> = {}) => {
  const res = await app.request(`/public/tournament/${t}/register-team`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": JSON.stringify(CAPTAIN) },
    body: JSON.stringify({ teamId: team, ...body }),
  });
  return { status: res.status, json: (await res.json()) as any };
};

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

  const [cap] = await q<{ id: string }>("INSERT INTO esports_players (alias) VALUES ('Capi') RETURNING id");
  const [eq] = await q<{ id: string }>(
    "INSERT INTO esports_teams (name, captain_id, created_by_user_id) VALUES ('Los Capi', $1, $2) RETURNING id",
    [cap.id, CAPTAIN.id]
  );
  team = eq.id;
  await q("INSERT INTO esports_players_to_teams (player_id, team_id, role) VALUES ($1, $2, 'captain')", [
    cap.id,
    team,
  ]);
}, 60_000);

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  resetAuthz();
  registerEsportsPolicy();
});

describe("register-team goes through the registration rules", () => {
  test("registration closed (the default) → 409", async () => {
    const t = await tournament({ registration_mode: "closed" });
    const r = await register(t);
    expect(r.status).toBe(409);
    expect((await q("SELECT 1 FROM esports_tournament_participants WHERE tournament_id = $1", [t])).length).toBe(0);
  });

  test("before opening or after closing → 409", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect((await register(await tournament({ registration_opens_at: future }))).status).toBe(409);
    expect((await register(await tournament({ registration_closes_at: past }))).status).toBe(409);
  });

  test("with the bracket generated → 409", async () => {
    const t = await tournament();
    await q(
      "INSERT INTO esports_matches (tournament_id, round, match_order) VALUES ($1, 1, 1)",
      [t]
    );
    expect((await register(t)).status).toBe(409);
  });

  test("required rules not accepted → 409; accepted → 201", async () => {
    const t = await tournament({ requires_rules_acceptance: true });
    expect((await register(t)).status).toBe(409);
    const ok = await register(t, { acceptRules: true });
    expect(ok.status).toBe(201);
    expect(ok.json.data.acceptedRulesAt).toBeTruthy();
  });

  test("open → 201 and a second time → 409", async () => {
    const t = await tournament();
    expect((await register(t)).status).toBe(201);
    expect((await register(t)).status).toBe(409);
  });

  test("approval mode → stays Pending", async () => {
    const t = await tournament({ registration_mode: "approval" });
    const r = await register(t);
    expect(r.status).toBe(201);
    expect(r.json.data.status).toBe("Pending");
  });
});

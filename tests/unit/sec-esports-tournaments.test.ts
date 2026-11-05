/**
 * Security of kon-esports: registrants, reports, teams and calendar
 * ============================================================================
 *
 * Each block pins down a hole found in the 2026-10-15 review:
 *
 *   1. `GET /tournaments/:id` and `GET /matches/:id` (public) returned the ENTIRE
 *      row of each registrant: the guest's email, their link hash, Discord
 *      handle, account and the private answers of the custom fields.
 *   2. `GET /public/tournament/:id` and registration did not check for draft.
 *   3. Reports: that only whoever plays the set reports, that a report is not a
 *      result, that `reportedBy` cannot be forged, links from another
 *      tournament, junk scores and evidence.
 *   4. Teams: someone else's alias gave access to someone else's record (captain or roster).
 *      Invitations stored in the clear and rejectable by anyone.
 *   5. `/pro-matches`: only asked for a session and wrote `...body`.
 *
 * Real router on PGlite with the kon's migrations.
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
import { hashAccessToken } from "../../kons/kon-esports/guest-access";
import { createKonEsports } from "../../kons/kon-esports/index";

const ROOT = resolve(__dirname, "../..");

const ADMIN = { id: "u-admin", role: "admin" };
const EDITOR = { id: "u-editor", role: "editor" };
const PLAYER1 = { id: "u-p1", role: "user", name: "Uno" };
const PLAYER3 = { id: "u-p3", role: "user", name: "Tres" };
const VICTIM = { id: "u-victima", role: "user", name: "Famoso" };
const ATTACKER = { id: "u-atacante", role: "user", name: "Atacante" };
const OTHER = { id: "u-otro", role: "user", name: "Other" };

let client: PGlite;
let app: Hono;

let tournament: string;
let draft: string;
let otherTournament: string;
let p1: string;
let p2: string;
let p3: string;
let setId: string;
let otherTournamentToken: string;

/** Optional session via the `x-test-user` header. */
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

async function q<T = any>(sql: string, params: unknown[] = []) {
  return (await client.query<T>(sql, params)).rows;
}

async function player(alias: string) {
  const [r] = await q<{ id: string }>(
    "INSERT INTO esports_players (alias) VALUES ($1) RETURNING id",
    [alias]
  );
  return r.id;
}

async function registered(t: string, playerId: string, extra: Record<string, unknown> = {}) {
  const cols = ["tournament_id", "player_id", "status", ...Object.keys(extra)];
  const vals = [t, playerId, "Approved", ...Object.values(extra)];
  const [r] = await q<{ id: string }>(
    `INSERT INTO esports_tournament_participants (${cols.join(",")})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
    vals
  );
  return r.id;
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
    auth: {
      requireAuth: mandatory,
      optionalAuth: optional,
      requireRole: () => mandatory,
    } as any,
  });
  app = new Hono();
  app.onError((err, c) => respondError(c, err));
  // Like the host: the session is read for EVERY request before the kon
  // (apps/api/src/index.ts). `hidden-drafts.ts` looks at it in front of the router.
  app.use("*", optional);
  app.route("/", createKonEsports(ctx));

  const fields = JSON.stringify([
    { key: "club", label: "Club", type: "text", visibility: "public" },
    { key: "paypal", label: "PayPal", type: "text" }, // private by default
  ]);
  const create = async (title: string, status: string) =>
    (
      await q<{ id: string }>(
        `INSERT INTO esports_tournaments
           (title, game_id, status, format, bracket_format, max_participants, registration_mode, custom_fields)
         VALUES ($1, $2, $3, '1v1', 'single_elimination', 16, 'open', $4::jsonb) RETURNING id`,
        [title, randomUUID(), status, fields]
      )
    )[0].id;
  tournament = await create("Copa", "Open");
  draft = await create("Secreto", "Draft");
  otherTournament = await create("Otra copa", "Open");

  p1 = await registered(tournament, await player("Uno"), {
    registered_by_user_id: PLAYER1.id,
    contact_handle: "uno#0001",
    custom_data: JSON.stringify({ club: "Club Uno", paypal: "uno@paypal.test" }),
  });
  p2 = await registered(tournament, await player("Dos"), {
    guest_email: "dos@correo.test",
    access_token_hash: hashAccessToken("token-de-dos"),
    contact_handle: "dos#0002",
  });
  p3 = await registered(tournament, await player("Tres"), { registered_by_user_id: PLAYER3.id });

  // A guest from ANOTHER tournament, with their link.
  otherTournamentToken = "token-de-otro-torneo";
  await registered(otherTournament, await player("Cuatro"), {
    guest_email: "cuatro@correo.test",
    access_token_hash: hashAccessToken(otherTournamentToken),
  });

  // The alias victim: played a tournament with their account.
  await registered(otherTournament, await player("Famoso"), { registered_by_user_id: VICTIM.id });

  const [m] = await q<{ id: string }>(
    `INSERT INTO esports_matches
       (tournament_id, round, match_order, bracket_match_id, participant_1_id, participant_2_id)
     VALUES ($1, 1, 1, 'W1M1', $2, $3) RETURNING id`,
    [tournament, p1, p2]
  );
  setId = m.id;
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  resetAuthz();
  registerEsportsPolicy();
});

const PRIVATE_ONES = ["guestEmail", "accessTokenHash", "contactHandle", "registeredByUserId"];

describe("1 · the registrant list publishes no personal data", () => {
  test("GET /tournaments/:id without a session: no emails, no hash, no handles, no private answers", async () => {
    const r = await request("GET", `/tournaments/${tournament}`, null);
    expect(r.status).toBe(200);
    const textValue = JSON.stringify(r.json);
    expect(textValue).not.toContain("dos@correo.test");
    expect(textValue).not.toContain(hashAccessToken("token-de-dos"));
    expect(textValue).not.toContain("uno@paypal.test");
    expect(textValue).not.toContain("uno#0001");
    for (const p of r.json.participants) {
      for (const k of PRIVATE_ONES) expect(p, k).not.toHaveProperty(k);
    }
    // What is public still comes out.
    const one = r.json.participants.find((p: any) => p.id === p1);
    expect(one.customData).toEqual({ club: "Club Uno" });
    expect(one.player.alias).toBe("Uno");
  });

  test("an arbitrary account does not see them either", async () => {
    const r = await request("GET", `/tournaments/${tournament}`, OTHER);
    expect(JSON.stringify(r.json)).not.toContain("dos@correo.test");
  });

  test("the organization does see the email and the handle, but NEVER the hash", async () => {
    const r = await request("GET", `/tournaments/${tournament}`, ADMIN);
    const textValue = JSON.stringify(r.json);
    expect(textValue).toContain("dos@correo.test");
    expect(textValue).toContain("uno#0001");
    expect(textValue).not.toContain(hashAccessToken("token-de-dos"));
  });

  test("GET /matches/:id without a session: same", async () => {
    const r = await request("GET", `/matches/${setId}`, null);
    expect(r.status).toBe(200);
    const textValue = JSON.stringify(r.json);
    expect(textValue).not.toContain("dos@correo.test");
    expect(textValue).not.toContain(hashAccessToken("token-de-dos"));
    expect(textValue).not.toContain("uno@paypal.test");
    expect(textValue).not.toContain("dos#0002");
    expect(r.json.participant1.player.alias).toBe("Uno");
  });
});

describe("2 · a draft does not exist from outside", () => {
  test("GET /public/tournament/:id: 404 without a session and for a player; 200 for the organization", async () => {
    expect((await request("GET", `/public/tournament/${draft}`, null)).status).toBe(404);
    expect((await request("GET", `/public/tournament/${draft}`, OTHER)).status).toBe(404);
    expect((await request("GET", `/public/tournament/${draft}`, EDITOR)).status).toBe(200);
  });

  test("nobody can register in a draft (neither guest nor with an account)", async () => {
    const g = await request("POST", `/public/tournament/${draft}/register-guest`, null, {
      alias: "Colado",
      email: "colado@correo.test",
    });
    expect(g.status).toBe(404);
    const s = await request("POST", `/public/tournament/${draft}/register`, OTHER, {
      alias: "Colado2",
    });
    expect(s.status).toBe(404);
    const [{ n }] = await q<{ n: number }>(
      "SELECT count(*)::int AS n FROM esports_tournament_participants WHERE tournament_id = $1",
      [draft]
    );
    expect(n).toBe(0);
  });
});

describe("3 · result reports", () => {
  test("whoever plays the tournament but NOT that set cannot report it", async () => {
    const r = await request("POST", `/match/${setId}/report`, PLAYER3, { winnerId: p3 });
    expect(r.status).toBe(400);
    const r2 = await request("POST", `/match/${setId}/report`, PLAYER3, { winnerId: p1 });
    expect(r2.status).toBe(400);
    const rows = await q("SELECT * FROM esports_match_reports WHERE match_id = $1", [setId]);
    expect(rows).toHaveLength(0);
  });

  test("whoever does not play the tournament gets 404, not a hint", async () => {
    const r = await request("POST", `/match/${setId}/report`, OTHER, { winnerId: p1 });
    expect(r.status).toBe(404);
  });

  test("the link of a guest from ANOTHER tournament does not work here", async () => {
    const r = await request(
      "POST",
      `/match/${setId}/report`,
      null,
      { winnerId: p2 },
      {
        "x-participant-token": otherTournamentToken,
      }
    );
    expect(r.status).toBe(404);
  });

  test("scores out of range or oddly shaped: 400 and nothing saved", async () => {
    for (const scores of [[1e9, 0], [-1, 2], [2], "2-1", [1.5, 0]]) {
      const r = await request("POST", `/match/${setId}/report`, PLAYER1, { winnerId: p1, scores });
      expect(r.status, JSON.stringify(scores)).toBe(400);
    }
    const rows = await q("SELECT * FROM esports_match_reports WHERE match_id = $1", [setId]);
    expect(rows).toHaveLength(0);
  });

  test("evidence with a `mediaId` that is not an id: 400 (it used to blow up the INSERT)", async () => {
    const r = await request("POST", `/match/${setId}/report`, PLAYER1, {
      winnerId: p1,
      evidence: [{ mediaId: "../../etc/passwd" }],
    });
    expect(r.status).toBe(400);
  });

  test("a report alone is NOT a result, and `reportedBy` is set by the server", async () => {
    const r = await request("POST", `/match/${setId}/report`, PLAYER1, {
      winnerId: p1,
      scores: [2, 1],
      // Attempt to impersonate the opponent: ignored.
      reportedBy: p2,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.applied).toBe(false);
    expect(r.json.data.status).toBe("awaiting_confirmation");

    const [row] = await q<{ reported_by: string }>(
      "SELECT reported_by FROM esports_match_reports WHERE match_id = $1",
      [setId]
    );
    expect(row.reported_by).toBe(p1);
    const [set] = await q<{ winner_id: string | null }>(
      "SELECT winner_id FROM esports_matches WHERE id = $1",
      [setId]
    );
    expect(set.winner_id).toBeNull();
  });

  test("insisting with the same report does not turn it into a result", async () => {
    await request("POST", `/match/${setId}/report`, PLAYER1, { winnerId: p1, scores: [2, 1] });
    const [set] = await q<{ winner_id: string | null }>(
      "SELECT winner_id FROM esports_matches WHERE id = $1",
      [setId]
    );
    expect(set.winner_id).toBeNull();
  });
});

describe("4 · teams: someone else's record is not used", () => {
  test("creating a team with someone else's alias: 409, and their record is not touched", async () => {
    const r = await request("POST", "/public/teams", ATTACKER, {
      name: "Equipo Pirata",
      alias: "Famoso",
    });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    const teams = await q("SELECT * FROM esports_teams WHERE name = 'Equipo Pirata'");
    expect(teams).toHaveLength(0);
  });

  test("the alias owner can use their record as captain", async () => {
    const r = await request("POST", "/public/teams", VICTIM, {
      name: "Equipo Bueno",
      alias: "Famoso",
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const [famous] = await q<{ id: string }>(
      "SELECT id FROM esports_players WHERE alias = 'Famoso'"
    );
    expect(r.json.data.captainId).toBe(famous.id);
  });

  test("invitations: the token is stored hashed; accepting with someone else's alias is 409", async () => {
    const team = await request("POST", "/public/teams", ATTACKER, {
      name: "Equipo A",
      alias: "Atacante",
    });
    expect(team.status).toBe(201);

    const inv = await request("POST", `/public/teams/${team.json.data.id}/invites`, ATTACKER, {
      handle: "alguien#1",
    });
    expect(inv.status).toBe(201);
    const token = inv.json.data.token as string;

    const [saved] = await q<{ token: string }>(
      "SELECT token FROM esports_team_invites WHERE id = $1",
      [inv.json.data.id]
    );
    expect(saved.token).not.toBe(token);

    expect((await request("GET", `/invites/${token}`, null)).status).toBe(200);
    // The stored hash does not work as a link.
    expect((await request("GET", `/invites/${saved.token}`, null)).status).toBe(404);

    const draw = await request("POST", `/invites/${token}/accept`, OTHER, { alias: "Famoso" });
    expect(draw.status).toBe(409);
    const [famous] = await q<{ id: string }>(
      "SELECT id FROM esports_players WHERE alias = 'Famoso'"
    );
    const inRoster = await q(
      "SELECT * FROM esports_players_to_teams WHERE team_id = $1 AND player_id = $2",
      [team.json.data.id, famous.id]
    );
    expect(inRoster).toHaveLength(0);

    // With their own alias, yes; and the invitation cannot be used twice.
    expect((await request("POST", `/invites/${token}/accept`, OTHER, { alias: "Other" })).status).toBe(
      200
    );
    expect(
      (await request("POST", `/invites/${token}/accept`, PLAYER3, { alias: "Tres bis" })).status
    ).toBe(409);
  });

  test("an invitation to a specific account can only be declined by that account", async () => {
    const team = await request("POST", "/public/teams", ATTACKER, {
      name: "Equipo B",
      alias: "Atacante",
    });
    expect(team.status, JSON.stringify(team.json)).toBe(201);
    const inv = await request("POST", `/public/teams/${team.json.data.id}/invites`, ATTACKER, {
      userId: PLAYER1.id,
    });
    const token = inv.json.data.token;
    expect((await request("POST", `/invites/${token}/decline`, OTHER)).status).toBe(403);
    expect((await request("POST", `/invites/${token}/decline`, PLAYER1)).status).toBe(200);
  });
});

describe("5 · the scene calendar is written by the organization", () => {
  const match = { gameName: "LoL", teamOne: "G2", teamTwo: "FNC" };

  test("an arbitrary account: 403 on POST, PATCH and DELETE", async () => {
    expect((await request("POST", "/pro-matches", OTHER, match)).status).toBe(403);
    const createdItem = await request("POST", "/pro-matches", EDITOR, match);
    expect(createdItem.status, JSON.stringify(createdItem.json)).toBe(201);
    const id = createdItem.json.id;
    expect((await request("PATCH", `/pro-matches/${id}`, OTHER, { teamOne: "X" })).status).toBe(403);
    expect((await request("DELETE", `/pro-matches/${id}`, OTHER)).status).toBe(403);
    expect((await request("PATCH", `/pro-matches/${id}`, ADMIN, { scoreOne: 1 })).status).toBe(200);
  });

  test("columns outside the schema and javascript: links are not written", async () => {
    const fixed = randomUUID();
    const withId = await request("POST", "/pro-matches", ADMIN, { ...match, id: fixed });
    expect(withId.status).toBe(422);
    expect(await q("SELECT * FROM esports_pro_matches WHERE id = $1", [fixed])).toHaveLength(0);

    const xss = await request("POST", "/pro-matches", ADMIN, {
      ...match,
      streamUrl: "javascript:alert(document.cookie)",
    });
    expect(xss.status).toBe(422);
  });
});

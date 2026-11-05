/**
 * A Swiss tournament can be run from start to finish through the API
 * ============================================================================
 *
 * ── WHAT USED TO HAPPEN ────────────────────────────────────────────────────
 *
 * A Swiss tournament could be paired, but not reported:
 *
 *   · `POST /matches/tournament/:id/report` went through `loadBracket`, which
 *     THROWS for Swiss: 400 with an internal message.
 *   · `PUT /matches/:id` wrote the winner and, since the set had no
 *     `nextMatchId` —in Swiss it never does—, marked the TOURNAMENT as finished.
 *
 * So the only route that "worked" closed the tournament on the first set.
 * The TO panel showed Swiss sets read-only, and an agent had no
 * way to finish a round.
 *
 * ── WHAT IT GUARDS ─────────────────────────────────────────────────────────
 *
 * The real kon runs on PGlite, with its migrations, and walks through
 * what whoever runs the tournament would do: generate round 1, report, pair
 * round 2, query the standings. Plus the three traps: the `PUT` that closed the
 * tournament, the misnamed field that got lost, and correcting a result when
 * the next round is already published.
 */

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { respondError } from "@kitsuden/engine";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createKonEsports } from "../../kons/kon-esports/index";

const ROOT = resolve(__dirname, "../..");
const MIGRATIONS = join(ROOT, "kons/kon-esports/migrations");

let client: PGlite;
let app: Hono;
let tournamentId: string;
const participants: string[] = [];

/** The organization: `requireStaff` asks for admin or editor. */
const asOrganization: MiddlewareHandler = async (c, next) => {
  c.set("user" as never, { id: "to-1", role: "admin" } as never);
  await next();
};

async function request(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
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

async function tournamentStatus(): Promise<string> {
  const r = await client.query<{ status: string }>(
    "SELECT status FROM esports_tournaments WHERE id = $1",
    [tournamentId]
  );
  return r.rows[0].status;
}

async function setsOfRound(round: number) {
  const r = await client.query<{
    id: string;
    participant_1_id: string | null;
    participant_2_id: string | null;
    winner_id: string | null;
  }>(
    `SELECT id, participant_1_id, participant_2_id, winner_id
       FROM esports_matches
      WHERE tournament_id = $1 AND round = $2 AND participant_2_id IS NOT NULL
      ORDER BY match_order`,
    [tournamentId, round]
  );
  return r.rows;
}

beforeAll(async () => {
  client = new PGlite();

  // The kon's REAL migrations, in order: if one stops applying on top of
  // an empty database, this test is the first to say so.
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }

  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: {
      requireAuth: asOrganization,
      optionalAuth: asOrganization,
      requireRole: () => asOrganization,
    } as any,
  });

  app = new Hono();
  app.onError((err, c) => respondError(c, err));
  app.route("/", createKonEsports(ctx));

  const t = await client.query<{ id: string }>(
    `INSERT INTO esports_tournaments (title, game_id, status, format, bracket_format, max_participants)
     VALUES ('Suizo de prueba', $1, 'Open', '1v1', 'single_elimination', 8)
     RETURNING id`,
    [randomUUID()]
  );
  tournamentId = t.rows[0].id;

  for (const alias of ["Aria", "Boro", "Ciro", "Dara"]) {
    const j = await client.query<{ id: string }>(
      "INSERT INTO esports_players (alias) VALUES ($1) RETURNING id",
      [alias]
    );
    const p = await client.query<{ id: string }>(
      `INSERT INTO esports_tournament_participants (tournament_id, player_id, status)
       VALUES ($1, $2, 'Approved') RETURNING id`,
      [tournamentId, j.rows[0].id]
    );
    participants.push(p.rows[0].id);
  }
});

afterAll(async () => {
  await client?.close();
});

describe("a Swiss tournament is reported without closing the tournament", () => {
  it("generating with the Swiss format pairs round 1", async () => {
    const r = await request("POST", `/matches/tournament/${tournamentId}/generate`, { format: "swiss" });
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300);

    const sets = await setsOfRound(1);
    expect(sets, "four players are two sets in round 1").toHaveLength(2);
  });

  it("`PUT /matches/:id` rejects the set and says which route to use", async () => {
    const [set] = await setsOfRound(1);
    const r = await request("PUT", `/matches/${set.id}`, { winnerId: set.participant_1_id });

    expect(r.status).toBe(409);
    expect(r.json.use.path).toContain(`/matches/tournament/${tournamentId}/report`);
    expect(r.json.use.body.matchId).toBe(set.id);
    expect(await tournamentStatus(), "the PUT used to mark the tournament as finished").not.toBe("Completed");
  });

  it("a misnamed field answers 422 with the right name", async () => {
    const [set] = await setsOfRound(1);
    const r = await request("POST", `/matches/tournament/${tournamentId}/report`, {
      matchId: set.id,
      winnerID: set.participant_1_id,
    });

    expect(r.status).toBe(422);
    const unknown = r.json.error.details.unknownKeys.find((k: any) => k.key === "winnerID");
    expect(unknown?.didYouMean).toBe("winnerId");
  });

  it("reporting the first set leaves the round half done, not the tournament finished", async () => {
    const [first] = await setsOfRound(1);
    const r = await request("POST", `/matches/tournament/${tournamentId}/report`, {
      matchId: first.id,
      winnerId: first.participant_1_id,
      participant1Score: 2,
      participant2Score: 1,
    });

    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.pendingInRound).toBe(1);
    expect(r.json.next, "with a pending set it is not yet time to pair").toBeNull();
    expect(await tournamentStatus()).not.toBe("Completed");
  });

  it("a winner who is not playing that set is rejected", async () => {
    const [, secondItem] = await setsOfRound(1);
    const foreign = participants.find(
      (p) => p !== secondItem.participant_1_id && p !== secondItem.participant_2_id
    );
    const r = await request("POST", `/matches/tournament/${tournamentId}/report`, {
      matchId: secondItem.id,
      winnerId: foreign,
    });
    expect(r.status).toBe(400);
    expect(r.json.participants).toEqual([secondItem.participant_1_id, secondItem.participant_2_id]);
  });

  it("when the round closes, the response says what the next step is", async () => {
    const [, secondItem] = await setsOfRound(1);
    const r = await request("POST", `/matches/tournament/${tournamentId}/report`, {
      matchId: secondItem.id,
      winnerId: secondItem.participant_2_id,
    });

    expect(r.status).toBe(200);
    expect(r.json.pendingInRound).toBe(0);
    expect(r.json.next).toBe(`POST /api/esports/tournament/${tournamentId}/swiss/next-round`);
  });

  it("round 2 is paired and the standings reflect round 1", async () => {
    const r = await request("POST", `/tournament/${tournamentId}/swiss/next-round`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await setsOfRound(2)).toHaveLength(2);

    const table = await request("GET", `/tournament/${tournamentId}/swiss`);
    expect(table.status).toBe(200);
    const withWin = table.json.data.standings.filter((s: any) => s.record.wins === 1);
    expect(withWin, "the two winners of round 1 are 1-0").toHaveLength(2);
  });

  it("correcting round 1 with round 2 already paired is rejected", async () => {
    /**
     * Changing that result now would move pairings that people already have on
     * their phones. It is a 409, not a silent correction.
     */
    const [first] = await setsOfRound(1);
    const r = await request("POST", `/matches/tournament/${tournamentId}/report`, {
      matchId: first.id,
      winnerId: first.participant_2_id,
    });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/Round 1/);
  });
});

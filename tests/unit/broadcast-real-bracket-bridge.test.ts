/**
 * kon-broadcast ↔ kon-esports: the bridge with a REAL bracket
 * ============================================================================
 *
 * Phase D (e2e against the real API, 2026-10-25), two failures:
 *
 * 1. Round name. Tournament with capacity 8 and 4 registered: the engine generates a
 *    bracket of 4 («size":4»), but `fetchPairing` computed the size with
 *    `maxParticipants` (8). The first round —semifinals— came out live
 *    as «Winners Cuartos», and the final as «Winners Semifinal».
 *
 * 2. Malformed ids. `POST /matches/from-set {"tournamentId":"no-uuid"}` and
 *    `POST /matches/:id/bind {"playerId":"no-uuid"}` → 500 (Postgres 22P02).
 *    kon-esports ids are uuids: they are validated on input (422).
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { respondError } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { fetchPairing, resetBracketCache } from "../../kons/kon-broadcast/broadcast.bracket";
import { registerBroadcastPolicy } from "../../kons/kon-broadcast/broadcast.policy";
import { createKonBroadcast } from "../../kons/kon-broadcast/index";

const ROOT = resolve(__dirname, "../..");
const OPERATOR = { id: "op-1", role: "editor" };

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let app: ReturnType<typeof createKonBroadcast>;
let tournament: string;

async function migrate(kon: string) {
  const dir = join(ROOT, "kons", kon, "migrations");
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate("kon-esports");
  await migrate("kon-broadcast");
  resetBracketCache();

  tournament = (
    await client.query<{ id: string }>(
      `INSERT INTO esports_tournaments (title, game_id, status, format, bracket_format, max_participants)
       VALUES ('Copa', $1, 'InProgress', '1v1', 'single_elimination', 8) RETURNING id`,
      [randomUUID()]
    )
  ).rows[0].id;
  const participant = async (alias: string) => {
    const [p] = (await client.query<{ id: string }>("INSERT INTO esports_players (alias) VALUES ($1) RETURNING id", [alias])).rows;
    return (
      await client.query<{ id: string }>(
        "INSERT INTO esports_tournament_participants (tournament_id, player_id, status) VALUES ($1, $2, 'Approved') RETURNING id",
        [tournament, p.id]
      )
    ).rows[0].id;
  };
  const [a, b, c, d] = [await participant("A"), await participant("B"), await participant("C"), await participant("D")];
  // Bracket of 4 (two semifinals and the final), even if the capacity is 8.
  const set = (id: string, round: number, order: number, p1: string | null, p2: string | null) =>
    client.query(
      `INSERT INTO esports_matches (tournament_id, round, match_order, bracket_match_id, participant_1_id, participant_2_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tournament, round, order, id, p1, p2]
    );
  await set("W1M1", 1, 1, a, b);
  await set("W1M2", 1, 2, c, d);
  await set("W2M1", 2, 1, null, null);

  const ctx = createTestKonContext({
    db: { instance: db } as any,
    auth: {
      requireAuth: (c: any, next: any) => {
        c.set("user", OPERATOR);
        return next();
      },
    } as any,
  });
  app = createKonBroadcast(ctx);
  app.onError((err, c) => respondError(c, err));
}, 60_000);

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerBroadcastPolicy();
});

describe("round name according to the generated bracket, not the capacity", () => {
  test("bracket of 4 in a tournament with capacity 8: the 1st round is a semifinal", async () => {
    const r = await fetchPairing(db as never, tournament, "W1M1");
    expect(r.value?.round).toBe("Winners Semifinal");
  });

  test("and the 2nd round is the final", async () => {
    const r = await fetchPairing(db as never, tournament, "W2M1");
    expect(r.value?.round).toBe("Winners Final");
  });
});

describe("malformed kon-esports ids", () => {
  const send = (route: string, body: unknown) =>
    app.request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("from-set with a tournamentId that is not a uuid → 422, not 500", async () => {
    const r = await send("/matches/from-set", { tournamentId: "no-uuid", bracketMatchId: "W1M1" });
    expect(r.status).toBe(422);
  });

  test("bind with a playerId that is not a uuid → 422, not 500", async () => {
    const createdItem = await send("/matches", { eventTitle: "Set" });
    const id = ((await createdItem.json()) as any).data.id;
    const r = await send(`/matches/${id}/bind`, { side: "a", playerId: "no-uuid" });
    expect(r.status).toBe(422);
  });

  test("from-set with a valid uuid tournament still works", async () => {
    const r = await send("/matches/from-set", { tournamentId: tournament, bracketMatchId: "W1M1" });
    expect(r.status).toBe(201);
  });
});

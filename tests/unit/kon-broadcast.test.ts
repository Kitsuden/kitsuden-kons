/**
 * Kon Broadcast — router integration test
 * ============================================================================
 *
 * Validates the contract of the kon generated with `kitsuden create-kon broadcast`:
 * the overlay is public, the rest requires auth, and the live operations
 * (score, screens, side swap) mutate the state the way OBS expects.
 *
 * Uses `createTestKonContext` (the framework's testable DI) + PGlite, the same
 * embedded PostgreSQL as lite mode: real SQL (jsonb included) with no Docker,
 * no Valkey and no network. pg-mem is no good here — it does not support the
 * parameterized queries that `repo().find()` generates.
 *
 * It lives in the vitest suite (and not in `.kitsuden/apps/api/src/tests-unit/`) on purpose:
 * several bun tests do `mock.module("drizzle-orm")` / `mock.module("@kitsuden/engine")`,
 * which in bun is GLOBAL and IRREVERSIBLE and leaves every later file without
 * `sql.identifier` or `repo`. Vitest isolates modules per file, so here the
 * kon is exercised against the real stack.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { drizzle } from "drizzle-orm/pglite";

import { operationsOf, respondError } from "@kitsuden/engine";

import {
  createMemoryStateStore,
  resetSyncedState,
  setStateStore,
  setStateTransport,
} from "@kitsuden/engine";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

import { kon, createKonBroadcast } from "../../kons/kon-broadcast/index";
import { registerBroadcastPolicy } from "../../kons/kon-broadcast/broadcast.policy";

const OPERATOR = { id: "op-1", role: "editor", email: "op@example.com" };
const ROOT = resolve(__dirname, "../..");

let app: ReturnType<typeof createKonBroadcast>;
let client: PGlite;

/** Captures what would be broadcast over WebSocket to the connected overlays. */
const broadcasts: { channel: string; message: any }[] = [];

/** `res.json()` is `unknown` in strict mode: helper to avoid casting in every test. */
async function body(res: Response): Promise<any> {
  return (await res.json()) as any;
}

/** Test auth: injects the operator and lets it through. */
function fakeRequireAuth(c: any, next: any) {
  c.set("user", OPERATOR);
  return next();
}

afterAll(async () => {
  // Without this PGlite leaves its worker alive and bun exits with a nonzero code.
  await client?.close();
  resetSyncedState();
});

// The policy registry is a process singleton and other test files
// call `resetAuthz()` (see authz-validation.test.ts). When running the whole
// suite that left this kon without rules and everything answered 403. Re-registering
// here makes the test independent of execution order.
beforeEach(() => {
  broadcasts.length = 0;
  registerBroadcastPolicy();
});

beforeAll(async () => {
  client = new PGlite(); // in-memory
  const db = drizzle(client);

  /**
   * The tables come from the KON'S MIGRATIONS, not from a CREATE TABLE written
   * here.
   *
   * They used to be written by hand, and when columns were added to the container —theme,
   * sponsors, start time, Fearless— this copy fell behind: the
   * tests started returning 500 on `POST /matches` with nothing broken
   * in the kon. A second definition of the schema is a second truth, and it
   * drifts apart as soon as someone touches the first.
   *
   * Reading them also checks, along the way, that the kon's migrations apply
   * on an empty database — which is how it is installed on a new machine.
   */
  const migrations = join(ROOT, "kons/kon-broadcast/migrations");
  for (const file of readdirSync(migrations)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(migrations, file), "utf8"));
  }

  // Fake realtime transport: we capture what an overlay connected
  // by WebSocket would receive, which is the contract that matters in a live broadcast.
  setStateTransport({
    broadcast(channel, message) {
      broadcasts.push({ channel, message });
    },
  });
  setStateStore(createMemoryStateStore());

  const ctx = createTestKonContext({
    db: { instance: db } as any,
    auth: { requireAuth: fakeRequireAuth } as any,
  });

  app = createKonBroadcast(ctx);

  // The host mounts this handler globally (apps/api/src/index.ts): it turns
  // the AppError from `validateRequest` into the 422 envelope. When testing the router
  // in isolation it has to be replicated, or every error would come out as 500.
  app.onError((err, c) => respondError(c, err));
});

describe("Kon Broadcast — manifest", () => {
  test("it is declared with the id, mountPath and domain tables", () => {
    expect(kon.id).toBe("kon-broadcast");
    expect(kon.mountPath).toBe("/api/broadcast");
    /**
     * `broadcastGames` came in when absorbing `kon-broadcast-moba`: it is the
     * OPTIONAL child table with one row per game, the one used only by profiles
     * that store draft and telemetry. A best-of-five fighting set creates
     * none — its score is a counter.
     */
    expect(kon.tables).toEqual(["broadcast_matches", "broadcast_games", "broadcast_champions"]);
  });
});

describe("Kon Broadcast — tournament set", () => {
  let matchId: string;

  test("POST /matches creates a set with the two default sides", async () => {
    const res = await app.request("/matches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventTitle: "COMBO BREAKER",
        round: "Grand Finals",
        firstTo: 5,
        // Without registering the rankings, the only available profile is
        // the generic duel that Broadcast provides: one character per side.
        sideA: { name: "PUNK", sponsor: "PG", chars: ["ahri"] },
        sideB: { name: "SONICFOX", losers: true },
      }),
    });

    expect(res.status).toBe(201);
    const { data } = await body(res);

    matchId = data.id;
    expect(data.eventTitle).toBe("COMBO BREAKER");
    expect(data.firstTo).toBe(5);
    expect(data.profileId).toBe("1v1");
    // Side A keeps what was sent and fills the rest with defaults.
    expect(data.sideA.name).toBe("PUNK");
    expect(data.sideA.chars).toEqual(["ahri"]);
    expect(data.sideA.score).toBe(0);
    // Side B marks losers and inherits the default color.
    expect(data.sideB.losers).toBe(true);
    expect(data.sideB.color).toBe("#ff5c72");
    // The operator becomes the owner → the "broadcast" policy lets them operate it.
    expect(data.ownerId).toBe(OPERATOR.id);
  });

  test("POST /matches/:id/score adds with delta and respects the floor at 0", async () => {
    const up = await app.request(`/matches/${matchId}/score`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ side: "a", delta: 1 }),
    });
    expect(up.status).toBe(200);
    expect((await body(up)).data.sideA.score).toBe(1);

    // Two subtractions in a row do not leave the score negative.
    for (let i = 0; i < 2; i++) {
      await app.request(`/matches/${matchId}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ side: "a", delta: -1 }),
      });
    }
    const after = await app.request(`/matches/${matchId}`);
    expect((await body(after)).data.sideA.score).toBe(0);
  });

  test("the score does not lose the character selection when scoring", async () => {
    const res = await app.request(`/matches/${matchId}`);
    const { data } = await body(res);
    expect(data.sideA.chars).toEqual(["ahri"]);
  });

  test("POST /matches/:id/screens puts the versus on air without touching the rest", async () => {
    const res = await app.request(`/matches/${matchId}/screens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versus: true }),
    });
    expect(res.status).toBe(200);
    const { data } = await body(res);
    expect(data.screens).toEqual({ ko: false, versus: true, casters: false, result: false });
  });

  test("POST /matches/:id/swap swaps the sides (grand finals)", async () => {
    const res = await app.request(`/matches/${matchId}/swap`, { method: "POST" });
    expect(res.status).toBe(200);
    const { data } = await body(res);
    expect(data.sideA.name).toBe("SONICFOX");
    expect(data.sideB.name).toBe("PUNK");
  });

  test("PATCH /matches/:id merges the partial side onto the existing one", async () => {
    const res = await app.request(`/matches/${matchId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sideA: { sponsor: "FOX" } }),
    });
    expect(res.status).toBe(200);
    const { data } = await body(res);
    // Changes the sponsor but keeps the gamertag already present.
    expect(data.sideA.sponsor).toBe("FOX");
    expect(data.sideA.name).toBe("SONICFOX");
  });

  test("validation: a malformed color is rejected with 422", async () => {
    const res = await app.request(`/matches/${matchId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sideA: { color: "verde" } }),
    });
    expect(res.status).toBe(422);
  });

  test("GET /overlay/:id returns only what goes on screen", async () => {
    const res = await app.request(`/overlay/${matchId}`);
    expect(res.status).toBe(200);
    const { data } = await body(res);

    expect(data.event).toEqual({
      title: "COMBO BREAKER",
      round: "Grand Finals",
      firstTo: 5,
      // The graphic needs the profile to paint the right number of picks
      // and use the game's terminology.
      profileId: "1v1",
    });
    expect(data.players.a.name).toBe("SONICFOX");
    expect(data.flags.versus).toBe(true);

    // The overlay payload does NOT leak internal metadata.
    expect(data).not.toHaveProperty("ownerId");
    expect(data.players.a).not.toHaveProperty("startggSetId");
  });

  test("GET /overlay/:id with a nonexistent id gives 404", async () => {
    const res = await app.request("/overlay/no-existe");
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Live state — what makes it a NodeCG competitor
// ═══════════════════════════════════════════════════════════════════════════

describe("Kon Broadcast — roster and result", () => {
  test("the roster loads in BULK and is idempotent by slug", async () => {
    // A roster arrives whole, from a CSV or a script; and after a patch it is
    // resent in full to update portraits without duplicating anything.
    const first = await app.request("/champions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        champions: [
          { slug: "ahri", name: "Ahri", portraitUrl: "https://example.com/ahri.png" },
          { slug: "darius", name: "Darius" },
        ],
      }),
    });
    expect(first.status).toBe(200);
    expect((await body(first)).count).toBe(2);

    const again = await app.request("/champions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        champions: [{ slug: "ahri", name: "Ahri", portraitUrl: "https://example.com/v2.png" }],
      }),
    });
    expect(again.status).toBe(200);

    const list = await body(await app.request("/champions"));
    expect(list.data).toHaveLength(2); // it was not duplicated
    expect(list.data.find((c: any) => c.slug === "ahri").portraitUrl).toBe(
      "https://example.com/v2.png"
    );
  });

  test("`replace` empties the roster: it is for switching games without mixing", async () => {
    const res = await app.request("/champions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        replace: true,
        champions: [{ slug: "ryu", name: "Ryu" }],
      }),
    });
    expect(res.status).toBe(200);

    const list = await body(await app.request("/champions"));
    expect(list.data).toHaveLength(1);
    expect(list.data[0].slug).toBe("ryu");
  });

  test("a slug with uppercase or spaces is rejected", async () => {
    // The slug is the idempotency key and what matches `chars`: if it allows
    // variants, the same character enters twice and the portrait is not
    // found when painting it.
    const res = await app.request("/champions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ champions: [{ slug: "Lee Sin", name: "Lee Sin" }] }),
    });
    expect(res.status).toBe(422);
  });

  test("the roster is READ without a session: OBS opens the overlay without cookies", () => {
    // On the operations' DECLARATION (kon SDK): GET is public
    // and writing requires a session. It used to be decided by an `app.use("/champions")`.
    const ops = operationsOf(kon);
    const de = (method: string) => ops.find((o) => o.method === method && o.route === "/champions");
    expect(de("GET")?.access).toBe("public");
    expect(de("POST")?.access).toBe("session");
  });
});

describe("Kon Broadcast — live broadcast to the overlay", () => {
  let liveId: string;

  test("creating a set broadcasts the initial state", async () => {
    const res = await app.request("/matches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventTitle: "EVO", sideA: { name: "DAIGO" } }),
    });
    const { data, channel } = await body(res);
    liveId = data.id;

    // The response says which channel to subscribe to: the client does not guess.
    expect(channel).toBe(`broadcast:match:${liveId}`);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].channel).toBe(`state:broadcast:match:${liveId}`);
    expect(broadcasts[0].message.value.players.a.name).toBe("DAIGO");
  });

  test("pressing + on the score reaches the overlay without polling", async () => {
    broadcasts.length = 0;

    await app.request(`/matches/${liveId}/score`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ side: "a", delta: 1 }),
    });

    // THIS is the NodeCG contract: the operator touches the score and the graphic
    // that is on air receives it. Without this message, an overlay would have to
    // poll and the delay would be visible on the broadcast.
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].message.type).toBe("state:sync");
    expect(broadcasts[0].message.value.players.a.score).toBe(1);
  });

  test("putting the versus on air is also broadcast", async () => {
    broadcasts.length = 0;
    await app.request(`/matches/${liveId}/screens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versus: true }),
    });
    expect(broadcasts.at(-1)!.message.value.flags.versus).toBe(true);
  });

  test("the revision is monotonic — the overlay can discard stale messages", async () => {
    broadcasts.length = 0;
    for (const delta of [1, 1, -1]) {
      await app.request(`/matches/${liveId}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ side: "b", delta }),
      });
    }
    const revs = broadcasts.map((b) => b.message.revision);
    expect(revs).toEqual([...revs].sort((x, y) => x - y));
    expect(new Set(revs).size).toBe(revs.length); // no repeats
  });

  test("GET /overlay returns snapshot + channel + revision to reconnect", async () => {
    const res = await app.request(`/overlay/${liveId}`);
    const payload = await body(res);

    expect(payload.channel).toBe(`state:broadcast:match:${liveId}`);
    expect(typeof payload.revision).toBe("number");
    expect(payload.data.players.a.name).toBe("DAIGO");
  });
});

/**
 * kon-broadcast — putting a set on air
 * ============================================================================
 *
 * The policy lets any signed-in account view a set whose `status` is `live`, and the `live`
 * column says "set on air, at most one per operator", but no route ever wrote either: sets were
 * born `draft` and reporting made them `reported`. `PATCH /matches/:id` now takes `live`:
 * `true` puts the set on air (status `live`), `false` takes it off (status `draft`), and a
 * reported set cannot go back on air.
 *
 * PGlite with the kon's migrations, like tests/unit/kon-broadcast.test.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  createMemoryStateStore,
  resetSyncedState,
  respondError,
  setStateStore,
  setStateTransport,
} from "@kitsuden/engine";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

import { createKonBroadcast } from "../../kons/kon-broadcast/index";
import { registerBroadcastPolicy } from "../../kons/kon-broadcast/broadcast.policy";

const USERS = {
  op: { id: "op-1", role: "editor" },
  other: { id: "op-2", role: "editor" },
  viewer: { id: "u-3", role: "user" },
} as const;
type Who = keyof typeof USERS;

const ROOT = resolve(__dirname, "../..");
let client: PGlite;
let app: ReturnType<typeof createKonBroadcast>;

function requireAuth(c: any, next: any) {
  const who = c.req.header("x-test-user") as Who | undefined;
  if (!who) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", USERS[who]);
  return next();
}

async function call(who: Who, method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json", "x-test-user": who },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function newSet(who: Who = "op"): Promise<string> {
  const res = await call(who, "POST", "/matches", { eventTitle: "Weekly" });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).data.id;
}

beforeAll(async () => {
  client = new PGlite();
  const migrations = join(ROOT, "kons/kon-broadcast/migrations");
  for (const file of readdirSync(migrations)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(migrations, file), "utf8"));
  }
  setStateTransport({ broadcast() {} });
  setStateStore(createMemoryStateStore());
  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: { requireAuth } as any,
  });
  app = createKonBroadcast(ctx);
  app.onError((err, c) => respondError(c, err));
});

afterAll(async () => {
  await client?.close();
  resetSyncedState();
});

beforeEach(() => registerBroadcastPolicy());

describe("on air", () => {
  test("live: true makes the set `live` and visible to any signed-in account (before: unreachable)", async () => {
    const id = await newSet();
    expect((await call("viewer", "GET", `/matches/${id}`)).status).toBe(404);

    const res = await call("op", "PATCH", `/matches/${id}`, { live: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data).toMatchObject({ status: "live", live: true });

    expect((await call("viewer", "GET", `/matches/${id}`)).status).toBe(200);
    const list = (await (await call("viewer", "GET", "/matches")).json()) as any;
    expect(list.docs.map((d: any) => d.id)).toContain(id);
    // Viewing is not operating: someone else's live set is still not theirs to update.
    expect((await call("other", "PATCH", `/matches/${id}`, { live: false })).status).toBe(404);
  });

  test("live: false takes it off air (status back to draft)", async () => {
    const id = await newSet();
    await call("op", "PATCH", `/matches/${id}`, { live: true });
    const res = await call("op", "PATCH", `/matches/${id}`, { live: false });
    expect(((await res.json()) as any).data).toMatchObject({ status: "draft", live: false });
    expect((await call("viewer", "GET", `/matches/${id}`)).status).toBe(404);
  });

  test("one set on air per operator: the previous one goes off air", async () => {
    const first = await newSet();
    const second = await newSet();
    await call("op", "PATCH", `/matches/${first}`, { live: true });
    await call("op", "PATCH", `/matches/${second}`, { live: true });

    const a = (await (await call("op", "GET", `/matches/${first}`)).json()) as any;
    const b = (await (await call("op", "GET", `/matches/${second}`)).json()) as any;
    expect(a.data).toMatchObject({ status: "draft", live: false });
    expect(b.data).toMatchObject({ status: "live", live: true });

    // Another operator's live set is not touched.
    const theirs = await newSet("other");
    await call("other", "PATCH", `/matches/${theirs}`, { live: true });
    const still = (await (await call("op", "GET", `/matches/${second}`)).json()) as any;
    expect(still.data).toMatchObject({ status: "live", live: true });
  });

  test("a reported set cannot go back on air (409)", async () => {
    const id = await newSet();
    await client.exec(`UPDATE broadcast_matches SET status = 'reported' WHERE id = '${id}'`);
    expect((await call("op", "PATCH", `/matches/${id}`, { live: true })).status).toBe(409);
  });

  test("`live` must be a boolean", async () => {
    const id = await newSet();
    expect((await call("op", "PATCH", `/matches/${id}`, { live: "yes" })).status).toBe(422);
  });
});

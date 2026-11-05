/**
 * Security of kon-streamers
 * ============================================================================
 *
 * Writes asked only for `requireAuth` (and sign-up is public): anyone
 * with a session could create, rename or delete the site's streamers, or mark
 * anyone as "live". A prefix rule in `auth-guard.ts` covered it;
 * now the kon's policy decides, and removing that rule opens nothing.
 *
 * Also: `PATCH` wrote `...body` (any column), `channelUrl` allowed
 * `javascript:`, and `?sort=` indexed the model with whatever arrived.
 *
 * Fake database that records what it is asked: what matters here is what is
 * reached and with what, not the SQL.
 */

import { resetAuthz } from "@kitsuden/engine";
import type { MiddlewareHandler } from "hono";
import { beforeEach, describe, expect, test } from "vitest";

import { registerStreamersPolicy } from "../../kons/kon-streamers/streamers.policy";
import { createStreamersRouter } from "../../kons/kon-streamers/streamers.routes";
import { streamers } from "../../kons/kon-streamers/streamers.schema";

function stubDb() {
  const log = {
    inserts: [] as unknown[],
    sets: [] as unknown[],
    deletes: 0,
    orderBy: [] as unknown[],
    touched: false,
  };
  const row = { id: "00000000-0000-0000-0000-000000000001", displayName: "X" };
  const chain: any = {
    select: () => ((log.touched = true), chain),
    from: () => chain,
    where: () => chain,
    orderBy: (...args: unknown[]) => (log.orderBy.push(...args), chain),
    limit: () => chain,
    offset: () => chain,
    insert: () => ((log.touched = true), chain),
    values: (v: unknown) => (log.inserts.push(v), chain),
    update: () => ((log.touched = true), chain),
    set: (v: unknown) => (log.sets.push(v), chain),
    delete: () => ((log.touched = true), (log.deletes += 1), chain),
    returning: () => Promise.resolve([row]),
    then: (r: (x: unknown[]) => unknown) => r([{ count: 0 }]),
  };
  return { log, instance: chain };
}

const auth = {
  requireAuth: (async (c, next) => {
    const raw = c.req.header("x-test-user");
    if (!raw) return c.json({ error: "Unauthorized" }, 401);
    c.set("user" as never, JSON.parse(raw) as never);
    await next();
  }) as MiddlewareHandler,
};

function mount() {
  const db = stubDb();
  const app = createStreamersRouter({ db, auth } as any);
  const request = (method: string, path: string, user: object | null, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { db, request };
}

const ANYONE = { id: "u-1", role: "user" };
const EDITOR = { id: "u-2", role: "editor" };
const CONTENT_AGENT = { id: "a-1", role: "agent", scopes: ["content:edit"] };
const STREAMERS_AGENT = { id: "a-2", role: "agent", scopes: ["streamer:*"] };

const NEW = { displayName: "Canal de prueba", platform: "twitch", channelId: "canal-de-prueba" };

beforeEach(() => {
  resetAuthz();
  registerStreamersPolicy();
});

describe("writes: team only", () => {
  test("any account gets 403 on everything, and the database is not touched", async () => {
    const { db, request } = mount();
    expect((await request("POST", "/", ANYONE, NEW)).status).toBe(403);
    expect((await request("PATCH", "/abc", ANYONE, { displayName: "Y" })).status).toBe(403);
    expect((await request("DELETE", "/abc", ANYONE)).status).toBe(403);
    expect(
      (
        await request("POST", "/sync/status", ANYONE, {
          updates: [{ channelId: "x", platform: "twitch", isLive: true }],
        })
      ).status
    ).toBe(403);
    expect(db.log.touched).toBe(false);
  });

  test("the content scope is not enough; `streamer:*` is", async () => {
    expect((await mount().request("POST", "/", CONTENT_AGENT, NEW)).status).toBe(403);
    expect((await mount().request("POST", "/", STREAMERS_AGENT, NEW)).status).toBe(201);
  });

  test("an editor can", async () => {
    const { request } = mount();
    expect((await request("POST", "/", EDITOR, NEW)).status).toBe(201);
  });
});

describe("what gets written", () => {
  test("PATCH does not write columns outside the list (`id`, `createdAt`)", async () => {
    const { db, request } = mount();
    const r = await request("PATCH", "/0b9f7c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b", EDITOR, {
      id: "11111111-1111-1111-1111-111111111111",
      createdAt: "2000-01-01",
      displayName: "Nuevo nombre",
    });
    expect(r.status).toBe(200);
    const set = db.log.sets[0] as Record<string, unknown>;
    expect(set.displayName).toBe("Nuevo nombre");
    expect(set).not.toHaveProperty("id");
    expect(set).not.toHaveProperty("createdAt");
  });

  test("`channelUrl` only http(s)", async () => {
    const { db, request } = mount();
    const r = await request("POST", "/", EDITOR, { ...NEW, channelUrl: "javascript:alert(1)" });
    expect(r.status).toBe(400);
    expect(db.log.inserts).toHaveLength(0);
  });
});

describe("public listing", () => {
  test("`?sort=` with something that is not a column falls back to the default order", async () => {
    const { db, request } = mount();
    const r = await request("GET", "/?sort=-constructor", null);
    expect(r.status).toBe(200);
    const order = db.log.orderBy[0] as { queryChunks?: unknown[] };
    expect(order.queryChunks).toContain(streamers.followerCount);
  });

  test("and a valid one is respected", async () => {
    const { db, request } = mount();
    await request("GET", "/?sort=-viewerCount", null);
    const order = db.log.orderBy[0] as { queryChunks?: unknown[] };
    expect(order.queryChunks).toContain(streamers.viewerCount);
  });
});

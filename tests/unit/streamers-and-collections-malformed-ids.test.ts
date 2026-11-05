/**
 * kon-streamers and kon-games: an id that is not a uuid is a 404, not a 500
 * ============================================================================
 *
 * Phase D (e2e against the real API, 2026-10-25):
 *
 *     GET /api/streamers/no-es-uuid          → 500
 *     GET /api/games/collections/no-uuid     → 500
 *
 * Postgres's `invalid input syntax for type uuid` (22P02). `GET /api/games/:id`
 * already answered 404 (`isUuid`); these routes did not check. It is checked BEFORE
 * querying: inside the host's RLS transaction an SQL error leaves it
 * aborted even if caught.
 */
import { describe, expect, it, vi } from "vitest";

import { createGamesRouter } from "../../kons/kon-games/games.routes";
import { createStreamersRouter } from "../../kons/kon-streamers/streamers.routes";

const withAdmin = async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
  c.set("user", { id: "u-admin", role: "admin" });
  await next();
};

/** A database that cannot be touched: if the route ends up querying, the test sees it. */
function untouchableBase() {
  const touch = vi.fn(() => {
    throw new Error("invalid input syntax for type uuid");
  });
  return { touch, instance: { select: touch, insert: touch, update: touch, delete: touch } };
}

const ctxWith = (instance: unknown) =>
  ({
    db: { instance },
    auth: { requireAuth: withAdmin, optionalAuth: withAdmin },
    cache: { invalidate: async () => {} },
  }) as never;

const request = (app: { request: (r: string, i: RequestInit) => Response | Promise<Response> }, method: string, route: string) =>
  app.request(route, {
    method: method,
    headers: { "content-type": "application/json" },
    ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify({ bio: "x", title: "x" }) }),
  });

describe("kon-streamers: /:id with a malformed id", () => {
  it.each(["GET", "PATCH", "DELETE"])("%s /no-es-uuid → 404 without querying", async (method) => {
    const { touch, instance } = untouchableBase();
    const app = createStreamersRouter(ctxWith(instance));
    const r = await request(app, method, "/no-es-uuid");
    expect(r.status).toBe(404);
    expect(touch).not.toHaveBeenCalled();
  });
});

describe("kon-games: /collections/:id with a malformed id", () => {
  it.each(["GET", "PATCH", "DELETE"])("%s /collections/no-uuid → 404 without querying", async (method) => {
    const { touch, instance } = untouchableBase();
    const app = createGamesRouter(ctxWith(instance));
    const r = await request(app, method, "/collections/no-uuid");
    expect(r.status).toBe(404);
    expect(touch).not.toHaveBeenCalled();
  });
});

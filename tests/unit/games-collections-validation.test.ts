/**
 * kon-games: a collection without a title is a 400, not a 500
 * ============================================================================
 *
 * Phase D (e2e against the real API, 2026-10-25):
 *
 *     POST /api/games/collections  { "name": "…" }   (without `title`)
 *     → 500 {"error":{"code":"INTERNAL","message":"Failed query: insert into
 *        \"game_collections\" …"}}
 *
 * `body.title.toLowerCase()` blew up (or the INSERT with title NULL) and the
 * client got an internal error with the SQL. What is missing from the body is
 * the caller's fault: 400 with the field, and without touching the database.
 */
import { describe, expect, it, vi } from "vitest";

import { createGamesRouter } from "../../kons/kon-games/games.routes";

function mount() {
  const insert = vi.fn(() => {
    throw new Error("should not insert");
  });
  const update = vi.fn(() => {
    throw new Error("should not update");
  });
  const ctx = {
    db: { instance: { insert, update } },
    // As in the host: `requireAuth` lets through whoever asks (the team; the
    // core gate now only lets admin and editor write here). From the
    // SDK the operation requires an account (`permission` actAsUser).
    auth: {
      requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
        c.set("user", { id: "ed-1", role: "editor" });
        await next();
      },
    },
    cache: { invalidate: async () => {} },
  } as never;
  return { app: createGamesRouter(ctx), insert, update };
}

const post = (app: ReturnType<typeof mount>["app"], route: string, body: unknown, method = "POST") =>
  app.request(route, {
    method: method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("kon-games: collection validation", () => {
  it("POST /collections without title → 400 without writing", async () => {
    const { app, insert } = mount();
    const r = await post(app, "/collections", { name: "no title" });
    expect(r.status).toBe(400);
    expect((await r.json()).field).toBe("title");
    expect(insert).not.toHaveBeenCalled();
  });

  it("POST /collections with empty title or non-JSON body → 400", async () => {
    const { app } = mount();
    expect((await post(app, "/collections", { title: "   " })).status).toBe(400);
    expect((await post(app, "/collections", "no es json")).status).toBe(400);
  });

  it("POST /collections with gameIds that is not a list → 400", async () => {
    const { app, insert } = mount();
    const r = await post(app, "/collections", { title: "Top", gameIds: "x" });
    expect(r.status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });

  it("PATCH /collections/:id with empty title → 400 without writing", async () => {
    const { app, update } = mount();
    const r = await post(app, "/collections/0b9f7c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b", { title: "" }, "PATCH");
    expect(r.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
});

/**
 * kon-games and each site's own routes (2026-10-19)
 *
 * The list of routes a game cannot occupy used to carry, in the core, the
 * sections of the websites of one specific installation (a shop, a guild page…). Now the core only ships the common ones and each installation declares
 * its own with `KITSUDEN_RESERVED_SEGMENTS`. Here: that kon-games applies them
 * when creating and renaming a game, and that without the variable it rejects nothing more
 * than the common ones.
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createGamesRouter } from "../../kons/kon-games/games.routes";

function app() {
  const ctx = createTestKonContext({
    // If a request reaches the database it means it passed the slug check
    db: {
      instance: new Proxy(
        {},
        {
          get: () => {
            throw new Error("llegó a la base");
          },
        }
      ),
    } as never,
    // Whoever creates games is the team (policy `game.create`, decision of 2026-10-26).
    auth: {
      requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
        c.set("user", { id: "ed-1", role: "editor" });
        await next();
      },
    } as never,
  });
  const a = new Hono();
  a.onError((_err, c) => c.json({ error: "llegó a la base" }, 500));
  a.route("/", createGamesRouter(ctx) as unknown as Hono);
  return a;
}

const create = (slug: string) =>
  app().request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Un juego", slug }),
  });

afterEach(() => {
  delete process.env.KITSUDEN_RESERVED_SEGMENTS;
});

describe("KITSUDEN_RESERVED_SEGMENTS in kon-games", () => {
  it("with the variable, a site-specific slug is rejected with 400 before touching the database", async () => {
    process.env.KITSUDEN_RESERVED_SEGMENTS = "torneos,tienda";
    const r = await create("tienda");
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({
      field: "slug",
      error: expect.stringMatching(/site route/),
    });
  });

  it("without the variable, that slug passes the check (only the common routes are reserved)", async () => {
    const r = await create("tienda");
    expect(r.status).not.toBe(400);
  });

  it("the common ones are always rejected", async () => {
    const r = await create("blog");
    expect(r.status).toBe(400);
  });
});

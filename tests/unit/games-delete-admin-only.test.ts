/**
 * kon-games: deleting a game is ADMIN-only, and the route checks it
 * ============================================================================
 *
 * Phase D (2026-10-25): the `game.delete` policy said "admin", but
 * `DELETE /api/games/:id` did not consult it. The core gate lets the team
 * (admin and editor) write to /api/games, so an EDITOR deleted
 * any game —with its collections and its editorial layer—. Without the fix,
 * the editor gets 200 and the DELETE reaches the database.
 */
import { describe, expect, it, vi } from "vitest";

import "../../kons/kon-games/games.policy";
import { createGamesRouter } from "../../kons/kon-games/games.routes";

const ID = "0b9f7c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";

function mount(user: Record<string, unknown> | null) {
  const deleted: string[] = [];
  const of = vi.fn(() => ({
    where: () => ({
      returning: async () => {
        deleted.push(ID);
        return [{ id: ID }];
      },
    }),
  }));
  const ctx = {
    db: { instance: { delete: of } },
    auth: {
      requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
        c.set("user", user);
        await next();
      },
    },
    cache: { invalidate: async () => {} },
  } as never;
  return { app: createGamesRouter(ctx), del: of };
}

const remove = (user: Record<string, unknown> | null) => {
  const m = mount(user);
  return { m, res: m.app.request(`/${ID}`, { method: "DELETE" }) };
};

describe("DELETE /api/games/:id", () => {
  it("an editor does NOT delete (403) and the database is not touched", async () => {
    const { m, res } = remove({ id: "ed-1", role: "editor" });
    expect((await res).status).toBe(403);
    expect(m.del).not.toHaveBeenCalled();
  });

  it("neither does a user or an agent with a foreign scope", async () => {
    expect((await remove({ id: "u-1", role: "user" }).res).status).toBe(403);
    expect((await remove({ id: "ag", role: "agent", scopes: ["content:edit"] }).res).status).toBe(403);
  });

  it("the admin does, and so does an agent with the whole kon (`games:*`) or with `game:delete`", async () => {
    expect((await remove({ id: "ad-1", role: "admin" }).res).status).toBe(200);
    expect((await remove({ id: "ag", role: "agent", scopes: ["games:*"] }).res).status).toBe(200);
    expect((await remove({ id: "ag", role: "agent", scopes: ["game:delete"] }).res).status).toBe(200);
  });

  it("a denial wins: `games:*` + `!game:delete` does not delete", async () => {
    const { m, res } = remove({ id: "ag", role: "agent", scopes: ["games:*", "!game:delete"] });
    expect((await res).status).toBe(403);
    expect(m.del).not.toHaveBeenCalled();
  });
});

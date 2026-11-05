/**
 * kon-games: games have NO owner (owner's decision, 2026-10-26)
 * ============================================================================
 *
 * The policy said "admin or owner" to edit and see a draft, the table has
 * no owner column and `PATCH /api/games/:id` did not consult the policy
 * (only the core gate decided). Now:
 *
 *   · create and edit: the TEAM (admin + editor, or an agent with the whole kon);
 *   · delete: admin only (games-delete-admin-only.test.ts);
 *   · an "owner" does not exist: an arbitrary user does not edit even if a resource
 *     says `ownerId` with their id.
 *
 * Without the change these fail: the editor does not see drafts, the "owner" edits, and a
 * user without permission reaches the route's UPDATE / INSERT.
 */
import { can } from "@kitsuden/engine";
import { describe, expect, it, vi } from "vitest";

import "../../kons/kon-games/games.policy";
import { createGamesRouter } from "../../kons/kon-games/games.routes";

const ID = "0b9f7c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";

const editor = { id: "ed-1", role: "editor" };
const admin = { id: "ad-1", role: "admin" };
const userValue = { id: "u-1", role: "user" };

function mount(user: Record<string, unknown> | null) {
  const update = vi.fn(() => ({
    set: () => ({ where: () => ({ returning: async () => [{ id: ID, title: "Editado" }] }) }),
  }));
  const insert = vi.fn(() => ({
    values: () => ({ returning: async () => [{ id: ID, title: "Nuevo", slug: "nuevo" }] }),
  }));
  const of = vi.fn(() => ({ where: () => ({ returning: async () => [{ id: ID }] }) }));
  const ctx = {
    db: { instance: { update, insert, delete: of } },
    auth: {
      requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
        c.set("user", user);
        await next();
      },
    },
    cache: { invalidate: async () => {} },
  } as never;
  return { app: createGamesRouter(ctx), update, insert, del: of };
}

const request = (user: Record<string, unknown> | null, method: string, route: string, body?: unknown) => {
  const m = mount(user);
  const res = m.app.request(route, {
    method: method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { m, res };
};

describe("`game` policy: no notion of owner", () => {
  it("a user with the same id as a supposed `ownerId` neither edits nor sees the draft", async () => {
    const resource = { id: ID, status: "draft", ownerId: userValue.id } as never;
    expect(await can(userValue as never, "update", resource, "game")).toBe(false);
    expect(await can(userValue as never, "view", resource, "game")).toBe(false);
  });

  it("the team (admin and editor) creates, edits and sees drafts; only the admin deletes", async () => {
    for (const u of [editor, admin]) {
      expect(await can(u as never, "create", { id: "*" }, "game")).toBe(true);
      expect(await can(u as never, "update", { id: ID }, "game")).toBe(true);
      expect(await can(u as never, "view", { id: ID, status: "draft" }, "game")).toBe(true);
    }
    expect(await can(editor as never, "delete", { id: ID }, "game")).toBe(false);
    expect(await can(admin as never, "delete", { id: ID }, "game")).toBe(true);
  });

  it("an agent with the whole kon is team; one with `content:edit` does not edit the game", async () => {
    expect(await can({ id: "ag", role: "agent", scopes: ["games:*"] } as never, "update", { id: ID }, "game")).toBe(true);
    expect(
      await can({ id: "ag", role: "agent", scopes: ["content:edit"] } as never, "update", { id: ID }, "game")
    ).toBe(false);
  });
});

describe("the routes ask the policy", () => {
  it("PATCH /:id — an editor edits (200); a user does not (403) and the database is not touched", async () => {
    const ed = request(editor, "PATCH", `/${ID}`, { title: "Editado" });
    expect((await ed.res).status).toBe(200);
    expect(ed.m.update).toHaveBeenCalled();

    const us = request(userValue, "PATCH", `/${ID}`, { title: "Mío" });
    expect((await us.res).status).toBe(403);
    expect(us.m.update).not.toHaveBeenCalled();
  });

  it("POST / — a user does not create (403) and does not reach the INSERT; an editor does pass the policy", async () => {
    const us = request(userValue, "POST", "/", { title: "Nuevo" });
    expect((await us.res).status).toBe(403);
    expect(us.m.insert).not.toHaveBeenCalled();

    const ed = request(editor, "POST", "/", { title: "Nuevo" });
    expect((await ed.res).status).not.toBe(403);
    expect(ed.m.insert).toHaveBeenCalled();
  });

  it("DELETE /:id — the editor edits but does NOT delete; the admin does", async () => {
    const ed = request(editor, "DELETE", `/${ID}`);
    expect((await ed.res).status).toBe(403);
    expect(ed.m.del).not.toHaveBeenCalled();
    expect((await request(admin, "DELETE", `/${ID}`).res).status).toBe(200);
  });
});

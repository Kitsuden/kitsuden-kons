/**
 * Hand generator (kon-cardsim `/hands`) — deleting a dataset leaves no orphaned decks, with real RLS
 * ============================================================================
 *
 * Phase D (2026-10-25), seen over HTTP against a real Kitsuden: the editor deletes
 * a dataset, the route deletes "its decks" with the request's connection, and the
 * RLS of `handlab_decks` (`handlab_decks_owner_isolation`, the core's owner
 * one) only let her see her OWN. The users' decks were left
 * pointing to a dataset that no longer exists. Without RLS in the test (PGlite
 * superuser) the failure is not visible.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { respondError } from "@kitsuden/engine";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createKonCardsim } from "../../kons/kon-cardsim/index";
import { registerHandlabPolicy } from "../../kons/kon-cardsim/handlab.policy";

const ROLE = "handlab_rls_app";
const ANA = { id: "Aq7kL2mP9zX4nT8vB1cD3eF5gH6jK0wQ", role: "user" };
const EDITOR = { id: "Ss9zX7cV5bN3mQ1wE2rT4yU6iO8pA0lK", role: "editor" };

let client: PGlite;
let app: ReturnType<typeof createKonCardsim>;

function userFrom(c: any) {
  const raw = c.req.header("x-test-user");
  return raw ? JSON.parse(raw) : null;
}
const fakeAuth = {
  requireAuth: (c: any, next: any) => {
    const u = userFrom(c);
    if (!u) return c.json({ error: "Unauthorized" }, 401);
    c.set("user", u);
    return next();
  },
  optionalAuth: (c: any, next: any) => {
    const u = userFrom(c);
    if (u) c.set("user", u);
    return next();
  },
};

async function call(method: string, path: string, user: { id: string; role: string } | null, body?: unknown) {
  // The request's RLS context, as set by the host.
  await client.query(
    `select set_config('app.current_user_id', $1, false), set_config('app.current_user_role', $2, false)`,
    [user?.id ?? "", user?.role ?? "anon"]
  );
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = JSON.stringify(user);
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

beforeAll(async () => {
  client = new PGlite();
  const dir = resolve(__dirname, "../../kons/kon-cardsim/migrations");
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  // The core's owner policy (apps/api/src/db/rls-owned-tables.sql).
  await client.exec(`
    ALTER TABLE handlab_decks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE handlab_decks FORCE ROW LEVEL SECURITY;
    CREATE POLICY handlab_decks_owner_isolation ON handlab_decks FOR ALL TO PUBLIC USING (
      ((current_setting('app.current_user_id', true) = '' OR current_setting('app.current_user_id', true) IS NULL)
        AND COALESCE(current_setting('app.current_user_role', true), '') = '')
      OR current_setting('app.current_user_role', true) = 'admin'
      OR owner_id = current_setting('app.current_user_id', true)
    );
    CREATE ROLE ${ROLE} NOLOGIN;
    GRANT USAGE ON SCHEMA public TO ${ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE};
    SET ROLE ${ROLE};
  `);
  const su = await client.query<{ su: boolean }>(
    `SELECT rolsuper OR rolbypassrls AS su FROM pg_roles WHERE rolname = current_user`
  );
  if (su.rows[0]?.su !== false) throw new Error("the test role skips RLS");
  const asSystem = async <T>(fn: () => Promise<T>): Promise<T> => {
    await client.exec(`RESET ROLE`);
    try {
      return await fn();
    } finally {
      await client.exec(`SET ROLE ${ROLE}`);
    }
  };
  const ctx = createTestKonContext({
    db: { instance: drizzle(client), asSystem } as any,
    auth: fakeAuth as any,
  });
  app = createKonCardsim(ctx);
  app.onError((err, c) => respondError(c, err));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerHandlabPolicy();
});

test("deleting a dataset takes everyone's decks with it, not just the deleter's", async () => {
  const cards = Array.from({ length: 10 }, (_, i) => ({ cardId: `c${i}`, name: `Carta ${i}` }));
  const ds = await call("POST", "/hands/datasets/import", EDITOR, {
    slug: "rls-ds",
    name: "RLS",
    deckMin: 20,
    deckMax: 40,
    maxCopies: 4,
    cards,
  });
  expect(ds.status).toBe(201);
  const deck = Array.from({ length: 20 }, (_, i) => `c${i % 10}`);
  const saved = await call("POST", "/hands/decks", ANA, { datasetId: ds.json.data.id, name: "De Ana", cards: deck });
  expect(saved.status).toBe(201);
  // RLS is live: the editor does not see Ana's deck.
  expect((await call("POST", "/hands/hands", EDITOR, { deckId: saved.json.data.id })).status).toBe(404);

  expect((await call("DELETE", "/hands/datasets/rls-ds", EDITOR)).status).toBe(204);

  await client.exec(`RESET ROLE`);
  const remain = await client.query(`select id from handlab_decks where dataset_id = $1`, [ds.json.data.id]);
  await client.exec(`SET ROLE ${ROLE}`);
  expect(remain.rows).toHaveLength(0);
});

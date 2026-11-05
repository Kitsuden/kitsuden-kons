/**
 * Test bench for the internal kons: PGlite with REAL RLS and five
 * actors (anonymous, A, B, staff, admin).
 *
 * ── WHY A NON-SUPERUSER ROLE ───────────────────────────────────────────────
 *
 * PGlite connects as `postgres`, a superuser, and Postgres skips RLS
 * for a superuser even if the table has FORCE. A test like that would take the
 * policies as good without ever running them. After migrating (as
 * superuser, like the real runner) we `SET ROLE` to a normal role
 * —the equivalent of `kitsuden_app`— and EVERYTHING else runs with it.
 *
 * User ids have the better-auth shape (text, NOT uuid) on
 * purpose: that catches `uuid` columns that cannot store them.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { MiddlewareHandler } from "hono";

export const USERS = {
  a: { id: "usrA7kq2Lm9PzX4nT8vB1cD3eF5gH6jK", role: "user", email: "a@example.com", name: "Ana" },
  b: { id: "usrB2wE4rT6yU8iO0pA1sD3fG5hJ7kL", role: "user", email: "b@example.com", name: "Beto" },
  staff: {
    id: "usrS9zX7cV5bN3mQ1wE2rT4yU6iO8pA",
    role: "editor",
    email: "s@example.com",
    name: "Sara",
  },
  admin: {
    id: "usrAdm1nQ2wE3rT4yU5iO6pA7sD8fG9",
    role: "admin",
    email: "ad@example.com",
    name: "Root",
  },
} as const;

export type Actor = keyof typeof USERS | "anon";

const HEADER = "x-test-user";

function headerUser(value: string | undefined) {
  if (!value || !(value in USERS)) return null;
  return { ...USERS[value as keyof typeof USERS] };
}

/** Doubles of `ctx.auth` that read the actor from a test header. */
export function testAuth() {
  const optionalAuth: MiddlewareHandler = async (c, next) => {
    const u = headerUser(c.req.header(HEADER));
    if (u) c.set("user" as never, u as never);
    await next();
  };
  const requireAuth: MiddlewareHandler = async (c, next) => {
    const u = headerUser(c.req.header(HEADER));
    if (!u) return c.json({ error: "Unauthorized - Authentication required" }, 401);
    c.set("user" as never, u as never);
    await next();
  };
  const requireRole =
    (roles: string[]): MiddlewareHandler =>
    async (c, next) => {
      const u = headerUser(c.req.header(HEADER));
      if (!u) return c.json({ error: "Unauthorized" }, 401);
      if (!roles.includes(u.role)) return c.json({ error: "Forbidden" }, 403);
      c.set("user" as never, u as never);
      await next();
    };
  return {
    optionalAuth,
    requireAuth,
    requireRole,
    getSession: async () => null,
    usersById: async () => new Map(),
  };
}

/** Request as an actor. */
export function requestAs(app: {
  request: (u: string, i?: RequestInit) => Response | Promise<Response>;
}) {
  return (actor: Actor, method: string, route: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (actor !== "anon") headers[HEADER] = actor;
    if (body !== undefined) headers["content-type"] = "application/json";
    return app.request(route, {
      method: method,
      headers,
      body:
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    });
  };
}

export const APP_ROLE = "kon_prueba_app";

/**
 * PGlite with the kon's migrations applied as superuser and the session
 * afterwards switched to a role WITHOUT special privileges.
 */
/** Ver safe-kons-bench.ts. */
const AGENT_FUNCTIONS = resolve(__dirname, "../../../.kitsuden/apps/api/src/db/agent-functions.sql");

export async function databaseWithRls(kon: string, migrations: string[]) {
  const client = new PGlite();
  // The core's agent functions, as the host does before the kon's.
  await client.exec(readFileSync(AGENT_FUNCTIONS, "utf8"));
  for (const m of migrations) {
    const route = resolve(__dirname, `../../../kons/${kon}/migrations/${m}`);
    await client.exec(readFileSync(route, "utf8"));
  }
  await client.exec(`
    CREATE ROLE ${APP_ROLE} NOLOGIN;
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};
  `);
  return client;
}

/** Switches the session to the app role (after seeding as superuser). */
export async function asAppRole(client: PGlite) {
  await client.exec(`SET ROLE ${APP_ROLE}`);
  const r = await client.query<{ su: boolean }>(
    `SELECT rolsuper OR rolbypassrls AS su FROM pg_roles WHERE rolname = current_user`
  );
  // If this were a superuser, every RLS test would be decorative.
  if (r.rows[0]?.su !== false) throw new Error("the test role bypasses RLS");
  return drizzle(client);
}

/** Runs raw SQL with an actor's RLS context (inside a transaction). */
export async function sqlAs<T = Record<string, unknown>>(
  client: PGlite,
  actor: Actor,
  query: string,
  params: unknown[] = []
): Promise<T[]> {
  const u = actor === "anon" ? null : USERS[actor];
  return client.transaction(async (tx) => {
    await tx.query(
      `select set_config('app.current_user_id', $1, true), set_config('app.current_user_role', $2, true)`,
      [u?.id ?? "anonymous", u?.role ?? "anon"]
    );
    const r = await tx.query<T>(query, params);
    return r.rows;
  });
}

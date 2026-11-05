/**
 * Security test bench for kon-dms, kon-agile and kon-conta.
 * ============================================================================
 *
 * Mounts the kon's REAL ROUTES against PGlite (real Postgres) with six
 * actors: anonymous, A, B, member, staff (site editor) and admin.
 *
 * Two details that make the tests say something:
 *
 *   · NON-superuser role. PGlite connects as `postgres`, and Postgres skips
 *     RLS for a superuser even if the table has FORCE: a test like that would take
 *     the policies as good without running them. It migrates as superuser
 *     (like the runner) and then EVERYTHING runs with `SET ROLE` to a
 *     normal role, the equivalent of `kitsuden_app`.
 *   · User ids with the better-auth shape (32-char text, NOT uuid): that catches
 *     `uuid` columns that cannot store them (kon-dms had them).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { MiddlewareHandler } from "hono";

export const ACTORS = {
  a: { id: "Aq7kL2mP9zX4nT8vB1cD3eF5gH6jK0wQ", role: "user", email: "a@example.com", name: "Ana" },
  b: { id: "Bw2E4rT6yU8iO0pA1sD3fG5hJ7kL9zXc", role: "user", email: "b@example.com", name: "Beto" },
  member: {
    id: "Mm3N5bV7cX9zA1sD2fG4hJ6kL8qW0eRt",
    role: "user",
    email: "m@example.com",
    name: "Mia",
  },
  staff: {
    id: "Ss9zX7cV5bN3mQ1wE2rT4yU6iO8pA0lK",
    role: "editor",
    email: "s@example.com",
    name: "Sara",
  },
  /** Second editor: reviews in kon-dms (reviewing belongs to the team, audit 2026-10-25). */
  revisor: {
    id: "Rv4tY6uI8oP0aS2dF4gH6jK8lZ1xC3vB",
    role: "editor",
    email: "r@example.com",
    name: "Rita",
  },
  admin: {
    id: "Ad1nQ2wE3rT4yU5iO6pA7sD8fG9hJ0kZ",
    role: "admin",
    email: "ad@example.com",
    name: "Root",
  },
} as const;

export type Actor = keyof typeof ACTORS | "anon";

const HEADER = "x-test-actor";
const AGENT_HEADER = "x-test-agent";

function actorOf(header: string | undefined, agent: string | undefined) {
  if (agent) {
    // An agent arrives as `role: "agent"` with its scopes (see index.ts).
    return { id: "agente-de-prueba", role: "agent", scopes: agent.split(",") };
  }
  if (!header || !(header in ACTORS)) return null;
  return { ...ACTORS[header as keyof typeof ACTORS] };
}

/** Double of `ctx.auth` that takes the actor from a test header. */
export function testAuth() {
  const requireAuth: MiddlewareHandler = async (c, next) => {
    const u = actorOf(c.req.header(HEADER), c.req.header(AGENT_HEADER));
    if (!u) return c.json({ error: "Unauthorized - Authentication required" }, 401);
    c.set("user" as never, u as never);
    await next();
  };
  const optionalAuth: MiddlewareHandler = async (c, next) => {
    const u = actorOf(c.req.header(HEADER), c.req.header(AGENT_HEADER));
    if (u) c.set("user" as never, u as never);
    await next();
  };
  return { requireAuth, optionalAuth, getSession: async () => null };
}

type Requestable = { request: (u: string, i?: RequestInit) => Response | Promise<Response> };

/** `request("a", "GET", "/route")` — request as an actor. */
export function requestAs(app: Requestable) {
  return (
    actor: Actor | { agent: string[] },
    method: string,
    route: string,
    bodyValue?: unknown,
    extra: Record<string, string> = {}
  ) => {
    const headers: Record<string, string> = { ...extra };
    if (typeof actor === "object") headers[AGENT_HEADER] = actor.agent.join(",");
    else if (actor !== "anon") headers[HEADER] = actor;
    let body: BodyInit | undefined;
    if (bodyValue instanceof FormData) body = bodyValue;
    else if (bodyValue !== undefined) {
      headers["content-type"] = "application/json";
      body = typeof bodyValue === "string" ? bodyValue : JSON.stringify(bodyValue);
    }
    return app.request(route, { method: method, headers, body });
  };
}

export const APP_ROLE = "kon_safe_app";

/**
 * The CORE's agent functions (`kitsuden_effective_admin`, …). The
 * host applies them before any kon migration (scripts/migrate.ts
 * and lib/kon-migrations.ts), so here too.
 */
export const AGENT_FUNCTIONS = resolve(
  __dirname,
  "../../../.kitsuden/apps/api/src/db/agent-functions.sql"
);

/** PGlite with the kon's migrations applied as superuser. */
export async function migratedBase(kon: string, migrations: string[]): Promise<PGlite> {
  const client = new PGlite();
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

/** Drops the session to the app role and returns the drizzle that the routes will use. */
export async function dropToAppRole(client: PGlite) {
  await client.exec(`SET ROLE ${APP_ROLE}`);
  const r = await client.query<{ su: boolean }>(
    `SELECT rolsuper OR rolbypassrls AS su FROM pg_roles WHERE rolname = current_user`
  );
  if (r.rows[0]?.su !== false) throw new Error("the test role skips RLS");
  return drizzle(client);
}

/** Raw SQL with an actor's RLS context, in a transaction. */
export async function sqlAs<T = Record<string, unknown>>(
  client: PGlite,
  actor: Actor,
  query: string,
  params: unknown[] = []
): Promise<T[]> {
  const u = actor === "anon" ? null : ACTORS[actor];
  return client.transaction(async (tx) => {
    await tx.query(
      `select set_config('app.current_user_id', $1, true), set_config('app.current_user_role', $2, true)`,
      [u?.id ?? "anonymous-without-account", u?.role ?? "anon"]
    );
    const r = await tx.query<T>(query, params);
    return r.rows;
  });
}

/** The error body cannot carry engine details. */
export function withoutInternalDetails(text: string): boolean {
  return !/violates|constraint|relation "|column "|syntax error|invalid input syntax|stack|at \w+ \(|pg_|duplicate key/i.test(
    text
  );
}

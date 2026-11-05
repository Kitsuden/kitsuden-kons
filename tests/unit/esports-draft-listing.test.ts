/**
 * Tournament listing: drafts
 * ============================================================================
 *
 * The esports policy already said who can see a `Draft` (`esports-authz`).
 * This checks the other thing, which is where the failure was: that the listing route
 * CALLS that rule with the real session.
 *
 * What was happening: `GET /tournaments` read `c.get("user")` but did not mount
 * `optionalAuth`, so the user was ALWAYS null. The consequence was not
 * a leak —it failed closed— but the opposite: the organization did not see its
 * own drafts in the panel, and `?status=Draft` was ignored even for
 * an admin.
 *
 * A correct policy to which nobody passes the session always decides the same.
 */

import { resetAuthz } from "@kitsuden/engine";
import type { MiddlewareHandler } from "hono";
import { beforeEach, describe, expect, test } from "vitest";

import { registerEsportsPolicy } from "../../kons/kon-esports/esports.policy";
import { createEsportsRouter } from "../../kons/kon-esports/esports.routes";

/**
 * Spy on the final `where`.
 *
 * The SQL is not inspected: it is enough whether the listing added conditions or not,
 * which is exactly what changes between "sees drafts" and "does not see them".
 */
function stubDb() {
  const wheres: unknown[] = [];
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where: (cond: unknown) => {
      wheres.push(cond);
      return chain;
    },
    orderBy: () => chain,
    limit: () => chain,
    /**
     * Chainable AND awaitable.
     *
     * The listing used to end in `.orderBy()`; since it respects `?limit=`
     * it ends in `.limit()`. With an `orderBy` that returned a promise, the
     * route called `.limit` on it and answered 500. With `then` being part
     * of the chain, it does not matter where the query ends.
     */
    then: (resolver: (rows: unknown[]) => unknown) => resolver([]),
  };
  return { wheres, instance: chain };
}

/**
 * Flattens a Drizzle condition to text so the OPERATOR can be looked at.
 *
 * It is needed because both branches produce a condition —both "defined"—
 * and what separates them is whether the status is excluded (`<>`) or requested (`=`).
 */
function plainSql(node: any): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(plainSql).join("");
  if (node.queryChunks) return plainSql(node.queryChunks);
  if (Array.isArray(node.value)) return plainSql(node.value);
  if (node.name) return String(node.name);
  if (node.value !== undefined) return String(node.value);
  return "";
}

/** A fake `optionalAuth`: puts in whatever session it is told, or none. */
const authWith = (user: { id: string; role: string } | null) => {
  const optionalAuth: MiddlewareHandler = async (c, next) => {
    if (user) c.set("user" as never, user as never);
    await next();
  };
  const requireAuth: MiddlewareHandler = async (c, next) => {
    if (!user) return c.json({ error: "no" }, 401);
    c.set("user" as never, user as never);
    await next();
  };
  return { optionalAuth, requireAuth } as any;
};

async function list(user: { id: string; role: string } | null, query = "") {
  const db = stubDb();
  const app = createEsportsRouter({ db, auth: authWith(user) } as any);
  const res = await app.request(`/tournaments${query}`);
  expect(res.status).toBe(200);
  return db.wheres;
}

const admin = { id: "u-admin", role: "admin" };
const player = { id: "u-player", role: "user" };

beforeEach(() => {
  resetAuthz();
  registerEsportsPolicy();
});

describe("tournament listing and drafts", () => {
  test("without a session, the listing FILTERS (drafts are hidden)", async () => {
    const [cond] = await list(null);
    expect(cond).toBeDefined();
  });

  test("a player with an account does not see them either", async () => {
    // With public registration, "has an account" does not mean "is staff".
    const [cond] = await list(player);
    expect(cond).toBeDefined();
  });

  test("THE ORGANIZATION DOES: with no filters requested, the listing filters nothing", async () => {
    // This is the one that failed: the session did not arrive and the admin was treated
    // as an anonymous user, with the draft exclusion applied anyway.
    const [cond] = await list(admin);
    expect(cond).toBeUndefined();
  });

  test("`?status=Draft` is ignored for whoever is not in charge, and honored for staff", async () => {
    // For the anonymous user the correct answer is not a 403 —that would confirm
    // there are drafts— but the public list: the filter is turned around.
    const [anon] = await list(null, "?status=Draft");
    expect(plainSql(anon)).toContain("<>");

    // Staff are honored as is: equality, not exclusion.
    const [staff] = await list(admin, "?status=Draft");
    expect(plainSql(staff)).not.toContain("<>");
    expect(plainSql(staff)).toContain("=");
  });
});

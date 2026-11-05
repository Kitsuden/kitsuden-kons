/**
 * kon-academy-lms: agents in row security, and a user sync that writes
 * ============================================================================
 *
 * Two bugs from the docs review (2026-11-08):
 *
 *   · Row security did not know agent scopes. The personal tables admitted the row owner, the
 *     human `admin` role, academy administrators and supervisors; an agent that passed a manager
 *     route with `academy:manage` (or `admin`) read only its own rows, so reports came back empty,
 *     and it could not assign (the route asked for supervised groups an agent does not have).
 *     Migration 0009 and `agentManagesAcademy` fix it with the core's rule.
 *   · `POST /sync/users` answered "Synced N users" and wrote nothing.
 *
 * Real routes against PGlite with the kon's whole migration chain, the core's owner policies
 * (rls-owned-tables.sql, which the host applies after the migrations) and a NON-superuser role;
 * the RLS host sets `app.agent_scopes` like the core.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createAcademyLMSRoutes } from "../../kons/kon-academy-lms/academy-lms.routes";
import { registerAcademyPolicy } from "../../kons/kon-academy-lms/academy.policy";

import { ACTORS, APP_ROLE, dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

const KON = "kon-academy-lms";
const OWNED_TABLES = resolve(__dirname, "../../.kitsuden/apps/api/src/db/rls-owned-tables.sql");

const chain = readdirSync(resolve(__dirname, `../../kons/${KON}/migrations`))
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

const agent = (...scopes: string[]) => ({ agent: scopes });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies
const json = async (r: Response): Promise<any> => r.json();

const A = ACTORS.a.id;
const B = ACTORS.b.id;
/** Accounts the host knows; `usersById` answers only for these. */
const ACCOUNTS = new Set<string>([A, B, ACTORS.member.id]);

let client: PGlite;
let request: ReturnType<typeof requestAs>;

beforeAll(async () => {
  client = await migratedBase(KON, chain);
  // The host applies the core's owner policies AFTER the kons' migrations: that is what turns
  // RLS on (and FORCE) for the personal tables.
  await client.exec(readFileSync(OWNED_TABLES, "utf8"));
  const db = await dropToAppRole(client);
  registerAcademyPolicy();
  const auth = {
    ...testAuth(),
    usersById: async (ids: string[]) =>
      new Map(
        ids.filter((id) => ACCOUNTS.has(id)).map((id) => [id, { id, name: id, image: null }])
      ),
  };
  const host = rlsHost(db, auth);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test context
  const ctx = createTestKonContext({ db: host.db as any, auth: auth as any });
  request = requestAs(host.mount(createAcademyLMSRoutes(ctx)));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  // As the migration runner would (superuser, no RLS context), then back to the app role.
  await client.exec(`
    RESET ROLE;
    TRUNCATE training_user_profiles, courses, assignment_groups, group_users, course_modules,
      topics, quizzes, course_progress, topic_progress, assignments, feedback, certificates,
      satisfaction_surveys, academy_activity_log CASCADE;
    INSERT INTO courses (id, title, description) VALUES ('c1', 'Safety', 'Course 1');
    INSERT INTO assignments (id, course_id, user_id) VALUES ('a1', 'c1', '${A}'), ('a2', 'c1', '${B}');
    INSERT INTO course_progress (id, user_id, course_id) VALUES ('cp1', '${A}', 'c1'), ('cp2', '${B}', 'c1');
    INSERT INTO training_user_profiles (id, user_id, training_role) VALUES ('pf1', '${A}', 'student');
    SET ROLE ${APP_ROLE};
  `);
});

/** Rows of `table` an agent with these scopes sees, as a request would. */
async function agentCount(table: string, scopes: string): Promise<number> {
  return client.transaction(async (tx) => {
    await tx.query(
      "select set_config('app.current_user_id', 'some-agent', true), set_config('app.current_user_role', 'agent', true), set_config('app.agent_scopes', $1, true)",
      [scopes]
    );
    const r = await tx.query<{ n: number }>(`select count(*)::int as n from ${table}`);
    return r.rows[0]!.n;
  });
}

/** Whether an agent with these scopes may insert a profile. */
async function agentInsertsProfile(scopes: string): Promise<boolean> {
  try {
    await client.transaction(async (tx) => {
      await tx.query(
        "select set_config('app.current_user_id', 'some-agent', true), set_config('app.current_user_role', 'agent', true), set_config('app.agent_scopes', $1, true)",
        [scopes]
      );
      await tx.query(
        `insert into training_user_profiles (id, user_id, training_role) values ('pf-x', '${B}', 'student')`
      );
      throw new Error("rollback");
    });
  } catch (e) {
    return (e as Error).message === "rollback";
  }
  return false;
}

describe("row security: agents by their scopes (migration 0009)", () => {
  it.each([
    ["academy:manage", 2],
    ["academy:administer", 2],
    ["academy:*", 2],
    ["academy-lms:*", 2],
    ["kon:academy-lms:*", 2],
    ["admin", 2],
    ["mcp:connect", 0],
    ["user:act", 0],
    ["kon:academy-lms:list-assignments", 0],
    ["academy:manage,!academy:*", 0],
    ["admin,!academy-lms:*", 0],
  ])("course_progress with %s: %i rows", async (scopes, n) => {
    expect(await agentCount("course_progress", scopes)).toBe(n);
  });

  it("a managing agent reads the profiles; only an administering one writes them", async () => {
    expect(await agentCount("training_user_profiles", "academy:manage")).toBe(1);
    expect(await agentCount("training_user_profiles", "mcp:connect")).toBe(0);
    expect(await agentInsertsProfile("academy:manage")).toBe(false);
    expect(await agentInsertsProfile("academy:administer")).toBe(true);
    expect(await agentInsertsProfile("academy:administer,!academy:*")).toBe(false);
  });
});

describe("routes: an agent with academy:manage manages every learner", () => {
  it("lists the assignments of every learner", async () => {
    const r = await request(agent("academy:manage"), "GET", "/assignments");
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body.assignments.map((a: { id: string }) => a.id).sort()).toEqual(["a1", "a2"]);
  });

  it("assigns a course to a learner (no supervised groups needed)", async () => {
    const r = await request(agent("academy:manage"), "POST", "/assignments", {
      courseId: "c1",
      userId: ACTORS.member.id,
    });
    expect(r.status).toBe(201);
  });

  it("without the scope, or with the denial, it does not get in", async () => {
    expect((await request(agent("mcp:connect"), "GET", "/assignments")).status).toBe(403);
    expect((await request(agent("academy:manage", "!academy:*"), "GET", "/assignments")).status).toBe(
      403
    );
  });
});

describe("user sync writes academy profiles", () => {
  const users = [
    { externalId: "E1", userId: A, email: "a@example.com", name: "Ana", role: "supervisor" },
    { externalId: "E2", userId: B, email: "b@example.com", name: "Beto" },
    { externalId: "E3", userId: "no-such-account", email: "c@example.com", name: "Nobody" },
  ];

  async function profiles(): Promise<Record<string, { role: string; active: boolean }>> {
    const r = await client.query<{ user_id: string; training_role: string; active: boolean }>(
      "select user_id, training_role::text, active from training_user_profiles"
    );
    return Object.fromEntries(
      r.rows.map((p) => [p.user_id, { role: p.training_role, active: p.active }])
    );
  }

  it("creates and updates profiles of existing accounts, never of unknown ones", async () => {
    const r = await request("admin", "POST", "/sync/users", { users });
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body.result).toMatchObject({ successful: 2, failed: 1, created: 1, updated: 1 });
    expect(body.result.errors[0].error).toContain("no-such-account");

    const after = await profiles();
    expect(after[A]).toEqual({ role: "supervisor", active: true });
    expect(after[B]).toEqual({ role: "student", active: true });
    expect(after["no-such-account"]).toBeUndefined();
  });

  it("honours updateExisting: false and a role mapping", async () => {
    const r = await request("admin", "POST", "/sync/users", {
      users: [
        { externalId: "E1", userId: A, email: "a@example.com", name: "Ana", role: "Boss" },
        { externalId: "E2", userId: B, email: "b@example.com", name: "Beto", role: "Boss" },
      ],
      config: {
        updateExisting: false,
        roleMapping: { externalField: "role", values: { Boss: "administrator" }, default: "student" },
      },
    });
    expect(r.status).toBe(200);
    expect((await json(r)).result).toMatchObject({ created: 1, updated: 0 });
    const after = await profiles();
    expect(after[A]?.role).toBe("student"); // existing profile left alone
    expect(after[B]?.role).toBe("administrator");
  });

  it("the CSV route writes too", async () => {
    const csv = `externalId,userId,email,name,role\nE2,${B},b@example.com,Beto,supervisor`;
    const r = await request("admin", "POST", "/sync/users/csv", csv, { "content-type": "text/csv" });
    expect(r.status).toBe(200);
    expect((await json(r)).result).toMatchObject({ created: 1 });
    expect((await profiles())[B]?.role).toBe("supervisor");
  });

  it("an invalid row writes nothing (400)", async () => {
    const r = await request("admin", "POST", "/sync/users", {
      users: [users[1], { externalId: "E9", email: "not-an-email", name: "X" }],
    });
    expect(r.status).toBe(400);
    expect((await profiles())[B]).toBeUndefined();
  });

  it("an agent with academy:administer syncs through row security; academy:manage may not", async () => {
    const ok = await request(agent("academy:administer"), "POST", "/sync/users", {
      users: [users[1]],
    });
    expect(ok.status).toBe(200);
    expect((await json(ok)).result).toMatchObject({ created: 1, failed: 0 });
    expect((await profiles())[B]?.role).toBe("student");

    const denied = await request(agent("academy:manage"), "POST", "/sync/users", { users });
    expect(denied.status).toBe(403);
  });

  it("a student cannot sync", async () => {
    const r = await request("a", "POST", "/sync/users", { users });
    expect(r.status).toBe(403);
  });
});

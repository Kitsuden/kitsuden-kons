/**
 * kon-academy-lms: pages of list-my-courses, list-assignments and list-profiles
 * ============================================================================
 *
 * These lists returned every row (api-contract, 2026-11-18). They take `limit`
 * and `offset` now and answer `hasMore` next to the items; `total` still counts
 * every row that matches, and with no `limit` the response is what it always was.
 * `list-surveys` is paged the same way as `list-assignments` and `list-profiles`.
 *
 * Same harness as kon-academy-lms-agents-and-sync.test.ts: real routes on
 * PGlite with the whole migration chain, the core's owner policies and a
 * non-superuser role.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createAcademyLMSRoutes } from "../../kons/kon-academy-lms/academy-lms.routes";
import { registerAcademyPolicy } from "../../kons/kon-academy-lms/academy.policy";

import { ACTORS, dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

const KON = "kon-academy-lms";
const OWNED_TABLES = resolve(__dirname, "../../.kitsuden/apps/api/src/db/rls-owned-tables.sql");

const chain = readdirSync(resolve(__dirname, `../../kons/${KON}/migrations`))
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies
const json = async (r: Response): Promise<any> => r.json();

const A = ACTORS.a.id;
const B = ACTORS.b.id;

let client: PGlite;
let request: ReturnType<typeof requestAs>;

beforeAll(async () => {
  client = await migratedBase(KON, chain);
  await client.exec(readFileSync(OWNED_TABLES, "utf8"));
  await client.exec(`
    INSERT INTO courses (id, title, description, created_at) VALUES
      ('c1', 'Safety', 'Course 1', '2026-01-01'), ('c2', 'First aid', 'Course 2', '2026-02-01');
    INSERT INTO assignments (id, course_id, user_id) VALUES
      ('a1', 'c1', '${A}'), ('a2', 'c1', '${B}'), ('a3', 'c2', '${A}');
    INSERT INTO course_progress (id, user_id, course_id) VALUES
      ('cp1', '${A}', 'c1'), ('cp2', '${B}', 'c1'), ('cp3', '${A}', 'c2');
    INSERT INTO training_user_profiles (id, user_id, training_role) VALUES
      ('pf1', '${A}', 'student'), ('pf2', '${B}', 'student');
  `);
  const db = await dropToAppRole(client);
  registerAcademyPolicy();
  const auth = testAuth();
  const host = rlsHost(db, auth);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test context
  const ctx = createTestKonContext({ db: host.db as any, auth: auth as any });
  request = requestAs(host.mount(createAcademyLMSRoutes(ctx)));
});

afterAll(async () => {
  await client?.close();
});

describe.each([
  ["list-assignments", "/assignments", "assignments", 3],
  ["list-profiles", "/profiles", "profiles", 2],
])("%s pages", (_id, path, key, count) => {
  it("limit=1 returns one row and hasMore: true; total counts them all", async () => {
    const first = await json(await request("admin", "GET", `${path}?limit=1`));
    expect(first[key]).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.total).toBe(count);
    const last = await json(await request("admin", "GET", `${path}?limit=1&offset=${count - 1}`));
    expect(last[key]).toHaveLength(1);
    expect(last[key][0].id).not.toBe(first[key][0].id);
    expect(last.hasMore).toBe(false);
  });

  it("without limit it returns every row, hasMore: false", async () => {
    const all = await json(await request("admin", "GET", path));
    expect(all[key]).toHaveLength(count);
    expect(all.total).toBe(count);
    expect(all.hasMore).toBe(false);
  });
});

describe("list-my-courses pages", () => {
  it("limit=1 returns the oldest course and hasMore: true; offset=1 the other", async () => {
    const first = await json(await request("a", "GET", "/courses?limit=1"));
    expect(first.courses.map((c: { id: string }) => c.id)).toEqual(["c1"]);
    expect(first.total).toBe(2);
    expect(first.hasMore).toBe(true);
    const second = await json(await request("a", "GET", "/courses?limit=1&offset=1"));
    expect(second.courses.map((c: { id: string }) => c.id)).toEqual(["c2"]);
    expect(second.hasMore).toBe(false);
  });

  it("with a status filter the page is cut after filtering", async () => {
    const page = await json(await request("a", "GET", "/courses?status=not-started&limit=1"));
    expect(page.courses).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(true);
  });

  it("without limit it returns every assigned course, hasMore: false", async () => {
    const all = await json(await request("a", "GET", "/courses"));
    expect(all.courses).toHaveLength(2);
    expect(all.total).toBe(2);
    expect(all.hasMore).toBe(false);
  });
});

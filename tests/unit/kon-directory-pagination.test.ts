/**
 * kon-directory — the lists that stopped at a server cap now page
 * ============================================================================
 *
 * `list-organizations` (500), `list-departments` and `list-positions` (1000) used to stop
 * at a cap with no sign. They take `limit` and `offset` and answer `hasMore`; a client
 * that sends neither gets what it got before (the cap is the default).
 *
 * `list-employees` took `limit` (1-100) and nothing else, so nobody could read employee 101.
 * It keeps that `limit` and its default (50) and takes `offset`, with `hasMore`; namesakes
 * are ordered by id, so a page never repeats or skips one.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { registerDirectoryPolicy } from "../../kons/kon-directory/directory.policy";
import { createDirectoryRouter } from "../../kons/kon-directory/directory.routes";

import { testAuth, databaseWithRls, asAppRole, requestAs } from "./helpers/kon-with-users";

let client: PGlite;
let request: ReturnType<typeof requestAs>;

const ORG_X = "00000000-0000-4000-8000-0000000000a1";
const ORG_Y = "00000000-0000-4000-8000-0000000000b2";
const ANA_1 = "00000000-0000-4000-8000-0000000000c1";
const ANA_2 = "00000000-0000-4000-8000-0000000000c2";
const BETO = "00000000-0000-4000-8000-0000000000c3";

async function json(res: Response): Promise<any> {
  return res.json();
}

beforeAll(async () => {
  client = await databaseWithRls("kon-directory", [
    "0000_base_schema.sql",
    "0001_rename_tables.sql",
    "0002_entry_security.sql",
    "0003_system_without_user.sql",
    "0004_effective_admin.sql",
  ]);
  await client.exec(`
    INSERT INTO directory_organizations (id, name, slug) VALUES
      ('${ORG_X}', 'Equis', 'equis'), ('${ORG_Y}', 'Ye', 'ye');
    INSERT INTO directory_departments (organization_id, name, slug) VALUES
      ('${ORG_X}', 'Alpha', 'alpha'), ('${ORG_X}', 'Beta', 'beta'), ('${ORG_X}', 'Gamma', 'gamma');
    INSERT INTO directory_positions (organization_id, title, slug) VALUES
      ('${ORG_X}', 'Analyst', 'analyst'), ('${ORG_X}', 'Boss', 'boss');
    -- Two namesakes and one more in Equis; 101 people in Ye.
    INSERT INTO directory_employees
      (id, organization_id, employee_id, first_name, last_name, email, start_date, visible_in_directory)
    VALUES
      ('${ANA_2}', '${ORG_X}', 'X-2', 'Ana', 'Alba', 'ana2@x.test', '2020-01-01', true),
      ('${BETO}', '${ORG_X}', 'X-3', 'Beto', 'Bravo', 'beto@x.test', '2020-01-01', true),
      ('${ANA_1}', '${ORG_X}', 'X-1', 'Ana', 'Alba', 'ana1@x.test', '2020-01-01', true);
    INSERT INTO directory_employees
      (organization_id, employee_id, first_name, last_name, email, start_date, visible_in_directory)
    SELECT '${ORG_Y}', 'Y-' || i, 'Person', 'P' || lpad(i::text, 3, '0'), 'p' || i || '@y.test', '2020-01-01', true
    FROM generate_series(1, 101) AS i;
  `);
  const db = await asAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never });
  request = requestAs(host.mount(createDirectoryRouter(ctx)));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerDirectoryPolicy();
});

describe("lists page with limit and offset", () => {
  it("organizations: limit=1 gives one and says there are more", async () => {
    const res = await request("anon", "GET", "/organizations?limit=1");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0].name).toBe("Equis");
    expect(body.hasMore).toBe(true);

    const next = await json(await request("anon", "GET", "/organizations?limit=1&offset=1"));
    expect(next.docs.map((o: any) => o.name)).toEqual(["Ye"]);
    expect(next.hasMore).toBe(false);
  });

  it("organizations: without limit, everything as before, and hasMore false", async () => {
    const body = await json(await request("anon", "GET", "/organizations"));
    expect(body.docs.map((o: any) => o.name)).toEqual(["Equis", "Ye"]);
    expect(body.hasMore).toBe(false);
  });

  it("departments and positions page the same way", async () => {
    const page = await json(await request("anon", "GET", "/departments?limit=2"));
    expect(page.docs.map((d: any) => d.name)).toEqual(["Alpha", "Beta"]);
    expect(page.hasMore).toBe(true);
    const all = await json(await request("anon", "GET", "/departments"));
    expect(all.docs).toHaveLength(3);
    expect(all.hasMore).toBe(false);

    const positions = await json(await request("anon", "GET", "/positions?limit=1"));
    expect(positions.docs).toHaveLength(1);
    expect(positions.hasMore).toBe(true);
    const everyPosition = await json(await request("anon", "GET", "/positions"));
    expect(everyPosition.docs).toHaveLength(2);
    expect(everyPosition.hasMore).toBe(false);
  });

  it("a limit out of range is refused, not clamped", async () => {
    expect((await request("anon", "GET", "/organizations?limit=0")).status).toBeGreaterThanOrEqual(400);
    expect((await request("anon", "GET", "/departments?limit=1001")).status).toBeGreaterThanOrEqual(400);
  });
});

describe("employees page with limit and offset", () => {
  const equis = `/employees?organizationId=${ORG_X}`;

  it("without offset, the same page as before, now with hasMore", async () => {
    const body = await json(await request("anon", "GET", equis));
    expect(body.docs.map((e: any) => e.id)).toEqual([ANA_1, ANA_2, BETO]);
    expect(body.totalDocs).toBe(3);
    expect(body.hasMore).toBe(false);
  });

  it("limit=1 says there are more, and offset=1 gives the second row (the namesake, by id)", async () => {
    const first = await json(await request("anon", "GET", `${equis}&limit=1`));
    expect(first.docs.map((e: any) => e.id)).toEqual([ANA_1]);
    expect(first.hasMore).toBe(true);

    const second = await json(await request("anon", "GET", `${equis}&limit=1&offset=1`));
    expect(second.docs.map((e: any) => e.id)).toEqual([ANA_2]);
    expect(second.totalDocs).toBe(1);
    expect(second.hasMore).toBe(true);

    const last = await json(await request("anon", "GET", `${equis}&limit=2&offset=2`));
    expect(last.docs.map((e: any) => e.id)).toEqual([BETO]);
    expect(last.hasMore).toBe(false);
  });

  it("employee 101 is reachable", async () => {
    const ye = `/employees?organizationId=${ORG_Y}`;
    const defaultPage = await json(await request("anon", "GET", ye));
    expect(defaultPage.docs).toHaveLength(50);
    expect(defaultPage.hasMore).toBe(true);

    const full = await json(await request("anon", "GET", `${ye}&limit=100`));
    expect(full.docs).toHaveLength(100);
    expect(full.hasMore).toBe(true);

    const rest = await json(await request("anon", "GET", `${ye}&limit=100&offset=100`));
    expect(rest.docs.map((e: any) => e.lastName)).toEqual(["P101"]);
    expect(rest.hasMore).toBe(false);
  });

  it("a negative offset is refused", async () => {
    const res = await request("anon", "GET", `${equis}&offset=-1`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

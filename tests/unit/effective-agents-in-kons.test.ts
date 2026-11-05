/**
 * An agent the app recognizes, the DATABASE does too (common core rule)
 * ============================================================================
 *
 * Phase D (e2e tests over HTTP, 2026-10-25): agents arrive with role
 * `agent`, and the kons' policies and RLS only knew the human role.
 * An agent with `admin` saw EMPTY lists in dms, members and booking and got
 * 403 in newsletter; with `directory:*` it could not create a record.
 *
 * The fix is ONE, in the core: `isEffectiveAdmin` / `isEffectiveStaff`
 * (packages/engine/src/effective-actor.ts) and the SQL functions
 * `kitsuden_effective_admin` / `kitsuden_effective_staff` / `kitsuden_agent_can`
 * (apps/api/src/db/agent-functions.sql, which the host applies before
 * the kons' migrations). Each kon uses it in its policy and in a new
 * migration. Without that change, these tests fail.
 *
 * REAL routes against PGlite with forced RLS and a non-superuser role; the
 * test host sets `app.agent_scopes` like the core.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createBookingRouter } from "../../kons/kon-booking/booking.routes";
import { registerBookingPolicy } from "../../kons/kon-booking/booking.policy";
import { createDirectoryRouter } from "../../kons/kon-directory/directory.routes";
import { registerDirectoryPolicy } from "../../kons/kon-directory/directory.policy";
import { createKonDMS } from "../../kons/kon-dms/index";
import { createKonMembers, registerMembersPolicy } from "../../kons/kon-members/index";
import { createNewsletterRouter } from "../../kons/kon-newsletter/newsletter.routes";

import { ACTORS, testAuth, dropToAppRole, migratedBase, requestAs } from "./helpers/safe-kons-bench";

const json = async (r: Response): Promise<any> => r.json();
const agent = (...scopes: string[]) => ({ agent: scopes });

/** The kon's whole chain, in order (the one the host would apply). */
function string(kon: string): string[] {
  return readdirSync(resolve(__dirname, `../../kons/${kon}/migrations`))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
}

async function mount(kon: string, router: (ctx: any) => any, seed?: string) {
  const client = await migratedBase(kon, string(kon));
  if (seed) await client.exec(seed);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as any, auth: auth as any });
  return { client, request: requestAs(host.mount(router(ctx))) };
}

describe("booking: a kon admin agent sees and manages all bookings", () => {
  let client: PGlite;
  let request: ReturnType<typeof requestAs>;
  let bookingOfA: string;

  beforeAll(async () => {
    registerBookingPolicy();
    ({ client, request } = await mount("kon-booking", createBookingRouter));
    const room = await request("admin", "POST", "/rooms", { name: "Room", capacity: 4, hourlyRate: "10.00" });
    expect(room.status).toBe(201);
    const start = new Date(Date.now() + 3 * 86_400_000);
    start.setUTCHours(10, 0, 0, 0);
    const r = await request("a", "POST", "/bookings", {
      roomId: (await json(room)).id,
      title: "Reunión de A",
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + 3_600_000).toISOString(),
    });
    expect(r.status).toBe(201);
    bookingOfA = (await json(r)).id;
  });
  afterAll(async () => client?.close());

  test.each([["admin"], ["booking:*"], ["kon:booking:*"]])(
    "agent %s: the list brings A's booking (before: empty) and so does the record",
    async (scope) => {
      const ag = agent("mcp:connect", scope);
      const ids = (await json(await request(ag, "GET", "/bookings"))).docs.map((d: any) => d.id);
      expect(ids).toContain(bookingOfA);
      expect((await request(ag, "GET", `/bookings/${bookingOfA}`)).status).toBe(200);
    }
  );

  test("permission before body: an account without permission gets 403, not 422", async () => {
    // The authorization matrix found it when booking was opened to any session.
    for (const route of ["/rooms", "/amenities"]) {
      expect((await request("a", "POST", route, {})).status).toBe(403);
      expect((await request(agent("mcp:connect"), "POST", route, {})).status).toBe(403);
      // The editor is personal (a product decision, 2026-10-26): it passes the
      // permission and it is the validation that answers.
      expect((await request("staff", "POST", route, {})).status).toBe(422);
    }
    expect((await request("admin", "POST", "/rooms", {})).status).toBe(422);
  });

  test("an agent without the kon's scope would only see its own: none", async () => {
    const ids = (await json(await request(agent("mcp:connect"), "GET", "/bookings"))).docs;
    expect(ids).toEqual([]);
  });

  test("a denial wins: `admin` + `!booking:*` is not personal", async () => {
    // Since booking became an SDK kon (2026-10-26), the operation itself
    // applies the key's denial: 403 before reaching the list (before,
    // the kon answered 200 with no bookings and the 403 was only set by the
    // host's gate, `agentDenials`). No bookings, either way.
    const res = await request(agent("admin", "!booking:*"), "GET", "/bookings");
    expect(res.status).toBe(403);
    expect((await json(res)).docs).toBeUndefined();
  });
});

describe("directory: a `directory:*` agent is HR", () => {
  let client: PGlite;
  let request: ReturnType<typeof requestAs>;

  beforeAll(async () => {
    registerDirectoryPolicy();
    ({ client, request } = await mount("kon-directory", createDirectoryRouter));
  });
  afterAll(async () => client?.close());

  test("creates organization and record, and changes the position (before: 403 / the database denied it)", async () => {
    const ag = agent("mcp:connect", "directory:*");
    const org = await request(ag, "POST", "/organizations", { name: "Equis" });
    expect(org.status).toBe(201);
    const organizationId = (await json(org)).id;
    const emp = await request(ag, "POST", "/employees", {
      organizationId,
      employeeId: "E-1",
      firstName: "Nora",
      lastName: "Nieto",
      email: "nora@x.test",
      userId: ACTORS.a.id,
    });
    expect(emp.status).toBe(201);
    const id = (await json(emp)).id;
    const change = await request(ag, "PATCH", `/employees/${id}`, { status: "remote" });
    expect(change.status).toBe(200);
    expect((await json(change)).status).toBe("remote");

    // The employee themselves: the personal yes, the HR no.
    expect((await request("a", "PATCH", `/employees/${id}`, { bio: "Hola" })).status).toBe(200);
    expect((await request("a", "PATCH", `/employees/${id}`, { status: "terminated" })).status).toBe(403);
    // Permission before body (403, not 422) on HR creations.
    for (const route of ["/organizations", "/departments", "/positions", "/employees", `/employees/${id}/documents`]) {
      expect((await request("a", "POST", route, {})).status, route).toBe(403);
    }
    // An agent without the whole kon is not HR.
    expect((await request(agent("mcp:connect"), "POST", "/organizations", { name: "No" })).status).toBe(403);
  });
});

describe("dms: an admin agent sees what is not theirs", () => {
  let client: PGlite;
  let request: ReturnType<typeof requestAs>;
  let privateOne: string;

  beforeAll(async () => {
    ({ client, request } = await mount("kon-dms", createKonDMS));
    const r = await request("staff", "POST", "/documents", { title: "Privado del editor", visibility: "private" });
    expect(r.status).toBe(201);
    privateOne = (await json(r)).id;
  });
  afterAll(async () => client?.close());

  test.each([["admin"], ["dms:*"]])("agent %s: lists it and opens it (before: only its own)", async (scope) => {
    const ag = agent("mcp:connect", scope);
    const list = JSON.stringify(await json(await request(ag, "GET", "/documents")));
    expect(list).toContain(privateOne);
    expect((await request(ag, "GET", `/documents/${privateOne}`)).status).toBe(200);
  });

  // 403 and not 404 since the DMS is SDK-based (2026-10-26): `dms_document:view`
  // is not a scope of the kon's family (`dms:…`/`kon:dms:…`), so the
  // agent does not get in as an account — which on the host its
  // `requireAuth` (agent-as-user.ts) already did and here `actAsUser` repeats.
  // The earlier 404 came from the tests' `requireAuth`, which does not apply that rule.
  test("with loose scopes no: it does not even get in (403)", async () => {
    expect((await request(agent("dms_document:view"), "GET", `/documents/${privateOne}`)).status).toBe(403);
  });
});

describe("members: an admin agent's backoffice does not come out empty", () => {
  let client: PGlite;
  let request: ReturnType<typeof requestAs>;

  beforeAll(async () => {
    registerMembersPolicy();
    ({ client, request } = await mount(
      "kon-members",
      createKonMembers,
      "INSERT INTO members (id, email) VALUES ('m-1', 'lectora@example.com')"
    ));
  });
  afterAll(async () => client?.close());

  test.each([["admin"], ["members:*"], ["member:view"]])("agent %s lists the members", async (scope) => {
    const r = await request(agent("mcp:connect", scope), "GET", "/admin/members");
    expect(r.status).toBe(200);
    expect(JSON.stringify(await json(r))).toContain("lectora@example.com");
  });

  test("without scope: 403; and the database does not show it to a user either", async () => {
    expect((await request(agent("mcp:connect"), "GET", "/admin/members")).status).toBe(403);
    expect((await request("a", "GET", "/admin/members")).status).toBe(403);
  });
});

describe("newsletter: an admin agent administers (before: 403)", () => {
  let client: PGlite;
  let request: ReturnType<typeof requestAs>;

  beforeAll(async () => {
    ({ client, request } = await mount(
      "kon-newsletter",
      (ctx) => createNewsletterRouter(ctx, { name: "nullable" } as any, new Map()),
      "INSERT INTO nl_members (email, status, unsub_token) VALUES ('sub@example.com', 'subscribed', 'tok-1')"
    ));
  });
  afterAll(async () => client?.close());

  test.each([["admin"], ["newsletter:*"]])("agent %s reads the subscribers", async (scope) => {
    const r = await request(agent("mcp:connect", scope), "GET", "/members");
    expect(r.status).toBe(200);
    expect(JSON.stringify(await json(r))).toContain("sub@example.com");
  });

  test("without scope, or with the denial, 403", async () => {
    expect((await request(agent("mcp:connect"), "GET", "/members")).status).toBe(403);
    expect((await request(agent("admin", "!newsletter:*"), "GET", "/members")).status).toBe(403);
    expect((await request("staff", "GET", "/members")).status).toBe(403);
  });
});

describe("the database alone: kitsuden_effective_admin in the kons' policies", () => {
  test("members: agent role with `admin` sees the row; with `!members:*` it does not", async () => {
    const client = await migratedBase("kon-members", string("kon-members"));
    await client.exec("INSERT INTO members (id, email) VALUES ('m-1', 'x@example.com')");
    await dropToAppRole(client);
    const count = (scopes: string) =>
      client.transaction(async (tx) => {
        await tx.query(
          "select set_config('app.current_user_id', 'ag-1', true), set_config('app.current_user_role', 'agent', true), set_config('app.agent_scopes', $1, true)",
          [scopes]
        );
        return ((await tx.query("select count(*)::int as n from members")).rows[0] as { n: number }).n;
      });
    expect(await count("admin")).toBe(1);
    expect(await count("admin,!members:*")).toBe(0);
    expect(await count("mcp:connect")).toBe(0);
    await client.close();
  });
});

/**
 * kon-agile — a project exists only for its members
 * ============================================================================
 *
 * REAL routes against PGlite with forced RLS and a non-superuser role. Before:
 * GETs did not even ask for a session, any account wrote to any project,
 * `createdBy`/`decidedBy` came from the body and status/cycle ids were not
 * checked against the project.
 *
 * Layout: P is created by `staff` (owner); `member` is member, `b` is viewer.
 * Q is created by `admin`. `a` is in neither.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createKonAgile } from "../../kons/kon-agile/index";

import {
  ACTORS,
  testAuth,
  dropToAppRole,
  migratedBase,
  requestAs,
  withoutInternalDetails,
  sqlAs,
} from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
let P: string;
let Q: string;
let cycleOfQ: string;
let issueDeP: string;
let issueDeQ: string;
let intakeDeP: string;

const json = async (r: Response): Promise<any> => r.json();

beforeAll(async () => {
  client = await migratedBase("kon-agile", [
    "0000_base_schema.sql",
    "0001_members_and_rls.sql",
    "0002_system_without_user.sql",
    "0003_english_names.sql",
    "0004_english_rls.sql",
    "0005_planning_squads_and_agents.sql",
  ]);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const app = host.mount(
    createKonAgile(createTestKonContext({ db: host.db as any, auth: auth as any }))
  );
  request = requestAs(app);

  const p = await request("staff", "POST", "/projects", { name: "Plataforma", identifier: "PLAT" });
  expect(p.status).toBe(201);
  P = (await json(p)).id;
  const q = await request("admin", "POST", "/projects", { name: "Quiosco", identifier: "QUIO" });
  expect(q.status).toBe(201);
  Q = (await json(q)).id;

  expect(
    (
      await request("staff", "POST", `/projects/${P}/members`, {
        userId: ACTORS.member.id,
        role: "member",
      })
    ).status
  ).toBe(201);
  expect(
    (
      await request("staff", "POST", `/projects/${P}/members`, {
        userId: ACTORS.b.id,
        role: "viewer",
      })
    ).status
  ).toBe(201);

  cycleOfQ = (
    await json(
      await request("admin", "POST", `/${Q}/cycles`, {
        name: "Sprint Q",
        startDate: "2026-10-01",
        endDate: "2026-10-14",
      })
    )
  ).id;
  issueDeQ = (await json(await request("admin", "POST", `/${Q}/issues`, { name: "Secreto de Q" })))
    .key;
  issueDeP = (await json(await request("member", "POST", `/${P}/issues`, { name: "Tarea de P" })))
    .key;
  intakeDeP = (await json(await request("b", "POST", `/${P}/intakes`, { title: "Propuesta" }))).id;
});

afterAll(async () => {
  await client?.close();
});

describe("anonymous", () => {
  test("not even the GETs (they used to be public)", async () => {
    expect((await request("anon", "GET", "/projects")).status).toBe(401);
    expect((await request("anon", "GET", `/issues/${issueDeP}`)).status).toBe(401);
    expect((await request("anon", "GET", `/${P}/issues`)).status).toBe(401);
  });
});

describe("an account that is not in the project (public sign-up)", () => {
  test("does not see it in the list or by id: 404, not 403", async () => {
    const { docs } = await json(await request("a", "GET", "/projects"));
    expect(docs).toEqual([]);
    expect((await request("a", "GET", `/projects/${P}`)).status).toBe(404);
    expect((await request("a", "GET", `/${P}/issues`)).status).toBe(404);
    expect((await request("a", "GET", `/${P}/intakes`)).status).toBe(404);
    expect((await request("a", "GET", `/projects/${P}/members`)).status).toBe(404);
  });

  test("does not read an issue by its key or its comments", async () => {
    expect((await request("a", "GET", `/issues/${issueDeP}`)).status).toBe(404);
    expect((await request("a", "GET", `/issues/${issueDeP}/comments`)).status).toBe(404);
  });

  test("does not write: issues, comments, intakes, cycles, decisions", async () => {
    expect((await request("a", "POST", `/${P}/issues`, { name: "intrusa" })).status).toBe(404);
    expect((await request("a", "PATCH", `/issues/${issueDeP}`, { name: "pisada" })).status).toBe(404);
    expect(
      (await request("a", "POST", `/issues/${issueDeP}/comments`, { contentHtml: "hola" })).status
    ).toBe(404);
    expect((await request("a", "POST", `/${P}/intakes`, { title: "spam" })).status).toBe(404);
    expect(
      (
        await request("a", "POST", `/${P}/cycles`, {
          name: "x",
          startDate: "2026-01-01",
          endDate: "2026-01-02",
        })
      ).status
    ).toBe(404);
    expect((await request("a", "POST", `/intakes/${intakeDeP}/approve`)).status).toBe(404);
    expect((await request("a", "POST", `/agile_intakes/${intakeDeP}/decline`)).status).toBe(404);
  });

  test("does not create projects either (team only)", async () => {
    expect((await request("a", "POST", "/projects", { name: "Mío", identifier: "MIO" })).status).toBe(
      403
    );
  });

  test("nor adds itself as a member", async () => {
    expect(
      (await request("a", "POST", `/projects/${P}/members`, { userId: ACTORS.a.id, role: "owner" }))
        .status
    ).toBe(404);
  });
});

describe("members", () => {
  test("member creates issues; authorship comes from the session, not the body", async () => {
    const withAuthor = await request("member", "POST", `/${P}/issues`, {
      name: "x",
      createdBy: ACTORS.admin.id,
    });
    expect(withAuthor.status).toBe(422);
    const res = await request("member", "POST", `/${P}/issues`, { name: "Bien" });
    expect(res.status).toBe(201);
    expect((await json(res)).createdBy).toBe(ACTORS.member.id);
  });

  test("member does not manage members (that belongs to the owner)", async () => {
    expect(
      (
        await request("member", "POST", `/projects/${P}/members`, {
          userId: ACTORS.a.id,
          role: "viewer",
        })
      ).status
    ).toBe(403);
  });

  test("viewer reads and proposes intakes, but does not write or decide", async () => {
    expect((await request("b", "GET", `/${P}/issues`)).status).toBe(200);
    expect((await request("b", "POST", `/${P}/issues`, { name: "no" })).status).toBe(403);
    expect(
      (await request("b", "POST", `/issues/${issueDeP}/comments`, { contentHtml: "no" })).status
    ).toBe(403);
    expect((await request("b", "POST", `/intakes/${intakeDeP}/approve`)).status).toBe(403);
  });

  test("deciding an intake is signed by whoever decides, not by the body", async () => {
    const withSignature = await request("member", "POST", `/intakes/${intakeDeP}/decline`, {
      decidedBy: ACTORS.admin.id,
    });
    expect(withSignature.status).toBe(422);
    const res = await request("member", "POST", `/intakes/${intakeDeP}/approve`);
    expect(res.status).toBe(201);
    const [row] = await sqlAs<{ decided_by: string }>(
      client,
      "admin",
      "select decided_by from agile_intakes where id = $1",
      [intakeDeP]
    );
    expect(row.decided_by).toBe(ACTORS.member.id);
    // Already processed: it is not approved twice.
    expect((await request("member", "POST", `/intakes/${intakeDeP}/approve`)).status).toBe(409);
  });

  test("on adding `a`, they see the project; on removing them, they stop seeing it", async () => {
    await request("staff", "POST", `/projects/${P}/members`, {
      userId: ACTORS.a.id,
      role: "viewer",
    });
    expect((await request("a", "GET", `/projects/${P}`)).status).toBe(200);
    expect((await request("staff", "DELETE", `/projects/${P}/members/${ACTORS.a.id}`)).status).toBe(
      200
    );
    expect((await request("a", "GET", `/projects/${P}`)).status).toBe(404);
  });

  test("admin sees all projects", async () => {
    const { docs } = await json(await request("admin", "GET", "/projects"));
    expect(docs.map((d: { id: string }) => d.id).sort()).toEqual([P, Q].sort());
  });
});

describe("no IDOR between projects", () => {
  test("a member of P neither reads nor touches issues of Q", async () => {
    expect((await request("member", "GET", `/issues/${issueDeQ}`)).status).toBe(404);
    expect((await request("member", "PATCH", `/issues/${issueDeQ}`, { name: "x" })).status).toBe(
      404
    );
  });

  test("an issue of P is not hung from the cycle of Q", async () => {
    const res = await request("member", "POST", `/${P}/issues`, { name: "x", cycleId: cycleOfQ });
    expect(res.status).toBe(422);
    const move = await request("member", "PATCH", `/issues/${issueDeP}`, { cycleId: cycleOfQ });
    expect(move.status).toBe(422);
  });

  test("does not assign someone who is not in the project", async () => {
    const res = await request("member", "POST", `/${P}/issues`, {
      name: "x",
      assigneeId: ACTORS.a.id,
    });
    expect(res.status).toBe(422);
  });

  test("an id that is not a uuid is 404, not a Postgres error", async () => {
    const res = await request("member", "GET", "/no-es-un-uuid/issues");
    expect(res.status).toBe(404);
    expect(withoutInternalDetails(await res.text())).toBe(true);
  });

  test("repeated identifier: generic 409", async () => {
    const res = await request("admin", "POST", "/projects", { name: "Other", identifier: "plat" });
    expect(res.status).toBe(409);
    expect(withoutInternalDetails(await res.text())).toBe(true);
  });
});

describe("RLS: the database filters even if the route failed", () => {
  test("whoever is not in Q sees zero rows of Q", async () => {
    const rows = await sqlAs(
      client,
      "member",
      "select id from agile_issues where project_id = $1",
      [Q]
    );
    expect(rows).toHaveLength(0);
    const projects = await sqlAs<{ id: string }>(client, "a", "select id from agile_projects");
    expect(projects).toHaveLength(0);
  });

  test("a viewer does not insert issues even by hand", async () => {
    await expect(
      sqlAs(
        client,
        "b",
        `insert into agile_issues(key, name, project_id, state_id, created_by)
         select 'PLAT-999', 'x', $1, id, $2 from agile_states where project_id = $1 limit 1`,
        [P, ACTORS.b.id]
      )
    ).rejects.toThrow(/row-level security/);
  });

  test("nobody gets themselves in as owner via SQL in someone else's project", async () => {
    await expect(
      sqlAs(
        client,
        "a",
        "insert into agile_project_members(project_id, user_id, role) values ($1, $2, 'owner')",
        [P, ACTORS.a.id]
      )
    ).rejects.toThrow(/row-level security/);
  });
});

/**
 * kon-agile — its MCP tools are SDK operations, and they require membership
 * ============================================================================
 *
 * Phase D (2026-10-25): `agile_read_board` and `agile_submit_intake` lived in an
 * `mcp.ts` that the core never published and that did not check membership in
 * the project (wired as is, any key read any board). Now
 * they are the `get-board` and `propose-intake` operations (agile.operations.ts)
 * and the core publishes them as tools from its registry.
 *
 * What is watched:
 *   · the catalog: exactly those two tools, with their usual names,
 *     one read-only and one that PROPOSES (the design's write
 *     boundary, which agile-mcp-tools.test.ts used to watch);
 *   · through the REAL routes (PGlite, forced RLS, non-superuser role): a
 *     member reads the board and proposes; a non-member, person or agent
 *     and even with `agile:*`, gets 404.
 *
 * Without the change: the board route does not exist (404 even for the member) and
 * the kon declares no operations (empty catalog).
 *
 * Since 2026-10-26 the kon's other routes are also SDK operations,
 * but REST only (`mcp: { excluir }`): the MCP catalog is still those two, and
 * the write boundary is measured on what goes out through MCP.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { mcpTool } from "../../.kitsuden/apps/api/src/lib/operations-openapi";
import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { inertCtx, operationsOf } from "../../.kitsuden/packages/engine/src/operations";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createKonAgile, kon } from "../../kons/kon-agile/index";
import { AGENT_TOOLS } from "../../kons/kon-agile/operations";

import { ACTORS, testAuth, dropToAppRole, migratedBase, requestAs } from "./helpers/safe-kons-bench";

const json = async (r: Response): Promise<any> => r.json();
const agent = (...scopes: string[]) => ({ agent: scopes });

describe("catalog: the tools come from the SDK registry", () => {
  const ops = operationsOf(kon, inertCtx());
  const tools = ops
    .map((op) => ({ op, h: mcpTool(kon.id, "/api/agile", op) }))
    .filter((x) => x.h !== null);

  // 1.3 (owner's decision 2026-11-03): agents work as teammates. Besides reading the board and
  // proposing, they get the tools to work on the issues in their reach. Nothing that configures
  // the project, decides an intake or deletes goes out through MCP.
  test("the board, the intake and the teammate tools, nothing else", () => {
    expect(tools.map((x) => x.h!.name).sort()).toEqual(
      [
        "agile_read_board",
        "agile_submit_intake",
        ...Object.values(AGENT_TOOLS).map((t) => t.name),
      ].sort()
    );
  });

  test("reading is GET; the writes are the issue work an agent does, never configuration", () => {
    const read = ops.find((o) => o.id === "get-board")!;
    const propose = ops.find((o) => o.id === "propose-intake")!;
    expect(read.method).toBe("GET");
    expect(propose.method).toBe("POST");
    expect(propose.route).toBe("/:projectId/intakes");
    expect(
      tools
        .filter((x) => x.op.method !== "GET")
        .map((x) => x.op.id)
        .sort()
    ).toEqual(
      [
        "propose-intake",
        "claim-work",
        "finish-work",
        "update-issue",
        "comment-issue",
        "update-checklist-item",
        "add-checklist-item",
        "handoff-issue",
        "create-issue",
      ].sort()
    );
    for (const id of ["approve-intake", "delete-issue", "create-cycle", "create-squad", "update-project"]) {
      expect(tools.some((x) => x.op.id === id)).toBe(false);
    }
  });

  test("both go first (they were resolved before the board routes)", () => {
    expect(ops.slice(0, 2).map((o) => o.id)).toEqual(["get-board", "propose-intake"]);
  });

  test("every tool requires a session and decides by membership in the project", () => {
    for (const { op } of tools) {
      expect(op.access).toBe("session");
      const policy = op.permission?.policy;
      // The first two ask the project's policy in the handler; the rest first ask the account rule
      // (an agent acts only with an agile scope), then membership and reach in the handler.
      expect(
        (policy?.resource === "agile_project" && policy.inHandler === true) ||
          (policy?.resource === "agile" && policy.action === "actAsUser")
      ).toBe(true);
    }
  });
});

describe("through the real routes: members only", () => {
  let client: PGlite;
  let request: ReturnType<typeof requestAs>;
  let P: string;

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
    request = requestAs(
      host.mount(createKonAgile(createTestKonContext({ db: host.db as any, auth: auth as any })))
    );
    const p = await request("staff", "POST", "/projects", { name: "Plataforma", identifier: "PLAT" });
    expect(p.status).toBe(201);
    P = (await json(p)).id;
    // `member` is member; the test agent, viewer.
    for (const [userId, role] of [
      [ACTORS.member.id, "member"],
      ["agente-de-prueba", "viewer"],
    ]) {
      expect((await request("staff", "POST", `/projects/${P}/members`, { userId, role })).status).toBe(201);
    }
    expect((await request("member", "POST", `/${P}/issues`, { name: "Tarea" })).status).toBe(201);
  });

  afterAll(async () => {
    await client?.close();
  });

  test("a member reads the board (statuses with their issues)", async () => {
    const r = await request("member", "GET", `/projects/${P}/board`);
    expect(r.status).toBe(200);
    const t = await json(r);
    expect(t.project.id).toBe(P);
    expect(t.totalIssues).toBe(1);
    expect(t.board.length).toBeGreaterThan(0);
  });

  test("a non-member: 404 (existence is not confirmed)", async () => {
    expect((await request("a", "GET", `/projects/${P}/board`)).status).toBe(404);
    expect((await request("a", "POST", `/${P}/intakes`, { title: "spam" })).status).toBe(404);
  });

  test("a MEMBER agent (viewer) reads and proposes; the intake is signed by it", async () => {
    const ag = agent("mcp:connect");
    expect((await request(ag, "GET", `/projects/${P}/board`)).status).toBe(200);
    const r = await request(ag, "POST", `/${P}/intakes`, { title: "Bug visto por el agente", source: "ai_agent" });
    expect(r.status).toBe(201);
    const intake = await json(r);
    expect(intake.status).toBe("pending");
    expect(intake.createdBy).toBe("agente-de-prueba");
  });

  test("an agent that is NOT a member does not get in even with `agile:*`", async () => {
    // Another project, without the agent: with `agile:*` the policy opens up for it by
    // scope, but membership RLS does not show it the project.
    const q = await request("staff", "POST", "/projects", { name: "Other", identifier: "OTHER" });
    const Q = (await json(q)).id;
    const ag = agent("agile:*");
    expect((await request(ag, "GET", `/projects/${Q}/board`)).status).toBe(404);
    expect((await request(ag, "POST", `/${Q}/intakes`, { title: "x" })).status).toBe(404);
  });

  test("on the other routes, an agent only acts as an account with `user:act` or an agile scope", async () => {
    // The host's `requireAuth` used to say so (agent-as-user.ts);
    // SDK operations do not go through that rule and the policy repeats it
    // "agile" (`actAsUser`).
    expect((await request(agent("mcp:connect"), "GET", "/projects")).status).toBe(403);
    expect((await request(agent("mcp:connect"), "POST", `/${P}/issues`, {})).status).toBe(403);
    const withScope = await request(agent("mcp:connect", "agile:read"), "GET", "/projects");
    expect(withScope.status).toBe(200);
    expect((await json(withScope)).docs.map((d: { id: string }) => d.id)).toEqual([P]);
    expect((await request(agent("user:act"), "GET", "/projects")).status).toBe(200);
  });

  test("the signature does not come from the body: a foreign `createdBy` does not slip through", async () => {
    const r = await request("member", "POST", `/${P}/intakes`, { title: "x", createdBy: "otro" });
    // The SDK rejects it (422) or ignores it as a server field; it never signs as another.
    if (r.status === 201) expect((await json(r)).createdBy).toBe(ACTORS.member.id);
    else expect(r.status).toBe(422);
  });
});

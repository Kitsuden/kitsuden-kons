/**
 * What an agent gets to work in the CRM: small tool groups and a guide
 * ============================================================================
 *
 * The groups (`mcpToolsets`, asked for as `kon:crm/<group>`) must name operations that exist, stay small enough
 * to choose from, and keep the decisions that belong to a person out of them. The guide comes with this
 * installation's own words and the caller's access.
 */

import type { PGlite } from "@electric-sql/pglite";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import kon from "../../kons/kon-crm";
import { CRM_TOOLSETS } from "../../kons/kon-crm/crm.agents";
import { registerCrmPolicy } from "../../kons/kon-crm/crm.policy";
import { createCRMRouter, crmOperations } from "../../kons/kon-crm/crm.routes";

import { dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
const announced: Array<{ name: string; data: Record<string, unknown> }> = [];
const json = (res: Response): Promise<any> => res.json();

beforeAll(async () => {
  const dir = resolve(__dirname, "../../kons/kon-crm/migrations");
  client = await migratedBase("kon-crm", readdirSync(dir).filter((f) => f.endsWith(".sql")).sort());
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const events = { emit: (name: string, data: unknown) => announced.push({ name, data: data as Record<string, unknown> }), on: () => {} };
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never, events: events as never });
  request = requestAs(host.mount(createCRMRouter(ctx)));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => registerCrmPolicy());

describe("tool groups", () => {
  const ids = new Set(crmOperations(createTestKonContext({}) as never).map((op) => (op as { id: string }).id));

  it("are what the kon declares to the core", () => {
    expect((kon as { mcpToolsets?: unknown }).mcpToolsets).toBe(CRM_TOOLSETS);
  });

  it("name only operations that exist, and each is small enough to choose from", () => {
    for (const [group, ops] of Object.entries(CRM_TOOLSETS)) {
      expect({ group, missing: ops.filter((op) => !ids.has(op)) }).toEqual({ group, missing: [] });
      expect(ops.length).toBeLessThanOrEqual(30);
      expect(new Set(ops).size).toBe(ops.length);
    }
  });

  it("leave out what only a person decides, and the chatbot group writes nothing", () => {
    const personOnly = ["accept-observation", "reject-observation", "decide-merge-request", "grant-access", "revoke-access", "create-portal-link"];
    for (const ops of Object.values(CRM_TOOLSETS)) expect(ops.filter((op) => personOnly.includes(op))).toEqual([]);
    expect(CRM_TOOLSETS.assistant!.filter((op) => !/^(get|list|count)-/.test(op))).toEqual([]);
  });
});

describe("the guide", () => {
  it("comes with this installation's words, the caller's access and the groups", async () => {
    await request("admin", "POST", "/presets/law-firm/apply");
    const res = await request({ agent: ["crm:view"] }, "GET", "/agent-guide");
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data.guide).toMatch(/Nothing is guessed/);
    expect(data.business.entities.map((e: { name: string }) => e.name)).toEqual(expect.arrayContaining(["matter", "contact"]));
    const matter = data.business.entities.find((e: { name: string }) => e.name === "matter");
    expect(matter.fields.find((f: { key: string }) => f.key === "opposingParty")).toMatchObject({ sensitive: true });
    expect(data.business.activityKinds.map((k: { key: string }) => k.key)).toContain("hearing");
    expect(data.access).toMatchObject({ sensitive: false, notes: false });
    expect(Object.keys(data.toolsets)).toEqual(["assistant", "sales", "research", "intake", "billing"]);
  });

  it("an agent can read its own notes dial, though it reads no notes", async () => {
    const { notes } = await json(await request({ agent: ["crm:view"] }, "GET", "/access/me"));
    expect(notes).toBe(false);
  });

  it("is closed to whoever is not on the CRM team", async () => {
    expect((await request("a", "GET", "/agent-guide")).status).toBe(403);
  });
});

describe("what the CRM announces", () => {
  it("ids and states, never values", async () => {
    await client.exec("RESET ROLE");
    await client.exec(`INSERT INTO crm_pipelines (id, name) VALUES ('pe', 'E'); INSERT INTO crm_pipeline_stages (id, pipeline_id, name, "order") VALUES ('se', 'pe', 'A', 0)`);
    await dropToAppRole(client);
    announced.length = 0;
    const contact = (await json(await request("staff", "POST", "/contacts", { firstName: "Eva", lastName: "Sol", email: "eva@x.example", notes: "private" }))).data;
    const deal = (await json(await request("staff", "POST", "/deals", { title: "Secret deal", value: 900, pipelineId: "pe", stageId: "se", contactId: contact.id }))).data;
    await request("staff", "PATCH", `/deals/${deal.id}`, { status: "won" });
    expect(announced.map((e) => e.name)).toEqual(["crm:contact:created", "crm:deal:created", "crm:deal:status-changed"]);
    expect(announced[2]!.data).toEqual({ dealId: deal.id, status: "won" });
    expect(JSON.stringify(announced)).not.toMatch(/private|Secret|900/);
  });
});

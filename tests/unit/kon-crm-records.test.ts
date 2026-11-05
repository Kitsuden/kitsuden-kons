/**
 * The reads and small writes an app's screens need from kon-crm
 * ============================================================================
 *
 * Every migration on PGlite as a NON-superuser role, the law-firm preset applied as the example business. Each
 * test is what a screen does: filter by the business's own fields, count before listing, reopen a task, show a
 * client their portal. The access dials hold throughout: a field someone cannot read cannot be filtered or
 * grouped by either.
 */

import type { PGlite } from "@electric-sql/pglite";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { registerCrmPolicy } from "../../kons/kon-crm/crm.policy";
import { createCRMRouter } from "../../kons/kon-crm/crm.routes";

import { ACTORS, dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
const STAFF = ACTORS.staff.id;
const json = (res: Response): Promise<any> => res.json();
const VIEWER = { agent: ["crm:view"] };

let pipelineId: string;
let firstStage: string;

beforeAll(async () => {
  const dir = resolve(__dirname, "../../kons/kon-crm/migrations");
  client = await migratedBase("kon-crm", readdirSync(dir).filter((f) => f.endsWith(".sql")).sort());
  await client.exec(`
    INSERT INTO crm_companies (id, name) VALUES ('co1', 'Acme Holdings');
    INSERT INTO crm_contacts (id, first_name, last_name, email, company_id, assigned_to) VALUES
      ('c1', 'Ana', 'Ortega', 'ana@acme.example', 'co1', '${STAFF}'),
      ('c2', 'Bruno', 'Paz', 'bruno@other.example', null, '${STAFF}');
  `);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never });
  request = requestAs(host.mount(createCRMRouter(ctx)));
  registerCrmPolicy();
  const applied = await json(await request("admin", "POST", "/presets/law-firm/apply"));
  pipelineId = applied.pipelineId;
  const pipeline = (await json(await request("admin", "GET", `/pipelines/${pipelineId}`))).data;
  firstStage = pipeline.stages[0].id;
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => registerCrmPolicy());

const newDeal = (body: Record<string, unknown>) =>
  request("staff", "POST", "/deals", { pipelineId, stageId: firstStage, ...body });

describe("deals of the preset's entity", () => {
  it("are validated against the preset's fields without naming the entity", async () => {
    const res = await newDeal({ title: "No fee type", contactId: "c1" });
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toMatch(/feeType is required/);
  });

  it("get the next number, one each, and keep a number given by hand", async () => {
    const a = (await json(await newDeal({ title: "Labor claim", contactId: "c1", companyId: "co1", customFields: { feeType: "time", practiceArea: "labor", opposingParty: "Rival SA" } }))).data;
    const b = (await json(await newDeal({ title: "Divorce", contactId: "c2", customFields: { feeType: "fixed", practiceArea: "family" } }))).data;
    const c = (await json(await newDeal({ title: "Old case", contactId: "c2", customFields: { feeType: "fixed", practiceArea: "civil", matterNumber: "OLD-7" } }))).data;
    expect([a.customFields.matterNumber, b.customFields.matterNumber, c.customFields.matterNumber]).toEqual(["M-0001", "M-0002", "OLD-7"]);
    expect(a.entityConfigId).toBeTruthy();
  });

  it("are found by the business's own fields, the contact's name or the company's", async () => {
    const titles = async (query: string) =>
      (await json(await request("staff", "GET", `/deals?${query}`))).data.map((d: { title: string }) => d.title).sort();
    expect(await titles("cf.practiceArea=labor")).toEqual(["Labor claim"]);
    expect(await titles("cf.feeType=fixed")).toEqual(["Divorce", "Old case"]);
    expect(await titles("search=Ortega")).toEqual(["Labor claim"]);
    expect(await titles("search=Acme")).toEqual(["Labor claim"]);
    expect((await request("staff", "GET", "/deals?cf.nope=1")).status).toBe(422);
  });

  it("a field someone cannot read cannot be filtered or grouped by", async () => {
    expect((await request("staff", "GET", "/deals?cf.opposingParty=Rival%20SA")).status).toBe(403);
    expect((await request("staff", "GET", "/deal-counts?groupBy=cf.opposingParty")).status).toBe(403);
    expect((await json(await request("admin", "GET", "/deals?cf.opposingParty=Rival%20SA"))).data).toHaveLength(1);
  });

  it("are counted per group in one call", async () => {
    const byArea = await json(await request("staff", "GET", "/deal-counts?groupBy=cf.practiceArea"));
    expect(byArea.total).toBe(3);
    expect(byArea.data).toEqual(expect.arrayContaining([{ key: "labor", count: 1 }, { key: "family", count: 1 }, { key: "civil", count: 1 }]));
    const fixedPerStage = await json(await request("staff", "GET", "/deal-counts?groupBy=stageId&cf.feeType=fixed"));
    expect(fixedPerStage.data).toEqual([{ key: firstStage, count: 2 }]);
    expect((await request("staff", "GET", "/deal-counts?groupBy=title")).status).toBe(422);
  });

  it("the board narrows by field too", async () => {
    const board = (await json(await request("staff", "GET", `/pipelines/${pipelineId}/kanban?cf.practiceArea=family`))).data;
    const titles = board.stages.flatMap((s: { deals: { title: string }[] }) => s.deals.map((d) => d.title));
    expect(titles).toEqual(["Divorce"]);
  });
});

describe("companies", () => {
  it("carry the preset's fields, validated, with the sensitive ones hidden", async () => {
    expect((await request("staff", "PATCH", "/companies/co1", { customFields: { kycStatus: "whatever" } })).status).toBe(422);
    expect((await request("staff", "PATCH", "/companies/co1", { customFields: { kycStatus: "approved", taxId: "J-99" } })).status).toBe(200);
    expect((await json(await request("staff", "GET", "/companies/co1"))).data.customFields).toEqual({ kycStatus: "approved" });
    expect((await json(await request("admin", "GET", "/companies/co1"))).data.customFields).toEqual({ kycStatus: "approved", taxId: "J-99" });
    expect((await json(await request("staff", "GET", "/companies?cf.kycStatus=approved"))).data).toHaveLength(1);
    expect((await request("staff", "GET", "/companies?cf.taxId=J-99")).status).toBe(403);
  });
});

describe("activities and the inbox", () => {
  let dealId: string;
  let taskId: string;

  it("kinds are the preset's words, and an unknown one is refused", async () => {
    const kinds = (await json(await request("staff", "GET", "/activity-kinds"))).data;
    expect(kinds.map((k: { key: string }) => k.key)).toEqual(["hearing", "deadline", "client-meeting"]);
    dealId = (await json(await request("staff", "GET", "/deals?cf.practiceArea=labor"))).data[0].id;
    const bad = await request("staff", "POST", "/activities", { type: "meeting", kind: "party", subject: "x", dealId });
    expect(bad.status).toBe(422);
    const hearing = await request("staff", "POST", "/activities", {
      type: "meeting",
      kind: "hearing",
      location: "Court 4",
      subject: "First hearing",
      dealId,
      dueDate: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      sharedWithClient: true,
    });
    expect(hearing.status).toBe(201);
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const agenda = (await json(await request("staff", "GET", `/agenda?from=${from}&to=${to}&kind=hearing`))).data;
    expect(agenda.map((a: { location: string }) => a.location)).toEqual(["Court 4"]);
  });

  it("the inbox brings each task's deal and the counts, without a call per row", async () => {
    const late = new Date(Date.now() - 2 * 86_400_000).toISOString();
    taskId = (await json(await request("staff", "POST", "/activities", { type: "task", subject: "File the brief", dealId, assignedTo: STAFF, dueDate: late }))).data.id;
    await request("staff", "POST", "/activities", { type: "task", subject: "Call back", assignedTo: STAFF });
    const work = await json(await request("staff", "GET", "/work?include=deal"));
    const brief = work.data.find((t: { id: string }) => t.id === taskId);
    expect(brief).toMatchObject({ dueState: "late", deal: { id: dealId, title: "Labor claim", contactName: "Ana Ortega", companyName: "Acme Holdings" } });
    expect(work.total).toBe(2);
    expect((await json(await request("staff", "GET", "/work?search=brief"))).data.map((t: { id: string }) => t.id)).toEqual([taskId]);
    const summary = await json(await request("staff", "GET", "/work/summary"));
    expect(summary.mine).toMatchObject({ late: 1, none: 1, total: 2 });
    expect(summary.done.total).toBe(0);
  });

  it("a completed task records who closed it, and can be reopened", async () => {
    expect((await request("staff", "POST", `/activities/${taskId}/reopen`, {})).status).toBe(409);
    const done = (await json(await request("staff", "POST", `/activities/${taskId}/complete`, {}))).data;
    expect(done.completedBy).toBe(STAFF);
    expect((await json(await request("staff", "GET", "/work/summary"))).done.total).toBe(1);
    const back = (await json(await request("staff", "POST", `/activities/${taskId}/reopen`, { reason: "closed by mistake" }))).data;
    expect(back).toMatchObject({ completedAt: null, completedBy: null });
    expect(back.notes).toContain("Reopened: closed by mistake");
    expect((await request(VIEWER, "POST", `/activities/${taskId}/reopen`, {})).status).toBe(403);
  });
});

describe("documents", () => {
  it("are listed across deals and their details change", async () => {
    const dealId = (await json(await request("staff", "GET", "/deals?cf.practiceArea=labor"))).data[0].id;
    await client.exec("RESET ROLE");
    await client.exec(`INSERT INTO crm_documents (id, deal_id, name, file_url, category) VALUES
      ('doc1', '${dealId}', 'Power of attorney', '/p', 'contracts'), ('doc2', '${dealId}', 'Notes', '/n', 'internal')`);
    await dropToAppRole(client);
    const list = await json(await request("staff", "GET", "/documents?contactId=c1"));
    expect(list.total).toBe(2);
    expect((await json(await request("staff", "GET", "/documents?search=power"))).data.map((d: { id: string }) => d.id)).toEqual(["doc1"]);
    const changed = (await json(await request("staff", "PATCH", "/documents/doc1", { sharedWithClient: true, metadata: { signature: "signed" } }))).data;
    expect(changed).toMatchObject({ sharedWithClient: true, metadata: { signature: "signed" }, fileUrl: "/p" });
    expect((await request("staff", "PATCH", "/documents/nope", { name: "x" })).status).toBe(404);
    // Confidential: who has no sensitive access no longer sees it.
    await request("admin", "PATCH", "/documents/doc2", { confidential: true });
    expect((await json(await request("staff", "GET", "/documents?contactId=c1"))).data.map((d: { id: string }) => d.id)).toEqual(["doc1"]);
  });
});

describe("the client portal", () => {
  it("shows the stages, where the deal is, and only the fields marked for clients", async () => {
    const labor = (await json(await request("admin", "GET", "/deals?cf.practiceArea=labor"))).data[0];
    await request("admin", "PATCH", `/deals/${labor.id}`, { portalVisible: true, customFields: { ...labor.customFields, court: "Labor court 2" } });
    const { token } = await json(await request("staff", "POST", "/portal-links", { contactId: "c1" }));
    const view = await json(await request("anon", "POST", "/public/portal", { token }));
    const deal = view.deals[0];
    expect(deal.stages).toEqual(["New", "In progress", "Resolution", "Closed"]);
    expect(deal.stageIndex).toBe(0);
    expect(deal.fields.map((f: { key: string }) => f.key).sort()).toEqual(["court", "matterNumber", "practiceArea"]);
    expect(JSON.stringify(view)).not.toMatch(/Rival SA|feeType/);
    expect(view.events).toEqual([expect.objectContaining({ kind: "hearing", location: "Court 4" })]);
    expect(view).not.toHaveProperty("statement");
  });

  it("staff can preview it without making a link; amounts need access to amounts", async () => {
    const preview = await json(await request("staff", "GET", "/contacts/c1/portal-preview"));
    expect(preview.deals.map((d: { title: string }) => d.title)).toEqual(["Labor claim"]);
    const agent = { agent: ["crm:view", "crm:edit"] };
    const grant = { records: "all", money: false, sensitive: false, notes: false, reason: "no amounts" };
    expect((await request("admin", "PUT", "/access/agent/agente-de-prueba", grant)).status).toBe(200);
    expect((await request(agent, "GET", "/contacts/c1/portal-preview?statement=true")).status).toBe(403);
    expect((await request(agent, "GET", "/contacts/c1/portal-preview")).status).toBe(200);
    await request("admin", "DELETE", "/access/agent/agente-de-prueba");
    expect((await request("staff", "GET", "/contacts/nope/portal-preview")).status).toBe(404);
  });

  it("the team sees which links show the statement", async () => {
    await request("staff", "POST", "/portal-links", { contactId: "c2", showStatement: true });
    const links = (await json(await request("staff", "GET", "/portal-links?contactId=c2"))).data;
    expect(links[0]).toMatchObject({ showStatement: true, live: true });
  });
});

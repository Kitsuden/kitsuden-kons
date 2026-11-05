/**
 * kon-crm: how far each person and agent reaches, and what comes in
 * ============================================================================
 *
 * Real routes on PGlite with every migration of the kon, as a NON-superuser role, so RLS runs.
 */

import type { PGlite } from "@electric-sql/pglite";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { withoutMoney } from "../../kons/kon-crm/crm.access";
import { registerCrmPolicy } from "../../kons/kon-crm/crm.policy";
import { createCRMRouter } from "../../kons/kon-crm/crm.routes";

import { ACTORS, dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
const AGENT = "agente-de-prueba";
const PIPELINE = "pipeline_access";
const STAGE = "stage_access";
const STAFF = ACTORS.staff.id;
const REVIEWER = ACTORS.revisor.id;

const json = (res: Response): Promise<any> => res.json();
const grant = (actor: "admin" | "staff", type: string, id: string, body: Record<string, unknown>) =>
  request(actor, "PUT", `/access/${type}/${id}`, { reason: "test", money: true, sensitive: false, records: "all", ...body });

beforeAll(async () => {
  const dir = resolve(__dirname, "../../kons/kon-crm/migrations");
  client = await migratedBase("kon-crm", readdirSync(dir).filter((f) => f.endsWith(".sql")).sort());
  await client.exec(`
    INSERT INTO crm_pipelines (id, name) VALUES ('${PIPELINE}', 'P');
    INSERT INTO crm_pipeline_stages (id, pipeline_id, name, "order") VALUES ('${STAGE}', '${PIPELINE}', 'S', 0);
    INSERT INTO crm_contacts (id, first_name, last_name, email, assigned_to) VALUES
      ('c_mine', 'Mia', 'One', 'mia@example.com', '${STAFF}'),
      ('c_other', 'Oto', 'Two', 'oto@example.com', '${REVIEWER}');
    INSERT INTO crm_deals (id, title, value, pipeline_id, stage_id, contact_id, assigned_to) VALUES
      ('d_mine', 'Mine', 500, '${PIPELINE}', '${STAGE}', 'c_mine', '${STAFF}'),
      ('d_other', 'Other', 900, '${PIPELINE}', '${STAGE}', 'c_other', '${REVIEWER}');
    INSERT INTO crm_documents (id, deal_id, name, file_url, confidential, is_privileged) VALUES
      ('doc_open', 'd_mine', 'Open', '/a', false, false),
      ('doc_secret', 'd_mine', 'Secret', '/b', true, false),
      ('doc_priv', 'd_mine', 'Privileged', '/c', false, true);
  `);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never });
  request = requestAs(host.mount(createCRMRouter(ctx)));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => registerCrmPolicy());

const ids = async (res: Response) => (await json(res)).data.map((r: { id: string }) => r.id).sort();
const documents = (actor: Parameters<typeof request>[0]) => request(actor, "GET", "/deals/d_mine/documents");

describe("default access", () => {
  it("the team sees all records and amounts, not sensitive documents", async () => {
    await request("admin", "DELETE", `/access/user/${STAFF}`);
    expect(await ids(await request("staff", "GET", "/deals"))).toEqual(["d_mine", "d_other"]);
    expect(await ids(await documents("staff"))).toEqual(["doc_open"]);
    expect(await json(await request("staff", "GET", "/access/me"))).toEqual({ records: "all", money: true, sensitive: false, notes: true });
  });

  it("an agent with crm:view is the same: reading a contact is not reading everything", async () => {
    expect(await ids(await documents({ agent: ["crm:view"] }))).toEqual(["doc_open"]);
  });
});

describe("the read-everything permission", () => {
  it("the scope crm:read-all opens sensitive documents to an agent", async () => {
    expect(await ids(await documents({ agent: ["crm:view", "crm:read-all"] }))).toEqual(["doc_open", "doc_priv", "doc_secret"]);
  });

  it("a denial beats it", async () => {
    expect(await ids(await documents({ agent: ["crm:view", "crm:read-all", "!crm:read-all"] }))).toEqual(["doc_open"]);
  });

  it("a person can grant it to an agent, and it stays on record who and why", async () => {
    expect((await grant("admin", "agent", AGENT, { sensitive: true, reason: "audit 2026" })).status).toBe(200);
    expect(await ids(await documents({ agent: ["crm:view"] }))).toEqual(["doc_open", "doc_priv", "doc_secret"]);
    const listed = (await json(await request("admin", "GET", "/access"))).data.find((g: any) => g.subjectId === AGENT);
    expect(listed).toMatchObject({ reason: "audit 2026", grantedBy: ACTORS.admin.id });
    await request("admin", "DELETE", `/access/agent/${AGENT}`);
    expect(await ids(await documents({ agent: ["crm:view"] }))).toEqual(["doc_open"]);
  });

  it("an expired grant stops opening sensitive documents", async () => {
    await grant("admin", "agent", AGENT, { sensitive: true, sensitiveUntil: "2020-01-01T00:00:00Z" });
    expect(await ids(await documents({ agent: ["crm:view"] }))).toEqual(["doc_open"]);
    await request("admin", "DELETE", `/access/agent/${AGENT}`);
  });

  it("only an admin person grants: not the team, not an agent, not on oneself", async () => {
    expect((await grant("staff", "agent", AGENT, { sensitive: true })).status).toBe(403);
    expect((await request({ agent: ["crm:*"] }, "PUT", `/access/agent/${AGENT}`, { reason: "self", records: "all", money: true, sensitive: true })).status).toBe(403);
    expect((await grant("admin", "user", ACTORS.admin.id, { sensitive: true })).status).toBe(403);
    expect((await request({ agent: ["crm:*"] }, "GET", "/access/me")).status).toBe(200);
  });

  it("without CRM access, the scope alone opens nothing", async () => {
    expect((await documents({ agent: ["crm:read-all"] })).status).toBe(403);
  });
});

describe("limited to what is assigned", () => {
  beforeAll(async () => {
    await grant("admin", "user", STAFF, { records: "assigned", money: false });
  });
  afterAll(async () => {
    await request("admin", "DELETE", `/access/user/${STAFF}`);
  });

  it("the database hides other people's records, on every route", async () => {
    expect(await ids(await request("staff", "GET", "/deals"))).toEqual(["d_mine"]);
    expect(await ids(await request("staff", "GET", "/contacts"))).toEqual(["c_mine"]);
    expect((await request("staff", "GET", "/deals/d_other")).status).toBe(404);
    expect((await request("staff", "PATCH", "/deals/d_other", { title: "x" })).status).toBe(404);
  });

  it("amounts do not come out, and the row does", async () => {
    const deal = (await json(await request("staff", "GET", "/deals/d_mine"))).data;
    expect(deal.title).toBe("Mine");
    expect(deal).not.toHaveProperty("value");
    const stats = JSON.stringify(await json(await request("staff", "GET", "/stats")));
    expect(stats).not.toMatch(/[a-z]Value"/);
  });

  it("an admin is not limited", async () => {
    expect(await ids(await request("admin", "GET", "/deals"))).toEqual(["d_mine", "d_other"]);
  });
});

describe("withoutMoney", () => {
  it("removes amounts at any depth, and leaves a stage rule's `value` alone", () => {
    expect(
      withoutMoney({
        data: [{ stageId: "s", pipelineId: "p", value: 5, title: "t" }],
        totalValue: 9,
        rule: { field: "x", value: 1 },
        annualRevenue: 2,
      })
    ).toEqual({ data: [{ stageId: "s", pipelineId: "p", title: "t" }], rule: { field: "x", value: 1 } });
  });
});

describe("capture and the exclusion list", () => {
  const form = { email: "New@Lead.example", firstName: "Nia", lastName: "Lead", message: "Hi", source: "web", campaign: "c1" };

  it("dryRun writes nothing", async () => {
    const plan = await json(await request("staff", "POST", "/capture", { ...form, dryRun: true }));
    expect(plan.action).toBe("create");
    expect(await ids(await request("staff", "GET", "/contacts?search=lead.example"))).toEqual([]);
  });

  it("creates the contact and its activity; a second submission does not duplicate", async () => {
    const first = await json(await request("staff", "POST", "/capture", form));
    expect(first.action).toBe("create");
    const second = await json(await request("staff", "POST", "/capture", { ...form, firstName: "Other", phone: "+1 555" }));
    expect(second).toMatchObject({ action: "update", contactId: first.contactId });
    const contact = (await json(await request("staff", "GET", `/contacts/${first.contactId}`))).data;
    expect(contact.firstName).toBe("Nia");
    expect(contact.phone).toBe("+1 555");
  });

  it("a suppressed email or domain writes nothing", async () => {
    await request("staff", "POST", "/suppressions", { kind: "domain", value: "@Blocked.example" });
    const res = await json(await request("staff", "POST", "/capture", { ...form, email: "a@blocked.example" }));
    expect(res).toEqual({ action: "suppressed" });
  });

  it("the team cannot take someone off the list", async () => {
    expect((await request("staff", "DELETE", "/suppressions/domain/blocked.example")).status).toBe(403);
    expect((await request("admin", "DELETE", "/suppressions/domain/blocked.example")).status).toBe(200);
  });

  it("anonymous and plain accounts stay out", async () => {
    expect((await request("anon", "POST", "/capture", form)).status).toBe(401);
    expect((await request("a", "POST", "/capture", form)).status).toBe(403);
  });
});

describe("duplicates and merging", () => {
  let older: string;
  let newer: string;

  beforeAll(async () => {
    await client.exec(`RESET ROLE`);
    await client.exec(`
      INSERT INTO crm_contacts (id, first_name, last_name, email, phone, created_at) VALUES
        ('c_old', 'Ana', 'Dup', 'dup@example.com', '111', now() - interval '2 days'),
        ('c_new', 'Ana', 'Dup', 'dup@example.com', '222', now());
      UPDATE crm_contacts SET job_title = 'CTO' WHERE id = 'c_new';
      INSERT INTO crm_deals (id, title, pipeline_id, stage_id, contact_id) VALUES ('d_new', 'D', '${PIPELINE}', '${STAGE}', 'c_new');
    `);
    await dropToAppRole(client);
    older = "c_old";
    newer = "c_new";
  });

  it("finds the duplicate and says why", async () => {
    const found = (await json(await request("staff", "GET", `/contacts/${older}/duplicates`))).data;
    expect(found[0].id).toBe(newer);
    expect(found[0].rating).toBeGreaterThanOrEqual(85);
  });

  it("the team cannot merge: a contact disappears", async () => {
    expect((await request("staff", "POST", `/contacts/${older}/merge`, { otherId: newer })).status).toBe(403);
  });

  it("different values stop the merge until someone chooses", async () => {
    const res = await request("admin", "POST", `/contacts/${older}/merge`, { otherId: newer });
    expect(res.status).toBe(409);
    expect((await json(res)).error.details.conflicts.map((x: { field: string }) => x.field)).toEqual(["phone"]);
    expect((await request("admin", "GET", `/contacts/${newer}`)).status).toBe(200);
  });

  it("merges: the oldest survives, gaps fill, deals move, and nothing is overwritten unasked", async () => {
    const res = await request("admin", "POST", `/contacts/${newer}/merge`, { otherId: older, resolutions: { phone: "keep" } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.absorbed).toBe(newer);
    expect(body.data).toMatchObject({ id: older, phone: "111", jobTitle: "CTO" });
    expect((await request("admin", "GET", `/contacts/${newer}`)).status).toBe(404);
    expect((await json(await request("admin", "GET", "/deals/d_new"))).data.contactId).toBe(older);
  });
});

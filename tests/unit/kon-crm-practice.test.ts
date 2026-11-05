/**
 * kon-crm: what it takes to run a practice on it
 * ============================================================================
 *
 * Real routes on PGlite with every migration, as a NON-superuser role. Covers the limits people relied on being
 * closed (amounts, notes, merges by agents, public forms), and that a law firm can be set up from a preset.
 */

import type { PGlite } from "@electric-sql/pglite";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { conditionHolds } from "../../kons/kon-crm/crm.automation";
import { parseCsv, mapColumns } from "../../kons/kon-crm/crm.import";
import { registerCrmPolicy } from "../../kons/kon-crm/crm.policy";
import { createCRMRouter } from "../../kons/kon-crm/crm.routes";
import { computeScore } from "../../kons/kon-crm/crm.scoring";
import { dueState, renderTemplate } from "../../kons/kon-crm/crm.work";

import { ACTORS, dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
const STAFF = ACTORS.staff.id;
const PIPELINE = "pipeline_p";
const STAGE_A = "stage_a";
const STAGE_B = "stage_b";

const json = (res: Response): Promise<any> => res.json();
const VIEWER = { agent: ["crm:view"] };

beforeAll(async () => {
  const dir = resolve(__dirname, "../../kons/kon-crm/migrations");
  client = await migratedBase("kon-crm", readdirSync(dir).filter((f) => f.endsWith(".sql")).sort());
  await client.exec(`
    INSERT INTO crm_pipelines (id, name) VALUES ('${PIPELINE}', 'P');
    INSERT INTO crm_pipeline_stages (id, pipeline_id, name, "order", on_enter_actions, on_exit_actions) VALUES
      ('${STAGE_A}', '${PIPELINE}', 'A', 0, '[]', '[{"type":"create_activity","title":"Left A"}]'),
      ('${STAGE_B}', '${PIPELINE}', 'B', 1, '[
        {"type":"create_task","title":"Prepare the hearing","value":3},
        {"type":"update_field","field":"owner"},
        {"type":"update_field","field":"custom.reached","value":"yes"},
        {"type":"create_task","title":"Only if big","condition":{"field":"value","operator":">","value":1000}}
      ]', '[]');
    INSERT INTO crm_contacts (id, first_name, last_name, email, notes, assigned_to, custom_fields) VALUES
      ('c1', 'Ana', 'One', 'ana@acme.example', 'private note', '${STAFF}', '{"taxId":"8-123","kycStatus":"approved"}');
    INSERT INTO crm_deals (id, title, value, pipeline_id, stage_id, contact_id, assigned_to, portal_visible, lost_notes) VALUES
      ('d1', 'Labor claim', 500, '${PIPELINE}', '${STAGE_A}', 'c1', '${STAFF}', true, 'why we lost');
    INSERT INTO crm_activities (id, type, subject, description, deal_id, contact_id, shared_with_client, due_date, assigned_to) VALUES
      ('a1', 'meeting', 'Hearing', 'strategy talk', 'd1', 'c1', true, now(), '${STAFF}'),
      ('a2', 'note', 'Internal', 'do not show', 'd1', 'c1', false, null, null);
    INSERT INTO crm_documents (id, deal_id, name, file_url, shared_with_client) VALUES
      ('doc1', 'd1', 'Shared', '/s', true), ('doc2', 'd1', 'Internal', '/i', false);
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

describe("notes about people", () => {
  it("a person reads them; an agent with crm:view does not", async () => {
    expect((await json(await request("staff", "GET", "/contacts/c1"))).data.notes).toBe("private note");
    const seen = (await json(await request(VIEWER, "GET", "/contacts/c1"))).data;
    expect(seen.firstName).toBe("Ana");
    expect(seen).not.toHaveProperty("notes");
    const activity = (await json(await request(VIEWER, "GET", "/activities/a1"))).data;
    expect(activity.subject).toBe("Hearing");
    expect(activity).not.toHaveProperty("description");
    expect((await json(await request(VIEWER, "GET", "/deals/d1"))).data).not.toHaveProperty("lostNotes");
  });

  it("crm:read-all or a grant opens them", async () => {
    expect((await json(await request({ agent: ["crm:view", "crm:read-all"] }, "GET", "/contacts/c1"))).data.notes).toBe("private note");
    await request("admin", "PUT", "/access/agent/agente-de-prueba", { records: "all", money: true, sensitive: false, notes: true, reason: "support" });
    expect((await json(await request(VIEWER, "GET", "/contacts/c1"))).data.notes).toBe("private note");
    await request("admin", "DELETE", "/access/agent/agente-de-prueba");
  });
});

describe("amounts", () => {
  beforeAll(async () => {
    await request("admin", "PUT", `/access/user/${STAFF}`, { records: "all", money: false, sensitive: false, reason: "assistant" });
  });
  afterAll(async () => {
    await request("admin", "DELETE", `/access/user/${STAFF}`);
  });

  it("writing one is refused, so a blind write cannot probe it", async () => {
    expect((await request("staff", "PATCH", "/deals/d1", { value: 1 })).status).toBe(403);
    expect((await request("staff", "PATCH", "/deals/d1", { title: "Labor claim" })).status).toBe(200);
  });
});

describe("merges by agents", () => {
  beforeAll(async () => {
    await client.exec(`RESET ROLE`);
    await client.exec(`
      INSERT INTO crm_contacts (id, first_name, last_name, email, created_at) VALUES
        ('m_old', 'Mia', 'Dup', 'mia@x.example', now() - interval '1 day'), ('m_new', 'Mia', 'Dup', 'mia@x.example', now());
    `);
    await dropToAppRole(client);
  });

  it("even with every scope, an agent only asks", async () => {
    const res = await request({ agent: ["crm:*"] }, "POST", "/contacts/m_old/merge", { otherId: "m_new" });
    expect(res.status).toBe(202);
    const { requestId } = await json(res);
    expect((await request("admin", "GET", "/contacts/m_new")).status).toBe(200);
    expect((await request({ agent: ["crm:*"] }, "POST", `/merge-requests/${requestId}/decision`, { decision: "approve" })).status).toBe(403);
    expect((await request("staff", "POST", `/merge-requests/${requestId}/decision`, { decision: "approve" })).status).toBe(403);

    const decided = await request("admin", "POST", `/merge-requests/${requestId}/decision`, { decision: "approve" });
    expect(decided.status).toBe(200);
    expect((await request("admin", "GET", "/contacts/m_new")).status).toBe(404);
    expect((await request("admin", "POST", `/merge-requests/${requestId}/decision`, { decision: "reject" })).status).toBe(404);
  });
});

describe("stage automation", () => {
  it("runs on a move; what fails leaves a note and does not undo the move", async () => {
    const res = await json(await request("admin", "POST", "/deals/d1/move", { targetStageId: STAGE_B, skipValidation: true }));
    expect(res.data.stageId).toBe(STAGE_B);
    expect(res.automation.ran).toEqual(["create_activity", "create_task", "update_field"]);
    expect(res.automation.failed).toEqual([{ type: "update_field", error: "A stage cannot change owner" }]);
    const activities = (await json(await request("admin", "GET", "/activities?dealId=d1"))).data;
    const subjects = activities.map((a: { subject: string }) => a.subject);
    expect(subjects).toContain("Prepare the hearing");
    expect(subjects).toContain("Left A");
    expect(subjects).toContain("A stage automation failed");
    expect(subjects).not.toContain("Only if big");
    expect((await json(await request("admin", "GET", "/deals/d1"))).data.customFields.reached).toBe("yes");
  });

  it("a stage cannot be told to do what nothing runs", async () => {
    const res = await request("admin", "POST", `/stages/${STAGE_A}/config`, { onEnterActions: [{ type: "webhook" }] });
    expect(res.status).not.toBe(200);
  });

  it("conditions", () => {
    const deal = { value: 10, customFields: { a: "x" } } as never;
    expect(conditionHolds({ type: "create_task", condition: { field: "value", operator: ">", value: 5 } }, deal)).toBe(true);
    expect(conditionHolds({ type: "create_task", condition: { field: "custom.a", operator: "==", value: "y" } }, deal)).toBe(false);
    expect(conditionHolds({ type: "create_task", condition: { field: "value", operator: "~", value: 5 } }, deal)).toBe(false);
  });
});

describe("public forms", () => {
  let formId: string;
  const lead = { email: "public@lead.example", firstName: "Pia", message: "Help" };

  it("only an admin creates one", async () => {
    expect((await request("staff", "POST", "/capture-forms", { name: "Web" })).status).toBe(403);
    const res = await request("admin", "POST", "/capture-forms", { name: "Web", source: "web", pipelineId: PIPELINE, stageId: STAGE_A });
    expect(res.status).toBe(201);
    formId = (await json(res)).id;
  });

  it("works with no account, and leaves the contact and the deal", async () => {
    expect((await request("anon", "POST", `/public/forms/${formId}`, lead)).status).toBe(202);
    const found = (await json(await request("admin", "GET", "/contacts?search=public@lead"))).data;
    expect(found[0]).toMatchObject({ origin: "form", source: "web" });
    expect((await json(await request("admin", "GET", `/deals?contactId=${found[0].id}`))).data).toHaveLength(1);
  });

  it("answers the same for a known person, an excluded one and a bot, and writes nothing for the last two", async () => {
    await request("admin", "POST", "/suppressions", { kind: "email", value: "no@lead.example" });
    for (const body of [lead, { ...lead, email: "no@lead.example" }, { ...lead, email: "bot@lead.example", website: "http://spam" }]) {
      const res = await request("anon", "POST", `/public/forms/${formId}`, body);
      expect(res.status).toBe(202);
      expect(await json(res)).toEqual({ ok: true });
    }
    expect((await json(await request("admin", "GET", "/contacts?search=no@lead"))).data).toEqual([]);
    expect((await json(await request("admin", "GET", "/contacts?search=bot@lead"))).data).toEqual([]);
  });

  it("an admin switches a form off and on, and its id never changes", async () => {
    expect((await request("staff", "PATCH", `/capture-forms/${formId}`, { active: false })).status).toBe(403);
    expect((await request("admin", "PATCH", `/capture-forms/${formId}`, { active: false })).status).toBe(200);
    expect((await request("anon", "POST", `/public/forms/${formId}`, lead)).status).toBe(404);
    expect((await request("admin", "PATCH", `/capture-forms/${formId}`, { stageId: null })).status).toBe(422);
    const back = await json(await request("admin", "PATCH", `/capture-forms/${formId}`, { active: true, name: "Website" }));
    expect(back).toMatchObject({ id: formId, name: "Website", active: true, stageId: STAGE_A });
    expect((await request("admin", "PATCH", "/capture-forms/nope", { active: true })).status).toBe(404);
  });

  it("an unknown form is 404, and everything else in the CRM stays closed", async () => {
    expect((await request("anon", "POST", "/public/forms/nope", lead)).status).toBe(404);
    expect((await request("anon", "GET", "/contacts")).status).toBe(401);
  });
});

describe("client portal", () => {
  let token: string;
  let linkId: string;

  it("an agent cannot open client access; a person can", async () => {
    expect((await request({ agent: ["crm:*"] }, "POST", "/portal-links", { contactId: "c1" })).status).toBe(403);
    const res = await json(await request("staff", "POST", "/portal-links", { contactId: "c1" }));
    token = res.token;
    linkId = res.id;
    expect(token.length).toBeGreaterThan(30);
  });

  it("shows what was marked, with no amounts or notes", async () => {
    const res = await request("anon", "POST", "/public/portal", { token });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.contact).toEqual({ firstName: "Ana", lastName: "One" });
    expect(body.deals.map((d: { title: string }) => d.title)).toEqual(["Labor claim"]);
    expect(body.events.map((e: { id: string }) => e.id)).toEqual(["a1"]);
    expect(body.documents.map((d: { id: string }) => d.id)).toEqual(["doc1"]);
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/500|why we lost|private note|strategy talk|8-123/);
  });

  it("the team sees who has a link and whether it works, never the token", async () => {
    const links = (await json(await request("staff", "GET", "/portal-links?contactId=c1"))).data;
    expect(links).toEqual([expect.objectContaining({ id: linkId, contactId: "c1", live: true })]);
    expect(JSON.stringify(links)).not.toContain(token);
    expect(JSON.stringify(links)).not.toMatch(/tokenHash|token_hash/);
    expect((await request(VIEWER, "GET", "/portal-links")).status).toBe(403);
  });

  it("the token is stored hashed, and a revoked or wrong one is 404", async () => {
    expect((await request("anon", "POST", "/public/portal", { token: "x".repeat(43) })).status).toBe(404);
    await client.exec("RESET ROLE");
    const stored = await client.query<{ token_hash: string }>("SELECT token_hash FROM crm_portal_links");
    await dropToAppRole(client);
    expect(stored.rows[0]!.token_hash).not.toBe(token);
    await request("staff", "DELETE", `/portal-links/${linkId}`);
    expect((await request("anon", "POST", "/public/portal", { token })).status).toBe(404);
    expect((await json(await request("staff", "GET", "/portal-links?contactId=c1"))).data[0]).toMatchObject({ id: linkId, live: false });
  });
});

describe("score model", () => {
  const rules = [
    { id: "a", label: "Has phone", signal: "hasPhone", op: "==" as const, value: true, points: 60 },
    { id: "b", label: "Deals", signal: "openDeals", op: ">=" as const, value: 1, points: 70 },
    { id: "c", label: "Cold", signal: "daysSinceContact", op: ">=" as const, value: 90, points: -20 },
  ];

  it("adds up the rules that hold, between 0 and 100, and says which", () => {
    expect(computeScore(rules, { hasPhone: true, openDeals: 2, daysSinceContact: 1 })).toEqual({
      score: 100,
      matched: [
        { id: "a", label: "Has phone", points: 60 },
        { id: "b", label: "Deals", points: 70 },
      ],
    });
    expect(computeScore(rules, { hasPhone: false, openDeals: 0, daysSinceContact: 200 }).score).toBe(0);
    expect(computeScore(rules, {}).matched).toEqual([]);
  });

  it("the model comes seeded with its guide, and agents can read it", async () => {
    const model = await json(await request(VIEWER, "GET", "/score-model"));
    expect(model.guide).toMatch(/sum of the points/);
    expect(model.signals).toHaveProperty("corporateEmail");
    expect(model.rules.length).toBeGreaterThan(3);
  });

  it("only an admin saves it; each save is a version; a bad signal is refused", async () => {
    const body = { rules: rules.slice(0, 1), guide: "# Ours" };
    expect((await request("staff", "PUT", "/score-model", body)).status).toBe(403);
    expect((await request("admin", "PUT", "/score-model", { ...body, rules: [{ ...rules[0], signal: "nope" }] })).status).toBe(422);
    const saved = await json(await request("admin", "PUT", "/score-model", body));
    expect(saved.version).toBe(2);
    expect((await json(await request("staff", "GET", "/score-model/versions"))).data).toHaveLength(2);
    await request("admin", "PUT", "/score-model", { rules, guide: "# Ours" });
  });

  it("previewing saves nothing; scoring saves the number and the reasons", async () => {
    const preview = await json(await request("staff", "POST", "/contacts/c1/score", { rules: rules.slice(1, 2) }));
    expect(preview.score).toBe(70);
    expect((await json(await request("staff", "GET", "/contacts/c1"))).data.score).toBe(0);
    await request("staff", "POST", "/contacts/c1/score", {});
    const contact = (await json(await request("staff", "GET", "/contacts/c1"))).data;
    expect(contact.score).toBe(50);
    expect(contact.scoreBreakdown.map((m: { id: string }) => m.id)).toEqual(["b", "c"]);
  });

  it("recalculates in pages", async () => {
    const first = await json(await request("staff", "POST", "/scores/recalculate", { limit: 1 }));
    expect(first.scored).toBe(1);
    expect(first.next).toBeTruthy();
  });
});

describe("import", () => {
  const csv = 'Correo;Nombre;Apellido;custom.area;Ignored\nnew@i.example;Ñu;"A; B";labor;x\nana@acme.example;Other;Name;;\nnew@i.example;Twice;T;;\nbad;No;Email;;\n';

  it("parses quotes and separators, and maps Spanish headers", () => {
    expect(parseCsv('a,"b ""q"", c"\n1,2\n')).toEqual([["a", 'b "q", c'], ["1", "2"]]);
    expect(mapColumns(["Correo", "Teléfono", "custom.x", "Zzz"]).fields).toEqual(["email", "phone", "custom.x", null]);
  });

  it("says what would happen, writes nothing, then does it", async () => {
    await request("admin", "POST", "/suppressions", { kind: "domain", value: "blocked.example" });
    const body = csv + "x@blocked.example;S;S;;\n";
    const preview = await json(await request("staff", "POST", "/contacts/import", { csv: body }));
    expect(preview.applied).toBe(false);
    expect(preview.summary).toEqual({ new: 1, existing: 1, repeated: 1, suppressed: 1, invalid: 1 });
    expect(preview.ignoredColumns).toEqual(["Ignored"]);
    expect((await json(await request("staff", "GET", "/contacts?search=new@i"))).data).toEqual([]);

    await request("staff", "POST", "/contacts/import", { csv: body, apply: true });
    const [created] = (await json(await request("staff", "GET", "/contacts?search=new@i"))).data;
    expect(created).toMatchObject({ firstName: "Ñu", lastName: "A; B", origin: "import", customFields: { area: "labor" } });
    // An existing contact keeps its name.
    expect((await json(await request("staff", "GET", "/contacts/c1"))).data.firstName).toBe("Ana");
  });
});

describe("the day's work", () => {
  it("tasks say where they stand", async () => {
    const now = new Date("2026-06-10T12:00:00Z");
    expect(dueState("2026-06-09", null, now)).toBe("late");
    expect(dueState("2026-06-10", null, now)).toBe("today");
    expect(dueState("2026-06-12", null, now)).toBe("soon");
    expect(dueState("2026-07-12", null, now)).toBe("later");
    expect(dueState(null, null, now)).toBe("none");
    expect(dueState("2026-06-09", "2026-06-09", now)).toBe("done");
  });

  it("the inbox and the agenda", async () => {
    await request("staff", "POST", "/activities", { type: "task", subject: "Mine", assignedTo: STAFF, priority: "high", dueDate: "2020-01-01" });
    const mine = (await json(await request("staff", "GET", "/work"))).data.find((t: { subject: string }) => t.subject === "Mine");
    expect(mine).toMatchObject({ dueState: "late", priority: "high" });
    // A day either side: `due_date` has no time zone, so near midnight UTC "now" can fall on either date.
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const agenda = (await json(await request("staff", "GET", `/agenda?from=${day(-1)}&to=${day(1)}`))).data;
    expect(agenda.map((a: { id: string }) => a.id)).toContain("a1");
    expect((await request("staff", "GET", "/agenda?from=2020-01-01&to=2030-01-01")).status).toBe(422);
  });

  it("several people on a deal, with roles", async () => {
    await client.exec("RESET ROLE");
    await client.exec(`INSERT INTO crm_contacts (id, first_name, last_name, email) VALUES ('c2', 'Bo', 'Two', 'bo@x.example')`);
    await dropToAppRole(client);
    expect((await request("staff", "POST", "/deals/d1/contacts", { contactId: "c2", role: "opposing-party" })).status).toBe(201);
    const people = (await json(await request("staff", "GET", "/deals/d1/contacts"))).data;
    expect(people.map((p: { id: string; role: string }) => [p.id, p.role])).toEqual([["c1", "primary"], ["c2", "opposing-party"]]);
    expect((await request("staff", "DELETE", "/deals/d1/contacts/c2")).status).toBe(200);
  });

  it("a private view is its owner's", async () => {
    const view = await json(await request("staff", "POST", "/views", { name: "Mine", entity: "deals", filters: { status: "open" } }));
    expect((await json(await request("staff", "GET", "/views"))).data.map((v: { id: string }) => v.id)).toContain(view.id);
    expect((await json(await request("revisor", "GET", "/views"))).data.map((v: { id: string }) => v.id)).not.toContain(view.id);
    expect((await request("revisor", "DELETE", `/views/${view.id}`)).status).toBe(404);
    expect((await request("staff", "DELETE", `/views/${view.id}`)).status).toBe(200);
  });
});

describe("custom fields and setting up a firm", () => {
  it("the preset sets up the firm, and repeating it changes nothing", async () => {
    expect((await request("staff", "POST", "/presets/law-firm/apply")).status).toBe(403);
    expect((await request("admin", "POST", "/presets/nope/apply")).status).toBe(404);
    const first = await json(await request("admin", "POST", "/presets/law-firm/apply"));
    expect(first.created).toEqual(expect.arrayContaining(["pipeline:Matters", "entity:matter", "entity:contact", "template:Engagement letter"]));
    expect(first.profiles.map((p: { profile: string }) => p.profile)).toEqual(["partner", "operations", "assistant"]);
    expect((await json(await request("admin", "POST", "/presets/law-firm/apply"))).created).toEqual([]);
  });

  it("defined fields are validated when written", async () => {
    const res = await request("staff", "PATCH", "/contacts/c1", { customFields: { kycStatus: "whatever" } });
    expect(res.status).toBe(422);
    expect((await request("staff", "PATCH", "/contacts/c1", { customFields: { kycStatus: "approved", taxId: "8-123" } })).status).toBe(200);
  });

  it("a sensitive field needs the sensitive grant", async () => {
    const custom = async (actor: Parameters<typeof request>[0]) => (await json(await request(actor, "GET", "/contacts/c1"))).data.customFields;
    expect(await custom("staff")).toEqual({ kycStatus: "approved" });
    expect(await custom("admin")).toEqual({ kycStatus: "approved", taxId: "8-123" });
    expect(await custom({ agent: ["crm:view", "crm:read-all"] })).toEqual({ kycStatus: "approved", taxId: "8-123" });
  });

  it("a template does not read a sensitive field for someone who cannot", async () => {
    const t = await json(await request("admin", "POST", "/document-templates", { name: "Id check", body: "ID {{custom.taxId}} / {{contact.customFields}}" }));
    const fill = async (actor: Parameters<typeof request>[0]) =>
      json(await request(actor, "POST", `/document-templates/${t.id}/render`, { contactId: "c1" }));
    const staff = await fill("staff");
    expect(staff.content).not.toContain("8-123");
    expect(staff.missing).toContain("custom.taxId");
    expect((await fill("admin")).content).toContain("ID 8-123");
    await request("admin", "PUT", `/document-templates/${t.id}`, { name: "Id check", body: "x", active: false });
  });

  it("documents fill from the record, and what is missing stays visible", async () => {
    expect(renderTemplate("{{deal.title}} {{ask.x}} {{constructor.name}}", { deal: { title: "T" } })).toEqual({
      content: "T {{ask.x}} {{constructor.name}}",
      missing: ["ask.x", "constructor.name"],
    });
    const templates = (await json(await request("staff", "GET", "/document-templates"))).data;
    const letter = templates.find((t: { name: string }) => t.name === "Engagement letter");
    const out = await json(
      await request("staff", "POST", `/document-templates/${letter.id}/render`, { dealId: "d1", values: { fees: "100", scope: "S", signatory: "Me" } })
    );
    expect(out.content).toContain("Dear Ana One");
    expect(out.content).toContain('"Labor claim"');
    expect(out.missing).toEqual(["custom.matterNumber", "custom.feeType"]);
  });

  it("a template switched off leaves the list, and an admin can still find it to switch it on", async () => {
    const all = (await json(await request("admin", "GET", "/document-templates?include=all"))).data;
    const reminder = all.find((t: { name: string }) => t.name === "Payment reminder");
    await request("admin", "PUT", `/document-templates/${reminder.id}`, { name: reminder.name, body: reminder.body, active: false });
    const names = async (path: string) => (await json(await request("staff", "GET", path))).data.map((t: { name: string }) => t.name);
    expect(await names("/document-templates")).not.toContain("Payment reminder");
    expect(await names("/document-templates?include=all")).toContain("Payment reminder");
  });
});

describe("presets are data, not code", () => {
  it("another business is another file", async () => {
    const { mkdtempSync, writeFileSync, copyFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { loadPresets } = await import("../../kons/kon-crm/crm.presets");
    const dir = mkdtempSync(resolve(tmpdir(), "presets-"));
    copyFileSync(resolve(__dirname, "../../kons/kon-crm/presets/law-firm.json"), resolve(dir, "law-firm.json"));
    writeFileSync(
      resolve(dir, "agency.json"),
      JSON.stringify({
        id: "agency",
        name: "Design agency",
        description: "Projects billed by the day.",
        entity: { name: "project", singular: "Project", plural: "Projects" },
        contactFields: [],
        dealFields: [{ key: "brief", label: "Brief", type: "text" }],
        pipeline: "Projects",
        stages: [{ name: "Pitch", probability: 20 }],
        conta: { labels: { resource: { singular: "Designer", plural: "Designers" } } },
      })
    );
    const presets = loadPresets(dir);
    expect([...presets.keys()]).toEqual(["agency", "law-firm"]);
    expect(presets.get("agency")!.dealContactRoles).toEqual([]);
    writeFileSync(resolve(dir, "broken.json"), JSON.stringify({ id: "Broken!" }));
    expect(() => loadPresets(dir)).toThrow(/broken\.json/);
  });

  it("the shipped presets list", async () => {
    const list = (await json(await request("staff", "GET", "/presets"))).data;
    expect(list.map((p: { id: string }) => p.id)).toContain("law-firm");
  });
});

/**
 * kon-crm: the dials hold on every path, not only on the way out (audit 2026-11-19, fixed 2026-11-21)
 * ============================================================================
 *
 * `applyAccess` removes amounts, notes and hidden custom fields from responses. These paths went around it:
 * a deal pointed at a contact the subject could not see made that contact visible; a score preview and an
 * observation replay answered about hidden fields; a template read the company's revenue; a portal link
 * handed the statement to someone without amounts; a write replaced or set hidden custom fields; reports
 * read the CRM's money and notes columns; portal links and merge requests had no record scope.
 *
 * Real routes on PGlite with every migration of the kon, as a NON-superuser role, so RLS runs.
 */

import type { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { registerCrmPolicy } from "../../kons/kon-crm/crm.policy";
import { createCRMRouter } from "../../kons/kon-crm/crm.routes";

import { ACTORS, dropToAppRole, migratedBase, requestAs, sqlAs, testAuth } from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
const PIPELINE = "pipeline_sec";
const STAGE = "stage_sec";
const STAFF = ACTORS.staff.id;
const REVIEWER = ACTORS.revisor.id;

const json = (res: Response): Promise<any> => res.json();
const ids = async (res: Response) => (await json(res)).data.map((r: { id: string }) => r.id);

beforeAll(async () => {
  const dir = resolve(__dirname, "../../kons/kon-crm/migrations");
  client = await migratedBase("kon-crm", readdirSync(dir).filter((f) => f.endsWith(".sql")).sort());
  await client.exec(`
    INSERT INTO crm_entity_configs (id, kon_id, entity_name, singular_label, plural_label, field_schema, is_active) VALUES
      ('ec_sec', 'kon-crm', 'contact', 'Contact', 'Contacts',
       '[{"key":"taxId","label":"Tax ID","type":"text","sensitive":true},{"key":"budget","label":"Budget","type":"currency"},{"key":"tier","label":"Tier","type":"text"}]', true);
    INSERT INTO crm_pipelines (id, name) VALUES ('${PIPELINE}', 'P');
    INSERT INTO crm_pipeline_stages (id, pipeline_id, name, "order") VALUES ('${STAGE}', '${PIPELINE}', 'S', 0);
    INSERT INTO crm_companies (id, name, annual_revenue, created_by) VALUES
      ('co_mine', 'Mine Inc', 777777, '${STAFF}'),
      ('co_other', 'Other Inc', 999999, '${REVIEWER}');
    INSERT INTO crm_contacts (id, first_name, last_name, email, assigned_to, created_by, company_id, custom_fields) VALUES
      ('c_mine', 'Mia', 'One', 'mia@example.com', '${STAFF}', '${STAFF}', 'co_mine', '{"taxId":"8-123","budget":5000,"tier":"gold"}'),
      ('c_other', 'Oto', 'Two', 'oto@example.com', '${REVIEWER}', '${REVIEWER}', NULL, '{}'),
      ('c_other2', 'Ota', 'Three', 'ota@example.com', '${REVIEWER}', '${REVIEWER}', NULL, '{}');
    INSERT INTO crm_deals (id, title, value, pipeline_id, stage_id, contact_id, assigned_to, created_by) VALUES
      ('d_mine', 'Mine', 500, '${PIPELINE}', '${STAGE}', 'c_mine', '${STAFF}', '${STAFF}');
    INSERT INTO crm_portal_links (id, contact_id, token_hash, expires_at, created_by) VALUES
      ('pl_mine', 'c_mine', 'hash-mine', now() + interval '1 day', '${STAFF}'),
      ('pl_other', 'c_other', 'hash-other', now() + interval '1 day', '${REVIEWER}');
    INSERT INTO crm_merge_requests (id, contact_id, other_id, requested_by) VALUES
      ('mr_other', 'c_other', 'c_other2', 'agent-x');
  `);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never });
  request = requestAs(host.mount(createCRMRouter(ctx)));
  registerCrmPolicy();
  const granted = await request("admin", "PUT", `/access/user/${STAFF}`, {
    reason: "test",
    records: "assigned",
    money: false,
    sensitive: false,
  });
  expect(granted.status).toBe(200);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => registerCrmPolicy());

describe("finding 6: a reference does not adopt a record", () => {
  it("a deal cannot point at a contact or company the subject cannot see", async () => {
    const base = { title: "Sneak", pipelineId: PIPELINE, stageId: STAGE };
    expect((await request("staff", "POST", "/deals", { ...base, contactId: "c_other" })).status).toBe(404);
    expect((await request("staff", "POST", "/deals", { ...base, companyId: "co_other" })).status).toBe(404);
    expect((await request("staff", "PATCH", "/deals/d_mine", { contactId: "c_other" })).status).toBe(404);
    expect((await request("staff", "GET", "/contacts/c_other")).status).toBe(404);
    expect((await request("staff", "GET", "/companies/co_other")).status).toBe(404);
  });

  it("nor an activity, nor a contact's company", async () => {
    expect((await request("staff", "POST", "/activities", { type: "note", subject: "x", contactId: "c_other" })).status).toBe(404);
    expect((await request("staff", "PATCH", "/contacts/c_mine", { companyId: "co_other" })).status).toBe(404);
    expect((await request("staff", "GET", "/companies/co_other")).status).toBe(404);
  });

  it("the database refuses it too, whatever path writes", async () => {
    await expect(
      sqlAs(client, "staff", `INSERT INTO crm_deals (id, title, pipeline_id, stage_id, contact_id, assigned_to, created_by)
        VALUES ('d_sneak', 'x', '${PIPELINE}', '${STAGE}', 'c_other', '${STAFF}', '${STAFF}')`)
    ).rejects.toThrow(/row-level security/);
    await expect(
      sqlAs(client, "staff", `INSERT INTO crm_deal_contacts (deal_id, contact_id) VALUES ('d_mine', 'c_other')`)
    ).rejects.toThrow(/row-level security/);
    await expect(sqlAs(client, "staff", `UPDATE crm_contacts SET company_id = 'co_other' WHERE id = 'c_mine'`)).rejects.toThrow(
      /row-level security/
    );
  });

  it("what the subject sees stays usable, and the team is not limited", async () => {
    const own = await request("staff", "POST", "/deals", { title: "Own", pipelineId: PIPELINE, stageId: STAGE, contactId: "c_mine", companyId: "co_mine" });
    expect(own.status).toBe(201);
    const team = await request("revisor", "POST", "/deals", { title: "Team", pipelineId: PIPELINE, stageId: STAGE, contactId: "c_other2" });
    expect(team.status).toBe(201);
  });
});

describe("finding 7: a score preview is not an oracle for hidden fields", () => {
  it("a rule on a sensitive or currency field never matches for someone who cannot read it", async () => {
    const rules = [
      { id: "tax", label: "Tax", signal: "custom.taxId", op: "==", value: "8-123", points: 10 },
      { id: "budget", label: "Budget", signal: "custom.budget", op: ">=", value: 1000, points: 20 },
      { id: "tier", label: "Tier", signal: "custom.tier", op: "==", value: "gold", points: 5 },
    ];
    const staff = await json(await request("staff", "POST", "/contacts/c_mine/score", { rules }));
    expect(staff.matched.map((m: { id: string }) => m.id)).toEqual(["tier"]);
    const admin = await json(await request("admin", "POST", "/contacts/c_mine/score", { rules }));
    expect(admin.score).toBe(35);
  });
});

describe("finding 8: a template does not read amounts", () => {
  it("the company's revenue stays missing without the money dial", async () => {
    const t = await json(
      await request("admin", "POST", "/document-templates", { name: "Revenue", body: "R {{company.annualRevenue}} V {{deal.value}}" })
    );
    const staff = await json(await request("staff", "POST", `/document-templates/${t.id}/render`, { dealId: "d_mine" }));
    expect(staff.content).not.toContain("777777");
    expect(staff.missing).toContain("company.annualRevenue");
    const admin = await json(await request("admin", "POST", `/document-templates/${t.id}/render`, { dealId: "d_mine" }));
    expect(admin.content).toContain("R 777777");
  });
});

describe("finding 16: a portal statement needs the money dial", () => {
  it("showStatement is refused without access to amounts", async () => {
    expect((await request("staff", "POST", "/portal-links", { contactId: "c_mine", showStatement: true })).status).toBe(403);
    expect((await request("staff", "POST", "/portal-links", { contactId: "c_mine" })).status).toBe(201);
  });
});

describe("finding 17: writes respect hidden custom fields", () => {
  it("setting a hidden field is refused", async () => {
    expect((await request("staff", "PATCH", "/contacts/c_mine", { customFields: { taxId: "0-000" } })).status).toBe(403);
    expect((await request("staff", "PATCH", "/contacts/c_mine", { customFields: { budget: 1 } })).status).toBe(403);
    expect(
      (await request("staff", "POST", "/contacts", { firstName: "N", lastName: "W", email: "nw@example.com", customFields: { taxId: "1" } })).status
    ).toBe(403);
  });

  it("replacing customFields keeps the hidden values", async () => {
    expect((await request("staff", "PATCH", "/contacts/c_mine", { customFields: { tier: "silver" } })).status).toBe(200);
    const stored = (await json(await request("admin", "GET", "/contacts/c_mine"))).data.customFields;
    expect(stored).toEqual({ taxId: "8-123", budget: 5000, tier: "silver" });
  });
});

describe("finding 22: reports keep the CRM's amounts and notes from agents", () => {
  it("kon.json restricts money and notes columns, and every listed column exists", async () => {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../kons/kon-crm/kon.json"), "utf8"));
    const { konReportAccess } = await import("../../.kitsuden/apps/api/src/lib/aggregate");
    const access = konReportAccess(manifest);
    expect(access.agentScope).toBe("crm:view");
    expect(access.restrictedScope).toBe("crm:read-all");
    expect([...(access.restricted.get("crm_deals") ?? [])]).toEqual(expect.arrayContaining(["value", "lost_notes", "custom_fields"]));
    expect([...(access.restricted.get("crm_companies") ?? [])]).toEqual(expect.arrayContaining(["annual_revenue"]));
    expect([...(access.restricted.get("crm_contacts") ?? [])]).toEqual(expect.arrayContaining(["notes", "custom_fields"]));
    expect([...(access.restricted.get("crm_activities") ?? [])]).toEqual(expect.arrayContaining(["description", "outcome"]));
    for (const [table, columns] of access.restricted) {
      const found = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table]
      );
      const names = found.rows.map((r) => r.column_name);
      for (const column of columns) expect(names, `${table}.${column}`).toContain(column);
    }
  });
});

describe("finding 26: portal links and merge requests follow the record scope", () => {
  it("someone limited to assigned records sees only links and requests on what it sees", async () => {
    const links = await ids(await request("staff", "GET", "/portal-links"));
    expect(links).toContain("pl_mine");
    expect(links).not.toContain("pl_other");
    expect(await ids(await request("staff", "GET", "/merge-requests"))).not.toContain("mr_other");
    expect(await ids(await request("admin", "GET", "/merge-requests"))).toContain("mr_other");
    expect(await ids(await request("revisor", "GET", "/portal-links"))).toContain("pl_other");
  });
});

describe("finding 28: an observation replay does not show a hidden field", () => {
  it("repeating someone else's externalRef on a hidden field is refused", async () => {
    const admin = await request("admin", "POST", "/observations", {
      entityType: "contact",
      entityId: "c_mine",
      field: "custom.taxId",
      value: "8-123",
      source: "kyc",
      evidence: "confirmed-by-person",
      externalRef: "kyc:c_mine:taxId",
    });
    expect(admin.status).toBe(201);
    const replay = await request("staff", "POST", "/observations", {
      entityType: "contact",
      entityId: "c_mine",
      field: "jobTitle",
      value: "CFO",
      source: "x",
      evidence: "own-profile",
      externalRef: "kyc:c_mine:taxId",
    });
    expect(replay.status).toBe(403);
    expect(JSON.stringify(await json(replay))).not.toContain("8-123");
  });
});

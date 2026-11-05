/**
 * Observed data: the evidence decides what reaches a record, and a person settles the rest
 * ============================================================================
 *
 * Every kon-crm migration on PGlite as a NON-superuser role. An agent records what it saw; it never says how sure
 * it is. What these tests hold: strong evidence writes, weak evidence waits, several sources add up, a value a
 * person typed is never overwritten, a rejected value never applies by itself again, only a person settles a
 * suggestion, and an observation of a field someone cannot read is neither recorded by them nor shown to them.
 */

import type { PGlite } from "@electric-sql/pglite";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { registerCrmPolicy } from "../../kons/kon-crm/crm.policy";
import { createCRMRouter } from "../../kons/kon-crm/crm.routes";

import { dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
const json = (res: Response): Promise<any> => res.json();
const AGENT = { agent: ["crm:view", "crm:edit"] };

beforeAll(async () => {
  const dir = resolve(__dirname, "../../kons/kon-crm/migrations");
  client = await migratedBase("kon-crm", readdirSync(dir).filter((f) => f.endsWith(".sql")).sort());
  await client.exec(`
    INSERT INTO crm_entity_configs (id, kon_id, entity_name, singular_label, plural_label, field_schema, is_active) VALUES
      ('ec1', 'kon-crm', 'contact', 'Contact', 'Contacts',
       '[{"key":"taxId","label":"Tax ID","type":"text","sensitive":true},{"key":"seniority","label":"Seniority","type":"select","options":["junior","senior"]}]', true);
    INSERT INTO crm_contacts (id, first_name, last_name, email) VALUES ('c1', 'Ana', 'Ortega', 'ana@acme.example');
    INSERT INTO crm_companies (id, name) VALUES ('co1', 'Acme');
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

const observe = (actor: Parameters<typeof request>[0], body: Record<string, unknown>) =>
  request(actor, "POST", "/observations", { entityType: "contact", entityId: "c1", ...body });
const contact = async () => (await json(await request("admin", "GET", "/contacts/c1"))).data;

describe("how evidence is weighed", () => {
  it("everyone on the team can read it; only an admin changes it", async () => {
    const policy = await json(await request("staff", "GET", "/evidence-policy"));
    expect(policy.applyAt).toBe(70);
    expect(policy.kinds.find((k: { key: string }) => k.key === "own-email-signature").weight).toBe(80);
    expect((await request("staff", "PUT", "/evidence-policy", { applyAt: 10 })).status).toBe(403);
    const changed = await json(await request("admin", "PUT", "/evidence-policy", { kinds: [{ key: "court-record", label: "A public court record", weight: 90 }] }));
    expect(changed.kinds.find((k: { key: string }) => k.key === "court-record")).toMatchObject({ weight: 90, active: true });
  });
});

describe("recording what was seen", () => {
  it("strong evidence on an empty field writes it to the record", async () => {
    const r = await json(await observe(AGENT, { field: "jobTitle", value: "CFO", source: "email:m1", evidence: "own-email-signature" }));
    expect(r.outcome).toBe("applied");
    expect((await contact()).jobTitle).toBe("CFO");
  });

  it("weak evidence waits for a person, and says why", async () => {
    const r = await json(await observe(AGENT, { field: "jobTitle", value: "CEO", source: "news.example", evidence: "web-mention" }));
    expect(r).toMatchObject({ outcome: "suggested", weight: 15 });
    expect(r.data.reason).toMatch(/weighs 15, under 70/);
    expect((await contact()).jobTitle).toBe("CFO");
  });

  it("different sources that saw the same value add up, and may replace a value an observation wrote", async () => {
    const second = await json(await observe(AGENT, { field: "jobTitle", value: "CEO", source: "provider-x", evidence: "data-provider" }));
    expect(second).toMatchObject({ outcome: "suggested", weight: 45 });
    const third = await json(await observe(AGENT, { field: "jobTitle", value: "CEO", source: "acme.example/team", evidence: "company-website" }));
    expect(third).toMatchObject({ outcome: "applied", weight: 95 });
    expect(third.data.previousValue).toBe("CFO");
    expect((await contact()).jobTitle).toBe("CEO");
  });

  it("the same source twice does not count twice", async () => {
    await observe(AGENT, { field: "city", value: "Lima", source: "news.example", evidence: "web-mention" });
    const again = await json(await observe(AGENT, { field: "city", value: "Lima", source: "news.example", evidence: "web-mention" }));
    expect(again.weight).toBe(15);
  });

  it("a value a person typed is never overwritten, however strong the evidence", async () => {
    await request("staff", "PATCH", "/contacts/c1", { phone: "+51 111" });
    const r = await json(await observe(AGENT, { field: "phone", value: "+51 222", source: "email:m2", evidence: "confirmed-by-person" }));
    expect(r.outcome).toBe("suggested");
    expect(r.data.reason).toMatch(/a person set/);
    expect((await contact()).phone).toBe("+51 111");
  });

  it("seeing what the record already says is a confirmation", async () => {
    expect((await json(await observe(AGENT, { field: "email", value: "ana@acme.example", source: "email:m3", evidence: "own-email-signature" }))).outcome).toBe("confirmed");
  });

  it("refuses what cannot be observed, an unknown kind of evidence, and a confidence instead of evidence", async () => {
    expect((await observe(AGENT, { field: "score", value: "99", source: "x", evidence: "inferred" })).status).toBe(422);
    expect((await observe(AGENT, { field: "jobTitle", value: "x", source: "x", evidence: "pretty-sure" })).status).toBe(422);
    expect((await observe(AGENT, { field: "jobTitle", value: "x", source: "x", evidence: "inferred", confidence: 0.99 })).status).toBe(422);
    expect((await observe(AGENT, { field: "custom.seniority", value: "boss", source: "x", evidence: "inferred" })).status).toBe(422);
    expect((await request(AGENT, "POST", "/observations", { entityType: "company", entityId: "co1", field: "annualRevenue", value: "1", source: "x", evidence: "inferred" })).status).toBe(422);
    expect((await observe(AGENT, { entityId: "nope", field: "jobTitle", value: "x", source: "x", evidence: "inferred" })).status).toBe(404);
  });

  it("repeating an externalRef records once", async () => {
    const body = { field: "country", value: "Peru", source: "provider-x", evidence: "data-provider", externalRef: "px-1" };
    const first = await json(await observe(AGENT, body));
    const again = await json(await observe(AGENT, body));
    expect(again).toMatchObject({ created: false });
    expect(again.data.id).toBe(first.data.id);
  });
});

describe("a person settles the suggestions", () => {
  it("an agent cannot; a person accepts and the value is written", async () => {
    const pending = (await json(await request("staff", "GET", "/observations?status=suggested&field=phone"))).data[0];
    expect((await request(AGENT, "POST", `/observations/${pending.id}/accept`, {})).status).toBe(403);
    const accepted = (await json(await request("staff", "POST", `/observations/${pending.id}/accept`, { note: "called her" }))).data;
    expect(accepted).toMatchObject({ status: "accepted", previousValue: "+51 111", decisionNote: "called her" });
    expect((await contact()).phone).toBe("+51 222");
    expect((await request("staff", "POST", `/observations/${pending.id}/accept`, {})).status).toBe(409);
  });

  it("a rejected value never applies by itself again", async () => {
    const r = await json(await observe(AGENT, { field: "department", value: "Sales", source: "news.example", evidence: "web-mention" }));
    await request("staff", "POST", `/observations/${r.data.id}/reject`, { note: "she is in Finance" });
    const strong = await json(await observe(AGENT, { field: "department", value: "Sales", source: "email:m9", evidence: "confirmed-by-person" }));
    expect(strong.outcome).toBe("suggested");
    expect(strong.data.reason).toMatch(/rejected this value before/);
    expect((await contact()).department).toBeNull();
  });
});

describe("sensitive fields", () => {
  it("someone who cannot read a field cannot record it, nor see what others recorded", async () => {
    expect((await observe(AGENT, { field: "custom.taxId", value: "8-123", source: "x", evidence: "own-profile" })).status).toBe(403);
    const r = await json(await observe("admin", { field: "custom.taxId", value: "8-123", source: "kyc-form", evidence: "confirmed-by-person" }));
    expect(r.outcome).toBe("applied");
    const fields = async (actor: Parameters<typeof request>[0]) =>
      (await json(await request(actor, "GET", "/observations?entityId=c1"))).data.map((o: { field: string }) => o.field);
    expect(await fields("staff")).not.toContain("custom.taxId");
    expect(await fields("admin")).toContain("custom.taxId");
    expect((await request("staff", "POST", `/observations/${r.data.id}/reject`, {})).status).toBe(404);
  });
});

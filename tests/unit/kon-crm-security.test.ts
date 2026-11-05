/**
 * kon-crm — the portfolio belongs to the team, not to anyone with an account
 * ============================================================================
 *
 * Before 2026-10-15 all routes used only `requireAuth`, and sign-up is
 * public: registering was enough to read, edit and DELETE contacts, companies,
 * opportunities and pipelines. Also `createdBy` came from the body, `fileUrl`
 * accepted `javascript:`, `/deals/:id/move` was registered twice (the
 * one that validated stage requirements never ran) and `/reorder`
 * changed stage without validating anything.
 *
 * Real routes on PGlite with the kon's migrations, as a NON-superuser
 * role (RLS actually runs).
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { registerCrmPolicy } from "../../kons/kon-crm/crm.policy";
import { createCRMRouter } from "../../kons/kon-crm/crm.routes";

import {
  USERS,
  testAuth,
  databaseWithRls,
  asAppRole,
  requestAs,
  sqlAs,
} from "./helpers/kon-with-users";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
let contactId: string;
let dealId: string;

async function json(res: Response): Promise<any> {
  return res.json();
}

beforeAll(async () => {
  client = await databaseWithRls("kon-crm", [
    "0000_initial.sql",
    "0001_crm_builder_phase1.sql",
    "0002_media_integration.sql",
    "0003_lost_reason.sql",
    "0004_team_rls.sql",
    "0005_system_without_user.sql",
    "0006_english_names.sql",
    "0007_english_rls.sql",
    "0008_access_and_suppressions.sql",
    "0009_crm_platform.sql",
    "0010_work_details.sql",
    "0011_observations.sql",
    "0012_inbound_email.sql",
  ]);
  // A second pipeline, and a requirement on the "Propuesta" stage.
  await client.exec(`
    INSERT INTO crm_pipelines (id, name) VALUES ('pipeline_other', 'Other');
    INSERT INTO crm_pipeline_stages (id, pipeline_id, name, "order") VALUES ('stage_other', 'pipeline_other', 'Elsewhere', 0);
    UPDATE crm_pipeline_stages SET entry_requirements = '{"requiredFields":["presupuesto"]}' WHERE id = 'stage_proposal';
  `);
  const db = await asAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({
    db: host.db as never,
    auth: auth as never,
  });
  request = requestAs(host.mount(createCRMRouter(ctx)));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerCrmPolicy();
});

describe("having an account is not being on the team", () => {
  it("anonymous: 401 on everything", async () => {
    for (const route of ["/contacts", "/companies", "/deals", "/stats", "/pipelines"]) {
      expect((await request("anon", "GET", route)).status, route).toBe(401);
    }
    expect(
      (await request("anon", "POST", "/contacts", { firstName: "x", lastName: "y", email: "a@b.co" }))
        .status
    ).toBe(401);
  });

  it("user with an account: 403 on read and write", async () => {
    for (const route of [
      "/contacts",
      "/companies",
      "/deals",
      "/stats",
      "/pipelines/pipeline_default_sales/kanban",
    ]) {
      expect((await request("a", "GET", route)).status, route).toBe(403);
    }
    expect(
      (await request("a", "POST", "/contacts", { firstName: "x", lastName: "y", email: "a@b.co" }))
        .status
    ).toBe(403);
  });
});

describe("the team works the portfolio", () => {
  it("createdBy in the body is rejected; the author comes from the session", async () => {
    const base = {
      firstName: "Lucy",
      lastName: "Luna",
      email: "lucy@client.test",
      phone: "+34 600",
    };
    expect(
      (await request("staff", "POST", "/contacts", { ...base, createdBy: USERS.admin.id })).status
    ).toBe(422);
    const res = await request("staff", "POST", "/contacts", base);
    expect(res.status).toBe(201);
    const { data } = await json(res);
    expect(data.createdBy).toBe(USERS.staff.id);
    contactId = data.id;
  });

  it("the editor reads what the team has", async () => {
    const { data } = await json(await request("staff", "GET", "/contacts?search=lu"));
    expect(data.map((c: any) => c.id)).toContain(contactId);
  });

  it("a negative offset is not a 500", async () => {
    expect((await request("staff", "GET", "/contacts?offset=-5&limit=99999")).status).toBe(200);
  });

  it("a javascript: link in a document is rejected", async () => {
    const deal = await json(
      await request("staff", "POST", "/deals", {
        title: "Licencias",
        pipelineId: "pipeline_default_sales",
        stageId: "stage_lead",
        contactId: contactId,
      })
    );
    dealId = deal.data.id;
    const res = await request("staff", "POST", "/documents", {
      dealId,
      name: "contract",
      fileUrl: "javascript:alert(document.cookie)",
    });
    expect(res.status).toBe(422);
  });

  it("an opportunity is not created in a stage of another pipeline", async () => {
    const res = await request("staff", "POST", "/deals", {
      title: "Cruzada",
      pipelineId: "pipeline_default_sales",
      stageId: "stage_other",
    });
    expect(res.status).toBe(422);
  });
});

describe("moving opportunities respects the stages", () => {
  it("the route that runs is the one that VALIDATES the requirements", async () => {
    const res = await request("staff", "POST", `/deals/${dealId}/move`, {
      targetStageId: "stage_proposal",
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.details.missingFields[0].key).toBe("presupuesto");
  });

  it("skipping validation is for admin", async () => {
    expect(
      (
        await request("staff", "POST", `/deals/${dealId}/move`, {
          targetStageId: "stage_proposal",
          skipValidation: true,
        })
      ).status
    ).toBe(403);
    expect(
      (
        await request("admin", "POST", `/deals/${dealId}/move`, {
          targetStageId: "stage_proposal",
          skipValidation: true,
        })
      ).status
    ).toBe(200);
  });

  it("it does not move to a stage of another pipeline", async () => {
    expect(
      (
        await request("admin", "POST", `/deals/${dealId}/move`, {
          targetStageId: "stage_other",
          skipValidation: true,
        })
      ).status
    ).toBe(422);
  });

  it("reorder does not change stage or accept endless lists", async () => {
    expect(
      (
        await request("staff", "POST", "/deals/reorder", {
          deals: [{ id: dealId, stageId: "stage_closed_won", order: 0 }],
        })
      ).status
    ).toBe(422);
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `d${i}`, stageId: "s", order: i }));
    expect((await request("staff", "POST", "/deals/reorder", { deals: many })).status).toBe(422);
  });

  it("PATCH does not change stage (that is /move)", async () => {
    expect(
      (await request("staff", "PATCH", `/deals/${dealId}`, { stageId: "stage_closed_won" })).status
    ).toBe(422);
  });

  /**
   * Phase D (e2e, 2026-10-25): creating an opportunity takes the probability of its
   * stage, but moving it left it with that of the ORIGIN stage (10 % in
   * "Proposal"): the weighted forecast in /stats lied after every move.
   */
  it("on moving it, the probability becomes that of the destination stage", async () => {
    const createdItem = await json(
      await request("staff", "POST", "/deals", {
        title: "Probabilidad",
        pipelineId: "pipeline_default_sales",
        stageId: "stage_lead",
      })
    );
    const before = createdItem.data.probability;
    const res = await request("staff", "POST", `/deals/${createdItem.data.id}/move`, {
      targetStageId: "stage_qualified",
    });
    expect(res.status).toBe(200);
    const moved = (await json(res)).data;
    expect(moved.stageId).toBe("stage_qualified");
    expect(before).not.toBe(25);
    expect(moved.probability).toBe(25);
  });
});

describe("deleting and configuring is for admin", () => {
  it("the editor does not delete contacts or touch pipelines; the admin does", async () => {
    expect((await request("staff", "DELETE", `/contacts/${contactId}`)).status).toBe(403);
    expect((await request("staff", "POST", "/pipelines", { name: "Mine" })).status).toBe(403);
    expect(
      (await request("staff", "PATCH", "/pipeline-stages/stage_lead/config", { estimatedDays: 1 }))
        .status
    ).toBe(403);
    expect((await request("admin", "POST", "/pipelines", { name: "New" })).status).toBe(201);
  });

  it("an activity is deleted by its author or an admin", async () => {
    const fromAdmin = (
      await json(await request("admin", "POST", "/activities", { type: "call", subject: "Call" }))
    ).data;
    const fromStaff = (
      await json(await request("staff", "POST", "/activities", { type: "note", subject: "Note" }))
    ).data;
    expect((await request("staff", "DELETE", `/activities/${fromAdmin.id}`)).status).toBe(403);
    expect((await request("staff", "DELETE", `/activities/${fromStaff.id}`)).status).toBe(200);
    expect((await request("admin", "DELETE", `/activities/${fromAdmin.id}`)).status).toBe(200);
  });

  it("the admin deletes the contact", async () => {
    expect((await request("admin", "DELETE", `/contacts/${contactId}`)).status).toBe(200);
  });
});

/**
 * When moving the kon to the SDK (2026-10-26): what used to come out as a 500 "Failed to
 * …" and was the input's fault.
 */
describe("what used to be 500s are 4xx", () => {
  it("a reference to a row that does not exist is 409", async () => {
    const res = await request("admin", "POST", "/activities", {
      type: "call",
      subject: "Orphan",
      dealId: "does-not-exist",
    });
    expect(res.status).toBe(409);
    expect(
      (await request("admin", "POST", "/pipelines/does-not-exist/stages", { name: "No pipeline" })).status
    ).toBe(409);
  });

  it("a date that does not exist is 422, not an Invalid Date in the database", async () => {
    expect(
      (await request("staff", "PATCH", `/deals/${dealId}`, { expectedCloseDate: "2024-13-45" }))
        .status
    ).toBe(422);
  });

  it("an unreadable date in cycle-time is 400", async () => {
    const res = await request(
      "staff",
      "GET",
      "/analytics/cycle-time?pipelineId=pipeline_default_sales&startDate=nunca"
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toBe("startDate is not a valid date");
  });
});

describe("RLS by role in the database", () => {
  it("a user or an anonymous visitor sees no CRM rows; the team does", async () => {
    expect(await sqlAs(client, "a", `select id from crm_pipelines`)).toHaveLength(0);
    expect(await sqlAs(client, "anon", `select id from crm_deals`)).toHaveLength(0);
    expect(
      (await sqlAs(client, "staff", `select id from crm_pipelines`)).length
    ).toBeGreaterThan(0);
  });

  it("a user cannot insert a contact even with direct SQL", async () => {
    await expect(
      sqlAs(
        client,
        "a",
        `insert into crm_contacts (id, first_name, last_name, email) values ('x1', 'a', 'b', 'c@d.e')`
      )
    ).rejects.toThrow(/row-level security/i);
  });
});

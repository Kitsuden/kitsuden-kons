/**
 * The generic CRM and the generic ledger, together, carrying the law-firm example
 * ============================================================================
 *
 * Both kons' migrations on one PGlite, as a NON-superuser role. The preset gives kon-conta its words; work and
 * expenses logged on a deal reach the ledger as unbilled work on the deal's project, without the person being on
 * the accounting team.
 */

import type { PGlite } from "@electric-sql/pglite";
import { PGlite as PGliteClass } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { ContaService } from "../../kons/kon-conta/conta.service";
import { registerCrmPolicy } from "../../kons/kon-crm/crm.policy";
import { createCRMRouter } from "../../kons/kon-crm/crm.routes";

import { ACTORS, AGENT_FUNCTIONS, requestAs, testAuth } from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
const ROLE = "crm_conta_app";
const json = (res: Response): Promise<any> => res.json();
const migrations = (kon: string) => {
  const dir = resolve(__dirname, `../../kons/${kon}/migrations`);
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(resolve(dir, f), "utf8"));
};

async function asSuperuser<T>(fn: () => Promise<T>): Promise<T> {
  await client.exec("RESET ROLE");
  try {
    return await fn();
  } finally {
    await client.exec(`SET ROLE ${ROLE}`);
  }
}

beforeAll(async () => {
  client = new PGliteClass();
  await client.exec(readFileSync(AGENT_FUNCTIONS, "utf8"));
  for (const sql of [...migrations("kon-crm"), ...migrations("kon-conta")]) await client.exec(sql);
  await client.exec(`
    CREATE ROLE ${ROLE} NOLOGIN;
    GRANT USAGE ON SCHEMA public TO ${ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE};
    INSERT INTO crm_companies (id, name) VALUES ('co1', 'Acme');
    INSERT INTO crm_contacts (id, first_name, last_name, email) VALUES ('c9', 'Lia', 'Mar', 'lia@example.com');
  `);
  // What kon-conta does on startup in a real install.
  await new ContaService(drizzle(client) as never).seedDefaultAccounts();
  await client.exec(`SET ROLE ${ROLE}`);
  const db = drizzle(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never });
  request = requestAs(host.mount(createCRMRouter(ctx)));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => registerCrmPolicy());

describe("a law firm on the generic CRM and ledger", () => {
  let dealId: string;

  it("the preset gives the ledger its words", async () => {
    const applied = await json(await request("admin", "POST", "/presets/law-firm/apply"));
    expect(applied.conta).toBe(true);
    const settings = await asSuperuser(() => client.query<{ labels: any }>("SELECT labels FROM conta_settings"));
    expect(settings.rows[0]!.labels.project).toEqual({ singular: "Matter", plural: "Matters" });
    expect(settings.rows[0]!.labels.resource).toEqual({ singular: "Lawyer", plural: "Lawyers" });
  });

  it("work logged on a deal becomes unbilled work on its project, by someone outside accounting", async () => {
    const pipeline = applied();
    const res = await request("staff", "POST", "/deals", { title: "Labor claim", pipelineId: (await pipeline).id, stageId: (await pipeline).stageId, companyId: "co1", assignedTo: ACTORS.staff.id, customFields: { feeType: "time", practiceArea: "labor" } });
    expect(res.status).toBe(201);
    dealId = (await json(res)).data.id;
    await asSuperuser(() =>
      client.exec(`INSERT INTO conta_resources (id, name, user_id, billing_rate, cost_rate, unit)
                   VALUES ('r1', 'Staff', '${ACTORS.staff.id}', '150.00', '60.00', 'hour')`)
    );
    const logged = await request("staff", "POST", `/deals/${dealId}/work`, { quantity: 1.5, description: "Hearing prep", externalRef: "w1" });
    expect(logged.status).toBe(201);
    const again = await json(await request("staff", "POST", `/deals/${dealId}/work`, { quantity: 1.5, description: "Hearing prep", externalRef: "w1" }));
    expect(again.created).toBe(false);
    const rows = await asSuperuser(() =>
      client.query<{ external_ref: string; name: string }>(`SELECT p.external_ref, p.name FROM conta_projects p WHERE p.external_ref = '${dealId}'`)
    );
    expect(rows.rows).toEqual([{ external_ref: dealId, name: "Labor claim" }]);
  });

  it("an expense goes to the same project; the person needs no accounting role", async () => {
    expect((await request("staff", "POST", `/deals/${dealId}/expenses`, { amount: 30, description: "Courier", externalRef: "e1" })).status).toBe(201);
  });

  it("an expense from the client's funds is refused when nothing was deposited", async () => {
    const res = await request("staff", "POST", `/deals/${dealId}/expenses`, { amount: 30, description: "Court fee", fromClientFunds: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("the project carries what the ledger groups by: number, billing type, category and who is responsible", async () => {
    const res = await json(await request("staff", "POST", `/deals/${dealId}/project`));
    expect(res).toMatchObject({ projectNumber: "M-0001", created: false });
    const [project] = (
      await asSuperuser(() =>
        client.query<{ billing_type: string; category: string; responsible_resource_id: string; number: string }>(
          `SELECT billing_type, category, responsible_resource_id, number FROM conta_projects WHERE external_ref = '${dealId}'`
        )
      )
    ).rows;
    expect(project).toEqual({ billing_type: "time", category: "labor", responsible_resource_id: "r1", number: "M-0001" });
  });

  it("renaming the deal renames the project on the next call", async () => {
    await request("staff", "PATCH", `/deals/${dealId}`, { title: "Labor claim (appeal)" });
    await request("staff", "POST", `/deals/${dealId}/project`);
    const rows = await asSuperuser(() => client.query<{ name: string }>(`SELECT name FROM conta_projects WHERE external_ref = '${dealId}'`));
    expect(rows.rows[0]!.name).toBe("Labor claim (appeal)");
  });

  it("a client exists in the ledger before any work, with its terms", async () => {
    const first = await json(await request("staff", "POST", "/contacts/c9/billing-client", { paymentTermsDays: 15 }));
    expect(first.created).toBe(true);
    const again = await json(await request("staff", "POST", "/contacts/c9/billing-client", {}));
    expect(again).toEqual({ clientId: first.clientId, created: false });
    expect((await request("staff", "POST", "/companies/nope/billing-client", {})).status).toBe(404);
  });

  it("only who configures the CRM logs work for someone else, and stays the author", async () => {
    await asSuperuser(() =>
      client.exec(`INSERT INTO conta_resources (id, name, user_id, billing_rate, cost_rate, unit) VALUES ('r2', 'Member', '${ACTORS.member.id}', '80.00', '30.00', 'hour')`)
    );
    const forOther = { quantity: 2, description: "Research", resourceUserId: ACTORS.member.id, externalRef: "w2" };
    expect((await request("staff", "POST", `/deals/${dealId}/work`, forOther)).status).toBe(403);
    expect((await request("admin", "POST", `/deals/${dealId}/work`, forOther)).status).toBe(201);
    const rows = await asSuperuser(() =>
      client.query<{ resource_id: string; created_by: string }>(`SELECT resource_id, created_by FROM conta_work_entries WHERE external_ref = 'w2'`)
    );
    expect(rows.rows[0]).toEqual({ resource_id: "r2", created_by: ACTORS.admin.id });
  });

  it("a portal link made with showStatement shows the ledger's balance; one without it does not", async () => {
    const withStatement = await json(await request("staff", "POST", "/portal-links", { contactId: "c9", showStatement: true }));
    const plain = await json(await request("staff", "POST", "/portal-links", { contactId: "c9" }));
    const read = async (token: string) => json(await request("anon", "POST", "/public/portal", { token }));
    expect((await read(withStatement.token)).statement).toEqual({ balanceDue: "0.0000", invoices: [] });
    expect(await read(plain.token)).not.toHaveProperty("statement");
  });

  it("without CRM edit access, nothing reaches the ledger", async () => {
    expect((await request("a", "POST", `/deals/${dealId}/work`, { quantity: 1, description: "x" })).status).toBe(403);
  });
});

async function applied(): Promise<{ id: string; stageId: string }> {
  const rows = await asSuperuser(() =>
    client.query<{ id: string; stage_id: string }>(
      `SELECT p.id, s.id AS stage_id FROM crm_pipelines p JOIN crm_pipeline_stages s ON s.pipeline_id = p.id WHERE p.name = 'Matters' ORDER BY s."order" LIMIT 1`
    )
  );
  return { id: rows.rows[0]!.id, stageId: rows.rows[0]!.stage_id };
}

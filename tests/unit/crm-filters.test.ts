/**
 * CRM combined filters
 * ============================================================================
 *
 * `crm.routes.ts` built the filters by chaining `query = query.where(...)`.
 * In Drizzle that does NOT add them up: each call replaces the previous condition, and
 * without warning. With `?organizationId=A&industry=X` only `industry` was applied,
 * so the response brought companies from ALL organizations — the filter
 * that was lost was precisely the isolation one.
 *
 * The `search` case was even worse: it came out in a second `.where()` that
 * wiped out at once the five or seven previous filters. Searching by name
 * opened the whole table.
 *
 * None of this was caught by the test that already existed (`kon-crm/tests/
 * crm.routes.test.ts`) because it uses a DOUBLE of the database: a mock does not reproduce
 * Drizzle's replacement semantics, so it saw two calls and took them as
 * fine. These tests go against PGlite with the real migration.
 */

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createCRMRouter } from "../../kons/kon-crm/crm.routes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let app: Hono;

beforeAll(async () => {
  const client = await PGlite.create();
  db = drizzle(client);

  const { readFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const base = dirname(fileURLToPath(import.meta.url));

  // ALL the migrations, in order: the routes need the schema and the access function of the last one.
  // The core's agent functions go first, as the host applies them.
  await client.exec(
    readFileSync(resolve(base, "../../.kitsuden/apps/api/src/db/agent-functions.sql"), "utf8")
  );
  const { readdirSync } = await import("node:fs");
  const migrations = resolve(base, "../../kons/kon-crm/migrations");
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    await client.exec(
      readFileSync(resolve(base, `../../kons/kon-crm/migrations/${file}`), "utf8")
    );
  }

  const ctx = createTestKonContext({
    db: { instance: db, execute: async () => undefined, tableExists: async () => true },
    auth: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono middleware double
      requireAuth: (c: any, next: any) => {
        c.set("user", { id: "u-1", role: "admin" });
        return next();
      },
      // The router sets the user from the optional session and decides itself
      // (policy "crm"): without this double, everything would be 401.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono middleware double
      optionalAuth: (c: any, next: any) => {
        c.set("user", { id: "u-1", role: "admin" });
        return next();
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial override
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial override
  } as any);

  app = new Hono();
  app.route("/", createCRMRouter(ctx));
});

beforeEach(async () => {
  await db.execute(sql.raw("DELETE FROM crm_deals"));
  await db.execute(sql.raw("DELETE FROM crm_contacts"));
  await db.execute(sql.raw("DELETE FROM crm_companies"));

  // Two organizations. The second exists for one thing only: if a filter is
  // lost, its rows show up where they should not.
  await db.execute(
    sql.raw(
      "INSERT INTO crm_companies (id, name, domain, industry, organization_id) VALUES " +
        "('c-1', 'Pottery Vigo', 'pottery.example', 'crafts', 'org-A'), " +
        "('c-2', 'North Workshop', 'workshop.example', 'software', 'org-A'), " +
        "('c-3', 'Pottery Elsewhere', 'elsewhere.example', 'crafts', 'org-B')"
    )
  );
  await db.execute(
    sql.raw(
      "INSERT INTO crm_contacts (id, first_name, last_name, email, organization_id) VALUES " +
        "('p-1', 'Ana', 'Ruiz', 'ana@pottery.example', 'org-A'), " +
        "('p-2', 'Ana', 'Otero', 'ana@elsewhere.example', 'org-B')"
    )
  );
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (route: string): Promise<any> => (await app.request(route)).json();

describe("companies", () => {
  it("applies organizationId and industry at the same time", async () => {
    const { data } = await json("/companies?organizationId=org-A&industry=crafts");
    expect(data.map((d: { id: string }) => d.id)).toEqual(["c-1"]);
  });

  it("the search does NOT cancel the organization filter", async () => {
    // Before, 'Pottery Elsewhere', from org-B, also came out.
    const { data } = await json("/companies?organizationId=org-A&search=Pottery");
    expect(data.map((d: { id: string }) => d.id)).toEqual(["c-1"]);
  });

  it("the search's OR goes in parentheses", async () => {
    // With a `sql\`name ILIKE x OR domain ILIKE x\`` without parentheses, SQL
    // precedence gives `(org AND name) OR domain` and the row from the other organization
    // slips through again, now through the domain branch.
    const { data } = await json("/companies?organizationId=org-A&search=elsewhere");
    expect(data).toEqual([]);
  });

  it("the total matches what is returned", async () => {
    // The count used only `organizationId`, so when filtering it said 2 and the
    // table showed 1: pagination with empty pages at the end.
    const res = await json("/companies?organizationId=org-A&industry=crafts");
    expect(Number(res.pagination.total)).toBe(res.data.length);
  });
});

describe("contacts", () => {
  it("the search does not cancel the organization filter", async () => {
    const { data } = await json("/contacts?organizationId=org-A&search=Ana");
    expect(data.map((d: { id: string }) => d.id)).toEqual(["p-1"]);
  });

  it("searches by surname and by email, not just by first name", async () => {
    expect((await json("/contacts?search=Otero")).data).toHaveLength(1);
    expect((await json("/contacts?search=ana@pottery.example")).data).toHaveLength(1);
  });
});

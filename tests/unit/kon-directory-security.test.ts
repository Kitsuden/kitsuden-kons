/**
 * kon-directory — who sees what of a record, with the REAL routes and RLS
 * ============================================================================
 *
 * Before 2026-10-15, without a session: the entire record (birth date, emergency
 * contact, salary band), emails and mobile numbers of the whole staff (also
 * of those who asked not to be listed), identity documents, and an infinite loop with a
 * cycle of managers. With any account: creating, editing and deactivating employees.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { registerDirectoryPolicy } from "../../kons/kon-directory/directory.policy";
import { createDirectoryRouter } from "../../kons/kon-directory/directory.routes";

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

const ORG_X = "00000000-0000-4000-8000-0000000000a1";
const ORG_Y = "00000000-0000-4000-8000-0000000000b2";
const EMP_A = "00000000-0000-4000-8000-00000000000a"; // account A, org X, visible
const EMP_B = "00000000-0000-4000-8000-00000000000b"; // account B, org X, HIDDEN
const EMP_C = "00000000-0000-4000-8000-00000000000c"; // no account, org Y, visible
const EMP_D = "00000000-0000-4000-8000-00000000000d"; // manager cycle with E
const EMP_E = "00000000-0000-4000-8000-00000000000e";
const DOC_PUB = "00000000-0000-4000-8000-0000000000d1";
const DOC_CONF = "00000000-0000-4000-8000-0000000000d2";

async function json(res: Response): Promise<any> {
  return res.json();
}

beforeAll(async () => {
  client = await databaseWithRls("kon-directory", [
    "0000_base_schema.sql",
    "0001_rename_tables.sql",
    "0002_entry_security.sql",
    "0003_system_without_user.sql",
    "0004_effective_admin.sql",
  ]);

  // Seed as superuser (empty context), before switching to the app role.
  await client.exec(`
    INSERT INTO directory_organizations (id, name, slug) VALUES
      ('${ORG_X}', 'Equis', 'equis'), ('${ORG_Y}', 'Ye', 'ye');
    INSERT INTO directory_employees
      (id, user_id, organization_id, employee_id, first_name, last_name, email, work_email, phone, mobile,
       start_date, birth_date, salary_band, emergency_contact, visible_in_directory, status)
    VALUES
      ('${EMP_A}', '${USERS.a.id}', '${ORG_X}', 'X-1', 'Ana', 'Alba', 'ana.personal@gmail.test', 'ana@equis.test',
       '+34 600 000 001', '+34 699 000 001', '2020-01-01', '1990-05-05', 'L3',
       '{"name":"Madre","relationship":"madre","phone":"+34 611"}', true, 'active'),
      ('${EMP_B}', '${USERS.b.id}', '${ORG_X}', 'X-2', 'Beto', 'Bravo', 'beto.personal@gmail.test', 'beto@equis.test',
       '+34 600 000 002', '+34 699 000 002', '2021-01-01', '1985-03-03', 'M1',
       '{"name":"Pareja","relationship":"pareja","phone":"+34 622"}', false, 'on_leave'),
      ('${EMP_C}', NULL, '${ORG_Y}', 'Y-1', 'Carla', 'Cruz', 'carla.secreta@gmail.test', 'carla@ye.test',
       '+34 600 000 003', NULL, '2022-01-01', '1999-09-09', 'L1', NULL, true, 'active'),
      ('${EMP_D}', NULL, '${ORG_X}', 'X-3', 'Dani', 'Diaz', 'd@x.test', NULL, NULL, NULL, '2022-01-01', NULL, NULL, NULL, true, 'active'),
      ('${EMP_E}', NULL, '${ORG_X}', 'X-4', 'Eva', 'Este', 'e@x.test', NULL, NULL, NULL, '2022-01-01', NULL, NULL, NULL, true, 'active');
    UPDATE directory_employees SET manager_id = '${EMP_E}' WHERE id = '${EMP_D}';
    UPDATE directory_employees SET manager_id = '${EMP_D}' WHERE id = '${EMP_E}';
    INSERT INTO directory_employee_documents (id, employee_id, name, type, media_id, document_number, is_confidential) VALUES
      ('${DOC_PUB}', '${EMP_A}', 'Certificado', 'certificate', gen_random_uuid(), NULL, false),
      ('${DOC_CONF}', '${EMP_A}', 'DNI', 'id', gen_random_uuid(), '12345678Z', true);
  `);

  const db = await asAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({
    db: host.db as never,
    auth: auth as never,
  });
  request = requestAs(host.mount(createDirectoryRouter(ctx)));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerDirectoryPolicy();
});

const PRIVATE_ONES = [
  "email",
  "mobile",
  "birthDate",
  "salaryBand",
  "emergencyContact",
  "customFields",
  "userId",
];

describe("anonymous: public record and nothing else", () => {
  it("the list carries no personal data, not even of those who asked not to be listed", async () => {
    const res = await request("anon", "GET", "/employees");
    expect(res.status).toBe(200);
    const { docs } = await json(res);
    const ids = docs.map((d: any) => d.id);
    expect(ids).toContain(EMP_A);
    expect(ids).not.toContain(EMP_B);
    const text = JSON.stringify(docs);
    for (const datum of ["gmail.test", "+34 6", "1990-05-05", "Madre", "L3", "ana@equis.test"]) {
      expect(text).not.toContain(datum);
    }
  });

  it("the record of a visible employee carries nothing from HR; the hidden one is 404", async () => {
    const a = await json(await request("anon", "GET", `/employees/${EMP_A}`));
    for (const k of [...PRIVATE_ONES, "workEmail", "phone"]) expect(a[k]).toBeUndefined();
    expect(a.firstName).toBe("Ana");
    expect((await request("anon", "GET", `/employees/${EMP_B}`)).status).toBe(404);
  });

  it("searching by email is not an oracle; filtering by status does not say who is on leave", async () => {
    const byEmail = await json(await request("anon", "GET", "/search?q=carla.secreta"));
    expect(byEmail.employees).toHaveLength(0);
    const unsubscribed = await json(await request("anon", "GET", "/employees?status=on_leave"));
    // The filter is ignored: the normal public list comes out, not "those on leave".
    expect(unsubscribed.docs.map((d: any) => d.id)).toContain(EMP_A);
  });

  it("documents require a session; so do the statistics", async () => {
    expect((await request("anon", "GET", `/employees/${EMP_A}/documents`)).status).toBe(401);
    expect((await request("anon", "GET", `/stats?organizationId=${ORG_X}`)).status).toBe(401);
  });

  it("a manager cycle does NOT hang the chain of command", async () => {
    const res = await request("anon", "GET", `/employees/${EMP_D}/reporting-chain`);
    expect(res.status).toBe(200);
    expect((await json(res)).chain.length).toBeLessThanOrEqual(2);
  });

  it("a garbage id gives 404/400, not a Postgres 500", async () => {
    expect((await request("anon", "GET", "/employees/hola")).status).toBe(404);
    expect((await request("anon", "GET", "/employees?departmentId=hola")).status).toBe(400);
  });
});

describe("users: colleagues, themselves and nobody else", () => {
  it("A (an employee of X) sees the work email of their colleagues in X, not those in Y", async () => {
    const { docs } = await json(await request("a", "GET", "/employees"));
    const d = docs.find((x: any) => x.id === EMP_D);
    const c = docs.find((x: any) => x.id === EMP_C);
    expect(Object.keys(d)).toContain("workEmail");
    expect(c.workEmail).toBeUndefined();
    expect(JSON.stringify(docs)).not.toContain("gmail.test");
  });

  it("B sees their own full record even if hidden; A does not see it", async () => {
    const own = await json(await request("b", "GET", `/employees/${EMP_B}`));
    expect(own.birthDate).toBe("1985-03-03");
    expect(own.salaryBand).toBe("M1");
    expect((await request("a", "GET", `/employees/${EMP_B}`)).status).toBe(404);
  });

  it("A edits the personal part of THEIR record, not the HR part, nor anyone else's", async () => {
    expect((await request("a", "PATCH", `/employees/${EMP_A}`, { bio: "Hola" })).status).toBe(200);
    expect((await request("a", "PATCH", `/employees/${EMP_A}`, { salaryBand: "M9" })).status).toBe(
      403
    );
    expect((await request("a", "PATCH", `/employees/${EMP_A}`, { departmentId: null })).status).toBe(
      403
    );
    expect((await request("a", "PATCH", `/employees/${EMP_A}`, { esJefa: true })).status).toBe(422);
    expect((await request("a", "PATCH", `/employees/${EMP_C}`, { bio: "x" })).status).toBe(403);
    expect((await request("a", "PATCH", `/employees/${EMP_B}`, { bio: "x" })).status).toBe(404);
  });

  it("A sees THEIR non-confidential documents; B does not see A's", async () => {
    const { docs } = await json(await request("a", "GET", `/employees/${EMP_A}/documents`));
    expect(docs.map((d: any) => d.id)).toEqual([DOC_PUB]);
    expect((await request("b", "GET", `/employees/${EMP_A}/documents`)).status).toBe(404);
  });

  it("statistics: A (of X) yes, the editor (of none) no", async () => {
    expect((await request("a", "GET", `/stats?organizationId=${ORG_X}`)).status).toBe(200);
    expect((await request("staff", "GET", `/stats?organizationId=${ORG_X}`)).status).toBe(403);
  });
});

describe("HR = admin; an editor is not HR", () => {
  const next = {
    organizationId: ORG_X,
    employeeId: "X-9",
    firstName: "Nora",
    lastName: "Nieto",
    email: "nora@x.test",
  };

  it("neither a user nor an editor creates, edits or deactivates employees", async () => {
    expect((await request("anon", "POST", "/employees", next)).status).toBe(401);
    expect((await request("a", "POST", "/employees", next)).status).toBe(403);
    expect((await request("staff", "POST", "/employees", next)).status).toBe(403);
    expect((await request("staff", "DELETE", `/employees/${EMP_C}`)).status).toBe(403);
    expect((await request("a", "POST", "/organizations", { name: "Mía" })).status).toBe(403);
  });

  it("the admin does, and sees the confidential documents", async () => {
    expect((await request("admin", "POST", "/employees", next)).status).toBe(201);
    const { docs } = await json(await request("admin", "GET", `/employees/${EMP_A}/documents`));
    expect(docs).toHaveLength(2);
  });

  it("uploadedById in the body is rejected; the author comes from the session", async () => {
    const base = {
      name: "Contrato",
      type: "contract",
      mediaId: "00000000-0000-4000-8000-000000000999",
    };
    expect(
      (
        await request("admin", "POST", `/employees/${EMP_A}/documents`, {
          ...base,
          uploadedById: USERS.b.id,
        })
      ).status
    ).toBe(422);
    const res = await request("admin", "POST", `/employees/${EMP_A}/documents`, base);
    expect(res.status).toBe(201);
    expect((await json(res)).uploadedById).toBe(USERS.admin.id);
  });
});

describe("RLS in the database (without going through the routes)", () => {
  it("an anonymous user does not see the hidden record", async () => {
    expect(
      await sqlAs(client, "anon", `select id from directory_employees where id = $1`, [EMP_B])
    ).toHaveLength(0);
  });

  it("A cannot raise their own salary band even with direct SQL", async () => {
    await expect(
      sqlAs(client, "a", `update directory_employees set salary_band = 'M9' where id = $1`, [
        EMP_A,
      ])
    ).rejects.toThrow(/RR\. HH\./);
  });

  it("A cannot touch C's record (0 rows)", async () => {
    const rows = await sqlAs(
      client,
      "a",
      `update directory_employees set bio = 'x' where id = $1 returning id`,
      [EMP_C]
    );
    expect(rows).toHaveLength(0);
  });

  it("A does not see their confidential document; B sees none of A's", async () => {
    expect(
      await sqlAs(client, "a", `select id from directory_employee_documents where id = $1`, [
        DOC_CONF,
      ])
    ).toHaveLength(0);
    expect(await sqlAs(client, "b", `select id from directory_employee_documents`)).toHaveLength(
      0
    );
  });
});

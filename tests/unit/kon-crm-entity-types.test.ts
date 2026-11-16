/**
 * kon-crm's entity types move into Kitsuden's entities
 * ============================================================================
 *
 * Every kon-crm migration on PGlite as the NON-superuser app role. Kitsuden's `ctx.entities` is a double
 * with the contract's shape (`define`, `definitions`), keeping definitions in memory as the core keeps them
 * in `data_sets`.
 *
 * What these tests hold:
 *   - a field survives the trip to the core's field types and back, the CRM's own type included;
 *   - each row of crm_entity_configs moves once, keeps its id (deals that point at it still find it) and
 *     carries its settings: pipeline, flags, numbering, activity kinds;
 *   - a type the core refuses stays in the table and is still read, so nothing disappears halfway;
 *   - a type created afterwards lives only in the core, and a deal can point at it (0014 dropped the FK);
 *   - without `ctx.entities`, everything reads the table as before.
 */

import type { PGlite } from "@electric-sql/pglite";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { activityKinds, allFields, entityOfDeal, numberingOf } from "../../kons/kon-crm/crm.entities";
import {
  entityTypes,
  fromCoreField,
  migrateEntityTypes,
  toCoreField,
  useEntityTypes,
} from "../../kons/kon-crm/crm.entitystore";
import type { EntityFieldSchema } from "../../kons/kon-crm/crm.schema";

import { APP_ROLE, dropToAppRole, migratedBase } from "./helpers/safe-kons-bench";

let client: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a drizzle over PGlite
let db: any;

type Def = { slug: string; name: string; fields: Array<Record<string, unknown>>; settings?: Record<string, unknown> };
const defined = new Map<string, Def>();
let refuse: string | null = null;
const core = {
  async define(konId: string, def: Def) {
    if (konId !== "kon-crm") throw new Error("wrong kon");
    if (refuse && def.slug === refuse) throw new Error("field type not allowed");
    defined.set(def.slug, structuredClone(def));
    return structuredClone(def);
  },
  async definitions(konId: string) {
    return konId === "kon-crm" ? [...defined.values()].map((d) => structuredClone(d)) : [];
  },
};

async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  await client.exec("RESET ROLE");
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.exec(`SET ROLE ${APP_ROLE}`);
  }
}

const caseFields: EntityFieldSchema[] = [
  { key: "reference", type: "text", label: "Reference", required: true, validation: { pattern: "^C-" } },
  { key: "fee", type: "currency", label: "Fee", validation: { min: 0, max: 100000 } },
  { key: "client", type: "contact", label: "Client", sensitive: true },
  { key: "area", type: "select", label: "Area", options: ["labor", "tax"] },
];

beforeAll(async () => {
  const dir = resolve(__dirname, "../../kons/kon-crm/migrations");
  client = await migratedBase("kon-crm", readdirSync(dir).filter((f) => f.endsWith(".sql")).sort());
  await client.query(
    `INSERT INTO crm_pipelines (id, name) VALUES ('p-cases', 'Cases');
     `.trim()
  );
  await client.query(
    `INSERT INTO crm_entity_configs (id, kon_id, entity_name, singular_label, plural_label, field_schema, default_pipeline_id, is_default, metadata)
     VALUES ('ec-case', 'kon-crm', 'case', 'Case', 'Cases', $1::jsonb, 'p-cases', true, $2::jsonb)`,
    [JSON.stringify(caseFields), JSON.stringify({ numbering: { field: "reference", prefix: "C-", padding: 5 } })]
  );
  await client.query(
    `INSERT INTO crm_entity_configs (id, kon_id, entity_name, singular_label, plural_label, field_schema, metadata)
     VALUES ('ec-activity', 'kon-crm', 'activity', 'Activity', 'Activities', '[]'::jsonb, $1::jsonb),
            ('ec-odd', 'kon-crm', 'odd', 'Odd', 'Odds', '[]'::jsonb, '{}'::jsonb)`,
    [JSON.stringify({ kinds: [{ key: "hearing", type: "meeting" }] })]
  );
  await client.exec(`INSERT INTO crm_pipeline_stages (id, pipeline_id, name, "order") VALUES ('s-c', 'p-cases', 'Open', 0)`);
  await client.exec(`INSERT INTO crm_deals (id, title, pipeline_id, stage_id, entity_config_id) VALUES ('d-case', 'A case', 'p-cases', 's-c', 'ec-case')`);
  db = await dropToAppRole(client);
});

afterAll(async () => {
  useEntityTypes({});
  await client?.close();
});

describe("fields", () => {
  it("survive the trip to the core's field types and back", () => {
    const core = caseFields.map(toCoreField);
    expect(core.map((f) => f.type)).toEqual(["text", "number", "relation", "select"]);
    expect(core[0]).toMatchObject({ validationRegex: "^C-", required: true, crmType: "text" });
    expect(core[1]).toMatchObject({ minValue: 0, maxValue: 100000, crmType: "currency" });
    expect(core[2]).toMatchObject({ sensitivity: "customer", sensitive: true });
    expect(core.map(fromCoreField)).toEqual(caseFields);
  });
});

describe("without Kitsuden's entities", () => {
  it("reads the table as before", async () => {
    useEntityTypes({});
    expect(entityTypes(db).backend).toBe("table");
    const entity = await entityOfDeal(db, { entityConfigId: "ec-case" });
    expect(entity?.entityName).toBe("case");
    expect(numberingOf(entity)).toEqual({ field: "reference", prefix: "C-", padding: 5 });
  });
});

describe("with Kitsuden's entities", () => {
  it("moves each type once, keeping its id and settings; a refused one stays in the table", async () => {
    useEntityTypes({ entities: core });
    refuse = "crm-odd";
    const first = await migrateEntityTypes(db);
    // Migration 0001 seeds a type of its own; it moves too.
    expect(first.moved).toEqual(expect.arrayContaining(["crm-activity", "crm-case"]));
    expect(first.moved).not.toContain("crm-odd");
    expect(first.failed).toEqual([{ name: "odd", error: "field type not allowed" }]);
    expect(defined.get("crm-case")).toMatchObject({
      name: "Case",
      settings: { id: "ec-case", entityName: "case", defaultPipelineId: "p-cases", isDefault: true, metadata: { numbering: { prefix: "C-" } } },
    });
    const marks = await q<{ id: string; mark: string | null }>(`SELECT id, metadata ->> 'migratedTo' AS mark FROM crm_entity_configs WHERE id IN ('ec-activity', 'ec-case', 'ec-odd') ORDER BY id`);
    expect(marks).toEqual([
      { id: "ec-activity", mark: "crm-activity" },
      { id: "ec-case", mark: "crm-case" },
      { id: "ec-odd", mark: null },
    ]);

    // A second start moves nothing new; the refused one is retried.
    refuse = null;
    const second = await migrateEntityTypes(db);
    expect(second.moved).toEqual(["crm-odd"]);
  });

  it("everything reads the core now: deals keep their type, fields, kinds and numbering", async () => {
    expect(entityTypes(db).backend).toBe("core");
    // Proof it is not the table: change the table and see nothing move.
    await q(`UPDATE crm_entity_configs SET singular_label = 'Changed in the table' WHERE id = 'ec-case'`);
    const entity = await entityOfDeal(db, { entityConfigId: "ec-case" });
    expect(entity).toMatchObject({ id: "ec-case", singularLabel: "Case", defaultPipelineId: "p-cases" });
    expect(await entityOfDeal(db, { pipelineId: "p-cases" })).toMatchObject({ entityName: "case" });
    expect((await allFields(db)).map((f) => f.key)).toEqual(expect.arrayContaining(["area", "client", "fee", "reference"]));
    expect(await activityKinds(db)).toEqual([{ key: "hearing", type: "meeting" }]);
    expect(numberingOf(entity)).toEqual({ field: "reference", prefix: "C-", padding: 5 });
  });

  it("a type created now lives only in the core, and a deal can point at it", async () => {
    const store = entityTypes(db);
    const project = await store.create({ entityName: "project", singularLabel: "Project", pluralLabel: "Projects", fieldSchema: [{ key: "budget", type: "currency", label: "Budget" }] });
    expect(project.id).toBe("crm-project");
    expect(await q(`SELECT 1 FROM crm_entity_configs WHERE entity_name = 'project'`)).toEqual([]);
    await expect(store.create({ entityName: "project", singularLabel: "P", pluralLabel: "Ps" })).rejects.toMatchObject({ status: 409 });

    await q(`INSERT INTO crm_deals (id, title, pipeline_id, stage_id, entity_config_id) VALUES ('d-proj', 'A project', 'p-cases', 's-c', 'crm-project')`);
    expect(await entityOfDeal(db, { entityConfigId: "crm-project" })).toMatchObject({ entityName: "project", fieldSchema: [{ key: "budget", type: "currency" }] });

    const updated = await store.update("crm-project", { pluralLabel: "All projects" });
    expect(updated).toMatchObject({ pluralLabel: "All projects" });
    await expect(store.update("crm-project", { entityName: "renamed" })).rejects.toMatchObject({ status: 409 });
  });
});

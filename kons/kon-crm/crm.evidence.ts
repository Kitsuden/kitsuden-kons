/**
 * Observed data: evidence decides what reaches a record
 * ============================================================================
 *
 * An agent, a connector (an action that reads a data provider) or a person records what it saw about a contact
 * or a company: the field, the value, the source and the KIND of evidence. It never says how sure it is. The
 * admin prices each kind of evidence in `crm_evidence_kinds`, and the weights of different sources that saw the
 * same value add up. Then:
 *
 *   - at or above `applyAt`, the value is written to the record, unless a person had typed a different one there;
 *   - below it, or against a person's value, or a value a person already rejected, it waits as a suggestion;
 *   - the same value as the record's is a confirmation, kept for the history.
 *
 * Only a person accepts or rejects a suggestion. A confidently wrong fact about a customer is worse than a blank
 * field, because nobody can tell it is wrong; a suggestion can be told apart.
 */

import { AppError } from "@kitsuden/engine";
import { createId } from "@paralleldrive/cuid2";
import { and, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";

import { accessOf, customFieldProblems, hiddenFieldKeys } from "./crm.access";
import { dbDe, userOf } from "./crm.context";
import type { CrmDb } from "./crm.db";
import { entityByName } from "./crm.entities";
import { emitCrm } from "./crm.events";
import { readableFields } from "./crm.records";
import { crmCompanies, crmContacts, crmEvidenceKinds, crmEvidencePolicy, crmObservations } from "./crm.schema";
import { CONFIGURE, EDIT, VIEW, requiresEdit, type registry } from "./operations";

/** The record columns an observation may fill. Money (`annualRevenue`) and links between records are not facts to observe. */
export const OBSERVABLE = {
  contact: ["firstName", "lastName", "email", "phone", "mobile", "jobTitle", "department", "linkedin", "twitter", "address", "city", "country"],
  company: ["name", "domain", "industry", "size", "website", "linkedin", "address", "city", "country", "phone", "description"],
} as const;

type EntityType = keyof typeof OBSERVABLE;
type Observation = typeof crmObservations.$inferSelect;

const Output = z.object({}).passthrough();
const ParamId = z.object({ id: z.string().min(1).max(100).describe("Observation id") });

const Observe = z.object({
  entityType: z.enum(["contact", "company"]),
  entityId: z.string().min(1).max(100),
  field: z
    .string()
    .min(1)
    .max(110)
    .describe("A record column (`jobTitle`, `phone`, `website`…) or `custom.<key>` for a custom field"),
  value: z.union([z.string().max(10_000), z.number(), z.boolean(), z.array(z.string().max(500)).max(50)]),
  source: z.string().trim().min(1).max(100).describe("Where it was seen: `email:<message id>`, `linkedin`, `acme.com/team`…"),
  evidence: z.string().min(2).max(60).describe("The kind of evidence, from `get-evidence-policy`. Never a confidence"),
  note: z.string().trim().max(2000).optional().describe("What exactly was seen, for whoever reviews it"),
  externalRef: z.string().max(200).optional().describe("Your id for this observation: repeating it records once"),
});

const Policy = z.object({
  applyAt: z.number().int().min(1).max(100).optional().describe("Combined weight from which a value is written to the record"),
  kinds: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9-]{2,60}$/),
        label: z.string().trim().min(1).max(200),
        description: z.string().trim().max(1000).nullable().optional(),
        weight: z.number().int().min(0).max(100),
        active: z.boolean().optional(),
      })
    )
    .max(100)
    .optional()
    .describe("Kinds to create or change; switch one off with `active: false`"),
});

const ListQuery = z
  .object({
    entityType: z.enum(["contact", "company"]).optional(),
    entityId: z.string().optional(),
    field: z.string().optional(),
    status: z.enum(["applied", "suggested", "confirmed", "accepted", "rejected"]).optional(),
    limit: z.string().optional().describe("1-200, default 100"),
  })
  .passthrough();

const Decision = z.object({ note: z.string().trim().max(2000).optional() });

function table(type: EntityType) {
  return type === "contact" ? crmContacts : crmCompanies;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

async function rowOf(db: CrmDb, type: EntityType, id: string): Promise<Record<string, unknown>> {
  const t = table(type);
  const [row] = await db.select().from(t).where(eq(t.id, id));
  if (!row) throw AppError.notFound(type === "contact" ? "Contact not found" : "Company not found");
  return row as Record<string, unknown>;
}

function currentValue(row: Record<string, unknown>, field: string): unknown {
  if (field.startsWith("custom.")) return ((row.customFields as Record<string, unknown> | null) ?? {})[field.slice(7)];
  return row[field];
}

/** The field and value, checked: a column this kon lets observations fill, or a custom field the caller can read. */
async function checkField(db: CrmDb, type: EntityType, field: string, value: unknown): Promise<void> {
  if (field.startsWith("custom.")) {
    const key = field.slice(7);
    const definition = (await readableFields(db, [key])).get(key)!;
    const problems = customFieldProblems([definition], { [key]: value }, false);
    if (problems.length > 0) throw AppError.validation(problems.join("; "));
    const onEntity = (await entityByName(db, type))?.fieldSchema ?? [];
    if (!onEntity.some((f) => f.key === key)) throw AppError.validation(`${key} is not a field of a ${type}`);
    return;
  }
  if (!(OBSERVABLE[type] as readonly string[]).includes(field)) {
    throw AppError.validation(`${field} cannot be observed on a ${type}. Fields: ${OBSERVABLE[type].join(", ")}, custom.<key>`);
  }
  if (typeof value !== "string" || !value.trim()) throw AppError.validation(`${field} takes text`);
  if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw AppError.validation("email must be an email");
}

async function writeValue(db: CrmDb, type: EntityType, id: string, field: string, value: unknown, row: Record<string, unknown>): Promise<void> {
  const t = table(type);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (field.startsWith("custom.")) {
    set.customFields = { ...((row.customFields as Record<string, unknown> | null) ?? {}), [field.slice(7)]: value };
  } else {
    set[field] = value;
  }
  await db.update(t).set(set).where(eq(t.id, id));
}

async function policyOf(db: CrmDb): Promise<number> {
  const [row] = await db.select().from(crmEvidencePolicy).limit(1);
  return row?.applyAt ?? 70;
}

/**
 * The combined weight of a value: the strongest evidence of each source that saw it, added up and capped at 100.
 * Rejected observations do not count.
 */
async function combinedWeight(db: CrmDb, type: EntityType, id: string, field: string, value: unknown, extra: { source: string; weight: number }): Promise<number> {
  const rows = await db
    .select({ source: crmObservations.source, weight: crmObservations.weight })
    .from(crmObservations)
    .where(
      and(
        eq(crmObservations.entityType, type),
        eq(crmObservations.entityId, id),
        eq(crmObservations.field, field),
        ne(crmObservations.status, "rejected"),
        sql`${crmObservations.value} = ${JSON.stringify(value)}::jsonb`
      )
    );
  const best = new Map<string, number>();
  for (const r of [...rows, extra]) best.set(r.source, Math.max(best.get(r.source) ?? 0, r.weight));
  return Math.min(100, [...best.values()].reduce((a, b) => a + b, 0));
}

/** Whether the record's current value came from an observation applied automatically, so another may replace it. */
async function setByObservation(db: CrmDb, type: EntityType, id: string, field: string, current: unknown): Promise<boolean> {
  const [last] = await db
    .select({ value: crmObservations.value, status: crmObservations.status })
    .from(crmObservations)
    .where(and(eq(crmObservations.entityType, type), eq(crmObservations.entityId, id), eq(crmObservations.field, field), inArray(crmObservations.status, ["applied", "accepted"])))
    .orderBy(desc(crmObservations.decidedAt), desc(crmObservations.observedAt))
    .limit(1);
  return !!last && last.status === "applied" && same(last.value, current);
}

async function wasRejected(db: CrmDb, type: EntityType, id: string, field: string, value: unknown): Promise<boolean> {
  const [row] = await db
    .select({ id: crmObservations.id })
    .from(crmObservations)
    .where(
      and(
        eq(crmObservations.entityType, type),
        eq(crmObservations.entityId, id),
        eq(crmObservations.field, field),
        eq(crmObservations.status, "rejected"),
        sql`${crmObservations.value} = ${JSON.stringify(value)}::jsonb`
      )
    )
    .limit(1);
  return !!row;
}

function onlyPerson(c: Context): string {
  const user = userOf(c);
  if (!user?.id || user.role === "agent") throw AppError.forbidden("Only a person settles a suggestion");
  return user.id;
}

/** Drops observations of fields the caller cannot read: the value is the field. */
async function readable(db: CrmDb, rows: Observation[]): Promise<Observation[]> {
  const hidden = await hiddenFieldKeys(db, await accessOf(db));
  return hidden.size === 0 ? rows : rows.filter((r) => !(r.field.startsWith("custom.") && hidden.has(r.field.slice(7))));
}

export function evidenceOperations(routes: ReturnType<typeof registry>): void {
  routes.get(
    "/evidence-policy",
    {
      id: "get-evidence-policy",
      summary: "See how evidence is weighed",
      description:
        "`applyAt`, the combined weight from which an observed value is written to the record, and the `kinds` of evidence with their weight. Use a kind's `key` as `evidence` in `record-observation`. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      output: { schema: Output },
    },
    async (c) => {
      const db = dbDe(c);
      const kinds = await db.select().from(crmEvidenceKinds).orderBy(desc(crmEvidenceKinds.weight));
      return c.json({ applyAt: await policyOf(db), kinds });
    }
  );

  routes.put(
    "/evidence-policy",
    {
      id: "update-evidence-policy",
      summary: "Change how evidence is weighed",
      description:
        "Sets `applyAt` and creates or changes kinds of evidence. Changes apply to new observations; what was already written stays. Admin only.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      sensitive: true,
      input: { body: Policy },
      output: { schema: Output },
    },
    async (c, input) => {
      const db = dbDe(c);
      if (input.body.applyAt !== undefined) {
        await db.update(crmEvidencePolicy).set({ applyAt: input.body.applyAt, updatedBy: userOf(c)?.id ?? null, updatedAt: new Date() }).where(eq(crmEvidencePolicy.id, true));
      }
      for (const kind of input.body.kinds ?? []) {
        const values = { label: kind.label, description: kind.description ?? null, weight: kind.weight, active: kind.active ?? true, updatedAt: new Date() };
        await db.insert(crmEvidenceKinds).values({ key: kind.key, ...values }).onConflictDoUpdate({ target: crmEvidenceKinds.key, set: values });
      }
      const kinds = await db.select().from(crmEvidenceKinds).orderBy(desc(crmEvidenceKinds.weight));
      return c.json({ applyAt: await policyOf(db), kinds });
    }
  );

  routes.post(
    "/observations",
    {
      id: "record-observation",
      summary: "Record something observed about a contact or company",
      description:
        "Say what was seen (`field`, `value`), where (`source`) and the kind of `evidence` (see `get-evidence-policy`); never a confidence. The weights of different sources that saw the same value add up. Returns `outcome`: `applied` (written to the record), `suggested` (waits for a person; `reason` says why), or `confirmed` (the record already says that). A value a person typed is never overwritten, and one a person rejected is never applied by itself again. With `externalRef`, repeating it records once. 403 for a custom field you cannot read; 422 for a field that cannot be observed or an unknown kind of evidence. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      input: { body: Observe },
      output: { schema: Output, status: 201 },
    },
    async (c, input) => {
      const db = dbDe(c);
      const body = input.body;
      if (body.externalRef) {
        const [existing] = await db.select().from(crmObservations).where(eq(crmObservations.externalRef, body.externalRef));
        if (existing) return c.json({ data: existing, outcome: existing.status, created: false }, 201);
      }
      const type = body.entityType;
      const row = await rowOf(db, type, body.entityId);
      await checkField(db, type, body.field, body.value);
      const [kind] = await db.select().from(crmEvidenceKinds).where(and(eq(crmEvidenceKinds.key, body.evidence), eq(crmEvidenceKinds.active, true)));
      if (!kind) throw AppError.validation(`Unknown kind of evidence: ${body.evidence}. See get-evidence-policy`);

      const value = typeof body.value === "string" ? body.value.trim() : body.value;
      const current = currentValue(row, body.field);
      const applyAt = await policyOf(db);
      const weight = await combinedWeight(db, type, body.entityId, body.field, value, { source: body.source, weight: kind.weight });
      let status: Observation["status"];
      let reason: string | null = null;
      if (same(current, value)) {
        status = "confirmed";
      } else if (await wasRejected(db, type, body.entityId, body.field, value)) {
        status = "suggested";
        reason = "A person rejected this value before";
      } else if (weight < applyAt) {
        status = "suggested";
        reason = `The evidence weighs ${weight}, under ${applyAt}`;
      } else if (!empty(current) && !(await setByObservation(db, type, body.entityId, body.field, current))) {
        status = "suggested";
        reason = "The record has a different value that a person set";
      } else {
        status = "applied";
      }
      if (status === "applied") await writeValue(db, type, body.entityId, body.field, value, row);
      const [saved] = await db
        .insert(crmObservations)
        .values({
          id: createId(),
          entityType: type,
          entityId: body.entityId,
          field: body.field,
          value,
          source: body.source,
          evidence: kind.key,
          weight: kind.weight,
          note: body.note ?? null,
          status,
          reason,
          previousValue: status === "applied" ? (current ?? null) : null,
          externalRef: body.externalRef ?? null,
          observedBy: userOf(c)?.id ?? null,
          ...(status === "applied" ? { decidedAt: new Date() } : {}),
        })
        .returning();
      if (status === "suggested" || status === "applied") {
        emitCrm(`observation:${status}`, { observationId: saved!.id, entityType: type, entityId: body.entityId, field: body.field });
      }
      return c.json({ data: saved, outcome: status, weight, applyAt, created: true }, 201);
    }
  );

  routes.get(
    "/observations",
    {
      id: "list-observations",
      summary: "List what was observed",
      description:
        "Newest first. `status=suggested` is the queue a person settles. Filters: `entityType`, `entityId`, `field`, `status`. Observations of fields you cannot read are left out. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      input: { query: ListQuery },
      output: { schema: Output },
    },
    async (c, input) => {
      const db = dbDe(c);
      const q = input.query;
      const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 200);
      const conditions: SQL[] = [];
      if (q.entityType) conditions.push(eq(crmObservations.entityType, q.entityType));
      if (q.entityId) conditions.push(eq(crmObservations.entityId, q.entityId));
      if (q.field) conditions.push(eq(crmObservations.field, q.field));
      if (q.status) conditions.push(eq(crmObservations.status, q.status));
      const rows = await db
        .select()
        .from(crmObservations)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(crmObservations.observedAt))
        .limit(limit);
      return c.json({ data: await readable(db, rows) });
    }
  );

  routes.post(
    "/observations/:id/accept",
    {
      id: "accept-observation",
      summary: "Accept a suggested value",
      description:
        "Writes the value to the record, whatever its weight, and marks it accepted by you. Only a person: agents get 403. 404 if it does not exist or you cannot see it; 409 if it is not a suggestion. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      mcp: { exclude: "Settling a suggestion is a person's decision." },
      input: { params: ParamId, body: Decision },
      output: { schema: Output },
    },
    async (c, input) => {
      const me = onlyPerson(c);
      const db = dbDe(c);
      const [obs] = await readable(db, await db.select().from(crmObservations).where(eq(crmObservations.id, input.params.id)));
      if (!obs) throw AppError.notFound("Observation not found");
      if (obs.status !== "suggested") throw AppError.conflict(`It is ${obs.status}, not a suggestion`);
      const type = obs.entityType as EntityType;
      const row = await rowOf(db, type, obs.entityId);
      await checkField(db, type, obs.field, obs.value);
      await writeValue(db, type, obs.entityId, obs.field, obs.value, row);
      const [saved] = await db
        .update(crmObservations)
        .set({ status: "accepted", previousValue: currentValue(row, obs.field) ?? null, decidedBy: me, decidedAt: new Date(), decisionNote: input.body.note ?? null })
        .where(eq(crmObservations.id, obs.id))
        .returning();
      return c.json({ data: saved });
    }
  );

  routes.post(
    "/observations/:id/reject",
    {
      id: "reject-observation",
      summary: "Reject a suggested value",
      description:
        "Marks it rejected by you. That value will not be applied to that field by itself again, whoever observes it. Only a person: agents get 403. 404 if it does not exist or you cannot see it; 409 if it is not a suggestion. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      mcp: { exclude: "Settling a suggestion is a person's decision." },
      input: { params: ParamId, body: Decision },
      output: { schema: Output },
    },
    async (c, input) => {
      const me = onlyPerson(c);
      const db = dbDe(c);
      const [obs] = await readable(db, await db.select().from(crmObservations).where(eq(crmObservations.id, input.params.id)));
      if (!obs) throw AppError.notFound("Observation not found");
      if (obs.status !== "suggested") throw AppError.conflict(`It is ${obs.status}, not a suggestion`);
      const [saved] = await db
        .update(crmObservations)
        .set({ status: "rejected", decidedBy: me, decidedAt: new Date(), decisionNote: input.body.note ?? null })
        .where(eq(crmObservations.id, obs.id))
        .returning();
      return c.json({ data: saved });
    }
  );
}

/**
 * How much of the CRM each person or agent sees
 * ============================================================================
 *
 * The policy says who gets in; this says how far. Four independent dials, read from `crm_access()`
 * (migration 0008):
 *
 *   records    `all`, or only what is `assigned` to the subject or was created by it. RLS applies it.
 *   sensitive  privileged and confidential documents (RLS) and custom fields marked sensitive (on the way out)
 *   money      amounts, removed on the way out, and writing them is refused: a blind write can probe a value
 *   notes      free text about people: contact notes, activity bodies, lost-deal notes, removed on the way out
 *
 * By default the team sees all records, amounts and notes, without the sensitive. An agent with `crm:view` sees
 * the same but no notes: what a person wrote about a client does not go to a model unless someone decides so.
 * Reading absolutely everything is an explicit, audited decision, in one of two ways:
 *
 *   - the agent scope `crm:read-all` (and `!crm:read-all` takes it away);
 *   - a grant here, which can expire and always records who gave it and why.
 *
 * Only a person grants. An agent could otherwise widen its own access or another one's, directly or
 * through an approved proposal, which runs under the agent's identity.
 *
 * What is removed on the way out passes through `registry()` in operations.ts, the one place every operation
 * goes through, REST or MCP. No list in this kon filters or sorts by amount; a new one must check `money`.
 */

import { AppError } from "@kitsuden/engine";
import { and, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";

import { dbDe, userOf } from "./crm.context";
import type { CrmDb } from "./crm.db";
import { activityKinds, entityByName, entityOfDeal } from "./crm.entities";
import { crmAccessGrants, crmDeals, crmEntityConfigs, type EntityFieldSchema } from "./crm.schema";
import { CONFIGURE, VIEW, requiresEdit, type registry } from "./operations";

export interface CrmAccess {
  records: "all" | "assigned";
  money: boolean;
  sensitive: boolean;
  notes: boolean;
}

const ERASED_KEYS = /^(annualRevenue|[a-z]+Value)$/;

/** Removes amounts from a response. A bare `value` is an amount only on a deal: stage rules have their own. */
export function withoutMoney(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(withoutMoney);
  if (!data || typeof data !== "object") return data;
  const source = data as Record<string, unknown>;
  const isDeal = "stageId" in source && "pipelineId" in source;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (ERASED_KEYS.test(key) || (isDeal && key === "value")) continue;
    out[key] = withoutMoney(value);
  }
  return out;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

export async function accessOf(db: CrmDb): Promise<CrmAccess> {
  const result = await db.execute(sql`SELECT crm_access() AS access`);
  const access = rowsOf(result)[0]?.access;
  const parsed = typeof access === "string" ? JSON.parse(access) : access;
  // A database that does not answer as expected closes what this file controls.
  if (!parsed || typeof parsed !== "object") {
    return { records: "assigned", money: false, sensitive: false, notes: false };
  }
  return parsed as CrmAccess;
}

/** Removes free text about people. An activity is recognized by its subject: elsewhere `description` is a label. */
export function withoutNotes(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(withoutNotes);
  if (!data || typeof data !== "object") return data;
  const source = data as Record<string, unknown>;
  const isActivity = "subject" in source && "type" in source;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    // A boolean `notes` is a dial in an access description (`get-my-access`), not text about someone.
    if ((key === "notes" || key === "lostNotes") && typeof value !== "boolean") continue;
    if (isActivity && (key === "description" || key === "outcome")) continue;
    out[key] = withoutNotes(value);
  }
  return out;
}

export function withoutFields(data: unknown, hidden: Set<string>): unknown {
  if (Array.isArray(data)) return data.map((d) => withoutFields(d, hidden));
  if (!data || typeof data !== "object") return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (key === "customFields" && value && typeof value === "object") {
      out[key] = Object.fromEntries(Object.entries(value).filter(([k]) => !hidden.has(k)));
    } else out[key] = withoutFields(value, hidden);
  }
  return out;
}

async function activeFields(db: CrmDb): Promise<EntityFieldSchema[]> {
  const rows = await db.select({ fieldSchema: crmEntityConfigs.fieldSchema }).from(crmEntityConfigs).where(eq(crmEntityConfigs.isActive, true));
  return rows.flatMap((r) => r.fieldSchema ?? []);
}

/** The custom fields this access must not read: sensitive ones without `sensitive`, currency ones without `money`. */
export async function hiddenFieldKeys(db: CrmDb, access: CrmAccess): Promise<Set<string>> {
  if (access.sensitive && access.money) return new Set();
  return new Set(
    (await activeFields(db))
      .filter((f) => (!access.sensitive && f.sensitive) || (!access.money && f.type === "currency"))
      .map((f) => f.key)
  );
}

/** Applies the dials to a response on its way out. */
export async function applyAccess(db: CrmDb, response: unknown): Promise<unknown> {
  if (!(response instanceof Response)) return response;
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json") || !response.ok) return response;
  const access = await accessOf(db);
  if (access.money && access.notes && access.sensitive) return response;
  let body: unknown = await response.clone().json();
  if (!access.money) body = withoutMoney(body);
  if (!access.notes) body = withoutNotes(body);
  if ((!access.sensitive || !access.money) && JSON.stringify(body).includes('"customFields"')) {
    const hidden = await hiddenFieldKeys(db, access);
    if (hidden.size > 0) body = withoutFields(body, hidden);
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(body), { status: response.status, headers });
}

/** The problems of a set of custom fields against their definitions. Unknown keys stay allowed. */
export function customFieldProblems(fields: EntityFieldSchema[], values: Record<string, unknown>, creating: boolean): string[] {
  const problems: string[] = [];
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === null || value === "") {
      if (creating && field.required) problems.push(`${field.key} is required`);
      continue;
    }
    const numeric = field.type === "number" || field.type === "currency";
    if (numeric && typeof value !== "number") problems.push(`${field.key} must be a number`);
    if (numeric && typeof value === "number") {
      if (field.validation?.min !== undefined && value < field.validation.min) problems.push(`${field.key} is below ${field.validation.min}`);
      if (field.validation?.max !== undefined && value > field.validation.max) problems.push(`${field.key} is above ${field.validation.max}`);
    }
    if (field.type === "boolean" && typeof value !== "boolean") problems.push(`${field.key} must be true or false`);
    if ((field.type === "date" || field.type === "datetime") && Number.isNaN(new Date(String(value)).getTime())) {
      problems.push(`${field.key} must be a date`);
    }
    if (field.type === "select" && field.options && !field.options.includes(String(value))) {
      problems.push(`${field.key} must be one of: ${field.options.join(", ")}`);
    }
    if (field.type === "multiselect") {
      const list = Array.isArray(value) ? value : [value];
      if (field.options && list.some((v) => !field.options!.includes(String(v)))) {
        problems.push(`${field.key} has values outside: ${field.options.join(", ")}`);
      }
    }
    if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) problems.push(`${field.key} must be an email`);
    if (field.type === "url" && !/^https?:\/\//i.test(String(value))) problems.push(`${field.key} must be an http(s) link`);
  }
  return problems;
}

const WRITES: Record<string, { money: string[]; entity?: "contact" | "company" | "deal" | "activity"; creating?: boolean }> = {
  "create-contact": { money: [], entity: "contact", creating: true },
  "update-contact": { money: [], entity: "contact" },
  "create-company": { money: ["annualRevenue"], entity: "company", creating: true },
  "update-company": { money: ["annualRevenue"], entity: "company" },
  "create-activity": { money: [], entity: "activity" },
  "update-activity": { money: [], entity: "activity" },
  "create-deal": { money: ["value"], entity: "deal", creating: true },
  "update-deal": { money: ["value"], entity: "deal" },
};

/** A deal being written, as far as choosing its entity goes: on update, the stored one. */
async function dealShape(
  db: CrmDb,
  operationId: string,
  body: Record<string, unknown>,
  params: unknown
): Promise<{ entityConfigId?: string | null; pipelineId?: string | null }> {
  const id = (params as { id?: unknown } | undefined)?.id;
  if (operationId === "update-deal" && typeof id === "string") {
    const [deal] = await db.select({ entityConfigId: crmDeals.entityConfigId, pipelineId: crmDeals.pipelineId }).from(crmDeals).where(eq(crmDeals.id, id));
    if (deal) return deal;
  }
  return {
    entityConfigId: typeof body.entityConfigId === "string" ? body.entityConfigId : null,
    pipelineId: typeof body.pipelineId === "string" ? body.pipelineId : null,
  };
}

/** Refuses what a subject may not write, before the handler runs. */
export async function checkWrite(db: CrmDb, operationId: string, input: { body?: unknown; params?: unknown }): Promise<void> {
  const rule = Object.prototype.hasOwnProperty.call(WRITES, operationId) ? WRITES[operationId] : undefined;
  const body = input.body as Record<string, unknown> | undefined;
  if (!rule || !body) return;
  const touchesMoney = rule.money.some((k) => body[k] !== undefined);
  const customFields = body.customFields as Record<string, unknown> | undefined;
  if (touchesMoney && !(await accessOf(db)).money) {
    throw AppError.forbidden("You do not have access to amounts in the CRM");
  }
  if (rule.entity === "activity") {
    if (typeof body.kind !== "string" || !body.kind) return;
    const kinds = await activityKinds(db);
    if (kinds.length > 0 && !kinds.some((k) => k.key === body.kind)) {
      throw AppError.validation(`Unknown activity kind: ${body.kind}. Offered: ${kinds.map((k) => k.key).join(", ")}`);
    }
    return;
  }
  if (!rule.entity || (!customFields && !rule.creating)) return;
  const config =
    rule.entity === "deal"
      ? await entityOfDeal(db, await dealShape(db, operationId, body, input.params))
      : await entityByName(db, rule.entity);
  if (!config) return;
  const problems = customFieldProblems(config.fieldSchema ?? [], customFields ?? {}, !!rule.creating);
  if (problems.length > 0) throw AppError.validation(`Custom fields: ${problems.join("; ")}`);
}

const ParamSubject = z.object({
  subjectType: z.enum(["user", "agent"]).describe("Whether the subject is a person or an agent identity"),
  subjectId: z.string().min(1).max(100).describe("User id or agent identity id"),
});
const Grant = z.object({
  records: z.enum(["all", "assigned"]).describe("`assigned`: only what it owns or created"),
  money: z.boolean().describe("Whether amounts appear in its responses"),
  sensitive: z.boolean().describe("Whether it reads privileged and confidential documents"),
  notes: z.boolean().nullable().optional().describe("Whether it reads notes about people. Default: yes for a person, no for an agent"),
  sensitiveUntil: z.string().datetime({ offset: true }).nullable().optional().describe("When the sensitive access ends"),
  reason: z.string().trim().min(3).max(500).describe("Why: it stays on record"),
});
const AccessOut = z
  .object({ records: z.enum(["all", "assigned"]), money: z.boolean(), sensitive: z.boolean(), notes: z.boolean() })
  .passthrough();
const Listing = z.object({ data: z.array(z.record(z.string(), z.unknown())) }).passthrough();
const Removed = z
  .object({ data: z.object({ subjectType: z.string(), subjectId: z.string(), deleted: z.literal(true) }) })
  .passthrough();

function requirePerson(c: Context): string {
  const user = userOf(c);
  if (!user?.id) throw AppError.unauthenticated();
  if (user.role === "agent") throw AppError.forbidden("Only a person can grant CRM access");
  return user.id;
}

export function accessOperations(routes: ReturnType<typeof registry>): void {
  routes.get(
    "/access/me",
    {
      id: "get-my-access",
      summary: "See how much of the CRM you can read",
      description:
        "What this request's person or agent can see: `records` (`all` or `assigned`), `money`, `sensitive` and `notes`. Requires CRM view access. Use it before concluding that a record or an amount does not exist.",
      access: "session",
      permission: VIEW,
      output: { schema: AccessOut },
    },
    async (c) => c.json(await accessOf(dbDe(c)))
  );

  routes.get(
    "/access",
    {
      id: "list-access-grants",
      summary: "List CRM access grants",
      description:
        "Every grant, with who gave it, why and until when. Admin only. Whoever has no grant has the default access.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      output: { schema: Listing },
    },
    async (c) => c.json({ data: await dbDe(c).select().from(crmAccessGrants) })
  );

  routes.put(
    "/access/:subjectType/:subjectId",
    {
      id: "grant-access",
      summary: "Set how much of the CRM someone can read",
      description:
        "Creates or replaces a person's or an agent's access. `sensitive: true` with `records: all` and `money: true` is read-everything. Only a person can call this, and not on themselves: agents get 403, including through an approved proposal. `sensitiveUntil` ends the sensitive access; `records` and `money` do not expire.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      sensitive: true,
      mcp: { exclude: "Granting access is a decision for a person." },
      input: { params: ParamSubject, body: Grant },
      output: { schema: AccessOut },
    },
    async (c, input) => {
      const grantedBy = requirePerson(c);
      const { subjectType, subjectId } = input.params;
      if (subjectType === "user" && subjectId === grantedBy) {
        throw AppError.forbidden("Nobody can change their own CRM access");
      }
      const body = input.body;
      const values = {
        records: body.records,
        money: body.money,
        sensitive: body.sensitive,
        notes: body.notes ?? null,
        sensitiveUntil: body.sensitiveUntil ? new Date(body.sensitiveUntil) : null,
        reason: body.reason,
        grantedBy,
        updatedAt: new Date(),
      };
      const [row] = await dbDe(c)
        .insert(crmAccessGrants)
        .values({ subjectType, subjectId, ...values })
        .onConflictDoUpdate({ target: [crmAccessGrants.subjectType, crmAccessGrants.subjectId], set: values })
        .returning();
      return c.json(row);
    }
  );

  routes.delete(
    "/access/:subjectType/:subjectId",
    {
      id: "revoke-access",
      summary: "Return someone to the default CRM access",
      description:
        "Deletes the grant: the subject goes back to all records and amounts without sensitive documents. Note this also lifts an `assigned` limit. Only a person can call this, and not on themselves. 404 if there is no grant.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      mcp: { exclude: "Changing access is a decision for a person." },
      input: { params: ParamSubject },
      output: { schema: Removed },
    },
    async (c, input) => {
      const by = requirePerson(c);
      const { subjectType, subjectId } = input.params;
      if (subjectType === "user" && subjectId === by) {
        throw AppError.forbidden("Nobody can change their own CRM access");
      }
      const removed = await dbDe(c)
        .delete(crmAccessGrants)
        .where(and(eq(crmAccessGrants.subjectType, subjectType), eq(crmAccessGrants.subjectId, subjectId)))
        .returning();
      if (removed.length === 0) throw AppError.notFound("No grant for that subject");
      return c.json({ data: { subjectType, subjectId, deleted: true as const } });
    }
  );
}

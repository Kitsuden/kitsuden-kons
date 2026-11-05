/**
 * Reading records the way an app's screens need them
 * ============================================================================
 *
 * A screen built on the CRM filters by the business's own fields, counts before it lists, reopens a task someone
 * closed by mistake and edits a document's details. These are those reads and small writes, in the same
 * vocabulary as the rest of the kon, with the same access dials.
 *
 * Filtering by a custom field is a read of that field: a filter on a field the caller cannot see would tell
 * them its value one guess at a time, so it is refused with 403, like reading it.
 */

import { AppError } from "@kitsuden/engine";
import { and, desc, eq, ilike, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";

import { accessOf, hiddenFieldKeys } from "./crm.access";
import { dbDe } from "./crm.context";
import type { CrmDb } from "./crm.db";
import { activityKinds, allFields } from "./crm.entities";
import { crmActivities, crmDocuments, type EntityFieldSchema } from "./crm.schema";
import { EDIT, VIEW, type registry } from "./operations";

const Output = z.object({}).passthrough();
const ParamId = z.object({ id: z.string().min(1).max(100).describe("Row id") });

/** `%text%` for ILIKE, with `%`, `_` and backslash taken literally. */
export function likePattern(text: string): string {
  return `%${text.slice(0, 200).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** The definitions of these custom fields, refusing an unknown one (422) or one the caller cannot read (403). */
export async function readableFields(db: CrmDb, keys: string[]): Promise<Map<string, EntityFieldSchema>> {
  const fields = await allFields(db);
  const hidden = await hiddenFieldKeys(db, await accessOf(db));
  const out = new Map<string, EntityFieldSchema>();
  for (const key of keys) {
    const field = fields.find((f) => f.key === key);
    if (!field) throw AppError.validation(`No custom field is called ${key}`);
    if (hidden.has(key)) throw AppError.forbidden(`You cannot read ${key}, so you cannot filter or group by it`);
    out.set(key, field);
  }
  return out;
}

/**
 * `cf.<key>=value` query parameters as SQL on a `customFields` column. Unknown keys answer 422; a field the
 * caller may not read answers 403. A multiselect matches when it contains the value.
 */
export async function customFieldFilters(c: Context, db: CrmDb, column: AnyColumn): Promise<SQL[]> {
  const params = Object.entries(c.req.queries() ?? {}).filter(([name]) => name.startsWith("cf."));
  if (params.length === 0) return [];
  const fields = await readableFields(db, params.map(([name]) => name.slice(3)));
  return params.map(([name, values]) => {
    const key = name.slice(3);
    const field = fields.get(key)!;
    const value = values[values.length - 1] ?? "";
    return field.type === "multiselect"
      ? sql`${column} -> ${key} @> ${JSON.stringify([value])}::jsonb`
      : sql`${column} ->> ${key} = ${value}`;
  });
}

const DocumentsQuery = z
  .object({
    dealId: z.string().optional(),
    contactId: z.string().optional().describe("Documents of the deals where this contact is the main contact"),
    companyId: z.string().optional().describe("Documents of the deals of this company"),
    category: z.string().optional(),
    search: z.string().max(200).optional().describe("Name contains this text"),
    sharedWithClient: z.enum(["true", "false"]).optional(),
    limit: z.string().optional().describe("1-200, default 50"),
    offset: z.string().optional(),
  })
  .passthrough();

const EditDocument = z
  .object({
    name: z.string().trim().min(1).max(300),
    category: z.string().trim().max(100).nullable(),
    documentType: z.string().trim().max(100).nullable(),
    sharedWithClient: z.boolean(),
    confidential: z.boolean(),
    isPrivileged: z.boolean(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .partial();

const Reopen = z.object({ reason: z.string().trim().max(1000).optional() });

function page(c: Context, max = 200): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), max);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  return { limit, offset };
}

export function recordOperations(routes: ReturnType<typeof registry>): void {
  routes.post(
    "/activities/:id/reopen",
    {
      id: "reopen-activity",
      summary: "Reopen a completed activity",
      description:
        "Clears `completedAt` and `completedBy`, so the task is pending again; an optional `reason` is added to its notes with who reopened it. 404 if it does not exist, 409 if it was not completed. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      input: { params: ParamId, body: Reopen },
      output: { schema: Output },
    },
    async (c, input) => {
      const db = dbDe(c);
      const [activity] = await db.select().from(crmActivities).where(eq(crmActivities.id, input.params.id));
      if (!activity) throw AppError.notFound("Activity not found");
      if (!activity.completedAt) throw AppError.conflict("The activity is not completed");
      const reason = input.body.reason ? `Reopened: ${input.body.reason}` : null;
      const [row] = await db
        .update(crmActivities)
        .set({
          completedAt: null,
          completedBy: null,
          notes: reason ? [activity.notes, reason].filter(Boolean).join("\n\n") : activity.notes,
          updatedAt: new Date(),
        })
        .where(eq(crmActivities.id, activity.id))
        .returning();
      return c.json({ data: row });
    }
  );

  routes.get(
    "/activity-kinds",
    {
      id: "list-activity-kinds",
      summary: "List the kinds of activity this installation uses",
      description:
        "What the business calls its activities (`hearing`, `site-visit`…), each with the `type` it maps to and a default duration, as a preset or an admin defined them in the `activity` entity. Empty when none are defined, and then any `kind` is accepted. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      output: { schema: Output },
    },
    async (c) => c.json({ data: await activityKinds(dbDe(c)) })
  );

  routes.get(
    "/documents",
    {
      id: "list-documents",
      summary: "List documents across deals",
      description:
        "Newest first, with `total`. Filters: `dealId`, `contactId`, `companyId`, `category`, `search` (name), `sharedWithClient`. Privileged and confidential documents appear only with sensitive access, as everywhere. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      input: { query: DocumentsQuery },
      output: { schema: Output },
    },
    async (c, input) => {
      const db = dbDe(c);
      const q = input.query;
      const { limit, offset } = page(c);
      const conditions: SQL[] = [];
      if (q.dealId) conditions.push(eq(crmDocuments.dealId, q.dealId));
      if (q.contactId) conditions.push(sql`${crmDocuments.dealId} IN (SELECT id FROM crm_deals WHERE contact_id = ${q.contactId})`);
      if (q.companyId) conditions.push(sql`${crmDocuments.dealId} IN (SELECT id FROM crm_deals WHERE company_id = ${q.companyId})`);
      if (q.category) conditions.push(eq(crmDocuments.category, q.category));
      if (q.search) conditions.push(ilike(crmDocuments.name, likePattern(q.search)));
      if (q.sharedWithClient) conditions.push(eq(crmDocuments.sharedWithClient, q.sharedWithClient === "true"));
      const where = conditions.length ? and(...conditions) : undefined;
      const data = await db.select().from(crmDocuments).where(where).orderBy(desc(crmDocuments.uploadedAt)).limit(limit).offset(offset);
      const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(crmDocuments).where(where);
      return c.json({ data, total: count?.total ?? 0, limit, offset });
    }
  );

  routes.patch(
    "/documents/:id",
    {
      id: "update-document",
      summary: "Change a document's details",
      description:
        "Name, `category`, `documentType`, `sharedWithClient`, `confidential`, `isPrivileged` and `metadata` (where a signature status can live). The file itself does not change: upload a new version with `create-document`. Marking it privileged or confidential hides it from whoever has no sensitive access. 404 if it does not exist or you cannot see it. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      input: { params: ParamId, body: EditDocument },
      output: { schema: Output },
    },
    async (c, input) => {
      if (Object.keys(input.body).length === 0) throw AppError.validation("Nothing to change");
      const [row] = await dbDe(c)
        .update(crmDocuments)
        .set(input.body)
        .where(eq(crmDocuments.id, input.params.id))
        .returning();
      if (!row) throw AppError.notFound("Document not found");
      return c.json({ data: row });
    }
  );
}

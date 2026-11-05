/**
 * The day's work: task inbox, agenda, people on a deal, saved views and document templates
 * ============================================================================
 *
 * All of it reads through the same RLS as the rest of the CRM, so someone limited to their assigned
 * records sees only their own work without this file having to know.
 */

import { AppError, can } from "@kitsuden/engine";
import { createId } from "@paralleldrive/cuid2";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { accessOf, hiddenFieldKeys } from "./crm.access";
import { likePattern } from "./crm.records";
import { dbDe, userOf } from "./crm.context";
import type { CrmDb } from "./crm.db";
import {
  crmActivities,
  crmCompanies,
  crmContacts,
  crmDealContacts,
  crmDeals,
  crmDocumentTemplates,
  crmSavedViews,
} from "./crm.schema";
import { CONFIGURE, EDIT, VIEW, requiresEdit, type registry } from "./operations";

const Output = z.object({}).passthrough();
const ParamId = z.object({ id: z.string().describe("Row id") });
const ParamDealContact = z.object({ id: z.string().describe("Deal id"), contactId: z.string().describe("Contact id") });
const DayMs = 86_400_000;

export type DueState = "done" | "none" | "late" | "today" | "soon" | "later";

/** Where a task stands against its date. `soon` is the next three days. */
export function dueState(dueDate: Date | string | null, completedAt: Date | string | null, now = new Date()): DueState {
  if (completedAt) return "done";
  if (!dueDate) return "none";
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.round((day(new Date(dueDate)) - day(now)) / DayMs);
  if (days < 0) return "late";
  if (days === 0) return "today";
  return days <= 3 ? "soon" : "later";
}

const WorkQuery = z
  .object({
    view: z.enum(["mine", "team", "unassigned", "done"]).optional().describe("Default `mine`"),
    dealId: z.string().optional(),
    kind: z.string().optional(),
    search: z.string().max(200).optional().describe("Subject contains this text"),
    include: z.enum(["deal"]).optional().describe("`deal` adds each task's deal title and its contact and company names"),
    limit: z.string().optional().describe("1-200 (default 100)"),
  })
  .passthrough();
const AgendaQuery = z
  .object({
    from: z.string().describe("ISO date, inclusive"),
    to: z.string().describe("ISO date, inclusive. At most 370 days after `from`"),
    assignedTo: z.string().optional(),
    type: z.string().optional().describe("`task`, `meeting`, `call`…"),
    kind: z.string().optional().describe("The installation's own kind, see `list-activity-kinds`"),
    dealId: z.string().optional(),
  })
  .passthrough();

const DealContact = z.object({
  contactId: z.string().min(1).max(100),
  role: z.string().trim().min(1).max(60).optional().describe("`decision-maker`, `payer`, `champion`… A preset suggests its own"),
});

const SavedView = z.object({
  name: z.string().trim().min(1).max(200),
  entity: z.enum(["contacts", "companies", "deals", "activities"]),
  filters: z
    .record(z.string(), z.unknown())
    .refine((v) => JSON.stringify(v).length <= 10_000, "Too large")
    .describe("The list operation's query, as stored by the panel"),
  shared: z.boolean().optional().describe("Whether the team sees it"),
});

const Template = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  body: z.string().min(1).max(200_000).describe("Text with `{{deal.title}}`, `{{contact.firstName}}`, `{{custom.x}}`, `{{ask.fee}}`"),
  active: z.boolean().optional(),
});
const Render = z.object({
  dealId: z.string().max(100).optional(),
  contactId: z.string().max(100).optional(),
  values: z.record(z.string(), z.string().max(10_000)).optional().describe("What `{{ask.x}}` asks for"),
});

const PLACEHOLDER = /\{\{\s*([a-zA-Z]+)\.([a-zA-Z0-9_-]+)\s*\}\}/g;

export interface RenderScope {
  deal?: Record<string, unknown> | null;
  contact?: Record<string, unknown> | null;
  company?: Record<string, unknown> | null;
  custom?: Record<string, unknown> | null;
  ask?: Record<string, unknown> | null;
  date?: Record<string, unknown> | null;
}

/** Fills a template. A placeholder without a value stays visible and is reported, never silently blank. */
export function renderTemplate(body: string, scope: RenderScope): { content: string; missing: string[] } {
  const missing = new Set<string>();
  const content = body.replace(PLACEHOLDER, (whole, group: string, key: string) => {
    // Own keys only: `{{constructor.name}}` must not reach into the prototype.
    const source = Object.prototype.hasOwnProperty.call(scope, group)
      ? (scope as Record<string, Record<string, unknown> | null | undefined>)[group]
      : undefined;
    const value = source && Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
    if (value === undefined || value === null || value === "") {
      missing.add(`${group}.${key}`);
      return whole;
    }
    return String(value);
  });
  return { content, missing: [...missing] };
}

async function ownViewOrAdmin(c: Parameters<typeof userOf>[0], ownerId: string): Promise<void> {
  if (ownerId === userOf(c)?.id) return;
  if (!(await can(userOf(c), "configure", null, "crm"))) throw AppError.forbidden("It is someone else's view");
}

export function withoutForbiddenScope(access: { money: boolean; notes?: boolean }, hidden: Set<string>, scope: RenderScope): RenderScope {
  // A template must not become a way around the same limits the responses have: the text it returns is a
  // response too, and a field the caller cannot read must not come back inside a letter.
  const strip = (row: Record<string, unknown> | null | undefined) => {
    if (!row) return row;
    const out = { ...row };
    if (out.customFields && typeof out.customFields === "object") {
      out.customFields = Object.fromEntries(Object.entries(out.customFields).filter(([k]) => !hidden.has(k)));
    }
    return out;
  };
  const deal = strip(scope.deal);
  const contact = strip(scope.contact);
  const company = strip(scope.company);
  const custom = scope.custom ? Object.fromEntries(Object.entries(scope.custom).filter(([k]) => !hidden.has(k))) : scope.custom;
  if (deal && !access.money) delete deal.value;
  if (access.notes === false) {
    if (deal) delete deal.lostNotes;
    if (contact) delete contact.notes;
  }
  return { ...scope, deal, contact, company, custom };
}

/** Each deal's title with its contact and company names, in one query: an inbox row needs them, not the whole deal. */
async function dealSummaries(
  db: CrmDb,
  ids: (string | null)[]
): Promise<Map<string, { id: string; title: string; contactName: string | null; companyName: string | null }>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({
      id: crmDeals.id,
      title: crmDeals.title,
      contactName: sql<string | null>`nullif(trim(coalesce(${crmContacts.firstName}, '') || ' ' || coalesce(${crmContacts.lastName}, '')), '')`,
      companyName: crmCompanies.name,
    })
    .from(crmDeals)
    .leftJoin(crmContacts, eq(crmContacts.id, crmDeals.contactId))
    .leftJoin(crmCompanies, eq(crmCompanies.id, crmDeals.companyId))
    .where(inArray(crmDeals.id, wanted));
  return new Map(rows.map((r) => [r.id, r]));
}

export function workOperations(routes: ReturnType<typeof registry>): void {
  routes.get(
    "/work",
    {
      id: "list-work",
      summary: "List the tasks to do",
      description:
        "Tasks with `dueState` (`late`, `today`, `soon`, `later`, `none`, `done`), most urgent first, and the `total` for the same filters. `view`: `mine` (default), `team`, `unassigned` or `done`; also `dealId`, `kind` and `search`. `include=deal` adds `deal: { id, title, contactName, companyName }` so a list needs no call per row. `get-work-summary` gives the counts. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      input: { query: WorkQuery },
      output: { schema: Output },
    },
    async (c, input) => {
      const me = userOf(c)?.id ?? "";
      const view = input.query.view ?? "mine";
      const limit = Math.min(Math.max(Number(input.query.limit) || 100, 1), 200);
      const filters = [eq(crmActivities.type, "task")];
      if (view === "done") filters.push(isNotNull(crmActivities.completedAt));
      else filters.push(isNull(crmActivities.completedAt));
      if (view === "mine") filters.push(eq(crmActivities.assignedTo, me));
      if (view === "unassigned") filters.push(isNull(crmActivities.assignedTo));
      if (input.query.dealId) filters.push(eq(crmActivities.dealId, input.query.dealId));
      if (input.query.kind) filters.push(eq(crmActivities.kind, input.query.kind));
      if (input.query.search) filters.push(ilike(crmActivities.subject, likePattern(input.query.search)));
      const db = dbDe(c);
      const rows = await db
        .select()
        .from(crmActivities)
        .where(and(...filters))
        .orderBy(asc(crmActivities.dueDate), desc(crmActivities.createdAt))
        .limit(limit);
      const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(crmActivities).where(and(...filters));
      const deals = input.query.include === "deal" ? await dealSummaries(db, rows.map((r) => r.dealId)) : null;
      return c.json({
        data: rows.map((t) => ({
          ...t,
          dueState: dueState(t.dueDate, t.completedAt),
          ...(deals ? { deal: (t.dealId && deals.get(t.dealId)) || null } : {}),
        })),
        total: count?.total ?? 0,
      });
    }
  );

  routes.get(
    "/work/summary",
    {
      id: "get-work-summary",
      summary: "Count the tasks to do",
      description:
        "Open tasks by `dueState` for `mine`, `unassigned` and the whole `team`, and how many are `done`: what an inbox shows on its tabs and a dashboard as late work. One call. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      output: { schema: Output },
    },
    async (c) => {
      const me = userOf(c)?.id ?? "";
      const now = new Date();
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const at = (days: number) => new Date(today + days * DayMs);
      const due = crmActivities.dueDate;
      const buckets = {
        late: sql<number>`count(*) FILTER (WHERE ${due} < ${at(0)})::int`,
        today: sql<number>`count(*) FILTER (WHERE ${due} >= ${at(0)} AND ${due} < ${at(1)})::int`,
        soon: sql<number>`count(*) FILTER (WHERE ${due} >= ${at(1)} AND ${due} < ${at(4)})::int`,
        later: sql<number>`count(*) FILTER (WHERE ${due} >= ${at(4)})::int`,
        none: sql<number>`count(*) FILTER (WHERE ${due} IS NULL)::int`,
        total: sql<number>`count(*)::int`,
      };
      const db = dbDe(c);
      const open = and(eq(crmActivities.type, "task"), isNull(crmActivities.completedAt));
      const [mine] = await db.select(buckets).from(crmActivities).where(and(open, eq(crmActivities.assignedTo, me)));
      const [unassigned] = await db.select(buckets).from(crmActivities).where(and(open, isNull(crmActivities.assignedTo)));
      const [team] = await db.select(buckets).from(crmActivities).where(open);
      const [done] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(crmActivities)
        .where(and(eq(crmActivities.type, "task"), isNotNull(crmActivities.completedAt)));
      return c.json({ mine, unassigned, team, done: { total: done?.total ?? 0 } });
    }
  );

  routes.get(
    "/agenda",
    {
      id: "get-agenda",
      summary: "See dated work between two days",
      description:
        "Every activity with a date between `from` and `to`, earliest first: meetings, calls, tasks and whatever kinds the installation defines. Filters: `assignedTo`, `type`, `kind`, `dealId`. Accounting dates such as invoice due dates come from kon-conta. Requires CRM view access. 422 if the dates are invalid or more than 370 days apart.",
      access: "session",
      permission: VIEW,
      input: { query: AgendaQuery },
      output: { schema: Output },
    },
    async (c, input) => {
      const from = new Date(input.query.from);
      const to = new Date(input.query.to);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from || to.getTime() - from.getTime() > 370 * DayMs) {
        throw AppError.validation("`from` and `to` must be dates up to 370 days apart");
      }
      to.setUTCHours(23, 59, 59, 999);
      const filters = [gte(crmActivities.dueDate, from), lte(crmActivities.dueDate, to)];
      if (input.query.assignedTo) filters.push(eq(crmActivities.assignedTo, input.query.assignedTo));
      if (input.query.kind) filters.push(eq(crmActivities.kind, input.query.kind));
      if (input.query.dealId) filters.push(eq(crmActivities.dealId, input.query.dealId));
      const type = input.query.type;
      if (type) {
        if (!(crmActivities.type.enumValues as readonly string[]).includes(type)) throw AppError.validation(`Unknown type: ${type}`);
        filters.push(eq(crmActivities.type, type as (typeof crmActivities.type.enumValues)[number]));
      }
      const data = await dbDe(c)
        .select()
        .from(crmActivities)
        .where(and(...filters))
        .orderBy(asc(crmActivities.dueDate))
        .limit(1000);
      return c.json({ data });
    }
  );

  routes.get(
    "/deals/:id/contacts",
    {
      id: "list-deal-contacts",
      summary: "List the people on a deal",
      description: "Each linked contact with its `role`. The deal's main contact is its `contactId` and is listed too. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input) => {
      const db = dbDe(c);
      const [deal] = await db.select({ contactId: crmDeals.contactId }).from(crmDeals).where(eq(crmDeals.id, input.params.id));
      if (!deal) throw AppError.notFound("Deal not found");
      const links = await db
        .select({ role: crmDealContacts.role, contact: crmContacts })
        .from(crmDealContacts)
        .innerJoin(crmContacts, eq(crmContacts.id, crmDealContacts.contactId))
        .where(eq(crmDealContacts.dealId, input.params.id));
      const data = links.map((l) => ({ ...l.contact, role: l.role }));
      if (deal.contactId && !data.some((p) => p.id === deal.contactId)) {
        const [main] = await db.select().from(crmContacts).where(eq(crmContacts.id, deal.contactId));
        if (main) data.unshift({ ...main, role: "primary" });
      }
      return c.json({ data });
    }
  );

  routes.post(
    "/deals/:id/contacts",
    {
      id: "add-deal-contact",
      summary: "Add a person to a deal",
      description: "Links a contact with a role; repeating it updates the role. 404 if the deal or the contact does not exist. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      input: { params: ParamId, body: DealContact },
      output: { schema: Output, status: 201 },
    },
    async (c, input) => {
      const db = dbDe(c);
      const [deal] = await db.select({ id: crmDeals.id }).from(crmDeals).where(eq(crmDeals.id, input.params.id));
      const [contact] = await db.select({ id: crmContacts.id }).from(crmContacts).where(eq(crmContacts.id, input.body.contactId));
      if (!deal || !contact) throw AppError.notFound("Deal or contact not found");
      const role = input.body.role ?? "other";
      await db
        .insert(crmDealContacts)
        .values({ dealId: deal.id, contactId: contact.id, role })
        .onConflictDoUpdate({ target: [crmDealContacts.dealId, crmDealContacts.contactId], set: { role } });
      return c.json({ dealId: deal.id, contactId: contact.id, role }, 201);
    }
  );

  routes.delete(
    "/deals/:id/contacts/:contactId",
    {
      id: "remove-deal-contact",
      summary: "Take a person off a deal",
      description: "The contact itself is not deleted. 404 if it was not linked. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      sensitive: false,
      input: { params: ParamDealContact },
      output: { schema: Output },
    },
    async (c, input) => {
      const removed = await dbDe(c)
        .delete(crmDealContacts)
        .where(and(eq(crmDealContacts.dealId, input.params.id), eq(crmDealContacts.contactId, input.params.contactId)))
        .returning();
      if (removed.length === 0) throw AppError.notFound("That contact is not on the deal");
      return c.json({ data: { dealId: input.params.id, contactId: input.params.contactId, deleted: true } });
    }
  );

  routes.get(
    "/views",
    {
      id: "list-saved-views",
      summary: "List saved views",
      description: "Your own views and those shared with the team. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      output: { schema: Output },
    },
    async (c) => c.json({ data: await dbDe(c).select().from(crmSavedViews).orderBy(asc(crmSavedViews.name)) })
  );

  routes.post(
    "/views",
    {
      id: "create-saved-view",
      summary: "Save a view",
      description: "Stores a list's filters under a name. Private unless `shared`. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      input: { body: SavedView },
      output: { schema: Output, status: 201 },
    },
    async (c, input) => {
      const [row] = await dbDe(c)
        .insert(crmSavedViews)
        .values({ id: createId(), ...input.body, shared: input.body.shared ?? false, ownerId: userOf(c)!.id })
        .returning();
      return c.json(row, 201);
    }
  );

  routes.delete(
    "/views/:id",
    {
      id: "delete-saved-view",
      summary: "Delete a saved view",
      description: "Its owner or an admin. 404 if it does not exist or you cannot see it. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      sensitive: false,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input) => {
      const db = dbDe(c);
      const [view] = await db.select().from(crmSavedViews).where(eq(crmSavedViews.id, input.params.id));
      if (!view) throw AppError.notFound("View not found");
      await ownViewOrAdmin(c, view.ownerId);
      await db.delete(crmSavedViews).where(eq(crmSavedViews.id, view.id));
      return c.json({ data: { id: view.id, deleted: true } });
    }
  );

  routes.get(
    "/document-templates",
    {
      id: "list-document-templates",
      summary: "List document templates",
      description: "Active templates with their text; `include=all` adds the switched-off ones, so they can be switched on again. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      input: { query: z.object({ include: z.enum(["active", "all"]).optional() }) },
      output: { schema: Output },
    },
    async (c, input) =>
      c.json({
        data: await dbDe(c)
          .select()
          .from(crmDocumentTemplates)
          .where(input.query.include === "all" ? undefined : eq(crmDocumentTemplates.active, true))
          .orderBy(asc(crmDocumentTemplates.name)),
      })
  );

  routes.post(
    "/document-templates",
    {
      id: "create-document-template",
      summary: "Create a document template",
      description: "Text with placeholders such as `{{deal.title}}` or `{{ask.fee}}`. Admin only: what it says goes out in the firm's name.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      input: { body: Template },
      output: { schema: Output, status: 201 },
    },
    async (c, input) => {
      const [row] = await dbDe(c)
        .insert(crmDocumentTemplates)
        .values({ id: createId(), ...input.body, createdBy: userOf(c)?.id ?? null })
        .returning();
      return c.json(row, 201);
    }
  );

  routes.put(
    "/document-templates/:id",
    {
      id: "update-document-template",
      summary: "Change a document template",
      description: "Admin only. 404 if it does not exist.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      input: { params: ParamId, body: Template },
      output: { schema: Output },
    },
    async (c, input) => {
      const [row] = await dbDe(c)
        .update(crmDocumentTemplates)
        .set({ ...input.body, updatedAt: new Date() })
        .where(eq(crmDocumentTemplates.id, input.params.id))
        .returning();
      if (!row) throw AppError.notFound("Template not found");
      return c.json(row);
    }
  );

  routes.post(
    "/document-templates/:id/render",
    {
      id: "render-document-template",
      summary: "Fill a document template",
      description:
        "Fills it from a deal and a contact (the deal's main contact by default) and from `values`. Returns `content` and `missing`: placeholders with no value, left visible in the text. It respects what the caller can see: without amount access, `{{deal.value}}` stays missing. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      readOnly: true,
      input: { params: ParamId, body: Render },
      output: { schema: Output },
    },
    async (c, input) => {
      const db: CrmDb = dbDe(c);
      const [template] = await db.select().from(crmDocumentTemplates).where(eq(crmDocumentTemplates.id, input.params.id));
      if (!template) throw AppError.notFound("Template not found");
      const { dealId, values } = input.body;
      const deal = dealId ? (await db.select().from(crmDeals).where(eq(crmDeals.id, dealId)))[0] : undefined;
      if (dealId && !deal) throw AppError.notFound("Deal not found");
      const contactId = input.body.contactId ?? deal?.contactId;
      const contact = contactId ? (await db.select().from(crmContacts).where(eq(crmContacts.id, contactId)))[0] : undefined;
      if (input.body.contactId && !contact) throw AppError.notFound("Contact not found");
      const companyId = deal?.companyId ?? contact?.companyId;
      const company = companyId ? (await db.select().from(crmCompanies).where(eq(crmCompanies.id, companyId)))[0] : undefined;
      const access = await accessOf(db);
      const hidden = await hiddenFieldKeys(db, access);
      const today = new Date().toISOString().slice(0, 10);
      return c.json(
        renderTemplate(
          template.body,
          withoutForbiddenScope(access, hidden, {
            deal,
            contact,
            company,
            custom: { ...((contact?.customFields as object) ?? {}), ...((deal?.customFields as object) ?? {}) },
            ask: values,
            date: { today },
          })
        )
      );
    }
  );
}


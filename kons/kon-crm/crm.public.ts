/**
 * What people outside the team reach: forms on a website and the client portal
 * ============================================================================
 *
 * Both are under `/api/crm/public/`, the one prefix the core's staff gate leaves open. Neither trusts the
 * caller: they run as the system, on purpose narrow, and answer the same whatever happened inside.
 *
 *   - A form only knows its own id. It answers 202 for a new person, a known one, a suppressed one and a bot,
 *     so it cannot be used to find out who is a client.
 *   - A portal link is a long random token, stored hashed, that expires and can be revoked. It shows only what
 *     someone marked for the client. The token travels in the body so it does not end up in access logs.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { AppError, asSystem } from "@kitsuden/engine";
import { createId } from "@paralleldrive/cuid2";
import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { dbDe, userOf } from "./crm.context";
import type { CrmDb } from "./crm.db";
import { accessOf } from "./crm.access";
import { clientRefOfCompany, clientRefOfContact, findContaBridge } from "./crm.billing";
import { entityOfDeal } from "./crm.entities";
import { runCapture } from "./crm.intake";
import {
  crmActivities,
  crmCaptureForms,
  crmContacts,
  crmDealContacts,
  crmDeals,
  crmDocuments,
  crmPipelineStages,
  crmPortalLinks,
} from "./crm.schema";
import { CONFIGURE, EDIT, requiresEdit, type registry } from "./operations";

const Output = z.object({}).passthrough();
const ParamId = z.object({ id: z.string().min(1).max(100).describe("Row id") });

const Form = z.object({
  name: z.string().trim().min(1).max(200),
  active: z.boolean().optional(),
  pipelineId: z.string().max(100).nullable().optional().describe("With `stageId`, each submission opens a deal"),
  stageId: z.string().max(100).nullable().optional(),
  source: z.string().trim().max(100).nullable().optional().describe("Stored as the contact's `source`"),
});

const Submission = z.object({
  email: z.string().trim().max(320),
  firstName: z.string().trim().max(200).optional(),
  lastName: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(50).optional(),
  companyName: z.string().trim().max(200).optional(),
  message: z.string().trim().max(5000).optional(),
  /** Hidden in the page. People leave it empty; bots fill it. */
  website: z.string().max(500).optional(),
});

const PortalRequest = z.object({ token: z.string().min(20).max(200) });
const PortalLink = z.object({
  contactId: z.string().min(1).max(100),
  days: z.number().int().min(1).max(90).optional().describe("Validity, default 14"),
  showStatement: z
    .boolean()
    .optional()
    .describe("Also show the client's issued invoices and balance from kon-conta. Off by default"),
});

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function portalLink(db: CrmDb, token: string, now = new Date()): Promise<{ contactId: string; showStatement: boolean } | null> {
  const hash = hashToken(token);
  const [link] = await db
    .select()
    .from(crmPortalLinks)
    .where(and(eq(crmPortalLinks.tokenHash, hash), isNull(crmPortalLinks.revokedAt), gt(crmPortalLinks.expiresAt, now)));
  if (!link) return null;
  const a = Buffer.from(link.tokenHash);
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b) ? { contactId: link.contactId, showStatement: link.showStatement } : null;
}

/** Adds money given as strings at the ledger's four decimals, without float drift: "10.10" + "0.20" is "10.3000". */
function addAmounts(values: string[]): string {
  const units = values.reduce((sum, v) => sum + Math.round(Number(v) * 10_000), 0);
  return (units / 10_000).toFixed(4);
}

/**
 * What a client sees. Runs as the system, so everything here is chosen on purpose: the deals marked
 * `portalVisible`, their stages, the fields their entity marks `portal` (never a sensitive one or an amount),
 * the activities and documents marked `sharedWithClient`, and with `statement` the client's issued invoices.
 */
export async function portalView(db: CrmDb, contactId: string, options: { statement: boolean }) {
  const [contact] = await db
    .select({ firstName: crmContacts.firstName, lastName: crmContacts.lastName, companyId: crmContacts.companyId })
    .from(crmContacts)
    .where(eq(crmContacts.id, contactId));
  if (!contact) return null;
  const linked = await db.select({ id: crmDealContacts.dealId }).from(crmDealContacts).where(eq(crmDealContacts.contactId, contactId));
  const rows = await db
    .select({
      id: crmDeals.id,
      title: crmDeals.title,
      status: crmDeals.status,
      stageId: crmDeals.stageId,
      pipelineId: crmDeals.pipelineId,
      entityConfigId: crmDeals.entityConfigId,
      customFields: crmDeals.customFields,
      updatedAt: crmDeals.updatedAt,
    })
    .from(crmDeals)
    .where(
      and(
        eq(crmDeals.portalVisible, true),
        or(eq(crmDeals.contactId, contactId), linked.length ? inArray(crmDeals.id, linked.map((l) => l.id)) : undefined)
      )
    );
  const pipelineIds = [...new Set(rows.map((d) => d.pipelineId))];
  const stages = pipelineIds.length
    ? await db
        .select({ id: crmPipelineStages.id, pipelineId: crmPipelineStages.pipelineId, name: crmPipelineStages.name })
        .from(crmPipelineStages)
        .where(inArray(crmPipelineStages.pipelineId, pipelineIds))
        .orderBy(asc(crmPipelineStages.order))
    : [];
  const deals = [];
  for (const d of rows) {
    const steps = stages.filter((s) => s.pipelineId === d.pipelineId);
    const entity = await entityOfDeal(db, d);
    const shown = (entity?.fieldSchema ?? []).filter((f) => f.portal && !f.sensitive && f.type !== "currency");
    const custom = (d.customFields as Record<string, unknown> | null) ?? {};
    deals.push({
      id: d.id,
      title: d.title,
      status: d.status,
      stage: steps.find((s) => s.id === d.stageId)?.name ?? null,
      stages: steps.map((s) => s.name),
      stageIndex: steps.findIndex((s) => s.id === d.stageId),
      fields: shown.filter((f) => custom[f.key] !== undefined && custom[f.key] !== null).map((f) => ({ key: f.key, label: f.label, value: custom[f.key] })),
      updatedAt: d.updatedAt,
    });
  }
  const ids = deals.map((d) => d.id);
  const events = ids.length
    ? await db
        .select({
          id: crmActivities.id,
          dealId: crmActivities.dealId,
          type: crmActivities.type,
          kind: crmActivities.kind,
          subject: crmActivities.subject,
          location: crmActivities.location,
          dueDate: crmActivities.dueDate,
        })
        .from(crmActivities)
        .where(and(inArray(crmActivities.dealId, ids), eq(crmActivities.sharedWithClient, true)))
        .orderBy(asc(crmActivities.dueDate))
    : [];
  const documents = ids.length
    ? await db
        .select({ id: crmDocuments.id, dealId: crmDocuments.dealId, name: crmDocuments.name, fileUrl: crmDocuments.fileUrl })
        .from(crmDocuments)
        .where(and(inArray(crmDocuments.dealId, ids), eq(crmDocuments.sharedWithClient, true)))
    : [];
  let statement: { balanceDue: string; invoices: unknown[] } | undefined;
  if (options.statement) {
    const bridge = await findContaBridge(db);
    const read = bridge?.clientStatement?.bind(bridge);
    if (read) {
      const refs = [clientRefOfContact(contactId), ...(contact.companyId ? [clientRefOfCompany(contact.companyId)] : [])];
      const parts = [];
      for (const clientExternalRef of refs) parts.push(await read(db, { clientExternalRef }));
      statement = { balanceDue: addAmounts(parts.map((p) => p.balanceDue)), invoices: parts.flatMap((p) => p.invoices) };
    }
  }
  return {
    contact: { firstName: contact.firstName, lastName: contact.lastName },
    deals,
    events,
    documents,
    ...(statement ? { statement } : {}),
  };
}

async function checkFormStage(db: CrmDb, pipelineId: string | null, stageId: string | null): Promise<void> {
  if (!!stageId !== !!pipelineId) throw AppError.validation("`pipelineId` and `stageId` go together");
  if (!stageId || !pipelineId) return;
  const [stage] = await db
    .select({ id: crmPipelineStages.id })
    .from(crmPipelineStages)
    .where(and(eq(crmPipelineStages.id, stageId), eq(crmPipelineStages.pipelineId, pipelineId)));
  if (!stage) throw AppError.validation("That stage is not in that pipeline");
}

export function publicOperations(routes: ReturnType<typeof registry>, root: () => CrmDb): void {
  routes.get(
    "/capture-forms",
    {
      id: "list-capture-forms",
      summary: "List public capture forms",
      description: "The forms a website can post to, with their ids. Admin only.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      output: { schema: Output },
    },
    async (c) => c.json({ data: await dbDe(c).select().from(crmCaptureForms).orderBy(desc(crmCaptureForms.createdAt)) })
  );

  routes.post(
    "/capture-forms",
    {
      id: "create-capture-form",
      summary: "Create a public capture form",
      description:
        "Returns the id a website posts to at `/api/crm/public/forms/:id`. Without a pipeline it only creates contacts. A stage from another pipeline answers 422. Admin only.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      sensitive: true,
      input: { body: Form },
      output: { schema: Output, status: 201 },
    },
    async (c, input) => {
      const db = dbDe(c);
      await checkFormStage(db, input.body.pipelineId ?? null, input.body.stageId ?? null);
      const [row] = await db
        .insert(crmCaptureForms)
        .values({ id: randomBytes(16).toString("hex"), ...input.body, createdBy: userOf(c)?.id ?? null })
        .returning();
      return c.json(row, 201);
    }
  );

  routes.patch(
    "/capture-forms/:id",
    {
      id: "update-capture-form",
      summary: "Change a public capture form",
      description:
        "Rename it, switch it off (`active: false`, posts answer 404 until it is on again) or change where its leads go. The id, which websites post to, never changes. A stage from another pipeline answers 422. Admin only. 404 if it does not exist.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      sensitive: true,
      input: { params: ParamId, body: Form.partial() },
      output: { schema: Output },
    },
    async (c, input) => {
      const db = dbDe(c);
      const [form] = await db.select().from(crmCaptureForms).where(eq(crmCaptureForms.id, input.params.id));
      if (!form) throw AppError.notFound("Form not found");
      const next = { ...form, ...input.body };
      await checkFormStage(db, next.pipelineId ?? null, next.stageId ?? null);
      const [row] = await db.update(crmCaptureForms).set(input.body).where(eq(crmCaptureForms.id, form.id)).returning();
      return c.json(row);
    }
  );

  routes.delete(
    "/capture-forms/:id",
    {
      id: "delete-capture-form",
      summary: "Delete a public capture form",
      description: "Posts to it stop being accepted at once. Contacts already captured stay. Admin only. 404 if it does not exist.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input) => {
      const removed = await dbDe(c).delete(crmCaptureForms).where(eq(crmCaptureForms.id, input.params.id)).returning();
      if (removed.length === 0) throw AppError.notFound("Form not found");
      return c.json({ data: { id: removed[0].id, deleted: true } });
    }
  );

  routes.post(
    "/public/forms/:id",
    {
      id: "submit-capture-form",
      summary: "Submit a public form",
      description:
        "For a website's own form, with no account. Always answers 202 with `{ ok: true }` once the form exists: it never says whether the person was already known or excluded. 404 if the form does not exist or is off, 422 if the email is not valid. Rate limited per connection.",
      access: "public",
      mcp: { exclude: "A form for people on a website, not a tool for agents." },
      input: { params: ParamId, body: Submission },
      output: { schema: z.object({ ok: z.literal(true) }), status: 202 },
    },
    async (c, input) => {
      const { website, ...submission } = input.body;
      const db = root();
      await asSystem(async () => {
        const [form] = await db
          .select()
          .from(crmCaptureForms)
          .where(and(eq(crmCaptureForms.id, input.params.id), eq(crmCaptureForms.active, true)));
        if (!form) throw AppError.notFound("Form not found");
        if (website) {
          return;
        }
        const result = await runCapture(db, {
          ...submission,
          source: form.source ?? "form",
          origin: "form",
          pipelineId: form.pipelineId ?? undefined,
          stageId: form.stageId ?? undefined,
        });
        if (result.action === "reject") throw AppError.validation("The email is not valid");
      });
      return c.json({ ok: true as const }, 202);
    }
  );

  routes.get(
    "/contacts/:id/portal-preview",
    {
      id: "preview-client-portal",
      summary: "See what a client's portal shows",
      description:
        "The same answer as `read-client-portal`, for staff, without making a link: what this contact would see. `statement=true` includes the invoices and balance as a link with `showStatement` would, and needs access to amounts (403). 404 if the contact does not exist or you cannot see it. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      input: { params: ParamId, query: z.object({ statement: z.enum(["true", "false"]).optional() }) },
      output: { schema: Output },
    },
    async (c, input) => {
      const db = dbDe(c);
      // The contact must be visible to the person asking; after that the view is the client's, built as the system.
      const [visible] = await db.select({ id: crmContacts.id }).from(crmContacts).where(eq(crmContacts.id, input.params.id));
      if (!visible) throw AppError.notFound("Contact not found");
      if (input.query.statement === "true" && !(await accessOf(db)).money) {
        throw AppError.forbidden("You do not have access to amounts in the CRM");
      }
      const view = await asSystem(() => portalView(root(), visible.id, { statement: input.query.statement === "true" }));
      return c.json(view);
    }
  );

  routes.post(
    "/portal-links",
    {
      id: "create-portal-link",
      summary: "Give a client a portal link",
      description:
        "Returns a token, shown only now, that lets that contact read what was marked for them through `/api/crm/public/portal`. Valid `days` days, 14 by default. With `showStatement` the portal also shows the client's issued invoices and balance from kon-conta. Only a person can create one: agents get 403. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      sensitive: true,
      mcp: { exclude: "Opening client access is a decision for a person." },
      input: { body: PortalLink },
      output: { schema: Output, status: 201 },
    },
    async (c, input) => {
      const user = userOf(c);
      if (user?.role === "agent") throw AppError.forbidden("Only a person can open client access");
      const db = dbDe(c);
      const [contact] = await db.select({ id: crmContacts.id }).from(crmContacts).where(eq(crmContacts.id, input.body.contactId));
      if (!contact) throw AppError.notFound("Contact not found");
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + (input.body.days ?? 14) * 86_400_000);
      const id = createId();
      const showStatement = input.body.showStatement ?? false;
      await db.insert(crmPortalLinks).values({ id, contactId: contact.id, tokenHash: hashToken(token), expiresAt, showStatement, createdBy: user?.id ?? null });
      return c.json({ id, token, expiresAt, showStatement }, 201);
    }
  );

  routes.get(
    "/portal-links",
    {
      id: "list-portal-links",
      summary: "List clients' portal links",
      description:
        "Who has a link, until when, and whether it was revoked; filter by `contactId`. Never the token: it was shown once, when the link was made. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      input: { query: z.object({ contactId: z.string().max(100).optional() }) },
      output: { schema: Output },
    },
    async (c, input) => {
      const rows = await dbDe(c)
        .select({
          id: crmPortalLinks.id,
          contactId: crmPortalLinks.contactId,
          expiresAt: crmPortalLinks.expiresAt,
          revokedAt: crmPortalLinks.revokedAt,
          showStatement: crmPortalLinks.showStatement,
          createdBy: crmPortalLinks.createdBy,
          createdAt: crmPortalLinks.createdAt,
        })
        .from(crmPortalLinks)
        .where(input.query.contactId ? eq(crmPortalLinks.contactId, input.query.contactId) : undefined)
        .orderBy(desc(crmPortalLinks.createdAt))
        .limit(500);
      const now = Date.now();
      return c.json({ data: rows.map((r) => ({ ...r, live: !r.revokedAt && r.expiresAt.getTime() > now })) });
    }
  );

  routes.delete(
    "/portal-links/:id",
    {
      id: "revoke-portal-link",
      summary: "Revoke a client's portal link",
      description: "It stops working at once. 404 if it does not exist. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      sensitive: false,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input) => {
      const rows = await dbDe(c)
        .update(crmPortalLinks)
        .set({ revokedAt: new Date() })
        .where(eq(crmPortalLinks.id, input.params.id))
        .returning({ id: crmPortalLinks.id });
      if (rows.length === 0) throw AppError.notFound("Link not found");
      return c.json({ data: { id: rows[0].id, revoked: true } });
    }
  );

  routes.post(
    "/public/portal",
    {
      id: "read-client-portal",
      summary: "Read a client's portal",
      description:
        "With a valid token: the contact's name; the deals marked `portalVisible` with their current `stage`, all `stages` in order and the `stageIndex`, and the `fields` their entity marks for the portal; the activities (with `kind` and `location`) and documents marked `sharedWithClient`; and, if the link was made with `showStatement`, the client's issued invoices and balance. No notes, no deal amounts, no sensitive fields. Answers 404 for an unknown, expired or revoked token alike. Rate limited per connection.",
      access: "public",
      readOnly: true,
      mcp: { exclude: "For a client with a link, not a tool for agents." },
      input: { body: PortalRequest },
      output: { schema: Output },
    },
    async (c, input) => {
      const db = root();
      const data = await asSystem(async () => {
        const link = await portalLink(db, input.body.token);
        const view = link ? await portalView(db, link.contactId, { statement: link.showStatement }) : null;
        if (!view) throw AppError.notFound("Link not valid");
        return view;
      });
      return c.json(data);
    }
  );
}

/**
 * What comes into the CRM: capture, exclusions, duplicates and merging
 * ============================================================================
 *
 * The decisions live in `crm.capture.ts` and `crm.dedupe.ts`, which are pure. These are the
 * operations that run them. A merge cannot be undone, so an agent only ever asks for one and a person
 * settles it, field by field where the two contacts disagree, whatever the approval settings are.
 */

import { AppError, can } from "@kitsuden/engine";
import { createId } from "@paralleldrive/cuid2";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";

import { planCapture, type FormSubmission } from "./crm.capture";
import { dbDe, userOf } from "./crm.context";
import type { CrmDb } from "./crm.db";
import { findDuplicates, normalizeEmail, planMerge, type ContactLike } from "./crm.dedupe";
import { emitCrm } from "./crm.events";
import { crmActivities, crmContacts, crmDeals, crmMergeRequests, crmPipelineStages, crmSuppressions } from "./crm.schema";
import { DELETE, EDIT, VIEW, requiresEdit, type registry } from "./operations";

const Output = z.object({}).passthrough();
const ParamId = z.object({ id: z.string().describe("Contact id") });
const Name = z.string().trim().max(200);

const Capture = z.object({
  email: z.string().trim().max(320),
  firstName: Name.nullable().optional(),
  lastName: Name.nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  companyName: Name.nullable().optional(),
  message: z.string().trim().max(10_000).nullable().optional(),
  source: z.string().trim().max(100).nullable().optional().describe("Where it came from: `web`, `landing-x`…"),
  campaign: z.string().trim().max(100).nullable().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  pipelineId: z.string().max(100).optional().describe("With `stageId`, also opens a deal"),
  stageId: z.string().max(100).optional(),
  dealTitle: z.string().trim().max(300).optional(),
  dryRun: z.boolean().optional().describe("Return the plan without writing"),
});

const Decision = z.object({
  decision: z.enum(["approve", "reject"]),
  resolutions: z.record(z.string(), z.enum(["keep", "absorb"])).optional(),
});

const Suppression = z.object({
  kind: z.enum(["email", "domain"]),
  value: z.string().trim().min(3).max(320).describe("The address, or the domain without `@`"),
  reason: z.string().trim().max(500).optional(),
});
const ParamSuppression = z.object({ kind: z.enum(["email", "domain"]), value: z.string().min(3).max(320) });

const Merge = z.object({
  otherId: z.string().min(1).max(100).describe("The other contact"),
  /** For each conflicting field, which side wins. A conflict left out answers 409. */
  resolutions: z.record(z.string(), z.enum(["keep", "absorb"])).optional(),
});

function normalizedSuppression(kind: "email" | "domain", value: string): string {
  return kind === "email" ? normalizeEmail(value) : value.trim().toLowerCase().replace(/^@/, "");
}

/** Whether an address is on the exclusion list, by itself or by its domain. */
export async function isSuppressed(db: CrmDb, email: string): Promise<boolean> {
  const address = normalizeEmail(email);
  const domain = address.split("@")[1] ?? "";
  const rows = await db
    .select({ kind: crmSuppressions.kind })
    .from(crmSuppressions)
    .where(
      or(
        and(eq(crmSuppressions.kind, "email"), eq(crmSuppressions.value, address)),
        and(eq(crmSuppressions.kind, "domain"), eq(crmSuppressions.value, domain))
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** Contacts that could be the same person: only by what the score can match on, so the whole base is not read. */
async function candidatesFor(db: CrmDb, contact: Partial<ContactLike>) {
  const conditions = [];
  const email = normalizeEmail(contact.email);
  if (email) conditions.push(sql`lower(${crmContacts.email}) = ${email}`);
  if (contact.phone) conditions.push(eq(crmContacts.phone, contact.phone));
  if (contact.firstName && contact.lastName) {
    conditions.push(
      sql`lower(${crmContacts.firstName}) = ${contact.firstName.toLowerCase()} AND lower(${crmContacts.lastName}) = ${contact.lastName.toLowerCase()}`
    );
  }
  if (conditions.length === 0) return [];
  return db
    .select()
    .from(crmContacts)
    .where(or(...conditions))
    .orderBy(desc(crmContacts.updatedAt))
    .limit(200);
}

export interface CaptureInput extends FormSubmission {
  pipelineId?: string;
  stageId?: string;
  dealTitle?: string;
  dryRun?: boolean;
  origin?: "manual" | "form" | "email" | "import";
}

/** One submission, from the team's API or a public form. An existing contact gains only what it lacked. */
export async function runCapture(db: CrmDb, input: CaptureInput, userId: string | null = null) {
  const { pipelineId, stageId, dealTitle, dryRun, origin, ...submission } = input;
  if (submission.email && (await isSuppressed(db, submission.email))) return { action: "suppressed" as const };
  const existing = await candidatesFor(db, submission);
  const plan = planCapture(submission, { pipelineId, stageId, dealTitle, existing });
  if (plan.action === "reject" || dryRun) return plan;

  const { campaign, ...contactFields } = plan.contact as Record<string, unknown> & { campaign?: unknown };
  const metadata = campaign ? { campaign } : {};
  const recordOrigin = origin ?? "manual";
  let contactId = plan.contactId;
  if (plan.action === "create") {
    const [row] = await db
      .insert(crmContacts)
      .values({ ...contactFields, metadata, origin: recordOrigin, createdBy: userId } as typeof crmContacts.$inferInsert)
      .returning({ id: crmContacts.id });
    contactId = row!.id;
    emitCrm("contact:created", { contactId, origin: recordOrigin });
  } else {
    // Only what was empty. `source` tells where the contact first came from, so it stays too.
    const [current] = await db.select().from(crmContacts).where(eq(crmContacts.id, contactId!));
    if (!current?.phone && contactFields.phone) {
      await db
        .update(crmContacts)
        .set({ phone: contactFields.phone as string, updatedAt: new Date() })
        .where(eq(crmContacts.id, contactId!));
    }
  }
  const activity = plan.activity as { subject: string; description: string | null; metadata: Record<string, unknown> };
  await db.insert(crmActivities).values({
    type: "note",
    subject: activity.subject,
    description: activity.description,
    metadata: activity.metadata,
    contactId,
    origin: recordOrigin,
    createdBy: userId,
  });
  let dealId: string | undefined;
  if (plan.deal) {
    const [stage] = await db
      .select({ id: crmPipelineStages.id })
      .from(crmPipelineStages)
      .where(and(eq(crmPipelineStages.id, stageId!), eq(crmPipelineStages.pipelineId, pipelineId!)));
    if (!stage) throw AppError.validation("That stage is not in that pipeline");
    const [row] = await db
      .insert(crmDeals)
      .values({ ...plan.deal, contactId, origin: recordOrigin, createdBy: userId } as typeof crmDeals.$inferInsert)
      .returning({ id: crmDeals.id });
    dealId = row!.id;
  }
  return { action: plan.action, contactId, dealId, matches: plan.matches };
}

type Resolutions = Record<string, "keep" | "absorb">;

/** The merge itself. Conflicts without a chosen side come back and nothing is written. */
async function executeMerge(db: CrmDb, contactId: string, otherId: string, resolutions: Resolutions, userId: string | null) {
  if (otherId === contactId) throw AppError.validation("A contact cannot merge with itself");
  const [a] = await db.select().from(crmContacts).where(eq(crmContacts.id, contactId));
  const [b] = await db.select().from(crmContacts).where(eq(crmContacts.id, otherId));
  if (!a || !b) throw AppError.notFound("Contact not found");
  const plan = planMerge(a, b);
  const pending = plan.conflicts.filter((x) => !resolutions[x.field]);
  if (pending.length > 0) return { conflicts: pending };
  const changes: Record<string, unknown> = { ...plan.filledFields };
  for (const conflict of plan.conflicts) {
    if (resolutions[conflict.field] === "absorb") changes[conflict.field] = conflict.absorb;
  }
  await db.update(crmDeals).set({ contactId: plan.keep }).where(eq(crmDeals.contactId, plan.absorb));
  await db.update(crmActivities).set({ contactId: plan.keep }).where(eq(crmActivities.contactId, plan.absorb));
  // People on deals move too, unless the survivor is already on that deal.
  await db.execute(sql`UPDATE crm_deal_contacts SET contact_id = ${plan.keep} WHERE contact_id = ${plan.absorb}
    AND deal_id NOT IN (SELECT deal_id FROM crm_deal_contacts WHERE contact_id = ${plan.keep})`);
  // The other contact goes first: `email` may be unique, and the survivor may be about to take it.
  await db.delete(crmContacts).where(eq(crmContacts.id, plan.absorb));
  const [kept] = await db
    .update(crmContacts)
    .set({ ...changes, updatedAt: new Date() } as Partial<typeof crmContacts.$inferInsert>)
    .where(eq(crmContacts.id, plan.keep))
    .returning();
  await db.insert(crmActivities).values({
    type: "note",
    subject: "Contacts merged",
    contactId: plan.keep,
    createdBy: userId,
    metadata: { absorbed: plan.absorb, resolutions },
  });
  return { kept, absorbed: plan.absorb };
}

export function intakeOperations(routes: ReturnType<typeof registry>): void {
  routes.post(
    "/capture",
    {
      id: "capture-lead",
      summary: "Bring a lead in from a form",
      description:
        "Turns a submission into a contact, an activity and optionally a deal. A contact that already exists gains only what it lacked: a form never overwrites a name. An address on the exclusion list writes nothing and answers `action: suppressed`. An invalid submission answers `action: reject` with its reasons. `dryRun: true` returns the plan and writes nothing. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      input: { body: Capture },
      output: { schema: Output },
    },
    async (c, input) => c.json(await runCapture(dbDe(c), input.body, userOf(c)?.id ?? null))
  );

  routes.get(
    "/suppressions",
    {
      id: "list-suppressions",
      summary: "List the CRM exclusion list",
      description: "Emails and domains that capture and import never bring in. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      output: { schema: Output },
    },
    async (c) => c.json({ data: await dbDe(c).select().from(crmSuppressions).limit(1000) })
  );

  routes.post(
    "/suppressions",
    {
      id: "add-suppression",
      summary: "Exclude an email or a domain from the CRM",
      description:
        "From now on, capture and import skip that address or domain. Existing contacts are not touched: erasing one is `delete-contact`. Repeating an entry changes nothing. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      input: { body: Suppression },
      output: { schema: Output, status: 201 },
    },
    async (c, input) => {
      const { kind, reason } = input.body;
      const value = normalizedSuppression(kind, input.body.value);
      await dbDe(c)
        .insert(crmSuppressions)
        .values({ kind, value, reason, createdBy: userOf(c)?.id ?? null })
        .onConflictDoNothing();
      return c.json({ kind, value }, 201);
    }
  );

  routes.delete(
    "/suppressions/:kind/:value",
    {
      id: "remove-suppression",
      summary: "Take an entry off the CRM exclusion list",
      description: "That address or domain can be captured again. Admin only: it may undo someone's request not to be contacted. 404 if it is not listed.",
      access: "session",
      permission: DELETE,
      before: [requiresEdit],
      input: { params: ParamSuppression },
      output: { schema: Output },
    },
    async (c, input) => {
      const { kind } = input.params;
      const value = normalizedSuppression(kind, input.params.value);
      const removed = await dbDe(c)
        .delete(crmSuppressions)
        .where(and(eq(crmSuppressions.kind, kind), eq(crmSuppressions.value, value)))
        .returning();
      if (removed.length === 0) throw AppError.notFound("That entry is not listed");
      return c.json({ data: { kind, value, deleted: true } });
    }
  );

  routes.get(
    "/contacts/:id/duplicates",
    {
      id: "find-contact-duplicates",
      summary: "Find possible duplicates of a contact",
      description:
        "Contacts that may be the same person, most likely first, each with a `rating` from 0 to 100 and the `reasons` that matched. It only suggests: merging is `merge-contacts`. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input) => {
      const db = dbDe(c);
      const [contact] = await db.select().from(crmContacts).where(eq(crmContacts.id, input.params.id));
      if (!contact) throw AppError.notFound("Contact not found");
      return c.json({ data: findDuplicates(contact, await candidatesFor(db, contact)) });
    }
  );

  routes.post(
    "/contacts/:id/merge",
    {
      id: "merge-contacts",
      summary: "Merge two contacts, or ask for it",
      description:
        "From a person with CRM delete access: the older contact survives, gaps are filled from the other one, its deals and activities move over and it is deleted. A field with different values answers 409 with the `conflicts` in `error.details`: repeat with `resolutions`. This cannot be undone. From an agent it never runs: it answers 202 with a request that a person decides with `decide-merge-request`, whatever the approval settings are.",
      access: "session",
      permission: EDIT,
      idempotent: false,
      input: { params: ParamId, body: Merge },
      output: { schema: Output, otherStatuses: [202] },
    },
    async (c, input) => {
      const db = dbDe(c);
      const user = userOf(c);
      const { otherId, resolutions = {} } = input.body;
      if (user?.role === "agent") {
        const [a] = await db.select({ id: crmContacts.id }).from(crmContacts).where(eq(crmContacts.id, input.params.id));
        const [b] = await db.select({ id: crmContacts.id }).from(crmContacts).where(eq(crmContacts.id, otherId));
        if (!a || !b || a.id === b.id) throw AppError.notFound("Contact not found");
        const id = createId();
        await db.insert(crmMergeRequests).values({ id, contactId: a.id, otherId: b.id, requestedBy: user.id! });
        return c.json({ status: "pending", requestId: id }, 202);
      }
      if (!(await can(user, "delete", null, "crm"))) {
        throw AppError.forbidden("Merging deletes a contact: it needs CRM delete access");
      }
      const result = await executeMerge(db, input.params.id, otherId, resolutions, user?.id ?? null);
      if ("conflicts" in result) {
        throw AppError.conflict("Some fields differ: choose a side for each", { conflicts: result.conflicts });
      }
      return c.json({ data: result.kept, absorbed: result.absorbed });
    }
  );

  routes.get(
    "/merge-requests",
    {
      id: "list-merge-requests",
      summary: "List merges agents asked for",
      description: "Pending first, newest first, up to 200. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      output: { schema: Output },
    },
    async (c) =>
      c.json({
        data: await dbDe(c)
          .select()
          .from(crmMergeRequests)
          .orderBy(sql`${crmMergeRequests.status} = 'pending' DESC`, desc(crmMergeRequests.createdAt))
          .limit(200),
      })
  );

  routes.post(
    "/merge-requests/:id/decision",
    {
      id: "decide-merge-request",
      summary: "Approve or reject a merge an agent asked for",
      description:
        "Only a person with CRM delete access; an agent gets 403 even with every scope. Approving runs the merge, and answers 409 with the `conflicts` in `error.details` until `resolutions` covers them. 404 if it does not exist or was already decided.",
      access: "session",
      // Deciding deletes a contact: the gate asks for it before the body, so the team gets 403 and not 422.
      permission: DELETE,
      before: [requiresEdit],
      mcp: { exclude: "This is the human side of a merge an agent asked for." },
      input: { params: ParamId, body: Decision },
      output: { schema: Output },
    },
    async (c, input) => {
      const db = dbDe(c);
      const user = userOf(c);
      if (user?.role === "agent") throw AppError.forbidden("Only a person decides a merge");
      if (!(await can(user, "delete", null, "crm"))) throw AppError.forbidden("It needs CRM delete access");
      const [request] = await db
        .select()
        .from(crmMergeRequests)
        .where(and(eq(crmMergeRequests.id, input.params.id), eq(crmMergeRequests.status, "pending")));
      if (!request) throw AppError.notFound("Request not found or already decided");
      if (input.body.decision === "approve") {
        const result = await executeMerge(db, request.contactId, request.otherId, input.body.resolutions ?? {}, user?.id ?? null);
        if ("conflicts" in result) {
          throw AppError.conflict("Some fields differ: choose a side for each", { conflicts: result.conflicts });
        }
      }
      await db
        .update(crmMergeRequests)
        .set({
          status: input.body.decision === "approve" ? "approved" : "rejected",
          decidedBy: user?.id ?? null,
          decidedAt: new Date(),
        })
        .where(eq(crmMergeRequests.id, request.id));
      return c.json({ status: input.body.decision === "approve" ? "approved" : "rejected" });
    }
  );
}

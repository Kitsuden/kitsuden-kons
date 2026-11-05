/**
 * Work and expenses on a deal go to the ledger
 * ============================================================================
 *
 * Money has one home, kon-conta. The CRM only sends it what was done and spent on a deal: a quantity of a unit
 * (hours by default, or days, pieces…) at the rate of whoever or whatever did it, and kon-conta keeps it as work in
 * progress on the deal's project until an invoice bills it. How it is billed (by time, fixed, recurring, by result)
 * is kon-conta's business.
 *
 * The deal's project carries what the ledger groups by. Which deal fields those are is the entity's
 * `metadata.conta` (`{ billingType: "feeType", category: "practiceArea" }`, set by a preset), the deal's owner is
 * the project's responsible resource, and its number field, if the entity numbers deals, is the project number.
 * Every call refreshes them, so a deal renamed or reassigned in the CRM is the same in the ledger.
 *
 * kon-conta is optional: it is reached with a runtime import, so this kon installs and compiles without it, and
 * these operations answer 409 when it is not there. The CRM decides who may log work (CRM edit access) and then
 * writes as the system, because the person logging it is rarely on the accounting team. `createdBy` keeps the real
 * author in kon-conta's audit trail, and an `externalRef` makes a retry record once.
 */

import { AppError, asSystem, can } from "@kitsuden/engine";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { dbDe, userOf } from "./crm.context";
import type { CrmDb } from "./crm.db";
import { contaMappingOf, entityByName, entityOfDeal, numberingOf } from "./crm.entities";
import { crmCompanies, crmContacts, crmDeals } from "./crm.schema";
import { EDIT, type registry } from "./operations";

interface ClientRef {
  externalRef: string;
  name: string;
  email?: string | null;
  taxId?: string;
}

export interface ContaBridge {
  ensureProject(db: unknown, input: Record<string, unknown>): Promise<{ project: { id: string; number?: string | null; clientId?: string }; created: boolean }>;
  ensureClient?(db: unknown, input: Record<string, unknown>): Promise<{ client: { id: string }; created: boolean }>;
  clientStatement?(db: unknown, input: { clientExternalRef: string }): Promise<{ balanceDue: string; invoices: unknown[] }>;
  recordProjectWork(db: unknown, input: Record<string, unknown>): Promise<unknown>;
  recordProjectExpense(db: unknown, input: Record<string, unknown>): Promise<unknown>;
}

const BRIDGE = "../kon-conta/conta.bridge";

/**
 * kon-conta's bridge, or `null` when it is not installed here. Its code can sit next to this kon in a project
 * that never installed it, so its tables decide, not the import.
 */
export async function findContaBridge(db: CrmDb): Promise<ContaBridge | null> {
  let bridge: ContaBridge;
  try {
    bridge = (await import(/* @vite-ignore */ BRIDGE)) as ContaBridge;
  } catch {
    return null;
  }
  const found = await db.execute(sql`SELECT to_regclass('conta_invoices') IS NOT NULL AS installed`);
  const rows = Array.isArray(found) ? found : ((found as { rows?: unknown[] }).rows ?? []);
  return (rows[0] as { installed?: boolean } | undefined)?.installed ? bridge : null;
}

async function contaBridge(db: CrmDb): Promise<ContaBridge> {
  const bridge = await findContaBridge(db);
  if (!bridge) throw AppError.conflict("kon-conta is not installed: work and expenses are billed there");
  return bridge;
}

type Deal = typeof crmDeals.$inferSelect;
type Contact = typeof crmContacts.$inferSelect;
type Company = typeof crmCompanies.$inferSelect;

export const clientRefOfCompany = (id: string) => `crm-company:${id}`;
export const clientRefOfContact = (id: string) => `crm-contact:${id}`;

/** The tax id field the contact or company entity names in `metadata.conta.taxId`, if any. */
async function taxIdOf(db: CrmDb, entity: "contact" | "company", customFields: unknown): Promise<string | undefined> {
  const key = contaMappingOf(await entityByName(db, entity)).taxId;
  const value = key ? (customFields as Record<string, unknown> | null)?.[key] : undefined;
  return typeof value === "string" && value ? value : undefined;
}

async function clientOfCompany(db: CrmDb, company: Company): Promise<ClientRef> {
  const taxId = await taxIdOf(db, "company", company.customFields);
  return { externalRef: clientRefOfCompany(company.id), name: company.name, ...(taxId ? { taxId } : {}) };
}

async function clientOfContact(db: CrmDb, contact: Contact): Promise<ClientRef> {
  const taxId = await taxIdOf(db, "contact", contact.customFields);
  return {
    externalRef: clientRefOfContact(contact.id),
    name: `${contact.firstName} ${contact.lastName}`.trim(),
    email: contact.email,
    ...(taxId ? { taxId } : {}),
  };
}

/** Who pays for a deal: its company, else its contact. */
async function clientOfDeal(db: CrmDb, deal: Deal): Promise<ClientRef> {
  const [company] = deal.companyId ? await db.select().from(crmCompanies).where(eq(crmCompanies.id, deal.companyId)) : [];
  if (company) return clientOfCompany(db, company);
  const [contact] = deal.contactId ? await db.select().from(crmContacts).where(eq(crmContacts.id, deal.contactId)) : [];
  if (contact) return clientOfContact(db, contact);
  throw AppError.validation("The deal needs a company or a contact to bill");
}

/** The deal's project in kon-conta, created the first time and brought up to date every time. */
async function projectFor(db: CrmDb, bridge: ContaBridge, deal: Deal) {
  const client = await clientOfDeal(db, deal);
  const entity = await entityOfDeal(db, deal);
  const mapping = contaMappingOf(entity);
  const numbering = numberingOf(entity);
  const custom = (deal.customFields as Record<string, unknown> | null) ?? {};
  const text = (key: string | undefined) => (key && typeof custom[key] === "string" && custom[key] ? (custom[key] as string) : undefined);
  return bridge.ensureProject(db, {
    externalRef: deal.id,
    name: deal.title,
    client,
    number: text(numbering?.field),
    billingType: text(mapping.billingType),
    category: text(mapping.category),
    responsibleResourceUserId: deal.assignedTo ?? undefined,
  });
}

export async function logDealWork(
  db: CrmDb,
  deal: Deal,
  input: { quantity: number; unit?: string; description: string; date?: string; externalRef?: string; userId: string | null; resourceUserId?: string }
): Promise<unknown> {
  const bridge = await contaBridge(db);
  return asSystem(async () => {
    await projectFor(db, bridge, deal);
    return bridge.recordProjectWork(db, {
      projectExternalRef: deal.id,
      resourceUserId: input.resourceUserId ?? input.userId ?? undefined,
      quantity: String(input.quantity),
      unit: input.unit,
      description: input.description,
      date: input.date,
      externalRef: input.externalRef,
      createdBy: input.userId,
    });
  });
}

const ParamId = z.object({ id: z.string().describe("Deal id") });
const ParamRecord = z.object({ id: z.string().describe("Contact or company id") });
const Work = z.object({
  quantity: z.number().positive().max(100_000).describe("How much: hours by default"),
  unit: z.string().trim().min(1).max(20).optional().describe("`hour` (default), `day`, `unit`… as the resource is billed"),
  description: z.string().trim().min(1).max(1000),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, today by default"),
  externalRef: z.string().max(100).optional().describe("Your id for this entry: repeating it records once"),
  resourceUserId: z
    .string()
    .max(100)
    .optional()
    .describe("Log it for someone else's resource (their user id). Only who can configure the CRM; the author stays you"),
});
const Expense = z.object({
  amount: z.number().positive().max(1e9),
  description: z.string().trim().min(1).max(1000),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  category: z.string().trim().max(100).optional(),
  fromClientFunds: z.boolean().optional().describe("Pay it from the money the client has deposited instead of the business's bank"),
  externalRef: z.string().max(100).optional(),
});
const BillingClient = z.object({
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  fundsMinimum: z.number().min(0).max(1e9).optional().describe("The client funds balance below which the ledger warns"),
});

async function dealOf(db: CrmDb, id: string): Promise<Deal> {
  const [deal] = await db.select().from(crmDeals).where(eq(crmDeals.id, id));
  if (!deal) throw AppError.notFound("Deal not found");
  return deal;
}

export function billingOperations(routes: ReturnType<typeof registry>): void {
  routes.post(
    "/deals/:id/project",
    {
      id: "ensure-deal-project",
      summary: "Open or refresh the deal's project in the ledger",
      description:
        "Creates the deal's project in kon-conta the first time, with the deal's company or contact as the client, and on every call brings its name, number, billing type, category and responsible resource up to date from the deal. Returns `projectId`, `projectNumber`, `clientId` and `created`: what `create-invoice` needs. 409 if kon-conta is not installed. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      idempotent: true,
      input: { params: ParamId },
      output: { schema: z.object({}).passthrough() },
    },
    async (c, input) => {
      const db = dbDe(c);
      const deal = await dealOf(db, input.params.id);
      const bridge = await contaBridge(db);
      const { project, created } = await asSystem(() => projectFor(db, bridge, deal));
      return c.json({ projectId: project.id, projectNumber: project.number ?? null, clientId: project.clientId ?? null, created });
    }
  );

  for (const kind of ["contacts", "companies"] as const) {
    routes.post(
      `/${kind}/:id/billing-client`,
      {
        id: kind === "contacts" ? "ensure-contact-billing-client" : "ensure-company-billing-client",
        summary: kind === "contacts" ? "Make a contact a client in the ledger" : "Make a company a client in the ledger",
        description:
          "Creates or updates its client in kon-conta, with optional `paymentTermsDays` and `fundsMinimum`, so it can be invoiced or hold client funds before any work is logged. Returns `clientId` and `created`. 409 if kon-conta is not installed. Requires CRM edit access.",
        access: "session",
        permission: EDIT,
        idempotent: true,
        input: { params: ParamRecord, body: BillingClient },
        output: { schema: z.object({}).passthrough() },
      },
      async (c, input) => {
        const db = dbDe(c);
        let client: ClientRef;
        if (kind === "contacts") {
          const [contact] = await db.select().from(crmContacts).where(eq(crmContacts.id, input.params.id));
          if (!contact) throw AppError.notFound("Contact not found");
          client = await clientOfContact(db, contact);
        } else {
          const [company] = await db.select().from(crmCompanies).where(eq(crmCompanies.id, input.params.id));
          if (!company) throw AppError.notFound("Company not found");
          client = await clientOfCompany(db, company);
        }
        const bridge = await contaBridge(db);
        if (!bridge.ensureClient) throw AppError.conflict("This kon-conta cannot create clients from the CRM: update it");
        const ensureClient = bridge.ensureClient.bind(bridge);
        const result = await asSystem(() =>
          ensureClient(db, {
            ...client,
            ...(input.body.paymentTermsDays !== undefined ? { paymentTermsDays: input.body.paymentTermsDays } : {}),
            ...(input.body.fundsMinimum !== undefined ? { fundsMinimum: String(input.body.fundsMinimum) } : {}),
          })
        );
        return c.json({ clientId: result.client.id, created: result.created });
      }
    );
  }

  routes.post(
    "/deals/:id/work",
    {
      id: "log-deal-work",
      summary: "Log billable work on a deal",
      description:
        "Sends it to kon-conta as unbilled work on the deal's project, created the first time with the deal's company or contact as the client. The rate and unit are those of your resource in kon-conta, or of `resourceUserId`'s if you can configure the CRM (403 otherwise); you stay the author. With `externalRef`, repeating the call records once. 409 if kon-conta is not installed. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      input: { params: ParamId, body: Work },
      output: { schema: z.object({}).passthrough(), status: 201 },
    },
    async (c, input) => {
      const db = dbDe(c);
      const me = userOf(c);
      const { resourceUserId, ...work } = input.body;
      if (resourceUserId && resourceUserId !== me?.id && !(await can(me, "configure", null, "crm"))) {
        throw AppError.forbidden("Only who configures the CRM logs work for someone else");
      }
      const deal = await dealOf(db, input.params.id);
      const result = await logDealWork(db, deal, { ...work, userId: me?.id ?? null, resourceUserId });
      return c.json(result as object, 201);
    }
  );

  routes.post(
    "/deals/:id/expenses",
    {
      id: "record-deal-expense",
      summary: "Record an expense on a deal",
      description:
        "Sends it to kon-conta to be billed to the client. `fromClientFunds` pays it from the client's deposited funds, and kon-conta refuses it if they do not cover it. With `externalRef`, repeating the call records once. 409 if kon-conta is not installed. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      input: { params: ParamId, body: Expense },
      output: { schema: z.object({}).passthrough(), status: 201 },
    },
    async (c, input) => {
      const db = dbDe(c);
      const deal = await dealOf(db, input.params.id);
      const bridge = await contaBridge(db);
      const { fromClientFunds, ...expense } = input.body;
      const result = await asSystem(async () => {
        await projectFor(db, bridge, deal);
        return bridge.recordProjectExpense(db, {
          ...expense,
          amount: String(expense.amount),
          projectExternalRef: deal.id,
          paidFrom: fromClientFunds ? "client_funds" : undefined,
          createdBy: userOf(c)?.id ?? null,
        });
      });
      return c.json(result as object, 201);
    }
  );
}

/**
 * Kitsuden CRM - API Routes
 *
 * Complete CRM API with:
 * - Companies CRUD
 * - Contacts CRUD
 * - Pipelines & Stages CRUD
 * - Deals CRUD + Kanban operations
 * - Activities CRUD
 *
 * Each route is now an OPERATION of the kon SDK (operations.ts):
 * each handler's body is the old one; what used to be middlewares (the router-wide
 * `view`/`edit` gate, `require`, `validateRequest`) is now its
 * declaration.
 */

import {
  AppError,
  can,
  eqEnum,
  postgresInputError,
  respondError,
  operationsRouter,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { eq, and, or, ilike, desc, asc, sql, inArray, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { accessOperations } from "./crm.access";
import { billingOperations } from "./crm.billing";
import { SUPPORTED_ACTIONS, runStageActions } from "./crm.automation";
import { rlsContext, dbDe, userOf } from "./crm.context";
import { entityOfDeal, formatNumber, nextNumber, numberingOf } from "./crm.entities";
import { agentOperations } from "./crm.agents";
import { evidenceOperations } from "./crm.evidence";
import { emitCrm, useCrmEvents } from "./crm.events";
import { inboundOperations } from "./crm.inbound";
import { customFieldFilters, likePattern, readableFields, recordOperations } from "./crm.records";
import type { CrmDb } from "./crm.db";
import { importOperations } from "./crm.import";
import { intakeOperations } from "./crm.intake";
import { registerCrmPolicy } from "./crm.policy";
import { presetOperations } from "./crm.presets";
import { publicOperations } from "./crm.public";
import { scoringOperations } from "./crm.scoring";
import { workOperations } from "./crm.work";
import { DELETE, CONFIGURE, EDIT, KON_ID, VIEW, requiresEdit, registry } from "./operations";

import {
  crmCompanies,
  crmContacts,
  crmPipelines,
  crmPipelineStages,
  crmDeals,
  crmActivities,
  crmEntityConfigs,
  crmStageTransitions,
  activityTypeEnum,
  priorityEnum,
  contactStatusEnum,
  dealStatusEnum,
  crmDocuments,
  type StageAction,
  type StageEntryRequirements,
  type ValidationResult,
} from "./crm.schema";

registerCrmPolicy();

// ── Input: allowlist per route ───────────────────────────────────────────────
//
// Before, each route copied `body.x` into column `x` without looking: `createdBy` could
// be set in anyone's name, `metadata`/`customFields` accepted
// any size, `fileUrl` accepted `javascript:` (and the panel draws it as a
// link) and `/deals/reorder` accepted an unbounded array. `validateRequest`
// also rejects keys it does not know (422) instead of silently dropping them.

const Id = z.string().min(1).max(100);
const Text = (max: number) => z.string().trim().max(max);
// The `refine`: "2024-13-45" matches the date pattern but is not a date;
// `new Date()` gives Invalid Date and Drizzle blows up writing it (it was a 500).
const DateField = z
  .union([
    z.string().datetime({ offset: true }),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Format YYYY-MM-DD"),
  ])
  .refine((v) => !Number.isNaN(new Date(v).getTime()), "Date that does not exist");
const UrlWeb = z
  .string()
  .max(1000)
  .refine((u) => /^https?:\/\//i.test(u), "Only http(s) links");
/** A file: own path (`/api/media/...`) or https. Never `javascript:` or `data:`. */
const FileUrl = z
  .string()
  .max(2000)
  .refine((u) => /^\/(?!\/)/.test(u) || /^https:\/\//i.test(u), "Path /... or https link");
const Json = (max: number) =>
  z
    .record(z.string(), z.unknown())
    .refine((v) => JSON.stringify(v).length <= max, "Too large");
const Tags = z.array(Text(100)).max(100);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const Company = z.object({
  name: Text(300).min(1),
  domain: Text(255).nullable(),
  industry: Text(100).nullable(),
  size: Text(20).nullable(),
  website: UrlWeb.nullable(),
  linkedin: UrlWeb.nullable(),
  address: Text(1000).nullable(),
  city: Text(100).nullable(),
  country: Text(100).nullable(),
  phone: Text(50).nullable(),
  description: Text(10000).nullable(),
  logoId: z.guid().nullable(),
  annualRevenue: z.number().int().min(0).nullable(),
  customFields: Json(50_000),
  metadata: Json(20_000),
  organizationId: Id.nullable(),
});
const CreateCompany = Company.partial().required({ name: true });
const EditCompany = Company.omit({ organizationId: true }).partial();

const Contact = z.object({
  firstName: Text(100).min(1),
  lastName: Text(100).min(1),
  email: z.string().email().max(255),
  phone: Text(50).nullable(),
  mobile: Text(50).nullable(),
  jobTitle: Text(200).nullable(),
  department: Text(200).nullable(),
  avatarId: z.guid().nullable(),
  status: z.enum(contactStatusEnum.enumValues),
  source: Text(100).nullable(),
  score: z.number().int().min(0).max(1000),
  companyId: Id.nullable(),
  assignedTo: Id.nullable(),
  linkedin: UrlWeb.nullable(),
  twitter: Text(200).nullable(),
  address: Text(1000).nullable(),
  city: Text(100).nullable(),
  country: Text(100).nullable(),
  notes: Text(20000).nullable(),
  tags: Tags,
  customFields: Json(20_000),
  metadata: Json(20_000),
  organizationId: Id.nullable(),
});
const CreateContact = Contact.partial().required({ firstName: true, lastName: true, email: true });
const EditContact = Contact.omit({ organizationId: true })
  .extend({ lastContactedAt: DateField.nullable() })
  .partial();

const Pipeline = z.object({
  name: Text(200).min(1),
  description: Text(5000).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  isDefault: z.boolean(),
  metadata: Json(20_000),
  organizationId: Id.nullable(),
});
const CreatePipeline = Pipeline.extend({ createDefaultStages: z.boolean() })
  .partial()
  .required({ name: true });
const EditPipeline = Pipeline.omit({ organizationId: true }).partial();

const Stage = z.object({
  name: Text(200).min(1),
  color: Color,
  order: z.number().int().min(0).max(10000),
  probability: z.number().int().min(0).max(100),
  wipLimit: z.number().int().min(0).max(100000).nullable(),
  metadata: Json(20_000),
});
const CreateStage = Stage.partial().required({ name: true });
const EditStage = Stage.partial();

const Deal = z.object({
  portalVisible: z.boolean(),
  title: Text(500).min(1),
  description: Text(10000).nullable(),
  value: z.number().int().min(0).max(1e12),
  currency: z.string().regex(/^[A-Z]{3}$/),
  status: z.enum(dealStatusEnum.enumValues),
  pipelineId: Id,
  stageId: Id,
  probability: z.number().int().min(0).max(100),
  contactId: Id.nullable(),
  companyId: Id.nullable(),
  assignedTo: Id.nullable(),
  expectedCloseDate: DateField.nullable(),
  source: Text(100).nullable(),
  campaign: Text(200).nullable(),
  tags: Tags,
  customFields: Json(50_000),
  metadata: Json(20_000),
  organizationId: Id.nullable(),
});
const CreateDeal = Deal.partial().required({
  title: true,
  pipelineId: true,
  stageId: true,
});
/**
 * Editing does NOT change pipeline or stage: that is `/move`, which checks the stage
 * requirements and leaves a trace. Before, a PATCH with `stageId` skipped
 * them.
 */
const EditDeal = Deal.omit({
  organizationId: true,
  pipelineId: true,
  stageId: true,
})
  .extend({ actualCloseDate: DateField.nullable() })
  .partial();

const Move = z.object({
  targetStageId: Id,
  newOrder: z.number().int().min(0).max(100000).optional(),
  skipValidation: z.boolean().optional(),
  moveReason: Text(2000).optional(),
});
const ValidateMove = z.object({ targetStageId: Id });
const Reorder = z.object({
  deals: z
    .array(z.object({ id: Id, stageId: Id, order: z.number().int().min(0).max(100000) }))
    .min(1)
    .max(500),
});

const Activity = z.object({
  type: z.enum(activityTypeEnum.enumValues),
  priority: z.enum(priorityEnum.enumValues),
  sharedWithClient: z.boolean(),
  subject: Text(500).min(1),
  description: Text(10000).nullable(),
  contactId: Id.nullable(),
  companyId: Id.nullable(),
  dealId: Id.nullable(),
  assignedTo: Id.nullable(),
  dueDate: DateField.nullable(),
  durationMinutes: z.number().int().min(0).max(100000).nullable(),
  kind: Text(100).nullable().describe("The business's own word for it (`hearing`, `site-visit`); see `list-activity-kinds`"),
  location: Text(500).nullable(),
  outcome: Text(2000).nullable(),
  notes: Text(20000).nullable(),
  metadata: Json(20_000),
  organizationId: Id.nullable(),
});
const CreateActivity = Activity.partial().required({ type: true, subject: true });
const EditActivity = Activity.omit({ organizationId: true }).partial();
const CompleteActivity = z.object({
  outcome: Text(2000).optional(),
  notes: Text(20000).optional(),
});

const StageAction = z.object({
  type: z.enum(SUPPORTED_ACTIONS),
  template: Text(200).optional(),
  title: Text(500).optional(),
  field: Text(100).optional(),
  value: z.unknown().optional(),
  condition: z.object({ field: Text(100), operator: Text(10), value: z.unknown() }).optional(),
});
const StageRequirements = z.object({
  requiredFields: z.array(Text(100)).max(100).optional(),
  requiredDocuments: z.array(Text(100)).max(100).optional(),
  customValidations: z
    .array(
      z.object({
        field: Text(100),
        operator: z.enum(["==", "!=", ">", "<", ">=", "<=", "exists"]),
        value: z.unknown().optional(),
      })
    )
    .max(100)
    .optional(),
});
const StageConfig = z
  .object({
    trackTimeInStage: z.boolean(),
    estimatedDays: z.number().int().min(0).max(3650).nullable(),
    entryRequirements: StageRequirements,
    onEnterActions: z.array(StageAction).max(50),
    onExitActions: z.array(StageAction).max(50),
  })
  .partial();

const EntityField = z.object({
  key: Text(100).min(1),
  sensitive: z.boolean().optional(),
  portal: z.boolean().optional().describe("Shown to the client in the portal; never when sensitive or an amount"),
  type: z.enum([
    "text",
    "number",
    "currency",
    "date",
    "datetime",
    "select",
    "multiselect",
    "boolean",
    "email",
    "url",
    "file",
    "contact",
    "company",
  ]),
  label: Text(200).min(1),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  options: z.array(Text(200)).max(200).optional(),
  validation: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      pattern: Text(500).optional(),
    })
    .optional(),
  calendarSync: z.boolean().optional(),
  reminderDays: z.array(z.number().int().min(0).max(3650)).max(20).optional(),
});

const Entity = z.object({
  konId: Text(100).min(1),
  entityName: Text(100).min(1),
  singularLabel: Text(100).min(1),
  pluralLabel: Text(100).min(1),
  requiresContact: z.boolean(),
  requiresCompany: z.boolean(),
  allowsValue: z.boolean(),
  allowsTimeTracking: z.boolean(),
  fieldSchema: z.array(EntityField).max(200),
  defaultPipelineId: Id.nullable(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  metadata: Json(20_000),
});
const CreateEntity = Entity.partial().required({
  konId: true,
  entityName: true,
  singularLabel: true,
  pluralLabel: true,
});
const EditEntity = Entity.omit({ konId: true }).partial();

const DocumentRecord = z.object({
  dealId: Id,
  sharedWithClient: z.boolean().optional(),
  name: Text(300).min(1),
  fileUrl: FileUrl,
  fileType: Text(100).optional(),
  fileSize: z.number().int().min(0).max(10_000_000_000).optional(),
  documentType: Text(100).optional(),
  category: Text(100).optional(),
  requiredForStageId: Id.optional(),
  isRequired: z.boolean().optional(),
  isPrivileged: z.boolean().optional(),
  confidential: z.boolean().optional(),
  metadata: Json(20_000).optional(),
});

// ── Parameters, query and outputs (OpenAPI and MCP) ──────────────────────────
//
// Ids go as text: the handler gives a 404 for what does not exist. Validating them here
// would turn that 404 into a 422. The query, with `passthrough`: unknown
// keys were ignored.

const ParamId = z.object({ id: z.string().describe("Row id") });

const Page = {
  limit: z.string().optional().describe("Page size, 1-100 (default 50)"),
  offset: z.string().optional().describe("Rows to skip (default 0)"),
};
const OrganizationQuery = z.object({ organizationId: z.string().optional() }).passthrough();
const CompaniesQuery = z
  .object({
    organizationId: z.string().optional(),
    industry: z.string().optional(),
    search: z.string().optional().describe("Name or domain contains this text"),
    ...Page,
  })
  .passthrough();
const ContactsQuery = z
  .object({
    organizationId: z.string().optional(),
    companyId: z.string().optional(),
    status: z.string().optional().describe("Contact status (ignored if not a valid one)"),
    assignedTo: z.string().optional(),
    search: z.string().optional().describe("First name, last name or email contains this text"),
    ...Page,
  })
  .passthrough();
const DealsQuery = z
  .object({
    organizationId: z.string().optional(),
    pipelineId: z.string().optional(),
    stageId: z.string().optional(),
    status: z.string().optional().describe("Deal status (ignored if not a valid one)"),
    contactId: z.string().optional(),
    companyId: z.string().optional(),
    assignedTo: z.string().optional(),
    search: z.string().optional().describe("Title contains this text"),
    ...Page,
  })
  .passthrough();
const ActivitiesQuery = z
  .object({
    organizationId: z.string().optional(),
    contactId: z.string().optional(),
    companyId: z.string().optional(),
    dealId: z.string().optional(),
    type: z.string().optional().describe("Activity type (ignored if not a valid one)"),
    assignedTo: z.string().optional(),
    completed: z.string().optional().describe("`true` or `false`"),
    kind: z.string().optional().describe("The installation's activity kind, see `list-activity-kinds`"),
    ...Page,
  })
  .passthrough();
const EntitiesQuery = z.object({ konId: z.string().optional() }).passthrough();
const CycleQuery = z
  .object({
    pipelineId: z.string().optional().describe("Required (400 without it)"),
    startDate: z.string().optional().describe("ISO date: transitions entered from"),
    endDate: z.string().optional().describe("ISO date: transitions entered until"),
  })
  .passthrough();

/** A row (company, contact, deal…): lax on purpose. */
const Row = z.object({ id: z.string() }).passthrough();
/** `count(*)` arrives as text or number depending on the driver. */
const Account = z.union([z.number(), z.string()]);
const RowResponse = z.object({ data: Row }).passthrough();
const RowsResponse = z.object({ data: z.array(Row) }).passthrough();
const ListResponse = z
  .object({
    data: z.array(Row),
    pagination: z.object({ total: Account, limit: z.number().int(), offset: z.number().int() }),
  })
  .passthrough();
/** What a delete answers: the id it was asked for, whether or not the row existed. */
const DeletedResponse = z
  .object({ data: z.object({ id: z.string(), deleted: z.literal(true) }) })
  .passthrough();
const DataResponse = z.object({ data: z.record(z.string(), z.unknown()) }).passthrough();
const RecordsResponse = z
  .object({ data: z.array(z.record(z.string(), z.unknown())) })
  .passthrough();
const BoardResponse = z
  .object({
    data: z.object({ pipeline: Row, stages: z.array(Row) }).passthrough(),
  })
  .passthrough();
const ReorderResponse = z.object({ updated: z.number().int() }).passthrough();

/**
 * Data that Postgres does not accept (a reference to a row that does not exist, a
 * deletion that another row prevents, an out-of-range value) is the fault of the
 * INPUT, not the server: before it came out as a 500 "Failed to …".
 *
 * It is THROWN, not answered from the `catch`. The statement that failed left the request's
 * transaction aborted; a response returned from here made the host commit it, and a COMMIT of
 * an aborted transaction is a silent ROLLBACK on Postgres but an error on PGlite (the 409 became
 * a 500). Thrown, the router's `onError` (`createCRMRouter`) writes the same envelope
 * (`respondError` reads the SQLSTATE) and the host rolls the transaction back.
 *
 * The driver's error goes up as it is, not as an `AppError`: the SDK answers an `AppError` itself
 * and the transaction would still be committed.
 */
function throwInputError(error: unknown): void {
  if (postgresInputError(error)) throw error;
}

/** Bounded pagination. A negative offset was a Postgres 500. */
function pagination(c: Context): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") ?? "", 10) || 50, 1), 100);
  const raw = Number.parseInt(c.req.query("offset") ?? "", 10);
  const offset = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1_000_000) : 0;
  return { limit, offset };
}

/** The user's `%` and `_` are text, not wildcards. */
/**
 * The filters `list-deals` and `count-deals` share. All in one array and one `.where()`: a second
 * `.where()` replaces the first, and once that threw the organization filter away.
 */
async function dealConditions(c: Context): Promise<SQL[]> {
  const q = (name: string) => c.req.query(name);
  const conditions: SQL[] = [];
  if (q("organizationId")) conditions.push(eq(crmDeals.organizationId, q("organizationId")!));
  if (q("pipelineId")) conditions.push(eq(crmDeals.pipelineId, q("pipelineId")!));
  if (q("stageId")) conditions.push(eq(crmDeals.stageId, q("stageId")!));
  // `eqEnum` returns undefined if the value does not belong to the enum.
  const status = eqEnum(crmDeals.status, q("status"));
  if (status) conditions.push(status);
  if (q("contactId")) conditions.push(eq(crmDeals.contactId, q("contactId")!));
  if (q("companyId")) conditions.push(eq(crmDeals.companyId, q("companyId")!));
  if (q("assignedTo")) conditions.push(eq(crmDeals.assignedTo, q("assignedTo")!));
  const search = q("search");
  if (search) {
    const like = pattern(search);
    conditions.push(
      or(
        ilike(crmDeals.title, like),
        sql`EXISTS (SELECT 1 FROM crm_contacts ct WHERE ct.id = ${crmDeals.contactId} AND (ct.first_name || ' ' || ct.last_name) ILIKE ${like})`,
        sql`EXISTS (SELECT 1 FROM crm_companies co WHERE co.id = ${crmDeals.companyId} AND co.name ILIKE ${like})`
      )!
    );
  }
  conditions.push(...(await customFieldFilters(c, dbDe(c), crmDeals.customFields)));
  return conditions;
}

const pattern = likePattern;

function dateOrNull(v: string | null | undefined): Date | null {
  return v ? new Date(v) : null;
}

// `c.get(k)` on a Hono without typed Variables resolves to `never`/{}.
// This helper types the access without changing the router's public signature
// (KonRouterFactory requires a bare `Hono`).
function ctxGet<T>(c: unknown, key: string): T | undefined {
  return (c as { get(k: string): unknown }).get(key) as T | undefined;
}

/**
 * The kon's operations, in the order in which the routes were registered (the
 * same resolution order as before).
 *
 * The gate that used to sit in front of the whole router (no session 401; with
 * a session but not on the team 403; reading asks for `view` and writing `edit`) and
 * the `require("delete" | "configure")` of the delete and configuration routes
 * are now the `access`, the `permission` and the `before` of each operation
 * (operations.ts).
 */
export function crmOperations(ctx: KonContext): AnyOperation[] {
  const crmRoutes = registry();
  useCrmEvents(ctx.events);
  const { logger } = ctx;

  /** Who deletes an activity or document: its author or an admin. */
  async function requireAuthorship(c: Context, author: string | null) {
    if (!(await can(userOf(c), "delete", { author }, "crm-authorship"))) {
      throw AppError.forbidden("Only its author or an administrator can delete it");
    }
  }

  // ============================================================================
  // COMPANIES
  // ============================================================================

  /**
   * GET /api/crm/companies
   * List companies with pagination and filters
   */
  crmRoutes.get(
    "/companies",
    {
      id: "list-companies",
      summary: "List CRM companies",
      description:
        "Companies (accounts) newest-updated first, paginated, with `logoUrl`. Filters: `organizationId`, `industry`, `search` (name or domain). `pagination.total` counts the same filter. CRM team only (admin/editor, or an agent with `crm:*`).",
      access: "session",
      permission: VIEW,
      input: { query: CompaniesQuery },
      output: { schema: ListResponse },
    },
    async (c, input) => {
      try {
        const orgId = c.req.query("organizationId");
        const industry = c.req.query("industry");
        const search = c.req.query("search");
        const { limit, offset } = pagination(c);

        // Conditions ACCUMULATE and `.where()` is called only once.
        //
        // Chaining `query = query.where(...)` does not add them up: each call
        // REPLACES the previous one, with no error. With `?organizationId=X&industry=Y`
        // only `industry` was applied, so the response brought companies from
        // ALL organizations — the filter that was lost was precisely the
        // isolation one.
        //
        // The search one uses `or()` and not a raw `sql` with OR inside: an
        // `sql\`A OR B\`` carries no parentheses of its own, and when combined with AND
        // SQL precedence turns it into `(org AND A) OR B` — which again
        // leaks other organizations' data, now through the back door.
        const conditionsValue = [];
        if (orgId) conditionsValue.push(eq(crmCompanies.organizationId, orgId));
        if (industry) conditionsValue.push(eq(crmCompanies.industry, industry));
        if (search) {
          conditionsValue.push(
            or(ilike(crmCompanies.name, pattern(search)), ilike(crmCompanies.domain, pattern(search)))
          );
        }
        conditionsValue.push(...(await customFieldFilters(c, dbDe(c), crmCompanies.customFields)));
        const filter = conditionsValue.length > 0 ? and(...conditionsValue) : undefined;

        // In series, not with `Promise.all`: the request has ONE connection (the
        // host's RLS transaction) and queries go one at a time.
        const companies = await dbDe(c)
          .select()
          .from(crmCompanies)
          .where(filter)
          .orderBy(desc(crmCompanies.updatedAt))
          .limit(limit)
          .offset(offset);
        // The SAME filter as the page. Before, it counted only by `orgId`, so
        // when searching the total did not match what was seen and the
        // pagination showed empty pages at the end.
        const countResult = await dbDe(c)
          .select({ count: sql<number>`count(*)` })
          .from(crmCompanies)
          .where(filter);

        // Transform logo IDs to URLs
        const companiesWithLogo = companies.map((company: typeof crmCompanies.$inferSelect) => ({
          ...company,
          logoUrl: company.logoId ? `/api/media/preset/${company.logoId}/small` : null,
        }));

        return c.json({
          data: companiesWithLogo,
          pagination: {
            total: countResult[0]?.count ?? 0,
            limit,
            offset,
          },
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error fetching companies:", { error });
        throw error;
      }
    }
  );

  /**
   * POST /api/crm/companies
   * Create a new company
   */
  crmRoutes.post(
    "/companies",
    {
      id: "create-company",
      summary: "Create a CRM company",
      description:
        "Creates a company (only `name` is required). The author is the caller, never the body. Returns the row with `logoUrl`. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { body: CreateCompany },
      output: { schema: RowResponse, status: 201 },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const body = input.body as z.infer<typeof CreateCompany>;

        const [company] = await dbDe(c)
          .insert(crmCompanies)
          .values({
            name: body.name,
            domain: body.domain,
            industry: body.industry,
            size: body.size,
            website: body.website,
            linkedin: body.linkedin,
            address: body.address,
            city: body.city,
            country: body.country,
            phone: body.phone,
            description: body.description,
            logoId: body.logoId,
            annualRevenue: body.annualRevenue,
            customFields: body.customFields || {},
            metadata: body.metadata || {},
            createdBy: userOf(c)?.id,
            organizationId: body.organizationId,
          })
          .returning();

        logger.info("[CRM] Company created", { companyId: company.id });
        return c.json(
          {
            data: {
              ...company,
              logoUrl: company.logoId ? `/api/media/preset/${company.logoId}/small` : null,
            },
          },
          201
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error creating company:", { error });
        throw error;
      }
    }
  );

  /**
   * GET /api/crm/companies/:id
   * Get company with contacts count
   */
  crmRoutes.get(
    "/companies/:id",
    {
      id: "get-company",
      summary: "Read a CRM company",
      description:
        "One company with `logoUrl` and `stats` (contacts count, deals count, total deal value). 404 if it does not exist. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { params: ParamId },
      output: { schema: RowResponse },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      try {
        const companyId = c.req.param("id");

        const [company] = await dbDe(c)
          .select()
          .from(crmCompanies)
          .where(eq(crmCompanies.id, companyId));

        if (!company) {
          throw AppError.notFound("Company not found");
        }

        // Get contacts count
        const [contactsCount] = await dbDe(c)
          .select({ count: sql<number>`count(*)` })
          .from(crmContacts)
          .where(eq(crmContacts.companyId, companyId));

        // Get deals count and total value
        const [dealsAgg] = await dbDe(c)
          .select({
            count: sql<number>`count(*)`,
            totalValue: sql<number>`coalesce(sum(${crmDeals.value}), 0)`,
          })
          .from(crmDeals)
          .where(eq(crmDeals.companyId, companyId));

        return c.json({
          data: {
            ...company,
            logoUrl: company.logoId ? `/api/media/preset/${company.logoId}/small` : null,
            stats: {
              contactsCount: contactsCount.count,
              dealsCount: dealsAgg.count,
              totalDealValue: dealsAgg.totalValue,
            },
          },
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error fetching company:", { error });
        throw error;
      }
    }
  );

  /**
   * PATCH /api/crm/companies/:id
   * Update company
   */
  crmRoutes.patch(
    "/companies/:id",
    {
      id: "update-company",
      summary: "Update a CRM company",
      description:
        "Partial update of a company (any field of the create body except `organizationId`). Returns the updated row; 404 if it does not exist. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { params: ParamId, body: EditCompany },
      output: { schema: RowResponse },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const companyId = c.req.param("id");
        const body = input.body as z.infer<typeof EditCompany>;

        const updateData: Record<string, unknown> = {
          updatedAt: new Date(),
        };

        const fields = [
          "name",
          "domain",
          "industry",
          "size",
          "website",
          "linkedin",
          "address",
          "city",
          "country",
          "phone",
          "description",
          "logoId",
          "annualRevenue",
          "customFields",
          "metadata",
        ];

        for (const field of fields) {
          if ((body as Record<string, unknown>)[field] !== undefined) {
            updateData[field] = (body as Record<string, unknown>)[field];
          }
        }

        const [company] = await dbDe(c)
          .update(crmCompanies)
          .set(updateData)
          .where(eq(crmCompanies.id, companyId))
          .returning();

        if (!company) {
          throw AppError.notFound("Company not found");
        }

        return c.json({
          data: {
            ...company,
            logoUrl: company.logoId ? `/api/media/preset/${company.logoId}/small` : null,
          },
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error updating company:", { error });
        throw error;
      }
    }
  );

  /**
   * DELETE /api/crm/companies/:id
   * Delete company (contacts will have companyId set to null)
   */
  crmRoutes.delete(
    "/companies/:id",
    {
      id: "delete-company",
      summary: "Delete a CRM company",
      description:
        "Deletes a company; its contacts and deals keep existing with `companyId` set to null, its activities are deleted. Answers `{ data: { id, deleted: true } }` even if the id did not exist. Admin only.",
      access: "session",
      permission: DELETE,
      before: [requiresEdit],
      input: { params: ParamId },
      output: { schema: DeletedResponse },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const companyId = c.req.param("id");

        await dbDe(c).delete(crmCompanies).where(eq(crmCompanies.id, companyId));

        logger.info("[CRM] Company deleted", { companyId });
        return c.json({ data: { id: companyId, deleted: true } });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error deleting company:", { error });
        throw error;
      }
    }
  );

  // ============================================================================
  // CONTACTS
  // ============================================================================

  /**
   * GET /api/crm/contacts
   * List contacts with pagination and filters
   */
  crmRoutes.get(
    "/contacts",
    {
      id: "list-contacts",
      summary: "List CRM contacts",
      description:
        "Contacts newest-updated first, paginated, with `avatarUrl`. Filters: `organizationId`, `companyId`, `status`, `assignedTo`, `search` (first name, last name or email). CRM team only.",
      access: "session",
      permission: VIEW,
      input: { query: ContactsQuery },
      output: { schema: ListResponse },
    },
    async (c, input) => {
      try {
        const orgId = c.req.query("organizationId");
        const companyId = c.req.query("companyId");
        const status = c.req.query("status");
        const assignedTo = c.req.query("assignedTo");
        const search = c.req.query("search");
        const { limit, offset } = pagination(c);

        // The search goes into the SAME array as the rest. Before it came in a
        // second `.where()`, which in Drizzle does not add but replaces: searching
        // a name suddenly erased the organization, company,
        // state and owner filters.
        const conditions = [];
        if (orgId) conditions.push(eq(crmContacts.organizationId, orgId));
        if (companyId) conditions.push(eq(crmContacts.companyId, companyId));
        // `eqEnum` returns undefined if the value does not belong to the enum.
        const filter326 = eqEnum(crmContacts.status, status);
        if (filter326) conditions.push(filter326);
        if (assignedTo) conditions.push(eq(crmContacts.assignedTo, assignedTo));
        if (search) {
          conditions.push(
            or(
              ilike(crmContacts.firstName, pattern(search)),
              ilike(crmContacts.lastName, pattern(search)),
              ilike(crmContacts.email, pattern(search))
            )
          );
        }
        conditions.push(...(await customFieldFilters(c, dbDe(c), crmContacts.customFields)));
        const filter = conditions.length > 0 ? and(...conditions) : undefined;

        // In series: one connection per request, one query at a time.
        const contacts = await dbDe(c)
          .select()
          .from(crmContacts)
          .where(filter)
          .orderBy(desc(crmContacts.updatedAt))
          .limit(limit)
          .offset(offset);
        const countResult = await dbDe(c)
          .select({ count: sql<number>`count(*)` })
          .from(crmContacts)
          .where(filter);

        // Transform avatar IDs to URLs
        const contactsWithAvatar = contacts.map((contact: typeof crmContacts.$inferSelect) => ({
          ...contact,
          avatarUrl: contact.avatarId ? `/api/media/preset/${contact.avatarId}/thumbnail` : null,
        }));

        return c.json({
          data: contactsWithAvatar,
          pagination: {
            total: countResult[0]?.count ?? 0,
            limit,
            offset,
          },
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error fetching contacts:", { error });
        throw error;
      }
    }
  );

  /**
   * POST /api/crm/contacts
   * Create a new contact
   */
  crmRoutes.post(
    "/contacts",
    {
      id: "create-contact",
      summary: "Create a CRM contact",
      description:
        "Creates a contact (`firstName`, `lastName` and `email` required; status defaults to `lead`). The author is the caller; `createdBy` in the body is rejected. Returns the row with `avatarUrl`. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { body: CreateContact },
      output: { schema: RowResponse, status: 201 },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const body = input.body as z.infer<typeof CreateContact>;

        const [contact] = await dbDe(c)
          .insert(crmContacts)
          .values({
            firstName: body.firstName,
            lastName: body.lastName,
            email: body.email,
            phone: body.phone,
            mobile: body.mobile,
            jobTitle: body.jobTitle,
            department: body.department,
            avatarId: body.avatarId,
            status: body.status || "lead",
            source: body.source,
            score: body.score || 0,
            companyId: body.companyId,
            assignedTo: body.assignedTo,
            linkedin: body.linkedin,
            twitter: body.twitter,
            address: body.address,
            city: body.city,
            country: body.country,
            notes: body.notes,
            tags: body.tags || [],
            customFields: body.customFields || {},
            metadata: body.metadata || {},
            createdBy: userOf(c)?.id,
            organizationId: body.organizationId,
          })
          .returning();

        emitCrm("contact:created", { contactId: contact.id, origin: contact.origin });
        logger.info("[CRM] Contact created", { contactId: contact.id });
        return c.json(
          {
            data: {
              ...contact,
              avatarUrl: contact.avatarId
                ? `/api/media/preset/${contact.avatarId}/thumbnail`
                : null,
            },
          },
          201
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error creating contact:", { error });
        throw error;
      }
    }
  );

  /**
   * GET /api/crm/contacts/:id
   * Get contact with company info
   */
  crmRoutes.get(
    "/contacts/:id",
    {
      id: "get-contact",
      summary: "Read a CRM contact",
      description:
        "One contact with `avatarUrl`, its `company` (or null) and `stats` (deals count and total value). 404 if it does not exist. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { params: ParamId },
      output: { schema: RowResponse },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      try {
        const contactId = c.req.param("id");

        const [contact] = await dbDe(c)
          .select()
          .from(crmContacts)
          .where(eq(crmContacts.id, contactId));

        if (!contact) {
          throw AppError.notFound("Contact not found");
        }

        // Get company if exists
        let company = null;
        if (contact.companyId) {
          const [co] = await dbDe(c)
            .select()
            .from(crmCompanies)
            .where(eq(crmCompanies.id, contact.companyId));
          company = co || null;
        }

        // Get deals count
        const [dealsAgg] = await dbDe(c)
          .select({
            count: sql<number>`count(*)`,
            totalValue: sql<number>`coalesce(sum(${crmDeals.value}), 0)`,
          })
          .from(crmDeals)
          .where(eq(crmDeals.contactId, contactId));

        return c.json({
          data: {
            ...contact,
            avatarUrl: contact.avatarId ? `/api/media/preset/${contact.avatarId}/thumbnail` : null,
            company,
            stats: {
              dealsCount: dealsAgg.count,
              totalDealValue: dealsAgg.totalValue,
            },
          },
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error fetching contact:", { error });
        throw error;
      }
    }
  );

  /**
   * PATCH /api/crm/contacts/:id
   * Update contact
   */
  crmRoutes.patch(
    "/contacts/:id",
    {
      id: "update-contact",
      summary: "Update a CRM contact",
      description:
        "Partial update of a contact (also `lastContactedAt`). Returns the updated row with `avatarUrl`; 404 if it does not exist. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { params: ParamId, body: EditContact },
      output: { schema: RowResponse },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const contactId = c.req.param("id");
        const body = input.body as z.infer<typeof EditContact>;

        const updateData: Record<string, unknown> = {
          updatedAt: new Date(),
        };

        const fields = [
          "firstName",
          "lastName",
          "email",
          "phone",
          "mobile",
          "jobTitle",
          "department",
          "avatarId",
          "status",
          "source",
          "score",
          "companyId",
          "assignedTo",
          "linkedin",
          "twitter",
          "address",
          "city",
          "country",
          "notes",
          "tags",
          "customFields",
          "metadata",
          "lastContactedAt",
        ];

        for (const field of fields) {
          if ((body as Record<string, unknown>)[field] !== undefined) {
            updateData[field] = (body as Record<string, unknown>)[field];
          }
        }
        // `timestamp` column: Drizzle needs a Date, not the body's text.
        if (body.lastContactedAt !== undefined) {
          updateData.lastContactedAt = dateOrNull(body.lastContactedAt);
        }

        const [contact] = await dbDe(c)
          .update(crmContacts)
          .set(updateData)
          .where(eq(crmContacts.id, contactId))
          .returning();

        if (!contact) {
          throw AppError.notFound("Contact not found");
        }

        return c.json({
          data: {
            ...contact,
            avatarUrl: contact.avatarId ? `/api/media/preset/${contact.avatarId}/thumbnail` : null,
          },
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error updating contact:", { error });
        throw error;
      }
    }
  );

  /**
   * DELETE /api/crm/contacts/:id
   * Delete contact
   */
  crmRoutes.delete(
    "/contacts/:id",
    {
      id: "delete-contact",
      summary: "Delete a CRM contact",
      description:
        "Deletes a contact (the erasure of a person): their deals keep existing with `contactId` null, their activities are deleted. Answers `{ data: { id, deleted: true } }` even if the id did not exist. Admin only.",
      access: "session",
      permission: DELETE,
      before: [requiresEdit],
      input: { params: ParamId },
      output: { schema: DeletedResponse },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const contactId = c.req.param("id");

        await dbDe(c).delete(crmContacts).where(eq(crmContacts.id, contactId));

        logger.info("[CRM] Contact deleted", { contactId });
        return c.json({ data: { id: contactId, deleted: true } });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error deleting contact:", { error });
        throw error;
      }
    }
  );

  // ============================================================================
  // PIPELINES
  // ============================================================================

  /**
   * GET /api/crm/pipelines
   * List all pipelines
   */
  crmRoutes.get(
    "/pipelines",
    {
      id: "list-pipelines",
      summary: "List CRM pipelines",
      description:
        "Deal pipelines, default first then by name (up to 500), without stages (see `get-pipeline`). Filter: `organizationId`. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { query: OrganizationQuery },
      output: { schema: RowsResponse },
    },
    async (c, input) => {
      try {
        const orgId = c.req.query("organizationId");

        const pipelines = await dbDe(c)
          .select()
          .from(crmPipelines)
          .where(orgId ? eq(crmPipelines.organizationId, orgId) : undefined)
          .orderBy(desc(crmPipelines.isDefault), asc(crmPipelines.name))
          .limit(500);

        return c.json({ data: pipelines });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error fetching pipelines:", { error });
        throw error;
      }
    }
  );

  /**
   * POST /api/crm/pipelines
   * Create a new pipeline with optional default stages
   */
  crmRoutes.post(
    "/pipelines",
    {
      id: "create-pipeline",
      summary: "Create a CRM pipeline",
      description:
        "Creates a pipeline (`name` required, currency defaults to USD). Unless `createDefaultStages` is false it also creates six stages: Lead, Qualified, Proposal, Negotiation, Closed Won, Closed Lost. Returns the pipeline. Admin only.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      input: { body: CreatePipeline },
      output: { schema: RowResponse, status: 201 },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const body = input.body as z.infer<typeof CreatePipeline>;

        // Create pipeline
        const [pipeline] = await dbDe(c)
          .insert(crmPipelines)
          .values({
            name: body.name,
            description: body.description,
            currency: body.currency || "USD",
            isDefault: body.isDefault || false,
            metadata: body.metadata || {},
            createdBy: userOf(c)?.id,
            organizationId: body.organizationId,
          })
          .returning();

        // Create default stages if requested
        if (body.createDefaultStages !== false) {
          const defaultStages = [
            { name: "Lead", color: "#6b7280", order: 0, probability: 10 },
            { name: "Qualified", color: "#3b82f6", order: 1, probability: 25 },
            { name: "Proposal", color: "#f59e0b", order: 2, probability: 50 },
            { name: "Negotiation", color: "#f97316", order: 3, probability: 75 },
            { name: "Closed Won", color: "#10b981", order: 4, probability: 100 },
            { name: "Closed Lost", color: "#ef4444", order: 5, probability: 0 },
          ];

          await dbDe(c)
            .insert(crmPipelineStages)
            .values(
              defaultStages.map((stage) => ({
                ...stage,
                pipelineId: pipeline.id,
              }))
            );
        }

        logger.info("[CRM] Pipeline created", { pipelineId: pipeline.id });
        return c.json({ data: pipeline }, 201);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error creating pipeline:", { error });
        throw error;
      }
    }
  );

  /**
   * GET /api/crm/pipelines/:id
   * Get pipeline with all stages
   */
  crmRoutes.get(
    "/pipelines/:id",
    {
      id: "get-pipeline",
      summary: "Read a CRM pipeline",
      description:
        "One pipeline with its `stages` in board order. 404 if it does not exist. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { params: ParamId },
      output: { schema: RowResponse },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      try {
        const pipelineId = c.req.param("id");

        const [pipeline] = await dbDe(c)
          .select()
          .from(crmPipelines)
          .where(eq(crmPipelines.id, pipelineId));

        if (!pipeline) {
          throw AppError.notFound("Pipeline not found");
        }

        const stages = await dbDe(c)
          .select()
          .from(crmPipelineStages)
          .where(eq(crmPipelineStages.pipelineId, pipelineId))
          .orderBy(asc(crmPipelineStages.order));

        return c.json({
          data: { ...pipeline, stages },
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error fetching pipeline:", { error });
        throw error;
      }
    }
  );

  /**
   * PATCH /api/crm/pipelines/:id
   * Update pipeline
   */
  crmRoutes.patch(
    "/pipelines/:id",
    {
      id: "update-pipeline",
      summary: "Update a CRM pipeline",
      description:
        "Partial update of a pipeline (name, description, currency, isDefault, metadata). Returns the row; 404 if it does not exist. Admin only.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      input: { params: ParamId, body: EditPipeline },
      output: { schema: RowResponse },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const pipelineId = c.req.param("id");
        const body = input.body as z.infer<typeof EditPipeline>;

        const updateData: Record<string, unknown> = {
          updatedAt: new Date(),
        };

        if (body.name !== undefined) updateData.name = body.name;
        if (body.description !== undefined) updateData.description = body.description;
        if (body.currency !== undefined) updateData.currency = body.currency;
        if (body.isDefault !== undefined) updateData.isDefault = body.isDefault;
        if (body.metadata !== undefined) updateData.metadata = body.metadata;

        const [pipeline] = await dbDe(c)
          .update(crmPipelines)
          .set(updateData)
          .where(eq(crmPipelines.id, pipelineId))
          .returning();

        if (!pipeline) {
          throw AppError.notFound("Pipeline not found");
        }

        return c.json({ data: pipeline });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error updating pipeline:", { error });
        throw error;
      }
    }
  );

  /**
   * DELETE /api/crm/pipelines/:id
   * Delete pipeline and all its stages/deals
   */
  crmRoutes.delete(
    "/pipelines/:id",
    {
      id: "delete-pipeline",
      summary: "Delete a CRM pipeline",
      description:
        "Deletes a pipeline with ALL its stages and deals (cascade). 409 if a stage is still referenced by a stage transition or a document requirement. Answers `{ data: { id, deleted: true } }` even if the id did not exist. Admin only.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      input: { params: ParamId },
      output: { schema: DeletedResponse },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const pipelineId = c.req.param("id");

        await dbDe(c).delete(crmPipelines).where(eq(crmPipelines.id, pipelineId));

        logger.info("[CRM] Pipeline deleted", { pipelineId });
        return c.json({ data: { id: pipelineId, deleted: true } });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error deleting pipeline:", { error });
        throw error;
      }
    }
  );

  // ============================================================================
  // PIPELINE STAGES
  // ============================================================================

  /**
   * POST /api/crm/pipelines/:id/stages
   * Add stage to pipeline
   */
  crmRoutes.post(
    "/pipelines/:id/stages",
    {
      id: "create-stage",
      summary: "Add a stage to a CRM pipeline",
      description:
        "Adds a stage to the pipeline `id` (`name` required; by default it goes last, with color #3b82f6 and probability 0). 409 if the pipeline does not exist. Admin only.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      input: { params: ParamId, body: CreateStage },
      output: { schema: RowResponse, status: 201 },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const pipelineId = c.req.param("id");
        const body = input.body as z.infer<typeof CreateStage>;

        // Get max order
        const [maxOrder] = await dbDe(c)
          .select({ maxOrder: sql<number>`coalesce(max(${crmPipelineStages.order}), -1)` })
          .from(crmPipelineStages)
          .where(eq(crmPipelineStages.pipelineId, pipelineId));

        const [stage] = await dbDe(c)
          .insert(crmPipelineStages)
          .values({
            pipelineId,
            name: body.name,
            color: body.color || "#3b82f6",
            order: body.order ?? maxOrder.maxOrder + 1,
            probability: body.probability ?? 0,
            wipLimit: body.wipLimit,
            metadata: body.metadata || {},
          })
          .returning();

        logger.info("[CRM] Stage created", { stageId: stage.id, pipelineId });
        return c.json({ data: stage }, 201);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error creating stage:", { error });
        throw error;
      }
    }
  );

  /**
   * PATCH /api/crm/stages/:id
   * Update stage
   */
  crmRoutes.patch(
    "/stages/:id",
    {
      id: "update-stage",
      summary: "Update a CRM pipeline stage",
      description:
        "Partial update of a stage (name, color, order, probability, wipLimit, metadata). Returns the row; 404 if it does not exist. Entry requirements and actions are `configure-stage`. Admin only.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      input: { params: ParamId, body: EditStage },
      output: { schema: RowResponse },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      try {
        const stageId = c.req.param("id");
        const body = input.body as z.infer<typeof EditStage>;

        const updateData: Record<string, unknown> = {
          updatedAt: new Date(),
        };

        if (body.name !== undefined) updateData.name = body.name;
        if (body.color !== undefined) updateData.color = body.color;
        if (body.order !== undefined) updateData.order = body.order;
        if (body.probability !== undefined) updateData.probability = body.probability;
        if (body.wipLimit !== undefined) updateData.wipLimit = body.wipLimit;
        if (body.metadata !== undefined) updateData.metadata = body.metadata;

        const [stage] = await dbDe(c)
          .update(crmPipelineStages)
          .set(updateData)
          .where(eq(crmPipelineStages.id, stageId))
          .returning();

        if (!stage) {
          throw AppError.notFound("Stage not found");
        }

        return c.json({ data: stage });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error updating stage:", { error });
        throw error;
      }
    }
  );

  /**
   * DELETE /api/crm/stages/:id
   * Delete stage (deals must be moved first)
   */
  crmRoutes.delete(
    "/stages/:id",
    {
      id: "delete-stage",
      summary: "Delete a CRM pipeline stage",
      description:
        "Deletes a stage. 400 with `error.details.dealsCount` if it still has deals (move them first with `move-deal`); 409 if a stage transition or document still references it. Admin only.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      input: { params: ParamId },
      output: { schema: DeletedResponse },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const stageId = c.req.param("id");

        // Check if stage has deals
        const [dealsCount] = await dbDe(c)
          .select({ count: sql<number>`count(*)` })
          .from(crmDeals)
          .where(eq(crmDeals.stageId, stageId));

        if (dealsCount.count > 0) {
          throw AppError.badRequest("Cannot delete stage with deals. Move deals first.", {
            dealsCount: dealsCount.count,
          });
        }

        await dbDe(c).delete(crmPipelineStages).where(eq(crmPipelineStages.id, stageId));

        logger.info("[CRM] Stage deleted", { stageId });
        return c.json({ data: { id: stageId, deleted: true } });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error deleting stage:", { error });
        throw error;
      }
    }
  );

  // ============================================================================
  // DEALS
  // ============================================================================

  /**
   * GET /api/crm/deals
   * List deals with pagination and filters
   */
  crmRoutes.get(
    "/deals",
    {
      id: "list-deals",
      summary: "List CRM deals",
      description:
        "Deals newest-updated first, paginated. Filters: `organizationId`, `pipelineId`, `stageId`, `status`, `contactId`, `companyId`, `assignedTo`, `search` (title, contact name or company name) and `cf.<key>=value` for custom fields (422 for an unknown field, 403 for one you cannot read). `count-deals` gives the totals per group. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { query: DealsQuery },
      output: { schema: ListResponse },
    },
    async (c, input) => {
      try {
        const { limit, offset } = pagination(c);
        const conditions = await dealConditions(c);
        const filter = conditions.length > 0 ? and(...conditions) : undefined;

        // In series: one connection per request, one query at a time.
        const deals = await dbDe(c)
          .select()
          .from(crmDeals)
          .where(filter)
          .orderBy(desc(crmDeals.updatedAt))
          .limit(limit)
          .offset(offset);
        const countResult = await dbDe(c)
          .select({ count: sql<number>`count(*)` })
          .from(crmDeals)
          .where(filter);

        return c.json({
          data: deals,
          pagination: {
            total: countResult[0]?.count ?? 0,
            limit,
            offset,
          },
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error fetching deals:", { error });
        throw error;
      }
    }
  );

  crmRoutes.get(
    "/deal-counts",
    {
      id: "count-deals",
      summary: "Count CRM deals per group",
      description:
        "How many deals there are per `groupBy`: `stageId`, `status`, `assignedTo`, `contactId`, `companyId`, `pipelineId` or `cf.<key>` (a custom field you can read), with every `list-deals` filter. Returns `data: [{ key, count }]`, largest first, and `total`. Deals without a value are counted under `key: null`. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { query: DealsQuery.extend({ groupBy: z.string().describe("What to count by") }) },
      output: { schema: z.object({}).passthrough() },
    },
    async (c, input) => {
      const db = dbDe(c);
      const groupBy = input.query.groupBy;
      const columns = {
        stageId: crmDeals.stageId,
        status: crmDeals.status,
        assignedTo: crmDeals.assignedTo,
        contactId: crmDeals.contactId,
        companyId: crmDeals.companyId,
        pipelineId: crmDeals.pipelineId,
      } as const;
      let key: SQL;
      if (groupBy.startsWith("cf.")) {
        // Grouping by a field reads it, so it goes through the same check as a filter on it.
        await readableFields(db, [groupBy.slice(3)]);
        key = sql`${crmDeals.customFields} ->> ${groupBy.slice(3)}`;
      } else if (Object.prototype.hasOwnProperty.call(columns, groupBy)) {
        key = sql`${columns[groupBy as keyof typeof columns]}::text`;
      } else {
        throw AppError.validation(`groupBy must be one of ${Object.keys(columns).join(", ")} or cf.<field>`);
      }
      const conditions = await dealConditions(c);
      const rows = await db
        .select({ key: sql<string | null>`${key}`, count: sql<number>`count(*)::int` })
        .from(crmDeals)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        // By position: the key as a parameter would be a different expression in GROUP BY than in SELECT.
        .groupBy(sql`1`)
        .orderBy(sql`count(*) DESC`)
        .limit(500);
      return c.json({ data: rows, total: rows.reduce((sum, r) => sum + Number(r.count), 0) });
    }
  );

  /**
   * POST /api/crm/deals
   * Create a new deal
   */
  crmRoutes.post(
    "/deals",
    {
      id: "create-deal",
      summary: "Create a CRM deal",
      description:
        "Creates a deal in `pipelineId`/`stageId` (`title` required). The stage must belong to that pipeline (422 otherwise); probability defaults to the stage's. The pipeline's entity validates `customFields` and, if it numbers deals, fills the number field with the next one. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { body: CreateDeal },
      output: { schema: RowResponse, status: 201 },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const body = input.body as z.infer<typeof CreateDeal>;

        const [stage] = await dbDe(c)
          .select({
            probability: crmPipelineStages.probability,
            pipelineId: crmPipelineStages.pipelineId,
          })
          .from(crmPipelineStages)
          .where(eq(crmPipelineStages.id, body.stageId));
        if (!stage || stage.pipelineId !== body.pipelineId) {
          throw AppError.validation("Stage not found in this pipeline");
        }
        const probability = body.probability ?? stage.probability ?? 0;
        // The entity of this pipeline gives the deal its fields and, when it numbers them, its number.
        const entity = await entityOfDeal(dbDe(c), { pipelineId: body.pipelineId });
        const customFields = { ...((body.customFields as Record<string, unknown> | undefined) ?? {}) };
        const numbering = numberingOf(entity);
        if (entity && numbering && (customFields[numbering.field] === undefined || customFields[numbering.field] === "")) {
          customFields[numbering.field] = formatNumber(numbering, await nextNumber(dbDe(c), `${entity.entityName}:${numbering.field}`));
        }

        const [deal] = await dbDe(c)
          .insert(crmDeals)
          .values({
            title: body.title,
            description: body.description,
            value: body.value || 0,
            currency: body.currency || "USD",
            status: body.status || "open",
            pipelineId: body.pipelineId,
            stageId: body.stageId,
            probability,
            contactId: body.contactId,
            companyId: body.companyId,
            assignedTo: body.assignedTo,
            expectedCloseDate: body.expectedCloseDate ? new Date(body.expectedCloseDate) : null,
            source: body.source,
            campaign: body.campaign,
            tags: body.tags || [],
            customFields,
            portalVisible: body.portalVisible ?? false,
            entityConfigId: entity?.id ?? null,
            metadata: body.metadata || {},
            createdBy: userOf(c)?.id,
            organizationId: body.organizationId,
          })
          .returning();

        emitCrm("deal:created", { dealId: deal.id, pipelineId: deal.pipelineId, stageId: deal.stageId });
        logger.info("[CRM] Deal created", { dealId: deal.id });
        return c.json({ data: deal }, 201);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error creating deal:", { error });
        throw error;
      }
    }
  );

  /**
   * GET /api/crm/deals/:id
   * Get deal with relations
   */
  crmRoutes.get(
    "/deals/:id",
    {
      id: "get-deal",
      summary: "Read a CRM deal",
      description:
        "One deal with its `contact`, `company`, `stage` and `pipeline` (each null if missing). 404 if it does not exist. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { params: ParamId },
      output: { schema: RowResponse },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      try {
        const dealId = c.req.param("id");

        const [deal] = await dbDe(c).select().from(crmDeals).where(eq(crmDeals.id, dealId));

        if (!deal) {
          throw AppError.notFound("Deal not found");
        }

        // Get related data (in series: one connection per request)
        const contact = deal.contactId
          ? ((
              await dbDe(c).select().from(crmContacts).where(eq(crmContacts.id, deal.contactId))
            )[0] ?? null)
          : null;
        const company = deal.companyId
          ? ((
              await dbDe(c).select().from(crmCompanies).where(eq(crmCompanies.id, deal.companyId))
            )[0] ?? null)
          : null;
        const stage = deal.stageId
          ? ((
              await dbDe(c)
                .select()
                .from(crmPipelineStages)
                .where(eq(crmPipelineStages.id, deal.stageId))
            )[0] ?? null)
          : null;
        const pipeline = deal.pipelineId
          ? ((
              await dbDe(c).select().from(crmPipelines).where(eq(crmPipelines.id, deal.pipelineId))
            )[0] ?? null)
          : null;

        return c.json({
          data: { ...deal, contact, company, stage, pipeline },
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error fetching deal:", { error });
        throw error;
      }
    }
  );

  /**
   * PATCH /api/crm/deals/:id
   * Update deal
   */
  crmRoutes.patch(
    "/deals/:id",
    {
      id: "update-deal",
      summary: "Update a CRM deal",
      description:
        "Partial update of a deal. It does NOT change pipeline or stage: use `move-deal`, which checks the stage requirements (a `stageId` here is a 422). Returns the row; 404 if it does not exist. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { params: ParamId, body: EditDeal },
      output: { schema: RowResponse },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const dealId = c.req.param("id");
        const body = input.body as z.infer<typeof EditDeal>;

        const updateData: Record<string, unknown> = {
          updatedAt: new Date(),
        };

        const fields = [
          "title",
          "description",
          "value",
          "currency",
          "status",
          "pipelineId",
          "stageId",
          "probability",
          "contactId",
          "companyId",
          "assignedTo",
          "expectedCloseDate",
          "actualCloseDate",
          "source",
          "campaign",
          "tags",
          "customFields",
          "portalVisible",
          "metadata",
        ];

        for (const field of fields) {
          if ((body as Record<string, unknown>)[field] !== undefined) {
            if (field === "expectedCloseDate" || field === "actualCloseDate") {
              updateData[field] = (body as Record<string, unknown>)[field]
                ? new Date((body as Record<string, unknown>)[field] as string)
                : null;
            } else {
              updateData[field] = (body as Record<string, unknown>)[field];
            }
          }
        }

        const [deal] = await dbDe(c)
          .update(crmDeals)
          .set(updateData)
          .where(eq(crmDeals.id, dealId))
          .returning();

        if (!deal) {
          throw AppError.notFound("Deal not found");
        }
        if (body.status !== undefined) emitCrm("deal:status-changed", { dealId: deal.id, status: deal.status });

        return c.json({ data: deal });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error updating deal:", { error });
        throw error;
      }
    }
  );

  /**
   * DELETE /api/crm/deals/:id
   * Delete deal
   */
  crmRoutes.delete(
    "/deals/:id",
    {
      id: "delete-deal",
      summary: "Delete a CRM deal",
      description:
        "Deletes a deal with its activities, documents and stage history. Answers `{ data: { id, deleted: true } }` even if the id did not exist. Admin only.",
      access: "session",
      permission: DELETE,
      before: [requiresEdit],
      input: { params: ParamId },
      output: { schema: DeletedResponse },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const dealId = c.req.param("id");

        await dbDe(c).delete(crmDeals).where(eq(crmDeals.id, dealId));

        logger.info("[CRM] Deal deleted", { dealId });
        return c.json({ data: { id: dealId, deleted: true } });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error deleting deal:", { error });
        throw error;
      }
    }
  );

  // ============================================================================
  // KANBAN OPERATIONS
  // ============================================================================

  /**
   * GET /api/crm/pipelines/:id/kanban
   * Get full kanban board data (pipeline + stages + deals)
   */
  crmRoutes.get(
    "/pipelines/:id/kanban",
    {
      id: "get-board",
      summary: "Read a CRM pipeline as a kanban board",
      description:
        "The pipeline and its stages in order, each with its OPEN deals; `assignedTo` and `cf.<key>=value` narrow the deals. 404 if the pipeline does not exist. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { params: ParamId, query: z.object({ assignedTo: z.string().optional() }).passthrough() },
      output: { schema: BoardResponse },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      try {
        const pipelineId = c.req.param("id");

        const [pipeline] = await dbDe(c)
          .select()
          .from(crmPipelines)
          .where(eq(crmPipelines.id, pipelineId));

        if (!pipeline) {
          throw AppError.notFound("Pipeline not found");
        }

        const stages = await dbDe(c)
          .select()
          .from(crmPipelineStages)
          .where(eq(crmPipelineStages.pipelineId, pipelineId))
          .orderBy(asc(crmPipelineStages.order));

        const assignedTo = c.req.query("assignedTo");
        const deals = await dbDe(c)
          .select()
          .from(crmDeals)
          .where(
            and(
              eq(crmDeals.pipelineId, pipelineId),
              eq(crmDeals.status, "open"),
              assignedTo ? eq(crmDeals.assignedTo, assignedTo) : undefined,
              ...(await customFieldFilters(c, dbDe(c), crmDeals.customFields))
            )
          )
          .orderBy(asc(crmDeals.createdAt));

        // Group deals by stage
        const stagesWithDeals = stages.map((stage: typeof crmPipelineStages.$inferSelect) => ({
          ...stage,
          deals: deals.filter((d: typeof crmDeals.$inferSelect) => d.stageId === stage.id),
        }));

        return c.json({
          data: {
            pipeline,
            stages: stagesWithDeals,
          },
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error fetching kanban:", { error });
        throw error;
      }
    }
  );

  // `POST /deals/:id/move` was registered TWICE. The first wins, so
  // the "improved" version further down — the one that validates the
  // stage requirements and records time — never ran: anyone on the team
  // moved a deal to "Won" without meeting anything. Only the good one remains.

  /**
   * POST /api/crm/deals/reorder
   * Batch reorder deals
   */
  crmRoutes.post(
    "/deals/reorder",
    {
      id: "reorder-deals",
      summary: "Reorder CRM deals within their stages",
      description:
        "Accepts up to 500 `{ id, stageId, order }` and answers how many. It never changes a deal's stage (422 listing the ids that would: use `move-deal`); deals have no stored order, so nothing is written. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { body: Reorder },
      output: { schema: ReorderResponse },
      idempotent: true,
    },
    async (c, input) => {
      try {
        const body = input.body as z.infer<typeof Reorder>;
        const { deals } = body;

        // Changing stage here skipped the target stage's requirements and
        // left no trace: that is what `/deals/:id/move` is for. And `crm_deals` has no
        // order column, so the `order` that was written was silently thrown away
        // by Drizzle. Here only the stage it is already in is accepted.
        const current = await dbDe(c)
          .select({ id: crmDeals.id, stageId: crmDeals.stageId })
          .from(crmDeals)
          .where(
            inArray(
              crmDeals.id,
              deals.map((d) => d.id)
            )
          );
        const stageOf = new Map(current.map((d) => [d.id, d.stageId]));
        const change = deals.filter((d) => stageOf.get(d.id) !== d.stageId);
        if (change.length > 0) {
          throw AppError.validation("To change stage use POST /deals/:id/move", {
            deals: change.map((d) => d.id),
          });
        }

        return c.json({ updated: deals.length });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error reordering deals:", { error });
        throw error;
      }
    }
  );

  // ============================================================================
  // ACTIVITIES
  // ============================================================================

  /**
   * GET /api/crm/activities
   * List activities with filters
   */
  crmRoutes.get(
    "/activities",
    {
      id: "list-activities",
      summary: "List CRM activities",
      description:
        "Calls, emails, meetings, tasks and notes, newest first, paginated. Filters: `organizationId`, `contactId`, `companyId`, `dealId`, `type`, `assignedTo`, `completed` (`true`/`false`). CRM team only.",
      access: "session",
      permission: VIEW,
      input: { query: ActivitiesQuery },
      output: { schema: ListResponse },
    },
    async (c, input) => {
      try {
        const orgId = c.req.query("organizationId");
        const contactId = c.req.query("contactId");
        const companyId = c.req.query("companyId");
        const dealId = c.req.query("dealId");
        const type = c.req.query("type");
        const assignedTo = c.req.query("assignedTo");
        const completed = c.req.query("completed");
        const { limit, offset } = pagination(c);

        const conditions: SQL[] = [];
        if (orgId) conditions.push(eq(crmActivities.organizationId, orgId));
        if (contactId) conditions.push(eq(crmActivities.contactId, contactId));
        if (companyId) conditions.push(eq(crmActivities.companyId, companyId));
        if (dealId) conditions.push(eq(crmActivities.dealId, dealId));
        // `eqEnum` returns undefined if the value does not belong to the enum.
        const filter1232 = eqEnum(crmActivities.type, type);
        if (filter1232) conditions.push(filter1232);
        if (assignedTo) conditions.push(eq(crmActivities.assignedTo, assignedTo));
        if (completed === "true") conditions.push(sql`${crmActivities.completedAt} IS NOT NULL`);
        if (completed === "false") conditions.push(sql`${crmActivities.completedAt} IS NULL`);
        const kind = c.req.query("kind");
        if (kind) conditions.push(eq(crmActivities.kind, kind));

        // In series: one connection per request, one query at a time.
        const activities = await dbDe(c)
          .select()
          .from(crmActivities)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(crmActivities.createdAt))
          .limit(limit)
          .offset(offset);
        const countResult = await dbDe(c)
          .select({ count: sql<number>`count(*)` })
          .from(crmActivities)
          .where(conditions.length > 0 ? and(...conditions) : undefined);

        return c.json({
          data: activities,
          pagination: {
            total: countResult[0]?.count ?? 0,
            limit,
            offset,
          },
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error fetching activities:", { error });
        throw error;
      }
    }
  );

  /**
   * POST /api/crm/activities
   * Create a new activity
   */
  crmRoutes.post(
    "/activities",
    {
      id: "create-activity",
      summary: "Log a CRM activity",
      description:
        "Creates an activity (`type` and `subject` required), authored by the caller; with `dealId` it also bumps the deal's `lastActivityAt`. 409 if a referenced contact, company or deal does not exist. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { body: CreateActivity },
      output: { schema: RowResponse, status: 201 },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const body = input.body as z.infer<typeof CreateActivity>;

        const [activity] = await dbDe(c)
          .insert(crmActivities)
          .values({
            type: body.type,
            subject: body.subject,
            description: body.description,
            contactId: body.contactId,
            companyId: body.companyId,
            dealId: body.dealId,
            assignedTo: body.assignedTo,
            createdBy: userOf(c)?.id,
            priority: body.priority,
            sharedWithClient: body.sharedWithClient,
            dueDate: body.dueDate ? new Date(body.dueDate) : null,
            durationMinutes: body.durationMinutes,
            kind: body.kind,
            location: body.location,
            outcome: body.outcome,
            notes: body.notes,
            metadata: body.metadata || {},
            organizationId: body.organizationId,
          })
          .returning();

        // Update lastActivityAt on related deal if exists
        if (body.dealId) {
          await dbDe(c)
            .update(crmDeals)
            .set({ lastActivityAt: new Date() })
            .where(eq(crmDeals.id, body.dealId));
        }

        logger.info("[CRM] Activity created", { activityId: activity.id });
        return c.json({ data: activity }, 201);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error creating activity:", { error });
        throw error;
      }
    }
  );

  /**
   * GET /api/crm/activities/:id
   * Get activity
   */
  crmRoutes.get(
    "/activities/:id",
    {
      id: "get-activity",
      summary: "Read a CRM activity",
      description: "One activity. 404 if it does not exist. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { params: ParamId },
      output: { schema: RowResponse },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      try {
        const activityId = c.req.param("id");

        const [activity] = await dbDe(c)
          .select()
          .from(crmActivities)
          .where(eq(crmActivities.id, activityId));

        if (!activity) {
          throw AppError.notFound("Activity not found");
        }

        return c.json({ data: activity });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error fetching activity:", { error });
        throw error;
      }
    }
  );

  /**
   * PATCH /api/crm/activities/:id
   * Update activity
   */
  crmRoutes.patch(
    "/activities/:id",
    {
      id: "update-activity",
      summary: "Update a CRM activity",
      description:
        "Partial update of an activity. Returns the row; 404 if it does not exist. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { params: ParamId, body: EditActivity },
      output: { schema: RowResponse },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const activityId = c.req.param("id");
        const body = input.body as z.infer<typeof EditActivity>;

        const updateData: Record<string, unknown> = {
          updatedAt: new Date(),
        };

        const fields = [
          "type",
          "subject",
          "description",
          "contactId",
          "companyId",
          "dealId",
          "assignedTo",
          "dueDate",
          "durationMinutes",
          "kind",
          "location",
          "priority",
          "sharedWithClient",
          "outcome",
          "notes",
          "metadata",
        ];

        for (const field of fields) {
          if ((body as Record<string, unknown>)[field] !== undefined) {
            if (field === "dueDate") {
              updateData[field] = (body as Record<string, unknown>)[field]
                ? new Date((body as Record<string, unknown>)[field] as string)
                : null;
            } else {
              updateData[field] = (body as Record<string, unknown>)[field];
            }
          }
        }

        const [activity] = await dbDe(c)
          .update(crmActivities)
          .set(updateData)
          .where(eq(crmActivities.id, activityId))
          .returning();

        if (!activity) {
          throw AppError.notFound("Activity not found");
        }

        return c.json({ data: activity });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error updating activity:", { error });
        throw error;
      }
    }
  );

  /**
   * POST /api/crm/activities/:id/complete
   * Mark activity as completed
   */
  crmRoutes.post(
    "/activities/:id/complete",
    {
      id: "complete-activity",
      summary: "Mark a CRM activity as done",
      description:
        "Sets `completedAt` to now and `completedBy` to you, and stores the optional `outcome` and `notes`. `reopen-activity` undoes it. Returns the row; 404 if it does not exist. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { params: ParamId, body: CompleteActivity },
      output: { schema: RowResponse },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      try {
        const activityId = c.req.param("id");
        const body = input.body as z.infer<typeof CompleteActivity>;

        const [activity] = await dbDe(c)
          .update(crmActivities)
          .set({
            completedAt: new Date(),
            completedBy: userOf(c)?.id ?? null,
            outcome: body.outcome,
            notes: body.notes,
            updatedAt: new Date(),
          })
          .where(eq(crmActivities.id, activityId))
          .returning();

        if (!activity) {
          throw AppError.notFound("Activity not found");
        }

        return c.json({ data: activity });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error completing activity:", { error });
        throw error;
      }
    }
  );

  /**
   * DELETE /api/crm/activities/:id
   * Delete activity
   */
  crmRoutes.delete(
    "/activities/:id",
    {
      id: "delete-activity",
      summary: "Delete a CRM activity",
      description:
        "Deletes an activity. Only its author or an admin (403 otherwise); 404 if it does not exist. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { params: ParamId },
      output: { schema: DeletedResponse },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      try {
        const activityId = c.req.param("id")!;

        const [activityValue] = await dbDe(c)
          .select({ createdBy: crmActivities.createdBy })
          .from(crmActivities)
          .where(eq(crmActivities.id, activityId));
        if (!activityValue) throw AppError.notFound("Activity not found");
        await requireAuthorship(c, activityValue.createdBy);

        await dbDe(c).delete(crmActivities).where(eq(crmActivities.id, activityId));

        logger.info("[CRM] Activity deleted", { activityId });
        return c.json({ data: { id: activityId, deleted: true } });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error deleting activity:", { error });
        throw error;
      }
    }
  );

  // ============================================================================
  // DASHBOARD STATS
  // ============================================================================

  /**
   * GET /api/crm/stats
   * Get CRM dashboard stats
   */
  crmRoutes.get(
    "/stats",
    {
      id: "get-stats",
      summary: "Read CRM dashboard stats",
      description:
        "Counts of contacts, companies and activities (and overdue open ones), and deals by status with total/open/won values. Filter: `organizationId`. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { query: OrganizationQuery },
      output: { schema: DataResponse },
    },
    async (c, input) => {
      try {
        const orgId = c.req.query("organizationId");

        const buildOrgWhere = (table: any) => {
          const conditions: any[] = [];
          if (orgId) conditions.push(eq(table.organizationId, orgId));
          return conditions.length > 0 ? and(...conditions) : undefined;
        };

        const overdueConditions = [
          sql`${crmActivities.completedAt} IS NULL`,
          sql`${crmActivities.dueDate} <= NOW()`,
        ];
        if (orgId) overdueConditions.push(eq(crmActivities.organizationId, orgId));

        // In series, not with `Promise.all`: one connection per request.
        const contactsCount = await dbDe(c)
          .select({ count: sql<number>`count(*)` })
          .from(crmContacts)
          .where(buildOrgWhere(crmContacts))
          .then((r: { count: number }[]) => r[0]?.count ?? 0);
        const companiesCount = await dbDe(c)
          .select({ count: sql<number>`count(*)` })
          .from(crmCompanies)
          .where(buildOrgWhere(crmCompanies))
          .then((r: { count: number }[]) => r[0]?.count ?? 0);
        const dealsStats = await dbDe(c)
          .select({
            total: sql<number>`count(*)`,
            open: sql<number>`count(*) FILTER (WHERE ${crmDeals.status} = 'open')`,
            won: sql<number>`count(*) FILTER (WHERE ${crmDeals.status} = 'won')`,
            lost: sql<number>`count(*) FILTER (WHERE ${crmDeals.status} = 'lost')`,
            totalValue: sql<number>`coalesce(sum(${crmDeals.value}), 0)`,
            openValue: sql<number>`coalesce(sum(${crmDeals.value}) FILTER (WHERE ${crmDeals.status} = 'open'), 0)`,
            wonValue: sql<number>`coalesce(sum(${crmDeals.value}) FILTER (WHERE ${crmDeals.status} = 'won'), 0)`,
          })
          .from(crmDeals)
          .where(buildOrgWhere(crmDeals))
          .then(
            (
              r: {
                total: number;
                open: number;
                won: number;
                lost: number;
                totalValue: number;
                openValue: number;
                wonValue: number;
              }[]
            ) => r[0]
          );
        const activitiesCount = await dbDe(c)
          .select({ count: sql<number>`count(*)` })
          .from(crmActivities)
          .where(buildOrgWhere(crmActivities))
          .then((r: { count: number }[]) => r[0]?.count ?? 0);
        const openActivitiesCount = await dbDe(c)
          .select({ count: sql<number>`count(*)` })
          .from(crmActivities)
          .where(overdueConditions.length > 1 ? and(...overdueConditions) : undefined)
          .then((r: { count: number }[]) => r[0]?.count ?? 0);

        return c.json({
          data: {
            contacts: contactsCount,
            companies: companiesCount,
            deals: {
              total: dealsStats?.total ?? 0,
              open: dealsStats?.open ?? 0,
              won: dealsStats?.won ?? 0,
              lost: dealsStats?.lost ?? 0,
              values: {
                total: dealsStats?.totalValue ?? 0,
                open: dealsStats?.openValue ?? 0,
                won: dealsStats?.wonValue ?? 0,
              },
            },
            activities: {
              total: activitiesCount,
              overdue: openActivitiesCount,
            },
          },
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error fetching stats:", { error });
        throw error;
      }
    }
  );

  // ============================================================================
  // PHASE 1: CRM BUILDER - ENTITY CONFIGS
  // ============================================================================

  /**
   * GET /api/crm/entity-configs
   * List entity configurations
   */
  crmRoutes.get(
    "/entity-configs",
    {
      id: "list-entities",
      summary: "List CRM entity configurations",
      description:
        "Entity configurations of the CRM builder (labels, field schema, default pipeline), newest-updated first. Filter: `konId`. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { query: EntitiesQuery },
      output: { schema: RowsResponse },
    },
    async (c, input) => {
      try {
        const konId = c.req.query("konId");
        const configs = await dbDe(c)
          .select()
          .from(crmEntityConfigs)
          .where(konId ? eq(crmEntityConfigs.konId, konId) : undefined)
          .orderBy(desc(crmEntityConfigs.updatedAt));

        return c.json({ data: configs });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error fetching entity configs:", { error });
        throw error;
      }
    }
  );

  /**
   * POST /api/crm/entity-configs
   * Create entity configuration
   */
  crmRoutes.post(
    "/entity-configs",
    {
      id: "create-entity",
      summary: "Create a CRM entity configuration",
      description:
        "Creates an entity configuration for a kon (`konId`, `entityName`, `singularLabel`, `pluralLabel` required). Admin only.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      input: { body: CreateEntity },
      output: { schema: RowResponse, status: 201 },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const body = input.body as z.infer<typeof CreateEntity>;
        const user = ctxGet<{ id?: string }>(c, "user");

        const [config] = await dbDe(c)
          .insert(crmEntityConfigs)
          .values({
            konId: body.konId,
            entityName: body.entityName,
            singularLabel: body.singularLabel,
            pluralLabel: body.pluralLabel,
            requiresContact: body.requiresContact ?? true,
            requiresCompany: body.requiresCompany ?? true,
            allowsValue: body.allowsValue ?? true,
            allowsTimeTracking: body.allowsTimeTracking ?? true,
            fieldSchema: body.fieldSchema ?? [],
            defaultPipelineId: body.defaultPipelineId,
            isActive: body.isActive ?? true,
            isDefault: body.isDefault ?? false,
            metadata: body.metadata ?? {},
            createdBy: user?.id,
          })
          .returning();

        logger.info("[CRM] Entity config created", { configId: config.id });
        return c.json({ data: config }, 201);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error creating entity config:", { error });
        throw error;
      }
    }
  );

  /**
   * PATCH /api/crm/entity-configs/:id
   * Update entity configuration
   */
  crmRoutes.patch(
    "/entity-configs/:id",
    {
      id: "update-entity",
      summary: "Update a CRM entity configuration",
      description:
        "Partial update of an entity configuration (not its `konId`). Returns the row; 404 if it does not exist. Admin only.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      input: { params: ParamId, body: EditEntity },
      output: { schema: RowResponse },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const id = c.req.param("id");
        const body = input.body as z.infer<typeof EditEntity>;

        const updateData: Record<string, unknown> = {
          updatedAt: new Date(),
        };

        if (body.entityName !== undefined) updateData.entityName = body.entityName;
        if (body.singularLabel !== undefined) updateData.singularLabel = body.singularLabel;
        if (body.pluralLabel !== undefined) updateData.pluralLabel = body.pluralLabel;
        if (body.requiresContact !== undefined) updateData.requiresContact = body.requiresContact;
        if (body.requiresCompany !== undefined) updateData.requiresCompany = body.requiresCompany;
        if (body.allowsValue !== undefined) updateData.allowsValue = body.allowsValue;
        if (body.allowsTimeTracking !== undefined)
          updateData.allowsTimeTracking = body.allowsTimeTracking;
        if (body.fieldSchema !== undefined) updateData.fieldSchema = body.fieldSchema;
        if (body.defaultPipelineId !== undefined)
          updateData.defaultPipelineId = body.defaultPipelineId;
        if (body.isActive !== undefined) updateData.isActive = body.isActive;
        if (body.isDefault !== undefined) updateData.isDefault = body.isDefault;
        if (body.metadata !== undefined) updateData.metadata = body.metadata;

        const [config] = await dbDe(c)
          .update(crmEntityConfigs)
          .set(updateData)
          .where(eq(crmEntityConfigs.id, id))
          .returning();

        if (!config) {
          throw AppError.notFound("Entity config not found");
        }

        logger.info("[CRM] Entity config updated", { configId: id });
        return c.json({ data: config });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error updating entity config:", { error });
        throw error;
      }
    }
  );

  // ============================================================================
  // PHASE 1: STAGE VALIDATIONS & TIME TRACKING
  // ============================================================================

  /**
   * Helper: Validate stage transition
   */
  async function validateStageTransition(
    dealId: string,
    targetStageId: string,
    tx: CrmDb
  ): Promise<ValidationResult> {
    const result: ValidationResult = {
      canMove: true,
      missingFields: [],
      missingDocuments: [],
      failedValidations: [],
      warnings: [],
    };

    // Get deal with custom fields
    const [deal] = await tx.select().from(crmDeals).where(eq(crmDeals.id, dealId));

    if (!deal) {
      result.canMove = false;
      result.warnings.push("Deal not found");
      return result;
    }

    // Get target stage with requirements
    const [stage] = await tx
      .select()
      .from(crmPipelineStages)
      .where(eq(crmPipelineStages.id, targetStageId));

    if (!stage) {
      result.canMove = false;
      result.warnings.push("Target stage not found");
      return result;
    }

    const requirements = (stage.entryRequirements || {}) as StageEntryRequirements;
    const customFields = (deal.customFields || {}) as Record<string, unknown>;

    // Validate required fields
    if (requirements.requiredFields?.length) {
      for (const fieldKey of requirements.requiredFields) {
        const value = customFields[fieldKey];
        if (value === undefined || value === null || value === "") {
          result.missingFields.push({
            key: fieldKey,
            label: fieldKey, // Could be enhanced to get from schema
            currentValue: value,
          });
          result.canMove = false;
        }
      }
    }

    // Validate custom validations
    if (requirements.customValidations?.length) {
      for (const validation of requirements.customValidations) {
        const value = customFields[validation.field];
        let passes = false;

        switch (validation.operator) {
          case "==":
            passes = value === validation.value;
            break;
          case "!=":
            passes = value !== validation.value;
            break;
          case ">":
            passes = Number(value) > Number(validation.value);
            break;
          case "<":
            passes = Number(value) < Number(validation.value);
            break;
          case ">=":
            passes = Number(value) >= Number(validation.value);
            break;
          case "<=":
            passes = Number(value) <= Number(validation.value);
            break;
          case "exists":
            passes = value !== undefined && value !== null && value !== "";
            break;
        }

        if (!passes) {
          result.failedValidations.push({
            field: validation.field,
            operator: validation.operator,
            expected: validation.value,
            actual: value,
            message: `Field ${validation.field} must be ${validation.operator} ${validation.value}`,
          });
          result.canMove = false;
        }
      }
    }

    // Validate required documents (basic check for Phase 1)
    if (requirements.requiredDocuments?.length) {
      const uploadedDocs = await tx
        .select({ type: crmDocuments.documentType })
        .from(crmDocuments)
        .where(eq(crmDocuments.dealId, dealId));

      const uploadedTypes = new Set(uploadedDocs.map((d: { type: string | null }) => d.type));

      for (const docType of requirements.requiredDocuments) {
        if (!uploadedTypes.has(docType)) {
          result.missingDocuments.push({
            type: docType,
            label: docType,
          });
          // Note: Not blocking move in Phase 1, just warning
          result.warnings.push(`Missing required document: ${docType}`);
        }
      }
    }

    return result;
  }

  /**
   * POST /api/crm/deals/:id/validate-move
   * Validate if deal can move to target stage
   */
  crmRoutes.post(
    "/deals/:id/validate-move",
    {
      id: "validate-move",
      summary: "Check whether a CRM deal can move to a stage",
      description:
        "Dry run of `move-deal`: checks the target stage's entry requirements (required custom fields, custom validations; missing documents only warn) and returns `{ canMove, missingFields, missingDocuments, failedValidations, warnings }`. Changes nothing. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { params: ParamId, body: ValidateMove },
      output: { schema: DataResponse },
      readOnly: true,
    },
    async (c, input) => {
      try {
        const dealId = c.req.param("id");
        const { targetStageId } = input.body as z.infer<typeof ValidateMove>;

        const validation = await validateStageTransition(dealId, targetStageId, dbDe(c));

        return c.json({ data: validation });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error validating move:", { error });
        throw error;
      }
    }
  );

  /**
   * GET /api/crm/deals/:id/timeline
   * Get deal timeline with stage transitions
   */
  crmRoutes.get(
    "/deals/:id/timeline",
    {
      id: "get-deal-history",
      summary: "Read a CRM deal's stage history",
      description:
        "The deal's stage transitions, newest first, with stage names, times in stage (`duration_text`) and SLA flags. An unknown deal gives an empty list. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { params: ParamId },
      output: { schema: RecordsResponse },
    },
    async (c, input) => {
      try {
        const dealId = c.req.param("id");

        const timeline = await dbDe(c).execute(sql`
        SELECT 
          st.id,
          st.from_stage_id,
          fs.name AS from_stage_name,
          st.to_stage_id,
          ts.name AS to_stage_name,
          st.entered_at,
          st.exited_at,
          st.duration_minutes,
          st.was_on_time,
          st.sla_breach,
          st.moved_by
        FROM crm_stage_transitions st
        LEFT JOIN crm_pipeline_stages fs ON st.from_stage_id = fs.id
        LEFT JOIN crm_pipeline_stages ts ON st.to_stage_id = ts.id
        WHERE st.deal_id = ${dealId}
        ORDER BY st.entered_at DESC
      `);

        // Format duration for human readability
        const formattedTimeline = (timeline.rows || []).map((row: Record<string, unknown>) => {
          const duration = row.duration_minutes as number;
          let durationText = "In progress";

          if (duration !== null && duration !== undefined) {
            const days = Math.floor(duration / (24 * 60));
            const hours = Math.floor((duration % (24 * 60)) / 60);
            const mins = duration % 60;

            const parts = [];
            if (days > 0) parts.push(`${days}d`);
            if (hours > 0) parts.push(`${hours}h`);
            if (mins > 0) parts.push(`${mins}m`);

            durationText = parts.join(" ") || "< 1m";
          }

          return {
            ...row,
            duration_text: durationText,
          };
        });

        return c.json({ data: formattedTimeline });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error fetching timeline:", { error });
        throw error;
      }
    }
  );

  /**
   * GET /api/crm/analytics/cycle-time
   * Get cycle time analytics for a pipeline
   */
  crmRoutes.get(
    "/analytics/cycle-time",
    {
      id: "get-cycle-times",
      summary: "Read cycle-time analytics of a CRM pipeline",
      description:
        "Per stage of `pipelineId` (required, 400 without it): average, median, min and max time in stage, deal count and SLA breach rate, over closed transitions, optionally between `startDate` and `endDate`. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { query: CycleQuery },
      output: { schema: RecordsResponse },
    },
    async (c, input) => {
      try {
        const pipelineId = c.req.query("pipelineId");
        const startDate = c.req.query("startDate");
        const endDate = c.req.query("endDate");

        if (!pipelineId) {
          throw AppError.badRequest("pipelineId is required");
        }
        // A date that is not understood reached the query as Invalid Date
        // (a 500); it now says which parameter it is, as with `pipelineId`.
        for (const [name, valueValue] of [
          ["startDate", startDate],
          ["endDate", endDate],
        ] as const) {
          if (valueValue && Number.isNaN(new Date(valueValue).getTime())) {
            throw AppError.badRequest(`${name} is not a valid date`);
          }
        }

        const result = await dbDe(c).execute(sql`
        SELECT 
          ps.id AS stage_id,
          ps.name AS stage_name,
          ROUND(AVG(st.duration_minutes), 2) AS avg_duration_minutes,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY st.duration_minutes) AS median_duration_minutes,
          MIN(st.duration_minutes) AS min_duration_minutes,
          MAX(st.duration_minutes) AS max_duration_minutes,
          COUNT(*) AS deal_count,
          COUNT(*) FILTER (WHERE st.sla_breach = TRUE) AS sla_breach_count,
          ROUND(
            COUNT(*) FILTER (WHERE st.sla_breach = TRUE) * 100.0 / NULLIF(COUNT(*), 0), 
            2
          ) AS sla_breach_rate
        FROM crm_stage_transitions st
        JOIN crm_pipeline_stages ps ON st.to_stage_id = ps.id
        WHERE ps.pipeline_id = ${pipelineId}
          AND st.exited_at IS NOT NULL
          ${startDate ? sql`AND st.entered_at >= ${new Date(startDate)}` : sql``}
          ${endDate ? sql`AND st.entered_at <= ${new Date(endDate)}` : sql``}
        GROUP BY ps.id, ps.name, ps.order
        ORDER BY ps.order
      `);

        // Format durations for readability
        const formattedData = (result.rows || []).map((row: Record<string, unknown>) => {
          const formatDuration = (mins: number) => {
            if (!mins) return "-";
            const days = Math.floor(mins / (24 * 60));
            if (days > 0) return `${days}d ${Math.floor((mins % (24 * 60)) / 60)}h`;
            const hours = Math.floor(mins / 60);
            if (hours > 0) return `${hours}h ${mins % 60}m`;
            return `${mins}m`;
          };

          return {
            ...row,
            avg_duration_text: formatDuration(row.avg_duration_minutes as number),
            median_duration_text: formatDuration(row.median_duration_minutes as number),
            min_duration_text: formatDuration(row.min_duration_minutes as number),
            max_duration_text: formatDuration(row.max_duration_minutes as number),
          };
        });

        return c.json({ data: formattedData });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error fetching cycle time:", { error });
        throw error;
      }
    }
  );

  /**
   * PATCH /api/crm/pipeline-stages/:id/config
   * Update stage configuration (builder features)
   */
  crmRoutes.patch(
    "/pipeline-stages/:id/config",
    {
      id: "configure-stage",
      summary: "Configure a CRM stage's rules",
      description:
        "Sets a stage's builder rules: `trackTimeInStage`, `estimatedDays`, `entryRequirements` (required fields, documents, custom validations checked by `move-deal`), `onEnterActions`, `onExitActions`. Returns the row; 404 if it does not exist. Admin only.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      input: { params: ParamId, body: StageConfig },
      output: { schema: RowResponse },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      try {
        const id = c.req.param("id");
        const body = input.body as z.infer<typeof StageConfig>;

        const updateData: Record<string, unknown> = {
          updatedAt: new Date(),
        };

        if (body.trackTimeInStage !== undefined)
          updateData.trackTimeInStage = body.trackTimeInStage;
        if (body.estimatedDays !== undefined) updateData.estimatedDays = body.estimatedDays;
        if (body.entryRequirements !== undefined)
          updateData.entryRequirements = body.entryRequirements;
        if (body.onEnterActions !== undefined) updateData.onEnterActions = body.onEnterActions;
        if (body.onExitActions !== undefined) updateData.onExitActions = body.onExitActions;

        const [stage] = await dbDe(c)
          .update(crmPipelineStages)
          .set(updateData)
          .where(eq(crmPipelineStages.id, id))
          .returning();

        if (!stage) {
          throw AppError.notFound("Stage not found");
        }

        logger.info("[CRM] Stage config updated", { stageId: id });
        return c.json({ data: stage });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error updating stage config:", { error });
        throw error;
      }
    }
  );

  // ============================================================================
  // PHASE 1: DOCUMENTS (Basic CRUD)
  // ============================================================================

  /**
   * GET /api/crm/deals/:id/documents
   * List documents for a deal
   */
  crmRoutes.get(
    "/deals/:id/documents",
    {
      id: "list-deal-documents",
      summary: "List a CRM deal's documents",
      description:
        "Document records of the deal, newest first. An unknown deal gives an empty list. CRM team only.",
      access: "session",
      permission: VIEW,
      input: { params: ParamId },
      output: { schema: RowsResponse },
    },
    async (c, input) => {
      try {
        const dealId = c.req.param("id");

        const documents = await dbDe(c)
          .select()
          .from(crmDocuments)
          .where(eq(crmDocuments.dealId, dealId))
          .orderBy(desc(crmDocuments.uploadedAt));

        return c.json({ data: documents });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error fetching documents:", { error });
        throw error;
      }
    }
  );

  /**
   * POST /api/crm/documents
   * Create document record
   */
  crmRoutes.post(
    "/documents",
    {
      id: "create-document",
      summary: "Attach a document record to a CRM deal",
      description:
        "Records a document of `dealId` (a `/...` path or an https link in `fileUrl`; never `javascript:`), uploaded by the caller. It stores the record only, not the file. 409 if the deal or stage does not exist. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { body: DocumentRecord },
      output: { schema: RowResponse, status: 201 },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      try {
        const body = input.body as z.infer<typeof DocumentRecord>;
        const user = ctxGet<{ id?: string }>(c, "user");

        const [doc] = await dbDe(c)
          .insert(crmDocuments)
          .values({
            dealId: body.dealId,
            name: body.name,
            fileUrl: body.fileUrl,
            fileType: body.fileType,
            fileSize: body.fileSize,
            documentType: body.documentType,
            category: body.category,
            requiredForStageId: body.requiredForStageId,
            isRequired: body.isRequired ?? false,
            sharedWithClient: body.sharedWithClient ?? false,
            isPrivileged: body.isPrivileged ?? false,
            confidential: body.confidential ?? false,
            uploadedBy: user?.id,
            metadata: body.metadata ?? {},
          })
          .returning();

        logger.info("[CRM] Document created", { docId: doc.id });
        return c.json({ data: doc }, 201);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error creating document:", { error });
        throw error;
      }
    }
  );

  /**
   * DELETE /api/crm/documents/:id
   * Delete document
   */
  crmRoutes.delete(
    "/documents/:id",
    {
      id: "delete-document",
      summary: "Delete a CRM document record",
      description:
        "Deletes a document record. Only whoever uploaded it or an admin (403 otherwise); 404 if it does not exist. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { params: ParamId },
      output: { schema: DeletedResponse },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      try {
        const id = c.req.param("id")!;

        const [prior] = await dbDe(c)
          .select({ uploadedBy: crmDocuments.uploadedBy })
          .from(crmDocuments)
          .where(eq(crmDocuments.id, id));
        if (!prior) throw AppError.notFound("Document not found");
        await requireAuthorship(c, prior.uploadedBy);

        const [doc] = await dbDe(c).delete(crmDocuments).where(eq(crmDocuments.id, id)).returning();

        if (!doc) {
          throw AppError.notFound("Document not found");
        }

        logger.info("[CRM] Document deleted", { docId: id });
        return c.json({ data: { id, deleted: true } });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error deleting document:", { error });
        throw error;
      }
    }
  );

  // ============================================================================
  // PHASE 1: ENHANCED DEAL MOVE (with validation & time tracking)
  // ============================================================================

  /**
   * POST /api/crm/deals/:id/move (ENHANCED)
   * Move deal to new stage with validation and time tracking
   */
  crmRoutes.post(
    "/deals/:id/move",
    {
      id: "move-deal",
      summary: "Move a CRM deal to another stage",
      description:
        "Moves the deal to `targetStageId` of the SAME pipeline (422 otherwise), after checking the stage's entry requirements (400 `Validation failed` with the check in `error.details` if they are not met). `skipValidation` is admin only (403). Records the stage transition and takes the stage's probability; a deal already there answers 200 with `message`. 404 if the deal does not exist. CRM team only.",
      access: "session",
      permission: EDIT,
      input: { params: ParamId, body: Move },
      output: { schema: RowResponse },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      idempotent: true,
    },
    async (c, input) => {
      try {
        const dealId = c.req.param("id");
        const { targetStageId, newOrder, skipValidation, moveReason } = input.body as z.infer<
          typeof Move
        >;
        const user = ctxGet<{ id?: string }>(c, "user");

        if (skipValidation && !(await can(userOf(c), "skipValidation", null, "crm"))) {
          throw AppError.forbidden("Only an administrator moves a deal without meeting the requirements");
        }

        // Get current deal
        const [deal] = await dbDe(c).select().from(crmDeals).where(eq(crmDeals.id, dealId));

        if (!deal) {
          throw AppError.notFound("Deal not found");
        }

        // Skip if already in target stage
        if (deal.stageId === targetStageId) {
          return c.json({ data: deal, message: "Already in target stage" });
        }

        // Validate transition (unless skipped)
        if (!skipValidation) {
          const validation = await validateStageTransition(dealId, targetStageId, dbDe(c));
          if (!validation.canMove) {
            throw AppError.badRequest("Validation failed", validation);
          }
        }

        // Get target stage for SLA tracking
        const [targetStage] = await dbDe(c)
          .select()
          .from(crmPipelineStages)
          .where(eq(crmPipelineStages.id, targetStageId));

        // A stage from ANOTHER pipeline left the deal on a board that is not
        // its own (and, with skipValidation, without passing any requirement).
        if (!targetStage || targetStage.pipelineId !== deal.pipelineId) {
          throw AppError.validation("Target stage not found in this pipeline");
        }

        // Close current transition (time tracking)
        if (deal.currentTransitionId) {
          await dbDe(c)
            .update(crmStageTransitions)
            .set({ exitedAt: new Date() })
            .where(eq(crmStageTransitions.id, deal.currentTransitionId));
        }

        // Create new transition record
        const [newTransition] = await dbDe(c)
          .insert(crmStageTransitions)
          .values({
            dealId,
            fromStageId: deal.stageId,
            toStageId: targetStageId,
            enteredAt: new Date(),
            estimatedDays: targetStage?.estimatedDays ?? null,
            movedBy: user?.id,
            moveReason,
            validationResult: skipValidation ? { skipped: true } : {},
          })
          .returning();

        // Update deal
        const updateData: Record<string, unknown> = {
          stageId: targetStageId,
          currentTransitionId: newTransition.id,
          updatedAt: new Date(),
        };
        // The probability is the stage's, as when creating it: otherwise the
        // weighted forecast keeps the origin stage's (phase D).
        if (targetStage.probability !== null && targetStage.probability !== undefined) {
          updateData.probability = targetStage.probability;
        }

        void newOrder; // `crm_deals` has no order column.

        const [updatedDeal] = await dbDe(c)
          .update(crmDeals)
          .set(updateData)
          .where(eq(crmDeals.id, dealId))
          .returning();

        // The deal already moved: a broken action leaves a note, it does not undo the move.
        const [sourceStage] = await dbDe(c)
          .select({ onExitActions: crmPipelineStages.onExitActions })
          .from(crmPipelineStages)
          .where(eq(crmPipelineStages.id, deal.stageId));
        const exit = await runStageActions(dbDe(c), sourceStage?.onExitActions as StageAction[], updatedDeal, user?.id ?? null);
        const enter = await runStageActions(dbDe(c), targetStage.onEnterActions as StageAction[], updatedDeal, user?.id ?? null);
        ctx.events.emit("crm:deal:stage-changed", { dealId, fromStageId: deal.stageId, toStageId: targetStageId });

        logger.info("[CRM] Deal moved", {
          dealId,
          fromStage: deal.stageId,
          toStage: targetStageId,
          transitionId: newTransition.id,
        });

        return c.json({
          data: updatedDeal,
          transition: newTransition,
          automation: { ran: [...exit.ran, ...enter.ran], failed: [...exit.failed, ...enter.failed] },
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throwInputError(error);
        logger.error("[CRM] Error moving deal:", { error });
        throw error;
      }
    }
  );

  accessOperations(crmRoutes);
  intakeOperations(crmRoutes);
  importOperations(crmRoutes);
  workOperations(crmRoutes);
  recordOperations(crmRoutes);
  agentOperations(crmRoutes);
  evidenceOperations(crmRoutes);
  scoringOperations(crmRoutes);
  presetOperations(crmRoutes);
  billingOperations(crmRoutes);
  publicOperations(crmRoutes, () => ctx.db.instance as CrmDb);
  inboundOperations(crmRoutes, () => ctx.db.instance as CrmDb);

  return crmRoutes.ops;
}

/**
 * The kon's router: the operations, behind what always used to sit in front of
 * all the routes (the request's `db` and the session for `dbDe`/`userOf`,
 * crm.context.ts) and with errors in the engine's envelope.
 */
export function createCRMRouter(ctx: KonContext): Hono {
  const router = new Hono();
  const root = ctx.db.instance as CrmDb;

  router.onError((err, c) => respondError(c, err));
  router.use("*", rlsContext(root, ctx.auth));
  router.route("/", operationsRouter(KON_ID, crmOperations(ctx), ctx));
  return router;
}

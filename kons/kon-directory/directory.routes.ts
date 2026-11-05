/**
 * Kitsuden CMS — Employee Directory Routes
 * ============================================================================
 *
 * ── WHAT WAS CLOSED (security review) ──────────────────────────────────────
 *
 * Without a session you could:
 *   · `GET /employees/:id` → the WHOLE record: date of birth, emergency
 *     contact, salary band, custom fields, personal email.
 *   · `GET /employees` → emails and mobiles of the entire staff, including of
 *     those who asked not to appear in the directory; filtering by `status` said
 *     who is on leave. The list was CACHED per query and served the same to
 *     anyone (what an admin saw, the next anonymous user saw).
 *   · `GET /employees/:id/documents` → contracts and identity documents with
 *     their number, including confidential ones.
 *   · `GET /employees/:id/reporting-chain` with a cycle in `managerId` → infinite
 *     loop of queries (DoS).
 * And with ANY account (public sign-up): create/edit/terminate employees,
 * upload documents in another's name (`uploadedById` from the body), create
 * organizations, departments and positions.
 *
 * Now: policy in directory.policy.ts, per-viewer projections (public /
 * colleague / full), allowlist of fields, per-request RLS
 * (directory.context.ts + migration 0002) and engine errors.
 *
 * Each route is now an OPERATION of the kon SDK (operations.ts):
 * each handler's body is the old one; what used to be middlewares
 * (`validateRequest`, `gestiona(type)`) is now its declaration.
 */

import {
  AppError,
  authorize,
  can,
  eqEnum,
  isUuid,
  respondError,
  operationsRouter,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { eq, and, or, sql, asc, desc, ilike, isNull, inArray, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { rlsContext, dbDe, userOf } from "./directory.context";
import type { DirectoryDb } from "./directory.db";
import { isHr, registerDirectoryPolicy, type Viewer } from "./directory.policy";
import {
  organizations,
  departments,
  positions,
  employees,
  employeeDocuments,
} from "./directory.schema";
import {
  Success,
  Card,
  Row,
  KON_ID,
  ListWithTotal,
  RowList,
  DepartmentParam,
  EmployeeParam,
  OrganizationParam,
  ON_THE_RECORD,
  query,
  manages,
  registry,
  text,
} from "./operations";

registerDirectoryPolicy();

type Employee = typeof employees.$inferSelect;

const getLogoUrl = (logoId: string | null | undefined) =>
  logoId ? `/api/media/preset/${logoId}/small` : null;
const getPhotoUrl = (photoId: string | null | undefined) =>
  photoId ? `/api/media/preset/${photoId}/thumbnail` : null;

// ── Projections: what comes out of a record depending on who looks ──────────

/** What anyone can see of a visible employee. */
const PUBLIC_COLUMNS = {
  id: employees.id,
  organizationId: employees.organizationId,
  firstName: employees.firstName,
  lastName: employees.lastName,
  displayName: employees.displayName,
  photoId: employees.photoId,
  departmentId: employees.departmentId,
  positionId: employees.positionId,
  managerId: employees.managerId,
  location: employees.location,
  remote: employees.remote,
  bio: employees.bio,
  skills: employees.skills,
  languages: employees.languages,
  linkedin: employees.linkedin,
  github: employees.github,
  twitter: employees.twitter,
  website: employees.website,
};

/** What a colleague from the same organization adds. */
const COLLEAGUE_FIELDS = ["workEmail", "phone", "timezone"] as const;

/**
 * To filter, in addition to what is public, these columns are needed (they are not output).
 */
const LIST_COLUMNS = {
  ...PUBLIC_COLUMNS,
  userId: employees.userId,
  isActive: employees.isActive,
  visibleInDirectory: employees.visibleInDirectory,
  workEmail: employees.workEmail,
  phone: employees.phone,
  timezone: employees.timezone,
};

/** Columns that only appear in the list for HR. */
const HR_LIST_COLUMNS = {
  employeeId: employees.employeeId,
  email: employees.email,
  mobile: employees.mobile,
  status: employees.status,
};

type ListRow = { [K in keyof typeof LIST_COLUMNS]: unknown } & {
  id: string;
  organizationId: string;
  userId: string | null;
  photoId: string | null;
  positionId: string | null;
  departmentId: string | null;
  managerId: string | null;
};

function project(viewer: Viewer, e: ListRow): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const k of Object.keys(PUBLIC_COLUMNS)) output[k] = e[k as keyof ListRow];
  const colleague =
    isHr(viewer.user) ||
    (!!viewer.user?.id && e.userId === viewer.user.id) ||
    viewer.organizations.has(e.organizationId);
  if (colleague) for (const k of COLLEAGUE_FIELDS) output[k] = e[k];
  output.photoUrl = getPhotoUrl(e.photoId);
  return output;
}

/** Row visibility condition for whoever is NOT HR. */
function visible(viewer: Viewer): SQL {
  const base = and(
    eq(employees.isActive, true),
    sql`coalesce(${employees.visibleInDirectory}, true)`
  )!;
  return viewer.user?.id ? or(base, eq(employees.userId, viewer.user.id))! : base;
}

/** Escapes LIKE wildcards: the user's `%` or `_` are not patterns. */
function patternValue(text: string): string {
  return `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

// ── Input schemas ────────────────────────────────────────────────────────────

const Uuid = z.guid();
const Text = (max: number) => z.string().trim().max(max);
const Url = z
  .string()
  .max(500)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "Only http(s)");
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Format YYYY-MM-DD");
const Slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(200);

const CreateOrganization = z.object({
  name: Text(200).min(1),
  slug: Slug.optional(),
  description: Text(5000).optional(),
  website: Url.optional(),
  email: z.string().email().max(255).optional(),
  phone: Text(50).optional(),
  address: Text(1000).optional(),
  city: Text(100).optional(),
  state: Text(100).optional(),
  country: Text(100).optional(),
  postalCode: Text(20).optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  logoId: Uuid.optional(),
});

const CreateDepartment = z.object({
  organizationId: Uuid,
  name: Text(200).min(1),
  slug: Slug.optional(),
  description: Text(5000).optional(),
  parentDepartmentId: Uuid.optional(),
  email: z.string().email().max(255).optional(),
  phone: Text(50).optional(),
  location: Text(500).optional(),
  costCenter: Text(100).optional(),
});

const CreatePosition = z.object({
  organizationId: Uuid,
  title: Text(200).min(1),
  slug: Slug.optional(),
  description: Text(5000).optional(),
  level: Text(50).optional(),
  grade: Text(20).optional(),
  departmentId: Uuid.optional(),
  reportsToPositionId: Uuid.optional(),
  isManagement: z.boolean().optional(),
});

const EmergencyContact = z.object({
  name: Text(200),
  relationship: Text(100),
  phone: Text(50),
});

/** What the employee themselves can touch on their record. */
const PersonalFields = {
  displayName: Text(200).nullable(),
  phone: Text(50).nullable(),
  mobile: Text(50).nullable(),
  photoId: Uuid.nullable(),
  timezone: Text(50).nullable(),
  bio: Text(5000).nullable(),
  skills: z.array(Text(100)).max(100),
  languages: z.array(Text(50)).max(50),
  linkedin: Url.nullable(),
  github: Url.nullable(),
  twitter: Url.nullable(),
  website: Url.nullable(),
  emergencyContact: EmergencyContact.nullable(),
  visibleInDirectory: z.boolean(),
};

/** What only HR touches (in addition to the personal parts). */
const HrFields = {
  userId: z.string().min(1).max(200).nullable(),
  firstName: Text(100).min(1),
  lastName: Text(100).min(1),
  email: z.string().email().max(255),
  workEmail: z.string().email().max(255).nullable(),
  departmentId: Uuid.nullable(),
  positionId: Uuid.nullable(),
  managerId: Uuid.nullable(),
  status: z.enum(["active", "on_leave", "remote", "terminated", "contractor", "intern"]),
  employmentType: z.enum(["full_time", "part_time", "contract", "intern", "freelance"]),
  startDate: Day,
  endDate: Day.nullable(),
  birthDate: Day.nullable(),
  location: Text(200).nullable(),
  remote: z.boolean(),
  salaryBand: Text(20).nullable(),
  customFields: z
    .record(z.string(), z.unknown())
    .refine((r) => JSON.stringify(r).length <= 20_000, "customFields too large"),
  externalId: Text(255).nullable(),
};

const EditEmployee = z.object({ ...PersonalFields, ...HrFields }).partial();
const PERSONAL_KEYS = new Set(Object.keys(PersonalFields));

const CreateEmployee = z
  .object({
    ...PersonalFields,
    ...HrFields,
    organizationId: Uuid,
    employeeId: Text(100).min(1),
  })
  .partial()
  .required({
    organizationId: true,
    employeeId: true,
    firstName: true,
    lastName: true,
    email: true,
  });

const CreateDocument = z.object({
  name: Text(200).min(1),
  type: Text(50).min(1),
  description: Text(2000).optional(),
  mediaId: Uuid,
  issueDate: Day.optional(),
  expiryDate: Day.optional(),
  documentNumber: Text(100).optional(),
  isConfidential: z.boolean().optional(),
});

function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 200);
}

function validId(id: string | undefined, that: string): string {
  if (!id || !isUuid(id)) throw AppError.notFound(`${that} not found`);
  return id;
}

function uuidDeQuery(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  if (!isUuid(value)) throw AppError.badRequest(`${name} is not a valid id`);
  return value;
}

function limitOf(value: string | undefined, defaultValue = 50, max = 100): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return defaultValue;
  return Math.min(n, max);
}

/**
 * The kon's operations, in the order in which the routes were registered (the
 * same resolution order as before).
 */
export function directoryOperations(ctx: KonContext): AnyOperation[] {
  const directoryRoutes = registry();
  const { cache } = ctx;

  const invalidateCache = async (pattern: string) => {
    try {
      await cache.invalidate(pattern);
    } catch {
      // accesoria
    }
  };

  /** Who looks and which organizations they are an active employee of. */
  async function viewerOf(c: Context): Promise<Viewer> {
    const user = userOf(c);
    const organizationsValue = new Set<string>();
    if (user?.id) {
      const rows = await dbDe(c)
        .select({ organizationId: employees.organizationId })
        .from(employees)
        .where(and(eq(employees.userId, user.id), eq(employees.isActive, true)));
      for (const f of rows) organizationsValue.add(f.organizationId);
    }
    return { user, organizations: organizationsValue };
  }

  async function requireManagement(c: Context, type: "directory-structure" | "directory-employee") {
    const user = userOf(c);
    await authorize(user, "manage", {}, type);
    return user!;
  }

  async function visibleEmployee(c: Context, id: string | undefined): Promise<Employee> {
    const [emp] = await dbDe(c)
      .select()
      .from(employees)
      .where(eq(employees.id, validId(id, "Employee")))
      .limit(1);
    if (!emp || !(await can(userOf(c), "viewPublic", emp, "directory-employee"))) {
      throw AppError.notFound("Employee not found");
    }
    return emp;
  }

  // In series, not with `Promise.all`: it is the request's transaction (one
  // connection, one query at a time; docs/kons/README.md, rules).
  async function namesOf(db: DirectoryDb, deptIds: string[], posIds: string[]) {
    const depts = deptIds.length
      ? await db
          .select({ id: departments.id, name: departments.name })
          .from(departments)
          .where(inArray(departments.id, deptIds))
      : ([] as { id: string; name: string }[]);
    const poss = posIds.length
      ? await db
          .select({ id: positions.id, title: positions.title })
          .from(positions)
          .where(inArray(positions.id, posIds))
      : ([] as { id: string; title: string }[]);
    return {
      dept: new Map(depts.map((d) => [d.id, d.name])),
      pos: new Map(poss.map((p) => [p.id, p.title])),
    };
  }

  function idsDe<T>(rows: T[], k: keyof T): string[] {
    return Array.from(new Set(rows.map((f) => f[k]).filter(Boolean))) as string[];
  }

  // ═══════════════════════════════════════════════
  // ORGANIZATIONS
  // ═══════════════════════════════════════════════

  directoryRoutes.get(
    "/organizations",
    {
      id: "list-organizations",
      summary: "List organizations",
      description:
        "Active organizations by name (up to 500), with their logo URL and employee count. The structure of the directory is not personal data: anyone who reaches the directory sees it.",
      access: "public",
      output: { schema: RowList },
    },
    async (c) => {
      const list = await dbDe(c)
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          website: organizations.website,
          city: organizations.city,
          country: organizations.country,
          logoId: organizations.logoId,
          employeeCount: organizations.employeeCount,
          isActive: organizations.isActive,
        })
        .from(organizations)
        .where(eq(organizations.isActive, true))
        .orderBy(asc(organizations.name))
        .limit(500);

      return c.json({ docs: list.map((org) => ({ ...org, logoUrl: getLogoUrl(org.logoId) })) });
    }
  );

  /**
   * PERMISSION before the body (phase D fixes): with validation
   * first, an account without permission got a 422 for an empty body
   * and learned the schema of a route that is not theirs. While the core's gate
   * only let the admin in this went unnoticed; now that the route is
   * open to anyone with a session, a 403 does not wait for a 422.
   *
   * It was the `gestiona(type)` middleware; now it is the `permission` of each
   * create operation (`gestiona(type)` in operations.ts), which the SDK
   * checks before reading the body.
   */

  directoryRoutes.post(
    "/organizations",
    {
      id: "create-organization",
      summary: "Create an organization",
      description:
        "Creates an organization; the slug comes from the name unless given, and must be unique (409). Only HR (admin, or an agent with `directory:*`): anyone else gets 403 before the body is read.",
      access: "optional",
      permission: manages("directory-structure"),
      input: { body: CreateOrganization },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      await requireManagement(c, "directory-structure");
      const body: z.infer<typeof CreateOrganization> = input.body;
      const db = dbDe(c);
      const slug = body.slug || slugOf(body.name);
      if (!slug) throw AppError.validation("The name does not produce a valid slug");

      const [existing] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, slug))
        .limit(1);
      if (existing) throw AppError.conflict("An organization with that slug already exists");

      const [org] = await db
        .insert(organizations)
        .values({ ...body, slug })
        .returning();
      return c.json(org, 201);
    }
  );

  directoryRoutes.get(
    "/organizations/:id",
    {
      id: "get-organization",
      summary: "Read an organization",
      description:
        "One organization by id or slug, with its logo URL and its active top-level departments. An inactive organization is a 404 except for HR.",
      access: "optional",
      input: { params: OrganizationParam },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const id = c.req.param("id");
      const db = dbDe(c);
      const [org] = await db
        .select()
        .from(organizations)
        .where(isUuid(id) ? eq(organizations.id, id) : eq(organizations.slug, id))
        .limit(1);
      if (!org || (!org.isActive && !isHr(userOf(c)))) {
        throw AppError.notFound("Organization not found");
      }

      const depts = await db
        .select({
          id: departments.id,
          name: departments.name,
          slug: departments.slug,
          employeeCount: departments.employeeCount,
          headId: departments.headId,
        })
        .from(departments)
        .where(
          and(
            eq(departments.organizationId, org.id),
            eq(departments.isActive, true),
            isNull(departments.parentDepartmentId)
          )
        )
        .orderBy(asc(departments.name))
        .limit(500);

      return c.json({ ...org, logoUrl: getLogoUrl(org.logoId), departments: depts });
    }
  );

  // ═══════════════════════════════════════════════
  // DEPARTMENTS
  // ═══════════════════════════════════════════════

  directoryRoutes.get(
    "/departments",
    {
      id: "list-departments",
      summary: "List departments",
      description:
        "Active departments by name (up to 1000). `organizationId` filters (uuid, else 400); `parentId` filters by parent department (`null` = top level).",
      access: "public",
      input: {
        query: query({
          organizationId: text("Organization id (uuid)"),
          parentId: text("Parent department id (uuid), or `null` for top-level departments"),
        }),
      },
      output: { schema: RowList },
    },
    async (c) => {
      const orgId = uuidDeQuery(c.req.query("organizationId"), "organizationId");
      const parentId = c.req.query("parentId");

      const conditions: SQL[] = [eq(departments.isActive, true)];
      if (orgId) conditions.push(eq(departments.organizationId, orgId));
      if (parentId === "null") conditions.push(isNull(departments.parentDepartmentId));
      else if (parentId) {
        conditions.push(eq(departments.parentDepartmentId, uuidDeQuery(parentId, "parentId")!));
      }

      const list = await dbDe(c)
        .select({
          id: departments.id,
          organizationId: departments.organizationId,
          name: departments.name,
          slug: departments.slug,
          description: departments.description,
          level: departments.level,
          employeeCount: departments.employeeCount,
          headId: departments.headId,
          location: departments.location,
        })
        .from(departments)
        .where(and(...conditions))
        .orderBy(asc(departments.name))
        .limit(1000);

      return c.json({ docs: list });
    }
  );

  directoryRoutes.post(
    "/departments",
    {
      id: "create-department",
      summary: "Create a department",
      description:
        "Creates a department in an organization (slug unique within it: 409). A parent department must be of the same organization (422). Only HR (admin, or an agent with `directory:*`): anyone else gets 403 before the body is read.",
      access: "optional",
      permission: manages("directory-structure"),
      input: { body: CreateDepartment },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      await requireManagement(c, "directory-structure");
      const body: z.infer<typeof CreateDepartment> = input.body;
      const db = dbDe(c);
      const slug = body.slug || slugOf(body.name);
      if (!slug) throw AppError.validation("The name does not produce a valid slug");

      const [existing] = await db
        .select({ id: departments.id })
        .from(departments)
        .where(and(eq(departments.organizationId, body.organizationId), eq(departments.slug, slug)))
        .limit(1);
      if (existing) throw AppError.conflict("A department with that slug already exists");

      let level = 0;
      if (body.parentDepartmentId) {
        const [parent] = await db
          .select({ level: departments.level, organizationId: departments.organizationId })
          .from(departments)
          .where(eq(departments.id, body.parentDepartmentId))
          .limit(1);
        if (!parent || parent.organizationId !== body.organizationId) {
          throw AppError.validation("The parent department does not belong to that organization");
        }
        level = parent.level + 1;
      }

      const [dept] = await db
        .insert(departments)
        .values({ ...body, slug, level })
        .returning();

      await invalidateCache(`directory:*`);
      return c.json(dept, 201);
    }
  );

  directoryRoutes.get(
    "/departments/:id",
    {
      id: "get-department",
      summary: "Read a department",
      description:
        "One department with its head, sub-departments and active employees, each employee shown as the caller may see them (public card; work email and phone for colleagues of the same organization; everything for HR). The cost center is HR only. An inactive department is a 404 except for HR.",
      access: "optional",
      input: { params: DepartmentParam },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const id = validId(c.req.param("id"), "Department");
      const db = dbDe(c);
      const viewer = await viewerOf(c);
      const hr = isHr(viewer.user);

      const [dept] = await db.select().from(departments).where(eq(departments.id, id)).limit(1);
      if (!dept || (!dept.isActive && !hr)) throw AppError.notFound("Department not found");

      let head: Record<string, unknown> | null = null;
      if (dept.headId) {
        const [h] = await db
          .select(LIST_COLUMNS)
          .from(employees)
          .where(and(eq(employees.id, dept.headId), hr ? undefined : visible(viewer)))
          .limit(1);
        head = h ? project(viewer, h as ListRow) : null;
      }

      const subDepartments = await db
        .select({
          id: departments.id,
          name: departments.name,
          slug: departments.slug,
          employeeCount: departments.employeeCount,
        })
        .from(departments)
        .where(and(eq(departments.parentDepartmentId, id), eq(departments.isActive, true)))
        .orderBy(asc(departments.name))
        .limit(500);

      const emps = await db
        .select(LIST_COLUMNS)
        .from(employees)
        .where(
          and(
            eq(employees.departmentId, id),
            eq(employees.isActive, true),
            hr ? undefined : visible(viewer)
          )
        )
        .orderBy(asc(employees.lastName))
        .limit(1000);

      // The cost center belongs to HR.
      const data: Record<string, unknown> = { ...dept };
      if (!hr) delete data.costCenter;
      return c.json({
        ...data,
        head,
        subDepartments,
        employees: emps.map((e) => project(viewer, e as ListRow)),
      });
    }
  );

  // ═══════════════════════════════════════════════
  // POSITIONS
  // ═══════════════════════════════════════════════

  directoryRoutes.get(
    "/positions",
    {
      id: "list-positions",
      summary: "List positions",
      description:
        "Active positions by title (up to 1000). `organizationId` and `departmentId` filter (uuids, else 400).",
      access: "public",
      input: {
        query: query({
          organizationId: text("Organization id (uuid)"),
          departmentId: text("Department id (uuid)"),
        }),
      },
      output: { schema: RowList },
    },
    async (c) => {
      const orgId = uuidDeQuery(c.req.query("organizationId"), "organizationId");
      const deptId = uuidDeQuery(c.req.query("departmentId"), "departmentId");

      const conditions: SQL[] = [eq(positions.isActive, true)];
      if (orgId) conditions.push(eq(positions.organizationId, orgId));
      if (deptId) conditions.push(eq(positions.departmentId, deptId));

      const list = await dbDe(c)
        .select({
          id: positions.id,
          title: positions.title,
          level: positions.level,
          grade: positions.grade,
          departmentId: positions.departmentId,
          isManagement: positions.isManagement,
        })
        .from(positions)
        .where(and(...conditions))
        .orderBy(asc(positions.title))
        .limit(1000);

      return c.json({ docs: list });
    }
  );

  directoryRoutes.post(
    "/positions",
    {
      id: "create-position",
      summary: "Create a position",
      description:
        "Creates a position in an organization; the slug comes from the title unless given. Only HR (admin, or an agent with `directory:*`): anyone else gets 403 before the body is read.",
      access: "optional",
      permission: manages("directory-structure"),
      input: { body: CreatePosition },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      await requireManagement(c, "directory-structure");
      const body: z.infer<typeof CreatePosition> = input.body;
      const slug = body.slug || slugOf(body.title);
      if (!slug) throw AppError.validation("The title does not produce a valid slug");

      const [position] = await dbDe(c)
        .insert(positions)
        .values({ ...body, slug, isManagement: body.isManagement ?? false })
        .returning();
      return c.json(position, 201);
    }
  );

  // ═══════════════════════════════════════════════
  // EMPLOYEES
  // ═══════════════════════════════════════════════

  /**
   * List. No cache: what comes out depends on who looks. Whoever is not HR
   * only filters by what is already public (organization, department, position,
   * manager, location, remote) and searches by NAME: searching by email or
   * filtering by status would be an oracle for learning someone's email or
   * who is on leave without the response saying so.
   */
  directoryRoutes.get(
    "/employees",
    {
      id: "list-employees",
      summary: "List employees",
      description:
        "Active employees by surname, each shown as the caller may see them: a public card for anyone (hidden profiles left out), plus work email, phone and timezone for colleagues of the same organization; HR sees every column. Filters: `organizationId`, `departmentId`, `positionId`, `managerId` (uuids, else 400), `remote=true`, `location`, `search` (by name; HR also by email), `status` (HR only, ignored for anyone else) and `limit` (1-100, default 50).",
      access: "optional",
      input: {
        query: query({
          organizationId: text("Organization id (uuid)"),
          departmentId: text("Department id (uuid)"),
          positionId: text("Position id (uuid)"),
          managerId: text("Manager's employee id (uuid)"),
          remote: text("`true`: only remote employees"),
          location: text("Exact location"),
          status: text("Employment status (HR only; ignored otherwise)"),
          search: text("Name contains (HR: also email)"),
          limit: text("Max employees, 1-100 (default 50)"),
        }),
      },
      output: { schema: ListWithTotal },
    },
    async (c) => {
      const query = c.req.query();
      const viewer = await viewerOf(c);
      const hr = isHr(viewer.user);
      const db = dbDe(c);

      const conditions: SQL[] = [eq(employees.isActive, true)];
      if (!hr) conditions.push(visible(viewer));
      const orgId = uuidDeQuery(query.organizationId, "organizationId");
      const deptId = uuidDeQuery(query.departmentId, "departmentId");
      const posId = uuidDeQuery(query.positionId, "positionId");
      const managerId = uuidDeQuery(query.managerId, "managerId");
      if (orgId) conditions.push(eq(employees.organizationId, orgId));
      if (deptId) conditions.push(eq(employees.departmentId, deptId));
      if (posId) conditions.push(eq(employees.positionId, posId));
      if (managerId) conditions.push(eq(employees.managerId, managerId));
      if (query.remote === "true") conditions.push(eq(employees.remote, true));
      if (query.location) conditions.push(eq(employees.location, query.location.slice(0, 200)));
      if (hr) {
        const statusFilter = eqEnum(employees.status, query.status);
        if (statusFilter) conditions.push(statusFilter);
      }

      if (query.search) {
        const p = patternValue(query.search.slice(0, 100));
        const fields = [
          ilike(employees.firstName, p),
          ilike(employees.lastName, p),
          ilike(employees.displayName, p),
        ];
        if (hr) fields.push(ilike(employees.email, p));
        conditions.push(or(...fields)!);
      }

      const empList = (await db
        .select(hr ? { ...LIST_COLUMNS, ...HR_LIST_COLUMNS } : LIST_COLUMNS)
        .from(employees)
        .where(and(...conditions))
        .orderBy(asc(employees.lastName), asc(employees.firstName))
        .limit(limitOf(query.limit))) as ListRow[];

      const names = await namesOf(
        db,
        idsDe(empList, "departmentId"),
        idsDe(empList, "positionId")
      );

      const docs = empList.map((e) => ({
        ...(hr ? { ...e, photoUrl: getPhotoUrl(e.photoId) } : project(viewer, e)),
        departmentName: e.departmentId ? names.dept.get(e.departmentId) : null,
        positionTitle: e.positionId ? names.pos.get(e.positionId) : null,
      }));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  directoryRoutes.post(
    "/employees",
    {
      id: "create-employee",
      summary: "Create an employee profile",
      description:
        "Creates an employee profile in an organization and recounts its headcount. The employee number must be unique in the organization and the email unique overall (409). Only HR (admin, or an agent with `directory:*`): anyone else gets 403 before the body is read.",
      access: "optional",
      permission: manages("directory-employee"),
      input: { body: CreateEmployee },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      await requireManagement(c, "directory-employee");
      const body: z.infer<typeof CreateEmployee> = input.body;
      const db = dbDe(c);

      const [existingId] = await db
        .select({ id: employees.id })
        .from(employees)
        .where(
          and(
            eq(employees.organizationId, body.organizationId),
            eq(employees.employeeId, body.employeeId)
          )
        )
        .limit(1);
      if (existingId)
        throw AppError.conflict("That employee number already exists in the organization");

      const [existingEmail] = await db
        .select({ id: employees.id })
        .from(employees)
        .where(eq(employees.email, body.email))
        .limit(1);
      if (existingEmail) throw AppError.conflict("That email is already registered");

      const [emp] = await db
        .insert(employees)
        .values({
          ...body,
          startDate: body.startDate || new Date().toISOString().split("T")[0],
          source: "manual",
        })
        .returning();

      await recount(db, body.organizationId, body.departmentId ?? null);
      await invalidateCache(`directory:*`);
      return c.json(emp, 201);
    }
  );

  async function recount(db: DirectoryDb, orgId: string, deptId: string | null) {
    const [orgCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(employees)
      .where(and(eq(employees.organizationId, orgId), eq(employees.isActive, true)));
    await db
      .update(organizations)
      .set({ employeeCount: orgCount?.count || 0 })
      .where(eq(organizations.id, orgId));
    if (deptId) {
      const [deptCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(employees)
        .where(and(eq(employees.departmentId, deptId), eq(employees.isActive, true)));
      await db
        .update(departments)
        .set({ employeeCount: deptCount?.count || 0 })
        .where(eq(departments.id, deptId));
    }
  }

  directoryRoutes.get(
    "/employees/:id",
    {
      id: "get-employee",
      summary: "Read an employee profile",
      description:
        "One employee with organization, department, position, manager and direct reports. The employee and HR see the whole profile; colleagues of the same organization add work email, phone and timezone to the public card; anyone else only the public card. A hidden or inactive profile is a 404 except for its owner and HR.",
      access: "optional",
      input: { params: EmployeeParam },
      output: { schema: Card },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const viewer = await viewerOf(c);
      const emp = await visibleEmployee(c, c.req.param("id"));
      const db = dbDe(c);
      const hr = isHr(viewer.user);
      const complete = await can(viewer.user, "viewFull", emp, "directory-employee");

      // In series: it is the request's transaction (no `Promise.all`).
      const dept = emp.departmentId
        ? await db
            .select({ id: departments.id, name: departments.name, slug: departments.slug })
            .from(departments)
            .where(eq(departments.id, emp.departmentId))
            .limit(1)
            .then((r) => r[0] ?? null)
        : null;
      const pos = emp.positionId
        ? await db
            .select({ id: positions.id, title: positions.title, level: positions.level })
            .from(positions)
            .where(eq(positions.id, emp.positionId))
            .limit(1)
            .then((r) => r[0] ?? null)
        : null;
      const manager = emp.managerId
        ? await db
            .select(LIST_COLUMNS)
            .from(employees)
            .where(and(eq(employees.id, emp.managerId), hr ? undefined : visible(viewer)))
            .limit(1)
            .then((r) => (r[0] ? project(viewer, r[0] as ListRow) : null))
        : null;
      const org = await db
        .select({
          name: organizations.name,
          slug: organizations.slug,
          logoId: organizations.logoId,
        })
        .from(organizations)
        .where(eq(organizations.id, emp.organizationId))
        .limit(1)
        .then((r) => r[0] ?? null);

      const reports = await db
        .select(LIST_COLUMNS)
        .from(employees)
        .where(
          and(
            eq(employees.managerId, emp.id),
            eq(employees.isActive, true),
            hr ? undefined : visible(viewer)
          )
        )
        .orderBy(asc(employees.lastName))
        .limit(500);
      const names = await namesOf(db, [], idsDe(reports, "positionId"));

      const card = complete
        ? { ...emp, photoUrl: getPhotoUrl(emp.photoId) }
        : project(viewer, emp as unknown as ListRow);
      return c.json({
        ...card,
        organization: org
          ? { name: org.name, slug: org.slug, logoUrl: getLogoUrl(org.logoId) }
          : null,
        department: dept,
        position: pos,
        manager,
        directReports: reports.map((r) => ({
          ...project(viewer, r as ListRow),
          positionTitle: r.positionId ? names.pos.get(r.positionId) : null,
        })),
      });
    }
  );

  directoryRoutes.patch(
    "/employees/:id",
    {
      id: "update-employee",
      summary: "Update an employee profile",
      description:
        "HR changes any field of a profile. An employee changes only the PERSONAL fields of their own profile (display name, photo, phones, timezone, bio, skills, languages, links, emergency contact, visibility): any other field is a 403, someone else's visible profile a 403 and a hidden one a 404. Without a session, 401.",
      access: "optional",
      permission: ON_THE_RECORD,
      input: { params: EmployeeParam, body: EditEmployee },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const user = userOf(c);
      if (!user) throw AppError.unauthenticated();
      const db = dbDe(c);
      const [existing] = await db
        .select()
        .from(employees)
        .where(eq(employees.id, validId(c.req.param("id"), "Employee")))
        .limit(1);
      if (!existing) throw AppError.notFound("Employee not found");

      // `h.can`: the "directory-employee" policy plus the operation's scopes.
      const hr = await h.can(existing, "manage");
      if (!hr) {
        if (!(await h.can(existing, "updateSelf"))) {
          // Someone else's record: 404 if it is not visible to them, 403 if they see it but it is not theirs.
          if (!(await h.can(existing, "viewPublic"))) {
            throw AppError.notFound("Employee not found");
          }
          throw AppError.forbidden("You can only edit your own record");
        }
      }
      const body: z.infer<typeof EditEmployee> = input.body;
      if (!hr) {
        const forbiddenItems = Object.keys(body).filter((k) => !PERSONAL_KEYS.has(k));
        if (forbiddenItems.length > 0) {
          throw AppError.forbidden("Only HR changes those fields", { fields: forbiddenItems });
        }
      }

      const [updated] = await db
        .update(employees)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(employees.id, existing.id))
        .returning();

      if (hr && body.departmentId !== undefined && body.departmentId !== existing.departmentId) {
        if (existing.departmentId)
          await recount(db, existing.organizationId, existing.departmentId);
        await recount(db, existing.organizationId, body.departmentId);
      }

      await invalidateCache(`directory:*`);
      return c.json(updated);
    }
  );

  directoryRoutes.delete(
    "/employees/:id",
    {
      id: "offboard-employee",
      summary: "Terminate an employee",
      description:
        "Soft delete: marks the profile inactive and terminated, and recounts the headcount. Only HR (admin, or an agent with `directory:*`).",
      access: "optional",
      permission: manages("directory-employee"),
      input: { params: EmployeeParam },
      output: { schema: Success },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      await requireManagement(c, "directory-employee");
      const db = dbDe(c);
      const [existing] = await db
        .select({ organizationId: employees.organizationId, departmentId: employees.departmentId })
        .from(employees)
        .where(eq(employees.id, validId(c.req.param("id"), "Employee")))
        .limit(1);
      if (!existing) throw AppError.notFound("Employee not found");

      await db
        .update(employees)
        .set({ isActive: false, status: "terminated", updatedAt: new Date() })
        .where(eq(employees.id, c.req.param("id")!));

      await recount(db, existing.organizationId, existing.departmentId);
      await invalidateCache(`directory:*`);
      return c.json({ success: true });
    }
  );

  // ═══════════════════════════════════════════════
  // ORG CHART
  // ═══════════════════════════════════════════════

  directoryRoutes.get(
    "/org-chart",
    {
      id: "get-org-chart",
      summary: "Read an organization's org chart",
      description:
        "The tree of active, visible employees of an organization by manager (`organizationId` is required: 400 without it). Each node is the card the caller may see, with department and position names.",
      access: "optional",
      input: { query: query({ organizationId: text("Organization id (uuid), required") }) },
      output: {
        schema: z
          .object({
            organizationId: z.string(),
            roots: z.array(Card),
            totalEmployees: z.number().int(),
          })
          .passthrough(),
      },
    },
    async (c) => {
      const orgId = uuidDeQuery(c.req.query("organizationId"), "organizationId");
      if (!orgId) throw AppError.badRequest("organizationId is required");
      const viewer = await viewerOf(c);
      const hr = isHr(viewer.user);
      const db = dbDe(c);

      const empList = (await db
        .select(LIST_COLUMNS)
        .from(employees)
        .where(
          and(
            eq(employees.organizationId, orgId),
            eq(employees.isActive, true),
            hr ? undefined : visible(viewer)
          )
        )
        .limit(5000)) as ListRow[];

      const names = await namesOf(
        db,
        idsDe(empList, "departmentId"),
        idsDe(empList, "positionId")
      );

      type TreeNode = Record<string, unknown> & { children: TreeNode[] };
      const empMap = new Map<string, TreeNode>(
        empList.map((e) => [
          e.id,
          {
            ...project(viewer, e),
            departmentName: e.departmentId ? names.dept.get(e.departmentId) : null,
            positionTitle: e.positionId ? names.pos.get(e.positionId) : null,
            children: [],
          },
        ])
      );

      const roots: TreeNode[] = [];
      for (const emp of empList) {
        const node = empMap.get(emp.id)!;
        if (emp.managerId && emp.managerId !== emp.id && empMap.has(emp.managerId)) {
          empMap.get(emp.managerId)!.children.push(node);
        } else {
          roots.push(node);
        }
      }

      return c.json({ organizationId: orgId, roots, totalEmployees: empList.length });
    }
  );

  /**
   * Chain of command. It used to follow `managerId` without limit: a cycle (A manager of
   * B, B manager of A) was an infinite loop of queries.
   */
  directoryRoutes.get(
    "/employees/:id/reporting-chain",
    {
      id: "get-reporting-chain",
      summary: "Read an employee's reporting chain",
      description:
        "From the top manager down to the employee (at most 50 steps; a cycle of managers stops). Each step is the card the caller may see, with the position title. A hidden profile is a 404.",
      access: "optional",
      input: { params: EmployeeParam },
      output: { schema: z.object({ chain: z.array(Card) }).passthrough() },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const viewer = await viewerOf(c);
      const hr = isHr(viewer.user);
      const emp = await visibleEmployee(c, c.req.param("id"));
      const db = dbDe(c);

      const chain: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      let currentId: string | null = emp.id;

      while (currentId && !seen.has(currentId) && seen.size < 50) {
        seen.add(currentId);
        const rows = (await db
          .select(LIST_COLUMNS)
          .from(employees)
          .where(and(eq(employees.id, currentId), hr ? undefined : visible(viewer)))
          .limit(1)) as ListRow[];
        const row = rows[0];
        if (!row) break;

        const [pos] = row.positionId
          ? await db
              .select({ title: positions.title })
              .from(positions)
              .where(eq(positions.id, row.positionId))
              .limit(1)
          : [null];

        chain.unshift({ ...project(viewer, row), positionTitle: pos?.title ?? null });
        currentId = row.managerId;
      }

      return c.json({ chain });
    }
  );

  // ═══════════════════════════════════════════════
  // EMPLOYEE DOCUMENTS
  // ═══════════════════════════════════════════════

  directoryRoutes.get(
    "/employees/:id/documents",
    {
      id: "list-employee-documents",
      summary: "List an employee's documents",
      description:
        "HR sees every document of a profile; the employee sees their own non-confidential ones; anyone else gets 404. Without a session, 401.",
      access: "optional",
      input: { params: EmployeeParam },
      output: { schema: RowList },
      errors: ["KITSUDEN_E_UNAUTHENTICATED", "KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const user = userOf(c);
      if (!user) throw AppError.unauthenticated();
      const emp = await visibleEmployee(c, c.req.param("id"));
      if (!(await can(user, "viewFull", emp, "directory-employee"))) {
        throw AppError.notFound("Employee not found");
      }

      const docs = await dbDe(c)
        .select()
        .from(employeeDocuments)
        .where(eq(employeeDocuments.employeeId, emp.id))
        .orderBy(desc(employeeDocuments.createdAt))
        .limit(500);

      const visible: typeof docs = [];
      for (const d of docs) {
        if (
          await can(
            user,
            "view",
            { isConfidential: d.isConfidential, employee: emp },
            "directory-document"
          )
        ) {
          visible.push(d);
        }
      }
      return c.json({ docs: visible });
    }
  );

  directoryRoutes.post(
    "/employees/:id/documents",
    {
      id: "add-employee-document",
      summary: "Add a document to an employee profile",
      description:
        "Records a document (contract, ID, certificate…) of an employee, pointing at a media file already uploaded (`mediaId`); the uploader is the caller. Only HR (admin, or an agent with `directory:*`): anyone else gets 403 before the body is read.",
      access: "optional",
      permission: manages("directory-document"),
      input: { params: EmployeeParam, body: CreateDocument },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const user = userOf(c);
      await authorize(user, "manage", {}, "directory-document");
      const id = validId(c.req.param("id"), "Employee");
      const body: z.infer<typeof CreateDocument> = input.body;
      const db = dbDe(c);

      const [emp] = await db
        .select({ id: employees.id })
        .from(employees)
        .where(eq(employees.id, id))
        .limit(1);
      if (!emp) throw AppError.notFound("Employee not found");

      const [doc] = await db
        .insert(employeeDocuments)
        .values({
          ...body,
          employeeId: id,
          isConfidential: body.isConfidential ?? false,
          uploadedById: user!.id, // from the session, never from the body
        })
        .returning();
      return c.json(doc, 201);
    }
  );

  // ═══════════════════════════════════════════════
  // SEARCH
  // ═══════════════════════════════════════════════

  directoryRoutes.get(
    "/search",
    {
      id: "search-directory",
      summary: "Search people and departments",
      description:
        "Up to 20 employees (by name; HR also by email) and 10 departments (by name or description) matching `q` (2 characters at least, else 400); `organizationId` narrows it. Employees come as the card the caller may see.",
      access: "optional",
      input: {
        query: query({
          q: text("Text to search, at least 2 characters"),
          organizationId: text("Organization id (uuid)"),
        }),
      },
      output: {
        schema: z
          .object({
            employees: z.array(Card),
            departments: z.array(Row),
            total: z.number().int(),
          })
          .passthrough(),
      },
    },
    async (c) => {
      const q = c.req.query("q");
      if (!q || q.length < 2)
        throw AppError.badRequest("The search needs at least 2 characters");
      const orgId = uuidDeQuery(c.req.query("organizationId"), "organizationId");
      const viewer = await viewerOf(c);
      const hr = isHr(viewer.user);
      const db = dbDe(c);
      const p = patternValue(q.slice(0, 100));

      const employeeFields = [
        ilike(employees.firstName, p),
        ilike(employees.lastName, p),
        ilike(employees.displayName, p),
      ];
      if (hr) employeeFields.push(ilike(employees.email, p));

      const empResults = (await db
        .select(LIST_COLUMNS)
        .from(employees)
        .where(
          and(
            eq(employees.isActive, true),
            hr ? undefined : visible(viewer),
            orgId ? eq(employees.organizationId, orgId) : undefined,
            or(...employeeFields)
          )
        )
        .limit(20)) as ListRow[];

      const deptResults = await db
        .select({
          id: departments.id,
          name: departments.name,
          description: departments.description,
          employeeCount: departments.employeeCount,
        })
        .from(departments)
        .where(
          and(
            eq(departments.isActive, true),
            orgId ? eq(departments.organizationId, orgId) : undefined,
            or(ilike(departments.name, p), ilike(departments.description, p))
          )
        )
        .limit(10);

      return c.json({
        employees: empResults.map((e) => project(viewer, e)),
        departments: deptResults,
        total: empResults.length + deptResults.length,
      });
    }
  );

  // ═══════════════════════════════════════════════
  // STATS — for HR or whoever works in that organization
  // ═══════════════════════════════════════════════

  directoryRoutes.get(
    "/stats",
    {
      id: "get-directory-stats",
      summary: "Read an organization's headcount stats",
      description:
        "Active employees of an organization by status and department, and remote vs on site (`organizationId` is required: 400 without it). For HR and for active employees of that organization (403 otherwise; 401 without a session).",
      access: "optional",
      input: { query: query({ organizationId: text("Organization id (uuid), required") }) },
      output: {
        schema: z
          .object({
            totalEmployees: z.number().int(),
            byStatus: z.record(z.string(), z.number()),
            byDepartment: z.record(z.string(), z.number()),
            remoteEmployees: z.number().int(),
            onSiteEmployees: z.number().int(),
          })
          .passthrough(),
      },
      errors: ["KITSUDEN_E_UNAUTHENTICATED", "KITSUDEN_E_FORBIDDEN"],
    },
    async (c) => {
      const orgId = uuidDeQuery(c.req.query("organizationId"), "organizationId");
      if (!orgId) throw AppError.badRequest("organizationId is required");
      const viewer = await viewerOf(c);
      if (!viewer.user) throw AppError.unauthenticated();
      await authorize(viewer.user, "view", { organizationId: orgId, visor: viewer }, "directory-stats");
      const db = dbDe(c);

      const ofOrg = and(eq(employees.organizationId, orgId), eq(employees.isActive, true));
      const statusCounts = await db
        .select({ status: employees.status, count: sql<number>`count(*)::int` })
        .from(employees)
        .where(ofOrg)
        .groupBy(employees.status);
      const deptCounts = await db
        .select({ departmentId: employees.departmentId, count: sql<number>`count(*)::int` })
        .from(employees)
        .where(ofOrg)
        .groupBy(employees.departmentId);
      const [remoteCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(employees)
        .where(and(ofOrg, eq(employees.remote, true)));
      const [totalCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(employees)
        .where(ofOrg);

      return c.json({
        totalEmployees: totalCount?.count || 0,
        byStatus: Object.fromEntries(statusCounts.map((s) => [s.status, s.count])),
        byDepartment: Object.fromEntries(deptCounts.map((d) => [d.departmentId, d.count])),
        remoteEmployees: remoteCount?.count || 0,
        onSiteEmployees: (totalCount?.count || 0) - (remoteCount?.count || 0),
      });
    }
  );

  return directoryRoutes.ops;
}

/**
 * The kon's router: the operations, behind what always used to sit in front of
 * all the routes (the request's `db` and the session for `dbDe`/`userOf`,
 * directory.context.ts) and with errors in the engine's envelope (those that
 * are not `AppError`, such as a SQLSTATE 23505 → 409, are translated by `respondError`).
 */
export function createDirectoryRouter(ctx: KonContext): Hono {
  const router = new Hono();
  const root = ctx.db.instance as DirectoryDb;

  router.onError((err, c) => respondError(c, err));
  router.use("*", rlsContext(root, ctx.auth));
  router.route("/", operationsRouter(KON_ID, directoryOperations(ctx), ctx));
  return router;
}

// Legacy export for backward compatibility
export { createDirectoryRouter as directoryRoutes };

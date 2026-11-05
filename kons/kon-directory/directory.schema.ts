/**
 * Kitsuden CMS — Employee Directory Schema
 *
 * Drizzle ORM schema for employee profiles, departments, positions,
 * and organizational hierarchy.
 */

import { relations } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";

// ═══════════════════════════════════════════════
// Enums
// ═══════════════════════════════════════════════

export const employeeStatusEnum = pgEnum("directory_employee_status", [
  "active",
  "on_leave",
  "remote",
  "terminated",
  "contractor",
  "intern",
]);

export const employmentTypeEnum = pgEnum("directory_employment_type", [
  "full_time",
  "part_time",
  "contract",
  "intern",
  "freelance",
]);

// ═══════════════════════════════════════════════
// Organizations Table (Company/Entity)
// ═══════════════════════════════════════════════

export const organizations = pgTable(
  "directory_organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 200 }).notNull().unique(),
    description: text("description"),

    // Contact
    website: varchar("website", { length: 500 }),
    email: varchar("email", { length: 255 }),
    phone: varchar("phone", { length: 50 }),

    // Address
    address: text("address"),
    city: varchar("city", { length: 100 }),
    state: varchar("state", { length: 100 }),
    country: varchar("country", { length: 100 }),
    postalCode: varchar("postal_code", { length: 20 }),

    // Branding
    logoId: uuid("logo_id"), // References media.id
    primaryColor: varchar("primary_color", { length: 7 }),

    // Settings
    isActive: boolean("is_active").default(true).notNull(),
    employeeCount: integer("employee_count").default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("directory_organizations_slug_idx").on(t.slug),
    index("directory_organizations_active_idx").on(t.isActive),
  ]
);

// ═══════════════════════════════════════════════
// Departments Table
// ═══════════════════════════════════════════════

export const departments = pgTable(
  "directory_departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    name: varchar("name", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 200 }).notNull(),
    description: text("description"),

    // Hierarchy
    parentDepartmentId: uuid("parent_department_id"), // Self-reference for nested depts
    level: integer("level").default(0).notNull(), // 0 = top level

    // Leadership
    headId: uuid("head_id"), // References employees.id (set after employee created)

    // Contact
    email: varchar("email", { length: 255 }),
    phone: varchar("phone", { length: 50 }),
    location: varchar("location", { length: 500 }),

    // Cost center
    costCenter: varchar("cost_center", { length: 100 }),

    // Settings
    isActive: boolean("is_active").default(true).notNull(),
    employeeCount: integer("employee_count").default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("directory_dept_org_slug_idx").on(t.organizationId, t.slug),
    index("directory_departments_org_idx").on(t.organizationId),
    index("directory_departments_parent_idx").on(t.parentDepartmentId),
    index("directory_departments_head_idx").on(t.headId),
    index("directory_departments_active_idx").on(t.isActive),
  ]
);

// ═══════════════════════════════════════════════
// Positions/Job Titles Table
// ═══════════════════════════════════════════════

export const positions = pgTable(
  "directory_positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    title: varchar("title", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 200 }).notNull(),
    description: text("description"),

    // Level
    level: varchar("level", { length: 50 }), // Junior, Senior, Lead, etc.
    grade: varchar("grade", { length: 20 }), // L1, L2, L3, M1, M2, etc.

    // Department
    departmentId: uuid("department_id").references(() => departments.id),

    // Reports to
    reportsToPositionId: uuid("reports_to_position_id"), // Parent position

    // Settings
    isActive: boolean("is_active").default(true).notNull(),
    isManagement: boolean("is_management").default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("directory_pos_org_slug_idx").on(t.organizationId, t.slug),
    index("directory_positions_org_idx").on(t.organizationId),
    index("directory_positions_dept_idx").on(t.departmentId),
    index("directory_positions_active_idx").on(t.isActive),
  ]
);

// ═══════════════════════════════════════════════
// Employees Table
// ═══════════════════════════════════════════════

export const employees = pgTable(
  "directory_employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Link to auth user (optional - for contractors/external)
    userId: text("user_id"), // auth_users.id (text: better-auth ids are not UUIDs)

    // Organization
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    // Basic Info
    employeeId: varchar("employee_id", { length: 100 }).notNull(), // Company employee ID
    firstName: varchar("first_name", { length: 100 }).notNull(),
    lastName: varchar("last_name", { length: 100 }).notNull(),
    displayName: varchar("display_name", { length: 200 }), // Preferred display name
    email: varchar("email", { length: 255 }).notNull(),
    workEmail: varchar("work_email", { length: 255 }),
    phone: varchar("phone", { length: 50 }),
    mobile: varchar("mobile", { length: 50 }),

    // Avatar/Photo
    photoId: uuid("photo_id"), // References media.id

    // Job Info
    departmentId: uuid("department_id").references(() => departments.id),
    positionId: uuid("position_id").references(() => positions.id),

    // Reporting
    managerId: uuid("manager_id"), // References employees.id (self-reference)

    // Employment
    status: employeeStatusEnum("status").default("active").notNull(),
    employmentType: employmentTypeEnum("employment_type").default("full_time").notNull(),

    // Dates
    startDate: date("start_date").notNull(),
    endDate: date("end_date"), // For terminated/contract employees
    birthDate: date("birth_date"),

    // Location
    location: varchar("location", { length: 200 }), // Office location
    timezone: varchar("timezone", { length: 50 }),
    remote: boolean("remote").default(false),

    // Compensation (encrypted or reference)
    salaryBand: varchar("salary_band", { length: 20 }), // L1, L2, etc.

    // Skills & Bio
    skills: jsonb("skills").$type<string[]>().default([]),
    languages: jsonb("languages").$type<string[]>().default([]),
    bio: text("bio"),

    // Social/Contact
    linkedin: varchar("linkedin", { length: 500 }),
    github: varchar("github", { length: 500 }),
    twitter: varchar("twitter", { length: 500 }),
    website: varchar("website", { length: 500 }),

    // Emergency Contact
    emergencyContact: jsonb("emergency_contact").$type<{
      name: string;
      relationship: string;
      phone: string;
    }>(),

    // Custom fields
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>().default({}),

    // Settings
    isActive: boolean("is_active").default(true).notNull(),
    visibleInDirectory: boolean("visible_in_directory").default(true),

    // Metadata
    source: varchar("source", { length: 50 }).default("manual"), // manual, import, api
    externalId: varchar("external_id", { length: 255 }), // ID from external HR system

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("directory_employees_org_empid_idx").on(t.organizationId, t.employeeId),
    uniqueIndex("directory_employees_email_idx").on(t.email),
    index("directory_employees_org_idx").on(t.organizationId),
    index("directory_employees_dept_idx").on(t.departmentId),
    index("directory_employees_position_idx").on(t.positionId),
    index("directory_employees_manager_idx").on(t.managerId),
    index("directory_employees_status_idx").on(t.status),
    index("directory_employees_active_idx").on(t.isActive),
    index("directory_employees_name_idx").on(t.firstName, t.lastName),
  ]
);

// ═══════════════════════════════════════════════
// Employee Documents
// ═══════════════════════════════════════════════

export const employeeDocuments = pgTable(
  "directory_employee_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .references(() => employees.id, { onDelete: "cascade" })
      .notNull(),

    name: varchar("name", { length: 200 }).notNull(),
    type: varchar("type", { length: 50 }).notNull(), // contract, id, certificate, etc.
    description: text("description"),

    mediaId: uuid("media_id").notNull(), // References media.id

    // Document metadata
    issueDate: date("issue_date"),
    expiryDate: date("expiry_date"),
    documentNumber: varchar("document_number", { length: 100 }),

    isConfidential: boolean("is_confidential").default(false),

    uploadedById: text("uploaded_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("directory_emp_docs_employee_idx").on(t.employeeId),
    index("directory_emp_docs_type_idx").on(t.type),
    index("directory_emp_docs_expiry_idx").on(t.expiryDate),
  ]
);

// ═══════════════════════════════════════════════
// Org Chart Cache (for fast hierarchy queries)
// ═══════════════════════════════════════════════

export const orgChartCache = pgTable(
  "directory_org_chart_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    employeeId: uuid("employee_id")
      .references(() => employees.id, { onDelete: "cascade" })
      .notNull(),

    // Hierarchy path
    path: jsonb("path").$type<string[]>().notNull(), // Array of employee IDs from root to this employee
    level: integer("level").notNull(), // Depth in org chart (0 = CEO)

    // Reporting chain
    directReports: jsonb("direct_reports").$type<string[]>().default([]),
    totalReports: integer("total_reports").default(0), // All descendants

    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("directory_orgchart_org_emp_idx").on(t.organizationId, t.employeeId),
    index("directory_orgchart_org_idx").on(t.organizationId),
    index("directory_orgchart_level_idx").on(t.level),
  ]
);

// ═══════════════════════════════════════════════
// Relations
// ═══════════════════════════════════════════════

export const organizationsRelations = relations(organizations, ({ many }) => ({
  departments: many(departments),
  positions: many(positions),
  employees: many(employees),
}));

export const departmentsRelations = relations(departments, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [departments.organizationId],
    references: [organizations.id],
  }),
  parent: one(departments, {
    fields: [departments.parentDepartmentId],
    references: [departments.id],
  }),
  children: many(departments),
  head: one(employees, {
    fields: [departments.headId],
    references: [employees.id],
  }),
  employees: many(employees),
  positions: many(positions),
}));

export const positionsRelations = relations(positions, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [positions.organizationId],
    references: [organizations.id],
  }),
  department: one(departments, {
    fields: [positions.departmentId],
    references: [departments.id],
  }),
  parent: one(positions, {
    fields: [positions.reportsToPositionId],
    references: [positions.id],
  }),
  employees: many(employees),
}));

export const employeesRelations = relations(employees, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [employees.organizationId],
    references: [organizations.id],
  }),
  department: one(departments, {
    fields: [employees.departmentId],
    references: [departments.id],
  }),
  position: one(positions, {
    fields: [employees.positionId],
    references: [positions.id],
  }),
  manager: one(employees, {
    fields: [employees.managerId],
    references: [employees.id],
  }),
  directReports: many(employees),
  documents: many(employeeDocuments),
}));

export const employeeDocumentsRelations = relations(employeeDocuments, ({ one }) => ({
  employee: one(employees, {
    fields: [employeeDocuments.employeeId],
    references: [employees.id],
  }),
}));

export const orgChartCacheRelations = relations(orgChartCache, ({ one }) => ({
  employee: one(employees, {
    fields: [orgChartCache.employeeId],
    references: [employees.id],
  }),
  organization: one(organizations, {
    fields: [orgChartCache.organizationId],
    references: [organizations.id],
  }),
}));

// ═══════════════════════════════════════════════
// Type Exports
// ═══════════════════════════════════════════════

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type Department = typeof departments.$inferSelect;
export type NewDepartment = typeof departments.$inferInsert;
export type Position = typeof positions.$inferSelect;
export type NewPosition = typeof positions.$inferInsert;
export type Employee = typeof employees.$inferSelect;
export type NewEmployee = typeof employees.$inferInsert;
export type EmployeeDocument = typeof employeeDocuments.$inferSelect;
export type NewEmployeeDocument = typeof employeeDocuments.$inferInsert;
export type OrgChartCache = typeof orgChartCache.$inferSelect;
export type NewOrgChartCache = typeof orgChartCache.$inferInsert;

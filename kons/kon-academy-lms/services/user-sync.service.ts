/**
 * Academy LMS - User Sync Service
 *
 * Service for synchronizing users from external systems.
 * Supports bulk import, validation and role mapping.
 */

import { withSavepoint } from "@kitsuden/engine";
import { z } from "zod";

// ============================================
// TYPES AND ENUMS
// ============================================

export interface ExternalUser {
  externalId: string;
  /**
   * The Kitsuden account this row is for. A kon cannot create accounts or look them up by email,
   * so a sync writes academy profiles of EXISTING accounts: `userId`, or `externalId` when the
   * external system already uses the account id.
   */
  userId?: string;
  /** External role, mapped to an academy role (`roleMapping`, or the academy role itself). */
  role?: string;
  email: string;
  name: string;
  lastName?: string;
  department?: string;
  jobTitle?: string;
  employeeNumber?: string;
  phone?: string;
  active?: boolean;
  metadata?: Record<string, unknown>;
}

export interface SyncResult {
  successful: number;
  failed: number;
  created: number;
  updated: number;
  errors: Array<{
    user: string;
    error: string;
  }>;
}

export interface RoleMapping {
  externalField: string;
  values: Record<string, string>;
  default: string;
}

export interface SyncConfig {
  provider: "csv" | "api" | "ldap" | "saml";
  roleMapping?: RoleMapping;
  createNewUsers?: boolean;
  updateExisting?: boolean;
  deactivateMissing?: boolean;
  emailField?: string;
  nameField?: string;
  departmentField?: string;
  jobTitleField?: string;
}

// ============================================
// VALIDATION SCHEMAS
// ============================================

export const externalUserSchema = z.object({
  externalId: z.string().min(1),
  userId: z.string().min(1).optional(),
  role: z.string().optional(),
  email: z.string().email(),
  name: z.string().min(1),
  lastName: z.string().optional(),
  department: z.string().optional(),
  jobTitle: z.string().optional(),
  employeeNumber: z.string().optional(),
  phone: z.string().optional(),
  active: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const syncConfigSchema = z.object({
  provider: z.enum(["csv", "api", "ldap", "saml"]),
  roleMapping: z
    .object({
      externalField: z.string(),
      values: z.record(z.string(), z.string()),
      default: z.string(),
    })
    .optional(),
  createNewUsers: z.boolean().default(true),
  updateExisting: z.boolean().default(true),
  deactivateMissing: z.boolean().default(false),
  emailField: z.string().default("email"),
  nameField: z.string().default("name"),
  departmentField: z.string().optional(),
  jobTitleField: z.string().optional(),
});

// ============================================
// PREDEFINED MAPPINGS
// ============================================

/**
 * Example role mapping from an HR system's job roles. Each installation defines its own.
 */
export const exampleRoleMapping: RoleMapping = {
  externalField: "role",
  values: {
    Administrator: "administrator",
    Supervisor: "supervisor",
    Assistant: "student",
    Analyst: "student",
    User: "student",
  },
  default: "student",
};

/**
 * Standard department mapping
 */
export const departmentMapping: Record<string, string> = {
  ACCOUNTING: "ACCOUNTING",
  FINANCE: "FINANCE",
  EXECUTIVE: "EXECUTIVE",
  LEGAL: "LEGAL",
  BUSINESS: "BUSINESS",
  OPERATIONS: "OPERATIONS",
  "HUMAN RESOURCES": "HUMAN_RESOURCES",
  TECHNOLOGY: "TECHNOLOGY",
  OTHER: "OTHER",
};

/**
 * Standard position mapping
 */
export const jobTitleMapping: Record<string, string> = {
  Assistant: "Assistant",
  Analyst: "Analyst",
  Professional: "Professional",
  Coordinator: "Coordinator",
  Supervisor: "Supervisor",
  Head: "Head",
  Manager: "Manager",
};

// ============================================
// VALIDATION FUNCTIONS
// ============================================

/**
 * Validates an external user
 */
export function validateExternalUser(
  data: unknown
): { valid: true; user: ExternalUser } | { valid: false; errors: string[] } {
  const result = externalUserSchema.safeParse(data);

  if (result.success) {
    return { valid: true, user: result.data as any as ExternalUser };
  }

  return {
    valid: false,
    errors: result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
  };
}

/**
 * Validates a list of external users
 */
export function validateExternalUsers(data: unknown[]): {
  valid: ExternalUser[];
  invalid: Array<{ index: number; data: unknown; errors: string[] }>;
} {
  const valid: ExternalUser[] = [];
  const invalid: Array<{ index: number; data: unknown; errors: string[] }> = [];

  data.forEach((item, index) => {
    const result = validateExternalUser(item);
    if (result.valid) {
      valid.push(result.user);
    } else {
      invalid.push({ index, data: item, errors: (result as any).errors });
    }
  });

  return { valid, invalid };
}

// ============================================
// MAPPING FUNCTIONS
// ============================================

/**
 * Maps an external role to the internal role
 */
export function mapRole(externalRole: string, mapping: RoleMapping): string {
  const normalizedRole = externalRole.trim();
  return mapping.values[normalizedRole] || mapping.default;
}

/**
 * Maps a department to the internal format
 */
export function mapDepartment(externalDept: string): string | undefined {
  const normalizedDept = externalDept.toUpperCase().trim();
  return departmentMapping[normalizedDept];
}

/**
 * Maps a position to the internal format
 */
export function mapJobTitle(externalJobTitle: string): string | undefined {
  const normalizedJobTitle = externalJobTitle.trim();
  return jobTitleMapping[normalizedJobTitle];
}

/**
 * Normalizes external user data
 */
export function normalizeExternalUser(
  user: ExternalUser,
  config: SyncConfig
): ExternalUser {
  return {
    ...user,
    email: user.email.toLowerCase().trim(),
    name: user.name.trim(),
    lastName: user.lastName?.trim(),
    department: user.department ? mapDepartment(user.department) : undefined,
    jobTitle: user.jobTitle ? mapJobTitle(user.jobTitle) : undefined,
  };
}

// ============================================
// CSV PROCESSING
// ============================================

/**
 * Parses CSV into external users
 * Expected format: externalId,email,name,lastName,department,jobTitle,phone,... (Spanish headers such as `Cargo` and `telefono` are accepted too)
 */
export function parseCsv(csvContent: string): ExternalUser[] {
  const lines = csvContent.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim());
  const users: ExternalUser[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map((v) => v.trim());
    const row: Record<string, string> = {};

    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });

    const user: ExternalUser = {
      externalId: row.externalId || row.id || row.ID || String(i),
      userId: row.userId || row.accountId || undefined,
      role: row.role || row.Role || undefined,
      email: row.email || row.Email || row.EMAIL || "",
      name: row.name || row.Name || "",
      lastName: row.lastName || row.lastname || row.LastName,
      department: row.department || row.Department,
      jobTitle: row.jobTitle || row.position || row.Cargo,
      employeeNumber: row.employeeNumber,
      // A spreadsheet exported in Spanish says `telefono`; it is accepted as a header, like `Cargo`.
      phone: row.phone || row.Phone || row.telefono || row.Telefono,
      active: row.active?.toLowerCase() !== "false",
    };

    users.push(user);
  }

  return users;
}

// ============================================
// SYNCHRONIZATION FUNCTIONS
// ============================================

export type AcademyRoleName = "administrator" | "supervisor" | "student";

const ACADEMY_ROLES: readonly AcademyRoleName[] = ["administrator", "supervisor", "student"];

/** The profile a sync writes for one account. */
export interface SyncedProfile {
  userId: string;
  trainingRole: AcademyRoleName;
  active: boolean;
  notes: string;
}

/** Where a sync reads and writes: the route passes the database and the host's account lookup. */
export interface SyncStore {
  /** Which of these ids are existing accounts (the host's `ctx.auth.usersById`). */
  existingAccounts(userIds: string[]): Promise<Set<string>>;
  /** Whether the account already has an academy profile. */
  hasProfile(userId: string): Promise<boolean>;
  createProfile(profile: SyncedProfile): Promise<void>;
  updateProfile(profile: SyncedProfile): Promise<void>;
}

/**
 * The academy role of an external row: the academy role itself when the row already says one,
 * otherwise `roleMapping` (an installation's own mapping) or `student`.
 */
export function academyRoleFor(user: ExternalUser, config: Partial<SyncConfig>): AcademyRoleName {
  const raw = (
    user.role ??
    (config.roleMapping ? (user.metadata?.[config.roleMapping.externalField] as string) : "") ??
    ""
  ).trim();
  if ((ACADEMY_ROLES as readonly string[]).includes(raw)) return raw as AcademyRoleName;
  if (config.roleMapping) {
    const mapped = mapRole(raw, config.roleMapping);
    if ((ACADEMY_ROLES as readonly string[]).includes(mapped)) return mapped as AcademyRoleName;
  }
  return "student";
}

/**
 * Writes the academy profiles of external users.
 *
 * Each row names an EXISTING account (`userId`, or `externalId`); a kon cannot create accounts,
 * so a row whose account does not exist fails with that reason and writes nothing. For an account
 * without a profile it creates one (unless `createNewUsers: false`); for one with a profile it
 * sets the role, active flag and notes (unless `updateExisting: false`). Each row runs in its own
 * SAVEPOINT, so one failure does not undo the others. `deactivateMissing` is not applied.
 */
export async function syncUsers(
  users: ExternalUser[],
  config: Partial<SyncConfig>,
  store: SyncStore
): Promise<SyncResult> {
  const result: SyncResult = {
    successful: 0,
    failed: 0,
    created: 0,
    updated: 0,
    errors: [],
  };

  const accountOf = (u: ExternalUser) => (u.userId ?? u.externalId).trim();
  const existing = await store.existingAccounts([...new Set(users.map(accountOf))]);
  const stamp = new Date().toISOString();

  for (const user of users) {
    const label = user.email || user.externalId;
    try {
      const validation = validateExternalUser(user);
      if (!validation.valid) {
        result.failed++;
        result.errors.push({
          user: label,
          error: `Validation failed: ${(validation as { errors: string[] }).errors.join(", ")}`,
        });
        continue;
      }
      const userId = accountOf(user);
      if (!existing.has(userId)) {
        result.failed++;
        result.errors.push({ user: label, error: `No account with id ${userId}` });
        continue;
      }
      const profile: SyncedProfile = {
        userId,
        trainingRole: academyRoleFor(user, config),
        active: user.active !== false,
        notes: `Synced from ${user.externalId}: ${stamp}`,
      };

      const done = await withSavepoint(async (): Promise<"created" | "updated" | null> => {
        if (await store.hasProfile(userId)) {
          if (config.updateExisting === false) return null;
          await store.updateProfile(profile);
          return "updated";
        }
        if (config.createNewUsers === false) return null;
        await store.createProfile(profile);
        return "created";
      });
      if (done === "created") result.created++;
      if (done === "updated") result.updated++;
      result.successful++;
    } catch (error) {
      result.failed++;
      result.errors.push({
        user: label,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return result;
}

// ============================================
// UTILITIES
// ============================================

/**
 * Generates a synchronization summary
 */
export function generateSyncSummary(result: SyncResult): string {
  return `
Synchronization completed:
- Total processed: ${result.successful + result.failed}
- Successful: ${result.successful}
- Failed: ${result.failed}
- Users created: ${result.created}
- Users updated: ${result.updated}
${
  result.errors.length > 0
    ? `
Errors:
${result.errors
  .slice(0, 10)
  .map((e) => `  - ${e.user}: ${e.error}`)
  .join("\n")}
${result.errors.length > 10 ? `  ... and ${result.errors.length - 10} more errors` : ""}
`
    : ""
}
  `.trim();
}

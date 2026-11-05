/**
 * Kon Agile — Project Management Schema
 *
 * Professional agile management system with:
 * - Projects: Work containers
 * - States: Per-project customizable states (Kanban columns)
 * - Issues: Work items with a unique key (PROJ-123)
 * - Cycles: Sprints that measure TIME
 * - Modules: Epics that measure SCOPE
 * - Intakes: Inbox for AI triage
 *
 * Dependency order:
 * 1. agile_projects (base)
 * 2. agile_states (depends on projects)
 * 3. agile_cycles (depends on projects)
 * 4. agile_modules (depends on projects)
 * 5. agile_estimates (depends on projects)
 * 6. agile_labels (depends on projects)
 * 7. agile_issues (depends on projects, states, cycles, modules)
 * 8. agile_module_issues (depends on modules, issues)
 * 9. agile_issue_labels (depends on issues, labels)
 * 10. agile_issue_links (depends on issues)
 * 11. agile_intakes (depends on projects, optionally issues)
 * 12. agile_comments (depends on issues)
 * 13. agile_activity_log (depends on projects, issues)
 *
 * @version 1.0.0
 */

import { relations } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  pgEnum,
  uniqueIndex,
  jsonb,
  numeric,
} from "drizzle-orm/pg-core";

// ═══════════════════════════════════════════════════════════════════════════════
// ENUMS
// ═══════════════════════════════════════════════════════════════════════════════

export const issueTypeEnum = pgEnum("agile_issue_type", [
  "issue",
  "feature",
  "bug",
  "improvement",
  "epic",
  "sub_issue",
  "spike",
]);

export const issuePriorityEnum = pgEnum("agile_issue_priority", [
  "urgent",
  "high",
  "medium",
  "low",
]);

export const cycleStatusEnum = pgEnum("agile_cycle_status", [
  "draft",
  "started",
  "completed",
  "cancelled",
]);

export const moduleStatusEnum = pgEnum("agile_module_status", [
  "backlog",
  "planned",
  "in_progress",
  "paused",
  "completed",
  "cancelled",
]);

export const intakeStatusEnum = pgEnum("agile_intake_status", [
  "pending",
  "accepted",
  "declined",
  "duplicate",
  "spam",
]);

export const linkTypeEnum = pgEnum("agile_link_type", [
  "blocks",
  "blocked_by",
  "relates_to",
  "duplicates",
  "duplicate_of",
  "parent_of",
  "child_of",
]);

export const estimateTypeEnum = pgEnum("agile_estimate_type", [
  "fibonacci",
  "linear",
  "tshirt",
  "days",
  "points",
]);

export const stateGroupEnum = pgEnum("agile_state_group", [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "cancelled",
]);

// ═══════════════════════════════════════════════════════════════════════════════
// 1. AGILE_PROJECTS (Base - No dependencies)
// ═══════════════════════════════════════════════════════════════════════════════

export const agileProjects = pgTable(
  "agile_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Identification
    name: text("name").notNull(),
    identifier: text("identifier").notNull().unique(), // E.g. "PROJ" for PROJ-123 keys
    description: text("description"),

    // Status
    isArchived: boolean("is_archived").default(false),

    // Leadership (flexible text references, not strict FK)
    leadId: text("lead_id"), // Reference to user/agent
    defaultAssigneeId: text("default_assignee_id"),

    // Visual
    emoji: text("emoji").default("📁"),
    color: text("color").default("#6366f1"),

    // Counter to auto-generate issue keys
    keyCounter: integer("key_counter").default(0),

    // Media - Cover Image (reference to kon-media)
    coverImageId: uuid("cover_image_id"),

    // Configuration
    config: jsonb("config")
      .$type<{
        estimateType?: string;
        timezone?: string;
        weekStartDay?: number;
        /** state id → user id: entering that state assigns the issue to that user */
        autoAssign?: Record<string, string>;
        /** closed issues are archived this many days after closing */
        autoArchiveDays?: number;
        /** a cycle whose end date passed is closed and its unfinished issues move to the next one */
        autoCloseCycles?: boolean;
      }>()
      .default({}),

    // Metadata
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: text("created_by"),
  },
  (t) => [uniqueIndex("agile_projects_identifier_idx").on(t.identifier)]
);

// ═══════════════════════════════════════════════════════════════════════════════
// 1b. AGILE_PROJECT_MEMBERS (Depends on agile_projects)
// Who sees and who works on each project. Without a row here (and without being the one who
// created the project, or admin) a project does NOT exist for that account: sign-up
// is public and "having a session" cannot mean "seeing all the boards".
//   owner  → manages members and everything else
//   member → creates and edits issues, cycles, modules; decides intakes
//   viewer → reads and can propose intakes
// ═══════════════════════════════════════════════════════════════════════════════

export const PROJECT_ROLES = ["owner", "member", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const agileProjectMembers = pgTable(
  "agile_project_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .references(() => agileProjects.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id").notNull(),
    role: text("role").$type<ProjectRole>().default("member").notNull(),
    // An agent (agent_identities.id) rather than a person: work assigned to it is queued (0005)
    isAgent: boolean("is_agent").default(false).notNull(),
    addedBy: text("added_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("agile_project_members_project_user_idx").on(t.projectId, t.userId)]
);

// ═══════════════════════════════════════════════════════════════════════════════
// 2. AGILE_STATES (Depends on agile_projects)
// Per-project customizable states - Kanban columns
// ═══════════════════════════════════════════════════════════════════════════════

export const agileStates = pgTable(
  "agile_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .references(() => agileProjects.id, { onDelete: "cascade" })
      .notNull(),

    // Identification
    name: text("name").notNull(), // E.g. "In Progress", "Code Review"
    description: text("description"),

    // Logical group for UI and reports
    group: stateGroupEnum("group").notNull(),

    // Visual
    color: text("color").default("#94a3b8"),

    // Position on the board
    sequence: integer("sequence").default(0),

    // Behavior
    isDefault: boolean("is_default").default(false), // Initial state for new issues
    isCompleted: boolean("is_completed").default(false),
    isCancelled: boolean("is_cancelled").default(false),

    // Validations on entering this state
    validations: jsonb("validations")
      .$type<{
        requireAssignee?: boolean;
        requireEstimate?: boolean;
        requireDescription?: boolean;
      }>()
      .default({}),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("agile_states_project_sequence_idx").on(t.projectId, t.sequence)]
);

// ═══════════════════════════════════════════════════════════════════════════════
// 3. AGILE_CYCLES (Depends on agile_projects)
// Sprints - Measure TIME ("What we will do this week")
// ═══════════════════════════════════════════════════════════════════════════════

export const agileCycles = pgTable("agile_cycles", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .references(() => agileProjects.id, { onDelete: "cascade" })
    .notNull(),

  // Identification
  name: text("name").notNull(), // Ej: "Cycle 12", "Sprint 3"
  description: text("description"),

  // Dates
  startDate: timestamp("start_date", { withTimezone: true }).notNull(),
  endDate: timestamp("end_date", { withTimezone: true }).notNull(),

  // Status
  status: cycleStatusEnum("status").default("draft").notNull(),

  // Cycle goal
  goal: text("goal"),

  // Team capacity (optional)
  capacity: integer("capacity"),

  // Computed metrics
  stats: jsonb("stats")
    .$type<{
      totalIssues?: number;
      completedIssues?: number;
      cancelledIssues?: number;
      totalEstimate?: number;
      completedEstimate?: number;
      velocity?: number;
    }>()
    .default({}),

  // Active cycle (only one per project)
  isActive: boolean("is_active").default(false),

  // Closing (migration 0005): when, and which cycle took the unfinished issues
  completedAt: timestamp("completed_at", { withTimezone: true }),
  carriedOverToId: uuid("carried_over_to_id"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: text("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. AGILE_MODULES (Depends on agile_projects)
// Epics/Modules - Measure SCOPE ("Launch Login" - can take several Cycles)
// ═══════════════════════════════════════════════════════════════════════════════

export const agileModules = pgTable("agile_modules", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .references(() => agileProjects.id, { onDelete: "cascade" })
    .notNull(),
  leadId: text("lead_id"),

  // Identification
  name: text("name").notNull(),
  description: text("description"),

  // Module state
  status: moduleStatusEnum("status").default("backlog").notNull(),

  // Dates
  startDate: timestamp("start_date", { withTimezone: true }),
  targetDate: timestamp("target_date", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),

  // Visual
  color: text("color").default("#6366f1"),

  // Metrics
  stats: jsonb("stats")
    .$type<{
      totalIssues?: number;
      completedIssues?: number;
      progress?: number;
    }>()
    .default({ progress: 0 }),

  // Hierarchy (nested modules)
  parentId: uuid("parent_id"),

  // Initiative it serves (migration 0005)
  initiativeId: uuid("initiative_id"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: text("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. AGILE_ESTIMATES (Depends on agile_projects)
// Per-project configurable estimation system
// ═══════════════════════════════════════════════════════════════════════════════

export const agileEstimates = pgTable("agile_estimates", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .references(() => agileProjects.id, { onDelete: "cascade" })
    .notNull(),

  // Configuration
  type: estimateTypeEnum("type").notNull(),
  name: text("name").notNull(), // "Story Points", "T-shirt Sizes"

  // Custom points for 'points' type
  customPoints: jsonb("custom_points").$type<
    Array<{
      value: number;
      label: string;
      color?: string;
    }>
  >(),

  isDefault: boolean("is_default").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. AGILE_LABELS (Depends on agile_projects)
// ═══════════════════════════════════════════════════════════════════════════════

export const agileLabels = pgTable(
  "agile_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .references(() => agileProjects.id, { onDelete: "cascade" })
      .notNull(),

    name: text("name").notNull(),
    description: text("description"),
    color: text("color").default("#6366f1"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("agile_labels_project_name_idx").on(t.projectId, t.name)]
);

// ═══════════════════════════════════════════════════════════════════════════════
// 7. AGILE_ISSUES (Depends on agile_projects, agile_states, agile_cycles, agile_modules)
// Main work items
// ═══════════════════════════════════════════════════════════════════════════════

export const agileIssues = pgTable(
  "agile_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Unique key (PROJ-123)
    key: text("key").notNull(),

    // Content
    name: text("name").notNull(), // Title
    descriptionHtml: text("description_html"),
    descriptionText: text("description_text"), // For search

    // Classification
    type: issueTypeEnum("type").default("issue").notNull(),
    priority: issuePriorityEnum("priority").default("medium").notNull(),

    // Hierarchical relations
    projectId: uuid("project_id")
      .references(() => agileProjects.id, { onDelete: "cascade" })
      .notNull(),
    parentId: uuid("parent_id"), // For sub-issues (self-reference)

    // Assignment (flexible text references)
    assigneeId: text("assignee_id"), // Can be a user id or an agent id
    createdBy: text("created_by").notNull(),

    // State (FK to agile_states)
    stateId: uuid("state_id")
      .references(() => agileStates.id, { onDelete: "restrict" })
      .notNull(),

    // TIME: Current Cycle/Sprint
    cycleId: uuid("cycle_id").references(() => agileCycles.id, { onDelete: "set null" }),

    // SCOPE: Module it belongs to
    moduleId: uuid("module_id").references(() => agileModules.id, { onDelete: "set null" }),

    // Position
    sequence: integer("sequence").default(0),
    sortOrder: integer("sort_order").default(0),

    // Estimate
    estimate: integer("estimate"),

    // Time tracking
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),

    // Planned dates
    targetDate: timestamp("target_date", { withTimezone: true }),

    // Archived (by hand, or by the project's auto-archive); archived issues leave the board
    archivedAt: timestamp("archived_at", { withTimezone: true }),

    // Initiative it serves (migration 0005)
    initiativeId: uuid("initiative_id"),

    // Metadata extensible
    props: jsonb("props")
      .$type<{
        component?: string;
        affectedVersion?: string;
        fixVersion?: string;
        environment?: string;
        source?: string;
        customFields?: Record<string, unknown>;
      }>()
      .default({}),

    // Flags
    isDraft: boolean("is_draft").default(false),
    isSubIssue: boolean("is_sub_issue").default(false),

    // Counters (performance)
    subIssuesCount: integer("sub_issues_count").default(0),
    commentsCount: integer("comments_count").default(0),
    attachmentsCount: integer("attachments_count").default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("agile_issues_key_idx").on(t.key),
    uniqueIndex("agile_issues_project_sequence_idx").on(t.projectId, t.sequence),
  ]
);

// ═══════════════════════════════════════════════════════════════════════════════
// 8. AGILE_MODULE_ISSUES (Junction - Depends on agile_modules and agile_issues)
// Many-to-many relation between modules and issues
// ═══════════════════════════════════════════════════════════════════════════════

export const agileModuleIssues = pgTable(
  "agile_module_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    moduleId: uuid("module_id")
      .references(() => agileModules.id, { onDelete: "cascade" })
      .notNull(),
    issueId: uuid("issue_id")
      .references(() => agileIssues.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("agile_module_issues_unique_idx").on(t.moduleId, t.issueId)]
);

// ═══════════════════════════════════════════════════════════════════════════════
// 9. AGILE_ISSUE_LABELS (Junction - Depends on agile_issues and agile_labels)
// ═══════════════════════════════════════════════════════════════════════════════

export const agileIssueLabels = pgTable(
  "agile_issue_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .references(() => agileIssues.id, { onDelete: "cascade" })
      .notNull(),
    labelId: uuid("label_id")
      .references(() => agileLabels.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("agile_issue_labels_unique_idx").on(t.issueId, t.labelId)]
);

// ═══════════════════════════════════════════════════════════════════════════════
// 10. AGILE_ISSUE_LINKS (Depends on agile_issues - Self-reference)
// Links between issues
// ═══════════════════════════════════════════════════════════════════════════════

export const agileIssueLinks = pgTable(
  "agile_issue_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .references(() => agileIssues.id, { onDelete: "cascade" })
      .notNull(),
    targetId: uuid("target_id")
      .references(() => agileIssues.id, { onDelete: "cascade" })
      .notNull(),
    linkType: linkTypeEnum("link_type").notNull(),
    relation: text("relation"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: text("created_by"),
  },
  (t) => [uniqueIndex("agile_issue_links_unique_idx").on(t.sourceId, t.targetId, t.linkType)]
);

// ═══════════════════════════════════════════════════════════════════════════════
// 11. AGILE_INTAKES (Depends on agile_projects - Optionally issues)
// Inbox for triage - KILLER FEATURE FOR AI
// ═══════════════════════════════════════════════════════════════════════════════

export const agileIntakes = pgTable("agile_intakes", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .references(() => agileProjects.id, { onDelete: "cascade" })
    .notNull(),

  // Content
  title: text("title").notNull(),
  description: text("description"),

  // Creator's suggestions (AI or external)
  suggestedType: issueTypeEnum("suggested_type"),
  suggestedPriority: issuePriorityEnum("suggested_priority"),
  suggestedStateId: uuid("suggested_state_id").references(() => agileStates.id, {
    onDelete: "set null",
  }),

  // Origin
  source: text("source").notNull(), // 'api', 'slack', 'email', 'form', 'ai_agent'
  sourceData: jsonb("source_data")
    .$type<{
      slackChannel?: string;
      slackUser?: string;
      emailFrom?: string;
      aiAgentId?: string;
      aiPrompt?: string;
      confidence?: number;
    }>()
    .default({}),

  // Triage state
  status: intakeStatusEnum("status").default("pending").notNull(),

  // Decision
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionReason: text("decision_reason"),

  // If it was accepted
  createdIssueId: uuid("created_issue_id").references(() => agileIssues.id, {
    onDelete: "set null",
  }),
  createdIssueKey: text("created_issue_key"),

  // If it was a duplicate
  duplicateOfId: uuid("duplicate_of_id"),

  // Creator (can be anonymous or external)
  createdBy: text("created_by"),
  createdByEmail: text("created_by_email"),
  createdByName: text("created_by_name"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. AGILE_COMMENTS (Depends on agile_issues)
// ═══════════════════════════════════════════════════════════════════════════════

export const agileComments = pgTable("agile_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id")
    .references(() => agileIssues.id, { onDelete: "cascade" })
    .notNull(),

  // Content
  contentHtml: text("content_html").notNull(),
  contentText: text("content_text"),

  // Author (flexible reference)
  createdBy: text("created_by").notNull(),

  // Editing
  isEdited: boolean("is_edited").default(false),
  editedAt: timestamp("edited_at", { withTimezone: true }),

  // Threading (replies)
  parentId: uuid("parent_id"),

  // Reactions
  reactions: jsonb("reactions").$type<Record<string, string[]>>().default({}),

  // Access
  access: text("access").default("public"), // 'public', 'internal'

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. AGILE_ACTIVITY_LOG (Depends on agile_projects, agile_issues)
// Full audit of changes
// ═══════════════════════════════════════════════════════════════════════════════

export const agileActivityLog = pgTable("agile_activity_log", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Actor
  actorId: text("actor_id").notNull(),

  // Affected object (polymorphic)
  entityType: text("entity_type").notNull(), // 'issue', 'project', 'cycle', 'module', 'intake'
  entityId: uuid("entity_id").notNull(),

  // Action
  action: text("action").notNull(), // 'created', 'updated', 'deleted', 'state_changed'

  // Specific changes
  field: text("field"),
  oldValue: jsonb("old_value"),
  newValue: jsonb("new_value"),

  // Readable description
  description: text("description"),

  // Metadata
  metadata: jsonb("metadata").default({}),

  // Optional references for fast queries
  projectId: uuid("project_id").references(() => agileProjects.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").references(() => agileIssues.id, { onDelete: "cascade" }),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. SQUADS (migration 0005)
// A team inside a project. Its scrum master (a person or an agent) may act on the issues of the
// squad's members; an agent outside that role writes only on its own issues.
// ═══════════════════════════════════════════════════════════════════════════════

export const agileSquads = pgTable(
  "agile_squads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .references(() => agileProjects.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    scrumMasterId: text("scrum_master_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("agile_squads_project_name_idx").on(t.projectId, t.name)]
);

export const agileSquadMembers = pgTable(
  "agile_squad_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    squadId: uuid("squad_id")
      .references(() => agileSquads.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id").notNull(),
    addedBy: text("added_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("agile_squad_members_unique_idx").on(t.squadId, t.userId)]
);

// ═══════════════════════════════════════════════════════════════════════════════
// 15. INITIATIVES — a goal with a target date that groups issues and modules
// ═══════════════════════════════════════════════════════════════════════════════

export const INITIATIVE_STATUSES = ["planned", "active", "completed", "cancelled"] as const;

export const agileInitiatives = pgTable("agile_initiatives", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .references(() => agileProjects.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").$type<(typeof INITIATIVE_STATUSES)[number]>().default("planned").notNull(),
  leadId: text("lead_id"),
  color: text("color").default("#6366f1"),
  startDate: timestamp("start_date", { withTimezone: true }),
  targetDate: timestamp("target_date", { withTimezone: true }),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// 16. CHECKLIST ITEMS — steps inside one issue (not sub-issues)
// ═══════════════════════════════════════════════════════════════════════════════

export const agileChecklistItems = pgTable("agile_checklist_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id")
    .references(() => agileIssues.id, { onDelete: "cascade" })
    .notNull(),
  text: text("text").notNull(),
  isDone: boolean("is_done").default(false).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  doneBy: text("done_by"),
  doneAt: timestamp("done_at", { withTimezone: true }),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// 17. CUSTOM FIELDS — per project; values live in `agile_issues.props.customFields[key]`
// ═══════════════════════════════════════════════════════════════════════════════

export const CUSTOM_FIELD_TYPES = [
  "text",
  "number",
  "date",
  "select",
  "multi_select",
  "checkbox",
  "user",
  "url",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const agileCustomFields = pgTable(
  "agile_custom_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .references(() => agileProjects.id, { onDelete: "cascade" })
      .notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    type: text("type").$type<CustomFieldType>().notNull(),
    options: jsonb("options").$type<string[]>().default([]).notNull(),
    isRequired: boolean("is_required").default(false).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("agile_custom_fields_project_key_idx").on(t.projectId, t.key)]
);

// ═══════════════════════════════════════════════════════════════════════════════
// 18. SAVED VIEWS — filters, grouping and layout, private or shared with the project
// ═══════════════════════════════════════════════════════════════════════════════

export const VIEW_LAYOUTS = ["board", "table", "calendar", "timeline"] as const;

export const agileSavedViews = pgTable("agile_saved_views", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .references(() => agileProjects.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  layout: text("layout").$type<(typeof VIEW_LAYOUTS)[number]>().default("board").notNull(),
  filters: jsonb("filters").$type<Record<string, unknown>>().default({}).notNull(),
  groupBy: text("group_by"),
  subGroupBy: text("sub_group_by"),
  display: jsonb("display").$type<Record<string, unknown>>().default({}).notNull(),
  isShared: boolean("is_shared").default(false).notNull(),
  ownerId: text("owner_id").notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// 19. NOTIFICATIONS — the inbox of each person or agent
// ═══════════════════════════════════════════════════════════════════════════════

export const NOTIFICATION_KINDS = ["mention", "assigned", "handoff", "agent_work"] as const;

export const agileNotifications = pgTable("agile_notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .references(() => agileProjects.id, { onDelete: "cascade" })
    .notNull(),
  issueId: uuid("issue_id").references(() => agileIssues.id, { onDelete: "cascade" }),
  commentId: uuid("comment_id").references(() => agileComments.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  actorId: text("actor_id"),
  kind: text("kind").$type<(typeof NOTIFICATION_KINDS)[number]>().notNull(),
  message: text("message"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// 20. AGENT WORK — what an agent was asked to do, why, and what it cost
// ═══════════════════════════════════════════════════════════════════════════════

export const WORK_TRIGGERS = ["assigned", "mention", "handoff", "schedule", "manual"] as const;
export const WORK_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;

export const agileAgentSchedules = pgTable("agile_agent_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .references(() => agileProjects.id, { onDelete: "cascade" })
    .notNull(),
  agentId: text("agent_id").notNull(),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  intervalMinutes: integer("interval_minutes").notNull(),
  filters: jsonb("filters").$type<Record<string, unknown>>().default({}).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const agileAgentWork = pgTable("agile_agent_work", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .references(() => agileProjects.id, { onDelete: "cascade" })
    .notNull(),
  issueId: uuid("issue_id").references(() => agileIssues.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull(),
  trigger: text("trigger").$type<(typeof WORK_TRIGGERS)[number]>().notNull(),
  status: text("status").$type<(typeof WORK_STATUSES)[number]>().default("queued").notNull(),
  prompt: text("prompt"),
  requestedBy: text("requested_by"),
  scheduleId: uuid("schedule_id").references(() => agileAgentSchedules.id, {
    onDelete: "set null",
  }),
  runId: text("run_id"),
  result: text("result"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// RELATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const agileProjectsRelations = relations(agileProjects, ({ many }) => ({
  states: many(agileStates),
  issues: many(agileIssues),
  cycles: many(agileCycles),
  modules: many(agileModules),
  labels: many(agileLabels),
  estimates: many(agileEstimates),
  intakes: many(agileIntakes),
  activityLogs: many(agileActivityLog),
}));

export const agileStatesRelations = relations(agileStates, ({ one, many }) => ({
  project: one(agileProjects, {
    fields: [agileStates.projectId],
    references: [agileProjects.id],
  }),
  issues: many(agileIssues),
}));

export const agileCyclesRelations = relations(agileCycles, ({ one, many }) => ({
  project: one(agileProjects, {
    fields: [agileCycles.projectId],
    references: [agileProjects.id],
  }),
  issues: many(agileIssues),
}));

export const agileModulesRelations = relations(agileModules, ({ one, many }) => ({
  project: one(agileProjects, {
    fields: [agileModules.projectId],
    references: [agileProjects.id],
  }),
  parent: one(agileModules, {
    fields: [agileModules.parentId],
    references: [agileModules.id],
    relationName: "subModules",
  }),
  subModules: many(agileModules, { relationName: "subModules" }),
  moduleIssues: many(agileModuleIssues),
  issues: many(agileIssues),
}));

export const agileIssuesRelations = relations(agileIssues, ({ one, many }) => ({
  project: one(agileProjects, {
    fields: [agileIssues.projectId],
    references: [agileProjects.id],
  }),
  state: one(agileStates, {
    fields: [agileIssues.stateId],
    references: [agileStates.id],
  }),
  cycle: one(agileCycles, {
    fields: [agileIssues.cycleId],
    references: [agileCycles.id],
  }),
  module: one(agileModules, {
    fields: [agileIssues.moduleId],
    references: [agileModules.id],
  }),
  parent: one(agileIssues, {
    fields: [agileIssues.parentId],
    references: [agileIssues.id],
    relationName: "subIssues",
  }),
  subIssues: many(agileIssues, { relationName: "subIssues" }),
  comments: many(agileComments),
  outgoingLinks: many(agileIssueLinks, { relationName: "source" }),
  incomingLinks: many(agileIssueLinks, { relationName: "target" }),
  activityLogs: many(agileActivityLog),
}));

export const agileModuleIssuesRelations = relations(agileModuleIssues, ({ one }) => ({
  module: one(agileModules, {
    fields: [agileModuleIssues.moduleId],
    references: [agileModules.id],
  }),
  issue: one(agileIssues, {
    fields: [agileModuleIssues.issueId],
    references: [agileIssues.id],
  }),
}));

export const agileLabelsRelations = relations(agileLabels, ({ one, many }) => ({
  project: one(agileProjects, {
    fields: [agileLabels.projectId],
    references: [agileProjects.id],
  }),
  issueLabels: many(agileIssueLabels),
}));

export const agileIssueLabelsRelations = relations(agileIssueLabels, ({ one }) => ({
  issue: one(agileIssues, {
    fields: [agileIssueLabels.issueId],
    references: [agileIssues.id],
  }),
  label: one(agileLabels, {
    fields: [agileIssueLabels.labelId],
    references: [agileLabels.id],
  }),
}));

export const agileIssueLinksRelations = relations(agileIssueLinks, ({ one }) => ({
  source: one(agileIssues, {
    fields: [agileIssueLinks.sourceId],
    references: [agileIssues.id],
    relationName: "source",
  }),
  target: one(agileIssues, {
    fields: [agileIssueLinks.targetId],
    references: [agileIssues.id],
    relationName: "target",
  }),
}));

export const agileIntakesRelations = relations(agileIntakes, ({ one }) => ({
  project: one(agileProjects, {
    fields: [agileIntakes.projectId],
    references: [agileProjects.id],
  }),
  suggestedState: one(agileStates, {
    fields: [agileIntakes.suggestedStateId],
    references: [agileStates.id],
  }),
  createdIssue: one(agileIssues, {
    fields: [agileIntakes.createdIssueId],
    references: [agileIssues.id],
  }),
}));

export const agileCommentsRelations = relations(agileComments, ({ one }) => ({
  issue: one(agileIssues, {
    fields: [agileComments.issueId],
    references: [agileIssues.id],
  }),
}));

export const agileActivityLogRelations = relations(agileActivityLog, ({ one }) => ({
  project: one(agileProjects, {
    fields: [agileActivityLog.projectId],
    references: [agileProjects.id],
  }),
  issue: one(agileIssues, {
    fields: [agileActivityLog.issueId],
    references: [agileIssues.id],
  }),
}));

// ═══════════════════════════════════════════════════════════════════════════════
// TYPESCRIPT TYPES (Export)
// ═══════════════════════════════════════════════════════════════════════════════

export type AgileProject = typeof agileProjects.$inferSelect;
export type AgileProjectMember = typeof agileProjectMembers.$inferSelect;
export type NewAgileProject = typeof agileProjects.$inferInsert;

export type AgileState = typeof agileStates.$inferSelect;
export type NewAgileState = typeof agileStates.$inferInsert;

export type AgileIssue = typeof agileIssues.$inferSelect;
export type NewAgileIssue = typeof agileIssues.$inferInsert;

export type AgileCycle = typeof agileCycles.$inferSelect;
export type NewAgileCycle = typeof agileCycles.$inferInsert;

export type AgileModule = typeof agileModules.$inferSelect;
export type NewAgileModule = typeof agileModules.$inferInsert;

export type AgileIntake = typeof agileIntakes.$inferSelect;
export type NewAgileIntake = typeof agileIntakes.$inferInsert;

export type AgileComment = typeof agileComments.$inferSelect;
export type NewAgileComment = typeof agileComments.$inferInsert;

export type AgileLabel = typeof agileLabels.$inferSelect;
export type NewAgileLabel = typeof agileLabels.$inferInsert;

export type AgileEstimate = typeof agileEstimates.$inferSelect;
export type NewAgileEstimate = typeof agileEstimates.$inferInsert;

export type AgileIssueLink = typeof agileIssueLinks.$inferSelect;
export type NewAgileIssueLink = typeof agileIssueLinks.$inferInsert;

export type AgileActivityLog = typeof agileActivityLog.$inferSelect;
export type NewAgileActivityLog = typeof agileActivityLog.$inferInsert;

export type AgileSquad = typeof agileSquads.$inferSelect;
export type AgileSquadMember = typeof agileSquadMembers.$inferSelect;
export type AgileInitiative = typeof agileInitiatives.$inferSelect;
export type AgileChecklistItem = typeof agileChecklistItems.$inferSelect;
export type AgileCustomField = typeof agileCustomFields.$inferSelect;
export type AgileSavedView = typeof agileSavedViews.$inferSelect;
export type AgileNotification = typeof agileNotifications.$inferSelect;
export type AgileAgentSchedule = typeof agileAgentSchedules.$inferSelect;
export type AgileAgentWork = typeof agileAgentWork.$inferSelect;

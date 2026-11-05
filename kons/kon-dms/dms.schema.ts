/**
 * Kitsuden DMS - Document Management System Schema
 *
 * Versioned document storage with hierarchical categories,
 * approval workflows, and comprehensive audit trail.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ═══════════════════════════════════════════════════════════════════════════
// ENUMS
// ═══════════════════════════════════════════════════════════════════════════

export const documentTypeEnum = pgEnum("dms_document_type", [
  "manual", // User manuals/procedures
  "policy", // Corporate policies
  "procedure", // Procedimientos operativos
  "template", // Templates
  "guide", // Quick guides
  "training", // Training material
  "report", // Technical reports
  "other", // Others
]);

export const documentStatusEnum = pgEnum("dms_document_status", [
  "draft", // Draft - visible only to the creator
  "in_review", // In review - visible to reviewers
  "approved", // Approved - ready to publish
  "published", // Published - visible to everyone
  "archived", // Archived - historical
  "deprecated", // Obsolete - replaced by new version
]);

export const versionStatusEnum = pgEnum("dms_version_status", [
  "draft",
  "review_pending", // Pending review
  "changes_requested", // Changes requested
  "approved", // Approved
  "published", // Published (immutable)
  "rejected", // Rejected
]);

export const changeTypeEnum = pgEnum("dms_change_type", [
  "major", // Major change (2.0.0) - incompatible
  "minor", // Minor change (1.1.0) - new functionality
  "patch", // Patch (1.0.1) - fix
]);

// ═══════════════════════════════════════════════════════════════════════════
// TABLES
// ═══════════════════════════════════════════════════════════════════════════

// User ids are `text`, not `uuid`: `auth_users.id` is text
// (better-auth). See migrations/0005_user_ids_and_rls.sql.

/**
 * Hierarchical categories to organize documents
 * E.g.: IT > Software > CRM > Manuals
 */
export const dmsCategories = pgTable(
  "dms_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 255 }).notNull(),
    description: text("description"),
    icon: varchar("icon", { length: 50 }).default("Folder"),
    color: varchar("color", { length: 7 }).default("#6366f1"),

    // Hierarchy
    parentId: uuid("parent_id").references((): AnyPgColumn => dmsCategories.id, {
      onDelete: "set null",
    }),
    level: integer("level").default(0).notNull(), // 0 = root, 1 = subcategory, etc.
    path: varchar("path", { length: 1000 }).default("").notNull(), // Path materializado "root/sub/sub2"

    // Category metadata (required fields depending on type)
    metadataSchema: jsonb("metadata_schema").default({}).notNull(), // { fields: [{name, type, required}] }

    // ACL
    allowedRoles: jsonb("allowed_roles").default([]).notNull(), // ["admin", "manager"]
    departmentId: uuid("department_id"), // If it is assigned to a specific department

    // Ordering
    sortOrder: integer("sort_order").default(0),

    // Counters
    documentCount: integer("document_count").default(0),

    // Status
    isActive: boolean("is_active").default(true).notNull(),

    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdById: text("created_by_id"),
  },
  (table) => ({
    slugIdx: uniqueIndex("dms_categories_slug_idx").on(table.slug),
    parentIdx: index("dms_categories_parent_idx").on(table.parentId),
    pathIdx: index("dms_categories_path_idx").on(table.path),
    levelIdx: index("dms_categories_level_idx").on(table.level),
  })
);

/**
 * Documents - Main metadata
 */
export const dmsDocuments = pgTable(
  "dms_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Identification
    code: varchar("code", { length: 100 }).notNull(), // Unique code: MAN-IT-001
    title: varchar("title", { length: 500 }).notNull(),
    slug: varchar("slug", { length: 500 }).notNull(),
    description: text("description"),

    // Classification
    type: documentTypeEnum("type").default("manual").notNull(),
    categoryId: uuid("category_id").references(() => dmsCategories.id, { onDelete: "set null" }),
    tags: jsonb("tags").default([]).notNull(), // ["urgente", "cliente-a", "iso9001"]

    // Versionado
    currentVersionId: uuid("current_version_id"), // Reference to the active version
    currentVersionNumber: varchar("current_version_number", { length: 20 }).default("0.0.0"),
    nextVersionNumber: varchar("next_version_number", { length: 20 }).default("1.0.0"),

    // Document state
    status: documentStatusEnum("status").default("draft").notNull(),

    // Approval workflow
    ownerId: text("owner_id").notNull(), // Person responsible for the document
    reviewerIds: jsonb("reviewer_ids").default([]).notNull(), // IDs of assigned reviewers
    approverIds: jsonb("approver_ids").default([]).notNull(), // IDs of approvers

    // ACL
    visibility: varchar("visibility", { length: 20 }).default("restricted").notNull(), // public, restricted, private
    allowedUserIds: jsonb("allowed_user_ids").default([]).notNull(),
    allowedRoleIds: jsonb("allowed_role_ids").default([]).notNull(),
    departmentId: uuid("department_id"), // Owning department

    // Category-specific metadata
    metadata: jsonb("metadata").default({}).notNull(),

    // Relations
    relatedDocumentIds: jsonb("related_document_ids").default([]).notNull(), // Related documents
    replacesDocumentId: uuid("replaces_document_id"), // If it replaces another document

    // Important dates
    effectiveDate: timestamp("effective_date", { withTimezone: true }), // When it takes effect
    reviewDueDate: timestamp("review_due_date", { withTimezone: true }), // Next mandatory review
    expirationDate: timestamp("expiration_date", { withTimezone: true }), // Expiry

    // Counters
    versionCount: integer("version_count").default(0),
    viewCount: integer("view_count").default(0),
    downloadCount: integer("download_count").default(0),

    // Flags
    isActive: boolean("is_active").default(true).notNull(),
    isTemplate: boolean("is_template").default(false), // If it is a reusable template
    requiresAcknowledgment: boolean("requires_acknowledgment").default(false), // Requires signed reading

    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdById: text("created_by_id").notNull(),
  },
  (table) => ({
    codeIdx: uniqueIndex("dms_documents_code_idx").on(table.code),
    slugIdx: index("dms_documents_slug_idx").on(table.slug),
    categoryIdx: index("dms_documents_category_idx").on(table.categoryId),
    statusIdx: index("dms_documents_status_idx").on(table.status),
    typeIdx: index("dms_documents_type_idx").on(table.type),
    ownerIdx: index("dms_documents_owner_idx").on(table.ownerId),
    reviewDueIdx: index("dms_documents_review_due_idx").on(table.reviewDueDate),
  })
);

/**
 * Individual document versions
 * Each version is immutable once published
 */
export const dmsDocumentVersions = pgTable(
  "dms_document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .references(() => dmsDocuments.id, { onDelete: "cascade" })
      .notNull(),

    // Semantic versioning
    versionNumber: varchar("version_number", { length: 20 }).notNull(), // "1.0.0"
    changeType: changeTypeEnum("change_type").default("minor").notNull(),

    // Content
    content: text("content"), // HTML/Markdown content if editable
    contentFormat: varchar("content_format", { length: 20 }).default("markdown"), // markdown, html, raw

    // Changes
    changelog: text("changelog").notNull(), // Description of changes in this version
    changesFromPrevious: jsonb("changes_from_previous"), // Structured diff { added: [], removed: [], modified: [] }

    // Status
    status: versionStatusEnum("status").default("draft").notNull(),

    // Workflow
    createdById: text("created_by_id").notNull(),
    reviewedById: text("reviewed_by_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNotes: text("review_notes"),
    approvedById: text("approved_by_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvalNotes: text("approval_notes"),
    publishedById: text("published_by_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),

    // Flags
    isActive: boolean("is_active").default(true).notNull(), // If it is the currently active version
    isLatest: boolean("is_latest").default(false).notNull(), // Last published version

    // File metadata (1:N relation with dmsDocumentFiles)
    fileCount: integer("file_count").default(0),
    // bigint (0008): with integer, more than 2 GB in a version gave 22003.
    totalSizeBytes: bigint("total_size_bytes", { mode: "number" }).default(0),

    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    documentVersionIdx: uniqueIndex("dms_doc_versions_doc_version_idx").on(
      table.documentId,
      table.versionNumber
    ),
    documentIdx: index("dms_doc_versions_document_idx").on(table.documentId),
    statusIdx: index("dms_doc_versions_status_idx").on(table.status),
    isLatestIdx: index("dms_doc_versions_is_latest_idx").on(table.isLatest),
  })
);

/**
 * Physical files associated with versions
 * A version can have multiple files (PDF, DOCX, images, etc.)
 */
export const dmsDocumentFiles = pgTable(
  "dms_document_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .references(() => dmsDocumentVersions.id, { onDelete: "cascade" })
      .notNull(),
    documentId: uuid("document_id")
      .references(() => dmsDocuments.id, { onDelete: "cascade" })
      .notNull(),

    // File metadata
    filename: varchar("filename", { length: 500 }).notNull(),
    originalName: varchar("original_name", { length: 500 }).notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    checksum: varchar("checksum", { length: 64 }), // SHA-256

    // Storage
    storageProvider: varchar("storage_provider", { length: 50 }).default("local").notNull(), // local, s3, azure
    storagePath: varchar("storage_path", { length: 1000 }).notNull(), // Path in storage
    storageBucket: varchar("storage_bucket", { length: 255 }), // Bucket/container
    publicUrl: varchar("public_url", { length: 1000 }), // Public URL (if applicable)

    // File type
    fileType: varchar("file_type", { length: 50 }).default("attachment").notNull(), // primary, attachment, thumbnail
    sortOrder: integer("sort_order").default(0),

    // Extract text for search (if PDF/DOCX)
    extractedText: text("extracted_text"),
    pageCount: integer("page_count"),

    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdById: text("created_by_id"),
  },
  (table) => ({
    versionIdx: index("dms_doc_files_version_idx").on(table.versionId),
    documentIdx: index("dms_doc_files_document_idx").on(table.documentId),
    mimeTypeIdx: index("dms_doc_files_mime_idx").on(table.mimeType),
  })
);

/**
 * Relations between documents
 */
export const dmsDocumentRelations = pgTable(
  "dms_document_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceDocumentId: uuid("source_document_id")
      .references(() => dmsDocuments.id, { onDelete: "cascade" })
      .notNull(),
    targetDocumentId: uuid("target_document_id")
      .references(() => dmsDocuments.id, { onDelete: "cascade" })
      .notNull(),
    relationType: varchar("relation_type", { length: 50 }).notNull(), // "related", "replaces", "requires", "supersedes"
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    sourceIdx: index("dms_doc_rel_source_idx").on(table.sourceDocumentId),
    targetIdx: index("dms_doc_rel_target_idx").on(table.targetDocumentId),
    uniqueRelationIdx: uniqueIndex("dms_doc_rel_unique_idx").on(
      table.sourceDocumentId,
      table.targetDocumentId,
      table.relationType
    ),
  })
);

/**
 * Read acknowledgments
 * When a document requires read confirmation
 */
export const dmsDocumentAcknowledgments = pgTable(
  "dms_document_acknowledgments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .references(() => dmsDocuments.id, { onDelete: "cascade" })
      .notNull(),
    versionId: uuid("version_id")
      .references(() => dmsDocumentVersions.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id").notNull(),

    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).defaultNow().notNull(),
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    documentUserIdx: uniqueIndex("dms_ack_doc_user_idx").on(table.documentId, table.userId),
    versionIdx: index("dms_ack_version_idx").on(table.versionId),
  })
);

/**
 * Access log (complete audit trail)
 */
export const dmsAccessLog = pgTable(
  "dms_access_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").references(() => dmsDocuments.id, { onDelete: "cascade" }),
    versionId: uuid("version_id").references(() => dmsDocumentVersions.id, { onDelete: "cascade" }),

    action: varchar("action", { length: 50 }).notNull(), // view, download, create, update, delete, approve, reject, publish
    resourceType: varchar("resource_type", { length: 50 }).notNull(), // document, version, file, category
    resourceId: uuid("resource_id"),

    userId: text("user_id"),
    userName: varchar("user_name", { length: 255 }),
    userEmail: varchar("user_email", { length: 255 }),
    userRole: varchar("user_role", { length: 100 }),

    // Details
    details: jsonb("details").default({}), // { fieldChanged, oldValue, newValue, etc. }

    // Context
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    documentIdx: index("dms_log_document_idx").on(table.documentId),
    userIdx: index("dms_log_user_idx").on(table.userId),
    actionIdx: index("dms_log_action_idx").on(table.action),
    createdIdx: index("dms_log_created_idx").on(table.createdAt),
  })
);

/**
 * Workflow notifications (review, approve, publish)
 */
export const dmsWorkflowNotifications = pgTable(
  "dms_workflow_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .references(() => dmsDocuments.id, { onDelete: "cascade" })
      .notNull(),
    versionId: uuid("version_id").references(() => dmsDocumentVersions.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    type: varchar("type", { length: 50 }).notNull(), // review_requested, approved, published, changes_requested
    message: text("message").notNull(),
    read: boolean("read").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    documentIdx: index("dms_notifications_document_idx").on(table.documentId),
    userIdx: index("dms_notifications_user_idx").on(table.userId),
    readIdx: index("dms_notifications_read_idx").on(table.read),
  })
);

/**
 * Slug history for permanent redirects
 */
export const dmsDocumentSlugHistory = pgTable(
  "dms_document_slug_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .references(() => dmsDocuments.id, { onDelete: "cascade" })
      .notNull(),
    oldSlug: varchar("old_slug", { length: 500 }).notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    oldSlugIdx: uniqueIndex("dms_slug_history_old_slug_idx").on(table.oldSlug),
    documentIdx: index("dms_slug_history_document_idx").on(table.documentId),
  })
);

/**
 * Comments on documents (informal collaboration)
 */
export const dmsDocumentComments = pgTable(
  "dms_document_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .references(() => dmsDocuments.id, { onDelete: "cascade" })
      .notNull(),
    versionId: uuid("version_id").references(() => dmsDocumentVersions.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => dmsDocumentComments.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").notNull(),
    content: text("content").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    documentIdx: index("dms_comments_document_idx").on(table.documentId),
    userIdx: index("dms_comments_user_idx").on(table.userId),
    parentIdx: index("dms_comments_parent_idx").on(table.parentId),
  })
);

/**
 * Diagrams embedded in documents (draw.io / excalidraw)
 */
export const dmsDocumentDiagrams = pgTable(
  "dms_document_diagrams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .references(() => dmsDocumentVersions.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    sourceXml: text("source_xml"), // draw.io XML
    sourceJson: text("source_json"), // Excalidraw JSON
    renderedSvg: text("rendered_svg"), // SVG string or reference
    mediaId: uuid("media_id"), // optional reference to kon-media
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    versionIdx: index("dms_diagrams_version_idx").on(table.versionId),
  })
);

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type DmsCategory = typeof dmsCategories.$inferSelect;
export type DmsDocument = typeof dmsDocuments.$inferSelect;
export type DmsDocumentVersion = typeof dmsDocumentVersions.$inferSelect;
export type DmsDocumentFile = typeof dmsDocumentFiles.$inferSelect;
export type DmsDocumentRelation = typeof dmsDocumentRelations.$inferSelect;
export type DmsDocumentAcknowledgment = typeof dmsDocumentAcknowledgments.$inferSelect;
export type DmsAccessLog = typeof dmsAccessLog.$inferInsert;
export type DmsWorkflowNotification = typeof dmsWorkflowNotifications.$inferSelect;
export type DmsDocumentSlugHistory = typeof dmsDocumentSlugHistory.$inferSelect;
export type DmsDocumentComment = typeof dmsDocumentComments.$inferSelect;
export type DmsDocumentDiagram = typeof dmsDocumentDiagrams.$inferSelect;

export type NewDmsCategory = typeof dmsCategories.$inferInsert;
export type NewDmsDocument = typeof dmsDocuments.$inferInsert;
export type NewDmsDocumentVersion = typeof dmsDocumentVersions.$inferInsert;
export type NewDmsDocumentFile = typeof dmsDocumentFiles.$inferInsert;
export type NewDmsWorkflowNotification = typeof dmsWorkflowNotifications.$inferInsert;
export type NewDmsDocumentSlugHistory = typeof dmsDocumentSlugHistory.$inferInsert;
export type NewDmsDocumentComment = typeof dmsDocumentComments.$inferInsert;
export type NewDmsDocumentRelation = typeof dmsDocumentRelations.$inferInsert;
export type NewDmsDocumentAcknowledgment = typeof dmsDocumentAcknowledgments.$inferInsert;
export type NewDmsAccessLog = typeof dmsAccessLog.$inferInsert;
export type NewDmsDocumentDiagram = typeof dmsDocumentDiagrams.$inferInsert;

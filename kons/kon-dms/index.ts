/**
 * @kitsuden/kon-dms — Document Management System (Modern)
 *
 * Professional document management system with:
 * - Categories (Hierarchical tree structure)
 * - Documents (Metadata, ACL, workflow status)
 * - Versions (Semantic versioning: major.minor.patch)
 * - Files (Multi-file support with checksums)
 * - Relations (linked documents)
 * - Acknowledgments (required reading confirmations)
 * - Audit trail (complete access logging)
 *
 * Layer: Kon Core (Level 3 — loaded via module-loader)
 * Mount: /api/dms
 *
 * @version 1.0.0
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonContext, KonDefinition } from "@kitsuden/shared";
import type { Hono } from "hono";

import { createDMSRouter, dmsOperations } from "./dms.routes";
import { KON_ID } from "./operations";

// ═══════════════════════════════════════════════════════════════════════════════
// Schema Exports
// ═══════════════════════════════════════════════════════════════════════════════

export {
  // Enums
  documentTypeEnum,
  documentStatusEnum,
  versionStatusEnum,
  changeTypeEnum,
  // Tables
  dmsCategories,
  dmsDocuments,
  dmsDocumentVersions,
  dmsDocumentFiles,
  dmsDocumentRelations,
  dmsDocumentAcknowledgments,
  dmsAccessLog,
  dmsWorkflowNotifications,
  dmsDocumentSlugHistory,
  dmsDocumentComments,
  dmsDocumentDiagrams,
} from "./dms.schema";

// ═══════════════════════════════════════════════════════════════════════════════
// Type Exports
// ═══════════════════════════════════════════════════════════════════════════════

export type {
  DmsCategory,
  NewDmsCategory,
  DmsDocument,
  NewDmsDocument,
  DmsDocumentVersion,
  NewDmsDocumentVersion,
  DmsDocumentFile,
  NewDmsDocumentFile,
  DmsDocumentRelation,
  NewDmsDocumentRelation,
  DmsDocumentAcknowledgment,
  NewDmsDocumentAcknowledgment,
  DmsAccessLog,
  NewDmsAccessLog,
  DmsWorkflowNotification,
  NewDmsWorkflowNotification,
  DmsDocumentSlugHistory,
  NewDmsDocumentSlugHistory,
  DmsDocumentComment,
  NewDmsDocumentComment,
  DmsDocumentDiagram,
  NewDmsDocumentDiagram,
} from "./dms.schema";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

// ═══════════════════════════════════════════════════════════════════════════════
// Kon Definition (Modern DI Pattern)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Factory function that creates the router with Dependency Injection
 * Used by the module-loader to mount the kon
 */
export function createKonDMS(ctx: KonContext): Hono {
  return createDMSRouter(ctx);
}

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`dmsOperations`), with its OpenAPI, its MCP tool and its fine-grained scope
 * `kon:dms:<id>`.
 *
 * `createRouter` is replaced by the usual one (`createDMSRouter`): the operations
 * router with `respondWithError` in front, which translates Postgres errors
 * without internal details (http-errors.ts).
 */
const definition = defineKonSdk({
  id: KON_ID,
  name: "Document Management System",
  version: manifest.version,
  description:
    "Document management system with semantic versioning, approval workflows and complete traceability",
  icon: "FileText",
  mountPath: "/api/dms",

  operations: (ctx: KonContext) => dmsOperations(ctx),

  // Lifecycle hooks
  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info("📄 DMS kon initialized");

      // Check main tables
      const requiredTables = [
        "dms_categories",
        "dms_documents",
        "dms_document_versions",
        "dms_document_files",
        "dms_document_relations",
        "dms_document_acknowledgments",
        "dms_access_log",
        "dms_workflow_notifications",
        "dms_document_slug_history",
        "dms_document_comments",
        "dms_document_diagrams",
      ];

      for (const table of requiredTables) {
        const exists = await ctx.db.tableExists(table);
        if (!exists) {
          ctx.logger.warn(`⚠️ Table '${table}' not found. Run migrations!`);
        }
      }
    },

    onEnable: async (ctx) => {
      ctx.logger.info("📄 DMS enabled");
    },

    onDisable: async (ctx) => {
      ctx.logger.info("📄 DMS disabled");
    },
  },

  // Admin UI configuration
  // kon.json `admin` is the one list of admin views; the definition copies it.
  admin: {
    category: manifest.admin.category as "content",
    views: manifest.admin.views.map((v) => ({
      id: v.id,
      type: v.type as "grid" | "custom",
      title: v.title,
      table: (v as { table?: string }).table,
    })),
  },

  // Tables it manages
  tables: konTables,

  // Dependencies
  dependencies: {
    kons: [],
    core: ["auth"],
  },
});

export const kon: KonDefinition = { ...definition, createRouter: createKonDMS };

// "dms_document" policy and DMS gates — registered on import.
export { registerDmsPolicy, type DocumentResource } from "./dms.policy";
export { permissions as dmsPermissions, readFilter as dmsReadFilter } from "./dms.access";

// ═══════════════════════════════════════════════════════════════════════════════
// Re-export routes for compatibility
// ═══════════════════════════════════════════════════════════════════════════════

export { createDMSRouter, dmsOperations } from "./dms.routes";

// Legacy exports for compatibility
export { createDMSRouter as dmsRoutes };
export { createKonDMS as default };

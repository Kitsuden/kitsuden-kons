/**
 * @kitsuden/kon-vekstudio — Bridge to the vekocr OCR stack (konusagi)
 *
 * Forwards the full konusagi gateway contract under /api/ocr/gateway
 * (jobs, corrections, training, models, health, SSE /events) and maintains a local
 * `ocr_documents` table that links each OCR job to KITSUDEN records.
 *
 * Upstream:  VEKDOCS_GATEWAY_URL (default http://gateway_api:8001; fallbacks VEKOCR_GATEWAY_URL,
 *            HARUOCR_GATEWAY_URL)
 * Studio:    window.__vekstudio_config = { gatewayUrl: '/api/ocr/gateway' }
 *
 * Layer: Kon Core (level 3, loaded via module-loader)
 * Mount: /api/ocr
 *
 * @version 1.0.1
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonContext, KonDefinition } from "@kitsuden/shared";
import type { Hono } from "hono";

import { KON_ID } from "./src/operations";
import { createOCRRouter, proxyGateway, vekstudioOperations } from "./src/routes";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

// ═══════════════════════════════════════════════════════════════════════════════
// Schema Exports
// ═══════════════════════════════════════════════════════════════════════════════

export { ocrDocuments } from "./src/schema";
export type { OcrDocument, NewOcrDocument } from "./src/schema";

// ═══════════════════════════════════════════════════════════════════════════════
// Kon Definition
// ═══════════════════════════════════════════════════════════════════════════════

export function createKonOCR(ctx: KonContext): Hono {
  return createOCRRouter(ctx);
}

/**
 * SDK kon (docs/kons/README.md): `/documents` and `/health` are declared
 * operations (`vekstudioOperations`), with their OpenAPI, their MCP tool and their
 * fine-grained scope `kon:vekstudio:<id>`. The `/gateway/*` proxy (any method,
 * multipart uploads and the SSE flow) does not fit a declared contract and is mounted
 * behind, as a legacy route.
 */
export const kon: KonDefinition = defineKonSdk({
  id: KON_ID,
  name: "VekStudio",
  version: manifest.version,
  description:
    "Bridge to the vekocr OCR stack: enqueues documents in konusagi, follows live statuses (SSE) and links OCR jobs to KITSUDEN records",
  icon: "ScanText",
  mountPath: "/api/ocr",

  operations: (ctx: KonContext) => vekstudioOperations(ctx),
  legacyRoutes: (ctx: KonContext) => proxyGateway(ctx),

  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info("🔍 OCR kon initialized", {
        gateway:
          process.env.VEKDOCS_GATEWAY_URL ??
          process.env.VEKOCR_GATEWAY_URL ??
          process.env.HARUOCR_GATEWAY_URL ??
          "http://gateway_api:8001",
      });
      const exists = await ctx.db.tableExists("ocr_documents");
      if (!exists) {
        ctx.logger.warn("⚠️ Table 'ocr_documents' not found. Run migrations!");
      }
    },
    onEnable: async (ctx) => {
      ctx.logger.info("🔍 OCR kon enabled");
    },
    onDisable: async (ctx) => {
      ctx.logger.info("🔍 OCR kon disabled");
    },
  },

  admin: {
    category: "content",
    // kon.json `admin.views` is the one list of admin views; the definition copies it.
    views: manifest.admin.views.map((v) => ({
      id: v.id,
      type: v.type as "grid",
      title: v.title,
      table: v.table,
    })),
  },

  tables: konTables,

  dependencies: {
    kons: [],
    core: ["auth"],
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// Re-exports / compatibility
// ═══════════════════════════════════════════════════════════════════════════════

export { createOCRRouter, proxyGateway, vekstudioOperations } from "./src/routes";
export { registerVekstudioPolicy } from "./src/policy";
export { createKonOCR as default };

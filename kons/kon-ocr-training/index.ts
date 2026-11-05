/**
 * @kitsuden/kon-ocr-training — OCR model operation (vekocr) + vision LLM
 *
 * Admin bridge to the vekocr engine: template proposal review,
 * promotion via /train, per-provider vocabulary and direct test extraction.
 * The lifecycle of OCR jobs lives outside this kon (konusagi); nothing here
 * depends on another kon.
 *
 * It also governs the vision LLM (last resort of the OCR cascade): it stores
 * the non-sensitive knobs in `ocr_vision_config` and runs the call to the
 * provider with the key from KITSUDEN Secrets (VEKOCR_VISION_LLM_API_KEY), which
 * NEVER leaves KITSUDEN — it does not touch the RabbitMQ queue or the engine.
 *
 * Upstreams: VEKOCR_URL          (default http://vekocr_engine:8000)
 *            VEKDOCS_GATEWAY_URL (for /overview and downloading the input to reprocess)
 * Secrets:   VEKOCR_VISION_LLM_API_KEY (provider key, encrypted in KITSUDEN)
 * Studio:    window.__vekstudio_config = { yomiUrl: '/api/ocr-training/yomi' }
 *
 * Layer: Kon Core (Level 3 — loaded via module-loader)
 * Mount: /api/ocr-training
 *
 * @version 1.1.1
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonContext, KonDefinition } from "@kitsuden/shared";
import type { Hono } from "hono";

import { KON_ID } from "./src/operations";
import { createOCRTrainingRouter, ocrTrainingOperations, proxyYomi } from "./src/routes";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

export { ocrVisionConfig } from "./src/schema";
export type { OcrVisionConfig, NewOcrVisionConfig } from "./src/schema";

export function createKonOCRTraining(ctx: KonContext): Hono {
  return createOCRTrainingRouter(ctx);
}

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`ocrTrainingOperations`), with its OpenAPI, its MCP tool and its fine-grained scope
 * `kon:ocr-training:<id>`. The `/yomi/*` proxy (any method to the
 * engine) does not fit a declared contract and is mounted behind, as a legacy route.
 */
export const kon: KonDefinition = defineKonSdk({
  id: KON_ID,
  name: "OCR Training + Vision LLM",
  version: manifest.version,
  description:
    "OCR model operation (template proposals, training, vocabulary) and vision LLM governance with the provider key in KITSUDEN Secrets",
  icon: "BrainCircuit",
  mountPath: "/api/ocr-training",

  operations: (ctx: KonContext) => ocrTrainingOperations(ctx),
  legacyRoutes: (ctx: KonContext) => proxyYomi(ctx),

  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info("🧠 OCR training kon initialized", {
        yomi: process.env.VEKOCR_URL ?? process.env.HARUOCR_YOMI_URL ?? "http://vekocr_engine:8000",
        vision_key_present: Boolean(
          (
            process.env.VEKOCR_VISION_LLM_API_KEY ??
            process.env.HARUOCR_VISION_LLM_API_KEY ??
            ""
          ).trim()
        ),
      });
      const exists = await ctx.db.tableExists("ocr_vision_config");
      if (!exists) {
        ctx.logger.warn("⚠️ Table 'ocr_vision_config' not found. Run migrations!");
      }
    },
    onEnable: async (ctx) => {
      ctx.logger.info("🧠 OCR training kon enabled");
    },
    onDisable: async (ctx) => {
      ctx.logger.info("🧠 OCR training kon disabled");
    },
  },

  admin: {
    category: "content",
    views: [{ id: "vision-config", type: "custom", title: "AI settings (vision)" }],
  },

  tables: konTables,

  dependencies: {
    core: ["auth"],
  },
});

export { createOCRTrainingRouter, ocrTrainingOperations, proxyYomi } from "./src/routes";
export { registerOcrTrainingPolicy } from "./src/policy";
export { createKonOCRTraining as default };

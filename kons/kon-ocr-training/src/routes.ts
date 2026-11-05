/**
 * kon-ocr-training — Routes
 *
 * Allowlisted proxy to the vekocr engine (model operation) + an
 * aggregated overview for admin dashboards.
 *
 *   /api/ocr-training/yomi/*    → VEKOCR_URL (proposals, train,
 *                                 templates, vocabulary, feedback,
 *                                 extract, extract/region, status, health)
 *   /api/ocr-training/overview  → aggregated snapshot: correction stats
 *                                 and training jobs (konusagi) + pending
 *                                 proposals (vekocr)
 *
 * VekStudio is configured with:
 *   window.__vekstudio_config = { yomiUrl: '/api/ocr-training/yomi' }
 *
 * ── AUTHORIZATION ────────────────────────────────────────────────────────────
 * Everything except `/health` goes through `can(user, action, {}, "ocr-training")`
 * (see src/policy.ts): administration only. Before, `requireAuth`
 * was enough, and account sign-up is public.
 *
 * ── KON SDK ──────────────────────────────────────────────────────────────────
 * Every route except the proxy is now an SDK OPERATION
 * (operations.ts): each handler's body is the same as before, and what were
 * middlewares (`requireAuth` + `require(action)`) is now its declaration. The
 * `/yomi/*` proxy (any method, any allowed sub-route) remains as a
 * legacy route: `proxyYomi()`.
 */
import {
  can,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { eq } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";

import { KON_ID, registry, adminOnly } from "./operations";
// Importing it registers the policy (deny-by-default).
import "./policy";
import { ocrVisionConfig } from "./schema";
import {
  defaultModel,
  runVisionLLM,
  visionApiKey,
  visionBaseUrl,
  type VisionConfig,
} from "./vision";

const YOMI_ALLOWLIST = new Set([
  "proposals",
  "train",
  "templates",
  "vocabulary",
  "feedback",
  "extract",
  "status",
  "health",
]);

/**
 * What can be saved of the vision LLM config. Allowlist and
 * `strict()`: a field not listed here is a 422, not an «it is ignored».
 *
 * `base_url` is NOT there, and on purpose: it is where the provider key
 * is sent. See `visionBaseUrl` in vision.ts.
 */
export const VisionConfigInput = z
  .object({
    enabled: z.boolean().optional(),
    provider: z.enum(["anthropic", "openai"]).optional(),
    model: z
      .string()
      .trim()
      .max(128)
      .regex(/^[A-Za-z0-9._:/-]*$/, "Invalid model name")
      .nullable()
      .optional(),
    min_confidence: z.union([z.number(), z.string().max(8), z.null()]).optional(),
    stage: z.enum(["after_light", "after_heavy"]).optional(),
    max_pages: z.number().int().min(1).max(20).optional(),
  })
  .strict();

/** Gateway job ids: hex/uuid/short slug. Nothing that forms another route. */
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Engine sub-route that is accepted for forwarding: clean segments, no `..`, no
 * `%` escapes (a `%2f` or `%2e%2e` would be decoded by the upstream, not by us)
 * and no backslashes.
 */
const SAFE_SUBPATH = /^[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)*\/?$/;

export function safeSubpath(subpath: string): boolean {
  if (!SAFE_SUBPATH.test(subpath)) return false;
  return !subpath.split("/").some((seg) => seg === "." || seg === "..");
}

// Two different upstreams, two different prefixes, and they should not be crossed:
//   VEKOCR_*  → the OCR engine in Python
//   VEKDOCS_* → the gateway (the Go binary)
// The HARUOCR_* names remain as a fallback so as not to bring down deployments that
// still have them configured. Remove when all migrate.

function vekocrBase(): string {
  return (
    process.env.VEKOCR_URL ??
    process.env.HARUOCR_YOMI_URL ??
    "http://vekocr_engine:8000"
  ).replace(/\/+$/, "");
}

function gatewayBase(): string {
  return (
    process.env.VEKDOCS_GATEWAY_URL ??
    process.env.VEKOCR_GATEWAY_URL ??
    "http://gateway_api:8001"
  ).replace(/\/+$/, "");
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/**
 * Browser headers that do NOT travel to the engine: the user's session
 * (cookie, Authorization) is not the upstream's business, and a client `x-api-key`
 * must not be able to pass itself off as the server's.
 */
const DO_NOT_FORWARD = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

/**
 * How long to wait for the service behind to respond (headers). Each
 * request runs in a Postgres transaction, which the application role
 * cuts at 60 s if it is left waiting with it open.
 */
const HEADERS_WAIT_MS = 30_000;

async function proxyTo(target: string, c: Context): Promise<Response> {
  const headers = new Headers();
  c.req.raw.headers.forEach((value: string, key: string) => {
    const k = key.toLowerCase();
    if (!HOP_BY_HOP.has(k) && !DO_NOT_FORWARD.has(k)) headers.set(key, value);
  });
  // Only the wait for the HEADERS is bounded (see HEADERS_WAIT_MS); the
  // body, if it is a stream, continues afterwards without limit.
  const control = new AbortController();
  const init: RequestInit & { duplex?: "half" } = {
    method: c.req.method,
    headers,
    signal: control.signal,
  };
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    init.body = c.req.raw.body;
    init.duplex = "half";
  }
  const timer = setTimeout(() => control.abort(), HEADERS_WAIT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    if (control.signal.aborted) {
      return new Response(
        JSON.stringify({ error: "The service did not respond in time", code: "KITSUDEN_E_TIMEOUT" }),
        { status: 504, headers: { "content-type": "application/json; charset=utf-8" } }
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const respHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) respHeaders.set(key, value);
  });
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

async function fetchJson(url: string, timeoutMs = 5000): Promise<unknown | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Session + policy. Account sign-up is public: `requireAuth` only says
 * that there is SOMEONE, not that they are on the team. The decision is made by `can()`. Only the
 * `/yomi/*` proxy uses it now (the operations DECLARE it: `adminOnly`).
 */
const require =
  (action: "operate" | "configure"): MiddlewareHandler =>
  async (c, next) => {
    const user = (c.get("user") ?? null) as AuthzUser | null;
    if (!user) return c.json({ error: "Authentication required" }, 401);
    if (!(await can(user, action, {}, "ocr-training"))) {
      return c.json({ error: "Not authorized" }, 403);
    }
    await next();
  };

// ── Declared input and output (OpenAPI and MCP) ─────────────────────────────

const ParamJob = z.object({
  jobId: z.string().describe("Gateway job id (letters, digits, _ and -, up to 64)"),
});

const PublicConfig = z
  .object({
    enabled: z.boolean(),
    provider: z.string(),
    model: z.string(),
    maxPages: z.number(),
    minConfidence: z.number().nullable(),
    stage: z.string(),
    base_url_source: z.literal("server"),
    api_key_present: z.boolean(),
  })
  .passthrough();

/**
 * The usual router: the operations and, behind them, the legacy proxy. It is what
 * `defineKonSdk` mounts (operations + `legacyRoutes`); it is exported for the
 * tests and for whoever mounted the kon by hand.
 */
export function createOCRTrainingRouter(ctx: KonContext): Hono {
  const router = operationsRouter(KON_ID, ocrTrainingOperations(ctx), ctx);
  router.route("/", proxyYomi(ctx));
  return router;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROXY TO THE VEKOCR ENGINE — /yomi/* (legacy route: not an operation)
// ═══════════════════════════════════════════════════════════════════════════

export function proxyYomi(ctx: KonContext): Hono {
  const router = new Hono();
  const { auth, logger } = ctx;
  const requireAuth = auth.requireAuth;

  router.all("/yomi/*", requireAuth, require("operate"), async (c: Context) => {
    const url = new URL(c.req.url);
    const marker = "/yomi/";
    const idx = url.pathname.indexOf(marker);
    const subpath = url.pathname.slice(idx + marker.length);
    const head = subpath.split("/")[0];

    if (!head || !YOMI_ALLOWLIST.has(head) || !safeSubpath(subpath)) {
      return c.json({ error: "Engine route not allowed" }, 404);
    }

    const target = `${vekocrBase()}/${subpath}${url.search}`;
    try {
      return await proxyTo(target, c);
    } catch (e) {
      // The detail (internal host, network error) goes to the log, not to the client.
      logger.error("ocr_yomi_unreachable", { target, error: String(e) });
      return c.json({ error: "vekocr engine unavailable" }, 502);
    }
  });

  return router;
}

export function ocrTrainingOperations(ctx: KonContext): AnyOperation[] {
  const router = registry();
  const { logger, db } = ctx;
  const dbInstance = db.instance;
  // Outside the request's transaction (the host always provides it).
  const background = db.background ?? (<T>(fn: () => T) => fn());

  function getUserId(c: Context): string {
    return c.get("user")?.id || "system";
  }

  /** Vision LLM config (singleton id=1). Defaults if there is no row yet. */
  async function loadVisionConfig(): Promise<
    VisionConfig & { minConfidence: number | null; stage: string }
  > {
    const rows = await dbInstance
      .select()
      .from(ocrVisionConfig)
      .where(eq(ocrVisionConfig.id, 1))
      .limit(1);
    const row = rows[0];
    return {
      enabled: row?.enabled ?? false,
      provider: row?.provider ?? "anthropic",
      model: row?.model ?? null,
      // The table's `base_url` is IGNORED: the provider URL belongs to the server.
      maxPages: row?.maxPages ?? 3,
      minConfidence: row?.minConfidence ?? null,
      stage: row?.stage ?? "after_heavy",
    };
  }

  /** The config as returned: without a URL (it is no longer stored or used). */
  const publicValue = (cfg: Awaited<ReturnType<typeof loadVisionConfig>>) => ({
    enabled: cfg.enabled,
    provider: cfg.provider,
    model: cfg.model || defaultModel(cfg.provider),
    maxPages: cfg.maxPages,
    minConfidence: cfg.minConfidence,
    stage: cfg.stage,
    base_url_source: "server",
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AGGREGATED OVERVIEW — for admin dashboards in KITSUDEN
  // ═══════════════════════════════════════════════════════════════════════════

  router.get(
    "/overview",
    {
      id: "get-summary",
      summary: "Read the OCR operations overview (admin)",
      description:
        "Aggregated snapshot for an admin dashboard: correction stats, the last 5 training jobs and the models (from the vekdocs gateway), the number of pending template proposals and the engine status (from vekocr). A part whose upstream does not answer is null. Admin only. Calls the gateway and the OCR engine.",
      access: "session",
      permission: adminOnly("operate"),
      output: {
        schema: z.object({
          corrections: z.unknown(),
          training_jobs: z.unknown(),
          models: z.unknown(),
          pending_proposals: z.unknown(),
          engine: z.unknown(),
        }),
      },
    },
    async (c) => {
      const [correctionStats, trainingJobs, models, proposals, engineStatus] = await Promise.all([
        fetchJson(`${gatewayBase()}/corrections/stats`),
        fetchJson(`${gatewayBase()}/training/jobs?limit=5`),
        fetchJson(`${gatewayBase()}/models`),
        fetchJson(`${vekocrBase()}/proposals?status=pending&limit=1`),
        fetchJson(`${vekocrBase()}/status`),
      ]);
      return c.json({
        corrections: correctionStats,
        training_jobs: trainingJobs,
        models,
        pending_proposals: (proposals as { count?: number } | null)?.count ?? null,
        engine: engineStatus,
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // VISION LLM CONFIG — governed by KITSUDEN
  // The provider key lives in KITSUDEN Secrets (VEKOCR_VISION_LLM_API_KEY) and
  // the provider URL is in the server config (VEKOCR_VISION_LLM_BASE_URL);
  // only the non-sensitive knobs are edited here. The response NEVER exposes the
  // key: only whether it is present or not.
  // ═══════════════════════════════════════════════════════════════════════════

  router.get(
    "/vision-config",
    {
      id: "get-vision-config",
      summary: "Read the vision LLM settings (admin)",
      description:
        "The vision LLM settings: enabled, provider (anthropic|openai), model, max pages, minimum confidence and stage, and whether the provider key is present in Secrets (never the key, never a URL: the provider URL is the server's). Admin only.",
      access: "session",
      permission: adminOnly("configure"),
      output: { schema: PublicConfig.extend({ api_key_source: z.string() }) },
    },
    async (c) => {
      const cfg = await loadVisionConfig();
      return c.json({
        ...publicValue(cfg),
        // Credential status without ever revealing it.
        api_key_present: visionApiKey().length > 0,
        api_key_source: "kitsuden_secrets",
      });
    }
  );

  router.put(
    "/vision-config",
    {
      id: "save-vision-config",
      summary: "Save the vision LLM settings (admin)",
      description:
        "Replaces the vision LLM settings (whitelist, strict: an unknown field such as base_url is a 422 with every issue): enabled, provider, model, min_confidence (0-1 or a percentage), stage (after_light|after_heavy), max_pages (1-20). Fields left out go back to their defaults. Returns the saved settings. Admin only.",
      access: "session",
      permission: adminOnly("configure"),
      // It governs a paid call with the site's key.
      sensitive: true,
      // The handler validates: its 422 (`error` + `issues`) is the usual one.
      input: { body: VisionConfigInput, validatesHandler: true },
      output: { schema: PublicConfig },
    },
    async (c) => {
      const rawValue = await c.req.json().catch(() => null);
      const parsed = VisionConfigInput.safeParse(rawValue ?? {});
      if (!parsed.success) {
        return c.json(
          {
            error: "Invalid config",
            issues: parsed.error.issues.map((i) => ({
              field: i.path.join(".") || "(body)",
              problem: i.message,
            })),
          },
          422
        );
      }
      const body = parsed.data;
      const provider = body.provider === "openai" ? "openai" : "anthropic";
      const stage = body.stage === "after_light" ? "after_light" : "after_heavy";
      let minConf: number | null = null;
      if (body.min_confidence != null && body.min_confidence !== "") {
        let v = Number(body.min_confidence);
        if (Number.isFinite(v)) {
          if (v > 1) v = v / 100; // accepts "90" or "0.90"
          minConf = Math.max(0, Math.min(1, v));
        }
      }
      const values = {
        id: 1,
        enabled: Boolean(body.enabled),
        provider,
        model: typeof body.model === "string" && body.model.trim() ? body.model.trim() : null,
        // Whatever there was is DELETED: a URL stored before the fix must not
        // stay in the database waiting for someone to read it again.
        baseUrl: null,
        minConfidence: minConf,
        stage,
        maxPages: body.max_pages ?? 3,
        updatedAt: new Date(),
        updatedBy: getUserId(c),
      };
      await dbInstance
        .insert(ocrVisionConfig)
        .values(values)
        .onConflictDoUpdate({ target: ocrVisionConfig.id, set: values });
      logger.info("vision_config_updated", {
        by: values.updatedBy,
        provider,
        enabled: values.enabled,
      });
      const cfg = await loadVisionConfig();
      return c.json({
        ...publicValue(cfg),
        api_key_present: visionApiKey().length > 0,
      });
    }
  );

  // Credential test: cheap call (text) to validate key+model.
  router.post(
    "/vision-config/test",
    {
      id: "test-vision-config",
      summary: "Test the vision LLM key (admin)",
      description:
        "Sends a tiny text request (8 tokens) to the configured provider with the key from Secrets and the saved model, and reports whether it answered OK and with which HTTP status. 400 if the key is missing; 502 if the provider cannot be reached. Changes nothing. Admin only. Calls the LLM provider (Anthropic or OpenAI) and spends a few tokens.",
      access: "session",
      permission: adminOnly("configure"),
      readOnly: true,
      output: {
        schema: z
          .object({ ok: z.boolean(), provider: z.string(), model: z.string(), status: z.number() })
          .passthrough(),
      },
      errors: ["KITSUDEN_E_BAD_GATEWAY"],
    },
    async (c) => {
      const cfg = await loadVisionConfig();
      const key = visionApiKey();
      if (!key) {
        return c.json(
          { ok: false, error: "VEKOCR_VISION_LLM_API_KEY is missing from KITSUDEN Secrets" },
          400
        );
      }
      const model = cfg.model || defaultModel(cfg.provider);
      try {
        if (cfg.provider === "anthropic") {
          const r = await fetch(`${visionBaseUrl("anthropic")}/v1/messages`, {
            method: "POST",
            headers: {
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model,
              max_tokens: 8,
              messages: [{ role: "user", content: "ping" }],
            }),
            signal: AbortSignal.timeout(15000),
          });
          return c.json({ ok: r.ok, provider: "anthropic", model, status: r.status });
        }
        const r = await fetch(`${visionBaseUrl("openai")}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            max_tokens: 8,
            messages: [{ role: "user", content: "ping" }],
          }),
          signal: AbortSignal.timeout(15000),
        });
        return c.json({ ok: r.ok, provider: "openai", model, status: r.status });
      } catch (e) {
        logger.warn("vision_config_test_failed", { error: String(e) });
        return c.json({ ok: false, error: "Could not contact the provider", model }, 502);
      }
    }
  );

  // Reprocess a document with the vision LLM. KITSUDEN downloads the input from the
  // gateway and calls the provider with the key from Secrets — the key never touches the
  // queue or the engine. Typical use: manual re-read of a doubtful job.
  router.post(
    "/vision-reprocess/:jobId",
    {
      id: "reread-with-vision",
      summary: "Re-read a document with the vision LLM (admin)",
      description:
        "Downloads the original input of an OCR job from the vekdocs gateway and reads it with the vision LLM using the key from Secrets; returns the text, its confidence, provider and model. Stores nothing. 400 for a malformed job id; 409 if the vision LLM is disabled; 404 if the gateway has no input for that job; 502 if the gateway or the LLM fail. Admin only. Calls the gateway and the LLM provider (paid, up to about 150 s).",
      access: "session",
      permission: adminOnly("configure"),
      readOnly: true,
      input: { params: ParamJob },
      output: { schema: z.object({ job_id: z.string() }).passthrough() },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT", "KITSUDEN_E_BAD_GATEWAY"],
    },
    async (c) => {
      const jobId = c.req.param("jobId") ?? "";
      if (!JOB_ID.test(jobId)) return c.json({ error: "Invalid jobId" }, 400);
      // The config is read OUTSIDE the request's transaction (already authorized
      // by `require("configure")`): what follows is up to 150 s of
      // external calls (30 s of download + 120 s of the LLM), and with the
      // transaction open Postgres would cut it at 60 s
      // (`idle_in_transaction_session_timeout`). That way the request never gets to
      // ask for a connection: it is the route's only query.
      const cfg = await background(() => loadVisionConfig());
      if (!cfg.enabled) {
        return c.json({ error: "The vision LLM is disabled in the config" }, 409);
      }

      // Download the original document from the gateway (authenticated proxy).
      const gw = gatewayBase();
      const headers: Record<string, string> = {};
      const gwKey = process.env.VEKDOCS_GATEWAY_API_KEY ?? process.env.VEKOCR_GATEWAY_API_KEY;
      if (gwKey) headers["x-api-key"] = gwKey;
      let bytes: ArrayBuffer;
      let mime: string;
      try {
        const inp = await fetch(`${gw}/jobs/${encodeURIComponent(jobId)}/input`, {
          headers,
          signal: AbortSignal.timeout(30000),
        });
        if (!inp.ok) {
          return c.json({ error: `Could not download the input (HTTP ${inp.status})` }, 404);
        }
        mime = inp.headers.get("content-type") || "application/octet-stream";
        bytes = await inp.arrayBuffer();
      } catch (e) {
        logger.warn("vision_reprocess_input_failed", { jobId, error: String(e) });
        return c.json({ error: "Input inaccessible" }, 502);
      }

      const result = await runVisionLLM(cfg, bytes, mime, 120000);
      if (!result.ok) {
        logger.warn("vision_reprocess_failed", { jobId, error: result.error });
        return c.json(
          { ok: false, error: "The vision LLM failed", provider: result.provider },
          502
        );
      }
      logger.info("vision_reprocess_ok", {
        jobId,
        provider: result.provider,
        confidence: result.confidence,
      });
      return c.json({ job_id: jobId, ...result });
    }
  );

  // Public (probes): only the status. Neither the engine's internal host nor whether there is an
  // LLM key, which is none of the business of whoever asks without a session.
  router.get(
    "/health",
    {
      id: "get-health",
      summary: "Health of the OCR training kon",
      description:
        "For probes: ok when the vekocr engine answers its health check, degraded otherwise. Says nothing about the upstream host or the LLM key. Public. Calls the OCR engine.",
      access: "public",
      output: { schema: z.object({ kon: z.literal("kon-ocr-training"), status: z.string() }) },
    },
    async (c) => {
      const engine = await fetchJson(`${vekocrBase()}/health`);
      return c.json({ kon: "kon-ocr-training", status: engine ? "ok" : "degraded" });
    }
  );

  return router.ops;
}

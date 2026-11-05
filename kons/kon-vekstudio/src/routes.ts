/**
 * kon-vekstudio — Routes
 *
 * Allowlisted proxy to the konusagi gateway + local ocr_documents table.
 *
 *   /api/ocr/gateway/*   → VEKDOCS_GATEWAY_URL (full gateway contract:
 *                          jobs, corrections, training, models, health, events)
 *   /api/ocr/documents   → local table of links (KITSUDEN ↔ job_id)
 *   /api/ocr/health      → aggregated health (kon + gateway)
 *
 * vekstudio is configured with:
 *   window.__vekstudio_config = { gatewayUrl: '/api/ocr/gateway', ... }
 * and works unchanged: the contract is forwarded 1:1.
 *
 * The proxy intercepts (buffers) only two small responses to keep
 * the local table in sync: POST jobs/extract (creation) and GET jobs/{id}
 * (status). Everything else — including files and the SSE stream — is
 * streamed without touching disk or memory.
 *
 * ── AUTHORIZATION (src/policy.ts) ────────────────────────────────────────────
 * The proxy adds the SERVER's gateway key, so what is let
 * through is what the user can do with that key:
 *
 *   POST jobs/extract          → `submit` (team). Who is recorded.
 *   anything jobs/<id>/…       → `view` on THAT document (admin or whoever
 *                                sent it, according to the `ocr_documents` mirror).
 *   everything else            → `operate` (admin): job list, everyone's
 *                                events, corrections, training, models.
 *
 * ── KON SDK ──────────────────────────────────────────────────────────────────
 * `/documents` and `/health` are now SDK OPERATIONS
 * (operations.ts): each handler's body is the same as before, and what were
 * middlewares is now their declaration. The `/gateway/*` proxy (any
 * method, multipart uploads, SSE) remains a legacy route: `proxyGateway()`.
 */
import {
  can,
  withSavepoint,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { KON_ID, registry, ON_THE_DOCUMENT, TEAM_ONLY } from "./operations";
// Importing it registers the policy (deny-by-default).
import { ownsOrOperates } from "./policy";
import { ocrDocuments } from "./schema";

const GATEWAY_ALLOWLIST = new Set([
  "jobs",
  "corrections",
  "training",
  "models",
  "health",
  "events",
]);

/** Gateway job ids (32-char hex, uuid…). Nothing that forms another route. */
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Sub-route that is accepted for forwarding: clean segments, no `..`, no
 * `%` escapes (a `%2f` would be decoded by the upstream, not by us) or backslashes.
 */
const SAFE_SUBPATH = /^[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)*\/?$/;

export function safeSubpath(subpath: string): boolean {
  if (!SAFE_SUBPATH.test(subpath)) return false;
  return !subpath.split("/").some((seg) => seg === "." || seg === "..");
}

/** The only thing that can be changed on a document: strict allowlist. */
const DocumentChange = z
  .object({
    entityType: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,64}$/, "Invalid entity type")
      .nullable()
      .optional(),
    entityId: z.string().min(1).max(64).nullable().optional(),
    reviewed: z.boolean().optional(),
  })
  .strict();

/** Reads the gateway URL on every request (compatible with Secrets hot-inject). */
function gatewayBase(): string {
  // The gateway is **VekDocs** (the Go binary); VEKOCR_ names the OCR engine in
  // Python, so VEKOCR_GATEWAY_URL crossed the two. It is accepted as a fallback
  // —like HARUOCR_GATEWAY_URL— so as not to bring down a deployment that already has it
  // configured. Remove both when everyone migrates.
  return (
    process.env.VEKDOCS_GATEWAY_URL ??
    process.env.VEKOCR_GATEWAY_URL ??
    process.env.HARUOCR_GATEWAY_URL ??
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
 * Browser headers that do NOT travel to the gateway. The user's session
 * (cookie, Authorization) is not the upstream's business, and the `x-api-key` is set
 * by the server: a client one must never sneak in if no key is configured.
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

function forwardHeaders(c: { req: { raw: Request } }): Headers {
  const headers = new Headers();
  c.req.raw.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (!HOP_BY_HOP.has(k) && !DO_NOT_FORWARD.has(k)) headers.set(key, value);
  });
  // Gateway auth (KONUSAGI_API_KEYS): the kon injects the key
  // server-side — the browser authenticated by KITSUDEN never knows it.
  // Read per request (compatible with Secrets hot-inject).
  // The key belongs to the gateway → VEKDOCS_. The old names remain as a fallback.
  const apiKey =
    process.env.VEKDOCS_GATEWAY_API_KEY ??
    process.env.VEKOCR_GATEWAY_API_KEY ??
    process.env.HARUOCR_GATEWAY_API_KEY;
  if (apiKey) headers.set("x-api-key", apiKey);
  return headers;
}

/**
 * How long to wait for the gateway to RESPOND (headers). The request runs in
 * a Postgres transaction that, if it already queried (per-job authorization
 * does), stays open in the meantime, and the application role cuts it at
 * 60 s (`idle_in_transaction_session_timeout`). Headers only: an SSE
 * stream (`/events`) continues afterwards without limit, already outside the route.
 */
const HEADERS_WAIT_MS = 30_000;

async function proxyTo(target: string, c: Context): Promise<Response> {
  const method = c.req.method;
  const control = new AbortController();
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: forwardHeaders(c),
    signal: control.signal,
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = c.req.raw.body;
    init.duplex = "half"; // required by undici for streaming a request body
  }
  const timer = setTimeout(() => control.abort(), HEADERS_WAIT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    if (control.signal.aborted) {
      return new Response(
        JSON.stringify({ error: "The gateway did not respond in time", code: "KITSUDEN_E_TIMEOUT" }),
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

// ── Declared input and output (OpenAPI and MCP) ─────────────────────────────

const ParamJob = z.object({
  jobId: z.string().describe("Gateway job id (letters, digits, _ and -, up to 64)"),
});
const LimitQuery = z.object({ limit: z.string().optional() }).passthrough();
/** A row of `ocr_documents`. */
const DocumentRecord = z.object({ id: z.string(), jobId: z.string() }).passthrough();

/**
 * The usual router: the operations and, behind them, the legacy proxy. It is what
 * `defineKonSdk` mounts (operations + `legacyRoutes`); it is exported for the
 * tests and for whoever mounted the kon by hand.
 */
export function createOCRRouter(ctx: KonContext): Hono {
  const router = operationsRouter(KON_ID, vekstudioOperations(ctx), ctx);
  router.route("/", proxyGateway(ctx));
  return router;
}

/** What the proxy and the operations share: the `ocr_documents` mirror. */
function pieces(ctx: KonContext) {
  const { db, logger } = ctx;
  const dbInstance = db.instance;

  const userValue = (c: Context) => (c.get("user") ?? null) as AuthzUser | null;

  async function documentByJob(jobId: string) {
    const rows = await dbInstance
      .select()
      .from(ocrDocuments)
      .where(eq(ocrDocuments.jobId, jobId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Can this user `action` on the job's document? A job that is not
   * in the mirror is seen only by admin: with no row there is no owner to check.
   * 404 and not 403 so as not to confirm which jobs exist.
   */
  async function canOnJob(
    user: AuthzUser,
    action: "view" | "edit",
    jobId: string
  ): Promise<boolean> {
    const doc = await documentByJob(jobId);
    const record = doc ?? { jobId, createdBy: null };
    // The policy, and then the sender rule, which a scope does not lift (agents included).
    return (await can(user, action, record, "vekstudio")) && (await ownsOrOperates(user, record));
  }

  /** Upsert of the local mirror from the gateway payload. */
  async function syncJobRow(payload: Record<string, unknown>, createdBy?: string) {
    const jobId = payload.job_id;
    if (!jobId || typeof jobId !== "string" || !JOB_ID.test(jobId)) return;
    const meta = (payload.meta ?? {}) as Record<string, unknown>;
    const values = {
      jobId,
      filename: payload.filename ?? null,
      state: payload.state ?? "PENDING",
      engine: meta.engine ?? payload.engine ?? null,
      confidence: meta.confidence ?? payload.confidence ?? null,
      processingTimeMs: meta.processing_time_ms ?? payload.processing_time_ms ?? null,
      error: payload.error ?? null,
      createdBy: createdBy ?? null,
      updatedAt: new Date(),
    };
    // In a SAVEPOINT: the failure is logged and processing continues (the job already exists in the
    // gateway), and without it the request's transaction would be left aborted and
    // Postgres would turn its COMMIT into a ROLLBACK.
    try {
      await withSavepoint(() =>
        dbInstance
          .insert(ocrDocuments)
          .values(values)
          .onConflictDoUpdate({
            target: ocrDocuments.jobId,
            // `createdBy` is NOT touched on conflict: who sent the document
            // is what decides who can see it afterwards.
            set: {
              filename: values.filename ?? undefined,
              state: values.state,
              engine: values.engine,
              confidence: values.confidence,
              processingTimeMs: values.processingTimeMs,
              error: values.error,
              updatedAt: values.updatedAt,
            },
          })
      );
    } catch (e) {
      logger.warn("ocr_sync_row_failed", { jobId, error: String(e) });
    }
  }

  return { dbInstance, user: userValue, documentByJob, canOnJob, syncJobRow };
}

// ═══════════════════════════════════════════════════════════════════════════
// PROXY TO THE KONUSAGI GATEWAY — /gateway/* (legacy route: not an operation)
// ═══════════════════════════════════════════════════════════════════════════

export function proxyGateway(ctx: KonContext): Hono {
  const router = new Hono();
  const { auth, logger } = ctx;
  const requireAuth = auth.requireAuth;
  const { user: userValue, canOnJob, syncJobRow } = pieces(ctx);

  router.all("/gateway/*", requireAuth, async (c: Context) => {
    const user = userValue(c);
    if (!user) return c.json({ error: "Authentication required" }, 401);

    const url = new URL(c.req.url);
    const marker = "/gateway/";
    const idx = url.pathname.indexOf(marker);
    const subpath = url.pathname.slice(idx + marker.length);
    const [head, secondItem] = subpath.split("/");

    if (!head || !GATEWAY_ALLOWLIST.has(head) || !safeSubpath(subpath)) {
      return c.json({ error: "Gateway route not allowed" }, 404);
    }

    // ── Authorization by route shape ──
    const isExtract = c.req.method === "POST" && subpath === "jobs/extract";
    const esDeUnJob = head === "jobs" && Boolean(secondItem) && !isExtract && JOB_ID.test(secondItem);

    if (isExtract) {
      if (!(await can(user, "submit", {}, "vekstudio"))) {
        return c.json({ error: "Not authorized" }, 403);
      }
    } else if (esDeUnJob) {
      const action = c.req.method === "GET" || c.req.method === "HEAD" ? "view" : "edit";
      if (!(await canOnJob(user, action, secondItem))) {
        return c.json({ error: "Not found" }, 404);
      }
    } else if (!(await can(user, "operate", {}, "vekstudio"))) {
      return c.json({ error: "Not authorized" }, 403);
    }

    const target = `${gatewayBase()}/${subpath}${url.search}`;

    try {
      // Small interceptions to sync the local table
      const isJobDetail = c.req.method === "GET" && /^jobs\/[a-zA-Z0-9_-]+$/.test(subpath);

      if (isExtract || isJobDetail) {
        const upstream = await proxyTo(target, c);
        const contentType = upstream.headers.get("content-type") ?? "";
        if (upstream.ok && contentType.includes("application/json")) {
          const text = await upstream.text();
          try {
            const payload = JSON.parse(text);
            if (isExtract) {
              await syncJobRow(
                { job_id: payload.job_id, state: payload.status ?? "PENDING" },
                user.id
              );
            } else {
              await syncJobRow(payload);
            }
          } catch {
            /* non-JSON payload: forward as is */
          }
          return new Response(text, { status: upstream.status, headers: upstream.headers });
        }
        return upstream;
      }

      // Rest of the contract (including SSE /events): pure streaming
      return await proxyTo(target, c);
    } catch (e) {
      // The detail (internal host, network error) goes to the log, not to the client.
      logger.error("ocr_gateway_unreachable", { target, error: String(e) });
      return c.json({ error: "konusagi gateway unavailable" }, 502);
    }
  });

  return router;
}

export function vekstudioOperations(ctx: KonContext): AnyOperation[] {
  const router = registry();
  const { dbInstance, user: userValue, documentByJob } = pieces(ctx);

  // ═══════════════════════════════════════════════════════════════════════════
  // LOCAL TABLE — /documents
  // ═══════════════════════════════════════════════════════════════════════════

  router.get(
    "/documents",
    {
      id: "list-documents",
      summary: "List OCR documents",
      description:
        "The local mirror of OCR jobs (job id, file name, state, engine, confidence, linked KITSUDEN record, reviewed), oldest first. Admin sees every document; an editor only the ones they submitted. `limit` 1-500 (default 100). Admin or editor.",
      access: "session",
      // It was `requireAuth` + `require("submit")`, before anything else.
      permission: TEAM_ONLY,
      input: { query: LimitQuery },
      output: { schema: z.array(DocumentRecord) },
    },
    async (c) => {
      const user = userValue(c)!;
      const request = Number.parseInt(c.req.query("limit") ?? "100", 10);
      const limit = Number.isFinite(request) ? Math.min(Math.max(request, 1), 500) : 100;
      // Admin sees the whole queue; everyone else, only what they sent.
      const viewAll = await can(user, "operate", {}, "vekstudio");
      const rows = await dbInstance
        .select()
        .from(ocrDocuments)
        .where(viewAll ? undefined : eq(ocrDocuments.createdBy, user.id ?? ""))
        .orderBy(ocrDocuments.createdAt)
        .limit(limit);
      return c.json(rows);
    }
  );

  router.get(
    "/documents/:jobId",
    {
      id: "get-document",
      summary: "Read an OCR document",
      description:
        "One row of the OCR mirror by gateway job id. Admin, or the editor or agent who submitted it; anyone else gets 404 (the same as an unknown job, so it does not confirm which jobs exist).",
      access: "session",
      permission: ON_THE_DOCUMENT,
      input: { params: ParamJob },
      output: { schema: DocumentRecord },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, _input, h) => {
      const user = userValue(c);
      if (!user) return c.json({ error: "Authentication required" }, 401);
      const jobId = c.req.param("jobId") ?? "";
      if (!JOB_ID.test(jobId)) return c.json({ error: "not found" }, 404);
      const doc = await documentByJob(jobId);
      if (!doc || !(await h.can(doc, "view")) || !(await ownsOrOperates(user, doc))) {
        return c.json({ error: "not found" }, 404);
      }
      return c.json(doc);
    }
  );

  /** Link an OCR job to any KITSUDEN entity, or mark it reviewed. */
  router.patch(
    "/documents/:jobId",
    {
      id: "update-document",
      summary: "Link an OCR document or mark it reviewed",
      description:
        "Links an OCR job to any KITSUDEN record (`entityType` + `entityId`, null to unlink) and/or sets `reviewed`. Nothing else can change (unknown fields: 422 with every issue). Admin, or the editor or agent who submitted it; anyone else gets 404. Returns the updated row.",
      access: "session",
      permission: ON_THE_DOCUMENT,
      // The handler validates AFTER looking at the document: its 422 (`error` +
      // `issues`) is the usual one, and whoever cannot see it gets 404, not a 422.
      input: { params: ParamJob, body: DocumentChange, validatesHandler: true },
      output: { schema: DocumentRecord },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, _input, h) => {
      const user = userValue(c);
      if (!user) return c.json({ error: "Authentication required" }, 401);
      const jobId = c.req.param("jobId") ?? "";
      if (!JOB_ID.test(jobId)) return c.json({ error: "not found" }, 404);
      const doc = await documentByJob(jobId);
      if (!doc || !(await h.can(doc, "edit")) || !(await ownsOrOperates(user, doc))) {
        return c.json({ error: "not found" }, 404);
      }

      const parsed = DocumentChange.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(
          {
            error: "Invalid data",
            issues: parsed.error.issues.map((i) => ({
              field: i.path.join("."),
              problem: i.message,
            })),
          },
          422
        );
      }
      const body = parsed.data;
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (body.entityType !== undefined) set.entityType = body.entityType;
      if (body.entityId !== undefined) set.entityId = body.entityId;
      if (body.reviewed !== undefined) set.reviewed = body.reviewed;
      const rows = await dbInstance
        .update(ocrDocuments)
        .set(set)
        .where(eq(ocrDocuments.jobId, jobId))
        .returning();
      return c.json(rows[0]);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // AGGREGATED HEALTH — public (probes): only the status, no host or errors.
  // ═══════════════════════════════════════════════════════════════════════════

  router.get(
    "/health",
    {
      id: "get-health",
      summary: "Health of the OCR bridge",
      description:
        "For probes: ok when the vekdocs gateway answers its health check without an error status, degraded otherwise. Says nothing about where the gateway is. Public. Calls the gateway.",
      access: "public",
      output: { schema: z.object({ kon: z.literal("kon-vekstudio"), status: z.string() }) },
    },
    async (c) => {
      let ok = false;
      try {
        const r = await fetch(`${gatewayBase()}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        const gateway = (await r.json()) as Record<string, unknown>;
        ok = r.ok && gateway?.status !== "error";
      } catch {
        ok = false;
      }
      return c.json({ kon: "kon-vekstudio", status: ok ? "ok" : "degraded" });
    }
  );

  return router.ops;
}

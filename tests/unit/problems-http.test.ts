/**
 * A single error format: `application/problem+json` (RFC 9457)
 * ============================================================================
 *
 * `httpProblems()` is mounted in front of REAL pieces of the core and the
 * kons —`validateRequest` + `respondError` from the engine, the body limit,
 * the exhausted pool, Hono's `HTTPException`, shared's `KonError`, the
 * kon-ecommerce router— and the same shape is required of all of them:
 *
 *   type · title · status · detail · instance · code (KITSUDEN_E_*) ·
 *   retryable · retry_after · hint · docs · requestId · error (compatibility)
 *
 * The page-builder and games routes (the ones Inti uses) are tested
 * in inti-contract.test.ts, which also goes through this middleware.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AppError, respondError, validateRequest, validated } from "@kitsuden/engine";
import {
  KITSUDEN_ERRORS,
  KonError,
  KonErrors,
  buildProblem,
  errorCodeForStatus,
  errorCodeFromLegacy,
  parseRetryAfter,
} from "@kitsuden/shared";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { bodyLimit } from "../../.kitsuden/apps/api/src/lib/body-limit";
import { annotateIfPoolExhausted, poolExhaustedTo503 } from "../../.kitsuden/apps/api/src/lib/pool-exhausted";
import { readSqlFile } from "../../.kitsuden/apps/api/src/lib/sql-file";
import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { errorsWithoutDetail } from "../../.kitsuden/apps/api/src/middleware/errors-without-detail";
import {
  problemFromResponse,
  httpProblems,
} from "../../.kitsuden/apps/api/src/middleware/problems-http";
import { registerShopPolicies } from "../../kons/kon-ecommerce/shop.policy";
import { createShopRouter } from "../../kons/kon-ecommerce/shop.routes";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Checks the common shape and returns the body. */
async function problem(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  const p = (await res.json()) as Record<string, unknown>;
  for (const field of [
    "type",
    "title",
    "status",
    "detail",
    "code",
    "retryable",
    "retry_after",
    "hint",
    "docs",
    "error",
  ]) {
    expect(p, `missing «${field}»`).toHaveProperty(field);
  }
  expect(p.status).toBe(status);
  expect(String(p.code)).toMatch(/^KITSUDEN_E_[A-Z_]+$/);
  expect(p.type).toBe(p.docs);
  expect(String(p.docs)).toContain(`#${String(p.code).toLowerCase()}`);
  return p;
}

/** App with the error core as index.ts mounts it. */
function appWithErrors() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("requestId" as never, "req-123" as never);
    await next();
  });
  app.use("*", httpProblems());
  app.use("*", poolExhaustedTo503());
  app.use("*", errorsWithoutDetail(() => true));
  app.use("/api/*", bodyLimit(64));
  app.onError((err, c) => respondError(c, err));
  return app;
}

describe("real core pieces", () => {
  const app = appWithErrors();
  app.post(
    "/api/zod",
    validateRequest(z.object({ title: z.string(), tagIds: z.array(z.string()).optional() })),
    (c) => c.json(validated(c))
  );
  app.get("/api/app-error", () => {
    throw AppError.forbidden("You cannot edit this");
  });
  app.get("/api/http-exception", () => {
    throw new HTTPException(404, { message: "Does not exist" });
  });
  app.get("/api/kon-error", () => {
    throw KonErrors.notFound("Torneo", "t-9");
  });
  app.get("/api/kon-error-propio", () => {
    throw new KonError("Ya inscrito", "ALREADY_REGISTERED", 409);
  });
  app.get("/api/text", (c) => c.text("Unauthorized", 401));
  app.get("/api/limit", (c) => {
    c.header("Retry-After", "17");
    return c.json({ error: "Too Many Requests", message: "Rate limit exceeded" }, 429);
  });
  app.get("/api/pool", () => {
    annotateIfPoolExhausted(new Error("timeout exceeded when trying to connect"));
    throw new Error("timeout exceeded when trying to connect");
  });
  app.get("/api/roto", () => {
    throw new Error("SELECT * FROM secreto WHERE email = 'x'");
  });
  app.get("/api/legado", (c) =>
    c.json({ error: "Legacy API keys were retired", code: "LEGACY_KEY_RETIRED", status: "x" }, 401)
  );
  app.get("/api/bien", (c) => c.json({ ok: true }));
  app.post("/api/mcp", (c) =>
    c.json({ jsonrpc: "2.0", error: { code: -32000, message: "no" }, id: null }, 401)
  );
  app.post("/api/auth/sign-in/email", (c) =>
    c.json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, 401)
  );

  it("zod 422: VALIDATION, with the usual `error` object (code, message, details)", async () => {
    const res = await app.request("/api/zod", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Hola", tags: ["a"] }),
    });
    const p = await problem(res, 422);
    expect(p.code).toBe("KITSUDEN_E_VALIDATION");
    expect(p.retryable).toBe(false);
    const error = p.error as { code: string; details: { unknownKeys: Array<{ didYouMean: string }> } };
    expect(error.code).toBe("VALIDATION");
    expect(error.details.unknownKeys[0]!.didYouMean).toBe("tagIds");
    expect(p.requestId).toBe("req-123");
    expect(p.instance).toBe("/api/zod");
  });

  it("AppError 403 → FORBIDDEN with its message as `detail`", async () => {
    const p = await problem(await app.request("/api/app-error"), 403);
    expect(p.code).toBe("KITSUDEN_E_FORBIDDEN");
    expect(p.detail).toBe("You cannot edit this");
  });

  it("HTTPException 404 → NOT_FOUND (it used to come out as BAD_REQUEST)", async () => {
    const p = await problem(await app.request("/api/http-exception"), 404);
    expect(p.code).toBe("KITSUDEN_E_NOT_FOUND");
    expect((p.error as { code: string }).code).toBe("NOT_FOUND");
  });

  it("KonError respects its statusCode (it used to be 500) and its known code", async () => {
    const p = await problem(await app.request("/api/kon-error"), 404);
    expect(p.code).toBe("KITSUDEN_E_NOT_FOUND");
    expect(p.detail).toBe("Torneo not found: t-9");
    const q = await problem(await app.request("/api/kon-error-propio"), 409);
    expect(q.code).toBe("KITSUDEN_E_CONFLICT");
  });

  it("plain text 401 → UNAUTHENTICATED with the text as detail", async () => {
    const p = await problem(await app.request("/api/text"), 401);
    expect(p.code).toBe("KITSUDEN_E_UNAUTHENTICATED");
    expect(p.error).toBe("Unauthorized");
  });

  it("429 carries retryable and retry_after from the Retry-After header", async () => {
    const res = await app.request("/api/limit");
    const p = await problem(res, 429);
    expect(p.code).toBe("KITSUDEN_E_RATE_LIMITED");
    expect(p.retryable).toBe(true);
    expect(p.retry_after).toBe(17);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(p.error).toBe("Too Many Requests");
    expect(p.detail).toBe("Rate limit exceeded");
  });

  it("exhausted pool → 503 DB_POOL_EXHAUSTED retryable with Retry-After 5", async () => {
    const res = await app.request("/api/pool");
    const p = await problem(res, 503);
    expect(p.code).toBe("KITSUDEN_E_DB_POOL_EXHAUSTED");
    expect(p.retry_after).toBe(5);
    expect(res.headers.get("retry-after")).toBe("5");
  });

  it("500 in production: still does not show the internal detail (erroresSinDetalle runs inside)", async () => {
    const res = await app.request("/api/roto");
    const p = await problem(res, 500);
    expect(p.code).toBe("KITSUDEN_E_INTERNAL");
    expect(JSON.stringify(p)).not.toContain("secreto");
  });

  it("413 from the real body limit", async () => {
    const res = await app.request("/api/zod", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x".repeat(200) }),
    });
    const p = await problem(res, 413);
    expect(p.code).toBe("KITSUDEN_E_PAYLOAD_TOO_LARGE");
    expect(p.maxBytes).toBe(64);
  });

  it("an old `code` is translated to the catalog and its value is not lost (`legacy_*`)", async () => {
    const p = await problem(await app.request("/api/legado"), 401);
    expect(p.code).toBe("KITSUDEN_E_LEGACY_KEY_RETIRED");
    expect(p.legacy_code).toBe("LEGACY_KEY_RETIRED");
    expect(p.legacy_status).toBe("x");
  });

  it("correct responses are not touched", async () => {
    const res = await app.request("/api/bien");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("JSON-RPC (MCP) and better-auth keep their protocol", async () => {
    const mcp = await app.request("/api/mcp", { method: "POST" });
    expect(mcp.headers.get("content-type")).toContain("application/json");
    expect(await mcp.json()).toEqual({ jsonrpc: "2.0", error: { code: -32000, message: "no" }, id: null });
    const auth = await app.request("/api/auth/sign-in/email", { method: "POST" });
    expect((await auth.json()).code).toBe("INVALID_EMAIL_OR_PASSWORD");
  });

  it("a route that does not exist → 404 NOT_FOUND", async () => {
    const p = await problem(await app.request("/api/no-existe"), 404);
    expect(p.code).toBe("KITSUDEN_E_NOT_FOUND");
  });
});

describe("kon-ecommerce (real router): its own errors come out in the common format", () => {
  let client: PGlite;
  const app = appWithErrors();

  beforeAll(async () => {
    const MIG = resolve(ROOT, "kons/kon-ecommerce/migrations");
    client = await PGlite.create();
    for (const stmt of readSqlFile(resolve(MIG, "0001_shop.sql"), "0001_shop").statements) {
      await client.exec(stmt);
    }
    await client.exec(readFileSync(resolve(MIG, "0002_secure_orders.sql"), "utf8"));
    // 0008: payment, delivery, discount codes (the order insert writes its columns).
    await client.exec(readFileSync(resolve(MIG, "0008_checkout_delivery_coupons.sql"), "utf8"));
    registerShopPolicies();
    const ctx = createTestKonContext({
      db: { instance: drizzle(client), execute: async () => undefined, tableExists: async () => true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono middleware double
      auth: { requireAuth: (c: any) => c.json({ error: "no session" }, 401) } as any,
      konConfig: { "kon-ecommerce": { shippingFlatCents: 500, pickupNote: "Taller" } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
    } as any);
    app.route("/api/shop", createShopRouter(ctx));
  });
  afterAll(async () => {
    await client?.close();
  });

  it("invalid body → 422 VALIDATION, `error` is the kon's message", async () => {
    const res = await app.request("/api/shop/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
    const p = await problem(res, 422);
    expect(p.code).toBe("KITSUDEN_E_VALIDATION");
  });

  it("nonexistent product → 404 NOT_FOUND", async () => {
    const p = await problem(await app.request("/api/shop/products/no-existe"), 404);
    expect(p.code).toBe("KITSUDEN_E_NOT_FOUND");
  });

  it("panel without a session → 401 with the `error` the middleware used to send", async () => {
    const p = await problem(await app.request("/api/shop/admin/products"), 401);
    expect(p.error).toBe("no session");
    expect(p.code).toBe("KITSUDEN_E_UNAUTHENTICATED");
  });
});

describe("code catalog (@kitsuden/shared)", () => {
  it("each code has its entry in the public guide docs/install/errors-and-retries.md", () => {
    const guide = resolve(ROOT, ".kitsuden/docs/install/errors-and-retries.md");
    expect(existsSync(guide)).toBe(true);
    const text = readFileSync(guide, "utf8");
    for (const code of Object.keys(KITSUDEN_ERRORS)) {
      expect(text, code).toMatch(new RegExp(`^#+ \`${code}\``, "m"));
    }
  });

  it("retryable ones have a wait; the others do not announce one", () => {
    for (const [code, e] of Object.entries(KITSUDEN_ERRORS)) {
      if (e.retryable) expect((e as { retryAfter?: number }).retryAfter, code).toBeGreaterThan(0);
      expect(buildProblem({ code: code as never }).retry_after === null).toBe(!e.retryable);
    }
  });

  it("status → code, and old codes → catalog", () => {
    expect(errorCodeForStatus(404)).toBe("KITSUDEN_E_NOT_FOUND");
    expect(errorCodeForStatus(418)).toBe("KITSUDEN_E_BAD_REQUEST");
    expect(errorCodeForStatus(599)).toBe("KITSUDEN_E_INTERNAL");
    expect(errorCodeFromLegacy("VALIDATION_ERROR")).toBe("KITSUDEN_E_VALIDATION");
    expect(errorCodeFromLegacy("KITSUDEN_E_CONFLICT")).toBe("KITSUDEN_E_CONFLICT");
    expect(errorCodeFromLegacy("ALGO_RARO")).toBeNull();
  });

  it("Retry-After in seconds or as an HTTP date", () => {
    expect(parseRetryAfter("30")).toBe(30);
    const now = Date.parse("2026-10-23T10:00:00Z");
    expect(parseRetryAfter("Fri, 23 Oct 2026 10:00:10 GMT", now)).toBe(10);
    expect(parseRetryAfter("mañana")).toBeNull();
  });

  it("an array or empty body also comes out with the common shape", () => {
    const p = problemFromResponse({ status: 400, body: [1, 2] });
    expect(p).toMatchObject({ code: "KITSUDEN_E_BAD_REQUEST", data: [1, 2], error: "Bad request" });
    const q = problemFromResponse({ status: 502, text: "" });
    expect(q).toMatchObject({ code: "KITSUDEN_E_BAD_GATEWAY", retryable: true, retry_after: 5 });
  });
});

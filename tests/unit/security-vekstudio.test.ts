/**
 * kon-vekstudio (/api/ocr) — the gateway key is no longer anyone's
 * ============================================================================
 *
 * Audit 2026-10-15. The `/gateway/*` proxy adds the SERVER's `x-api-key`
 * and only asked for `requireAuth` (public sign-up). With a freshly
 * created account you could list everyone's OCR jobs, download their documents,
 * launch trainings, change the active model and read/edit the entire
 * `ocr_documents` table.
 *
 * Here we test with different users that each reaches their own and nothing
 * else, against PGlite with the real migration and `fetch` replaced.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { registerVekstudioPolicy } from "../../kons/kon-vekstudio/src/policy";
import { createOCRRouter } from "../../kons/kon-vekstudio/src/routes";

const here = dirname(fileURLToPath(import.meta.url));

let client: PGlite;
let app: Hono;
let session: { id: string; role: string } | null = null;
let calls: { url: string; method: string; headers: Record<string, string> }[] = [];
let nextJob = "a".repeat(32);

const ADMIN = { id: "u-admin", role: "admin" };
const ANA = { id: "u-ana", role: "editor" };
const BEA = { id: "u-bea", role: "editor" };
const ANYONE = { id: "u-alta", role: "user" };

beforeAll(async () => {
  client = await PGlite.create();
  await client.exec(
    readFileSync(
      resolve(here, "../../kons/kon-vekstudio/migrations/0000_initial.sql"),
      "utf8"
    )
  );
  registerVekstudioPolicy();
  const ctx = createTestKonContext({
    db: {
      instance: drizzle(client),
      execute: async () => undefined,
      tableExists: async () => true,
    },
    auth: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono middleware double
      requireAuth: (c: any, next: any) => {
        if (!session) return c.json({ error: "no session" }, 401);
        c.set("user", session);
        return next();
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
  } as any);
  app = new Hono();
  app.route("/", createOCRRouter(ctx));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  session = null;
  calls = [];
  process.env.VEKDOCS_GATEWAY_URL = "http://gateway.interno:8001";
  process.env.VEKDOCS_GATEWAY_API_KEY = "clave-del-servidor";
  await client.exec("DELETE FROM ocr_documents");
  // Two documents: one Ana's, one Bea's.
  await client.exec(
    "INSERT INTO ocr_documents (job_id, filename, created_by) VALUES " +
      `('${"1".repeat(32)}', 'nomina-ana.pdf', 'u-ana'), ('${"2".repeat(32)}', 'dni-bea.pdf', 'u-bea')`
  );
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, method: init?.method ?? "GET", headers });
    if (url.includes("caido")) throw new Error("connect ECONNREFUSED 10.1.2.3:8001");
    const body = url.endsWith("/jobs/extract") ? { job_id: nextJob, status: "PENDING" } : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const request = (
  method: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {}
) =>
  app.request(route, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("global gateway operation: admin only", () => {
  it.each([
    ["GET", "/gateway/jobs"],
    ["GET", "/gateway/events"],
    ["POST", "/gateway/training/start"],
    ["PUT", "/gateway/models/active"],
    ["GET", "/gateway/corrections"],
  ])("%s %s → 403 for a regular account and for the editor", async (m, r) => {
    session = ANYONE;
    expect((await request(m, r, m === "GET" ? undefined : {})).status).toBe(403);
    session = ANA;
    expect((await request(m, r, m === "GET" ? undefined : {})).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("the admin does, and the key is supplied by the server", async () => {
    session = ADMIN;
    expect((await request("GET", "/gateway/jobs")).status).toBe(200);
    expect(calls[0].headers["x-api-key"]).toBe("clave-del-servidor");
  });
});

describe("a document belongs to whoever submitted it", () => {
  const deAna = `/gateway/jobs/${"1".repeat(32)}`;

  it("Bea neither sees nor downloads Ana's job (404, without reaching the gateway)", async () => {
    session = BEA;
    expect((await request("GET", deAna)).status).toBe(404);
    expect((await request("GET", `${deAna}/input`)).status).toBe(404);
    expect((await request("DELETE", deAna)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("Ana does see hers", async () => {
    session = ANA;
    expect((await request("GET", deAna)).status).toBe(200);
  });

  it("a regular account cannot submit documents", async () => {
    session = ANYONE;
    expect((await request("POST", "/gateway/jobs/extract", {})).status).toBe(403);
  });

  it("on submission, the document is registered to whoever submits it", async () => {
    nextJob = "3".repeat(32);
    session = BEA;
    expect((await request("POST", "/gateway/jobs/extract", {})).status).toBe(200);
    const rows = await client.query<{ created_by: string }>(
      `SELECT created_by FROM ocr_documents WHERE job_id = '${"3".repeat(32)}'`
    );
    expect(rows.rows[0].created_by).toBe("u-bea");
    // Y Ana no lo ve.
    session = ANA;
    expect((await request("GET", `/documents/${"3".repeat(32)}`)).status).toBe(404);
  });

  it("GET /documents: each editor sees only their own; the admin sees everything", async () => {
    session = ANA;
    const onAnasList = await (await request("GET", "/documents")).json();
    expect(onAnasList.map((d: { createdBy: string }) => d.createdBy)).toEqual(["u-ana"]);

    session = ADMIN;
    expect(await (await request("GET", "/documents")).json()).toHaveLength(2);

    session = ANYONE;
    expect((await request("GET", "/documents")).status).toBe(403);
  });

  it("PATCH of someone else's document: 404; of your own, only allowed fields", async () => {
    session = BEA;
    expect((await request("PATCH", `/documents/${"1".repeat(32)}`, { reviewed: true })).status).toBe(
      404
    );

    session = ANA;
    const bad = await request("PATCH", `/documents/${"1".repeat(32)}`, { createdBy: "u-ana-2" });
    expect(bad.status).toBe(422);
    const good = await request("PATCH", `/documents/${"1".repeat(32)}`, { reviewed: true });
    expect(good.status).toBe(200);
    expect((await good.json()).createdBy).toBe("u-ana");
  });

  it("?limit=abc does not break the query", async () => {
    session = ADMIN;
    expect((await request("GET", "/documents?limit=abc")).status).toBe(200);
  });
});

describe("the proxy neither leaks nor lets itself be diverted", () => {
  it("does not forward the user's session", async () => {
    session = ADMIN;
    await request("GET", "/gateway/jobs", undefined, {
      authorization: "Bearer token-de-sesion",
      cookie: "kitsuden.session=abc",
    });
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].headers.cookie).toBeUndefined();
  });

  it("without a key on the server, a client x-api-key does not sneak through", async () => {
    delete process.env.VEKDOCS_GATEWAY_API_KEY;
    session = ADMIN;
    await request("GET", "/gateway/jobs", undefined, { "x-api-key": "la-que-yo-diga" });
    expect(calls[0].headers["x-api-key"]).toBeUndefined();
  });

  it.each(["jobs/..%2fadmin", "jobs/%2e%2e/x", "health/..%5c..%5cetc"])(
    "rejects %s",
    async (sub) => {
      session = ADMIN;
      expect((await request("GET", `/gateway/${sub}`)).status).toBe(404);
      expect(calls).toEqual([]);
    }
  );

  it("a network failure does not return the internal host", async () => {
    process.env.VEKDOCS_GATEWAY_URL = "http://caido:8001";
    session = ADMIN;
    const res = await request("GET", "/gateway/jobs");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("caido");
    expect(text).not.toContain("ECONNREFUSED");
  });

  it("/health does not say where it points", async () => {
    const body = await (await request("GET", "/health")).json();
    expect(body).not.toHaveProperty("upstream");
    expect(body).not.toHaveProperty("gateway");
  });
});

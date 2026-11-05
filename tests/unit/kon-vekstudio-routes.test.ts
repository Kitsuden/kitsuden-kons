/**
 * kon-vekstudio (/api/ocr): agents, validation, the mirror and the gateway bridge
 * ============================================================================
 *
 * `security-vekstudio` pins the 2026-10-15 audit with people (admin, two editors, a fresh
 * account): who reaches which gateway route, who sees which document, that the session and a
 * client `x-api-key` never travel upstream. `vekstudio-kon` pins the loading contract. What
 * neither covers, and is tested here:
 *
 *   · anonymous callers and AGENT keys, with and without the kon's scopes, on every operation and
 *     on the proxy; a denial beats `admin`;
 *   · `PATCH /documents/:jobId`: a 422 that lists EVERY problem, but a 404 (never a 422) for
 *     whoever may not see the document; what can and cannot change;
 *   · `limit` bounds and order of `/documents`;
 *   · the mirror sync: a re-submission never takes a document from its owner, a job id from the
 *     gateway that could form another route is never stored, a failed upstream stores nothing,
 *     a job's status is copied from the gateway's payload;
 *   · the bridge itself: query strings forwarded, forwarding headers dropped, the 30 s headers
 *     timeout as a 504, the health probe's verdicts, the gateway URL fallbacks.
 *
 * PGlite with the kon's migrations (listed from the folder: their names are changing) and `fetch`
 * stubbed: nothing here touches the network.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { registerVekstudioPolicy } from "../../kons/kon-vekstudio/src/policy";
import { createOCRRouter } from "../../kons/kon-vekstudio/src/routes";

const MIGRATIONS = resolve(__dirname, "../../kons/kon-vekstudio/migrations");

type Session = { id: string; role: string; scopes?: string[] } | null;

let client: PGlite;
let app: Hono;
let session: Session = null;

const ADMIN = { id: "u-admin", role: "admin" };
const ANA = { id: "u-ana", role: "editor" };
const BEA = { id: "u-bea", role: "editor" };
const ANYONE = { id: "u-alta", role: "user" };
const agent = (...scopes: string[]): Session => ({ id: "ag-ocr", role: "agent", scopes });

const ANA_JOB = "1".repeat(32);
const BEA_JOB = "2".repeat(32);
const AGENT_JOB = "4".repeat(32);
const GATEWAY = "http://gateway.internal:8001";

/** What the stubbed gateway was asked. */
let calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
/** How the stubbed gateway answers; each test may replace it. */
let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "VEKDOCS_GATEWAY_URL",
  "VEKOCR_GATEWAY_URL",
  "HARUOCR_GATEWAY_URL",
  "VEKDOCS_GATEWAY_API_KEY",
  "VEKOCR_GATEWAY_API_KEY",
  "HARUOCR_GATEWAY_API_KEY",
];

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  client = await PGlite.create();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await client.exec(readFileSync(resolve(MIGRATIONS, file), "utf8"));
  }
  registerVekstudioPolicy();
  const ctx = createTestKonContext({
    db: { instance: drizzle(client), execute: async () => undefined, tableExists: async () => true },
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
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await client?.close();
});

beforeEach(async () => {
  registerVekstudioPolicy();
  session = null;
  calls = [];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.VEKDOCS_GATEWAY_URL = GATEWAY;
  process.env.VEKDOCS_GATEWAY_API_KEY = "server-key";
  await client.exec("DELETE FROM ocr_documents");
  await client.exec(
    "INSERT INTO ocr_documents (job_id, filename, created_by, created_at) VALUES " +
      `('${ANA_JOB}', 'payslip-ana.pdf', 'u-ana', now() - interval '2 hours'), ` +
      `('${BEA_JOB}', 'id-bea.pdf', 'u-bea', now() - interval '1 hour')`
  );
  answer = (url) => (url.endsWith("/jobs/extract") ? jsonResponse({ job_id: "3".repeat(32), status: "PENDING" }) : jsonResponse({}));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, method: init?.method ?? "GET", headers });
    return answer(url, init);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const request = (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(route, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

const row = async (jobId: string) =>
  (await client.query<Record<string, unknown>>("SELECT * FROM ocr_documents WHERE job_id = $1", [jobId])).rows[0];

// ════════════════════════════════════════════════════════════════════════════

describe("without a session", () => {
  it.each([
    ["GET", "/documents"],
    ["GET", `/documents/${ANA_JOB}`],
    ["PATCH", `/documents/${ANA_JOB}`],
    ["GET", "/gateway/jobs"],
    ["POST", "/gateway/jobs/extract"],
    ["GET", `/gateway/jobs/${ANA_JOB}`],
  ])("%s %s is a 401 and never reaches the gateway", async (method, route) => {
    expect((await request(method, route, method === "GET" ? undefined : { reviewed: true })).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("the health probe is public", async () => {
    expect((await request("GET", "/health")).status).toBe(200);
  });
});

describe("agent keys", () => {
  it("a key with no vekstudio scope reaches nothing, document routes included", async () => {
    session = agent("mcp:connect");
    expect((await request("GET", "/documents")).status).toBe(403);
    expect((await request("GET", `/documents/${ANA_JOB}`)).status).toBe(403);
    expect((await request("PATCH", `/documents/${ANA_JOB}`, { reviewed: true })).status).toBe(403);
    expect((await request("POST", "/gateway/jobs/extract", {})).status).toBe(403);
    expect((await request("GET", "/gateway/models")).status).toBe(403);
    expect(calls).toEqual([]);
    expect((await row(ANA_JOB))!.reviewed).toBe(false);
  });

  it("`vekstudio:submit` sends documents in its own name and lists only those", async () => {
    session = agent("vekstudio:submit");
    expect((await request("GET", "/documents")).status).toBe(200);
    expect(await (await request("GET", "/documents")).json()).toEqual([]);
    expect((await request("POST", "/gateway/jobs/extract", {})).status).toBe(200);
    expect((await row("3".repeat(32)))!.created_by).toBe("ag-ocr");
    const listed = await (await request("GET", "/documents")).json();
    expect(listed.map((d: { jobId: string }) => d.jobId)).toEqual(["3".repeat(32)]);
    // Submitting is not operating the gateway.
    expect((await request("GET", "/gateway/jobs")).status).toBe(403);
  });

  it("`vekstudio:*` is the kon's admin: the whole queue and the gateway", async () => {
    session = agent("vekstudio:*");
    expect(await (await request("GET", "/documents")).json()).toHaveLength(2);
    expect((await request("GET", "/gateway/jobs")).status).toBe(200);
  });

  it("`user:act` lets an agent ask as an account, and an account that did not send it gets 404", async () => {
    session = agent("user:act");
    expect((await request("GET", `/documents/${ANA_JOB}`)).status).toBe(404);
    expect((await request("PATCH", `/documents/${ANA_JOB}`, { reviewed: true })).status).toBe(404);
  });

  it("a fine scope opens its own operation: `get-document` reads the agent's document, but does not edit", async () => {
    await client.exec(
      `INSERT INTO ocr_documents (job_id, filename, created_by) VALUES ('${AGENT_JOB}', 'agent.pdf', 'ag-ocr')`
    );
    session = agent("kon:vekstudio:get-document");
    const res = await request("GET", `/documents/${AGENT_JOB}`);
    expect(res.status).toBe(200);
    expect((await res.json()).filename).toBe("agent.pdf");
    expect((await request("PATCH", `/documents/${AGENT_JOB}`, { reviewed: true })).status).toBe(404);
    expect((await row(AGENT_JOB))!.reviewed).toBe(false);
  });

  it.each([
    ["kon:vekstudio:get-document", "kon:vekstudio:update-document"],
    ["vekstudio:view", "vekstudio:edit"],
    ["vekstudio:submit", "user:act"],
  ])("an agent with %s + %s neither reads nor edits another account's document (404)", async (...scopes) => {
    await client.exec(
      `INSERT INTO ocr_documents (job_id, filename, created_by) VALUES ('${AGENT_JOB}', 'agent.pdf', 'ag-ocr')`
    );
    session = agent(...scopes);
    expect((await request("GET", `/documents/${ANA_JOB}`)).status).toBe(404);
    expect((await request("PATCH", `/documents/${ANA_JOB}`, { reviewed: true })).status).toBe(404);
    expect((await row(ANA_JOB))!.reviewed).toBe(false);
    // Nor through the proxy, which never reaches the gateway for it.
    expect((await request("GET", `/gateway/jobs/${ANA_JOB}`)).status).toBe(404);
    expect((await request("DELETE", `/gateway/jobs/${ANA_JOB}`)).status).toBe(404);
    expect(calls).toEqual([]);
    // Its own document stays reachable with the scopes that grant it.
    if (!scopes.includes("vekstudio:submit")) {
      expect((await request("GET", `/documents/${AGENT_JOB}`)).status).toBe(200);
      const patched = await request("PATCH", `/documents/${AGENT_JOB}`, { reviewed: true });
      expect(patched.status).toBe(200);
      expect((await row(AGENT_JOB))!.reviewed).toBe(true);
    }
  });

  it("an agent that may operate (`vekstudio:operate`) reaches every document", async () => {
    session = agent("vekstudio:operate", "vekstudio:view");
    expect((await request("GET", `/documents/${ANA_JOB}`)).status).toBe(200);
  });

  it("a denial beats `admin`", async () => {
    session = agent("admin", "!kon:vekstudio:update-document", "!vekstudio:list-documents");
    expect((await request("PATCH", `/documents/${ANA_JOB}`, { reviewed: true })).status).toBe(403);
    expect((await request("GET", "/documents")).status).toBe(403);
    expect((await request("GET", `/documents/${ANA_JOB}`)).status).toBe(200);
  });
});

describe("GET /documents", () => {
  it("oldest first", async () => {
    session = ADMIN;
    const docs = await (await request("GET", "/documents")).json();
    expect(docs.map((d: { jobId: string }) => d.jobId)).toEqual([ANA_JOB, BEA_JOB]);
  });

  it("`limit` stays between 1 and 500", async () => {
    await client.exec(
      "INSERT INTO ocr_documents (job_id, created_by) SELECT 'bulk' || g, 'u-admin' FROM generate_series(1, 501) g"
    );
    session = ADMIN;
    expect(await (await request("GET", "/documents?limit=1")).json()).toHaveLength(1);
    expect(await (await request("GET", "/documents?limit=0")).json()).toHaveLength(1);
    expect(await (await request("GET", "/documents?limit=-20")).json()).toHaveLength(1);
    expect(await (await request("GET", "/documents?limit=100000")).json()).toHaveLength(500);
    expect(await (await request("GET", "/documents")).json()).toHaveLength(100);
  });

  it("a plain account is refused before anything is read", async () => {
    session = ANYONE;
    expect((await request("GET", "/documents")).status).toBe(403);
  });
});

describe("GET and PATCH /documents/:jobId", () => {
  it.each(["x".repeat(65), "has.dot", "a%20b"])("a job id like %s is a 404", async (jobId) => {
    session = ADMIN;
    expect((await request("GET", `/documents/${jobId}`)).status).toBe(404);
    expect((await request("PATCH", `/documents/${jobId}`, { reviewed: true })).status).toBe(404);
  });

  it("a job that is not in the mirror is a 404, also for the admin", async () => {
    session = ADMIN;
    expect((await request("GET", `/documents/${"f".repeat(32)}`)).status).toBe(404);
  });

  it("a plain account gets 404 on a document that exists, the same as on one that does not", async () => {
    session = ANYONE;
    const real = await request("GET", `/documents/${ANA_JOB}`);
    const fake = await request("GET", `/documents/${"f".repeat(32)}`);
    expect(real.status).toBe(404);
    expect(await real.text()).toBe(await fake.text());
  });

  it("an invalid body is one 422 that lists every problem", async () => {
    session = ANA;
    const res = await request("PATCH", `/documents/${ANA_JOB}`, {
      entityType: "not valid!",
      entityId: "",
      reviewed: "yes",
      createdBy: "u-ana-2",
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    const fields = body.issues.map((i: { field: string }) => i.field);
    expect(fields).toEqual(expect.arrayContaining(["entityType", "entityId", "reviewed"]));
    expect(body.issues.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(body.issues)).toContain("createdBy");
    expect(await row(ANA_JOB)).toMatchObject({ reviewed: false, created_by: "u-ana", entity_type: null });
  });

  it("a body that is not JSON is refused by the SDK before the handler (400) and changes nothing", async () => {
    session = ANA;
    expect((await request("PATCH", `/documents/${ANA_JOB}`, "{nope")).status).toBe(400);
    expect((await row(ANA_JOB))!.reviewed).toBe(false);
  });

  it("whoever may not see the document gets 404 even with an invalid body: no 422 confirms it exists", async () => {
    session = BEA;
    expect((await request("PATCH", `/documents/${ANA_JOB}`, { reviewed: "yes", junk: 1 })).status).toBe(404);
  });

  it("links, marks reviewed, unlinks with null, and nothing else moves", async () => {
    session = ANA;
    const before = await row(ANA_JOB);
    const linked = await request("PATCH", `/documents/${ANA_JOB}`, { entityType: "crm.deal", entityId: "deal-7", reviewed: true });
    expect(linked.status).toBe(200);
    expect(await linked.json()).toMatchObject({ jobId: ANA_JOB, entityType: "crm.deal", entityId: "deal-7", reviewed: true, createdBy: "u-ana", filename: "payslip-ana.pdf", state: "PENDING" });
    const unlinked = await (await request("PATCH", `/documents/${ANA_JOB}`, { entityType: null, entityId: null })).json();
    expect(unlinked).toMatchObject({ entityType: null, entityId: null, reviewed: true });
    const after = await row(ANA_JOB);
    expect(new Date(after!.updated_at as string).getTime()).toBeGreaterThanOrEqual(new Date(before!.updated_at as string).getTime());
    // Bea's document did not move.
    expect(await row(BEA_JOB)).toMatchObject({ reviewed: false, entity_type: null });
  });

  it("the admin may edit anyone's document", async () => {
    session = ADMIN;
    expect((await request("PATCH", `/documents/${BEA_JOB}`, { reviewed: true })).status).toBe(200);
    expect((await row(BEA_JOB))!.reviewed).toBe(true);
  });
});

describe("the mirror follows the gateway", () => {
  it("a re-submission that comes back with an existing job id does not take it from its owner", async () => {
    answer = () => jsonResponse({ job_id: ANA_JOB, status: "STARTED" });
    session = BEA;
    expect((await request("POST", "/gateway/jobs/extract", {})).status).toBe(200);
    expect(await row(ANA_JOB)).toMatchObject({ created_by: "u-ana", state: "STARTED" });
    expect((await request("GET", `/documents/${ANA_JOB}`)).status).toBe(404);
  });

  it.each([["../../admin"], ["x".repeat(65)], [12345], [null]])("a job id %s from the gateway is never stored", async (jobId) => {
    answer = () => jsonResponse({ job_id: jobId, status: "PENDING" });
    session = ANA;
    expect((await request("POST", "/gateway/jobs/extract", {})).status).toBe(200);
    const n = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM ocr_documents");
    expect(n.rows[0]!.n).toBe(2);
  });

  it("an upstream error is passed on and stores nothing", async () => {
    answer = () => jsonResponse({ job_id: "4".repeat(32), detail: "queue full" }, 503);
    session = ANA;
    const res = await request("POST", "/gateway/jobs/extract", {});
    expect(res.status).toBe(503);
    expect(await row("4".repeat(32))).toBeUndefined();
  });

  it("a non-JSON answer is passed on as it is and stores nothing", async () => {
    answer = () => new Response("accepted", { status: 200, headers: { "content-type": "text/plain" } });
    session = ANA;
    const res = await request("POST", "/gateway/jobs/extract", {});
    expect(await res.text()).toBe("accepted");
    expect(await client.query("SELECT 1 FROM ocr_documents WHERE created_by = 'u-ana' AND job_id <> $1", [ANA_JOB]).then((r) => r.rows)).toEqual([]);
  });

  it("reading a job copies its status from the gateway, and never its owner", async () => {
    answer = () =>
      jsonResponse({
        job_id: ANA_JOB,
        filename: "payslip-ana.pdf",
        state: "SUCCESS",
        meta: { engine: "paddle", confidence: 0.93, processing_time_ms: 1200 },
      });
    session = ANA;
    expect((await request("GET", `/gateway/jobs/${ANA_JOB}`)).status).toBe(200);
    expect(await row(ANA_JOB)).toMatchObject({ state: "SUCCESS", engine: "paddle", confidence: 0.93, processing_time_ms: 1200, created_by: "u-ana" });
  });

  it("the owner may delete their job upstream; another editor and a plain account may not", async () => {
    session = BEA;
    expect((await request("DELETE", `/gateway/jobs/${ANA_JOB}`)).status).toBe(404);
    session = ANYONE;
    expect((await request("DELETE", `/gateway/jobs/${ANA_JOB}`)).status).toBe(404);
    expect(calls).toEqual([]);
    session = ANA;
    expect((await request("DELETE", `/gateway/jobs/${ANA_JOB}`)).status).toBe(200);
    expect(calls).toEqual([expect.objectContaining({ url: `${GATEWAY}/jobs/${ANA_JOB}`, method: "DELETE" })]);
  });
});

describe("the bridge", () => {
  it("forwards the query string and the method, to the configured gateway", async () => {
    session = ADMIN;
    await request("GET", "/gateway/jobs?state=SUCCESS&limit=5");
    expect(calls[0]).toMatchObject({ url: `${GATEWAY}/jobs?state=SUCCESS&limit=5`, method: "GET" });
  });

  it("drops forwarding headers a client could forge", async () => {
    session = ADMIN;
    await request("GET", "/gateway/jobs", undefined, {
      "x-forwarded-for": "10.0.0.1",
      "x-real-ip": "10.0.0.1",
      "x-forwarded-host": "evil.example",
      "proxy-authorization": "Basic Zm9vOmJhcg==",
      "x-trace": "keep-me",
    });
    const sent = calls[0]!.headers;
    expect(sent["x-forwarded-for"]).toBeUndefined();
    expect(sent["x-real-ip"]).toBeUndefined();
    expect(sent["x-forwarded-host"]).toBeUndefined();
    expect(sent["proxy-authorization"]).toBeUndefined();
    expect(sent["x-trace"]).toBe("keep-me");
    expect(sent["x-api-key"]).toBe("server-key");
  });

  it.each(["/gateway/", "/gateway/admin", "/gateway/jobsx", "/gateway/jobs//x", "/gateway/jobs/a%20b"])(
    "%s is not a gateway route (404, no call)",
    async (route) => {
      session = ADMIN;
      expect((await request("GET", route)).status).toBe(404);
      expect(calls).toEqual([]);
    }
  );

  it("a gateway that does not send headers within 30 s is a 504, not a hung request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    answer = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    session = ADMIN;
    const pending = request("GET", "/gateway/models");
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await pending;
    expect(res.status).toBe(504);
    expect((await res.json()).code).toBe("KITSUDEN_E_TIMEOUT");
  });

  it("falls back to the older gateway variables, without a trailing slash", async () => {
    delete process.env.VEKDOCS_GATEWAY_URL;
    delete process.env.VEKDOCS_GATEWAY_API_KEY;
    process.env.VEKOCR_GATEWAY_URL = "http://old-gateway:9000///";
    process.env.HARUOCR_GATEWAY_API_KEY = "older-key";
    session = ADMIN;
    await request("GET", "/gateway/health");
    expect(calls[0]!.url).toBe("http://old-gateway:9000/health");
    expect(calls[0]!.headers["x-api-key"]).toBe("older-key");
  });
});

describe("the health probe", () => {
  it.each([
    ["the gateway says ok", () => jsonResponse({ status: "ok" }), "ok"],
    ["the gateway says error", () => jsonResponse({ status: "error" }), "degraded"],
    ["the gateway answers 503", () => jsonResponse({ status: "ok" }, 503), "degraded"],
    ["the gateway answers HTML", () => new Response("<html>", { status: 200 }), "degraded"],
    [
      "the gateway is down",
      () => {
        throw new Error("connect ECONNREFUSED 10.1.2.3:8001");
      },
      "degraded",
    ],
  ])("%s → %s, and nothing about where it is", async (_label, upstream, status) => {
    answer = upstream as typeof answer;
    const res = await request("GET", "/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kon: "kon-vekstudio", status });
    expect(calls[0]!.url).toBe(`${GATEWAY}/health`);
    // The probe does not hand the server's key to anything it calls.
    expect(calls[0]!.headers["x-api-key"]).toBeUndefined();
  });
});

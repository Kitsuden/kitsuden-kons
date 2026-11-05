/**
 * kon-ocr-training — real authorization and the LLM key that does not leave
 * ============================================================================
 *
 * Audit 2026-10-15. What there was:
 *
 *   · All routes asked only for `requireAuth`, and sign-up is public.
 *   · `PUT /vision-config` saved the body's `base_url`, and
 *     `POST /vision-config/test` sent the provider key to THAT host in
 *     `x-api-key`. Any account could take the key (and incidentally use the
 *     server to make requests wherever they wanted: SSRF).
 *   · The `/yomi/*` proxy forwarded the user's cookie/Authorization to the
 *     engine and accepted sub-routes with `%2f`/`..`.
 *   · The 502s returned the internal host and the network error.
 *
 * Against PGlite with the kon's real migration and `fetch` replaced: it
 * checks WHICH host the key is sent to, not just the status code.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { registerOcrTrainingPolicy } from "../../kons/kon-ocr-training/src/policy";
import { createOCRTrainingRouter } from "../../kons/kon-ocr-training/src/routes";

const here = dirname(fileURLToPath(import.meta.url));
const KEY = "sk-ant-SECRETO-DE-PRUEBA";

let client: PGlite;
let app: Hono;
let session: { id: string; role: string } | null = null;
let calls: { url: string; headers: Record<string, string> }[] = [];

beforeAll(async () => {
  client = await PGlite.create();
  await client.exec(
    readFileSync(
      resolve(here, "../../kons/kon-ocr-training/migrations/0000_vision_config.sql"),
      "utf8"
    )
  );
  const db = drizzle(client);
  registerOcrTrainingPolicy();

  const ctx = createTestKonContext({
    db: { instance: db, execute: async () => undefined, tableExists: async () => true },
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
  app.route("/", createOCRTrainingRouter(ctx));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  session = null;
  calls = [];
  process.env.VEKOCR_VISION_LLM_API_KEY = KEY;
  delete process.env.VEKOCR_VISION_LLM_BASE_URL;
  await client.exec("DELETE FROM ocr_vision_config");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, headers });
    if (url.includes("caido")) throw new Error("connect ECONNREFUSED 10.0.0.7:8000");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VEKOCR_URL;
});

const ADMIN = { id: "u-admin", role: "admin" };
const ANYONE = { id: "u-alta-publica", role: "user" };
const EDITOR = { id: "u-editora", role: "editor" };

const json = (
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

describe("only administration operates the kon", () => {
  const routes: [string, string][] = [
    ["GET", "/vision-config"],
    ["PUT", "/vision-config"],
    ["POST", "/vision-config/test"],
    ["POST", "/vision-reprocess/abc123"],
    ["GET", "/overview"],
    ["GET", "/yomi/proposals"],
    ["POST", "/yomi/train"],
  ];

  it.each(routes)("%s %s without a session → 401", async (m, r) => {
    expect((await json(m, r, m === "GET" ? undefined : {})).status).toBe(401);
  });

  it.each(routes)("%s %s with a regular account → 403", async (m, r) => {
    session = ANYONE;
    expect((await json(m, r, m === "GET" ? undefined : {})).status).toBe(403);
    // And nothing outside was ever called.
    expect(calls).toEqual([]);
  });

  it("the editor role (content) does not train the model either", async () => {
    session = EDITOR;
    expect((await json("POST", "/yomi/train", {})).status).toBe(403);
  });

  it("the admin does", async () => {
    session = ADMIN;
    expect((await json("GET", "/vision-config")).status).toBe(200);
  });
});

describe("the LLM key only travels to the provider configured on the server", () => {
  it("PUT with base_url is rejected (strict allowlist)", async () => {
    session = ADMIN;
    const res = await json("PUT", "/vision-config", {
      enabled: true,
      base_url: "https://atacante.example/robar",
    });
    expect(res.status).toBe(422);
    const rows = await client.query("SELECT base_url FROM ocr_vision_config");
    expect(rows.rows).toEqual([]);
  });

  it("a URL that was already stored in the database is IGNORED when testing the key", async () => {
    // What someone left written before the fix.
    await client.exec(
      "INSERT INTO ocr_vision_config (id, enabled, provider, base_url) " +
        "VALUES (1, true, 'anthropic', 'https://atacante.example')"
    );
    session = ADMIN;
    const res = await json("POST", "/vision-config/test", {});
    expect(res.status).toBe(200);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls.some((l) => l.url.includes("atacante"))).toBe(false);
  });

  it("the own gateway is declared on the server (VEKOCR_VISION_LLM_BASE_URL)", async () => {
    process.env.VEKOCR_VISION_LLM_BASE_URL = "https://llm-gateway.interno/";
    await client.exec(
      "INSERT INTO ocr_vision_config (id, enabled, provider) VALUES (1, true, 'openai')"
    );
    session = ADMIN;
    await json("POST", "/vision-config/test", {});
    expect(calls[0].url).toBe("https://llm-gateway.interno/chat/completions");
  });

  it("saving the config deletes an old base_url and does not return it", async () => {
    await client.exec(
      "INSERT INTO ocr_vision_config (id, provider, base_url) VALUES (1, 'anthropic', 'https://atacante.example')"
    );
    session = ADMIN;
    const res = await json("PUT", "/vision-config", { enabled: true, model: "claude-sonnet-4-5" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("atacante");
    expect(body).not.toHaveProperty("baseUrl");
    const rows = await client.query<{ base_url: string | null }>(
      "SELECT base_url FROM ocr_vision_config"
    );
    expect(rows.rows[0].base_url).toBeNull();
  });

  it("no response carries the key", async () => {
    session = ADMIN;
    const res = await json("GET", "/vision-config");
    expect(await res.text()).not.toContain(KEY);
  });
});

describe("proxy to the engine", () => {
  it("does not forward the user's session or a client x-api-key", async () => {
    session = ADMIN;
    await json("GET", "/yomi/status", undefined, {
      authorization: "Bearer token-de-sesion",
      cookie: "kitsuden.session=abc",
      "x-api-key": "la-que-yo-diga",
    });
    expect(calls).toHaveLength(1);
    const h = calls[0].headers;
    expect(h.authorization).toBeUndefined();
    expect(h.cookie).toBeUndefined();
    expect(h["x-api-key"]).toBeUndefined();
  });

  it.each(["proposals/..%2f..%2fadmin", "proposals/%2e%2e/secret", "train\\..\\x"])(
    "rejects sub-routes with escapes or jumps: %s",
    async (sub) => {
      session = ADMIN;
      expect((await json("GET", `/yomi/${sub}`)).status).toBe(404);
      expect(calls).toEqual([]);
    }
  );

  it("a network failure does not return the internal host or the error", async () => {
    process.env.VEKOCR_URL = "http://caido:8000";
    session = ADMIN;
    const res = await json("GET", "/yomi/status");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("caido");
    expect(text).not.toContain("ECONNREFUSED");
  });
});

describe("public health", () => {
  it("does not reveal upstream or whether there is a key", async () => {
    const res = await json("GET", "/health");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).not.toHaveProperty("upstream");
    expect(body).not.toHaveProperty("vision_llm_key_present");
  });
});

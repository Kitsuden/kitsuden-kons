/**
 * kon-vekstudio: pages of `GET /api/ocr/documents` (list-documents)
 * ============================================================================
 *
 * The list read the local `ocr_documents` mirror (a SQL table, not the OCR
 * gateway) with `limit` (1-500, default 100) and no way past it (api-contract,
 * 2026-11-18). It keeps that `limit`, takes `offset`, and orders by creation
 * then id. The body stays the bare array every client reads; whether more
 * follow is the `X-Has-More` header. Same harness as
 * kon-vekstudio-routes.test.ts: PGlite with the kon's migrations and `fetch`
 * stubbed out.
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

type Session = { id: string; role: string } | null;

let client: PGlite;
let app: Hono;
let session: Session = null;

const ADMIN = { id: "u-admin", role: "admin" };
const ANA = { id: "u-ana", role: "editor" };

const JOB_A = "1".repeat(32);
const JOB_B = "2".repeat(32);
const JOB_C = "3".repeat(32);
const JOB_D = "4".repeat(32);

beforeAll(async () => {
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
  await client?.close();
});

beforeEach(async () => {
  registerVekstudioPolicy();
  session = null;
  // Nothing here may reach the gateway.
  vi.stubGlobal("fetch", async () => {
    throw new Error("no network in this test");
  });
  await client.exec("DELETE FROM ocr_documents");
  // Three of Ana's jobs (two from one batch: the same instant) and one of somebody else.
  await client.exec(
    "INSERT INTO ocr_documents (job_id, filename, created_by, created_at) VALUES " +
      `('${JOB_A}', 'a.pdf', 'u-ana', '2030-01-01T10:00:00Z'), ` +
      `('${JOB_B}', 'b.pdf', 'u-ana', '2030-01-01T11:00:00Z'), ` +
      `('${JOB_C}', 'c.pdf', 'u-ana', '2030-01-01T11:00:00Z'), ` +
      `('${JOB_D}', 'd.pdf', 'u-bea', '2030-01-01T12:00:00Z')`
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function list(route: string) {
  const res = await app.request(route);
  return { status: res.status, hasMore: res.headers.get("x-has-more"), json: (await res.json()) as any };
}

const jobs = (rows: Array<{ jobId: string }>) => rows.map((r) => r.jobId);

describe("GET /documents pages", () => {
  it("without parameters: every document, oldest first, as a bare array, X-Has-More: false", async () => {
    session = ADMIN;
    const all = await list("/documents");
    expect(all.status).toBe(200);
    expect(Array.isArray(all.json)).toBe(true);
    expect(all.json).toHaveLength(4);
    expect(jobs(all.json)[0]).toBe(JOB_A);
    expect(jobs(all.json)[3]).toBe(JOB_D);
    expect(all.hasMore).toBe("false");
  });

  it("limit=1 has more; limit=1&offset=1 is the second row; walking visits each once", async () => {
    session = ADMIN;
    const all = jobs((await list("/documents")).json);
    const first = await list("/documents?limit=1");
    expect(jobs(first.json)).toEqual([all[0]]);
    expect(first.hasMore).toBe("true");
    const second = await list("/documents?limit=1&offset=1");
    expect(jobs(second.json)).toEqual([all[1]]);
    expect(second.hasMore).toBe("true");

    const walked: string[] = [];
    for (let offset = 0; offset < 4; offset++) {
      const page = await list(`/documents?limit=1&offset=${offset}`);
      walked.push(...jobs(page.json));
      expect(page.hasMore).toBe(String(offset < 3));
    }
    expect(walked).toEqual(all);
  });

  it("an editor pages only their own documents", async () => {
    session = ANA;
    const all = await list("/documents");
    expect(all.json).toHaveLength(3);
    expect(all.hasMore).toBe("false");
    const last = await list("/documents?limit=2&offset=2");
    expect(last.json).toHaveLength(1);
    expect(last.hasMore).toBe("false");
    expect(jobs(last.json)).not.toContain(JOB_D);
  });

  it("a negative offset is refused; the lenient limit still clamps", async () => {
    session = ADMIN;
    expect((await list("/documents?offset=-1")).status).toBe(422);
    expect((await list("/documents?limit=0")).json).toHaveLength(1);
  });
});

/**
 * kon-ingest: extracting and chunking, and who reaches which document
 * ============================================================================
 *
 * Two halves:
 *
 *   · The pure part (extract.ts): which types are read as they are, what HTML
 *     keeps, which types fail with `CannotExtract` (and so end `failed` instead of
 *     being retried), the OCR sidecar contract, and how text is cut into chunks.
 *   · The routes and the queue job against PGlite as a NON-superuser role, behind
 *     the core's per-request RLS host: both models are `owner`, so every document
 *     and chunk stays with whoever uploaded it, the admin of the kon sees them all,
 *     and an agent gets in only through its scopes.
 *
 * PGlite has no pgvector, so the three `vector` statements of 0000_models.sql are
 * left out here: the `embedding` column and its index are the only thing not
 * applied. Search is therefore checked for access and for the 503 of a server
 * without an embeddings provider, not for its ranking.
 */

import type { PGlite } from "@electric-sql/pglite";
import { PGlite as PGliteClass } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { configureQueue, type QueueJob } from "../../.kitsuden/packages/engine/src/queue";
import { configureEmbeddings } from "../../.kitsuden/packages/engine/src/semantics";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { kon, INGEST_QUEUE } from "../../kons/kon-ingest";
import { CannotExtract, chunk, extractText, textFromHtml } from "../../kons/kon-ingest/extract";
import { processDocument } from "../../kons/kon-ingest/job";

import { ACTORS, AGENT_FUNCTIONS, APP_ROLE, dropToAppRole, requestAs, testAuth } from "./helpers/safe-kons-bench";

// ── The pure part ───────────────────────────────────────────────────────────

describe("extractText", () => {
  it("reads plain text, markdown, CSV and JSON as they are, and ignores the charset", async () => {
    for (const mime of ["text/plain", "text/markdown", "text/csv", "application/json", "TEXT/PLAIN; charset=utf-8"]) {
      expect(await extractText(mime, "a,b\n# c")).toBe("a,b\n# c");
    }
  });

  it("keeps the text of HTML and drops tags, scripts, styles and entities", async () => {
    const html =
      "<html><head><style>p{color:red}</style><script>alert('x')</script></head>" +
      "<body><h1>Refunds</h1><p>Paid within 14&nbsp;days &amp; no fee.</p><noscript>enable js</noscript>" +
      "<p>Line<br>break &#65;&#x42;</p></body></html>";
    const text = await extractText("text/html", html);
    expect(text).toContain("Refunds");
    expect(text).toContain("Paid within 14 days & no fee.");
    expect(text).toContain("Line\nbreak AB");
    expect(text).not.toMatch(/alert|color:red|enable js|</);
    // Block ends become paragraph breaks, so the chunker sees the paragraphs.
    expect(textFromHtml("<p>one</p><p>two</p>").split(/\n\s*\n/).map((p) => p.trim())).toEqual(["one", "two"]);
  });

  it("fails with CannotExtract for a type it does not know", async () => {
    await expect(extractText("application/zip", "UEsDBA==")).rejects.toBeInstanceOf(CannotExtract);
    await expect(extractText("application/zip", "UEsDBA==")).rejects.toThrow("Unsupported type: application/zip");
  });

  const require = createRequire(resolve(__dirname, "../../kons/kon-ingest/extract.ts"));
  const hasUnpdf = (() => {
    try {
      require.resolve("unpdf");
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(hasUnpdf)("without the optional 'unpdf', a PDF fails with a message that says how to fix it", async () => {
    const err = await extractText("application/pdf", Buffer.from("%PDF-1.4").toString("base64")).catch((e) => e);
    expect(err).toBeInstanceOf(CannotExtract);
    expect(err.message).toContain("pnpm add unpdf");
  });

  describe("images through the OCR sidecar", () => {
    const before = process.env.OCR_SIDECAR_URL;
    afterEach(() => {
      vi.unstubAllGlobals();
      if (before === undefined) delete process.env.OCR_SIDECAR_URL;
      else process.env.OCR_SIDECAR_URL = before;
    });

    it("without OCR_SIDECAR_URL an image cannot be read, and that is final", async () => {
      delete process.env.OCR_SIDECAR_URL;
      await expect(extractText("image/png", "iVBORw0KGgo=")).rejects.toBeInstanceOf(CannotExtract);
    });

    it("sends the decoded bytes with their type and takes { text } back", async () => {
      process.env.OCR_SIDECAR_URL = "http://ocr.test/read";
      const calls: Array<{ url: string; init: RequestInit }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ text: "INVOICE 42" }), { status: 200 });
      });
      expect(await extractText("image/png", Buffer.from("png-bytes").toString("base64"))).toBe("INVOICE 42");
      expect(calls[0]!.url).toBe("http://ocr.test/read");
      expect(calls[0]!.init.method).toBe("POST");
      expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe("image/png");
      expect(Buffer.from(calls[0]!.init.body as Uint8Array).toString()).toBe("png-bytes");
    });

    it("a sidecar that answers without text is final; one that is down is transient (it is retried)", async () => {
      process.env.OCR_SIDECAR_URL = "http://ocr.test/read";
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ words: [] }), { status: 200 }));
      await expect(extractText("image/jpeg", "AA==")).rejects.toBeInstanceOf(CannotExtract);

      vi.stubGlobal("fetch", async () => new Response("busy", { status: 503 }));
      const err = await extractText("image/jpeg", "AA==").catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CannotExtract);
      expect(err.message).toContain("503");
    });
  });
});

describe("chunk", () => {
  it("keeps a short text in one chunk and drops empty paragraphs", () => {
    expect(chunk("one\n\n\n\ntwo")).toEqual(["one\n\ntwo"]);
    expect(chunk("   \n\n  ")).toEqual([]);
    expect(chunk("a\r\n\r\nb")).toEqual(["a\n\nb"]);
  });

  it("starts a new chunk at a markdown heading, without overlap across it", () => {
    const parts = chunk("Intro text.\n\n# Refunds\n\nPaid in 14 days.\n\n## Shipping\n\nThree days.");
    expect(parts).toEqual(["Intro text.", "# Refunds\n\nPaid in 14 days.", "## Shipping\n\nThree days."]);
  });

  it("closes a chunk before it passes `max`, and carries an overlap from its end into the next", () => {
    const p1 = "alpha ".repeat(15).trim(); // 89 characters
    const p2 = "beta ".repeat(15).trim(); // 74 characters
    const parts = chunk(`${p1}\n\n${p2}`, 120, 30);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(p1);
    // The overlap starts at a word boundary: the first, cut word is dropped.
    expect(parts[1]!.endsWith(`\n\n${p2}`)).toBe(true);
    const carried = parts[1]!.slice(0, parts[1]!.indexOf("\n\n"));
    expect(carried.length).toBeGreaterThan(0);
    expect(carried.length).toBeLessThanOrEqual(30);
    expect(p1.endsWith(carried)).toBe(true);
    expect(carried.startsWith("alpha")).toBe(true);
  });

  it("with overlap 0 the chunks do not repeat text", () => {
    const parts = chunk(`${"a".repeat(80)}\n\n${"b".repeat(80)}`, 100, 0);
    expect(parts).toEqual(["a".repeat(80), "b".repeat(80)]);
  });

  it("cuts a paragraph longer than `max` by sentences, and a sentence longer than `max` bluntly", () => {
    const sentences = ["First sentence here.", "Second one is here!", "Third, is it?"].join(" ");
    const bySentence = chunk(sentences, 25, 0);
    expect(bySentence).toEqual(["First sentence here.", "Second one is here!", "Third, is it?"]);

    const blunt = chunk("x".repeat(250), 100, 0);
    expect(blunt).toEqual(["x".repeat(100), "x".repeat(100), "x".repeat(50)]);
    for (const c of chunk(`${"word ".repeat(400)}`, 300, 50)) expect(c.length).toBeLessThanOrEqual(300 + 50 + 2);
  });

  it("uses ~1,200 characters with a 150-character overlap by default", () => {
    const paragraph = `${"lorem ipsum ".repeat(50).trim()}.`; // ~600 characters
    const parts = chunk(Array.from({ length: 6 }, () => paragraph).join("\n\n"));
    expect(parts.length).toBeGreaterThan(1);
    for (const c of parts) expect(c.length).toBeLessThanOrEqual(1200 + 150 + 2);
  });
});

// ── The routes and the job, on PGlite with RLS ──────────────────────────────

let client: PGlite;
let request: ReturnType<typeof requestAs>;
let ctx: ReturnType<typeof createTestKonContext>;
const json = (res: Response): Promise<any> => res.json();
const dispatched: Array<{ queue: string; name: string; payload: any; options: any }> = [];

function job(documentId: string): QueueJob {
  return { id: "job-1", queue: INGEST_QUEUE, name: "document", payload: { documentId }, attempt: 1, maxAttempts: 3, actor: null, requestId: null };
}

beforeAll(async () => {
  client = new PGliteClass();
  await client.exec(readFileSync(AGENT_FUNCTIONS, "utf8"));
  const dir = resolve(__dirname, "../../kons/kon-ingest/migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(resolve(dir, file), "utf8")
      .split("\n")
      .filter((line) => !/vector/.test(line))
      .join("\n");
    await client.exec(sql);
  }
  await client.exec(`
    CREATE ROLE ${APP_ROLE} NOLOGIN;
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
  `);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  ctx = createTestKonContext({ db: host.db as never, auth: auth as never } as never);
  request = requestAs(host.mount(kon.createRouter(ctx)));
  configureQueue({
    dispatch: async (queue, name, payload, options) => {
      dispatched.push({ queue, name, payload, options });
      return { id: `q-${dispatched.length}` };
    },
  });
});

afterAll(async () => {
  configureQueue(null);
  configureEmbeddings(null);
  await client?.close();
});

beforeEach(() => {
  dispatched.length = 0;
});

async function ingest(actor: Parameters<typeof request>[0], body: Record<string, unknown>) {
  return request(actor, "POST", "/documents/ingest", body);
}

/** Raw rows as the system (the superuser that migrated), to look past RLS. */
async function rows(sql: string, params: unknown[] = []): Promise<any[]> {
  await client.exec("RESET ROLE");
  try {
    return (await client.query(sql, params)).rows as any[];
  } finally {
    await client.exec(`SET ROLE ${APP_ROLE}`);
  }
}

describe("ingesting", () => {
  it("needs a session", async () => {
    expect((await ingest("anon", { title: "T", mimeType: "text/plain", content: "x" })).status).toBe(401);
  });

  it("takes exactly one of content or contentBase64", async () => {
    expect((await ingest("a", { title: "T", mimeType: "text/plain" })).status).toBe(422);
    expect((await ingest("a", { title: "T", mimeType: "text/plain", content: "x", contentBase64: "eA==" })).status).toBe(422);
    expect((await ingest("a", { title: "", mimeType: "text/plain", content: "x" })).status).toBe(422);
    expect(dispatched).toHaveLength(0);
  });

  it("stores the document as its uploader's, answers 202 pending and queues the job in the same request", async () => {
    const res = await ingest("a", { title: "Handbook", mimeType: "text/markdown", content: "# Refunds\n\nPaid in 14 days." });
    expect(res.status).toBe(202);
    const body = await json(res);
    const doc = body.data ?? body;
    expect(doc).toMatchObject({ status: "pending" });
    expect(dispatched).toEqual([
      { queue: "kitsuden-ingest", name: "document", payload: { documentId: doc.id }, options: { attempts: 3 } },
    ]);
    const [stored] = await rows("SELECT owner_id, title, status FROM ingest_documents WHERE id = $1", [doc.id]);
    expect(stored).toEqual({ owner_id: ACTORS.a.id, title: "Handbook", status: "pending" });
  });

  it("an agent without the document scopes is refused; with them it may ingest", async () => {
    expect((await ingest({ agent: ["mcp:connect"] }, { title: "T", mimeType: "text/plain", content: "x" })).status).toBe(403);
    expect((await ingest({ agent: ["chunk:write"] }, { title: "T", mimeType: "text/plain", content: "x" })).status).toBe(403);
    expect(dispatched).toHaveLength(0);
    const ok = await ingest({ agent: ["document:write"] }, { title: "By agent", mimeType: "text/plain", content: "x" });
    expect(ok.status).toBe(202);
    expect(dispatched).toHaveLength(1);
  });
});

describe("processing and ownership", () => {
  let docA: string;
  let docB: string;

  beforeAll(async () => {
    const a = await json(await ingest("a", { title: "Refunds", mimeType: "text/html", content: "<h1>Refunds</h1><p>A refund is paid within 14 days.</p><p>Ask support.</p>" }));
    docA = (a.data ?? a).id;
    const b = await json(await ingest("b", { title: "Shipping", mimeType: "text/plain", content: "Shipping takes three days." }));
    docB = (b.data ?? b).id;
  });

  it("the job extracts, chunks, keeps the owner on every chunk and queues one embedding per chunk", async () => {
    await processDocument(job(docA), ctx);
    const [doc] = await rows("SELECT status, chunks, error, content FROM ingest_documents WHERE id = $1", [docA]);
    expect(doc).toMatchObject({ status: "done", chunks: 1, error: null });
    // Text documents keep their content; only binaries are emptied.
    expect(doc.content).toContain("Refunds");
    const chunks = await rows("SELECT owner_id, position, text FROM ingest_chunks WHERE document_id = $1 ORDER BY position", [docA]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ owner_id: ACTORS.a.id, position: 0 });
    expect(chunks[0].text).toContain("A refund is paid within 14 days.");
    expect(chunks[0].text).not.toContain("<p>");
    expect(dispatched).toEqual([
      {
        queue: "kitsuden-embeddings",
        name: "embed:ingest_chunks",
        payload: expect.objectContaining({ table: "ingest_chunks", columns: ["text"], dimensions: 1536 }),
        options: { attempts: 5 },
      },
    ]);
  });

  it("is idempotent: running the job again replaces the chunks instead of adding more", async () => {
    await processDocument(job(docA), ctx);
    expect(await rows("SELECT id FROM ingest_chunks WHERE document_id = $1", [docA])).toHaveLength(1);
  });

  it("a type it cannot read ends `failed` with its error, and the job does not throw (no retry)", async () => {
    const res = await json(await ingest("a", { title: "Archive", mimeType: "application/zip", contentBase64: "UEsDBA==" }));
    const id = (res.data ?? res).id;
    await expect(processDocument(job(id), ctx)).resolves.toBeUndefined();
    const [doc] = await rows("SELECT status, error, chunks FROM ingest_documents WHERE id = $1", [id]);
    expect(doc).toEqual({ status: "failed", error: "Unsupported type: application/zip", chunks: 0 });
  });

  it("a job for a document deleted while it waited does nothing; a job without a document is permanent", async () => {
    await expect(processDocument(job("00000000-0000-4000-8000-000000000000"), ctx)).resolves.toBeUndefined();
    await expect(processDocument({ ...job(""), payload: {} }, ctx)).rejects.toThrow("job without document");
  });

  it("each account sees only its own documents and chunks", async () => {
    await processDocument(job(docB), ctx);
    const listA = (await json(await request("a", "GET", "/documents"))).data as any[];
    expect(listA.map((d) => d.id)).toContain(docA);
    expect(listA.map((d) => d.id)).not.toContain(docB);
    expect((await request("b", "GET", `/documents/${docA}`)).status).toBe(404);
    expect((await request("a", "GET", `/documents/${docA}`)).status).toBe(200);

    const chunksB = (await json(await request("b", "GET", "/chunks"))).data as any[];
    expect(chunksB.length).toBeGreaterThan(0);
    expect(chunksB.every((c) => c.text.includes("Shipping"))).toBe(true);
  });

  it("another account can neither change nor delete a document that is not theirs", async () => {
    expect((await request("b", "PATCH", `/documents/${docA}`, { title: "Mine now" })).status).toBe(404);
    expect((await request("b", "DELETE", `/documents/${docA}`)).status).toBe(404);
    const [doc] = await rows("SELECT title FROM ingest_documents WHERE id = $1", [docA]);
    expect(doc.title).toBe("Refunds");
  });

  it("the site admin administers the kon and sees every document", async () => {
    const all = (await json(await request("admin", "GET", "/documents"))).data as any[];
    expect(all.map((d) => d.id)).toEqual(expect.arrayContaining([docA, docB]));
  });

  it("the database itself keeps the rows apart (RLS), not only the route's filter", async () => {
    await client.exec("BEGIN");
    try {
      await client.query("SELECT set_config('app.current_user_id', $1, true), set_config('app.current_user_role', 'user', true)", [ACTORS.b.id]);
      const seen = (await client.query<{ id: string }>("SELECT id FROM ingest_documents")).rows.map((r) => r.id);
      expect(seen).toContain(docB);
      expect(seen).not.toContain(docA);
      await expect(
        client.query("INSERT INTO ingest_chunks (document_id, position, text, owner_id) VALUES ($1, 0, 'x', $2)", [docA, ACTORS.a.id])
      ).rejects.toThrow(/row-level security/);
    } finally {
      await client.exec("ROLLBACK");
    }
  });

  it("a document created with create-document is queued for processing too", async () => {
    const res = await request("a", "POST", "/documents", { title: "Direct", mimeType: "text/plain", content: "Created directly." });
    expect(res.status).toBe(201);
    const body = await json(res);
    const id = (body.data ?? body).id;
    expect(dispatched).toEqual([
      { queue: "kitsuden-ingest", name: "document", payload: { documentId: id }, options: { attempts: 3 } },
    ]);
    await processDocument(job(id), ctx);
    const [doc] = await rows("SELECT status, chunks FROM ingest_documents WHERE id = $1", [id]);
    expect(doc).toEqual({ status: "done", chunks: 1 });
  });

  it("deleting a document deletes its chunks in the same transaction", async () => {
    const res = await json(await ingest("a", { title: "Short-lived", mimeType: "text/plain", content: "Gone soon." }));
    const id = (res.data ?? res).id;
    await processDocument(job(id), ctx);
    expect(await rows("SELECT id FROM ingest_chunks WHERE document_id = $1", [id])).toHaveLength(1);
    expect((await request("a", "DELETE", `/documents/${id}`)).status).toBe(204);
    expect(await rows("SELECT id FROM ingest_chunks WHERE document_id = $1", [id])).toHaveLength(0);
    // Other documents keep theirs.
    expect((await rows("SELECT id FROM ingest_chunks WHERE document_id = $1", [docA])).length).toBeGreaterThan(0);
  });

  it("an agent reads documents only with `document:read`", async () => {
    expect((await request({ agent: ["mcp:connect"] }, "GET", "/documents")).status).toBe(403);
    expect((await request({ agent: ["document:read"] }, "GET", "/documents")).status).toBe(200);
  });
});

describe("semantic search", () => {
  it("needs a session", async () => {
    expect((await request("anon", "GET", "/chunks/search?q=refunds")).status).toBe(401);
  });

  it("answers 503 on a server without an embeddings provider", async () => {
    configureEmbeddings(null);
    expect((await request("a", "GET", "/chunks/search?q=refunds")).status).toBe(503);
  });
});

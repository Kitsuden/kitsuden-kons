/**
 * kon-ingest — document ingestion: extract, chunk, search by meaning
 * ============================================================================
 *
 *   POST /api/ingest/documents/ingest   { title, mimeType, content | contentBase64 }
 *        → 202 { id, status: "pending" }. The job goes to the Postgres queue
 *          (`kitsuden-ingest`), atomic with the document insert.
 *   GET  /api/ingest/documents/:id      the status (pending → processing → done | failed)
 *   GET  /api/ingest/chunks/search?q=   the most similar passages (D5)
 *   … and the rest of the operations of the two models (list, get, delete).
 *   `create-document` queues the same job as the ingest route, so a document
 *   created either way is processed. Deleting a document deletes its chunks in
 *   the same transaction (trigger in migrations/0003_delete_chunks_with_document.sql).
 *
 * Optional and outside the engine, as the plan asks: the heavy stuff (PDF, OCR)
 * is an optional dependency or a sidecar (see extract.ts). Everything about a
 * document belongs to its owner: the RLS of both models is `owner`.
 */
import {
  defineKonSdk,
  modelOperations,
  queue,
  registerModelPolicies,
  type AnyOperation,
} from "@kitsuden/engine";
import { defineOperation, type KonContext, type KonDefinition } from "@kitsuden/shared";
import { z } from "@kitsuden/engine/zod";

import manifest from "./kon.json" with { type: "json" };

import { document, chunk } from "./ingest.model";
import { ingestDocuments } from "./tables";
import { processDocument } from "./job";

export const INGEST_QUEUE = "kitsuden-ingest";
/** What fits in a request (in base64 a third more): the API body limit is 10 MB. */
const MAX_CONTENT = 7 * 1024 * 1024;

const Input = z
  .object({
    title: z.string().trim().min(1).max(300),
    mimeType: z.string().trim().min(3).max(120),
    content: z.string().max(MAX_CONTENT).optional(),
    contentBase64: z.string().max(Math.ceil((MAX_CONTENT * 4) / 3)).optional(),
  })
  .refine((v) => Boolean(v.content) !== Boolean(v.contentBase64), {
    message: "Send exactly one of content (text) or contentBase64 (binary)",
  });

const ingest = defineOperation({
  id: "ingest-document",
  method: "POST",
  route: "/documents/ingest",
  summary: "Ingest a document",
  description:
    "Stores the document and queues its processing: text is extracted (text, markdown, HTML; PDF with the optional 'unpdf'; images through an OCR sidecar), split into chunks and embedded for semantic search. Poll get-document for the status, then use search-chunks.",
  tags: ["model:document"],
  input: { body: Input },
  output: { status: 202, schema: z.object({ id: z.string(), status: z.string() }) },
  access: "session",
  permission: { scopes: ["document:write"], policy: { resource: "document", action: "write" } },
  handle: async ({ body }, h) => {
    await h.authorize();
    const e = body as z.infer<typeof Input>;
    const me = String(h.user?.id ?? "");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the kon's db is the host's Drizzle one
    const [row] = (await (h.ctx.db.instance as any)
      .insert(ingestDocuments)
      .values({ title: e.title, mimeType: e.mimeType, content: e.content ?? e.contentBase64!, ownerId: me })
      .returning({ id: ingestDocuments.id, status: ingestDocuments.status })) as { id: string; status: string }[];
    // In the SAME transaction: if the insert is rolled back, there is no job.
    await enqueueProcessing(row!.id);
    return row;
  },
});

/** Queues the processing job of a document (inside the request's transaction). */
function enqueueProcessing(documentId: string) {
  return queue.dispatch(INGEST_QUEUE, "document", { documentId }, { attempts: 3 });
}

/**
 * The generated `create-document`, plus the processing job: a document created
 * directly is processed like an ingested one, never left `pending` forever.
 */
function processesOnCreate(op: AnyOperation): AnyOperation {
  if (op.id !== "create-document") return op;
  return {
    ...op,
    description: `${op.description} Its processing is queued, as with ingest-document.`,
    handle: async (input, h) => {
      const row = (await op.handle(input, h)) as { id: string };
      await enqueueProcessing(row.id);
      return row;
    },
  };
}

const MODELS = [document, chunk];
const KON_ID = "kon-ingest";

// defineModelsKon, spelled out so that `create-document` can queue the job.
const base = defineKonSdk({
  id: KON_ID,
  name: manifest.name,
  version: manifest.version,
  description: "Extracts, chunks and embeds documents for semantic search (PDF and OCR optional).",
  mountPath: manifest.mount.path,
  tables: [...manifest.tables],
  operations: [...MODELS.flatMap((m) => modelOperations(KON_ID, m)).map(processesOnCreate), ingest],
  hooks: {
    onStartup: async (ctx: KonContext) => {
      queue.handle(INGEST_QUEUE, (job) => processDocument(job, ctx), { concurrency: 1 });
    },
  },
});
registerModelPolicies(KON_ID, MODELS);

export const kon: KonDefinition = {
  ...base,
  createRouter: (ctx: KonContext) => {
    // After a `resetAuthz()` (tests) the model policies have to come back.
    registerModelPolicies(KON_ID, MODELS);
    return base.createRouter(ctx);
  },
};

export default kon;

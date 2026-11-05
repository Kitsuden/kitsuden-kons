/**
 * kon-ingest — the queue job: extract, chunk, save and enqueue the embeddings
 *
 * Runs in the queue worker (RLS transaction with the owner, re-read). It does
 * so as the SYSTEM (`asSystem`) because it writes the chunks and the status
 * of a document that was already authorized when it was enqueued. Idempotent:
 * if repeated, it deletes any existing chunks and creates them again.
 */
import {
  asSystem,
  PermanentError,
  queue,
  type QueueJob,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { eq } from "drizzle-orm";

import { extractText, CannotExtract, chunk } from "./extract";
import { ingestChunks, ingestDocuments } from "./tables";

const EMBEDDINGS_QUEUE = "kitsuden-embeddings";
const BINARIES = /^(application\/pdf|image\/)/i;

export async function processDocument(job: QueueJob, ctx: KonContext): Promise<void> {
  const id = (job.payload as { documentId?: string })?.documentId;
  if (!id) throw new PermanentError("job without document");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the kon's db is the host's Drizzle one
  const db = ctx.db.instance as any;

  const doc = await asSystem(async () => {
    const [d] = await db.select().from(ingestDocuments).where(eq(ingestDocuments.id, id)).limit(1);
    if (d) await db.update(ingestDocuments).set({ status: "processing", error: null }).where(eq(ingestDocuments.id, id));
    return d as { id: string; ownerId: string | null; mimeType: string; content: string | null } | undefined;
  });
  if (!doc) return; // deleted while it waited

  let chunks: string[];
  try {
    chunks = chunk(await extractText(doc.mimeType, doc.content ?? ""));
  } catch (err) {
    // No possible fix (unsupported type, missing `unpdf` or sidecar): the
    // DOCUMENT is left `failed` with its error and the job ends without throwing
    // (throwing would roll back the job's transaction, and that status with it).
    // A transient failure (network, OCR down) does throw: the queue retries it.
    if (err instanceof CannotExtract) {
      await asSystem(() =>
        db
          .update(ingestDocuments)
          .set({ status: "failed", error: err.message.slice(0, 2000) })
          .where(eq(ingestDocuments.id, id))
      );
      return;
    }
    throw err;
  }

  await asSystem(async () => {
    await db.delete(ingestChunks).where(eq(ingestChunks.documentId, id));
    for (let i = 0; i < chunks.length; i++) {
      const [c] = await db
        .insert(ingestChunks)
        .values({ documentId: id, position: i, text: chunks[i], ownerId: doc.ownerId })
        .returning({ id: ingestChunks.id });
      // The embedding of each chunk, as defineModel enqueues it (D5).
      await queue.dispatch(
        EMBEDDINGS_QUEUE,
        "embed:ingest_chunks",
        { table: "ingest_chunks", id: c.id, columns: ["text"], dimensions: 1536 },
        { attempts: 5 }
      );
    }
    await db
      .update(ingestDocuments)
      .set({
        status: "done",
        chunks: chunks.length,
        // The binary is no longer needed: the text lives in the chunks.
        ...(BINARIES.test(doc.mimeType) ? { content: null } : {}),
      })
      .where(eq(ingestDocuments.id, id));
  });
}

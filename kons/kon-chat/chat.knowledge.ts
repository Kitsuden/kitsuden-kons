/**
 * What a bot knows: documents in chunks, and finding the right ones for a question
 * ============================================================================
 *
 * A document is cut into chunks of about 800 characters along paragraph and sentence boundaries, with a little
 * overlap so an idea split across two chunks is found from either. With an embeddings provider in the core
 * (`ctx.ai.embed`), each chunk gets a vector and a question finds the closest chunks; without one, by the words
 * they share. A kon must not search with made-up vectors, so there is no third way.
 *
 * Two kinds of document: the bot's knowledge, which every conversation searches, and an attachment, which only
 * its own conversation does ("what does this PDF say?").
 *
 * Where the database has pgvector, chunks also get a vector column and the closest ones are found in SQL;
 * otherwise in memory, over the bot's chunks. Live data, such as a deal's stage, is never copied here: a team
 * bot reads it with tools, under the reader's rules, at the moment of asking.
 */

import { createId } from "@paralleldrive/cuid2";
import { and, eq, isNull, or, sql } from "drizzle-orm";

import { chatChunks, chatDocuments } from "./chat.schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the host's Drizzle instance
type Db = any;
type Embed = ((texts: string[]) => Promise<number[][] | null>) | undefined;

const TARGET = 800;
const OVERLAP = 120;
/** A bot's chunks searched in memory when there is no pgvector. */
export const MAX_CHUNKS_PER_BOT = 5000;

/** Paragraphs first, then sentences, then hard cuts: a chunk ends where a reader would pause. */
export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (!clean) return [];
  const pieces: string[] = [];
  for (const paragraph of clean.split(/\n\s*\n/)) {
    if (paragraph.length <= TARGET) pieces.push(paragraph.trim());
    else {
      for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
        for (let i = 0; i < sentence.length; i += TARGET) pieces.push(sentence.slice(i, i + TARGET).trim());
      }
    }
  }
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces.filter(Boolean)) {
    if (current && current.length + piece.length + 2 > TARGET) {
      chunks.push(current);
      current = `${current.slice(-OVERLAP).replace(/^\S*\s/, "")}\n\n${piece}`;
    } else current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

const rowsOf = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? [])) as Record<string, unknown>[];

let vectorColumn: Promise<boolean> | null = null;

/** Whether this database gave chunks a pgvector column (the migration adds it only where pgvector exists). */
export function hasVectorColumn(db: Db): Promise<boolean> {
  vectorColumn ??= (async () => {
    try {
      const r = await db.execute(
        sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'chat_chunks' AND column_name = 'embedding_vec'`
      );
      return rowsOf(r).length > 0;
    } catch {
      return false;
    }
  })();
  return vectorColumn;
}

/** For tests: forget what was learned about the database. */
export function resetVectorCache(): void {
  vectorColumn = null;
}

const literal = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;

export async function addDocument(
  db: Db,
  embed: Embed,
  input: { botId: string; conversationId?: string; title: string; content: string; createdBy: string | null }
): Promise<{ id: string; chunkCount: number; embedded: boolean }> {
  const chunks = chunkText(input.content);
  const [counted] = await db.select({ n: sql<number>`count(*)::int` }).from(chatChunks).where(eq(chatChunks.botId, input.botId));
  if (!(await hasVectorColumn(db)) && Number(counted?.n ?? 0) + chunks.length > MAX_CHUNKS_PER_BOT) {
    throw Object.assign(new Error(`Without pgvector a bot holds at most ${MAX_CHUNKS_PER_BOT} chunks`), { code: "too-much" });
  }
  const vectors = chunks.length && embed ? await embed(chunks.map((c) => `${input.title}\n\n${c}`)) : null;
  const id = createId();
  await db.insert(chatDocuments).values({
    id,
    botId: input.botId,
    conversationId: input.conversationId ?? null,
    title: input.title,
    content: input.content,
    chunkCount: chunks.length,
    embedded: !!vectors,
    createdBy: input.createdBy,
  });
  if (chunks.length) {
    const rows = chunks.map((text, ordinal) => ({
      id: createId(),
      documentId: id,
      botId: input.botId,
      conversationId: input.conversationId ?? null,
      ordinal,
      text,
      embedding: vectors?.[ordinal] ?? null,
    }));
    await db.insert(chatChunks).values(rows);
    if (vectors && (await hasVectorColumn(db))) {
      for (const row of rows) {
        if (row.embedding) await db.execute(sql`UPDATE chat_chunks SET embedding_vec = ${literal(row.embedding)}::vector WHERE id = ${row.id}`);
      }
    }
  }
  return { id, chunkCount: chunks.length, embedded: !!vectors };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2)
  );

export interface Found {
  documentId: string;
  title: string;
  text: string;
  score: number;
  attachment: boolean;
}

const MIN_SIMILARITY = 0.2;

/**
 * The chunks closest to a question, among the bot's knowledge and this conversation's attachments: by vectors
 * when there are any (in SQL with pgvector), by shared words otherwise.
 */
export async function search(
  db: Db,
  embed: Embed,
  botId: string,
  question: string,
  options: { conversationId?: string; limit?: number } = {}
): Promise<Found[]> {
  const limit = options.limit ?? 4;
  const scope = and(
    eq(chatChunks.botId, botId),
    options.conversationId ? or(isNull(chatChunks.conversationId), eq(chatChunks.conversationId, options.conversationId)) : isNull(chatChunks.conversationId)
  );
  const vector = embed ? (await embed([question]))?.[0] : undefined;

  if (vector && (await hasVectorColumn(db))) {
    const convo = options.conversationId ?? null;
    const r = await db.execute(sql`
      SELECT c.document_id AS "documentId", d.title, c.text, c.conversation_id AS "conversationId",
             1 - (c.embedding_vec <=> ${literal(vector)}::vector) AS score
        FROM chat_chunks c JOIN chat_documents d ON d.id = c.document_id
       WHERE c.bot_id = ${botId}
         AND (c.conversation_id IS NULL OR c.conversation_id = ${convo})
         AND c.embedding_vec IS NOT NULL AND vector_dims(c.embedding_vec) = ${vector.length}
       ORDER BY c.embedding_vec <=> ${literal(vector)}::vector
       LIMIT ${limit}`);
    return rowsOf(r)
      .map((x) => ({ documentId: String(x.documentId), title: String(x.title), text: String(x.text), score: Number(x.score), attachment: x.conversationId != null }))
      .filter((f) => f.score >= MIN_SIMILARITY);
  }

  const rows: Array<{ documentId: string; title: string; text: string; embedding: number[] | null; conversationId: string | null }> = await db
    .select({ documentId: chatChunks.documentId, title: chatDocuments.title, text: chatChunks.text, embedding: chatChunks.embedding, conversationId: chatChunks.conversationId })
    .from(chatChunks)
    .innerJoin(chatDocuments, eq(chatDocuments.id, chatChunks.documentId))
    .where(scope)
    .limit(MAX_CHUNKS_PER_BOT);
  if (rows.length === 0) return [];
  const withVectors = rows.filter((r) => Array.isArray(r.embedding) && r.embedding.length > 0);
  let scored: Found[];
  if (vector && withVectors.length) {
    scored = withVectors
      .map((r) => ({ documentId: r.documentId, title: r.title, text: r.text, score: cosine(vector, r.embedding!), attachment: r.conversationId != null }))
      .filter((f) => f.score >= MIN_SIMILARITY);
  } else {
    const asked = words(question);
    scored = rows
      .map((r) => {
        const have = words(`${r.title} ${r.text}`);
        let shared = 0;
        for (const w of asked) if (have.has(w)) shared++;
        return { documentId: r.documentId, title: r.title, text: r.text, score: asked.size ? shared / asked.size : 0, attachment: r.conversationId != null };
      })
      .filter((f) => f.score > 0);
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** What the model reads before the question, numbered so it can say where an answer came from. */
export function contextOf(found: Found[]): string {
  return found.map((f, i) => `[${i + 1}] ${f.attachment ? "(attached) " : ""}${f.title}\n${f.text}`).join("\n\n---\n\n");
}

interface IngestaBridge {
  extractText(mime: string, content: string): Promise<string>;
}

const INGESTA = "../kon-ingest/extract";
const PLAIN = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

/**
 * The text of an attached file. Plain text is read here; PDF, HTML and images go through kon-ingest when it is
 * installed next to this kon (a PDF needs its optional `unpdf`, an image its OCR sidecar).
 */
export async function textOfFile(mime: string, content: string): Promise<string> {
  const type = mime.toLowerCase().split(";")[0]!.trim();
  if (PLAIN.has(type)) return content;
  let bridge: IngestaBridge;
  try {
    bridge = (await import(/* @vite-ignore */ INGESTA)) as IngestaBridge;
  } catch {
    throw Object.assign(new Error(`Reading ${type} files needs kon-ingest`), { code: "cannot-read" });
  }
  try {
    return await bridge.extractText(type, content);
  } catch (err) {
    throw Object.assign(new Error((err as Error).message), { code: "cannot-read" });
  }
}

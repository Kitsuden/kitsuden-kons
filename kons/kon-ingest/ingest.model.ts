/**
 * kon-ingest — the models
 *
 *   document  what was uploaded: title, type, processing status and, while it
 *             waits, its content (text, or base64 if binary; emptied when done).
 *   chunk     the text chunks of a document, with SEMANTIC SEARCH
 *             (D5): `search-chunks?q=` finds passages by their meaning.
 *
 * The embedding dimensions (1536, that of text-embedding-3-small) have to
 * match the API's provider: with a local model of 384 or 768, change them here
 * and generate the migration (`kitsuden makemigrations --kon ingest`).
 */
import { field, defineModel } from "@kitsuden/shared";

export const STATUSES = ["pending", "processing", "done", "failed"] as const;

export const document = defineModel({
  name: "document",
  table: "ingest_documents",
  description: "A document sent for ingestion: its text is extracted and split into searchable chunks in the background.",
  fields: {
    title: field.text({ max: 300, required: true }),
    mimeType: field.text({ max: 120, required: true }),
    status: field.enum([...STATUSES], { required: true, defaultValue: "pending" }),
    error: field.longText({ max: 2000 }),
    chunks: field.integer({ min: 0, required: true, defaultValue: 0 }),
    content: field.longText({ description: "The raw content while it waits (text, or base64 for binaries); cleared once processed." }),
  },
  access: { read: "owner", write: "owner" },
});

export const chunk = defineModel({
  name: "chunk",
  table: "ingest_chunks",
  description: "A passage of an ingested document. Search them by meaning with search-chunks.",
  fields: {
    documentId: field.text({ max: 36, required: true, index: true }),
    position: field.integer({ min: 0, required: true }),
    text: field.longText({ required: true }),
  },
  access: { read: "owner", write: "owner" },
  semantics: { fields: ["text"], dimensions: 1536 },
});

# kon-ingest — document ingestion

Extracts the text of a document, splits it into chunks and makes the chunks searchable by meaning. For
projects that want their users (or agents) to upload documents and search them. The heavy parts (PDF,
OCR) are an optional dependency or a sidecar, never inside the API.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| experimental | documents | 0.1.1 | `/api/ingest` | — (pgvector in the database; the core's embeddings provider for search) |

## Install

```bash
kitsuden kon add ingest --enable
```

Run it inside a Kitsuden project, then restart the API. The kon is off by default (`defaultEnabled: false`),
so pass `--enable` or switch it on in the admin panel (**Kons**).

- The first migration runs `CREATE EXTENSION IF NOT EXISTS vector`: the database needs pgvector available.
- Search needs the core's embeddings provider; without one, `GET /api/ingest/chunks/search` answers 503.
- PDF: `pnpm add unpdf` (optional peer dependency). Without it, PDF documents end `failed`.
- Images: run an OCR sidecar and set `OCR_SIDECAR_URL`. Without it, image documents end `failed`.

## What it adds

Two models, declared with `defineModel` in `ingest.model.ts`:

| Table | Model | What it holds |
| --- | --- | --- |
| `ingest_documents` | `document` | What was uploaded: `title`, `mime_type`, `status` (`pending`, `processing`, `done`, `failed`), `error`, `chunks` (count), and `content` while it waits (text, or base64 for binaries; emptied for PDF and images once done). |
| `ingest_chunks` | `chunk` | Passages of a document: `document_id`, `position`, `text`, and an `embedding vector(1536)` with an HNSW index. |

Both rows carry `owner_id`: everything about a document belongs to whoever uploaded it.

How a document is processed:

1. `POST /api/ingest/documents/ingest` stores the document and, in the same transaction, queues a job on the
   Postgres queue `kitsuden-ingest` (3 attempts). It answers `202 { id, status: "pending" }`.
2. The job extracts the text, cuts it into chunks (by paragraph, up to about 1,200 characters, with a
   150-character overlap; a markdown heading starts a new chunk), replaces any earlier chunks of that
   document, and queues one embedding job per chunk on `kitsuden-embeddings` (5 attempts).
3. The document ends `done` with its chunk count. A document that cannot be read (unsupported type, missing
   `unpdf` or sidecar, a sidecar answer without `text`) ends `failed` with its `error` and is not retried;
   a transient failure (sidecar down, network) is retried by the queue.

| Type | How |
| --- | --- |
| `text/plain`, `text/markdown`, `text/csv`, `application/json` | as is |
| `text/html` | tags, scripts and styles removed, entities decoded |
| `application/pdf` (send `contentBase64`) | optional peer `unpdf` |
| `image/*` (send `contentBase64`) | `POST` of the bytes to `OCR_SIDECAR_URL`, which answers `{ "text": "..." }` (120 s timeout) |

```http
POST /api/ingest/documents/ingest
{ "title": "Handbook", "mimeType": "text/markdown", "content": "# ..." }
-> 202 { "id": "...", "status": "pending" }
```

Send exactly one of `content` (text, up to 7 MB) or `contentBase64` (binary).

## HTTP API

Most routes are generated from the two models by the core (`modelOperations`); one is the kon's own.

| Method and path | Operation | What it does |
| --- | --- | --- |
| `POST /api/ingest/documents/ingest` | `ingest-document` | Store a document and queue its processing. 202. |
| `GET /api/ingest/documents/_model` | `describe-document` | Fields, access policy and scopes of the model. |
| `GET /api/ingest/documents` | `list-documents` | Your documents, newest first; `limit`, `offset`, `sort` and filters by field. |
| `GET /api/ingest/documents/:id` | `get-document` | One document; poll it for `status`. |
| `POST /api/ingest/documents` | `create-document` | Insert a document row directly. Its processing is queued, as with the ingest route. |
| `PATCH /api/ingest/documents/:id` | `update-document` | Change fields of one of your documents. |
| `DELETE /api/ingest/documents/:id` | `delete-document` | Delete one of your documents (204). Its chunks are deleted in the same transaction. |
| `GET /api/ingest/chunks/_model` | `describe-chunk` | Fields, access policy and scopes of the model. |
| `GET /api/ingest/chunks` | `list-chunks` | Your chunks; filter with `documentId`. |
| `GET /api/ingest/chunks/search` | `search-chunks` | `q` (required) and `limit` (1-50, default 10): your chunks closest in meaning, with `score` (1 = identical). |
| `GET /api/ingest/chunks/:id` | `get-chunk` | One chunk. |
| `POST /api/ingest/chunks` | `create-chunk` | Insert a chunk directly; its embedding is queued. |
| `PATCH /api/ingest/chunks/:id` | `update-chunk` | Change fields of one of your chunks. |
| `DELETE /api/ingest/chunks/:id` | `delete-chunk` | Delete one of your chunks (204). |

Every route needs a session (an account or an agent key). Chunks written moments ago may not be searchable
yet: their embedding is computed in the background.

## Who can do what

There is no hand-written policy file: the core registers the `document` and `chunk` policies from the
models (`access: { read: "owner", write: "owner" }` in `ingest.model.ts`).

| Who | Can |
| --- | --- |
| Anonymous | Nothing (401). |
| Any signed-in account | Ingest, read, search, change and delete their own documents and chunks. |
| Site admin | Everything, on every user's rows. |
| Agent | Only through scopes: `document:read`, `document:write`, `chunk:read`, `chunk:write`, the fine `kon:ingest:<operation>`, `ingest:*` or `admin`. An agent's rows are owned by its own identity. |

Row security on both tables (`migrations/0002_english_rls.sql`): a row is visible and writable when its
`owner_id` is the caller, or the caller is the system, a human admin, or an agent whose key opens the whole
kon (`ingest:*`, `kon:ingest:*`, `admin`). Another user's document or chunk answers 404, the same as one
that does not exist.

## Configuration

| Env var | Read by | Purpose |
| --- | --- | --- |
| `OCR_SIDECAR_URL` | `extract.ts` | URL that receives image bytes (`POST`, `content-type` of the image) and answers `{ "text": "..." }`. |

The embedding size is 1536 (the `chunk` model's `semantics.dimensions`). With a local embeddings model of
another size, change it in `ingest.model.ts` and in `job.ts`, and generate a migration with
`kitsuden makemigrations --kon ingest`.

## Agents and MCP

Every route above is an SDK operation and an MCP tool named `ingest__<operation>`: `ingest__ingest-document`,
`ingest__describe-document`, `ingest__list-documents`, `ingest__get-document`, `ingest__create-document`,
`ingest__update-document`, `ingest__delete-document`, `ingest__describe-chunk`, `ingest__list-chunks`,
`ingest__search-chunks`, `ingest__get-chunk`, `ingest__create-chunk`, `ingest__update-chunk`,
`ingest__delete-chunk`.

| Need | Scope |
| --- | --- |
| Ingest, change, delete documents | `document:write` (or `kon:ingest:<operation>`) |
| Read and list documents | `document:read` |
| Search, read chunks | `chunk:read` |
| Write chunks directly | `chunk:write` |

The two `DELETE` operations are sensitive: with human approval on, an agent gets
`202 KITSUDEN_E_APPROVAL_REQUIRED`. See [AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/kon-ingest.test.ts` | Extraction by type, the OCR sidecar, chunking, the ingest route, the job, ownership and row security, agent scopes, search without embeddings. |

```bash
pnpm vitest run tests/unit/kon-ingest.test.ts
```

kon-chat imports this kon's `extract.ts` to read PDF, HTML and image attachments; no test covers that
import.

## License

MIT.

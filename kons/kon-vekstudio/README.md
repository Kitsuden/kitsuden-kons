# kon-vekstudio

Bridge to the vekdocs OCR gateway (konusagi): forwards the gateway's contract under `/api/ocr/gateway` so
the vekstudio frontend works unchanged behind a Kitsuden login, and keeps a local table that links each OCR
job to a Kitsuden record. For teams that run the vekocr/vekdocs stack next to Kitsuden.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| experimental | documents | 1.0.1 | `/api/ocr` | — (core `auth`; a reachable vekdocs gateway) |

## Install

```bash
kitsuden kon add vekstudio --enable
```

Run it inside a Kitsuden project, then restart the API. The kon is off by default (`defaultEnabled: false`),
so pass `--enable` or switch it on in the admin panel (**Kons**). Set `VEKDOCS_GATEWAY_URL` if the gateway
is not at the Docker default, and `VEKDOCS_GATEWAY_API_KEY` if the gateway requires a key (see
[Configuration](#configuration)). Point vekstudio at the bridge with
`window.__vekstudio_config = { gatewayUrl: '/api/ocr/gateway' }`.

## What it adds

- **A proxy** at `/api/ocr/gateway/*` (any method, including multipart uploads and the server-sent events
  of `events`) to the gateway's `jobs`, `corrections`, `training`, `models`, `health` and `events` routes.
  The server adds the gateway key; the browser never sees it.
- **A local mirror**, the table `ocr_documents`: one row per OCR job (`job_id`, `filename`, `state`,
  `engine`, `confidence`, `processing_time_ms`, `error`), who sent it (`created_by`), an optional link to
  any Kitsuden record (`entity_type`, `entity_id`) and a `reviewed` flag. The source of truth for jobs stays
  in the gateway.

The proxy keeps the mirror in step on two calls only: submitting a job (`jobs/extract`, which records the
sender) and reading one job (`jobs/<id>`, which copies its state but never changes its owner). Everything
else, files and the event stream included, is streamed through untouched.

## HTTP API

| Method and path | Who | What it does |
| --- | --- | --- |
| `GET /api/ocr/documents` | Admin, editor | The mirror, oldest first. An admin sees every job; an editor only the ones they sent. `limit` 1-500 (default 100). |
| `GET /api/ocr/documents/:jobId` | Admin, or the editor or agent who sent it | One row by gateway job id; 404 for anyone else and for a job not in the mirror. |
| `PATCH /api/ocr/documents/:jobId` | Admin, or the editor or agent who sent it | Set `entityType` + `entityId` (null to unlink) and/or `reviewed`. Unknown fields: 422 listing every issue. 404 for anyone else. Returns the row. |
| `GET /api/ocr/health` | Anyone | `{ kon, status }`: `ok` when the gateway's health check answers without an error status, `degraded` otherwise. |

The proxy `/api/ocr/gateway/*` is a legacy route, not an SDK operation and not an MCP tool. It needs a
session, and authorizes by the shape of the request:

| Request to the gateway | Needs |
| --- | --- |
| `POST jobs/extract` (submit a document) | `submit`: admin or editor. The sender is recorded. |
| Anything under `jobs/<id>` | `view` (GET, HEAD) or `edit` (other methods) on that job: admin, or the editor or agent who sent it. Otherwise 404. |
| Everything else (job list, events, corrections, training, models) | `operate`: admin only. |

Sub-paths outside the allowlist, with `..` or `%` escapes, answer 404. The caller's cookies, `Authorization`
and `x-api-key` are never forwarded. 504 when the gateway sends no headers within 30 s; 502 when it is
unreachable.

## Who can do what

The policy is `src/policy.ts` (resource `vekstudio`), deny by default:

| Action | Allowed |
| --- | --- |
| `submit` | `admin`, `editor` |
| `view`, `edit` (one document) | `admin`, or an `editor` whose id is the row's `created_by`; an agent only on rows it sent, unless it may `operate` |
| `operate` | `admin` |
| `actAsUser` | The core's rule for agents acting as an account (`user:act`, `admin`, or a `vekstudio` scope) |

Plain accounts get 403 on the list and 404 on single documents; anonymous callers get 401. A document that
exists but is not yours answers 404, the same as one that does not exist, so the API never confirms which
jobs exist. A job missing from the mirror is visible only to an admin through the proxy.

Agents pass with `admin`, `vekstudio:*` (the kon's admin), the policy scopes (`vekstudio:submit`,
`vekstudio:view`, `vekstudio:edit`, `vekstudio:operate`), or the fine scope of one operation
(`kon:vekstudio:<operation>`). A denial on the key wins. The sender rule binds agents too: a scope that grants `view` or
`edit` (or the fine scope of `get-document` / `update-document`) opens only the documents the agent sent, and
any other answers 404. Only an agent that may `operate` (`admin`, `vekstudio:*`, `vekstudio:operate`) reaches
every document. The table has no row security: ownership is checked in the routes.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `VEKDOCS_GATEWAY_URL` | `http://gateway_api:8001` | The gateway. Fallbacks, in order: `VEKOCR_GATEWAY_URL`, `HARUOCR_GATEWAY_URL`. |
| `VEKDOCS_GATEWAY_API_KEY` | — | Sent as `x-api-key` on every proxied request. Fallbacks: `VEKOCR_GATEWAY_API_KEY`, `HARUOCR_GATEWAY_API_KEY`. |

Both are read on every request. The admin panel shows the table as the "OCR Documents" grid.

## Agents and MCP

| MCP tool | Fine scope | Writes |
| --- | --- | --- |
| `vekstudio__list-documents` | `kon:vekstudio:list-documents` | no |
| `vekstudio__get-document` | `kon:vekstudio:get-document` | no |
| `vekstudio__update-document` | `kon:vekstudio:update-document` | yes |
| `vekstudio__get-health` | `kon:vekstudio:get-health` | no |

None is marked sensitive, so none is held for human approval by default; an admin can change that per
operation. Submitting documents is only possible through the proxy, which is not an MCP tool. See
[AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/kon-vekstudio-routes.test.ts` | Sessions and agent keys, the document routes, the mirror following the gateway, header forwarding, timeouts, fallback variables, health. |
| `tests/unit/security-vekstudio.test.ts` | Admin-only gateway operation, per-sender ownership, the proxy not leaking the session or a client key. |
| `tests/unit/vekstudio-kon.test.ts` | The kon definition loads. |

```bash
pnpm vitest run tests/unit/kon-vekstudio-routes.test.ts
pnpm vitest run tests/unit/security-vekstudio.test.ts
```

## License

MIT.

# kon-ocr-training

Admin bridge to the vekocr OCR engine (template proposals, training, vocabulary, test extraction) and the
settings of the vision LLM that re-reads doubtful documents. For operators who run the vekocr/vekdocs stack
next to Kitsuden; it is of no use without that stack.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| experimental | documents | 1.1.1 | `/api/ocr-training` | — (core `auth`; a reachable vekocr engine and vekdocs gateway) |

## Install

```bash
kitsuden kon add ocr-training --enable
```

Run it inside a Kitsuden project, then restart the API. The kon is off by default (`defaultEnabled: false`),
so pass `--enable` or switch it on in the admin panel (**Kons**).

Set the upstream URLs if they differ from the Docker defaults, and store the provider key in Kitsuden
Secrets if you will use the vision LLM (see [Configuration](#configuration)). It depends on no other kon.

## What it adds

- **A proxy to the vekocr engine** at `/api/ocr-training/yomi/*`, any method, for the engine's
  `proposals`, `train`, `templates`, `vocabulary`, `feedback`, `extract`, `status` and `health` routes. A
  studio frontend points at it with `window.__vekstudio_config = { yomiUrl: '/api/ocr-training/yomi' }`.
- **An overview** for dashboards: correction stats, the last 5 training jobs and the models (from the
  gateway), the number of pending proposals and the engine status (from vekocr).
- **Vision LLM settings**, kept in one row of the table `ocr_vision_config` (id always 1): `enabled`,
  `provider` (`anthropic` or `openai`), `model`, `min_confidence`, `stage` (`after_light` or
  `after_heavy`), `max_pages`, and who changed them. Only these non-sensitive values are stored; the
  provider key lives in Kitsuden Secrets and the provider URL in the server's environment. The table's
  `base_url` column is ignored and cleared on every save.
- **Re-reading a job with the vision LLM**: the kon downloads the job's input from the gateway and calls
  the provider itself, so the key never travels through the OCR queue or the engine.

## HTTP API

| Method and path | Who | What it does |
| --- | --- | --- |
| `GET /api/ocr-training/overview` | Admin | Aggregated snapshot; a part whose upstream does not answer is `null`. |
| `GET /api/ocr-training/vision-config` | Admin | The vision settings, `api_key_present` (never the key) and `base_url_source: "server"`. |
| `PUT /api/ocr-training/vision-config` | Admin | Replace the settings. Strict: an unknown field (such as `base_url`) is a 422 listing every issue. Fields left out go back to their defaults. `min_confidence` accepts 0-1 or a percentage. |
| `POST /api/ocr-training/vision-config/test` | Admin | Send an 8-token request to the provider with the stored key and model; returns `ok`, `provider`, `model`, `status`. 400 without a key, 502 if the provider cannot be reached. Spends a few tokens. |
| `POST /api/ocr-training/vision-reprocess/:jobId` | Admin | Download the job's input and read it with the vision LLM; returns `job_id`, `text`, `confidence`, `provider`, `model`. Stores nothing. 400 for a malformed id, 409 if the vision LLM is disabled, 404 if the gateway has no input, 502 on upstream failure. Up to about 150 s. |
| `GET /api/ocr-training/health` | Anyone | `{ kon, status }`: `ok` when the engine answers its health check, `degraded` otherwise. Says nothing about hosts or keys. |

The proxy `/api/ocr-training/yomi/*` (any method) is a legacy route, not an SDK operation, and is not an MCP
tool. It needs an admin session, forwards only allowlisted, clean sub-paths (no `..`, no `%` escapes; others
answer 404), never forwards the caller's cookies, `Authorization` or `x-api-key`, and answers 504 when the
engine sends no headers within 30 s, 502 when it is unreachable.

## Who can do what

The policy is `src/policy.ts` (resource `ocr-training`), deny by default:

| Action | Allowed | Used by |
| --- | --- | --- |
| `operate` | `admin` | `overview`, the `/yomi/*` proxy |
| `configure` | `admin` | `vision-config` (read, save, test), `vision-reprocess` |

Editors and plain accounts get 403; anonymous callers get 401. Only `/health` is public. Agents pass with
`admin`, `ocr-training:*`, the policy scopes `ocr-training:operate` / `ocr-training:configure`, or the
fine scope of one operation (`kon:ocr-training:<operation>`); a denial on the key wins. The table has no row
security and nothing is hidden behind a 404.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `VEKOCR_URL` | `http://vekocr_engine:8000` | The vekocr engine (proxy, overview, health). Fallback: `HARUOCR_YOMI_URL`. |
| `VEKDOCS_GATEWAY_URL` | `http://gateway_api:8001` | The vekdocs gateway (overview, job input for re-reading). Fallback: `VEKOCR_GATEWAY_URL`. |
| `VEKDOCS_GATEWAY_API_KEY` | — | Sent as `x-api-key` when downloading a job's input. Fallback: `VEKOCR_GATEWAY_API_KEY`. |
| `VEKOCR_VISION_LLM_API_KEY` | — | Provider key, kept in Kitsuden Secrets (declared in `kon.json` `secrets`). Fallback: `HARUOCR_VISION_LLM_API_KEY`. |
| `VEKOCR_VISION_LLM_BASE_URL` | the provider's official URL | Your own gateway (OpenRouter, vLLM, Ollama). Only http(s) URLs without credentials are used. |

The vision settings themselves are stored in `ocr_vision_config` and changed through the API or the
"AI settings (vision)" view the manifest declares. Default models: `claude-sonnet-4-5` (anthropic),
`gpt-4o` (openai).

## Agents and MCP

| MCP tool | Fine scope | Writes | Calls out |
| --- | --- | --- | --- |
| `ocr-training__get-summary` | `kon:ocr-training:get-summary` | no | gateway, engine |
| `ocr-training__get-vision-config` | `kon:ocr-training:get-vision-config` | no | — |
| `ocr-training__save-vision-config` | `kon:ocr-training:save-vision-config` | yes (sensitive) | — |
| `ocr-training__test-vision-config` | `kon:ocr-training:test-vision-config` | no (spends tokens) | LLM provider |
| `ocr-training__reread-with-vision` | `kon:ocr-training:reread-with-vision` | no (paid call) | gateway, LLM provider |
| `ocr-training__get-health` | `kon:ocr-training:get-health` | no | engine |

`save-vision-config` is sensitive: with human approval on, an agent gets `202 KITSUDEN_E_APPROVAL_REQUIRED`.
See [AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/security-ocr-training.test.ts` | Admin-only access, the strict settings body, the key going only to the server's provider URL, the proxy's header filtering, public health. |
| `tests/unit/ocr-vision.test.ts` | `src/vision.ts`: parsing the LLM answer, image types, default models, the key variables. |

```bash
pnpm vitest run tests/unit/security-ocr-training.test.ts
pnpm vitest run tests/unit/ocr-vision.test.ts
```

## License

MIT.

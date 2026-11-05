# AGENTS.md — kon-ocr-training

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

Admin-only bridge at `/api/ocr-training` to the vekocr OCR engine and the vekdocs gateway, plus the settings
of the vision LLM (one row in `ocr_vision_config`) and a route that re-reads a job with that LLM. The
provider key stays in Kitsuden Secrets; the kon makes the provider call itself.

## Calling it

- Scopes: read and write alike need administration. Use `ocr-training:*`, or the policy scopes
  `ocr-training:operate` (overview) and `ocr-training:configure` (vision settings, test, re-read), or fine
  scopes such as `kon:ocr-training:get-vision-config`. `get-health` needs nothing.
- MCP tools: `ocr-training__get-summary` (overview object), `ocr-training__get-vision-config` (settings plus
  `api_key_present`), `ocr-training__save-vision-config` (body under `body`; returns the saved settings),
  `ocr-training__test-vision-config` (`{ ok, provider, model, status }`), `ocr-training__reread-with-vision`
  (`jobId`; returns `{ job_id, ok, text, confidence, provider, model }`), `ocr-training__get-health`.
- `save-vision-config` is sensitive and may come back `202 KITSUDEN_E_APPROVAL_REQUIRED`: report the
  proposal, do not retry. It is a full replace (PUT): fields you leave out return to their defaults, so send
  every value you want to keep. Repeating it is safe.
- `test-vision-config` and `reread-with-vision` spend money on the provider. Do not call them in loops.
- 404 here means a missing upstream resource (no job input) or a disallowed proxy path, never a hidden row.
- Refused on purpose: `base_url` or any unknown field in the settings (422); a `jobId` outside
  `[A-Za-z0-9_-]{1,64}` (400); re-reading while `enabled` is false (409). The key is never returned.
- The `/api/ocr-training/yomi/*` proxy is not an MCP tool; over REST it needs `operate`.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | `defineKonSdk` definition: operations, the legacy proxy, startup log, admin view, exports. |
| `src/operations.ts` | Router-shaped registry of SDK operations; `adminOnly(action)` permission. |
| `src/routes.ts` | The six operations, the `/yomi/*` proxy (`proxyYomi`), upstream URLs, header filtering, `safeSubpath`, the strict `VisionConfigInput`. |
| `src/vision.ts` | `visionApiKey`, `visionBaseUrl`, `defaultModel`, `runVisionLLM` and the parsing of the LLM's JSON answer. |
| `src/policy.ts` | The `ocr-training` policy: `operate` and `configure`, admin only. |
| `src/schema.ts` | Drizzle table `ocr_vision_config`. |
| `kon.json` | Manifest: id, version, table, mount, the secret `VEKOCR_VISION_LLM_API_KEY`, the admin view. |
| `migrations/0000_vision_config.sql` | Creates the singleton table (check `id = 1`). |
| `migrations/0001_english_names.sql` | Renames stored scopes, tool names and pending proposals from the old operation ids. |
| `migrations/history.json` | Earlier checksums of applied migrations. |

## Rules that must hold

- Every route except `/health` is admin only (`src/policy.ts`; `tests/unit/security-ocr-training.test.ts`).
- The provider key goes only to `visionBaseUrl`, which comes from the server's environment, never from the
  database or a request; a stored `base_url` is ignored and cleared on save (same test file).
- No response carries the key (same test file).
- The proxy forwards only allowlisted heads and clean sub-paths, and never the caller's session or
  `x-api-key` (same test file).
- `reread-with-vision` reads its settings outside the request transaction (`db.background`) before up to
  150 s of external calls, so no transaction is held open.
- `/health` reveals no upstream host and no key state.

## Changing it

- New migration: next number in `migrations/` (`0002_...sql`). Never edit an applied one; old checksums go
  in `migrations/history.json`.
- New file at the root: run `pnpm kon:sync` (it updates `package.json` `files` and `kon.json`). Files under
  `src/` are already shipped through the `src` entry.
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- A new engine path for the proxy goes in `YOMI_ALLOWLIST` (`src/routes.ts`) and in `kon.json`
  `features.proxy.paths`.
- Operation ids are contract (MCP tools, fine scopes); renaming one needs a migration like `0001`.

## Tests

```bash
pnpm vitest run tests/unit/security-ocr-training.test.ts
pnpm vitest run tests/unit/ocr-vision.test.ts
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-ocr-training"
```

Run `security-ocr-training.test.ts` after touching `src/routes.ts` or `src/policy.ts`; `ocr-vision.test.ts`
after `src/vision.ts`.

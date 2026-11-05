# AGENTS.md — kon-vekstudio

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

A bridge at `/api/ocr` to the vekdocs OCR gateway: an authorizing proxy under `/api/ocr/gateway/*` that adds
the server's gateway key, and a local table `ocr_documents` that mirrors each job, records who sent it and
links it to a Kitsuden record.

## Calling it

- List the documents you sent: `vekstudio:submit` or `kon:vekstudio:list-documents` (the list is filtered to
  `created_by` unless the key also grants `operate`). Read or change one document: `vekstudio:view` /
  `vekstudio:edit`, or the fine scopes `kon:vekstudio:get-document` / `kon:vekstudio:update-document`. A
  scope opens only the documents the agent sent (404 on any other); every document needs a key that may
  `operate` (`admin`, `vekstudio:*`, `vekstudio:operate`). Every job and the global gateway routes: `vekstudio:*` or `admin`.
  Example key for an agent that files and lists its own jobs: `["vekstudio:submit"]`.
- MCP tools: `vekstudio__list-documents` (`limit`; returns an array of rows), `vekstudio__get-document`
  (`jobId`; one row), `vekstudio__update-document` (`jobId`, body `{ entityType?, entityId?, reviewed? }`;
  the updated row), `vekstudio__get-health` (`{ kon, status }`). None is sensitive by default.
- Submitting a document, reading results and live events go through the REST proxy, which is not an MCP
  tool.
- A 404 on a document means it is not in the mirror or the key may not see it; the API never says which.
  Documents an agent submits are recorded with its identity in `created_by`.
- `update-document` is a PATCH of plain values: repeating it leaves the same state.
- Refused on purpose: any field besides `entityType`, `entityId` and `reviewed` (422, but only after the
  ownership check, so a caller who may not see the row gets 404, never 422); job ids outside
  `[A-Za-z0-9_-]{1,64}`; gateway paths outside the allowlist.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | `defineKonSdk` definition: operations, the legacy proxy, startup log, admin grid view, exports. |
| `src/operations.ts` | Router-shaped registry of SDK operations; the `TEAM_ONLY` and `ON_THE_DOCUMENT` permissions. |
| `src/routes.ts` | The four operations, the `/gateway/*` proxy (`proxyGateway`), header filtering, `safeSubpath`, mirror sync (`syncJobRow`). |
| `src/policy.ts` | The `vekstudio` policy: `submit`, `view`, `edit`, `operate`, `actAsUser`; `ownsOrOperates`, the sender rule for every caller. |
| `src/schema.ts` | Drizzle table `ocr_documents`. |
| `kon.json` | Manifest: id, version, table, mount, admin view, proxy description. |
| `migrations/0000_initial.sql` | Creates `ocr_documents` and its indexes. |
| `migrations/0001_english_names.sql` | Renames stored scopes, tool names and pending proposals from the old operation ids. |
| `migrations/history.json` | Earlier checksums of applied migrations. |

## Rules that must hold

- The owner of a job is set once, on submit; a later sync never changes `created_by`
  (`syncJobRow` in `src/routes.ts`; `tests/unit/kon-vekstudio-routes.test.ts`, "does not take it from its owner").
- One document is seen and edited only by an admin (or an agent that may `operate`) or its sender, human or
  agent, and anyone else gets 404, not 403. A scope never lifts the sender rule: the routes ask
  `ownsOrOperates` (`src/policy.ts`) after the policy
  (`tests/unit/security-vekstudio.test.ts`, `tests/unit/kon-vekstudio-routes.test.ts`).
- Global gateway routes (job list, events, corrections, training, models) are admin only (same file).
- The proxy never forwards the caller's session, `Authorization` or a client `x-api-key`; only the server's
  key is sent (both test files).
- A failed mirror write runs in a savepoint, so it never aborts the request transaction
  (`withSavepoint` in `src/routes.ts`).
- Waiting for gateway headers is capped at 30 s (504), because the request transaction stays open meanwhile.
- `/health` reveals no upstream host.

## Changing it

- New migration: next number in `migrations/` (`0002_...sql`). Never edit an applied one; old checksums go
  in `migrations/history.json`.
- New file at the root: run `pnpm kon:sync` (it updates `package.json` `files` and `kon.json`). Files under
  `src/` are already shipped through the `src` entry.
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- A new gateway path goes in `GATEWAY_ALLOWLIST` (`src/routes.ts`), in `kon.json` `features.proxy.paths`,
  and in the authorization by route shape in `proxyGateway`.
- Operation ids are contract (MCP tools, fine scopes); renaming one needs a migration like `0001`.

## Tests

```bash
pnpm vitest run tests/unit/kon-vekstudio-routes.test.ts
pnpm vitest run tests/unit/security-vekstudio.test.ts
pnpm vitest run tests/unit/vekstudio-kon.test.ts
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-vekstudio"
```

Run the first two after touching `src/routes.ts` or `src/policy.ts`.

# AGENTS.md — kon-collection

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

A personal "I have this one" list over an index (a core dataset). It stores one row per
(user, dataset, entry key) in `collection_marks` and nothing else. Every route acts on the
caller's own marks; nothing reads anyone else's.

## Calling it

- Read and empty your own collection: `user:act`, `admin`, or any scope of this kon
  (`collection:*`, `kon:collection:get-my-collection`, `kon:collection:clear-my-collection`…).
- Mark: `collection:create`, `collection:*`, `admin`, or the fine scope
  (`kon:collection:mark-entry`, `kon:collection:mark-many`). `user:act` alone does **not** mark.
- Example key for an agent that keeps a collection: `kon:collection:get-my-collection`,
  `kon:collection:mark-many`. Read only: `kon:collection:get-my-collection`.
- MCP tools:
  - `collection__get-my-collection` — `{ data: { marks: [entryKey…] } }`.
  - `collection__mark-entry` — body `{ entryKey, have }`; returns `{ data: { entryKey, have } }`.
  - `collection__mark-many` — body `{ entryKeys }` (max 2,000); returns the whole collection.
  - `collection__clear-my-collection` — returns `{ data: { marks: [] } }`. It is a `DELETE`, so
    sensitive by default: it may come back `202 KITSUDEN_E_APPROVAL_REQUIRED`. Report the
    proposal; do not retry.
- 404 means the `datasetId` is not a uuid, or (when marking) no dataset with that id exists. It
  never means "someone else's": there is no route to anyone else's marks.
- Idempotency: `mark-entry` with the same body leaves the same state (`PUT`); `mark-many` is
  declared idempotent (it only adds). Unmarking what is not marked is not an error.
- Refused on purpose:
  - Marking for someone else: the owner is always the session user; a `userId` in the body is
    an unknown field and the request is a 422.
  - Marking in an index that does not exist (404), so the table cannot be filled with invented
    uuids.
  - More than 20,000 marks in one index (409 on `mark-entry`; `mark-many` silently keeps what
    fits).
  - An agent with only `mcp:connect` or with no collection scope gets 403.
- The batch route is `POST /api/collection/:datasetId/many`.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | The four operations (`collectionOperations`), validation schemas, `MAX_MARKS`, the router (`createKonCollection`) and the kon definition (`defineKonSdk`). |
| `operations.ts` | `KON_ID`, the router-shaped operation registry, and the two permissions: `ANY_ACCOUNT` (policy `actAsUser`) and `MARK` (policy `create`, checked in the handler). |
| `collection.policy.ts` | Policy `collection`: `view`/`update`/`delete` for owner or admin, `create` for a person (agents need a scope), `actAsUser` via `actsAsUserIn("collection")`. |
| `collection.schema.ts` | Drizzle table `collection_marks`. |
| `kon.json` | Manifest: version, mount, tables, admin grid view. |
| `package.json` | Package metadata and published `files`. |
| `migrations/0001_collection.sql` | Creates `collection_marks` and its index. |
| `migrations/0002_english_names.sql` | Rewrites stored Spanish operation scopes and tool names to the English ids. |
| `migrations/history.json` | Previous checksums and the old file name of `0001`. |

## Rules that must hold

- The owner is the session user, never input: guarded by
  `tests/unit/kon-collection-and-analytics-security.test.ts`.
- Row security on `collection_marks` (owner, admin or system) is set by the core's
  `apps/api/src/db/rls-owned-tables.sql`, not by a migration here; the test
  `kon-collection-routes.test.ts` ("the database wall is really up") checks it is forced.
- Marking checks the dataset exists before writing; unmarking does not need to.
- The per-index cap (`MAX_MARKS`) holds for both write routes, and in `mark-many` room is only
  spent on keys the account does not have yet (`kon-collection-routes.test.ts`, "near the cap").
- `mark-many` adds; it never deletes existing marks.
- Agents mark only with a scope (`create` excludes `role: "agent"` in the policy).

## Changing it

- New migration: next number in `migrations/` (`0003_…`); never edit an applied one. Renames of a
  migration file go in `migrations/history.json` (`renamed`, and its old checksums in
  `previousChecksums`).
- New file at the kon root: run `pnpm kon:sync` (updates `package.json` `files` and `kon.json`).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json` (`index.ts` reads it from there).
- Do not rename an operation `id`: it is the MCP tool name and the fine scope.
- A new owned table needs row security; this kon relies on the core list for
  `collection_marks`.

## Tests

```bash
pnpm vitest run tests/unit/kon-collection-routes.test.ts
pnpm vitest run tests/unit/kon-collection-and-analytics-security.test.ts
```

Run both after touching `index.ts`, `operations.ts` or `collection.policy.ts`; the security test
also covers kon-analytics, so a failure there may not be yours.

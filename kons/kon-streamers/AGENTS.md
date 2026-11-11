# AGENTS.md — kon-streamers

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

The streamers a site features (`streamers`) and the games each one plays (`games_to_streamers`),
mounted at `/api/streamers`. Reading is public; every write is for site staff. Live status is
pushed in by a sync job; the kon calls no streaming platform itself.

## Calling it

- Read: no scope needed.
- Write: the policy resource is `streamer` (singular). Scopes: `streamer:create`,
  `streamer:update`, `streamer:delete`, `streamer:sync`, or `streamer:*`; the kon-wide
  `streamers:*`; or a fine scope such as `kon:streamers:update-streamer`. `content:edit` is not
  enough. Example for a sync agent: `["streamer:sync"]`.
- MCP tools (`streamers__<op>`): `list-streamers` (`docs` plus pagination totals), `list-live`
  (`docs`, `totalDocs`), `get-streamer-by-slug` (the streamer plus `games`), `get-streamer`,
  `create-streamer` (the new row, 201), `update-streamer` (the updated row), `delete-streamer`
  (`{ deleted, id }`), `sync-live` (`{ synced, total }`).
- `sync-live` and `delete-streamer` are sensitive: they may come back
  `202 KITSUDEN_E_APPROVAL_REQUIRED`. Report the proposal; do not retry.
- 404 means the streamer does not exist or the id is not a uuid. The tables have no row security,
  so nothing is hidden.
- `create-streamer` and `sync-live` are `POST`: pass an `idempotency_key` when you may repeat a
  call. A second create with the same slug or the same platform + `channelId` answers 409 (unique
  indexes `streamers_slug_idx` and `streamers_channel_idx`); so does an update to them.
- Things that look possible but are not:
  - `sync-live` sets every field it owns on each matched row: an omitted `isLive` becomes `false`,
    an omitted `viewerCount` becomes `0`, an omitted title or thumbnail becomes `null`.
  - `gameIds` on update replaces all the streamer's games; the first id becomes the primary game.
  - Unknown fields in a create or update body are ignored, not stored.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | `defineKonSdk` (mount, admin view copied from `kon.json`, dependencies) and the startup check that both tables exist. |
| `operations.ts` | `KON_ID`, the `registry()` helper that turns `app.get(path, declaration, handler)` into SDK operations, `OF_TEAM(action)`. |
| `streamers.routes.ts` | The eight operations, `cleanStreamer` (write validation), the sortable-column list. |
| `streamers.policy.ts` | The `streamer` policy: `create`, `update`, `delete`, `sync` for admin or editor. |
| `streamers.schema.ts` | Drizzle tables `streamers`, `games_to_streamers` and the enum `streamers_platform`. |
| `streamers.db.ts` | The typed Drizzle client type. |
| `migrations/0000_base_tables.sql` | Creates the enum, both tables, indexes, and the `games` foreign key when `games` exists. |
| `migrations/0000_missing_columns.sql` | Adds columns the schema declared and older databases lacked. |
| `migrations/0001_english_names.sql` | Renames stored scopes, tool names and pending proposals from the old Spanish operation ids. |
| `migrations/0002_unique_channel.sql` | Unique index on platform + channel and the `is_live` index; stops with a message if duplicates exist. |
| `migrations/history.json` | Rename of `0000_missing_columns.sql` (old name `0000_columnas_ausentes.sql`) and its earlier checksums. |

## Rules that must hold

- Every write goes through the `streamer` policy before the body is read (`OF_TEAM` in
  `operations.ts`). Guarded by `tests/unit/sec-esports-streamers.test.ts` ("writes: team only").
- Writes only touch the columns `cleanStreamer` lists; `id` and `createdAt` are never writable
  ("PATCH does not write columns outside the list").
- `channelUrl` is an `http(s)` link or null; the site renders it as a link.
- `?sort=` only accepts the columns in `SORTABLE`; anything else falls back to `-followerCount`.
- A repeated slug or platform + channel is a 409, never a 500
  (`tests/unit/streamers-unique-channel.test.ts`). The insert and the update run in a savepoint
  (`withSavepoint`), so the 409 does not leave the request's transaction aborted
  (`tests/unit/input-errors-in-the-request-transaction.test.ts`).
- A malformed `:id` is a 404, never a 500 (`tests/unit/streamers-and-collections-malformed-ids.test.ts`).
- Queries inside a handler run one after another, never with `Promise.all` (one request
  transaction).
- Operation ids are part of the contract (scopes, MCP tool names). Do not rename them.

## Changing it

- New migration: next number in `migrations/` (`0003_...sql`), never edit an applied one. A file
  rename or a reworded comment is declared in `migrations/history.json` (`renamed`,
  `previousChecksums`).
- New file at the root: run `pnpm kon:sync` (it updates package.json `files` and kon.json).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.

## Tests

```bash
pnpm vitest run tests/unit/sec-esports-streamers.test.ts                    # policy, writes, sorting
pnpm vitest run tests/unit/streamers-and-collections-malformed-ids.test.ts  # :id handling
pnpm vitest run tests/unit/streamers-unique-channel.test.ts                 # 409s, live fields, migration 0002
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-streamers"            # these docs
```

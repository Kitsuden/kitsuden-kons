# AGENTS.md — kon-games

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

A game catalog with no owners: games (with page `blocks`), platforms, tags and curated
collections, written by the team. Each block has a `data` part owned by the loaders and an
`editorial` part edited by hand (Inti, agents) that survives reloads.

## Calling it

- Read: no scope needed for published games, collections, platforms and tags. With a key, the
  fine scopes are `kon:games:list-games`, `kon:games:get-game-by-slug`…
- Edit only the text of a game's page: `content:edit` opens `update-editorial-layer` and
  `reorder-blocks` and nothing else. This is the narrowest key for Inti-like agents.
- Create and edit games, collections, platforms and tags: the team. For an agent, `games:*`,
  `kon:games:*`, `admin`, or the operation's fine scope (for example
  `kon:games:update-game`). Writes under `/api/games` also pass the core's staff gate
  (`auth-guard.ts`).
- Delete a game: `admin`, `games:*`, `kon:games:*` or `game:delete`. A deny such as
  `!game:delete` wins over `games:*`.
- MCP tools are `games__<operation>` (17; the list is in the README). Reads return the rows as
  the REST routes do: lists are `{ docs, totalDocs, … }`, a game is the row (plus `media` URLs
  unless `includeMedia: "false"`). `update-editorial-layer` returns `{ id, editorial }`;
  `reorder-blocks` returns `{ id, ids }`.
- `delete-game` and `delete-collection` are `DELETE`s and sensitive by default: they may come
  back `202 KITSUDEN_E_APPROVAL_REQUIRED`. Report the proposal; do not retry.
- 404 means missing, or a draft you may not see (a draft is never a 403, so its slug is not
  confirmed). There is no row security on these tables: hiding is done by the `game` policy in
  the handlers.
- Idempotency: the same `update-editorial-layer` patch leaves the same state, and
  `reorder-blocks` is a `PUT`. Creates are not idempotent: pass an `idempotency_key` over MCP if
  you may retry `create-game`, `create-collection`, `create-platform` or `create-tag`.
- Refused on purpose:
  - Editing the game itself with `content:edit` (403).
  - An editor deleting a game (403).
  - A 0.8 key (`titulo`, `descripcion`, `oculto`, `orden`, or Spanish block data keys) in any
    write: 422 with `hint` and `renamed`. Use the English names.
  - Any editorial key other than `title`, `description`, `hidden` (400; `order` is set only by
    `reorder-blocks`).
  - A slug equal to a site route (400): the game would be unreachable at `/<slug>/`.
  - `sort` on a column that does not exist (400).
  - Asking for `status=draft` without being the team: you get published games only.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | Kon definition (`defineKonSdk`), startup hooks that check the tables, re-exports of the schema and of `keepEditorial` / `sqlBlocksWithEditorial`. |
| `games.routes.ts` | The 17 operations (`gamesOperations`), body schemas, the uuid guard for collections, media URL helpers. |
| `operations.ts` | `KON_ID`, the router-shaped registry, `ANY_ACCOUNT` (policy `actAsUser`), shared zod helpers. |
| `games.policy.ts` | Policy `game`: published or team to view, team to create and update, admin to delete. |
| `games.editorial.ts` | The editorial layer: patch and order validation, 0.8 key detection, SQL that merges, reorders and keeps the layer across reloads, `gameToServe`. |
| `games.schema.ts` | Drizzle tables, enums, relations and media URL builders. |
| `games.db.ts` | `GamesDb`: the database type narrowed to this schema. |
| `kon.json` | Manifest: version, mount, tables, admin views, media transforms (URLs to the core media library, `/api/media`); no kon dependencies. |
| `package.json` | Package metadata and published `files`. |
| `README.md` | Human documentation. |
| `migrations/0000_base_tables.sql` | Creates the tables if a fresh core did not. |
| `migrations/0000_rename_enums.sql` | Prefixes the enums with `games_`. |
| `migrations/0001_collections_missing_columns.sql` | Adds `description` and `is_active` to `game_collections`. |
| `migrations/0002_english_names.sql` | Rewrites stored Spanish scopes and tool names (and `contenido:editar` to `content:edit`). |
| `migrations/0003_english_block_keys.sql` | Rewrites stored block `data` and `editorial` keys to English. |
| `migrations/history.json` | Old checksums and the old name of `0001`. |

## Rules that must hold

- Drafts are invisible outside the team on every read path (`/`, `/slug/:slug`, `/:id`,
  collections): `games-without-owner.test.ts`.
- Only admin deletes; denies win (`games-delete-admin-only.test.ts`).
- Editorial writes are one SQL statement each and touch only `editorial`, never `data` or other
  blocks (`game-blocks-editorial.test.ts`).
- Saving the whole game keeps each block's editorial layer by id
  (`save-game-keeps-editorial.test.ts`).
- Writes speak English only; reads accept 0.8 keys until 0.10. The code marked
  "Remove in 0.10" in `games.editorial.ts` is that compatibility.
- A game slug cannot be a reserved segment (`site-reserved-segments.test.ts`).
- Literal routes (`/slug/:slug`, `/collections`, `/platforms`, `/tags`) are declared before
  `/:id`; the SDK refuses a shadowed operation.
- Collections only list published games, and their cache (`collections:*`) is invalidated on
  every write that changes what they show.
- The responses the Inti adapter uses keep their shape (`inti-contract.test.ts`).

## Changing it

- New migration: next number in `migrations/` (`0004_…`); never edit an applied one. A renamed
  migration file goes in `migrations/history.json`.
- New file at the kon root: run `pnpm kon:sync` (updates `package.json` `files`).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to
  `kon.json`.
- The block key table lives in the core (`@kitsuden/shared`, `block-keys.ts`), not here.
- When 0.10 drops 0.8 reads, remove the "Remove in 0.10" branches and the README section "From
  0.8".
- Do not rename an operation `id`: it is the MCP tool name and the fine scope.

## Tests

```bash
pnpm vitest run tests/unit/games-without-owner.test.ts
pnpm vitest run tests/unit/games-delete-admin-only.test.ts
pnpm vitest run tests/unit/game-blocks-editorial.test.ts
pnpm vitest run tests/unit/save-game-keeps-editorial.test.ts
pnpm vitest run tests/unit/english-block-keys.test.ts
pnpm vitest run tests/unit/games-collections-validation.test.ts
pnpm vitest run tests/unit/streamers-and-collections-malformed-ids.test.ts
pnpm vitest run tests/unit/site-reserved-segments.test.ts
pnpm vitest run tests/unit/inti-contract.test.ts
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-games"
```

- `games.editorial.ts`: `game-blocks-editorial`, `save-game-keeps-editorial`,
  `english-block-keys`, `inti-contract`.
- `games.policy.ts` or permissions in `games.routes.ts`: `games-without-owner`,
  `games-delete-admin-only`.

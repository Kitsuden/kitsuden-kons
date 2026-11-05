# AGENTS.md — kon-tierlist

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

Tier lists in one table, `tier_lists`, with two kinds of row: editorial **templates** (public,
by slug, written by the team) and **personal** lists (a reader's fork of a template, owned and
private, shared by a code that carries only the placement). All list logic is the pure engine
in `tierlist.engine.ts`.

## Calling it

- Read: no scope needed; templates, diffs and share codes are public (`access: "public"` or
  `"optional"`). With a key, `kon:tierlist:list-templates`, `kon:tierlist:get-template`…
- Write a template: the policy scopes `tierlist:publish` (`publish-template`) and
  `tierlist:update` (`place-in-template`, `add-items`, `remove-item`, `sync-catalog`), or the
  fine scope of the operation (`kon:tierlist:place-in-template`), or `tierlist:*`.
- Fork into your own list: `tierlist:create` or `kon:tierlist:fork-template`.
- `content:edit` grants nothing here.
- MCP tools are `tierlist__<operation>`:
  - `list-templates` → `{ data: [{ id, slug, title, version }] }`.
  - `get-template` → `{ data: <row>, view: { rows, unranked } }`.
  - `publish-template`, `place-in-template`, `add-items`, `remove-item` → `{ data: <row> }`.
  - `sync-catalog` → `{ data, unranked, inCatalog, origin }`. A 409 with `lost` means hand-added
    items would be dropped: only repeat with `confirm: true` if dropping them is intended.
  - `compare-versions` → `{ data: { promoted, demoted, added, removed, unchanged }, from, to }`.
  - `fork-template`, `place-in-my-list` → `{ data, code }`.
  - `open-code` → `{ data: { template }, view }`.
- May come back `202 KITSUDEN_E_APPROVAL_REQUIRED` (report it, do not retry):
  `publish-template` and `sync-catalog` (declared sensitive) and `remove-item` (a `DELETE`).
- 404: the template slug does not exist, or the personal list is not yours (row security hides
  it; the handlers also answer 404 instead of 403). `sync-catalog` answers 404 for a dataset you
  cannot read, so it does not reveal which datasets exist.
- Idempotent: `place-in-template` and `place-in-my-list` (placing twice gives the same result),
  `publish-template` (`PUT` by slug). `add-items` and `fork-template` are not: pass an
  `idempotency_key` over MCP if you may retry.
- Refused on purpose:
  - Publishing a slug that a personal row carries (409): it would expose that list.
  - A full `PUT` to move one item: use `place-in-template`; a `PUT` overwrites other editors.
  - Item images that are not `http(s)` (422), on `PUT`, `add-items` and the `catalog` of `sync`.
  - Placing in a tier or item that does not exist (409).
  - Listing, renaming or deleting personal lists: there is no route for it.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | The 11 operations (`tierlistOperations`), zod input/output schemas, `catalogFromDataset` (dataset → items, through `readDatasetCatalog` of `@kitsuden/shared`), router and `defineKonSdk`. |
| `tierlist.engine.ts` | Pure engine: default tiers, `validateTierList`, `place`, `addItems`, `removeItem`, `syncWithCatalog`, `tierView`, `diffTierLists`, `calculatePlacementsFromStats`, share codes (`encodeTierList`, `decodeTierList`, `applyPlacement`). |
| `tierlist.policy.ts` | Policy `tierlist`: `view`, `create`, `publish`, `update`, `delete`. |
| `tierlist.schema.ts` | Drizzle table `tier_lists`. |
| `kon.json` | Manifest: version, mount, tables, admin views. |
| `package.json` | Package metadata, published `files`, dependency `@paralleldrive/cuid2`. |
| `admin/tierlist-editor.js` | Built admin view (generated from `admin-src/`; do not edit). |
| `admin-src/TierlistEditor.svelte` | Source of the editor view: board, drag and keyboard placing, sync, diff. |
| `admin-src/Chip.svelte` | One item chip (portrait or initials, name). |
| `admin-src/api.ts` | Fetch calls to the kon's routes with the browser's cookies; `ApiError` keeps status and body. |
| `admin-src/format.ts` | Helpers: slug from title, initials, grouped view, diff groups and `diffMarkdown` (the diff as markdown). |
| `admin-src/types.ts` | Types of what the editor reads. |
| `admin-src/views.json` | Which views `pnpm build:admin` builds. |
| `admin-src/tallao.json`, `admin-src/tallao/` | The tallao components the view uses, copied by `pnpm sync:tallao`; do not edit the copy. |
| `migrations/0001`–`0002` | Table, indexes, `manual` column. |
| `migrations/0003_public_templates_rls.sql`, `0005_english_rls.sql` | Row security for templates. |
| `migrations/0004_english_names.sql` | Renames stored Spanish scopes and tool names to English. |
| `migrations/history.json` | Old checksums and the old name of `0003`. |

## Rules that must hold

- A personal list is never readable by anyone but its owner and admin: row security
  (`rls-owned-tables.sql` in the core) plus the `view` check in `compare-versions` and
  `open-code`. Guarded by `tests/unit/sec-cards-tierlist.test.ts`.
- Only admin, editor or an agent with `tierlist:publish` publishes; a normal account never
  writes a template (`sec-cards-tierlist.test.ts`).
- A list is validated before it is saved (`validateTierList`); a placement may only point at
  existing items and tiers (`tierlist-engine.test.ts`).
- Sync never moves an existing placement, and never drops hand-added items without `confirm`
  (`tierlist-from-dataset.test.ts`, `tierlist-without-catalog.test.ts`, `mcp-full-path.test.ts`).
- A fork copies the template; it does not reference it.
- `decodeTierList` never throws; `applyPlacement` drops what no longer exists.
- The owner of a fork is the session user, not input.

## Changing it

- New migration: next number in `migrations/` (`0006_…`); never edit an applied one. A renamed
  migration file goes in `migrations/history.json`.
- New file at the kon root: run `pnpm kon:sync` (updates `package.json` `files`; `admin-src/`
  is never shipped).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to
  `kon.json` (the API reads it from `kon.json`).
- Admin view: edit `admin-src/`, then `pnpm build:admin kon-tierlist` (writes
  `admin/tierlist-editor.js`, which is committed) and `pnpm check:admin kon-tierlist`. To update
  the tallao copy, `pnpm sync:tallao kon-tierlist` (needs `TALLAO_DIR`).
- Do not rename an operation `id`: it is the MCP tool name and the fine scope.

## Tests

```bash
pnpm vitest run tests/unit/tierlist-engine.test.ts
pnpm vitest run tests/unit/tierlist-meta.test.ts
pnpm vitest run tests/unit/tierlist-from-dataset.test.ts
pnpm vitest run tests/unit/tierlist-without-catalog.test.ts
pnpm vitest run tests/unit/sec-cards-tierlist.test.ts
pnpm vitest run tests/unit/mcp-full-path.test.ts
pnpm vitest run tests/unit/tierlist-editor-render.test.ts
pnpm vitest run tests/unit/tierlist-without-output.test.ts
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-tierlist"
```

- Engine: the first four. Routes or policy: `sec-cards-tierlist` and `mcp-full-path`.
- `admin-src/`: the last two, after rebuilding.

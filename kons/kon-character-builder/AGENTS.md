# AGENTS.md — kon-character-builder

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

A data-defined character builder: a definition (slots, options, budgets, formulas) per game, an
engine that validates a build and computes its stats with kon-formulas, saved builds with share
codes and visibility, and a voted gallery. Mounted at `/api/builder`; the kon id, scopes and
tools say `character-builder`, and the policy resource is `builder`.

## Calling it

- Read definitions, compute builds, read the gallery and decode codes: no scope needed. With a
  key, the fine scopes are `kon:character-builder:<operation>`.
- Publish a definition: `builder:publishDefinition`, `builder:*`, `character-builder:*`,
  `kon:character-builder:publish-definition` or `admin`. Seeing drafts needs the team:
  `character-builder:*`, `kon:character-builder:*` or `admin`.
- Save, list your own, update, delete, vote, validate a definition: the agent acts as a user, so
  it needs `user:act`, `admin` or a scope of the kon (for example
  `kon:character-builder:save-build`). The build's owner is the agent itself.
- MCP tools (`character-builder__<operation>`):
  - `list-definitions` → `{ data: [{ id, slug, name, published }] }`.
  - `get-definition` → `{ data: <row with resolved definition>, meta?: { datasets } }`.
  - `validate-definition` → `{ ok, error? }`. `ok: false` is an answer, not a failure.
  - `publish-definition` → `{ data: <row> }`, 201 or 200.
  - `compute-build` → `{ data: stats, issues, code }`; 422 with `issues` on a rule break.
  - `open-build-code` → `{ data: { ok, builderId, build } }`.
  - `save-build`, `update-build` → `{ data: <build row> }`.
  - `list-my-builds`, `list-builds` → `{ docs: [...] }`; `get-build` → `{ data }`.
  - `delete-build` → `{ data: { id } }`; `vote-build` → `{ data: { id, votes, voted } }`.
- `publish-definition` and `delete-build` are sensitive: they may come back
  `202 KITSUDEN_E_APPROVAL_REQUIRED`. Report the proposal; do not retry.
- 404 means missing, or hidden: a draft definition outside the team, a private build of someone
  else. A 403 on update or delete means the build is visible but not yours.
- Idempotency: saving the same build twice updates the first (200), it does not duplicate.
  `vote-build` toggles, so repeating it removes the vote: pass an `idempotency_key` over MCP if
  you may retry. `publish-definition` is a `PUT` by slug.
- Refused on purpose:
  - Saving against a draft (404) or an invalid build (422 with `issues`).
  - Setting owner, votes, subject or dates in the body: the server sets them.
  - A link build with pieces, a long label, or a `link` that is not a safe `#…` fragment (422).
  - More than 100 builds per planner, 1,000 in total (409), or 60 new in 10 minutes (429).
  - Voting on a private build (409).
  - An agent with only `mcp:connect` cannot publish a definition (403).

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | The 13 operations (`builderOperations`), body schemas and limits, `resolveDefinition` (dataset options), router and `defineKonSdk`. |
| `operations.ts` | `KON_ID`, the router-shaped registry, permissions `ANY_ACCOUNT` (`actAsUser`) and `onTheResource`, shared zod params. |
| `character-builder.engine.ts` | Pure engine: definition types, `compileBuilder`, `validateBuild`, `computeStats`, link planner rules, `subjectOfBuild`, `encodeBuild` / `decodeBuild`. |
| `character-builder.dataset.ts` | Dataset-backed slots: `datasetSlots`, `optionsFromEntries`, `withDatasetOptions`. |
| `character-builder.policy.ts` | Policy `builder` and `isBuilderTeam`. |
| `character-builder.schema.ts` | Drizzle tables `builder_definitions`, `builder_builds`, `builder_build_votes`. |
| `kon.json` | Manifest: version, mount, tables, admin views, dependency on kon-formulas, scopes and sensitive operations. |
| `package.json` | Package metadata, published `files`, dependency `@paralleldrive/cuid2`. |
| `admin/definition-editor.js` | Built admin view (generated from `admin-src/`; do not edit). |
| `admin-src/DefinitionEditor.svelte` | Root of the `builder-definition-editor` custom element. |
| `admin-src/editor.svelte.ts` | Shared editor state: the definition, saved definitions, datasets, unsaved changes, what the check found wrong. |
| `admin-src/sections/*.svelte` | Editor sections: `BaseStats`, `Slots`, `SlotCard`, `Budgets`, `Derived`. |
| `admin-src/ui/*` | The frame shared by every kon view, copied from kon-crm and kept identical: `ui/View.svelte`, `ui/Panel.svelte`, `ui/Loadable.svelte`, `ui/load.svelte.ts`, `ui/RowMenu.svelte`, `ui/FormGrid.svelte`, `ui/notify.ts`, `ui/labels.ts`. |
| `admin-src/api.ts`, `admin-src/types.ts` | Fetch calls with the browser's cookies; the shapes the view sends and reads. |
| `admin-src/views.json`, `admin-src/tallao.json`, `admin-src/tallao/` | Build list and the copied tallao components (`pnpm sync:tallao`; do not edit the copy). |
| `migrations/0001`–`0002` | Tables, indexes, gallery columns and the votes table. |
| `migrations/0003_public_read_rls.sql`, `0005_english_rls.sql` | Public read of `public` and `unlisted` builds. |
| `migrations/0004_english_names.sql` | Renames indexes, stored build keys, `link:` planner ids and stored scopes to English. |
| `migrations/history.json` | Old checksums and old file names. |

## Rules that must hold

- A definition is compiled before it is saved, and a build is validated before it is saved or
  computed (`builder-engine.test.ts`).
- A draft definition behaves as nonexistent outside the team: read, compute and save
  (`kon-builder-security.test.ts`, "draft definitions").
- A private build is seen only by its owner and admin; the gallery lists only `public` builds
  and never includes `ownerId` (`kon-builder-security.test.ts`).
- Owner, subject, votes and dates are set by the server, never from the request.
- One vote per person and build; the counter is recounted from the table, not incremented, and
  simultaneous clicks do not fail (`kon-builder-security.test.ts`, "votes").
- Saving never lowers visibility; the first publication date is kept.
- Work on others' rows (vote count, a build's votes on delete) runs as the system only after the
  policy check.
- Formulas are only evaluated through kon-formulas.
- `/builds/mine` is declared before `/builds/:id`; keep that order.

## Changing it

- New migration: next number in `migrations/` (`0006_…`); never edit an applied one. A renamed
  migration file goes in `migrations/history.json`.
- New file at the kon root: run `pnpm kon:sync` (updates `package.json` `files`; `admin-src/`
  is never shipped).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to
  `kon.json`.
- A new operation: add its fine scope to `kon.json` `permissions.scopes` (and to `sensitive` if
  it destroys or rewrites shared data). Do not rename an operation `id`.
- Admin view: edit `admin-src/`, then `pnpm build:admin kon-character-builder` (writes
  `admin/definition-editor.js`, which is committed) and `pnpm check:admin kon-character-builder`.

## Tests

```bash
pnpm vitest run tests/unit/builder-engine.test.ts
pnpm vitest run tests/unit/builder-groups-and-filters.test.ts
pnpm vitest run tests/unit/kons-from-dataset.test.ts
pnpm vitest run tests/unit/kon-builder-security.test.ts
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-character-builder"
```

- Engine or dataset files: the first three. Routes or policy: `kon-builder-security`.

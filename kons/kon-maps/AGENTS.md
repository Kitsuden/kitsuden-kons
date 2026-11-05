# AGENTS.md — kon-maps

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

Game maps for a viewer: a map (image, aspect ratio, layers), its marker categories and its markers, with
coordinates normalized to `[0..1]`. Reading is public; writing is for site staff or an agent with the
scope. Three SDK operations, mounted at `/api/maps`.

## Calling it

- Read: no scope needed. `GET /api/maps/maps/:slug`, MCP tool `maps__get-map` (argument `slug`, optional
  `cluster`). It returns `{ data, categories, markers, clusters }`; with `cluster` set, `markers` is empty
  and `clusters` holds `{ x, y, markers }` groups.
- Write: one of `kon:maps:save-map` / `kon:maps:import-markers` (fine), `maps:*` (whole kon), or the
  policy scopes `maps:create` (+ `maps:update` to rewrite an existing map). Example key scopes:
  `["kon:maps:save-map", "kon:maps:import-markers"]`.
- `maps__save-map` (body under `body`: `slug`, `definition`, optional `categories`) returns
  `{ data, categories }`, status 201 on create and 200 on rewrite.
- `maps__import-markers` (`slug`, body `{ markers: [...] }`) returns `{ data: { imported } }`.
- Both writes are sensitive. With human approval on they come back `202 KITSUDEN_E_APPROVAL_REQUIRED`:
  report the proposal to the user, do not retry.
- A 404 always means the slug does not exist; nothing is hidden by row security here.
- `save-map` is an upsert by slug, so repeating it is safe. `import-markers` is not idempotent: every call
  inserts its markers again. Pass `idempotency_key` (MCP) or `Idempotency-Key` (REST) when you may retry.
- Refused on purpose: coordinates outside `[0..1]` (rejected, not clamped), markers in a category that was
  never saved, `imageUrl` values that are not http(s) or a site path (`javascript:`, `data:`), more than
  5,000 markers per call, and partial imports. There is no route to delete or move a marker.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | Zod input schemas, the three operations (`mapsOperations`), the router and the `defineKonSdk` definition. |
| `maps.engine.ts` | Pure rules: `validateMapDefinition`, `validateMarker`, `toPixels`/`fromPixels`, `clusterMarkers`, `visibleMarkers`. |
| `maps.policy.ts` | The `maps` policy (`view`, `create`, `update`, `delete`). |
| `maps.schema.ts` | Drizzle tables `game_maps`, `map_categories`, `map_markers`. |
| `kon.json` | Manifest: id, version, tables, mount path. |
| `migrations/0001_maps.sql` | Creates the three tables and their indexes. |
| `migrations/0002_english_names.sql` | Renames stored scopes, tool names and pending proposals from the old operation ids. |
| `migrations/history.json` | Earlier checksums of applied migrations. |

## Rules that must hold

- Coordinates are normalized and out-of-range values are rejected (`validateMarker` in `maps.engine.ts`;
  `tests/unit/wiki-maps-engine.test.ts`).
- Imports are all or nothing: validate every marker, then one `createMany` (`index.ts`, `import-markers`).
- `save-map` never deletes categories; it upserts by `(map_id, category_id)` (`tests/unit/maps-categories.test.ts`).
- Rewriting an existing map checks `update` on top of `create` (`index.ts`, `save-map`).
- Clustering is O(n) and deterministic, and the grid is at least 1/4096
  (`tests/unit/sec-data-wiki-maps-formulas.test.ts`, `tests/unit/wiki-maps-engine.test.ts`).
- A malformed definition is a 400 or 422, never a 500 (`tests/unit/sec-data-wiki-maps-formulas.test.ts`).
- Operation ids (`get-map`, `save-map`, `import-markers`) are contract: they name the MCP tools and fine
  scopes. Do not rename them.

## Changing it

- New migration: the next number in `migrations/` (`0003_...sql`). Never edit an applied one; if a
  checksum must change, the old one goes in `migrations/history.json`.
- New file at the root: run `pnpm kon:sync` (it updates `package.json` `files` and `kon.json`).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- If you add a table with personal data, give it row security; today's tables are editorial on purpose.

## Tests

```bash
pnpm vitest run tests/unit/maps-categories.test.ts
pnpm vitest run tests/unit/sec-data-wiki-maps-formulas.test.ts
pnpm vitest run tests/unit/wiki-maps-engine.test.ts
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-maps"
```

After touching `maps.engine.ts`, run `wiki-maps-engine.test.ts`; after `index.ts` or the policy, the other
two.

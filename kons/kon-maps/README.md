# kon-maps

Interactive game maps: a base image with layers, marker categories and markers stored in normalized
coordinates. It is the data model and its rules for a map viewer; the viewer itself (Leaflet or anything
else) lives in your frontend.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | gaming | 1.0.1 | `/api/maps` | — (core `auth`) |

## Install

```bash
kitsuden kon add maps --enable
```

Run it inside a Kitsuden project. The kon is off by default (`defaultEnabled: false` in `package.json`),
so pass `--enable` or switch it on in the admin panel (**Kons**), then restart the API. It needs no other
kon and no environment variables.

## What it adds

A **map** is an image (`imageUrl`, an http(s) URL or a path on your own site), its `aspectRatio` and
at least one **layer** ("Act 1", "Underground"). Each map has **categories** (chests, bosses, NPCs) with
an icon and a hex color, and **markers**: a point on one layer, in one category, with a title and an
optional body.

Coordinates are normalized to `[0..1]` over the image, so uploading a higher-resolution image moves no
marker. A coordinate outside that range is rejected, never clamped.

Tables (from `kon.json`):

| Table | What it holds |
| --- | --- |
| `game_maps` | One row per map: unique `slug`, `name`, and the whole `definition` (image, aspect ratio, layers) as JSON. |
| `map_categories` | Marker categories of a map, unique per `(map_id, category_id)`; default color `#00d2a8`. |
| `map_markers` | Markers: `map_id`, `layer_id`, `category_id`, `x`, `y`, `title`, `body`. |

The tables have no owner column and no row-level security: map content is editorial and public.

## HTTP API

| Method and path | Who | What it does |
| --- | --- | --- |
| `GET /api/maps/maps/:slug` | Anyone, no session | The map, its categories and its markers in one response. `?cluster=<grid>` (cell size in normalized units, at least 1/4096) returns markers grouped in `clusters` and an empty `markers` list. 404 for an unknown slug. |
| `PUT /api/maps/maps` | Staff (admin, editor) or an agent with the scope | Creates (201) or rewrites (200) a map by `slug`. `categories` are upserted by id; categories you leave out are kept, never deleted. A malformed body is a 400 with `issues`; a definition that passes the schema but fails the engine's checks (duplicate layer ids) is a 422. |
| `POST /api/maps/maps/:slug/markers` | Staff (admin, editor) or an agent with the scope | Imports 1 to 5,000 markers. All or nothing: if any marker is invalid (unknown layer or category, coordinates out of range, empty title) none is saved and the 422 lists `issues` by index. Returns 201 with `{ data: { imported } }`. |

There is no route to list maps, or to edit or delete a single marker or category.

Body of `PUT /api/maps/maps`:

```json
{
  "slug": "world",
  "definition": {
    "name": "World",
    "imageUrl": "/media/world.webp",
    "aspectRatio": 1.5,
    "layers": [{ "id": "surface", "name": "Surface" }]
  },
  "categories": [{ "id": "chest", "name": "Chests", "icon": "chest", "color": "#ffcc00" }]
}
```

`slug` is lowercase letters, digits and hyphens (up to 80). A marker category must exist before markers
that use it are imported, so send `categories` with the map first.

## Who can do what

The policy is `maps.policy.ts` (resource `maps`):

| Action | Allowed |
| --- | --- |
| `view` | Everyone |
| `create` | `admin`, `editor` |
| `update` | `admin`, `editor` |
| `delete` | `admin` (no route uses it) |

- Anonymous visitors and plain accounts can only read maps. A plain account gets 403 on the writes.
- Rewriting a map that already exists checks `update` as well as `create`.
- Agents pass with the fine scope of the operation (`kon:maps:save-map`, `kon:maps:import-markers`), the
  kon-wide `maps:*`, `admin`, or the policy scopes `maps:create` (and `maps:update` to rewrite an existing
  map). A denial on the key (`!kon:maps:save-map`, `!maps:*`) always wins.
- Nothing answers 404 to hide a row: there is no row security. A 404 means the slug does not exist.

## Configuration

None. The kon reads no environment variables and no settings.

## Agents and MCP

The three routes are kon SDK operations, so each is also an MCP tool:

| MCP tool | Fine scope | Writes | Sensitive |
| --- | --- | --- | --- |
| `maps__get-map` | `kon:maps:get-map` | no | no |
| `maps__save-map` | `kon:maps:save-map` | yes | yes |
| `maps__import-markers` | `kon:maps:import-markers` | yes | yes |

`save-map` and `import-markers` are marked sensitive: when an admin turns on human approval, an agent's
call comes back as `202 KITSUDEN_E_APPROVAL_REQUIRED` until a person approves it. See
[AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/maps-categories.test.ts` | Saving a map with categories, then importing markers and reading them back. |
| `tests/unit/sec-data-wiki-maps-formulas.test.ts` | The `maps` block: a plain account cannot write, bad definitions are 400, clustering stays linear. |
| `tests/unit/wiki-maps-engine.test.ts` | The engine in `maps.engine.ts`: definitions, marker validation, pixel conversion, clustering. |

```bash
pnpm vitest run tests/unit/maps-categories.test.ts
pnpm vitest run tests/unit/wiki-maps-engine.test.ts
```

## License

MIT.

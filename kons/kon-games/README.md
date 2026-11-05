# kon-games — Game catalog

A game catalog: games with metadata, cover art, screenshots, specs and page blocks, plus
platforms, tags and curated collections. For sites that publish a page per game (`/<slug>/`) and
let the team and agents edit the text of those pages without fighting the data loaders.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | gaming | 2.1.1 | `/api/games` | — (core: `auth`; images from the core media library, `/api/media`) |

## Install

```bash
kitsuden kon add games --enable
```

`package.json` has `defaultEnabled: false`, so pass `--enable` (or switch it on in the admin panel,
**Kons**). Restart the API afterwards. Cover art, screenshots and platform icons are ids in the
core's media library (a core feature, not a kon), and responses carry URLs to its
`/api/media/preset/...` and `/api/media/transform/...` endpoints.

Optional environment variable: `KITSUDEN_RESERVED_SEGMENTS` (see [Configuration](#configuration)).

## What it adds

| Table | What it holds |
| --- | --- |
| `games` | One game: `title`, `slug` (its address on the site), `subtitle`, `description` (Lexical JSON), `excerpt`, `release_date`, `status` (`draft`, `published`, `archived`), developer, publisher, scores, cover art id and focal point, `trailer_url`, `external_ids`, `specs`, `screenshots`, `blocks`, `is_featured_on_home`. |
| `platforms` | Gaming platforms (PC, consoles…), with an optional icon (media id). |
| `tags` | Tags with a category: `genre`, `feature`, `topic`, `series`. |
| `game_collections` | Curated groupings of games, with a display order. |
| `game_collection_entries` | Which games each collection holds, in order. |
| `games_to_platforms`, `games_to_tags` | Links between games and platforms or tags. |

`specs.coverUrl` and `specs.heroUrl` (http(s) only) are used as external art while a game has no
cover in the media library.

The admin panel gets the views of `kon.json`: **All Games** (grid), **By Status** (kanban by
`status`) and **Collections**.

## HTTP API

### Games

| Route | Operation | Who | What it does |
| --- | --- | --- | --- |
| `GET /api/games` | `list-games` | anyone | Paginated games (`limit` up to 100, default 24; `page`), sorted by `sort` (a column, `-` for descending; default `-metacriticScore`, then title), filtered by `search` (title) and `featured=true`. Only published games unless the caller is staff and asks for another `status`. 400 if `sort` is not a column. Adds `media` URLs unless `includeMedia=false`. |
| `GET /api/games/slug/:slug` | `get-game-by-slug` | anyone | The game with its platforms and tags (and `media`). A draft is a 404 outside the team. |
| `GET /api/games/:id` | `get-game` | anyone | The game row (and `media`). A draft is a 404 outside the team. |
| `POST /api/games` | `create-game` | team | Creates a game (draft by default) and its platform/tag links. A slug taken by a site route is a 400; a 0.8 key in `blocks` is a 422. |
| `PATCH /api/games/:id` | `update-game` | team | Changes the given columns; `platformIds` / `tagIds` replace the links; `blocks` replaces the array but keeps each block's editorial layer by block id. Same slug rule as create. |
| `DELETE /api/games/:id` | `delete-game` | admin | Deletes the game with its links and collection entries. |

### Editorial layer of a game's blocks

| Route | Operation | Who | What it does |
| --- | --- | --- | --- |
| `PATCH /api/games/:id/blocks/:blockId/editorial` | `update-editorial-layer` | team, or agent with `content:edit` | Merges `{ title?, description?, hidden? }` into one block's `editorial` (`null` removes a key), in one statement. Returns `{ id, editorial }`. |
| `PUT /api/games/:id/blocks/order` | `reorder-blocks` | team, or agent with `content:edit` | `{ ids }`: every block id of the game in the new order; writes `editorial.order`. Returns `{ id, ids }`. |

### Collections, platforms, tags

| Route | Operation | Who | What it does |
| --- | --- | --- | --- |
| `GET /api/games/collections` | `list-collections` | anyone | Every collection in display order, each with its published games (with `tagSlugs` and `platformSlugs`). Cached for two minutes. |
| `GET /api/games/collections/:id` | `get-collection` | anyone | One collection with its published games and their entries. |
| `POST /api/games/collections` | `create-collection` | team | `title` required (400 otherwise); `gameIds` creates the entries in order. |
| `PATCH /api/games/collections/:id` | `update-collection` | team | Changes `title`, `slug`, `displayOrder`; `gameIds` replaces the entries. |
| `DELETE /api/games/collections/:id` | `delete-collection` | team | Deletes the collection and its entries; the games stay. |
| `GET /api/games/platforms` | `list-platforms` | anyone | Every platform by name. |
| `POST /api/games/platforms` | `create-platform` | team | `name` required; slug derived from it when missing. |
| `GET /api/games/tags` | `list-tags` | anyone | Every tag by name. |
| `POST /api/games/tags` | `create-tag` | team | `name` required; slug derived from it when missing. |

A collection id that is not a uuid is a 404 before any query, and so is the game id of the two
editorial routes.

## Who can do what

Games have **no owner**: a game belongs to the catalog, not to the account that created it.

| Actor | Published games | Drafts | Create / edit | Delete |
|---|---|---|---|---|
| Anonymous, signed-in user | Read | No (a draft answers 404) | No (403) | No (403) |
| Team: `admin` or `editor`, or an agent with `admin`, `games:*` or `kon:games:*` | Read | Read | Yes | No (403) |
| `admin` (or an agent with `admin`, `games:*`, `kon:games:*` or `game:delete`) | Read | Read | Yes | Yes |

The rule lives in `games.policy.ts` (policy `game`: `view`, `create`, `update`, `delete`,
`actAsUser`) and the routes ask it (`POST /`, `PATCH /:id`, `DELETE /:id`); the core gate
(`auth-guard.ts`) also keeps every write under `/api/games` for staff. The editorial layer of the
blocks (`PATCH /:id/blocks/:blockId/editorial`, `PUT /:id/blocks/order`) is also open to an agent
with `content:edit` (Inti); that scope cannot edit or delete the game itself. A deny wins:
`games:*` with `!game:delete` does not delete.

The tables have no row security; drafts are hidden by the policy in the routes, and collections
only ever list published games.

## The editorial layer of a game's blocks

`games.blocks` is `[{ id, type, order, data, editorial }]`. `data` belongs to the loaders and is
regenerated on every reload; `editorial` is what the team edits by hand (Inti, agents) and reloads
keep it by block `id`. Whoever renders uses `editorial.title ?? data.title`,
`editorial.description ?? data.description`, skips blocks with `editorial.hidden === true` and
sorts by `editorial.order ?? order`.

- `PATCH /api/games/:id/blocks/:blockId/editorial` merges `{ title?, description?, hidden? }`
  (`null` removes a key) into one block's layer in a single statement. Any other key is a 400.
- `PUT /api/games/:id/blocks/order` with `{ ids }` (every block id of the game, in the new order)
  writes `editorial.order`. Ids that are not exactly the game's block ids are a 400.

### From 0.8 (Spanish keys)

Up to Kitsuden 0.8 these keys were `titulo`, `descripcion`, `oculto` and `orden`, block data used
Spanish keys too (`titulo`, `descripcion`, `campos`…; the full table is in the core's
`packages/shared/src/block-keys.ts` and its CHANGELOG), and the routes were
`/bloques/:bloqueId/editorial` and `/bloques/orden`.

- Migration `0003_english_block_keys.sql` rewrites every game's stored `data` and `editorial` to
  the English names; where a block somehow has both, the English value is kept. It is idempotent
  and only touches rows that change.
- Until 0.10, reads still accept a 0.8 key the migration did not see (a loader writing straight
  to the table): game responses, the editorial merge and reorder, and reloads
  (`sqlBlocksWithEditorial`, `keepEditorial`) turn it into the English one.
- Writes speak English only: a 0.8 key in the editorial body, or in the `blocks` of `POST /` and
  `PATCH /:id`, is a 422 whose `hint` names the English key (`renamed` lists them). The old routes
  answer 404.

## Configuration

| Variable | Read in | What it does |
| --- | --- | --- |
| `KITSUDEN_RESERVED_SEGMENTS` | `games.routes.ts` | Comma-separated extra path segments of your site (for example `tournaments,shop`). A game slug equal to one of them, or to a common reserved segment from `@kitsuden/shared`, is a 400 on create and on slug change. Optional. |

No settings beyond that.

## Agents and MCP

Each route is an MCP tool `games__<operation>` with the fine scope `kon:games:<operation>`:
`list-games`, `get-game-by-slug`, `get-game`, `create-game`, `update-game`, `delete-game`,
`update-editorial-layer`, `reorder-blocks`, `list-collections`, `get-collection`,
`create-collection`, `update-collection`, `delete-collection`, `list-platforms`,
`create-platform`, `list-tags`, `create-tag`. `games:*` opens the whole kon; `content:edit` opens
only the two editorial tools.

`delete-game` and `delete-collection` are `DELETE`s, sensitive by default: with human approval on
they can come back `202 KITSUDEN_E_APPROVAL_REQUIRED`. More for agents: [AGENTS.md](AGENTS.md).

## Tests

| File | What it covers |
| --- | --- |
| `tests/unit/games-without-owner.test.ts` | The `game` policy and the routes that ask it |
| `tests/unit/games-delete-admin-only.test.ts` | Only admin deletes; denies win |
| `tests/unit/game-blocks-editorial.test.ts` | The editorial layer: merge, reorder, validation, reloads |
| `tests/unit/save-game-keeps-editorial.test.ts` | Saving the whole game keeps the editorial layer |
| `tests/unit/english-block-keys.test.ts` | Migration `0003` and 0.8 keys on read and write |
| `tests/unit/games-collections-validation.test.ts` | Collection body validation |
| `tests/unit/streamers-and-collections-malformed-ids.test.ts` | Malformed collection ids are a 404 |
| `tests/unit/site-reserved-segments.test.ts` | `KITSUDEN_RESERVED_SEGMENTS` and slugs |
| `tests/unit/inti-contract.test.ts` | The contract the Inti adapter relies on |

```bash
pnpm vitest run tests/unit/game-blocks-editorial.test.ts
pnpm vitest run tests/unit/games-without-owner.test.ts
```

## License

MIT

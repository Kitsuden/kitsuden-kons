# kon-wiki

Wikis with history, one per game. Every save is a new immutable revision; pages can be diffed and
reverted, and `[[Page]]` links are indexed for backlinks and a list of wanted pages. For sites that
keep a reference wiki for each game they cover.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | content | 1.1.2 | `/api/wiki` | core `auth` |

## Install

```bash
kitsuden kon add wiki --enable
```

Run it inside a Kitsuden project. The kon is off by default (`defaultEnabled: false` in
`package.json`): use `--enable`, or switch it on in the admin panel (**Kons**). Restart the API
afterwards. No environment variable is required.

A wiki is tied to a game by `gameId` (a uuid). The kon does not declare a dependency on kon-games
and has no foreign key to `games`; it only stores the id. The public site serves a wiki at
`/<game>/wiki/`; the API does not build that URL.

## What it adds

| Table | What it holds |
| --- | --- |
| `wikis` | One wiki per game: `slug` (unique), `title`, `description`, `game_id`. |
| `wiki_pages` | Pages of a wiki: `slug` (unique inside its wiki), `title`, `current_revision`, `protection` (`open` by default; `locked` reserves editing to admins). |
| `wiki_revisions` | Every saved version of a page: `number` (1, 2, 3… per page), full `content`, `summary`, `author_id`. Never updated or deleted by the API. |
| `wiki_links` | `[[links]]` found in each page's current content (`from_slug` → `to_slug`, per wiki). Rebuilt on every save or revert. |

- **Slugs.** Page slugs are normalized from the title or URL (`wikiPageSlug` in `@kitsuden/shared`:
  accents, apostrophes and spaces). Wiki slugs must be lowercase letters, numbers and single
  hyphens, at most 63 characters (`invalidWikiSlugReason`).
- **Links.** `[[Target]]` and `[[Target|label]]` point to a page of the same wiki. Links to pages
  that do not exist are valid and show up in the wanted-pages list. At most 1,000 links per page are
  indexed (`MAX_LINKS_PER_PAGE`).
- **Revert** never deletes: it writes a new revision with the old content and the summary
  `Reverted to revision <n>`.
- **Identical saves** (same content as the current revision) write nothing and answer
  `unchanged: true`.
- **Diff** is by lines. Above 4,000,000 cells of the comparison table (`MAX_DIFF_CELLS`) the
  changed stretch is returned as all deleted plus all added, so a huge public diff cannot exhaust
  memory.

## HTTP API

All paths are under `/api/wiki`. `:wiki` is the wiki slug, `:slug` the page slug.

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/wiki/wikis` | anyone | All wikis, most recently updated first; `?game=<uuid>` for one game's wiki. `{ docs, total }`. |
| `GET /api/wiki/wikis/suggestion` | anyone | Preview for a new wiki: `?slug=` or `?title=`, and `?game=`. Returns `{ slug, valid, reason }`. Creates nothing. |
| `POST /api/wiki/wikis` | admin | Body `{ title, gameId, slug?, description? }`. Creates a wiki. `409` if the slug is taken or the game already has one (`field` says which); `400` if the slug is invalid. |
| `GET /api/wiki/wikis/:wiki` | anyone | The wiki and its page count (`pages`). |
| `GET /api/wiki/wikis/:wiki/pages` | anyone | Page index (slug, title, current revision, last update), newest first. `limit` up to 500, default 100. |
| `GET /api/wiki/wikis/:wiki/pages/:slug` | anyone | `{ wiki, data, content, backlinks }`: the page, the content of its current revision and the slugs that link to it. |
| `GET /api/wiki/wikis/:wiki/pages/:slug/history` | anyone | Up to 1,000 revisions, newest first: `number`, `summary`, `createdAt`, `size` (characters). No content, no author id. |
| `GET /api/wiki/wikis/:wiki/pages/:slug/diff/:from/:to` | anyone | Line diff between two revision numbers: `data` (ops `keep`/`add`/`del` with the line) and `stats` (`added`, `removed`). |
| `PUT /api/wiki/wikis/:wiki/pages/:slug` | admin, editor | Body `{ content, title?, summary? }` (content up to 500,000 characters). Creates the page if needed and writes a new revision. Returns `{ data, revision }` or `{ data, unchanged: true }`. |
| `POST /api/wiki/wikis/:wiki/pages/:slug/revert/:number` | admin, editor | Writes revision `number`'s content as a new revision. `409` if it is already the current one. |
| `GET /api/wiki/wikis/:wiki/wanted` | anyone | Slugs linked from this wiki that have no page yet, most linked first: `[{ slug, links }]`. |

`404` when the wiki, the page or a revision does not exist, including revision numbers that are not
positive integers.

The API has no route to delete a wiki, page or revision, and no route to change a page's
`protection`; both are done from the admin panel's table views.

## Who can do what

Two policies in `wiki.policy.ts`:

| Policy | Action | Allowed |
| --- | --- | --- |
| `wiki` (pages) | `view` | everyone |
| | `create` | `admin`, `editor` |
| | `update` | `admin` on any page; `editor` on pages whose `protection` is not `locked` |
| | `delete` | `admin` (no route uses it) |
| `wiki-space` (wikis) | `create`, `update`, `delete` | `admin` |

Ordinary signed-in accounts cannot edit. Revision history never exposes `author_id`. The tables
have no row security: everything that exists is public to read.

## Configuration

None. The kon reads no environment variables or settings.

## Agents and MCP

Every operation is an MCP tool named `wiki__<operation>`:

| Operation | MCP tool | Fine scope | Writes | Sensitive |
| --- | --- | --- | --- |
| `list-wikis` | `wiki__list-wikis` | `kon:wiki:list-wikis` | no | no |
| `suggest-wiki` | `wiki__suggest-wiki` | `kon:wiki:suggest-wiki` | no | no |
| `create-wiki` | `wiki__create-wiki` | `kon:wiki:create-wiki` | yes | no |
| `get-wiki` | `wiki__get-wiki` | `kon:wiki:get-wiki` | no | no |
| `list-pages` | `wiki__list-pages` | `kon:wiki:list-pages` | no | no |
| `get-page` | `wiki__get-page` | `kon:wiki:get-page` | no | no |
| `page-history` | `wiki__page-history` | `kon:wiki:page-history` | no | no |
| `compare-revisions` | `wiki__compare-revisions` | `kon:wiki:compare-revisions` | no | no |
| `save-page` | `wiki__save-page` | `kon:wiki:save-page` | yes | no |
| `revert-page` | `wiki__revert-page` | `kon:wiki:revert-page` | yes | yes |
| `requested-pages` | `wiki__requested-pages` | `kon:wiki:requested-pages` | no | no |

Writes are also granted by the broad `wiki:*` and by the policy scopes `wiki:create`,
`wiki:update` (pages) and `wiki-space:create` (wikis). `revert-page` is the one held by default
when an admin turns human approval on. Notes for agents: [AGENTS.md](AGENTS.md).

## Admin panel

The **Wikis** view (`admin/wiki-creator.js`, custom element `wiki-creator`) lists the wikis and
creates new ones, using `suggest-wiki` to preview the slug. It calls the REST routes with the
admin's own session. The panel also has a grid view of `wiki_pages`.

## Tests

| File | What it covers |
| --- | --- |
| `tests/unit/wiki-maps-engine.test.ts` | Slugs, `[[links]]`, line diff, revert as a new revision, identical edits. |
| `tests/unit/sec-data-wiki-maps-formulas.test.ts` | Only the team edits, authorship set by the server, odd revision numbers are 404, the diff cap. |
| `tests/unit/kon-wiki-create-conflict.test.ts` | A taken slug or a game with a wiki is `409`; the definition's admin views match `kon.json`. |

```bash
pnpm vitest run tests/unit/wiki-maps-engine.test.ts
pnpm vitest run tests/unit/sec-data-wiki-maps-formulas.test.ts
pnpm vitest run tests/unit/kon-wiki-create-conflict.test.ts
```

## License

MIT.

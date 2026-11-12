# kon-tierlist

Tier lists on one engine with two uses: editorial templates the site publishes (with a diff
between versions, ready for a "tier list update" post), and personal lists that readers fork from
a template and share with a code. For game sites that rank characters, decks or items.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | gaming | 1.0.2 | `/api/tierlist` | — (core: `auth`) |

## Install

```bash
kitsuden kon add tierlist --enable
```

`package.json` has `defaultEnabled: false`, so pass `--enable` (or switch it on in the admin panel,
**Kons**). Restart the API afterwards. No other kon is required and no environment variable is
read.

## What it adds

One table, `tier_lists`, holds both kinds of list, told apart by `kind`:

- **Template** (`kind: "template"`): a site's editorial tier list. It has a unique `slug`, no
  owner, and is public. `catalog_dataset_id` pins the dataset its items are synced from;
  `manual: true` marks it as ordered by hand (a content loader is expected to leave it alone).
- **Personal list** (`kind: "personal"`): a reader's copy of a template (`template_id`), owned by
  `owner_id`. It is a copy, not a reference: republishing the template does not change it.

Every list has `tiers` (id, label, color; default S, A, B, C, D), `items` (id, label, `imageUrl`,
`sourceRef`, optional `meta` such as `winRate` or `share`) and `placement` (`itemId → tierId`; an
item that is absent is unranked).

A **share code** is base64url of `{ v: 1, t: templateId, p: placement }`: only the placement
travels, never the items. Opening an old code drops items or tiers the template no longer has.

The admin panel gets two views: **Tier list editor** (a custom element built from `admin-src/`,
shipped as `admin/tierlist-editor.js`) and **All tier lists**, a grid over `tier_lists`.

## HTTP API

All paths are under `/api/tierlist`.

### Templates

| Route | Operation | Who | What it does |
| --- | --- | --- | --- |
| `GET /api/tierlist/templates` | `list-templates` | anyone | Every template, most recently updated first: id, slug, title, version. |
| `GET /api/tierlist/templates/:slug` | `get-template` | anyone | The template plus `view`: items grouped by tier, and the unranked pool. |
| `PUT /api/tierlist/templates` | `publish-template` | admin, editor, or agent with `tierlist:publish` | Upsert by slug: 201 created, 200 rewritten. Omitted `tiers`/`items`/`placement` keep the current ones. The whole list is validated first (422 with `issues`). 409 if the slug belongs to a personal row. |
| `POST /api/tierlist/templates/:slug/place` | `place-in-template` | admin, editor, or agent with `tierlist:update` | Moves one item to a tier (`tierId: null` = unranked). 409 if the item or tier does not exist. |
| `POST /api/tierlist/templates/:slug/items` | `add-items` | admin, editor, or agent with `tierlist:update` | Appends 1–200 hand-written items, unranked. 422 with `issues` if the result is invalid (for example a repeated id). |
| `DELETE /api/tierlist/templates/:slug/items/:itemId` | `remove-item` | admin, editor, or agent with `tierlist:update` | Removes an item and its placement. 404 if the template or item does not exist. |
| `POST /api/tierlist/templates/:slug/sync` | `sync-catalog` | admin, editor, or agent with `tierlist:update` | Makes the items equal to a catalog: `catalog` in the body, else `datasetId` (and pins it), else the pinned dataset. New items enter unranked, retired ones leave with their placement, existing placements are kept. 409 with `lost` if hand-added items (no `sourceRef`) would be dropped: repeat with `confirm: true`. 400 if there is no catalog source; 404 if the dataset does not exist or you cannot read it. |
| `GET /api/tierlist/templates/:slug/diff/:otherId` | `compare-versions` | anyone (session optional) | Compares template `slug` (after) with list `otherId` (before): `promoted`, `demoted`, `added`, `removed`, `unchanged`. A personal list you may not see is a 404. |

### Personal lists

| Route | Operation | Who | What it does |
| --- | --- | --- | --- |
| `POST /api/tierlist/templates/:slug/fork` | `fork-template` | any signed-in person, or agent with `tierlist:create` | Creates your list from a template, with an optional starting `placement` or the `code` of another list. Returns the list and its share code (201). |
| `POST /api/tierlist/mine/:id/place` | `place-in-my-list` | the owner (or admin) | Moves one item in your list; returns the list and its updated share code. Someone else's list is a 404. |
| `GET /api/tierlist/decode/:code` | `open-code` | anyone (session optional) | Decodes a share code into its template and the grouped view. 400 if unreadable, 404 if the template is gone or not visible to you. |

There is no route to list, rename or delete a personal list.

## Who can do what

The policy is `tierlist` in `tierlist.policy.ts`.

| Caller | Read templates | Write templates | Fork | Personal lists |
| --- | --- | --- | --- | --- |
| Anonymous | Yes | No (401) | No (401) | Open a share code only |
| Signed-in person | Yes | No (403) | Yes | Their own |
| Editor | Yes | Yes (publish, place, add, remove, sync) | Yes | Their own |
| Admin | Yes | Yes | Yes | Any (row security lets admin through) |
| Agent | Yes | `tierlist:publish` to publish; `tierlist:update` to place, add, remove, sync | `tierlist:create` | Its own |

- `content:edit` does not grant any tier list write.
- Row security on `tier_lists`: templates (`kind <> 'personal'`) are readable by anyone
  (`tier_lists_templates_select`) and writable only by the roles `admin`, `editor` and `agent`
  (`tier_lists_templates_edit`, migration `0005_english_rls.sql`); the scope check for agents is
  in the application. Personal lists are isolated to owner and admin by the core's
  `rls-owned-tables.sql` (`tier_lists`, `owner_id`).
- Someone else's personal list answers **404**, not 403: in `place-in-my-list`, in the
  `otherId` of `compare-versions`, and as the target of a share code.

## Configuration

None. Limits are in the validation schemas of `index.ts`: 1–12 tiers, up to 1,000 items per
template or synced catalog, 1–200 items per `add-items` call, item images must be `http(s)` URLs.

## Agents and MCP

Each route is a kon SDK operation and an MCP tool `tierlist__<operation>` with the fine scope
`kon:tierlist:<operation>`; `tierlist:*` opens the whole kon.

| MCP tool | Writes | Notes |
| --- | --- | --- |
| `tierlist__list-templates` | No | |
| `tierlist__get-template` | No | |
| `tierlist__publish-template` | Yes | Declared sensitive: may need human approval |
| `tierlist__place-in-template` | Yes | Declared idempotent |
| `tierlist__add-items` | Yes | |
| `tierlist__remove-item` | Yes | `DELETE`: sensitive by default |
| `tierlist__sync-catalog` | Yes | Declared sensitive: may need human approval |
| `tierlist__compare-versions` | No | |
| `tierlist__fork-template` | Yes | |
| `tierlist__place-in-my-list` | Yes | Declared idempotent |
| `tierlist__open-code` | No | |

A sensitive operation can come back `202 KITSUDEN_E_APPROVAL_REQUIRED` when an admin has turned
human approval on. More for agents: [AGENTS.md](AGENTS.md).

## Tests

| File | What it covers |
| --- | --- |
| `tests/unit/tierlist-engine.test.ts` | The engine: creation, validation, placing, sync, diff, codes |
| `tests/unit/tierlist-meta.test.ts` | Item `meta` (card game stats), `calculatePlacementsFromStats` |
| `tests/unit/tierlist-from-dataset.test.ts` | Building the catalog from a dataset |
| `tests/unit/tierlist-without-catalog.test.ts` | Adding and removing by hand, and sync stopping before it drops hand-added items |
| `tests/unit/sec-cards-tierlist.test.ts` | Who may publish, place, fork; someone else's personal list through diff and codes; `/sync` input |
| `tests/unit/mcp-full-path.test.ts` | The character tier list recipe through MCP |
| `tests/unit/tierlist-editor-render.test.ts`, `tests/unit/tierlist-without-output.test.ts` | The admin editor view |

```bash
pnpm vitest run tests/unit/tierlist-engine.test.ts
pnpm vitest run tests/unit/sec-cards-tierlist.test.ts
```

## License

MIT

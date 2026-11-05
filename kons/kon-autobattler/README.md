# kon-autobattler

Team compositions ("comps") for autobattler games such as Teamfight Tactics: staff import a set
(units, traits, items, augments and board rules), anyone checks the synergies of a board, and
signed-in users save comps that staff rank into a tier list.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | gaming | 1.0.1 | `/api/autobattler` | — (core: `auth`) |

## Install

```bash
kitsuden kon add autobattler --enable
```

The kon is off by default (`defaultEnabled: false` in `package.json`), so pass `--enable` or switch
it on in the admin panel (**Kons**). Restart the API afterwards. No other kon and no environment
variable is needed.

The kon ships no game data. Load a set with `POST /api/autobattler/sets/import` before the other
routes have anything to work on.

## What it adds

- **Set** (`autobattler_sets`): one game set (`slug`, `name`, `game` default `tft`, `patch`,
  `source`, `current`) and its rules: board rows and columns, items per unit, team size by level,
  augment slots, unit costs. Importing with `current: true` makes it the only current set of its
  game.
- **Entities** (`autobattler_entities`): the units, traits, items and augments of a set, one row
  each (`kind`, `entity_id`, `name`, `icon`, and the rest in `data`). Unique by set, kind and id.
- **Comp** (`autobattler_comps`): a saved board (`slots` with unit, cell, items, emblems, stars,
  `core` flag), level, augments, carousel priority, tags, computed gold cost, its author, an
  editorial `tier`, external `stats` with their `stats_source`, and `status` (`published` or
  `hidden`).

The engine (`autobattler.engine.ts`, `autobattler.builder.ts`) computes:

- trait synergies: distinct units per trait plus emblems, the highest threshold reached and how
  many units are missing for the next one;
- rule issues: unknown units, items, traits or augments, cells off the board or taken twice, too
  many units for the level, too many items, a repeated unique item, too many augments;
- gold cost (a 2-star unit is 3 copies, a 3-star 9);
- which items can be crafted from some components, and the components of an item;
- unit suggestions ranked by the trait thresholds they would complete, and a plan for one trait.

The kon does not compute meta statistics (average placement and so on). Staff store them on a comp
with the source they came from.

## HTTP API

Sets and catalogue:

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/autobattler/sets` | anyone | Every set, current ones first, then by name. `?game=` filters. |
| `POST /api/autobattler/sets/import` | admin, editor, or an agent with `autobattler:import` | Upsert a set by `slug` with all its entities (1 to 20,000), matched by kind and id; repeated ids in the batch are collapsed. Returns 201 with `created`, `updated`, `total`, `collapsed`. Icons must be `http(s)` or `/path`. |
| `GET /api/autobattler/sets/:slug` | anyone | The set and how many entities of each kind it has. |
| `GET /api/autobattler/sets/:slug/comps` | anyone | Published comps of the set in tier order (S, A, B… then unranked; then best average placement; then most recently updated). `?tag=` filters. |
| `GET /api/autobattler/sets/:slug/:kind` | anyone | Entities of one kind (`units`, `traits`, `items`, `augments`) by name. `?q=` matches the name; any other query key filters on that `data` field. Another kind is a 404. |
| `GET /api/autobattler/sets/:slug/items/:id/components` | anyone | The components an item is built from. |

Calculators (save nothing; the body names the set with `setSlug`):

| Route | Who | What it does |
| --- | --- | --- |
| `POST /api/autobattler/analyse` | anyone | Traits of the board (all and active), rule issues, gold cost, unit count. |
| `POST /api/autobattler/suggest` | anyone | Units that fit the board, ranked by thresholds they complete. Options `limit`, `costs`, `traitId`, `ignoreLevel`; `meta.full` says the board is full. |
| `POST /api/autobattler/trait-plan` | anyone | For `traitId`: count, thresholds, next threshold, units that would complete it. |
| `POST /api/autobattler/craft` | anyone | Items of the set that can be built from `components`. |

Comps:

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/autobattler/comps/:slug` | anyone (hidden: author and staff) | The comp, its set, its traits and the board with each unit and item resolved. 409 if its set no longer exists. |
| `POST /api/autobattler/comps` | any signed-in account | Save a comp as yours, published. The slug comes from the title plus a random suffix; the gold cost is computed. A comp with rule issues is a 422 with `issues`. |
| `DELETE /api/autobattler/comps/:id` | the author, or staff | Delete a comp. 204. |
| `POST /api/autobattler/comps/:id/rank` | admin, editor | Set `tier` (null removes it), `hide`, and `stats` with `statsSource` (stats without a source are a 422). Omitted fields keep their value. Never the author. |

## Who can do what

The policy is `autobattler.policy.ts` (resource `autobattler`):

| Action | Who |
| --- | --- |
| `view` a comp | anyone if published; a hidden comp only its author, admin or editor |
| `create` a comp | any account with an id |
| `import` a set | admin, editor |
| `update`, `delete` a comp | its author, admin, editor |
| `rank` (tier, stats, hide) | admin, editor; never the author |
| `actAsUser` | how an agent passes the session routes: `user:act`, `admin` or an `autobattler` scope |

Agents: an agent first needs `actAsUser` for the session routes, then the action's scope
(`autobattler:import`, `autobattler:create`, `autobattler:delete`, `autobattler:rank`) or
`autobattler:*`. A hidden comp answers 404 to anyone the policy does not let see it.

The tables have no row-security policy; visibility is decided in the handlers by the policy.

## Configuration

None. The kon reads no environment variable and no setting. Each API process keeps a loaded set in
memory for 120 seconds; importing a set clears that set from the cache of the process that served
the import.

## Agents and MCP

Every route is an SDK operation and an MCP tool:

| MCP tool | Fine scope | Writes |
| --- | --- | --- |
| `autobattler__list-sets` | `kon:autobattler:list-sets` | no |
| `autobattler__get-set` | `kon:autobattler:get-set` | no |
| `autobattler__import-set` | `kon:autobattler:import-set` | yes, marked sensitive |
| `autobattler__list-set-comps` | `kon:autobattler:list-set-comps` | no |
| `autobattler__search-entities` | `kon:autobattler:search-entities` | no |
| `autobattler__analyze-comp` | `kon:autobattler:analyze-comp` | no |
| `autobattler__suggest-units` | `kon:autobattler:suggest-units` | no |
| `autobattler__trait-plan` | `kon:autobattler:trait-plan` | no |
| `autobattler__craftable-items` | `kon:autobattler:craftable-items` | no |
| `autobattler__item-components` | `kon:autobattler:item-components` | no |
| `autobattler__get-comp` | `kon:autobattler:get-comp` | no |
| `autobattler__create-comp` | `kon:autobattler:create-comp` | yes |
| `autobattler__delete-comp` | `kon:autobattler:delete-comp` | yes, sensitive (DELETE) |
| `autobattler__rank-comp` | `kon:autobattler:rank-comp` | yes, marked sensitive |

`import-set`, `delete-comp` and `rank-comp` are sensitive: with human approval turned on, an agent's
call answers `202 KITSUDEN_E_APPROVAL_REQUIRED` until a person approves it. See
[AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/autobattler-engine.test.ts` | Trait thresholds, distinct units, emblems, comp validation, gold cost, crafting. |
| `tests/unit/autobattler-builder.test.ts` | Unit suggestions, full board, trait plan. |
| `tests/unit/sec-cards-deckshow-autobattler.test.ts` (`describe("autobattler: ...")`) | Importing a set is editorial; `autobattler:import` works for an agent; icon URLs. |

```bash
pnpm vitest run tests/unit/autobattler-engine.test.ts
pnpm vitest run tests/unit/autobattler-builder.test.ts
pnpm vitest run tests/unit/sec-cards-deckshow-autobattler.test.ts
```

## License

MIT

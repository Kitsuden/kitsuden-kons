# AGENTS.md — kon-autobattler

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

Autobattler sets (units, traits, items, augments, board rules), a synergy engine over them, and
saved comps with an editorial tier list. Mounted at `/api/autobattler`. Reads and calculators are
public; saving comps needs an account; importing sets and ranking comps is for staff.

## Calling it

- Read and calculate: no scope (`list-sets`, `get-set`, `list-set-comps`, `search-entities`,
  `item-components`, `get-comp`, `analyze-comp`, `suggest-units`, `trait-plan`,
  `craftable-items`).
- Session operations first need `actAsUser`: `user:act`, `admin` or any `autobattler` scope. Then
  each one checks its own action in the handler:
  - `create-comp`: `autobattler:create` (or `user:act`, since `create` allows any account with an id).
  - `delete-comp`: `autobattler:delete`; a human must be the author or staff.
  - `import-set`: `autobattler:import`.
  - `rank-comp`: `autobattler:rank`.
  - `autobattler:*` covers all of them; fine scopes are `kon:autobattler:<operation>`.
- MCP tools are `autobattler__<operation>`. The calculators take the board in `body`
  (`setSlug`, `slots`, `level`, `augments`) and return `{ data }`; `suggest-units` also returns
  `meta.full` and `meta.summary`.
- Sensitive, may come back `202 KITSUDEN_E_APPROVAL_REQUIRED`: `import-set`, `rank-comp`,
  `delete-comp`. Report the proposal; do not retry.
- 404: the set, comp, trait or item does not exist, the `:kind` is not one of `units`, `traits`,
  `items`, `augments`, or the comp is hidden and the caller is neither its author nor staff.
  409 on `get-comp`: the comp's set was deleted.
- Idempotency: `import-set` is an upsert by slug and by (kind, id), so repeating it leaves the same
  data. `create-comp` is not: each call makes a new comp with a new random slug suffix; pass an
  `idempotency_key` if you may retry.
- Refused on purpose:
  - an author cannot rank, hide or set stats on their own comp (`rank` is staff only);
  - `stats` without a `statsSource` (the comp has none yet) are a 422;
  - a comp with rule issues cannot be saved (422 with `issues`), but the calculators accept it;
  - icons that are not `http(s)` or `/path` are a 422 on import;
  - there is no route to edit a saved comp's board; delete it and save a new one.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | All operations, input schemas, the in-memory set cache (`loadSet`, 120 s), `defineKonSdk` with three admin grid views. |
| `operations.ts` | `KON_ID`, the `registry()` helper that turns `app.get(path, declaration, handler)` into SDK operations, `ANY_ACCOUNT`. |
| `autobattler.policy.ts` | The `autobattler` policy: `view`, `create`, `import`, `update`, `delete`, `rank`, `actAsUser`. |
| `autobattler.engine.ts` | `activateTraits`, `tierFor`, `onlyActive`, `validateComp`, `compCost`, `craftableFrom`, `componentsOf`. |
| `autobattler.builder.ts` | `suggestUnits`, `unitsForTrait`, `compIsFull`, `traitPlan`, `compSummary`. |
| `autobattler.types.ts` | Set, unit, trait, item, augment, rules and comp types. |
| `autobattler.schema.ts` | Drizzle tables `autobattler_sets`, `autobattler_entities`, `autobattler_comps`. |
| `migrations/0001_autobattler.sql` | Creates the three tables and their indexes. |
| `migrations/0002_comp_card.sql` | Adds `autobattler_comps.carousel`. |
| `migrations/0003_english_names.sql` | Renames stored scopes, tool names and pending proposals from the old Spanish operation ids. |
| `migrations/history.json` | Rename of `0002_comp_card.sql` (old name `0002_ficha_de_comp.sql`) and earlier checksums. |

## Rules that must hold

- A trait counts distinct units; an emblem of a trait the unit already has does not count twice;
  the active tier is the highest reached even if the source lists tiers unsorted
  (`tests/unit/autobattler-engine.test.ts`).
- `validateComp` never throws; it returns readable issues (same test file).
- Importing a set is editorial: a normal account gets 403
  (`tests/unit/sec-cards-deckshow-autobattler.test.ts`).
- `rank` is separate from `update`: the author never sets the tier (`autobattler.policy.ts`).
- Stats are stored only with a source (`rank-comp` in `index.ts`).
- A hidden comp is a 404, not a 403, for whoever may not see it (`get-comp`).
- `list-set-comps` returns only `published` comps.
- After an import, `cache.delete(slug)` must stay, or calculators serve the old patch for up to
  120 seconds in that process.
- Operation ids are part of the contract (scopes, MCP tool names). Do not rename them.

## Changing it

- New migration: next number in `migrations/` (`0004_...sql`), never edit an applied one. A file
  rename or a reworded comment is declared in `migrations/history.json`.
- New file at the root: run `pnpm kon:sync` (it updates package.json `files` and kon.json).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- Literal routes go before parametric ones: `/sets/:slug/comps` must stay before
  `/sets/:slug/:kind`.
- Queries in a handler run one after another (one request transaction); no `Promise.all`.

## Tests

```bash
pnpm vitest run tests/unit/autobattler-engine.test.ts               # after touching autobattler.engine.ts
pnpm vitest run tests/unit/autobattler-builder.test.ts              # after touching autobattler.builder.ts
pnpm vitest run tests/unit/sec-cards-deckshow-autobattler.test.ts   # after touching index.ts or the policy
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-autobattler"  # these docs
```

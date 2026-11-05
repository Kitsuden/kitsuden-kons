# kon-character-builder

A character builder engine where each game's builder is data: a definition with slots, options,
budgets and formulas. It validates builds, computes final stats, gives each build a share code,
and keeps a public gallery of builds with votes. For game sites that offer build planners.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | gaming | 1.1.0 | `/api/builder` | `kon-formulas` (^1.0.0); core: `auth` |

## Install

```bash
kitsuden kon add formulas
kitsuden kon add character-builder --enable
```

`kon-formulas` is required: the engine evaluates every formula with it. `package.json` has
`defaultEnabled: false`, so pass `--enable` (or switch it on in the admin panel, **Kons**).
Restart the API afterwards. No environment variable is read.

The mount path is `/api/builder`, not `/api/character-builder`; the kon id, scopes and MCP tools
use `character-builder`.

## What it adds

- **Definition** (`builder_definitions`): one game's builder, by `slug`. It holds `baseStats`,
  `slots` (each with a `capacity`, `options` and whether it is `required`), `budgets` (points that
  options in some slots consume), `derived` stats (formulas evaluated by kon-formulas, in any
  order) and an optional `subjectSlot` (the slot that says whose build it is, for the gallery).
  Options carry `modifiers`, `cost`, `requires`, `excludes` and an optional `group` (at most one
  option per group in a slot). A slot can also take options from a dataset with `optionsFrom`
  (`datasetId`, `idField`, `costField`, `statFields`, `groupField`, `where`). State is `draft` or
  `published`.
- **Build** (`builder_builds`): what a user chose in each slot and how they spent attributes,
  saved with a `name`, its share `code`, `visibility` (`private`, `unlisted`, `public`), the
  `subject` computed by the server, a `votes` counter and `published_at`.
- **Link planner builds**: a build can also belong to a planner that keeps its state in the page
  address. Its `builderId` is `link:<game>:/<path>` and the build carries only `link` (a `#…`
  fragment) and an optional `label`; there is no definition to validate against.
- **Vote** (`builder_build_votes`): one per person and build.

A **share code** is base64url of `{ v: 1, b: builderId, s: selections, a: attributes }`.

The admin panel gets three views: **Definition** (a definition editor, a custom element built
from `admin-src/` and shipped as `admin/definition-editor.js`), **All definitions** and **Saved
builds** (grids).

## HTTP API

### Definitions

| Route | Operation | Who | What it does |
| --- | --- | --- | --- |
| `GET /api/builder/definitions` | `list-definitions` | anyone | id, slug, name and state of each definition, by name. Drafts only for the builder team. |
| `GET /api/builder/definitions/:slug` | `get-definition` | anyone | The definition with dataset-backed options filled in; `meta.datasets` says, per slot, which dataset fed it or why it could not be read. A draft is a 404 for anyone outside the team. |
| `POST /api/builder/definitions/validate` | `validate-definition` | any account | Compiles a definition without saving it: `{ ok: true }` or `{ ok: false, error }` (both 200). 400 without `definition`. |
| `PUT /api/builder/definitions` | `publish-definition` | builder team, or agent with `builder:publishDefinition` | Upsert by `slug`: 201 created, 200 rewritten. Compiled first (422 with the formula error). `published` sets `draft`/`published`; omitted, a new definition is a draft and an existing one keeps its state. |
| `POST /api/builder/definitions/:slug/compute` | `compute-build` | anyone | Validates a build against the definition and returns `data` (stats), `issues` (warnings such as unspent points) and `code`. 422 with `issues` if the build breaks a rule. Saves nothing. |
| `GET /api/builder/decode/:code` | `open-build-code` | anyone | Decodes a share code into `builderId` and `build`. 400 if unreadable. |

### Builds

| Route | Operation | Who | What it does |
| --- | --- | --- | --- |
| `POST /api/builder/builds` | `save-build` | any account | Validates and saves a build (`builderId`, `build`, optional `name`, `visibility`, default `private`). Saving the same build again updates it (200) and never lowers its visibility. 404 if the definition does not exist or is a draft you cannot see; 409 at 100 builds per planner or 1,000 in total; 429 after 60 new builds in 10 minutes (not for admin). |
| `GET /api/builder/builds/mine?builder=<id>` | `list-my-builds` | the caller (401 without a session) | Your builds in one planner, private ones included, newest first, up to 100. 400 without `builder`. |
| `GET /api/builder/builds?builder=<id>` | `list-builds` | anyone | The gallery: public builds of a planner, optionally of one `subject`, most voted first; `limit` 1–100 (default 24). Each says whether you `voted` it. Owner ids are left out. |
| `GET /api/builder/builds/:id` | `get-build` | anyone for public and unlisted; owner or admin for private | One build with `voted`. A private build of someone else is a 404. |
| `PATCH /api/builder/builds/:id` | `update-build` | owner or admin | Changes `name` and/or `visibility`. The publication date is set the first time it becomes public. Anyone else: 403. |
| `DELETE /api/builder/builds/:id` | `delete-build` | owner or admin | Deletes the build and all its votes. Anyone else: 403. |
| `POST /api/builder/builds/:id/vote` | `vote-build` | any account | Toggles your vote and returns the recounted total. 404 if you cannot see the build, 409 if it is private. |

## Who can do what

The policy is `builder` in `character-builder.policy.ts`.

| Caller | Published definitions | Drafts, publish a definition | Own builds | Others' builds |
| --- | --- | --- | --- | --- |
| Anonymous | Read, compute | No (draft = 404) | — | Read public and unlisted |
| Signed-in person | Read, compute, validate | No (403) | Save, list, rename, publish, delete, vote on others' | Read public and unlisted, vote |
| Admin, editor | Yes | Yes | Yes | Admin only: read, edit and delete any |
| Agent | Read, compute | `builder:publishDefinition`, `builder:*`, `character-builder:*` or `admin` | Needs `user:act`, `admin` or a scope of the kon | As a person |

- The builder team is "effective staff" of the kon: a human admin or editor, or an agent with
  `admin`, `character-builder:*` or `kon:character-builder:*`.
- Row security: `builder_builds` and `builder_build_votes` are owner-isolated by the core's
  `rls-owned-tables.sql` (owner, admin or system); migration `0005_english_rls.sql` adds
  `builder_builds_public_select`, so anyone reads `public` and `unlisted` builds. Votes are not
  readable by others; the vote count and the deletion of a build's votes run as the system after
  the policy check.
- 404 instead of 403: a draft definition (read, compute, save against it) and someone else's
  private build (read, vote). Editing or deleting someone else's visible build is a 403.

## Configuration

None. Limits are constants in `index.ts`: 100 slots and 100 ids per slot in a build, 100 builds
per person and planner, `MAX_BUILDS` (1,000 in total, 60 new per 10 minutes).

## Agents and MCP

Every route is an MCP tool `character-builder__<operation>` with the fine scope
`kon:character-builder:<operation>` (all 13 are listed in `kon.json` `permissions.scopes`).
`character-builder:*` opens the whole kon.

| MCP tool | Writes |
| --- | --- |
| `character-builder__list-definitions`, `character-builder__get-definition` | No |
| `character-builder__validate-definition`, `character-builder__compute-build` | No (declared read-only) |
| `character-builder__open-build-code` | No |
| `character-builder__publish-definition` | Yes, sensitive |
| `character-builder__save-build`, `character-builder__update-build`, `character-builder__vote-build` | Yes |
| `character-builder__list-my-builds`, `character-builder__list-builds`, `character-builder__get-build` | No |
| `character-builder__delete-build` | Yes, sensitive |

`publish-definition` and `delete-build` are the sensitive operations (`kon.json`
`permissions.sensitive`): with human approval on, they can come back
`202 KITSUDEN_E_APPROVAL_REQUIRED`. More for agents: [AGENTS.md](AGENTS.md).

## Tests

| File | What it covers |
| --- | --- |
| `tests/unit/builder-engine.test.ts` | Compile, validate, compute, share codes, subject, gallery rules, link builds |
| `tests/unit/builder-groups-and-filters.test.ts` | `optionsFromEntries`, option groups |
| `tests/unit/kons-from-dataset.test.ts` | Options read from a dataset (shared with kon-cardsim) |
| `tests/unit/kon-builder-security.test.ts` | Others' builds, votes, drafts, caps, who publishes a definition |

```bash
pnpm vitest run tests/unit/builder-engine.test.ts
pnpm vitest run tests/unit/kon-builder-security.test.ts
```

## License

MIT

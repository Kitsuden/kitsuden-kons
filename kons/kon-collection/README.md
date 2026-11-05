# kon-collection

Lets each signed-in reader mark which records of an index (a dataset: a creature log, a card list,
a gacha roster) they already have, and keeps that list for them across devices. For sites that
draw an index and want a personal "have / missing" tracker on top of it.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | gaming | 1.0.1 | `/api/collection` | — (core: `auth`) |

## Install

```bash
kitsuden kon add collection --enable
```

`package.json` has `defaultEnabled: false`, so pass `--enable` (or switch it on in the admin panel,
**Kons**). Restart the API afterwards. No other kon is required and no environment variable is
read.

## What it adds

The kon stores only *which* records each person has marked. The records themselves stay in the
index (a core dataset, `data_sets`); there is no records table here, so if the index changes the
collection does not need to.

| Table | What it holds |
| --- | --- |
| `collection_marks` | One row per (person, index, record): `user_id`, `dataset_id`, `entry_key`, `state` (always `caught` today), `created_at`. The primary key is the trio, so marking twice stores one row. |

`entry_key` is the record's key inside the index (its slug, for example `emberpup`), not a row
uuid. If a record's slug changes, its marks are orphaned.

The admin panel gets one grid view, **Collection marks**, over `collection_marks`.

## HTTP API

Every route needs a session (`access: "session"`); without one the answer is 401. `:datasetId` is
the uuid of the index; anything that is not a uuid answers 404.

| Route | Operation | Who | What it does |
| --- | --- | --- | --- |
| `GET /api/collection/:datasetId` | `get-my-collection` | any account | Returns `{ data: { marks: [entryKey…] } }`: the keys of that index you have marked. An index you never marked returns an empty list. |
| `PUT /api/collection/:datasetId` | `mark-entry` | a person, or an agent with `collection:create` | Body `{ entryKey, have }`. `have: true` marks, `have: false` unmarks. Marking twice is not an error. 404 if the index does not exist (only checked when marking); 409 when your collection of that index already has 20,000 marks. |
| `POST /api/collection/:datasetId/many` | `mark-many` | a person, or an agent with `collection:create` | Body `{ entryKeys: [...] }` (up to 2,000). Adds, never replaces; duplicates and keys already marked are skipped; keys beyond the 20,000 cap are left out. Returns your whole collection of that index. 404 if the index does not exist. |
| `DELETE /api/collection/:datasetId` | `clear-my-collection` | any account | Removes all your marks of that index. Cannot be undone. |

Validation: `entryKey` is 1–120 characters of `A-Z a-z 0-9 . _ -`. A bad key, a wrong type or an
unknown field is a 422; a batch with more than 2,000 keys or one bad key is refused whole.

## Who can do what

The policy is `collection` in `collection.policy.ts`.

| Caller | Read / empty own | Mark (one or many) | Someone else's collection |
| --- | --- | --- | --- |
| Anonymous | No (401) | No (401) | No |
| Signed-in person | Yes | Yes | No |
| Admin (human) | Yes, their own | Yes, their own | Not through the API; row security lets an admin read every row (for support) |
| Agent with `user:act`, `admin` or any `collection` scope | Yes, its own | Only with `collection:create`, `collection:*`, `admin` or the operation's fine scope | No |
| Agent with only `mcp:connect` | No | No | No |

- Every route works on the caller's own marks: the user id comes from the session, never from the
  body. There is no route that reads another person's collection, and no public read.
- `collection_marks` has forced row security from the core's `rls-owned-tables.sql`: a row is
  visible and writable only for its owner, an admin, or the system (no user and no role).
- A deny in an agent key (`!kon:collection:mark-entry`, `!collection:*`…) wins over any grant,
  `admin` included.

## Configuration

None. Two limits are constants in `index.ts`: `MAX_MARKS = 20000` marks per person and index, and
2,000 keys per `mark-many` request.

## Agents and MCP

Each route is a kon SDK operation, so it is also an MCP tool.

| MCP tool | Fine scope | Writes |
| --- | --- | --- |
| `collection__get-my-collection` | `kon:collection:get-my-collection` | No |
| `collection__mark-entry` | `kon:collection:mark-entry` | Yes |
| `collection__mark-many` | `kon:collection:mark-many` | Yes (declared idempotent) |
| `collection__clear-my-collection` | `kon:collection:clear-my-collection` | Yes (DELETE: sensitive by default) |

`collection__clear-my-collection` is a `DELETE`, so it is sensitive by default: when an admin turns
human approval on, it can come back `202 KITSUDEN_E_APPROVAL_REQUIRED`. An agent always acts on its
own collection. Notes for agents and for coding agents: [AGENTS.md](AGENTS.md).

## Tests

| File | What it covers |
| --- | --- |
| `tests/unit/kon-collection-routes.test.ts` | Forced row security, who may use each route (people, agents, fine scopes, denies), validation, mark/unmark/batch/empty, the 20,000 cap |
| `tests/unit/kon-collection-and-analytics-security.test.ts` | One person cannot read, empty or mark for another; agents without scope; made-up indexes; per-person cap |

```bash
pnpm vitest run tests/unit/kon-collection-routes.test.ts
pnpm vitest run tests/unit/kon-collection-and-analytics-security.test.ts
```

## License

MIT

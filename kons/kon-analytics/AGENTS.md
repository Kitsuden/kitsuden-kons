# AGENTS.md — kon-analytics

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

A public view counter: one row per subject and day in `analytics_views`, incremented by
`POST /api/analytics/hit`. It stores no IP, cookie, user agent or user id, so it counts views and
never unique visitors.

## Calling it

- **Scopes.** All operations are public: no scope is needed to read. If a key is restricted by
  fine scopes, the reads are `kon:analytics:get-most-viewed` and `kon:analytics:get-subject-series`
  (or the broad `analytics:*`). A deny such as `!kon:analytics:*` closes them even though they are
  public.
- **MCP tools.**
  - `analytics__get-most-viewed`: `{ type, days, docs: [{ subjectId, views }] }`, most viewed
    first. Arguments `type`, `days`, `limit`, `ids` are strings (query parameters).
  - `analytics__get-subject-series`: `{ type, id, days, total, docs: [{ day, views }] }`, oldest
    day first.
  - `add-view` is not an MCP tool on purpose: an agent reading a page is not a view. Do not call
    `POST /hit` over REST to "register" agent reads either.
- **Approval.** No operation is sensitive; none should come back `202 KITSUDEN_E_APPROVAL_REQUIRED`
  unless an admin turned approval on for it. If one does, report it and do not retry.
- **404s.** There are none from the handlers: an unknown subject gives an empty series, and `hit`
  answers `204` whether or not the subject exists (so the answer cannot be used to probe ids).
  Invalid type or id is `400`. There is no row security.
- **Idempotency.** `hit` is not idempotent: every accepted call adds one view.
- **Refused or ignored.** A view count in the body (`views`, `count`) is ignored. Subject types
  outside `MEASURABLE_SUBJECTS` are `400`. More than 100 `ids` in `top` are cut to 100, non-uuids
  are dropped. `days` is clamped to 1-365 and `limit` to 1-50.

## Map of the code

| File | Responsibility |
| --- | --- |
| `kon.json` | Manifest: id, version, table, mount path, maturity. |
| `package.json` | npm package; `files` and `version` kept in sync by `pnpm kon:sync`. |
| `index.ts` | `defineKonSdk` definition: mount, operations, `rateLimits`, admin grid view, startup check that the table exists. |
| `analytics.routes.ts` | The three operations, bot filter `isBot`, subject existence check (`SUBJECT_TABLE`), `ANALYTICS_LIMITS`. |
| `analytics.schema.ts` | Drizzle table `analytics_views` and `MEASURABLE_SUBJECTS`. |
| `migrations/0000_analytics.sql` | Creates the table and its two indexes. |
| `migrations/0001_english_names.sql` | Renames the indexes and stored scopes/tool names to English. |
| `migrations/history.json` | Declares the rename of `0000_analitica.sql` to `0000_analytics.sql` and its previous checksums. |
| `tsconfig.json` | Extends `../../tsconfig.kons.json`. |

## Rules that must hold

- **No personal data.** No column or log for IP, user agent, cookie or user. Guarded by
  `tests/unit/analytics-without-personal-data.test.ts` and
  `tests/unit/kon-collection-and-analytics-security.test.ts`.
- **One request, one view.** The count is never taken from the body; the increment is an UPSERT on
  `(subject_type, subject_id, day)` so concurrent hits are not lost
  (`tests/unit/kon-analytics-routes.test.ts`).
- **Same answer for real and made-up subjects.** `hit` returns `204` either way and only inserts for
  subjects that exist (when their table is installed).
- **The existence check never breaks the request.** It runs in a savepoint and returns `true` on
  any error; the table name comes from `SUBJECT_TABLE`, never from the request.
- **Bounded queries.** `days` 1-365, `limit` 1-50, `ids` at most 100.
- **`hit` keeps its own rate limit** (`ANALYTICS_LIMITS`, 30/min per IP), checked in
  `kon-collection-and-analytics-security.test.ts`.

## Changing it

- **New subject type:** add it to `MEASURABLE_SUBJECTS` and its table to `SUBJECT_TABLE`. No
  migration is needed.
- **New migration:** next number in `migrations/` (`0002_...`); never edit an applied one. A rename
  or a comment-only change of an applied file goes in `migrations/history.json` (`renamed`:
  new name to old name; `previousChecksums`).
- **New file at the root:** run `pnpm kon:sync` (updates `package.json` `files` and `kon.json`).
- **Behaviour change:** bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- Do not rename operation ids: they are the MCP tool names and fine scopes stored in agent keys.

## Tests

```bash
pnpm vitest run tests/unit/kon-analytics-routes.test.ts
pnpm vitest run tests/unit/analytics-without-personal-data.test.ts
pnpm vitest run tests/unit/kon-collection-and-analytics-security.test.ts
```

Touching `analytics.routes.ts`: run all three. Touching `analytics.schema.ts` or a migration: run
`analytics-without-personal-data.test.ts` and `kon-analytics-routes.test.ts`, then
`pnpm test:guards`.

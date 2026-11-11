# kon-analytics

Counts views per subject and per day (games, blog posts, wiki pages, wikis, datasets, tournaments,
streamers) without cookies, IP addresses or any other personal data. For sites that want a "most
viewed" list and a per-page view series without a consent banner.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | content | 1.0.2 | `/api/analytics` | — |

## Install

```bash
kitsuden kon add analytics --enable
```

Run it inside a Kitsuden project. `--enable` is needed because the kon is off by default
(`defaultEnabled: false` in `package.json`); without it, switch it on in the admin panel (**Kons**).
Restart the API afterwards. No other kon and no environment variable is required.

## What it adds

One table, `analytics_views`: one row per subject and day, with a counter (`views`) that goes up
with an atomic UPSERT on the unique key `(subject_type, subject_id, day)`.

- **Subject**: a `subject_type` and a uuid `subject_id`. The valid types are listed in
  `MEASURABLE_SUBJECTS` (`analytics.schema.ts`): `game`, `blog_post`, `wiki_page`, `wiki`, `dataset`,
  `tournament`, `streamer`. `subject_type` is text, not an enum: adding a type is a code change,
  not a migration.
- **Views, not visitors.** Nothing that identifies the viewer is stored, so unique visitors cannot
  be counted and are never reported.
- **Existence check.** Before counting, `hit` checks that the subject exists in its table
  (`SUBJECT_TABLE` in `analytics.routes.ts`: `games`, `blog_posts`, `wiki_pages`, `wikis`,
  `data_sets`, `esports_tournaments`, `streamers`). If that table is not installed, or has a shape
  the check cannot read, the view is counted anyway.
- **Bots.** A request whose `User-Agent` matches the list in `isBot()` (search engines, AI
  crawlers, link previews, `curl`, `wget`, `python-requests`, `axios`, headless browsers) is
  dropped. The agent string is not stored.

The figures are indicative: anyone can call `hit` in a loop, and only the per-IP rate limit
(below) slows that down.

## HTTP API

| Route | Who | What it does |
| --- | --- | --- |
| `POST /api/analytics/hit` | anyone | Body `{ "type", "id" }`. Adds one view for today. Always `204` for a valid type and uuid (also when the caller is a bot or the subject does not exist). `400 { "error": "invalid type or id" }` otherwise. Extra body fields (`views: 1000`) are ignored. |
| `GET /api/analytics/top` | anyone | Most viewed subjects of one type. Query: `type` (default `game`), `days` (1-365, default 30), `limit` (1-50, default 5), `ids` (comma-separated uuids, at most 100: rank only inside that set). Returns `{ type, days, docs: [{ subjectId, views }] }`. `400` for an unknown type. |
| `GET /api/analytics/subject/:type/:id` | anyone | Daily views of one subject, oldest first. Query: `days` (1-365, default 30). Returns `{ type, id, days, total, docs: [{ day, views }] }`. A subject with no views gets an empty series, not a 404. `400` for an invalid type or id. |

Out-of-range `days` and `limit` are clamped; a value that is not a number falls back to the
default. If `ids` is given but none of its entries is a uuid, `top` returns an empty list instead
of the global ranking.

## Who can do what

All three operations are `access: "public"`: anonymous visitors, users and agents can call them.
The kon has no policy file and the table has no row security: the counts are public data.

An agent key can still be closed out of an operation with a deny (`!kon:analytics:get-most-viewed`,
`!analytics:*`): deny wins even on public operations.

The admin panel lists the table as a grid view (`analytics-views`).

## Configuration

None. The kon reads no environment variables or settings.

The only built-in limit is `ANALYTICS_LIMITS` in `analytics.routes.ts`: `POST /hit` is capped at
30 requests per 60 seconds per client IP (resolved by the host). The IP is used as a cache key
that expires, never written to a table.

## Agents and MCP

| Operation | MCP tool | Fine scope | Writes |
| --- | --- | --- |
| `add-view` | not exposed (counts a browser page view; an agent reading a page is not a view) | `kon:analytics:add-view` | yes |
| `get-most-viewed` | `analytics__get-most-viewed` | `kon:analytics:get-most-viewed` | no |
| `get-subject-series` | `analytics__get-subject-series` | `kon:analytics:get-subject-series` | no |

No operation is marked sensitive, so nothing here is held for human approval by default. Notes for
agents: [AGENTS.md](AGENTS.md).

## Tests

| File | What it covers |
| --- | --- |
| `tests/unit/kon-analytics-routes.test.ts` | The three routes on a real database: one view per request, concurrent UPSERTs, bots, made-up subjects, `days`/`limit`/`ids` bounds, series. |
| `tests/unit/analytics-without-personal-data.test.ts` | The table stores nothing identifying; bot list; bounded queries. |
| `tests/unit/kon-collection-and-analytics-security.test.ts` | Made-up subjects create no rows; the body cannot set the count; `hit` has its own rate limit. |

From the repository root:

```bash
pnpm vitest run tests/unit/kon-analytics-routes.test.ts
pnpm vitest run tests/unit/analytics-without-personal-data.test.ts
pnpm vitest run tests/unit/kon-collection-and-analytics-security.test.ts
```

## License

MIT.

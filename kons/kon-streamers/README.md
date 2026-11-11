# kon-streamers

A list of the streamers a site features (Twitch, YouTube and Kick), with the games they play and
their live status. Site staff manage the list; a sync job reports who is live; everyone can read
it.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | gaming | 1.0.2 | `/api/streamers` | `kon-games`, `kon-media` (core: `auth`) |

## Install

```bash
kitsuden kon add streamers --enable
```

The kon is off by default (`defaultEnabled: false` in `package.json`), so pass `--enable` or switch
it on in the admin panel (**Kons**). Restart the API afterwards.

`kon.json` lists `kon-games` and `kon-media` as dependencies. The first migration references the
`media` table (`streamers.avatar_id`) and, when the `games` table exists, adds a foreign key from
`games_to_streamers.game_id` to it. No environment variable is needed.

## What it adds

- **Streamer** (`streamers`): display name, unique `slug`, `platform` (`twitch`, `youtube` or
  `kick`, the Postgres enum `streamers_platform`), `channelId`, `channelUrl`, bio, avatar and
  thumbnail (media file ids), social links (stored as a JSON string), follower count, and the live
  fields the sync job writes: `isLive`, `viewerCount`, `currentStreamTitle`, `lastSyncedAt`.
- **Games of a streamer** (`games_to_streamers`): one row per game id, with `is_primary` on the
  first game sent. Deleting a streamer deletes its rows here.

The kon does not call Twitch, YouTube or Kick itself. Live status comes in through
`POST /api/streamers/sync/status`, sent by whatever job you run.

## HTTP API

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/streamers` | anyone | Paginated list (`limit` default 50, max 200; `page`). Filters `platform`, `live=true`. `sort` is a column, `-` for descending (default `-followerCount`); an unknown column falls back to the default. |
| `GET /api/streamers/live` | anyone | Up to 20 live streamers, most viewers first. |
| `GET /api/streamers/slug/:slug` | anyone | One streamer by slug, with `games` (`gameId`, `isPrimary`). |
| `POST /api/streamers/sync/status` | staff | Batch of up to 500 updates matched by `platform` + `channelId`; sets `isLive`, `viewerCount`, `currentStreamTitle`, `thumbnailId` and `lastSyncedAt`. Unmatched channels are skipped. Returns `{ synced, total }`. |
| `GET /api/streamers/:id` | anyone | One streamer by id. A malformed id is a 404. |
| `POST /api/streamers` | staff | Create a streamer (`displayName`, `platform`, `channelId` required). `slug` defaults to one made from the display name. `gameIds` (up to 50) adds games, the first one primary. `409` if the slug or the platform + channel already exist. |
| `PATCH /api/streamers/:id` | staff | Partial update; only listed fields are written, unknown fields are ignored. `gameIds` replaces the streamer's games. `409` on a slug or platform + channel another streamer has. |
| `DELETE /api/streamers/:id` | staff | Delete a streamer and its game rows. Returns `{ deleted: true, id }`. |

Sortable columns: `followerCount`, `viewerCount`, `displayName`, `slug`, `createdAt`, `updatedAt`,
`lastSyncedAt`.

Validation of writes (`cleanStreamer` in `streamers.routes.ts`): text fields have length limits,
`channelUrl` must be an `http(s)` link, file and game ids must be uuids, counts are integers ≥ 0.
A bad field is a `400` that names it. Create stores every field it validates, including the live
fields and counts (`isLive`, `viewerCount`, `followerCount`, `currentStreamTitle`,
`currentGameId`); without them a new streamer is offline with zero counts.

`slug` is unique (`streamers_slug_idx`) and so is `platform` + `channelId`
(`streamers_channel_idx`, migration `0002_unique_channel.sql`). A write that repeats either answers
`409`. That migration refuses to run while the table holds a duplicated platform + channel: it names
the duplicates, and a person keeps one row per channel before running the migrations again.

## Who can do what

The policy is `streamers.policy.ts` (resource `streamer`). Reading is public. Every write
(`create`, `update`, `delete`, `sync`) needs site staff:

| Role | Read | Create, update, delete | Sync live status |
| --- | --- | --- | --- |
| anonymous | yes | no (401) | no (401) |
| signed-in user | yes | no (403) | no (403) |
| editor, admin | yes | yes | yes |
| agent | yes | `streamer:create`, `streamer:update`, `streamer:delete` (or `streamer:*`, `streamers:*`) | `streamer:sync` |

`content:edit` does not grant writes here. The tables have no row-security policy: nothing is hidden
by row, so a 404 always means the streamer does not exist (or the id is not a uuid).

## Configuration

None. The kon reads no environment variable and no setting.

## Agents and MCP

Every route is an SDK operation and an MCP tool:

| MCP tool | Fine scope | Writes |
| --- | --- | --- |
| `streamers__list-streamers` | `kon:streamers:list-streamers` | no |
| `streamers__list-live` | `kon:streamers:list-live` | no |
| `streamers__get-streamer-by-slug` | `kon:streamers:get-streamer-by-slug` | no |
| `streamers__get-streamer` | `kon:streamers:get-streamer` | no |
| `streamers__create-streamer` | `kon:streamers:create-streamer` | yes |
| `streamers__update-streamer` | `kon:streamers:update-streamer` | yes |
| `streamers__sync-live` | `kon:streamers:sync-live` | yes, marked sensitive |
| `streamers__delete-streamer` | `kon:streamers:delete-streamer` | yes, sensitive (DELETE) |

`sync-live` and `delete-streamer` are sensitive: with human approval turned on, an agent's call
answers `202 KITSUDEN_E_APPROVAL_REQUIRED` until a person approves it. See [AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/sec-esports-streamers.test.ts` | Writes are staff only; `content:edit` is not enough and `streamer:*` is; `PATCH` writes only listed columns; `channelUrl` must be http(s); `?sort=` fallback. |
| `tests/unit/streamers-and-collections-malformed-ids.test.ts` | A malformed `:id` is a 404, not a 500. |
| `tests/unit/streamers-unique-channel.test.ts` | On real Postgres: duplicated channel or slug is a 409; create stores the live fields; migration 0002 stops over existing duplicates. |

```bash
pnpm vitest run tests/unit/sec-esports-streamers.test.ts
pnpm vitest run tests/unit/streamers-and-collections-malformed-ids.test.ts
pnpm vitest run tests/unit/streamers-unique-channel.test.ts
```

## License

MIT

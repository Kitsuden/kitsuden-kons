# kon-broadcast

Broadcast graphics for tournaments: an OBS scoreboard with versus, K.O., casters and ticker screens
for fighting games, and, when switched on, per-game draft with Fearless and live League of Legends
telemetry. For production teams who run the stream of an event.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | gaming | 1.0.4 | `/api/broadcast` | — (core: `auth`; optional: `kon-esports`) |

## Install

```bash
kitsuden kon add broadcast --enable
```

The kon is off by default (`defaultEnabled: false` in `package.json`), so pass `--enable` or switch
it on in the admin panel (**Kons**). Restart the API afterwards.

No other kon is required. `kon-esports` is optional (`optionalDependencies` in `kon.json`): with it,
a set can be built from a bracket pairing, report its result back, and fill a side from a
registered player. Without it those three routes answer `409` and everything else works with names
typed by hand. No environment variable is needed.

## What it adds

- **Set** (`broadcast_matches`): the state the overlay paints. Event title, round, `firstTo`
  (or `bestOf` on input, converted once), game profile, side A and side B (validated against the
  profile), casters, screens (`versus`, `ko`, `casters`, `result`), ticker, theme (accent, surface,
  opacity, corners, font), sponsors, Fearless mode, start time, the `kon-esports` tournament and
  bracket set it came from, `status` and its owner.
- **Game** (`broadcast_games`): one game of a best-of-N set, with its draft, Fearless history,
  telemetry snapshot, gold series, winner, duration and a hashed ingest token. Used by the `games`
  section.
- **Roster** (`broadcast_champions`): the selectable characters (slug, name, season, portrait,
  order) that the overlay shows.
- **Game profiles**: the shape of a side for each game. Built in: `1v1` (generic duel, the
  default), and through classification packs `2xko`, `sf6`, `tekken8`, `ggst` (versus), `doubles`,
  `smash-doubles` (doubles), `lol`, `valorant` (team, exactly 5 players), `smash-crew` (crew).
  A set's profile cannot be changed after it is created.
- **Live overlay updates**: every write publishes the set's overlay state to a synced-state channel
  (`broadcast:match:<id>`; games use `moba:game:<id>`), so OBS updates without polling. Postgres
  stays the source of truth.
- **Mail template** `broadcast.match-scheduled` (registered at startup; the kon does not send it
  itself).

### Sections

Parts of the kon are switched on per installation through the active grimoire's `konConfig`:

```json
"konConfig": {
  "kon-broadcast": { "gameProfile": "lol", "enableGames": true, "enableDraft": true, "enableLive": true }
}
```

| Section | Setting | What it adds | Default |
| --- | --- | --- | --- |
| `games` | `enableGames` | One row per game in a set | off |
| `draft` | `enableDraft` | Turns, bans and Fearless. Turns `games` on too | off |
| `live` | `enableLive` | Telemetry ingest. Turns `games` on too | off |
| `standings` | `enableStandings` | The classifications list | on |
| `catalog` | `enableCatalog` | The character roster | on |

A section that is off still has its routes mounted: they answer `409` with the section name and the
line to add (`enableWith`). Sections are read once when the kon mounts; restart after a change.

### Graphics (OBS Browser Sources, 1920x1080, transparent)

Served by the host at `/api/kons/kon-broadcast/graphics/<file>`:

| File | Query | Shows |
| --- | --- | --- |
| `overlay.html` | `?match=<setId>` | Scoreboard, versus, K.O., casters, ticker of one set. |
| `overlay-live.html` | `?game=<gameId>`, optional `&layers=` | Draft, live stats and post-game of one game. Needs `games`. |
| `standings.html` | `?tournament=<id>` | Standings read from `kon-esports`. |
| `top8.html` | `?tournament=<id>` | Top 8 bracket read from `kon-esports`. |

To run a MOBA broadcast end to end, read [VIEWER-GUIDE.md](VIEWER-GUIDE.md).

## HTTP API

Public (OBS has no session):

| Route | What it does |
| --- | --- |
| `GET /api/broadcast/sections` | Which sections are on, what each does, and the configured game profile. |
| `GET /api/broadcast/overlay/:id` | What the set overlay paints, the channel to subscribe to and a `revision`. Never includes the owner, timestamps or external ids. |
| `GET /api/broadcast/live/overlay/:gameId` | The per-game overlay state and its channel. Section `games`. |
| `GET /api/broadcast/classifications` | Classification packs and the game profiles each adds. Section `standings`. |
| `GET /api/broadcast/champions` | The character roster in display order. Section `catalog`. |
| `POST /api/broadcast/games/:id/ingest/push` | Receives a raw Riot Live Client frame from the local agent, authenticated by the `X-Broadcast-Ingest-Token` header, not a session. An unknown game and a wrong token give the same 401. Section `live`. |

Sets (a session is required; "owner or admin" routes answer 404 to anyone else):

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/broadcast/matches` | any account | Sets the caller may view, newest first, 20 per page (`?page=`). |
| `POST /api/broadcast/matches` | admin, editor | Create a set. Returns the set and its overlay channel. |
| `POST /api/broadcast/matches/from-set` | admin, editor | Create a set from a `kon-esports` pairing (`tournamentId`, `bracketMatchId` such as `W2M1`). 409 without `kon-esports`. |
| `GET /api/broadcast/matches/:id` | owner, admin | One set. |
| `PATCH /api/broadcast/matches/:id` | owner, admin | Edit event, format, theme, sponsors, casters or sides (merged over the current side, then validated). `live: true` puts the set on air, `live: false` takes it off (see below). Changing `profileId` is a 409; putting a reported set on air is a 409. |
| `DELETE /api/broadcast/matches/:id` | admin | Delete a set. |
| `POST /api/broadcast/matches/:id/score` | owner, admin | `{ side, delta }` or `{ side, value }`; never below zero. |
| `POST /api/broadcast/matches/:id/screens` | owner, admin | Turn `versus`, `ko`, `casters`, `result` on or off. |
| `POST /api/broadcast/matches/:id/ticker` | owner, admin | Set the ticker text (max 140), or `null` to remove it. |
| `POST /api/broadcast/matches/:id/swap` | owner, admin | Swap side A and side B. |
| `POST /api/broadcast/matches/:id/bind` | owner, admin | Fill a side from a `kon-esports` player (`playerId`, `null` unbinds; `overwriteSponsor`). 409 without `kon-esports`. |
| `POST /api/broadcast/matches/:id/report` | owner, admin | Close a set built from a bracket and send the result (winner from the score; optional `dqParticipantId`, `eliminate`). 409 if not from a bracket, tied or not decided. |
| `POST /api/broadcast/champions` | admin, editor | Upsert characters by `slug` (1 to 200); `replace: true` empties the roster first. Section `catalog`. |

Games, draft and telemetry (session; owner or admin unless noted):

| Route | Section | What it does |
| --- | --- | --- |
| `POST /api/broadcast/matches/:id/games` | games | Add the next game (up to the best-of); sides alternate unless `sideAFirst` is sent. |
| `GET /api/broadcast/matches/:id/games` | games | The set's games in order, without ingest tokens. Anyone who may view the set. |
| `GET /api/broadcast/games/:id` | games | One game without its ingest token. Anyone who may view its set. |
| `POST /api/broadcast/games/:id/draft` | draft | Pick or ban `championId` in the current turn (`null` skips a ban). A Fearless violation is a 409. |
| `POST /api/broadcast/games/:id/draft/undo` | draft | Revert the last pick or ban. |
| `GET /api/broadcast/games/:id/fearless` | draft | The set's Fearless mode and what each side of this game can no longer pick. |
| `GET /api/broadcast/live/adapters` | live | Registered telemetry sources and what each publishes. Any account. |
| `POST /api/broadcast/games/:id/ingest/start` | live | Start polling an adapter (`adapterId`, default `riot-live-client`; `push` for the local agent; `intervalMs` 100 to 5000). |
| `POST /api/broadcast/games/:id/ingest/push-token` | live | Issue the push token for this game (shown once; a new one revokes the old one) and the command to run the agent. |
| `POST /api/broadcast/games/:id/ingest/stop` | live | Stop the telemetry session and empty its frame inbox. |
| `POST /api/broadcast/games/:id/finish` | games | Close the game with the winning side (`blue` or `red`) and add the point to the right side of the set. |

## Who can do what

The policy is `broadcast.policy.ts` (resource `broadcast`):

| Action | Who |
| --- | --- |
| `view` a set | its owner, an admin, or any signed-in account if the set's `status` is `live` |
| `create` a set, load the roster | admin, editor |
| `update` a set and its games | its owner, an admin |
| `delete` a set | admin |
| `actAsUser` | how an agent passes the "any account" routes: `user:act`, `admin` or a `broadcast` scope |

A set starts as `draft`. `PATCH /api/broadcast/matches/:id` with `live: true` puts it on air:
`status` becomes `live` and the `live` flag `true`, so every signed-in account can view it (not
update it). Each operator has at most one set on air: putting a second one on air takes the first
off (`draft`). `live: false` takes a set off air (`draft`). Reporting to the bracket sets
`reported` and takes the set off air; a reported set cannot go back on air (409). A set the caller may not view or update answers
404, not 403, so its existence is not revealed. Creating without permission is a 403.

Agents use `broadcast:create`, `broadcast:update`, `broadcast:delete` (or `broadcast:*`). The tables
have no row-security policy; the policy above, checked in the handlers, is what isolates sets.

## Configuration

- `konConfig["kon-broadcast"]` keys, read with `konSetting` (declared in `kon.json`
  `konConfigSchema`): `gameProfile` (default profile for new sets; falls back to `1v1`),
  `enableGames`, `enableDraft`, `enableLive`, `enableStandings`, `enableCatalog`.
- No environment variable.
- The `riot-live-client` adapter reads `https://127.0.0.1:2999` on the machine that runs the API.
  When the game client is on another PC, use the local agent `tools/agent.mjs` and the `push`
  adapter instead (see [VIEWER-GUIDE.md](VIEWER-GUIDE.md)).

### Admin views

Svelte sources in `admin-src/` are built into Web Components in `admin/` (`scoreboard.js`,
`classifications.js`, `live-control.js`) with `pnpm build:admin kon-broadcast`. The admin loads
them at runtime from `/api/kons/kon-broadcast/admin-asset/admin/<file>`. A view receives
`context` and `params` properties and calls the API with the browser's cookies; it never receives
the session token.

## Agents and MCP

Every route is an SDK operation and an MCP tool `broadcast__<operation>`, fine scope
`kon:broadcast:<operation>`:

| Operation | Writes | Operation | Writes |
| --- | --- | --- | --- |
| `sections` | no | `report-to-bracket` | yes |
| `set-overlay` | no | `list-characters` | no |
| `classifications` | no | `load-characters` | yes, sensitive |
| `list-sets` | no | `game-overlay` | no |
| `get-set` | no | `create-game` | yes |
| `create-set` | yes | `list-games` | no |
| `update-set` | yes | `get-game` | no |
| `delete-set` | yes, sensitive (DELETE) | `draft-step` | yes |
| `scoreboard` | yes | `undo-draft` | yes |
| `screens` | yes | `game-fearless` | no |
| `caption` (ticker) | yes | `ingest-adapters` | no |
| `swap-sides` | yes | `start-ingest` | yes |
| `link-player` | yes | `ingest-token` | yes |
| `create-set-from-bracket` | yes | `stop-ingest` | yes |
| | | `close-game` | yes |

`push-frame` is not an MCP tool: it authenticates with the per-game ingest token, not an agent key.
`load-characters` and `delete-set` are sensitive: with human approval on, an agent's call answers
`202 KITSUDEN_E_APPROVAL_REQUIRED`. See [AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/kon-broadcast.test.ts` | Manifest, set lifecycle, roster, result, live publish to the overlay. |
| `tests/unit/broadcast-unification.test.ts` | Sections on and off, `bestOf` vs `firstTo`, side swaps between games, graphics scripts, OBS URLs. |
| `tests/unit/broadcast-game-profiles.test.ts` | Profiles, side validation, unknown profiles, precedence. |
| `tests/unit/broadcast-bracket-bridge.test.ts`, `broadcast-real-bracket-bridge.test.ts` | The `kon-esports` bridge: round names, reporting, malformed ids, working without it. |
| `tests/unit/broadcast-roster-bridge.test.ts` | Binding a side to a registered player. |
| `tests/unit/broadcast-live-draft.test.ts` | Draft order, transitions, Fearless. |
| `tests/unit/broadcast-live-telemetry.test.ts`, `broadcast-live-networth.test.ts` | Gold, objectives, MVP, Riot adapter, push ingest. |
| `tests/unit/broadcast-live-overlay-render.test.ts` | The live overlay graphic. |
| `tests/unit/broadcast-on-air.test.ts` | Putting a set on air and off, one live set per operator, visibility of a live set, reported sets stay off air. |
| `tests/unit/sec-esports-broadcast-ingest.test.ts` | Ingest token hashing and comparison; `GET /matches` uses the `view` rule. |

```bash
pnpm vitest run tests/unit/kon-broadcast.test.ts
pnpm vitest run tests/unit/broadcast-unification.test.ts
```

## License

MIT

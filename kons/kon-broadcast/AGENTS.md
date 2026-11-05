# AGENTS.md — kon-broadcast

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

Broadcast state for tournament streams, mounted at `/api/broadcast`: sets that feed OBS overlays
(scoreboard, screens, ticker), a character roster, and optional sections for per-game draft and
live telemetry. It can read and write `kon-esports` brackets and players when that kon is present.

## Calling it

- Public reads need no scope: `sections`, `set-overlay`, `game-overlay`, `classifications`,
  `list-characters`.
- Session operations: `create-set`, `create-set-from-bracket`, `load-characters` need
  `broadcast:create`; everything that changes an existing set or game needs `broadcast:update`;
  `delete-set` needs `broadcast:delete`. `list-sets`, `get-set`, `list-games`, `get-game` and
  `ingest-adapters` need `actAsUser` (`user:act`, `admin` or any `broadcast` scope) and then the
  `view` rule. `broadcast:*` covers all; fine scopes are `kon:broadcast:<operation>`.
- An agent that creates a set becomes its owner (`ownerId`), so it can update it with
  `broadcast:update` or by ownership. A human editor can only update sets they own.
- MCP tools are `broadcast__<operation>`. Writes on a set return `{ data: set }`; `create-set` and
  `create-set-from-bracket` also return `channel`. `ingest-token` returns the plaintext token once.
- Sensitive, may come back `202 KITSUDEN_E_APPROVAL_REQUIRED`: `delete-set`, `load-characters`.
  Report the proposal; do not retry.
- 404 means missing **or** not yours: a set or game the caller may not view or update answers 404.
  A 409 on most routes means a section is off (the body has `section` and `enableWith`) or
  `kon-esports` is not available; read the body before anything else.
- Not idempotent: `scoreboard` with `delta`, `swap-sides`, `create-game`, `draft-step`,
  `close-game` (it adds a point). Use `value` instead of `delta` for a safe retry, and pass an
  `idempotency_key` on POSTs you may repeat. `load-characters` is an upsert by slug.
- Refused on purpose:
  - changing a set's `profileId` (409; create a new set);
  - sides that do not match the profile (422 with `issues`), for example a `lol` side without five
    players;
  - more games than the best-of allows (409);
  - a Fearless pick that was already used (409 with the reason);
  - reporting a set that was not built from a bracket, or is tied (409);
  - putting a reported set back on air (`update-set` with `live: true`, 409).
- `update-set` with `live: true` puts a set on air (status `live`: every signed-in account can
  view it) and takes the caller's other live set off air; `live: false` takes it off (`draft`).
  - `push-frame` over MCP: it takes the per-game ingest token, not an agent key.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | `defineKonSdk`, admin views copied from `kon.json`, startup hooks (mail, Riot adapter), stops sessions on disable. |
| `operations.ts` | `registry()` helper, `ANY_ACCOUNT`, `onTheSet(action)` (policy checked in the handler). |
| `broadcast.routes.ts` | Set, overlay, roster, sections, classifications and bracket operations; overlay publishing. |
| `broadcast.policy.ts` | The `broadcast` policy: `view`, `create`, `update`, `delete`, `actAsUser`. |
| `broadcast.schema.ts` | Drizzle tables `broadcast_matches`, `broadcast_games`, `broadcast_champions`; defaults; `bestOf`/`firstTo` conversion. |
| `broadcast.sections.ts` | `KON_ID`, section defaults, `resolveSections`, the 409 middleware `requiresSection`. |
| `broadcast.profiles.ts` | Game profile registry, the built-in `1v1` profile, `validateSide`, `resolveProfileId`. |
| `broadcast.bracket.ts` | Dynamic bridge to `kon-esports` brackets: fetch a pairing, check and report a result. |
| `broadcast.roster.ts` | Dynamic bridge to the `kon-esports` player registry: look up a player, fill a side. |
| `broadcast.mails.ts` | Mail template `broadcast.match-scheduled`. |
| `classifications/index.ts` | The four classification packs and `registerClassifications`. |
| `classifications/versus.ts`, `doubles.ts`, `team.ts`, `crew.ts` | Profiles of each pack and their side schemas. |
| `live/routes.ts` | Game, draft, Fearless, ingest and finish operations (sections `games`, `draft`, `live`). |
| `live/draft.ts` | Draft turn order, picks, bans, undo, Fearless history. |
| `live/sides.ts` | Mapping between set sides (A/B) and game sides (blue/red). |
| `live/frame.ts` | Normalized telemetry frame and the ingest adapter registry. |
| `live/ingest.riot.ts` | Adapter `riot-live-client` (reads `https://127.0.0.1:2999`). |
| `live/ingest.push.ts` | Adapter `push`: frames pushed by the local agent, 15 s freshness. |
| `live/ingest-token.ts` | Issue, hash (SHA-256) and compare (constant time) ingest tokens; `publicGame` strips them. |
| `live/session.ts` | Polling loop per game and the per-game overlay state (`moba:game:<id>`). |
| `live/gold.ts`, `objectives.ts`, `stats.ts` | Gold estimate and series, objective timers, MVP, timeline, comparisons. |
| `graphics/*.html`, `*.js` | OBS graphics: `overlay`, `overlay-live`, `standings`, `top8`. |
| `tools/agent.mjs` | Local agent: reads the game client on the spectator's PC and pushes frames. |
| `admin-src/` | Svelte sources of the admin views; `admin-src/tallao/` is a copied UI kit. |
| `admin/` | Built admin views (`scoreboard.js`, `classifications.js`, `live-control.js`). |
| `migrations/0001`–`0004` | Tables, MOBA unification, games and production fields, English names. |
| `migrations/history.json` | Renames of `0002` and `0003` from their Spanish names, earlier checksums. |

## Rules that must hold

- The overlay payload never carries `ownerId`, timestamps or external ids (`toOverlayPayload`;
  `tests/unit/kon-broadcast.test.ts`, "returns only what goes on screen").
- A set the caller may not view or update is a 404, never a 403; `GET /matches` filters with the
  same `view` rule (`tests/unit/sec-esports-broadcast-ingest.test.ts`).
- Ingest tokens are stored hashed, compared in constant time, and never returned by game reads;
  the push route gives the same 401 for a missing game and a wrong token (same test file).
- Sides are validated after merging the patch, against the set's profile; an unknown profile
  rejects the side (`tests/unit/broadcast-game-profiles.test.ts`).
- A section that is off answers 409, not 404, and `draft`/`live` turn `games` on
  (`tests/unit/broadcast-unification.test.ts`).
- `kon-esports` stays optional: imported dynamically, no foreign keys to its tables
  (`tests/unit/broadcast-bracket-bridge.test.ts`, "Broadcast keeps working without `kon-esports`").
- Publishing to the overlay never throws; Postgres is written first.
- The score never goes below zero; the overlay `revision` is monotonic.
- `status: "live"` and the `live` flag move together, only through `PATCH /matches/:id` `live`;
  one live set per operator; a `reported` set never goes back on air
  (`tests/unit/broadcast-on-air.test.ts`).

## Changing it

- New migration: next number in `migrations/` (`0005_...sql`), never edit an applied one. Renames
  and reworded comments go in `migrations/history.json`.
- New file at the root: run `pnpm kon:sync` (it updates package.json `files` and kon.json).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- Admin views: edit `admin-src/*.svelte`, then `pnpm build:admin kon-broadcast` and commit the
  built `admin/*.js`. Do not edit `admin-src/tallao/`; run `pnpm sync:tallao kon-broadcast` with
  `TALLAO_DIR` set instead.
- A new game is a new profile in a classification file, not a new kon or a new route.
- Admin views are declared once, in `kon.json` `admin.views`; `index.ts` copies them.

## Tests

```bash
pnpm vitest run tests/unit/kon-broadcast.test.ts                 # routes, overlay publishing
pnpm vitest run tests/unit/broadcast-unification.test.ts         # sections, games, graphics
pnpm vitest run tests/unit/broadcast-game-profiles.test.ts       # after touching profiles or classifications
pnpm vitest run tests/unit/broadcast-live-draft.test.ts          # after touching live/draft.ts
pnpm vitest run tests/unit/broadcast-live-telemetry.test.ts      # after touching live/ (gold, objectives, stats, adapters)
pnpm vitest run tests/unit/sec-esports-broadcast-ingest.test.ts  # ingest tokens, list visibility
pnpm vitest run tests/unit/broadcast-on-air.test.ts              # live status transitions
pnpm vitest run tests/unit/broadcast-bracket-bridge.test.ts      # after touching broadcast.bracket.ts
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-broadcast" # these docs
```

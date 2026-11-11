# AGENTS.md — kon-esports

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

The tournament kon, mounted at `/api/esports`: players, teams, tournaments, brackets (single and
double elimination, round robin, Swiss), phases, check-in, public registration, player-reported
results, online operations and imports. 78 SDK operations, all of them MCP tools.

## Calling it

- Scopes:
  - Read: most `GET` operations are public. Staff-only reads (`list-stations`, `stream-queue`,
    `pending-reports`, `pending-notices`) need `esports:manage`.
  - Run tournaments: `esports:manage` (every operation guarded by `ORGANIZATION_ONLY`).
  - Scene calendar: `esports:editScene` (`create-scene-match`, `update-scene-match`,
    `delete-scene-match`), separate from `manage` on purpose.
  - "Any account" operations (`register-me`, `my-registration`, `delete-my-registration`,
    `check-in`, `create-my-team`, `invite-to-team`, `accept-invitation`, `reject-invitation`,
    `register-my-team`, `where-do-i-play`) need `actAsUser`: `user:act`, `admin` or any `esports`
    scope. They act on the agent's own identity, so they register or check in the agent itself.
  - `esports:*` covers everything; fine scopes are `kon:esports:<operation>`.
- MCP tools are `esports__<operation>`. Operation ids by area:
  - players and teams: `list-players`, `get-player`, `create-player`, `update-player`,
    `delete-player`, `list-teams`, `get-team`, `create-team`, `update-team`, `delete-team`;
  - tournaments: `list-tournaments`, `create-tournament`, `get-tournament`, `update-tournament`,
    `delete-tournament`, `register-participant`;
  - sets: `list-sets`, `tournament-sets`, `get-set`, `generate-bracket`, `report-set`,
    `round-robin-standings`, `get-bracket`, `report-set-manual`, `delete-set`;
  - Swiss: `swiss-standings`, `next-swiss-round`, `withdraw-participant`, `swiss-cut`;
  - check-in and phases: `check-in-status`, `check-in-window`, `check-in`, `undo-check-in`,
    `resolve-no-shows`, `list-phases`, `plan-phases`, `start-phase`, `advance-phase`,
    `phase-results`;
  - registration: `tournament-public-card`, `my-registration`, `register-me`,
    `delete-my-registration`, `register-guest`, `my-guest-registration`, `guest-check-in`,
    `guest-withdraw`;
  - reports: `reports-status`, `report-my-set`, `pending-reports`, `sign-result`;
  - online: `pending-notices`, `confirm-notices`, `fail-notice`, `create-my-team`,
    `invite-to-team`, `get-invitation`, `accept-invitation`, `reject-invitation`, `team-roster`,
    `register-my-team`, `create-station`, `list-stations`, `assign-station`, `where-do-i-play`,
    `create-stream`, `tournament-streams`, `stream-queue`, `move-in-stream-queue`;
  - other: `overall-standings` (leaderboard), `list-scene-matches`, `create-scene-match`,
    `update-scene-match`, `delete-scene-match`, `import-sources`, `import-tournament`,
    `sync-prize-pool`, `get-prize-pool`.
- Sensitive, may come back `202 KITSUDEN_E_APPROVAL_REQUIRED`: `generate-bracket`,
  `resolve-no-shows`, `plan-phases`, `import-tournament` and every `DELETE`. Report the proposal;
  do not retry.
- 404 means one of: the row does not exist; the id is not a uuid; the tournament is a `Draft` and
  the caller is not staff; or the caller does not play the tournament whose set they report.
- `winnerId` is always a **participant** id (`esports_tournament_participants.id`), never a player
  or team id. `register-participant` and `register-me` return it.
- Two-step operations write nothing without `confirm: true`: `resolve-no-shows` and
  `import-tournament` return a plan or preview first. Show it to a human before confirming.
- Idempotency: checking in twice keeps the first time (`alreadyCheckedIn`); sending the same
  report twice does not make it a result; `generate-bracket` replaces the bracket (not a no-op).
  Pass `idempotency_key` on other POSTs you may repeat.
- Refused on purpose:
  - a single report is not a result; the opponent must send the same report, or staff signs it
    (`sign-result`);
  - undoing a check-in is staff only, even your own;
  - `register-me` on a Team tournament is a 501; use `register-my-team`;
  - withdrawing after the bracket exists is a 409;
  - `report-set-manual` on Swiss or round robin sets is a 409; use `report-set`;
  - guest tokens, invite tokens and access links are returned once and cannot be read again;
  - a start.gg token sent to `import-tournament` is never stored.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | `defineKonSdk`, rate limits, admin views copied from `kon.json`; exports the engines and schema. |
| `operations.ts` | `KON_ID`, `registry(prefix)`, `ORGANIZATION_ONLY`, `ANY_ACCOUNT`. |
| `esports.routes.ts` | Players, teams, tournaments, scene matches, sets, Swiss operations; `createEsportsRouter` wraps them. |
| `phases.routes.ts` | Check-in and phase operations. |
| `registration.routes.ts` | Public card, account and guest registration, player reports, disputes. |
| `online.routes.ts` | Notice inbox, player teams and invites, stations, streams, stream queue. |
| `leaderboard.ts` | Cross-tournament leaderboard operation. |
| `importers/import.routes.ts` | Import sources, preview/confirm import, prize pool sync and read. |
| `importers/startgg.ts`, `matcherino.ts`, `battlefy.ts` | One importer each, producing the neutral model. |
| `importers/import.types.ts` | The neutral `ImportedTournament` model. |
| `importers/import.persistence.ts` | Writes an imported tournament into the tables. |
| `esports.policy.ts` | The `esports` policy (`manage`, `editScene`, `view`, `selfCheckIn`, `actAsUser`). |
| `esports.guard.ts` | `requireStaff` middleware and `denyUnless` for per-participant checks. |
| `hidden-drafts.ts` | Wrapper: a `Draft` tournament is a 404 to non-staff through any path that names it. |
| `valid-ids.ts` | Wrapper: a non-uuid id is a 404 before any query. |
| `participant-privacy.ts` | What a participant row shows depending on who asks. |
| `guest-access.ts` | Guest token issue, SHA-256 hash, constant-time compare, reading it from a request, the link and the public site it points at (`publicSiteUrl`). |
| `player-identity.ts` | Whether a player record belongs to the calling account (alias ownership). |
| `custom-fields.ts` | Custom registration field definitions and answer validation. |
| `bracket.ts`, `bracket.persistence.ts` | Elimination engine (pure) and its storage. |
| `roundrobin.ts`, `roundrobin.persistence.ts` | Round robin engine and its storage. |
| `swiss.ts`, `swiss.persistence.ts` | Swiss pairing and tiebreakers, and their storage. |
| `checkin.ts`, `phases.ts` | Check-in and phase engines (pure). |
| `registration.ts`, `reporting.ts`, `online.ts` | Registration state and waitlist, report reconciliation, online rules (pure). |
| `esports.schema.ts`, `esports.db.ts`, `schemas.ts` | Drizzle tables and enums, typed client, shared zod schemas. |
| `admin-src/`, `admin/to-panel.js` | Svelte sources of the TO panel and the built Web Component. |
| `migrations/0000`–`0015`, `history.json` | Schema chain; `history.json` declares four renamed files and earlier checksums. |

## Rules that must hold

- `register-participant` inserts in a savepoint (`withSavepoint`): a registration Postgres refuses
  (a repeated one, a player that does not exist) is its 400 and does not leave the request's
  transaction aborted (`tests/unit/input-errors-in-the-request-transaction.test.ts`).
- Players never get `manage` by acting on their own participation
  (`tests/unit/esports-authz.test.ts`, "the boundary is where it should be").
- Public reads never expose emails, link hashes, handles or private answers; staff see contact
  data but never the hash (`tests/unit/sec-esports-tournaments.test.ts`, section 1).
- A draft does not exist from outside, and nobody registers in one (same file, section 2;
  `tests/unit/esports-draft-listing.test.ts`).
- A report alone is not a result; `reportedBy` is set by the server; a non-player gets a 404
  (section 3).
- Someone else's alias cannot be taken when creating a team or accepting an invite (section 4).
- Guest and invite tokens are stored hashed and shown once (`guest-access.ts`).
- Registration is `closed` by default; a generated bracket closes it; the waitlist promotes in
  arrival order (`tests/unit/esports-registration.test.ts`).
- Malformed ids are a 404, not a 500 (`tests/unit/esports-malformed-ids.test.ts`).
- Inside `db.transaction`, every query goes through `tx` (`countsFor(id, tx)`,
  `waitlistOf(id, tx)`): on a single connection (PGlite, lite mode) a query on the outer `db`
  waits forever, and on a pool it cannot see the transaction's own writes
  (`tests/unit/esports-guest-link.test.ts` registers a guest through the real transaction).
- The guest link points at the public site (`publicSiteUrl`), never at the API host
  (`tests/unit/esports-guest-link.test.ts`).
- The engines stay pure (no database): bracket, round robin, Swiss, check-in, phases,
  registration, reporting, online. Their tests import them directly.
- Operation ids are part of the contract (scopes, MCP tool names, `kon-broadcast` reads some
  routes). Do not rename them.

## Changing it

- New migration: next number in `migrations/` (`0016_...sql`), never edit an applied one. Renamed
  files and reworded comments go in `migrations/history.json`.
- New file at the root: run `pnpm kon:sync` (it updates package.json `files` and kon.json).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- New route with a uuid parameter: name it `:id`, `:tournamentId`, `:matchId`, `:participantId` or
  `:phaseId` so `valid-ids.ts` covers it, and put it under a path `hidden-drafts.ts` recognizes if
  it belongs to a tournament.
- `kon-broadcast` imports this kon dynamically (`broadcast.bracket.ts`, `broadcast.roster.ts`) and
  its `standings.html` and `top8.html` graphics read the `/matches/tournament/:tournamentId`
  routes. Run the broadcast bridge tests after changing brackets or players.
- Admin view: edit `admin-src/`, then `pnpm build:admin kon-esports`; do not edit
  `admin-src/tallao/` by hand (`pnpm sync:tallao kon-esports`).

## Tests

```bash
pnpm vitest run tests/unit/bracket.test.ts                       # after touching bracket.ts
pnpm vitest run tests/unit/roundrobin.test.ts                    # round robin
pnpm vitest run tests/unit/esports-swiss.test.ts                 # swiss.ts
pnpm vitest run tests/unit/esports-reportable-swiss.test.ts      # Swiss through the API
pnpm vitest run tests/unit/checkin-phases.test.ts                # check-in and phases
pnpm vitest run tests/unit/esports-authz.test.ts                 # the policy
pnpm vitest run tests/unit/sec-esports-tournaments.test.ts       # privacy, drafts, reports, teams
pnpm vitest run tests/unit/esports-registration.test.ts          # registration and reports
pnpm vitest run tests/unit/esports-guest-link.test.ts            # guest link host
pnpm vitest run tests/unit/esports-online.test.ts                # online.ts, online.routes.ts
pnpm vitest run tests/unit/esports-importers.test.ts             # importers
pnpm vitest run tests/unit/broadcast-real-bracket-bridge.test.ts # the kon-broadcast bridge
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-esports"   # these docs
```

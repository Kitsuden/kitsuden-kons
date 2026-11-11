# kon-esports

Tournaments for a gaming community: players and teams, brackets (single and double elimination,
round robin, Swiss), chained phases, check-in, public registration for accounts, guests and teams,
results reported by the players themselves, and the tools to run an online event (stations,
streams, a notice inbox for a bot, imports from start.gg, Matcherino and Battlefy). For tournament
organizers and the people who play.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | gaming | 1.0.2 | `/api/esports` | `kon-games`, `kon-media` (core: `auth`) |

## Install

```bash
kitsuden kon add esports --enable
```

The kon is off by default (`defaultEnabled: false` in `package.json`), so pass `--enable` or switch
it on in the admin panel (**Kons**). Restart the API afterwards. `kon.json` lists `kon-games` (a
tournament has a `gameId`) and `kon-media` (avatars, logos, report screenshots) as dependencies.
No environment variable is required; `STARTGG_TOKEN` is optional (see Configuration).

`kon-broadcast` can build its on-air sets from this kon's brackets and report results back; it
loads this kon dynamically and works without it.

## What it adds

| Table | What it holds |
| --- | --- |
| `esports_players` | Player profiles: alias, country, avatar, bio, links, the account that owns it. |
| `esports_teams`, `esports_players_to_teams` | Teams, their captain and roster. |
| `esports_tournaments` | Title, game, `format` (`1v1` or `Team`), status (`Draft`, `Open`, `InProgress`, `Completed`), bracket format, seeding, check-in window, registration mode and window, waitlist, rules, roster sizes, guest registration, evidence rule, report grace minutes, custom fields, Swiss rounds, external source, prize pool. |
| `esports_tournament_participants` | Who plays a tournament: player or team, status (`Pending`, `Approved`, `Rejected`), seed, check-in time, waitlist place, answers to custom fields, guest email and hashed link. |
| `esports_matches` | Sets: round, order, bracket side, both participants, scores, winner, status (`Pending`, `Ready`, `InProgress`, `Completed`, `Bye`, `Void`), station, stream queue place. |
| `esports_phases`, `esports_phase_entries` | A tournament's phase plan (pools, top 8…) and who enters each phase. |
| `esports_match_reports`, `esports_report_evidence` | What each player reported for a set, and up to 6 screenshots per report. |
| `esports_team_invites` | Invite links to join a team (expire after 7 days). |
| `esports_stations`, `esports_streams` | Places to play (a setup or an online lobby) and broadcast channels. |
| `esports_notifications` | Notice inbox for a community bot (`match.ready`, `match.station`, `match.stream`, `checkin.open`, `checkin.closing`, `team.invited`). |
| `esports_prize_pool_snapshots` | Prize pool history read from Matcherino. |
| `esports_pro_matches` | "Scene" matches of other teams for a blog calendar; not this kon's tournaments. |

The engines are pure and tested on their own: `bracket.ts` (seeding, byes, single and double
elimination, DQ), `roundrobin.ts`, `swiss.ts` (pairing by score, tiebreakers with a floor),
`checkin.ts`, `phases.ts` (including the FGC template: double elimination pools into a top 8),
`registration.ts` (window, capacity, waitlist), `reporting.ts` (reconciling two reports into
`agreed`, `awaiting_confirmation` or `disputed`), `online.ts` (notices, rosters, stations, streams).

## HTTP API

"staff" means the organization: admin, editor, or an agent with `esports:manage`. "account" means
any signed-in account (an agent needs `actAsUser`, see below). "guest link" means the personal
token of a guest registration.

Players and teams:

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/esports/players` | anyone | Up to 500 players, newest first; `?search=` by alias. Account ids only for staff. |
| `GET /api/esports/players/:id` | anyone | A player and their teams. |
| `POST /api/esports/players` | staff | Create a player profile. |
| `PATCH /api/esports/players/:id` | staff | Edit a player. |
| `DELETE /api/esports/players/:id` | staff | Delete a player; 409 if a tournament still references them. |
| `GET /api/esports/teams` | anyone | Up to 500 teams; `?search=` by name. Account ids only for staff. |
| `GET /api/esports/teams/:id` | anyone | A team with captain and members. |
| `POST /api/esports/teams` | staff | Create a team with optional captain and `memberIds`. |
| `PATCH /api/esports/teams/:id` | staff | Edit a team; `memberIds` replaces the whole roster. |
| `DELETE /api/esports/teams/:id` | staff | Delete a team; 409 if a tournament still references it. |

Tournaments:

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/esports/tournaments` | anyone | Newest first (`limit` default 50, max 200), text filter on the title. Drafts only for staff. |
| `POST /api/esports/tournaments` | staff | Create a tournament (starts as `Draft` unless `status` says otherwise). |
| `GET /api/esports/tournaments/:id` | anyone | A tournament with its participants. Contact data and private answers only for staff. A draft is a 404 from outside. |
| `PATCH /api/esports/tournaments/:id` | staff | Edit status, formats, registration window and rules, roster sizes, and other writable fields. |
| `DELETE /api/esports/tournaments/:id` | staff | Delete a tournament. |
| `POST /api/esports/tournaments/:id/register` | staff | Enter a player (`playerId`, 1v1) or team (`teamId`, Team) in an `Open` tournament, approved. |

Sets and brackets:

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/esports/matches` | anyone | Sets by round and order, optionally of one tournament. Sets of drafts only for staff. |
| `GET /api/esports/matches/tournament/:tournamentId` | anyone | Every set of a tournament. |
| `GET /api/esports/matches/:id` | anyone | One set with both participants and the winner. |
| `POST /api/esports/matches/tournament/:tournamentId/generate` | staff | Seed the approved participants and build the bracket (or pair Swiss round 1). Optional `format`, `seeding`, `shuffleSeed`. Regenerating replaces the bracket. Sets the tournament `InProgress`. |
| `POST /api/esports/matches/tournament/:tournamentId/report` | staff | Record a result: `matchId` and `winnerId` (a participant id). Elimination advances the bracket; round robin and Swiss return the standings. |
| `GET /api/esports/matches/tournament/:tournamentId/standings` | anyone | Round robin standings with display names; 409 for another format. |
| `GET /api/esports/matches/tournament/:tournamentId/bracket` | anyone | The bracket by side, champion and standings; 409 when there is no elimination bracket. |
| `PUT /api/esports/matches/:id` | staff | Older manual result route; Swiss and round robin sets answer 409. Prefer the report route above. |
| `DELETE /api/esports/matches/:id` | staff | Delete one set row. |

Swiss:

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/esports/tournament/:id/swiss` | anyone | Current round, total rounds, completion and standings with tiebreakers. |
| `POST /api/esports/tournament/:id/swiss/next-round` | staff | Pair the next round once every set of the current one has a result. |
| `GET /api/esports/tournament/:id/swiss/cut` | anyone | The top `size` (default 8) and whether the cut is still provisional. |
| `POST /api/esports/participant/:participantId/drop` | staff | Drop a participant: no more pairings, results kept for opponents' tiebreakers. |

Check-in and phases:

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/esports/tournament/:id/check-in` | anyone | Window state (pending, open, closed), seconds to open or close, and how many checked in. |
| `POST /api/esports/tournament/:id/check-in/window` | staff | Set the window; `opensAt: null` turns check-in off. |
| `POST /api/esports/participant/:participantId/check-in` | the participant's account, or staff | Check in while the window is open. Repeating keeps the first time. |
| `DELETE /api/esports/participant/:participantId/check-in` | staff | Remove a check-in. |
| `POST /api/esports/tournament/:id/check-in/resolve` | staff | Drop (before the bracket) or disqualify (after) whoever did not check in. Without `confirm: true` it only returns the plan. |
| `GET /api/esports/tournament/:id/phases` | anyone | The phase plan in order, with status. |
| `POST /api/esports/tournament/:id/phases` | staff | Replace the plan with `phases` or the FGC `template`. A plan with warnings needs `force: true`. |
| `POST /api/esports/phase/:phaseId/start` | staff | Draw the phase into groups and generate each group's bracket. |
| `POST /api/esports/phase/:phaseId/advance` | staff | Close the phase and seed the next one with those who advance. |
| `GET /api/esports/phase/:phaseId/results` | anyone | Each group's order and who advances. |

Public registration:

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/esports/public/tournament/:id` | anyone | Public card: formats, rules, prize pool, registration state (open, closed, full, waitlist), capacity and spots left. |
| `GET /api/esports/public/tournament/:id/me` | account | Your registration: participant id, status, waitlist place, check-in, seed. |
| `POST /api/esports/public/tournament/:id/register` | account | Register yourself in a 1v1 tournament (approved, pending or waitlisted). A taken alias is a 409; a Team tournament answers 501. |
| `DELETE /api/esports/public/tournament/:id/register` | account | Withdraw and promote the waitlist; 409 once the bracket exists. |
| `POST /api/esports/public/tournament/:id/register-guest` | anyone, if the tournament allows guests | Register with an email and alias. Returns `accessToken` and `accessLink` once. The link is `<public site>/t/<tournamentId>/me?token=…` on the public site (see Configuration), not on the API host. |
| `GET /api/esports/public/tournament/:id/guest` | guest link | The guest's registration and waitlist place. |
| `POST /api/esports/public/tournament/:id/guest/check-in` | guest link | Check in inside the same window. |
| `DELETE /api/esports/public/tournament/:id/guest` | guest link | Withdraw and promote the waitlist. |
| `POST /api/esports/public/tournament/:id/register-team` | the team's captain | Register a team in a Team tournament; the roster must meet the size limits (422 with `issues`). |

Results reported by players:

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/esports/match/:matchId/report` | anyone | What each side reported and the reconciliation. |
| `POST /api/esports/match/:matchId/report` | a player of the set (account or guest link) | Report `winnerId` and `scores`, with `evidence` (up to 6, each a `mediaId` or a `url`) when required. Sending the same report as the opponent confirms it; when both agree the bracket advances (`applied`). |
| `GET /api/esports/tournament/:id/pending-reports` | staff | Disputed sets with each side's evidence, and reports older than the grace period. |
| `POST /api/esports/match/:matchId/resolve` | staff | Sign the result of a set and advance the bracket. |

Teams and invites:

| Route | Who | What it does |
| --- | --- | --- |
| `POST /api/esports/public/teams` | account | Create a team with you as captain. |
| `POST /api/esports/public/teams/:id/invites` | the captain | Invite an account (`userId`) or a handle. Returns the invite `token` once. |
| `GET /api/esports/invites/:token` | anyone | An invite's team, role, status and whether it can still be used. |
| `POST /api/esports/invites/:token/accept` | account (the invited one, if the invite names an account) | Join the team with your player profile, or a new one with `alias`. |
| `POST /api/esports/invites/:token/decline` | account (same rule) | Decline the invite. |
| `GET /api/esports/public/teams/:id/roster` | anyone | Team members; with `?tournamentId=`, whether the roster meets that tournament's size rules. |

Stations, streams and the notice inbox:

| Route | Who | What it does |
| --- | --- | --- |
| `POST /api/esports/tournament/:id/stations` | staff | Create a station (a setup or an online lobby with access details). |
| `GET /api/esports/tournament/:id/stations` | staff | Stations with their access details. |
| `POST /api/esports/match/:matchId/station` | staff | Assign a station (or `null`) and notify both players. |
| `GET /api/esports/match/:matchId/where` | account | A set's station; the access details only for its two players and staff. |
| `POST /api/esports/tournament/:id/streams` | staff | Add a channel (twitch, youtube or kick), public or for registered viewers. |
| `GET /api/esports/public/tournament/:id/streams` | anyone | Channels with embed URLs; a registered-only stream says `allowed: false` to anonymous visitors. |
| `GET /api/esports/tournament/:id/stream-queue` | staff | Sets queued for the stream, in order. |
| `POST /api/esports/match/:matchId/stream-queue` | staff | Put a set at `position` (default 1) or remove it with `null`; notifies the players. |
| `GET /api/esports/notifications/pending` | staff | Undelivered notices, oldest first (`tournamentId`, `since`, `limit` up to 200). |
| `POST /api/esports/notifications/ack` | staff | The bot confirms delivered notices. |
| `POST /api/esports/notifications/fail` | staff | The bot records a failed delivery; the notice stays pending. |

Scene calendar, leaderboard and imports:

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/esports/pro-matches` | anyone | Other teams' matches for a blog calendar: live and scheduled by default, `order=recent` for results; filters `status`, `game`, `days`, `limit` (1 to 100). |
| `POST /api/esports/pro-matches` | admin, editor, or `esports:editScene` | Add a calendar match (links must be http(s); unknown fields are a 422). |
| `PATCH /api/esports/pro-matches/:id` | same | Edit a calendar match. |
| `DELETE /api/esports/pro-matches/:id` | same | Remove a calendar match. |
| `GET /api/esports/leaderboard` | anyone | Sets played and won across all tournaments; `type` (`teams` or `players`), `limit` 1 to 50, `game`. |
| `GET /api/esports/import/sources` | anyone | Import sources and what each needs. |
| `POST /api/esports/import/tournament/:id/import` | staff | Import from `startgg` (event URL and token), `matcherino` (URL or id) or `battlefy` (`fileContent`: the exported CSV or JSON). Without `confirm: true` it only previews. 502 when the other platform fails. |
| `POST /api/esports/import/tournament/:id/prize-pool/sync` | staff | Read the linked Matcherino prize pool and store a snapshot; 409 if not linked. |
| `GET /api/esports/import/public/tournament/:id/prize-pool` | anyone | Current prize pool, change since the last snapshot, recent history. |

Every path id except `:token` must be a uuid; anything else is a 404 before the database is queried
(`valid-ids.ts`). A tournament in `Draft` answers 404 to non-staff through every route under
`/tournament/:id`, `/public/tournament/:id`, `/import/.../tournament/:id`,
`/matches/tournament/:tournamentId`, `/phase/:phaseId` and `/match/:matchId` (`hidden-drafts.ts`).

Rate limits declared by the kon (`rateLimits` in `index.ts`): guest registration 5 per 10 minutes; account and team
registration 10 per 10 minutes; creating a team 10 per hour; invites 30 per hour; set reports 30 per
10 minutes.

## Who can do what

The policy is `esports.policy.ts` (resource `esports`); `operations.ts` maps operations to it:

| Action | Who | Used by |
| --- | --- | --- |
| `manage` | admin, editor (agent: `esports:manage`) | every "staff" route, including removing a check-in |
| `editScene` | admin, editor (agent: `esports:editScene`) | `/pro-matches` writes |
| `view` | anyone for a tournament that is not `Draft`; staff for drafts | tournament and set reads, `hidden-drafts.ts` |
| `selfCheckIn` | staff, or the account that registered the participant | account check-in |
| `actAsUser` | how an agent passes "account" routes: `user:act`, `admin` or an `esports` scope | registration, teams, invites, check-in |

A participant created by staff or imported has no registering account, so only staff can act on
it. A guest acts only through their personal link (`X-Participant-Token` header,
`Authorization: Participant <token>`, or `?token=`); the link is stored hashed and covers one
participation. Someone who does not play a tournament gets a 404 when reporting one of its sets.

The tables have no row-security policy; visibility is enforced in the handlers and the two
wrappers above.

## Configuration

- `STARTGG_TOKEN` (optional): start.gg token used by the import route when the request does not
  send `token`. A token sent in the request is used for that request only and never stored.
- The guest link (`accessLink` of `register-guest`) points at the public site: the panel's Site URL
  (General settings, read through the host's `site.publicUrl()`), else `SITE_URL`, else the host's
  `config.siteUrl`, else `http://localhost:4321`. The site must serve the guest page at
  `/t/<tournamentId>/me`.
- No setting is read from `konConfig`. Everything else is per tournament (registration mode,
  waitlist, guests, evidence, grace minutes, roster sizes, custom fields).

### Admin view

`admin/to-panel.js` (the "TO booth": brackets, check-in, disputes, stations, standings) is built
from `admin-src/ToPanel.svelte` with `pnpm build:admin kon-esports`.

## Agents and MCP

All 78 routes are SDK operations and MCP tools named `esports__<operation>`, fine scope
`kon:esports:<operation>` (for example `esports__generate-bracket`,
`kon:esports:generate-bracket`). None is excluded from MCP. The operation ids are listed in
[AGENTS.md](AGENTS.md).

Sensitive (held for human approval when it is on, answering `202 KITSUDEN_E_APPROVAL_REQUIRED`):
`generate-bracket`, `resolve-no-shows`, `plan-phases`, `import-tournament`, and every `DELETE`
operation (`delete-player`, `delete-team`, `delete-tournament`, `delete-set`,
`delete-scene-match`, `undo-check-in`, `delete-my-registration`, `guest-withdraw`).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/bracket.test.ts`, `roundrobin.test.ts`, `esports-swiss.test.ts` | The pure engines. |
| `tests/unit/checkin-phases.test.ts` | Check-in engine and chained phases. |
| `tests/unit/esports-authz.test.ts`, `sec-esports-tournaments.test.ts` | Staff-only routes, registrants, reports, teams, scene calendar. |
| `tests/unit/esports-registration.test.ts`, `esports-registration-by-api.test.ts`, `esports-team-registration.test.ts` | Public registration and player reports. |
| `tests/unit/esports-guest-link.test.ts` | The guest link points at the public site, not the API host. |
| `tests/unit/esports-reportable-swiss.test.ts` | A Swiss tournament run end to end through the API. |
| `tests/unit/esports-online.test.ts` | Notices, teams, stations, streams. |
| `tests/unit/esports-custom-fields.test.ts` | Custom registration fields. |
| `tests/unit/esports-importers.test.ts`, `esports-battlefy-import.test.ts` | start.gg, Matcherino and Battlefy imports. |
| `tests/unit/esports-draft-listing.test.ts`, `esports-malformed-ids.test.ts` | Hidden drafts; malformed ids are 404. |

```bash
pnpm vitest run tests/unit/esports-authz.test.ts
pnpm vitest run tests/unit/bracket.test.ts
```

## License

MIT

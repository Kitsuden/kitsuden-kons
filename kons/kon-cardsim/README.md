# kon-cardsim

Card game tools on one engine, for sites about trading card games. It has three parts, all mounted
at `/api/cardsim`:

- **The simulator** — card games defined with data (zones, resources, deck sections, phases,
  defeats), validated decks, rooms with a clock, deterministic sessions with replay, matchmaking
  and an Elo ranking.
- **The showcase** (`/api/cardsim/showcase/...`) — build a deck of a simulator game, test its
  hands and publish it in a gallery. It was kon-deckshow.
- **The hand generator** (`/api/cardsim/hands/...`) — upload a card dataset with four rules (hand
  size, deck size, copies) and deal hands and statistics, with no game to define. It was
  kon-handlab.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | gaming | 2.3.1 | `/api/cardsim` | — (core: `auth`) |

## Install

```bash
kitsuden kon add cardsim --enable
```

`package.json` has `defaultEnabled: false`, so pass `--enable` (or switch it on in the admin panel,
**Kons**). Restart the API afterwards. No other kon is required and no environment variable is
read. Do not install kon-deckshow or kon-handlab next to it: both now live here.

## What it adds

All three parts use the same engine: deck validation, the hand dealer and the goldfish statistics
are the functions of `cardsim.deck.ts` and `cardsim.goldfish.ts`.

A simulator session does not store state. It stores `{seed, decks, actions}` and the state is
rebuilt with `replay`: replay is free, undo truncates the list, and the deck order travels to no
client, because what travels is the per-seat view computed by `viewFor`. Games between people
carry a secret seed (`secret_rng`) that never leaves the server while the game is played.

| Table | What it holds |
| --- | --- |
| `cardsim_games` | Game definitions (published by the team); seven presets ship in `cardsim.presets.ts`. |
| `cardsim_cards` | Each game's card catalog. |
| `cardsim_decks` | Decks, owned by a user (private to their owner). Showcase decks are these decks too. |
| `cardsim_sessions` | Rooms and sessions: seed, decks, actions, clock. |
| `cardsim_matches` | Finished matches. |
| `cardsim_ratings` | Elo ratings per game. |
| `cardsim_queue` | Matchmaking queue. |
| `deckshow_entries` | Showcase entries: who published a deck, how they describe it, featured, hidden. |
| `deckshow_likes` | One like per person and entry. |
| `handlab_datasets` | Hand generator datasets: a name and four rules. |
| `handlab_cards` | The cards of each dataset. |
| `handlab_decks` | Hand generator decks. |

## HTTP API

### The simulator

| Route | Operation | Access |
| --- | --- | --- |
| `GET /api/cardsim/presets` | `list-presets` | public |
| `GET /api/cardsim/games` | `list-games` | public |
| `GET /api/cardsim/games/:slug` | `get-game` | public |
| `GET /api/cardsim/games/:slug/cards` | `search-cards` | public |
| `PUT /api/cardsim/games` | `publish-game` | staff (`cardsim:manageCatalog`) |
| `POST /api/cardsim/games/:slug/cards` | `import-cards` | staff |
| `POST /api/cardsim/games/:slug/sync-catalog` | `sync-catalog` | staff |
| `POST /api/cardsim/games/:slug/sealed` | `generate-sealed` | session |
| `GET /api/cardsim/decks` | `list-my-decks` | session |
| `POST /api/cardsim/decks` | `create-deck` | session |
| `GET /api/cardsim/decks/:id` | `get-deck` | session |
| `PUT /api/cardsim/decks/:id` | `update-deck` | session (owner) |
| `DELETE /api/cardsim/decks/:id` | `delete-deck` | session (owner) |
| `POST /api/cardsim/decks/import` | `import-deck` | session |
| `GET /api/cardsim/decks/:id/export` | `export-deck` | session |
| `POST /api/cardsim/goldfish` | `simulate-goldfish` | public |
| `GET /api/cardsim/sessions` | `list-rooms` | public |
| `POST /api/cardsim/sessions` | `create-room` | session |
| `GET /api/cardsim/rooms/:code` | `find-room-by-code` | public |
| `POST /api/cardsim/sessions/:id/join` | `take-seat` | session (10 tries per 5 minutes per room) |
| `GET /api/cardsim/sessions/:id` | `get-session` | public (per-seat view) |
| `POST /api/cardsim/sessions/:id/action` | `send-action` | session |
| `POST /api/cardsim/sessions/:id/undo` | `request-undo` | session |
| `DELETE /api/cardsim/sessions/:id/undo` | `cancel-undo` | session |
| `GET /api/cardsim/sessions/:id/replay` | `get-replay` | public |
| `POST /api/cardsim/sessions/:id/rematch` | `request-rematch` | session |
| `GET /api/cardsim/matches/:id` | `get-match` | public |
| `POST /api/cardsim/queue` | `join-queue` | session |
| `DELETE /api/cardsim/queue` | `leave-queue` | session |
| `GET /api/cardsim/ratings/:slug` | `get-ranking` | public |

Policy: `cardsim`.

### The showcase

A showcase deck **is** a simulator deck: the catalog is `cardsim_cards` and the lists are
`cardsim_decks`, so a published deck can be played without exporting anything. Viewing and testing
is public; writing needs a session. Featuring and hiding is the policy's `moderate` action
(admin/editor), never the author's: if it were `update`, anyone could feature themselves. A hidden
entry answers 404 to everyone but its author and moderation.

| Route | Operation | Access |
| --- | --- | --- |
| `GET /api/cardsim/showcase/games` | `showcase-list-games` | public |
| `GET /api/cardsim/showcase/games/:slug/cards` | `showcase-search-cards` | public |
| `POST /api/cardsim/showcase/validate` | `showcase-validate-deck` | public |
| `POST /api/cardsim/showcase/hands` | `showcase-deal-hands` | public |
| `POST /api/cardsim/showcase/goldfish` | `showcase-simulate-goldfish` | public |
| `POST /api/cardsim/showcase/decks` | `showcase-save-deck` | session (`deckshow:create` for an agent) |
| `GET /api/cardsim/showcase/entries` | `list-posts` | public |
| `GET /api/cardsim/showcase/entries/:slug` | `get-post` | public |
| `POST /api/cardsim/showcase/entries` | `publish-post` | session |
| `PUT /api/cardsim/showcase/entries/:id` | `update-post` | session (author or moderation) |
| `DELETE /api/cardsim/showcase/entries/:id` | `delete-post` | session (author or moderation) |
| `POST /api/cardsim/showcase/entries/:id/like` | `like` | session |
| `DELETE /api/cardsim/showcase/entries/:id/like` | `unlike` | session |
| `POST /api/cardsim/showcase/entries/:id/moderate` | `moderate-post` | session (admin/editor) |

Policy: `deckshow`.

### The hand generator

No zones, no turns, no opponent: a dataset is cards plus four rules, and a minimal game definition
is synthesized from them on the fly (`handlab.definition.ts`) so the simulator's engine deals and
counts. The short path is one call: `POST /api/cardsim/hands/datasets/import` creates the dataset
and uploads its cards, accepting the `cards.kitsuden.json` the scrapers emit.

| Route | Operation | Access |
| --- | --- | --- |
| `GET /api/cardsim/hands/datasets` | `list-datasets` | public |
| `GET /api/cardsim/hands/datasets/:slug` | `get-dataset` | public |
| `POST /api/cardsim/hands/datasets/import` | `import-dataset` | staff (`handlab:create`) |
| `POST /api/cardsim/hands/datasets` | `create-dataset` | staff (`handlab:create`) |
| `POST /api/cardsim/hands/datasets/:slug/cards` | `upload-cards` | staff (`handlab:update`) |
| `GET /api/cardsim/hands/datasets/:slug/cards` | `hands-search-cards` | public |
| `DELETE /api/cardsim/hands/datasets/:slug` | `delete-dataset` | staff (`handlab:delete`) |
| `GET /api/cardsim/hands/decks` | `hands-list-my-decks` | session |
| `POST /api/cardsim/hands/decks` | `hands-save-deck` | session (`handlab-deck:create` for an agent) |
| `POST /api/cardsim/hands/datasets/:slug/random-deck` | `random-deck` | public (60/min) |
| `POST /api/cardsim/hands/validate` | `hands-validate-deck` | public |
| `POST /api/cardsim/hands/hands` | `hands-deal-hands` | public (60/min) |
| `POST /api/cardsim/hands/goldfish` | `hands-simulate-goldfish` | public (20/min) |

Policies: `handlab` (datasets) and `handlab-deck` (decks).

## Who can do what

Three policies, one per part: `cardsim` (`cardsim.policy.ts`), `deckshow` (`deckshow.policy.ts`),
`handlab` and `handlab-deck` (`handlab.policy.ts`).

| Caller | Simulator | Showcase | Hand generator |
| --- | --- | --- | --- |
| Anonymous | Read games, cards, rooms, sessions (per-seat view), replays, rankings; goldfish | Read entries; validate, deal, goldfish | Read datasets and cards; random deck, validate, deal, goldfish |
| Signed-in person | Own decks, rooms, play, queue | Save decks, publish, edit and delete own entries, like | Own decks |
| Editor | Plus publish games and catalogs | Plus moderate and edit or delete any entry | Plus create, fill and delete datasets |
| Admin | Plus any deck | As editor | As editor |
| Agent | `user:act`, `admin` or a cardsim scope to act as a user; `cardsim:create` to save decks and open rooms; `cardsim:manageCatalog` for the catalog | `deckshow:create` to save and like; `deckshow:moderate` to moderate | `handlab-deck:create` for decks; `handlab:create`/`update`/`delete` for datasets |

- `content:edit` does not open the simulator's catalog.
- Row security: `cardsim_decks` and `handlab_decks` are owner-isolated by the core's
  `rls-owned-tables.sql`; migration `0007_english_rls.sql` keeps decks with no owner usable
  (`cardsim_decks_ownerless`). A published showcase entry shows its deck to everyone (read as the
  system after the policy check); hiding the entry hides the deck again.
- 404 instead of 403: someone else's private deck, a hidden showcase entry for anyone but its
  author and moderation, and someone else's hand generator deck.
- Secrets: an action that would look at or move the opponent's hidden cards is a 409, and a room
  without spectators does not publish its decks in the replay.

## Configuration

None. Rate limits are declared in `index.ts` (`rateLimits`): `POST /api/cardsim/sessions/:id/join`
10 per 5 minutes per room (fail-closed), `POST /api/cardsim/hands/goldfish` 20 per minute,
`POST /api/cardsim/hands/hands` and `POST /api/cardsim/hands/datasets/:slug/random-deck` 60 per
minute.

## Agents and MCP

Every operation has its MCP tool `cardsim__<operation>` and its fine scope
`kon:cardsim:<operation>`; `cardsim:*` opens the whole kon, showcase and hand generator included.
The policy scopes keep their resource names: `cardsim:create`, `cardsim:manageCatalog`,
`deckshow:create`, `deckshow:moderate`, `handlab:create`, `handlab-deck:create`…

Writes that can be held for human approval (`202 KITSUDEN_E_APPROVAL_REQUIRED`):

- declared sensitive: `publish-game`, `import-cards`, `sync-catalog`, `publish-post`,
  `moderate-post`, `import-dataset`, `upload-cards`;
- `DELETE`s, sensitive by default: `delete-deck`, `delete-post`, `unlike`, `delete-dataset`
  (`cancel-undo` and `leave-queue` are declared not sensitive).

More for agents: [AGENTS.md](AGENTS.md).

## Merged from kon-deckshow and kon-handlab

Until 2.3.0 the showcase was `kon-deckshow` (mounted at `/api/deckshow`) and the hand generator was
`kon-handlab` (mounted at `/api/handlab`). They now live in this kon:

- **Routes**: `/api/deckshow/<path>` → `/api/cardsim/showcase/<path>` and
  `/api/handlab/<path>` → `/api/cardsim/hands/<path>`, same relative paths and access.
- **Operation ids**: unchanged, except the ones that would collide with another in the kon, which
  carry a prefix — showcase `list-games`, `search-cards`, `validate-deck`, `deal-hands`,
  `simulate-goldfish`, `save-deck` → `showcase-…`; hand generator `search-cards`, `list-my-decks`,
  `save-deck`, `validate-deck`, `deal-hands`, `simulate-goldfish` → `hands-…`.
- **Scopes and tools**: `kon:deckshow:<op>` / `kon:handlab:<op>` → `kon:cardsim:<op>` and
  `deckshow__<op>` / `handlab__<op>` → `cardsim__<op>` (with the new ids). Migration
  `0012_showcase_and_hands_scopes.sql` rewrites the stored ones (agents, OAuth grants, pending
  approvals, including their path). It never widens a grant: `deckshow:*`, `kon:deckshow:*`,
  `handlab:*` and `kon:handlab:*` become the list of the fine scopes of the moved operations, not
  `cardsim:*`; a denial keeps its `!`. Note the reverse: an agent that already held `cardsim:*` or
  `kon:cardsim:*` now also reaches the showcase and the hand generator (the migration reports how
  many there are).
- **Unchanged**: table names, policy names (`deckshow`, `handlab`, `handlab-deck`) and their
  resource scopes, and the rate limits (now on `/hands/goldfish`, `/hands/hands` and
  `/hands/datasets/:slug/random-deck`).
- **Migrations**: their files are `0008`–`0011` here, unchanged; `migrations/history.json` maps
  them to the keys existing databases recorded (`kon-deckshow/0001_deckshow.sql`…), so they do not
  run again.

## Tests

| File | What it covers |
| --- | --- |
| `tests/unit/cardsim-engine.test.ts` | Engine: RNG, sessions, actions, presets |
| `tests/unit/cardsim-macros.test.ts`, `tests/unit/cardsim-statecache.test.ts`, `tests/unit/cardsim-secret-seed.test.ts` | Engine details: macros, the state cache, the secret seed |
| `tests/unit/cardsim-goldfish.test.ts`, `tests/unit/cardsim-decklist.test.ts` | Hand dealing and goldfish; deck list import/export and Elo |
| `tests/unit/sec-cards-cardsim.test.ts` | Catalog permissions, rooms, secrets, replay, rematch Elo, join rate limit |
| `tests/unit/cards-agents-with-scope.test.ts` | Agent scopes across the three parts, and migration `0012` |
| `tests/unit/deckshow-authz.test.ts`, `tests/unit/deckshow-published-deck-rls.test.ts`, `tests/unit/sec-cards-deckshow-autobattler.test.ts` | The showcase: policy, published decks under row security, likes on hidden entries |
| `tests/unit/handlab-definition.test.ts`, `tests/unit/handlab-delete-dataset-rls.test.ts`, `tests/unit/security-handlab.test.ts` | The hand generator: minimal definition, deleting datasets, permissions and rate limits |
| `tests/unit/kons-from-dataset.test.ts` | Cards read from a dataset |

```bash
pnpm vitest run tests/unit/cardsim-engine.test.ts
pnpm vitest run tests/unit/sec-cards-cardsim.test.ts
```

## License

MIT

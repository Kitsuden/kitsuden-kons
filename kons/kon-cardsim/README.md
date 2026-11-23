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
- **The board** (`@kitsuden/kon-cardsim/board`) — a Svelte component that plays any game solo in
  the browser, with the card images each player brings (`@kitsuden/kon-cardsim/images`). See
  [Card images: bring your own](#card-images-bring-your-own).
- **The table** (`@kitsuden/kon-cardsim/board/table`) — play another person: lobby, rooms, a two-seat
  board kept in sync over the host's WebSocket. See [Playing another person](#playing-another-person).

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | gaming | 2.6.0 | `/api/cardsim` | — (core: `auth`) |

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
| `cardsim_image_prefs` | Where a person's card images come from, per game: the order of their sources and the links they typed. Never an image. Owner-isolated (migration `0013`). |
| `deckshow_entries` | Showcase entries: who published a deck, how they describe it, featured, hidden. |
| `deckshow_likes` | One like per person and entry. |
| `handlab_datasets` | Hand generator datasets: a name and four rules. |
| `handlab_cards` | The cards of each dataset. |
| `handlab_decks` | Hand generator decks. |

## Card images: bring your own

A game is in one of two **image modes** (`set-image-mode`, staff):

- `hosted` (the default) — card responses carry `imageUrl`, as always.
- `byod` — "bring your own data": **no response of the kon names an image** (not `imageUrl`, not
  an image field inside a card's `data`). Each player brings their own images in the browser. The
  stored `imageUrl`s are kept, so switching back needs no re-import.

`tests/unit/cardsim-byod-no-image-urls.test.ts` walks every operation of the kon in a `byod` game
and scans each response; a new operation must be added to that walk or excused there with its
reason. The hand generator is excused: its datasets are uploaded by their owners and have no
cardsim game.

**What the server keeps** is settings, never pictures: `/image-prefs/:gameKey` stores the order of
a person's sources and the links they typed. A folder or a zip is stored as "there is one, called
X" — no path, no file. Links must be `https:` to a public host (no localhost, LAN addresses,
`.local`, or credentials), so a link shared with another player cannot make their browser probe
their network. `gameKey` is a cardsim slug or the site's own game slug.

**In the browser** (`@kitsuden/kon-cardsim/images`), `createImageResolver` finds each card's image:

1. the persistent cache (IndexedDB; works offline and survives reloads; `requestPersistentStorage`
   asks the browser not to evict it);
2. the player's sources, in their order: a **folder** (`showDirectoryPicker`, kept between visits
   in Chromium; a file list elsewhere), a **zip** (read in the browser, zip bombs refused), images
   **dropped or pasted** on a card, a **link template** (`https://…/{id}.webp`, `{name}`), **per-card
   links**, and a **community pack**;
3. a card **drawn by code** (`placeholderSvg`): name, and cost, type and color when known.

What enters the cache is checked by its bytes (PNG, JPEG, WebP, GIF, AVIF; never SVG), at most
15 MB and 8000 px a side, and re-encoded to a 480×672 WebP. Remote images are fetched without
cookies or referrer; a site that does not allow reading them (no CORS) is shown with a plain
`<img>` and not cached. `resolveBlob` gives the bytes, for renderers that build textures.

**A community pack** is a JSON file someone else hosts; the kon never lists, recommends or fetches
packs — a player pastes the link of one they chose:

```json
{
  "format": "kitsuden-cardsim-pack",
  "version": 1,
  "game": "one-piece-card-game",
  "name": "My scans",
  "keyBy": "id",
  "template": "https://example.org/op/{id}.webp",
  "cards": { "OP01-001": "https://example.org/op/OP01-001-alt.webp" }
}
```

At most 30,000 cards and 4 MB; `cards` wins over `template`. Schema: `CommunityPackSchema` in
`cardsim.images.ts`.

## The board

`@kitsuden/kon-cardsim/board` is a Svelte 5 component (peer dependency `svelte`, optional for
installs that do not use it). It plays any game definition solo, in the browser: no account, no
database, offline. Free table mode relaxes deck construction for meta samples
(`@kitsuden/kon-cardsim/solo`).

```astro
---
import Board from "@kitsuden/kon-cardsim/board";
import { ONEPIECE_CARD_GAME } from "@kitsuden/kon-cardsim/presets";
---
<Board
  client:only="svelte"
  game="one-piece-card-game"
  definition={ONEPIECE_CARD_GAME}
  catalog={{ "Roronoa Zoro": { name: "Roronoa Zoro", data: { cost: 3, color: "Green" } } }}
  imageMode="byod"
  apiBase="https://api.example.org/api/cardsim"
/>
```

- `catalog` is keyed by what the deck list uses (usually the card name); `id` and `data` help find
  and draw the card. In `byod` an `image` in the catalog is ignored; in `hosted` it is used when the
  player has no image of their own.
- `apiBase` keeps the player's image settings in their account (`/image-prefs`); without it, or
  without a session, they stay in that browser.
- Texts in Spanish, English and Portuguese, picked from `lang` or `<html lang>`; override single
  strings with `texts`.
- Theme it with CSS custom properties on any ancestor: `--cardsim-surface`, `--cardsim-surface-2`,
  `--cardsim-input`, `--cardsim-border`, `--cardsim-text`, `--cardsim-muted`, `--cardsim-faint`,
  `--cardsim-accent`, `--cardsim-on-accent`, `--cardsim-danger`, `--cardsim-radius`,
  `--cardsim-card-width`, `--cardsim-hand-width`.
- Other renderers (a WebGL table, a game engine) can drive the same images without Svelte:
  `createImagesController` (`@kitsuden/kon-cardsim/images/controller`) holds the sources and the
  resolver, and `resolver.resolveBlob(card)` returns the bytes for a texture.

## Playing another person

`@kitsuden/kon-cardsim/board/table` (Svelte 5) is the lobby and the two-seat table. It needs the game
PUBLISHED in the kon (decks are validated against its catalog on the server) and a signed-in player;
spectators need neither a session nor a seat if the room admits them.

```astro
---
import TableBoard from "@kitsuden/kon-cardsim/board/table";
---
<TableBoard client:only="svelte" apiBase="/api/cardsim" game="one-piece-card-game" />
```

- **Lobby**: your decks of the game (or a pasted list, saved with `import-deck`), create a room
  (password, spectators, clock, best of), join or watch with a code, open rooms.
- **Table**: your seat at the bottom, the rival's hand as card backs, clocks, undo by agreement,
  concede, the result, and a rematch both players land in (pressing it twice opens ONE game,
  migration `0014`). `sessionId` opens a table directly; `onTable` lets the page keep it in its URL.
- **Images**: the player's own, exactly as on the solo board. A player can offer their link
  template or community pack to the rival (`share-image-source`); the rival sees the offer and adds
  it only if they accept. Folders, zips and per-card links cannot be shared.

**The relay** (`cardsim.relay.ts`). The kon broadcasts on `kon:cardsim:session:<id>` (players, and
spectators where the room admits them) and `kon:cardsim:session:<id>:players` (seated players only),
through the host's kon channels (`ctx.realtime.channels`). Until 2.5.0 it broadcast on
`cardsim:session:<id>`, a channel the host only lets admins hear: no player ever received an event.
What travels is "what happened, and its number" — never an action's contents, a card, a deck or an
image; each client then reads its own seat's view (`get-session`), so `viewFor` stays the only place
that decides what a seat sees. The one message with a link is a shared source, on the players'
channel. `tests/unit/cardsim-relay.test.ts` plays a whole game and checks every message.

**The client** (`@kitsuden/kon-cardsim/table`, no Svelte): `createTableApi`, `connectRealtime` (subscribes,
pings, reconnects with backoff 1 s → 30 s and subscribes again) and `createTableSession` (the table
as a store; polls while the socket is down; reads again when a clock runs out). Actions go one at a
time with `expectActionCount`: if the table moved, or a retried action already went through, the
server answers 409 `stale` instead of applying it twice. Writes also carry `Idempotency-Key`.

## Other renderers and a rules arbiter

- **Drawing contract** (`@kitsuden/kon-cardsim/render`): `sceneFor(view, definition, seat, { width })`
  lays the table out as rectangles (deterministic), `hitTest` and `zoneAt` turn a pointer into a card
  or a zone, and `CardRenderer` is what a renderer implements (`mount`, `setScene`, `setTexture`,
  `onPointer`, `dispose`). Textures come from `resolver.resolveBlob(card)`.
- **Estella** (github.com/esengine/estella) fits that contract as a renderer, verified 2026-11-20:
  its core was built from source (Emscripten 5.0.0, `-DES_ENABLE_SPINE=OFF`) and a probe project was
  exported with its open exporter (`node pipeline/bin/estella.mjs export <dir> --platform web`), no
  editor. In that page this kon's engine created a session, `sceneFor` placed 12 cards as Sprites,
  every texture came from bytes made at runtime (`decodeImagePixels(blob)` → `Assets.createTexture`),
  a tapped card rotated, and clicks resolved through `hitTest`. So BYOD needs no service worker or
  virtual URLs. Notes: the SDK is not on npm (its package is `private`; npm `esengine` is another
  project), so a site ships a build or an export; with Spine off the core is named `esengine-core`
  and the build tool expects `esengine` (copy it); SVG cannot be decoded into an ImageBitmap, so the
  drawn card is rasterized through an `<img>` first; Estella's own picking is for UI nodes only.
  Apache-2.0 (Spine runtimes excluded).
- **Arbiter contract** (`@kitsuden/kon-cardsim/arbiter`): an `Arbiter` knows a game's rules; `check`
  may refuse an action before it is applied and `after` answers with follow-up actions.
  `arbitrate` runs it against the engine; follow-ups are logged as ordinary actions, so an arbitrated
  game replays without the arbiter, and free rooms and rules rooms share engine, relay and log.
  Not wired into `send-action` yet; no game ships an arbiter.

## The game it belongs to

A simulator game can say which game of the catalog it belongs to, in `game`: the game's slug in kon-games
(`/api/games`), lowercase letters, numbers and single hyphens (`elden-ring`). Every gaming kon uses
this same field and the same value (kon-maps, kon-tierlist, kon-character-builder, kon-formulas,
kon-cardsim, kon-wiki, kon-autobattler), so a site asks each one for a game's things the same way.

- **List by game:** `GET /api/cardsim/games?game=one-piece-card-game`.
- **Set it:** `game` in the body of `PUT /api/cardsim/games`. Left out, the game stays as it was; `null` clears it.
- It is optional, and nothing checks that the game exists: kon-games does not have to be installed.
- It is not the simulator's own game id (`gameId` on decks, rooms and matches, a `cardsim_games`
  row): two simulator games, a standard format and a draft one, can belong to the same catalog game.

## HTTP API

**Pages (since 2.4.0).** `list-rooms` takes `limit` (1-50, default 50: the old cap) and
`offset`; `list-my-decks` takes `limit` (1-500) and `offset`, and without `limit` still returns
every deck. Both add `hasMore` next to `data`: while it is `true`, ask again with `offset` +
`limit`. `list-presets`, `list-games` and `list-datasets` are read whole (declared `unpaginated`):
the shipped presets, and the games and datasets the team curates.

### The simulator

| Route | Operation | Access |
| --- | --- | --- |
| `GET /api/cardsim/presets` | `list-presets` | public |
| `GET /api/cardsim/games` | `list-games` | public |
| `GET /api/cardsim/games/:slug` | `get-game` | public |
| `GET /api/cardsim/games/:slug/cards` | `search-cards` | public |
| `POST /api/cardsim/games/:slug/cards/lookup` | `lookup-cards` | public (up to 200 ids) |
| `PUT /api/cardsim/games/:slug/image-mode` | `set-image-mode` | staff (`cardsim:manageCatalog`) |
| `GET /api/cardsim/image-prefs/:gameKey` | `get-image-prefs` | session (own) |
| `PUT /api/cardsim/image-prefs/:gameKey` | `put-image-prefs` | session (own) |
| `DELETE /api/cardsim/image-prefs/:gameKey` | `delete-image-prefs` | session (own) |
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
| `POST /api/cardsim/sessions/:id/share-source` | `share-image-source` | session (seated) |
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
| `GET /api/cardsim/showcase/entries/:ref` | `get-post` | public |
| `POST /api/cardsim/showcase/entries` | `publish-post` | session |
| `PUT /api/cardsim/showcase/entries/:ref` | `update-post` | session (author or moderation) |
| `DELETE /api/cardsim/showcase/entries/:ref` | `delete-post` | session (author or moderation) |
| `POST /api/cardsim/showcase/entries/:id/like` | `like` | session |
| `DELETE /api/cardsim/showcase/entries/:id/like` | `unlike` | session |
| `POST /api/cardsim/showcase/entries/:id/moderate` | `moderate-post` | session (admin/editor) |

Policy: `deckshow`.

`:ref` on `/showcase/entries/:ref` is the entry's **slug** for `get-post` and its **id** for
`update-post` and `delete-post`, exactly as before. Until 2.3.2 the parameter was called `slug`
on the GET and `id` on the PUT and DELETE; OpenAPI reads two such templates as one path, so 2.4.0
gives both the one name `ref`. URLs do not change, but generated clients and MCP tools
(`cardsim__get-post`, `cardsim__update-post`, `cardsim__delete-post`) now take `ref` in place of
`slug` / `id`.

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
- Image settings (`cardsim_image_prefs`) are owner-isolated in the database by migration `0013`
  (the core's template: system with an empty role, admin, or the owner), and every route also
  filters by the caller.
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

- declared sensitive: `publish-game`, `set-image-mode`, `import-cards`, `sync-catalog`, `publish-post`,
  `moderate-post`, `import-dataset`, `upload-cards`;
- `DELETE`s, sensitive by default: `delete-deck`, `delete-post`, `unlike`, `delete-dataset`
  (`cancel-undo`, `leave-queue`, `delete-image-prefs` and `share-image-source` are declared not sensitive).

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
| `tests/unit/cardsim-pagination.test.ts` | Pages of `list-my-decks` and `list-rooms` (`limit`, `offset`, `hasMore`); `/showcase/entries/:ref` keeps its URLs |
| `tests/unit/cardsim-byod-no-image-urls.test.ts` | Every operation in a `byod` game: no response names an image; `hosted` keeps them; `set-image-mode` is editorial |
| `tests/unit/cardsim-image-prefs.test.ts` | Image settings: validation, per-person isolation through the routes and in the database (non-superuser role), shared URL rules |
| `tests/unit/cardsim-images-client.test.ts` | The browser module: zip reader, image checks, each source, the chain, the cache, the drawn card, settings through the kon |
| `tests/unit/cardsim-solo.test.ts` | The board's solo rules on the seven presets |
| `tests/unit/cardsim-relay.test.ts` | A whole two-player game over the relay: every message zero-asset and on the kon's channels, who may listen, stale actions, the clock, one rematch, sharing a source, `lookup-cards` |
| `tests/unit/cardsim-table-client.test.ts` | The table client: reconnection and backoff, resubscribing, reading on events, actions in order, offers, rematch, polling, clocks |
| `tests/unit/cardsim-render-arbiter.test.ts` | The drawing contract (layout, hit test) and the arbiter contract (veto, follow-ups, replay without it, loop guard) |

```bash
pnpm vitest run tests/unit/cardsim-engine.test.ts
pnpm vitest run tests/unit/sec-cards-cardsim.test.ts
```

## License

MIT

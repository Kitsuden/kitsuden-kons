# AGENTS.md — kon-cardsim

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

A card game simulator whose games are data, plus two tools on the same engine: the showcase
(`/showcase/...`, formerly kon-deckshow) and the hand generator (`/hands/...`, formerly
kon-handlab). A session stores `{seed, decks, actions}` and rebuilds the state with `replay`;
clients only ever get the per-seat view from `viewFor`.

Since 2.5.0 it also ships browser code: the solo board (`./board`, Svelte 5) and the card images
each player brings (`./images`). In a game whose image mode is `byod`, no response of the kon names
an image; the kon only stores each person's image SETTINGS (`/image-prefs`), never an image.

Also: the two-player table (`./board/table`, `./table`), its realtime relay on
`kon:cardsim:session:<id>` (`cardsim.relay.ts`), and two contracts for other renderers and for a rules
arbiter (`./render`, `./arbiter`).

## Calling it

- Everything is one kon for scopes and tools: MCP tools are `cardsim__<operation>` and fine
  scopes `kon:cardsim:<operation>`, for all three parts. `cardsim:*` opens all of them.
- The handlers also ask a policy, by resource scope:
  - simulator: `cardsim:create` (save decks, open rooms, queue), `cardsim:manageCatalog`
    (`publish-game`, `set-image-mode`, `import-cards`, `sync-catalog`);
  - showcase: `deckshow:create` (save decks, like), `deckshow:moderate` (`moderate-post`);
  - hand generator: `handlab:create` / `handlab:update` / `handlab:delete` (datasets),
    `handlab-deck:create` (decks).
- Acting as a user (any route with `access: "session"`) needs `user:act`, `admin` or a scope of
  that part (`cardsim…`, `deckshow…`, `handlab…`). With only `mcp:connect` an agent saves nothing.
- Read-only key example: `kon:cardsim:list-games`, `kon:cardsim:get-session`,
  `kon:cardsim:list-posts`, `kon:cardsim:hands-deal-hands`.
- What the main tools return: `get-session` → the view for your seat (or a spectator's view);
  `send-action` applies one engine action; `get-replay` → definition, decks, seed, sub-seeds and actions of a
  finished game (409 before it ends; 403 to non-players if the room has no spectators); `simulate-goldfish` and the
  `…-goldfish` tools → per-query probabilities over many dealt hands; `…-deal-hands` → sample
  hands from a seed (same seed, same hands).
- Pages: `list-rooms` (`limit` 1-50, default 50) and `list-my-decks` (`limit` 1-500, none by
  default: every deck) take `limit` and `offset` and answer `hasMore` next to `data`.
  `list-presets`, `list-games` and `list-datasets` are read whole (`unpaginated`).
- Showcase entries: `get-post`, `update-post` and `delete-post` take `ref` (renamed in 2.4.0 from
  `slug` / `id`): the entry's slug for `get-post`, its id for the other two.
- May come back `202 KITSUDEN_E_APPROVAL_REQUIRED` (report it, do not retry): `publish-game`,
- `send-action` takes an optional `expectActionCount`: a 409 with `stale: true` means the table moved
  (or your retry already went through) — read `get-session` again; do not resend blindly.
- `lookup-cards` → names and data of up to 200 card ids (a view carries ids only).
- `share-image-source` → offers your `template` or `pack` source to the seated rival (202).
- `request-rematch` answers 200 with the existing rematch when the other player already started it.
- `get-image-prefs` / `put-image-prefs` / `delete-image-prefs` → the caller's own image sources for
  a game (links and names only). `put-image-prefs` refuses non-https links, private hosts and paths.
- May come back `202 KITSUDEN_E_APPROVAL_REQUIRED` (report it, do not retry): `publish-game`, `set-image-mode`,
  `import-cards`, `sync-catalog`, `publish-post`, `moderate-post`, `import-dataset`,
  `upload-cards` (declared sensitive) and the `DELETE`s `delete-deck`, `delete-post`, `unlike`,
  `delete-dataset`. `cancel-undo`, `leave-queue` and `delete-image-prefs` are declared not sensitive.
- 404 is usually "hidden": someone else's private deck (row security), a hidden showcase entry,
  someone else's hand generator deck. `get-deck` with the deck's code in the `share` query opens a
  deck that is not yours.
- Idempotent: `import-cards`, `sync-catalog`, `upload-cards`, `like`, `put-image-prefs` (declared), and the `PUT`s.
  Pass an `idempotency_key` over MCP when retrying `create-deck`, `create-room`, `send-action`,
  `publish-post` or `create-dataset`.
- Refused on purpose:
  - Looking at or moving the opponent's hidden cards, or acting from their seat (409).
  - Choosing the seed of a two-player room (only solo rooms accept one).
  - Seating someone else's private deck or a deck of another game.
  - Huge packs, decks or card lists (size caps in the schemas).
  - An author moderating their own entry (403), liking a hidden entry.
  - `content:edit` publishing a game definition.
  - Guessing room passwords: `take-seat` allows 10 tries per 5 minutes per room, fail-closed.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | The simulator's 36 operations (image mode, image settings, card lookup and source sharing included), deck/room/session/queue/ranking handlers, `allOperations` (adds showcase and hand generator), rate limits, `defineKonSdk`. |
| `operations.ts` | `KON_ID`, the router-shaped registry (with a path prefix), permissions `ANY_ACCOUNT`, `SHOWCASE_ACCOUNT`, `HANDS_ACCOUNT`, `onTheDataset`, `CATALOG`, shared zod params. |
| `cardsim.types.ts` | The data vocabulary that describes a card game (`GameDefinition`, zones, visibility…). |
| `cardsim.engine.ts` | The engine: RNG and shuffle, `createSession`, `applyAction`, `checkSecrecy`, `replay`, `viewFor`. |
| `cardsim.deck.ts` | Deck sections, `normalizeDeck`, `validateGameDefinition`, `validateDeck`. |
| `cardsim.goldfish.ts` | Dealing hands (`dealHands`, `handSeed`) and goldfish statistics (`goldfish`, `goldfishAsync`). |
| `cardsim.decklist.ts` | Text deck lists and YDK: parse and format. |
| `cardsim.rating.ts` | Elo: `kFactor`, `expectedScore`, `applyElo`. |
| `cardsim.seed.ts` | The per-game secret seed and HMAC subseeds. |
| `cardsim.statecache.ts` | `SessionStateCache`: incremental replay cache per session. |
| `cardsim.dataset.ts` | `cardsFromEntries`: a core dataset turned into a card catalog. |
| `cardsim.images.ts` | Shared (server and browser): image modes, `stripCardImages`, `urlProblem`, `ImagePrefsSchema`, `CommunityPackSchema`. |
| `cardsim.images.client.ts` | `./images`, browser: `createImageResolver`, the six sources, IndexedDB cache, image checks, `createPrefsStore`, folder handles. |
| `cardsim.images.controller.ts` | `./images/controller`: the "My images" state without a UI (sources, local folders and zips, saving, resolver). |
| `cardsim.zip.ts` | A small zip reader (stored and deflate) with zip-bomb limits. |
| `cardsim.placeholder.ts` | The card drawn by code, as an escaped SVG. |
| `cardsim.solo.ts` | `./solo`: `soloSeat` and `freeTable`, what a two-seat game needs to be played alone. |
| `cardsim.board.i18n.ts` | `./board/texts`: the board's texts in es, en and pt. |
| `Board.svelte` | `./board`: the solo board. Moved from the Cardback site 2026-11-20. |
| `TableBoard.svelte` | `./board/table`: lobby and the two-seat table. |
| `cardsim.table.client.ts` | `./table`: `createTableApi`, `connectRealtime`, `createTableSession`. |
| `cardsim.table.i18n.ts` | `./board/table/texts`: the table's texts in es, en and pt. |
| `cardsim.relay.ts` | `./relay`: channel names, the events that travel, `authorizeTableChannel`. |
| `cardsim.render.ts` | `./render`: `sceneFor`, `hitTest`, `zoneAt`, the `CardRenderer` contract. |
| `cardsim.arbiter.ts` | `./arbiter`: the `Arbiter` contract and `arbitrate`. |
| `ImageSourcesPanel.svelte` | `./board/sources`: the "My images" panel. |
| `cardsim.presets.ts` | Seven ready game definitions (`PRESETS`). |
| `cardsim.policy.ts` | Policy `cardsim`. |
| `cardsim.schema.ts` | Drizzle tables `cardsim_*`. |
| `deckshow.routes.ts` | The showcase's 14 operations under `/showcase`. |
| `deckshow.policy.ts` | Policy `deckshow` (`view`, `create`, `update`, `delete`, `moderate`, `actAsUser`). |
| `deckshow.schema.ts` | Tables `deckshow_entries`, `deckshow_likes`. |
| `handlab.routes.ts` | The hand generator's 13 operations under `/hands`. |
| `handlab.definition.ts` | Dataset rules → minimal `GameDefinition` for the engine. |
| `handlab.policy.ts` | Policies `handlab` (datasets, team) and `handlab-deck` (decks, owner). |
| `handlab.schema.ts` | Tables `handlab_datasets`, `handlab_cards`, `handlab_decks`. |
| `kon.json`, `package.json` | Manifest and package (exports `./motor`, `./presets`, `./decklist`). |
| `README.md` | Human documentation, including the merge notes. |
| `migrations/0001`–`0007` | Simulator tables, rooms, dataset link, ownerless-deck policy, secret seed, English renames. |
| `migrations/0008`–`0011` | The former kon-deckshow and kon-handlab migrations, unchanged. |
| `migrations/0014_rematch_once.sql` | `cardsim_sessions.rematch_id`: one rematch per game. |
| `migrations/0015_game.sql` | `cardsim_games.game`: the catalog game (kon-games slug) a simulator game belongs to. |
| `migrations/0013_byod_images.sql` | `cardsim_games.image_mode` and the owner-isolated `cardsim_image_prefs` (RLS in the file). |
| `migrations/0012_showcase_and_hands_scopes.sql` | Rewrites stored deckshow/handlab scopes and tools to cardsim ones without widening grants. |
| `migrations/history.json` | Old checksums and old migration keys (including `kon-deckshow/…` and `kon-handlab/…`). |

## Rules that must hold

- The session stores actions, not state; replaying the same seed and actions gives the same
  state (`cardsim-engine.test.ts`, `cardsim-statecache.test.ts`).
- No client sees hidden information: views come from `viewFor`, and `checkSecrecy` refuses
  actions that would reveal or move the opponent's hidden cards (`sec-cards-cardsim.test.ts`).
- Two-player games use the secret seed; the client does not choose it
  (`cardsim-secret-seed.test.ts`, `sec-cards-cardsim.test.ts`).
- A rematch never moves the Elo of a closed match again (`sec-cards-cardsim.test.ts`).
- Decks are private to their owner under row security; a published showcase entry exposes its
  deck only after the policy check, and hiding the entry hides it again
  (`deckshow-published-deck-rls.test.ts`).
- Moderation is never the author's (`deckshow-authz.test.ts`).
- Deleting a dataset deletes everyone's decks of it, as the system after the policy check
  (`handlab-delete-dataset-rls.test.ts`).
- Agents need the action's scope to save anything (`cards-agents-with-scope.test.ts`).
- Expensive public routes keep their rate limits (`security-handlab.test.ts`,
  `sec-cards-cardsim.test.ts`).
- Migration `0012` never widens a grant; table and policy names of the showcase and the hand
  generator stay as they are.
- The relay carries no card, deck, action contents or image: every broadcast goes through `relay()`
  with a `TableEvent` of `cardsim.relay.ts` (`EVENT_KEYS` lists each event's keys), on the
  `kon:cardsim:` namespace; clients read their own view after it (`cardsim-relay.test.ts`). A shared
  image source goes only on the `:players` channel.
- Who may listen to a table is `authorizeTableChannel`: players; others only if the room admits
  spectators; the `:players` channel only seated players.
- In a `byod` game no response names an image: every route that returns cards passes them through
  `stripCardImages`. A NEW operation must be called in `walkEveryOperation` of
  `cardsim-byod-no-image-urls.test.ts` or listed in its `NOT_SCANNED` with the reason; the
  coverage test fails otherwise.
- The server never downloads, proxies or stores an image for `byod`: `/image-prefs` holds links and
  names only, validated by the same `ImagePrefsSchema` the browser uses
  (`cardsim-image-prefs.test.ts`, including RLS with a non-superuser role).
- What the board caches is checked by its bytes and re-encoded; SVG never enters the cache
  (`cardsim-images-client.test.ts`).

## Changing it

- New migration: next number in `migrations/` (`0016_…`); never edit an applied one. Renames of
  a migration file go in `migrations/history.json` (`renamed`; old checksums in
  `previousChecksums`). The `0008`–`0011` entries there keep old databases from running the
  merged migrations again: do not remove them.
- New file at the kon root: run `pnpm kon:sync` (updates `package.json` `files`).
- The Svelte files are checked with svelte-check (tsc ignores them):
  `pnpm exec svelte-check --workspace <abs path to kons/kon-cardsim> --tsconfig <abs path>/tsconfig.json`.
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to
  `kon.json`.
- A new showcase or hand generator operation whose id collides with another in the kon gets the
  `showcase-` or `hands-` prefix. Do not rename existing ids: they are tool names and scopes.
- Engine changes must keep old replays valid: the session only stores actions.

## Tests

```bash
pnpm vitest run tests/unit/cardsim-engine.test.ts
pnpm vitest run tests/unit/cardsim-macros.test.ts
pnpm vitest run tests/unit/cardsim-statecache.test.ts
pnpm vitest run tests/unit/cardsim-secret-seed.test.ts
pnpm vitest run tests/unit/cardsim-goldfish.test.ts
pnpm vitest run tests/unit/cardsim-decklist.test.ts
pnpm vitest run tests/unit/sec-cards-cardsim.test.ts
pnpm vitest run tests/unit/cards-agents-with-scope.test.ts
pnpm vitest run tests/unit/deckshow-authz.test.ts
pnpm vitest run tests/unit/deckshow-published-deck-rls.test.ts
pnpm vitest run tests/unit/sec-cards-deckshow-autobattler.test.ts
pnpm vitest run tests/unit/handlab-definition.test.ts
pnpm vitest run tests/unit/handlab-delete-dataset-rls.test.ts
pnpm vitest run tests/unit/security-handlab.test.ts
pnpm vitest run tests/unit/kons-from-dataset.test.ts
pnpm vitest run tests/unit/cardsim-pagination.test.ts
pnpm vitest run tests/unit/cardsim-byod-no-image-urls.test.ts
pnpm vitest run tests/unit/cardsim-image-prefs.test.ts
pnpm vitest run tests/unit/cardsim-images-client.test.ts
pnpm vitest run tests/unit/cardsim-solo.test.ts
pnpm vitest run tests/unit/cardsim-relay.test.ts
pnpm vitest run tests/unit/cardsim-table-client.test.ts
pnpm vitest run tests/unit/cardsim-render-arbiter.test.ts
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-cardsim"
```

- Images (`cardsim.images*.ts`, `cardsim.zip.ts`, `cardsim.placeholder.ts`, the `.svelte` files): the
  three image tests above and svelte-check. The board's solo rules: `cardsim-solo`.
- Engine files: the `cardsim-*` tests. `index.ts` or `cardsim.policy.ts`: `sec-cards-cardsim`,
  `cards-agents-with-scope`. Showcase: the `deckshow-*` tests and
  `sec-cards-deckshow-autobattler`. Hand generator: the `handlab-*` tests and `security-handlab`.

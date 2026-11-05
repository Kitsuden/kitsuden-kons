# AGENTS.md — kon-cardsim

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

A card game simulator whose games are data, plus two tools on the same engine: the showcase
(`/showcase/...`, formerly kon-deckshow) and the hand generator (`/hands/...`, formerly
kon-handlab). A session stores `{seed, decks, actions}` and rebuilds the state with `replay`;
clients only ever get the per-seat view from `viewFor`.

## Calling it

- Everything is one kon for scopes and tools: MCP tools are `cardsim__<operation>` and fine
  scopes `kon:cardsim:<operation>`, for all three parts. `cardsim:*` opens all of them.
- The handlers also ask a policy, by resource scope:
  - simulator: `cardsim:create` (save decks, open rooms, queue), `cardsim:manageCatalog`
    (`publish-game`, `import-cards`, `sync-catalog`);
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
- May come back `202 KITSUDEN_E_APPROVAL_REQUIRED` (report it, do not retry): `publish-game`,
  `import-cards`, `sync-catalog`, `publish-post`, `moderate-post`, `import-dataset`,
  `upload-cards` (declared sensitive) and the `DELETE`s `delete-deck`, `delete-post`, `unlike`,
  `delete-dataset`. `cancel-undo` and `leave-queue` are declared not sensitive.
- 404 is usually "hidden": someone else's private deck (row security), a hidden showcase entry,
  someone else's hand generator deck. `get-deck` with the deck's code in the `share` query opens a
  deck that is not yours.
- Idempotent: `import-cards`, `sync-catalog`, `upload-cards`, `like` (declared), and the `PUT`s.
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
| `index.ts` | The simulator's 30 operations, deck/room/session/queue/ranking handlers, `allOperations` (adds showcase and hand generator), rate limits, `defineKonSdk`. |
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

## Changing it

- New migration: next number in `migrations/` (`0013_…`); never edit an applied one. Renames of
  a migration file go in `migrations/history.json` (`renamed`; old checksums in
  `previousChecksums`). The `0008`–`0011` entries there keep old databases from running the
  merged migrations again: do not remove them.
- New file at the kon root: run `pnpm kon:sync` (updates `package.json` `files`).
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
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-cardsim"
```

- Engine files: the `cardsim-*` tests. `index.ts` or `cardsim.policy.ts`: `sec-cards-cardsim`,
  `cards-agents-with-scope`. Showcase: the `deckshow-*` tests and
  `sec-cards-deckshow-autobattler`. Hand generator: the `handlab-*` tests and `security-handlab`.

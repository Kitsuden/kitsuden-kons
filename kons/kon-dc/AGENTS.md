# AGENTS.md — kon-dc

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Keep it true when the kon changes.

## What it is

Discord bots as configuration: modules switched on per server, and blueprints (slash commands,
buttons, selects, modals, live panels and triggers made of fixed steps, as JSON). Interactions
arrive over HTTP, signed by Discord; gateway events arrive from a separate Go worker (`gateway/`);
other kons' events arrive on the core's bus. The API process holds no WebSocket.

## Calling it

- Configuration needs `dc:*`, `kon:dc:*` or the operation's fine scope
  (`kon:dc:create-blueprint`, `kon:dc:set-guild-module`…). A deny on the key wins.
- To build a bot: read `dc__get-blueprint-schema`, write a definition, check it with
  `dc__validate-blueprint` (problems come with their path), create it with `dc__create-blueprint`
  (status `published`), switch it on with `dc__set-guild-module` (`moduleId` = `blueprint-<id>`),
  then `dc__sync-guild-commands` for its slash commands and `dc__post-panel` for its panels.
- Or start from a template: `dc__list-templates`, then `dc__install-template` (a draft).
- `dc__list-modules` gives each module's settings as JSON Schema; `set-guild-module` answers 422
  with the problems when settings do not fit.
- `dc__delete-blueprint` and `dc__import` are sensitive. A write held for human approval answers
  `202 KITSUDEN_E_APPROVAL_REQUIRED`: report the proposal, do not retry.
- Never put a token or key in a blueprint or a module's settings: they are exported in clear.

## Map of the code

- `kon.json` — manifest: version, tables, mount path, admin views. The single source.
- `index.ts` — the kon definition and what the package exports (tables, schemas, module SDK,
  templates).
- `dc.contract.ts` — zod schemas: blueprint format (commands, components, modals, panels,
  triggers, steps), export file, gateway wire format, `DC_EVENTS`; `crossCheck` for rules across
  parts (an `open_modal` alone, ids unique, panels and modals that exist).
- `dc.modules.ts` — the module SDK, templates/rendering (placeholders, JSON bodies, embeds,
  components, modals), the step runner, blueprints as modules, the built-in modules.
- `dc.engine.ts` — modules per server, interactions (commands, autocomplete, components, modals,
  deferral), gateway events, kon events, live panels, command sync, the bounded queue.
- `dc.kitsuden.ts` — calls to other kons with the bot's agent key.
- `dc.templates.ts` — ready-made blueprints (broadcast booth, feedback form, loot box, quiz).
- `dc.catalog.ts` — the step catalog for editors (`GET /blueprints/steps`) and the guide a model
  gets for "describe your bot" (`POST /blueprints/generate`).
- `dc.cards.ts` — image cards: SVG templates (rank, wallet, leaderboard, profile, stat, captcha) →
  PNG with `sharp` loaded at run time; avatars only from allowed hosts.
- `dc.i18n.ts`, `dc.i18n.texts.ts` — the bot's own texts in the member's language: modules write
  `rt.t("English {var}", { var })`, the English is the key, the dictionary has Spanish and Portuguese.
- `dc.member.ts`, `member/` — the member page (HTML + script served by this kon), its Discord login
  (OAuth2 `identify`, signed state and session cookies) and its data.
- `dc.extensions.ts` — the public extension API (AI per server and metering, branded bots, event
  verdicts, staff actions, templates, plans). kon-dc never imports an extension; the registry lives
  on `globalThis` so an extension that loads its own copy of kon-dc still reaches the running one.
- `dc.manage.ts` — the admin's overview, economy, member file, activity and schedules routes.
- `dc.http.ts` — the checked fetch feeds use (https, no private addresses, redirects re-checked)
  and the RSS/Atom reader.
- Built-in modules by family: `dc.rewards.ts` (economy, leveling, giveaways, role menus, reminders,
  scheduled messages, suggestions, polls), `dc.profile.ts`, `dc.items.ts`, `dc.stats.ts`,
  `dc.voice.ts` (temporary rooms), `dc.feeds.ts`, `dc.moderation.ts` (moderation, automod, logs,
  tickets), `dc.security.ts`, `dc.webhooks.ts` (characters, sticky), `dc.extras.ts` (reaction roles,
  auto purge, birthdays). `dc.routes.ts` imports them so they register.
- `dc.rest.ts` — Discord REST over `fetch`, Ed25519 verification, settings from the environment.
- `dc.routes.ts` — the operations (REST route, OpenAPI entry and MCP tool each).
- `dc.policy.ts` — the team policy.
- `dc.schema.ts` — the Drizzle tables.
- `migrations/` — numbered SQL with row security.
- `admin-src/` — the admin view (Svelte 5 + tallao) → `admin/bot.js`: `BotAdmin.svelte` (tabs),
  `sections/` (Setup, Servers, Blueprints, `BlueprintEditor`), `blueprint.ts` (outline, paths,
  starters, preview model). A part tallao lacks goes into tallao first. `admin-src/tallao/` is a
  synced copy: never edit it; change tallao and run `TALLAO_DIR=<tallao> pnpm sync:tallao kon-dc`.
- `gateway/` — the Go worker (`main.go`, `shard.go`, `forwarder.go`), its Dockerfile and the
  committed JSON Schema of the wire format (`contract/`).
- `deploy/` — the Compose overlay with profiles and an example environment file.

## Rules that must hold

- Blueprints are data. Never add a step that evaluates code, a regular expression from the
  definition, or a request to a URL taken from it. Other kons are reached ONLY through
  `kon_call`/`KonSource` paths under this API (`KonPath`), with the bot's own key.
- A blueprint may not call `/dc/interactions` or `/dc/gateway/*`, nor listen to `dc:blueprint:*`
  events; `emit_event` only emits under `dc:blueprint:`. The per-module kon-event burst limit stays.
- Anything Discord users can trigger runs agents with `allowedTools: []`.
- Bot messages ping users only (`allowed_mentions: { parse: ["users"] }`): never everyone or roles.
- Calls to Discord, another kon or a model run outside the request's transaction (`background`),
  through the engine's bounded queue.
- A component that only acts is acknowledged as an update; an error then goes as a private
  follow-up, never over a panel.
- The interaction route verifies the signature over the raw body before parsing it, and refuses
  timestamps older than five minutes.
- The worker's key reaches `/gateway/*` only; those operations are not MCP tools.
- A module's state (`rt.kv`, `rt.lists`, its schedules) is namespaced by module id: a module never
  reads another's keys. The ECONOMY (wallets, inventories, the catalog), PROFILES and activity are
  shared on purpose: coins a blueprint gives are spent in the Economy shop.
- Feeds and card images are fetched only through `dc.http.ts` / `dc.cards.ts`: never a plain
  `fetch` of a URL a server owner wrote.
- Message text is stored only by the Logs module when a server sets `keepMessagesHours`, and the
  engine deletes it when it expires. Activity stores counts, never text.
- Anti-nuke never acts on the server's owner, the bot itself, or trusted members and roles.
- Every AI call goes through `runAi` (dc.extensions.ts), never `ctx.agents.run` directly: that is
  where an extension answers with a server's key or credits, refuses, or meters.
- Discord calls for a server use `restOf(guildId)` in the engine, never `restFor(settings())`: a
  branded bot answers with its own token.
- Built-in modules never write a sentence for a member without `rt.t(...)`, and a new key goes in
  `dc.i18n.texts.ts` with the same `{placeholders}` (a test checks them).
- The member page shows a server only while its `member-page` module is on, and only what that
  module allows; buying checks with Discord that the member is in the server. Its session cookie is
  signed with DISCORD_MEMBER_SECRET and carries only the Discord id, name and avatar.
- A free server cannot switch on DISCORD_PREMIUM_MODULES nor pass DISCORD_FREE_BLUEPRINTS; when a
  premium plan ends its premium modules stop by themselves (settings kept).
- Rewards that can race (a quiz win, a trade, a stock) use one SQL write to claim
  (`kv_increment`, `take`, `reserve`): never read-then-write.
- Events this kon emits carry ids and names, never message text.

## Changing it

- Schema change: edit `dc.schema.ts` and add the next numbered migration. Never edit an
  applied migration.
- Gateway wire change: edit the zod in `dc.contract.ts`, regenerate `gateway/contract/` with
  `KON_DC_WRITE_CONTRACT=1 pnpm vitest run tests/unit/kon-dc-contract.test.ts`, update
  `gateway/contract.go`, and bump `GATEWAY_CONTRACT_VERSION` and `ContractVersion` together if old
  workers cannot read it.
- New built-in module: `defineDcModule` in `dc.modules.ts` and register it; its id is
  stored, never rename it.
- New template: add it to `dc.templates.ts` with the scopes it needs; a test installs each one.
- Admin view: edit `admin-src/`, then `pnpm build:admin kon-dc` and `pnpm check:admin`; commit the
  built `admin/bot.js`.
- New file next to `index.ts`: run `pnpm kon:sync` (package.json `files`).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`.

## Tests

`pnpm test -- kon-dc` (both files); `cd kons/kon-dc/gateway && go test ./...` for the
worker. The tests inject a fake Discord, a fake renderer (`renderPng`), a fake web (`fetchText`), a
fake Twitch and a movable clock (`now`), and drive schedules with `engine.tick()`. On PGlite the
admin route that posts a panel cannot finish (one connection): panels are posted by commands there.

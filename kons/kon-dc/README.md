# kon-dc

Discord bots built from declarative blueprints: modules you switch on per server, slash commands,
buttons, selects, modals and live panels over HTTP, other kons as data sources and targets, and a
separate Go gateway worker.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| experimental | content | 0.2.0 | `/api/dc` | — |

A bot here is **configuration, not code**. Each server switches on the modules it wants (welcome,
auto role, levels, AI answers, kon announcements) and any number of **blueprints**: commands,
components, modals, live panels and triggers made of fixed steps, written as JSON, validated by one
zod schema, exportable and importable. Nothing an admin, an agent or an imported file writes is ever
run as code, so there is no sandbox to escape.

```
Discord ──signed HTTP (interactions)──▶ Kitsuden API + kon-dc ──REST──▶ Discord
Discord ──gateway WebSocket──▶ gateway/ (Go) ──HTTP + agent key──▶ kon-dc
other kons ──events on the core's bus──▶ kon-dc ──REST + the bot's agent key──▶ other kons
```

- **Interactions need no gateway.** Slash commands, autocomplete, buttons, selects and modals are
  POSTed by Discord, signed with Ed25519, to `POST /api/dc/interactions`. A bot made of commands and
  panels runs with the API alone.
- **The gateway lives in a separate Go process** (`gateway/`): heartbeats, resume, sharding and
  re-identifying when the needed intents change. The API can restart or redeploy without dropping
  the bot's session, and the worker uses about 10 MB of memory.
- **Switching a module off removes its traffic.** The worker identifies with the union of the
  intents the switched-on modules need and forwards only the event types they listen to.
- **Other kons are first-class.** A blueprint listens to their events (`broadcast:match:updated`),
  reads their data (a select whose options are kon-broadcast's roster, a panel that shows a set) and
  calls their operations, always with the bot's own agent key and only through their REST faces.
  kon-dc emits its own events (`dc:member:joined`, `dc:command:used`, `dc:component:used`,
  `dc:blueprint:<name>`…) for them and for the core's actions.
- **Bring your own model.** The AI module and the `ai_reply` step run one of the core's agents: its
  model, its key (Anthropic, OpenAI, Gemini…) or a local Ollama. They never get tools: anyone in a
  server can type to the bot.
- **No lock-in.** `GET /api/dc/export` gives the whole bot as one JSON file with no secrets;
  `POST /api/dc/import` loads it into any other installation.

## Install

Inside a Kitsuden project: `kitsuden kon add dc`, then restart the API. In Discord's Developer
Portal create an application with a bot, and set in the API:

| Variable | Where it comes from | Used for |
| --- | --- | --- |
| `DISCORD_APPLICATION_ID` | General Information → Application ID | command sync, deferred answers |
| `DISCORD_PUBLIC_KEY` | General Information → Public Key | verifying interactions |
| `DISCORD_BOT_TOKEN` | Bot → Reset Token | command sync, roles, messages, panels |
| `DISCORD_DISABLED_MODULES` | yours | modules switched off everywhere, comma-separated |
| `DISCORD_KITSUDEN_API_URL` | this API, as the API reaches itself | blueprints that call other kons |
| `DISCORD_KITSUDEN_API_TOKEN` | an agent key you create for the bot | the same; its scopes are the ceiling |

Then set **Interactions Endpoint URL** (General Information) to the URL the panel's *Setup* tab
shows (`https://<your API>/api/dc/interactions`). Discord checks it with a signed PING when you
save. The *Setup* tab also gives the invite link, which asks for view channels, send messages,
embed links, read history and manage roles, never Administrator.

### Docker Compose, with profiles

`deploy/docker-compose.dc.yml` is an overlay for Kitsuden's `docker-compose.yml`. Every Discord
process is behind a profile, so nothing starts unless you ask:

| Profile | Adds |
| --- | --- |
| (none) | the `DISCORD_*` settings in the API: commands, buttons, modals, panels work |
| `dc-gateway` | the Go gateway worker (joins, messages, reactions) |
| `dc-ai-local` | Ollama, for agents that answer with a local model |
| `dc` | both |

```bash
docker compose -f docker-compose.yml -f docker-compose.kons.yml \
  -f ../kitsuden-kons/kons/kon-dc/deploy/docker-compose.dc.yml \
  --profile dc-gateway up -d
```

The worker needs an agent key with only `kon:dc:gateway-config` and `kon:dc:ingest-gateway-events`
(`DISCORD_GATEWAY_AGENT_KEY`). The bot's own key for other kons is `DISCORD_BOT_AGENT_KEY`.
`deploy/dc.env.example` lists every setting. The worker image is a static binary on `scratch`,
read-only, with no capabilities and a 96 MB memory cap.

## What it adds

| Table | Holds |
| --- | --- |
| `dc_guilds` | servers the bot is or was in |
| `dc_blueprints` | blueprint definitions (draft or published) |
| `dc_guild_modules` | which module is on in which server, and its settings |
| `dc_kv` | per-server state of each module (counters, cooldowns, the booth's set) |
| `dc_panels` | live panels: messages the bot posted and keeps redrawing |
| `dc_wallets` | balances per server, member and currency (`coins`, `xp`, any other), shared by every module |
| `dc_inventory` | items per server and member |
| `dc_list_members` | lists of members (giveaway entries, raffles, birthdays by date) |
| `dc_schedules` | work for later (`later` steps, giveaway ends) and recurring schedules |
| `dc_profiles` | what follows a member across every server: bio, colour, reputation, badges, the global daily |
| `dc_global_wallets` | global balances (credits, global XP) |
| `dc_items` | the item catalog: a server's items, or global ones (badges, backgrounds) |
| `dc_global_inventory` | global items members own |
| `dc_voice_sessions` | who is in which voice channel, since when (voice XP, temporary rooms) |
| `dc_activity` | messages and voice minutes per member and day (never text) |
| `dc_characters` | characters members speak through (webhook proxies) |
| `dc_message_cache` | recent message text for logs: opt-in per server, erased when it expires |
| `dc_guild_plans` | each server's plan (free or premium, until when, where it came from) |

Built-in modules, each switched on per server with its own settings:

| Module | Does | Needs from Discord |
| --- | --- | --- |
| `welcome` | greets who joins (and by DM), says goodbye to who leaves | Server Members intent |
| `autorole` | gives roles to everyone who joins | Server Members intent |
| `ai` | `/ask` answered by a core agent (never with tools) | — |
| `announcements` | "when `<kon>:<event>` happens, post this in that channel" | — |
| `economy` | coins: `/daily` with streaks, `/work`, `/pay`, `/shop` with a select, `/buy`, `/inventory`, `/leaderboard`, `/economy` for the staff | — |
| `leveling` | XP for messages and voice minutes, level-up messages, role rewards, coins per level, multipliers, global XP, `/rank` and `/levels` as image cards | Guild Messages, Voice States |
| `profile` | `/profile` card across servers, `/rep`, `/credits` (global daily, balance, top) | — |
| `items` | the catalog's store, `/items buy use equip gift sell trade` (trades with Accept/Decline) | — |
| `giveaways` | `/giveaway start end reroll`: an Enter button with a live count, fair winners, coins | — |
| `role-menus` | panels of buttons or a select that give and take roles; `/rolemenu post` | — |
| `reaction-roles` | a reaction gives a role, removing it takes it | Guild Message Reactions |
| `reminders` | `/remind` by DM or in the channel | — |
| `scheduled-messages` | messages every N minutes or at a time of day | — |
| `birthdays` | `/birthday`: a greeting, a role for the day, coins | — |
| `suggestions` | `/suggest`: a card with votes and a thread | — |
| `polls` | `/poll`: Discord's own polls | — |
| `stats` | `/stats`, `/top` by day, week, month or all time; a weekly ranking with prizes and a champion role | Guild Messages, Voice States |
| `temp-voice` | join a hub, get your own voice room; `/voice rename limit lock` | Voice States |
| `feeds` | RSS, YouTube, Reddit and Twitch-going-live posts | — (Twitch keys in the API) |
| `moderation` | `/warn /warnings /timeout /kick /ban /purge /slowmode`, cases, a log channel, automatic steps at N warnings | — |
| `automod` | Discord's own AutoMod rules from settings (words, invites, links, mention spam, spam) | — |
| `security` | anti-nuke from the live audit log, a join gate, raid mode, image captcha, `/lockdown` | Guild Moderation, Server Members |
| `logs` | joins, leaves, bans, edits (before and after) and deletions (what it said, when text is kept) | Guild Messages; Message Content only if text is kept |
| `tickets` | a panel that opens a private thread per member, closed with a button | — |
| `characters` | speak as a character with its own name and avatar (`k:text`), like Tupperbox | Message Content (privileged) |
| `sticky` | a message kept at the bottom of a channel | Guild Messages |
| `auto-purge` | channels cleared on a schedule, pins kept | — |
| `member-page` | a web page for the server: rankings, the store, each member's stats, a Discord login | — |

The bot answers in each member's Discord language (English, Spanish and Portuguese for now), and
in the server's for what it says by itself; slash commands carry Discord's localized descriptions.
Blueprints and module settings are written by the staff in their own language.

Image cards (rank, wallet, leaderboard, profile, captcha, a generic stat card) are drawn as SVG and
turned into PNG with `sharp`, which the API already ships. The API's image needs a font: Debian
has DejaVu; on Alpine add `font-dejavu`. Without `sharp` the modules answer with embeds.

### The builder

Everything Discord's interactions offer, as data (`GET /api/dc/blueprints/schema` is the full
format):

| Part | What it is |
| --- | --- |
| `commands` | slash commands with options, `choices`, `autocomplete` (a fixed list, or another kon's list), min/max, `subcommands`, an `access` role gate |
| components | rows of buttons (`primary`, `secondary`, `success`, `danger`, links), selects (fixed options, another kon's list, or a list an earlier step got) and user/role/channel selects; each with its own steps and role gate |
| `modals` | up to 5 text fields, prefilled from templates; their steps read `{{input.<id>}}` |
| `panels` | live messages: data read from other kons, embeds and components; redrawn on the kon events they name, and after their own buttons |
| `triggers` | `member_join`, `message`, `reaction_add`, and `kon_event` (another kon's event, with `{{event.*}}`), each with an optional `where` |

Steps, grouped as the editor shows them (`GET /api/dc/blueprints/steps` gives each one with an
example and a form schema):

- **Messages**: `reply`, `update_message`, `send_message`, `dm`, `open_modal` (the first whose
  `if` holds), `poll`.
- **Discord**: `add_role`, `remove_role`, `toggle_role` (with `{{value}}` for role menus),
  `timeout`, `kick`, `ban`, `set_nickname`, `delete_message`, `pin_message`, `react`,
  `create_thread`, `close_thread`, `slowmode`.
- **Rewards**: `wallet_add`, `wallet_take` (all or nothing), `wallet_get`, `leaderboard`,
  `item_add`, `item_take`, `item_get`, `item_random` (a drop by rarity), `item_transfer`,
  `item_use`, `list_join`, `list_pick`, `list_count`, `list_clear`, `card` (an image: rank,
  wallet, leaderboard, stat), `activity_get`, `activity_top`. With `global: true` the wallet steps
  use the balance shared by every server.
- **Flow and data**: `stop`, `cooldown`, `set_var`, `random` (numbers or a weighted loot table),
  `math` (arithmetic, never code), `later` (steps that run in N minutes), `kv_set`,
  `kv_increment`.
- **Kons and AI**: `kon_call`, `emit_event`, `post_panel`, `refresh_panels`, `ai_reply`.

Any step can carry an `if` (`eq`, `neq`, `contains`, `starts_with`, `ends_with`, `gt`, `gte`, `lt`,
`lte`, `empty`, `not_empty`, `in`, `not_in`). Triggers: `member_join`, `member_leave`, `message`,
`reaction_add`, `reaction_remove`, `voice_join`, `voice_leave`, `item_used`, `kon_event` and
`schedule` (every N minutes, or at a time of day on some weekdays, in a time zone). Commands can be
slash commands or context menus (right click on a member or a message), gated by roles or by
Discord permissions.

Text takes placeholders (`{{user.mention}}`, `{{option.<name>}}`, `{{value}}`, `{{input.<id>}}`,
`{{kv.<key>}}` (`$user` in the key is the member), `{{var.<name>}}`, `{{call.<saveAs>.<path>}}`,
`{{data.<name>.<path>}}`, `{{event.<path>}}`, `{{target.*}}`, `{{now.unix}}`…) and filters
(`{{x|upper}}`, `{{x|number}}`, `{{x|default:none}}`, `{{x|plural:coin,coins}}`, `{{x|time:R}}`,
`{{x|bar:500}}`…). In a JSON body, a value that is exactly one placeholder keeps its type, and a
missing or blank one is left out: a blank modal field means "leave it as it is".

```json
{
  "commands": [{
    "name": "cookie", "description": "Give a cookie",
    "options": [{ "name": "to", "description": "Who", "type": "user", "required": true }],
    "steps": [
      { "do": "kv_increment", "key": "cookies", "by": 1 },
      { "do": "reply", "content": "{{user.name}} gave a cookie to <@{{option.to}}> ({{kv.cookies}} so far)" }
    ]
  }],
  "triggers": [{
    "on": "kon_event", "event": "blog:post:published",
    "steps": [{ "do": "send_message", "channelId": "123456789012345678", "content": "New post: {{event.title}}" }]
  }]
}
```

### Templates

`GET /api/dc/templates` lists ready-made blueprints; installing one creates a draft you edit like
any other:

- **broadcast-booth**: the operator's booth for kon-broadcast, for any game. `/booth` commands
  (set, panel, event, player, score, point, chars, swap, versus, ko, casters, caster, reset, startgg,
  status), and a live panel with score buttons, screen toggles, an edit form, a round select and
  character selects fed by the kon's roster. It redraws on `broadcast:match:updated`. It needs the
  bot's key to have the kon-broadcast scopes the template lists, and an operator role is advised.
- **feedback-form**: `/feedback` opens a form; answers arrive in a staff channel.
- **loot-box**: `/lootbox` (or a panel button) spends coins on weighted drops into the inventory.
- **quiz**: `/quiz ask`; the first right answer (in a form) wins coins and XP.

"Describe a bot" (`POST /api/dc/blueprints/generate`) asks a core agent to write a blueprint from a
description; the server checks it and asks once more with the problems. Nothing is saved until you
save it in the editor.

### Shared types

The kon's entry exports what other code needs, so nothing is declared twice:

- the Drizzle tables and their row types (`dcBlueprints`, `DcBlueprint`, `dcPanels`…);
- the zod schemas (`BlueprintDefinition`, `KonSource`, `DcExport`, `GatewayConfig`…) and the
  event names (`DC_EVENTS`);
- the module SDK (`defineDcModule`, `registerDcModule`, and the runtime with `kitsuden`,
  `panels`, `emit`): another kon adds a module by depending on this one and registering it;
- the templates (`TEMPLATES`, `BOOTH_SCOPES`).

The gateway wire format is also committed as JSON Schema in `gateway/contract/` and served at
`GET /api/dc/contract`; a test fails if the zod schemas, that JSON Schema and the Go structs
drift apart.

### Admin view

`admin-src/` (Svelte 5 + tallao, built to `admin/bot.js` as `<dc-bot-admin>`) is configuration and
oversight: *Setup* (what is configured, the endpoint URL, the invite link, activity), *Servers*
(modules on/off with their settings as forms drawn from each module's schema, lists of ids as
TagInputs, the slash commands and the sync, the live panels), *Blueprints* (a visual editor: the
definition as a TreeView outline, each part edited and checked against the server's schema as you
apply it, the parts with problems marked, messages and panels previewed as Discord draws them;
the whole JSON one tab away; publishing; templates installed through a form) and *Export /
import*. Rebuild with `pnpm build:admin kon-dc`; check with `pnpm check:admin`.

## HTTP API

| Route | Who |
| --- | --- |
| `GET /api/dc/status` | admin, editor, or an agent with this kon's scope |
| `GET /api/dc/modules` | admin, editor, or an agent with this kon's scope |
| `GET /api/dc/guilds` | admin, editor, or an agent with this kon's scope |
| `PUT /api/dc/guilds/:guildId` | admin, editor, or an agent with this kon's scope |
| `GET /api/dc/guilds/:guildId/modules` | admin, editor, or an agent with this kon's scope |
| `PUT /api/dc/guilds/:guildId/modules/:moduleId` | admin, editor, or an agent with this kon's scope |
| `GET /api/dc/guilds/:guildId/commands` | admin, editor, or an agent with this kon's scope |
| `POST /api/dc/guilds/:guildId/commands/sync` | admin, editor, or an agent with this kon's scope |
| `GET /api/dc/guilds/:guildId/panels` | admin, editor, or an agent with this kon's scope |
| `POST /api/dc/guilds/:guildId/panels` | admin, editor, or an agent with this kon's scope |
| `POST /api/dc/guilds/:guildId/panels/refresh` | admin, editor, or an agent with this kon's scope |
| `GET /api/dc/blueprints` | admin, editor, or an agent with this kon's scope |
| `POST /api/dc/blueprints` | admin, editor, or an agent with this kon's scope |
| `POST /api/dc/blueprints/validate` | admin, editor, or an agent with this kon's scope |
| `POST /api/dc/blueprints/generate` | admin, editor, or an agent with this kon's scope (runs a core agent, with no tools) |
| `GET /api/dc/blueprints/:id` | admin, editor, or an agent with this kon's scope |
| `PATCH /api/dc/blueprints/:id` | admin, editor, or an agent with this kon's scope |
| `DELETE /api/dc/blueprints/:id` | admin, editor, or an agent with this kon's scope |
| `GET /api/dc/templates` | admin, editor, or an agent with this kon's scope |
| `POST /api/dc/templates/:templateId/install` | admin, editor, or an agent with this kon's scope |
| `GET /api/dc/export` | admin, editor, or an agent with this kon's scope |
| `POST /api/dc/import` | admin, editor, or an agent with this kon's scope |
| `GET /api/dc/blueprints/schema` | anyone (the format, no data) |
| `GET /api/dc/blueprints/steps` | anyone (the step catalog, no data) |
| `GET /api/dc/items` | admin, editor, or an agent with this kon's scope |
| `PUT /api/dc/items` | admin, editor, or an agent with this kon's scope |
| `DELETE /api/dc/items/:id` | admin, editor, or an agent with this kon's scope |
| `GET /api/dc/overview` | admin, editor, or an agent with this kon's scope |
| `GET /api/dc/guilds/:guildId/economy` | admin, editor, or an agent with this kon's scope |
| `PUT /api/dc/guilds/:guildId/economy/:userId` | admin, editor, or an agent with this kon's scope |
| `GET /api/dc/guilds/:guildId/members/:userId` | admin, editor, or an agent with this kon's scope |
| `GET /api/dc/guilds/:guildId/activity` | admin, editor, or an agent with this kon's scope |
| `GET /api/dc/guilds/:guildId/schedules` | admin, editor, or an agent with this kon's scope |
| `DELETE /api/dc/guilds/:guildId/schedules/:id` | admin, editor, or an agent with this kon's scope |
| `GET /api/dc/guilds/:guildId/plan` | admin, editor, or an agent with this kon's scope |
| `PUT /api/dc/guilds/:guildId/plan` | admin, editor, or an agent with this kon's scope (a shop kon, with its key and this scope) |
| `GET /api/dc/member/page/:guildId` | anyone, while the server's member-page module is on |
| `GET /api/dc/member/page.js` | anyone (the page's script, no data) |
| `GET /api/dc/member/login` | anyone (to Discord's login, scope `identify`) |
| `GET /api/dc/member/callback` | anyone with the state their browser got (back from Discord) |
| `POST /api/dc/member/logout` | anyone |
| `GET /api/dc/member/guilds/:guildId` | anyone, while the server's member-page module is on; "me" with a member session |
| `POST /api/dc/member/guilds/:guildId/buy` | a member session, in that server; JSON only |
| `GET /api/dc/contract` | anyone (the wire format, no data) |
| `POST /api/dc/interactions` | Discord only: the Ed25519 signature is checked |
| `GET /api/dc/gateway/config` | the gateway worker's key, or an admin |
| `POST /api/dc/gateway/events` | the gateway worker's key, or an admin |

## Who can do what

`dc.policy.ts` decides. The team (admin, editor) reads and changes servers, modules, blueprints and
panels; an agent needs `dc:*`, `kon:dc:*` or the operation's fine scope. Nothing is public except
the two schemas. Discord is authenticated by its signature, and the gateway worker by an agent key
that holds only the two gateway scopes: it cannot read or change the configuration. Row security on
all five tables admits the team only; interactions and the worker write as the system after the
route has authorized them.

Inside a Discord server, who may run a command, press a button or submit a modal is the
blueprint's `access.roles`. What any of that may do in OTHER kons is bounded by the scopes of the
bot's agent key (`DISCORD_KITSUDEN_API_TOKEN`), whatever a blueprint says; an operation that needs a
human's approval answers the member "waiting for approval" and is not retried. A blueprint cannot
call the bot's own Discord endpoints, cannot listen to blueprint events (loops), and a module that
reacts to kon events more than 30 times in 10 seconds in one server is skipped.

## Configuration

The `DISCORD_*` variables above, read on every use, and:

| Variable | For |
| --- | --- |
| `DISCORD_CARD_IMAGE_HOSTS` | extra https hosts card images (item backgrounds) may come from; Discord's CDN always may |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | the `feeds` module's Twitch live checks |
| `DISCORD_CLIENT_SECRET`, `DISCORD_OAUTH_REDIRECT_URL`, `DISCORD_MEMBER_SECRET` | the member page's Discord login: the app's secret, this API's `/api/dc/member/callback` (also in the Developer Portal), and 32+ random characters that sign sessions |
| `DISCORD_PREMIUM_MODULES` | modules only premium servers can switch on (comma-separated ids) |
| `DISCORD_FREE_BLUEPRINTS` | how many blueprints a free server can have on (empty = no limit) |

Module settings live per server in `dc_guild_modules` and are validated by each module's zod schema
(`GET /api/dc/modules` returns each one as JSON Schema). Feeds are fetched over https only, never
from private addresses (checked again on each redirect), 8 s and 1 MB at most. Calls to Discord wait
for each route's rate-limit bucket and obey a `retry_after` instead of failing.

## Extending kon-dc

Another package can add to kon-dc without kon-dc importing it (`dc.extensions.ts`): kon-dc's
Enterprise edition plugs in this way, and so can your own code.

```ts
import { registerDcExtension } from "@kitsuden/kon-dc";

registerDcExtension({
  name: "my-extension",
  modules: [/* more modules, offered to every server */],
  ai: (req) => null, // a runner (a server's own key, credits), a refusal sentence, or null = core agents
  afterAi: (usage) => {}, // metering: purpose, server, member, characters in and out, ms
  botFor: (guildId) => null, // a branded bot's token and application for that server
  publicKeys: () => [], // more keys interactions may be signed with
  onEvent: (event) => undefined, // "drop" stops a gateway event before the modules
  onStaffAction: (action) => {}, // every write the team makes through the API
  templates: () => [], // more ready-made blueprints
  isPremium: (guildId) => null, // a billing system's answer; null = the dc_guild_plans table
});
```

Every hook is optional. With none registered kon-dc behaves exactly as it does alone; a hook that
throws in `onEvent` or `onStaffAction` is logged and does not stop the bot.

## Agents and MCP

Every configuration operation is an MCP tool (`dc__list-modules`, `dc__set-guild-module`,
`dc__validate-blueprint`, `dc__create-blueprint`, `dc__install-template`, `dc__post-panel`,
`dc__export`…), so an agent can build a bot by writing a blueprint from
`dc__get-blueprint-schema` and checking it with `dc__validate-blueprint`. The interaction and
gateway operations are not MCP tools. See [AGENTS.md](AGENTS.md).

## Tests

`tests/unit/kon-dc.test.ts` (routes on PGlite with row security, a fake Discord, a fake agent
engine, a fake kon-broadcast behind the bot's key and an event bus) and
`tests/unit/kon-dc-contract.test.ts` (zod ⇄ JSON Schema ⇄ Go). The worker has its own:
`cd kons/kon-dc/gateway && go test ./...` (a fake gateway and a fake kon).

## Roadmap

Not built yet: music (it needs a voice connection, a separate service), more languages than
English, Spanish and Portuguese, a payment provider of its own (plans are set by the team or by a
shop kon through `PUT /guilds/:guildId/plan`), Discord's newer layout components and a marketplace
of blueprints.

## License

MIT

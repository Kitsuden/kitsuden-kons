# AGENTS.md — kon-koe

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

An omnichannel inbox mounted at `/api/koe`: WhatsApp Cloud API, Messenger, Instagram and a web chat of its
own, one conversation per contact and channel, a state machine for who answers (bot, queue, person, snoozed,
resolved), Meta's windows and templates enforced on every outbound message, a live inbox with web push, rich
media, an AI relay to kon-chat, and automation (flows, rule steps, campaigns, sequences, SLAs, collections).

## Calling it

- MCP tools are `koe__<operation>`; ask for `kon:koe/inbox` or `kon:koe/supervisor` to see a short list.
- Read before writing: `koe__list-conversations` (filter `assignee=me`, `state=queued`), `koe__get-conversation`,
  `koe__list-messages`, then `koe__conversation-window` before answering. When the window is closed on
  WhatsApp only an approved template goes out (`kind: "template"` with `templateId` and `values`).
- `koe__send-message` from an agent key is sent as the AI. It is refused (409, `details.koe: BOT_SILENCED`)
  in any conversation that is not in the `bot` state: a person has it, or it waits for one. Do not retry;
  leave a note (`koe__add-note`) or hand off (`koe__handoff-conversation` with a `summary`).
- Long lists page: `koe__list-notes`, `koe__list-promises` and `koe__list-outcomes` take `limit` and `offset`
  and answer `hasMore` (promises and outcomes default to 200 rows, notes to all of them); so do
  `koe__list-contacts`, `koe__list-notices`, `koe__list-quick-replies`, `koe__list-stickers` and
  `koe__list-campaigns`, with their own default `limit`. Keep asking with `offset += limit` while
  `hasMore` is true. Configuration lists
  (members, teams, channels, templates, flows, sequences) come whole.
- Pass `idempotencyKey` (body) or `idempotency_key` (MCP) on sends you may repeat; the same key never sends
  twice.
- Scopes: `koe:*` (or `kon:koe:*`) opens everything as a koe admin; a fine scope (`kon:koe:send-message`)
  opens that one operation as a member would, and no other. A key without a koe scope gets 403. A denial wins.
- `202 KITSUDEN_E_APPROVAL_REQUIRED` on sensitive operations (channels, members, templates, campaign
  approval, merges): report the proposal; do not retry.
- 404 means missing or not visible to you; the API never says which.
- Never send a campaign or a template to a contact without recorded consent; the API refuses a campaign or
  any marketing template without opt-in (`OPTED_OUT`), whoever sends it, and trying costs the owner's number
  quality.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | `defineKonSdk`: operations of every module, queue handlers, rate limits, tool groups, events, rule steps, reports, secret columns, startup. |
| `operations.ts` | The router-shaped registry every module adds to. |
| `koe.common.ts` | Kon id, queue names, the context, `emit`, small helpers. |
| `koe.schema.ts` | Drizzle tables and types. |
| `koe.policy.ts` | The `koe` policy, `requireMember`, `requireLead`. |
| `koe.states.ts` | The state machine: the transition table and the one gate. Pure. |
| `koe.window.ts` | Service windows per channel, the human-agent tag, free entry. Pure. |
| `koe.conversations.ts` | `changeState` with the row locked, assignment (round robin, load), transfer, SLAs. |
| `koe.inbound.ts` | Webhook storage, the inbound job, contacts and identities, statuses, keywords. |
| `koe.send.ts` | `send()`, the only way out, and the delivery job. |
| `koe.templates.ts` | Template slots, filling, sync with Meta, status webhooks. |
| `koe.channels.ts` | Sealed credentials and channel lookups. |
| `koe.realtime.ts` | Realtime channel names and their authorizer. |
| `koe.notify.ts` | Notices, payload-less web push with VAPID, the notify queue. |
| `koe.ops.inbox.ts` | Inbox operations: conversations, messages, notes, contacts, notices, push. |
| `koe.ops.setup.ts` | Members, teams, channels, Meta webhook, templates, public web chat. |
| `koe.ops.web.ts` | The inbox page, its bundle, the service worker, the widget script. |
| `koe.media.ts` | Media download and upload, the sidecar client, stickers, `channelFileOf`. |
| `koe.quickreplies.ts` | Quick replies and sending them with attachments. |
| `koe.bot.ts` | Bot turns (flow, then kon-chat through a queue), bot replies, store context, copilot. |
| `koe.flows.ts` | The flow language, its check, engine and dry run. |
| `koe.automation.ts` | Rule steps, the automation queue, and the modules below. |
| `koe.campaigns.ts`, `koe.sequences.ts`, `koe.sales.ts` | Campaigns, sequences, promises, outcomes, portfolio and pipeline. |
| `koe.sweep.ts`, `koe.hours.ts` | What happens because time passed (the core schedule `koe:sweep`, once a minute; a per-process interval only on a core without kon schedules); quiet and business hours. |
| `koe.reports.ts` | Kon reports and the inbox summary. |
| `koe.events.ts` | The event catalog. |
| `koe.extensions.ts` | The public extension API (`beforeSend`, `onAccess`); koe Enterprise plugs in here. |
| `channels/*` | Adapters: `whatsapp.ts`, `messenger.ts`, `instagram.ts` (shared `meta-messaging.ts`), `webchat.ts`; `graph.ts` (signatures, calls, errors, media downloads); `types.ts` (the contract). |
| `migrations/0000_initial.sql` | Tables, indexes, row security and its helper functions. |
| `admin-src/*`, `admin/*.js` | The admin view (`koe-admin`) and the inbox (`koe-inbox`); `admin/` is built, do not edit. |
| `public/*` | The service worker and the web chat widget, served as they are. |
| `media-sidecar/*` | The Go converter (ffmpeg) for voice notes, playable copies and stickers. |

## Rules that must hold

- Nothing leaves except through `send()`; the delivery job re-checks bot silence, the window and extension policies.
- koe never imports an extension (koe Enterprise included); keep `koe.extensions.ts` the only seam and keep it backward compatible.
- Every change of who answers goes through `changeState()`; never update `state` or `assignee_id` by hand
  (removing a member is the one bulk exception, and it goes to `queued`).
- Every queue handler is idempotent: the queue delivers at least once.
- The webhook route answers fast: signature, store, queue. No calls to Meta inside it.
- Credentials are sealed and never returned; their columns end in `token` or `secret` and are declared in
  `secretColumns`.
- The window is computed from `last_inbound_at`, never stored as a state.
- Realtime messages carry ids and what changed, never content the client could not read over REST.
- Meta's limits are data (`POLICIES`, `capabilities`); mark anything not checked against Meta's docs with
  "verify".

## Changing it

- New outbound kind: add it to `OutboundKind`, each adapter's payload and `capabilities`, and `mediaProblem`
  in `koe.send.ts`.
- New channel: an adapter in `channels/`, its `POLICIES` entry, the `kind` check in the migration.
- New state or trigger: the table in `koe.states.ts` and the exhaustive test; the migration's checks.
- New table: a new migration with row security, `kon.json` `tables`, then `pnpm kon:sync kon-koe`.
- After editing `admin-src`: `pnpm build:admin kon-koe` and `pnpm check:admin kon-koe`.

## Tests

`tests/unit/helpers/koe-bench.ts` mounts the kon on PGlite as a non-superuser with row security, replaces the
queue (jobs run with `drain()`), secrets, storage, realtime, events and Meta's Graph API. Suites:
`kon-koe-core`, `kon-koe-extensions`, `kon-koe-channels`, `kon-koe-media`, `kon-koe-ai`, `kon-koe-automation`, `kon-koe-web`.

```bash
pnpm vitest run tests/unit/kon-koe-core.test.ts tests/unit/kon-koe-channels.test.ts
```

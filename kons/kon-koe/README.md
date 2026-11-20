# kon-koe

One inbox for WhatsApp Cloud API, Messenger, Instagram and web chat, built for automation and AI agents
first, and for teams that sell and collect over chat. Notes for coding agents: [AGENTS.md](AGENTS.md).

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| experimental | business | 0.2.0 | `/api/koe` | core `auth`; a secrets key for Meta channels; kon-chat optional (AI bots); the media sidecar optional (voice notes, stickers) |

koe (声, "voice") keeps one conversation per contact and channel, decides who answers it (a bot, the queue,
one person), enforces each channel's service window and Meta's template rules on every message that goes
out, and lets rules, campaigns and agents act on conversations with the same permissions as people.

## Install

```bash
kitsuden kon add koe --enable
```

Run it inside a Kitsuden project and restart the API. Then:

1. Set `KITSUDEN_SECRETS_KEY` in the API: access tokens and app secrets are stored sealed, and without a key
   a Meta channel cannot be connected (web chat still works).
2. Add people to the team (`PUT /api/koe/members/:userId`) and create teams.
3. Connect channels in the admin view (**koe**): a WhatsApp number (phone number id, WhatsApp Business Account
   id, a system user token, the app secret), a Facebook page or Instagram account (id, page token, app
   secret), or a web chat (a name; its public key is generated).
4. In the Meta app, set the webhook to `https://<api>/api/koe/webhooks/meta` with the verify token you saved
   in the admin view, and subscribe to `messages` (WhatsApp, Messenger, Instagram) and, for WhatsApp,
   `message_template_status_update`, `message_template_quality_update` and `phone_number_quality_update`.
5. Agents work at `https://<api>/api/koe/inbox`.

Optional:

- **AI bots**: install kon-chat, create a bot with audience `channel`, and set the channel's bot.
- **Voice notes and stickers**: run the media sidecar (`media-sidecar/`, Go and ffmpeg) and set
  `KOE_MEDIA_URL` and `KOE_MEDIA_TOKEN` in the API. Without it, recordings go out as audio files where the
  channel accepts them and stickers must already be WebP 512×512.
- **Web chat on another site**: add that site to the core's `ALLOWED_ORIGINS` and paste the snippet from the
  admin view.

Meta's rules (window lengths, tags, sizes, prices) change. They are data in `koe.window.ts` and the adapters'
`capabilities`; check them against Meta's current documentation before relying on them.

## How it works

- **In**: the webhook checks the signature over the raw body, stores the body once (a resent webhook is a
  no-op) and queues a job. The job finds or creates the contact and the open conversation, stores the
  message, reopens the window, applies keywords (opt-out, opt-in, "a person please"), downloads media before
  Meta's URL expires, and wakes the bot or tells the people who should know.
- **Who answers**: `bot`, `queued`, `human`, `snoozed`, `resolved`. Every change goes through one state
  machine with the row locked; two people taking the same conversation get one 200 and one 409. The bot never
  writes in a conversation a person has: `send()` refuses it, and the delivery job checks again.
- **Out**: one path for everyone (people, bots, AI, rules, campaigns). It refuses what the channel cannot
  carry, blocked and opted-out contacts, free text outside the window (WhatsApp then takes only approved
  templates; Messenger and Instagram take a person's reply with the human-agent tag for up to 7 days), and
  repeats with the same idempotency key. Delivery runs on a queue at the channel's pace and classifies Meta's
  errors: temporary ones retry, permanent ones fail the message, a refused token marks the channel broken.
- **Live**: the inbox listens on realtime channels authorized per conversation and re-reads through REST.
  Web push carries no content: the service worker asks for the notice with the person's session.
- **Bots**: a flow without AI (menus, questions, branches, handoff) or a kon-chat bot through a queue, with
  the conversation's history and store context (the contact, open payment promises, recent kon-ecommerce
  orders, kon-crm deals when installed). A bot that cannot help hands off with a summary.
- **Automation**: rule steps for the core's rule engine, campaigns of templates (consent required, paced,
  quiet hours, cost estimate, approval), sequences that stop when the contact answers, SLAs, reminders before
  a window closes, auto-resolve, payment promises and outcomes for collections, and reports.

## Editions

koe is MIT and complete on its own: channels, inbox, windows and templates, bots and AI relay, flows,
campaigns, teams, SLAs, collections, reports. **koe Enterprise** (`kon-koe-ee`, a separate package under its
own license) adds what organizations need to coordinate and prove things: an audit log of who read and
changed each conversation, data retention with legal holds, and contact rules for collections law. It plugs
in through the public extension API below; koe never imports it, and without it koe behaves the same.

### Extension API

`registerKoeExtension({ name, beforeSend?, onAccess? })`, exported from the kon (`koe.extensions.ts`):

- `beforeSend(check)` runs in `send()` and again in the delivery job. Returning a sentence refuses the
  message (409 `details.koe: "POLICY"` at send, `failed` with `POLICY` at delivery). A hook that throws
  refuses too.
- `onAccess(event)` hears reads and changes (`view`, `messages`, `send`, `state`, `note`,
  `contact-view`, `contact-update`) inside the same transaction; if it throws, the request fails.

## HTTP API

Every route answers `{ data }` (lists add `next` when there is more). Notes, payment promises and outcomes
take `limit` and `offset` and add `hasMore`: promises and outcomes default to (and cap at) 200 rows, what they
always returned; notes return every note unless `limit` (1-500) is given. Contacts, notices, quick replies,
stickers and campaigns keep their own `limit` and default (contacts, notices and quick replies 30 of at most
100, stickers 100 of 200, campaigns 50 of 100) and take `offset` with `hasMore` too. Members, teams, channels,
templates, flows and sequences are configuration and come whole. `POST /api/koe/conversations/:id/messages`
refuses with 409 and `details.koe` naming why: `WINDOW_CLOSED`, `TAG_NOT_ALLOWED`, `TEMPLATE_NOT_SUPPORTED`,
`TEMPLATE_NOT_APPROVED`, `OPTED_OUT`, `BLOCKED`, `NOT_YOURS`, `BOT_SILENCED`, `UNSUPPORTED`, `TOO_LARGE`.

| Method and route | Who | What |
| --- | --- | --- |
| GET `/api/koe/me` | member | Who I am in koe |
| POST `/api/koe/me/heartbeat` | member | I am in the inbox |
| GET `/api/koe/conversations` | member | List conversations |
| GET `/api/koe/conversations/counts` | member | Inbox counters |
| GET `/api/koe/conversations/:id` | member | One conversation |
| GET `/api/koe/conversations/:id/messages` | member | Messages of a conversation |
| POST `/api/koe/conversations/:id/messages` | member | Send a message |
| POST `/api/koe/conversations/:id/take` | member | Take a conversation |
| POST `/api/koe/conversations/:id/assign` | member | Give a conversation to someone |
| POST `/api/koe/conversations/:id/release` | member | Let a conversation go back to the queue |
| POST `/api/koe/conversations/:id/return-to-bot` | member | Hand a conversation back to the bot |
| POST `/api/koe/conversations/:id/handoff` | member | Ask for a person |
| POST `/api/koe/conversations/:id/snooze` | member | Snooze a conversation |
| POST `/api/koe/conversations/:id/resolve` | member | Resolve a conversation |
| POST `/api/koe/conversations/:id/transfer` | member | Move a conversation to another team |
| PATCH `/api/koe/conversations/:id` | member | Label or prioritise a conversation |
| POST `/api/koe/conversations/:id/read` | member | Mark as read |
| POST `/api/koe/conversations/:id/typing` | member | I am typing |
| GET `/api/koe/conversations/:id/window` | member | Can I write freely now? |
| GET `/api/koe/conversations/:id/notes` | member | Internal notes (`limit`, `offset`; `hasMore`) |
| POST `/api/koe/conversations/:id/notes` | member | Add an internal note |
| GET `/api/koe/conversations/:id/events` | member | What happened to a conversation |
| GET `/api/koe/contacts` | member | Find contacts (`q`, `limit`, `offset`; `hasMore`) |
| GET `/api/koe/contacts/:id` | member | One contact |
| PATCH `/api/koe/contacts/:id` | member | Edit a contact |
| POST `/api/koe/contacts/:id/merge` | member | Merge two contacts |
| PUT `/api/koe/contacts/:id/consent` | member | Record consent |
| POST `/api/koe/contacts/:id/start` | member | Write first to a contact |
| GET `/api/koe/notices` | member | My notices (`unread`, `limit`, `offset`; `hasMore`) |
| GET `/api/koe/notices/latest` | member | What a push should show |
| POST `/api/koe/notices/read` | member | Mark notices as read |
| POST `/api/koe/push/subscriptions` | member | Get web push on this browser |
| POST `/api/koe/push/unsubscribe` | member | Stop web push on this browser |
| GET `/api/koe/members` | member | Who is on koe |
| PUT `/api/koe/members/:userId` | admin | Add or change a member |
| DELETE `/api/koe/members/:userId` | admin | Remove a member |
| GET `/api/koe/teams` | member | Teams |
| POST `/api/koe/teams` | member | Create a team |
| PATCH `/api/koe/teams/:id` | member | Change a team |
| DELETE `/api/koe/teams/:id` | member | Delete a team |
| PUT `/api/koe/teams/:id/members` | member | Who is on a team |
| GET `/api/koe/channels` | member | Channels |
| POST `/api/koe/channels` | admin | Connect a channel |
| PATCH `/api/koe/channels/:id` | admin | Change a channel |
| DELETE `/api/koe/channels/:id` | admin | Disconnect a channel |
| POST `/api/koe/channels/:id/check` | admin | Check a channel's connection |
| PUT `/api/koe/config/meta` | admin | Set the Meta webhook verify token |
| GET `/api/koe/webhooks/meta` | anyone | Meta webhook verification |
| POST `/api/koe/webhooks/meta` | anyone | Meta webhook |
| GET `/api/koe/templates` | member | WhatsApp templates |
| POST `/api/koe/channels/:id/templates/sync` | member | Refresh templates from Meta |
| POST `/api/koe/channels/:id/templates` | member | Submit a template to Meta |
| DELETE `/api/koe/templates/:id` | member | Delete a template |
| POST `/api/koe/templates/:id/preview` | member | Preview a filled template |
| GET `/api/koe/public/webchat/:key/config` | anyone | Web chat settings |
| POST `/api/koe/public/webchat/:key/messages` | anyone | A visitor writes |
| GET `/api/koe/public/webchat/:key/messages` | anyone | A visitor's conversation |
| POST `/api/koe/media` | member | Upload a file to send |
| GET `/api/koe/media/:id` | member | A media file |
| GET `/api/koe/stickers` | member | The team's stickers (`limit`, `offset`; `hasMore`) |
| POST `/api/koe/stickers` | member | Keep a sticker |
| DELETE `/api/koe/stickers/:id` | member | Remove a sticker from the library |
| POST `/api/koe/public/webchat/:key/media` | anyone | A visitor sends a file |
| GET `/api/koe/quick-replies` | member | Quick replies (`limit`, `offset`; `hasMore`) |
| POST `/api/koe/quick-replies` | member | Create a quick reply |
| PATCH `/api/koe/quick-replies/:id` | member | Change a quick reply |
| DELETE `/api/koe/quick-replies/:id` | member | Delete a quick reply |
| POST `/api/koe/conversations/:id/quick-replies/:qrId/send` | member | Send a quick reply |
| GET `/api/koe/config/copilot` | member | Is the copilot set up? |
| PUT `/api/koe/config/copilot` | admin | Choose the copilot's agent |
| POST `/api/koe/conversations/:id/copilot/draft` | member | Suggest a reply |
| POST `/api/koe/conversations/:id/copilot/summary` | member | Summarize a conversation |
| POST `/api/koe/conversations/:id/copilot/translate` | member | Translate in a conversation |
| GET `/api/koe/flows` | member | List bot flows |
| GET `/api/koe/flows/:id` | member | Get a bot flow |
| POST `/api/koe/flows` | member | Create a bot flow |
| PATCH `/api/koe/flows/:id` | member | Change a bot flow |
| DELETE `/api/koe/flows/:id` | member | Delete a bot flow |
| POST `/api/koe/flows/:id/test` | member | Try a bot flow |
| GET `/api/koe/config/pricing` | member | Message price table |
| PUT `/api/koe/config/pricing` | admin | Set the message price table |
| GET `/api/koe/campaigns` | member | List campaigns (`status`, `limit`, `offset`; `hasMore`) |
| GET `/api/koe/campaigns/:id` | member | Get a campaign |
| POST `/api/koe/campaigns` | member | Create a campaign draft |
| PATCH `/api/koe/campaigns/:id` | member | Change a campaign draft |
| DELETE `/api/koe/campaigns/:id` | member | Delete a campaign draft |
| POST `/api/koe/campaigns/:id/recipients` | member | Add recipients to a campaign |
| GET `/api/koe/campaigns/:id/estimate` | member | Estimate a campaign |
| POST `/api/koe/campaigns/:id/approve` | member | Approve a campaign |
| POST `/api/koe/campaigns/:id/schedule` | member | Schedule a campaign |
| POST `/api/koe/campaigns/:id/pause` | member | Pause a campaign |
| POST `/api/koe/campaigns/:id/resume` | member | Resume a campaign |
| POST `/api/koe/campaigns/:id/cancel` | member | Cancel a campaign |
| GET `/api/koe/campaigns/:id/stats` | member | Campaign results |
| GET `/api/koe/sequences` | member | List sequences |
| POST `/api/koe/sequences` | member | Create a sequence |
| PATCH `/api/koe/sequences/:id` | member | Change a sequence |
| DELETE `/api/koe/sequences/:id` | member | Delete a sequence |
| GET `/api/koe/conversations/:id/sequences` | member | Sequences of a conversation |
| POST `/api/koe/conversations/:id/sequences/:sequenceId` | member | Start a sequence in a conversation |
| DELETE `/api/koe/conversations/:id/sequences/:sequenceId` | member | Stop a sequence in a conversation |
| POST `/api/koe/conversations/:id/promises` | member | Record a payment promise |
| GET `/api/koe/conversations/:id/promises` | member | Payment promises of a contact (`limit` 1-200, `offset`; `hasMore`) |
| PATCH `/api/koe/promises/:id` | member | Mark a payment promise kept or cancelled |
| POST `/api/koe/conversations/:id/outcomes` | member | Record the outcome of an attempt |
| GET `/api/koe/conversations/:id/outcomes` | member | Outcomes of a conversation (`limit` 1-200, `offset`; `hasMore`) |
| GET `/api/koe/collections/portfolio` | member | Collections portfolio |
| GET `/api/koe/sales/pipeline` | member | Sales pipeline |
| GET `/api/koe/reports/summary` | member | Inbox dashboard |
| GET `/api/koe/inbox` | anyone | The live inbox (HTML) |
| GET `/api/koe/inbox/koe-inbox.js` | anyone | The inbox's script |
| GET `/api/koe/sw.js` | anyone | The inbox's service worker |
| GET `/api/koe/public/webchat/widget.js` | anyone | Embeddable web chat (JavaScript) |

## Who can do what

The policy is `koe.policy.ts` (resource `koe`); who sees which conversation is row-level security in
`migrations/0000_initial.sql`.

| Who | Can |
| --- | --- |
| Anonymous | The Meta webhook (signed), the web chat routes for active web chats, the inbox page, the service worker and the widget script. |
| Account not on koe | Nothing: 403 on every inbox route. |
| Agent (koe member) | Conversations assigned to them, of their teams, and unassigned ones without a team; their contacts; personal quick replies; notices and push of their own. |
| Supervisor | Every conversation; assign and reassign; teams, templates, flows, sequences, shared quick replies, campaigns, reports, block and merge contacts. |
| Admin (Kitsuden admin, or a koe member with role admin) | All of the above, plus channels and their credentials, members, the Meta verify token, pricing and the copilot agent. |
| Agent key | `koe:*` (or `kon:koe:*`) opens koe as an admin; one operation's fine scope (`kon:koe:send-message`) opens that operation as a member would. A key with no koe scope gets 403. A denial wins. |

A message an agent key sends goes out as the AI (`author ai`), which never writes in a conversation a person
has. Sensitive operations (connecting channels, members, templates, campaign approval, merges) may come back
`202 KITSUDEN_E_APPROVAL_REQUIRED` when human approval is on.

## Configuration

| Setting | Where | What |
| --- | --- | --- |
| `KITSUDEN_SECRETS_KEY` | API environment | Seals channel tokens, app secrets and the VAPID key. Required for Meta channels and web push. |
| `KOE_MEDIA_URL`, `KOE_MEDIA_TOKEN` | API environment | The media sidecar and its shared secret. |
| `KOE_MEDIA_TRANSCRIBE` | API environment | `true` to ask the sidecar for transcripts of voice notes (the bundled sidecar does not implement it yet). |
| `ALLOWED_ORIGINS` | API environment | Sites that embed the web chat widget. |
| Channel settings | `PATCH /api/koe/channels/:id` | Greeting, keywords (opt-out, opt-in, handoff), auto-resolve hours, pace, Graph API version, bot, flow, default team, reopen behaviour, allowed sites. |
| Teams | `/api/koe/teams` | Purpose (support, sales, collections), time zone, business hours, assignment (round robin, load, manual), SLAs. |
| Pricing | `PUT /api/koe/config/pricing` | Per-category, per-country prices for campaign estimates. Nothing is assumed when unset. |
| Copilot | `PUT /api/koe/config/copilot` | The core agent that drafts, summarizes and translates for people. |

## Agents and MCP

Every route except files, browser presence, the webhook and the browser assets is an MCP tool named
`koe__<operation>`. Two tool groups narrow what a model sees: `kon:koe/inbox` (read and answer conversations,
hand off, notes, templates, quick replies, copilot) and `kon:koe/supervisor` (assign, transfer, members,
teams, history).

Events for rules and other kons are declared in `koe.events.ts` (`koe:message.received`,
`koe:conversation.state_changed`, `koe:window.expiring`, `koe:sla.breached`, `koe:promise.broken`…). Rule
steps: `kon-koe:send-message`, `send-template`, `assign`, `set-state`, `add-label`, `add-note`,
`start-sequence`, `record-outcome`. Reports ship as `kon:kon-koe/<id>`.

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/kon-koe-core.test.ts` | The state machine and windows exhaustively, WhatsApp wire format, signatures, templates, and end to end: webhooks, row security, delivery, statuses, collisions, templates after 24 h, broken tokens, bot silence, opt-out, outbound start, web chat. |
| `tests/unit/kon-koe-channels.test.ts` | Messenger and Instagram: parsing, payloads, the human-agent tag, profiles. |
| `tests/unit/kon-koe-media.test.ts` | Downloads, uploads, voice notes, stickers, quick replies, visitor uploads. |
| `tests/unit/kon-koe-ai.test.ts` | The kon-chat relay, handoff, store context, copilot. |
| `tests/unit/kon-koe-automation.test.ts` | Flows, rule steps, campaigns, sequences, the sweep, collections, reports. |
| `tests/unit/kon-koe-extensions.test.ts` | The extension API: refusals at send and delivery, failing hooks, access events. |
| `tests/unit/kon-koe-web.test.ts` | The inbox page, service worker and widget routes. |
| `media-sidecar/media_test.go` | The converter with real ffmpeg (`docker build --target test media-sidecar`). |

```bash
pnpm vitest run tests/unit/kon-koe-core.test.ts
```

## License

MIT.

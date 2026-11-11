# kon-chat

Chatbots over the agents the Kitsuden core already runs: team bots that may use one tool group, and public
bots on a website that answer from what you teach them. For site admins who want a support or team
assistant without writing an agent loop.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| experimental | content | 1.0.2 | `/api/chat` | — (core `auth`; the core's agent engine; kon-ingest optional) |

A bot is a channel to one agent identity: the agent brings the model (whatever provider the core is
configured with), its prompt and its permissions; the bot adds who may talk to it, what it knows, which
tools it may touch, what it may spend and its limits.

## Install

```bash
kitsuden kon add chat --enable
```

Run it inside a Kitsuden project, then restart the API. The kon is off by default (`defaultEnabled: false`),
so pass `--enable` or switch it on in the admin panel (**Kons**).

- The core's agent engine (`ctx.agents`) must be available: without it every question answers 409 and the
  API logs at startup that bots cannot answer.
- For search by meaning the core needs an embeddings provider (`ctx.ai`); without one, knowledge is
  searched by shared words.
- pgvector is used when the database already has the extension; this kon never creates it.
- PDF, HTML and image attachments are read through kon-ingest, if it is installed next to this kon
  (`packages/kons/kon-ingest`). Without it those attachments answer 422.
- A public bot embedded on another site needs that site in the core's `ALLOWED_ORIGINS`.

## What it adds

- **Bots** (`chat_bots`): slug, name, agent identity, audience (`team` or `public`), tool group, greeting,
  members, allowed origins, limits, token prices and daily budget.
- **Knowledge** (`chat_documents`, `chat_chunks`): documents an admin teaches a bot, cut into chunks of about
  800 characters with a small overlap. A document with a `conversation_id` is an attachment that only its
  conversation searches.
- **Conversations** (`chat_conversations`): one per person (`user_id`) or per visitor (`visitor_key`, the
  SHA-256 hash of a random key the browser keeps; nothing else identifies a visitor).
- **Messages** (`chat_messages`): kept as parts (text, tools called with their input and whether they
  worked, approvals waited for, sources), with tokens, cost and the rating people gave.

Two kinds of question:

- **Text you give it** ("how do refunds work?"): searched before each answer, by meaning when the core has
  embeddings (in SQL where the database has pgvector), by shared words otherwise. Each answer lists the
  documents it used. Text found in documents reaches the model marked as reference material.
- **Live data** ("what stage is the Acme deal in?"): never copied into the bot. A team bot reads it with a
  tool group such as `kon:crm/assistant`, with its agent's access, at the moment of asking.

| | Team bot | Public bot |
| --- | --- | --- |
| Who | Signed-in admins and editors, or only its `members` | Anyone on a website |
| Where | The `/api/chat/bots/:slug/...` routes, from an app built on top | The widget: `<script src=".../api/chat/public/widget.js" data-bot="help" defer></script>` |
| Tools | One tool group (`toolset`), within its agent's `allowedTools`; none without it | Never |
| Limits | Per person per day, the bot's daily messages and budget | Per visitor per hour, the bot's daily messages and budget, 30 requests a minute per connection |

Runs go through the core's agent engine with memory and brain notes off and without caching: one agent
serves many people here, and one must never read what another said.

Streaming: the `/chat/stream` routes answer in the AI SDK's UI message stream protocol (server-sent events,
header `x-vercel-ai-ui-message-stream: v1`), so `useChat` reads it without an adapter. Text arrives as the
model writes it, tool calls as `tool-input-available`/`tool-output-available`, a tool held for a person as
`tool-approval-request` with the proposal id, documents as `source-document`, and a `data-chat` part carries
`conversationId` and `messageId`. The widget reads the same stream by hand.

Conversations: `regenerate: true` answers the last question again and replaces its answer; a fork starts a
new conversation with the messages up to one of them (editing a question is a fork before it plus the new
question). At most 5 attachments per conversation, 200,000 characters of text each. Ratings are `1` or `-1`
with an optional comment, by whoever had the conversation; a new rating replaces the old one.

Spending: each bot has prices per million input and output tokens. Every answer stores its tokens and cost;
`dailyBudgetUsd` stops the bot for the day once spent.

## HTTP API

Admin (configure):

| Method and path | What it does |
| --- | --- |
| `GET /api/chat/bots` | Every bot with its settings. |
| `POST /api/chat/bots` | Create a bot. 409 if the slug is taken; 422 for a public bot with `toolset` or `members`. |
| `PATCH /api/chat/bots/:id` | Change any setting. Same rules; 404 if missing. |
| `DELETE /api/chat/bots/:id` | Delete a bot with its knowledge, conversations and messages. |
| `GET /api/chat/bots/:id/knowledge` | Its documents (not attachments), with chunk counts and whether they have embeddings. |
| `POST /api/chat/bots/:id/knowledge` | Teach it a document (`title`, `content`). 400 past 5,000 chunks per bot without pgvector. |
| `DELETE /api/chat/knowledge/:id` | Forget a document and its chunks. |
| `GET /api/chat/bots/:id/conversations` | Its latest 200 conversations, newest first. |
| `GET /api/chat/bots/:id/usage` | Per day for `days` (default 30, max 365): questions, tokens, cost, ratings; plus the last 24 hours against the limits. |
| `GET /api/chat/bots/:id/feedback` | Rated answers with the question before each; `rating=up` or `rating=down`. |

Team (use):

| Method and path | What it does |
| --- | --- |
| `GET /api/chat/conversations/:id` | A conversation with its messages as parts. Yours, or any for an admin; 404 otherwise. |
| `POST /api/chat/bots/:slug/chat` | Ask a team bot: `reply`, `parts`, `pendingApprovals`, `costUsd`. `conversationId` continues one of yours. |
| `POST /api/chat/bots/:slug/chat/stream` | The same, streamed. |
| `POST /api/chat/bots/:slug/attachments` | Attach a file to a conversation (or start one with it). |
| `POST /api/chat/conversations/:id/fork` | Branch a conversation at `fromMessageId`. |
| `POST /api/chat/messages/:id/feedback` | Rate an answer in one of your conversations. |

Public (no session; `visitorId` of 20 to 200 characters in every body):

| Method and path | What it does |
| --- | --- |
| `GET /api/chat/public/bots/:slug` | Name and greeting, for the widget. |
| `POST /api/chat/public/bots/:slug/chat` | Ask a public bot: `conversationId`, `messageId`, `reply` and source titles only. |
| `POST /api/chat/public/bots/:slug/chat/stream` | The same, streamed. |
| `POST /api/chat/public/bots/:slug/attachments` | Attach a file to the visitor's conversation. |
| `POST /api/chat/public/bots/:slug/conversations/:id/fork` | Branch the visitor's conversation. |
| `POST /api/chat/public/bots/:slug/messages/:id/feedback` | Rate an answer in the visitor's conversation. |
| `GET /api/chat/public/widget.js` | The embeddable widget script. |

Errors to expect: 404 for an unknown, inactive or wrong-audience bot (and for a team bot you are not a
member of); 403 when a public bot's `allowedOrigins` does not list the request's `Origin`; 429 past a daily
or hourly limit or the budget; 409 without an agent engine.

## Who can do what

The policy is `chat.policy.ts` (resource `chat`):

| Role | Can |
| --- | --- |
| Anonymous | The public routes, for active public bots only. |
| Plain account | The public routes. 403 on team and admin routes. |
| Editor | `use`: talk to team bots (unless a bot lists `members` without them), read and rate their own conversations. |
| Admin | `use` and `configure`: everything above, plus set bots up and read every conversation. |
| Agent | Through scopes; see below. |

Row security (`migrations/0001_agents_in_rls.sql`): bots are written by admins and read by the team;
documents and chunks are admin-only; a person reads only their own conversations and messages, an admin
reads all. "Admin" and "team" in those policies are the core's effective ones: the human role, or an agent
whose key opens the whole kon (`chat:*`, `kon:chat:*` or `admin`). `migrations/0002_fine_scopes_in_rls.sql`
also lets in an agent whose key grants the admin operation that needs the table: `chat:configure` for all of
them, or one operation's fine scope (`kon:chat:list-chatbots` reads bots, `kon:chat:add-chatbot-knowledge`
writes documents and chunks, and so on). Conversations and messages are written by the system, after the
route has authorized the speaker.

What answers 404 instead of 403: a team bot you may not use, a conversation or answer that is not yours, and
a public bot reached from a team route (or the reverse).

## Configuration

Per bot, through the API or the **Chatbots** admin view: `dailyLimit` (default 500), `userDailyLimit`
(default 200), `visitorHourlyLimit` (default 30), `priceInPerMillion`, `priceOutPerMillion`,
`dailyBudgetUsd`, `allowedOrigins`, `members`, `toolset`, `greeting`, `active`.

The kon reads no environment variables of its own. It uses the core's agent engine and embeddings, and the
core's `ALLOWED_ORIGINS` decides which sites a browser may call the API from.

## Agents and MCP

Agents do not chat with bots over MCP: they have the tools directly. The chat, stream, attachment, fork,
rating and public routes are excluded from MCP. The configuration and oversight operations are tools:

| MCP tool | Fine scope | Writes |
| --- | --- | --- |
| `chat__list-chatbots` | `kon:chat:list-chatbots` | no |
| `chat__create-chatbot` | `kon:chat:create-chatbot` | yes (sensitive) |
| `chat__update-chatbot` | `kon:chat:update-chatbot` | yes (sensitive) |
| `chat__delete-chatbot` | `kon:chat:delete-chatbot` | yes (sensitive, DELETE) |
| `chat__list-chatbot-knowledge` | `kon:chat:list-chatbot-knowledge` | no |
| `chat__add-chatbot-knowledge` | `kon:chat:add-chatbot-knowledge` | yes (sensitive) |
| `chat__delete-chatbot-knowledge` | `kon:chat:delete-chatbot-knowledge` | yes (sensitive, DELETE) |
| `chat__list-chatbot-conversations` | `kon:chat:list-chatbot-conversations` | no |
| `chat__get-chatbot-usage` | `kon:chat:get-chatbot-usage` | no |
| `chat__list-chatbot-feedback` | `kon:chat:list-chatbot-feedback` | no |
| `chat__get-chat-conversation` | `kon:chat:get-chat-conversation` | no |

Sensitive writes may come back `202 KITSUDEN_E_APPROVAL_REQUIRED` when an admin turns on human approval.
An agent may hold `chat:*` (or `kon:chat:*`) for everything, `chat:configure` for every admin operation, or
the fine scope of each operation it needs: the route and the row security accept the same scopes.
`get-chat-conversation` returns the caller's own conversations only (an agent has none) unless the key opens
the whole kon. Details in [AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/kon-chat.test.ts` | Setting bots up, public and team turns, streaming, approvals, regenerate, fork, attachments, usage, budget, the widget. |
| `tests/unit/kon-chat-routes.test.ts` | Who reaches which route (accounts, agents, denials), validation, limits, ownership of conversations, attachments and ratings. |

```bash
pnpm vitest run tests/unit/kon-chat.test.ts
pnpm vitest run tests/unit/kon-chat-routes.test.ts
```

## License

MIT.

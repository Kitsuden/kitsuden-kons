# kon-inbox

A person's mailbox and calendar (Gmail and Google Calendar, or Microsoft 365), synced from an
account they connected in kon-connections. Each message and meeting is matched to CRM contacts by
email: kon-crm listens and puts them on the contact's timeline. The owner decides which mailboxes
are read and who sees each thread.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | business | 0.1.0 | `/api/inbox` | `kon-connections` (core: `auth`); `kon-crm` optional |

## Install

```bash
kitsuden kon add connections inbox --enable
```

Restart the API afterwards. The person connects their Google or Microsoft account in
kon-connections asking for `mail.read` and `calendar.read` (and `mail.send` to send), then adds it
here.

## What it adds

| Table | What it holds |
| --- | --- |
| `inbox_mailboxes` | A mailbox its owner added: the connection it reads through, what it syncs, default visibility, cursors, last sync. |
| `inbox_threads` | One thread: subject, visibility (`private` or `team`), message count, last message. |
| `inbox_messages` | One message: direction, sender, recipients, subject, the provider's short preview, date. Never a body or an attachment. |
| `inbox_events` | One calendar event: title, place, start and end, attendees, organizer, cancelled. |

Sync runs on Kitsuden's queue (`kon-inbox` / `sync`), one mailbox per job and a bounded step per
job; a mailbox not synced for five minutes is queued again. Gmail reads `history` from a
`historyId`, Google Calendar uses a `syncToken`, Microsoft uses Graph delta links; an expired cursor
starts over.

Events, after the sync's transaction commits:

| Event | Payload |
| --- | --- |
| `inbox:message.received` | `messageId`, `mailboxId`, `ownerId`, `from`, `to`, `cc`, `subject`, `direction`, `at`, `mailboxAddresses` |
| `inbox:event.synced` | `eventId`, `mailboxId`, `ownerId`, `title`, `startsAt`, `endsAt`, `attendees`, `organizer`, `cancelled`, `mailboxAddresses` |

It listens to `connections:connection.revoked` (deletes the connection's mailboxes and everything
synced from them) and `connections:connection.expired` (marks them in error).

## HTTP API

| Route | Who | What |
| --- | --- | --- |
| `GET /api/inbox/mailboxes` | the owner | Your mailboxes. |
| `POST /api/inbox/mailboxes` | a person | Start syncing one of your connections (mail, calendar or both). |
| `PATCH /api/inbox/mailboxes/:id` | the owner | What it syncs, default visibility, pause or resume. |
| `DELETE /api/inbox/mailboxes/:id` | the owner | Stop and delete everything it brought, and the CRM's links to it. |
| `POST /api/inbox/mailboxes/:id/sync` | the owner | Sync now. |
| `POST /api/inbox/mailboxes/:id/send` | the owner | Send a plain-text email from the mailbox (needs `mail.send`). |
| `GET /api/inbox/threads` | the owner; admins and editors for `team` threads | Threads, newest first. |
| `GET /api/inbox/threads/:id` | the same | A thread and its messages. |
| `PATCH /api/inbox/threads/:id` | the owner | `visibility`: `private` or `team`. |
| `GET /api/inbox/events` | the owner; admins and editors for `team` events | Calendar events in a date range. |

## Who can do what

- Only a mailbox's owner adds, changes, syncs, sends from or removes it. A mailbox is never read
  until its owner adds it, and only from their own connection.
- Admins and editors READ threads, messages and events their owner marked `team`. They never see a
  `private` thread nor a mailbox's settings. Row security enforces it.
- An agent cannot add a mailbox (403). It can read and sync as the person it acts for; sending is
  `sensitive`, so an agent's send becomes a proposal for a person.

## Configuration

Nothing of its own: the provider credentials and OAuth clients are kon-connections'. The first sync
reads `backfillDays` back (30, at most 365), set per mailbox.

## Agents and MCP

Each route is an MCP tool `inbox__<operation id>`. Notes for agents: [AGENTS.md](AGENTS.md).

## Tests

```bash
pnpm vitest run tests/unit/kon-inbox.test.ts
```

kon-connections, kon-inbox and kon-crm together on PGlite as a non-superuser role, with a provider
double for Gmail, Google Calendar and Microsoft Graph.

## License

MIT

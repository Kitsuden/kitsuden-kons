# AGENTS.md — kon-inbox

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

A person's mailbox and calendar synced through kon-connections, metadata only (sender,
recipients, subject, preview, dates). kon-crm links each message and meeting to the contacts on it.

## Calling it

- `inbox__list-mailboxes`, `inbox__list-threads`, `inbox__get-thread`, `inbox__list-events`: what
  the person you act for may read.
- `inbox__sync-mailbox`: queues a sync now.
- `inbox__send-mail`: sends as the person. It is `sensitive`: expect
  `202 KITSUDEN_E_APPROVAL_REQUIRED`, report the proposal and do not retry.
- `inbox__add-mailbox` answers 403 to an agent: tell the person to add it.
- 404 means not theirs (or not shared with the team). It never says which.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | Operations, `runSync` (fetch, then store in one transaction), the queue handler and timer, listeners for kon-connections, the kon definition. |
| `inbox.sources.ts` | Gmail, Google Calendar and Microsoft Graph: incremental reads, sending, address parsing, MIME. |
| `inbox.sync.ts` | `fetchChanges` (network) and `storeChanges` (database, announces new items). |
| `inbox.schema.ts` | Tables and `publicMailbox`. |
| `inbox.policy.ts` | Policy `inbox`. |
| `operations.ts` | `KON_ID`, the registry, the `OWN` and `SEND` permissions. |
| `migrations/0001_inbox.sql` | Tables and row security. |

## Rules that must hold

- Never store a message body or an attachment, and never request one (`format=metadata`,
  `$select` without `body`).
- No database transaction is open while the provider is called: fetch first, store after.
- A message is announced once: only rows the insert created are announced.
- A mailbox is read only after its owner adds it, and only through their own connection.
- Removing a mailbox or revoking its connection deletes everything synced from it and the links
  to it.
- A header value never carries a line break (`buildMime`).

## Changing it

- A new provider: a `MailSource` in `inbox.sources.ts`, registered in `SOURCES`, and its hosts in
  kon-connections' catalog.
- A new route: add it to `authorization-matrix.kons.json` and to the README.

## Tests

`tests/unit/kon-inbox.test.ts`, with kon-connections and kon-crm installed in the same database.

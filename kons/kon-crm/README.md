# kon-crm

A CRM backend for Kitsuden: companies, contacts, pipelines and deals, activities and tasks, lead
capture, a client portal, contact scoring, evidence-weighted data from agents, each person's mailbox and
calendar synced into the contacts' timeline, and billing through kon-conta. For a team that wants its client portfolio behind an API that people and agents share
under the same rules. The screens people work in belong to the app built on top; the kon's two
admin views are configuration only.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | business | 1.2.0 | `/api/crm` | kon-media; core `auth` (kon-conta optional, for billing) |

## Install

Inside a Kitsuden project:

```bash
kitsuden kon add crm
```

Kitsuden switches kon-crm on by itself the first time it is installed (it is in the core's list of
kons most businesses want), so `--enable` is not needed. Restart the API. `kon.json` lists
`kon-media` as a required kon; it ships with the Kitsuden core, so nothing else is installed. For
the billing routes install kon-conta too (`kitsuden kon add conta --enable`); without it they
answer 409.

Environment variables are needed only to receive email into the CRM (see
[Configuration](#configuration)).

## What it adds

| Table | What it holds |
| --- | --- |
| `crm_companies`, `crm_contacts` | Accounts and people, with custom fields, lead score and its reasons |
| `crm_pipelines`, `crm_pipeline_stages` | Pipelines and their stages, with entry requirements and enter/exit actions |
| `crm_deals` | Opportunities, with status (`open`, `won`, `lost`, `paused`), `lost_reason` and `lost_notes` |
| `crm_deal_contacts` | Several contacts per deal, with roles |
| `crm_stage_transitions` | Every stage move, for history and cycle times |
| `crm_activities` | Calls, emails, meetings, tasks, notes; tasks can be completed and reopened |
| `crm_entity_configs` | The business's entities (a deal may be a "matter" or an "order") with custom fields |
| `crm_documents`, `crm_document_templates` | Document records on deals; templates filled from a deal |
| `crm_saved_views` | Saved filters |
| `crm_access_grants` | How much of the CRM a person or agent may read |
| `crm_suppressions` | Exclusion list of emails and domains |
| `crm_merge_requests` | Merges agents asked for, waiting for a person |
| `crm_score_models` | Versioned scoring rules and guide |
| `crm_capture_forms`, `crm_portal_links` | Public capture forms; hashed, expiring client portal links |
| `crm_counters` | Deal numbering per entity |
| `crm_evidence_kinds`, `crm_evidence_policy`, `crm_observations` | Evidence kinds and their weights; observed values about contacts and companies |
| `crm_inbound_emails` | Every email posted to the CRM and what happened to it |
| `crm_inbox_mailboxes` | A mailbox its owner added: the connection it reads through, what it syncs, default visibility, cursors, last sync |
| `crm_inbox_threads`, `crm_inbox_messages` | Synced threads and messages: direction, sender and display name, recipients, subject, the provider's short preview, date, visibility (`private` or `team`). Never a body or an attachment |
| `crm_inbox_events` | Synced calendar events: title, place, start and end, attendees, organizer, cancelled, visibility |

What the code does with them:

- **Presets.** A JSON file in `presets/` sets up an entity with fields, a pipeline, deal roles,
  document templates and kon-conta's words. Two ship with the kon: `presets/law-firm.json`
  (numbered matters, KYC, hearings) and `presets/real-estate.json` (sales and rentals as numbered
  operations tied to a listing, buyer and tenant requirements, visits and signings; the
  properties themselves live in kon-listings). An installation adds its own in the folder named
  by `CRM_PRESETS_DIR`; one with the id of a shipped preset replaces it. A broken file is skipped
  and listed in `problems` by `GET /api/crm/presets`, so it never hides the others.
- **Presets bring their automation.** Each stage of a preset can say what happens when a deal
  enters or leaves it (`onEnterActions`, `onExitActions`: a task or a meeting due in N days, an
  activity, logged time, a field), what a deal needs before it may enter (`entryRequirements`)
  and how many days it should stay (`estimatedDays`), so the CRM works the day it is set up. Both
  shipped presets do: the law firm asks for the practice area and the fee type before a matter is
  in progress, and the agency asks for the listing before a visit. Applying a preset again fills a
  stage the team never configured and leaves the ones they did. An action that `move-deal` could
  not run (a field a stage may not change, a field the preset does not define, time without a
  quantity) makes the file a problem when it is read, not a failure on a deal later.

  ```json
  {
    "name": "In progress",
    "probability": 50,
    "estimatedDays": 120,
    "entryRequirements": { "requiredFields": ["practiceArea", "feeType"] },
    "onEnterActions": [
      { "type": "create_calendar_event", "title": "Kick-off meeting with the client", "value": 5 },
      {
        "type": "create_task",
        "title": "Agree the success fee in writing",
        "value": 3,
        "condition": { "field": "custom.feeType", "operator": "==", "value": "success" }
      }
    ]
  }
  ```
- **Access dials.** Per person or agent: `records` (all, or assigned/created; applied by row
  security), `sensitive`, `money` and `notes`. By default the team sees all records, amounts and
  notes, not sensitive data; an agent sees the same without notes. `crm:read-all` or a grant made
  by a person opens everything. Hidden values are removed from every response, REST or MCP.
- **Intake.** `capture-lead`, public forms, CSV import with a preview, the exclusion list and
  duplicate detection. Nothing is merged automatically: duplicates need two signals (email 90,
  phone 45, name 40, company 10; threshold 85), the oldest contact survives, and differing values
  are returned as conflicts. An agent only asks for a merge; a person decides.
- **Stage automation.** `onEnterActions` and `onExitActions` run on `move-deal` (tasks,
  activities, calendar events, field changes). A failed action leaves a note and does not undo the
  move.
- **Score.** Rules plus a Markdown guide, versioned; a contact's score is the sum of the points of
  the rules that hold, 0 to 100, with its reasons kept.
- **Observed data.** `record-observation` takes a field, a value, a source and an evidence kind,
  never a confidence. Weights of different sources that saw the same value add up; at `applyAt`
  the value is written. Otherwise, or against a value a person typed or rejected, it waits as a
  suggestion only a person accepts or rejects.
- **Email into the CRM.** A provider posts Bcc'd or forwarded mail to
  `/api/crm/public/inbound/<provider>`; each known contact on it gets an `email` activity. It never
  creates contacts.
- **Client portal.** A token shows a contact only what was marked for them: stages of
  `portalVisible` deals, `portal` fields, shared activities and documents, and the kon-conta
  statement if the link was made with `showStatement`. Never notes, amounts or sensitive fields.
- **Events**, emitted after commit with ids only: `crm:deal:created`, `crm:deal:stage-changed`,
  `crm:deal:status-changed`, `crm:contact:created`, `crm:email:received`,
  `crm:observation:suggested`, `crm:observation:applied` (`crm.events.ts`).

## HTTP API

All routes except `/api/crm/public/*` need a session and pass the host's staff gate. "view" and
"edit" = the CRM team (admin or editor account, or an agent, see below); "delete" and "configure" =
admin. "Person" = refused to agents whatever their scopes.

Paging: lists of records take `limit` and `offset`. Since 1.2.0, `deals/:id/documents` returns every
row unless `limit` (1-500) asks for a page, and the exclusion list (up to 1000 per page), targets
and portal links (500), merge requests (200) and score model versions (50) come a page at a time,
that cap being the default `limit`. The work queue, observations, inbound emails and the inbox's
threads and events kept their `limit` and gained `offset`. Each answers `hasMore` when rows follow
the page.

### Records

| Route | Needs | What it does |
| --- | --- | --- |
| `GET /api/crm/companies` | view | List companies (search, `cf.<key>` filters) |
| `POST /api/crm/companies` | edit | Create a company |
| `GET /api/crm/companies/:id` | view | Read a company |
| `PATCH /api/crm/companies/:id` | edit | Update a company |
| `DELETE /api/crm/companies/:id` | delete | Delete a company |
| `GET /api/crm/contacts` | view | List contacts |
| `POST /api/crm/contacts` | edit | Create a contact |
| `GET /api/crm/contacts/:id` | view | Read a contact |
| `PATCH /api/crm/contacts/:id` | edit | Update a contact |
| `DELETE /api/crm/contacts/:id` | delete | Delete a contact |
| `POST /api/crm/contacts/import` | edit | Import a CSV: preview without `apply`, write with `apply: true` (5000 rows max) |
| `GET /api/crm/timeline` | view | One contact (with its deals) or one deal, newest first: activities, stage moves, and what other kons linked (orders, payments, newsletter, mail, meetings) |
| `GET /api/crm/deals/:id/lines` | view | A deal's product lines and totals |
| `POST /api/crm/deals/:id/lines` | edit | Add a line: price frozen when added; product by shape (`productType` + `productId`) |
| `PATCH /api/crm/deal-lines/:id` | edit | Quantity, discount, tax or name (never the frozen price) |
| `DELETE /api/crm/deal-lines/:id` | edit | Remove a line; the deal's value follows its lines |
| `GET /api/crm/deals/:id/quotes` | view | A deal's quotes |
| `POST /api/crm/deals/:id/quotes` | edit | A draft quote: a numbered snapshot of the deal's lines |
| `GET /api/crm/quotes/:id` | view | One quote |
| `POST /api/crm/quotes/:id/send` | edit | draft → sent |
| `POST /api/crm/quotes/:id/reject` | edit | sent → rejected |
| `POST /api/crm/quotes/:id/accept` | edit | → accepted; `then: payment` opens a kon-payments payment, `then: order` asks kon-ecommerce for an order |
| `GET /api/crm/forecast` | view | Per person and period: open, weighted, won, target, attainment |
| `GET /api/crm/targets` | view | Sales targets; `limit` (1-500, default 500), `offset`, `hasMore` |
| `PUT /api/crm/targets` | configure | Set a person's target for a period |
| `GET /api/crm/reports/:id` | view | `funnel`, `stage-conversion`, `lost-reasons` |
| `GET /api/crm/contacts/:id/duplicates` | view | Possible duplicates with score and reasons |
| `POST /api/crm/contacts/:id/merge` | edit; runs for a person with delete | Merge two contacts; from an agent, a 202 request for a person |
| `GET /api/crm/merge-requests` | view | Merges agents asked for; `limit` (1-200, default 200), `offset`, `hasMore` |
| `POST /api/crm/merge-requests/:id/decision` | delete, person | Approve or reject a requested merge |
| `POST /api/crm/capture` | edit | Bring a lead in (contact, activity, optional deal); `dryRun` returns the plan |
| `GET /api/crm/suppressions` | view | The exclusion list, newest first; `limit` (1-1000, default 1000), `offset`, `hasMore` |
| `POST /api/crm/suppressions` | edit | Exclude an email or domain |
| `DELETE /api/crm/suppressions/:kind/:value` | delete | Take an entry off the list |
| `POST /api/crm/contacts/:id/score` | edit | Calculate one contact's score |
| `POST /api/crm/scores/recalculate` | edit | Recalculate scores a page at a time (`limit`, `after`) |

### Pipelines and deals

| Route | Needs | What it does |
| --- | --- | --- |
| `GET /api/crm/pipelines` | view | List pipelines |
| `POST /api/crm/pipelines` | configure | Create a pipeline |
| `GET /api/crm/pipelines/:id` | view | A pipeline with its stages |
| `PATCH /api/crm/pipelines/:id` | configure | Update a pipeline |
| `DELETE /api/crm/pipelines/:id` | configure | Delete a pipeline |
| `POST /api/crm/pipelines/:id/stages` | configure | Add a stage |
| `PATCH /api/crm/stages/:id` | configure | Update a stage |
| `DELETE /api/crm/stages/:id` | configure | Delete a stage |
| `PATCH /api/crm/pipeline-stages/:id/config` | configure | A stage's requirements and actions |
| `GET /api/crm/pipelines/:id/kanban` | view | The pipeline as a board |
| `GET /api/crm/deals` | view | List deals (search by title, contact or company; `cf.<key>` filters) |
| `GET /api/crm/deal-counts` | view | Count deals grouped by stage, status, assignee or a custom field |
| `POST /api/crm/deals` | edit | Create a deal (takes the entity's fields and next number) |
| `GET /api/crm/deals/:id` | view | Read a deal |
| `PATCH /api/crm/deals/:id` | edit | Update a deal |
| `DELETE /api/crm/deals/:id` | delete | Delete a deal |
| `POST /api/crm/deals/reorder` | edit | Reorder deals within their stages |
| `POST /api/crm/deals/:id/validate-move` | edit | Check a stage's entry requirements without moving |
| `POST /api/crm/deals/:id/move` | edit | Move to a stage of the same pipeline; `skipValidation` is admin only |
| `GET /api/crm/deals/:id/timeline` | view | A deal's stage history |
| `GET /api/crm/analytics/cycle-time` | view | Cycle times of a pipeline's stages |
| `GET /api/crm/deals/:id/contacts` | view | People on a deal and their roles |
| `POST /api/crm/deals/:id/contacts` | edit | Add a person to a deal |
| `DELETE /api/crm/deals/:id/contacts/:contactId` | edit | Take a person off a deal |
| `GET /api/crm/entity-configs` | view | The business's entities and fields |
| `POST /api/crm/entity-configs` | configure | Create an entity |
| `PATCH /api/crm/entity-configs/:id` | configure | Update an entity |
| `GET /api/crm/stats` | view | Dashboard stats |

### Work, documents and views

| Route | Needs | What it does |
| --- | --- | --- |
| `GET /api/crm/activities` | view | List activities |
| `POST /api/crm/activities` | edit | Log an activity |
| `GET /api/crm/activities/:id` | view | Read an activity |
| `PATCH /api/crm/activities/:id` | edit | Update an activity |
| `POST /api/crm/activities/:id/complete` | edit | Complete a task |
| `POST /api/crm/activities/:id/reopen` | edit | Reopen a completed task |
| `DELETE /api/crm/activities/:id` | edit; its author or admin | Delete an activity |
| `GET /api/crm/activity-kinds` | view | The activity kinds this installation uses |
| `GET /api/crm/work` | view | Tasks to do, with due-date status; `include=deal`; `limit` (1-200, default 100), `offset`, `hasMore` |
| `GET /api/crm/work/summary` | view | Counts of tasks to do |
| `GET /api/crm/agenda` | view | Dated work between two days, by type, `kind` and deal |
| `GET /api/crm/documents` | view | Documents across deals |
| `GET /api/crm/deals/:id/documents` | view | A deal's documents; optional `limit` (1-500), `offset`, `hasMore` |
| `POST /api/crm/documents` | edit | Attach a document record to a deal |
| `PATCH /api/crm/documents/:id` | edit | Change a document's details |
| `DELETE /api/crm/documents/:id` | edit; its uploader or admin | Delete a document record |
| `GET /api/crm/document-templates` | view | List document templates |
| `POST /api/crm/document-templates` | configure | Create a template |
| `PUT /api/crm/document-templates/:id` | configure | Change a template |
| `POST /api/crm/document-templates/:id/render` | view | Fill a template from a deal |
| `GET /api/crm/views` | view | Saved views |
| `POST /api/crm/views` | edit | Save a view |
| `DELETE /api/crm/views/:id` | edit | Delete a saved view |

### Billing (kon-conta)

| Route | Needs | What it does |
| --- | --- | --- |
| `POST /api/crm/deals/:id/project` | edit | Open or refresh the deal's project in kon-conta |
| `POST /api/crm/contacts/:id/billing-client` | edit | Make a contact a kon-conta client |
| `POST /api/crm/companies/:id/billing-client` | edit | Make a company a kon-conta client |
| `POST /api/crm/deals/:id/work` | edit | Log billable work on the deal (quantity at the resource's rate) |
| `POST /api/crm/deals/:id/expenses` | edit | Record an expense on the deal |

### Settings, access and agents

| Route | Needs | What it does |
| --- | --- | --- |
| `GET /api/crm/access/me` | view | What the caller can read (the four dials) |
| `GET /api/crm/access` | configure | List access grants |
| `PUT /api/crm/access/:subjectType/:subjectId` | configure, person, not on yourself | Set someone's access, with a reason and optional end date |
| `DELETE /api/crm/access/:subjectType/:subjectId` | configure | Return someone to the default access |
| `GET /api/crm/score-model` | view | The score model |
| `PUT /api/crm/score-model` | configure | Save a new version of the score model |
| `GET /api/crm/score-model/versions` | view | Earlier versions; `limit` (1-50, default 50), `offset`, `hasMore` |
| `GET /api/crm/evidence-policy` | view | Evidence kinds and their weights |
| `PUT /api/crm/evidence-policy` | configure | Change the weights |
| `POST /api/crm/observations` | edit | Record an observed value about a contact or company |
| `GET /api/crm/observations` | view | List observations, newest first; `limit` (1-200, default 100), `offset`, `hasMore` |
| `POST /api/crm/observations/:id/accept` | edit, person | Accept a suggested value |
| `POST /api/crm/observations/:id/reject` | edit, person | Reject a suggested value |
| `GET /api/crm/presets` | view | Ready-made setups |
| `POST /api/crm/presets/:id/apply` | configure | Apply a preset |
| `GET /api/crm/capture-forms` | configure | List public capture forms |
| `POST /api/crm/capture-forms` | configure | Create a form |
| `PATCH /api/crm/capture-forms/:id` | configure | Change a form |
| `DELETE /api/crm/capture-forms/:id` | configure | Delete a form |
| `GET /api/crm/portal-links` | edit | List portal links; `limit` (1-500, default 500), `offset`, `hasMore` |
| `POST /api/crm/portal-links` | edit, person | Give a contact a portal link (token shown once; `days`, `showStatement`) |
| `DELETE /api/crm/portal-links/:id` | edit | Revoke a portal link |
| `GET /api/crm/contacts/:id/portal-preview` | edit | What a contact's portal shows, without a link |
| `GET /api/crm/inbound-emails` | configure | Emails posted to the CRM and why any was turned away; `limit` (1-500, default 100), `offset`, `hasMore` |
| `GET /api/crm/agent-guide` | view | `AGENT_GUIDE.md` plus this installation's entities, fields, kinds, the caller's access and the tool groups |

### Inbox (each person's own; no CRM access needed)

| Route | Needs | What it does |
| --- | --- | --- |
| `GET /api/crm/inbox/mailboxes` | the owner | Your mailboxes |
| `POST /api/crm/inbox/mailboxes` | a person | Start syncing one of your connections (mail, calendar or both) |
| `PATCH /api/crm/inbox/mailboxes/:id` | the owner | What it syncs, default visibility, pause or resume |
| `DELETE /api/crm/inbox/mailboxes/:id` | the owner | Stop and delete everything it brought, and its links to contacts |
| `POST /api/crm/inbox/mailboxes/:id/sync` | the owner | Sync now |
| `POST /api/crm/inbox/mailboxes/:id/send` | the owner, sensitive | Send a plain-text email from the mailbox (the connection needs `mail.send`) |
| `GET /api/crm/inbox/threads` | the owner; admins and editors for `team` threads | Threads, newest first; `limit` (1-200, default 50), `offset`, `hasMore` |
| `GET /api/crm/inbox/threads/:id` | the same | A thread and its messages |
| `PATCH /api/crm/inbox/threads/:id` | the owner | `visibility`: `private` or `team` |
| `GET /api/crm/inbox/events` | the owner; admins and editors for `team` events | Calendar events in a date range, soonest first; `limit` (1-500, default 200), `offset`, `hasMore` |

### Public (no account; rate limited)

| Route | Needs | What it does |
| --- | --- | --- |
| `POST /api/crm/public/forms/:id` | public, 20/min | Submit a capture form; always 202 `{ ok: true }` once the form exists |
| `POST /api/crm/public/portal` | public, 20/min | Read a client portal with its token; unknown, expired or revoked are all 404 |
| `POST /api/crm/public/inbound/:provider` | provider signature, 300/min | Receive an email from `mailgun`, `postmark` or `generic` |

## The inbox

Each person connects their Google or Microsoft account in Kitsuden (`/api/connections/oauth/start`,
asking for `mail.read` and `calendar.read`, and `mail.send` to send) and adds it with
`POST /api/crm/inbox/mailboxes`. Nothing is read before that. The credential stays in Kitsuden's
connections; the CRM never sees it.

- **Sync** runs on Kitsuden's queue (`kon-crm:inbox` / `sync`), one mailbox per job and a bounded
  step per job; a mailbox not synced for five minutes is queued again. Gmail reads `history`, Google
  Calendar a `syncToken`, Microsoft Graph delta links; an expired cursor starts over.
- **What is kept**: sender, recipients, subject, the provider's short preview and dates. Never a body
  or an attachment.
- **Who sees it**: its owner. A thread (or the whole mailbox, by default) marked `team` is also read
  by admins and editors. Row security enforces it (`migrations/0015_inbox.sql`).
- **On the contacts**: each message and meeting is linked (`about`) to the contacts on it; mail never
  creates a contact. The timeline reads each one again as the reader: a message they may not read
  shows only that there was an email and when, with `private: true`, never its subject. The link
  itself only holds the subject of a `team` thread.
- **As evidence**: a message from a contact suggests the name they write under (`"Ruiz, Ana"` is Ana
  Ruiz) and, for a company address, the company's domain, as observations of kind `mail-header`
  (weight 10, source `mail`). That is far under `applyAt`, so it waits for a person; display names
  that are not a person ("Billing", "ACME Support", all capitals) and free mail domains say nothing.
  No subject, preview, recipient or mailbox goes into an observation.
- **Deleting**: removing a mailbox, or revoking its connection in Kitsuden, deletes everything it
  brought and its links. An expired connection marks the mailbox in error.

Events, after the sync's transaction commits: `crm:message.received` (`messageId`, `mailboxId`,
`ownerId`, `from`, `fromName`, `visibility`, `to`, `cc`, `subject`, `direction`, `at`,
`mailboxAddresses`) and `crm:meeting.synced` (`eventId`, `visibility`, `mailboxId`, `ownerId`,
`title`, `startsAt`, `endsAt`, `attendees`, `organizer`, `cancelled`, `mailboxAddresses`).

## Who can do what

The policy is `crm.policy.ts` (resources `crm` and `crm-authorship`); the access dials are
`crm.access.ts` and the database function `crm_access()` (migration
`0008_access_and_suppressions.sql`).

| Actor | What it may do |
| --- | --- |
| Anonymous | Only the three public routes |
| Signed-in `user` account | Nothing (the host's staff gate answers 403) |
| `editor` account | view and edit; delete its own activities and documents |
| `admin` account | Everything, including delete, configure and `skipValidation` |
| Agent | view and edit with `crm:*`, `kon:crm:*` or `admin` (admin-level), or the operation's fine scope `kon:crm:<op>`; never the person-only routes |

At the host, `/api/crm` (except `/api/crm/public/`) is behind the staff gate in the core's
`auth-guard.ts`: an agent passes with `crm:*`, `kon:crm:*`, `admin` or the fine scope of the
operation it calls. An agent with `crm:*`, `kon:crm:*` or `admin` counts as a CRM admin for the
policy (delete and configure included); give narrower agents fine scopes. A deny such as
`!crm:read-all` or `!kon:crm:delete-deal` wins.

Row security: the CRM tables admit the system, `admin`, `editor` and `agent` roles, and then the
`records` dial limits a subject to what is assigned to it or it created. Documents marked
privileged or confidential need the `sensitive` dial.

**404 instead of 403.** A record outside the caller's `records` dial is a 404. A field the caller
cannot read cannot be filtered or grouped by (403).

## Configuration

The exclusion list is shared with kon-newsletter when it is installed: an address excluded here stops
getting campaigns, and someone who unsubscribes or complains there is excluded here (stored with
`created_by: kon-newsletter`). Removing an entry on one side lifts it on the other only if that side put
it there. Domains are not mirrored.

Entity types (cases, properties, projects…, with their custom fields, flags, default pipeline, numbering
and activity kinds) live in Kitsuden's entities when the host has them (`ctx.entities`), as
`crm-<entityName>`: at startup each row of `crm_entity_configs` is moved there once and marked
`migratedTo`. Custom field values stay on the records (`custom_fields`). On a Kitsuden without runtime
entities, `crm_entity_configs` is used as before.

For the installation's own presets, and for receiving email (`crm.inbound.ts`, where every lock
is closed by default):

| Variable | What it is |
| --- | --- |
| `CRM_PRESETS_DIR` | A folder with the installation's own preset files (`*.json`, same format as `presets/`); relative to the API's working directory. Unset: only the shipped presets |
| `CRM_INBOUND_ALLOWED_SENDERS` | Comma-separated addresses or domains whose mail is accepted; empty rejects everything |
| `MAILGUN_WEBHOOK_SIGNING_KEY` | Mailgun's signing key, for provider `mailgun` |
| `CRM_INBOUND_POSTMARK_TOKEN` | The password in Postmark's inbound webhook URL, for provider `postmark` |
| `CRM_INBOUND_SECRET` | HMAC-SHA256 secret over `<timestamp>.<body>`, for provider `generic` |

A signature older than 15 minutes is refused, and the message must pass SPF or DKIM. Everything
else (entities, pipelines, scoring, evidence weights, access, forms) is data set through the API
or the admin views **Score, evidence and access** (`admin/settings.js`) and **Setup**
(`admin/setup.js`).

## Agents and MCP

Every operation has the fine scope `kon:crm:<operation>` and is an MCP tool `crm__<operation>`,
except nine kept off MCP on purpose: `grant-access`, `revoke-access`, `accept-observation`,
`reject-observation`, `decide-merge-request`, `create-portal-link` (decisions for a person), and
`submit-capture-form`, `read-client-portal`, `receive-inbound-email` (public callers). Start with `crm__get-agent-guide` ([AGENT_GUIDE.md](AGENT_GUIDE.md) is its
text). Tool groups, asked for as `kon:crm/<group>` (`crm.agents.ts`): `assistant` (read-only),
`sales`, `research`, `intake`, `billing`. They narrow the tool list; they grant nothing.

Writes marked sensitive (held for human approval when it is on, `202
KITSUDEN_E_APPROVAL_REQUIRED`): `grant-access`, `update-evidence-policy`, `apply-preset`,
`create-capture-form`, `update-capture-form`, `create-portal-link`, `update-score-model`, and
every DELETE. Separately, `merge-contacts` from an agent always becomes a request a person decides.
Details for agents: [AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/kon-crm-security.test.ts` | Accounts vs team, stage rules on moves, delete and configure for admin, 4xx instead of 500, RLS by role |
| `tests/unit/kon-crm-access.test.ts` | Access dials, read-all, assigned records, amounts, capture, exclusion list, duplicates and merges |
| `tests/unit/kon-crm-agents.test.ts` | Tool groups, the agent guide, events |
| `tests/unit/kon-crm-records.test.ts` | Preset entities, companies, activities and inbox, documents, client portal |
| `tests/unit/kon-crm-evidence.test.ts` | Observations and evidence weights |
| `tests/unit/kon-crm-inbound.test.ts` | Inbound email locks and recording |
| `tests/unit/kon-crm-inbox.test.ts` | The inbox: Gmail, Calendar and Graph sync through a `ctx.connections` double, people kept apart, private mail on the timeline, mail as evidence, sending |
| `tests/unit/kon-crm-practice.test.ts` | Notes, amounts, agent merges, stage automation, public forms, portal, score model, import |
| `tests/unit/kon-crm-conta-bridge.test.ts` | Billing through kon-conta |
| `tests/unit/crm-filters.test.ts` | Custom field filters |
| `tests/unit/kon-crm-pagination.test.ts` | `limit`, `offset` and `hasMore` on the lists that had none |
| `tests/bun/crm-dedupe-capture.test.ts` | Duplicate scoring and capture plans (Bun) |
| `kons/kon-crm/tests/crm.routes.test.ts`, `crm.schema.test.ts` | Route registration and schema |
| `kons/kon-crm/tests/crm.integration.spec.ts` | Playwright against a running test API, as an agent (`KITSUDEN_API_TOKEN` with `crm:*`); skipped without it |

```bash
pnpm vitest run tests/unit/kon-crm-security.test.ts   # and the other files above, one at a time
pnpm vitest run kons/kon-crm/tests/crm.routes.test.ts
pnpm test:bun
```

More in [tests/README.md](tests/README.md).

## License

MIT

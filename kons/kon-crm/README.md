# kon-crm

A CRM backend for Kitsuden: companies, contacts, pipelines and deals, activities and tasks, lead
capture, a client portal, contact scoring, evidence-weighted data from agents, and billing through
kon-conta. For a team that wants its client portfolio behind an API that people and agents share
under the same rules. The screens people work in belong to the app built on top; the kon's two
admin views are configuration only.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | business | 1.0.3 | `/api/crm` | kon-media; core `auth` (kon-conta optional, for billing) |

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

What the code does with them:

- **Presets.** A JSON file in `presets/` sets up an entity with fields, a pipeline, deal roles,
  document templates and kon-conta's words. `presets/law-firm.json` is the example.
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
| `GET /api/crm/contacts/:id/duplicates` | view | Possible duplicates with score and reasons |
| `POST /api/crm/contacts/:id/merge` | edit; runs for a person with delete | Merge two contacts; from an agent, a 202 request for a person |
| `GET /api/crm/merge-requests` | view | Merges agents asked for |
| `POST /api/crm/merge-requests/:id/decision` | delete, person | Approve or reject a requested merge |
| `POST /api/crm/capture` | edit | Bring a lead in (contact, activity, optional deal); `dryRun` returns the plan |
| `GET /api/crm/suppressions` | view | The exclusion list |
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
| `GET /api/crm/work` | view | Tasks to do, with due-date status; `include=deal` |
| `GET /api/crm/work/summary` | view | Counts of tasks to do |
| `GET /api/crm/agenda` | view | Dated work between two days, by type, `kind` and deal |
| `GET /api/crm/documents` | view | Documents across deals |
| `GET /api/crm/deals/:id/documents` | view | A deal's documents |
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
| `GET /api/crm/score-model/versions` | view | Earlier versions |
| `GET /api/crm/evidence-policy` | view | Evidence kinds and their weights |
| `PUT /api/crm/evidence-policy` | configure | Change the weights |
| `POST /api/crm/observations` | edit | Record an observed value about a contact or company |
| `GET /api/crm/observations` | view | List observations |
| `POST /api/crm/observations/:id/accept` | edit, person | Accept a suggested value |
| `POST /api/crm/observations/:id/reject` | edit, person | Reject a suggested value |
| `GET /api/crm/presets` | view | Ready-made setups |
| `POST /api/crm/presets/:id/apply` | configure | Apply a preset |
| `GET /api/crm/capture-forms` | configure | List public capture forms |
| `POST /api/crm/capture-forms` | configure | Create a form |
| `PATCH /api/crm/capture-forms/:id` | configure | Change a form |
| `DELETE /api/crm/capture-forms/:id` | configure | Delete a form |
| `GET /api/crm/portal-links` | edit | List portal links |
| `POST /api/crm/portal-links` | edit, person | Give a contact a portal link (token shown once; `days`, `showStatement`) |
| `DELETE /api/crm/portal-links/:id` | edit | Revoke a portal link |
| `GET /api/crm/contacts/:id/portal-preview` | edit | What a contact's portal shows, without a link |
| `GET /api/crm/inbound-emails` | configure | Emails posted to the CRM and why any was turned away |
| `GET /api/crm/agent-guide` | view | `AGENT_GUIDE.md` plus this installation's entities, fields, kinds, the caller's access and the tool groups |

### Public (no account; rate limited)

| Route | Needs | What it does |
| --- | --- | --- |
| `POST /api/crm/public/forms/:id` | public, 20/min | Submit a capture form; always 202 `{ ok: true }` once the form exists |
| `POST /api/crm/public/portal` | public, 20/min | Read a client portal with its token; unknown, expired or revoked are all 404 |
| `POST /api/crm/public/inbound/:provider` | provider signature, 300/min | Receive an email from `mailgun`, `postmark` or `generic` |

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

Only for receiving email (`crm.inbound.ts`); every lock is closed by default:

| Variable | What it is |
| --- | --- |
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
| `tests/unit/kon-crm-practice.test.ts` | Notes, amounts, agent merges, stage automation, public forms, portal, score model, import |
| `tests/unit/kon-crm-conta-bridge.test.ts` | Billing through kon-conta |
| `tests/unit/crm-filters.test.ts` | Custom field filters |
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

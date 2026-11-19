# kon-agile

An issue tracker where people and AI agents work on the same board: projects, issues with keys,
custom states, sprints, epics, initiatives, saved views and a dashboard, with attachments, full-text
search, logged time and GitHub pull requests. Agents join a project as members, work from a queue and
write only on the issues in their reach.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | business | 1.5.0 | `/api/agile` | kon-media; core `auth` |

## Install

Inside a Kitsuden project:

```bash
kitsuden kon add agile --enable
```

The kon is off by default (`defaultEnabled: false` in `package.json`), so pass `--enable` or switch
it on in the admin panel (**Kons**). Restart the API afterwards. `kon.json` lists `kon-media` as a
required kon; it ships with the Kitsuden core, so nothing else is installed. No environment
variables are required. Once running, the kon starts a one-minute timer (`agile.workflow.ts`,
`tick`) for automation and agent schedules.

## What it adds

- **Projects** (`agile_projects`) with members (`agile_project_members`: owner, member, viewer).
  A project exists only for its members.
- **Issues** (`agile_issues`) with keys (`PLAT-12`), custom **states** (`agile_states`, columns
  with entry validations), **labels** (`agile_labels`, `agile_issue_labels`), **checklists**
  (`agile_checklist_items`), sub-issues, **links** (`agile_issue_links`: blocks, relates to,
  duplicates...), **custom fields** (`agile_custom_fields`), estimate scales
  (`agile_estimates`), archiving and a history (`agile_activity_log`).
- **Cycles** (`agile_cycles`, sprints): closing one carries its unfinished issues to the next.
- **Modules** (`agile_modules`, epics, with `agile_module_issues`) and **initiatives**
  (`agile_initiatives`): a goal with a target date and its pace (on track, at risk, off track).
- **Saved views** (`agile_saved_views`): filters, grouping and a layout (board, table, calendar,
  timeline), private or shared. Plus calendar, timeline and dashboard reads.
- **Automation** in the project's `config`: `autoAssign` (state to member), `autoArchiveDays`,
  `autoCloseCycles`.
- **Intakes** (`agile_intakes`): an inbox where any member (agents included) proposes work, and a
  person approves, declines or marks it a duplicate.
- **Comments** (`agile_comments`) and **notifications** (`agile_notifications`) for mentions,
  assignments and hand-offs. Notifications stay inside the kon; nothing is emailed.
- **Squads** (`agile_squads`, `agile_squad_members`), the **agent work queue**
  (`agile_agent_work`) and **agent schedules** (`agile_agent_schedules`).
- **Attachments** (`agile_issue_attachments`, 1.4): a file of the core's media library hung on an
  issue. Upload it to the media library first (the core's media routes), then attach its id. Removing the attachment leaves the file.
- **Subscribers** (`agile_issue_subscribers`) and **reactions**: the creator, every assignee and every
  commenter follow an issue and hear about its comments and state changes; anyone in the project may
  follow or stop. Any member, viewers and agents too, reacts to a comment for itself.
- **Bulk changes**: one request (or one MCP call) sets state, assignee, priority, sprint, epic,
  initiative, estimate, target date, labels or archiving on up to 100 issues, all or nothing.
- **Full-text search** over keys, titles, descriptions and comments (`tsvector`, migration 0006), in
  the issue list, saved views and `GET /:projectId/search`, which answers a snippet per hit.
- **Time** (`agile_time_entries`): minutes logged per person and issue, and each issue's **cost**: the
  people's hours at `config.hourlyRateUsd` plus what agents reported (runs, tokens, USD).
- **GitHub** (`agile_github_repos`, `agile_issue_pull_requests`): a connected repository posts its
  pull requests; one that names an issue key is listed on the issue, and one that says `fixes KEY` and
  is merged completes it. The webhook secret is stored sealed (`ctx.secrets`).
- **Events for automation rules**: `agile:issue.created`, `.updated`, `.state_changed`, `.assigned`,
  `.commented`, `agile:pull_request.linked` and `agile:agent_work`, declared for the core's rule
  catalog, a mail template (`agile.issue-event`) and ready-made rules (`GET /rule-templates`) to email
  a team or post to a webhook. The kon still never learns an account's email.

Every table has forced row security by project membership.

### Agents as teammates

An agent joins a project like a person: `POST /api/agile/projects/:id/members` with its agent id,
a role and `isAgent: true`.

| An agent may | An agent may not |
| --- | --- |
| read the whole project | change states, cycles, modules, labels, fields, initiatives, squads |
| create, edit, comment, tick checklists and archive issues assigned to itself | decide intakes |
| hand its issue to another member | delete issues |
| propose intakes | share views |

A **squad** is a team inside the project. An agent that is a squad's `scrumMasterId` also writes on
the issues of the squad's members and on unassigned ones, and assigns only inside the squad. People
configure squads. The route answers 403, and the database refuses the same write made by hand
(`agile_agent_reach`, migration `0005_planning_squads_and_agents.sql`). An agent key that acts as
a person (`user:act`) is that person.

### The work queue

The Kitsuden core cannot start an agent run on behalf of a kon, so work is queued in
`agile_agent_work`. Assigning an issue to an agent, mentioning it, handing it an issue, an agent
schedule (every 15 minutes or more) or a person (`POST /api/agile/:projectId/work`) adds a row,
and the kon emits `agile:agent_work` on the host's event bus. An agent (or its runner) then:

1. reads its queue (`GET /api/agile/work/mine`);
2. claims a piece (`POST /api/agile/work/:workId/claim`, only once);
3. works on the board (read the issue, update it, comment, tick the checklist, hand off);
4. closes it (`POST /api/agile/work/:workId/finish`): `done` or `failed`, with its result, run
   id, tokens and cost in USD.

`GET /api/agile/:projectId/work` lists the queue and totals per agent.

### Administration panel

`<agile-workspace>` (`admin/workspace.js`) configures and oversees: project details and
automation, members and agents, states, labels and fields, planning, squads and schedules,
intakes, agent work and cost, issues (archive, restore, delete) and history. Daily work on the
board belongs to a frontend or to MCP. It is written in Svelte 5 in `admin-src/` with a copy of
the tallao components (`admin-src/tallao/`, listed in `admin-src/tallao.json`).

## HTTP API

Every route needs a session. "Member" means any role in the project; "writer" an owner or
member; "owner" the project owner; a human `admin` account passes every project check. Someone
who is not a member gets 404 for anything in the project.

**Pages (1.5).** The lists that grow with use take an optional page: projects, members, comments,
sub-issues, intakes, sprints, epics, an epic's issues and an issue's logged time. `limit` (1-500)
and `offset` (default 0) return one page, and `hasMore: true` means another page follows. Without
`limit` the whole list comes back as before, with `hasMore: false`. `totalDocs` counts the rows of
the answer; `totalMinutes` on an issue's time always counts every entry. The other lists
(configuration such as states, labels, fields, squads and schedules, and the few links,
attachments, followers or pull requests of one issue) are bounded and come back whole; each says
why in its OpenAPI `x-kitsuden-operation.unpaginated`. The issue list, the caller's notifications,
the work queues (`/work/mine`, `/:projectId/work`) keep their own `limit` and default (issues 50,
notifications 50, my work 20, project work 50) and take `offset` with `hasMore` too: oldest or
newest first as before, then by id. Search is a top-k by relevance (`limit` 1-50) and is not paged:
narrow it with more words. History keeps its own `limit`.

**Deprecated (1.5).** `POST /api/agile/agile_intakes/:id/approve`, `.../decline` and
`.../convert` have an underscore in the path. They keep working until 2027-05-18 and answer
`Deprecation` and `Sunset` headers. Use `POST /api/agile/intakes/:intakeId/approve`, `/decline`
and `/convert` instead (`/convert` is new in 1.5).

### Projects, members, issues and intakes

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/agile/projects` | signed in | Projects the caller is a member of (`limit`, `offset`) |
| `POST /api/agile/projects` | admin or editor | Create a project with five default states; the caller becomes owner |
| `GET /api/agile/projects/:id` | member | Read a project |
| `PATCH /api/agile/projects/:id` | owner | Details, lead, default assignee, archiving, automation |
| `GET /api/agile/projects/:id/members` | member | List members (`limit`, `offset`) |
| `POST /api/agile/projects/:id/members` | owner | Add or change a member (`isAgent: true` for an agent) |
| `DELETE /api/agile/projects/:id/members/:userId` | owner | Remove a member (not the creator) |
| `GET /api/agile/projects/:projectId/board` | member | The board: states with their issues and counts |
| `GET /api/agile/:projectId/issues` | member | List issues (state, assignee, label, cycle, archived...; `limit`, `offset`) |
| `POST /api/agile/:projectId/issues` | writer, agent in reach | Create an issue with the next key |
| `GET /api/agile/issues/:key` | member | Read an issue by key |
| `PATCH /api/agile/issues/:key` | writer, agent in reach | Update an issue |
| `DELETE /api/agile/issues/:key` | writer, never an agent | Delete an issue with its comments, checklist and links |
| `POST /api/agile/issues/:key/archive` | writer, agent in reach | Archive an issue |
| `POST /api/agile/issues/:key/unarchive` | writer, agent in reach | Restore an archived issue |
| `GET /api/agile/issues/:key/comments` | member | List comments (`limit`, `offset`) |
| `POST /api/agile/issues/:key/comments` | writer, agent in reach | Comment; `mentions` notifies members |
| `GET /api/agile/issues/:key/sub-issues` | member | List sub-issues (`limit`, `offset`) |
| `GET /api/agile/issues/:key/activity` | member | An issue's history |
| `GET /api/agile/issues/:key/links` | member | List links |
| `POST /api/agile/issues/:key/links` | writer, agent in reach | Link two issues |
| `DELETE /api/agile/issues/:key/links/:linkId` | writer, agent in reach | Remove a link |
| `PUT /api/agile/issues/:key/labels` | writer, agent in reach | Set an issue's labels |
| `GET /api/agile/issues/:key/checklist` | member | Read the checklist |
| `POST /api/agile/issues/:key/checklist` | writer, agent in reach | Add a step |
| `PATCH /api/agile/issues/:key/checklist/:itemId` | writer, agent in reach | Tick or edit a step |
| `DELETE /api/agile/issues/:key/checklist/:itemId` | writer, agent in reach | Delete a step |
| `POST /api/agile/issues/:key/handoff` | writer, agent in reach | Hand an issue to another member with a note |
| `GET /api/agile/:projectId/activity` | member | A project's history |
| `GET /api/agile/:projectId/intakes` | member | The triage inbox (`status`, `limit`, `offset`) |
| `POST /api/agile/:projectId/intakes` | member (viewers and agents too) | Propose work; never creates an issue |
| `POST /api/agile/intakes/:intakeId/approve` | writer, never an agent | Turn a pending intake into an issue |
| `POST /api/agile/intakes/:intakeId/decline` | writer, never an agent | Decline a pending intake |
| `POST /api/agile/intakes/:intakeId/duplicate` | writer, never an agent | Mark an intake as a duplicate |
| `POST /api/agile/intakes/:intakeId/convert` | writer, never an agent | Convert into an issue, same as approve (1.5) |
| `POST /api/agile/agile_intakes/:id/approve` | writer, never an agent | Deprecated grid alias of `/intakes/:intakeId/approve` (until 2027-05-18) |
| `POST /api/agile/agile_intakes/:id/decline` | writer, never an agent | Deprecated grid alias of `/intakes/:intakeId/decline` (until 2027-05-18) |
| `POST /api/agile/agile_intakes/:id/convert` | writer, never an agent | Deprecated grid alias of `/intakes/:intakeId/convert` (until 2027-05-18) |

### Planning (configuration: owner or member, never an agent; reads: member)

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/agile/:projectId/states` | member | List states |
| `POST /api/agile/:projectId/states` | writer | Create a state |
| `PUT /api/agile/:projectId/states/order` | writer | Reorder states |
| `PATCH /api/agile/states/:stateId` | writer | Update a state (group, color, default, entry validations) |
| `DELETE /api/agile/states/:stateId` | writer | Delete a state; its issues move to `moveTo` (409 without it, or for the default state) |
| `GET /api/agile/:projectId/labels` | member | List labels |
| `POST /api/agile/:projectId/labels` | writer | Create a label |
| `PATCH /api/agile/labels/:labelId` | writer | Update a label |
| `DELETE /api/agile/labels/:labelId` | writer | Delete a label |
| `GET /api/agile/:projectId/estimates` | member | List estimate scales |
| `POST /api/agile/:projectId/estimates` | writer | Create an estimate scale |
| `PATCH /api/agile/estimates/:estimateId` | writer | Update an estimate scale |
| `DELETE /api/agile/estimates/:estimateId` | writer | Delete an estimate scale |
| `GET /api/agile/:projectId/fields` | member | List custom fields |
| `POST /api/agile/:projectId/fields` | writer | Create a custom field |
| `PATCH /api/agile/fields/:fieldId` | writer | Update a custom field |
| `DELETE /api/agile/fields/:fieldId` | writer | Delete a custom field |
| `GET /api/agile/:projectId/cycles` | member | List sprints (`limit`, `offset`) |
| `POST /api/agile/:projectId/cycles` | writer | Create a sprint |
| `GET /api/agile/cycles/:cycleId` | member | A sprint with its numbers |
| `PATCH /api/agile/cycles/:cycleId` | writer | Update a sprint |
| `POST /api/agile/cycles/:cycleId/complete` | writer | Close a sprint and carry over unfinished issues |
| `DELETE /api/agile/cycles/:cycleId` | writer | Delete a sprint |
| `GET /api/agile/:projectId/modules` | member | List epics (`limit`, `offset`) |
| `POST /api/agile/:projectId/modules` | writer | Create an epic |
| `GET /api/agile/modules/:moduleId` | member | An epic with its progress |
| `PATCH /api/agile/modules/:moduleId` | writer | Update an epic |
| `DELETE /api/agile/modules/:moduleId` | writer | Delete an epic |
| `GET /api/agile/modules/:moduleId/issues` | member | An epic's issues (`limit`, `offset`) |
| `POST /api/agile/modules/:moduleId/issues` | writer | Add an issue to an epic |
| `DELETE /api/agile/modules/:moduleId/issues/:key` | writer | Remove an issue from an epic |
| `GET /api/agile/:projectId/initiatives` | member | List initiatives |
| `POST /api/agile/:projectId/initiatives` | writer | Create an initiative |
| `GET /api/agile/initiatives/:initiativeId` | member | An initiative with its pace |
| `PATCH /api/agile/initiatives/:initiativeId` | writer | Update an initiative |
| `DELETE /api/agile/initiatives/:initiativeId` | writer | Delete an initiative |

### Team, work queue and views

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/agile/:projectId/squads` | member | List squads |
| `POST /api/agile/:projectId/squads` | writer, never an agent | Create a squad (with a scrum master) |
| `PATCH /api/agile/squads/:squadId` | writer, never an agent | Update a squad |
| `DELETE /api/agile/squads/:squadId` | writer, never an agent | Delete a squad |
| `POST /api/agile/squads/:squadId/members` | writer, never an agent | Add a squad member |
| `DELETE /api/agile/squads/:squadId/members/:userId` | writer, never an agent | Remove a squad member |
| `GET /api/agile/notifications` | signed in | The caller's notifications (`unread`, `limit`, `offset`) |
| `POST /api/agile/notifications/:notificationId/read` | signed in | Mark one read |
| `POST /api/agile/notifications/read-all` | signed in | Mark all read |
| `GET /api/agile/work/mine` | signed in | The caller's work queue (`status`, `limit`, `offset`) |
| `POST /api/agile/work/:workId/claim` | the agent it is for | Start a piece of work |
| `POST /api/agile/work/:workId/finish` | the agent it is for | Close a piece of work with its result and cost |
| `POST /api/agile/:projectId/work` | writer, never an agent | Ask an agent member for something |
| `GET /api/agile/:projectId/work` | member | A project's agent work (`limit`, `offset`) and totals per agent |
| `GET /api/agile/:projectId/schedules` | member | List agent schedules |
| `POST /api/agile/:projectId/schedules` | writer, never an agent | Wake an agent every `intervalMinutes` (15 to 43200) |
| `PATCH /api/agile/schedules/:scheduleId` | writer, never an agent | Change a schedule |
| `DELETE /api/agile/schedules/:scheduleId` | writer, never an agent | Delete a schedule |
| `GET /api/agile/:projectId/views` | member | The caller's and shared saved views |
| `POST /api/agile/:projectId/views` | member | Save a view (sharing needs write rights) |
| `PATCH /api/agile/views/:viewId` | view owner; writer for shared | Change a saved view |
| `DELETE /api/agile/views/:viewId` | view owner; writer for shared | Delete a saved view |
| `GET /api/agile/views/:viewId/issues` | member | Run a saved view |
| `GET /api/agile/:projectId/calendar` | member | Calendar of a project |
| `GET /api/agile/:projectId/timeline` | member | Timeline of a project |
| `GET /api/agile/:projectId/dashboard` | member | Throughput, burn-up, breakdown, pulse |

### Attachments, subscribers, reactions, bulk changes and search (1.4)

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/agile/issues/:key/attachments` | member | List an issue's files |
| `POST /api/agile/issues/:key/attachments` | writer, agent in reach | Attach a media file by `mediaId` (422 unknown, 409 twice) |
| `DELETE /api/agile/issues/:key/attachments/:attachmentId` | writer, agent in reach | Unhook a file (it stays in the media library) |
| `GET /api/agile/issues/:key/subscribers` | member | Who follows the issue, and whether the caller does |
| `POST /api/agile/issues/:key/subscribe` | member (viewers and agents too) | Follow the issue |
| `DELETE /api/agile/issues/:key/subscribe` | member | Stop following it |
| `POST /api/agile/comments/:commentId/reactions` | member (viewers and agents too) | Toggle the caller's reaction (`emoji`) |
| `POST /api/agile/:projectId/issues/bulk` | writer, agent in reach | Same change on up to 100 issues, all or nothing |
| `GET /api/agile/:projectId/search` | member | Full-text search with a snippet per hit (`q`, `includeArchived`, `limit`; top-k, not paged) |

### Time, cost, GitHub and rules (1.4)

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/agile/issues/:key/time` | member | Time logged on an issue (`limit`, `offset`; `totalMinutes` counts every entry) |
| `POST /api/agile/issues/:key/time` | writer, agent in reach | Log the caller's minutes (1-1440, `spentOn`) |
| `PATCH /api/agile/time/:entryId` | its author, or a person with write rights | Fix an entry |
| `DELETE /api/agile/time/:entryId` | its author, or a person with write rights | Remove an entry |
| `GET /api/agile/issues/:key/cost` | member | People's hours and cost, agents' runs, tokens and USD, and the total |
| `GET /api/agile/:projectId/time` | member | Entries between `from` and `to`, totals per person |
| `GET /api/agile/:projectId/github` | member | Connected repositories and their webhook URL (never the secret) |
| `POST /api/agile/:projectId/github` | writer, never an agent | Connect `owner/name`; answers the webhook URL and secret once |
| `PATCH /api/agile/github/:repoId` | writer, never an agent | Whether a merge completes the issue (`closeOnMerge`) |
| `DELETE /api/agile/github/:repoId` | writer, never an agent | Disconnect a repository |
| `GET /api/agile/issues/:key/pull-requests` | member | Pull requests that mention the issue |
| `POST /api/agile/github/webhook/:repoId` | GitHub, signed | `pull_request` and `ping`; `X-Hub-Signature-256` required (401) |
| `GET /api/agile/rule-templates` | signed in | The agile events and ready-made rules for the core's actions API |

**Connecting GitHub.** `POST /api/agile/:projectId/github` with `{ "repo": "acme/web" }` answers
`webhookUrl` and `webhookSecret`. In GitHub: Settings → Webhooks → Add webhook, that URL, content
type `application/json`, that secret, event "Pull requests". The secret is not shown again. A pull
request whose title, description or branch names `PLAT-12` is listed on PLAT-12; one that says
`fixes PLAT-12` (or `closes`, `resolves`) and is merged moves it to the project's first completed
state, unless that state's validations stop it. The server needs `KITSUDEN_SECRETS_KEY` (409 without
it), and nothing is ever read from GitHub.

**Email and webhooks.** The kon emits events; a person turns them into email or webhooks with an
automation rule. `GET /api/agile/rule-templates` answers five rules (urgent issue, issue done, new
comment, changes to a webhook, merged pull request) ready to post to the core's actions API once the project id
and the address or URL are filled in. Events are delivered after commit and at most once, so the
kon's own notifications and history stay the record.

## Who can do what

Policies are in `agile.policy.ts`; per-request checks in `agile.access.ts`; row security in the
migrations (`0001_members_and_rls.sql`, `0004_english_rls.sql`, `0005_planning_squads_and_agents.sql`,
`0006_attachments_time_github_search.sql`).

| Actor | What it may do |
| --- | --- |
| Anonymous | Nothing (401) |
| Signed-in account | Its own notifications and work queue; projects only where it is a member |
| Human `admin` or `editor` account | Create projects (gate `agile:create-project`) |
| Project viewer | Read the project, propose intakes |
| Project member | Viewer rights, plus write issues, configure planning, decide intakes |
| Project owner (or human `admin`) | Member rights, plus edit the project and manage members |
| Agent member | Read; write only on issues in its reach (attachments, time and bulk changes too); propose intakes; claim and finish its work; follow issues and react; never connect a repository |

An agent key reaches the routes only if it may act as a user (`user:act`, `admin`, or a scope
starting with `agile:` or `kon:agile:`; policy `agile`, action `actAsUser`), and then only inside
projects it is a member of. The `admin` scope does not make an agent a project admin: the project
checks look at the account role `admin`.

**404 instead of 403.** A project, issue, cycle or view the caller cannot see is a 404, whether it
does not exist or the caller is not a member. A member without the right for the action gets 403.

## Configuration

No environment variables of its own. Each project carries its own `config` (estimate type, time
zone, week start, `autoAssign`, `autoArchiveDays`, `autoCloseCycles`, `hourlyRateUsd`), changed with
`PATCH /api/agile/projects/:id`. Connecting GitHub needs the core's `KITSUDEN_SECRETS_KEY`, and the
webhook URL is built from the API's site URL (`ctx.config.siteUrl`).

## Agents and MCP

Every route is a kon SDK operation with the fine scope `kon:agile:<operation>`, but only these
are MCP tools. Their names are set by the kon (`AGENT_TOOLS` in `operations.ts` and
`agile.operations.ts`), not the usual `agile__<operation>`:

| MCP tool | Operation | Route | Writes |
| --- | --- | --- | --- |
| `agile_read_board` | `get-board` | `GET /api/agile/projects/:projectId/board` | no |
| `agile_submit_intake` | `propose-intake` | `POST /api/agile/:projectId/intakes` | yes |
| `agile_my_work` | `list-my-work` | `GET /api/agile/work/mine` | no |
| `agile_claim_work` | `claim-work` | `POST /api/agile/work/:workId/claim` | yes |
| `agile_finish_work` | `finish-work` | `POST /api/agile/work/:workId/finish` | yes |
| `agile_list_issues` | `list-issues` | `GET /api/agile/:projectId/issues` | no |
| `agile_get_issue` | `get-issue` | `GET /api/agile/issues/:key` | no |
| `agile_list_comments` | `list-issue-comments` | `GET /api/agile/issues/:key/comments` | no |
| `agile_get_checklist` | `list-checklist` | `GET /api/agile/issues/:key/checklist` | no |
| `agile_update_issue` | `update-issue` | `PATCH /api/agile/issues/:key` | yes |
| `agile_comment` | `comment-issue` | `POST /api/agile/issues/:key/comments` | yes |
| `agile_check_item` | `update-checklist-item` | `PATCH /api/agile/issues/:key/checklist/:itemId` | yes |
| `agile_add_checklist_item` | `add-checklist-item` | `POST /api/agile/issues/:key/checklist` | yes |
| `agile_handoff` | `handoff-issue` | `POST /api/agile/issues/:key/handoff` | yes |
| `agile_create_issue` | `create-issue` | `POST /api/agile/:projectId/issues` | yes |
| `agile_list_squads` | `list-squads` | `GET /api/agile/:projectId/squads` | no |
| `agile_search` | `search-issues` | `GET /api/agile/:projectId/search` | no |
| `agile_bulk_update` | `bulk-update-issues` | `POST /api/agile/:projectId/issues/bulk` | yes |
| `agile_link_issues` | `link-issues` | `POST /api/agile/issues/:key/links` | yes |
| `agile_list_links` | `list-issue-links` | `GET /api/agile/issues/:key/links` | no |
| `agile_list_attachments` | `list-attachments` | `GET /api/agile/issues/:key/attachments` | no |
| `agile_attach_file` | `attach-file` | `POST /api/agile/issues/:key/attachments` | yes |
| `agile_log_time` | `log-time` | `POST /api/agile/issues/:key/time` | yes |
| `agile_issue_cost` | `issue-cost` | `GET /api/agile/issues/:key/cost` | no |
| `agile_list_pull_requests` | `list-pull-requests` | `GET /api/agile/issues/:key/pull-requests` | no |
| `agile_follow_issue` | `subscribe-issue` | `POST /api/agile/issues/:key/subscribe` | yes |

Configuration (GitHub repositories included), intake decisions and deletes are REST only. No operation is marked sensitive
beyond the default (every DELETE); with human approval on, those may come back
`202 KITSUDEN_E_APPROVAL_REQUIRED`. An MCP example: [MCP_EXAMPLE.md](MCP_EXAMPLE.md). Details for
agents: [AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/kon-agile-security.test.ts` | Anonymous, non-members, members, no IDOR between projects, RLS |
| `tests/unit/kon-agile-teammates.test.ts` | Agent reach, scrum master, hand-offs, mentions, work queue, planning |
| `tests/unit/agile-operations-mcp.test.ts` | Which operations are MCP tools, and membership through the real routes |
| `tests/unit/kon-agile-plane-parity.test.ts` | 1.4: events and rule templates, subscribers, reactions, attachments, bulk changes, search, time and cost, signed GitHub webhooks |
| `tests/unit/kon-agile-pagination.test.ts` | 1.5: optional pages (`limit`, `offset`, `hasMore`) on the lists that grow, the kebab-case convert route and the deprecated `/agile_intakes` aliases |

```bash
pnpm vitest run tests/unit/kon-agile-security.test.ts
pnpm vitest run tests/unit/kon-agile-teammates.test.ts
pnpm vitest run tests/unit/agile-operations-mcp.test.ts
pnpm vitest run tests/unit/kon-agile-plane-parity.test.ts
pnpm vitest run tests/unit/kon-agile-pagination.test.ts
```

Admin panel: `pnpm build:admin kon-agile` rebuilds `admin/workspace.js`; `pnpm check:admin` runs
svelte-check.

## License

MIT

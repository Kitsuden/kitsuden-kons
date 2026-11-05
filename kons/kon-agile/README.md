# kon-agile

An issue tracker where people and AI agents work on the same board: projects, issues with keys,
custom states, sprints, epics, initiatives, saved views and a dashboard. Agents join a project as
members, work from a queue and write only on the issues in their reach.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | business | 1.3.1 | `/api/agile` | kon-media; core `auth` |

## Install

Inside a Kitsuden project:

```bash
kitsuden kon add agile
```

`kon-media` is added with it. The manifest does not set `defaultEnabled: false`, so `--enable` is
not needed. Restart the API. No environment variables are required. Once running, the kon starts a
one-minute timer (`agile.workflow.ts`, `tick`) for automation and agent schedules.

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

### Projects, members, issues and intakes

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/agile/projects` | signed in | Projects the caller is a member of |
| `POST /api/agile/projects` | admin or editor | Create a project with five default states; the caller becomes owner |
| `GET /api/agile/projects/:id` | member | Read a project |
| `PATCH /api/agile/projects/:id` | owner | Details, lead, default assignee, archiving, automation |
| `GET /api/agile/projects/:id/members` | member | List members |
| `POST /api/agile/projects/:id/members` | owner | Add or change a member (`isAgent: true` for an agent) |
| `DELETE /api/agile/projects/:id/members/:userId` | owner | Remove a member (not the creator) |
| `GET /api/agile/projects/:projectId/board` | member | The board: states with their issues and counts |
| `GET /api/agile/:projectId/issues` | member | List issues (state, assignee, label, cycle, archived...) |
| `POST /api/agile/:projectId/issues` | writer, agent in reach | Create an issue with the next key |
| `GET /api/agile/issues/:key` | member | Read an issue by key |
| `PATCH /api/agile/issues/:key` | writer, agent in reach | Update an issue |
| `DELETE /api/agile/issues/:key` | writer, never an agent | Delete an issue with its comments, checklist and links |
| `POST /api/agile/issues/:key/archive` | writer, agent in reach | Archive an issue |
| `POST /api/agile/issues/:key/unarchive` | writer, agent in reach | Restore an archived issue |
| `GET /api/agile/issues/:key/comments` | member | List comments |
| `POST /api/agile/issues/:key/comments` | writer, agent in reach | Comment; `mentions` notifies members |
| `GET /api/agile/issues/:key/sub-issues` | member | List sub-issues |
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
| `GET /api/agile/:projectId/intakes` | member | The triage inbox |
| `POST /api/agile/:projectId/intakes` | member (viewers and agents too) | Propose work; never creates an issue |
| `POST /api/agile/intakes/:intakeId/approve` | writer, never an agent | Turn a pending intake into an issue |
| `POST /api/agile/intakes/:intakeId/decline` | writer, never an agent | Decline a pending intake |
| `POST /api/agile/intakes/:intakeId/duplicate` | writer, never an agent | Mark an intake as a duplicate |
| `POST /api/agile/agile_intakes/:id/approve` | writer, never an agent | Approve (alias for the admin data grid row action) |
| `POST /api/agile/agile_intakes/:id/decline` | writer, never an agent | Decline (grid alias) |
| `POST /api/agile/agile_intakes/:id/convert` | writer, never an agent | Convert into an issue (grid alias) |

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
| `GET /api/agile/:projectId/cycles` | member | List sprints |
| `POST /api/agile/:projectId/cycles` | writer | Create a sprint |
| `GET /api/agile/cycles/:cycleId` | member | A sprint with its numbers |
| `PATCH /api/agile/cycles/:cycleId` | writer | Update a sprint |
| `POST /api/agile/cycles/:cycleId/complete` | writer | Close a sprint and carry over unfinished issues |
| `DELETE /api/agile/cycles/:cycleId` | writer | Delete a sprint |
| `GET /api/agile/:projectId/modules` | member | List epics |
| `POST /api/agile/:projectId/modules` | writer | Create an epic |
| `GET /api/agile/modules/:moduleId` | member | An epic with its progress |
| `PATCH /api/agile/modules/:moduleId` | writer | Update an epic |
| `DELETE /api/agile/modules/:moduleId` | writer | Delete an epic |
| `GET /api/agile/modules/:moduleId/issues` | member | An epic's issues |
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
| `GET /api/agile/notifications` | signed in | The caller's notifications |
| `POST /api/agile/notifications/:notificationId/read` | signed in | Mark one read |
| `POST /api/agile/notifications/read-all` | signed in | Mark all read |
| `GET /api/agile/work/mine` | signed in | The caller's work queue |
| `POST /api/agile/work/:workId/claim` | the agent it is for | Start a piece of work |
| `POST /api/agile/work/:workId/finish` | the agent it is for | Close a piece of work with its result and cost |
| `POST /api/agile/:projectId/work` | writer, never an agent | Ask an agent member for something |
| `GET /api/agile/:projectId/work` | member | A project's agent work and totals per agent |
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

## Who can do what

Policies are in `agile.policy.ts`; per-request checks in `agile.access.ts`; row security in the
migrations (`0001_members_and_rls.sql`, `0004_english_rls.sql`, `0005_planning_squads_and_agents.sql`).

| Actor | What it may do |
| --- | --- |
| Anonymous | Nothing (401) |
| Signed-in account | Its own notifications and work queue; projects only where it is a member |
| Human `admin` or `editor` account | Create projects (gate `agile:create-project`) |
| Project viewer | Read the project, propose intakes |
| Project member | Viewer rights, plus write issues, configure planning, decide intakes |
| Project owner (or human `admin`) | Member rights, plus edit the project and manage members |
| Agent member | Read; write only on issues in its reach; propose intakes; claim and finish its work |

An agent key reaches the routes only if it may act as a user (`user:act`, `admin`, or a scope
starting with `agile:` or `kon:agile:`; policy `agile`, action `actAsUser`), and then only inside
projects it is a member of. The `admin` scope does not make an agent a project admin: the project
checks look at the account role `admin`.

**404 instead of 403.** A project, issue, cycle or view the caller cannot see is a 404, whether it
does not exist or the caller is not a member. A member without the right for the action gets 403.

## Configuration

No environment variables or global settings. Each project carries its own `config` (estimate
type, time zone, week start, `autoAssign`, `autoArchiveDays`, `autoCloseCycles`), changed with
`PATCH /api/agile/projects/:id`.

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

Configuration, intake decisions and deletes are REST only. No operation is marked sensitive
beyond the default (every DELETE); with human approval on, those may come back
`202 KITSUDEN_E_APPROVAL_REQUIRED`. An MCP example: [MCP_EXAMPLE.md](MCP_EXAMPLE.md). Details for
agents: [AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/kon-agile-security.test.ts` | Anonymous, non-members, members, no IDOR between projects, RLS |
| `tests/unit/kon-agile-teammates.test.ts` | Agent reach, scrum master, hand-offs, mentions, work queue, planning |
| `tests/unit/agile-operations-mcp.test.ts` | Which operations are MCP tools, and membership through the real routes |

```bash
pnpm vitest run tests/unit/kon-agile-security.test.ts
pnpm vitest run tests/unit/kon-agile-teammates.test.ts
pnpm vitest run tests/unit/agile-operations-mcp.test.ts
```

Admin panel: `pnpm build:admin kon-agile` rebuilds `admin/workspace.js`; `pnpm check:admin` runs
svelte-check.

## License

MIT

# AGENTS.md — kon-agile

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

An issue tracker mounted at `/api/agile` where agents are project members with a work queue. An
agent reads the whole project, writes only on issues in its reach (its own, or its squad's as
scrum master) and proposes everything else as an intake a person decides. Human docs:
[README.md](README.md); MCP example: [MCP_EXAMPLE.md](MCP_EXAMPLE.md).

## Calling it

- **Two things are needed.** (1) The key must act as a user: `user:act`, `admin`, or any scope
  starting with `agile:` or `kon:agile:` (for example `agile:*`). (2) The agent must be a member
  of the project: a person adds it with `POST /api/agile/projects/:id/members`
  (`{ "userId": "<agent id>", "role": "member", "isAgent": true }`). Scopes never replace
  membership: row security filters by membership whatever the key says.
- **MCP tools** carry custom names (`AGENT_TOOLS` in `operations.ts`): `agile_read_board`,
  `agile_submit_intake`, `agile_my_work`, `agile_claim_work`, `agile_finish_work`,
  `agile_list_issues`, `agile_get_issue`, `agile_list_comments`, `agile_get_checklist`,
  `agile_update_issue`, `agile_comment`, `agile_check_item`, `agile_add_checklist_item`,
  `agile_handoff`, `agile_create_issue`, `agile_list_squads`. Every other operation is REST only.
  Lists return `{ docs, totalDocs }`; single reads and writes return the row; the board returns
  states with their issues and counts per group.
- **A run:** `agile_my_work` → `agile_claim_work` (once; a second claim is 409, someone else's
  work 403) → work on the issue → `agile_finish_work` with `done`, `failed` or `cancelled`, the
  result, run id, tokens and cost.
- **Issues are addressed by key** (`PLAT-12`), not by uuid. Projects, cycles, modules and the rest
  by uuid.
- **404** means "not a member" as much as "does not exist": the kon never confirms that a project
  you cannot see exists. **403** means you are a member but the action is not yours (out of your
  reach, configuration, intake decisions, deleting).
- **Approval.** Only DELETE operations are sensitive (the default), and none of them is an MCP
  tool. Over REST, with human approval on, they may come back `202 KITSUDEN_E_APPROVAL_REQUIRED`:
  report it, do not retry.
- **Idempotency.** POSTs are not idempotent: pass `idempotency_key` (MCP) or `Idempotency-Key`
  (REST) when retrying `agile_create_issue`, `agile_comment` or `agile_submit_intake`, or you may
  create two.
- **Refused on purpose:**
  - Creating a project: only a human admin or editor (gate `agile:create-project`).
  - Writing on an issue assigned to someone outside your reach, or assigning outside your squad:
    403 from the route, and the database refuses it too (`agile_agent_reach`).
  - Changing states, cycles, modules, labels, fields, initiatives, squads, schedules; approving
    or declining intakes; deleting issues; sharing views; requesting work: never an agent (403).
  - The `admin` scope does not make an agent a project admin: project checks read the account
    role.
  - References across projects (a state, cycle, module, parent, initiative or assignee of another
    project): 422.
  - Entering a state whose validations fail (assignee, estimate, description): 422.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | `defineKonSdk` definition; starts and stops the one-minute `tick` timer; admin view list |
| `kon.json` | Manifest: id, version, mount, tables, enums, admin views, MCP tool list, dependencies |
| `operations.ts` | `KON_ID`, `AGENT_TOOLS` (MCP names), `registry()`, `ANY_ACCOUNT`, `REST_ONLY`, `declareOp`, shared schemas |
| `agile.operations.ts` | `get-board` and `propose-intake` (`agile_read_board`, `agile_submit_intake`) |
| `agile.routes.ts` | Projects, members, issues, comments, intakes, cycles and modules lists; `agileShared`, `allAgileOperations`, `createAgileRouter` |
| `agile.planning.ts` | Labels, states, estimates, links, cycles, modules, delete/archive, sub-issues, history, checklists, custom fields, initiatives |
| `agile.team.ts` | Squads, hand-offs, notifications, work queue, agent schedules |
| `agile.views.ts` | Saved views, calendar, timeline, dashboard |
| `agile.workflow.ts` | `prepareIssue`/`afterIssue` (state validations, auto-assign, notifications, queue rows, `agile:agent_work` event) and `tick` |
| `agile.access.ts` | Membership role, `projectFor` (404/403), agent reach, same-project checks |
| `agile.policy.ts` | Policies `agile_project` (view, propose, write, manage) and `agile` (`actAsUser`); gate `agile:create-project` |
| `agile.query.ts` | Issue filters and grouping shared by lists, views, calendar and timeline |
| `agile.fields.ts` | Validates custom field values against the project's definitions |
| `agile.schema.ts` | Drizzle tables and enums |
| `agile.db.ts` | `AgileDb` type |
| `http-errors.ts` | Error translation: no Postgres text to the client |
| `admin-src/` | Svelte 5 source of the admin panel (`Workspace.svelte`, `sections/`, `ui/`, copied `tallao/`) |
| `admin/workspace.js` | Built admin panel (generated; do not edit) |
| `migrations/` | SQL 0000-0005 and `history.json` |
| `MCP_EXAMPLE.md` | MCP tools and an example call |

## Rules that must hold

- **Membership decides everything**, in the route (`agile.access.ts`) and in the database (forced
  RLS). Guards: `tests/unit/kon-agile-security.test.ts` ("an account that is not in the project",
  "no IDOR between projects", "RLS: the database filters even if the route failed").
- **Agent reach** is enforced twice: `agile.access.ts` gives the 403, `agile_agent_reach` in
  migration 0005 refuses the write. Guard: `tests/unit/kon-agile-teammates.test.ts` ("an agent
  writes only on its own issues", "a scrum master agent acts on its squad").
- **Only the listed tools go out through MCP**: configuration, intake decisions and deletes stay
  REST only. Guard: `tests/unit/agile-operations-mcp.test.ts` ("the board, the intake and the
  teammate tools, nothing else").
- **An intake never creates an issue by itself**; a person approves it.
- **Authors come from the session** (`createdBy`, `decidedBy`, comment authors), never the body.
- **Every issue change goes through `prepareIssue`/`afterIssue`** so state validations, automation,
  notifications and queue rows apply to every path. Guard: "hand-offs, mentions and the work
  queue", "planning".
- **A piece of work is claimed once**; `tick` uses conditional updates so several workers do not
  repeat work.
- **Closing a cycle carries unfinished issues** to the next one.

## Changing it

- New migration: the next number in `migrations/` (now `0006_...sql`). Never edit an applied one.
  `migrations/history.json` records renamed files and earlier checksums; touch it only when
  renaming or rewording an applied migration. New tables need forced RLS by membership, and the
  agent rule if agents may write them.
- A new operation an agent should use: add it to `AGENT_TOOLS` and update the expected list in
  `tests/unit/agile-operations-mcp.test.ts`, `kon.json` `mcp.tools` and `MCP_EXAMPLE.md`.
  Otherwise declare it with `declareOp` (REST only).
- Admin panel: edit `admin-src/`, then `pnpm build:admin kon-agile` and `pnpm check:admin`. After
  changing the tallao kit, `TALLAO_DIR=<tallao checkout> pnpm sync:tallao kon-agile`.
- New file at the kon's root: run `pnpm kon:sync` (it updates package.json `files` and kon.json).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- Operation ids and MCP tool names are part of the contract: do not rename them.

## Tests

```bash
pnpm vitest run tests/unit/kon-agile-security.test.ts     # routes, membership, RLS
pnpm vitest run tests/unit/kon-agile-teammates.test.ts    # agent reach, squads, queue, planning
pnpm vitest run tests/unit/agile-operations-mcp.test.ts   # after touching AGENT_TOOLS or agile.operations.ts
```

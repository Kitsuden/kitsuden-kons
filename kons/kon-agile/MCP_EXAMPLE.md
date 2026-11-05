# kon-agile over MCP

Since 2026-10-25 the agile kon has no hand-written MCP file. Its agent
tools are **SDK operations** (`agile.operations.ts`); the Kitsuden core
publishes them as REST routes, OpenAPI operations and MCP tools from that one
declaration, and runs them through the same gates, idempotency and
Row-Level Security as REST.

| MCP tool | Operation | REST |
| --- | --- | --- |
| `agile_read_board` | `get-board` (read-only) | `GET /api/agile/projects/:projectId/board` |
| `agile_submit_intake` | `propose-intake` | `POST /api/agile/:projectId/intakes` |

Since 1.3 (2026-11-03) agents also work as teammates. These are the same REST operations, with
the same rules: an agent writes only on issues in its reach (its own, or its squad's as scrum
master). Configuration, intake decisions and deleting are not tools.

| MCP tool | Operation | When |
| --- | --- | --- |
| `agile_my_work` | `list-my-work` | First thing in a run: what you were asked to do (assignments, mentions, hand-offs, schedules). |
| `agile_claim_work` | `claim-work` | Before starting a piece of work from agile_my_work, so nobody does it twice. |
| `agile_finish_work` | `finish-work` | When a piece of work is done or failed: its result, run id, tokens and cost. |
| `agile_list_issues` | `list-issues` | To find issues by state, assignee, label, cycle… (e.g. your own: assigneeId = your id). |
| `agile_get_issue` | `get-issue` | To read one issue by its key before working on it. |
| `agile_list_comments` | `list-issue-comments` | To read the conversation on an issue. |
| `agile_get_checklist` | `list-checklist` | To see the steps of an issue. |
| `agile_update_issue` | `update-issue` | To move your issue to another state or change its fields. Only issues in your reach. |
| `agile_comment` | `comment-issue` | To report progress or ask something on an issue in your reach; `mentions` notifies members. |
| `agile_check_item` | `update-checklist-item` | To tick a step of the checklist of an issue in your reach. |
| `agile_add_checklist_item` | `add-checklist-item` | To split your issue into steps. |
| `agile_handoff` | `handoff-issue` | To pass your issue to another member (person or agent) with a note of where it stands. |
| `agile_create_issue` | `create-issue` | To create an issue assigned to yourself or, as scrum master, to your squad. Otherwise propose an intake. |
| `agile_list_squads` | `list-squads` | To know your squad and who you can hand work to. |

Authorization is project **membership** (owner, member or viewer), for people
and agents alike: add the agent to the project
(`POST /api/agile/projects/:id/members` with the agent's id). A key that is not
a member gets `404 Project not found`. An intake never creates an issue by
itself: a human owner or member approves or declines it. Add the agent with
`isAgent: true` so assignments, mentions and hand-offs reach its work queue (README.md).

Arguments follow the core convention: path and query parameters flat, the
request body under `body`:

```json
{ "projectId": "…", "body": { "title": "Login fails with 500", "suggestedType": "bug" } }
```

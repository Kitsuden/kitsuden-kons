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

Since 1.4, with the same rule:

| MCP tool | Operation | When |
| --- | --- | --- |
| `agile_search` | `search-issues` | To find issues by words in their title, description or comments; answers a short snippet, not the whole issue. |
| `agile_bulk_update` | `bulk-update-issues` | To apply the same change (state, sprint, assignee, labels, archive) to many issues in one call instead of one per issue. |
| `agile_link_issues` | `link-issues` | To mark that your issue blocks, relates to or duplicates another issue of the project. |
| `agile_list_links` | `list-issue-links` | To see what an issue blocks or is blocked by. |
| `agile_list_attachments` | `list-attachments` | To see the files attached to an issue. |
| `agile_attach_file` | `attach-file` | To attach a file you uploaded to the media library (its media id) to an issue in your reach. |
| `agile_log_time` | `log-time` | To record minutes spent on an issue in your reach. |
| `agile_issue_cost` | `issue-cost` | To know what an issue cost so far: people's hours and agents' runs, tokens and USD. |
| `agile_list_pull_requests` | `list-pull-requests` | To see the GitHub pull requests that mention an issue and their state. |
| `agile_follow_issue` | `subscribe-issue` | To hear about the comments and state changes of an issue you are not assigned to. |

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

Since 1.5 `agile_list_comments` takes an optional page: `{ "key": "PLAT-12", "limit": 50, "offset": 0 }`
answers at most 50 comments and `hasMore: true` when more follow. Without `limit` it answers every
comment, as before.

# AGENTS.md — kon-crm

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

A CRM backend mounted at `/api/crm`: companies, contacts, pipelines, deals, activities, intake,
client portal, scoring, observed data weighed by evidence, and billing through kon-conta. People
and agents use the same operations; some decisions are kept for people. Human docs:
[README.md](README.md). The agent working guide is [AGENT_GUIDE.md](AGENT_GUIDE.md), served live by
`crm__get-agent-guide`.

## Calling it

- **Scopes.** The host's staff gate lets an agent into `/api/crm` with `crm:*`, `kon:crm:*`,
  `admin`, or the fine scope of the operation it calls (`kon:crm:list-deals`). `crm:*`,
  `kon:crm:*` and `admin` make the agent a CRM admin (delete and configure too). For a narrower
  agent, list fine scopes: read, for example `kon:crm:list-deals`, `kon:crm:get-deal`,
  `kon:crm:count-deals`; write, `kon:crm:update-deal`, `kon:crm:move-deal`,
  `kon:crm:create-activity`, `kon:crm:record-observation`. Policy scopes alone (`crm:view`,
  `crm:edit`) do not pass the host's gate.
- **Read-all** needs `crm:read-all` (or a grant by a person). Without it an agent sees no notes
  (contact notes, activity bodies, lost-deal notes) and no sensitive fields; amounts depend on the
  `money` dial. A hidden value is absent, not empty: never conclude "none" from it. Call
  `crm__get-my-access` first.
- **MCP tools** are `crm__<operation>`. Ask for a group with `kon:crm/<group>`: `assistant`,
  `sales`, `research`, `intake`, `billing` (`crm.agents.ts`). Arguments: path and query flat, body
  under `body`.
- **Not MCP tools**, and 403 to an agent over REST: `grant-access`, `revoke-access` (configure is
  admin; granting is a person's decision), `accept-observation`, `reject-observation`,
  `decide-merge-request`, `create-portal-link`. Public callers only: `submit-capture-form`,
  `read-client-portal`, `receive-inbound-email`.
- **Merges.** `crm__merge-contacts` from an agent never merges: it answers 202 with a merge request
  a person decides. Report it; do not retry.
- **Approval.** `grant-access`, `update-evidence-policy`, `apply-preset`, `create-capture-form`,
  `update-capture-form`, `create-portal-link`, `update-score-model` and every DELETE are
  sensitive: with human approval on they come back `202 KITSUDEN_E_APPROVAL_REQUIRED`. Report the
  proposal; do not retry.
- **404** means missing or outside your `records` dial (assigned or created by you). **403** on a
  filter or `groupBy` by a custom field means you cannot read that field. **409** on billing
  routes means kon-conta is not installed; on a merge, `error.details.conflicts` to resolve.
- **Idempotency.** POSTs are not idempotent; send `idempotency_key` when retrying
  `create-deal`, `create-activity`, `capture-lead` or `log-deal-work`.
- **Refused on purpose:**
  - Writing an amount without the `money` dial (403): a blind write could probe a value.
  - An activity `kind` not in this installation's list (`list-activity-kinds`): 422.
  - `skipValidation` on `move-deal` unless admin; a target stage of another pipeline (422).
  - Sending a confidence with `record-observation`: give the evidence kind and source instead.
  - Overwriting a value a person typed: it waits as a suggestion.
  - Granting yourself or another agent access, even through an approved proposal.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | `defineKonSdk` definition; rate limits of the public routes; `mcpToolsets`; startup registers the kon's emails; exports of dedupe and capture helpers |
| `kon.json` | Manifest: id, version, mount, tables, admin views and dependencies (`kons`, `core`, `optionalKons`); `index.ts` reads both lists from here |
| `operations.ts` | `KON_ID`, `registry()` (every response passes `checkWrite` and `applyAccess`), `VIEW`/`EDIT`/`DELETE`/`CONFIGURE`, `requiresEdit` |
| `crm.routes.ts` | Companies, contacts, pipelines, stages, deals, board, activities, stats, entities, moves, history, cycle times, documents; `createCRMRouter` |
| `crm.access.ts` | Access dials, `withoutMoney`, `checkWrite`, `applyAccess`, the access grant operations |
| `crm.agents.ts` | `CRM_TOOLSETS` and `get-agent-guide` |
| `crm.automation.ts` | Stage enter/exit actions run on `move-deal` |
| `crm.billing.ts` | Deal project, billing clients, work and expenses through kon-conta's bridge |
| `crm.capture.ts` | `planCapture`: turns a form submission into a plan |
| `crm.dedupe.ts` | Normalization, `scorePair`, `findDuplicates`, `planMerge` |
| `crm.intake.ts` | Capture, exclusion list, duplicates, merges and merge requests |
| `crm.import.ts` | CSV import with preview |
| `crm.public.ts` | Capture forms, public form submission, portal links and the client portal |
| `crm.inbound.ts` | Inbound email: provider signatures, sender list, SPF/DKIM, recording, the receipts list |
| `crm.evidence.ts` | Evidence policy and observations |
| `crm.scoring.ts` | Score model, versions and scoring |
| `crm.records.ts` | Activity reopen, activity kinds, documents across deals |
| `crm.work.ts` | Task inbox, agenda, deal contacts, saved views, document templates |
| `crm.presets.ts` | Presets from `presets/` and applying them (with kon-conta's words) |
| `crm.entities.ts` | Entities, fields, activity kinds, numbering |
| `crm.events.ts` | `emitCrm`: events after commit, ids only |
| `crm.mails.ts` | The kon's email templates, registered at startup |
| `crm.policy.ts` | Policies `crm` and `crm-authorship` |
| `crm.context.ts` | `dbDe` and `userOf` for the request |
| `crm.schema.ts`, `crm.db.ts` | Drizzle tables and enums; `CrmDb` type |
| `presets/law-firm.json` | The example preset |
| `admin-src/` | Svelte source of the two admin views (`CrmSettings.svelte`, `CrmSetup.svelte`, copied `tallao/`) |
| `admin/settings.js`, `admin/setup.js` | Built admin views (generated; do not edit) |
| `migrations/` | SQL 0000-0012 and `history.json` |
| `tests/` | Route registration and schema tests (vitest), a Playwright spec, `tests/README.md` |

## Rules that must hold

- **Every response goes through `applyAccess`, every write through `checkWrite`** (`registry()` in
  `operations.ts`). A new list must not filter or sort by amount without checking `money`. Guards:
  `tests/unit/kon-crm-access.test.ts`, `tests/unit/kon-crm-practice.test.ts` ("notes about
  people", "amounts").
- **Only a person grants access, decides merges, settles suggestions and opens portal links.**
  Guards: `kon-crm-access.test.ts`, `kon-crm-evidence.test.ts` ("a person settles the
  suggestions"), `kon-crm-practice.test.ts` ("merges by agents").
- **Nothing merges automatically**; two signals are needed and the oldest contact survives.
  Guards: `tests/bun/crm-dedupe-capture.test.ts`, "duplicates and merging".
- **Having an account is not being on the team**; delete and configure are admin. Guard:
  `tests/unit/kon-crm-security.test.ts`.
- **Stage requirements are checked on every move**; a failed stage action never undoes the move.
  Guards: "moving opportunities respects the stages", "stage automation".
- **Public routes reveal nothing**: a form always answers 202 once it exists; any bad portal token
  is 404. Guards: "public forms", "client portal".
- **Inbound email locks stay closed by default** (empty sender list rejects all). Guard:
  `tests/unit/kon-crm-inbound.test.ts`.
- **Events carry ids, never values.** Guard: `kon-crm-agents.test.ts` ("what the CRM announces").
- **The billing bridge is loaded by path at runtime**, so the kon works without kon-conta. Guard:
  `tests/unit/kon-crm-conta-bridge.test.ts`.

## Changing it

- New migration: the next number in `migrations/` (now `0013_...sql`). Never edit an applied one.
  `migrations/history.json` records renamed files and earlier checksums; touch it only when
  renaming or rewording an applied migration. New tables need the team RLS and, for records, the
  `crm_can_see` rule.
- A new write that touches amounts or an entity's fields: add it to `WRITES` in `crm.access.ts`.
- A new operation an agent should get: add it to the right group in `CRM_TOOLSETS`. A decision for
  a person: `mcp: { exclude: "..." }` and refuse agents in the handler.
- Admin views: edit `admin-src/`, then `pnpm build:admin kon-crm` and `pnpm check:admin`.
- New file at the kon's root: run `pnpm kon:sync` (it updates package.json `files` and kon.json).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- Operation ids are the MCP tool names and fine scopes: do not rename them.

## Tests

```bash
pnpm vitest run tests/unit/kon-crm-security.test.ts      # routes, policy, RLS
pnpm vitest run tests/unit/kon-crm-access.test.ts        # dials, grants, intake, merges
pnpm vitest run tests/unit/kon-crm-agents.test.ts        # toolsets, guide, events
pnpm vitest run tests/unit/kon-crm-records.test.ts       # records, work, documents, portal
pnpm vitest run tests/unit/kon-crm-evidence.test.ts      # observations
pnpm vitest run tests/unit/kon-crm-inbound.test.ts       # inbound email
pnpm vitest run tests/unit/kon-crm-practice.test.ts      # end to end with a preset
pnpm vitest run tests/unit/kon-crm-conta-bridge.test.ts  # billing
pnpm vitest run tests/unit/crm-filters.test.ts           # custom field filters
pnpm vitest run kons/kon-crm/tests/crm.routes.test.ts    # route registration
pnpm test:bun                                            # dedupe and capture
```

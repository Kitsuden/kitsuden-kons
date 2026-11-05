# AGENTS.md — kon-directory

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

An employee directory: organizations, departments, positions, employee profiles and their
documents, org chart, reporting chain, search and headcount stats. Mounted at `/api/directory`.
What a caller sees of each profile depends on who they are (public card, colleague, owner, HR).

## Calling it

- The host's gate lets only signed-in callers (accounts or agent keys) into `/api/directory`.
- Read: any agent key reaches the read tools, and sees what a signed-in user without a profile
  sees: public cards of active, visible employees, the structure, no e-mails or phones, no
  documents, no stats.
- Write, and read everything: HR. For an agent that is `directory:*`, `kon:directory:*` or
  `admin`. Example key: `["mcp:connect", "directory:*"]`.
- Fine scopes (`kon:directory:create-employee`, …) or the policy scopes
  (`directory-employee:manage`, `directory-structure:manage`, `directory-document:manage`) pass
  the route check, but several handlers check HR again with `isHr()` (which only accepts the
  scopes above), and row security plus the HR-fields trigger on `directory_employees` and
  `directory_employee_documents` only admit HR as defined above. Use `directory:*` for HR work.
- MCP tools are `directory__<op>`; each returns the same JSON as its route (see the README's
  [HTTP API](README.md#http-api)): lists as `{ docs }`, creations as the new row (201), the org
  chart as `{ organizationId, roots, totalEmployees }`, the chain as `{ chain }`, stats as counts.
- `directory__offboard-employee` (`DELETE /api/directory/employees/:id`) is sensitive: it may
  come back `202 KITSUDEN_E_APPROVAL_REQUIRED`. Report the proposal and do not retry.
- 404 means missing, or hidden from you: a hidden or inactive profile, someone else's documents,
  an inactive organization or department. A malformed uuid in the path is also 404.
- 409: duplicate slug, employee number in the organization, or e-mail.
- Idempotency: `PATCH` and `DELETE` are idempotent; the `POST` creations are not. Send an
  `idempotency_key` (MCP) or `Idempotency-Key` (REST) when you may retry; a retry without one
  gets 409 on a duplicate slug or number, or a second document.
- Refused on purpose: `uploadedById` in a document body (the uploader is the caller);
  `status` filtering and e-mail search for non-HR (ignored, not an error); an employee changing a
  non-personal field of their own profile (403); hard deletion of employees (offboarding is a
  soft delete). There are no routes to edit or delete organizations, departments, positions or
  documents.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | Kon definition; `createRouter` replaced by `createDirectoryRouter`. |
| `operations.ts` | `KON_ID`, operation registry, `manages()` and `ON_THE_RECORD` permissions, shared output schemas. |
| `directory.routes.ts` | The nineteen operations, per-viewer projections (`PUBLIC_COLUMNS`, `COLLEAGUE_FIELDS`, `HR_LIST_COLUMNS`), personal vs HR field lists, `createDirectoryRouter`. |
| `directory.policy.ts` | Policies `directory-employee`, `directory-structure`, `directory-document`, `directory-stats`; `isHr()`. |
| `directory.context.ts` | Per-request `db` and user (`rlsContext`, `dbDe`, `userOf`). |
| `directory.db.ts` | Drizzle database type bound to the schema. |
| `directory.schema.ts` | Drizzle tables and enums. |
| `migrations/` | `0000`-`0006` and `history.json`. |
| `kon.json`, `package.json`, `tsconfig.json` | Manifest, package, compiler settings. |

## Rules that must hold

| Rule | Where | Guarded by |
| --- | --- | --- |
| Non-HR callers get projections, never whole rows: public card for anyone, plus work e-mail, phone and timezone for colleagues of the same organization. | `project()` in `directory.routes.ts` | `tests/unit/kon-directory-security.test.ts` |
| An employee edits only `PersonalFields` of their own active profile; any HR field is 403 in the app and refused by the trigger in the database. | `directory.routes.ts`, `directory_protect_hr_fields` in `migrations/0006_english_rls.sql` | `kon-directory-security.test.ts` ("A cannot raise their own salary band even with direct SQL") |
| An editor is not HR; HR is `isEffectiveAdmin(user, "directory")` in the app and `kitsuden_effective_admin('directory')` in SQL. | `directory.policy.ts`, migrations | `kon-directory-security.test.ts` |
| Confidential documents are HR only; the owner sees their other documents; others get 404. | policy + RLS | `kon-directory-security.test.ts` |
| Management checks run before the body is validated (403 before 422). | `manages()` in `operations.ts` | `kon-directory-security.test.ts` |
| The uploader of a document comes from the session. | `add-employee-document` | `kon-directory-security.test.ts` |
| The reporting chain stops at 50 steps or on a cycle. | `get-reporting-chain` | `kon-directory-security.test.ts` |
| Queries run in series on the request transaction (no `Promise.all`). | `directory.routes.ts` | review |
| Search patterns escape `%` and `_`. | `patternValue()` | review |
| Headcounts are recounted on create, department change and offboarding. | `recount()` | review |

## Changing it

- New migration: the next number in `migrations/` (now `0007_…`). Never edit an applied one;
  `migrations/history.json` keeps accepted older checksums (`previousChecksums`) and the old names
  of renamed files (`renamed`). Add a `renamed` entry only when you rename a file.
- Adding an HR-only column: add it to `HrFields` and to the trigger
  `directory_protect_hr_fields` in a new migration (`CREATE OR REPLACE FUNCTION`), or an employee
  can change it through SQL. Adding a personal column: `PersonalFields` only.
- A new column that is personal data must not go into `PUBLIC_COLUMNS`.
- New file at the kon root: run `pnpm kon:sync` (updates `package.json` `files` and `kon.json`).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- Operation ids are part of the contract (MCP tool, fine scope, stored agent keys): do not rename.

## Tests

```bash
pnpm vitest run tests/unit/kon-directory-security.test.ts       # after any change here
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-directory"
```

# AGENTS.md — kon-academy-lms

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

A learning management system mounted at `/api/academy`: courses, modules, topics, quizzes,
assignments to users and groups, progress, learning paths, surveys and certificates. Who manages
is decided by the academy role in `training_user_profiles`, not the site role. Human docs:
[README.md](README.md), [SETUP.md](SETUP.md), [API.md](API.md).

## Calling it

- **Short name** `academy-lms`: MCP tools are `academy-lms__<operation>`, fine scopes
  `kon:academy-lms:<operation>`.
- **Learner routes** (my courses, topics, quizzes, surveys, certificates, groups, media helpers):
  the key must act as a user, with `user:act`, `admin`, or a scope starting with `academy-lms:` or
  `kon:academy-lms:`. The agent then acts as itself: it sees the courses assigned to its own id.
- **Manager routes** (assignments, reports, dashboard, profiles list, surveys list): the policy
  action `manage`, granted to an agent by `academy:manage`, `admin`, or the operation's fine
  scope. **Administrator routes** (content, groups, profiles, learning paths, deletes, sync):
  `academy:administer`, `admin`, or the fine scope. Note the policy resource is `academy`, not
  `academy-lms`. `academy:*`, `academy-lms:*` and `kon:academy-lms:*` open both.
- **Row security knows agent scopes** (migration `0009`, `kitsuden_agent_can_in_kon`): an agent
  with `academy:manage` (or administering) reads and writes the personal tables (progress,
  results, assignments, surveys, certificates, feedback) of every learner and reads the profiles;
  `academy:administer` also writes profiles. A managing agent is not limited to groups. A fine
  operation scope alone passes the route, but row security then shows the agent only its own rows.
- **Responses** are `{ <key>: [rows], total }` for lists, `{ success: true, <key>: row }` for
  writes, `{ success: true, message }` for writes without a row.
- **Validation** keeps the old `zValidator` behaviour: an invalid body is a **400** (not 422)
  with `{ success: false, error }`, and unknown fields are dropped silently.
- **404** means not found or not visible to you (a course not assigned to you, a group you are not
  in). 403 means you can see it but the action needs a role you lack, or a certificate you are not
  yet eligible for.
- **Approval.** Sensitive: `assign-courses-in-bulk`, `assign-learning-path`, `reorder-modules`,
  `reorder-topics`, `create-profile`, `change-profile-role`, and every DELETE. With human
  approval on they may come back `202 KITSUDEN_E_APPROVAL_REQUIRED`: report it, do not retry.
- **Idempotency.** POSTs are not idempotent: send `idempotency_key` / `Idempotency-Key` when
  retrying an assignment or a quiz answer (each answer spends an attempt).
- **Refused on purpose:**
  - More than 5 quiz attempts (429); retaking a passed quiz (409).
  - Reading correct options as a learner; they are returned only to managers.
  - Completing topics, rating topics or answering quizzes of courses not assigned to you (404).
  - Giving yourself an academy role; an inactive profile has no role.
  - A supervisor assigning outside the groups it supervises (403).
  - `sync-users` and `sync-users-csv` create or update academy profiles only for EXISTING
    accounts (`userId`, or `externalId` when it is the account id); they never create accounts.
    A row whose account does not exist is reported in `result.errors`.
  - PDF certificates and Excel exports are not MCP tools (binary output); `sync-users-csv` is not
    either (raw CSV body).

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | Re-exports `src/index.ts` |
| `src/index.ts` | `defineKonSdk` definition (tables and version from `kon.json`, startup table check, admin views) and re-exports of schema and services |
| `kon.json` | Manifest: id, version, mount, tables, admin views (the only list; `src/index.ts` reads it), `dependencies.kons` (kon-media) |
| `operations.ts` | `KON_ID`, `registry()`, permissions `ANY_ACCOUNT`, `MANAGE`, `ADMINISTER`, `inSeries`, `validatedAsBefore` |
| `schemas.ts` | Shared path parameters and output shapes |
| `academy-lms.routes.ts` | Every operation (`academyOperations`), the academy role lookup (`academyRoleOf`) and the course visibility checks |
| `academy-lms.schema.ts` | Drizzle tables and enums |
| `academy.policy.ts` | Policies `academy` (`manage`, `administer`, `actAsUser`) and `academy-course` (`view`); `agentManagesAcademy` / `agentAdministersAcademy` |
| `academy.queries.ts` | Reads without Drizzle's relational API (the host's instance does not carry the kon's relations) |
| `academy.db.ts` | `AcademyDb` type |
| `academy-lms.admin.ts`, `academy.admin.ts` | Admin view configuration objects; nothing in the kon imports them |
| `services/pdf.service.ts` | Certificate PDFs (`pdfkit`, or the optional `pdf-lib` over a template) and certificate codes |
| `services/excel.service.ts` | `.xlsx` exports with `exceljs` |
| `services/media.service.ts` | File validation, YouTube and video URL helpers, kon-media URLs |
| `services/user-sync.service.ts` | External user validation, CSV parsing, role mapping, `syncUsers` (writes profiles through a `SyncStore`) |
| `migrations/` | SQL 0000-0009 and `history.json` |
| `tests/academy-lms.test.ts` | Bun tests of the services |
| `tests/run-tests.sh`, `tests/youtube-examples.md` | Manual smoke test and YouTube examples |
| `README.md`, `SETUP.md`, `API.md` | Human docs |

## Rules that must hold

- **The academy role comes from `training_user_profiles`, active profiles only**, read per request;
  never from the body. Guard: `tests/unit/security-academy.test.ts` ("management: the role that
  counts is the academy's", "nobody promotes themselves", "a deactivated profile does not keep the
  role").
- **Course content only for assigned learners or managers** (`academy-course` policy). Guard:
  "content of a course: only whoever has it assigned".
- **Correct answers never reach a learner**, before or after answering. Guard: "correct answers do
  not come out before answering".
- **Quiz limits:** 5 attempts, no retake after passing, options must belong to their question.
  Guard: "quizzes: no shortcuts".
- **Progress is per person**; feedback does not reveal its author. Guard: "progress: each one
  their own".
- **Supervisors see only their groups' learners**, in the routes and in row security
  (`migrations/0004_supervisor_by_groups.sql`, functions in `0007_english_rls.sql`).
- **Agents in row security use the core's rule**, never a copy: `academy_agent_manages()` /
  `academy_agent_administers()` call `kitsuden_agent_can_in_kon` and match `agentManagesAcademy`
  / `agentAdministersAcademy`. Guard: `tests/unit/kon-academy-lms-agents-and-sync.test.ts`.
- **A sync never creates accounts** and only writes profiles of ids `ctx.auth.usersById` knows.
  Guard: the same file.
- **Certificate codes are unpredictable** and pass `validateCertificateCode`; an unknown course is
  404, not 403. Guard: "certificates".
- **No `Promise.all` on the request transaction**; use `inSeries`.
- **No relational `db.query.*` reads**: the host's Drizzle instance does not know this kon's
  relations. Guard: `tests/unit/academy-without-relational-api.test.ts`.
- **Tables come only from migrations**; `onStartup` only checks them.

## Changing it

- New migration: the next number in `migrations/` (now `0010_...sql`). Never edit an applied one.
  `migrations/history.json` records renamed files and earlier checksums; touch it only when
  renaming or rewording an applied migration. Personal tables need row security matching
  `0007_english_rls.sql`.
- Keep `validatesHandler: true` with `validatedAsBefore` on existing bodies unless you mean to
  change the 400 contract for clients.
- New file at the kon's root: run `pnpm kon:sync` (it updates package.json `files` and kon.json).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- Operation ids are part of the contract (MCP tool names and fine scopes).
- `pdfkit` and `exceljs` are regular dependencies in `package.json`; `pdf-lib` is optional (template
  certificates only).
- Admin views are declared once, in `kon.json`.

## Tests

```bash
pnpm vitest run tests/unit/security-academy.test.ts                # after touching routes, policy or RLS
pnpm vitest run tests/unit/kon-academy-lms-agents-and-sync.test.ts # agents in RLS, user sync
pnpm vitest run tests/unit/academy-without-relational-api.test.ts  # after touching reads or academy.queries.ts
pnpm test:bun                                                      # after touching services/
```

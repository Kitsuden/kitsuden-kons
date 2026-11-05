# AGENTS.md — kon-dms

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

A document management system: folders, documents with an ACL, semantic versions with a
review-and-publish workflow, files, diagrams, comments, read acknowledgments, notifications and an
audit log. Mounted at `/api/dms`. Every route needs a session.

## Calling it

- To enter at all, an agent key needs `user:act`, `admin`, or a scope of the kon's family
  (`dms:…`, `kon:dms:…`). `dms_document:view` alone is not of that family: 403 on every route
  (`tests/unit/effective-agents-in-kons.test.ts`).
- DMS admin (sees and does everything, in the app and in row security): `admin`, `dms:*` or
  `kon:dms:*`. Example key: `["mcp:connect", "dms:*"]`.
- With anything narrower, the agent is an account whose id is its identity's id: it sees only
  documents shared with that id (`allowedUserIds`, reviewer, approver, owner) or published as
  `public`. Creating documents, importing and creating from a template also need the gate scope
  `gate:dms:create` (or team rights); folders and the whole audit log need DMS admin.
- MCP tools are `dms__<op>` (see the README's table). They return the route's JSON: lists as
  `{ docs, … }` with pagination, single items as the row, the reader view as the rendered
  document with its table of contents.
- Sensitive, may return `202 KITSUDEN_E_APPROVAL_REQUIRED` (report it, do not retry):
  `dms__publish-version`, `dms__import-documents`, `dms__archive-document`, `dms__delete-comment`,
  `dms__delete-diagram`.
- 404 means the document (or its version, file, comment, diagram) does not exist or you cannot
  read it; the two are never told apart. 403 means you can read it but not do that. 409 means a
  state conflict (version not in the right status, published version, duplicate code or slug).
- Idempotent: `acknowledge-read` (a repeat answers `{ alreadyAcknowledged: true }`) and the two
  notification marks. Creations are not: send an `idempotency_key` when you may retry.
- Refused on purpose: unknown fields such as `createdById`, `isActive` or `force` (422); setting
  another `ownerId` unless admin; moving `status` outside the workflow with a `PATCH`; editing a
  published version; reviewing your own version or your own document (unless admin); linking to
  a document you cannot read (422, not 404); HTML or SVG with executable code. Uploading and
  downloading files are not MCP tools, and the host restricts them to admins.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | Kon definition, admin views, startup table check, re-exports; `createRouter` replaced by `createKonDMS`. |
| `operations.ts` | `KON_ID`, operation registry, `ANY_ACCOUNT` permission (the `actAsUser` rule). |
| `dms.routes.ts` | All 43 operations: validation schemas, sanitizing, numbering, workflow, files, export and import, search, render. |
| `dms.access.ts` | `permissions()` for one document, `readFilter()` SQL for lists, `canViewVersion()`. |
| `dms.policy.ts` | Registers the `dms_document` policy and the gates `dms:create`, `dms:folders`, `dms:auditoria`. |
| `http-errors.ts` | `translateError()`: Postgres errors to generic 400/409, everything else to a 500 without details. |
| `dms.db.ts` | Drizzle database type bound to the schema. |
| `dms.schema.ts` | Drizzle tables and enums. |
| `migrations/` | `0000`-`0010` and `history.json`. |
| `kon.json`, `package.json`, `tsconfig.json` | Manifest, package, compiler settings. |

## Rules that must hold

| Rule | Where | Guarded by |
| --- | --- | --- |
| One read rule in three forms: `permissions()`, `readFilter()` and the row security of `0010_english_rls.sql`. Change all three together. | `dms.access.ts`, migrations | `tests/unit/kon-dms-security.test.ts` ("RLS: the database filters even if the route failed") |
| A document the caller cannot read is 404 on every route that reaches it. | `dms.routes.ts` | `kon-dms-security.test.ts` |
| Readers see only published versions and no ACL fields; comments on hidden versions stay hidden. | `dms.routes.ts`, `canViewVersion` | `kon-dms-security.test.ts` |
| A published version is immutable; status only moves through submit, review, publish (or archive/deprecate by the owner, anything by admin). | `dms.routes.ts` | `kon-dms-security.test.ts` ("approval flow") |
| Nobody reviews their own version or document, except an admin. | `review-version` | `kon-dms-security.test.ts` |
| Effective admin is `isEffectiveAdmin(u, "dms")` in the app and `kitsuden_effective_admin('dms')` in `dms_is_system()`. Never `role === "admin"`. | `dms.access.ts`, migrations | `tests/unit/effective-agents-in-kons.test.ts` |
| The client's file name never becomes the storage key; HTML, SVG and scripts are refused as files; size up to 25 MB; sizes are `bigint`. | `dms.routes.ts`, `0008_sizes_as_bigint.sql` | `kon-dms-security.test.ts` ("files, export and diagrams") |
| HTML content and SVG diagrams with executable code are refused; HTML export is escaped and sandboxed. | `dms.routes.ts` | `kon-dms-security.test.ts` |
| Responses never carry storage location (`storagePath`, `publicUrl`, `storageBucket`). | `dms.routes.ts` (the helper that strips them) | review |
| Database errors never reach the client with internal details. | `http-errors.ts` | `kon-dms-security.test.ts` ("ids that are not uuid") |
| User ids are stored as text. | `0005_user_ids_and_rls.sql` | `kon-dms-security.test.ts` |
| An old slug redirects only a caller who can read the document. | `read-document` | `kon-dms-security.test.ts` |

## Changing it

- New migration: the next number in `migrations/` (now `0011_…`). Never edit an applied one;
  `migrations/history.json` keeps accepted older checksums (`previousChecksums`) and old file
  names of renamed migrations (`renamed`). Add a `renamed` entry only when you rename a file.
- Row security policies are dropped and recreated by name; when you change who can read, change
  `permissions()`, `readFilter()` and the policies in the same change.
- The full-text index and queries use the `spanish` text configuration
  (`0002_slug_history_and_fts.sql`, `search-documents`). Changing it needs a new index.
- New file at the kon root: run `pnpm kon:sync` (updates `package.json` `files` and `kon.json`).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- Operation ids and the gate names (`dms:create`, `dms:folders`, `dms:auditoria`) are stored in
  agent keys: do not rename them.

## Tests

```bash
pnpm vitest run tests/unit/kon-dms-security.test.ts              # after any change here
pnpm vitest run tests/unit/effective-agents-in-kons.test.ts      # policy, dms.access.ts, RLS
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-dms"
```

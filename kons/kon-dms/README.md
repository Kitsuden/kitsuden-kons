# kon-dms

A document management system for manuals, policies and procedures: folders, documents with
semantic versions, a review and publication workflow, per-document access control, comments,
diagrams, read acknowledgments and an audit log. For a team that publishes internal documentation
and needs to know who approved and who read what.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | business | 2.0.0 | `/api/dms` | — (core `auth`) |

## Install

```bash
kitsuden kon add dms --enable
```

`package.json` has `defaultEnabled: false`, so pass `--enable` (or switch it on in the admin
panel, **Kons**). Restart the API afterwards. On startup the kon logs a warning for each of its
tables that does not exist yet.

File attachments go to the host's storage (`ctx.storage`); downloads need a storage that can sign
URLs. No environment variables.

## What it adds

- **Folders** (`dms_categories`): a tree (materialized `path`), with `allowedRoles`: roles that may
  read the documents inside.
- **Documents** (`dms_documents`): metadata, a unique `code` and `slug`, type (`manual`, `policy`,
  `procedure`, `template`, `guide`, `training`, `report`, `other`), status (`draft`, `in_review`,
  `approved`, `published`, `archived`, `deprecated`), tags, and an ACL: owner, reviewers,
  approvers, allowed users and roles, and `visibility` (`private`, `restricted`, `internal`,
  `public`). A document can be a template and can require read acknowledgment.
- **Versions** (`dms_document_versions`): content in `markdown`, `html` or `raw`, numbered
  `major.minor.patch` by `changeType`. Status: `draft`, `review_pending`, `changes_requested`,
  `approved`, `published`, `rejected`. A published version is immutable.
- **Workflow**: draft → submit (`review_pending`) → review (`approved` or `changes_requested`) →
  publish. Each step notifies the people involved (`dms_workflow_notifications`).
- **Files** (`dms_document_files`), **diagrams** (`dms_document_diagrams`, embedded in content as
  `[[diagram:<id>]]`), **relations** between documents (`related`, `replaces`, `requires`,
  `supersedes`; `dms_document_relations`), **comments** with replies and resolution
  (`dms_document_comments`), **read acknowledgments** (`dms_document_acknowledgments`).
- **Wiki links**: `[[code]]` or `[[slug]]` in content; saving reports which links resolve, and
  backlinks list the documents pointing at one.
- **Slug history** (`dms_document_slug_history`): an old slug redirects to the current one.
- **Audit log** (`dms_access_log`): views, downloads and changes.
- **Search**: Postgres full-text search with the `spanish` text configuration (a persisted name in
  the migrations and queries) over published content, with a fallback on title, code and
  description.

## HTTP API

Every route needs a session (anonymous: 401). "Reader", "owner", "author", "reviewer",
"approver" are relative to the document; "team" is admin or editor. Lists are paginated with
`limit` and `page` where noted.

Folders:

| Route | Who may call it | What it does |
| --- | --- | --- |
| `GET /api/dms/categories` | Any account | Visible folders; `parentId`, `stats=true` (adds `documentCount`). |
| `POST /api/dms/categories` | Admin | Creates a folder; 409 if the slug is taken, 422 for an unknown parent. |
| `GET /api/dms/categories/tree` | Any account | Visible folders as a tree. |
| `GET /api/dms/categories/:id/export/zip` | Reader of the folder | The folder's published documents as a JSON manifest plus `files` (the shape `import` takes). |

Documents:

| Route | Who may call it | What it does |
| --- | --- | --- |
| `GET /api/dms/documents` | Any account | Documents the caller can read. Filters `categoryId`, `status`, `type`, `ownerId`, `tags`, `search`; `limit` 1-100, `page`. |
| `POST /api/dms/documents` | Team | Creates a document; with `content` or `changelog` also a draft 1.0.0. Owner is the caller unless an admin sets `ownerId`. 409 if `code` is taken. |
| `POST /api/dms/documents/from-template/:templateId` | Team | Copies a readable template into a new private document with a draft 1.0.0. |
| `GET /api/dms/documents/:id` | Reader | The document; `versions=true`, `relations=true`. Readers do not get the ACL fields. Counts a view. |
| `PATCH /api/dms/documents/:id` | Owner or author | Metadata. ACL fields: owner or admin. `status`: admin, or the owner to `archived`/`deprecated`. A new slug keeps the old one as a redirect. |
| `DELETE /api/dms/documents/:id` | Owner or admin | Archives (inactive and `archived`); nothing is erased. |
| `POST /api/dms/documents/:id/relations` | Owner or author | Links to another readable document; an unreadable target is 422. |
| `POST /api/dms/documents/:id/acknowledge` | Reader | Records reading the current published version; repeating answers `{ alreadyAcknowledged: true }`. |
| `GET /api/dms/documents/:id/acknowledgments` | Owner or author | Who acknowledged it. |
| `GET /api/dms/documents/:id/backlinks` | Reader | Readable documents whose published content links here. |
| `POST /api/dms/import` | Team | Imports the output of the folder export as private drafts owned by the caller. |

Versions, files and diagrams:

| Route | Who may call it | What it does |
| --- | --- | --- |
| `GET /api/dms/documents/:id/versions` | Reader | Versions, newest first; readers only get published ones. |
| `POST /api/dms/documents/:id/versions` | Owner or author | New draft; number from `changeType` (default `minor`). |
| `GET /api/dms/versions/:versionId` | Reader (published) or participant (drafts) | A version; `files=true` adds its files. |
| `PATCH /api/dms/versions/:versionId` | Owner or author | Edits a `draft` or `changes_requested` version; published is 409. |
| `POST /api/dms/versions/:versionId/submit` | Owner or author | To `review_pending`; notifies reviewers. |
| `POST /api/dms/versions/:versionId/review` | Team reviewer or approver | `decision` (`approved` or `changes_requested`), optional `notes`. Not the version's author nor the document's owner, unless admin. |
| `POST /api/dms/versions/:versionId/publish` | Approver or owner | Publishes an `approved` version; it becomes current and the document `published`. |
| `GET /api/dms/versions/:versionId/export/html` | As the version | Standalone HTML, escaped, with a sandbox Content-Security-Policy. |
| `GET /api/dms/versions/:versionId/export/md` | As the version | Markdown attachment. |
| `POST /api/dms/versions/:versionId/files` | Admin (host gate); owner or author in the kon | Multipart `file`, up to 25 MB, to an editable version. Office, PDF, ZIP, text, CSV, Markdown and raster images only. |
| `GET /api/dms/files/:fileId/download` | Admin (host gate); as the version in the kon | 302 to a signed storage URL valid 5 minutes. Counts a download. |
| `GET /api/dms/versions/:versionId/diagrams` | As the version | The version's diagrams. |
| `POST /api/dms/versions/:versionId/diagrams` | Owner or author | Adds a diagram to an editable version; an SVG with executable code is 422. |
| `PATCH /api/dms/diagrams/:diagramId` | Owner or author | Updates a diagram of an editable version. |
| `DELETE /api/dms/diagrams/:diagramId` | Owner or author | Deletes a diagram of an editable version. |

Comments:

| Route | Who may call it | What it does |
| --- | --- | --- |
| `GET /api/dms/documents/:id/comments` | Reader | Top-level comments with replies; `resolved`, `limit`, `page`. Readers do not see comments on versions they cannot see. |
| `POST /api/dms/documents/:id/comments` | Reader | Adds a comment, optionally on a visible version or as a reply. |
| `PATCH /api/dms/comments/:commentId` | Comment author | Edits the text. |
| `DELETE /api/dms/comments/:commentId` | Comment author, or whoever edits the document | Deletes the comment. |
| `POST /api/dms/comments/:commentId/resolve` | Comment author, or whoever edits the document | Marks it resolved. |

Reading, search and the rest:

| Route | Who may call it | What it does |
| --- | --- | --- |
| `GET /api/dms/render/:slug` | Reader | Reader view of the current published version: header ids, diagrams, table of contents, breadcrumb, previous and next. An old slug answers 308. |
| `GET /api/dms/render/code/:code` | Reader | 307 redirect to the reader view by code. |
| `GET /api/dms/search` | Any account | Full-text search over readable documents (`q` 2-200 chars), plus up to 10 folders. Filters `categoryId`, `type`, `status`; `limit` 1-50. |
| `GET /api/dms/stats` | Any account | Counts over readable documents, reviews due in 30 days, versions pending the caller's review. |
| `GET /api/dms/audit-log` | Admin; or owner or author with `documentId` | The access and change log; filters `documentId`, `userId`, `action`. |
| `GET /api/dms/notifications` | Any account | The caller's workflow notifications; `unreadOnly=true`. |
| `POST /api/dms/notifications/:id/read` | The notification's recipient | Marks one as read. |
| `POST /api/dms/notifications/read-all` | Any account | Marks all of the caller's as read. |

Unknown body fields give 422. HTML content and SVG diagrams with executable code are refused
(422). Database errors reach the client as generic 400/409 messages (`http-errors.ts`), never
with table or column names. There are no routes to edit or delete folders.

## Who can do what

Rules live in `dms.access.ts` (`permissions()` for one document, `readFilter()` for lists) and are
registered as the `dms_document` policy in `dms.policy.ts`, with three gates: `dms:create` (team:
create, import, from template), `dms:folders` (admin: folders) and `dms:auditoria` (admin: the
whole audit log; a persisted gate name).

| Role on a document | Can |
| --- | --- |
| Admin (human, or an agent with `admin`, `dms:*` or `kon:dms:*`) | Everything. |
| Owner (`ownerId`) | Read, drafts, edit, ACL, archive, publish. |
| Author (`createdById`) | Read, drafts, edit. |
| Reviewer / approver | Read, drafts, review; an approver also publishes. |
| Reader | The document and its published versions only. Who is a reader depends on `visibility`: `private` = `allowedUserIds`; `restricted` adds `allowedRoleIds` and the folder's `allowedRoles`; `internal` adds the team once published; `public` adds any account once published. |
| Editor (team) | Creates documents, imports, creates from templates; reads published `internal` documents. |

Row security (`migrations/0010_english_rls.sql`) repeats the read rule in the database for
`dms_documents`, `dms_document_versions`, `dms_document_files`, `dms_document_relations`,
`dms_document_comments`, `dms_document_diagrams`, `dms_document_slug_history` and
`dms_access_log`; `dms_is_system()` lets the system and effective DMS admins through. A document
the caller cannot read answers 404 everywhere (by id, version, file, export, comments), never 403.
403 means the caller can read it but not do that.

The host adds one gate: `POST /api/dms/versions/:versionId/files` and
`GET /api/dms/files/:fileId/download` are admin only, because files go to the host's public media
store.

## Configuration

None. The kon reads no environment variables or settings. It uses the host's storage for files.

## Agents and MCP

Each operation is an MCP tool `dms__<op>` with the fine scope `kon:dms:<op>`. Sensitive ones may
need human approval.

| Operation | Route | Writes |
| --- | --- | --- |
| `list-folders` | `GET /api/dms/categories` | no |
| `create-folder` | `POST /api/dms/categories` | yes |
| `get-folder-tree` | `GET /api/dms/categories/tree` | no |
| `list-documents` | `GET /api/dms/documents` | no |
| `create-document` | `POST /api/dms/documents` | yes |
| `get-document` | `GET /api/dms/documents/:id` | no (counts a view) |
| `update-document` | `PATCH /api/dms/documents/:id` | yes |
| `archive-document` | `DELETE /api/dms/documents/:id` | yes, sensitive |
| `create-document-from-template` | `POST /api/dms/documents/from-template/:templateId` | yes |
| `list-versions` | `GET /api/dms/documents/:id/versions` | no |
| `create-version` | `POST /api/dms/documents/:id/versions` | yes |
| `get-version` | `GET /api/dms/versions/:versionId` | no |
| `update-version` | `PATCH /api/dms/versions/:versionId` | yes |
| `submit-version-for-review` | `POST /api/dms/versions/:versionId/submit` | yes |
| `review-version` | `POST /api/dms/versions/:versionId/review` | yes |
| `publish-version` | `POST /api/dms/versions/:versionId/publish` | yes, sensitive |
| `create-relation` | `POST /api/dms/documents/:id/relations` | yes |
| `acknowledge-read` | `POST /api/dms/documents/:id/acknowledge` | yes |
| `list-read-acknowledgments` | `GET /api/dms/documents/:id/acknowledgments` | no |
| `list-comments` | `GET /api/dms/documents/:id/comments` | no |
| `create-comment` | `POST /api/dms/documents/:id/comments` | yes |
| `update-comment` | `PATCH /api/dms/comments/:commentId` | yes |
| `delete-comment` | `DELETE /api/dms/comments/:commentId` | yes, sensitive |
| `resolve-comment` | `POST /api/dms/comments/:commentId/resolve` | yes |
| `list-incoming-links` | `GET /api/dms/documents/:id/backlinks` | no |
| `export-version-markdown` | `GET /api/dms/versions/:versionId/export/md` | no |
| `export-folder` | `GET /api/dms/categories/:id/export/zip` | no |
| `list-diagrams` | `GET /api/dms/versions/:versionId/diagrams` | no |
| `create-diagram` | `POST /api/dms/versions/:versionId/diagrams` | yes |
| `update-diagram` | `PATCH /api/dms/diagrams/:diagramId` | yes |
| `delete-diagram` | `DELETE /api/dms/diagrams/:diagramId` | yes, sensitive |
| `import-documents` | `POST /api/dms/import` | yes, sensitive |
| `get-audit` | `GET /api/dms/audit-log` | no |
| `list-notices` | `GET /api/dms/notifications` | no |
| `mark-notice-read` | `POST /api/dms/notifications/:id/read` | yes |
| `mark-notices-read` | `POST /api/dms/notifications/read-all` | yes |
| `read-document` | `GET /api/dms/render/:slug` | no |
| `get-stats` | `GET /api/dms/stats` | no |
| `search-documents` | `GET /api/dms/search` | no |

Not MCP tools: `upload-file` (multipart), `download-file` and `open-document-by-code` (browser
redirects) and `export-version-html` (a page for the browser). Details for agents:
[AGENTS.md](AGENTS.md).

## Tests

`tests/unit/kon-dms-security.test.ts` covers anonymous access, accounts without permission,
per-document permissions, comments, the approval flow, folders and groups, the field allowlist,
files (path traversal, types, sizes over 2 GB), HTML and SVG sanitizing, audit, and row security
in the database. `tests/unit/effective-agents-in-kons.test.ts` checks that agents with `admin` or
`dms:*` see documents that are not theirs.

```bash
pnpm vitest run tests/unit/kon-dms-security.test.ts
pnpm vitest run tests/unit/effective-agents-in-kons.test.ts
```

## License

MIT

# AGENTS.md — kon-comments

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

Polymorphic comments: a thread hangs from `(subjectType, subjectId)`, where the type is one of
`COMMENTABLE_SUBJECTS` in `@kitsuden/shared` (`blog_post`, `block_page`, `wiki_page`). Replies up
to depth 3, one vote per account, and moderation by status (`published`, `pending`, `hidden`).

## Calling it

- **Scopes.** Reading a thread needs nothing. Writing needs a scope; an agent never passes as a
  person in the policy (`isPerson` excludes `role: "agent"`).
  - Post and vote: `kon:comments:create-comment`, `kon:comments:vote-comment`, or the policy scopes
    `comments:create`, `comments:vote`.
  - Moderate: `kon:comments:moderation-queue`, `kon:comments:moderate-comment`,
    `kon:comments:moderate-in-bulk`, or `comments:moderate`.
  - Everything: `comments:*` (or `kon:comments:*`).
  - Example read-only moderator key: `["kon:comments:moderation-queue", "kon:comments:get-thread"]`.
- **MCP tools** (`comments__<operation>`):
  - `comments__get-thread`: `{ data: [{ comment, answers }], total, maxDepth }`.
  - `comments__moderation-queue`: `{ data: [comment + subject], total, counts }`.
  - `comments__create-comment`: `{ data: comment }` (201).
  - `comments__update-comment`, `comments__moderate-comment`: `{ data: comment }`.
  - `comments__moderate-in-bulk`: `{ moderated, requested, status }`.
  - `comments__delete-comment`: `{ ok: true }` or `{ data, hidden: true }`.
  - `comments__vote-comment`: `{ data: { id, score }, myVote }`.
- **Approval.** `delete-comment` and `moderate-in-bulk` are sensitive. When human approval is on
  they come back `202 KITSUDEN_E_APPROVAL_REQUIRED`: report the proposal, do not retry.
- **404 vs empty.** `get-thread` never answers 404: an unknown, invisible or impossible subject is
  an empty thread. `create-comment` answers 404 when the subject cannot be seen (same as missing).
  `vote-comment` answers 404 for a comment that is not published. There is no row security; these
  404s come from the handlers.
- **Idempotency.** `moderate-comment`, `moderate-in-bulk` and `vote-comment` are idempotent (the
  same request leaves the same state). `create-comment` is not: send an `Idempotency-Key` (REST
  header, or the MCP `idempotency_key` argument) when you may retry.
- **Refused, and why.**
  - Editing someone else's comment: `update` belongs to the author only, admins included.
    Moderators change the status instead.
  - Setting `authorId`, `status` or `score` on create: the body schema is strict (422).
  - Subject types outside the vocabulary (`post`, `blogpost`): 422.
  - Agents with role `agent` and a moderation scope can moderate, but `get-thread` shows the text of
    hidden or pending comments only to the roles `admin` and `editor`.
  - More than 10 comments in 10 minutes (or 100 a day) from one non-moderator account: 429.

## Map of the code

| File | Responsibility |
| --- | --- |
| `kon.json` | Manifest: tables, admin views, fine scopes, sensitive operations, mount path. |
| `package.json` | npm package; `files` and `version` kept in sync by `pnpm kon:sync`. |
| `index.ts` | All eight operations, subject visibility check, subject titles for the queue, rate limit (`COMMENT_LIMIT`), blocklist from `KITSUDEN_COMMENT_BLOCKLIST`, `defineKonSdk` definition. |
| `operations.ts` | `registry()` (router-shaped operation registry), `onTheComment(action)` policy declaration, shared zod helpers (`Row`, `query`, `text`), `KON_ID`. |
| `comments.engine.ts` | Pure functions: `depthOf`, `buildTree`, `sort`, `count`, `censor`, `initialStatus`; `MAX_DEPTH`, `STATUSES`. |
| `comments.policy.ts` | The `comments` policy (view, create, vote, update, delete, moderate). |
| `comments.schema.ts` | Drizzle tables `comments` and `comment_votes`. |
| `migrations/0001_comments.sql` | Creates both tables and their indexes. |
| `migrations/0002_english_names.sql` | Renames stored scopes and tool names to English. |
| `migrations/history.json` | Previous checksums of `0001_comments.sql` (comments translated). |
| `admin-src/` | Svelte source of the Moderation view: `Moderation.svelte`, `store.svelte.ts`, `api.ts`, `format.ts`, `types.ts`, `ui/CommentItem.svelte`; the frame shared by every kon view, copied from kon-crm and kept identical (`ui/View.svelte`, `ui/Panel.svelte`, `ui/Loadable.svelte`, `ui/load.svelte.ts`, `ui/RowMenu.svelte`, `ui/FormGrid.svelte`, `ui/notify.ts`, `ui/labels.ts`); `views.json` (what to build), `tallao.json` (which tallao components to copy). |
| `admin-src/tallao/` | Copied tallao components. Do not edit; run `pnpm sync:tallao`. |
| `admin/moderation.js` | Built view (custom element `comments-moderation`). Generated; committed. |
| `tsconfig.json` | Extends `../../tsconfig.kons.json`. |

## Rules that must hold

- **The table name never comes from the request.** Subject tables and columns are read from
  `COMMENTABLE_SUBJECTS` after `isSubjectType`; the id is a parameter
  (`blog-and-comments.test.ts`).
- **No thread on what the caller cannot see**, on read or on write; an impossible id is "not
  visible", never a 500 (`blog-and-comments.test.ts`).
- **Only the author rewrites.** Policy `update`; guarded by `kon-comments-security.test.ts`.
- **Hide, do not delete, when there are replies**; `censor` keeps the node and replaces the text
  (`comments-engine.test.ts`).
- **One vote per account**: unique index `(comment_id, user_id)`, UPSERT, score recounted from
  `comment_votes` (`kon-comments-security.test.ts`).
- **No account ids or emails in public threads**: `forOutside` strips `authorId`; `visibleName`
  never falls back to the email (`kon-comments-security.test.ts`).
- **The blocklist applies on edit too**, and editing never publishes a pending or hidden comment.
- **Depth ≤ `MAX_DEPTH`** and replies stay on their parent's subject.
- **Literal routes before parametric ones**: `/moderation/queue` and `/moderation/bulk` are
  declared before `/:subjectType/:subjectId`.

## Changing it

- **New commentable subject:** add it to `COMMENTABLE_SUBJECTS` in the core
  (`packages/shared/src/comment-subjects.ts`), not here. This kon imports no other kon.
- **New migration:** next number in `migrations/` (`0003_...`); never edit an applied one. Renames
  and comment-only edits of applied files go in `migrations/history.json`.
- **New file at the root:** run `pnpm kon:sync`.
- **Behaviour change:** bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- **Admin view:** edit `admin-src/`, then `pnpm build:admin kon-comments` to regenerate
  `admin/moderation.js`, and `pnpm check:admin`. To change a tallao component, change tallao and run
  `pnpm sync:tallao kon-comments`.
- Do not rename operation ids: they are MCP tool names and fine scopes stored in agent keys.

## Tests

```bash
pnpm vitest run tests/unit/comments-engine.test.ts
pnpm vitest run tests/unit/kon-comments-security.test.ts
pnpm vitest run tests/unit/blog-and-comments.test.ts
```

- `comments.engine.ts`: `comments-engine.test.ts`.
- `index.ts`, `comments.policy.ts`: `kon-comments-security.test.ts` and `blog-and-comments.test.ts`.
- `kon.json`, migrations: `pnpm test:guards`.

# kon-comments

Comment threads that hang from any commentable subject (a blog post, a page-builder page, a wiki
page), with replies up to three levels deep, one vote per account and moderation that hides a
comment without breaking its thread. For sites that want readers to discuss their content.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | content | 1.0.2 | `/api/comments` | core `auth` |

## Install

```bash
kitsuden kon add comments --enable
```

Run it inside a Kitsuden project. The kon is off by default (`defaultEnabled: false` in
`package.json`): use `--enable`, or switch it on in the admin panel (**Kons**). Restart the API
afterwards. No other kon is required, but a thread can only hang from a subject whose table exists
(see below). No environment variable is required.

## What it adds

| Table | What it holds |
| --- | --- |
| `comments` | One row per comment: subject (`subject_type`, `subject_id`), `parent_id`, `depth` (stored at write time), `body`, `status`, denormalized `score`, `author_id`, a copy of the author's display name (`author_name`). |
| `comment_votes` | One row per account and comment (unique on `comment_id, user_id`), `value` +1 or -1. It is the source of truth for `comments.score`, which is recounted from it on every vote. |

- **Subjects.** The valid subject types come from `COMMENTABLE_SUBJECTS` in `@kitsuden/shared`
  (the core), not from this kon: `blog_post` (`blog_posts`), `block_page` (`block_pages`) and
  `wiki_page` (`wiki_pages`). A comment can only be posted, and a thread only read, when the subject
  exists and the caller can see it (for blog posts and builder pages: `status = 'published'`,
  unless the caller is admin or editor). There is no foreign key to the subject.
- **Threads.** Replies must belong to the same subject as their parent. Depth is capped at
  `MAX_DEPTH = 3` (levels 0 to 3). Threads are returned already built as a tree; a reply whose
  parent is missing is promoted to the root rather than dropped.
- **Status.** `published`, `pending` or `hidden`. A comment containing a word from
  `KITSUDEN_COMMENT_BLOCKLIST` starts as `pending` (it is queued, not rejected). Non-moderators see
  pending and hidden comments with the text `[comment removed by moderation]` and no author name.
- **Deleting a comment with replies hides it** instead of deleting it, so the replies keep their
  context.
- **Rate limit per account:** at most 10 comments in 10 minutes and 100 per day for anyone who is
  not admin or editor (`COMMENT_LIMIT` in `index.ts`; `429` with `Retry-After: 600`).

## HTTP API

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/comments/moderation/queue` | admin, editor | Comments in one `status` (default `pending`), newest first, each with its subject's `{ title, slug }` (or `null` if the subject is gone), plus `counts` per status. `limit` 1-200, default 100. `422` for an unknown status. |
| `POST /api/comments/moderation/bulk` | admin, editor | Body `{ ids: [...] (1-200), status }`. Sets the status of many comments; returns `{ moderated, requested, status }`. |
| `GET /api/comments/:subjectType/:subjectId` | anyone | The thread as a tree `{ data: [{ comment, answers }], total, maxDepth }`. Query `order`: `best` (default), `newest`, `oldest`. A subject that does not exist or that the caller cannot see returns an empty thread, not a 404. |
| `POST /api/comments` | signed-in person | Body `{ subjectType, subjectId, parentId?, body }` (body up to 10,000 characters). `201 { data }`. `404` if the subject cannot be seen or the parent does not exist; `422` if the parent is on another subject or the thread is too deep; `429` over the rate limit. |
| `PATCH /api/comments/:id` | the author only | Body `{ body }`. Rewrites the text. A published comment that now contains a blocked word goes back to `pending`. |
| `POST /api/comments/:id/moderate` | admin, editor | Body `{ status }`. Changes the status without touching the text. |
| `DELETE /api/comments/:id` | the author, admin, editor | Deletes the comment and its votes (`{ ok: true }`), or hides it if it has replies (`{ data, hidden: true }`). |
| `POST /api/comments/:id/vote` | signed-in person | Body `{ value: 1 \| -1 \| 0 }` (`0` removes your vote). Only on published comments (`404` otherwise). Returns `{ data: { id, score }, myVote }`. |

Author, status and score cannot be set when creating a comment: the author comes from the session,
the status from the blocklist, the score starts at 0.

## Who can do what

The policy is `comments.policy.ts` (resource `comments`):

| Action | Allowed |
| --- | --- |
| `view` | everyone |
| `create`, `vote` | a person with a session (not `role: "agent"`) |
| `update` | the comment's author only; not even an admin can rewrite someone else's comment |
| `delete` | the author, `admin`, `editor` |
| `moderate` | `admin`, `editor` |

Agents never pass as "a person": they need a scope (see [Agents and MCP](#agents-and-mcp)).

Public threads never include `authorId`; each comment carries `mine` (whether it is the caller's)
instead. Moderators (role `admin` or `editor`) get `authorId` and see the text of pending and hidden
comments. The author name is the user's `name` or `displayName`, never the email.

The tables have no row security. The kon answers `404` instead of `403` where a `403` would confirm
that something exists: posting on a subject the caller cannot see, and voting on a comment that is
not published.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `KITSUDEN_COMMENT_BLOCKLIST` | empty | Comma-separated words. A comment containing one (case-insensitive) is stored as `pending` instead of `published`. Read once at startup. |

## Agents and MCP

Every operation is an MCP tool named `comments__<operation>`:

| Operation | MCP tool | Fine scope | Writes | Sensitive |
| --- | --- | --- | --- |
| `moderation-queue` | `comments__moderation-queue` | `kon:comments:moderation-queue` | no | no |
| `moderate-in-bulk` | `comments__moderate-in-bulk` | `kon:comments:moderate-in-bulk` | yes | yes |
| `get-thread` | `comments__get-thread` | `kon:comments:get-thread` | no | no |
| `create-comment` | `comments__create-comment` | `kon:comments:create-comment` | yes | no |
| `update-comment` | `comments__update-comment` | `kon:comments:update-comment` | yes | no |
| `moderate-comment` | `comments__moderate-comment` | `kon:comments:moderate-comment` | yes | no |
| `delete-comment` | `comments__delete-comment` | `kon:comments:delete-comment` | yes | yes (DELETE) |
| `vote-comment` | `comments__vote-comment` | `kon:comments:vote-comment` | yes | no |

Besides the fine scopes, the broad `comments:*` and the policy scopes `comments:<action>`
(`comments:create`, `comments:vote`, `comments:moderate`, ...) grant them. When an admin turns
human approval on, `moderate-in-bulk` and `delete-comment` are the ones held by default. Notes for
agents: [AGENTS.md](AGENTS.md).

## Admin panel

The **Moderation** view (`admin/moderation.js`, custom element `comments-moderation`) lists the
queue by status with bulk actions. It calls the REST routes above with the admin's own session, so
the same permissions apply. The panel also has grid views of both tables.

## Tests

| File | What it covers |
| --- | --- |
| `tests/unit/comments-engine.test.ts` | Depth, tree building, orphan promotion, sorting, counting, censoring, blocklist. |
| `tests/unit/kon-comments-security.test.ts` | Ownership (IDOR), agents need a scope, concurrent votes, filter on edit, rate limit, no email or account ids in public threads. |
| `tests/unit/blog-and-comments.test.ts` | The subject vocabulary, threads of unseen subjects, impossible ids, the blog's comment fields. |

```bash
pnpm vitest run tests/unit/comments-engine.test.ts
pnpm vitest run tests/unit/kon-comments-security.test.ts
pnpm vitest run tests/unit/blog-and-comments.test.ts
```

## License

MIT.

# AGENTS.md — kon-blog

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

The blog: posts (`blog_posts`) with a draft/scheduled/published/archived workflow, categories,
tag and game links, translations, content blocks, SEO/Open Graph/JSON-LD metadata and GEO fields.
It is a `stable`, tier `essential` kon: most sites run it, so behaviour changes need care.

## Calling it

- **Scopes.** Reads are public. Writes need the blog staff rule (`isEffectiveStaff(user, "blog")`):
  for an agent, `blog:*`, `kon:blog:*` or `admin`. A single operation is also granted by its fine
  scope (`kon:blog:create-post`, `kon:blog:update-post`, `kon:blog:publish-post`…) or by the policy
  scope `blog_post:<action>` / `blog_category:<action>`. `content:edit` does not open the blog.
  - Writer that cannot publish or delete:
    `["kon:blog:create-post", "kon:blog:update-post", "kon:blog:list-categories"]`.
  - Whole blog but never delete: `["blog:*", "!kon:blog:delete-post", "!kon:blog:delete-category"]`.
- **Seeing drafts.** An agent sees unpublished posts only with `blog_post:viewUnpublished`,
  `blog:viewUnpublished`, `kon:blog:update-post` or `kon:blog:publish-post` (or the whole blog).
  Otherwise a draft is a `404`, like for the public.
- **Author.** An agent is not an account, so `create-post` needs `authorId`: the id of an existing
  account the post is written for. An agent with a human signer can only write as that signer
  (unless it has `admin`); otherwise `403`.
- **MCP tools** (`blog__<operation>`): `list-posts` returns `{ docs, totalDocs, … }`;
  `get-by-slug` / `get-post` a post with relations; `post-seo` `{ success, post, seo, social,
  html }`; `post-geo` `{ success, data, _meta }`; `list-categories` `{ docs, total }`;
  `create-post` the post (201); `update-post` / `publish-post` the post; `delete-post`
  `{ deleted, id }`; category writes the category or `{ success, id }`; `validate-seo` and
  `validate-image` a report; `promote-from-source` `{ success, postId, slug }`; `post-source` the
  source record. `refresh-og-cache` is REST only.
- **Approval.** `publish-post`, `delete-post` and `delete-category` are sensitive: with human
  approval on they come back `202 KITSUDEN_E_APPROVAL_REQUIRED`. Report it, do not retry.
- **404 vs missing.** There is no row security. A `404` on a read means missing, not a uuid, or not
  visible to you (unpublished or future-dated). The handlers never answer `403` for a hidden post.
- **Idempotency.** `create-post`, `create-category` and `promote-from-source` are not idempotent:
  send `Idempotency-Key` (MCP `idempotency_key`) when you may retry; a second create with the same
  slug is `409`. `PATCH` with `expectedUpdatedAt` refuses to overwrite a newer save (`409`).
- **Refused, and why.**
  - Tag or category names instead of uuids (`tags`, `categories`): use `tagIds`, `categoryIds`.
  - A reserved or malformed slug: `400`.
  - Blocks with 0.8 Spanish keys (`titulo`, `campos`…): `422` with the English key to use.
  - A BLUF over 50 words: `400`.
  - Promoting a row of a table (`sourceType: "kon"`) unless the caller's role is `admin`, and never
    from auth, agent, secret, session, token, OAuth, webhook, audit or `pg_` tables.

## Map of the code

| File | Responsibility |
| --- | --- |
| `kon.json` | Manifest: tables, enum, admin views, dependencies, mount path, maturity. |
| `package.json` | npm package; `files` and `version` kept in sync by `pnpm kon:sync`. |
| `index.ts` | Re-exports `src/index.ts` (the package entry). |
| `src/index.ts` | `defineKonSdk` definition (operations, admin views, startup check) and the kon's public exports (schema, SEO and GEO helpers). |
| `src/routes.ts` | All operations (`blogOperations`), visibility rules (`canViewUnpublished`, `alreadyPublic`), slug rules, banned tables for promotion, events, cache. |
| `src/schemas.ts` | zod schemas of query parameters and outputs (OpenAPI and MCP). |
| `src/blog.policy.ts` | Policies `blog_post` and `blog_category`; `isTeam`. |
| `src/sanitize.ts` | HTML and markdown sanitizing, block sanitizing, English block keys, `postToServe`. |
| `src/seo-utils.ts` | SEO metadata, Open Graph, Twitter Cards, JSON-LD, SEO validation and score, WhatsApp image checks, media transform URLs. |
| `src/geo-utils.ts` | BLUF validation, FAQ and Article schemas, `sanitizeHTML`, TOC extraction, `buildAPIPayload`. |
| `src/content-target.ts` | `blogContentTarget`: creates a post from another source (used by `promote-from-source`). |
| `src/content-utils.ts` | Slug, template, excerpt and reading-time helpers for content targets. |
| `src/schema.local.ts` | Drizzle tables, enum, relations and types. |
| `src/schema.ts` | Re-exports `schema.local.ts`. |
| `blog.simple.test.ts`, `blog.sandbox.test.ts` | Bun tests (run with `pnpm test:bun`). |
| `migrations/0000_initial.sql` … `0010_english_block_keys.sql` | Schema chain; `history.json` lists renamed files and previous checksums. |
| `*_GUIDE.md`, `DATAEXPLORER_CONFIG.md` | Guides linked from the README. |
| `tsconfig.json` | Extends `../../tsconfig.kons.json`. |

## Rules that must hold

- **A write whose failure is answered with a 4xx runs in a savepoint** (`withSavepoint`): creating
  and updating posts (with their tags, games and categories, all in one savepoint) and categories.
  Without it the 409 or 400 leaves the request's transaction aborted and the host's COMMIT fails.
  Guard: `tests/unit/input-errors-in-the-request-transaction.test.ts`.
- **One visibility rule.** Every public read goes through `hiddenForThisVisitor` /
  `canViewUnpublished` and `alreadyPublic` (published and date reached). A new read route must use
  them (`drafts-not-public.test.ts`, `sec-blog-routes.test.ts`).
- **Hidden is 404, never 403**, and `?preview=true` alone is not a credential.
- **Writes are authorized inside the kon** by `blog.policy.ts`; an ordinary account is not staff
  (`sec-blog-routes.test.ts`).
- **Sanitize on write and on read** (`sanitizeBody`, `sanitizeBlocks`, `postToServe`;
  `sec-blog-sanitize.test.ts`).
- **No raw source rows to the public**: `postToServe` strips `source.snapshot` / `rawData` for
  non-staff.
- **Promotion never reads secret tables** (`bannedTable`) and table promotion is admin only.
- **Mass assignment:** the author is validated against existing accounts; agents sign as their
  signer (`agentSignature`).
- **Literal routes before `/:id`** (`/slug/:slug`, `/seo/:slug`, `/categories`, `/source/:postId`
  …); the SDK refuses a shadowed route at mount time.
- **English block keys on write** (`oldBlockKeysError`; `english-block-keys.test.ts`).
- **Category tree has no cycles** (`wouldCreateCycle`).

## Changing it

- **New migration:** next number in `migrations/` (`0011_...`); never edit an applied one. Renames
  and comment-only edits of applied files go in `migrations/history.json`.
- **New file at the root:** run `pnpm kon:sync` (the guides are in `package.json` `files`).
- **Behaviour change:** bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`. This kon is `stable`: keep the REST shapes and
  operation ids, which are MCP tool names and fine scopes stored in agent keys.
- The tables of kon-games (`games`, `tags`) and kon-comments (`comments`) are reached with SQL that
  tolerates their absence; do not import those kons.
- Block key renames live in the core (`@kitsuden/shared` `block-keys.ts`), not here.

## Tests

```bash
pnpm vitest run tests/unit/sec-blog-routes.test.ts
pnpm vitest run tests/unit/sec-blog-sanitize.test.ts
pnpm vitest run tests/unit/drafts-not-public.test.ts
pnpm vitest run tests/unit/blog-publish-on-edit.test.ts
pnpm vitest run tests/unit/blog-docs-review-fixes.test.ts
pnpm vitest run tests/unit/input-errors-in-the-request-transaction.test.ts
pnpm vitest run tests/unit/blog-and-comments.test.ts
pnpm vitest run tests/unit/english-block-keys.test.ts
pnpm vitest run tests/unit/event-blog-newsletter.test.ts
pnpm test:bun
```

- `src/routes.ts`, `src/blog.policy.ts`: `sec-blog-routes`, `drafts-not-public`,
  `blog-publish-on-edit`, `blog-and-comments`, `event-blog-newsletter`.
- `src/sanitize.ts`: `sec-blog-sanitize`, `english-block-keys`.
- `src/seo-utils.ts`, `src/content-utils.ts`: `pnpm test:bun` (`blog.simple.test.ts`).
- Migrations and `kon.json`: `english-block-keys` and `pnpm test:guards`.

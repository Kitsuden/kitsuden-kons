# kon-blog

The blog of a Kitsuden site: posts with a draft, scheduled, published and archived workflow,
categories, tags and games, translations, content blocks, SEO and Open Graph metadata, and GEO
fields (BLUF, FAQ) for answer engines. For any site that publishes articles; most sites install it.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| stable (tier `essential`) | core | 2.0.2 | `/api/blog` | kon-media (part of the core), core `auth` |

## Install

```bash
kitsuden kon add blog
```

Run it inside a Kitsuden project, then restart the API. The kon is on by default
(`defaultEnabled: true`), so `--enable` is not needed. `kon-media` is listed as a dependency; it
ships with the Kitsuden core, so nothing else is installed. No environment variable is required.

Optional companions, detected at run time:

- **kon-games**: `tagIds` and `gameIds` point to its `tags` and `games` tables (foreign keys are
  added by whichever of the two kons migrates second).
- **kon-comments**: each post carries its comment thread info and published-comment count.
- **kon-newsletter**: listens to `blog:post:published` to send posts as campaigns.

## What it adds

| Table | What it holds |
| --- | --- |
| `blog_posts` | The posts (columns below). |
| `blog_posts_to_tags` | Post to tag links (`tag_id`, kon-games' `tags`). |
| `blog_posts_to_games` | Post to game links (`game_id`, kon-games' `games`). |
| `blog_categories` | Categories: `name`, unique `slug`, `description`, optional `parent_id` (a tree), `display_order`. |
| `blog_posts_to_categories` | Post to category links. |

It also creates the Postgres enum `blog_status` (`draft`, `scheduled`, `published`, `archived`).

Main `blog_posts` columns: `title`, `slug` (unique), `content` (an HTML string or a JSON document),
`excerpt`, `blocks` (content blocks `{ id, type, order, data }`), `status`, `published_at`,
`author_id` (an account), `featured_image_id` and `og_image_id` (media items),
`featured_image_focal_point`, `meta_title` (70), `meta_description` (170), `seo_overrides`,
`bluf_text`, `faq_data`, `dataset_url`, `reading_time`, `layout` (`article` or `tips`),
`comments_enabled`, `locale` (default `es`), `translation_group_id`, `source` (where a promoted post
came from), and a `search_vector` kept by a trigger.

- **Visibility.** The public sees a post only when it is `published` and its `published_at` is
  empty or in the past. Everything else is a 404 for the public.
- **Translations.** Versions of the same post share a `translation_group_id`; each has its own
  `locale` and `slug`. `?locale=xx` on the list returns one version per group: that locale, else
  English, else the newest.
- **Sanitizing.** HTML in `content` and markdown in blocks are sanitized on write and again on read
  (`src/sanitize.ts`). FAQ answers allow only basic tags.
- **Block keys** are English (`title`, `description`, `hidden`, `order`…). Blocks that still use the
  0.8 Spanish keys are refused with `422`; old rows were renamed by
  `migrations/0010_english_block_keys.sql` and are still read in English until 0.10.
- **Slugs** allow lowercase letters, digits and hyphens. When missing, the slug is derived from
  the title. Reserved: `slug`, `seo`, `geo`, `source`, `categories`, `validate-seo`,
  `validate-image`, `promote-from-source`, `index`, `page`, `rss`, `feed`, `sitemap`.
- **Events** on the core event bus: `blog:post:created`, `blog:post:published` (on
  `POST /:id/publish`, on `PATCH` when the body sets `status: "published"`, and once on create
  when the post is created with `status: "published"`),
  `blog:post:deleted`, `blog:post:promoted`. A `PATCH` also broadcasts `blog:post:<id>` on the
  realtime channel.
- **Cache.** List answers are cached for 60 seconds and invalidated by every write.

## HTTP API

Reads (anyone; staff also see unpublished posts):

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/blog` | anyone | Paginated list, newest first: `{ docs, totalDocs, totalPages, page, limit, hasNextPage, hasPrevPage }`. Query: `limit` (default 12, max 100), `page`, `category` (slug or uuid), `game` (uuid), `search` (title and excerpt), `locale` (two letters), `status` (`draft`, `published`, `scheduled`, `archived` or `all`; staff only, the public always gets published). Each post carries `categories`, `gameIds`, `tagIds` and `comments`. |
| `GET /api/blog/slug/:slug` | anyone | One post with `author`, `tagIds`, `gameIds`, `translations`, `blocksHtml`, `interactiveBlocks` and `comments`. |
| `GET /api/blog/:id` | anyone | One post by uuid, with `tagIds`, `categoryIds` and `comments`. A non-uuid id is a 404. |
| `GET /api/blog/seo/:slug` | anyone | SEO, Open Graph, Twitter Card and JSON-LD metadata, plus ready-made HTML tags. Query `siteName`, `baseUrl`, `language` (site language, used for `og:locale` only when the post has no `locale`; `og:locale` comes from the post's `locale`, e.g. `pt` → `pt_BR`, fallback `en_US`); `preview=true` lets staff read an unpublished post. See [SEO_GUIDE.md](SEO_GUIDE.md). |
| `GET /api/blog/geo/:slug` | anyone | The answer-engine payload: SEO summary, `geo_ai` (BLUF, FAQ schema, dataset URL, reading time, word count), body and table of contents. Same query as the SEO route. See [GEO_IMPLEMENTATION_GUIDE.md](GEO_IMPLEMENTATION_GUIDE.md). |
| `GET /api/blog/categories` | anyone | Every category as a flat list with `parentId` and `postCount`, by `displayOrder` then name. |

Writes and editor tools (staff: see [Who can do what](#who-can-do-what)):

| Route | Who | What it does |
| --- | --- | --- |
| `POST /api/blog` | staff | Creates a post (`201`), draft by default, with `tagIds`, `gameIds`, `categoryIds`. `400` for an invalid body, slug or BLUF (more than 50 words), or an author that does not exist; `409` if the slug exists; `422` for blocks with old keys. |
| `PATCH /api/blog/:id` | staff | Changes the fields sent; `tagIds`, `gameIds`, `categoryIds` replace the links when sent. `publishedAt` (ISO 8601, or `null`) schedules or unschedules. With `expectedUpdatedAt` (the `updatedAt` you loaded) a concurrent save answers `409` instead of being overwritten. |
| `POST /api/blog/:id/publish` | staff | Sets `status: published` and `publishedAt` to now. |
| `DELETE /api/blog/:id` | staff | Deletes the post and its links. Cannot be undone. `{ deleted: true, id }`. |
| `POST /api/blog/categories` | staff | Creates a category (`201`). `409` if the slug exists, `400` if the parent does not. |
| `PATCH /api/blog/categories/:id` | staff | Renames, moves or reorders a category. `409` if the move would make it its own ancestor or the slug is taken. |
| `DELETE /api/blog/categories/:id` | staff | Deletes a category; its posts stay, without it. Child categories move to the root. |
| `POST /api/blog/validate-seo` | staff | Scores a title, description, focus keyword, content and optional image against the SEO limits. Saves nothing. |
| `POST /api/blog/validate-image` | staff | Checks an image URL, size, weight and type against what WhatsApp and Open Graph previews need. See [WHATSAPP_OG_GUIDE.md](WHATSAPP_OG_GUIDE.md). |
| `POST /api/blog/:slug/refresh-og-cache` | staff | Asks the Facebook Graph API to re-scrape `<baseUrl>/blog/<slug>` (`baseUrl` query, default the API origin). An outbound call. |
| `POST /api/blog/promote-from-source` | staff; admin for tables | Creates a post from a dataset entry (`sourceType: "dataset"`, `datasetId`, `entryId`) or from a row of any table (`sourceType: "kon"`, admin only; tables whose names look like auth, agent, secret, session, token, OAuth, webhook, audit or system tables are refused). `titleTemplate` fills `{field}` from the source. |
| `GET /api/blog/source/:postId` | staff | The `source` record a promoted post came from, including the full source row. |

Served by the Kitsuden core, not by this kon:

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/blog/posts/count` | staff | `{ count }` of `blog_posts` for the admin home page; `0` when the blog is not installed. |

## Who can do what

The policy is `src/blog.policy.ts`, with two resources:

| Resource | Actions | Allowed |
| --- | --- | --- |
| `blog_post` | `viewUnpublished`, `create`, `update`, `publish`, `delete`, `promote`, `useTools` | staff: role `admin` or `editor`, or an agent with `admin`, `blog:*` or `kon:blog:*` (`isEffectiveStaff(user, "blog")`) |
| `blog_post` | `promoteFromTable` | role `admin` only |
| `blog_category` | `create`, `update`, `delete` | staff, as above |

An ordinary signed-in account is not staff: writes answer `403` (and `401` without a session).
`content:edit` does not open the blog.

For the public, unpublished posts are a `404` on every read (by slug, by id, SEO and GEO); they are
never a `403`, so their existence is not confirmed. For non-staff, `source.snapshot` and
`source.rawData` are stripped from served posts. The blog tables have no row security: these rules
live in the handlers.

## Configuration

None. The kon reads no environment variables or settings. The SEO and GEO routes take the site
name and base URL from their `siteName` and `baseUrl` query parameters (defaults: `Kitsuden CMS`
and the API's own origin).

## Agents and MCP

Every operation except `refresh-og-cache` (it calls Facebook with a caller-chosen base URL) is an
MCP tool named `blog__<operation>`:

| Operation | MCP tool | Fine scope | Writes | Sensitive |
| --- | --- | --- | --- | --- |
| `list-posts` | `blog__list-posts` | `kon:blog:list-posts` | no | no |
| `get-by-slug` | `blog__get-by-slug` | `kon:blog:get-by-slug` | no | no |
| `get-post` | `blog__get-post` | `kon:blog:get-post` | no | no |
| `post-seo` | `blog__post-seo` | `kon:blog:post-seo` | no | no |
| `post-geo` | `blog__post-geo` | `kon:blog:post-geo` | no | no |
| `list-categories` | `blog__list-categories` | `kon:blog:list-categories` | no | no |
| `validate-seo` | `blog__validate-seo` | `kon:blog:validate-seo` | no | no |
| `validate-image` | `blog__validate-image` | `kon:blog:validate-image` | no | no |
| `post-source` | `blog__post-source` | `kon:blog:post-source` | no | no |
| `create-post` | `blog__create-post` | `kon:blog:create-post` | yes | no |
| `update-post` | `blog__update-post` | `kon:blog:update-post` | yes | no |
| `publish-post` | `blog__publish-post` | `kon:blog:publish-post` | yes | yes |
| `delete-post` | `blog__delete-post` | `kon:blog:delete-post` | yes | yes (DELETE) |
| `create-category` | `blog__create-category` | `kon:blog:create-category` | yes | no |
| `update-category` | `blog__update-category` | `kon:blog:update-category` | yes | no |
| `delete-category` | `blog__delete-category` | `kon:blog:delete-category` | yes | yes (DELETE) |
| `promote-from-source` | `blog__promote-from-source` | `kon:blog:promote-from-source` | yes | no |
| `refresh-og-cache` | not exposed | `kon:blog:refresh-og-cache` | no | no |

The policy scopes `blog_post:<action>` and `blog_category:<action>` also grant them. When an admin
turns human approval on, `publish-post`, `delete-post` and `delete-category` are the ones held by
default. Notes for agents: [AGENTS.md](AGENTS.md).

## Guides

| Guide | What it covers |
| --- | --- |
| [SEO_GUIDE.md](SEO_GUIDE.md) | The SEO route, `seoOverrides`, limits, warnings and score. |
| [GEO_IMPLEMENTATION_GUIDE.md](GEO_IMPLEMENTATION_GUIDE.md) | BLUF, FAQ and dataset fields, the GEO payload, BLUF validation. |
| [WHATSAPP_OG_GUIDE.md](WHATSAPP_OG_GUIDE.md) | Open Graph images for WhatsApp, Facebook and LinkedIn; the image check. |
| [SOCIAL_PREVIEW_GUIDE.md](SOCIAL_PREVIEW_GUIDE.md) | The admin panel's social preview component (Kitsuden core) and the routes it reads. |
| [DATAEXPLORER_CONFIG.md](DATAEXPLORER_CONFIG.md) | Pointing the admin panel's DataExplorer (Kitsuden core) at the blog list. |

## Tests

| File | What it covers |
| --- | --- |
| `tests/unit/sec-blog-routes.test.ts` | Ordinary accounts are not staff, drafts and agents, mass assignment, public reads, promote-from-source. |
| `tests/unit/sec-blog-sanitize.test.ts` | HTML and markdown sanitizing of bodies and blocks. |
| `tests/unit/drafts-not-public.test.ts` | Public reads hide unpublished and future posts. |
| `tests/unit/blog-publish-on-edit.test.ts` | `PATCH` with `publishedAt` and status. |
| `tests/unit/blog-docs-review-fixes.test.ts` | `blog:post:published` on create-as-published, category `description`, `og:locale` from the post language. |
| `tests/unit/blog-and-comments.test.ts` | Comment thread info and counts on posts. |
| `tests/unit/english-block-keys.test.ts` | `0010_english_block_keys.sql` and the 422 for old keys. |
| `tests/unit/event-blog-newsletter.test.ts` | The `blog:post:published` event kon-newsletter listens to. |
| `kons/kon-blog/blog.simple.test.ts`, `kons/kon-blog/blog.sandbox.test.ts` | Bun tests of the router and SEO helpers. |

```bash
pnpm vitest run tests/unit/sec-blog-routes.test.ts
pnpm vitest run tests/unit/sec-blog-sanitize.test.ts
pnpm vitest run tests/unit/drafts-not-public.test.ts
pnpm vitest run tests/unit/blog-publish-on-edit.test.ts
pnpm test:bun        # the bun tests in kons/kon-blog (needs Bun)
```

## License

MIT.

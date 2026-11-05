# AGENTS.md — kon-wiki

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

One wiki per game (`wikis.game_id`), with pages whose every save is an immutable revision in
`wiki_revisions`. Reverting writes a new revision; nothing in the API deletes history. `[[links]]`
are indexed in `wiki_links` for backlinks and wanted pages.

## Calling it

- **Scopes.** Every read is public. Writes need a scope:
  - Edit or create pages: `kon:wiki:save-page`, `kon:wiki:revert-page`, or the policy scopes
    `wiki:update` (existing pages) and `wiki:create` (new pages).
  - Create a wiki: `kon:wiki:create-wiki` or `wiki-space:create`.
  - Everything: the kon-wide `wiki:*` (or `kon:wiki:*`).
  - Example editor key: `["kon:wiki:save-page", "kon:wiki:get-page", "kon:wiki:list-pages"]`.
- **MCP tools** (`wiki__<operation>`):
  - `wiki__list-wikis` `{ docs, total }`; `wiki__get-wiki` `{ data: wiki + pages }`;
    `wiki__suggest-wiki` `{ slug, valid, reason }`.
  - `wiki__list-pages` `{ wiki, docs, total }`; `wiki__get-page` `{ wiki, data, content, backlinks }`.
  - `wiki__page-history` `{ data: [{ number, summary, createdAt, size }] }`.
  - `wiki__compare-revisions` `{ data: [{ op: keep|add|del, line }], stats: { added, removed } }`.
  - `wiki__requested-pages` `{ data: [{ slug, links }] }`.
  - `wiki__save-page` `{ data, revision }` or `{ data, unchanged: true }`.
  - `wiki__revert-page` `{ data, revision }`; `wiki__create-wiki` `{ data }` (201).
- **Approval.** `revert-page` is sensitive: with human approval on it comes back
  `202 KITSUDEN_E_APPROVAL_REQUIRED`. Report it, do not retry.
- **404s.** There is no row security; a 404 means the wiki, page or revision really does not
  exist (or the revision number is not a positive integer).
- **Idempotency.** `save-page` (PUT) is idempotent in effect: saving the same content again writes
  no revision and returns `unchanged: true`. `revert-page` is not: a second call is `409` (already
  the current revision). `create-wiki` is not: retry with an `Idempotency-Key`.
- **Refused, and why.**
  - Editing a `locked` page as anything but `admin`: 403 "This page is protected".
  - A second wiki for the same game, or a taken slug: 409 (`field` is `gameId` or `slug`). Use
    `suggest-wiki` first; it gives the exact reason.
  - Deleting pages or revisions: no operation exists. To undo an edit, revert.
  - `protection` cannot be set through the API.
  - `content` over 500,000 characters, `title` over 200, `summary` over 200: 422.

## Map of the code

| File | Responsibility |
| --- | --- |
| `kon.json` | Manifest: tables, admin views, mount path, maturity. |
| `package.json` | npm package; `files` and `version` kept in sync by `pnpm kon:sync`. |
| `index.ts` | All eleven operations, wiki-creation checks (`reasonNotToCreate`), link reindexing, `defineKonSdk` definition. |
| `operations.ts` | `registry()` (router-shaped operation registry), `onThePage` / `onTheWikis` policy declarations, zod helpers, `KON_ID`. |
| `wiki.engine.ts` | Pure functions: line diff with the `MAX_DIFF_CELLS` cap, `diffStats`, `prepareRevert`, `isMeaningfulEdit`; re-exports slug and link helpers from `@kitsuden/shared`. |
| `wiki.policy.ts` | Policies `wiki` (pages) and `wiki-space` (wikis). |
| `wiki.schema.ts` | Drizzle tables `wikis`, `wiki_pages`, `wiki_revisions`, `wiki_links`. |
| `migrations/0001_wiki.sql` | Pages, revisions, links (global slugs at the time). |
| `migrations/0002_wikis_with_subdomain.sql` | Adds `wikis`, moves existing pages to a `general` wiki, makes slugs unique per wiki. |
| `migrations/0003_english_names.sql` | Renames stored scopes and tool names to English. |
| `migrations/history.json` | Rename of `0002_wikis_con_subdominio.sql` and previous checksums. |
| `admin-src/` | Svelte source of the Wikis view: `WikiCreator.svelte`, `api.ts`, `ui/Panel.svelte`; `views.json`, `tallao.json`. |
| `admin-src/tallao/` | Copied tallao components. Do not edit; run `pnpm sync:tallao`. |
| `admin/wiki-creator.js` | Built view (custom element `wiki-creator`). Generated; committed. |
| `tsconfig.json` | Extends `../../tsconfig.kons.json`. |

## Rules that must hold

- **History only grows.** Saves and reverts insert a revision with `number = current + 1`; no
  code updates or deletes `wiki_revisions` (`wiki-maps-engine.test.ts`, revert tests).
- **Only the team edits**, and `locked` is admin-only (`wiki.policy.ts`;
  `sec-data-wiki-maps-formulas.test.ts`).
- **The server sets authorship** (`author_id` from the session), and the public history never
  returns it.
- **One wiki per game, unique wiki slug**: `reasonNotToCreate` plus the unique index
  `wikis_slug_idx`.
- **Slugs and links use the shared rules** (`wikiPageSlug`, `extractWikiLinks` in
  `@kitsuden/shared`), so the frontend renders links the way the server indexes them.
- **Bounded work on public routes:** diff capped by `MAX_DIFF_CELLS`, history by 1,000 rows, page
  index by 500, links by `MAX_LINKS_PER_PAGE`.
- **Links stay inside their wiki** and a page does not link to itself.
- **Literal routes before parametric ones:** `/wikis/suggestion` is declared before
  `/wikis/:wiki`.

## Changing it

- **New migration:** next number in `migrations/` (`0004_...`); never edit an applied one.
  Renames and comment-only edits go in `migrations/history.json`.
- **New file at the root:** run `pnpm kon:sync`.
- **Behaviour change:** bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- **Admin view:** edit `admin-src/`, then `pnpm build:admin kon-wiki` and `pnpm check:admin`.
  tallao components: change tallao, then `pnpm sync:tallao kon-wiki`.
- Slug and link rules live in the core (`packages/shared`), not here.
- Do not rename operation ids: they are MCP tool names and fine scopes stored in agent keys.

## Tests

```bash
pnpm vitest run tests/unit/wiki-maps-engine.test.ts
pnpm vitest run tests/unit/sec-data-wiki-maps-formulas.test.ts
pnpm vitest run tests/unit/kon-wiki-create-conflict.test.ts
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-wiki"
```

- `wiki.engine.ts`: `wiki-maps-engine.test.ts`.
- `index.ts`, `wiki.policy.ts`: `sec-data-wiki-maps-formulas.test.ts`.
- `kon.json`, migrations: `pnpm test:guards`.

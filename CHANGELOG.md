# Changelog

Each kon has its own version in its `package.json` (copied to `kon.json` by `pnpm kon:sync`) and
its maturity in the table of the [README](README.md). This file records releases of the repository.

## Unreleased

- The admin views carry tallao f8eab12: a confirmation dialog no longer draws an empty band
  between its title and its buttons, and DiffView can show a hidden value. kon-conta's view titles
  are in sentence case ("New journal entry", "Reimbursable expenses", "New template").
  kon-agile 1.3.3, kon-broadcast 1.0.4, kon-character-builder 1.1.2, kon-chat 1.0.3,
  kon-comments 1.0.2, kon-conta 1.0.2, kon-crm 1.0.4, kon-esports 1.0.4, kon-tierlist 1.0.2,
  kon-wiki 1.1.3.
- The twelve admin views the kons ship follow one layout, built on the current tallao kit: sections
  as cards with an h2 (the panel draws the page title), a skeleton while a list loads, an empty
  state with the next action, an error with Retry, a SaveBar with dirty state on forms, a
  confirmation before destructive actions, and every result as a toast. Lists are DataTables with
  sorting and a pinned row menu. Requests are unchanged, except that a new tier list takes its row
  colours from the kit's series tokens. kon-agile 1.3.2, kon-broadcast 1.0.3,
  kon-character-builder 1.1.1, kon-chat 1.0.2, kon-comments 1.0.1, kon-crm 1.0.3, kon-esports 1.0.3,
  kon-tierlist 1.0.1, kon-wiki 1.1.2.
- `pnpm sync:tallao` follows every import of a component (`$lib/motion`, `$lib/toast.svelte`,
  `$lib/components/…`, `internal/*.svelte`) and takes `"modules"` in `admin-src/tallao.json` for
  tallao's other entry points.

## 0.9.0-beta — first public release

- Security scanning on every push and pull request with Kitsuden's scanners: gitleaks, OSV-Scanner,
  Checkov and CodeQL (`.github/workflows/security.yml`). Actions are pinned by commit and kept
  current by Dependabot. `exceljs` gets `uuid` 11.1.1 (its own `uuid@8` has a HIGH advisory).
- 30 kons under MIT, grouped by category: core (blog, members), business, content and community,
  gaming, and documents and OCR. `stable` is reserved for the essential kons; the rest are `beta`
  or `experimental`.
- Every kon carries a `README.md` (install, routes, permissions, configuration, MCP, tests) and an
  `AGENTS.md` (scopes, MCP tools, code map, invariants), checked against the code by
  `tests/guards/kon-docs.test.ts`.
- Agents work through the core's scopes in every kon: broad `<kon>:*`, fine `kon:<kon>:<operation>`,
  and a deny that wins. Row security honours fine scopes as well as broad ones.
- Everything is in English: code, routes, messages, migrations (renamed ones are recorded in each
  `migrations/history.json`, so installed databases do not run them again).
- kon-cardsim absorbs the former deck showcase and hand-test kons.
- `kitsuden make kon <name>` works inside this repository and writes a kon that passes every guard.
- A 4xx a kon writes after Postgres refused a value no longer leaves the request's transaction
  aborted (a 500 on PGlite 0.5.16, which Kitsuden's `main` now uses): kon-crm 1.0.2 throws the
  error for its `onError`; kon-blog 2.0.2, kon-streamers 1.0.2 and kon-esports 1.0.2 run the
  statement in a savepoint. Same status and body as before.
- kon-crm 1.0.2 no longer runs its own migrations at startup: it warns when a table is missing,
  like every other kon. The guard `kons-do-not-create-tables` now also refuses a kon source that
  reads its migration files.
- kon-ecommerce 1.1.2: generated license keys use every letter of their alphabet with the same
  probability. kon-broadcast 1.0.2: the live overlay loads a team or sponsor logo only from
  `http(s)` or an inline image. kon-blog 2.0.2 drops an unused regex HTML sanitizer.
- kon-analytics 1.0.2, kon-games 2.1.2 and kon-streamers 1.0.2 declare `zod` as the peer
  dependency they import. `pnpm build` type-checks kon-ingest too (it had no `build` script).
- The READMEs of kon-academy-lms, kon-agile, kon-booking and kon-conta install with `--enable`:
  Kitsuden leaves those kons off until they are switched on.
- CI also runs `kon:sync:check` and `check:admin`, and once a week on its own, against Kitsuden's
  `main`. `node scripts/link-core.mjs --check` verifies the core link without changing it.
  `pnpm sync:tallao` reads a tallao checkout at `../tallao`.

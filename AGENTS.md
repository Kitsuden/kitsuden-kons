# kitsuden-kons: notes for AI agents

Read by Codex, Claude Code (through `CLAUDE.md`) and other agents. Each kon has its own
`kons/kon-<id>/AGENTS.md` with its scopes, MCP tools, code map and invariants: read it before
touching or calling that kon.

## What this repository is

Optional modules (**kons**) for [Kitsuden](https://github.com/Kitsuden/kitsuden). A kon runs inside
a Kitsuden API: it imports `@kitsuden/shared` and `@kitsuden/engine` from the host and shares one
copy of `hono`, `drizzle-orm` and `zod` with it. This repo builds and tests against a Kitsuden
checkout linked at `./.kitsuden` (`node scripts/link-core.mjs`, `KITSUDEN_DIR=<path>` if it is not
`../kitsuden`). Building `@kitsuden/shared` in that checkout needs Bun.

## Never

- Edit a migration that has been released. Add the next numbered file instead. A rename or a
  reworded comment goes in that folder's `migrations/history.json` (`renamed`,
  `previousChecksums`), or installed databases run it again or stop on a checksum drift.
- Create tables at runtime, or read a kon's migration files to run them at startup. Tables come
  from the kon's own migrations, applied by the host's runner, and `kon.json` lists them; at
  startup a kon only checks (`ctx.db.tableExists`) and warns
  (guard: `tests/guards/kons-do-not-create-tables.test.ts`).
- Answer a 4xx from a `catch` around a statement that failed. The request runs in one transaction
  and that commits it aborted. Put the statement in a savepoint (`withSavepoint` from the engine)
  or let the error go up to the kon's `onError`.
- Run `node scripts/link-core.mjs` bare to "validate" the core link: it re-points `.kitsuden` at
  `../kitsuden`. Use `node scripts/link-core.mjs --check`, which changes nothing.
- Edit `kons/kon-<id>/admin-src/tallao/` by hand. It is a copy of the tallao UI kit:
  `pnpm sync:tallao` writes it.
- Import another kon by relative path. Depend on it by package name and list it in `kon.json` →
  `dependencies.kons` (guard: `kon-installable`).
- Declare `@kitsuden/shared` or `@kitsuden/engine` in a kon's `package.json`, or make `hono`,
  `drizzle-orm` or `zod` anything other than peer dependencies.
- Set `maturity: "stable"` on a kon that is not `tier: "essential"` (guard: `kon-maturity`).
- Edit the kon table in `README.md` by hand. `pnpm maturity` writes it.
- Write a token or a key into a file in the repository.

## One source per fact

- `kon.json` holds the tables, mount path, category, maturity and dependencies. `index.ts` imports
  it (`import manifest from "./kon.json" with { type: "json" }`).
- The version is edited in `package.json`; `pnpm kon:sync` copies it to `kon.json`.
- `package.json` `files` is generated. After adding or removing a file at a kon's root, run
  `pnpm kon:sync`.
- Guard: `tests/guards/kon-single-source.test.ts`.

## Authorization in a kon

- Policies use the engine's `actsAsUserIn("<kon>")` for agents acting as users. Do not copy the
  rule by hand.
- Row security in migrations uses the core helpers `kitsuden_rls_team`, `kitsuden_rls_owned` and
  `kitsuden_rls_public_read` from `agent-functions.sql`.
- A row the caller may not see answers 404, not 403.
- Fine scopes are `kon:<kon>:<operation>`. Broad scopes are `<kon>:*`. A deny on the key wins.
  See `docs/kons/README.md` in Kitsuden.

## Commands

```bash
pnpm install
pnpm build                 # type-checks every kon
pnpm test                  # all vitest: kon tests and guards
pnpm test:guards           # only the repository rules
pnpm test:bun              # bun tests (kon-blog, kon-academy-lms, tests/bun)
pnpm vitest run tests/unit/<file>   # one file
pnpm kon:sync:check        # package.json files and kon.json in step
pnpm maturity:check        # README table matches the manifests
pnpm check:admin           # svelte-check on every kon's admin views (admin-src/)
pnpm build:admin           # rebuilds the committed admin/*.js from admin-src/views.json
pnpm sync:tallao           # refreshes admin-src/tallao/ from a tallao checkout at ../tallao
node scripts/link-core.mjs --check   # the core link is valid; changes nothing
```

`check:admin`, `build:admin` and `sync:tallao` take kon ids (`pnpm build:admin kon-wiki`); without
them they cover every kon that has `admin-src/views.json`.

Kon tests that mount the kon with the core's middleware belong in vitest (`tests/unit`), not in
bun: Bun's `mock.module` leaks across files. Run a long suite in the background and read its
summary. If a worker fails to start under load, rerun that file alone.

## Admin views

- A kon's own views are Svelte 5 components in `admin-src/`, built one file per view into
  `admin/<view>.js` (a custom element; `admin-src/views.json` lists entry and output, `kon.json` →
  `admin.views` points at the output). The built files are committed.
- After changing `admin-src/`: `pnpm check:admin <kon>` and `pnpm build:admin <kon>`, and keep the
  rebuilt `admin/*.js` in the same change.
- Build the UI with the tallao components in `admin-src/tallao/` (`$lib/components`) and its
  colour tokens (`rgb(var(--ta-…))`). If a component is missing, add it to
  [tallao](https://github.com/tallao-ui/tallao), list it in `admin-src/tallao.json` and run
  `pnpm sync:tallao <kon>` (`TALLAO_DIR=<path>` if the checkout is not `../tallao`). `"modules"`
  in `tallao.json` lists tallao's other entry points (`motion`, `toast.svelte`).
- Every view has the same frame, in the files of `admin-src/ui/` that are identical in every kon
  (`kon-crm` is the reference; change them there and copy them): `View` (theme scope and the
  Toaster), `Panel` (a section; its title is an h2, because the panel draws the page title),
  `Loadable` and `load.svelte.ts` (a skeleton while loading, an empty state with the next action,
  an error with Retry), `notify.ts` (every result is a toast), `RowMenu`, `FormGrid`. Lists are
  the kit's `DataTable`, a form with a save action ends in a `SaveBar` with dirty state, a
  destructive action goes through `ConfirmDialog`, and colours come only from `--ta-*` tokens.

## Adding a kon

`kitsuden make kon <name>` inside this repo writes `kons/kon-<name>/` with its README, AGENTS.md,
migration, policy, operations and a test in `tests/unit/`. Every kon must keep a `README.md` and
an `AGENTS.md` that match its code (guard: `tests/guards/kon-docs.test.ts`).

## Tools for agents

- `.claude/settings.json`: shared Claude Code permissions. The safe dev commands are allowed;
  reading `.env` files, `git push` and `pnpm publish` are denied.
- `.claude/skills/`: step-by-step skills, usable by any agent that reads Markdown:
  - `new-kon`: scaffold a kon with `kitsuden make kon` and take it to passing guards;
  - `fix-kon`: change a kon safely (new migration, `history.json`, version bump, docs, tests);
  - `release-check`: the full pre-release verification.
- `CONTRIBUTING.md`: setup, commands and what each guard enforces.

## Talking to a running Kitsuden

Use the API's `GET /llms.txt` before the first call, and never invent routes, flags or scopes. A
`202 KITSUDEN_E_APPROVAL_REQUIRED` means a human must approve: report the proposal, do not retry.

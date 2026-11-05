# Contributing to kitsuden-kons

Thanks for helping. Bug reports, fixes, documentation and new kons are all welcome. For a new
kon or a larger change, please open an issue first (there is a **New kon** template) so we can
agree on the approach.

Security problems go through [SECURITY.md](SECURITY.md), not public issues. Problems in the
Kitsuden core itself (API, auth, MCP server, admin panel, CLI) belong in
[Kitsuden](https://github.com/Kitsuden/kitsuden).

## Setup

You need Node 22.12 or later, pnpm 9 and [Bun](https://bun.sh) (for `pnpm test:bun`).

Kons do not run on their own: they are built and tested against a checkout of Kitsuden, linked
at `./.kitsuden`.

```bash
git clone https://github.com/Kitsuden/kitsuden ../kitsuden
(cd ../kitsuden && pnpm install && pnpm --filter @kitsuden/shared build)

git clone https://github.com/Kitsuden/kitsuden-kons
cd kitsuden-kons
node scripts/link-core.mjs        # or: KITSUDEN_DIR=../my-kitsuden node scripts/link-core.mjs
pnpm install
```

The root `package.json` links `@kitsuden/shared`, `@kitsuden/engine`, `@kitsuden/testing`,
`hono`, `drizzle-orm`, `zod`, `vitest` and `typescript` from `.kitsuden`, so every kon is checked
against the exact core it will run in.

## Commands

```bash
pnpm build                          # type-checks every kon (tsc)
pnpm test                           # all vitest: kon tests and guards
pnpm test:guards                    # only the repository rules (tests/guards)
pnpm test:bun                       # bun tests (kon-blog, kon-academy-lms, tests/bun)
pnpm vitest run tests/unit/<file>   # one file
pnpm kon:sync                       # writes package.json `files` and kon.json `version`
pnpm kon:sync:check                 # fails if they are out of step
pnpm maturity                       # writes the kon table in README.md
pnpm maturity:check                 # fails if the table does not match the manifests
```

CI (`.github/workflows/ci.yml`) runs `build`, `maturity:check`, `test` and `test:bun`, then
applies the migrations of every kon on a real Postgres with Kitsuden's own runner, and runs
Schemathesis against the kons' SDK operations.

Kon tests that mount a kon with the core's middleware belong in vitest (`tests/unit`), not in
bun: Bun's `mock.module` leaks across files.

## The guards

`tests/guards/` holds the rules every kon must follow. They run with `pnpm test` and
`pnpm test:guards`.

| Guard | What it enforces |
| --- | --- |
| `kon-manifest` | every `kon.json` is valid against the kon schema |
| `kon-loadable` | every kon exports something the loader can mount |
| `kon-installable` | every kon installs alone: declared `sdk` and `mount.path`, no relative import of another kon |
| `kon-tables` | every table a kon declares is created by one of its migrations |
| `kons-do-not-create-tables` | no `CREATE TABLE` at runtime: tables come from migrations |
| `kon-single-source` | version and tables say the same thing in `kon.json`, `package.json` and `index.ts` |
| `full-published-package` | what a kon publishes (`files`) includes everything its `index.ts` imports |
| `kon-typecheck-coverage` | every kon declares a `typecheck` script, so `pnpm build` checks it |
| `kon-icons` | every icon a kon declares exists in the admin panel's icon map |
| `kon-maturity` | every kon declares a maturity and a category; `stable` only for `tier: essential`; the README table agrees |
| `kon-registry-full` | the core's registry knows every kon |
| `kon-docs` | every kon has a `README.md` and an `AGENTS.md` with their sections, matching its version, maturity, mount path and routes, in English |
| `gates-still-deny` | authorization gates still deny after the DSL moved to English |
| `rls-kon-personal-data` | row security on the personal data of kon-members and kon-newsletter, with a non-superuser role |

## Adding a kon

Start with the Kitsuden CLI, inside this repository:

```bash
kitsuden make kon <name>
```

If `kitsuden` is not on your path, build it in the core checkout
(`(cd .kitsuden && pnpm --filter @kitsuden/cli build)`) and run
`node .kitsuden/packages/cli/dist/index.js make kon <name>` from the root of this repository.

It writes `kons/kon-<name>/` (manifest, operations, deny-by-default policy, schema, a migration
with row security, `README.md` and `AGENTS.md`) and a test in `tests/unit/` that exercises the
real routes on PGlite with a non-superuser role. Then:

1. Fill in `kon.json`: name, description, `tier`, `category`, `maturity` (start at
   `experimental`), icon, tables and mount path.
2. Model the tables in `<name>.schema.ts` and create them in `migrations/0000_initial.sql`, with
   row security from the core helpers (`kitsuden_rls_team`, `kitsuden_rls_owned`,
   `kitsuden_rls_public_read`).
3. Declare the routes as operations: REST, OpenAPI, MCP tools, scopes and approval come from one
   declaration. Fine scopes are `kon:<kon>:<operation>`, broad scopes `<kon>:*`.
4. `kitsuden make policy|model|request|job|test --kon <name>` add to an existing kon.
5. Run `pnpm kon:sync`, `pnpm maturity`, `pnpm build` and `pnpm test`.

The operation SDK, migrations and RLS are documented in
[docs/kons](https://github.com/Kitsuden/kitsuden/tree/main/docs/kons) in the Kitsuden repo.

## Rules

- **Docs:** every kon keeps a `README.md` (install, routes, permissions, configuration, MCP,
  tests) and an `AGENTS.md` (scopes, MCP tools, code map, invariants) that match its code.
  `tests/guards/kon-docs.test.ts` checks both. Change them in the same pull request as the code.
- **Versions:** edit the version in the kon's `package.json`, then run `pnpm kon:sync` to copy it
  to `kon.json`. Never edit the kon table in `README.md` by hand: `pnpm maturity` writes it.
- **Migrations:** never edit a released migration; add the next numbered file. A rename or a
  reworded comment goes in that folder's `migrations/history.json` (`renamed`,
  `previousChecksums`), or installed databases run it again or stop on a checksum drift.
- **Dependencies:** `hono`, `drizzle-orm` and `zod` are peer dependencies. Do not declare
  `@kitsuden/shared` or `@kitsuden/engine`. Another kon is a peer by name and is listed in
  `kon.json` → `dependencies.kons`; never import it by relative path.
- **Authorization:** policies use the engine's `actsAsUserIn("<kon>")` for agents acting as users.
  A row the caller may not see answers 404, not 403.
- **Tests:** a bug fix comes with a test that fails without it.
- **Secrets:** never commit a `.env` file, a token or a key. CI uses throwaway values only.
- **Language:** code, comments, docs, routes and messages are in English.

## Pull request checklist

- [ ] `pnpm build`, `pnpm test` and, if relevant, `pnpm test:bun` pass
- [ ] `pnpm kon:sync:check` and `pnpm maturity:check` pass
- [ ] Version bumped in the kon's `package.json`, then `pnpm kon:sync`
- [ ] No released migration edited
- [ ] The kon's `README.md` and `AGENTS.md` still match its code
- [ ] A test that fails without the change, for a bug fix
- [ ] No secrets in the diff

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).

---
name: new-kon
description: >-
  Create a new kon in this repository, from scaffold to passing guards. Use when the user asks to
  "add a kon", "create a kon", "write a new module", "scaffold kon-<name>", or to start a new
  domain (tables, routes, MCP tools) that does not belong to an existing kon.
---

# New kon

Read `AGENTS.md` at the root first, and one real kon's `AGENTS.md` close to the new domain
(for example `kons/kon-tierlist/AGENTS.md`). The core's `docs/kons/README.md` (in `.kitsuden/`)
documents the operation SDK.

1. **Scaffold.** From the repository root: `kitsuden make kon <name>`. If `kitsuden` is not on the
   path: `node .kitsuden/packages/cli/dist/index.js make kon <name>` (build it first with
   `(cd .kitsuden && pnpm --filter @kitsuden/cli build)` if `dist/` is missing). It writes
   `kons/kon-<name>/` and `tests/unit/kon-<name>.test.ts`. Do not hand-copy another kon.
2. **Manifest.** Fill `kons/kon-<name>/kon.json`: `name`, `description`, `tier`, `category`
   (`core`, `business`, `content`, `gaming`, `documents`), `maturity: "experimental"`, an icon the
   admin knows (guard `kon-icons`), `tables`, `mount.path`. `stable` is only for `tier: essential`.
3. **Schema and migration.** Model the tables in `<name>.schema.ts`. Create them in
   `migrations/0000_initial.sql` only, never at runtime. Enable row security with the core
   helpers `kitsuden_rls_team`, `kitsuden_rls_owned` or `kitsuden_rls_public_read`.
4. **Policy.** Deny by default in `<name>.policy.ts`; agents acting as users go through the
   engine's `actsAsUserIn("<kon>")`. A row the caller may not see answers 404, not 403.
5. **Operations.** Declare every route as an operation in `<name>.routes.ts`: REST, OpenAPI, MCP
   tool, scope (`kon:<kon>:<operation>`, broad `<kon>:*`) and approval come from it. Add
   policies, models, requests, jobs or tests with `kitsuden make <thing> --kon <name>`.
6. **Dependencies.** `hono`, `drizzle-orm`, `zod` are peers. Never declare `@kitsuden/shared` or
   `@kitsuden/engine`. Another kon: peer by package name + `kon.json` → `dependencies.kons`.
7. **Docs.** Keep the generated `README.md` and `AGENTS.md` sections and make them true: every
   route, scope, MCP tool and invariant, in English. If a new route is not in
   `authorization-matrix.kons.json`, classify it there.
8. **Tests.** Extend `tests/unit/kon-<name>.test.ts`: allowed and denied callers, row isolation.
9. **Sync and check.**
   ```bash
   pnpm kon:sync && pnpm maturity
   pnpm build
   pnpm vitest run tests/unit/kon-<name>.test.ts
   pnpm test:guards
   pnpm kon:sync:check && pnpm maturity:check
   ```
   Fix every failure; do not weaken a guard to make it pass.

Never write a token or key into a file. Do not commit unless the user asks.

---
name: fix-kon
description: >-
  Change an existing kon safely: a bug fix, a new field or route, a rename or a schema change.
  Use when the user asks to fix, change, extend or refactor anything under kons/kon-<id>/, or
  reports a bug in a kon.
---

# Fix or change a kon

1. **Read first.** `kons/kon-<id>/AGENTS.md` (scopes, MCP tools, code map, rules that must hold),
   then its `README.md`, `kon.json` and the tests that cover it (`tests/unit/*<id>*`, and
   `kons/kon-<id>/tests` if present). Respect every rule listed under "Rules that must hold".
2. **Reproduce.** For a bug, write a test that fails before changing code.
3. **Schema changes.** Never edit a released migration in `migrations/`. Add the next numbered
   file. If you rename a migration or reword its comments, record it in
   `migrations/history.json` (`renamed`: new name → old name; `previousChecksums`), or installed
   databases rerun it or stop on a checksum drift. Tables are created by migrations only; new
   tables also go in `kon.json` → `tables`. Keep row security on every new table.
4. **Authorization.** Keep deny-by-default policies, `actsAsUserIn("<kon>")` for agents, 404 for
   rows the caller may not see, and scopes `kon:<kon>:<operation>` / `<kon>:*`. A new route is
   also classified in `authorization-matrix.kons.json`.
5. **Version.** Bump the version in the kon's `package.json` (patch for fixes, minor for
   additions, major for breaking changes), then `pnpm kon:sync`. Never edit `kon.json` `version`
   or the README kon table by hand; run `pnpm maturity` if maturity or version changed.
6. **Docs stay true.** Update the kon's `README.md` (routes, permissions, configuration) and
   `AGENTS.md` (scopes, tools, code map, invariants) in the same change.
7. **Check.**
   ```bash
   pnpm build
   pnpm vitest run tests/unit/<the kon's test files>
   pnpm test:guards
   pnpm kon:sync:check && pnpm maturity:check
   ```
   Add `pnpm test:bun` for kon-blog and kon-academy-lms. Under load, rerun a failing file alone
   before concluding it is broken.

Report what changed, the new version, and any test you could not run. Do not commit unless asked.

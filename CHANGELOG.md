# Changelog

Each kon has its own version in its `package.json` (copied to `kon.json` by `pnpm kon:sync`) and
its maturity in the table of the [README](README.md). This file records releases of the repository.

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

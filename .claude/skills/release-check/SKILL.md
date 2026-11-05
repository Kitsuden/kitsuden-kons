---
name: release-check
description: >-
  Full pre-release verification of this repository. Use when the user asks "is it ready to
  release", "run the release checks", "pre-release check", "verify everything", or before
  tagging a version or publishing the repository.
---

# Release check

Run every step, even after a failure, and report a table: step, result, and what failed.
Do not fix anything unless the user asks; do not commit, tag or push.

1. **Core link.** `.kitsuden` points at a Kitsuden checkout (`node scripts/link-core.mjs`
   validates it).
2. **Type-check.** `pnpm build`
3. **Tests.** `pnpm test` (kon tests and guards), in the background; read the summary. Rerun a
   file alone if a worker failed to start.
4. **Bun tests.** `pnpm test:bun`
5. **Guards alone.** `pnpm test:guards`; `kon-docs` must pass for every kon (README.md and
   AGENTS.md exist, have their sections, match version, maturity, mount path and routes).
6. **Generated files.** `pnpm kon:sync:check` and `pnpm maturity:check`.
7. **Versions.** The root `package.json` version matches the top entry of `CHANGELOG.md`, and
   every kon whose code changed since the last release has a new version.
8. **Spanish scan.** Code, docs and messages are English only. Search tracked text files for
   Spanish prose, outside code spans and persisted names recorded in `migrations/history.json`:
   ```bash
   git grep -nIwiE 'para|los|las|que|con|una|del|está|también|cuando|según|ningún' -- \
     ':!pnpm-lock.yaml' ':!*.json' | head -50
   ```
   Review each hit; identifiers kept for compatibility are fine, prose is not.
9. **Secrets scan.** No `.env` file is tracked (`git ls-files | grep -E '(^|/)\.env'` prints
   nothing), and no key or token is in the tree:
   ```bash
   git grep -nIE '(sk-ant-|sk_live_|ghp_|github_pat_|AKIA[0-9A-Z]{16}|kitsuden_agent_[A-Za-z0-9]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY)' | head
   ```
   Never print the matching value in the report: name the file and line only.
10. **Clean tree.** `git status --short` shows only intended changes: no stray logs,
    `progress.txt`, `dist/`, `coverage/`, compiled `.js`/`.d.ts` next to sources, or scratch files.

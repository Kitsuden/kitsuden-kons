## What and why

## Kons touched

<!-- e.g. kon-wiki 1.1.1 → 1.1.2 -->

## How it was tested

- [ ] `pnpm build`
- [ ] `pnpm test` (kon tests and guards)
- [ ] `pnpm test:bun`, if it touches kon-blog, kon-academy-lms or `tests/bun`
- [ ] `pnpm kon:sync:check` and `pnpm maturity:check`
- [ ] A test that fails without this change, if it fixes a bug
- [ ] No released migration was edited (new numbered file; renames in `migrations/history.json`)
- [ ] Version bumped in the kon's `package.json`, then `pnpm kon:sync`
- [ ] The kon's `README.md` and `AGENTS.md` still match its routes and scopes
- [ ] No secrets, tokens or `.env` files in the diff

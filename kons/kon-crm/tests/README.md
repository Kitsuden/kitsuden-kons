# kon-crm tests in this folder

Most of the CRM's tests live at the repository root, in `tests/unit/kon-crm-*.test.ts`,
`tests/unit/crm-filters.test.ts` and `tests/bun/crm-dedupe-capture.test.ts` (see
[../README.md](../README.md#tests)). This folder holds the older ones:

```
tests/
├── vitest.config.ts          # config for running this folder on its own
├── crm.schema.test.ts        # Drizzle tables, columns and enums
├── crm.routes.test.ts        # every route is registered with the right method (mocked context)
└── crm.integration.spec.ts   # Playwright requests against a running API
```

## Running them

The root `vitest.config.ts` includes `kons/*/tests/**/*.test.ts`, so from the repository root:

```bash
pnpm vitest run kons/kon-crm/tests/crm.routes.test.ts
pnpm vitest run kons/kon-crm/tests/crm.schema.test.ts
```

From the kon's folder, `pnpm test` runs both with `tests/vitest.config.ts`.

The Playwright spec needs a running TEST API at `API_URL` (default `http://localhost:3000`) and an
agent key with the `crm:*` scope in `KITSUDEN_API_TOKEN` (environment only, never in a file); it
sends it as `Authorization: Bearer <token>` and checks first that a request without it gets 401.
Without the variable every test is skipped. It creates and deletes records, so never point it at
production:

```bash
API_URL=http://localhost:3000 KITSUDEN_API_TOKEN=kitsuden_agent_... pnpm test:integration
```

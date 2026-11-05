# AGENTS.md — kon-conta

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

A double-entry general ledger mounted at `/api/conta`, with billing on top (invoices, payments,
work entries, client funds, recurring and success fees, bank reconciliation, period close, audit
trail). One ledger for the whole installation: there are no per-user rows. Human docs:
[README.md](README.md).

## Calling it

- **Scopes.** The fine scope `kon:conta:<op>` alone opens that one operation (route and row
  security). For many operations use:
  - read: `conta:view`;
  - read and write: `conta:write`;
  - roles, settings, seed, reopen a period: `conta:administer`, or `conta:*` / `kon:conta:*` /
    `admin`.
  Example key for a bookkeeping agent: `["mcp:connect", "conta:write"]`. A denial
  (`!conta:write`) wins over everything else, fine scopes included.
- **MCP tools** are `conta__<operation>` (ids in `conta.routes.ts` and `conta.billing.routes.ts`).
  Reads return `{ data: ... }`; writes return `{ data: row }`; deletes return `{ success }`.
  Amounts in and out are decimal strings.
- **Approval.** Sensitive operations may come back `202 KITSUDEN_E_APPROVAL_REQUIRED` when an admin
  has turned approval on: `post-journal`, `reverse-journal`, `issue-invoice`, `void-invoice`,
  `record-payment`, `reverse-payment`, `record-expense`, the three `client-funds-*` writes,
  `run-recurring-fees`, `bill-recurring-fee`, `settle-success-fee`, `reconcile-bank-line`,
  `reconcile-suggested-lines`, `close-period`, `reopen-period`, `update-settings`,
  `grant-permission`, `seed-chart-of-accounts`, and every DELETE. Report the proposal; do not retry.
- **404** means the row does not exist or row security hid it (Postgres `42501` is translated to
  404 in `http-errors.ts`). Without any conta scope the answer is 403 "You do not have access to
  accounting" before any lookup.
- **Idempotency.** POSTs are not idempotent: pass `idempotency_key` (MCP) or `Idempotency-Key`
  (REST) when retrying. `seed-chart-of-accounts` is declared idempotent. Through the bridge,
  `externalRef` makes a repeated call record once (`created: false`).
- **Refused on purpose:**
  - Editing or deleting a posted journal: reverse it (`reverse-journal`).
  - Creating a journal with `status: "reversed"`: 422; reversal only through `/reverse`.
  - Unbalanced lines, fewer than two lines, a line with both debit and credit, or a date in a
    closed period: 400 (409 for a closed period on some billing writes).
  - Taking more out of client funds than the client holds, or a client funds line without
    `counterpartyId`.
  - Editing or deleting a billed work entry; editing an invoice that is not a draft.
  - Amounts as JSON numbers in ledger lines: the schema wants strings.
  - Template formulas that are not arithmetic.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | `defineKonSdk` definition; startup: warns about missing tables (never creates them), seeds currencies and accounts on the first start that finds no account; re-exports the service, billing, reports and bridge |
| `kon.json` | Manifest: id, version, mount path, tables, admin views |
| `operations.ts` | `KON_ID`, the `registry()` that builds SDK operations, `CONTA_PERMISSION` per action |
| `conta.routes.ts` | Ledger operations, the `conta(actions, …)` declaration helper (`withContaRole`, policy or fine-scope check, JSON body check) and `createContaRouter` |
| `conta.billing.routes.ts` | Billing operations, registered on the same registry |
| `conta.service.ts` | `ContaService`: journals, posting rules, validation, template formula evaluator, seed, ledger reports |
| `conta.billing.ts` | `BillingService`: invoices, payments, work, expenses, client funds, fees, bank, close, audit |
| `conta.reports.ts` | `ContaReports`: aging, WIP, DSO, monthly series, profitability, billing reports |
| `conta.bridge.ts` | Stable in-process surface for other kons (`ensureProject`, `ensureClient`, `clientStatement`, `recordProjectWork`, `recordProjectExpense`, `applyContaPreset`) |
| `conta.policy.ts` | The `conta` policy: `view`, `write`, `administer` from the accounting role or agent scopes |
| `conta.schema.ts` | Drizzle tables, enums, `CONTA_ROLES`, `BILLING_TYPES` |
| `http-errors.ts` | Translates errors: `AppError` as is, Postgres codes to 409/400/404, the rest a generic 500 |
| `types.ts` | `ContaDb` type |
| `migrations/` | SQL migrations 0000-0008 and `history.json`; `0008_fine_scopes_in_rls.sql` maps each operation to its action (`conta_operation_action`) for `conta_agent_can` |
| `package.json`, `tsconfig.json` | Package metadata and shipped files; TypeScript config |

## Rules that must hold

- **Every movement goes through `ContaService.createJournal`**, which enforces balance, line
  rules, closed periods and client funds limits. Guards: `tests/unit/kon-conta-billing.test.ts`
  ("pure rules", "client funds", "closed periods").
- **Posted journals are never rewritten.** Guard: `tests/unit/kon-conta-security.test.ts` ("the
  general ledger is not rewritten").
- **Formulas run without `eval`/`new Function`** (`conta.service.ts`). Guard: "template formulas
  without executing code".
- **No Postgres text reaches the client** (`http-errors.ts`). Guard: "errors without internals".
- **The accounting role comes from `conta_permissions`, never from the request.** `withContaRole`
  always overwrites `contaRole` on the user. Guard: "who gets in".
- **Row security on every table is forced** and matches the policy, including for agents
  (`conta_agent_can`), fine scopes included. Guards: "RLS: the database filters even if the route
  failed" and `tests/unit/kon-conta-agents.test.ts`.
- **The kon never runs migrations or re-seeds on boot.** Tables come from the host's runner;
  the default chart is seeded only on the first start with no account. Guard:
  `tests/unit/kon-conta-startup.test.ts`.
- **The audit log is append-only**: no UPDATE or DELETE policy (`migrations/0007_billing.sql`).
- **Multi-row writes are all or nothing** (savepoints): a refusal halfway leaves nothing.
- **Money is `Decimal` / `numeric(19,4)`**, never a JS `number`.
- **The bridge stays stable**: kon-crm and kon-payments import it at runtime by path. Guard:
  `tests/unit/kon-crm-conta-bridge.test.ts`.

## Changing it

- New migration: the next number in `migrations/` (now `0009_...sql`). Never edit an applied one.
  `migrations/history.json` records renamed files and earlier checksums; add to it only when
  renaming or rewording an applied migration. Enable and force row security on any new table,
  with the same reader/writer rules as `0007_billing.sql`.
- Keep migrations idempotent (`IF NOT EXISTS`, `DROP POLICY IF EXISTS`).
- New operation: declare it with `conta(action, …)` so the role, policy and body checks run in
  the same order as the rest, and add its id to `conta_operation_action` in a new migration
  (`kon-conta-agents.test.ts` fails until the SQL map matches the code). Mark money-moving writes `sensitive: true`.
- New file at the kon's root: run `pnpm kon:sync` (it updates package.json `files` and kon.json).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- Operation ids are the MCP tool names and fine scopes; a rename needs a migration of stored
  scopes (as `0007_billing.sql` does).
- Do not use `Promise.all` on the request transaction.

## Tests

```bash
pnpm vitest run tests/unit/kon-conta-security.test.ts   # routes, policy, errors, RLS
pnpm vitest run tests/unit/kon-conta-agents.test.ts     # agent scopes and RLS functions
pnpm vitest run tests/unit/kon-conta-startup.test.ts    # startup: no migrations, first-start seed
pnpm vitest run tests/unit/kon-conta-billing.test.ts    # billing, client funds, close, reports
pnpm vitest run tests/unit/kon-conta-reads.test.ts      # reads, settings, attention, bridge
pnpm vitest run tests/unit/kon-crm-conta-bridge.test.ts # after touching conta.bridge.ts
```

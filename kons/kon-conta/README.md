# kon-conta

A double-entry general ledger for Kitsuden, and the billing a business runs on top of it: clients,
projects, work billed as quantity times rate, invoices, payments, client funds, recurring and
success fees, bank reconciliation, period close and an audit trail. For a business that keeps its
books in Kitsuden, whatever it sells.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | business | 1.0.1 | `/api/conta` | — (core `auth`) |

## Install

Inside a Kitsuden project:

```bash
kitsuden kon add conta
```

It needs no other kon and no environment variables. The manifest does not set
`defaultEnabled: false`, so `--enable` is not needed. The host's migration runner creates the
tables (the kon never runs its migrations itself; at startup it only warns if a table is missing).
Restart the API. The first start that finds no account seeds the default currencies and chart of
accounts (`ContaService.seedDefaultAccounts`); later starts leave the chart alone. To seed again on
purpose: `POST /api/conta/seed`.

After installing, an admin grants accounting roles (`PUT /api/conta/permissions/:userId`): no
one but an admin sees the books until then.

## What it adds

The engine knows accounts, journals and balances; on top of them, clients, projects, resources
and invoices. What an installation calls each thing is configuration (`labels` in settings).

| Table | What it holds |
| --- | --- |
| `conta_currencies` | Currencies for multi-currency lines |
| `conta_accounts` | Hierarchical chart of accounts; `isClientFundsAccount` marks money held for clients |
| `conta_counterparties` | Clients, vendors, banks, others |
| `conta_projects` | Work billed to a client; billing type `time`, `fixed`, `recurring` or `success` |
| `conta_journal_templates` | Rules that turn a business event into journal lines |
| `conta_journals` | Journal headers (draft, posted, reversed) |
| `conta_ledger_entries` | Double-entry lines (account, debit, credit, currency, project, `metadata`) |
| `conta_disbursements` | Expenses paid for a client, to be billed on |
| `conta_permissions` | Accounting role per user: `accountant` (read and write) or `viewer` (read) |
| `conta_settings` | One row: currency, tax rate, numbering, terms, closed date, account codes, labels, issuer, targets |
| `conta_number_sequences` | Gapless document counters per kind and year |
| `conta_resources` | People or things billed per unit, with billing and cost rates |
| `conta_work_entries` | Work on a project as quantity times rate, or work in progress |
| `conta_invoices`, `conta_invoice_lines` | Invoices from draft to paid or void, and their lines |
| `conta_invoice_payments` | Full and partial payments, each with its journal |
| `conta_invoice_reminders` | Payment reminders recorded on an invoice |
| `conta_recurring_fees` | Fees billed every period, with the next billing date |
| `conta_success_fees` | Fees that depend on a result, with the expected amount |
| `conta_bank_lines` | Statement lines and how each was reconciled |
| `conta_audit_log` | Every accounting action, append-only |

Design rules the code follows:

- **One posting path.** Every movement goes through `ContaService.createJournal`, which refuses
  unbalanced entries, fewer than two lines, a line with both sides, dates in a closed period and
  client funds overdrafts.
- **Money is decimal text.** Send amounts as strings (`"1000.50"`), never numbers. The database
  uses `numeric(19,4)` and the code `decimal.js`.
- **Templates are arithmetic, not code.** `amountFormula` takes `+ - * /` and parentheses over the
  variables you pass; it is evaluated without `eval` or `new Function`.
- **Posted journals are not edited or deleted.** A draft is edited or deleted; a posted journal is
  reversed (a counter-entry).
- **Client funds.** A line on a client funds liability account needs the client
  (`counterpartyId`), and nothing takes out more than that client holds.
- **Quantities of different units are never added.** Reports give them per unit and compare work
  by value.

## HTTP API

All routes except `GET /api/conta` need a session and an accounting role. "view" = admin,
`accountant` or `viewer`; "write" = admin or `accountant`; "admin" = admin only (see
[Who can do what](#who-can-do-what)). Bodies are strict: an unknown field is a 422.

### Ledger

| Route | Needs | What it does |
| --- | --- | --- |
| `GET /api/conta` | public | Kon name and description; no data |
| `GET /api/conta/me` | view | The caller's accounting role |
| `GET /api/conta/permissions` | admin | Who holds an accounting role |
| `PUT /api/conta/permissions/:userId` | admin | Grant or change a role (`accountant`, `viewer`) |
| `DELETE /api/conta/permissions/:userId` | admin | Revoke a role |
| `GET /api/conta/currencies` | view | List currencies |
| `POST /api/conta/currencies` | write | Create a currency |
| `GET /api/conta/accounts` | view | List accounts |
| `GET /api/conta/accounts/:id` | view | Account detail |
| `POST /api/conta/accounts` | write | Create an account |
| `PATCH /api/conta/accounts/:id` | write | Edit an account |
| `DELETE /api/conta/accounts/:id` | write | Deactivate an account |
| `GET /api/conta/counterparties` | view | List counterparties |
| `GET /api/conta/counterparties/:id` | view | Counterparty detail |
| `POST /api/conta/counterparties` | write | Create a counterparty |
| `PATCH /api/conta/counterparties/:id` | write | Edit a counterparty |
| `DELETE /api/conta/counterparties/:id` | write | Delete a counterparty |
| `GET /api/conta/projects` | view | List projects |
| `GET /api/conta/projects/:id` | view | Project detail |
| `POST /api/conta/projects` | write | Create a project |
| `PATCH /api/conta/projects/:id` | write | Edit a project |
| `DELETE /api/conta/projects/:id` | write | Delete a project |
| `GET /api/conta/templates` | view | List journal templates |
| `GET /api/conta/templates/:id` | view | Template detail |
| `POST /api/conta/templates` | write | Create a template |
| `PATCH /api/conta/templates/:id` | write | Edit a template |
| `DELETE /api/conta/templates/:id` | write | Deactivate a template |
| `POST /api/conta/templates/:id/apply` | view | Preview: the lines a template produces for the given `variables`; saves nothing |
| `GET /api/conta/journals` | view | List journals (filters, `include=lines`, a `summary`) |
| `GET /api/conta/journals/:id` | view | Journal with its lines |
| `POST /api/conta/journals/validate` | view | Check a journal without saving |
| `POST /api/conta/journals` | write | Create a journal (draft or posted) |
| `PATCH /api/conta/journals/:id` | write | Edit a draft journal |
| `DELETE /api/conta/journals/:id` | write | Delete a draft journal |
| `POST /api/conta/journals/:id/post` | write | Post a draft journal |
| `POST /api/conta/journals/:id/reverse` | write | Reverse a posted journal with a counter-entry |
| `GET /api/conta/t-account/:accountId` | view | T-account view of one account |
| `GET /api/conta/client-funds/balance` | view | Balance of a client funds account (`accountId`, optional `projectId`) |
| `GET /api/conta/disbursements` | view | List disbursements |
| `GET /api/conta/disbursements/:id` | view | Disbursement detail |
| `POST /api/conta/disbursements` | write | Record a disbursement (Dr disbursements receivable, Cr the paying account) |
| `POST /api/conta/disbursements/:id/bill` | write | Bill a disbursement on its own |
| `POST /api/conta/disbursements/:id/pay` | write | Mark a disbursement paid |
| `DELETE /api/conta/disbursements/:id` | write | Delete a pending disbursement |
| `GET /api/conta/reports/trial-balance` | view | Trial balance |
| `GET /api/conta/reports/balance-sheet` | view | Balance sheet as of `asOf`, with net income not yet closed |
| `GET /api/conta/reports/profit-loss` | view | Income statement between `dateFrom` and `dateTo`; `groupBy=month` or `quarter` per period |
| `POST /api/conta/seed` | admin | Seed the default chart of accounts (idempotent) |

### Billing

| Route | Needs | What it does |
| --- | --- | --- |
| `GET /api/conta/settings` | view | Currency, tax rate, numbering, terms, closed date, account codes, `labels`, `billingTypes`, `issuer`, `targets` |
| `PATCH /api/conta/settings` | admin | Change settings (`issuer` merged field by field, `targets` replaced) |
| `GET /api/conta/periods` | view | Closed date and close checklist |
| `POST /api/conta/periods/close` | write | Close a period |
| `POST /api/conta/periods/reopen` | admin | Reopen a closed period |
| `GET /api/conta/resources` | view | List resources |
| `POST /api/conta/resources` | write | Create a resource (`unit`, `billingRate`, `costRate`) |
| `PATCH /api/conta/resources/:id` | write | Edit a resource |
| `GET /api/conta/work-entries` | view | List work entries |
| `POST /api/conta/work-entries` | write | Record work on a project (rate and unit copied from the resource) |
| `PATCH /api/conta/work-entries/:id` | write | Edit an unbilled work entry |
| `DELETE /api/conta/work-entries/:id` | write | Delete an unbilled work entry |
| `POST /api/conta/expenses` | write | Record an expense on a project, paid by the business or `paidFrom: "client_funds"` |
| `GET /api/conta/invoices` | view | List invoices (filters, sorting, a `summary`; `include=counts` for counts per status) |
| `GET /api/conta/invoices/:id` | view | Invoice detail; `include=journals` adds the journals behind it |
| `POST /api/conta/invoices` | write | Create a draft invoice |
| `PATCH /api/conta/invoices/:id` | write | Edit a draft invoice |
| `POST /api/conta/invoices/:id/issue` | write | Issue a draft: next number, posts receivable against revenue, expenses and tax |
| `POST /api/conta/invoices/:id/void` | write | Void an invoice with a credit note |
| `POST /api/conta/invoices/:id/payments` | write | Record a full or partial payment, or one from client funds |
| `POST /api/conta/payments/:id/reverse` | write | Reverse a payment |
| `POST /api/conta/invoices/:id/reminders` | write | Record a payment reminder |
| `POST /api/conta/invoices/reminders` | write | Record a reminder on many invoices (up to 500) |
| `POST /api/conta/invoices/:id/delivery` | write | Record that an invoice was sent or viewed |
| `POST /api/conta/client-funds/deposits` | write | Receive client funds |
| `POST /api/conta/client-funds/disbursements` | write | Pay out of client funds |
| `POST /api/conta/client-funds/refunds` | write | Return funds to a client |
| `GET /api/conta/client-funds` | view | Funds per client, minimum, top-up to ask for |
| `GET /api/conta/client-funds/transactions` | view | Client funds statement with running balance |
| `GET /api/conta/client-funds/reconciliation` | view | Three-way check: bank = liability = sum of clients |
| `GET /api/conta/recurring-fees` | view | List recurring fees |
| `POST /api/conta/recurring-fees` | write | Create a recurring fee (monthly, quarterly, semiannual, annual) |
| `PATCH /api/conta/recurring-fees/:id` | write | Edit or pause a recurring fee |
| `POST /api/conta/recurring-fees/run` | write | Bill every recurring fee that is due |
| `POST /api/conta/recurring-fees/:id/bill` | write | Bill one recurring fee now |
| `GET /api/conta/success-fees` | view | List success fees |
| `POST /api/conta/success-fees` | write | Create a success fee |
| `PATCH /api/conta/success-fees/:id` | write | Edit a success fee |
| `POST /api/conta/success-fees/:id/settle` | write | Settle a success fee as won or lost |
| `POST /api/conta/bank-lines/import` | write | Import statement lines |
| `GET /api/conta/bank-lines` | view | List statement lines |
| `GET /api/conta/bank-lines/summary` | view | Books against statement |
| `GET /api/conta/bank-lines/:id/suggestion` | view | Suggested match for a statement line |
| `POST /api/conta/bank-lines/reconcile-suggested` | write | Accept the high-confidence suggestions |
| `POST /api/conta/bank-lines/:id/reconcile` | write | Reconcile one statement line |
| `GET /api/conta/audit` | view | Audit trail |
| `GET /api/conta/attention` | view | Overdue invoices, drafts, fees due, clients under their funds minimum, unreconciled lines, closed date |
| `GET /api/conta/reports/aging` | view | Receivables by age |
| `GET /api/conta/reports/aging-by-client` | view | Receivables by age, per client |
| `GET /api/conta/reports/wip` | view | Work in progress |
| `GET /api/conta/reports/dso` | view | Days to collect |
| `GET /api/conta/reports/monthly-series` | view | Billed, collected and spent per month |
| `GET /api/conta/reports/profitability/projects` | view | Profitability per project |
| `GET /api/conta/reports/profitability/resources` | view | Profitability per resource |
| `GET /api/conta/reports/billing-by-client` | view | Billing per client |
| `GET /api/conta/reports/billing-by-category` | view | Billing per category |
| `GET /api/conta/reports/resource-performance` | view | Billing per resource |

Example: a template applied, then posted.

```bash
POST /api/conta/templates/:id/apply   { "variables": { "total": 1000, "taxRate": 0.07 } }
# returns the lines, ready for:
POST /api/conta/journals              { "date": "2025-01-15", "description": "Sale", "lines": [...] }
```

## Who can do what

The policy is `conta.policy.ts` (resource `conta`, actions `view`, `write`, `administer`). The
accounting role is not the site role: it comes from `conta_permissions`, so a site `editor` sees
nothing without one. The host's gate does not cover `/api/conta`; the kon authorizes itself.

| Actor | view | write | administer (roles, settings, seed, reopen) |
| --- | --- | --- | --- |
| Anonymous | `GET /api/conta` only | no | no |
| Account without an accounting role | no (403) | no | no |
| `viewer` | yes | no | no |
| `accountant` | yes | yes | no |
| Human `admin` | yes | yes | yes |
| Agent with `conta:view` | yes | no | no |
| Agent with `conta:write` | yes | yes | no |
| Agent with `conta:administer`, `conta:*`, `kon:conta:*` or `admin` | yes | yes | yes |
| Agent with an operation's fine scope `kon:conta:<operation>` | that operation only | that operation only | that operation only |

Every table has forced row security with the same rule (migrations `0006_english_rls.sql` and
`0007_billing.sql`): an admin, a user with an accounting role, or an agent whose scopes grant the
action (`conta_agent_can`). Since `0008_fine_scopes_in_rls.sql` the fine scope of an operation grants
its declared action in row security too (a read operation reads the ledger, a write operation writes
it), while the route lets that scope run only its own operation. The audit log has no UPDATE or DELETE policy. In `conta_permissions` a user reads only
their own row; admins and agents with `conta:administer` read and write all of it.

There are no per-user rows: it is one ledger. A missing id is a 404; a row hidden by row security
also answers 404 (Postgres permission errors are translated to 404 in `http-errors.ts`).

## Configuration

No environment variables. Settings live in the `conta_settings` row and are changed through
`PATCH /api/conta/settings`: base currency, default tax rate, numbering, payment terms, account
code per kind of movement, bank charge keywords, `labels`, `billingTypes`, `issuer` and `targets`.
The closed date changes only through the period routes.

## Agents and MCP

Every route is a kon SDK operation and an MCP tool `conta__<operation>` (for example
`conta__list-accounts`, `conta__create-journal`, `conta__issue-invoice`); the operation ids are in
`conta.routes.ts` and `conta.billing.routes.ts`. Each publishes the fine scope
`kon:conta:<operation>`, which alone opens that operation, in the route and in row security. For
many operations at once use `conta:view`, `conta:write`, `conta:administer` or `conta:*` (or
`admin`). A denial wins over all of them: `!conta:write` closes every write, fine scopes included.

Operations marked sensitive, which an admin can hold for human approval
(`202 KITSUDEN_E_APPROVAL_REQUIRED`): `grant-permission`, `post-journal`, `reverse-journal`,
`seed-chart-of-accounts`, `update-settings`, `close-period`, `reopen-period`, `record-expense`,
`issue-invoice`, `void-invoice`, `record-payment`, `reverse-payment`, `client-funds-deposit`,
`client-funds-disburse`, `client-funds-refund`, `run-recurring-fees`, `bill-recurring-fee`,
`settle-success-fee`, `reconcile-suggested-lines`, `reconcile-bank-line`, and every DELETE.

Other kons call the ledger in process through `conta.bridge.ts` (`ensureProject`, `ensureClient`,
`clientStatement`, `recordProjectWork`, `recordProjectExpense`, `applyContaPreset`): kon-crm and
kon-payments do. With `externalRef`, a repeated call records once and answers `created: false`.
Details for agents: [AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/kon-conta-security.test.ts` | Roles, strict bodies, posted journals not rewritten, errors without internals, formulas without code, RLS |
| `tests/unit/kon-conta-agents.test.ts` | Agent scopes, fine scopes, denials, row security without the app, the SQL map of operations to actions |
| `tests/unit/kon-conta-startup.test.ts` | Startup creates no tables and seeds the chart of accounts only on the first start |
| `tests/unit/kon-conta-reads.test.ts` | Bridge, invoice and journal reads, income statement, settings, attention, recurring fees |
| `tests/unit/kon-conta-billing.test.ts` | Work, invoices, payments, client funds, fees, bank, reports, closed periods, labels, bridge, upgrade from 0006 |
| `tests/unit/kon-crm-conta-bridge.test.ts` | The bridge as kon-crm uses it |

```bash
pnpm vitest run tests/unit/kon-conta-security.test.ts
pnpm vitest run tests/unit/kon-conta-agents.test.ts
pnpm vitest run tests/unit/kon-conta-reads.test.ts
pnpm vitest run tests/unit/kon-conta-billing.test.ts
pnpm vitest run tests/unit/kon-crm-conta-bridge.test.ts
```

## License

MIT

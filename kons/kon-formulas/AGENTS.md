# AGENTS.md — kon-formulas

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

A store of game formula systems (`formula_systems`) and a safe evaluator for them, mounted at
`/api/formulas`. Reading is public, evaluating needs a session, writing is for site staff.
`kon-character-builder` builds on it.

## Calling it

- Read: no scope needed (`list-systems` and `get-system` are public).
- Evaluate: `user:act`, `admin`, `formulas:*` or the fine scope `kon:formulas:evaluate-system`.
- Write: `formulas:create` to create, `formulas:update` to rewrite an existing slug (or
  `formulas:*`, or the fine scope `kon:formulas:save-system`). Example key scopes for an agent that
  maintains systems: `["formulas:create", "formulas:update"]`.
- MCP tools:
  - `formulas__list-systems` returns `{ data: [system] }`.
  - `formulas__get-system` (`slug`) returns `{ data, inputs, outputs }`. Call it before
    `evaluate-system` to learn which inputs to send.
  - `formulas__evaluate-system` (`slug`, `body: { inputs }`) returns `{ data: { name: value } }`
    with every input and stat.
  - `formulas__save-system` (`body: { slug, name, stats }`) returns `{ data: system }`. It is
    sensitive: it may come back `202 KITSUDEN_E_APPROVAL_REQUIRED`. Report the proposal; do not
    retry.
- 404 means the slug does not exist. There is no row security on this table, so nothing is hidden.
- `save-system` is a `PUT` upsert by slug, so repeating it leaves the same state. It replaces the
  whole `stats` array: send every stat, not only the changed one.
- A 422 from `save-system`, `get-system` or `evaluate-system` carries the engine's message (the
  failing variable, function or cycle). Fix the formula; do not retry the same body.
- Refused on purpose: more than 500 inputs, non-finite numbers, formulas over 2000 characters,
  functions outside the allowlist, `__proto__`/`constructor`/`prototype` as names. There is no
  delete operation.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | The four SDK operations, input/output schemas, the 500-input cap, `defineKonSdk` (mount, admin view). |
| `formula.engine.ts` | Tokenizer, parser to RPN, function allowlist, `compile`, `evaluate`, `compileSystem` (topological order, cycle detection), `evaluateSystem`. |
| `formulas.policy.ts` | The `formulas` policy: `view` open, `create`/`update` admin or editor, `delete` admin, `actAsUser`. |
| `formulas.schema.ts` | Drizzle table `formula_systems`. |
| `migrations/0001_formulas.sql` | Creates the table and the unique slug index. |
| `migrations/0002_english_names.sql` | Renames stored scopes, tool names and pending proposals from the old Spanish operation ids to the English ones. |
| `migrations/history.json` | Earlier checksums of `0001_formulas.sql` (text changed, SQL did not). |

## Rules that must hold

- No `eval`, `Function` or third-party expression library. Only the allowlist in
  `formula.engine.ts` (`FUNCTIONS`). Guarded by `tests/unit/formula-engine.test.ts`
  ("security: allowlist, not sandbox").
- A system is compiled before it is saved; a broken system never reaches the table
  (`save-system` in `index.ts`).
- Every function is total over finite numbers; a non-finite result is a `FormulaError`
  (`formula-engine.test.ts`).
- `evaluateSystem` uses a prototype-less object; reserved identifiers are rejected at compile time.
- `evaluate-system` stays capped at `MAX_EVALUATION_INPUTS` (500) and stays read-only
  (`tests/unit/sec-data-wiki-maps-formulas.test.ts`).
- Rewriting an existing slug checks `update` on the stored row, not only `create`.
- Operation ids (`list-systems`, `get-system`, `save-system`, `evaluate-system`) are part of the
  contract (scopes, MCP tool names). Do not rename them.

## Changing it

- New migration: next number in `migrations/` (`0003_...sql`), never edit an applied one. If you
  must rename a migration file or reword one without changing its SQL, declare it in
  `migrations/history.json` (`renamed` or `previousChecksums`).
- New file at the root: run `pnpm kon:sync` (it updates package.json `files` and kon.json).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- A new engine function must be total (never throw, never return a non-finite number for finite
  input) and needs a test in `formula-engine.test.ts`.

## Tests

```bash
pnpm vitest run tests/unit/formula-engine.test.ts               # after touching formula.engine.ts
pnpm vitest run tests/unit/sec-data-wiki-maps-formulas.test.ts  # after touching index.ts or the policy
```

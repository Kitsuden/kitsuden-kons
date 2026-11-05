# kon-formulas

A safe formula engine for game tools. Site staff store "formula systems" (how a game computes
damage, defense and other derived stats); calculators, builders and agents read them and evaluate
them with their own inputs.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | gaming | 1.0.1 | `/api/formulas` | — (core: `auth`) |

## Install

```bash
kitsuden kon add formulas --enable
```

The kon is off by default (`defaultEnabled: false` in `package.json`), so pass `--enable` or switch
it on in the admin panel (**Kons**). Restart the API afterwards. No other kon and no environment
variable is needed. `kon-character-builder` declares this kon as a dependency.

## What it adds

- **Formula system**: a named set of stats, each one a formula over variables
  (`def_final = def_base * (1 + def_pct / 100)`). Stored in the table `formula_systems`
  (`slug` unique, `name`, `stats` as JSONB).
- **Inputs and outputs**: a variable that no stat defines is an input the user must provide. The
  compiler sorts the stats by dependency, so authors can write them in any order.
- **The engine** (`formula.engine.ts`): a tokenizer and shunting-yard parser with no `eval()`. It
  knows numbers, variables, `+ - * / % ^`, parentheses, comparisons (`> < >= <= == !=`, which give
  `1` or `0`) and an allowlist of functions: `min`, `max`, `floor`, `ceil`, `round`, `abs`,
  `sqrt`, `exp`, `clamp`, `if`. Anything else is rejected at compile time.

Rules the engine applies:

- A formula is at most 2000 characters.
- `__proto__`, `constructor` and `prototype` cannot be used as variable or stat names.
- A stat defined twice, an unknown function, a wrong number of arguments or a dependency cycle is
  an error at compile time (the cycle error names the path).
- A variable without a value is an error, not a silent zero. A result that is not a finite number
  is an error.
- `sqrt` of a negative number gives 0; `exp` clamps its argument to ±50; division by zero gives 0.

## HTTP API

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/formulas/systems` | anyone | Every system, sorted by name, with its stats. |
| `GET /api/formulas/systems/:slug` | anyone | One system plus `inputs` (variables to provide) and `outputs` (stats in evaluation order). 404 if missing; 422 if the stored system no longer compiles. |
| `PUT /api/formulas/systems` | admin, editor, or an agent with the scope | Create or rewrite a system by `slug`: 201 on create, 200 on rewrite. It is compiled first; a broken system is a 422 and nothing is saved. |
| `POST /api/formulas/systems/:slug/evaluate` | any signed-in account | Body `{ "inputs": { "<variable>": <number> } }` (at most 500 finite numbers). Declared inputs that are missing count as 0. Returns every variable and stat with its value. Changes nothing. |

Validation limits on `PUT`: `slug` matches `^[a-z0-9-]+$` (1 to 80 characters), `name` 1 to 120
characters, 1 to 300 stats, each stat name a valid identifier of at most 60 characters.

## Who can do what

The policy is `formulas.policy.ts` (resource `formulas`):

| Role | Read systems | Evaluate | Create a system | Rewrite a system |
| --- | --- | --- | --- | --- |
| anonymous | yes | no (401) | no | no |
| signed-in user | yes | yes | no (403) | no (403) |
| editor | yes | yes | yes | yes |
| admin | yes | yes | yes | yes |
| agent | yes | with `user:act`, `admin` or a `formulas` scope | with `formulas:create` or `formulas:*` | with `formulas:update` or `formulas:*` |

Rewriting an existing slug checks `update` against the stored row, not only `create`. The policy
also declares `delete` (admin only), but the kon has no delete route.

`formula_systems` has no row-security policy of its own: what a caller may write is decided by the
policy above, and every row is public to read.

## Configuration

None. The kon reads no environment variable and no setting.

## Agents and MCP

Every route is an SDK operation, so each one is also an MCP tool:

| MCP tool | Fine scope | Writes |
| --- | --- | --- |
| `formulas__list-systems` | `kon:formulas:list-systems` | no |
| `formulas__get-system` | `kon:formulas:get-system` | no |
| `formulas__evaluate-system` | `kon:formulas:evaluate-system` | no (read-only) |
| `formulas__save-system` | `kon:formulas:save-system` | yes, marked sensitive |

`save-system` is sensitive: when an admin turns human approval on, an agent's call is held and
answers `202 KITSUDEN_E_APPROVAL_REQUIRED` until a person approves it. See [AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/formula-engine.test.ts` | The engine: allowlist, precedence, functions, variables, dependency order, cycles. |
| `tests/unit/sec-data-wiki-maps-formulas.test.ts` (`describe("formulas")`) | The routes: the 500-input cap on `evaluate`, a normal account cannot write a system. |

```bash
pnpm vitest run tests/unit/formula-engine.test.ts
pnpm vitest run tests/unit/sec-data-wiki-maps-formulas.test.ts
```

## License

MIT

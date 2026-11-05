/**
 * Formula engine — safe evaluator of game expressions
 * ============================================================================
 *
 * The foundation of everything else: builders, calculators and simulators are, at
 * heart, formulas over variables ("damage is ATK × skill% × (1 - DEF/(DEF
 * + 1000))"). This kon evaluates them SAFELY and DETERMINISTICALLY.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A CUSTOM PARSER AND NOT `eval()` NOR A LIBRARY
 *
 * `eval()` is ruled out without discussion: formulas are written by CMS users,
 * and evaluating their text as JavaScript is handing them the server.
 *
 * Ecosystem libraries are out as well: `expr-eval` has gone years without
 * maintenance with sandbox-escape CVEs, and `mathjs` is ~500KB to
 * use a fraction — and its `evaluate` has had its own escapes. A
 * 200-line shunting-yard that ONLY knows numbers, operators and the
 * functions on this allowlist has no escape surface: there are no
 * strings, no objects, no access to anything.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Grammar: numbers, variables (`atk`, `skill_pct`), + - * / % ^,
 * parentheses, comparisons (> < >= <= == !=  → 1|0), and allowlisted functions.
 * Nothing more — everything that is not supported is surface that does not
 * have to be defended.
 */

// ── Tokenizador ──────────────────────────────────────────────────────────────

type Token =
  | { kind: "number"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "op"; op: string }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "comma" };

const OPERATORS = ["+", "-", "*", "/", "%", "^", ">", "<", ">=", "<=", "==", "!="] as const;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (/[0-9.]/.test(ch)) {
      const match = /^[0-9]*\.?[0-9]+/.exec(source.slice(i));
      if (!match) throw new FormulaError(`Invalid number at position ${i}`);
      tokens.push({ kind: "number", value: Number(match[0]) });
      i += match[0].length;
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      const match = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(source.slice(i))!;
      tokens.push({ kind: "ident", name: match[0] });
      i += match[0].length;
      continue;
    }

    // Two-character operators before one-character ones: `>=` is not `>` + `=`.
    const two = source.slice(i, i + 2);
    if ((OPERATORS as readonly string[]).includes(two)) {
      tokens.push({ kind: "op", op: two });
      i += 2;
      continue;
    }
    if ((OPERATORS as readonly string[]).includes(ch)) {
      tokens.push({ kind: "op", op: ch });
      i++;
      continue;
    }

    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma" });
      i++;
      continue;
    }

    throw new FormulaError(`Unexpected character "${ch}" at position ${i}`);
  }

  return tokens;
}

// ── Parser (shunting-yard → RPN) ─────────────────────────────────────────────

export class FormulaError extends Error {}

/**
 * Allowed functions. ALLOWLIST: what is not here does not exist.
 *
 * All are total over finite numbers — none can throw or return
 * objects. `if(cond, a, b)` covers the conditional without introducing a ternary
 * operator into the grammar.
 */
const FUNCTIONS: Record<string, { arity: number; apply: (args: number[]) => number }> = {
  min: { arity: 2, apply: ([a, b]) => Math.min(a, b) },
  max: { arity: 2, apply: ([a, b]) => Math.max(a, b) },
  floor: { arity: 1, apply: ([a]) => Math.floor(a) },
  ceil: { arity: 1, apply: ([a]) => Math.ceil(a) },
  round: { arity: 1, apply: ([a]) => Math.round(a) },
  abs: { arity: 1, apply: ([a]) => Math.abs(a) },
  sqrt: { arity: 1, apply: ([a]) => Math.sqrt(Math.max(0, a)) },
  /**
   * e^a. Total like the others: the argument is clamped to ±50 (e^50 ≈ 5·10^21),
   * so it never returns Infinity or an exact 0. It serves to combine by
   * MULTIPLICATION what the engine only knows how to ADD: storing ln(1 − n/100) of
   * each piece, 100·(1 − exp(sum)) is a team's total negation (two
   * 10 % pieces give 19 %, not 20 %).
   */
  exp: { arity: 1, apply: ([a]) => Math.exp(Math.min(Math.max(a, -50), 50)) },
  clamp: { arity: 3, apply: ([v, lo, hi]) => Math.min(Math.max(v, lo), hi) },
  if: { arity: 3, apply: ([cond, a, b]) => (cond !== 0 ? a : b) },
};

const PRECEDENCE: Record<string, number> = {
  "==": 1,
  "!=": 1,
  ">": 2,
  "<": 2,
  ">=": 2,
  "<=": 2,
  "+": 3,
  "-": 3,
  "*": 4,
  "/": 4,
  "%": 4,
  "^": 5,
  neg: 6, // unary minus
};

const RIGHT_ASSOC = new Set(["^", "neg"]);

/**
 * Identifiers forbidden as a variable or stat name.
 *
 * They are not an execution risk —the engine never evaluates text— but they ARE a
 * read risk: `variables["__proto__"]` on an object literal returns
 * `Object.prototype` instead of `undefined`, so a variable with that
 * name would dodge the "no value" check and reach the arithmetic
 * as an object. They are rejected here, where the author can read the reason, instead
 * of being defended against on every read.
 */
const RESERVED_IDENTIFIERS = new Set(["__proto__", "constructor", "prototype"]);

type RpnItem =
  | { kind: "number"; value: number }
  | { kind: "var"; name: string }
  | { kind: "op"; op: string }
  | { kind: "call"; name: string; arity: number };

export interface CompiledFormula {
  rpn: RpnItem[];
  /** Variables the formula references. For resolving dependencies. */
  variables: string[];
}

/**
 * Compiles an expression to RPN.
 *
 * Compiling and evaluating are separate on purpose: a builder evaluates the same
 * formula hundreds of times with different variables, and parsing each time would be
 * paying the cost N times out of laziness.
 */
export function compile(source: string): CompiledFormula {
  if (source.length > 2000) {
    throw new FormulaError("The formula exceeds 2000 characters");
  }

  const tokens = tokenize(source);
  if (tokens.length === 0) throw new FormulaError("Empty formula");

  const output: RpnItem[] = [];
  const stack: Array<
    { kind: "op"; op: string } | { kind: "lparen" } | { kind: "func"; name: string; args: number }
  > = [];
  const variables = new Set<string>();

  let prev: Token | null = null;

  for (const token of tokens) {
    if (token.kind === "number") {
      output.push({ kind: "number", value: token.value });
    } else if (token.kind === "ident") {
      if (RESERVED_IDENTIFIERS.has(token.name)) {
        throw new FormulaError(`"${token.name}" cannot be used as a name`);
      }
      // An identifier followed by `(` is a function; otherwise, a variable.
      // It is decided on seeing the next token, so it is deferred here.
      variables.add(token.name);
      output.push({ kind: "var", name: token.name });
    } else if (token.kind === "lparen") {
      // Was it a call? The last item in the output would be the "variable".
      const last = output[output.length - 1];
      if (prev?.kind === "ident" && last?.kind === "var") {
        const name = last.name;
        if (!FUNCTIONS[name]) {
          throw new FormulaError(
            `Unknown function "${name}". Allowed: ${Object.keys(FUNCTIONS).join(", ")}`
          );
        }
        output.pop();
        variables.delete(name);
        stack.push({ kind: "func", name, args: 1 });
      } else {
        stack.push({ kind: "lparen" });
      }
    } else if (token.kind === "comma") {
      while (stack.length && stack[stack.length - 1].kind === "op") {
        output.push(stack.pop() as RpnItem);
      }
      const top = stack[stack.length - 1];
      if (top?.kind !== "func") throw new FormulaError("Comma outside a function call");
      top.args++;
    } else if (token.kind === "op") {
      // Unary minus: at the start, after `(`, after a comma or after another operator.
      const isUnary =
        token.op === "-" &&
        (!prev || prev.kind === "op" || prev.kind === "lparen" || prev.kind === "comma");
      const op = isUnary ? "neg" : token.op;

      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.kind !== "op") break;
        const higher =
          PRECEDENCE[top.op] > PRECEDENCE[op] ||
          (PRECEDENCE[top.op] === PRECEDENCE[op] && !RIGHT_ASSOC.has(op));
        if (!higher) break;
        output.push(stack.pop() as RpnItem);
      }
      stack.push({ kind: "op", op });
    } else if (token.kind === "rparen") {
      while (stack.length && stack[stack.length - 1].kind === "op") {
        output.push(stack.pop() as RpnItem);
      }
      const top = stack.pop();
      if (!top) throw new FormulaError("Closing parenthesis without opening");
      if (top.kind === "func") {
        const fn = FUNCTIONS[top.name];
        if (top.args !== fn.arity) {
          throw new FormulaError(
            `${top.name}() expects ${fn.arity} argument(s), received ${top.args}`
          );
        }
        output.push({ kind: "call", name: top.name, arity: fn.arity });
      } else if (top.kind !== "lparen") {
        throw new FormulaError("Unbalanced parentheses");
      }
    }
    prev = token;
  }

  while (stack.length) {
    const top = stack.pop()!;
    if (top.kind !== "op") throw new FormulaError("Unclosed parenthesis");
    output.push(top);
  }

  // Structural validation: evaluating with zeros detects broken arities NOW,
  // not the first time a user opens the calculator.
  try {
    evaluateRpn(output, () => 0);
  } catch (err) {
    if (err instanceof FormulaError)
      throw new FormulaError(`Malformed expression: ${err.message}`);
    throw err;
  }

  return { rpn: output, variables: [...variables] };
}

// ── Evaluation ───────────────────────────────────────────────────────────────

function applyOp(op: string, stack: number[]): void {
  if (op === "neg") {
    if (stack.length < 1) throw new FormulaError("Missing operand");
    stack.push(-stack.pop()!);
    return;
  }
  if (stack.length < 2) throw new FormulaError(`Missing operands for "${op}"`);
  const b = stack.pop()!;
  const a = stack.pop()!;
  switch (op) {
    case "+":
      stack.push(a + b);
      break;
    case "-":
      stack.push(a - b);
      break;
    case "*":
      stack.push(a * b);
      break;
    // Division by zero gives 0, not Infinity: in a game formula,
    // Infinity propagates until it draws "∞ damage" on a real screen.
    case "/":
      stack.push(b === 0 ? 0 : a / b);
      break;
    case "%":
      stack.push(b === 0 ? 0 : a % b);
      break;
    case "^":
      stack.push(Math.pow(a, b));
      break;
    case ">":
      stack.push(a > b ? 1 : 0);
      break;
    case "<":
      stack.push(a < b ? 1 : 0);
      break;
    case ">=":
      stack.push(a >= b ? 1 : 0);
      break;
    case "<=":
      stack.push(a <= b ? 1 : 0);
      break;
    case "==":
      stack.push(a === b ? 1 : 0);
      break;
    case "!=":
      stack.push(a !== b ? 1 : 0);
      break;
    default:
      throw new FormulaError(`Unknown operator "${op}"`);
  }
}

function evaluateRpn(rpn: RpnItem[], lookup: (name: string) => number): number {
  const stack: number[] = [];
  for (const item of rpn) {
    if (item.kind === "number") stack.push(item.value);
    else if (item.kind === "var") stack.push(lookup(item.name));
    else if (item.kind === "op") applyOp(item.op, stack);
    else {
      const fn = FUNCTIONS[item.name];
      const args = stack.splice(stack.length - item.arity, item.arity);
      if (args.length !== item.arity) throw new FormulaError("Missing arguments");
      stack.push(fn.apply(args));
    }
  }
  if (stack.length !== 1) throw new FormulaError("The expression does not reduce to a value");
  return stack[0];
}

/**
 * Evaluates a compiled formula.
 *
 * A missing variable is an ERROR, not a silent zero: `atk * skil_pct` with the
 * typo would always give 0, the calculator would "work" and nobody would know why
 * the damage comes out wrong. Better that it fails with the name up front.
 */
export function evaluate(formula: CompiledFormula, variables: Record<string, number>): number {
  const result = evaluateRpn(formula.rpn, (name) => {
    // `hasOwn` and not `=== undefined`: prototype inheritance would make an
    // inherited key pass as "defined".
    if (!Object.hasOwn(variables, name)) {
      throw new FormulaError(`Variable "${name}" has no value`);
    }
    const value = variables[name];
    if (!Number.isFinite(value)) {
      throw new FormulaError(`Variable "${name}" is not a finite number`);
    }
    return value;
  });
  // NaN never leaves the engine: it is turned into a named error.
  if (!Number.isFinite(result)) {
    throw new FormulaError("The formula does not produce a finite number");
  }
  return result;
}

// ── Derived stat systems ─────────────────────────────────────────────────────

export interface StatDefinition {
  /** Name of the variable it defines: `def_final`, `crit_dmg`. */
  name: string;
  formula: string;
}

export interface CompiledSystem {
  /** Resolved evaluation order. */
  order: Array<{ name: string; compiled: CompiledFormula }>;
  /** INPUT variables: those no formula defines. */
  inputs: string[];
}

/**
 * Compiles a stat system with dependencies among themselves.
 *
 * `def_final` may depend on `def_base` and `def_pct`, and `damage_taken` on
 * `def_final`: the evaluation order is resolved by topological order, not by
 * the order in which the user wrote the formulas — which is exactly what they
 * should not be required to know.
 *
 * A cycle (`a` needs `b`, `b` needs `a`) is detected HERE, at compile time,
 * with the names of the cycle in the error. At evaluation it would be a hang.
 */
export function compileSystem(stats: StatDefinition[]): CompiledSystem {
  const byName = new Map<string, CompiledFormula>();
  for (const stat of stats) {
    if (RESERVED_IDENTIFIERS.has(stat.name)) {
      throw new FormulaError(`"${stat.name}" cannot be used as a stat name`);
    }
    if (byName.has(stat.name)) {
      throw new FormulaError(`The stat "${stat.name}" is defined twice`);
    }
    byName.set(stat.name, compile(stat.formula));
  }

  const order: Array<{ name: string; compiled: CompiledFormula }> = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const inputs = new Set<string>();

  function visit(name: string, path: string[]): void {
    if (done.has(name)) return;
    if (visiting.has(name)) {
      throw new FormulaError(`Circular dependency: ${[...path, name].join(" → ")}`);
    }
    const compiled = byName.get(name);
    if (!compiled) {
      inputs.add(name); // nobody defines it: it is user input
      return;
    }
    visiting.add(name);
    for (const dep of compiled.variables) visit(dep, [...path, name]);
    visiting.delete(name);
    done.add(name);
    order.push({ name, compiled });
  }

  for (const stat of stats) visit(stat.name, []);

  return { order, inputs: [...inputs] };
}

/**
 * Evaluates the whole system: inputs → all the derived stats.
 *
 * It returns ALL the variables, inputs included: a calculator shows the entire
 * chain ("with 500 base DEF and +40%, final DEF 700, damage taken
 * 312"), not just the last number.
 */
export function evaluateSystem(
  system: CompiledSystem,
  inputs: Record<string, number>
): Record<string, number> {
  // No prototype: the accumulator is indexed with names that come from an
  // editable definition, and an object literal would bring `constructor` and company
  // inherited as standard.
  const values: Record<string, number> = Object.assign(Object.create(null), inputs);
  for (const { name, compiled } of system.order) {
    values[name] = evaluate(compiled, values);
  }
  return values;
}

/**
 * Formula engine — security, correctness and dependencies
 * ============================================================================
 *
 * The foundation of builders, calculators and simulators. Two families of tests:
 *
 *   1. **Security.** Formulas are written by CMS users. What this engine
 *      cannot evaluate it has to REJECT, not attempt.
 *   2. **Correctness.** Precedence, associativity and dependency order:
 *      a bug here shows up as "the damage is wrong" three layers up.
 */

import { describe, expect, test } from "vitest";

import {
  compile,
  compileSystem,
  evaluate,
  evaluateSystem,
  FormulaError,
} from "../../kons/kon-formulas/formula.engine";

/** Shortcut: compile and evaluate in one go. */
const calc = (src: string, vars: Record<string, number> = {}) => evaluate(compile(src), vars);

// ── Security ─────────────────────────────────────────────────────────────────

describe("security: allowlist, not sandbox", () => {
  test("there is no access to anything in the environment", () => {
    // The grammar knows neither `.` nor strings, so these are not "dangerous
    // expressions that get blocked": they are text that does not parse.
    for (const attack of [
      "process.exit(1)",
      "globalThis.foo",
      "constructor.constructor('return 1')()",
      "this.x",
      "__proto__",
      "require('fs')",
    ]) {
      expect(() => compile(attack)).toThrow();
    }
  });

  test("a function outside the allowlist is rejected AT COMPILE TIME", () => {
    // At compile time and not at evaluation: the author finds out when saving it, not
    // when a user opens the calculator.
    const err = (() => {
      try {
        compile("eval(1)");
      } catch (e) {
        return e as FormulaError;
      }
    })();
    expect(err).toBeInstanceOf(FormulaError);
    expect(err!.message).toMatch(/Unknown function/);
    // And it says which ones ARE valid: the author does not have to look up the list.
    expect(err!.message).toMatch(/min, max/);
  });

  test("a giant formula is rejected before tokenizing", () => {
    expect(() => compile("1+".repeat(2000) + "1")).toThrow(/2000 characters/);
  });

  test("characters that do not exist in the grammar are rejected", () => {
    expect(() => compile('"texto"')).toThrow(/Unexpected character/);
    expect(() => compile("a & b")).toThrow(/Unexpected character/);
  });
});

// ── Arithmetic ───────────────────────────────────────────────────────────────

describe("arithmetic and precedence", () => {
  test("respects standard precedence", () => {
    expect(calc("2 + 3 * 4")).toBe(14);
    expect(calc("(2 + 3) * 4")).toBe(20);
    expect(calc("2 + 3 > 4")).toBe(1); // comparison below addition
  });

  test("power associates to the RIGHT", () => {
    // 2^(3^2) = 512, not (2^3)^2 = 64. It is the mathematical convention and the one
    // expected by whoever writes exponential scaling.
    expect(calc("2 ^ 3 ^ 2")).toBe(512);
  });

  test("unary minus works where it should", () => {
    expect(calc("-5")).toBe(-5);
    expect(calc("3 * -2")).toBe(-6);
    expect(calc("-(2 + 3)")).toBe(-5);
    expect(calc("max(-1, -5)")).toBe(-1);
  });

  test("comparisons give 1 or 0, not booleans", () => {
    // That way they can be multiplied: `dmg * (crit > 0)` is a common pattern.
    expect(calc("5 > 3")).toBe(1);
    expect(calc("5 < 3")).toBe(0);
    expect(calc("5 == 5")).toBe(1);
    expect(calc("5 != 5")).toBe(0);
  });

  test("dividing by zero gives 0, not Infinity", () => {
    // Infinity would propagate all the way to painting "∞ damage" on a real screen.
    expect(calc("10 / 0")).toBe(0);
    expect(calc("10 % 0")).toBe(0);
  });

  test("the typical mitigation formula comes out right", () => {
    // DEF 1000 → mitigates half. It is the case that truly validates the engine.
    expect(calc("1 - def / (def + 1000)", { def: 1000 })).toBe(0.5);
  });
});

describe("allowlisted functions", () => {
  test("min, max, clamp and rounding", () => {
    expect(calc("min(3, 7)")).toBe(3);
    expect(calc("max(3, 7)")).toBe(7);
    expect(calc("clamp(15, 0, 10)")).toBe(10);
    expect(calc("clamp(-5, 0, 10)")).toBe(0);
    expect(calc("floor(3.7)")).toBe(3);
    expect(calc("ceil(3.2)")).toBe(4);
    expect(calc("round(3.5)")).toBe(4);
    expect(calc("abs(-4)")).toBe(4);
  });

  test("`if` covers the conditional without putting a ternary in the grammar", () => {
    expect(calc("if(atk > 100, 2, 1)", { atk: 150 })).toBe(2);
    expect(calc("if(atk > 100, 2, 1)", { atk: 50 })).toBe(1);
  });

  test("sqrt of a negative gives 0, not NaN", () => {
    // NaN propagates silently through the whole stat chain.
    expect(calc("sqrt(-9)")).toBe(0);
  });

  test("exp combines by multiplication what the engine only adds, and is always finite", () => {
    // Two pieces of 10 % negation give 19 %, not 20 %
    const sum = Math.log(1 - 0.1) + Math.log(1 - 0.1);
    expect(calc("100 * (1 - exp(s))", { s: sum })).toBeCloseTo(19, 10);
    expect(calc("exp(0)")).toBe(1);
    // Bounded to ±50: neither Infinity nor an exact zero
    expect(Number.isFinite(calc("exp(100000)"))).toBe(true);
    expect(calc("exp(-100000)")).toBeGreaterThan(0);
  });

  test("a wrong arity is caught at compile time", () => {
    expect(() => compile("min(1)")).toThrow(/expects 2 argument/);
    expect(() => compile("clamp(1, 2)")).toThrow(/expects 3 argument/);
  });
});

// ── Variables ────────────────────────────────────────────────────────────────

describe("variables", () => {
  test("a variable without a value is an ERROR, not a silent zero", () => {
    // `atk * skil_pct` with the typo would always give 0, the calculator
    // would "work" and nobody would know why the damage comes out wrong.
    expect(() => calc("atk * skill_pct", { atk: 100 })).toThrow(/skill_pct.*has no value/);
  });

  test("declares which variables it needs", () => {
    // It is what lets a calculator know which fields to ask the user for.
    expect(compile("atk * ratio + flat").variables.sort()).toEqual(["atk", "flat", "ratio"]);
  });

  test("the name of a function does NOT count as a variable", () => {
    expect(compile("max(atk, def)").variables.sort()).toEqual(["atk", "def"]);
  });

  test("a non-finite result becomes a named error", () => {
    expect(() => calc("a ^ b", { a: 1e300, b: 10 })).toThrow(/does not produce a finite/);
  });
});

// ── Systems ──────────────────────────────────────────────────────────────────

describe("stat systems with dependencies", () => {
  const system = [
    { name: "damage", formula: "atk_final * skill_pct / 100 * (1 - mitigation)" },
    { name: "atk_final", formula: "atk_base * (1 + atk_pct / 100)" },
    { name: "mitigation", formula: "def / (def + 1000)" },
  ];

  test("the engine resolves the order, not the user", () => {
    // `damage` was written first but depends on two that come after.
    const compiled = compileSystem(system);
    const order = compiled.order.map((o) => o.name);
    expect(order.indexOf("atk_final")).toBeLessThan(order.indexOf("damage"));
    expect(order.indexOf("mitigation")).toBeLessThan(order.indexOf("damage"));
  });

  test("distinguishes INPUTS from derived values", () => {
    // Inputs are what the interface has to ask the user for.
    expect(compileSystem(system).inputs.sort()).toEqual([
      "atk_base",
      "atk_pct",
      "def",
      "skill_pct",
    ]);
  });

  test("evaluates the whole chain and returns EVERYTHING", () => {
    // A calculator shows the chain ("final ATK 1400, mitigation 0.5"),
    // not just the last number.
    const values = evaluateSystem(compileSystem(system), {
      atk_base: 1000,
      atk_pct: 40,
      def: 1000,
      skill_pct: 200,
    });
    expect(values.atk_final).toBe(1400);
    expect(values.mitigation).toBe(0.5);
    expect(values.damage).toBe(1400);
    expect(values.atk_base).toBe(1000); // the inputs come out too
  });

  test("a cycle is detected at COMPILE time, with the path in the error", () => {
    // At evaluation it would be a hang. Here it is a message with the names.
    const err = (() => {
      try {
        compileSystem([
          { name: "a", formula: "b + 1" },
          { name: "b", formula: "a + 1" },
        ]);
      } catch (e) {
        return e as FormulaError;
      }
    })();
    expect(err!.message).toMatch(/Circular dependency/);
    expect(err!.message).toMatch(/a → b → a/);
  });

  test("a stat defined twice is rejected", () => {
    expect(() =>
      compileSystem([
        { name: "x", formula: "1" },
        { name: "x", formula: "2" },
      ])
    ).toThrow(/defined twice/);
  });

  test("a long chain resolves in the right order", () => {
    const chain = evaluateSystem(
      compileSystem([
        { name: "d", formula: "c * 2" },
        { name: "c", formula: "b + 5" },
        { name: "b", formula: "a * 3" },
      ]),
      { a: 2 }
    );
    expect(chain.d).toBe(22); // a=2 → b=6 → c=11 → d=22
  });
});

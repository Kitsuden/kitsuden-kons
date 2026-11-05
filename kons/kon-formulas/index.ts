/**
 * @kitsuden/kon-formulas
 * ============================================================================
 *
 * The FOUNDATION of the family of tools: builders, calculators and
 * simulators are, at heart, formulas over variables. This kon evaluates them
 * safely and deterministically, and the others consume it.
 *
 * It is installed only if you are going to build tools — a blog does not need it — but
 * if you build any of them, this one goes underneath.
 */

import {
  repo,
  defineKonSdk,
  defineOperation,
  operationsRouter,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import type { Hono } from "hono";
import { z } from "zod";

import { compileSystem, evaluateSystem, FormulaError } from "./formula.engine.js";
import "./formulas.policy.js";
import { formulaSystems } from "./formulas.schema.js";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

export * from "./formula.engine.js";
export * from "./formulas.schema.js";

const StatSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "the name must be a valid identifier"),
  formula: z.string().min(1).max(2000),
});

const UpsertSystem = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(120),
  stats: z.array(StatSchema).min(1).max(300),
});

/** Maximum inputs per evaluation: a system declares at most 300 stats. */
export const MAX_EVALUATION_INPUTS = 500;

/**
 * `evaluate` is PUBLIC. Before, `inputs` admitted any number of keys of
 * any length: a megabyte-sized body with a hundred thousand keys was copied twice
 * in memory per anonymous request.
 */
const EvaluateRequest = z.object({
  inputs: z
    .record(z.string().max(60), z.number().finite())
    .refine((r) => Object.keys(r).length <= MAX_EVALUATION_INPUTS, {
      message: `At most ${MAX_EVALUATION_INPUTS} inputs`,
    }),
});

// ── Outputs (OpenAPI and MCP) ────────────────────────────────────────────────

const StatOut = z.object({ name: z.string(), formula: z.string() }).passthrough();
const SystemOut = z
  .object({ id: z.string(), slug: z.string(), name: z.string(), stats: z.array(StatOut) })
  .passthrough();

const ParamSlug = z.object({ slug: z.string().describe("Formula system slug") });

/**
 * `PUT /systems` answers 201 on create and 200 on rewrite: `otherStatuses` publishes
 * it (see `PUBLISH_OUTPUT` in kon-tierlist).
 */
const SAVE_OUTPUT = {
  schema: z.object({ data: SystemOut }),
  otherStatuses: [201 as const],
  description: "Rewritten (200) or created (201)",
};

/**
 * The write routes used to ask only for a session (the `requireAuth` of
 * `/systems/*`, also for `evaluate`). An AGENT went through the host's rule
 * (`agent-as-user.ts`); SDK operations do not, so the
 * policy repeats it (`actAsUser`).
 */
const ANY_ACCOUNT = {
  policy: { resource: "formulas", action: "actAsUser" },
} as const;

export const KON_ID = "kon-formulas";

export function formulasOperations(ctx: KonContext): AnyOperation[] {
  const db = ctx.db.instance;

  // Reading is public: a calculator embedded in a page queries it
  // without a session, just as the overlay reads the Broadcast roster.
  // Everything else (also `evaluate`) requires a session: before, a
  // `requireAuth` on `/systems/*` did it for anything that was not GET; now it is the
  // `access` of each operation.
  return [
    defineOperation({
      id: "list-systems",
      method: "GET",
      route: "/systems",
      summary: "List formula systems",
      description:
        "Every formula system (a game's derived-stat formulas: how damage, defense… are computed) by name, with its stats. Public.",
      access: "public",
      output: { schema: z.object({ data: z.array(SystemOut) }) },
      handle: async (_input, { c }) => {
        const rows = await repo(formulaSystems, { db }).orderBy("name").all();
        return c.json({ data: rows });
      },
    }),

    defineOperation({
      id: "get-system",
      method: "GET",
      route: "/systems/:slug",
      summary: "Read a formula system",
      description:
        "The system plus what a calculator needs: `inputs` (the variables the user must provide) and `outputs` (the stats, in evaluation order). Public. 422 if the stored system no longer compiles.",
      access: "public",
      input: { params: ParamSlug },
      output: {
        schema: z.object({
          data: SystemOut,
          inputs: z.array(z.string()),
          outputs: z.array(z.string()),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (_input, { c }) => {
        const [row] = await repo(formulaSystems, { db })
          .filter({ slug: c.req.param("slug") })
          .all();
        if (!row) return c.json({ error: "Not found" }, 404);

        // It is returned compiled: whoever consumes the calculator needs to know which
        // INPUTS to ask the user for, and only the compiler knows that.
        // `PUT` compiles before saving, but a row touched by another route (the
        // panel, SQL) might not compile and came out as a 500: now it is a 422 with the
        // engine's message, as in `evaluate`.
        let system: ReturnType<typeof compileSystem>;
        try {
          system = compileSystem(row.stats);
        } catch (err) {
          const message = err instanceof FormulaError ? err.message : "Invalid system";
          return c.json({ error: message }, 422);
        }
        return c.json({
          data: row,
          inputs: system.inputs,
          outputs: system.order.map((o) => o.name),
        });
      },
    }),

    /**
     * Creates or updates a system. **Compiles before saving**: a system with
     * a cycle or an unknown function does not reach the table, so nobody
     * can open a broken calculator.
     */
    defineOperation({
      id: "save-system",
      method: "PUT",
      route: "/systems",
      summary: "Create or rewrite a formula system",
      description:
        "Upsert by slug: 201 when it creates the system, 200 when it rewrites it. The system is compiled before saving: a cycle, an unknown function or a malformed formula is a 422 with the engine message, and nothing is saved. Site staff (admin/editor), or an agent with formulas:create (formulas:update to rewrite one).",
      access: "session",
      permission: { policy: { resource: "formulas", action: "create", inHandler: true } },
      // Rewrites at once the formulas on which all the calculators hang.
      sensitive: true,
      input: { body: UpsertSystem },
      output: SAVE_OUTPUT,
      errors: ["KITSUDEN_E_CONFLICT"],
      handle: async ({ body: data }, { c, can }) => {
        // The policy is checked after validating the body, as before the SDK.
        if (!(await can({}))) return c.json({ error: "Forbidden" }, 403);

        try {
          compileSystem(data.stats);
        } catch (err) {
          const message = err instanceof FormulaError ? err.message : "Invalid system";
          return c.json({ error: message }, 422);
        }

        const [existing] = await repo(formulaSystems, { db }).filter({ slug: data.slug }).all();
        // Overwriting a system that already exists is EDITING it: `update` is checked.
        if (existing && !(await can(existing, "update"))) {
          return c.json({ error: "Forbidden" }, 403);
        }
        const row = existing
          ? (
              await repo(formulaSystems, { db })
                .filter({ id: existing.id })
                .update({ name: data.name, stats: data.stats, updatedAt: new Date() })
            )[0]
          : await repo(formulaSystems, { db }).create(data);

        return c.json({ data: row }, existing ? 200 : 201);
      },
    }),

    /**
     * Evaluates the system with some inputs. Public and without side effects: it is THE
     * operation of a calculator, and requiring a session to calculate would turn
     * any embedded widget into a login wall.
     */
    defineOperation({
      id: "evaluate-system",
      method: "POST",
      route: "/systems/:slug/evaluate",
      summary: "Evaluate a formula system",
      description:
        "Computes every stat of the system from `inputs` (variable → finite number, at most 500); declared inputs that are missing start at 0. Returns stat → value. Changes nothing. 422 with the engine message (the failing variable or function) if it cannot be evaluated. Any signed-in account; an agent needs user:act or a formulas scope.",
      access: "session",
      permission: ANY_ACCOUNT,
      readOnly: true,
      input: { params: ParamSlug, body: EvaluateRequest },
      output: { schema: z.object({ data: z.record(z.string(), z.number()) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ body }, { c }) => {
        const [row] = await repo(formulaSystems, { db })
          .filter({ slug: c.req.param("slug") })
          .all();
        if (!row) return c.json({ error: "Not found" }, 404);

        const { inputs } = body;

        try {
          const system = compileSystem(row.stats);
          // Inputs the system expects and that do not arrive start at 0: they are
          // variables DECLARED by the author, not typos of whoever calculates.
          const filled = { ...inputs };
          for (const input of system.inputs) if (!(input in filled)) filled[input] = 0;

          return c.json({ data: evaluateSystem(system, filled) });
        } catch (err) {
          // The engine's error carries the name of the variable or function that
          // failed: it is exactly what whoever builds the calculator needs to read.
          const message = err instanceof FormulaError ? err.message : "Could not evaluate";
          return c.json({ error: message }, 422);
        }
      },
    }),
  ];
}

export function createKonFormulas(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, formulasOperations(ctx), ctx);
}

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`formulasOperations`), with its OpenAPI, its MCP tool and its fine-grained scope.
 */
export const kon = defineKonSdk({
  id: KON_ID,
  name: "Formulas",
  version: manifest.version,
  description: "Game formula engine: safe evaluator and derived stat systems",
  icon: "Sigma",
  mountPath: "/api/formulas",
  operations: (ctx: KonContext) => formulasOperations(ctx),

  tables: konTables,

  // kon.json `admin` is the one list of admin views; the definition copies it.
  admin: {
    category: manifest.admin.category as "tools",
    views: manifest.admin.views.map((v) => ({
      id: v.id,
      type: v.type as "grid",
      title: v.title,
      table: v.table,
    })),
  },

  dependencies: { kons: [], core: ["auth"] },

  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info("Σ Formulas ready — allowlist evaluator, no eval()");
    },
  },
});

export default kon;

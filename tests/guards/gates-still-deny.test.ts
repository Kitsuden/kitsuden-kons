/**
 * Authorization gates still deny after the DSL went from Spanish to English
 * ============================================================================
 *
 * An unknown key in an operation is not an error. `{ ...base, before: [guard] }` compiles
 * after `before` became `before` (a spread escapes the excess-property check) and the engine
 * simply never reads it, so the guard stops running and nothing says so. The same goes for
 * `const MANAGE = { policy: { resource, action } }`, which only meets its type later.
 *
 * So this looks at what the engine really receives, at runtime, for every operation of every kon:
 *
 *   1. no operation carries a key the engine does not read (the silent failure itself);
 *   2. no gate was lost: each kon still declares at least the gates its Spanish source declared
 *      (`gate-inventory.json`, counted from that source before the rename);
 *   3. every gate denies: a request without credentials does not reach the handler, a logged-in
 *      account without permission does not either, and a guard in `before` that refuses stops it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { inertCtx, operationsOf, operationsRouter, type AnyOperation } from "@kitsuden/engine";
import type { KonContext, KonDefinition } from "@kitsuden/shared";
import type { MiddlewareHandler } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

const KONS = join(__dirname, "..", "..", "kons");
const INVENTORY = JSON.parse(readFileSync(join(__dirname, "gate-inventory.json"), "utf8")) as Record<
  string,
  { operations: number; before: number; permission: number; sensitive: number; cost: number }
>;

// The contract in packages/shared/src/operations.ts. A key outside these lists is one nobody reads.
const OPERATION_KEYS = new Set([
  "id", "method", "route", "summary", "description", "tags", "input", "output", "access", "permission",
  "sensitive", "readOnly", "idempotent", "errors", "mcp", "guide", "cost", "before", "handle",
]);
const PERMISSION_KEYS = new Set(["scopes", "policy", "roles", "resourceScope"]);
const POLICY_KEYS = new Set(["resource", "action", "inHandler"]);
const OUTPUT_KEYS = new Set(["status", "schema", "type", "description", "otherStatuses", "flow"]);
const INPUT_KEYS = new Set(["params", "query", "body", "format", "validatesHandler"]);
const GUIDE_KEYS = new Set(["whenToUse", "before", "examples", "traps"]);
const MCP_KEYS = new Set(["exclude", "name", "description", "whenToUse"]);
const ACCESS = new Set(["public", "optional", "session"]);

const konFolders = readdirSync(KONS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(KONS, e.name, "index.ts")))
  .map((e) => e.name);

function isDefinition(v: unknown): v is KonDefinition {
  const d = v as { operations?: unknown } | null;
  return !!d && typeof d === "object" && !!d.operations;
}

/** The kon's definition, found the way the loader does: `kon`, `default`, or any export shaped like one. */
function definitionOf(mod: Record<string, unknown>): KonDefinition | null {
  for (const v of [mod.kon, mod.default, ...Object.values(mod)]) if (isDefinition(v)) return v;
  return null;
}

const operations = new Map<string, AnyOperation[]>();
const loadFailures: string[] = [];

beforeAll(async () => {
  // One at a time: `@kitsuden/engine` is in an import cycle and concurrent imports can see it half-loaded.
  for (const kon of konFolders) {
    try {
      const def = definitionOf(await import(join(KONS, kon, "index.ts")));
      operations.set(kon, def ? operationsOf(def, inertCtx()) : []);
    } catch (err) {
      loadFailures.push(`${kon}: ${String(err)}`);
    }
  }
}, 300_000);

const unknownKeys = (o: object | undefined | null, allowed: Set<string>) =>
  o ? Object.keys(o).filter((k) => !allowed.has(k)) : [];

/** A context whose authentication is a real gate: without the test's user it answers 401. */
function gateContext(user: Record<string, unknown> | null): KonContext {
  const setUser: MiddlewareHandler = async (c, next) => {
    (c.set as (k: string, v: unknown) => void)("user", user);
    await next();
  };
  const requireAuth: MiddlewareHandler = async (c, next) => {
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    return setUser(c, next);
  };
  return Object.assign(Object.create(inertCtx() as object), {
    auth: { requireAuth, optionalAuth: setUser },
  }) as KonContext;
}

/** Sends the operation's own method and route, with no body, and says whether the handler ran. */
async function call(kon: string, op: AnyOperation, user: Record<string, unknown> | null) {
  let reached = false;
  const spy: AnyOperation = {
    ...op,
    handle: () => {
      reached = true;
      return {};
    },
  };
  const app = operationsRouter(kon, [spy], gateContext(user));
  const url = `http://test${op.route.replace(/:[A-Za-z_]+/g, "00000000-0000-4000-8000-000000000000")}`;
  const res = await app.request(new Request(url, { method: op.method }));
  return { status: res.status, reached };
}

describe("what the engine receives", () => {
  it("every kon loads and declares operations", () => {
    expect(loadFailures).toEqual([]);
    const total = [...operations.values()].reduce((n, ops) => n + ops.length, 0);
    const expected = Object.values(INVENTORY).reduce((n, c) => n + c.operations, 0);
    expect(total).toBeGreaterThanOrEqual(expected);
  });

  it("no operation carries a key nobody reads", () => {
    const bad: string[] = [];
    for (const [kon, ops] of operations) {
      for (const op of ops) {
        const where = `${kon}/${op.id}`;
        for (const k of unknownKeys(op, OPERATION_KEYS)) bad.push(`${where}: ${k}`);
        for (const k of unknownKeys(op.permission, PERMISSION_KEYS)) bad.push(`${where}: permission.${k}`);
        for (const k of unknownKeys(op.permission?.policy, POLICY_KEYS)) bad.push(`${where}: policy.${k}`);
        for (const k of unknownKeys(op.output, OUTPUT_KEYS)) bad.push(`${where}: output.${k}`);
        for (const k of unknownKeys(op.input, INPUT_KEYS)) bad.push(`${where}: input.${k}`);
        for (const k of unknownKeys(op.guide, GUIDE_KEYS)) bad.push(`${where}: guide.${k}`);
        for (const k of unknownKeys(typeof op.mcp === "object" ? op.mcp : null, MCP_KEYS)) bad.push(`${where}: mcp.${k}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every access is one of the English values, and every policy names its resource and action", () => {
    const bad: string[] = [];
    for (const [kon, ops] of operations) {
      for (const op of ops) {
        if (!ACCESS.has(op.access as string)) bad.push(`${kon}/${op.id}: access ${String(op.access)}`);
        const p = op.permission?.policy;
        if (p && (typeof p.resource !== "string" || typeof p.action !== "string")) {
          bad.push(`${kon}/${op.id}: policy ${JSON.stringify(p)}`);
        }
        if (op.permission && Object.keys(op.permission).length === 0) bad.push(`${kon}/${op.id}: empty permission`);
        for (const g of op.before ?? []) if (typeof g !== "function") bad.push(`${kon}/${op.id}: before is not a function`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("no kon lost a gate its Spanish source declared", () => {
    const lost: string[] = [];
    for (const [kon, was] of Object.entries(INVENTORY)) {
      const ops = operations.get(kon) ?? [];
      const now = {
        operations: ops.length,
        before: ops.filter((o) => (o.before?.length ?? 0) > 0).length,
        permission: ops.filter((o) => !!o.permission).length,
        sensitive: ops.filter((o) => o.sensitive !== undefined).length,
        cost: ops.filter((o) => o.cost !== undefined).length,
      };
      for (const k of Object.keys(now) as (keyof typeof now)[]) {
        if (now[k] < was[k]) lost.push(`${kon}: ${k} ${was[k]} -> ${now[k]}`);
      }
    }
    expect(lost).toEqual([]);
  });
});

describe("the gates deny", () => {
  it("without credentials, no operation behind a session reaches its handler", async () => {
    const opened: string[] = [];
    let checked = 0;
    for (const [kon, ops] of operations) {
      for (const op of ops) {
        if (op.access !== "session") continue;
        checked++;
        const { status, reached } = await call(kon, op, null);
        if (reached || status !== 401) opened.push(`${kon}/${op.id}: ${status}${reached ? " REACHED" : ""}`);
      }
    }
    expect(opened).toEqual([]);
    expect(checked).toBeGreaterThan(300);
  }, 120_000);

  it("without credentials, a permission checked before the handler does not let anyone through", async () => {
    const opened: string[] = [];
    let checked = 0;
    for (const [kon, ops] of operations) {
      for (const op of ops) {
        if (op.access === "session" || !op.permission || op.permission.policy?.inHandler) continue;
        checked++;
        const { status, reached } = await call(kon, op, null);
        if (reached) opened.push(`${kon}/${op.id}: ${status} REACHED`);
      }
    }
    expect(opened).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  }, 120_000);

  it("an agent with no scopes does not pass a permission without a policy of its own", async () => {
    // Policies are registered when a router is built, which `inertCtx` does not do; with none registered, `can`
    // says no, so only `scopes` and `roles` could open the door, and this identity has neither.
    const opened: string[] = [];
    let checked = 0;
    const agent = { id: "agent-without-scopes", role: "agent", scopes: [] };
    for (const [kon, ops] of operations) {
      for (const op of ops) {
        if (!op.permission || op.permission.policy?.inHandler) continue;
        checked++;
        const { status, reached } = await call(kon, op, agent);
        if (reached) opened.push(`${kon}/${op.id}: ${status} REACHED`);
      }
    }
    expect(opened).toEqual([]);
    expect(checked).toBeGreaterThan(200);
  }, 120_000);

  it("a guard in `before` that refuses stops the operation, in every kon that declares one", async () => {
    const opened: string[] = [];
    let checked = 0;
    const refuse: MiddlewareHandler = async (c) => c.json({ error: "Forbidden" }, 403);
    const admin = { id: "admin", role: "admin", scopes: ["admin"] };
    for (const [kon, ops] of operations) {
      for (const op of ops) {
        if (!op.before?.length) continue;
        checked++;
        const { status, reached } = await call(kon, { ...op, before: [refuse] }, admin);
        if (reached || status !== 403) opened.push(`${kon}/${op.id}: ${status}${reached ? " REACHED" : ""}`);
      }
    }
    expect(opened).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(Object.values(INVENTORY).reduce((n, c) => n + c.before, 0));
  }, 120_000);
});

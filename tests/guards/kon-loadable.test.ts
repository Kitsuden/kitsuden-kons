/**
 * Every kon must be mountable
 * ============================================================================
 *
 * The loader (`loadKons`) looks, in this order, for: `mod.kon` or `mod.default` shaped like a kon,
 * any export that is a Hono router, or an `init*` function. If it finds none of the three, it prints
 * `⚠️ <id> → no router or init found` and records it as FAILED.
 *
 * That is a warning in a startup log, not an error: `kon-ecommerce` lived like that for a
 * while —schema, service, policies, migration and manifest with three
 * tables— being really a library inside a folder that claimed to be a
 * kon. It compiled, its tests passed and it could not be installed.
 *
 * This test imports every kon for real and repeats the loader's check.
 * It does not verify that the routes work; it verifies that there IS something to mount.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const KONS = join(ROOT, "kons");

/** Folders with `kon.json`: what the loader considers an installable kon. */
function listKons(): string[] {
  return readdirSync(KONS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(KONS, e.name, "kon.json")))
    .map((e) => e.name);
}

/** A Hono router, recognized by its shape as the loader does. */
function isHonoRouter(v: unknown): boolean {
  const r = v as { fetch?: unknown; routes?: unknown; request?: unknown } | null;
  return !!r && typeof r.fetch === "function" && Array.isArray(r.routes);
}

/** Does it have the shape of a kon definition? (`createRouter` or auto-kon metadata) */
function isDefinition(v: unknown): boolean {
  const d = v as { id?: unknown; createRouter?: unknown; tables?: unknown } | null;
  return !!d && typeof d === "object" && (typeof d.createRouter === "function" || !!d.id);
}

/**
 * `definePolicy is not a function` under load: a race in the module
 * loader, not a broken kon.
 *
 * `@kitsuden/engine` is in a cycle (its index re-exports code from
 * apps/api, and that code imports `@kitsuden/engine`), and in that cycle is
 * `db`, with a top-level await. Vite's module runner, when
 * someone requests a module that is INSIDE a cycle and still being evaluated, does not
 * wait for it to finish: it returns its exports as they stand (vite
 * `ModuleRunner.cachedRequest` → `isCircularImport`). If at that moment there is
 * another import in flight —the previous kon's, whose test timed out
 * with the machine loaded but whose import continues—, the next kon receives a
 * half-built engine and its policy calls `definePolicy` while it is still
 * `undefined`.
 *
 * Fix without touching timeouts: (1) the engine is evaluated WHOLE once, before
 * any kon, so nobody can see it half-built; (2) kon imports
 * are queued: one test's does not start until the previous one finished,
 * even if that one exceeded its timeout.
 */
let row: Promise<unknown> = Promise.resolve();
function importInRow(route: string): Promise<Record<string, unknown>> {
  const turn = row.then(
    () => import(/* @vite-ignore */ route) as Promise<Record<string, unknown>>
  );
  row = turn.catch(() => undefined);
  return turn;
}

describe("kons can be mounted", () => {
  const kons = listKons();

  it("there are kons to inspect", () => {
    // Without this, a failure in discovery would leave the list empty and the
    // checks below would pass without looking at anything.
    expect(kons.length).toBeGreaterThan(20);
  });

  /**
   * Each kon is really imported, and that drags in its entire dependency
   * graph: Hono, Drizzle, zod and whatever the kon uses. Measured, a large kon
   * (`kon-academy-lms`) takes 4.8 s with the machine free and **21.2 s** with the
   * whole suite competing for CPU.
   *
   * The global ceiling is 20 s, so under load this file failed
   * intermittently — and a file that fails depending on how busy the machine is
   * is a file people learn to ignore. That is the path by which a
   * CI stops being looked at.
   *
   * It is raised HERE and not in the global configuration on purpose: the rest of the
   * suite does not import dependency graphs, and its 20 s is a useful limit
   * for catching a hung test. Raising it for everyone would hide that.
   */
  const CEILING_MS = 60_000;

  beforeAll(async () => {
    await importInRow("@kitsuden/engine");
  }, CEILING_MS);

  for (const kon of kons) {
    it(`${kon} exports something the loader recognizes`, { timeout: CEILING_MS }, async () => {
      const mod = await importInRow(join(KONS, kon, "index.ts"));

      const principal = mod.kon ?? mod.default;
      const recognized =
        isDefinition(principal) ||
        isHonoRouter(principal) ||
        Object.values(mod).some(isHonoRouter) ||
        Object.entries(mod).some(([n, v]) => n.startsWith("init") && typeof v === "function");

      expect(
        recognized,
        `${kon} exports neither a kon definition (\`export const kon = defineKon(...)\`), ` +
          `nor a Hono router, nor an \`init*\` function. The loader will mark it as ` +
          `failed at startup: "no router or init found". Exports found: ` +
          `${Object.keys(mod).slice(0, 12).join(", ")}`
      ).toBe(true);
    });
  }
});

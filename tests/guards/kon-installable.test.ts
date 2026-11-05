/**
 * Every kon can be installed ALONE (with its declared dependencies)
 * ============================================================================
 *
 * Kitsuden installs kons one at a time (`kitsuden kon add <kon>`, or the
 * KITSUDEN_KONS list of the Docker image). That requires three things of each kon:
 *
 *   1. `sdk` declared: the loader compares it with `GET /api/version` →
 *      `sdk.kons` BEFORE importing the kon.
 *   2. `mount.path` declared and EQUAL to the code's `mountPath`. A kon
 *      installed and switched off is reserved at startup so it can be activated without
 *      restarting, and the path is read from the manifest. kon-ecommerce had
 *      `/api/shop` only in the code: activated from the panel, `/api/shop/*`
 *      returned 404 until restart.
 *   3. No STATIC imports to another kon by path (`../kon-x/…`): with the
 *      other kon not installed, this one does not compile. kon-payments → kon-conta broke
 *      the first phase C image that way. What a kon needs from another goes
 *      by package name (`@kitsuden/kon-x`, declared) or is optional and
 *      loaded at runtime.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const KONS = join(__dirname, "..", "..", "kons");

function manifest(dir: string): Record<string, any> {
  const kon = join(dir, "kon.json");
  if (existsSync(kon)) return JSON.parse(readFileSync(kon, "utf8"));
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return { id: pkg.kitsuden?.id ?? pkg.name, ...pkg.kitsuden };
}

function sources(dir: string, output: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "tests"].includes(e.name)) continue;
    const route = join(dir, e.name);
    if (e.isDirectory()) sources(route, output);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) output.push(route);
  }
  return output;
}

const kons = readdirSync(KONS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => [e.name, join(KONS, e.name)] as const);

describe("kons installable one at a time", () => {
  it("there are kons to check", () => {
    expect(kons.length).toBeGreaterThan(20);
  });

  it.each(kons)("%s declares an integer sdk >= 1", (_n, dir) => {
    const sdk = manifest(dir).sdk;
    expect(Number.isInteger(sdk) && sdk >= 1, `sdk = ${JSON.stringify(sdk)}`).toBe(true);
  });

  it.each(kons)("%s declares mount.path and it matches its mountPath", (_n, dir) => {
    const declaredOne = manifest(dir).mount?.path;
    const ofTheCode = sources(dir)
      .map((f) => readFileSync(f, "utf8").match(/mountPath:\s*["']([^"']+)["']/)?.[1])
      .find(Boolean);
    expect(declaredOne, "mount.path is missing from the manifest").toBeTruthy();
    if (ofTheCode) expect(declaredOne).toBe(ofTheCode);
  });

  it.each(kons)("%s does not import another kon by relative path", (_n, dir) => {
    const badOnes: string[] = [];
    for (const f of sources(dir)) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.\.\/)+kon-[^"']+["']/g)) {
        badOnes.push(`${f.slice(KONS.length + 1)}: ${m[0]}`);
      }
    }
    expect(badOnes).toEqual([]);
  });
});

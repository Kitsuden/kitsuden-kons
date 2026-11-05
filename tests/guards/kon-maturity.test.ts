/**
 * Every kon declares its maturity
 * ============================================================================
 *
 * `maturity` says how much real use a kon has: "estable" (in production
 * end to end), "beta" (works and has tests, with gaps or little real use)
 * or "experimental" (nobody has used it end to end). This repo's README and
 * the badge in the Kitsuden panel (Kons view) come from this field,
 * so a kon without it would be advertised as if it were as reliable as the blog.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const LEVELS = ["stable", "beta", "experimental"];
/** In the (English) README, maturity is written like this. */
const IN_ENGLISH: Record<string, string> = {
  stable: "stable",
  beta: "beta",
  experimental: "experimental",
};

/** kon.json or, if there is none, the `kitsuden` field of package.json. */
function manifests(): Array<[string, Record<string, unknown>]> {
  const dir = join(ROOT, "kons");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e): [string, Record<string, unknown>] => {
      const kon = join(dir, e.name, "kon.json");
      if (existsSync(kon)) return [`kons/${e.name}`, JSON.parse(readFileSync(kon, "utf8"))];
      const pkg = JSON.parse(readFileSync(join(dir, e.name, "package.json"), "utf8"));
      return [`kons/${e.name}`, { id: pkg.kitsuden?.id ?? pkg.name, ...pkg.kitsuden }];
    });
}

const all = manifests();

describe("kon maturity", () => {
  it("there are manifests to check", () => {
    expect(all.length).toBeGreaterThan(20);
  });

  it.each(all)("%s declares a valid maturity", (_route, manifest) => {
    expect(LEVELS).toContain(manifest.maturity);
  });

  it("the schema requires it and only allows the three levels", () => {
    const schema = JSON.parse(readFileSync(join(ROOT, "schemas", "kon-schema.json"), "utf8"));
    expect(schema.required).toContain("maturity");
    expect(schema.properties.maturity.enum).toEqual(LEVELS);
  });

  it.each(all)("%s: stable only for the core kons (tier essential)", (_route, manifest) => {
    // Stable is a promise to whoever installs the kon. It is kept for the kons most sites need,
    // which are also the ones running in production end to end; everything else is beta or
    // experimental until it earns more.
    if (manifest.maturity === "stable") expect(manifest.tier).toBe("essential");
  });

  it.each(all)("%s declares one of the repo's categories", (_route, manifest) => {
    // The README groups the kons by category (scripts/maturity.mjs) and the schema lists them.
    const schema = JSON.parse(readFileSync(join(ROOT, "schemas", "kon-schema.json"), "utf8"));
    expect(schema.properties.category.enum).toContain(manifest.category);
  });

  it("the README lists each kon with the same maturity as its manifest", () => {
    // The table is written by `pnpm maturity` (scripts/maturity.mjs).
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    for (const [, m] of all) {
      const level = IN_ENGLISH[m.maturity as string];
      const row = new RegExp(`\\|\\s*\`${m.id}\`\\s*\\|\\s*${level}\\s*\\|`);
      expect(readme, `${m.id} (${level}) en README.md`).toMatch(row);
    }
  });
});

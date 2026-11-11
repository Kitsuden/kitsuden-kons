/**
 * Every kon is checked
 * ============================================================================
 *
 * `pnpm typecheck` is `pnpm -r --no-bail typecheck`: it walks the packages and
 * runs THAT script. A package that does not declare it does not fail — it is simply
 * not looked at. For a while 13 of the 29 kons were like that, and the result was
 * the worst possible: `pnpm typecheck` said "0 errors" while two files of
 * `kon-blog` and `kon-dms` did not even parse (an import had ended up inside
 * another import). A green that lies is worse than a red.
 *
 * This test requires every publishable kon to declare `typecheck` and have the
 * `tsconfig.json` it needs to run it. It does not check the types —`tsc`
 * already does that—, it checks that SOMEONE checks them.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const KONS = join(ROOT, "kons");

/** Real kons: folder with package.json. */
function listKons(): string[] {
  return readdirSync(KONS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(KONS, e.name, "package.json")))
    .map((e) => e.name);
}

describe("typecheck coverage in the kons", () => {
  it("there are kons to inspect", () => {
    // If discovery breaks, the two tests below would pass with an
    // empty list and this file would silently stop protecting anything.
    expect(listKons().length).toBeGreaterThan(20);
  });

  it("all declare the typecheck script", () => {
    const withoutScript = listKons().filter((kon) => {
      const pkg = JSON.parse(readFileSync(join(KONS, kon, "package.json"), "utf8"));
      return !pkg.scripts?.typecheck;
    });

    expect(
      withoutScript,
      `These kons do not declare "typecheck", so \`pnpm -r typecheck\` ` +
        `SKIPS them and its green means nothing. Add ` +
        `"typecheck": "tsc --noEmit" to its package.json. Kons: ${withoutScript.join(", ")}`
    ).toEqual([]);
  });

  /**
   * In THIS repository the command people and CI run is `pnpm build`
   * (`pnpm --filter "./kons/*" build`), and it has the same hole: a kon without a `build` script
   * is skipped in silence. kon-ingest declared `typecheck` only, so "type-checks every kon"
   * meant 29 of 30.
   */
  it("all declare a build script that type-checks, which is what `pnpm build` runs", () => {
    const withoutBuild = listKons().filter((kon) => {
      const pkg = JSON.parse(readFileSync(join(KONS, kon, "package.json"), "utf8"));
      return !/\btsc\b/.test(pkg.scripts?.build ?? "");
    });

    expect(
      withoutBuild,
      `These kons have no "build" script that runs tsc, so \`pnpm build\` (and the CI step ` +
        `"Type-check every kon") skips them. Add "build": "pnpm exec tsc" to its ` +
        `package.json. Kons: ${withoutBuild.join(", ")}`
    ).toEqual([]);
  });

  it("all have the tsconfig that script needs", () => {
    const withoutConfig = listKons().filter((kon) => !existsSync(join(KONS, kon, "tsconfig.json")));

    expect(
      withoutConfig,
      `Without its own tsconfig.json, \`tsc --noEmit\` in the kon inherits whatever ` +
        `it finds upwards and checks a set of files that is not ` +
        `its own. Kons: ${withoutConfig.join(", ")}`
    ).toEqual([]);
  });
});

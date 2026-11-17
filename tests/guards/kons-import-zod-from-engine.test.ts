/**
 * Kons import Zod from the engine
 * ============================================================================
 *
 * Kitsuden's ESLint config has a "firewall between kons": a file under
 * `packages/kons/**` may not import `zod` or `zod/*`. It imports
 * `import { z } from "@kitsuden/engine/zod"`. So there is ONE Zod for the whole
 * installation, and upgrading it is a change in one file of the core.
 *
 * This repository never ran that rule, because its kons live in `kons/`, not in
 * `packages/kons/`. The first time someone installed them into a Kitsuden
 * checkout and ran `pnpm lint`, it reported 35 errors, in 73 files across
 * 29 kons. This guard runs the same rule here, where the kons are written.
 *
 * `zod` stays a peer dependency in each kon's package.json: the host provides it,
 * and `@kitsuden/engine/zod` re-exports that same copy.
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { listFiles } from "../../.kitsuden/tests/unit/helpers/files";

const ROOT = join(__dirname, "..", "..");
const KONS = join(ROOT, "kons");

/** `from "zod"`, `from 'zod/v4'`, `import("zod")`, `require("zod")`. */
const DIRECT_ZOD = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']zod(?:\/[^"']*)?["']/;

function sources(): string[] {
  return listFiles(KONS, ".ts", ".tsx", ".mts", ".js", ".mjs", ".svelte").filter((file) => {
    const parts = relative(KONS, file).split(sep);
    // Built output and installed dependencies are not written by hand.
    return !parts.includes("node_modules") && !parts.includes("dist") && parts[1] !== "admin";
  });
}

describe("kons import Zod from @kitsuden/engine/zod", () => {
  it("finds kon sources to check", () => {
    expect(sources().length).toBeGreaterThan(100);
  });

  it("no kon source imports zod directly", () => {
    const offenders = sources()
      .map((file) => {
        const lines = readFileSync(file, "utf-8").split("\n");
        const index = lines.findIndex((line) => DIRECT_ZOD.test(line));
        return index === -1 ? null : `${relative(ROOT, file)}:${index + 1}`;
      })
      .filter((x): x is string => x !== null);

    expect(
      offenders,
      'import { z } from "@kitsuden/engine/zod" instead: one Zod for the whole installation'
    ).toEqual([]);
  });
});

/**
 * What a kon PUBLISHES includes everything its `index.ts` imports
 * ============================================================================
 *
 * ── THE FAILURE THIS CHASES ────────────────────────────────────────────────
 *
 * `files[]` in `package.json` decides what goes into the npm tarball. Nothing checks it
 * against the code: it is written by hand the day the kon is created and
 * stays still while the kon grows.
 *
 * The result is a package that installs an `index.ts` that imports files
 * that were not shipped. And it does not fail here: it fails on the machine of whoever
 * installs it, with a `Cannot find module`, after publishing.
 *
 * Measured when this was written: `kon-broadcast` published its seven flat
 * files and left out `broadcast.sections.ts` and the `live/` and
 * `classifications/` subsystems entirely — 16 files, half the kon. `kon-cardsim` and
 * the character builder left out their `.dataset.ts`, added later.
 *
 * All three share the shape: the file arrived AFTER the list.
 *
 * ── WHY THE TRANSITIVE CLOSURE AND NOT JUST THE IMPORTS OF `index.ts` ──────
 *
 * Because `index.ts` imported `live/routes.ts` through another file, not
 * directly. Looking at a single level said 10 were missing; following the chain
 * it was 16.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, posix } from "node:path";

import { describe, expect, it } from "vitest";

const KONS = join(__dirname, "..", "..", "kons");

/** Every local file reachable from `index.ts`, following the imports. */
function reachableFromIndex(dir: string): string[] {
  const seen = new Set<string>();
  const queue = ["index.ts"];

  while (queue.length > 0) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    const route = join(dir, f);
    if (!existsSync(route)) continue;
    seen.add(f);

    const source = readFileSync(route, "utf-8");
    const refs = [
      ...source.matchAll(/from "(\.[^"]+)"/g),
      ...source.matchAll(/import "(\.[^"]+)"/g),
    ].map((m) => m[1]);

    for (const ref of refs) {
      // Code is written with `.js` (ESM) and on disk it is `.ts`.
      const base = normalize(join(dirname(f), ref.replace(/\.js$/, ".ts")))
        .split("\\")
        .join("/");
      const options = base.endsWith(".ts") ? [base] : [`${base}.ts`, `${base}/index.ts`];
      const foundItem = options.find((o) => existsSync(join(dir, o)));
      if (foundItem) queue.push(foundItem);
    }
  }
  return [...seen].sort();
}

/** `files[]` accepts an exact file or a folder that contains it. */
function coversIt(patterns: string[], file: string): boolean {
  return patterns.some(
    (p) => p === file || file.startsWith(`${posix.normalize(p).replace(/\/$/, "")}/`)
  );
}

const kons = readdirSync(KONS).filter(
  (d) => d.startsWith("kon-") && existsSync(join(KONS, d, "package.json"))
);

describe("each kon's tarball carries what its index.ts imports", () => {
  it("there are kons to check", () => {
    expect(kons.length).toBeGreaterThan(20);
  });

  for (const kon of kons) {
    const dir = join(KONS, kon);

    it(`${kon}`, () => {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));

      // Without `files[]`, npm publishes the whole directory. That is not this failure.
      if (!Array.isArray(pkg.files)) return;
      if (!existsSync(join(dir, "index.ts"))) return;

      const areMissing = reachableFromIndex(dir).filter((f) => !coversIt(pkg.files, f));

      expect(
        areMissing,
        `\`${kon}\` would publish an index.ts that imports ${areMissing.length} fichero(s) ` +
          `that are not in the tarball:\n  ${areMissing.join("\n  ")}\n` +
          `Add them to \`files[]\` (the folder name is enough for a whole subsystem).`
      ).toEqual([]);
    });
  }
});

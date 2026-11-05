/**
 * What a kon says twice must say the same thing
 * ============================================================================
 *
 * A kon's version and tables live in `kon.json`. Three other places repeat them, for tools that
 * read different files, and they used to drift unnoticed:
 *
 *   · package.json `version` and `files` — npm and `kitsuden kon add` read them. Three kons had a
 *     manifest at one version and a package at another, and three never shipped their migrations.
 *     `pnpm kon:sync` writes both from the folder; this runs its check.
 *   · `version` and `tables` in the definition exported by index.ts — the API reads them. New kons
 *     read them from kon.json (`import manifest from "./kon.json" with { type: "json" }`); older
 *     ones still write them out, and must agree with the manifest.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const KONS = join(ROOT, "kons");

const kons = readdirSync(KONS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(KONS, e.name, "kon.json")) && existsSync(join(KONS, e.name, "index.ts")))
  .map((e) => e.name);

describe("kon single source", () => {
  it("package.json files and versions are in step with each kon (pnpm kon:sync)", () => {
    let output = "";
    try {
      output = execFileSync(process.execPath, [join(ROOT, "scripts", "kon-sync.mjs"), "--check"], {
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(`${err.stderr ?? ""}${err.stdout ?? ""}`);
    }
    expect(output).toMatch(/in step/);
  });

  it.each(kons)("%s: index.ts says the same version and tables as kon.json", async (kon) => {
    const manifest = JSON.parse(readFileSync(join(KONS, kon, "kon.json"), "utf8"));
    const mod = (await import(join(KONS, kon, "index.ts"))) as Record<string, unknown>;
    const def = [mod.kon, mod.default, ...Object.values(mod)].find(
      (v) => !!v && typeof v === "object" && "id" in (v as object) && ("operations" in (v as object) || "createRouter" in (v as object))
    ) as { version?: string; tables?: string[] } | undefined;
    if (!def) return; // a library-only module; kon-loadable reports it
    if (def.version !== undefined) expect(def.version).toBe(manifest.version);
    if (def.tables !== undefined) {
      const declared = (manifest.tables ?? []).map((t: string | { name: string }) =>
        typeof t === "string" ? t : t.name
      );
      expect([...def.tables].sort()).toEqual([...declared].sort());
    }
  }, 120_000);
});

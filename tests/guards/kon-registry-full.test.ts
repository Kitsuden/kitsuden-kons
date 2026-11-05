/**
 * The registry knows every kon
 * ============================================================================
 *
 * KON_REGISTRY classified 13 of the repository's 33 kons. The other 24
 * started up the same —the loader scans the disk, not this table— but came out of
 * startup with no category, no `tables` and no `dependsOn`.
 *
 * The failure was not visible: there was no gap or warning, those kons
 * simply were not in the modules panel or in the dependency
 * graph. That is why a test is needed and filling in the list
 * once is not enough: kon number 34 would hit it again.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { KON_REGISTRY, KON_KEYS } from "../../.kitsuden/apps/api/src/services/module-registry";

const ROOT = join(__dirname, "..", "..");
const KONS = join(ROOT, "kons");

function konsOnDisk(): string[] {
  return readdirSync(KONS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(KONS, e.name, "kon.json")))
    .map((e) => e.name);
}

describe("KON_REGISTRY", () => {
  it("classifies every kon on disk", () => {
    const registeredValues = new Set(KON_KEYS);
    const absent = konsOnDisk().filter((kon) => !registeredValues.has(kon));

    expect(
      absent,
      `These kons exist in packages/kons/ but the registry does not know them, so ` +
        `they load without metadata and do not appear in the panel: ${absent.join(", ")}`
    ).toEqual([]);
  });

  it("does not repeat keys", () => {
    // The curated list and the derived one are concatenated: a key in both
    // would duplicate the record in the panel.
    const views = new Set<string>();
    const repeatedItems = KON_KEYS.filter((k) => (views.has(k) ? true : (views.add(k), false)));

    expect(repeatedItems).toEqual([]);
  });

  it("every entry carries the fields the panel consumes", () => {
    const incomplete = KON_REGISTRY.filter(
      (k) =>
        !k.key ||
        !k.name ||
        !k.category ||
        !Array.isArray(k.tables) ||
        !Array.isArray(k.dependsOn) ||
        !Array.isArray(k.referencedBy)
    ).map((k) => k.key);

    expect(incomplete).toEqual([]);
  });

  it("derived tables are names, not records", () => {
    // `tables` in kon.json accepts strings or `{name, label, ...}`. If the record
    // slips in unflattened, the panel tries `SELECT COUNT(*) FROM [object Object]`.
    const malformed = KON_REGISTRY.filter((k) =>
      k.tables.some((t) => typeof t !== "string" || t.length === 0)
    ).map((k) => k.key);

    expect(malformed).toEqual([]);
  });

  it("declared dependencies point to kons that exist", () => {
    const known = new Set([...KON_KEYS, ...konsOnDisk()]);
    const broken: string[] = [];

    for (const kon of KON_REGISTRY) {
      for (const dep of kon.dependsOn) {
        // kon-media / kon-datasets / kon-blocks live in packages/core.
        if (
          !known.has(dep) &&
          !existsSync(join(ROOT, ".kitsuden", "packages", "core", dep.replace(/^kon-/, "")))
        ) {
          broken.push(`${kon.key} → ${dep}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  it("hand curation takes precedence over what is derived", () => {
    // kon-crm is curated: it carries `referencedBy`, which cannot be deduced from the
    // manifest. If the derived data overwrote it, the graph would be lost.
    const crm = KON_REGISTRY.find((k) => k.key === "kon-crm");

    expect(crm).toBeDefined();
    expect(crm!.category).toBe("optional");
    expect(crm!.color).toBe("#E91E63");
  });

  it("fills the gaps of a curated record from the manifest", () => {
    // kon-crm was curated with `tables: []` because its 6 tables lived in
    // `database.tables`, the field nobody reads. The curated record keeps
    // its own (color, category) and takes from the manifest what it lacked.
    const crm = KON_REGISTRY.find((k) => k.key === "kon-crm")!;
    const manifest = JSON.parse(readFileSync(join(KONS, "kon-crm", "kon.json"), "utf8"));

    expect(crm.tables.length).toBeGreaterThan(0);
    expect(crm.tables).toEqual(
      manifest.tables.map((t: unknown) => (typeof t === "string" ? t : (t as any).name))
    );
  });

  it("an uncurated kon enters with what its manifest declares", () => {
    const wiki = KON_REGISTRY.find((k) => k.key === "kon-wiki");
    const manifest = JSON.parse(readFileSync(join(KONS, "kon-wiki", "kon.json"), "utf8"));

    expect(wiki).toBeDefined();
    expect(wiki!.name).toBe(manifest.name);
    expect(wiki!.icon).toBe(manifest.icon);
  });
});

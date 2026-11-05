/**
 * VekStudio kon contract
 * ============================================================================
 *
 * kon-vekstudio had no tests. It is almost all a passthrough to the vekocr
 * gateway, so what can be pinned down without a network is its LOADING CONTRACT — which
 * happens to be exactly what the loader needs and what breaks silently:
 *
 * `loadKons` imports the index, looks for `mod.kon || mod.default` and checks that
 * it has `createRouter`. If it does not, the kon does not mount; and the failure shows up
 * as one console line during a startup of thirty-three kons.
 *
 * The other point is the mount path: the manifest says /api/ocr and the code
 * says /api/ocr, and the code rules. Their ceasing to match breaks nothing today,
 * but turns kon.json into false documentation.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { kon } from "../../kons/kon-vekstudio";

const ROOT = join(__dirname, "..", "..");
const DIR = join(ROOT, "kons", "kon-vekstudio");
const manifest = JSON.parse(readFileSync(join(DIR, "kon.json"), "utf8"));

describe("the kon can be loaded", () => {
  it("exports a definition with id and name", () => {
    expect(kon.id).toBe("kon-vekstudio");
    expect(kon.name).toBeTruthy();
  });

  it("has createRouter, which is what the loader requires", () => {
    // Without this, isKonDefinition() gives false and the kon skips the modern branch.
    expect(typeof kon.createRouter).toBe("function");
  });

  it("declares where it mounts", () => {
    expect(kon.mountPath).toBe("/api/ocr");
  });
});

describe("the manifest does not lie about the code", () => {
  it("the kon.json path is the same as the code's", () => {
    expect(manifest.mount?.path).toBe(kon.mountPath);
  });

  it("the id matches in both places and with the folder", () => {
    // Resolution goes by the JSON id, not by the directory.
    expect(manifest.id).toBe(kon.id);
    expect(manifest.id).toBe("kon-vekstudio");
  });

  it("the declared tables match", () => {
    const ofManifest = (manifest.tables ?? []).map((t: unknown) =>
      typeof t === "string" ? t : (t as { name: string }).name
    );

    expect(ofManifest).toEqual(kon.tables);
  });
});

describe("the admin view points to something that exists", () => {
  it("every grid-type view names a declared table", () => {
    const tables = new Set(kon.tables ?? []);
    const orphans = (kon.admin?.views ?? [])
      .filter((v: any) => v.type === "grid")
      .filter((v: any) => !tables.has(v.table))
      .map((v: any) => `${v.id} → ${v.table}`);

    expect(orphans).toEqual([]);
  });
});

describe("migrations accompany the schema", () => {
  it("there is SQL for the table the kon says it needs", () => {
    // The onStartup hook warns if `ocr_documents` does not exist. That warning is of
    // little use if the kon does not ship what it takes to create it.
    expect(kon.tables).toContain("ocr_documents");
    expect(existsSync(join(DIR, "migrations"))).toBe(true);
  });
});

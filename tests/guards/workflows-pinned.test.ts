/**
 * The workflows stay locked down
 * ============================================================================
 *
 * Third-party actions run with the repository's token: each is pinned by commit
 * (Dependabot moves them), every workflow is read-only by default, and the security
 * scanners stay blocking.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const DIR = join(ROOT, ".github", "workflows");
const read = (file: string) => readFileSync(join(DIR, file), "utf8").replace(/\r\n/g, "\n");
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

describe("workflows", () => {
  it.each(files)("%s pins every action by commit and is read-only by default", (file) => {
    const text = read(file);
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]!);
    expect(uses.filter((u) => !u.startsWith("./") && !/@[0-9a-f]{40}$/.test(u))).toEqual([]);
    expect(text).toMatch(/^permissions:\n\s+contents: read$/m);
  });

  it("the security scanners and CodeQL run on every push and pull request, and block", () => {
    const text = read("security.yml");
    expect(text).toMatch(/pull_request:/);
    expect(text).toContain("scripts/security/scan.mjs --root=.");
    expect(text).toContain("security-extended");
    expect(text).not.toMatch(/^ {4}continue-on-error/m);
  });
});

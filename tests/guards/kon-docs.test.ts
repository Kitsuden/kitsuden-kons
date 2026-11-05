/**
 * Every kon documents itself, and the docs match the code
 * ============================================================================
 *
 * Each kon folder is published as it is, so it carries two documents:
 *
 *   · README.md — for a person deciding to install and use the kon;
 *   · AGENTS.md — for AI agents: coding agents changing the kon, and agents calling it.
 *
 * This checks what can be checked mechanically: both exist with their sections, the README states
 * the version, maturity and mount path of kon.json, it lists every route the kon serves and no
 * route the kon does not serve (both against `authorization-matrix.kons.json`, the classification
 * of every kon route), and neither document is in Spanish.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const KONS = join(ROOT, "kons");

const kons = readdirSync(KONS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(KONS, e.name, "kon.json")))
  .map((e) => e.name);

const README_SECTIONS = [
  "Install",
  "HTTP API",
  "Who can do what",
  "Configuration",
  "Agents and MCP",
  "Tests",
  "License",
];
const AGENTS_SECTIONS = [
  "What it is",
  "Calling it",
  "Map of the code",
  "Rules that must hold",
  "Changing it",
  "Tests",
];

/** Words that only appear in Spanish prose (not identifiers that happen to be Spanish). */
const SPANISH = /\b(para|los|las|que|con|una|del|está|también|cuando|puede|según|sólo|ningún)\b/i;

type Manifest = { id: string; version: string; maturity: string; mount?: { path?: string } };

const matrix = Object.keys(
  JSON.parse(readFileSync(join(ROOT, "authorization-matrix.kons.json"), "utf8")) as Record<
    string,
    string
  >
).filter((r) => !r.startsWith("ALL "));

const mounts = kons
  .map((k) => {
    const m = JSON.parse(readFileSync(join(KONS, k, "kon.json"), "utf8")) as Manifest;
    return { kon: k, path: m.mount?.path ?? "" };
  })
  .filter((m) => m.path);

/** The kon whose mount path is the longest prefix of the route (on a segment boundary). */
function ownerOf(route: string): string | undefined {
  const path = route.slice(route.indexOf(" ") + 1);
  return mounts
    .filter((m) => path === m.path || path.startsWith(`${m.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]?.kon;
}

/** `GET /api/x/:id` and `GET /api/x/:slug` are the same route. */
const normalize = (route: string) => route.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":p");

/** `METHOD /api/...` written in the document (inside backticks or a table cell). */
function routesIn(doc: string): string[] {
  const found = new Set<string>();
  for (const m of doc.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+`?(\/api\/[^\s`|)]+)/g)) {
    found.add(`${m[1]} ${m[2].replace(/[.,;]+$/, "").replace(/\?.*$/, "")}`);
  }
  return [...found];
}

const known = new Set(matrix.map(normalize));

describe("kon docs", () => {
  it("there are kons to check", () => {
    expect(kons.length).toBeGreaterThan(20);
  });

  for (const kon of kons) {
    describe(kon, () => {
      const dir = join(KONS, kon);
      const manifest = JSON.parse(readFileSync(join(dir, "kon.json"), "utf8")) as Manifest;
      const readme = existsSync(join(dir, "README.md"))
        ? readFileSync(join(dir, "README.md"), "utf8")
        : "";
      const agents = existsSync(join(dir, "AGENTS.md"))
        ? readFileSync(join(dir, "AGENTS.md"), "utf8")
        : "";
      const headings = (doc: string) =>
        [...doc.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1].trim());

      it("has README.md and AGENTS.md", () => {
        expect(readme, `${kon}/README.md`).not.toBe("");
        expect(agents, `${kon}/AGENTS.md`).not.toBe("");
      });

      it("README has its sections and states what kon.json says", () => {
        expect(readme.split("\n")[0]).toContain(kon);
        const h = headings(readme);
        for (const s of README_SECTIONS) expect(h, `${kon}/README.md: ## ${s}`).toContain(s);
        expect(readme).toContain(manifest.version);
        expect(readme).toContain(manifest.maturity);
        if (manifest.mount?.path) expect(readme).toContain(manifest.mount.path);
        expect(readme).toMatch(/\]\(\.?\/?AGENTS\.md\)/);
      });

      it("AGENTS.md has its sections", () => {
        expect(agents.split("\n")[0]).toContain(kon);
        const h = headings(agents);
        for (const s of AGENTS_SECTIONS) expect(h, `${kon}/AGENTS.md: ## ${s}`).toContain(s);
      });

      it("README lists every route the kon serves", () => {
        const written = new Set(routesIn(readme).map(normalize));
        const missing = matrix
          .filter((r) => ownerOf(r) === kon)
          .filter((r) => !written.has(normalize(r)));
        expect(missing, `${kon}/README.md does not list`).toEqual([]);
      });

      it("the docs mention no route the kon does not serve", () => {
        const invented = [...routesIn(readme), ...routesIn(agents)].filter(
          (r) => !known.has(normalize(r))
        );
        expect(invented, `${kon}: routes not in authorization-matrix.kons.json`).toEqual([]);
      });

      it("the docs are in English", () => {
        for (const [name, doc] of [
          ["README.md", readme],
          ["AGENTS.md", agents],
        ] as const) {
          // Code spans and fences may quote persisted Spanish names; prose may not.
          const prose = doc.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
          const lines = prose.split("\n").filter((l) => SPANISH.test(l));
          expect(lines, `${kon}/${name}`).toEqual([]);
        }
      });
    });
  }
});

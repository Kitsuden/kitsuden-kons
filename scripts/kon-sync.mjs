#!/usr/bin/env node
/**
 * Keeps what a kon repeats in step, so nobody maintains it by hand
 * ============================================================================
 *
 *   node scripts/kon-sync.mjs [kon-id ...]   write (default: every kon)
 *   node scripts/kon-sync.mjs --check        exit 1 if anything is out of step (CI, guards)
 *
 * Two things a kon has to say twice, because two tools read different files:
 *
 *   · package.json `files` — what `kitsuden kon add` and a registry publish copy. It is every
 *     top-level entry of the kon's folder except what is never shipped: node_modules, dist,
 *     tests, coverage, admin-src (the sources of the built `admin/`), tsconfig files, test
 *     files, compiled leftovers and dotfiles. A new file next to index.ts is shipped without
 *     anyone remembering to list it.
 *   · kon.json `version` — npm needs it in package.json, the API reads the manifest. package.json
 *     is the one you edit; this copies it.
 *
 * index.ts does not repeat them: a kon reads version and tables from kon.json
 * (`import manifest from "./kon.json" with { type: "json" }`).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const konsDir = join(root, "kons");
const check = process.argv.includes("--check");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const NEVER = new Set([
  "node_modules",
  "dist",
  "tests",
  "test",
  "coverage",
  "admin-src",
  "package.json",
  "pnpm-lock.yaml",
]);

/** Is this top-level entry of a kon folder something that is never published? */
function never(name) {
  return (
    NEVER.has(name) ||
    name.startsWith(".") ||
    /^tsconfig(\..+)?\.json$/.test(name) ||
    /\.test\.[cm]?[jt]sx?$/.test(name) ||
    /\.(tsbuildinfo|js\.map|d\.ts\.map)$/.test(name)
  );
}

function shippedEntries(dir) {
  return readdirSync(dir)
    .filter((name) => {
      if (never(name)) return false;
      // Declarations compiled next to a source (`foo.d.ts` beside `foo.ts`) are build output.
      if (name.endsWith(".d.ts") && existsSync(join(dir, name.replace(/\.d\.ts$/, ".ts")))) return false;
      // Compiled `.js` next to its `.ts` source likewise.
      if (name.endsWith(".js") && existsSync(join(dir, name.replace(/\.js$/, ".ts")))) return false;
      // An empty folder ships nothing.
      const p = join(dir, name);
      return !statSync(p).isDirectory() || readdirSync(p).length > 0;
    })
    .sort();
}

/** Writes JSON keeping 2-space indentation and the file's own line ending. */
function writeJson(path, raw, value) {
  let out = `${JSON.stringify(value, null, 2)}\n`;
  if (raw.includes("\r\n")) out = out.replace(/\n/g, "\r\n");
  if (out !== raw) writeFileSync(path, out);
}

const problems = [];
const kons = readdirSync(konsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(konsDir, e.name, "package.json")))
  .map((e) => e.name)
  .filter((k) => only.length === 0 || only.includes(k));

for (const kon of kons) {
  const dir = join(konsDir, kon);
  const pkgPath = join(dir, "package.json");
  const pkgRaw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(pkgRaw);

  const files = shippedEntries(dir);
  const sameFiles = JSON.stringify(pkg.files ?? []) === JSON.stringify(files);
  if (!sameFiles) {
    if (check) {
      const missing = files.filter((f) => !(pkg.files ?? []).includes(f));
      const extra = (pkg.files ?? []).filter((f) => !files.includes(f));
      problems.push(
        `${kon}: package.json files is out of step` +
          (missing.length ? ` (missing: ${missing.join(", ")})` : "") +
          (extra.length ? ` (not in the folder or never shipped: ${extra.join(", ")})` : "")
      );
    } else {
      pkg.files = files;
      writeJson(pkgPath, pkgRaw, pkg);
    }
  }

  const konPath = join(dir, "kon.json");
  if (existsSync(konPath)) {
    const konRaw = readFileSync(konPath, "utf8");
    const manifest = JSON.parse(konRaw);
    if (manifest.version !== pkg.version) {
      if (check) problems.push(`${kon}: kon.json version ${manifest.version} ≠ package.json ${pkg.version}`);
      else {
        manifest.version = pkg.version;
        writeJson(konPath, konRaw, manifest);
      }
    }
  }
}

if (check) {
  if (problems.length > 0) {
    console.error(`${problems.join("\n")}\n\nRun \`pnpm kon:sync\` to fix it.`);
    process.exit(1);
  }
  console.log(`kon:sync — ${kons.length} kons in step.`);
} else {
  console.log(`kon:sync — ${kons.length} kons written.`);
}

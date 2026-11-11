#!/usr/bin/env node
/**
 * Links the Kitsuden checkout this repo builds and tests against.
 *
 *   KITSUDEN_DIR=../kitsuden node scripts/link-core.mjs     (default: ../kitsuden)
 *   node scripts/link-core.mjs --check                      validate the current link, change nothing
 *
 * Without `--check` this POINTS the link at KITSUDEN_DIR (or ../kitsuden), replacing a link that
 * points elsewhere. To only verify the checkout `.kitsuden` already points at (a release check,
 * an agent that must not move it), use `--check`: it never creates, removes or re-points it.
 *
 * Kons are NOT standalone packages: they run inside a Kitsuden API and import
 * `@kitsuden/shared` and `@kitsuden/engine`, and they must share ONE copy of
 * `hono`, `drizzle-orm` and `zod` with it (an `AppError` from a second copy of
 * the engine fails `instanceof` and turns a 404 into a 500; a second drizzle
 * has its own entity classes). So this repo does not install its own copy of
 * those: the root package.json points them at `./.kitsuden`, a link to a
 * Kitsuden checkout that already ran `pnpm install` and built `@kitsuden/shared`.
 *
 * The link has a fixed name so that the lockfile and `tsconfig.kons.json` are
 * the same on every machine; only its target changes (KITSUDEN_DIR).
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const link = join(root, ".kitsuden");
const check = process.argv.includes("--check");
// `--check` looks at what is linked NOW, whatever KITSUDEN_DIR says.
const target = check ? link : resolve(root, process.env.KITSUDEN_DIR || "../kitsuden");

function fail(message) {
  console.error(`link-core: ${message}`);
  process.exit(1);
}

if (check && !existsSync(link)) {
  fail(
    `.kitsuden does not exist. Link a Kitsuden checkout first:\n` +
      `  node scripts/link-core.mjs        (KITSUDEN_DIR=<path> if it is not ../kitsuden)`
  );
}

function readName(pkgJson) {
  try {
    return JSON.parse(readFileSync(pkgJson, "utf8")).name;
  } catch {
    return null;
  }
}

if (readName(join(target, "packages", "shared", "package.json")) !== "@kitsuden/shared") {
  fail(
    `${target} is not a Kitsuden checkout (no packages/shared named @kitsuden/shared).\n` +
      `  Clone https://github.com/Kitsuden/kitsuden next to this repo,\n` +
      `  or point KITSUDEN_DIR at your checkout: KITSUDEN_DIR=../my-kitsuden node scripts/link-core.mjs`
  );
}
if (readName(join(target, "packages", "engine", "package.json")) !== "@kitsuden/engine") {
  fail(`${target}/packages/engine is missing or is not @kitsuden/engine.`);
}
for (const dep of ["hono", "drizzle-orm", "zod"]) {
  if (!existsSync(join(target, "node_modules", dep, "package.json"))) {
    fail(`${target}/node_modules/${dep} is missing: run \`pnpm install\` in the Kitsuden checkout first.`);
  }
}
if (!existsSync(join(target, "packages", "shared", "dist", "index.js"))) {
  fail(
    `@kitsuden/shared is not built in ${target}: run \`pnpm --filter @kitsuden/shared build\` there first.`
  );
}

if (check) {
  console.log(`link-core: .kitsuden -> ${realpathSync(link)} (checked, not changed)`);
  process.exit(0);
}

let current = null;
try {
  if (lstatSync(link)) current = realpathSync(link);
} catch {
  current = null;
}

if (current && current === realpathSync(target)) {
  console.log(`link-core: .kitsuden -> ${target} (already linked)`);
  process.exit(0);
}
if (current !== null || existsSync(link)) {
  // Only ever remove the LINK, never what it points to: a junction is removed
  // with rmdir (unlink fails on it on Windows), a symlink with unlink.
  if (!lstatSync(link).isSymbolicLink() && process.platform !== "win32") {
    fail(".kitsuden exists and is not a link; remove it by hand.");
  }
  try {
    unlinkSync(link);
  } catch {
    rmdirSync(link);
  }
}

// A junction on Windows needs no admin rights; elsewhere a plain dir symlink.
symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
console.log(`link-core: .kitsuden -> ${target}`);

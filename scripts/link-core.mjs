#!/usr/bin/env node
/**
 * Links the Kitsuden checkout this repo builds and tests against.
 *
 *   KITSUDEN_DIR=../kitsuden node scripts/link-core.mjs     (default: ../kitsuden)
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
const target = resolve(root, process.env.KITSUDEN_DIR || "../kitsuden");

function fail(message) {
  console.error(`link-core: ${message}`);
  process.exit(1);
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

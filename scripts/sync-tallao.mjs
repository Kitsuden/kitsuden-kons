#!/usr/bin/env node
/**
 * Copies tallao components into a kon's admin sources.
 *
 *   TALLAO_DIR=../cms/tallao node scripts/sync-tallao.mjs [kon-id ...]   (default: every kon with admin-src/tallao.json)
 *
 * tallao (the owner's Svelte 5 UI kit) is used the shadcn way: components are COPIED into the
 * project, not installed. A kon lists the ones it uses in `admin-src/tallao.json`
 * (`{ "components": ["button", "tabs", …] }`); this script copies them, the ones they import
 * (`./dialog.svelte` from `confirm-dialog.svelte`…), `utils.ts`, and writes an `index.ts` with
 * only those exports. The copy lives in `admin-src/tallao/` and is committed, so the kon builds
 * without tallao on disk. Do not edit it: change tallao and run this again.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tallao = resolve(root, process.env.TALLAO_DIR || "../cms/tallao");
const source = join(tallao, "src", "lib");

function fail(message) {
  console.error(`sync-tallao: ${message}`);
  process.exit(1);
}

if (!existsSync(join(source, "components", "index.ts"))) {
  fail(`no tallao at ${tallao} (set TALLAO_DIR to the folder with src/lib/components)`);
}

const wanted = process.argv.slice(2);
const kons = (wanted.length ? wanted : readdirSync(join(root, "kons"))).filter((kon) =>
  existsSync(join(root, "kons", kon, "admin-src", "tallao.json"))
);
if (wanted.length && kons.length !== wanted.length) fail(`some of ${wanted.join(", ")} have no admin-src/tallao.json`);

// tallao is written on Windows with CRLF; this repo keeps LF.
const read = (path) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const copy = (from, to) => writeFileSync(to, read(from));

const index = read(join(source, "components", "index.ts")).split("\n");

for (const kon of kons) {
  const adminSrc = join(root, "kons", kon, "admin-src");
  const { components } = JSON.parse(readFileSync(join(adminSrc, "tallao.json"), "utf8"));

  // Components plus what they import (sibling components and tallao's own `$lib/...` modules:
  // `internal/` helpers, `i18n`, `toast.svelte`…), until nothing new appears. A bare package
  // they import (`@floating-ui/dom` for the floating components) has to be installed in this repo.
  const files = new Set();
  const internals = new Set();
  const pending = components.map((c) => `components/${c}.svelte`);
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file) || internals.has(file)) continue;
    const path = join(source, file);
    if (!existsSync(path)) fail(`${kon}: tallao has no ${file}`);
    (file.startsWith("components/") ? files : internals).add(file);
    const text = read(path);
    for (const m of text.matchAll(/from "\.\/([a-z0-9-]+\.svelte)"/g)) pending.push(`components/${m[1]}`);
    for (const m of text.matchAll(/from "\$lib\/([a-z0-9/.-]+)"/g)) {
      if (m[1] === "utils" || m[1].startsWith("components")) continue;
      pending.push(m[1].endsWith(".ts") ? m[1] : `${m[1]}.ts`);
    }
    // Modules of `internal/` import each other with relative paths.
    if (file.startsWith("internal/"))
      for (const m of text.matchAll(/from "\.\/([a-z0-9-]+)"/g)) pending.push(`internal/${m[1]}.ts`);
  }

  const out = join(adminSrc, "tallao");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "components"), { recursive: true });
  for (const file of [...files, ...internals]) {
    mkdirSync(join(out, file, ".."), { recursive: true });
    copy(join(source, file), join(out, file));
  }
  copy(join(source, "utils.ts"), join(out, "utils.ts"));

  const exports = index.filter((line) => {
    const m = line.match(/from "\.\/([a-z0-9-]+\.svelte)"/);
    return m && files.has(`components/${m[1]}`);
  });
  writeFileSync(
    join(out, "components", "index.ts"),
    `// Copied from tallao by scripts/sync-tallao.mjs. Do not edit: change tallao and sync again.\n${exports.join("\n")}\n`
  );
  console.log(`sync-tallao: ${kon} ← ${[...files, ...internals].sort().join(", ")}`);
}

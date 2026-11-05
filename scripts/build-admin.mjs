#!/usr/bin/env node
/**
 * Builds the admin views that kons write in Svelte with tallao.
 *
 *   node scripts/build-admin.mjs [kon-id ...]   (default: every kon with admin-src/views.json)
 *
 * The admin loads a kon's view as a compiled file at runtime (`admin.views[].src`, a custom
 * element), so each view listed in `admin-src/views.json` (`[{ "entry": "Scoreboard.svelte",
 * "out": "scoreboard.js" }]`) is built on its own into the kon's `admin/` folder; the built
 * files are what gets committed and published. Svelte, Vite and the Svelte plugin are linked
 * from the Kitsuden checkout's admin (root package.json), the copies the admin builds with.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { build } from "vite";

import { adminViteConfig } from "./admin-vite.mjs";

const root = resolve(import.meta.dirname, "..");
const wanted = process.argv.slice(2);
const kons = (wanted.length ? wanted : readdirSync(join(root, "kons"))).filter((kon) =>
  existsSync(join(root, "kons", kon, "admin-src", "views.json"))
);
if (wanted.length && kons.length !== wanted.length) {
  console.error(`build-admin: some of ${wanted.join(", ")} have no admin-src/views.json`);
  process.exit(1);
}

for (const kon of kons) {
  const adminSrc = join(root, "kons", kon, "admin-src");
  const views = JSON.parse(readFileSync(join(adminSrc, "views.json"), "utf8"));
  for (const view of views) {
    console.log(`build-admin: ${kon} ${view.entry} → admin/${view.out}`);
    await build(adminViteConfig({ adminSrc, ...view }));
  }
}

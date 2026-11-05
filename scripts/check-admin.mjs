#!/usr/bin/env node
/**
 * svelte-check on every kon's admin sources (admin-src/), one workspace per kon.
 *
 *   node scripts/check-admin.mjs [kon-id ...]
 *
 * svelte-check cannot see that only a view's root is compiled as a custom element
 * (scripts/admin-vite.mjs), so the warning about the root's <svelte:options customElement> is off.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const wanted = process.argv.slice(2);
const kons = (wanted.length ? wanted : readdirSync(join(root, "kons"))).filter((kon) =>
  existsSync(join(root, "kons", kon, "admin-src", "views.json"))
);

let failed = false;
for (const kon of kons) {
  const workspace = join(root, "kons", kon, "admin-src");
  const res = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "svelte-check", "bin", "svelte-check"),
      "--workspace",
      workspace,
      "--compiler-warnings",
      "options_missing_custom_element:ignore",
      "--fail-on-warnings",
      "--output",
      "human",
    ],
    { stdio: "pipe", encoding: "utf8" }
  );
  // The summary line, without svelte-check's colour codes.
  const plain = (res.stdout || "").replace(/\x1b\[[0-9;]*m/g, "");
  const last = plain.split("\n").find((l) => l.includes("svelte-check found")) ?? "";
  console.log(`check-admin: ${kon}: ${last}`);
  if (res.status !== 0) {
    failed = true;
    console.log(res.stdout);
  }
}
process.exit(failed ? 1 : 0);

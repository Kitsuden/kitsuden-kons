#!/usr/bin/env node
/**
 * Kitsuden's contract rules on these kons' operations
 * ============================================================================
 *
 * The same check the core runs on its own contract (`pnpm api:lint` in Kitsuden,
 * docs/api-contract.md there): operation ids, fine scopes, problem+json errors,
 * Idempotency-Key, pagination… on every `defineOperation` of every kon here.
 *
 *   1. The core builds the OpenAPI of these kons from their declarations, with no
 *      server and no database: `apps/api/scripts/sdk-openapi.ts --kon=<dir> …`.
 *   2. The core lints it with its ruleset: `scripts/api-contract/lint.mjs`
 *      (Spectral at a pinned version, through npx).
 *
 *   node scripts/api-contract.mjs                       # the core at ./.kitsuden
 *   KITSUDEN_DIR=../kitsuden node scripts/api-contract.mjs
 *   node scripts/api-contract.mjs --github --summary=<file>   # in CI
 *   node scripts/api-contract.mjs --kon=kon-blog        # only these kons (repeatable)
 *
 * Exit code: lint.mjs's (1 on an `error` rule). A core too old to have the ruleset
 * is reported and skipped (exit 0).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = resolve(ROOT, process.env.KITSUDEN_DIR ?? ".kitsuden");
const args = process.argv.slice(2);
const only = args.filter((a) => a.startsWith("--kon=")).map((a) => a.slice(6));
const passThrough = args.filter((a) => !a.startsWith("--kon="));
const windows = process.platform === "win32";
const quote = (a) => (windows && /\s/.test(a) ? `"${a}"` : a);

const lint = join(CORE, "scripts/api-contract/lint.mjs");
if (!existsSync(lint)) {
  console.error(
    `[api-contract] ${CORE} has no scripts/api-contract/lint.mjs (a Kitsuden older than the contract rules): skipped.`
  );
  process.exit(0);
}

const kons = readdirSync(join(ROOT, "kons"))
  .filter((k) => k.startsWith("kon-") && (only.length === 0 || only.includes(k)))
  .sort()
  .map((k) => join(ROOT, "kons", k));
if (kons.length === 0) {
  console.error(`[api-contract] no kon matches ${only.join(", ")}`);
  process.exit(2);
}

const spec = join(tmpdir(), `kitsuden-kons-contract-${process.pid}.json`);
try {
  const built = spawnSync(
    process.env.BUN_BINARY || "bun",
    ["--no-env-file", "scripts/sdk-openapi.ts", ...kons.map((k) => `--kon=${k}`), `--out=${spec}`].map(quote),
    { cwd: join(CORE, "apps/api"), stdio: "inherit", shell: windows }
  );
  if (built.status !== 0) {
    console.error(`[api-contract] building the kons' OpenAPI failed (exit ${built.status})`);
    process.exit(2);
  }
  const r = spawnSync(process.execPath, [lint, `--spec=${spec}`, ...passThrough], {
    cwd: CORE,
    stdio: "inherit",
  });
  process.exitCode = r.status ?? 2;
} finally {
  rmSync(spec, { force: true });
}

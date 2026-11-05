// Tests of the kons. They run AGAINST a Kitsuden checkout linked at
// ./.kitsuden (scripts/link-core.mjs): the kons do not exist without their host, and
// the security tests mount the kon with the core's real middleware.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "vitest/config";

const core = path.resolve(__dirname, ".kitsuden");

// The core only knows the kons declared as installed. Here that is every kon of this repo, by path.
const kons = path.resolve(__dirname, "kons");
const installed = readdirSync(kons, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(path.join(kons, e.name, "kon.json")))
  .map((e) => `${e.name}=${path.join(kons, e.name)}`)
  .join(",");

export default defineConfig({
  test: {
    globals: true,
    env: { KITSUDEN_KONS: installed },
    environment: "node",
    include: ["tests/**/*.test.ts", "kons/*/tests/**/*.test.ts"],
    // academy-lms and blog ship bun tests (`bun:test`): they run with `pnpm test:bun`.
    exclude: ["**/node_modules/**", "**/dist/**", "kons/kon-academy-lms/**", "tests/bun/**"],
    // The same setup as the core's unit suite (.where() guard).
    setupFiles: [path.join(core, "tests", "unit", "setup.ts")],
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@core": path.join(core, "packages", "core"),
      "@api": path.join(core, "apps", "api", "src"),
      "@/": path.join(core, "apps", "api", "src") + "/",
      // FROM SOURCE, as in the core: what is tested is what is written.
      "@kitsuden/shared": path.join(core, "packages", "shared", "src", "index.ts"),
    },
  },
});

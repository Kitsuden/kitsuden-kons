#!/usr/bin/env node
// bun tests for some kons (blog, academy-lms). They import the core's `db`,
// which requires DATABASE_URL at load time even though these tests do not connect:
// it is given a fake URL if there is no real one.
import { spawnSync } from "node:child_process";

const env = { ...process.env };
// A placeholder so the core's `db` module loads; these tests mock it and never connect. Port 1 is
// unreachable on purpose: 5432 may be a real database on the machine running them.
env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:1/test";
env.NODE_ENV ||= "test";
const r = spawnSync("bun", ["test", "kons/kon-blog", "kons/kon-academy-lms", "tests/bun"], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});
process.exit(r.status ?? 1);

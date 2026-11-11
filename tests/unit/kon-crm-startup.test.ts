/**
 * kon-crm — what the kon does when the API starts
 * ============================================================================
 *
 * Before 1.0.2 the startup hook ran the kon's migrations itself when one of six tables was
 * missing: it listed `packages/kons/kon-crm/migrations` under the working directory, read every
 * `.sql` and executed it with `sql.raw`. That is outside the host runner's ledger (the runner
 * would apply them again), as the application role (which cannot create tables), and from a path
 * that only exists in one layout. Now, as in kon-conta:
 *
 *   · tables come only from the host's migration runner: a missing table is a warning that names
 *     it, and the hook creates nothing;
 *   · with every table in place the hook says so and logs no warning or error.
 *
 * The guard `tests/guards/kons-do-not-create-tables.test.ts` keeps a kon from reading its
 * migration files at runtime again.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { kon } from "../../kons/kon-crm/index";

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "../../kons/kon-crm/kon.json"), "utf8")
) as { tables: Array<string | { name: string }> };
const TABLES = manifest.tables.map((t) => (typeof t === "string" ? t : t.name));

function start(client: PGlite, existing: (name: string) => Promise<boolean>) {
  const logs: Array<{ level: string; message: string; data?: unknown }> = [];
  const log = (level: string) => (message: string, data?: unknown) =>
    logs.push({ level, message, data });
  const ctx = createTestKonContext({
    db: {
      instance: drizzle(client),
      execute: async () => undefined,
      tableExists: existing,
    },
    logger: { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") },
  } as never);
  return { run: () => kon.hooks!.onStartup!(ctx), logs };
}

const inDatabase = (client: PGlite) => async (name: string) =>
  (
    await client.query<{ e: boolean }>(
      "select exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = $1) as e",
      [name]
    )
  ).rows[0]!.e;

describe("kon-crm startup", () => {
  it("never runs migrations: with the tables missing it warns, names them and creates nothing", async () => {
    const client = new PGlite();
    const { run, logs } = start(client, inDatabase(client));
    await run();

    const tables = await client.query<{ n: number }>(
      "select count(*)::int as n from information_schema.tables where table_schema = 'public'"
    );
    expect(tables.rows[0]!.n).toBe(0);

    const warning = logs.find((l) => l.level === "warn" && /migrations/i.test(l.message));
    expect(warning, JSON.stringify(logs)).toBeDefined();
    expect((warning!.data as { missing: string[] }).missing).toEqual(TABLES);
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
    await client.close();
  }, 60_000);

  it("checks every table of kon.json, not six of them", async () => {
    const client = new PGlite();
    const asked: string[] = [];
    const { run, logs } = start(client, async (name) => {
      asked.push(name);
      return true;
    });
    await run();

    expect(asked).toEqual(TABLES);
    expect(logs.filter((l) => l.level === "warn" || l.level === "error")).toEqual([]);
    await client.close();
  }, 60_000);
});

/**
 * kon-conta — what the kon does when the API starts
 * ============================================================================
 *
 * Before 1.0.1 the startup hook ran the kon's migrations itself when a table was missing (from a
 * path under the working directory, swallowing "already exists" errors) and seeded the default
 * chart of accounts on EVERY boot, so an account an admin renamed or removed came back. Now:
 *
 *   · tables come only from the host's migration runner: a missing table is a warning, and the
 *     hook creates nothing;
 *   · the default currencies and accounts are seeded once, on the first start that finds no
 *     account; `POST /api/conta/seed` seeds again on purpose.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { kon } from "../../kons/kon-conta/index";

import { AGENT_FUNCTIONS } from "./helpers/safe-kons-bench";

const MIGRATIONS = resolve(__dirname, "../../kons/kon-conta/migrations");

async function database(migrated: boolean): Promise<PGlite> {
  const client = new PGlite();
  await client.exec(readFileSync(AGENT_FUNCTIONS, "utf8"));
  if (migrated) {
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      await client.exec(readFileSync(resolve(MIGRATIONS, file), "utf8"));
    }
  }
  return client;
}

function start(client: PGlite) {
  const logs: Array<{ level: string; message: string }> = [];
  const log = (level: string) => (message: string) => logs.push({ level, message });
  const ctx = createTestKonContext({
    db: {
      instance: drizzle(client),
      execute: async () => undefined,
      tableExists: async (name: string) =>
        (
          await client.query<{ e: boolean }>(
            "select exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = $1) as e",
            [name]
          )
        ).rows[0]!.e,
    },
    logger: { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") },
  } as never);
  return { run: () => kon.hooks!.onStartup!(ctx), logs };
}

const tableCount = async (client: PGlite) =>
  (
    await client.query<{ n: number }>(
      "select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name like 'conta\\_%'"
    )
  ).rows[0]!.n;

describe("kon-conta startup", () => {
  it("never runs migrations: with the tables missing it warns and creates nothing", async () => {
    const client = await database(false);
    const { run, logs } = start(client);
    await run();
    expect(await tableCount(client)).toBe(0);
    expect(logs.some((l) => l.level === "warn" && /migrations/i.test(l.message))).toBe(true);
    await client.close();
  });

  it("seeds the default chart once, on the first start, and never brings back a removed account", async () => {
    const client = await database(true);
    const { run, logs } = start(client);
    await run();
    const seeded = await client.query<{ code: string }>("select code from conta_accounts order by code");
    expect(seeded.rows.map((r) => r.code)).toContain("1000");
    expect(logs.filter((l) => l.level === "error")).toEqual([]);

    // An admin removes a default account and renames another; the next boots leave them alone.
    await client.exec("delete from conta_accounts where code = '1500'");
    await client.exec("update conta_accounts set name = 'Petty cash' where code = '1000'");
    await run();
    await run();
    const after = await client.query<{ code: string; name: string }>("select code, name from conta_accounts");
    expect(after.rows.map((r) => r.code)).not.toContain("1500");
    expect(after.rows.find((r) => r.code === "1000")!.name).toBe("Petty cash");
    expect(after.rows).toHaveLength(seeded.rows.length - 1);
    await client.close();
  });
});

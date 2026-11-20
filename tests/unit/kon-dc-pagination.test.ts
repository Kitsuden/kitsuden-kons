/**
 * kon-dc: lists that grow with use take a page size
 * ============================================================================
 *
 * Servers, catalog items and blueprints take an optional `limit` (and `offset`): without it they answer
 * every row as before, with `hasMore: false`. A server's schedules page with `limit` (default and cap 500,
 * what the list always returned). The real router on PGlite as a non-superuser with row security and a
 * Discord that answers nothing.
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { AppError } from "@kitsuden/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { registerDcPolicy } from "../../kons/kon-dc/dc.policy";
import type { DiscordRest, DiscordSettings } from "../../kons/kon-dc/dc.rest";
import { createDcRouter } from "../../kons/kon-dc/dc.routes";

import { dropToAppRole, migratedBase, requestAs, sqlAs, testAuth } from "./helpers/safe-kons-bench";

const GUILDS = ["161616161616161616", "171717171717171717"];

const settings: DiscordSettings & Record<string, unknown> = {
  applicationId: "999999999999999999",
  publicKey: "00".repeat(32),
  botToken: "test-token",
  disabledModules: new Set(),
  apiBase: "http://discord.invalid",
};
const quietDiscord = new Proxy({} as DiscordRest, { get: () => async () => undefined });

let client: PGlite;
let request: ReturnType<typeof requestAs>;
const json = async (res: Response | Promise<Response>): Promise<any> => (await res).json();

beforeAll(async () => {
  const migrations = readdirSync(resolve(__dirname, "../../kons/kon-dc/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  client = await migratedBase("kon-dc", migrations);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never });
  const mounted = host.mount(createDcRouter(ctx, { settings: () => settings, rest: () => quietDiscord, scheduleTickMs: 0, renderPng: null }));
  mounted.onError((err) =>
    err instanceof AppError ? Response.json({ error: err.message, details: err.details }, { status: err.status }) : Response.json({ error: String(err) }, { status: 500 })
  );
  request = requestAs(mounted);
  registerDcPolicy();

  for (const [i, id] of GUILDS.entries()) expect((await request("staff", "PUT", `/guilds/${id}`, { name: `Server ${i}` })).status).toBe(200);
  for (const item of ["potion", "sword"]) expect((await request("staff", "PUT", "/items", { guildId: GUILDS[0], item, name: item })).status).toBe(200);
  for (const name of ["first", "second"]) {
    const r = await request("staff", "POST", "/blueprints", { name, status: "draft", definition: { commands: [{ name, description: "x", steps: [{ do: "reply", content: "x" }] }] } });
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
  }
  await sqlAs(client, "staff", `INSERT INTO dc_schedules (guild_id, module_id, key, run_at) VALUES ($1, 'reminders', 'a', now() + interval '1 hour'), ($1, 'reminders', 'b', now() + interval '1 hour')`, [GUILDS[0]]);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerDcPolicy();
});

describe("kon-dc list pagination", () => {
  for (const path of ["/guilds", `/items?guildId=${GUILDS[0]}&`, "/blueprints", `/guilds/${GUILDS[0]}/schedules`]) {
    it(`${path}: limit=1 answers one row and hasMore; without limit every row`, async () => {
      const sep = path.endsWith("&") ? "" : "?";
      const base = path.endsWith("&") ? path.slice(0, -1) : path;
      const page = await json(request("staff", "GET", `${path}${sep}limit=1`));
      expect(page.docs).toHaveLength(1);
      expect(page.hasMore).toBe(true);

      const next = await json(request("staff", "GET", `${path}${sep}limit=1&offset=1`));
      expect(next.docs).toHaveLength(1);
      expect(next.docs[0].id).not.toBe(page.docs[0].id);
      expect(next.hasMore).toBe(false);

      const all = await json(request("staff", "GET", base));
      expect(all.docs).toHaveLength(2);
      expect(all.hasMore).toBe(false);
    });
  }

  it("a page size beyond the cap is refused", async () => {
    expect((await request("staff", "GET", "/guilds?limit=501")).status).toBe(422);
    expect((await request("staff", "GET", `/guilds/${GUILDS[0]}/schedules?limit=0`)).status).toBe(422);
  });
});

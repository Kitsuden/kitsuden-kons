/**
 * kon-dc — REAL routes on PGlite, a non-superuser role and per-request row security
 * ============================================================================
 *
 * Mounts `createDcRouter` behind the host's RLS transaction (`rlsHost`) with the kon's
 * migration, a fake Discord REST API and a fake agent engine, and checks:
 *
 *   · only the team configures; the gateway worker's key reaches the two gateway operations and
 *     nothing else; nothing is public but the two schemas;
 *   · module settings are validated by each module's own zod schema;
 *   · the worker's intents follow the modules switched on;
 *   · blueprints run as data (commands, triggers, state), clashes are refused;
 *   · interactions need Discord's Ed25519 signature; slow answers are deferred and edited later;
 *   · export → import gives the same bot back.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";

import type { PGlite } from "@electric-sql/pglite";
import { AppError } from "@kitsuden/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { INTENTS } from "../../kons/kon-dc/dc.contract";
import { registerDcPolicy } from "../../kons/kon-dc/dc.policy";
import { KonCallError, type KitsudenClient } from "../../kons/kon-dc/dc.kitsuden";
import type { DiscordRest, DiscordSettings } from "../../kons/kon-dc/dc.rest";
import type { DcEngine } from "../../kons/kon-dc/dc.engine";
import { createDcRouter } from "../../kons/kon-dc/dc.routes";

import { dropToAppRole, migratedBase, requestAs, sqlAs, testAuth } from "./helpers/safe-kons-bench";

const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";
const ROLE = "333333333333333333";
const MEMBER = "444444444444444444";
const WORKER = { agent: ["kon:dc:gateway-config", "kon:dc:ingest-gateway-events"] };

// Discord's signing key, ours for the test.
const keys = generateKeyPairSync("ed25519");
const publicKeyHex = Buffer.from(keys.publicKey.export({ format: "der", type: "spki" }))
  .subarray(-32)
  .toString("hex");

const settings: DiscordSettings & Record<string, unknown> = {
  applicationId: "999999999999999999",
  publicKey: publicKeyHex,
  botToken: "test-token",
  disabledModules: new Set(),
  apiBase: "http://discord.invalid",
};

const calls: Array<{ fn: string; args: unknown[] }> = [];
let messageSeq = 900000000000000000n;
/** Roles Discord says a member has (for toggle_role on someone else). */
const memberRoles = new Map<string, string[]>();
/** Every REST method records its call; a few answer like Discord would. */
const fakeRest = new Proxy({} as DiscordRest, {
  get(_t, fn: string) {
    return async (...args: unknown[]) => {
      calls.push({ fn, args });
      if (fn === "sendMessage") return { id: String(++messageSeq) };
      if (fn === "openDm") return "555555555555555555";
      if (fn === "createThread" || fn === "createChannel") return { id: String(++messageSeq) };
      if (fn === "getMember") return { roles: memberRoles.get(args[1] as string) ?? [], nick: null };
      if (fn === "syncGuildCommands" || fn === "listAutoModRules") return [];
      if (fn === "getGuildOwner") return "199999999999999999";
      if (fn === "createWebhook") return { id: "201010101010101010", token: "hook-token" };
      if (fn === "executeWebhook") return { id: String(++messageSeq) };
      if (fn === "listRoles") return [{ id: args[0] as string, name: "@everyone", permissions: String((1n << 11n) | (1n << 10n) | (1n << 20n)), position: 0, managed: false }];
      if (fn === "recentMessages") {
        return [1, 2, 3].map((n) => ({ id: String(800000000000000000n + BigInt(n)), authorId: MEMBER, timestamp: new Date(Date.now() + clockOffsetMs - 3_600_000).toISOString(), pinned: n === 3 }));
      }
      return undefined;
    };
  },
});

/** Another kon, as the bot's agent key would reach it: a tiny fake kon-broadcast. */
const match = {
  id: "m1",
  eventTitle: "Weekly",
  round: "Pools",
  firstTo: 2,
  sideA: { name: "Ana", sponsor: "", score: 0 },
  sideB: { name: "Beto", sponsor: "", score: 0 },
  screens: { versus: false, ko: false, casters: false },
};
const konCalls: Array<{ method: string; path: string; body: unknown }> = [];
let konRefuses: string | null = null;
const fakeKitsuden: KitsudenClient = {
  async call(method, path, body) {
    konCalls.push({ method, path, body });
    if (konRefuses) throw new KonCallError(konRefuses, 403, "KITSUDEN_E_FORBIDDEN");
    if (path === "/broadcast/champions") {
      return { status: 200, data: { data: [{ slug: "ahri", name: "Ahri" }, { slug: "ekko", name: "Ekko" }, { slug: "yasuo", name: "Yasuo" }] } };
    }
    if (path.startsWith("/broadcast/matches/m1/score")) {
      const b = body as { side: "a" | "b"; delta?: number };
      const key = b.side === "a" ? "sideA" : "sideB";
      match[key].score += b.delta ?? 0;
      return { status: 200, data: { data: match } };
    }
    if (path === "/broadcast/matches/m1" && method === "PATCH") return { status: 200, data: { data: match } };
    if (path === "/broadcast/matches/m1") return { status: 200, data: { data: match } };
    return { status: 404, data: null };
  },
};
const bus = new EventEmitter();
const events = { emit: (e: string, d: unknown) => void bus.emit(e, d), on: (e: string, h: (d: unknown) => void) => void bus.on(e, h) };
const emitted: Array<{ event: string; data: unknown }> = [];
const realEmit = events.emit;
events.emit = (e, d) => {
  emitted.push({ event: e, data: d });
  realEmit(e, d);
};

let agentDelayMs = 0;
const agents = {
  run: async (o: { agentId: string; message: string; allowedTools?: string[] }) => {
    calls.push({ fn: "agents.run", args: [o] });
    await new Promise((r) => setTimeout(r, agentDelayMs));
    // "Describe your bot": a first answer that breaks the format, then a fixed one.
    if (o.message.startsWith("Write a kon-dc blueprint")) {
      const bad = { commands: [{ name: "Daily Coins", description: "Coins", steps: [{ do: "wallet_add", amount: 100 }, { do: "reply", content: "+100" }] }] };
      const fence = "`".repeat(3);
      return { response: `Here it is:\n${fence}json\n${JSON.stringify(bad)}\n${fence}`, sessionId: "s", traceId: "t", provider: "test", model: "test", tokensIn: 1, tokensOut: 1, toolCalls: [] };
    }
    if (o.message.startsWith("Your blueprint for this bot")) {
      const good = { commands: [{ name: "daily-coins", description: "Coins", steps: [{ do: "wallet_add", amount: 100 }, { do: "reply", content: "+100" }] }] };
      return { response: JSON.stringify(good), sessionId: "s", traceId: "t", provider: "test", model: "test", tokensIn: 1, tokensOut: 1, toolCalls: [] };
    }
    return {
      response: `answer to: ${o.message}`,
      sessionId: "s",
      traceId: "t",
      provider: "test",
      model: "test",
      tokensIn: 1,
      tokensOut: 1,
      toolCalls: [],
    };
  },
};

let client: PGlite;
let engine: DcEngine;
/** Moves the engine's clock forward (schedules, cooldowns). */
let clockOffsetMs = 0;
/** Image cards for the tests that turn them on, and the SVG of each one drawn. */
let cardsOn = false;
/** Feeds the fake web serves, and who the fake Twitch says is live. */
const feedDocs = new Map<string, string>();
const liveNow: Array<{ login: string; name: string; title: string; game: string; startedAt: string; thumbnail: string }> = [];
const drawn: string[] = [];
let request: ReturnType<typeof requestAs>;
let app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> };

async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function signed(body: unknown, opts: { tamper?: boolean; ts?: number } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = sign(null, Buffer.from(ts + raw), keys.privateKey).toString("hex");
  return app.request("/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": opts.tamper ? sig.replace(/^./, sig[0] === "a" ? "b" : "a") : sig,
      "x-signature-timestamp": ts,
    },
    body: raw,
  });
}

function command(name: string, options: Record<string, unknown> = {}) {
  return {
    type: 2,
    id: "1",
    token: "interaction-token",
    guild_id: GUILD,
    channel_id: CHANNEL,
    member: { user: { id: MEMBER, username: "ana", global_name: "Ana" } },
    data: { name, options: Object.entries(options).map(([n, value]) => ({ name: n, value })) },
  };
}

beforeAll(async () => {
  client = await migratedBase("kon-dc", ["0000_initial.sql", "0001_rewards_and_schedules.sql", "0002_global_profiles.sql", "0003_item_catalog.sql", "0004_voice.sql", "0005_activity.sql", "0006_characters.sql", "0007_message_cache.sql", "0008_guild_locale.sql", "0009_guild_plans.sql"]);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never, agents: agents as never, events: events as never });
  const mounted = host.mount(
    createDcRouter(ctx, {
      settings: () => settings,
      rest: () => fakeRest,
      kitsuden: () => fakeKitsuden,
      directAnswerMs: 100,
      panelDebounceMs: 20,
      scheduleTickMs: 0,
      // Image cards: off unless a test turns them on; the SVG drawn is kept to look at.
      renderPng: async () => (cardsOn ? async (svg: string) => (drawn.push(svg), new Uint8Array([0x89, 0x50, 0x4e, 0x47])) : null),
      fetchImage: async () => null,
      oauth: async (code: string) => {
        if (code !== "good-code") throw new Error("bad code");
        return { id: MEMBER, name: "Ana", avatar: null };
      },
      fetchText: async (url: string) => ({ status: feedDocs.has(url) ? 200 : 404, text: feedDocs.get(url) ?? "", contentType: "application/rss+xml" }),
      twitch: async (logins: string[]) => liveNow.filter((l) => logins.includes(l.login)),
      now: () => new Date(Date.now() + clockOffsetMs),
      onEngine: (e) => {
        engine = e;
      },
    })
  );
  mounted.onError((err) =>
    err instanceof AppError
      ? Response.json({ error: err.message, details: err.details }, { status: err.status })
      : Response.json({ error: String(err) }, { status: 500 })
  );
  app = mounted;
  request = requestAs(mounted);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerDcPolicy();
  calls.length = 0;
  konCalls.length = 0;
  emitted.length = 0;
  konRefuses = null;
  agentDelayMs = 0;
});

describe("kon-dc: who may do what", () => {
  it("only the team configures", async () => {
    expect((await request("anon", "GET", "/modules")).status).toBe(401);
    expect((await request("a", "GET", "/modules")).status).toBe(403);
    const r = await request("staff", "GET", "/modules");
    expect(r.status).toBe(200);
    const ids = (await r.json()).docs.map((m: { id: string }) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["welcome", "autorole", "leveling", "ai"]));
  });

  it("an agent needs the kon's scope", async () => {
    expect((await request({ agent: ["blog:*"] }, "GET", "/guilds")).status).toBe(403);
    expect((await request({ agent: ["dc:*"] }, "GET", "/guilds")).status).toBe(200);
  });

  it("the worker's key reaches the gateway and nothing else", async () => {
    expect((await request(WORKER, "GET", "/gateway/config")).status).toBe(200);
    expect((await request(WORKER, "GET", "/guilds")).status).toBe(403);
    expect((await request(WORKER, "GET", "/export")).status).toBe(403);
    expect((await request({ agent: ["blog:*"] }, "GET", "/gateway/config")).status).toBe(403);
    expect((await request("staff", "GET", "/gateway/config")).status).toBe(403);
  });

  it("the two schemas are public and hold no data", async () => {
    const contract = await (await request("anon", "GET", "/contract")).json();
    expect(Object.keys(contract)).toEqual(["gateway-config", "gateway-event-batch", "gateway-ingest-result"]);
    const bp = await (await request("anon", "GET", "/blueprints/schema")).json();
    expect(bp.type).toBe("object");
  });
});

describe("kon-dc: servers and modules", () => {
  it("the worker registers a server from GUILD_CREATE", async () => {
    const r = await request(WORKER, "POST", "/gateway/events", {
      contract: 1,
      events: [
        { t: "GUILD_CREATE", s: 1, shard: [0, 1], receivedAt: new Date().toISOString(), d: { id: GUILD, name: "Test server" } },
      ],
    });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ accepted: 1, dropped: 0 });
    const guilds = (await (await request("staff", "GET", "/guilds")).json()).docs;
    expect(guilds.map((g: { id: string }) => g.id)).toContain(GUILD);
  });

  it("a malformed batch is a 422", async () => {
    const r = await request(WORKER, "POST", "/gateway/events", { contract: 1, events: [{ t: "TYPING_START" }] });
    expect(r.status).toBe(422);
  });

  it("settings are validated by the module's schema", async () => {
    const bad = await request("staff", "PUT", `/guilds/${GUILD}/modules/welcome`, { enabled: true, config: {} });
    expect(bad.status).toBe(422);
    const unknown = await request("staff", "PUT", `/guilds/${GUILD}/modules/nope`, { enabled: true });
    expect(unknown.status).toBe(404);
    const ok = await request("staff", "PUT", `/guilds/${GUILD}/modules/welcome`, {
      enabled: true,
      config: { channelId: CHANNEL },
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).config.message).toContain("{{user.mention}}");
  });

  it("the worker's intents follow the modules switched on", async () => {
    const cfg = await (await request(WORKER, "GET", "/gateway/config")).json();
    expect(cfg.intents & INTENTS.GUILD_MEMBERS).toBeTruthy();
    expect(cfg.intents & INTENTS.MESSAGE_CONTENT).toBe(0);
    expect(cfg.events).toContain("GUILD_MEMBER_ADD");

    await request("staff", "PUT", `/guilds/${GUILD}/modules/welcome`, { enabled: false, config: { channelId: CHANNEL } });
    const off = await (await request(WORKER, "GET", "/gateway/config")).json();
    expect(off.intents & INTENTS.GUILD_MEMBERS).toBe(0);
    expect(off.revision).not.toBe(cfg.revision);
    await request("staff", "PUT", `/guilds/${GUILD}/modules/welcome`, { enabled: true, config: { channelId: CHANNEL } });
  });

  it("gateway events reach the modules switched on (welcome, leveling)", async () => {
    await request("staff", "PUT", `/guilds/${GUILD}/modules/leveling`, { enabled: true, config: { cooldownSeconds: 0 } });
    const now = new Date().toISOString();
    const r = await request(WORKER, "POST", "/gateway/events", {
      contract: 1,
      events: [
        { t: "GUILD_MEMBER_ADD", s: 2, shard: [0, 1], receivedAt: now, d: { guild_id: GUILD, user: { id: MEMBER, username: "ana" } } },
        { t: "MESSAGE_CREATE", s: 3, shard: [0, 1], receivedAt: now, d: { guild_id: GUILD, channel_id: CHANNEL, author: { id: MEMBER, username: "ana" } } },
        { t: "MESSAGE_CREATE", s: 4, shard: [0, 1], receivedAt: now, d: { guild_id: GUILD, channel_id: CHANNEL, author: { id: "5", bot: true } } },
      ],
    });
    expect(r.status).toBe(202);

    const welcome = await until(async () => calls.find((c) => c.fn === "sendMessage"));
    expect(welcome.args).toEqual([CHANNEL, `Welcome to the server, <@${MEMBER}>!`]);

    const xp = await until(async () => {
      const rows = await sqlAs<{ balance: number }>(client, "staff", `SELECT balance FROM dc_wallets WHERE currency = 'xp' AND user_id = $1`, [MEMBER]);
      return rows[0];
    });
    // XP lives in the server's shared economy, as the currency "xp".
    expect(Number(xp.balance)).toBe(10);
    // The bot's own message gave no XP.
    const bots = await sqlAs(client, "staff", `SELECT 1 FROM dc_wallets WHERE user_id = '5'`);
    expect(bots).toHaveLength(0);
  });
});

describe("kon-dc: interactions", () => {
  it("refuses a missing or wrong signature, and a stale one", async () => {
    const plain = await app.request("/interactions", { method: "POST", body: JSON.stringify({ type: 1 }) });
    expect(plain.status).toBe(401);
    expect((await signed({ type: 1 }, { tamper: true })).status).toBe(401);
    expect((await signed({ type: 1 }, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
  });

  it("answers PING", async () => {
    const r = await signed({ type: 1 });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ type: 1 });
  });

  // PGlite has ONE connection: a command that reads state waits for the request's transaction, so
  // here it is always deferred and then edited. With a real pool a fast one is answered directly.
  it("runs a built-in command (/rank), privately", async () => {
    const body = await (await signed(command("rank"))).json();
    expect(body).toEqual({ type: 5, data: { flags: 64 } });
    const edit = await until(async () => calls.find((c) => c.fn === "editOriginal"));
    expect(edit.args[0]).toBe("interaction-token");
    expect(edit.args[1]).toMatchObject({ content: "Level 0 · 10 XP" });
  });

  it("an inactive command says so", async () => {
    const body = await (await signed(command("nothing-here"))).json();
    expect(body.data.content).toMatch(/not active/);
  });

  it("a slow answer is deferred, then edited", async () => {
    await request("staff", "PUT", `/guilds/${GUILD}/modules/ai`, { enabled: true, config: { agentId: "discord-helper", cooldownSeconds: 0 } });
    agentDelayMs = 300;
    const body = await (await signed(command("ask", { question: "what is 6x7?" }))).json();
    expect(body.type).toBe(5);
    const edit = await until(async () => calls.find((c) => c.fn === "editOriginal"));
    expect(edit.args).toEqual(["interaction-token", { content: "answer to: what is 6x7?" }]);
    const run = calls.find((c) => c.fn === "agents.run")!.args[0] as { allowedTools: string[] };
    // Anyone on Discord can type to the bot: never with tools.
    expect(run.allowedTools).toEqual([]);
  });
});

describe("kon-dc: blueprints", () => {
  let blueprintId: string;

  it("refuses a definition that does not fit the format", async () => {
    const r = await request("staff", "POST", "/blueprints", {
      name: "Bad",
      definition: { triggers: [{ on: "member_join", steps: [{ do: "reply", content: "x" }] }] },
    });
    expect(r.status).toBe(422);
    const code = await request("staff", "POST", "/blueprints", {
      name: "Bad",
      definition: { commands: [{ name: "x", description: "x", steps: [{ do: "eval", code: "process.exit()" }] }] },
    });
    expect(code.status).toBe(422);
  });

  it("a published blueprint is a module with commands and state", async () => {
    const r = await request("staff", "POST", "/blueprints", {
      name: "Cookies",
      status: "published",
      definition: {
        commands: [
          {
            name: "cookie",
            description: "Give a cookie",
            options: [{ name: "to", description: "Who", type: "string", required: true }],
            steps: [
              { do: "kv_increment", key: "cookies", by: 1 },
              { do: "reply", content: "{{user.name}} gave a cookie to {{option.to}} ({{kv.cookies}} so far)" },
            ],
          },
        ],
        triggers: [{ on: "member_join", steps: [{ do: "add_role", roleId: ROLE }] }],
      },
    });
    expect(r.status).toBe(201);
    blueprintId = (await r.json()).id;

    const modules = (await (await request("staff", "GET", "/modules")).json()).docs;
    expect(modules.map((m: { id: string }) => m.id)).toContain(`blueprint-${blueprintId}`);

    expect(
      (await request("staff", "PUT", `/guilds/${GUILD}/modules/blueprint-${blueprintId}`, { enabled: true })).status
    ).toBe(200);

    const answer = async (to: string) => {
      calls.length = 0;
      expect((await (await signed(command("cookie", { to }))).json()).type).toBe(5);
      return ((await until(async () => calls.find((c) => c.fn === "editOriginal"))).args[1] as { content: string }).content;
    };
    expect(await answer("Beto")).toBe("Ana gave a cookie to Beto (1 so far)");
    expect(await answer("Mia")).toBe("Ana gave a cookie to Mia (2 so far)");

    const cfg = await (await request(WORKER, "GET", "/gateway/config")).json();
    expect(cfg.intents & INTENTS.GUILD_MEMBERS).toBeTruthy();
  });

  it("a command that needs no state is answered directly", async () => {
    const r = await request("staff", "POST", "/blueprints", {
      name: "Ping",
      status: "published",
      definition: { commands: [{ name: "ping", description: "Pong", steps: [{ do: "reply", content: "pong, {{user.mention}}" }] }] },
    });
    const id = (await r.json()).id;
    await request("staff", "PUT", `/guilds/${GUILD}/modules/blueprint-${id}`, { enabled: true });
    const body = await (await signed(command("ping"))).json();
    expect(body).toEqual({
      type: 4,
      data: { content: `pong, <@${MEMBER}>`, flags: 0, allowed_mentions: { parse: ["users"] } },
    });
    expect((await request("staff", "DELETE", `/blueprints/${id}`)).status).toBe(204);
  });

  it("two modules with the same command are refused at sync", async () => {
    const clash = await request("staff", "POST", "/blueprints", {
      name: "Clash",
      status: "published",
      definition: { commands: [{ name: "rank", description: "x", steps: [{ do: "reply", content: "x" }] }] },
    });
    const clashId = (await clash.json()).id;
    await request("staff", "PUT", `/guilds/${GUILD}/modules/blueprint-${clashId}`, { enabled: true });
    const r = await request("staff", "POST", `/guilds/${GUILD}/commands/sync`);
    expect(r.status).toBe(409);
    expect(calls.some((c) => c.fn === "syncGuildCommands")).toBe(false);
    expect((await request("staff", "DELETE", `/blueprints/${clashId}`)).status).toBe(204);
  });

  it("sync pushes the commands of the active modules", async () => {
    const r = await request("staff", "POST", `/guilds/${GUILD}/commands/sync`);
    expect(r.status).toBe(200);
    const names = (await r.json()).synced.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(["ask", "cookie", "levels", "rank", "xp"]);
    expect(calls.find((c) => c.fn === "syncGuildCommands")!.args[0]).toBe(GUILD);
  });

  it("export, delete, import: the same bot comes back", async () => {
    const exported = await (await request("staff", "GET", "/export")).json();
    expect(exported.kind).toBe("kitsuden.dc/export");
    expect(JSON.stringify(exported)).not.toContain("test-token");

    expect((await request("staff", "DELETE", `/blueprints/${blueprintId}`)).status).toBe(204);
    const gone = (await (await request("staff", "GET", `/guilds/${GUILD}/modules`)).json()).docs;
    expect(gone.some((m: { id: string }) => m.id === `blueprint-${blueprintId}`)).toBe(false);

    const r = await request("staff", "POST", "/import", exported);
    expect(r.status).toBe(200);
    const result = await r.json();
    expect(result.blueprints).toBe(1);
    expect(result.skipped).toEqual([]);

    const back = (await (await request("staff", "GET", `/guilds/${GUILD}/modules`)).json()).docs;
    expect(back.find((m: { id: string }) => m.id === `blueprint-${blueprintId}`)?.enabled).toBe(true);
  });

  it("an id that is not a UUID gives 404, not a 500", async () => {
    expect((await request("staff", "GET", "/blueprints/not-a-uuid")).status).toBe(404);
  });
});

// ── The builder: components, modals, autocomplete, panels, other kons ─────────

function component(customId: string, opts: { values?: string[]; roles?: string[]; type?: number } = {}) {
  return {
    type: 3,
    id: "2",
    token: "component-token",
    guild_id: GUILD,
    channel_id: CHANNEL,
    message: { id: "800000000000000001" },
    member: { user: { id: MEMBER, username: "ana", global_name: "Ana" }, roles: opts.roles ?? [] },
    data: { custom_id: customId, component_type: opts.type ?? 2, ...(opts.values ? { values: opts.values } : {}) },
  };
}

function modalSubmit(customId: string, fields: Record<string, string>) {
  return {
    type: 5,
    id: "3",
    token: "modal-token",
    guild_id: GUILD,
    channel_id: CHANNEL,
    member: { user: { id: MEMBER, username: "ana" }, roles: [] },
    data: {
      custom_id: customId,
      components: Object.entries(fields).map(([custom_id, value]) => ({ type: 1, components: [{ type: 4, custom_id, value }] })),
    },
  };
}

function autocomplete(name: string, options: Array<{ name: string; value: string; focused?: boolean }>) {
  return { ...command(name), type: 4, data: { name, options: options.map((o) => ({ type: 3, ...o })) } };
}

const BOOTH = {
  name: "Booth lite",
  status: "published",
  definition: {
    commands: [
      {
        name: "pick",
        description: "Pick a character",
        options: [
          {
            name: "char",
            description: "Fixed list",
            type: "string",
            autocomplete: { choices: [{ name: "Ahri", value: "ahri" }, { name: "Ekko", value: "ekko" }] },
          },
          {
            name: "remote",
            description: "From the roster",
            type: "string",
            autocomplete: { path: "/broadcast/champions", items: "data", label: "{{item.name}}", value: "{{item.slug}}" },
          },
        ],
        steps: [{ do: "reply", content: "picked {{option.char}}", ephemeral: true }],
      },
      { name: "ops", description: "Operators only", access: { roles: [ROLE], message: "Operators only." }, steps: [{ do: "reply", content: "ok" }] },
      {
        name: "booth",
        description: "Booth",
        subcommands: [
          {
            name: "post",
            description: "Post the panel",
            steps: [
              { do: "kv_set", key: "set", value: "m1" },
              { do: "post_panel", panel: "board", channelId: "$channel" },
              { do: "reply", content: "posted", ephemeral: true },
            ],
          },
        ],
      },
    ],
    triggers: [
      {
        on: "kon_event",
        event: "broadcast:match:updated",
        where: { left: "{{event.round}}", op: "eq", right: "Grand Final" },
        steps: [{ do: "send_message", channelId: CHANNEL, content: "GF: {{event.sideA.name}} vs {{event.sideB.name}}" }],
      },
    ],
    modals: [
      {
        id: "edit",
        title: "Edit",
        inputs: [
          { id: "title", label: "Title" },
          { id: "name_a", label: "Side A" },
        ],
        steps: [
          {
            do: "kon_call",
            method: "PATCH",
            path: "/broadcast/matches/{{kv.set}}",
            body: { eventTitle: "{{input.title}}", sideA: { name: "{{input.name_a}}" } },
          },
          { do: "reply", content: "saved", ephemeral: true },
        ],
      },
    ],
    panels: [
      {
        id: "board",
        data: { m: "/broadcast/matches/{{kv.set}}" },
        refreshOn: ["broadcast:match:updated"],
        content: "{{data.m.data.sideA.name}} {{data.m.data.sideA.score}} - {{data.m.data.sideB.score}} {{data.m.data.sideB.name}}",
        components: [
          [
            {
              type: "button",
              id: "a-up",
              label: "A +1",
              style: "success",
              steps: [{ do: "kon_call", method: "POST", path: "/broadcast/matches/{{kv.set}}/score", body: { side: "a", delta: 1 } }],
            },
            { type: "button", id: "edit", label: "Edit", steps: [{ do: "open_modal", modal: "edit" }] },
            { type: "button", id: "guarded", label: "Ops", access: { roles: [ROLE] }, steps: [{ do: "update_message", content: "operated" }] },
          ],
          [
            {
              type: "select",
              id: "chars",
              optionsFrom: { path: "/broadcast/champions", items: "data", label: "{{item.name}}", value: "{{item.slug}}" },
              maxValues: 2,
              steps: [
                { do: "kon_call", method: "PATCH", path: "/broadcast/matches/{{kv.set}}", body: { sideA: { chars: "{{values_list}}" } } },
                { do: "update_message", content: "chars: {{values}}" },
              ],
            },
          ],
        ],
      },
    ],
  },
};

describe("kon-dc: the builder", () => {
  let moduleId = "";
  let panelMessage = "";

  it("refuses definitions that cannot work", async () => {
    const check = async (definition: unknown) => (await request("staff", "POST", "/blueprints/validate", { definition })).json();
    const step = (s: unknown) => ({ commands: [{ name: "x", description: "x", steps: [s] }] });
    const modalNotAlone = {
      // A modal opens only as the immediate answer: after another step it could never open.
      commands: [{ name: "x", description: "x", steps: [{ do: "reply", content: "y" }, { do: "open_modal", modal: "m" }] }],
      modals: [{ id: "m", title: "M", inputs: [{ id: "a", label: "A" }], steps: [{ do: "reply", content: "z" }] }],
    };
    expect((await check(modalNotAlone)).valid).toBe(false);
    expect((await check(step({ do: "update_message", content: "y" }))).problems[0].message).toMatch(/update_message/);
    expect((await check(step({ do: "post_panel", panel: "nope", channelId: "$channel" }))).valid).toBe(false);
    expect((await check(step({ do: "kon_call", path: "/dc/interactions" }))).valid).toBe(false);
    expect((await check(step({ do: "kon_call", path: "/broadcast/../admin" }))).valid).toBe(false);
    expect((await check({ triggers: [{ on: "kon_event", event: "dc:blueprint:x", steps: [{ do: "kv_set", key: "a", value: 1 }] }] })).valid).toBe(false);
    const ok = await check(BOOTH.definition);
    expect(ok.problems).toEqual([]);
    expect(ok.summary).toMatchObject({ commands: 3, triggers: 1, modals: 1, panels: 1, components: 4 });
  });

  it("posts a live panel with buttons and a select fed by another kon", async () => {
    const r = await request("staff", "POST", "/blueprints", BOOTH);
    expect(r.status).toBe(201);
    moduleId = `blueprint-${(await r.json()).id}`;
    await request("staff", "PUT", `/guilds/${GUILD}/modules/${moduleId}`, { enabled: true });

    const body = await (await signed({ ...command("booth"), data: { name: "booth", options: [{ type: 1, name: "post", options: [] }] } })).json();
    expect(body.type).toBe(5);
    const edit = await until(async () => calls.find((c) => c.fn === "editOriginal"));
    expect(edit.args[1]).toEqual({ content: "posted" });

    const sent = calls.find((c) => c.fn === "sendMessage")!;
    const payload = sent.args[1] as { content: string; components: Array<{ components: Array<Record<string, unknown>> }> };
    expect(payload.content).toBe("Ana 0 - 0 Beto");
    expect(payload.components[0].components.map((c) => c.custom_id)).toEqual([
      `dc:${moduleId}:a-up`,
      `dc:${moduleId}:edit`,
      `dc:${moduleId}:guarded`,
    ]);
    const select = payload.components[1].components[0] as { options: Array<{ value: string }>; max_values: number };
    expect(select.options.map((o) => o.value)).toEqual(["ahri", "ekko", "yasuo"]);
    expect(select.max_values).toBe(2);

    const panels = (await (await request("staff", "GET", `/guilds/${GUILD}/panels`)).json()).docs;
    expect(panels).toHaveLength(1);
    panelMessage = panels[0].messageId;
    expect(panels[0]).toMatchObject({ moduleId, panelId: "board", channelId: CHANNEL });
  });

  it("a button calls the other kon and only acknowledges", async () => {
    const r = await (await signed(component(`dc:${moduleId}:a-up`))).json();
    expect(r).toEqual({ type: 6 });
    const call = await until(async () => konCalls.find((k) => k.path === "/broadcast/matches/m1/score"));
    expect(call.body).toEqual({ side: "a", delta: 1 });
    expect(calls.some((c) => c.fn === "editOriginal")).toBe(false);
  });

  it("a button opens a modal at once; blank fields leave values as they are", async () => {
    const r = await (await signed(component(`dc:${moduleId}:edit`))).json();
    expect(r.type).toBe(9);
    expect(r.data.custom_id).toBe(`dc:${moduleId}:edit`);
    expect(r.data.components.map((row: { components: Array<{ custom_id: string }> }) => row.components[0].custom_id)).toEqual([
      "title",
      "name_a",
    ]);

    await (await signed(modalSubmit(`dc:${moduleId}:edit`, { title: "", name_a: "Zed" }))).json();
    const call = await until(async () => konCalls.find((k) => k.method === "PATCH"));
    expect(call.body).toEqual({ sideA: { name: "Zed" } });
  });

  it("a select passes what was picked as a list", async () => {
    await (await signed(component(`dc:${moduleId}:chars`, { values: ["ahri", "ekko"], type: 3 }))).json();
    const call = await until(async () => konCalls.find((k) => k.method === "PATCH"));
    expect(call.body).toEqual({ sideA: { chars: ["ahri", "ekko"] } });
    const edit = await until(async () => calls.find((c) => c.fn === "editOriginal"));
    expect((edit.args[1] as { content: string }).content).toBe("chars: ahri, ekko");
  });

  it("role gates: refused without the role, run with it", async () => {
    const no = await (await signed(component(`dc:${moduleId}:guarded`))).json();
    expect(no.type).toBe(4);
    expect(no.data.flags).toBe(64);
    const yes = await (await signed(component(`dc:${moduleId}:guarded`, { roles: [ROLE] }))).json();
    expect([6, 7]).toContain(yes.type);
    const cmd = await (await signed(command("ops"))).json();
    expect(cmd.data.content).toBe("Operators only.");
  });

  it("autocomplete: a fixed list filtered, and another kon's list", async () => {
    const fixed = await (await signed(autocomplete("pick", [{ name: "char", value: "ek", focused: true }]))).json();
    expect(fixed).toEqual({ type: 8, data: { choices: [{ name: "Ekko", value: "ekko" }] } });
    const remote = await (await signed(autocomplete("pick", [{ name: "remote", value: "ya", focused: true }]))).json();
    expect(remote.data.choices).toEqual([{ name: "Yasuo", value: "yasuo" }]);
  });

  it("another kon's event redraws the panel and runs the trigger", async () => {
    // The engine subscribes in the background after a module is switched on.
    await until(async () => bus.listenerCount("broadcast:match:updated") > 0);
    calls.length = 0;
    match.sideA.score = 2;
    events.emit("broadcast:match:updated", { matchId: "m1", round: "Grand Final", sideA: { name: "Ana" }, sideB: { name: "Beto" } });
    const msg = await until(async () => calls.find((c) => c.fn === "sendMessage"));
    expect(msg.args).toEqual([CHANNEL, { content: "GF: Ana vs Beto" }]);
    const redraw = await until(async () => calls.find((c) => c.fn === "editMessage"));
    expect(redraw.args[0]).toBe(CHANNEL);
    expect(redraw.args[1]).toBe(panelMessage);
    expect((redraw.args[2] as { content: string }).content).toBe("Ana 2 - 0 Beto");
  });

  it("another kon's refusal reaches the member, privately and apart from the panel", async () => {
    konRefuses = "Not your set";
    const r = await (await signed(component(`dc:${moduleId}:a-up`))).json();
    if (r.type === 4) expect(r.data.content).toBe("⚠️ Not your set");
    else {
      expect(r.type).toBe(6);
      const f = await until(async () => calls.find((c) => c.fn === "followup"));
      expect(f.args).toEqual(["component-token", "⚠️ Not your set", true]);
    }
    expect(calls.some((c) => c.fn === "editMessage" || c.fn === "editOriginal")).toBe(false);
  });

  it("emits its own events for other kons and the core's actions", async () => {
    await (await signed(command("pick", { char: "ahri" }))).json();
    expect(emitted.some((e) => e.event === "dc:command:used" && (e.data as { command: string }).command === "pick")).toBe(true);
  });

  it("templates install as drafts, with their settings validated", async () => {
    const list = (await (await request("staff", "GET", "/templates")).json()).docs;
    expect(list.map((t: { id: string }) => t.id)).toEqual(["broadcast-booth", "feedback-form", "loot-box", "quiz"]);
    expect(list[0].needs.scopes).toContain("kon:broadcast:scoreboard");
    expect((await request("staff", "POST", "/templates/feedback-form/install", { options: {} })).status).toBe(422);
    const booth = await request("staff", "POST", "/templates/broadcast-booth/install", {
      options: { operatorRoleIds: [ROLE], picksPerSide: 2 },
    });
    expect(booth.status).toBe(201);
    const row = await booth.json();
    expect(row.status).toBe("draft");
    expect(row.definition.commands[0].subcommands.map((s: { name: string }) => s.name)).toEqual(
      expect.arrayContaining(["set", "panel", "event", "player", "score", "point", "chars", "swap", "versus", "ko", "casters", "caster", "reset", "startgg", "status"])
    );
    expect((await request("staff", "DELETE", `/blueprints/${row.id}`)).status).toBe(204);
  });

  it("status says what is configured, never a value", async () => {
    const s = await (await request("staff", "GET", "/status")).json();
    expect(s.configured).toEqual({ publicKey: true, applicationId: true, botToken: true, kitsudenApi: false });
    expect(s.inviteUrl).toContain("client_id=999999999999999999");
    expect(JSON.stringify(s)).not.toContain("test-token");
    expect((await request("a", "GET", "/status")).status).toBe(403);
  });
});

describe("kon-dc: settings the panel draws as forms", () => {
  it("every module and template setting has a title, and lists are lists SchemaForm draws (text, numbers, objects)", async () => {
    const modules = (await (await request("staff", "GET", "/modules")).json()).docs as Array<{ id: string; configSchema: { properties?: Record<string, { title?: string; type?: string; items?: { type?: string } }> } }>;
    const templates = (await (await request("staff", "GET", "/templates")).json()).docs as Array<{ id: string; optionsSchema: { properties?: Record<string, { title?: string; type?: string; items?: { type?: string } }> } }>;
    const schemas = [
      ...modules.filter((m) => !m.id.startsWith("blueprint-")).map((m) => [m.id, m.configSchema] as const),
      ...templates.map((t) => [t.id, t.optionsSchema] as const),
    ];
    for (const [id, schema] of schemas) {
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        expect(prop.title, `${id}.${key} has no title`).toBeTruthy();
        if (prop.type === "array") expect(["string", "object", "integer", "number"], `${id}.${key}`).toContain(prop.items?.type);
      }
    }
  });
});

// ── Rewards, interactivity and Discord actions ─────────────────────────────────────────────────

const OTHER = "777777777777777777";
const ROLE_B = "666666666666666666";
const TARGET_MESSAGE = "810000000000000001";

/** Publishes a blueprint and switches it on in the test server. */
async function enableBlueprint(definition: unknown): Promise<string> {
  const r = await request("staff", "POST", "/blueprints", { name: `bp-${Math.random().toString(36).slice(2, 8)}`, status: "published", definition });
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
  const moduleId = `blueprint-${(await r.json()).id}`;
  expect((await request("staff", "PUT", `/guilds/${GUILD}/modules/${moduleId}`, { enabled: true })).status).toBe(200);
  return moduleId;
}

/** A gateway event in any server, waited for. */
async function gatewayEventIn(guildId: string, t: string, d: Record<string, unknown>) {
  const r = await request(WORKER, "POST", "/gateway/events", { contract: 1, events: [{ t, s: 9, shard: [0, 1], receivedAt: new Date().toISOString(), d: { guild_id: guildId, ...d } }] });
  expect(r.status).toBe(202);
  await engine.idle();
}

/** Publishes a blueprint and switches it on in another server. */
async function enableBlueprintIn(guildId: string, definition: unknown): Promise<string> {
  const r = await request("staff", "POST", "/blueprints", { name: `bp-${Math.random().toString(36).slice(2, 8)}`, status: "published", definition });
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
  const moduleId = `blueprint-${(await r.json()).id}`;
  expect((await request("staff", "PUT", `/guilds/${guildId}/modules/${moduleId}`, { enabled: true })).status).toBe(200);
  return moduleId;
}

/** What the member reads after an interaction: the direct answer, the edited "thinking…", or a private follow-up. */
async function said(body: unknown): Promise<string> {
  calls.length = 0;
  const r = await (await signed(body)).json();
  if (r.type === 4 || r.type === 7) return r.data.content;
  const edit = await until(async () => calls.find((c) => c.fn === "editOriginal" || c.fn === "followup"));
  const payload = edit.args[1];
  return typeof payload === "string" ? payload : (payload as { content: string }).content;
}

const withMember = (body: ReturnType<typeof command>, member: Record<string, unknown>) => ({ ...body, member: { ...body.member, ...member } });

describe("kon-dc: rewards and the economy", () => {
  it("daily with a cooldown, a shop with a price, items, a leaderboard and arithmetic", async () => {
    await enableBlueprint({
      commands: [
        {
          name: "daily",
          description: "Daily coins",
          steps: [
            { do: "cooldown", seconds: 86400, message: "Come back in {{cooldown.left}}" },
            { do: "random", saveAs: "amt", min: 50, max: 50 },
            { do: "wallet_add", amount: "{{var.amt}}", saveAs: "bal" },
            { do: "reply", content: "+{{var.amt}} coins, you have {{var.bal|number}}" },
          ],
        },
        {
          name: "buy",
          description: "Buy",
          options: [{ name: "item", description: "Item", type: "string", required: true }],
          steps: [
            { do: "stop", if: { left: "{{option.item}}", op: "not_in", right: "sword, shield" }, content: "No such item" },
            { do: "wallet_take", amount: 30, else: "You need 30 coins" },
            { do: "item_add", item: "sword", saveAs: "n" },
            { do: "reply", content: "You have {{var.n}} {{var.n|plural:sword,swords}}" },
          ],
        },
        {
          name: "top",
          description: "Top",
          steps: [
            { do: "leaderboard", saveAs: "lb" },
            { do: "wallet_get", saveAs: "me" },
            { do: "reply", content: "{{var.lb}}\n#{{var.me_rank}} {{user.name|upper}}" },
          ],
        },
        {
          name: "calc",
          description: "Calc",
          options: [{ name: "x", description: "x", type: "integer" }],
          steps: [
            { do: "math", saveAs: "r", expr: "max({{option.x}} * 2, 10) + 1" },
            { do: "reply", content: "{{var.r}}" },
          ],
        },
      ],
    });

    expect(await said(command("daily"))).toBe("+50 coins, you have 50");
    // One second may pass between the two: 1 d, or 23 h 59 min.
    expect(await said(command("daily"))).toMatch(/^Come back in (1 d|23 h 59 min)$/);
    clockOffsetMs += 86_401_000;
    expect(await said(command("daily"))).toBe("+50 coins, you have 100");
    expect(emitted.some((e) => e.event === "dc:reward:granted" && (e.data as { amount: number }).amount === 50)).toBe(true);

    expect(await said(command("buy", { item: "axe" }))).toBe("No such item");
    expect(await said(command("buy", { item: "sword" }))).toBe("You have 1 sword");
    expect(await said(command("buy", { item: "sword" }))).toBe("You have 2 swords");
    expect(await said(command("buy", { item: "sword" }))).toBe("You have 3 swords");
    // 100 - 90 = 10 left: all or nothing.
    expect(await said(command("buy", { item: "sword" }))).toBe("You need 30 coins");
    expect(emitted.some((e) => e.event === "dc:item:granted")).toBe(true);

    expect(await said(command("top"))).toBe(`**1.** <@${MEMBER}> — 10\n#1 ANA`);
    expect(await said(command("calc", { x: 3 }))).toBe("11");
    expect(await said(command("calc", { x: 20 }))).toBe("41");
  });
});

describe("kon-dc: interactivity", () => {
  let roles = "";

  it("a role menu toggles the picked role; an entry button counts and restyles the live panel", async () => {
    roles = await enableBlueprint({
      commands: [
        { name: "roles-panel", description: "Post", steps: [{ do: "post_panel", panel: "menu", channelId: "$channel" }, { do: "reply", content: "ok", ephemeral: true }] },
        {
          name: "draw",
          description: "Draw",
          access: { permissions: ["manage_guild"], message: "Staff only" },
          steps: [{ do: "list_pick", list: "raffle", saveAs: "w" }, { do: "reply", content: "Winner: {{var.w}} ({{var.w_count}})" }],
        },
      ],
      panels: [
        {
          id: "menu",
          content: "Pick your roles",
          embeds: [{ title: "Roles", color: "{{kv.color|default:#ff0000}}" }],
          components: [
            [
              {
                type: "select",
                id: "roles",
                options: [
                  { label: "A", value: ROLE },
                  { label: "B", value: ROLE_B },
                ],
                selected: "{{kv.fav}}",
                steps: [{ do: "toggle_role", roleId: "{{value}}", saveAs: "t" }, { do: "reply", ephemeral: true, content: "Role {{var.t}}" }],
              },
            ],
            [
              {
                type: "button",
                id: "enter",
                label: "Enter ({{kv.n|default:0}})",
                styles: [{ if: { left: "{{kv.n}}", op: "gte", right: "1" }, style: "success" }],
                steps: [
                  { do: "list_join", list: "raffle", mode: "toggle", saveAs: "j" },
                  { do: "kv_set", key: "n", value: "{{var.j_count}}" },
                  { do: "kv_set", key: "fav", value: ROLE_B },
                  { do: "refresh_panels" },
                ],
              },
            ],
          ],
        },
      ],
    });

    await said(command("roles-panel"));
    const posted = calls.find((c) => c.fn === "sendMessage")!.args[1] as {
      embeds: Array<{ color: number }>;
      components: Array<{ components: Array<{ style?: number; label?: string; options?: Array<{ default?: boolean }> }> }>;
    };
    expect(posted.embeds[0].color).toBe(0xff0000);
    expect(posted.components[1].components[0]).toMatchObject({ style: 2, label: "Enter (0)" });
    expect(posted.components[0].components[0].options!.some((o) => o.default)).toBe(false);

    expect(await said(component(`dc:${roles}:roles`, { values: [ROLE], type: 3 }))).toBe("Role added");
    expect(calls.find((c) => c.fn === "addRole")!.args).toEqual([GUILD, MEMBER, ROLE]);
    expect(await said(component(`dc:${roles}:roles`, { values: [ROLE], type: 3, roles: [ROLE] }))).toBe("Role removed");
    expect(calls.find((c) => c.fn === "removeRole")!.args).toEqual([GUILD, MEMBER, ROLE]);

    calls.length = 0;
    expect((await (await signed(component(`dc:${roles}:enter`))).json()).type).toBe(6);
    const redraw = await until(async () => calls.find((c) => c.fn === "editMessage"));
    const drawn = redraw.args[2] as typeof posted;
    expect(drawn.components[1].components[0]).toMatchObject({ style: 3, label: "Enter (1)" });
    // The value saved in state is shown as already picked.
    expect(drawn.components[0].components[0].options![1].default).toBe(true);
  });

  it("permission gates: refused without the permission, run with it (or as an administrator)", async () => {
    expect(await said(command("draw"))).toBe("Staff only");
    expect(await said(withMember(command("draw"), { permissions: String(1 << 5) }))).toBe(`Winner: <@${MEMBER}> (1)`);
    expect(await said(withMember(command("draw"), { permissions: String(1 << 3) }))).toBe(`Winner: <@${MEMBER}> (1)`);
  });

  it("context menus, DMs, pins, reactions, private threads, polls and timeouts", async () => {
    await enableBlueprint({
      commands: [
        {
          type: "user",
          name: "Give a cookie",
          steps: [
            { do: "wallet_add", currency: "cookies", amount: 1, userId: "{{target.id}}", saveAs: "c" },
            { do: "dm", userId: "{{target.id}}", content: "{{user.name}} gave you a cookie ({{var.c}})" },
            { do: "reply", ephemeral: true, content: "Sent to {{target.mention}}" },
          ],
        },
        {
          type: "message",
          name: "Pin it",
          steps: [
            { do: "pin_message", messageId: "{{target.id}}" },
            { do: "react", messageId: "{{target.id}}", emoji: "📌" },
            { do: "reply", ephemeral: true, content: "Pinned: {{target.content|truncate:5}}" },
          ],
        },
        {
          name: "ticket",
          description: "Open a ticket",
          steps: [
            { do: "create_thread", name: "ticket-{{user.name|lower}}", private: true, saveAs: "t" },
            { do: "send_message", channelId: "{{sent.t}}", content: "Hi {{user.mention}}" },
            { do: "poll", channelId: "{{sent.t}}", question: "Happy?", answers: [{ text: "Yes" }, { text: "No" }], hours: 1 },
            { do: "reply", ephemeral: true, content: "Opened <#{{sent.t}}>" },
          ],
        },
        {
          name: "mute",
          description: "Mute",
          defaultPermissions: ["moderate_members"],
          options: [{ name: "who", description: "Who", type: "user", required: true }],
          steps: [{ do: "timeout", userId: "{{option.who}}", minutes: 10, reason: "by {{user.name}}" }, { do: "reply", content: "done" }],
        },
      ],
    });

    const userMenu = { ...command("Give a cookie"), data: { name: "Give a cookie", type: 2, target_id: OTHER, resolved: { users: { [OTHER]: { id: OTHER, username: "beto" } } } } };
    expect(await said(userMenu)).toBe(`Sent to <@${OTHER}>`);
    expect(calls.find((c) => c.fn === "openDm")!.args).toEqual([OTHER]);
    expect(calls.find((c) => c.fn === "sendMessage")!.args).toEqual(["555555555555555555", { content: "Ana gave you a cookie (1)" }]);

    const messageMenu = {
      ...command("Pin it"),
      data: { name: "Pin it", type: 3, target_id: TARGET_MESSAGE, resolved: { messages: { [TARGET_MESSAGE]: { id: TARGET_MESSAGE, content: "Hello world", author: { id: OTHER, username: "beto" } } } } },
    };
    expect(await said(messageMenu)).toBe("Pinned: Hell…");
    expect(calls.find((c) => c.fn === "pinMessage")!.args).toEqual([CHANNEL, TARGET_MESSAGE, true]);
    expect(calls.find((c) => c.fn === "react")!.args).toEqual([CHANNEL, TARGET_MESSAGE, "📌"]);

    const opened = await said(command("ticket"));
    const thread = calls.find((c) => c.fn === "createThread")!;
    expect(thread.args[1]).toMatchObject({ name: "ticket-ana", private: true });
    const threadId = String(messageSeq - 2n);
    expect(opened).toBe(`Opened <#${threadId}>`);
    expect(calls.find((c) => c.fn === "addThreadMember")!.args).toEqual([threadId, MEMBER]);
    const poll = calls.filter((c) => c.fn === "sendMessage")[1].args as [string, { poll: { question: { text: string }; duration: number } }];
    expect(poll[0]).toBe(threadId);
    expect(poll[1].poll).toMatchObject({ question: { text: "Happy?" }, duration: 1 });

    await said(command("mute", { who: OTHER }));
    const timeout = calls.find((c) => c.fn === "editMember")!.args as [string, string, { communicationDisabledUntil: string }, string];
    expect(timeout[1]).toBe(OTHER);
    expect(Date.parse(timeout[2].communicationDisabledUntil) - (Date.now() + clockOffsetMs)).toBeGreaterThan(9 * 60_000);
    expect(timeout[3]).toBe("by Ana");

    const synced = (await (await request("staff", "GET", `/guilds/${GUILD}/commands`)).json()).docs as Array<{ name: string; type: number; description: string; default_member_permissions?: string }>;
    expect(synced.find((c) => c.name === "Give a cookie")).toMatchObject({ type: 2, description: "" });
    expect(synced.find((c) => c.name === "Pin it")).toMatchObject({ type: 3 });
    expect(synced.find((c) => c.name === "mute")!.default_member_permissions).toBe(String(1n << 40n));
  });

  it("a modal opens only when its condition holds, prefilled from state", async () => {
    await enableBlueprint({
      commands: [
        {
          name: "bio",
          description: "Your bio",
          options: [{ name: "edit", description: "Edit", type: "boolean" }],
          steps: [
            { do: "open_modal", modal: "bio", if: { left: "{{option.edit}}", op: "eq", right: "true" } },
            { do: "reply", ephemeral: true, content: "Bio: {{kv.bio:$user|default:none}}" },
          ],
        },
      ],
      modals: [
        {
          id: "bio",
          title: "Your bio",
          inputs: [{ id: "text", label: "Bio", value: "{{kv.bio:$user}}" }],
          steps: [{ do: "kv_set", key: "bio:{{user.id}}", value: "{{input.text}}" }, { do: "reply", ephemeral: true, content: "Saved" }],
        },
      ],
    });
    expect(await said(command("bio"))).toBe("Bio: none");
    const first = await (await signed(command("bio", { edit: true }))).json();
    expect(first.type).toBe(9);
    expect(first.data.components[0].components[0].value).toBeUndefined();
    expect(await said(modalSubmit(first.data.custom_id, { text: "I main Ahri" }))).toBe("Saved");
    expect(await said(command("bio"))).toBe("Bio: I main Ahri");
    const again = await (await signed(command("bio", { edit: true }))).json();
    expect(again.data.components[0].components[0].value).toBe("I main Ahri");
  });
});

describe("kon-dc: schedules", () => {
  it("`later` runs its steps when due, with the values of then", async () => {
    await enableBlueprint({
      commands: [
        {
          name: "remind",
          description: "Remind me",
          options: [{ name: "what", description: "What", type: "string", required: true }],
          steps: [{ do: "later", minutes: 5, steps: [{ do: "dm", content: "Reminder: {{option.what}}" }] }, { do: "reply", ephemeral: true, content: "ok" }],
        },
      ],
    });
    expect(await said(command("remind", { what: "stretch" }))).toBe("ok");
    calls.length = 0;
    expect(await engine.tick()).toBe(0);
    clockOffsetMs += 6 * 60_000;
    expect(await engine.tick()).toBe(1);
    await engine.idle();
    expect(calls.find((c) => c.fn === "openDm")!.args).toEqual([MEMBER]);
    expect(calls.find((c) => c.fn === "sendMessage")!.args[1]).toEqual({ content: "Reminder: stretch" });
    // Ran once: it is gone.
    expect(await engine.tick()).toBe(0);
  });

  it("a schedule trigger runs every period, and stops with its module", async () => {
    const moduleId = await enableBlueprint({
      triggers: [{ on: "schedule", schedule: { everyMinutes: 60 }, steps: [{ do: "send_message", channelId: CHANNEL, content: "Hourly at {{now.unix|time:t}}" }] }],
    });
    calls.length = 0;
    expect(await engine.tick()).toBe(0);
    clockOffsetMs += 61 * 60_000;
    expect(await engine.tick()).toBe(1);
    await engine.idle();
    expect((calls.find((c) => c.fn === "sendMessage")!.args[1] as { content: string }).content).toMatch(/^Hourly at <t:\d+:t>$/);
    clockOffsetMs += 61 * 60_000;
    expect(await engine.tick()).toBe(1);
    await engine.idle();

    await request("staff", "PUT", `/guilds/${GUILD}/modules/${moduleId}`, { enabled: false });
    clockOffsetMs += 61 * 60_000;
    expect(await engine.tick()).toBe(0);
  });

  it("times of day follow the time zone and its daylight saving", async () => {
    const { nextRun } = await import("../../kons/kon-dc/dc.engine");
    // 2026-11-15 is a Sunday; Lima is UTC-5 all year.
    expect(nextRun({ at: "09:00", timezone: "America/Lima" }, new Date("2026-11-15T13:00:00Z")).toISOString()).toBe("2026-11-15T14:00:00.000Z");
    expect(nextRun({ at: "09:00", days: ["mon"], timezone: "America/Lima" }, new Date("2026-11-15T13:00:00Z")).toISOString()).toBe("2026-11-16T14:00:00.000Z");
    // Madrid moves to summer time on 2026-03-29: 09:00 is 07:00 UTC that day.
    expect(nextRun({ at: "09:00", timezone: "Europe/Madrid" }, new Date("2026-03-28T12:00:00Z")).toISOString()).toBe("2026-03-29T07:00:00.000Z");
    expect(nextRun({ everyMinutes: 30, timezone: "UTC" }, new Date("2026-01-01T00:00:00Z")).toISOString()).toBe("2026-01-01T00:30:00.000Z");
  });
});

describe("kon-dc: templates are data, never code", () => {
  it("filters, arithmetic and conditions", async () => {
    const { render, evaluate, holds } = await import("../../kons/kon-dc/dc.modules");
    const scope = { "user.name": "ana maría", n: 1234.567, list: ["a", "b"], one: 1, empty: "", __proto__: { x: 1 } };
    expect(render("{{user.name|title}} {{n|number}} {{n|round:1}} {{list|join:/}} {{list|length}}", scope)).toBe("Ana María 1,234.57 1234.6 a/b 2");
    expect(render("{{empty|default:anon}} {{one}} {{one|plural:coin,coins}} {{n|pad:6}}", scope)).toBe("anon 1 coin 1234.567");
    expect(render("{{n|bar:2000}} {{nope|unknown}}|", scope)).toBe("▰▰▰▰▰▰▱▱▱▱ |");
    expect(evaluate("2^3*2 + (10 % 4) - min(3, 1)")).toBe(17);
    expect(() => evaluate("process.exit()")).toThrow();
    expect(() => evaluate("1/0")).toThrow();
    expect(() => evaluate("constructor")).toThrow();
    expect(holds({ left: "B", op: "in", right: '["a","b"]' }, {})).toBe(true);
    expect(holds({ left: "{{one}}", op: "lte", right: "1" }, scope)).toBe(true);
    expect(holds({ left: "abc", op: "starts_with", right: "AB" }, {})).toBe(true);
  });
});

// ── Ready-made modules (a second server, so their commands never clash with the blueprints above) ──

const GUILD2 = "121212121212121212";
const g2 = <T extends Record<string, unknown>>(body: T) => ({ ...body, guild_id: GUILD2 });
const STAFF_PERMS = String((1n << 5n) | (1n << 40n) | (1n << 13n) | (1n << 34n) | (1n << 28n));
const asStaff = <T extends { member: Record<string, unknown> }>(body: T) => ({ ...body, member: { ...body.member, permissions: STAFF_PERMS } });

async function enable(moduleId: string, config: Record<string, unknown> = {}) {
  const r = await request("staff", "PUT", `/guilds/${GUILD2}/modules/${moduleId}`, { enabled: true, config });
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
}

async function gatewayEvent(t: string, d: Record<string, unknown>) {
  const r = await request(WORKER, "POST", "/gateway/events", { contract: 1, events: [{ t, s: 9, shard: [0, 1], receivedAt: new Date().toISOString(), d: { guild_id: GUILD2, ...d } }] });
  expect(r.status).toBe(202);
}

describe("kon-dc: ready-made modules", () => {
  beforeAll(async () => {
    expect((await request("staff", "PUT", `/guilds/${GUILD2}`, { name: "Second server" })).status).toBe(200);
  });

  it("economy: daily streaks, a shop that sells a role through a select, one per member, /pay", async () => {
    await enable("economy", {
      shop: [{ id: "vip", name: "VIP", price: 150, roleId: ROLE, oncePerMember: true, description: "A shiny role" }],
    });
    expect(await said(g2(command("daily")))).toBe("+🪙 **100** You have 🪙 100.");
    expect(await said(g2(command("daily")))).toMatch(/^You already collected today\. Come back <t:\d+:R>\.$/);
    clockOffsetMs += 86_400_000;
    expect(await said(g2(command("daily")))).toBe("+🪙 **110** 🔥 2-day streak! You have 🪙 210.");

    calls.length = 0;
    const shop = await (await signed(g2(command("shop")))).json();
    const shopReply = shop.type === 4 ? shop.data : ((await until(async () => calls.find((c) => c.fn === "editOriginal"))).args[1] as Record<string, unknown>);
    const select = (shopReply.components as Array<{ components: Array<{ custom_id: string; options: Array<{ value: string }> }> }>)[0].components[0];
    expect(select.custom_id).toBe("dc:economy:buy");
    expect(select.options.map((o) => o.value)).toEqual(["vip"]);

    const buyIt = g2(component("dc:economy:buy", { values: ["vip"], type: 3 }));
    expect(await said(buyIt)).toBe("You bought **VIP** for 🪙 150. 🪙 60 left.");
    expect(calls.find((c) => c.fn === "addRole")!.args).toEqual([GUILD2, MEMBER, ROLE]);
    expect(await said(buyIt)).toBe("You already have **VIP**.");

    expect(await said(g2(command("pay", { member: OTHER, amount: 10 })))).toBe(`Ana paid <@${OTHER}> 🪙 **10**.`);
    expect(await said(g2(command("balance", { member: OTHER })))).toBe(`<@${OTHER}> has 🪙 **10** coins (#2 in the server).`);
    expect(await said(g2(command("economy", {})))).toBe("Only the staff (Manage Server) can do that.");
  });

  it("levels: XP from chatting, a reward role and coins at a new level, an announcement", async () => {
    await enable("leveling", { xpPerMessage: 100, cooldownSeconds: 0, rewards: [{ level: 1, roleId: ROLE_B }], coinsPerLevel: 5, announceChannelId: CHANNEL });
    calls.length = 0;
    await gatewayEvent("MESSAGE_CREATE", { channel_id: CHANNEL, id: "830000000000000001", author: { id: OTHER, username: "beto" }, member: { roles: [] } });
    const announced = await until(async () => calls.find((c) => c.fn === "sendMessage"));
    expect(announced.args).toEqual([CHANNEL, `<@${OTHER}> reached **level 1**! 🎉`]);
    expect(calls.find((c) => c.fn === "addRole")!.args).toEqual([GUILD2, OTHER, ROLE_B]);
    expect(await said(g2(command("balance", { member: OTHER })))).toBe(`<@${OTHER}> has 🪙 **15** coins (#2 in the server).`);
    expect(emitted.some((e) => e.event === "dc:level:up")).toBe(true);
  });

  it("giveaways: enter with a button (the count updates), the timer draws a winner and pays coins", async () => {
    await enable("giveaways");
    expect(await said(g2(command("giveaway", {})))).toBe("Only the staff (Manage Server) and giveaway hosts can run giveaways.");
    const start = asStaff(g2({ ...command("giveaway"), data: { name: "giveaway", options: [{ type: 1, name: "start", options: [
      { name: "prize", value: "A mousepad" },
      { name: "minutes", value: 10 },
      { name: "coins", value: 50 },
    ] }] } }));
    expect(await said(start)).toMatch(/^Giveaway `[a-z0-9]{8}` started; it ends <t:\d+:R>\.$/);
    const card = calls.find((c) => c.fn === "sendMessage")!.args[1] as { components: Array<{ components: Array<{ custom_id: string; label: string }> }> };
    const enter = card.components[0].components[0];
    expect(enter.label).toBe("Enter (0)");

    expect(await said(g2(component(enter.custom_id)))).toBe("You are in! 🎉 Good luck.");
    const redrawn = calls.find((c) => c.fn === "editMessage")!.args[2] as typeof card;
    expect(redrawn.components[0].components[0].label).toBe("Enter (1)");

    calls.length = 0;
    clockOffsetMs += 11 * 60_000;
    expect(await engine.tick()).toBe(1);
    await engine.idle();
    const won = calls.filter((c) => c.fn === "sendMessage").map((c) => c.args[1]);
    expect(won).toContain(`🎉 <@${MEMBER}> won **A mousepad**!`);
    expect(emitted.find((e) => e.event === "dc:giveaway:ended")!.data).toMatchObject({ winners: [MEMBER] });
    // 50 left after the shop and /pay, + 50 for winning.
    expect(await said(g2(command("balance")))).toBe(`<@${MEMBER}> has 🪙 **100** coins (#1 in the server).`);
  });

  it("role menus: one panel per menu; picking one of a one-of menu swaps the roles", async () => {
    await enable("role-menus", {
      menus: [{ id: "games", title: "Games", mode: "one", roles: [{ roleId: ROLE, label: "A" }, { roleId: ROLE_B, label: "B", emoji: "🎮" }] }],
    });
    const mods = (await (await request("staff", "GET", `/guilds/${GUILD2}/modules`)).json()).docs as Array<{ id: string; panels: string[] }>;
    expect(mods.find((m) => m.id === "role-menus")!.panels).toEqual(["games"]);
    // The admin route POST /guilds/:id/panels does the same (not run here: PGlite has one connection).
    const post = asStaff(g2({ ...command("rolemenu"), data: { name: "rolemenu", options: [{ type: 1, name: "post", options: [{ name: "menu", value: "games" }] }] } }));
    expect(await said(post)).toBe("Posted **Games**.");
    const panel = calls.find((c) => c.fn === "sendMessage")!.args[1] as { components: Array<{ components: Array<{ custom_id: string }> }> };
    expect(panel.components[0].components.map((c) => c.custom_id)).toEqual(["dc:role-menus:b-games-0", "dc:role-menus:b-games-1"]);
    expect(await said(g2(component("dc:role-menus:b-games-1", { roles: [ROLE] })))).toBe(`Added <@&${ROLE_B}> · Removed <@&${ROLE}>`);
  });

  it("moderation: warnings with an automatic timeout, permission checks, purge", async () => {
    await enable("moderation", { escalation: [{ warnings: 2, action: "timeout", minutes: 30 }], logChannelId: CHANNEL });
    expect(await said(g2(command("warn", { member: OTHER, reason: "spam" })))).toBe("You do not have the permission for that.");
    expect(await said(asStaff(g2(command("warn", { member: OTHER, reason: "spam" }))))).toBe(`Case #1: <@${OTHER}> warned (1 so far).`);
    expect(calls.some((c) => c.fn === "openDm")).toBe(true);
    expect(await said(asStaff(g2(command("warn", { member: OTHER, reason: "again" }))))).toBe(
      `Case #2: <@${OTHER}> warned (2 so far). They reached 2 warnings: timeout 30 min.`
    );
    expect((calls.find((c) => c.fn === "editMember")!.args as [string, string])[1]).toBe(OTHER);
    expect(await said(asStaff(g2(command("purge", { count: 2 }))))).toBe("Deleted 2 messages.");
    expect((calls.find((c) => c.fn === "bulkDelete")!.args[1] as string[]).length).toBe(2);
  });

  it("automod: Discord's own rules are written from the settings", async () => {
    calls.length = 0;
    await enable("automod", { bannedWords: ["badword"], blockInvites: true, mentionLimit: 5, blockSpam: false, alertChannelId: CHANNEL });
    const created = await until(async () => {
      const c = calls.filter((x) => x.fn === "createAutoModRule");
      return c.length === 2 ? c : null;
    });
    const rules = created.map((c) => c.args[1] as { name: string; trigger_type: number; trigger_metadata: Record<string, unknown>; actions: Array<{ type: number }> });
    expect(rules.map((r) => r.name)).toEqual(["kitsuden: words and links", "kitsuden: mention spam"]);
    expect(rules[0].trigger_metadata.keyword_filter).toEqual(["badword"]);
    expect((rules[0].trigger_metadata.regex_patterns as string[])[0]).toContain("discord");
    expect(rules[0].actions.map((a) => a.type)).toEqual([1, 2]);
  });

  it("tickets: a private thread per member, closed by them with a button", async () => {
    await enable("tickets", { logChannelId: CHANNEL });
    expect(await said(asStaff(g2(command("tickets"))))).toBe("Ticket panel posted.");
    expect((calls.find((c) => c.fn === "sendMessage")!.args[1] as { components: Array<{ components: Array<{ custom_id: string }> }> }).components[0].components[0].custom_id).toBe("dc:tickets:open");
    const opened = await said(g2(component("dc:tickets:open")));
    const thread = calls.find((c) => c.fn === "createThread")!;
    expect(thread.args[1]).toMatchObject({ private: true });
    const threadId = opened.match(/<#(\d+)>/)![1];
    expect(calls.find((c) => c.fn === "addThreadMember")!.args).toEqual([threadId, MEMBER]);
    expect(await said(g2(component("dc:tickets:open")))).toBe("You already have an open ticket.");

    calls.length = 0;
    const close = { ...g2(component("dc:tickets:close")), channel_id: threadId };
    expect((await (await signed(close)).json()).type).toBe(6);
    const archived = await until(async () => calls.find((c) => c.fn === "setThreadState"));
    expect(archived.args).toEqual([threadId, { archived: true, locked: true }]);
  });

  it("welcome says goodbye, logs note who left, reminders arrive by DM", async () => {
    await enable("welcome", { channelId: CHANNEL, leaveChannelId: CHANNEL });
    await enable("logs", { channelId: "232323232323232323" });
    await enable("reminders");
    calls.length = 0;
    await gatewayEvent("GUILD_MEMBER_REMOVE", { user: { id: OTHER, username: "beto" } });
    const sent = await until(async () => {
      const s = calls.filter((c) => c.fn === "sendMessage");
      return s.length >= 2 ? s : null;
    });
    expect(sent.map((c) => c.args[1])).toContainEqual("beto left the server.");
    expect(sent.find((c) => c.args[0] === "232323232323232323")!.args[1]).toMatchObject({ embeds: [{ title: "Left" }] });
    expect(emitted.some((e) => e.event === "dc:member:left")).toBe(true);

    expect(await said(g2(command("remind", { what: "drink water", minutes: 1 })))).toMatch(/^I will remind you <t:\d+:R>\.$/);
    calls.length = 0;
    clockOffsetMs += 2 * 60_000;
    expect(await engine.tick()).toBe(1);
    await engine.idle();
    expect(calls.find((c) => c.fn === "sendMessage")!.args).toEqual(["555555555555555555", `⏰ <@${MEMBER}> drink water`]);
  });
});

describe("kon-dc: reward templates", () => {
  const GUILD3 = "131313131313131313";
  const g3 = <T extends Record<string, unknown>>(body: T) => ({ ...body, guild_id: GUILD3 });

  async function install(id: string, options: Record<string, unknown>) {
    const r = await request("staff", "POST", `/templates/${id}/install`, { options });
    expect(r.status).toBe(201);
    const row = await r.json();
    expect((await request("staff", "PATCH", `/blueprints/${row.id}`, { status: "published" })).status).toBe(200);
    const moduleId = `blueprint-${row.id}`;
    expect((await request("staff", "PUT", `/guilds/${GUILD3}/modules/${moduleId}`, { enabled: true })).status).toBe(200);
    return moduleId;
  }

  beforeAll(async () => {
    expect((await request("staff", "PUT", `/guilds/${GUILD3}`, { name: "Third server" })).status).toBe(200);
    await request("staff", "PUT", `/guilds/${GUILD3}/modules/economy`, { enabled: true, config: {} });
  });

  it("are listed with the others", async () => {
    const list = (await (await request("staff", "GET", "/templates")).json()).docs as Array<{ id: string }>;
    expect(list.map((t) => t.id)).toEqual(["broadcast-booth", "feedback-form", "loot-box", "quiz"]);
  });

  it("loot box: refuses without coins, then drops a gem into the inventory", async () => {
    await install("loot-box", { price: 50, commonWeight: 0, rareWeight: 0, legendaryWeight: 1 });
    expect(await said(g3(command("lootbox")))).toBe("A loot box costs 🪙 50. Try /daily or /work.");
    await said(g3(command("daily")));
    calls.length = 0;
    const r = await (await signed(g3(command("lootbox")))).json();
    const reply = r.type === 4 ? r.data : ((await until(async () => calls.find((c) => c.fn === "editOriginal"))).args[1] as Record<string, unknown>);
    const embed = (reply.embeds as Array<{ description: string; color: number }>)[0];
    expect(embed.description).toBe("You got a **Legendary gem**: you have 1 gem of that kind.");
    expect(embed.color).toBe(0xf1c40f);
    const gems = await sqlAs<{ item: string; quantity: number }>(client, "staff", `SELECT item, quantity FROM dc_inventory WHERE guild_id = $1 AND user_id = $2`, [GUILD3, MEMBER]);
    expect(gems).toEqual([{ item: "gem-legendary", quantity: 1 }]);
  });

  it("quiz: a wrong answer, then the first right one wins coins and XP; later ones are too late", async () => {
    const moduleId = await install("quiz", { xp: 25 });
    const ask = asStaff(g3({ ...command("quiz"), data: { name: "quiz", options: [{ type: 1, name: "ask", options: [
      { name: "question", value: "Capital of Peru?" },
      { name: "answer", value: "Lima" },
      { name: "prize", value: 30 },
    ] }] } }));
    expect(await said(ask)).toBe("Asked.");
    const card = calls.find((c) => c.fn === "sendMessage")!.args[1] as { embeds: Array<{ title: string; description: string }> };
    expect(card.embeds[0]).toMatchObject({ title: "❓ Capital of Peru?", description: "First right answer wins 🪙 30 and 25 XP" });

    const answer = (guess: string, user = MEMBER) => g3({ ...modalSubmit(`dc:${moduleId}:answer`, { guess }), member: { user: { id: user, username: user === MEMBER ? "ana" : "beto" }, roles: [] } });
    expect(await said(answer("Cusco"))).toBe("Not quite. Try again!");
    expect(await said(answer("  lima "))).toBe("Correct!");
    const won = calls.find((c) => c.fn === "sendMessage" && typeof (c.args[1] as { content?: string }).content === "string")!;
    expect((won.args[1] as { content: string }).content).toBe(`🎉 <@${MEMBER}> got it: **lima** (+🪙 30)`);
    expect(await said(answer("Lima", OTHER))).toBe("Too late, someone got it first!");
    const xp = await sqlAs<{ balance: number }>(client, "staff", `SELECT balance FROM dc_wallets WHERE guild_id = $1 AND currency = 'xp' AND user_id = $2`, [GUILD3, MEMBER]);
    expect(Number(xp[0].balance)).toBe(25);
  });
});

describe("kon-dc: the block editor's catalog and describe-your-bot", () => {
  it("every step has a category, a valid example and a form schema with no unions", async () => {
    const { BlueprintStep } = await import("../../kons/kon-dc/dc.contract");
    const docs = (await (await request("anon", "GET", "/blueprints/steps")).json()).docs as Array<{
      do: string;
      category: string;
      example: unknown;
      formSchema: unknown;
      jsonFields: string[];
      numberFields: string[];
    }>;
    const union = (BlueprintStep as unknown as { options: unknown[] }).options.length;
    expect(docs).toHaveLength(union);
    for (const d of docs) {
      expect(BlueprintStep.safeParse(d.example).success, d.do).toBe(true);
      expect(JSON.stringify(d.formSchema), d.do).not.toMatch(/anyOf|oneOf|\$ref/);
    }
    const later = docs.find((d) => d.do === "later")!;
    expect(later.jsonFields).toEqual(["steps"]);
    expect(later.numberFields).toEqual(["minutes"]);
    expect(docs.find((d) => d.do === "wallet_add")!.category).toBe("Rewards");
  });

  it("describe a bot: the agent's answer is checked, and fixed once with the problems", async () => {
    expect((await request("a", "POST", "/blueprints/generate", { prompt: "A daily coins command", agentId: "writer" })).status).toBe(403);
    const r = await request("staff", "POST", "/blueprints/generate", { prompt: "A daily coins command", agentId: "writer" });
    expect(r.status).toBe(200);
    const out = await r.json();
    expect(out.attempts).toBe(2);
    expect(out.problems).toEqual([]);
    expect(out.definition.commands[0].name).toBe("daily-coins");
    const runs = calls.filter((c) => c.fn === "agents.run").map((c) => c.args[0] as { allowedTools: string[]; message: string; context: string });
    expect(runs.every((x) => x.allowedTools.length === 0)).toBe(true);
    expect(runs[1].message).toContain("commands.0");
    expect(runs[0].context).toContain("wallet_add");
  });
});

describe("kon-dc: image cards", () => {
  beforeAll(() => {
    cardsOn = true;
  });
  afterAll(() => {
    cardsOn = false;
  });

  it("/rank and /balance answer with a PNG card (deferred: files go as an edit)", async () => {
    drawn.length = 0;
    calls.length = 0;
    const r = await (await signed(g2(command("rank")))).json();
    expect(r).toEqual({ type: 5, data: { flags: 64 } });
    const edit = await until(async () => calls.find((c) => c.fn === "editOriginal"));
    const body = edit.args[1] as { content: string; files: Array<{ name: string; contentType: string }> };
    expect(body.content).toMatch(/^Level \d+ · [\d,]+ XP$/);
    expect(body.files.map((f) => [f.name, f.contentType])).toEqual([["rank.png", "image/png"]]);
    expect(drawn[0]).toContain(">Ana<");
    expect(drawn[0]).toContain("LEVEL");

    calls.length = 0;
    await signed(g2(command("balance")));
    const wallet = await until(async () => calls.find((c) => c.fn === "editOriginal"));
    expect((wallet.args[1] as { files: Array<{ name: string }> }).files[0].name).toBe("wallet.png");
  });

  it("a blueprint card step: the next message carries it, its embed shows it; with no renderer the image is dropped", async () => {
    await enableBlueprint({
      commands: [
        {
          name: "topcard",
          description: "Top card",
          steps: [
            { do: "card", kind: "leaderboard", currency: "coins", title: "Richest <b>&</b>", accent: "#ff0000" },
            { do: "reply", embeds: [{ title: "Top", image: "attachment://card.png" }] },
          ],
        },
      ],
    });
    drawn.length = 0;
    calls.length = 0;
    await signed(command("topcard"));
    const edit = await until(async () => calls.find((c) => c.fn === "editOriginal"));
    const body = edit.args[1] as { embeds: Array<{ image?: { url: string } }>; files: Array<{ name: string }> };
    expect(body.files[0].name).toBe("card.png");
    expect(body.embeds[0].image).toEqual({ url: "attachment://card.png" });
    // Text is escaped, colours are checked.
    expect(drawn[0]).toContain("Richest &lt;b&gt;&amp;&lt;/b&gt;");
    expect(drawn[0]).toContain("#ff0000");

    cardsOn = false;
    calls.length = 0;
    const plain = await (await signed(command("topcard"))).json();
    const plainBody = plain.type === 4 ? plain.data : ((await until(async () => calls.find((c) => c.fn === "editOriginal"))).args[1] as typeof body);
    expect(plainBody.embeds[0].image).toBeUndefined();
    expect(plainBody.files).toBeUndefined();
    cardsOn = true;
  });

  it("the real renderer: sharp turns a card into a PNG, and files go as multipart", async () => {
    const { rankSvg, avatarUrl, hex } = await import("../../kons/kon-dc/dc.cards");
    const { encodeBody } = await import("../../kons/kon-dc/dc.rest");
    expect(hex("red", "#000000")).toBe("#000000");
    expect(avatarUrl({ id: MEMBER, name: "a", avatar: "0123456789abcdef0123456789abcdef" })).toBe(`https://cdn.discordapp.com/avatars/${MEMBER}/0123456789abcdef0123456789abcdef.png?size=128`);
    const svg = rankSvg({ user: { id: MEMBER, name: "Ana" }, level: 3, current: 120, needed: 700, totalXp: 1020, rank: 1 }, null);
    const { createRequire } = await import("node:module");
    const sharp = createRequire(`${process.cwd()}/.kitsuden/apps/api/package.json`)("sharp") as (b: Buffer) => { png(): { toBuffer(): Promise<Buffer> } };
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const form = encodeBody({ content: "hi", files: [{ name: "rank.png", data: new Uint8Array(png), contentType: "image/png" }] }) as FormData;
    expect(JSON.parse(String(form.get("payload_json")))).toEqual({ content: "hi", attachments: [{ id: 0, filename: "rank.png" }] });
    expect((form.get("files[0]") as File).name).toBe("rank.png");
    expect(encodeBody({ content: "x", files: [] })).toBe('{"content":"x"}');
  });
});

describe("kon-dc: profiles and the global economy", () => {
  it("credits and reputation are the same in every server; the daily has a streak", async () => {
    for (const g of [GUILD, GUILD2]) {
      expect((await request("staff", "PUT", `/guilds/${g}/modules/profile`, { enabled: true, config: {} })).status).toBe(200);
    }
    const sub = (name: string, sub: string, options: Record<string, unknown> = {}, guild = GUILD2) => ({
      ...command(name),
      guild_id: guild,
      data: { name, options: [{ type: 1, name: sub, options: Object.entries(options).map(([n, value]) => ({ name: n, value })) }] },
    });
    expect(await said(sub("credits", "daily"))).toBe("+**200** credits. You have 200 in every server.");
    expect(await said(sub("credits", "daily", {}, GUILD))).toMatch(/^You already collected today/);
    clockOffsetMs += 86_400_000;
    expect(await said(sub("credits", "daily", {}, GUILD))).toBe("+**220** credits · 2-day streak. You have 420 in every server.");
    expect(await said(sub("credits", "balance", {}, GUILD2))).toBe(`<@${MEMBER}> has **420** credits (#1 across the bot).`);

    expect(await said(sub("profile", "bio", { text: "Main Ahri <3" }))).toBe("Bio saved.");
    expect(await said(sub("profile", "color", { hex: "red" }))).toBe("Write the colour as #rrggbb, e.g. #5865f2.");
    expect(await said(sub("profile", "color", { hex: "#FF8800" }))).toBe("Colour saved: #ff8800.");

    expect(await said(g2(command("rep", { member: OTHER })))).toBe(`Ana gave <@${OTHER}> a reputation point (+1).`);
    expect(await said(command("rep", { member: OTHER }))).toMatch(/^You can give reputation again <t:\d+:R>\.$/);
    expect(await said(command("rep", { member: MEMBER }))).toBe("Give reputation to someone else.");
  });

  it("the profile card draws the bio, the colour and global levels; Levels gives global XP", async () => {
    cardsOn = true;
    drawn.length = 0;
    try {
      calls.length = 0;
      await signed({ ...command("profile"), guild_id: GUILD2, data: { name: "profile", options: [{ type: 1, name: "view", options: [] }] } });
      const edit = await until(async () => calls.find((c) => c.fn === "editOriginal"));
      expect((edit.args[1] as { files: Array<{ name: string }> }).files[0].name).toBe("profile.png");
      expect(drawn[0]).toContain("Main Ahri &lt;3");
      expect(drawn[0]).toContain("#ff8800");
      expect(drawn[0]).toContain(">420<");
    } finally {
      cardsOn = false;
    }
    // XP from chatting in a server is also global XP.
    const rows = await sqlAs<{ balance: number }>(client, "staff", `SELECT balance FROM dc_global_wallets WHERE currency = 'xp' AND user_id = $1`, [OTHER]);
    expect(Number(rows[0]?.balance ?? 0)).toBeGreaterThan(0);
  });
});

describe("kon-dc: the item catalog", () => {
  const items = (sub: string, options: Record<string, unknown> = {}, member: Record<string, unknown> | null = null) => {
    const body = { ...command("items"), guild_id: GUILD2, data: { name: "items", options: [{ type: 1, name: sub, options: Object.entries(options).map(([n, value]) => ({ name: n, value })) }] } };
    return member ? { ...body, member } : body;
  };
  const put = async (item: Record<string, unknown>) => {
    const r = await request("staff", "PUT", "/items", item);
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    return r.json();
  };

  it("buy with stock, use (blueprints hear it), a global badge on the profile, gift, trade, sell", async () => {
    await put({ guildId: GUILD2, item: "potion", name: "Potion", emoji: "🧪", kind: "consumable", price: 10, sellPrice: 5, stock: 2 });
    await put({ guildId: GUILD2, item: "sword", name: "Sword", price: 20, rarity: "rare" });
    await put({ guildId: null, item: "early-bird", name: "Early bird", kind: "badge", price: 100, color: "#ff8800" });
    expect((await request("a", "PUT", "/items", { guildId: null, item: "x", name: "X" })).status).toBe(403);
    expect((await (await request("staff", "GET", "/items?guildId=global")).json()).docs.map((i: { item: string }) => i.item)).toEqual(["early-bird"]);

    expect((await request("staff", "PUT", `/guilds/${GUILD2}/modules/items`, { enabled: true, config: {} })).status).toBe(200);
    await enableBlueprintIn(GUILD2, {
      triggers: [{ on: "item_used", match: { item: "potion" }, steps: [{ do: "send_message", channelId: CHANNEL, content: "{{user.mention}} drank a {{item}}" }] }],
      commands: [{ name: "loot", description: "Loot", steps: [{ do: "item_random", kind: "consumable", saveAs: "drop" }, { do: "reply", content: "{{var.drop_name}} ({{var.drop_rarity}})" }] }],
    });

    expect(await said(items("buy", { item: "potion" }))).toMatch(/^You bought 🧪 Potion for 10 coins \(you have 1\)\./);
    expect(await said(items("buy", { item: "potion" }))).toMatch(/you have 2/);
    expect(await said(items("buy", { item: "potion" }))).toBe("**Potion** is sold out.");

    calls.length = 0;
    expect(await said(items("use", { item: "potion" }))).toBe("You used 🧪 Potion.");
    await engine.idle();
    expect(calls.find((c) => c.fn === "sendMessage")!.args).toEqual([CHANNEL, { content: `<@${MEMBER}> drank a potion` }]);

    // A global item is paid in credits and goes on the profile.
    expect(await said(items("buy", { item: "early-bird" }))).toMatch(/for 100 credits/);
    expect(await said(items("equip", { item: "sword" }))).toBe("Only badges and backgrounds go on the profile.");
    expect(await said(items("equip", { item: "early-bird" }))).toBe("Early bird is on your profile.");

    await said(items("buy", { item: "sword" }));
    expect(await said(items("gift", { member: OTHER, item: "sword" }))).toBe(`You gave <@${OTHER}> 1 × Sword.`);

    calls.length = 0;
    const offer = await (await signed(items("trade", { member: OTHER, give: "potion", want: "sword" }))).json();
    const offerBody = offer.type === 4 ? offer.data : ((await until(async () => calls.find((c) => c.fn === "editOriginal"))).args[1] as Record<string, unknown>);
    const accept = (offerBody.components as Array<{ components: Array<{ custom_id: string }> }>)[0].components[0].custom_id;
    expect(await said(g2(component(accept)))).toBe(`Only <@${OTHER}> can answer this trade.`);
    const asOther = { ...g2(component(accept)), member: { user: { id: OTHER, username: "beto" }, roles: [] } };
    calls.length = 0;
    const done = await (await signed(asOther)).json();
    const doneBody = done.type === 7 ? done.data : ((await until(async () => calls.filter((c) => c.fn === "editOriginal").at(-1))).args[1] as Record<string, unknown>);
    expect((doneBody.embeds as Array<{ title: string }>)[0].title).toBe("Trade done");
    const inv = await sqlAs<{ user_id: string; item: string; quantity: number }>(client, "staff", `SELECT user_id, item, quantity FROM dc_inventory WHERE guild_id = $1 AND quantity > 0 ORDER BY user_id, item`, [GUILD2]);
    expect(inv.map((r) => `${r.user_id === MEMBER ? "ana" : "beto"}:${r.item}:${r.quantity}`)).toEqual(expect.arrayContaining(["ana:sword:1", "beto:potion:1"]));

    expect(await said(items("sell", { item: "sword" }))).toBe("Nobody buys that here.");
    expect(await said({ ...items("sell", { item: "potion" }), member: { user: { id: OTHER, username: "beto" }, roles: [] } })).toMatch(/^You sold 1 × 🧪 Potion for 5 coins/);

    expect(await said(g2(command("loot")))).toBe("Potion (common)");
  });
});

describe("kon-dc: voice", () => {
  const VC = "141414141414141414";
  const HUB = "151515151515151515";
  const voice = (user: string, channel: string | null, extra: Record<string, unknown> = {}) =>
    gatewayEvent("VOICE_STATE_UPDATE", { user_id: user, channel_id: channel, member: { user: { id: user, username: user === MEMBER ? "ana" : "beto" }, roles: [] }, ...extra });
  const xpOf = async (user: string) =>
    Number((await sqlAs<{ balance: number }>(client, "staff", `SELECT balance FROM dc_wallets WHERE guild_id = $1 AND currency = 'xp' AND user_id = $2`, [GUILD2, user]))[0]?.balance ?? 0);
  const settle = async () => {
    await engine.idle();
    await new Promise((r) => setTimeout(r, 30));
    await engine.idle();
  };

  it("voice XP: paid by the minute when leaving, only with company and unmuted; the gateway asks for voice", async () => {
    await request("staff", "PUT", `/guilds/${GUILD2}/modules/leveling`, { enabled: true, config: { xpPerMessage: 100, cooldownSeconds: 0, voiceXpPerMinute: 5 } });
    const cfg = await (await request(WORKER, "GET", "/gateway/config")).json();
    expect(cfg.events).toContain("VOICE_STATE_UPDATE");
    expect(cfg.intents & INTENTS.GUILD_VOICE_STATES).toBeTruthy();

    await voice(MEMBER, VC);
    await settle();
    await voice(OTHER, VC);
    await settle();
    const before = await xpOf(MEMBER);
    clockOffsetMs += 10 * 60_000;
    await voice(MEMBER, null);
    await settle();
    expect((await xpOf(MEMBER)) - before).toBe(50);

    // Alone now: the 10-minute payout gives Beto nothing.
    const otherBefore = await xpOf(OTHER);
    clockOffsetMs += 11 * 60_000;
    await engine.tick();
    clockOffsetMs += 11 * 60_000;
    await engine.tick();
    await settle();
    expect(await xpOf(OTHER)).toBe(otherBefore);
    await voice(OTHER, null);
    await settle();
  });

  it("temporary rooms: the hub makes one, moves the member, deletes it when empty", async () => {
    expect((await request("staff", "PUT", `/guilds/${GUILD2}/modules/temp-voice`, { enabled: true, config: { hubChannelId: HUB } })).status).toBe(200);
    calls.length = 0;
    await voice(MEMBER, HUB);
    const made = await until(async () => calls.find((c) => c.fn === "createChannel"));
    expect(made.args[1]).toMatchObject({ name: "ana's room", type: 2 });
    const room = String(messageSeq);
    expect((await until(async () => calls.find((c) => c.fn === "moveMember"))).args).toEqual([GUILD2, MEMBER, room]);
    await settle();
    await voice(MEMBER, room);
    await settle();

    expect(await said(g2({ ...command("voice"), data: { name: "voice", options: [{ type: 1, name: "lock", options: [] }] } }))).toBe("Locked: nobody else may join.");
    expect(calls.find((c) => c.fn === "setChannelPermission")!.args).toEqual([room, GUILD2, 0, "0", String(1n << 20n)]);

    calls.length = 0;
    await voice(MEMBER, null);
    expect((await until(async () => calls.find((c) => c.fn === "deleteChannel"))).args).toEqual([room]);
  });

  it("blueprint voice triggers know the channel and the minutes", async () => {
    await enableBlueprintIn(GUILD2, {
      triggers: [
        { on: "voice_join", match: { channelId: VC }, steps: [{ do: "send_message", channelId: CHANNEL, content: "{{user.mention}} joined <#{{voice.channel}}>" }] },
        { on: "voice_leave", steps: [{ do: "send_message", channelId: CHANNEL, content: "left after {{voice.minutes}} min" }] },
      ],
    });
    calls.length = 0;
    await voice(OTHER, VC);
    const joined = await until(async () => calls.find((c) => c.fn === "sendMessage" && (c.args[1] as { content: string }).content.includes("joined")));
    expect((joined.args[1] as { content: string }).content).toBe(`<@${OTHER}> joined <#${VC}>`);
    await settle();
    clockOffsetMs += 3 * 60_000;
    await voice(OTHER, null);
    const left = await until(async () => calls.find((c) => c.fn === "sendMessage" && (c.args[1] as { content: string }).content.startsWith("left")));
    expect((left.args[1] as { content: string }).content).toBe("left after 3 min");
  });
});

describe("kon-dc: activity by period", () => {
  const say = (user: string, n: number) =>
    gatewayEvent("MESSAGE_CREATE", { channel_id: CHANNEL, id: String(860000000000000000n + BigInt(n)), author: { id: user, username: user === MEMBER ? "ana" : "beto" }, member: { roles: [] } });
  const settle = async () => {
    await engine.idle();
    await new Promise((r) => setTimeout(r, 30));
    await engine.idle();
  };

  it("counts messages per day; /stats and /top read the period; the weekly post pays and moves the champion role", async () => {
    expect((await request("staff", "PUT", `/guilds/${GUILD2}/modules/stats`, { enabled: true, config: { weeklyChannelId: CHANNEL, prizes: [100], championRoleId: ROLE_B } })).status).toBe(200);
    await engine.tick();
    // A week later (the weekly post is due), this week's messages:
    clockOffsetMs += 8 * 86_400_000;
    await say(MEMBER, 1);
    await say(MEMBER, 2);
    await say(OTHER, 3);
    await settle();

    expect(await said(g2(command("stats", { period: "day" })))).toContain(`<@${MEMBER}>, today: **2** messages (#1)`);
    calls.length = 0;
    const top = await (await signed(g2(command("top", { by: "messages", period: "week" })))).json();
    const topBody = top.type === 4 ? top.data : ((await until(async () => calls.find((c) => c.fn === "editOriginal"))).args[1] as { embeds: Array<{ description: string }> });
    expect(topBody.embeds[0].description.split("\n")[0]).toBe(`**1.** <@${MEMBER}> — 2 messages`);

    const coins = async () => Number((await sqlAs<{ balance: number }>(client, "staff", `SELECT balance FROM dc_wallets WHERE guild_id = $1 AND currency = 'coins' AND user_id = $2`, [GUILD2, MEMBER]))[0]?.balance ?? 0);
    const before = await coins();
    calls.length = 0;
    expect(await engine.tick()).toBeGreaterThanOrEqual(1);
    await settle();
    const post = calls.find((c) => c.fn === "sendMessage" && String((c.args[1] as { content?: string }).content).startsWith("🏆"));
    expect((post!.args[1] as { content: string }).content).toBe(`🏆 <@${MEMBER}> was the most active this week!\nPrizes: <@${MEMBER}> +100`);
    expect(await coins()).toBe(before + 100);
    expect(calls.find((c) => c.fn === "addRole")!.args).toEqual([GUILD2, MEMBER, ROLE_B]);
  });
});

describe("kon-dc: feeds", () => {
  const RSS = "https://blog.example.test/rss";
  const rss = (items: Array<[string, string]>) =>
    `<?xml version="1.0"?><rss><channel><title>Blog</title>${items.map(([id, title]) => `<item><guid>${id}</guid><title><![CDATA[${title}]]></title><link>https://blog.example.test/${id}</link></item>`).join("")}</channel></rss>`;
  const settle = async () => {
    await engine.idle();
    await new Promise((r) => setTimeout(r, 30));
    await engine.idle();
  };
  const poll = async () => {
    clockOffsetMs += 11 * 60_000;
    calls.length = 0;
    await engine.tick();
    await settle();
    return calls.filter((c) => c.fn === "sendMessage").map((c) => c.args[1]);
  };

  it("posts only what is new (the first poll remembers), and a stream once when it goes live", async () => {
    feedDocs.set(RSS, rss([["a1", "Old post"]]));
    expect(
      (
        await request("staff", "PUT", `/guilds/${GUILD2}/modules/feeds`, {
          enabled: true,
          config: {
            feeds: [
              { id: "blog", kind: "rss", source: RSS, channelId: CHANNEL },
              { id: "live", kind: "twitch", source: "SomeStreamer", channelId: CHANNEL },
            ],
          },
        })
      ).status
    ).toBe(200);
    expect((await request("staff", "PUT", `/guilds/${GUILD2}/modules/feeds`, { enabled: true, config: { feeds: [{ id: "x", kind: "youtube", source: "nope", channelId: CHANNEL }] } })).status).toBe(422);
    await engine.tick();
    expect(await poll()).toEqual([]);

    feedDocs.set(RSS, rss([["a2", "New & shiny"], ["a1", "Old post"]]));
    liveNow.push({ login: "somestreamer", name: "SomeStreamer", title: "Ranked grind", game: "2XKO", startedAt: "2026-11-16T10:00:00Z", thumbnail: "https://static-cdn.jtvnw.net/x.jpg" });
    const posted = await poll();
    expect(posted).toContainEqual("📰 **New & shiny**\nhttps://blog.example.test/a2");
    const stream = posted.find((p) => typeof p === "object") as { content: string };
    expect(stream.content).toBe("🔴 **SomeStreamer** is live: Ranked grind (2XKO)\nhttps://twitch.tv/somestreamer");
    expect(await poll()).toEqual([]);
  });

  it("feeds never reach private addresses; RSS and Atom both parse", async () => {
    const { checkUrl, privateAddress, parseFeed } = await import("../../kons/kon-dc/dc.http");
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
      expect(privateAddress(ip), ip).toBe(true);
    }
    expect(privateAddress("8.8.8.8")).toBe(false);
    await expect(checkUrl("http://example.com/rss")).rejects.toThrow(/https/);
    await expect(checkUrl("https://127.0.0.1/rss")).rejects.toThrow(/not reachable/);
    await expect(checkUrl("https://[::1]/rss")).rejects.toThrow(/not reachable/);
    await expect(checkUrl("https://user:pw@example.com/")).rejects.toThrow(/credentials/);
    const atom = parseFeed(`<feed><entry><id>yt:video:abc</id><title>Video &amp; more</title><link rel="alternate" href="https://youtu.be/abc"/><author><name>Chan</name></author><media:thumbnail url="https://i.ytimg.com/a.jpg"/></entry></feed>`);
    expect(atom).toEqual([{ id: "yt:video:abc", title: "Video & more", link: "https://youtu.be/abc", author: "Chan", published: "", image: "https://i.ytimg.com/a.jpg" }]);
  });
});

describe("kon-dc: security", () => {
  const G4 = "161616161616161616";
  const QR = "171717171717171717";
  const VR = "181818181818181818";
  const g4 = <T extends Record<string, unknown>>(body: T) => ({ ...body, guild_id: G4 });
  const event = async (t: string, d: Record<string, unknown>) => {
    const r = await request(WORKER, "POST", "/gateway/events", { contract: 1, events: [{ t, s: 9, shard: [0, 1], receivedAt: new Date().toISOString(), d: { guild_id: G4, ...d } }] });
    expect(r.status).toBe(202);
    await engine.idle();
  };
  const audit = (executor: string, action: number, target = "191919191919191919") => event("GUILD_AUDIT_LOG_ENTRY_CREATE", { user_id: executor, action_type: action, target_id: target });
  /** An account id created `days` days ago (a snowflake carries its time). */
  const accountId = (days: number) => String(BigInt(Date.now() + clockOffsetMs - days * 86_400_000 - 1420070400000) << 22n);

  beforeAll(async () => {
    expect((await request("staff", "PUT", `/guilds/${G4}`, { name: "Fourth server" })).status).toBe(200);
    const r = await request("staff", "PUT", `/guilds/${G4}/modules/security`, {
      enabled: true,
      config: { alertChannelId: CHANNEL, quarantineRoleId: QR, limitChannelDelete: 2, minAccountDays: 30, verifiedRoleId: VR },
    });
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
  });

  it("anti-nuke: past the limit the executor loses their roles and is quarantined; the bot and the owner never are", async () => {
    memberRoles.set(OTHER, [ROLE]);
    calls.length = 0;
    await audit(OTHER, 12);
    await audit(OTHER, 12);
    expect(calls.some((c) => c.fn === "removeRole")).toBe(false);
    await audit(OTHER, 12);
    expect(calls.find((c) => c.fn === "removeRole")!.args).toEqual([G4, OTHER, ROLE]);
    expect(calls.find((c) => c.fn === "addRole")!.args).toEqual([G4, OTHER, QR]);
    const alert = calls.find((c) => c.fn === "sendMessage")!.args[1] as { embeds: Array<{ title: string }> };
    expect(alert.embeds[0].title).toBe("🛡️ Nuke attempt stopped");

    calls.length = 0;
    for (const who of [settings.applicationId!, "199999999999999999"]) for (let i = 0; i < 4; i++) await audit(who, 12);
    expect(calls.some((c) => c.fn === "removeRole" || c.fn === "kick" || c.fn === "ban")).toBe(false);
  });

  it("join gate: new accounts and unverified bots are removed; old accounts pass", async () => {
    calls.length = 0;
    const fresh = accountId(2);
    await event("GUILD_MEMBER_ADD", { user: { id: fresh, username: "fresh", avatar: null } });
    expect(calls.find((c) => c.fn === "kick")!.args.slice(0, 2)).toEqual([G4, fresh]);
    calls.length = 0;
    await event("GUILD_MEMBER_ADD", { user: { id: accountId(400), username: "veteran", avatar: "0123456789abcdef0123456789abcdef" } });
    expect(calls.some((c) => c.fn === "kick")).toBe(false);
    const bot = accountId(400);
    await event("GUILD_MEMBER_ADD", { user: { id: bot, username: "spam-bot", bot: true, public_flags: 0 } });
    expect(calls.find((c) => c.fn === "kick")!.args.slice(0, 2)).toEqual([G4, bot]);
  });

  it("captcha: a code, a form, the verified role", async () => {
    const shown = await said(g4(component("dc:security:verify")));
    const code = shown.match(/\|\|(.+?)\|\|/)![1].replace(/​/g, "");
    expect(code).toMatch(/^[A-Z0-9]{5}$/);
    const modal = await (await signed(g4(component("dc:security:code")))).json();
    expect(modal.type).toBe(9);
    expect(await said(g4(modalSubmit(modal.data.custom_id, { code: "WRONG" })))).toBe("That is not the code: press Verify for a new one.");
    // A wrong answer burns the code: a new one.
    const second = await said(g4(component("dc:security:verify")));
    const code2 = second.match(/\|\|(.+?)\|\|/)![1].replace(/​/g, "");
    calls.length = 0;
    expect(await said(g4(modalSubmit(modal.data.custom_id, { code: code2.toLowerCase() })))).toBe("Verified. Welcome!");
    expect(calls.find((c) => c.fn === "addRole")!.args).toEqual([G4, MEMBER, VR]);
  });

  it("lockdown takes the permissions away and puts back exactly what there was", async () => {
    const staff = (sub: string) => ({ ...g4({ ...command("lockdown"), data: { name: "lockdown", options: [{ type: 1, name: sub, options: [] }] } }), member: { user: { id: MEMBER, username: "ana" }, roles: [], permissions: String(1n << 5n) } });
    calls.length = 0;
    expect(await said(staff("on"))).toBe("🔒 The server is locked: only the staff can write or join voice.");
    const locked = calls.find((c) => c.fn === "editRole")!.args as [string, string, { permissions: string }];
    expect(BigInt(locked[2].permissions) & (1n << 11n)).toBe(0n);
    expect(BigInt(locked[2].permissions) & (1n << 10n)).toBe(1n << 10n);
    calls.length = 0;
    expect(await said(staff("off"))).toBe("🔓 The server is open again.");
    expect((calls.find((c) => c.fn === "editRole")!.args as [string, string, { permissions: string }])[2].permissions).toBe(String((1n << 11n) | (1n << 10n) | (1n << 20n)));
  });
});

describe("kon-dc: characters and sticky messages", () => {
  const G4 = "161616161616161616";
  const say = (content: string, id: number) =>
    gatewayEventIn(G4, "MESSAGE_CREATE", { channel_id: CHANNEL, id: String(870000000000000000n + BigInt(id)), content, author: { id: MEMBER, username: "ana" }, member: { roles: [] } });

  it("a message in a character's brackets is reposted by a webhook as the character", async () => {
    expect((await request("staff", "PUT", `/guilds/${G4}/modules/characters`, { enabled: true, config: {} })).status).toBe(200);
    const cmd = (sub: string, options: Record<string, unknown>) => ({
      ...command("character"),
      guild_id: G4,
      data: { name: "character", options: [{ type: 1, name: sub, options: Object.entries(options).map(([n, value]) => ({ name: n, value })) }] },
    });
    expect(await said(cmd("add", { name: "Kitsune", brackets: "nope" }))).toMatch(/^Write the brackets/);
    expect(await said(cmd("add", { name: "Kitsune", brackets: "k:text", avatar: "https://cdn.example.test/k.png" }))).toBe("**Kitsune** is ready: write k:hello.");

    calls.length = 0;
    await say("k: hello there", 1);
    const sent = calls.find((c) => c.fn === "executeWebhook")!;
    expect(sent.args).toEqual(["201010101010101010", "hook-token", { content: "hello there", username: "Kitsune", avatarUrl: "https://cdn.example.test/k.png" }]);
    expect(calls.find((c) => c.fn === "deleteMessage")!.args).toEqual([CHANNEL, "870000000000000001"]);
    calls.length = 0;
    await say("k:again", 2);
    await say("plain words", 3);
    expect(calls.filter((c) => c.fn === "createWebhook")).toHaveLength(0);
    expect(calls.filter((c) => c.fn === "executeWebhook")).toHaveLength(1);
    const counted = await sqlAs<{ messages: number }>(client, "staff", `SELECT messages FROM dc_characters WHERE user_id = $1 AND name = 'Kitsune'`, [MEMBER]);
    expect(Number(counted[0].messages)).toBe(2);
  });

  it("a sticky message goes back to the bottom, at most every N seconds", async () => {
    expect((await request("staff", "PUT", `/guilds/${G4}/modules/sticky`, { enabled: true, config: { messages: [{ channelId: CHANNEL, content: "Read the rules" }] } })).status).toBe(200);
    calls.length = 0;
    await say("first", 4);
    expect(calls.filter((c) => c.fn === "sendMessage").map((c) => c.args[1])).toEqual([{ content: "📌 Read the rules" }]);
    const first = String(messageSeq);
    calls.length = 0;
    await say("second", 5);
    expect(calls.some((c) => c.fn === "sendMessage")).toBe(false);
    clockOffsetMs += 16_000;
    await say("third", 6);
    expect(calls.find((c) => c.fn === "deleteMessage")!.args).toEqual([CHANNEL, first]);
    expect(calls.some((c) => c.fn === "sendMessage")).toBe(true);
  });
});

describe("kon-dc: logs with the message cache", () => {
  const G4 = "161616161616161616";
  const LOG = "202020202020202020";
  const msg = (t: string, id: string, content?: string) =>
    gatewayEventIn(G4, t, { channel_id: CHANNEL, id, ...(content !== undefined ? { content, author: { id: OTHER, username: "beto" } } : {}) });
  const logged = () => calls.filter((c) => c.fn === "sendMessage" && c.args[0] === LOG).map((c) => (c.args[1] as { embeds: Array<Record<string, unknown>> }).embeds[0]);

  it("edits show before and after; a deletion shows what it said; the text goes when it expires", async () => {
    expect((await request("staff", "PUT", `/guilds/${G4}/modules/logs`, { enabled: true, config: { channelId: LOG, keepMessagesHours: 24 } })).status).toBe(200);
    const cfg = await (await request(WORKER, "GET", "/gateway/config")).json();
    expect(cfg.intents & INTENTS.MESSAGE_CONTENT).toBeTruthy();

    calls.length = 0;
    await msg("MESSAGE_CREATE", "880000000000000001", "secret plan");
    await msg("MESSAGE_UPDATE", "880000000000000001", "better plan");
    expect(logged()[0]).toMatchObject({ title: "Message edited", fields: [{ name: "Before", value: "secret plan" }, { name: "After", value: "better plan" }] });
    await msg("MESSAGE_DELETE", "880000000000000001");
    expect(logged()[1]).toMatchObject({ title: "Message deleted", description: `By <@${OTHER}> in <#${CHANNEL}>`, fields: [{ name: "It said", value: "better plan" }] });

    await msg("MESSAGE_CREATE", "880000000000000002", "short-lived");
    clockOffsetMs += 25 * 3_600_000;
    await engine.tick();
    const left = await sqlAs(client, "staff", `SELECT 1 FROM dc_message_cache WHERE message_id = '880000000000000002'`);
    expect(left).toHaveLength(0);
    calls.length = 0;
    await msg("MESSAGE_DELETE", "880000000000000002");
    expect(logged()[0]).toMatchObject({ title: "Message deleted", description: `In <#${CHANNEL}> · id 880000000000000002` });
  });
});

describe("kon-dc: Discord rate limits", () => {
  it("route keys keep the major parameter only", async () => {
    const { rateKey } = await import("../../kons/kon-dc/dc.rest");
    expect(rateKey("POST", "/channels/222222222222222222/messages")).toBe("POST /channels/222222222222222222/messages");
    expect(rateKey("DELETE", "/channels/222222222222222222/messages/800000000000000001")).toBe("DELETE /channels/222222222222222222/messages/:id");
    expect(rateKey("PUT", "/channels/222222222222222222/messages/800000000000000001/reactions/%F0%9F%93%8C/@me")).toBe("PUT /channels/222222222222222222/messages/:id/reactions/:emoji/@me");
    expect(rateKey("PATCH", "/webhooks/999999999999999999/tok-en/messages/@original")).toBe("PATCH /webhooks/999999999999999999/:token/messages/@original");
    expect(rateKey("PUT", "/guilds/111111111111111111/members/444444444444444444/roles/333333333333333333")).toBe("PUT /guilds/111111111111111111/members/:id/roles/:id");
  });

  it("waits for an empty bucket, and obeys a 429 instead of failing", async () => {
    const { createDiscordRest } = await import("../../kons/kon-dc/dc.rest");
    const sent: number[] = [];
    let n = 0;
    const fakeFetch = (async () => {
      n++;
      sent.push(Date.now());
      if (n === 3) {
        return new Response(JSON.stringify({ retry_after: 0.05, global: false }), { status: 429, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: String(n) }), {
        status: 200,
        headers: { "content-type": "application/json", "x-ratelimit-remaining": n === 1 ? "0" : "5", "x-ratelimit-reset-after": "0.08" },
      });
    }) as unknown as typeof fetch;
    const rest = createDiscordRest({ ...settings, apiBase: "http://discord.invalid" }, fakeFetch);
    const channel = "212121212121212121";
    await rest.sendMessage(channel, "one");
    await rest.sendMessage(channel, "two");
    // The bucket was empty after the first: the second waited for its reset.
    expect(sent[1] - sent[0]).toBeGreaterThanOrEqual(70);
    await rest.sendMessage(channel, "three");
    // A 429, then the same call again after retry_after.
    expect(n).toBe(4);
    expect(sent[3] - sent[2]).toBeGreaterThanOrEqual(40);
  });
});

describe("kon-dc: reaction roles, slowmode, birthdays, auto purge", () => {
  const G4 = "161616161616161616";
  const MSG = "890000000000000001";
  const react = (t: string, emoji: string) =>
    gatewayEventIn(G4, t, { user_id: OTHER, channel_id: CHANNEL, message_id: MSG, emoji: { name: emoji }, member: { user: { id: OTHER, username: "beto" }, roles: [] } });

  it("a reaction gives the role and taking it away takes the role", async () => {
    expect((await request("staff", "PUT", `/guilds/${G4}/modules/reaction-roles`, { enabled: true, config: { rules: [{ messageId: MSG, emoji: "⭐", roleId: ROLE }] } })).status).toBe(200);
    calls.length = 0;
    await react("MESSAGE_REACTION_ADD", "⭐");
    expect(calls.find((c) => c.fn === "addRole")!.args).toEqual([G4, OTHER, ROLE]);
    await react("MESSAGE_REACTION_ADD", "🔥");
    expect(calls.filter((c) => c.fn === "addRole")).toHaveLength(1);
    await react("MESSAGE_REACTION_REMOVE", "⭐");
    expect(calls.find((c) => c.fn === "removeRole")!.args).toEqual([G4, OTHER, ROLE]);
  });

  it("/slowmode sets the channel's", async () => {
    expect((await request("staff", "PUT", `/guilds/${G4}/modules/moderation`, { enabled: true, config: {} })).status).toBe(200);
    const body = { ...command("slowmode", { seconds: 30 }), guild_id: G4, member: { user: { id: MEMBER, username: "ana" }, roles: [], permissions: String(1n << 13n) } };
    expect(await said(body)).toBe("Slowmode: one message every 30 s.");
    expect(calls.find((c) => c.fn === "editChannel")!.args).toEqual([CHANNEL, { slowmode: 30 }]);
  });

  it("birthdays: greeted on the day, with a role for 24 hours and coins", async () => {
    expect((await request("staff", "PUT", `/guilds/${G4}/modules/birthdays`, { enabled: true, config: { channelId: CHANNEL, roleId: ROLE_B, coins: 50, at: "00:05" } })).status).toBe(200);
    // The greeting runs at the next 00:05 UTC: the birthday is that day.
    const now = Date.now() + clockOffsetMs;
    const d = new Date(now);
    let next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 5);
    if (next <= now) next += 86_400_000;
    const tomorrow = new Date(next);
    const cmd = { ...command("birthday"), guild_id: G4, data: { name: "birthday", options: [{ type: 1, name: "set", options: [{ name: "day", value: tomorrow.getUTCDate() }, { name: "month", value: tomorrow.getUTCMonth() + 1 }] }] } };
    expect(await said(cmd)).toMatch(/^Saved: /);
    expect(await said({ ...cmd, data: { name: "birthday", options: [{ type: 1, name: "set", options: [{ name: "day", value: 31 }, { name: "month", value: 2 }] }] } })).toBe("That day does not exist.");
    await engine.tick();
    clockOffsetMs += next - now + 60_000;
    calls.length = 0;
    await engine.tick();
    await engine.idle();
    expect(calls.find((c) => c.fn === "sendMessage" && c.args[0] === CHANNEL)!.args[1]).toBe(`🎂 Happy birthday, <@${MEMBER}>!`);
    expect(calls.find((c) => c.fn === "addRole")!.args).toEqual([G4, MEMBER, ROLE_B]);
    clockOffsetMs += 25 * 3_600_000;
    calls.length = 0;
    await engine.tick();
    await engine.idle();
    expect(calls.find((c) => c.fn === "removeRole")!.args).toEqual([G4, MEMBER, ROLE_B]);
  });

  it("auto purge clears a channel on a schedule and keeps pins", async () => {
    expect((await request("staff", "PUT", `/guilds/${G4}/modules/auto-purge`, { enabled: true, config: { purges: [{ id: "clean", channelId: CHANNEL, everyHours: 1 }] } })).status).toBe(200);
    await engine.tick();
    clockOffsetMs += 61 * 60_000;
    calls.length = 0;
    await engine.tick();
    await engine.idle();
    expect(calls.find((c) => c.fn === "bulkDelete")!.args).toEqual([CHANNEL, ["800000000000000001", "800000000000000002"]]);
  });
});

describe("kon-dc: the bot speaks the member's language", () => {
  it("every translation keeps the English placeholders, and a key is never translated twice", async () => {
    const { TEXTS } = await import("../../kons/kon-dc/dc.i18n.texts");
    const holes = (t: string) => [...t.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort().join(",");
    const seen = new Set<string>();
    for (const [en, es, pt] of TEXTS) {
      expect(seen.has(en), `twice: ${en}`).toBe(false);
      seen.add(en);
      expect(holes(es), `es: ${en}`).toBe(holes(en));
      expect(holes(pt), `pt: ${en}`).toBe(holes(en));
    }
  });

  it("answers in Spanish to a Spanish client, and commands carry Discord localizations", async () => {
    const inSpanish = { ...command("daily"), guild_id: GUILD2, locale: "es-419" };
    expect(await said(inSpanish)).toMatch(/^Ya lo cobraste hoy\. Vuelve <t:\d+:R>\.$|^\+🪙/);
    expect(await said({ ...command("nope"), locale: "pt-BR" })).toBe("Este comando não está ativo neste servidor.");
    const cmds = (await (await request("staff", "GET", `/guilds/${GUILD2}/commands`)).json()).docs as Array<{ name: string; description_localizations?: Record<string, string> }>;
    expect(cmds.find((c) => c.name === "rank")!.description_localizations).toEqual({
      "es-ES": "Tu nivel y XP en este servidor",
      "es-419": "Tu nivel y XP en este servidor",
      "pt-BR": "Seu nível e XP neste servidor",
    });
  });
});

describe("kon-dc: the member page", () => {
  const page = (path: string, init: RequestInit = {}) => app.request(path, init);
  const cookieOf = (res: Response, name: string) => {
    const all = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
    const hit = all.find((c) => c.startsWith(`${name}=`));
    return hit ? hit.split(";")[0] : null;
  };

  beforeAll(() => {
    Object.assign(settings, { clientSecret: "client-secret", oauthRedirectUrl: "https://api.example.test/api/dc/member/callback", memberSecret: "a".repeat(40) });
  });
  afterAll(() => {
    Object.assign(settings, { clientSecret: null, oauthRedirectUrl: null, memberSecret: null });
  });

  it("is public only while the server's member-page module is on", async () => {
    expect((await page(`/member/page/${GUILD2}`)).status).toBe(404);
    expect((await page(`/member/guilds/${GUILD2}`)).status).toBe(404);
    expect((await request("staff", "PUT", `/guilds/${GUILD2}/modules/member-page`, { enabled: true, config: { title: "Weekly FGC" } })).status).toBe(200);
    const html = await page(`/member/page/${GUILD2}`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await html.text()).toContain('<script src="/api/dc/member/page.js"');
    expect((await page("/member/page.js")).headers.get("content-type")).toContain("javascript");

    const data = await (await page(`/member/guilds/${GUILD2}`)).json();
    expect(data.page).toMatchObject({ title: "Weekly FGC", canBuy: true });
    expect(data.me).toBeNull();
    expect(data.login).toBe(true);
    expect(Array.isArray(data.leaderboards.coins)).toBe(true);
    expect(data.store.map((i: { item: string }) => i.item)).toContain("sword");
  });

  it("logs in with Discord: a state tied to the browser, then a signed session; buying needs both", async () => {
    const login = await page(`/member/login?guildId=${GUILD2}`);
    expect(login.status).toBe(302);
    const to = new URL(login.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(to.searchParams.get("scope")).toBe("identify");
    const state = to.searchParams.get("state")!;
    const nonce = cookieOf(login, "dc_oauth")!;

    // Another browser (no nonce cookie), or a forged state: refused.
    expect((await page(`/member/callback?code=good-code&state=${encodeURIComponent(state)}`)).status).toBe(400);
    expect((await page(`/member/callback?code=good-code&state=x.y`, { headers: { cookie: nonce } })).status).toBe(400);

    const back = await page(`/member/callback?code=good-code&state=${encodeURIComponent(state)}`, { headers: { cookie: nonce } });
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(`/api/dc/member/page/${GUILD2}`);
    const session = cookieOf(back, "dc_member")!;
    expect(session).toBeTruthy();

    const mine = await (await page(`/member/guilds/${GUILD2}`, { headers: { cookie: session } })).json();
    expect(mine.me).toMatchObject({ id: MEMBER, name: "Ana" });
    // A tampered session is nobody.
    const forged = session.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect((await (await page(`/member/guilds/${GUILD2}`, { headers: { cookie: forged } })).json()).me).toBeNull();

    const buy = (cookie: string | null, type = "application/json") =>
      page(`/member/guilds/${GUILD2}/buy`, { method: "POST", headers: { "content-type": type, ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ item: "sword" }) });
    expect((await buy(null)).status).toBe(401);
    expect((await buy(session, "application/x-www-form-urlencoded")).status).not.toBe(200);
    await said(asStaff(g2({ ...command("economy"), data: { name: "economy", options: [{ type: 1, name: "give", options: [{ name: "member", value: MEMBER }, { name: "amount", value: 100 }] }] } })));
    const bought = await buy(session);
    expect(bought.status).toBe(200);
    expect(await bought.json()).toMatchObject({ ok: true });
  });
});

describe("kon-dc: premium plans", () => {
  const G5 = "242424242424242424";
  beforeAll(async () => {
    Object.assign(settings, { premiumModules: new Set(["giveaways"]), freeBlueprints: 1 });
    expect((await request("staff", "PUT", `/guilds/${G5}`, { name: "Fifth server" })).status).toBe(200);
  });
  afterAll(() => {
    Object.assign(settings, { premiumModules: new Set(), freeBlueprints: null });
  });

  it("a free server cannot switch premium modules on or pass the blueprint limit; premium can, until it ends", async () => {
    const put = (moduleId: string) => request("staff", "PUT", `/guilds/${G5}/modules/${moduleId}`, { enabled: true, config: {} });
    const refused = await put("giveaways");
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await refused.json())).toMatch(/premium module/);

    const bp = async () => {
      const r = await request("staff", "POST", "/blueprints", { name: `p-${Math.random()}`, status: "published", definition: { commands: [{ name: `c${Math.floor(Math.random() * 1e6)}`, description: "x", steps: [{ do: "reply", content: "x" }] }] } });
      return `blueprint-${(await r.json()).id}`;
    };
    const first = await bp();
    const second = await bp();
    expect((await put(first)).status).toBe(200);
    expect((await put(second)).status).toBe(409);

    expect((await request("a", "PUT", `/guilds/${G5}/plan`, { plan: "premium" })).status).toBe(403);
    const until = new Date(Date.now() + clockOffsetMs + 86_400_000).toISOString();
    const plan = await request("staff", "PUT", `/guilds/${G5}/plan`, { plan: "premium", until, source: "order-42" });
    expect(await plan.json()).toMatchObject({ plan: "premium", active: true, premiumModules: ["giveaways"], freeBlueprints: 1 });
    expect((await put("giveaways")).status).toBe(200);
    expect((await put(second)).status).toBe(200);
    expect(emitted.some((e) => e.event === "dc:plan:changed")).toBe(true);

    const giveaway = { ...command("giveaway"), guild_id: G5, data: { name: "giveaway", options: [{ type: 1, name: "end", options: [{ name: "id", value: "x" }] }] } };
    expect(await said(giveaway)).toBe("Only the staff (Manage Server) and giveaway hosts can run giveaways.");
    // The plan ends: the premium module stops by itself, its settings stay.
    clockOffsetMs += 2 * 86_400_000;
    engine.forget(G5);
    expect(await said(giveaway)).toBe("This command is not active on this server.");
    expect((await (await request("staff", "GET", `/guilds/${G5}/plan`)).json()).active).toBe(false);
  });
});

describe("kon-dc: what the admin view manages", () => {
  const G6 = "262626262626262626";
  const A = "600000000000000001";
  const B = "600000000000000002";
  beforeAll(async () => {
    expect((await request("staff", "PUT", `/guilds/${G6}`, { name: "Sixth server" })).status).toBe(200);
  });

  it("gives, takes and sets balances; ranks a currency; only the team", async () => {
    expect((await request("a", "PUT", `/guilds/${G6}/economy/${A}`, { currency: "coins", add: 5 })).status).toBe(403);
    expect((await request("staff", "PUT", `/guilds/${G6}/economy/${A}`, { currency: "coins", add: 5, set: 1 })).status).toBe(422);
    const give = await request("staff", "PUT", `/guilds/${G6}/economy/${A}`, { currency: "coins", add: 500, reason: "event prize" });
    expect(await give.json()).toEqual({ userId: A, currency: "coins", balance: 500 });
    expect(emitted.some((e) => e.event === "dc:economy:adjusted")).toBe(true);
    const take = await request("staff", "PUT", `/guilds/${G6}/economy/${A}`, { currency: "coins", add: -800 });
    expect((await take.json()).balance).toBe(0);
    await request("staff", "PUT", `/guilds/${G6}/economy/${A}`, { currency: "coins", set: 120 });
    await request("staff", "PUT", `/guilds/${G6}/economy/${B}`, { currency: "coins", set: 300 });
    await request("staff", "PUT", `/guilds/${G6}/economy/${B}`, { currency: "xp", set: 42 });

    const ranking = await (await request("staff", "GET", `/guilds/${G6}/economy`)).json();
    expect(ranking).toMatchObject({ currency: "coins", total: 420, docs: [{ userId: B, value: 300 }, { userId: A, value: 120 }] });
    expect(ranking.currencies).toEqual([
      { currency: "coins", members: 2, total: 420 },
      { currency: "xp", members: 1, total: 42 },
    ]);
    const xp = await (await request("staff", "GET", `/guilds/${G6}/economy?currency=xp`)).json();
    expect(xp.docs).toEqual([{ userId: B, name: null, value: 42 }]);
    expect((await request("staff", "GET", `/guilds/999999999999999999/economy`)).status).toBe(404);

    const member = await (await request("staff", "GET", `/guilds/${G6}/members/${B}`)).json();
    expect(member.balances).toEqual([
      { currency: "coins", balance: 300 },
      { currency: "xp", balance: 42 },
    ]);
    expect(member.activity.days).toHaveLength(30);
  });

  it("activity per day with every day present, and the overview across servers", async () => {
    const today = Math.floor((Date.now() + clockOffsetMs) / 86_400_000);
    await sqlAs(
      client,
      "staff",
      `INSERT INTO dc_activity (guild_id, user_id, day, messages, voice_minutes) VALUES
        ('${G6}', '${A}', ${today}, 7, 30), ('${G6}', '${B}', ${today}, 3, 0), ('${G6}', '${A}', ${today - 2}, 1, 0), ('${G6}', '${B}', ${today - 40}, 99, 0)`
    );
    const act = await (await request("staff", "GET", `/guilds/${G6}/activity?days=7`)).json();
    expect(act.days).toHaveLength(7);
    expect(act.days.at(-1)).toMatchObject({ messages: 10, voiceMinutes: 30 });
    expect(act.days.at(-3)).toMatchObject({ messages: 1 });
    expect(act.totals).toEqual({ messages: 11, voiceMinutes: 30, members: 2 });
    expect(act.topMessages.map((r: { userId: string }) => r.userId)).toEqual([A, B]);
    expect(act.topVoice).toEqual([{ userId: A, name: null, value: 30 }]);

    const overview = await (await request("staff", "GET", "/overview")).json();
    expect(overview.days).toHaveLength(30);
    expect(overview.totals.guilds).toBeGreaterThanOrEqual(1);
    expect(overview.totals.members).toBeGreaterThanOrEqual(2);
    expect(overview.topGuilds.some((g: { guildId: string; messages: number }) => g.guildId === G6 && g.messages === 11)).toBe(true);
    expect((await request("a", "GET", "/overview")).status).toBe(403);
  });

  it("lists queued work and cancels it", async () => {
    const at = new Date(Date.now() + clockOffsetMs + 3_600_000).toISOString();
    await sqlAs(
      client,
      "staff",
      `INSERT INTO dc_schedules (guild_id, module_id, key, run_at, payload) VALUES ('${G6}', 'reminders', 'r-1', '${at}', '{"text":"stand-up"}')`
    );
    const list = await (await request("staff", "GET", `/guilds/${G6}/schedules`)).json();
    expect(list.docs).toHaveLength(1);
    expect(list.docs[0]).toMatchObject({ moduleId: "reminders", key: "r-1", recurring: false, payload: { text: "stand-up" } });
    expect((await request("a", "DELETE", `/guilds/${G6}/schedules/${list.docs[0].id}`)).status).toBe(403);
    expect((await request("staff", "DELETE", `/guilds/${G6}/schedules/not-a-uuid`)).status).toBe(404);
    expect((await request("staff", "DELETE", `/guilds/${G6}/schedules/${list.docs[0].id}`)).status).toBe(200);
    expect((await (await request("staff", "GET", `/guilds/${G6}/schedules`)).json()).docs).toEqual([]);
  });
});

/**
 * kon-dc's extension API (dc.extensions.ts): what an extension (the Enterprise edition, or anyone's)
 * can add or decide, and that kon-dc without one behaves as before.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";

import type { PGlite } from "@electric-sql/pglite";
import { AppError } from "@kitsuden/engine";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { registerDcExtension } from "../../kons/kon-dc";
import { dcExtensions, registryId, type DcExtension } from "../../kons/kon-dc/dc.extensions";
import { defineDcModule, registeredModule } from "../../kons/kon-dc/dc.modules";
import { registerDcPolicy } from "../../kons/kon-dc/dc.policy";
import type { DiscordRest, DiscordSettings } from "../../kons/kon-dc/dc.rest";
import type { DcEngine } from "../../kons/kon-dc/dc.engine";
import { createDcRouter } from "../../kons/kon-dc/dc.routes";

import { dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

const GUILD = "131313131313131313";
const CHANNEL = "222222222222222222";
const MEMBER = "444444444444444444";
const WORKER = { agent: ["kon:dc:gateway-config", "kon:dc:ingest-gateway-events"] };

const hexKey = (k: ReturnType<typeof generateKeyPairSync>["publicKey"]) =>
  Buffer.from(k.export({ format: "der", type: "spki" })).subarray(-32).toString("hex");
const keys = generateKeyPairSync("ed25519");
const brandedKeys = generateKeyPairSync("ed25519");

const settings: DiscordSettings & Record<string, unknown> = {
  applicationId: "999999999999999999",
  publicKey: hexKey(keys.publicKey),
  botToken: "installation-token",
  disabledModules: new Set(),
  apiBase: "http://discord.invalid",
};

/** Every REST call, with the token of the client that made it. */
const calls: Array<{ fn: string; token: string | undefined; args: unknown[] }> = [];
const restFor = (s: DiscordSettings) =>
  new Proxy({} as DiscordRest, {
    get(_t, fn: string) {
      return async (...args: unknown[]) => {
        calls.push({ fn, token: s.botToken, args });
        if (fn === "sendMessage") return { id: "900000000000000001" };
        if (fn === "syncGuildCommands") return [];
        return undefined;
      };
    },
  });

const coreCalls: string[] = [];
const agents = {
  run: async (o: { agentId: string; message: string }) => {
    coreCalls.push(o.message);
    return { response: `core: ${o.message}`, sessionId: "s", traceId: "t", provider: "test", model: "test", tokensIn: 1, tokensOut: 1, toolCalls: [] };
  },
};

const bus = new EventEmitter();
const events = { emit: (e: string, d: unknown) => void bus.emit(e, d), on: (e: string, h: (d: unknown) => void) => void bus.on(e, h) };

let client: PGlite;
let engine: DcEngine;
let request: ReturnType<typeof requestAs>;
let app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> };
const removers: Array<() => void> = [];

function use(extension: DcExtension) {
  removers.push(registerDcExtension(extension));
}

function signedWith(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], body: unknown) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return app.request("/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": sign(null, Buffer.from(ts + raw), privateKey).toString("hex"),
      "x-signature-timestamp": ts,
    },
    body: raw,
  });
}

const ask = (question: string) => ({
  type: 2,
  id: "1",
  token: "interaction-token",
  guild_id: GUILD,
  channel_id: CHANNEL,
  member: { user: { id: MEMBER, username: "ana", global_name: "Ana" } },
  data: { name: "ask", options: [{ name: "question", value: question }] },
});

/** The member's answer: the direct reply or the edited "thinking…". */
async function answerOf(res: Response): Promise<string> {
  const r = await res.json();
  if (r.type === 4) return r.data.content;
  await engine.idle();
  const edit = [...calls].reverse().find((c) => c.fn === "editOriginal" || c.fn === "followup");
  const payload = edit?.args[1];
  return typeof payload === "string" ? payload : ((payload as { content?: string } | undefined)?.content ?? "");
}

beforeAll(async () => {
  client = await migratedBase("kon-dc", [
    "0000_initial.sql",
    "0001_rewards_and_schedules.sql",
    "0002_global_profiles.sql",
    "0003_item_catalog.sql",
    "0004_voice.sql",
    "0005_activity.sql",
    "0006_characters.sql",
    "0007_message_cache.sql",
    "0008_guild_locale.sql",
    "0009_guild_plans.sql",
  ]);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never, agents: agents as never, events: events as never });
  const mounted = host.mount(
    createDcRouter(ctx, {
      settings: () => settings,
      rest: restFor,
      directAnswerMs: 100,
      panelDebounceMs: 20,
      scheduleTickMs: 0,
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
  expect((await request("staff", "PUT", `/guilds/${GUILD}`, { name: "Extension server" })).status).toBe(200);
  expect((await request("staff", "PUT", `/guilds/${GUILD}/modules/ai`, { enabled: true, config: { agentId: "helper", cooldownSeconds: 0 } })).status).toBe(200);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerDcPolicy();
  calls.length = 0;
  coreCalls.length = 0;
});

afterEach(() => {
  while (removers.length) removers.pop()!();
  engine.forget(GUILD);
});

describe("kon-dc extensions", () => {
  it("with none registered, AI answers come from the core's agents", async () => {
    expect(dcExtensions()).toHaveLength(0);
    expect(await answerOf(await signedWith(keys.privateKey, ask("hi")))).toBe("core: hi");
    expect(coreCalls).toEqual(["hi"]);
  });

  it("the registry is one per process, whatever copy of kon-dc reaches it", () => {
    const again = (globalThis as unknown as Record<symbol, { id: string }>)[Symbol.for("kitsuden.kon-dc.extensions.v1")];
    expect(again.id).toBe(registryId());
  });

  it("an extension answers with its own AI, or refuses, and is told the usage", async () => {
    const usage: Array<{ purpose: string; guildId: string | null; ok: boolean; outputChars: number }> = [];
    let refuse = false;
    use({
      name: "credits",
      ai: (req) => (refuse ? "No AI credits left this month." : { run: async (o) => ({ response: `own key (${req.purpose}): ${o.message}` }) }),
      afterAi: (u) => void usage.push({ purpose: u.purpose, guildId: u.guildId, ok: u.ok, outputChars: u.outputChars }),
    });
    expect(await answerOf(await signedWith(keys.privateKey, ask("hello")))).toBe("own key (ask): hello");
    expect(coreCalls).toEqual([]);
    expect(usage).toEqual([{ purpose: "ask", guildId: GUILD, ok: true, outputChars: "own key (ask): hello".length }]);

    refuse = true;
    expect(await answerOf(await signedWith(keys.privateKey, ask("again")))).toBe("No AI credits left this month.");
    expect(coreCalls).toEqual([]);
  });

  it("the builder in the admin goes through the same hook: a refusal is a 409", async () => {
    use({ name: "credits", ai: () => "Start a trial to build more bots today." });
    const r = await request("staff", "POST", "/blueprints/generate", { prompt: "A bot that greets people", agentId: "helper" });
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).toMatch(/Start a trial/);
  });

  it("a branded bot: its key signs interactions, and its token answers in its server", async () => {
    // Before: the branded bot's key is unknown.
    expect((await signedWith(brandedKeys.privateKey, ask("x"))).status).toBe(401);
    use({
      name: "branded",
      botFor: (guildId) => (guildId === GUILD ? { botToken: "branded-token" } : null),
      publicKeys: () => [hexKey(brandedKeys.publicKey)],
    });
    engine.forget(GUILD);
    const res = await signedWith(brandedKeys.privateKey, ask("brand"));
    expect(res.status).toBe(200);
    expect(await answerOf(res)).toBe("core: brand");
    // Calls to Discord for that server go out with the branded bot's token, not the installation's.
    calls.length = 0;
    expect((await request("staff", "POST", `/guilds/${GUILD}/commands/sync`)).status).toBe(200);
    expect(calls.map((c) => [c.fn, c.token])).toEqual([["syncGuildCommands", "branded-token"]]);
  });

  it("an event an extension drops never reaches the modules", async () => {
    expect((await request("staff", "PUT", `/guilds/${GUILD}/modules/welcome`, { enabled: true, config: { channelId: CHANNEL } })).status).toBe(200);
    const join = (id: string) =>
      request(WORKER, "POST", "/gateway/events", {
        contract: 1,
        events: [{ t: "GUILD_MEMBER_ADD", s: 9, shard: [0, 1], receivedAt: new Date().toISOString(), d: { guild_id: GUILD, user: { id, username: "x" }, roles: [] } }],
      });
    const quarantined = "555555555555555555";
    use({ name: "security", onEvent: (e) => (e.type === "GUILD_MEMBER_ADD" && e.user?.id === quarantined ? "drop" : undefined) });
    expect((await join(quarantined)).status).toBe(202);
    await engine.idle();
    expect(calls.filter((c) => c.fn === "sendMessage")).toHaveLength(0);
    expect((await join("666666666666666666")).status).toBe(202);
    await engine.idle();
    expect(calls.filter((c) => c.fn === "sendMessage")).toHaveLength(1);

    // A hook that throws lets the event through.
    calls.length = 0;
    use({
      name: "security",
      onEvent: () => {
        throw new Error("boom");
      },
    });
    await join("777777777777777777");
    await engine.idle();
    expect(calls.filter((c) => c.fn === "sendMessage")).toHaveLength(1);
    await request("staff", "PUT", `/guilds/${GUILD}/modules/welcome`, { enabled: false, config: { channelId: CHANNEL } });
  });

  it("the team's changes are reported with who made them; reads and Discord's calls are not", async () => {
    const seen: Array<{ kind: string; guildId: string | null; actor: string }> = [];
    use({ name: "audit", onStaffAction: (a) => void seen.push({ kind: a.kind, guildId: a.guildId, actor: a.actor.kind }) });
    await request("staff", "PUT", `/guilds/${GUILD}/economy/${MEMBER}`, { currency: "coins", set: 10 });
    await request("staff", "GET", `/guilds/${GUILD}/economy`);
    await signedWith(keys.privateKey, ask("not staff"));
    await engine.idle();
    expect(seen).toEqual([{ kind: "set-member-balance", guildId: GUILD, actor: "user" }]);
  });

  it("templates from an extension are listed and install like the built-in ones", async () => {
    use({
      name: "market",
      templates: () => [
        {
          id: "market-hello",
          name: "Hello pack",
          description: "Says hello.",
          needs: { kons: [], scopes: [] },
          options: z.object({}),
          build: () => ({ commands: [{ name: "hello", description: "Hello", steps: [{ do: "reply", content: "Hello!" }] }] }),
        } as never,
      ],
    });
    const list = await (await request("staff", "GET", "/templates")).json();
    expect(list.docs.some((t: { id: string }) => t.id === "market-hello")).toBe(true);
    const installed = await request("staff", "POST", "/templates/market-hello/install", { options: {} });
    expect(installed.status, JSON.stringify(await installed.clone().json())).toBe(201);
  });

  it("modules from an extension join the list; a billing extension decides who is premium", async () => {
    use({
      name: "ee",
      modules: [
        defineDcModule({
          id: "ee-sample",
          name: "EE sample",
          description: "A module an extension adds.",
          config: z.object({}).strict(),
          intents: 0,
          events: [],
        }),
      ],
    });
    expect(registeredModule("ee-sample")).toBeTruthy();
    const modules = await (await request("staff", "GET", "/modules")).json();
    expect(modules.docs.some((m: { id: string }) => m.id === "ee-sample")).toBe(true);

    let premium: boolean | null = true;
    use({ name: "billing", isPremium: () => premium });
    expect((await (await request("staff", "GET", `/guilds/${GUILD}/plan`)).json()).active).toBe(true);
    premium = null;
    engine.forget(GUILD);
    expect((await (await request("staff", "GET", `/guilds/${GUILD}/plan`)).json()).active).toBe(false);
  });

  it("an extension gets kon-dc's host: it registers a server, switches a module on and syncs", async () => {
    let host: import("../../kons/kon-dc/dc.extensions").DcHost | null = null;
    use({ name: "onboarding", attach: (h) => void (host = h) });
    expect(host).not.toBeNull();
    const NEW = "141414141414141414";
    await host!.registerGuild(NEW, "Installed by onboarding");
    expect((await (await request("staff", "GET", "/guilds")).json()).docs.some((g: { id: string }) => g.id === NEW)).toBe(true);
    expect(await host!.setModule(NEW, "polls", true)).toEqual({ ok: true });
    expect(await host!.setModule(NEW, "welcome", true, {})).toMatchObject({ error: expect.stringMatching(/Invalid settings/) });
    expect(await host!.setModule(NEW, "nope", true)).toMatchObject({ error: expect.stringMatching(/does not exist/) });
    const mods = await (await request("staff", "GET", `/guilds/${NEW}/modules`)).json();
    expect(mods.docs.find((m: { id: string }) => m.id === "polls").enabled).toBe(true);
    calls.length = 0;
    expect(await host!.syncCommands(NEW)).toBeGreaterThan(0);
    expect(calls.map((c) => c.fn)).toEqual(["syncGuildCommands"]);
    expect((await host!.moduleIds()).includes("leveling")).toBe(true);
  });
});

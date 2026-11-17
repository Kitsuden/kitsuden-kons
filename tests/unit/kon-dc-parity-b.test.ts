/**
 * kon-dc — community modules that MEE6, Dyno, Carl-bot and Arcane offer, and moving levels from them:
 * the invite tracker, sticky roles, temporary roles, voice roles, ticket transcripts and the levels
 * import (MEE6's leaderboard through the fake web, and the staff route with rows from any bot).
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";

import type { PGlite } from "@electric-sql/pglite";
import { AppError } from "@kitsuden/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { INTENTS } from "../../kons/kon-dc/dc.contract";
import { parseDuration, usedInvite } from "../../kons/kon-dc/dc.community";
import { normalizeEvent, type DcEngine } from "../../kons/kon-dc/dc.engine";
import { registerDcPolicy } from "../../kons/kon-dc/dc.policy";
import type { DiscordFile, DiscordRest, DiscordSettings, InviteInfo, TranscriptMessage } from "../../kons/kon-dc/dc.rest";
import { mee6LeaderboardUrl } from "../../kons/kon-dc/dc.rewards";
import { createDcRouter } from "../../kons/kon-dc/dc.routes";

import { dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

const GUILD = "141414141414141414";
const CHANNEL = "222222222222222222";
const LOG = "232323232323232323";
const MEMBER = "444444444444444444";
const OWNER = "199999999999999999";
const INVITER = "455555555555555555";
const INVITER_B = "466666666666666666";
const ROLE_LOW = "300000000000000001";
const ROLE_HIGH = "300000000000000002";
const ROLE_MOD = "300000000000000003";
const WORKER = { agent: ["kon:dc:gateway-config", "kon:dc:ingest-gateway-events"] };
/** Manage Server, Manage Roles. */
const STAFF_PERMS = String((1n << 5n) | (1n << 28n));

const keys = generateKeyPairSync("ed25519");
const settings: DiscordSettings & Record<string, unknown> = {
  applicationId: "999999999999999999",
  publicKey: Buffer.from(keys.publicKey.export({ format: "der", type: "spki" })).subarray(-32).toString("hex"),
  botToken: "test-token",
  disabledModules: new Set(),
  apiBase: "http://discord.invalid",
};

// ── A fake Discord ──────────────────────────────────────────────────────────────────────────────

const calls: Array<{ fn: string; args: unknown[] }> = [];
let seq = 900000000000000000n;
/** What GET /guilds/:id/invites answers. */
let invites: InviteInfo[] = [];
/** The ticket thread's messages, newest first (as Discord pages them). */
let threadMessages: TranscriptMessage[] = [];
const fakeRest = new Proxy({} as DiscordRest, {
  get(_t, fn: string) {
    return async (...args: unknown[]) => {
      calls.push({ fn, args });
      if (fn === "sendMessage") return { id: String(++seq) };
      if (fn === "openDm") return "555555555555555555";
      if (fn === "createThread") return { id: String(++seq) };
      if (fn === "syncGuildCommands") return [];
      if (fn === "getGuildOwner") return OWNER;
      if (fn === "listInvites") return invites.map((i) => ({ ...i }));
      if (fn === "listRoles") {
        return [
          { id: GUILD, name: "@everyone", permissions: "0", position: 0, managed: false },
          { id: ROLE_LOW, name: "low", permissions: "0", position: 1, managed: false },
          { id: ROLE_MOD, name: "mod", permissions: "0", position: 5, managed: false },
          { id: ROLE_HIGH, name: "high", permissions: "0", position: 9, managed: false },
        ];
      }
      if (fn === "messagePage") {
        const [, limit, before] = args as [string, number, string | undefined];
        const start = before ? threadMessages.findIndex((m) => m.id === before) + 1 : 0;
        return threadMessages.slice(start, start + limit);
      }
      return undefined;
    };
  },
});

/** MEE6's leaderboard pages the fake web serves (anything else is a 404). */
const web = new Map<string, { status: number; text: string }>();
const fetched: string[] = [];

const bus = new EventEmitter();
const events = { emit: (e: string, d: unknown) => void bus.emit(e, d), on: (e: string, h: (d: unknown) => void) => void bus.on(e, h) };

let client: PGlite;
let engine: DcEngine;
let clockOffsetMs = 0;
let request: ReturnType<typeof requestAs>;
let app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> };

async function until<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function signed(body: unknown) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return app.request("/interactions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature-ed25519": sign(null, Buffer.from(ts + raw), keys.privateKey).toString("hex"), "x-signature-timestamp": ts },
    body: raw,
  });
}

type Member = { id?: string; roles?: string[]; permissions?: string };
const memberOf = (m: Member = {}) => ({ user: { id: m.id ?? MEMBER, username: "ana", global_name: "Ana" }, roles: m.roles ?? [], ...(m.permissions ? { permissions: m.permissions } : {}) });

function command(name: string, options: Record<string, unknown> = {}, member?: Member) {
  return {
    type: 2,
    id: "1",
    token: "interaction-token",
    guild_id: GUILD,
    channel_id: CHANNEL,
    member: memberOf(member),
    data: { name, options: Object.entries(options).map(([n, value]) => ({ name: n, value })) },
  };
}

function sub(name: string, subcommand: string, options: Record<string, unknown> = {}, member?: Member) {
  return { ...command(name, {}, member), data: { name, options: [{ type: 1, name: subcommand, options: Object.entries(options).map(([n, value]) => ({ name: n, value })) }] } };
}

/** What the member reads: the direct answer, or the edited "thinking…". */
async function said(body: unknown): Promise<{ content: string; embeds?: Array<{ description?: string }> }> {
  calls.length = 0;
  const r = await (await signed(body)).json();
  if (r.type === 4 || r.type === 7) return r.data;
  const edit = await until(() => calls.find((c) => c.fn === "editOriginal" || c.fn === "followup"), 20_000);
  const payload = edit.args[1];
  return typeof payload === "string" ? { content: payload } : (payload as { content: string });
}

async function gateway(t: string, d: Record<string, unknown>) {
  const r = await request(WORKER, "POST", "/gateway/events", { contract: 1, events: [{ t, s: 9, shard: [0, 1], receivedAt: new Date().toISOString(), d: { guild_id: GUILD, ...d } }] });
  expect(r.status).toBe(202);
  await engine.idle();
}

async function enable(moduleId: string, config: Record<string, unknown> = {}) {
  const r = await request("staff", "PUT", `/guilds/${GUILD}/modules/${moduleId}`, { enabled: true, config });
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
  await engine.idle();
}

/** An account id created `days` days ago (a snowflake carries its time). */
const accountId = (days: number, salt = 0) => String((BigInt(Date.now() + clockOffsetMs - days * 86_400_000 - 1420070400000) << 22n) + BigInt(salt));

/** A member's balance of one currency, as the admin sees it. */
async function balanceOf(userId: string, currency: string): Promise<number> {
  const r = await (await request("staff", "GET", `/guilds/${GUILD}/members/${userId}`)).json();
  return (r.balances as Array<{ currency: string; balance: number }>).find((b) => b.currency === currency)?.balance ?? 0;
}

const join = (id: string, roles: string[] = []) => gateway("GUILD_MEMBER_ADD", { user: { id, username: `u${id.slice(-3)}` }, roles });
const leave = (id: string) => gateway("GUILD_MEMBER_REMOVE", { user: { id, username: `u${id.slice(-3)}` } });
const sent = () => calls.filter((c) => c.fn === "sendMessage").map((c) => c.args[1] as string | { content?: string; files?: DiscordFile[] });
const textOf = (m: string | { content?: string }) => (typeof m === "string" ? m : (m.content ?? ""));

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
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never, events: events as never });
  const mounted = host.mount(
    createDcRouter(ctx, {
      settings: () => settings,
      rest: () => fakeRest,
      directAnswerMs: 100,
      panelDebounceMs: 20,
      scheduleTickMs: 0,
      renderPng: async () => null,
      fetchImage: async () => null,
      fetchText: async (url: string) => {
        fetched.push(url);
        const page = web.get(url);
        return { status: page?.status ?? 404, text: page?.text ?? "", contentType: "application/json" };
      },
      now: () => new Date(Date.now() + clockOffsetMs),
      onEngine: (e) => {
        engine = e;
      },
    })
  );
  mounted.onError((err) =>
    err instanceof AppError ? Response.json({ error: err.message, details: err.details }, { status: err.status }) : Response.json({ error: String(err) }, { status: 500 })
  );
  app = mounted;
  request = requestAs(mounted);
  expect((await request("staff", "PUT", `/guilds/${GUILD}`, { name: "Parity server" })).status).toBe(200);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerDcPolicy();
  calls.length = 0;
  fetched.length = 0;
});

// ── Pieces ──────────────────────────────────────────────────────────────────────────────────────

describe("kon-dc parity: pieces", () => {
  it("durations are read without a regular expression", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("1d12h")).toBe(36 * 3_600_000);
    expect(parseDuration("1w")).toBe(7 * 86_400_000);
    expect(parseDuration("45")).toBe(45 * 60_000);
    expect(parseDuration(" 2h 30m ")).toBe(150 * 60_000);
    for (const bad of ["", "h", "10x", "1d2", "9999999m", "-5m", "1.5h", "a".repeat(40)]) expect(parseDuration(bad), bad).toBeNull();
  });

  it("the invite used is the one whose count went up; two at once credit nobody", () => {
    const before = { abc: { u: 1, m: 0, i: INVITER }, xyz: { u: 4, m: 0, i: INVITER_B }, last: { u: 2, m: 3, i: INVITER_B } };
    expect(usedInvite(before, [{ code: "abc", uses: 2, maxUses: 0, inviterId: INVITER }, { code: "xyz", uses: 4, maxUses: 0, inviterId: INVITER_B }])?.inviterId).toBe(INVITER);
    expect(usedInvite(before, [{ code: "abc", uses: 2, maxUses: 0, inviterId: INVITER }, { code: "xyz", uses: 5, maxUses: 0, inviterId: INVITER_B }])).toBeNull();
    // `last` reached its 3 uses and Discord deleted it: it is the one.
    expect(usedInvite(before, [{ code: "abc", uses: 1, maxUses: 0, inviterId: INVITER }, { code: "xyz", uses: 4, maxUses: 0, inviterId: INVITER_B }])?.code).toBe("last");
  });

  it("invite and member-update events are understood", () => {
    const created = normalizeEvent({ t: "INVITE_CREATE", s: 1, shard: [0, 1], receivedAt: "", d: { guild_id: GUILD, code: "abc", uses: 0, max_uses: 5, inviter: { id: INVITER, username: "x" } } });
    expect(created?.invite).toEqual({ code: "abc", uses: 0, maxUses: 5, inviterId: INVITER });
    expect(normalizeEvent({ t: "INVITE_DELETE", s: 1, shard: [0, 1], receivedAt: "", d: { guild_id: GUILD, code: "abc" } })?.invite?.code).toBe("abc");
    expect(normalizeEvent({ t: "GUILD_MEMBER_UPDATE", s: 1, shard: [0, 1], receivedAt: "", d: { guild_id: GUILD, user: { id: MEMBER, username: "x" }, roles: [ROLE_LOW] } })?.memberRoles).toEqual([ROLE_LOW]);
    expect(normalizeEvent({ t: "GUILD_CREATE", s: 1, shard: [0, 1], receivedAt: "", d: { id: GUILD, name: "x" } })?.guildId).toBe(GUILD);
  });
});

// ── Invites ─────────────────────────────────────────────────────────────────────────────────────

describe("kon-dc parity: invite tracker", () => {
  it("asks the gateway for invites and members", async () => {
    invites = [
      { code: "abc", uses: 0, maxUses: 0, inviterId: INVITER },
      { code: "xyz", uses: 3, maxUses: 0, inviterId: INVITER_B },
    ];
    await enable("invites", { channelId: CHANNEL, fakeAccountDays: 7, rewards: [{ invites: 2, roleId: ROLE_LOW, coins: 50 }] });
    // Seeded when switched on.
    expect(calls.some((c) => c.fn === "listInvites")).toBe(true);
    const config = await (await request(WORKER, "GET", "/gateway/config")).json();
    expect(config.intents & INTENTS.GUILD_INVITES).toBe(INTENTS.GUILD_INVITES);
    expect(config.intents & INTENTS.GUILD_MEMBERS).toBe(INTENTS.GUILD_MEMBERS);
    expect(config.events).toEqual(expect.arrayContaining(["INVITE_CREATE", "INVITE_DELETE", "GUILD_MEMBER_ADD", "GUILD_MEMBER_REMOVE"]));
  });

  it("credits the inviter, says so, counts fakes apart, rewards at N, and keeps a rejoin with the first inviter", async () => {
    const first = accountId(400, 1);
    calls.length = 0;
    invites[0].uses = 1;
    await join(first);
    expect(sent().map(textOf)).toEqual([`<@${first}> joined, invited by <@${INVITER}> (1 invites).`]);

    // A brand-new account: fake, not an invite.
    calls.length = 0;
    invites[0].uses = 2;
    await join(accountId(1, 2));
    expect((await said(sub("invites", "count", { member: INVITER }))).content).toBe(`<@${INVITER}> has 1 invites (1 joined, 0 left, 1 fake).`);

    // Second real invite: the reward (role and coins) once.
    calls.length = 0;
    const second = accountId(300, 3);
    invites[0].uses = 3;
    await join(second);
    expect(calls.find((c) => c.fn === "addRole")?.args).toEqual([GUILD, INVITER, ROLE_LOW]);
    expect(await balanceOf(INVITER, "coins")).toBe(50);

    // Leaving takes the invite away; coming back gives it back to the same inviter, not to who invited again.
    await leave(second);
    expect((await said(sub("invites", "count", { member: INVITER }))).content).toBe(`<@${INVITER}> has 1 invites (2 joined, 1 left, 1 fake).`);
    invites[1].uses = 4;
    calls.length = 0;
    await join(second);
    expect(sent().map(textOf)[0]).toContain(`<@${INVITER}>`);
    expect((await said(sub("invites", "count", { member: INVITER }))).content).toBe(`<@${INVITER}> has 2 invites (2 joined, 0 left, 1 fake).`);
    // The reward was not paid twice.
    expect(calls.filter((c) => c.fn === "addRole")).toHaveLength(0);
  });

  it("an invite made after the copy, and one spent at its last use, are still credited", async () => {
    await gateway("INVITE_CREATE", { code: "new1", uses: 0, max_uses: 1, inviter: { id: INVITER_B, username: "b" } });
    // Discord deletes an invite at its last use, sometimes before the join arrives.
    invites = invites.filter((i) => i.code !== "new1");
    await gateway("INVITE_DELETE", { code: "new1" });
    calls.length = 0;
    const id = accountId(200, 4);
    await join(id);
    expect(sent().map(textOf)).toEqual([`<@${id}> joined, invited by <@${INVITER_B}> (1 invites).`]);
  });

  it("two invites going up at once credit nobody, and the leaderboard ranks inviters", async () => {
    invites[0].uses += 1;
    invites[1].uses += 1;
    calls.length = 0;
    const id = accountId(200, 5);
    await join(id);
    expect(sent().map(textOf)).toEqual([`<@${id}> joined.`]);
    const board = await said(sub("invites", "leaderboard"));
    const text = (board.embeds ?? [])[0]?.description ?? "";
    expect(text.indexOf(`<@${INVITER}>`)).toBeLessThan(text.indexOf(`<@${INVITER_B}>`));
    expect(text).toContain("2 invites");
  });

  it("the copy is refreshed when the gateway reconnects (GUILD_CREATE)", async () => {
    calls.length = 0;
    const r = await request(WORKER, "POST", "/gateway/events", { contract: 1, events: [{ t: "GUILD_CREATE", s: 1, shard: [0, 1], receivedAt: new Date().toISOString(), d: { id: GUILD, name: "Parity server" } }] });
    expect(r.status).toBe(202);
    await engine.idle();
    expect(calls.some((c) => c.fn === "listInvites")).toBe(true);
    await request("staff", "PUT", `/guilds/${GUILD}/modules/invites`, { enabled: false, config: { channelId: CHANNEL } });
  });
});

// ── Sticky roles ────────────────────────────────────────────────────────────────────────────────

describe("kon-dc parity: sticky roles", () => {
  it("gives back the roles a member had, except those left out", async () => {
    await enable("sticky-roles", { excludedRoleIds: [ROLE_HIGH] });
    const who = "488888888888888888";
    await join(who);
    await gateway("GUILD_MEMBER_UPDATE", { user: { id: who, username: "x" }, roles: [ROLE_LOW, ROLE_HIGH, ROLE_MOD] });
    await leave(who);
    calls.length = 0;
    await join(who);
    expect(calls.filter((c) => c.fn === "addRole").map((c) => c.args[2])).toEqual([ROLE_LOW, ROLE_MOD]);

    // "Keep only these": only that role comes back.
    await enable("sticky-roles", { onlyRoleIds: [ROLE_MOD] });
    await gateway("GUILD_MEMBER_UPDATE", { user: { id: who, username: "x" }, roles: [ROLE_LOW, ROLE_MOD] });
    await leave(who);
    calls.length = 0;
    await join(who);
    expect(calls.filter((c) => c.fn === "addRole").map((c) => c.args[2])).toEqual([ROLE_MOD]);

    // A first join restores nothing.
    calls.length = 0;
    await join("499999999999999999", [ROLE_LOW]);
    expect(calls.filter((c) => c.fn === "addRole")).toHaveLength(0);
    await request("staff", "PUT", `/guilds/${GUILD}/modules/sticky-roles`, { enabled: false, config: {} });
  });
});

// ── Temporary roles ─────────────────────────────────────────────────────────────────────────────

describe("kon-dc parity: temporary roles", () => {
  it("gives a role, lists it, and takes it when the time is up (a schedule, so it survives restarts)", async () => {
    await enable("temp-roles", { logChannelId: LOG });
    const mod = { permissions: STAFF_PERMS, roles: [ROLE_MOD] };
    // Without Manage Roles: no.
    expect((await said(sub("temprole", "add", { member: OWNER, role: ROLE_LOW, duration: "2h" }))).content).toBe("Only the staff (Manage Roles) can do that.");
    // A role above the giver's highest: no.
    expect((await said(sub("temprole", "add", { member: OWNER, role: ROLE_HIGH, duration: "2h" }, mod))).content).toBe("You can only give roles below your highest role.");
    expect((await said(sub("temprole", "add", { member: OWNER, role: ROLE_LOW, duration: "soon" }, mod))).content).toBe("Write the duration like 30m, 2h, 7d or 1d12h.");

    const given = await said(sub("temprole", "add", { member: OWNER, role: ROLE_LOW, duration: "2h" }, mod));
    expect(given.content).toMatch(new RegExp(`^<@${OWNER}> has <@&${ROLE_LOW}> until <t:\\d+:f>\\.$`));
    expect(calls.find((c) => c.fn === "addRole")?.args).toEqual([GUILD, OWNER, ROLE_LOW]);
    const list = await said(sub("temprole", "list", {}, mod));
    expect(list.embeds?.[0]?.description).toContain(`<@${OWNER}> · <@&${ROLE_LOW}>`);

    // The schedule is stored in the database: what a restarted API reads.
    const schedules = await (await request("staff", "GET", `/guilds/${GUILD}/schedules`)).json();
    expect(JSON.stringify(schedules)).toContain(`tr-${OWNER}-${ROLE_LOW}`);

    calls.length = 0;
    clockOffsetMs += 60 * 60_000;
    expect(await engine.tick()).toBe(0);
    clockOffsetMs += 61 * 60_000;
    expect(await engine.tick()).toBe(1);
    await engine.idle();
    expect(calls.find((c) => c.fn === "removeRole")?.args).toEqual([GUILD, OWNER, ROLE_LOW]);
    expect((await said(sub("temprole", "list", {}, mod))).embeds?.[0]?.description).toBe("None.");
  });

  it("removes one early, and the server's owner may give any role", async () => {
    const owner = { id: OWNER, permissions: STAFF_PERMS };
    await said(sub("temprole", "add", { member: MEMBER, role: ROLE_HIGH, duration: "1d" }, owner));
    expect(calls.find((c) => c.fn === "addRole")?.args).toEqual([GUILD, MEMBER, ROLE_HIGH]);
    expect((await said(sub("temprole", "remove", { member: MEMBER, role: ROLE_HIGH }, owner))).content).toBe(`<@&${ROLE_HIGH}> taken from <@${MEMBER}>.`);
    expect(calls.find((c) => c.fn === "removeRole")?.args).toEqual([GUILD, MEMBER, ROLE_HIGH]);
    clockOffsetMs += 2 * 86_400_000;
    expect(await engine.tick()).toBe(0);
    await request("staff", "PUT", `/guilds/${GUILD}/modules/temp-roles`, { enabled: false, config: {} });
  });
});

// ── Voice roles ─────────────────────────────────────────────────────────────────────────────────

describe("kon-dc parity: voice roles", () => {
  it("a role while in a voice channel, per channel and for any; taken when leaving or moving", async () => {
    const VC1 = "610000000000000001";
    const VC2 = "610000000000000002";
    const AFK = "610000000000000003";
    // Settings with nothing linked are refused.
    expect((await request("staff", "PUT", `/guilds/${GUILD}/modules/voice-roles`, { enabled: true, config: {} })).status).toBe(422);
    await enable("voice-roles", { links: [{ channelId: VC1, roleId: ROLE_LOW }], anyChannelRoleId: ROLE_MOD, ignoredChannelIds: [AFK] });
    const voice = (channelId: string | null) => gateway("VOICE_STATE_UPDATE", { user_id: MEMBER, channel_id: channelId, member: { user: { id: MEMBER, username: "ana" }, roles: [] } });

    calls.length = 0;
    await voice(VC1);
    expect(calls.filter((c) => c.fn === "addRole").map((c) => c.args[2]).sort()).toEqual([ROLE_LOW, ROLE_MOD].sort());

    calls.length = 0;
    await voice(VC2);
    expect(calls.filter((c) => c.fn === "removeRole").map((c) => c.args[2])).toEqual([ROLE_LOW]);
    expect(calls.filter((c) => c.fn === "addRole")).toHaveLength(0);

    calls.length = 0;
    await voice(AFK);
    expect(calls.filter((c) => c.fn === "removeRole").map((c) => c.args[2])).toEqual([ROLE_MOD]);

    calls.length = 0;
    await voice(VC1);
    await voice(null);
    expect(calls.filter((c) => c.fn === "removeRole").map((c) => c.args[2]).sort()).toEqual([ROLE_LOW, ROLE_MOD].sort());
    await request("staff", "PUT", `/guilds/${GUILD}/modules/voice-roles`, { enabled: false, config: { anyChannelRoleId: ROLE_MOD } });
  });
});

// ── Ticket transcripts ──────────────────────────────────────────────────────────────────────────

describe("kon-dc parity: ticket transcripts", () => {
  it("on close, the thread as a .txt file in the log channel and by DM, read page by page and capped", async () => {
    await enable("tickets", { transcriptChannelId: LOG, transcriptDm: true, transcriptMaxMessages: 150 });
    const open = { type: 3, id: "2", token: "t", guild_id: GUILD, channel_id: CHANNEL, message: { id: "800000000000000001" }, member: memberOf(), data: { custom_id: "dc:tickets:open", component_type: 2 } };
    const opened = await said(open);
    const threadId = opened.content.match(/<#(\d+)>/)![1];

    // 230 messages, newest first: the transcript keeps the newest 150, oldest first.
    const base = Date.parse("2026-11-16T10:00:00Z");
    threadMessages = Array.from({ length: 230 }, (_, n) => {
      const i = 229 - n;
      return {
        id: String(700000000000000000n + BigInt(i)),
        authorId: i % 2 ? MEMBER : OWNER,
        authorName: i % 2 ? "Ana" : "Staff",
        bot: false,
        timestamp: new Date(base + i * 1000).toISOString(),
        content: i === 229 ? "thanks, solved" : `message ${i}`,
        attachments: i === 228 ? ["https://cdn.discordapp.com/attachments/1/2/log.png"] : [],
        embeds: 0,
      };
    });

    calls.length = 0;
    const close = { ...open, channel_id: threadId, data: { custom_id: "dc:tickets:close", component_type: 2 } };
    expect((await (await signed(close)).json()).type).toBe(6);
    await until(() => calls.find((c) => c.fn === "setThreadState"));
    await engine.idle();

    const pages = calls.filter((c) => c.fn === "messagePage");
    expect(pages.map((c) => c.args[1])).toEqual([100, 50]);
    const files = calls.filter((c) => c.fn === "sendMessage" && typeof c.args[1] === "object" && (c.args[1] as { files?: DiscordFile[] }).files);
    expect(files.map((c) => c.args[0])).toEqual([LOG, "555555555555555555"]);
    const posted = files[0].args[1] as { content: string; files: DiscordFile[] };
    expect(posted.content).toBe(`Transcript of <#${threadId}> (opened by <@${MEMBER}>, 150 messages).`);
    expect(posted.files[0].name).toBe(`transcript-${threadId}.txt`);
    const text = new TextDecoder().decode(posted.files[0].data);
    const lines = text.split("\n");
    expect(lines[0]).toBe(`Ticket ${threadId} in server ${GUILD}`);
    expect(text).toContain("150 messages (UTC)");
    expect(text).not.toContain("message 79:");
    expect(text).toContain(`Staff (${OWNER}): message 80`);
    expect(text.indexOf("message 80")).toBeLessThan(text.indexOf("thanks, solved"));
    expect(text).toContain("    attachment: https://cdn.discordapp.com/attachments/1/2/log.png");
    // The transcript is read before the thread is archived.
    const order = calls.map((c) => c.fn);
    expect(order.indexOf("messagePage")).toBeLessThan(order.indexOf("setThreadState"));
    await request("staff", "PUT", `/guilds/${GUILD}/modules/tickets`, { enabled: false, config: {} });
  });
});

// ── Levels from other bots ──────────────────────────────────────────────────────────────────────

describe("kon-dc parity: levels migration", () => {
  const A = "471111111111111111";
  const B = "472222222222222222";
  const C = "473333333333333333";
  const xpOf = (userId: string) => balanceOf(userId, "xp");

  it("/levels-import mee6 reads every page of MEE6's leaderboard and keeps the higher XP", async () => {
    await enable("leveling", { cooldownSeconds: 0 });
    await request("staff", "PUT", `/guilds/${GUILD}/economy/${B}`, { currency: "xp", set: 5000 });
    // Page 0 is full (1000 rows), page 1 has the rest.
    const filler = Array.from({ length: 998 }, (_, n) => ({ id: String(480000000000000000n + BigInt(n)), xp: 10, level: 0 }));
    web.set(mee6LeaderboardUrl(GUILD, 0), { status: 200, text: JSON.stringify({ players: [{ id: A, xp: 1200, level: 5 }, { id: B, xp: 300, level: 2 }, ...filler] }) });
    web.set(mee6LeaderboardUrl(GUILD, 1), { status: 200, text: JSON.stringify({ players: [{ id: C, xp: 50, level: 0 }, { id: "not-an-id", xp: 9 }] }) });

    expect((await said(command("levels-import", { source: "mee6" }))).content).toBe("Only the staff (Manage Server) can do that.");
    const r = await said(command("levels-import", { source: "mee6" }, { permissions: STAFF_PERMS }));
    expect(r.content).toBe("Imported from MEE6: 1001 members read, 1000 changed.");
    expect(fetched).toEqual([mee6LeaderboardUrl(GUILD, 0), mee6LeaderboardUrl(GUILD, 1)]);
    expect(fetched.every((u) => u.startsWith("https://mee6.xyz/api/plugins/levels/leaderboard/"))).toBe(true);
    expect(await xpOf(A)).toBe(1200);
    expect(await xpOf(B)).toBe(5000);
    expect(await xpOf(C)).toBe(50);

    // Again at once: refused for five minutes.
    expect((await said(command("levels-import", { source: "mee6" }, { permissions: STAFF_PERMS }))).content).toBe("An import ran a moment ago: wait five minutes.");
  }, 60_000);

  it("overwrite replaces, keep=level keeps the level, a private leaderboard is explained; the server owner may import", async () => {
    clockOffsetMs += 6 * 60_000;
    web.set(mee6LeaderboardUrl(GUILD, 0), { status: 200, text: JSON.stringify({ players: [{ id: B, xp: 300, level: 3 }] }) });
    const owner = { id: OWNER };
    expect((await said(command("levels-import", { source: "mee6", overwrite: true, keep: "level" }, owner))).content).toBe("Imported from MEE6: 1 members read, 1 changed.");
    // Level 3 on this bot's curve is 900 XP.
    expect(await xpOf(B)).toBe(900);

    clockOffsetMs += 6 * 60_000;
    web.set(mee6LeaderboardUrl(GUILD, 0), { status: 401, text: JSON.stringify({ error: { message: "Unauthorized" } }) });
    expect((await said(command("levels-import", { source: "mee6" }, owner))).content).toBe(
      "MEE6's leaderboard for this server is not public: make it public in MEE6's dashboard, then try again."
    );
  });

  it("the staff route takes rows from any bot, keeps the higher unless told, and only the team may call it", async () => {
    const rows = [
      { userId: A, xp: 100 },
      { userId: C, xp: 7000 },
      { userId: C, xp: 6000 },
      { userId: "474444444444444444", level: 4 },
    ];
    expect((await request("anon", "POST", `/guilds/${GUILD}/import/levels`, { rows })).status).toBe(401);
    expect((await request("a", "POST", `/guilds/${GUILD}/import/levels`, { rows })).status).toBe(403);
    expect((await request("staff", "POST", `/guilds/999999999999999990/import/levels`, { rows })).status).toBe(404);
    expect((await request("staff", "POST", `/guilds/${GUILD}/import/levels`, { rows: [{ userId: A }] })).status).toBe(422);

    const r = await request("staff", "POST", `/guilds/${GUILD}/import/levels`, { rows, source: "arcane" });
    expect(r.status).toBe(200);
    // The row with only a level is skipped when keeping XP.
    expect(await r.json()).toEqual({ members: 2, skipped: 1 });
    expect(await xpOf(A)).toBe(1200);
    expect(await xpOf(C)).toBe(7000);

    const again = await request("staff", "POST", `/guilds/${GUILD}/import/levels`, { rows, overwrite: true, keep: "level" });
    expect(await again.json()).toEqual({ members: 3, skipped: 0 });
    expect(await xpOf(A)).toBe(100);
    expect(await xpOf("474444444444444444")).toBe(1600);
  });

  it("resetOnLeave clears a member's XP when they leave, and asks for the members intent", async () => {
    await enable("leveling", { cooldownSeconds: 0, resetOnLeave: true });
    const config = await (await request(WORKER, "GET", "/gateway/config")).json();
    expect(config.intents & INTENTS.GUILD_MEMBERS).toBe(INTENTS.GUILD_MEMBERS);
    expect(await xpOf(C)).toBe(7000);
    await leave(C);
    expect(await xpOf(C)).toBe(0);

    // Off: XP stays.
    await enable("leveling", { cooldownSeconds: 0 });
    await leave(A);
    expect(await xpOf(A)).toBe(100);
  });
});

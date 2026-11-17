/**
 * kon-dc — community modules at parity with Dyno, Carl-bot and MEE6: starboard, tags,
 * autoresponder, AFK, highlights, the embed builder, and social presets for feeds.
 *
 * Real routes on PGlite with row security, a fake Discord that remembers messages, channels and
 * members, a fake web for feeds and a movable clock.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";

import type { PGlite } from "@electric-sql/pglite";
import { AppError } from "@kitsuden/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { INTENTS } from "../../kons/kon-dc/dc.contract";
import type { DcEngine } from "../../kons/kon-dc/dc.engine";
import { feedUrl, presetSource } from "../../kons/kon-dc/dc.feeds";
import { registerDcPolicy } from "../../kons/kon-dc/dc.policy";
import type { ChannelInfo, DiscordRest, DiscordSettings, MessageInfo } from "../../kons/kon-dc/dc.rest";
import { createDcRouter } from "../../kons/kon-dc/dc.routes";
import { emojiKey } from "../../kons/kon-dc/dc.starboard";
import { buildEmbed, messageLink, short, tagName, tagsModule, unshort } from "../../kons/kon-dc/dc.tags";
import { matchesTrigger } from "../../kons/kon-dc/dc.utilities";

import { dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

const GUILD = "121212121212121212";
const OTHER_GUILD = "131313131313131313";
const CHANNEL = "222222222222222222";
const STARS = "232323232323232323";
const HIDDEN = "242424242424242424";
const NSFW = "252525252525252525";
const MEMBER = "444444444444444444";
const OTHER = "777777777777777777";
const THIRD = "787878787878787878";
const BOT = "999999999999999999";
const ROLE = "333333333333333333";
const WORKER = { agent: ["kon:dc:gateway-config", "kon:dc:ingest-gateway-events"] };
const MANAGE_MESSAGES = String(1n << 13n);
const VIEW = String(1n << 10n);

const keys = generateKeyPairSync("ed25519");
const settings: DiscordSettings & Record<string, unknown> = {
  applicationId: BOT,
  publicKey: Buffer.from(keys.publicKey.export({ format: "der", type: "spki" })).subarray(-32).toString("hex"),
  botToken: "test-token",
  disabledModules: new Set(),
  apiBase: "http://discord.invalid",
};

// ── A fake Discord that remembers what the modules read ─────────────────────────────────────────

const calls: Array<{ fn: string; args: unknown[] }> = [];
let seq = 900000000000000000n;
const messages = new Map<string, MessageInfo>();
const reactors = new Map<string, string[]>();
const channels = new Map<string, ChannelInfo>();
const memberRoles = new Map<string, string[]>();
const channel = (id: string, more: Partial<ChannelInfo> = {}): ChannelInfo => ({ id, type: 0, guildId: GUILD, parentId: null, nsfw: false, overwrites: [], ...more });

const fakeRest = new Proxy({} as DiscordRest, {
  get(_t, fn: string) {
    return async (...args: unknown[]) => {
      calls.push({ fn, args });
      switch (fn) {
        case "sendMessage":
          return { id: String(++seq) };
        case "openDm":
          return `dm-${args[0] as string}`;
        case "syncGuildCommands":
          return [];
        case "getMessage": {
          const m = messages.get(args[1] as string);
          if (!m) throw Object.assign(new Error("Unknown Message"), { status: 404 });
          return m;
        }
        case "reactionUsers":
          return reactors.get(args[1] as string) ?? [];
        case "getChannel":
          return channels.get(args[0] as string) ?? channel(args[0] as string);
        case "getMember":
          return { roles: memberRoles.get(args[1] as string) ?? [], nick: null, user: { id: args[1], name: `user-${String(args[1]).slice(0, 3)}`, avatar: null } };
        case "listRoles":
          return [{ id: GUILD, name: "@everyone", permissions: VIEW, position: 0, managed: false }];
        case "getGuildOwner":
          return "100000000000000001";
        default:
          return undefined;
      }
    };
  },
});

const feedDocs = new Map<string, string>();
let clockOffsetMs = 0;
const bus = new EventEmitter();
const events = { emit: (e: string, d: unknown) => void bus.emit(e, d), on: (e: string, h: (d: unknown) => void) => void bus.on(e, h) };

let client: PGlite;
let engine: DcEngine;
let request: ReturnType<typeof requestAs>;
let app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> };

// ── Helpers (as in kon-dc.test.ts) ──────────────────────────────────────────────────────────────

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
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": sign(null, Buffer.from(ts + raw), keys.privateKey).toString("hex"),
      "x-signature-timestamp": ts,
    },
    body: raw,
  });
}

type Member = { id?: string; roles?: string[]; permissions?: string };

function command(name: string, options: Record<string, unknown> = {}, subcommand?: string, member: Member = {}) {
  const opts = Object.entries(options).map(([n, value]) => ({ name: n, type: 3, value }));
  return {
    type: 2,
    id: "1",
    token: "interaction-token",
    guild_id: GUILD,
    channel_id: CHANNEL,
    member: { user: { id: member.id ?? MEMBER, username: "ana", global_name: "Ana" }, roles: member.roles ?? [], permissions: member.permissions ?? "0" },
    data: { name, options: subcommand ? [{ name: subcommand, type: 1, options: opts }] : opts },
  };
}

function modalSubmit(customId: string, fields: Record<string, string>, member: Member = {}) {
  return {
    type: 5,
    id: "3",
    token: "modal-token",
    guild_id: GUILD,
    channel_id: CHANNEL,
    member: { user: { id: member.id ?? MEMBER, username: "ana" }, roles: member.roles ?? [], permissions: member.permissions ?? "0" },
    data: {
      custom_id: customId,
      components: Object.entries(fields).map(([custom_id, value]) => ({ type: 1, components: [{ type: 4, custom_id, value }] })),
    },
  };
}

const staff: Member = { permissions: MANAGE_MESSAGES };

/** What the member reads: the direct answer, or the edited "thinking…". */
async function said(body: unknown): Promise<string> {
  calls.length = 0;
  const r = await (await signed(body)).json();
  if (r.type === 4 || r.type === 7) return r.data.content;
  const edit = await until(() => calls.find((c) => c.fn === "editOriginal" || c.fn === "followup"));
  const payload = edit.args[1];
  return typeof payload === "string" ? payload : (payload as { content: string }).content;
}

/** The answer to a command, direct or deferred, and whether it is private (flags 64). */
async function answer(body: unknown): Promise<{ content: string; flags: number }> {
  calls.length = 0;
  const r = await (await signed(body)).json();
  if (r.type !== 5) return { content: r.data?.content ?? "", flags: r.data?.flags ?? 0 };
  const edit = await until(() => calls.find((c) => c.fn === "editOriginal"));
  const payload = edit.args[1];
  return { content: typeof payload === "string" ? payload : (payload as { content: string }).content, flags: r.data?.flags ?? 0 };
}

async function enable(moduleId: string, config: Record<string, unknown> = {}, guildId = GUILD) {
  const r = await request("staff", "PUT", `/guilds/${guildId}/modules/${moduleId}`, { enabled: true, config });
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
}

async function gatewayEvents(list: Array<{ t: string; d: Record<string, unknown> }>, guildId = GUILD) {
  const r = await request(WORKER, "POST", "/gateway/events", {
    contract: 1,
    events: list.map((e, i) => ({ t: e.t, s: 9 + i, shard: [0, 1], receivedAt: new Date().toISOString(), d: { guild_id: guildId, ...e.d } })),
  });
  expect(r.status).toBe(202);
  await engine.idle();
}

const gatewayEvent = (t: string, d: Record<string, unknown>, guildId = GUILD) => gatewayEvents([{ t, d }], guildId);

let messageSeq = 810000000000000000n;
async function message(content: string, opts: { author?: string; channel?: string; mentions?: string[]; roles?: string[]; bot?: boolean } = {}) {
  const id = String(++messageSeq);
  calls.length = 0;
  await gatewayEvent("MESSAGE_CREATE", {
    id,
    channel_id: opts.channel ?? CHANNEL,
    content,
    author: { id: opts.author ?? MEMBER, username: "ana", global_name: "Ana", ...(opts.bot ? { bot: true } : {}) },
    member: { roles: opts.roles ?? [] },
    mentions: (opts.mentions ?? []).map((m) => ({ id: m, username: "x" })),
  });
  return id;
}

const sent = () => calls.filter((c) => c.fn === "sendMessage").map((c) => ({ to: c.args[0] as string, body: c.args[1] }));
const textOf = (body: unknown) => (typeof body === "string" ? body : ((body as { content?: string }).content ?? ""));

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
      directAnswerMs: 400,
      panelDebounceMs: 20,
      scheduleTickMs: 0,
      fetchText: async (url: string) => ({ status: feedDocs.has(url) ? 200 : 404, text: feedDocs.get(url) ?? "", contentType: "application/rss+xml" }),
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
  expect((await request("staff", "PUT", `/guilds/${GUILD}`, { name: "Parity server" })).status).toBe(200);
  expect((await request("staff", "PUT", `/guilds/${OTHER_GUILD}`, { name: "Another server" })).status).toBe(200);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerDcPolicy();
  calls.length = 0;
});

// ── Matching ────────────────────────────────────────────────────────────────────────────────────

describe("kon-dc parity: matching triggers without regular expressions", () => {
  it("exact, contains, starts with and whole words, with * for anything", () => {
    expect(matchesTrigger("Hello", "hello", "exact")).toBe(true);
    expect(matchesTrigger("hello there", "hello", "exact")).toBe(false);
    expect(matchesTrigger("well, hello there", "hello", "contains")).toBe(true);
    expect(matchesTrigger("othello", "hello", "contains")).toBe(true);
    expect(matchesTrigger("othello", "hello", "word")).toBe(false);
    expect(matchesTrigger("say hello!", "hello", "word")).toBe(true);
    expect(matchesTrigger("hello world", "hello", "starts_with")).toBe(true);
    expect(matchesTrigger("oh hello world", "hello", "starts_with")).toBe(false);
    expect(matchesTrigger("good sunny morning", "good * morning", "exact")).toBe(true);
    expect(matchesTrigger("good morning to you", "good * morning", "exact")).toBe(false);
    expect(matchesTrigger("a goodish day, morningstar", "good*morning", "word")).toBe(false);
    expect(matchesTrigger("well good day and morning all", "good*morning", "word")).toBe(true);
    expect(matchesTrigger("we have a bug", "bug*", "word")).toBe(true);
    expect(matchesTrigger("ladybugs", "*bug", "word")).toBe(false);
    expect(matchesTrigger("ladybug!", "*bug", "word")).toBe(true);
    expect(matchesTrigger("anything", "*", "exact")).toBe(true);
    expect(matchesTrigger("¿Qué tal, Ñandú?", "ñandú", "word")).toBe(true);
  });

  it("stays fast on hostile input (no backtracking)", () => {
    const text = "a".repeat(4000);
    const started = Date.now();
    for (const kind of ["exact", "contains", "starts_with", "word"] as const) {
      expect(matchesTrigger(text, "a*a*a*a*a*a*a*a*b", kind)).toBe(false);
      expect(matchesTrigger(text, "*a*a*a*a*a*a*a*a*a", kind)).toBe(true);
    }
    expect(Date.now() - started).toBeLessThan(500);
  });
});

// ── Starboard ───────────────────────────────────────────────────────────────────────────────────

describe("kon-dc parity: starboard", () => {
  const STARRED = "820000000000000001";
  const star = (user: string, msg = STARRED, ch = CHANNEL, t = "MESSAGE_REACTION_ADD") => ({
    t,
    d: { channel_id: ch, message_id: msg, user_id: user, emoji: { name: "⭐" }, member: { user: { id: user, username: "u" } } },
  });
  const setStars = (msg: string, users: string[], ch = CHANNEL) => {
    reactors.set(msg, users);
    messages.set(msg, {
      id: msg,
      channelId: ch,
      authorId: MEMBER,
      authorName: "Ana",
      authorAvatar: "abc",
      authorBot: false,
      content: "A great message",
      timestamp: "2026-11-16T10:00:00.000Z",
      attachments: [
        { url: "https://cdn.discordapp.com/file.txt", filename: "notes.txt", contentType: "text/plain" },
        { url: "https://cdn.discordapp.com/cat.png", filename: "cat.png", contentType: "image/png" },
      ],
      embeds: [],
      reactions: [{ emoji: "⭐", count: users.length }],
    });
  };

  beforeAll(async () => {
    channels.set(NSFW, channel(NSFW, { nsfw: true }));
    await enable("starboard", { channelId: STARS, threshold: 2, ignoredChannels: [HIDDEN] });
  });

  it("needs only the reactions intent", async () => {
    const cfg = await (await request(WORKER, "GET", "/gateway/config")).json();
    expect(cfg.events).toEqual(expect.arrayContaining(["MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE"]));
    expect(cfg.intents & INTENTS.GUILD_MESSAGE_REACTIONS).toBeTruthy();
  });

  it("posts once at the threshold, with author, text, first image and a jump link; the count follows", async () => {
    setStars(STARRED, [OTHER]);
    calls.length = 0;
    await gatewayEvents([star(OTHER)]);
    expect(sent()).toEqual([]);

    // Two reactions arrive together: the message is posted once.
    setStars(STARRED, [OTHER, THIRD]);
    calls.length = 0;
    await gatewayEvents([star(THIRD), star(OTHER)]);
    const posts = sent();
    expect(posts).toHaveLength(1);
    expect(posts[0].to).toBe(STARS);
    const body = posts[0].body as { content: string; embeds: Array<Record<string, any>> };
    expect(body.content).toBe(`⭐ **2** · <#${CHANNEL}>`);
    expect(body.embeds[0].author).toEqual({ name: "Ana", icon_url: `https://cdn.discordapp.com/avatars/${MEMBER}/abc.png` });
    expect(body.embeds[0].description).toBe("A great message");
    expect(body.embeds[0].image).toEqual({ url: "https://cdn.discordapp.com/cat.png" });
    expect(body.embeds[0].fields[0].value).toContain(`https://discord.com/channels/${GUILD}/${CHANNEL}/${STARRED}`);

    // A third star edits the same post; a removal edits it again.
    setStars(STARRED, [OTHER, THIRD, "797979797979797979"]);
    calls.length = 0;
    await gatewayEvents([star("797979797979797979")]);
    expect(sent()).toEqual([]);
    const edit = calls.find((c) => c.fn === "editMessage")!;
    expect(edit.args[0]).toBe(STARS);
    expect(textOf(edit.args[2])).toBe(`⭐ **3** · <#${CHANNEL}>`);

    setStars(STARRED, [OTHER]);
    calls.length = 0;
    await gatewayEvents([star(THIRD, STARRED, CHANNEL, "MESSAGE_REACTION_REMOVE")]);
    expect(sent()).toEqual([]);
    expect(textOf(calls.find((c) => c.fn === "editMessage")!.args[2])).toBe(`⭐ **1** · <#${CHANNEL}>`);
  });

  it("the author's own star does not count; other emojis, ignored and age-restricted channels never post", async () => {
    const own = "820000000000000002";
    setStars(own, [MEMBER, OTHER]);
    calls.length = 0;
    await gatewayEvents([star(MEMBER, own)]);
    expect(sent()).toEqual([]);

    const ignored = "820000000000000003";
    setStars(ignored, [OTHER, THIRD], HIDDEN);
    await gatewayEvents([star(OTHER, ignored, HIDDEN)]);
    expect(sent()).toEqual([]);

    const nsfw = "820000000000000004";
    setStars(nsfw, [OTHER, THIRD], NSFW);
    await gatewayEvents([star(OTHER, nsfw, NSFW)]);
    expect(sent()).toEqual([]);

    const other = "820000000000000005";
    setStars(other, [OTHER, THIRD]);
    await gatewayEvents([{ t: "MESSAGE_REACTION_ADD", d: { channel_id: CHANNEL, message_id: other, user_id: OTHER, emoji: { name: "🔥" } } }]);
    expect(sent()).toEqual([]);

    // Self-stars allowed: the author's star counts.
    await enable("starboard", { channelId: STARS, threshold: 2, selfStar: true });
    await gatewayEvents([star(MEMBER, own)]);
    expect(sent()).toHaveLength(1);
  });

  it("names custom emojis the way reaction events do", () => {
    expect(emojiKey("<:star2:123456789012345678>")).toBe("star2:123456789012345678");
    expect(emojiKey("<a:spin:123456789012345678>")).toBe("spin:123456789012345678");
    expect(emojiKey("⭐️")).toBe("⭐");
  });
});

// ── Tags ────────────────────────────────────────────────────────────────────────────────────────

describe("kon-dc parity: tags", () => {
  beforeAll(async () => {
    await enable("tags", { maxTags: 2, staffRoles: [ROLE] });
  });

  it("only the staff opens the form; a staff role counts as staff", async () => {
    const refused = await (await signed(command("tags", { name: "rules" }, "create"))).json();
    expect(refused.type).toBe(4);
    expect(refused.data.content).toBe("Only the staff can change tags.");

    const form = await (await signed(command("tags", { name: "Server Rules" }, "create", staff))).json();
    expect(form.type).toBe(9);
    expect(form.data.custom_id).toBe("dc:tags:c-server-rules");
    const byRole = await (await signed(command("tags", { name: "faq" }, "create", { roles: [ROLE] }))).json();
    expect(byRole.type).toBe(9);

    // The form is checked again when it comes back.
    expect(await said(modalSubmit("dc:tags:c-server-rules", { content: "Be kind." }))).toBe("Only the staff can change tags.");
  });

  it("create, post with placeholders, autocomplete, list, info, edit and delete", async () => {
    expect(await said(modalSubmit("dc:tags:c-server-rules", { content: "Be kind, {{user.mention}}." }, staff))).toBe("Saved the tag server-rules.");
    expect(await said(modalSubmit("dc:tags:c-server-rules", { content: "Again" }, staff))).toBe("A tag called server-rules already exists.");

    const posted = await answer(command("tag", { name: "server-rules" }));
    expect(posted.flags).toBe(0);
    expect(posted.content).toBe(`Be kind, <@${MEMBER}>.`);
    expect(await said(command("tag", { name: "nope" }))).toBe("There is no tag called nope.");

    // On PGlite the request holds the only connection, so autocomplete is driven directly here.
    const kv = { get: async (k: string) => (k === "index" ? JSON.stringify(["faq", "server-rules", "rules-old"]) : undefined) };
    const choices = await tagsModule.onAutocomplete!({ command: "tag", subcommand: null, option: "name", focused: "Rul", options: {} }, {} as never, { kv } as never);
    expect(choices).toEqual([
      { name: "rules-old", value: "rules-old" },
      { name: "server-rules", value: "server-rules" },
    ]);

    expect(await said(command("tags", {}, "list"))).toBe("**Tags (1):** `server-rules`");
    expect(await said(command("tags", { name: "server-rules" }, "info"))).toMatch(new RegExp(`^Tag server-rules: made by <@${MEMBER}> <t:\\d+:R>, changed <t:\\d+:R>, used 1 times\\.$`));

    // Edit opens the form filled in.
    const edit = await (await signed(command("tags", { name: "server-rules" }, "edit", staff))).json();
    expect(edit.type).toBe(9);
    expect(edit.data.components[0].components[0].value).toBe("Be kind, {{user.mention}}.");
    expect(await said(modalSubmit("dc:tags:e-server-rules", { content: "Be very kind." }, staff))).toBe("Saved the tag server-rules.");
    expect((await answer(command("tag", { name: "server-rules" }))).content).toBe("Be very kind.");
    expect(await said(command("tags", { name: "missing" }, "edit", staff))).toBe("There is no tag called missing.");

    // The server's limit.
    expect(await said(modalSubmit("dc:tags:c-faq", { content: "Read the pins." }, staff))).toBe("Saved the tag faq.");
    expect(await said(modalSubmit("dc:tags:c-third", { content: "One too many." }, staff))).toBe("This server has 2 tags, the most it can have.");

    expect(await said(command("tags", { name: "faq" }, "delete"))).toBe("Only the staff can change tags.");
    expect(await said(command("tags", { name: "faq" }, "delete", staff))).toBe("Deleted the tag faq.");
    expect(await said(command("tag", { name: "faq" }))).toBe("There is no tag called faq.");
    expect(await said(command("tags", {}, "list"))).toBe("**Tags (1):** `server-rules`");
  });

  it("names are checked", () => {
    expect(tagName("  Hello World ")).toBe("hello-world");
    expect(tagName("a".repeat(31))).toBeNull();
    expect(tagName("bad/name")).toBeNull();
  });
});

// ── Autoresponder ───────────────────────────────────────────────────────────────────────────────

describe("kon-dc parity: autoresponder", () => {
  beforeAll(async () => {
    await enable("autoresponder", {
      rules: [
        { id: "hi", trigger: "good * morning", match: "word", response: "Morning, {{user.mention}}!", cooldownSeconds: 60, ignoredRoles: [ROLE] },
        { id: "rocket", trigger: "launch", match: "contains", reaction: "🚀", cooldownSeconds: 0, channels: [CHANNEL] },
        { id: "nolinks", trigger: "free nitro*", match: "starts_with", response: "No scams here.", deleteTrigger: true, cooldownSeconds: 0 },
      ],
    });
  });

  it("asks for Message Content, which only modules that read text declare", async () => {
    const cfg = await (await request(WORKER, "GET", "/gateway/config")).json();
    expect(cfg.intents & INTENTS.MESSAGE_CONTENT).toBeTruthy();
    expect(cfg.events).toContain("MESSAGE_CREATE");
  });

  it("answers the first rule that matches, with placeholders and a cooldown", async () => {
    await message("well, Good sunny Morning all");
    expect(sent()).toEqual([{ to: CHANNEL, body: `Morning, <@${MEMBER}>!` }]);
    expect(calls.some((c) => c.fn === "react")).toBe(false);
    await message("good rainy morning");
    expect(sent()).toEqual([]);
    clockOffsetMs += 61_000;
    await message("good rainy morning");
    expect(sent()).toHaveLength(1);
  });

  it("respects roles and channels, reacts, deletes the trigger, ignores bots", async () => {
    clockOffsetMs += 61_000;
    await message("good rainy morning", { roles: [ROLE] });
    expect(sent()).toEqual([]);

    const launch = await message("we launch today");
    expect(calls.find((c) => c.fn === "react")!.args).toEqual([CHANNEL, launch, "🚀"]);
    await message("we launch today", { channel: HIDDEN });
    expect(calls.some((c) => c.fn === "react")).toBe(false);

    const scam = await message("Free Nitro here: link");
    expect(sent()).toEqual([{ to: CHANNEL, body: "No scams here." }]);
    expect(calls.find((c) => c.fn === "deleteMessage")!.args).toEqual([CHANNEL, scam]);

    await message("free nitro", { bot: true });
    expect(calls).toHaveLength(0);
  });

  it("a rule needs a response or a reaction", async () => {
    const r = await request("staff", "PUT", `/guilds/${GUILD}/modules/autoresponder`, { enabled: true, config: { rules: [{ id: "x", trigger: "x" }] } });
    expect(r.status).toBe(422);
  });
});

// ── AFK ─────────────────────────────────────────────────────────────────────────────────────────

describe("kon-dc parity: afk", () => {
  beforeAll(async () => {
    await enable("afk", { nicknamePrefix: true, tellCooldownSeconds: 60 });
  });

  it("marks the member, tells who mentions them (without pinging), and welcomes them back", async () => {
    const r = await answer(command("afk", { reason: "lunch" }));
    expect(r.content).toBe("Ana is now AFK: lunch");
    expect(r.flags).toBe(0);
    await engine.idle();

    await message("hey <@444444444444444444> are you there?", { author: OTHER, mentions: [MEMBER] });
    const notice = sent();
    expect(notice).toHaveLength(1);
    expect(textOf(notice[0].body)).toMatch(/^\*\*Ana\*\* is AFK since <t:\d+:R>: lunch$/);
    expect(textOf(notice[0].body)).not.toContain(`<@${MEMBER}>`);

    // Not again in the same channel within the cooldown.
    await message("hello??", { author: OTHER, mentions: [MEMBER] });
    expect(sent()).toEqual([]);

    // The member writes: AFK ends, once.
    await message("back!");
    expect(sent()).toHaveLength(1);
    expect(textOf(sent()[0].body)).toMatch(new RegExp(`^Welcome back, <@${MEMBER}>\\. You were AFK since <t:\\d+:R>\\.$`));
    expect(calls.find((c) => c.fn === "editMember")!.args.slice(0, 3)).toEqual([GUILD, MEMBER, { nick: null }]);
    await message("still here");
    expect(sent()).toEqual([]);
    clockOffsetMs += 120_000;
    await message("ping <@444444444444444444>", { author: OTHER, mentions: [MEMBER] });
    expect(sent()).toEqual([]);
  });

  it("adds [AFK] to the nickname when the server wants it", async () => {
    calls.length = 0;
    await answer(command("afk"));
    const rename = await until(() => calls.find((c) => c.fn === "editMember"));
    expect(rename.args.slice(0, 3)).toEqual([GUILD, MEMBER, { nick: "[AFK] user-444" }]);
    await message("ok I am back");
  });
});

// ── Highlights ──────────────────────────────────────────────────────────────────────────────────

describe("kon-dc parity: highlights", () => {
  beforeAll(async () => {
    channels.set(HIDDEN, channel(HIDDEN, { overwrites: [{ id: GUILD, type: 0, allow: "0", deny: VIEW }] }));
    await enable("highlights", { cooldownMinutes: 5 });
  });

  it("adds, lists and removes words, up to 10", async () => {
    expect(await said(command("highlight", { word: "Kitsuden" }, "add"))).toBe("I will DM you when someone says kitsuden.");
    expect(await said(command("highlight", { word: "kitsuden" }, "add"))).toBe("You already follow kitsuden.");
    expect(await said(command("highlight", { word: "x" }, "add"))).toBe("A word is 2 to 32 characters, without *.");
    for (let i = 1; i < 10; i++) await said(command("highlight", { word: `word${i}` }, "add"));
    expect(await said(command("highlight", { word: "eleventh" }, "add"))).toBe("You follow 10 words, the most you can. Remove one first.");
    expect(await said(command("highlight", { word: "word9" }, "remove"))).toBe("Removed word9.");
    expect(await said(command("highlight", { word: "word9" }, "remove"))).toBe("You do not follow word9.");
    expect(await said(command("highlight", {}, "list"))).toMatch(/^You follow: `kitsuden`, `word1`/);
  });

  it("DMs the member when the word is said where they can see it, never for their own messages, with a cooldown", async () => {
    await message("I love kitsuden so much", { author: MEMBER });
    expect(sent()).toEqual([]);

    await message("Does anyone use Kitsuden?", { author: OTHER, channel: HIDDEN });
    expect(sent()).toEqual([]);

    await message("kitsudens are not the word", { author: OTHER });
    expect(sent()).toEqual([]);

    const asked = await message("Does anyone use Kitsuden?", { author: OTHER });
    const dms = sent();
    expect(dms).toHaveLength(1);
    expect(dms[0].to).toBe(`dm-${MEMBER}`);
    const embed = (dms[0].body as { embeds: Array<Record<string, any>> }).embeds[0];
    expect(embed.title).toBe("Someone said kitsuden");
    expect(embed.description).toBe("**Ana:** Does anyone use Kitsuden?");
    expect(embed.fields[0].value).toContain(`/channels/${GUILD}/${CHANNEL}/${asked}`);

    await message("kitsuden again", { author: OTHER });
    expect(sent()).toEqual([]);
    clockOffsetMs += 6 * 60_000;
    await message("kitsuden again", { author: OTHER });
    expect(sent()).toHaveLength(1);
  });
});

// ── Embeds ──────────────────────────────────────────────────────────────────────────────────────

describe("kon-dc parity: embed builder", () => {
  const POSTED = "830000000000000001";

  beforeAll(async () => {
    await enable("embeds", {});
    messages.set(POSTED, {
      id: POSTED,
      channelId: CHANNEL,
      authorId: BOT,
      authorName: "Bot",
      authorAvatar: null,
      authorBot: true,
      content: "",
      timestamp: "",
      attachments: [],
      embeds: [{ title: "Rules", description: "Be kind", color: 0x57f287, footer: { text: "The staff" } }],
      reactions: [],
    });
  });

  it("is hidden from members without the permission and refused to them", async () => {
    const cmds = (await (await request("staff", "GET", `/guilds/${GUILD}/commands`)).json()).docs as Array<{ name: string; default_member_permissions?: string }>;
    expect(cmds.find((c) => c.name === "embed")!.default_member_permissions).toBe(MANAGE_MESSAGES);
    expect(await said(command("embed", {}, "post"))).toBe("Only the staff can post embeds.");
  });

  it("posts what the form says, and checks it", async () => {
    const form = await (await signed(command("embed", {}, "post", staff))).json();
    expect(form.type).toBe(9);
    expect(form.data.components).toHaveLength(5);
    const id = form.data.custom_id as string;
    expect(id).toBe(`dc:embeds:p-${short(CHANNEL)}`);

    expect(await said(modalSubmit(id, { title: "", description: "" }, staff))).toBe("Give the embed a title or a description.");
    expect(await said(modalSubmit(id, { title: "Hi", color: "blue" }, staff))).toBe("A color is six hex digits, like #5865F2.");
    expect(await said(modalSubmit(id, { title: "Hi", image: "http://x.test/a.png" }, staff))).toBe("The image must be an https:// link.");
    expect(await said(modalSubmit(id, { title: "Hi", description: "Welcome", color: "#FF0000", image: "https://x.test/a.png", footer: "Staff" }, { permissions: "0" }))).toBe(
      "Only the staff can post embeds."
    );
    expect(await said(modalSubmit(id, { title: "Hi", description: "Welcome", color: "#FF0000", image: "https://x.test/a.png", footer: "Staff" }, staff))).toBe(`Posted in <#${CHANNEL}>.`);
    expect(sent()[0]).toEqual({
      to: CHANNEL,
      body: { embeds: [{ color: 0xff0000, title: "Hi", description: "Welcome", image: { url: "https://x.test/a.png" }, footer: { text: "Staff" } }] },
    });

    // A channel of another server is refused even if the form's id says so.
    channels.set("262626262626262626", channel("262626262626262626", { guildId: OTHER_GUILD }));
    expect(await said(modalSubmit(`dc:embeds:p-${short("262626262626262626")}`, { title: "Hi" }, staff))).toBe("That channel is not in this server.");
  });

  it("edits an embed the bot posted, filled in from the message", async () => {
    const link = `https://discord.com/channels/${GUILD}/${CHANNEL}/${POSTED}`;
    const form = await (await signed(command("embed", { link }, "edit", staff))).json();
    expect(form.type).toBe(9);
    const values = (form.data.components as Array<{ components: Array<{ custom_id: string; value?: string }> }>).map((r) => [r.components[0].custom_id, r.components[0].value]);
    expect(values).toEqual([
      ["title", "Rules"],
      ["description", "Be kind"],
      ["color", "#57F287"],
      ["image", undefined],
      ["footer", "The staff"],
    ]);
    expect(await said(modalSubmit(form.data.custom_id, { title: "Rules v2", description: "Be kind" }, staff))).toBe("Embed updated.");
    expect(calls.find((c) => c.fn === "editMessage")!.args.slice(0, 2)).toEqual([CHANNEL, POSTED]);

    expect(await said(command("embed", { link: `https://discord.com/channels/${OTHER_GUILD}/${CHANNEL}/${POSTED}` }, "edit", staff))).toBe(
      "That is not a link to a message in this server."
    );
    messages.set("830000000000000002", { ...messages.get(POSTED)!, id: "830000000000000002", authorId: MEMBER });
    expect(await said(command("embed", { link: `https://discord.com/channels/${GUILD}/${CHANNEL}/830000000000000002` }, "edit", staff))).toBe(
      "I can only edit messages I posted, in a channel I can read."
    );
  });

  it("links, ids and fields are parsed strictly", () => {
    expect(messageLink(`https://ptb.discord.com/channels/${GUILD}/${CHANNEL}/${POSTED}`)).toEqual({ guildId: GUILD, channelId: CHANNEL, messageId: POSTED });
    expect(messageLink(`https://evil.test/channels/${GUILD}/${CHANNEL}/${POSTED}`)).toBeNull();
    expect(messageLink(`https://discord.com/channels/${GUILD}/${CHANNEL}`)).toBeNull();
    expect(unshort(short(POSTED))).toBe(POSTED);
    expect(unshort("not-base36!")).toBeNull();
    expect(buildEmbed({ description: "x" })).toEqual({ embed: { color: 0x5865f2, description: "x" } });
  });
});

// ── Feeds: social presets ───────────────────────────────────────────────────────────────────────

describe("kon-dc parity: social feed presets", () => {
  it("turns YouTube, Reddit and Bluesky sources into their public feeds", () => {
    const yt = "UCabcdefghijklmnopqrstuv";
    expect(feedUrl({ kind: "youtube", source: yt })).toBe(`https://www.youtube.com/feeds/videos.xml?channel_id=${yt}`);
    expect(presetSource("youtube", `https://www.youtube.com/channel/${yt}/videos`)).toBe(yt);
    expect(presetSource("youtube", `https://evil.test/channel/${yt}`)).toBeNull();
    expect(presetSource("reddit", "r/discordapp")).toBe("discordapp");
    expect(presetSource("reddit", "https://www.reddit.com/r/discordapp/new/")).toBe("discordapp");
    expect(feedUrl({ kind: "reddit", source: "/r/discordapp" })).toBe("https://www.reddit.com/r/discordapp/new/.rss");
    expect(presetSource("bluesky", "@Kitsuden.bsky.social")).toBe("kitsuden.bsky.social");
    expect(presetSource("bluesky", "https://bsky.app/profile/kitsuden.bsky.social/post/3k")).toBe("kitsuden.bsky.social");
    expect(presetSource("bluesky", "did:plc:abcdefghijklmnopqrstuvwx")).toBe("did:plc:abcdefghijklmnopqrstuvwx");
    expect(presetSource("bluesky", "-bad-.bsky.social")).toBeNull();
    expect(presetSource("bluesky", "nodots")).toBeNull();
    expect(feedUrl({ kind: "bluesky", source: "kitsuden.bsky.social" })).toBe("https://bsky.app/profile/kitsuden.bsky.social/rss");
  });

  it("a Bluesky feed posts new posts, with their text as the title", async () => {
    const url = "https://bsky.app/profile/kitsuden.bsky.social/rss";
    const doc = (ids: string[]) =>
      `<rss><channel>${ids.map((id) => `<item><link>https://bsky.app/profile/kitsuden.bsky.social/post/${id}</link><description>Post ${id} text</description><guid>${id}</guid></item>`).join("")}</channel></rss>`;
    feedDocs.set(url, doc(["p1"]));
    expect((await request("staff", "PUT", `/guilds/${GUILD}/modules/feeds`, { enabled: true, config: { feeds: [{ id: "sky", kind: "bluesky", source: "x", channelId: CHANNEL }] } })).status).toBe(422);
    await enable("feeds", { feeds: [{ id: "sky", kind: "bluesky", source: "@kitsuden.bsky.social", channelId: CHANNEL }] });
    const poll = async () => {
      clockOffsetMs += 11 * 60_000;
      calls.length = 0;
      await engine.tick();
      await engine.idle();
      await new Promise((r) => setTimeout(r, 30));
      await engine.idle();
      return sent().map((s) => s.body);
    };
    await engine.tick();
    expect(await poll()).toEqual([]);
    feedDocs.set(url, doc(["p2", "p1"]));
    expect(await poll()).toEqual(["🦋 New post from @kitsuden.bsky.social:\nPost p2 text\nhttps://bsky.app/profile/kitsuden.bsky.social/post/p2"]);
  });
});

// ── Settings as forms ───────────────────────────────────────────────────────────────────────────

describe("kon-dc parity: settings the panel draws", () => {
  it("every new module's setting has a title", async () => {
    const modules = (await (await request("staff", "GET", "/modules")).json()).docs as Array<{ id: string; configSchema: { properties?: Record<string, { title?: string }> } }>;
    for (const id of ["starboard", "tags", "autoresponder", "afk", "highlights", "embeds"]) {
      const m = modules.find((x) => x.id === id);
      expect(m, id).toBeTruthy();
      for (const [key, prop] of Object.entries(m!.configSchema.properties ?? {})) expect(prop.title, `${id}.${key}`).toBeTruthy();
    }
  });
});

/**
 * kon-dc — community utilities that read messages
 * ============================================================================
 *
 *   autoresponder  rules: when a message matches a trigger (exact, contains, starts with, a whole
 *                  word; `*` stands for anything), answer with text or a reaction, in some channels
 *                  or for some roles, with a cooldown, optionally deleting the trigger
 *   afk            /afk [reason]: who mentions an AFK member is told so and since when; the next
 *                  message of the member ends it (a "welcome back" and an [AFK] nickname are options)
 *   highlights     /highlight add | remove | list: a DM when a word appears in a channel the member
 *                  can see (never their own messages, a cooldown per member, up to 10 words)
 *
 * Reading message text needs Discord's privileged Message Content intent: the autoresponder and
 * highlights ask for it. AFK does not: Discord sends who a message pings without it.
 *
 * Triggers are matched with plain string search (`indexOf`), never with a regular expression built
 * from what the staff or a member typed: nothing here can backtrack.
 */

import { z } from "zod";

import { INTENTS, LocalId, Snowflake } from "./dc.contract";
import { baseVars, clip, defineDcModule, messageOf, registerDcModule, render, type DcModule, type ModuleRuntime, type Reply } from "./dc.modules";
import type { ChannelInfo, DiscordRest } from "./dc.rest";

const ME = (text: string): Reply => ({ content: clip(text), ephemeral: true });

// ── Matching without regular expressions ────────────────────────────────────────────────────────

export type MatchKind = "exact" | "contains" | "starts_with" | "word";

/** Letters, digits and `_` belong to a word (one character, a fixed pattern: linear). */
const isWordChar = (c: string | undefined) => c !== undefined && c !== "" && /[\p{L}\p{N}_]/u.test(c);

/** Longest text looked at: a match costs at most a few passes over it. */
const MAX_TEXT = 4000;

/**
 * Whether `text` matches `trigger` (both compared in lower case). `*` in the trigger stands for any
 * run of characters, empty included. `exact` is the whole message, `starts_with` its beginning,
 * `contains` anywhere, `word` anywhere between word boundaries.
 *
 * Literal pieces are found with `indexOf` from left to right. The leftmost place of each piece is
 * always the best one for the pieces after it, so no choice is ever undone: the work is linear in
 * the text for each piece, whatever anyone typed.
 */
export function matchesTrigger(text: string, trigger: string, kind: MatchKind): boolean {
  const t = text.slice(0, MAX_TEXT).toLowerCase();
  const parts = trigger.toLowerCase().split("*");
  if (parts.every((p) => p === "")) return t.trim() !== "";
  const anchorStart = kind === "exact" || kind === "starts_with";
  const anchorEnd = kind === "exact";
  const bounded = kind === "word";
  const first = parts[0];
  const last = parts[parts.length - 1];
  const middle = parts.slice(1, -1);

  const startOk = (s: number) => !bounded || !isWordChar(t[s - 1]);
  const endOk = (e: number) => !bounded || !isWordChar(t[e]);

  // Without a `*`, the match is the trigger itself: try each place it starts.
  if (parts.length === 1) {
    if (anchorStart) return t.startsWith(first) && (anchorEnd ? t.length === first.length : endOk(first.length));
    for (let s = t.indexOf(first); s !== -1; s = t.indexOf(first, s + 1)) {
      if (startOk(s) && endOk(s + first.length)) return true;
    }
    return false;
  }

  // With a `*`, the leftmost start that may begin a match is the best one: a later start only
  // leaves less room for the pieces after it. A leading `*` starts at 0.
  let s = anchorStart || first === "" ? 0 : t.indexOf(first);
  while (s !== -1 && !startOk(s)) s = t.indexOf(first, s + 1);
  if (s === -1 || !t.startsWith(first, s)) return false;
  let pos = s + first.length;
  for (const piece of middle) {
    const at = t.indexOf(piece, pos);
    if (at === -1) return false;
    pos = at + piece.length;
  }
  // A trailing `*` takes the rest, and the end of the text ends a word.
  if (last === "") return true;
  if (anchorEnd) return t.length - last.length >= pos && t.endsWith(last);
  // With boundaries the last piece may need a later place, one that ends a word.
  for (let at = t.indexOf(last, pos); at !== -1; at = t.indexOf(last, at + 1)) {
    if (endOk(at + last.length)) return true;
  }
  return false;
}

const nowMs = (rt: ModuleRuntime) => rt.now().getTime();

async function readJson<T>(rt: ModuleRuntime, key: string, fallback: T): Promise<T> {
  const raw = await rt.kv.get(key);
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ── Autoresponder ───────────────────────────────────────────────────────────────────────────────

const Rule = z
  .object({
    id: LocalId.meta({ title: "Id" }),
    trigger: z.string().min(1).max(200).meta({ title: "Trigger", description: "What to look for; * stands for anything (good * morning)" }),
    match: z.enum(["exact", "contains", "starts_with", "word"]).default("word").meta({ title: "Match", description: "exact message, contains, starts with, or a whole word" }),
    response: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .meta({ title: "Response", description: "{{user.mention}} {{user.name}} {{channel.mention}} are filled in" }),
    reaction: z.string().min(1).max(64).optional().meta({ title: "Reaction", description: "A unicode emoji, or name:id for a custom one" }),
    channels: z.array(Snowflake).max(50).default([]).meta({ title: "Only in these channels", description: "Empty = every channel" }),
    ignoredChannels: z.array(Snowflake).max(50).default([]).meta({ title: "Never in these channels" }),
    roles: z.array(Snowflake).max(50).default([]).meta({ title: "Only for these roles", description: "Empty = everyone" }),
    ignoredRoles: z.array(Snowflake).max(50).default([]).meta({ title: "Never for these roles" }),
    cooldownSeconds: z.number().int().min(0).max(86_400).default(10).meta({ title: "Cooldown in seconds", description: "Per rule and channel" }),
    deleteTrigger: z.boolean().default(false).meta({ title: "Delete the message that triggered it", description: "Needs Manage Messages" }),
  })
  .strict()
  .refine((r) => r.response || r.reaction, { message: "Give a response, a reaction, or both" });
type Rule = z.output<typeof Rule>;

const AutoresponderConfig = z
  .object({
    rules: z
      .array(Rule)
      .min(1)
      .max(50)
      .refine((r) => new Set(r.map((x) => x.id)).size === r.length, { message: "Two rules with the same id" })
      .meta({ title: "Rules", description: "The first rule that matches answers" }),
  })
  .strict();

function ruleApplies(rule: Rule, channelId: string, roles: string[]): boolean {
  if (rule.channels.length && !rule.channels.includes(channelId)) return false;
  if (rule.ignoredChannels.includes(channelId)) return false;
  if (rule.roles.length && !rule.roles.some((r) => roles.includes(r))) return false;
  if (rule.ignoredRoles.some((r) => roles.includes(r))) return false;
  return true;
}

export const autoresponderModule = defineDcModule({
  id: "autoresponder",
  name: "Autoresponder",
  description: "Answers messages that match a trigger with text or a reaction (exact, contains, starts with, a word; * for anything).",
  config: AutoresponderConfig,
  intents: INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT,
  events: ["MESSAGE_CREATE"],
  async onEvent(event, config, rt) {
    if (event.type !== "MESSAGE_CREATE" || event.isBot || !event.user || !event.channelId || !event.messageId || !event.content) return;
    const channelId = event.channelId;
    const roles = event.memberRoles ?? [];
    const rule = config.rules.find((r) => ruleApplies(r, channelId, roles) && matchesTrigger(event.content!, r.trigger, r.match));
    if (!rule) return;
    if (rule.cooldownSeconds > 0) {
      const key = `cd:${rule.id}:${channelId}`;
      const last = Number(await rt.kv.get(key)) || 0;
      if (nowMs(rt) - last < rule.cooldownSeconds * 1000) return;
      await rt.kv.set(key, nowMs(rt));
    }
    try {
      if (rule.reaction && !rule.deleteTrigger) await rt.rest.react(channelId, event.messageId, rule.reaction);
      if (rule.response) await rt.rest.sendMessage(channelId, clip(render(rule.response, baseVars(rt))));
      if (rule.deleteTrigger) await rt.rest.deleteMessage(channelId, event.messageId);
    } catch (err) {
      rt.logger.warn("Autoresponder: Discord refused", { rule: rule.id, message: messageOf(err) });
    }
    rt.emit("dc:autoresponder:matched", { guildId: rt.guildId, ruleId: rule.id, channelId, userId: event.user.id });
  },
});

// ── AFK ─────────────────────────────────────────────────────────────────────────────────────────

const AfkConfig = z
  .object({
    welcomeBack: z.boolean().default(true).meta({ title: "Say welcome back", description: "When an AFK member writes again" }),
    nicknamePrefix: z.boolean().default(false).meta({ title: "Add [AFK] to the nickname", description: "Needs Manage Nicknames; never works on the server's owner" }),
    tellCooldownSeconds: z
      .number()
      .int()
      .min(0)
      .max(3600)
      .default(60)
      .meta({ title: "Seconds between two notices", description: "For the same AFK member in the same channel" }),
  })
  .strict();

interface AfkState {
  reason: string;
  since: number;
  name: string;
  /** The nickname before [AFK] was added (null: none); undefined when it was not changed. */
  nick?: string | null;
}

const AFK_PREFIX = "[AFK] ";

async function endAfk(rt: ModuleRuntime, userId: string): Promise<AfkState | null> {
  // Leaving the list is the claim: of two messages at once, only one ends the AFK.
  if (!(await rt.lists.leave("afk", userId))) return null;
  const state = await readJson<AfkState | null>(rt, `afk:${userId}`, null);
  await rt.kv.set(`afk:${userId}`, "");
  if (state && state.nick !== undefined) {
    await rt.rest.editMember(rt.guildId, userId, { nick: state.nick }, "No longer AFK").catch(() => undefined);
  }
  return state;
}

export const afkModule = defineDcModule({
  id: "afk",
  name: "AFK",
  description: "/afk [reason]: whoever mentions you is told you are away and since when; your next message ends it.",
  config: AfkConfig,
  intents: INTENTS.GUILD_MESSAGES,
  events: ["MESSAGE_CREATE"],
  commands: () => [
    {
      name: "afk",
      description: "Mark yourself as away",
      type: 1,
      options: [{ name: "reason", description: "Why (shown to who mentions you)", type: 3, max_length: 200 }],
    },
  ],
  plan: () => ({ reply: true, ephemeral: false }),

  async onCommand(invocation, config, rt) {
    if (invocation.name !== "afk" || !rt.user) return null;
    const user = rt.user;
    const reason = String(invocation.options.reason ?? "").trim().slice(0, 200);
    const state: AfkState = { reason, since: nowMs(rt), name: user.name };
    const old = await readJson<AfkState | null>(rt, `afk:${user.id}`, null);
    if (config.nicknamePrefix) {
      if (old && old.nick !== undefined) state.nick = old.nick;
      else {
        try {
          const m = await rt.rest.getMember(rt.guildId, user.id);
          const shown = m.nick ?? m.user?.name ?? user.name;
          if (!shown.startsWith(AFK_PREFIX)) {
            await rt.rest.editMember(rt.guildId, user.id, { nick: clip(`${AFK_PREFIX}${shown}`, 32) }, "AFK");
            state.nick = m.nick;
          }
        } catch {
          /* the owner, or a member above the bot: the nickname stays */
        }
      }
    }
    await rt.kv.set(`afk:${user.id}`, JSON.stringify(state));
    await rt.lists.join("afk", user.id);
    return { content: clip(reason ? rt.t("{who} is now AFK: {reason}", { who: user.name, reason }) : rt.t("{who} is now AFK.", { who: user.name })) };
  },

  async onEvent(event, config, rt) {
    if (event.type !== "MESSAGE_CREATE" || event.isBot || !event.user || !event.channelId) return;
    const author = event.user;
    const channelId = event.channelId;

    const back = await endAfk(rt, author.id);
    if (back && config.welcomeBack) {
      await rt.rest
        .sendMessage(channelId, rt.t("Welcome back, <@{who}>. You were AFK since <t:{at}:R>.", { who: author.id, at: Math.floor(back.since / 1000) }))
        .catch(() => undefined);
    }

    const pinged = [...new Set(event.mentions ?? [])].filter((id) => id !== author.id).slice(0, 5);
    const lines: string[] = [];
    for (const id of pinged) {
      if (!(await rt.lists.has("afk", id))) continue;
      const state = await readJson<AfkState | null>(rt, `afk:${id}`, null);
      if (!state) continue;
      if (config.tellCooldownSeconds > 0) {
        const key = `told:${id}:${channelId}`;
        const last = Number(await rt.kv.get(key)) || 0;
        if (nowMs(rt) - last < config.tellCooldownSeconds * 1000) continue;
        await rt.kv.set(key, nowMs(rt));
      }
      // By name, not a mention: the notice must not ping the member who is away.
      const at = Math.floor(state.since / 1000);
      lines.push(
        state.reason
          ? rt.t("**{who}** is AFK since <t:{at}:R>: {reason}", { who: state.name, at, reason: state.reason })
          : rt.t("**{who}** is AFK since <t:{at}:R>.", { who: state.name, at })
      );
    }
    if (lines.length) await rt.rest.sendMessage(channelId, clip(lines.join("\n"))).catch(() => undefined);
  },
});

// ── Highlights ──────────────────────────────────────────────────────────────────────────────────

/** Discord's hard cap per member, like Carl-bot's. */
export const MAX_HIGHLIGHTS = 10;

const HighlightsConfig = z
  .object({
    cooldownMinutes: z.number().int().min(0).max(1440).default(5).meta({ title: "Minutes between two DMs", description: "Per member" }),
    ignoredChannels: z.array(Snowflake).max(100).default([]).meta({ title: "Never in these channels" }),
  })
  .strict();

const VIEW_CHANNEL = 1n << 10n;
const ADMINISTRATOR = 1n << 3n;
const THREADS = new Set([10, 11, 12]);
const PRIVATE_THREAD = 12;

/** A word or short phrase as stored: lower case, single spaces, 2–32 characters. */
export function highlightWord(value: unknown): string | null {
  const w = String(value ?? "")
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .join(" ");
  if (w.length < 2 || w.length > 32) return null;
  if (w.includes("*")) return null;
  return w;
}

const big = (v: string) => {
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
};

/** What a message's handling reads once and shares between members. */
interface ViewCache {
  channel?: Promise<ChannelInfo | null>;
  roles?: Promise<Map<string, bigint>>;
  owner?: Promise<string | null>;
}

/**
 * Whether a member can see a channel, the way Discord computes it: @everyone and the member's roles,
 * then the channel's overwrites (@everyone, roles, the member). A thread follows its parent; a
 * private thread is never assumed visible.
 */
export async function canView(rest: DiscordRest, guildId: string, channelId: string, userId: string, cache: ViewCache = {}): Promise<boolean> {
  cache.channel ??= (async () => {
    let c = await rest.getChannel(channelId).catch(() => null);
    if (c && THREADS.has(c.type)) {
      if (c.type === PRIVATE_THREAD || !c.parentId) return null;
      c = await rest.getChannel(c.parentId).catch(() => null);
    }
    return c;
  })();
  cache.roles ??= rest
    .listRoles(guildId)
    .then((rs) => new Map(rs.map((r) => [r.id, big(r.permissions)])))
    .catch(() => new Map());
  cache.owner ??= rest.getGuildOwner(guildId).catch(() => null);
  const channel = await cache.channel;
  if (!channel || (channel.guildId && channel.guildId !== guildId)) return false;
  if ((await cache.owner) === userId) return true;
  const member = await rest.getMember(guildId, userId).catch(() => null);
  if (!member) return false;
  const roles = await cache.roles;
  let perms = roles.get(guildId) ?? 0n;
  for (const r of member.roles) perms |= roles.get(r) ?? 0n;
  if (perms & ADMINISTRATOR) return true;
  const everyone = channel.overwrites.find((o) => o.id === guildId);
  if (everyone) perms = (perms & ~big(everyone.deny)) | big(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of channel.overwrites) {
    if (o.type === 0 && o.id !== guildId && member.roles.includes(o.id)) {
      allow |= big(o.allow);
      deny |= big(o.deny);
    }
  }
  perms = (perms & ~deny) | allow;
  const own = channel.overwrites.find((o) => o.type === 1 && o.id === userId);
  if (own) perms = (perms & ~big(own.deny)) | big(own.allow);
  return (perms & VIEW_CHANNEL) === VIEW_CHANNEL;
}

const listOf = (word: string) => `w:${word}`;

export const highlightsModule = defineDcModule({
  id: "highlights",
  name: "Highlights",
  description: "/highlight add: a DM when a word you follow is said in a channel you can see (up to 10 words).",
  config: HighlightsConfig,
  intents: INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT,
  events: ["MESSAGE_CREATE"],
  commands: () => [
    {
      name: "highlight",
      description: "Get a DM when a word is said",
      type: 1,
      options: [
        {
          name: "add",
          description: "Follow a word",
          type: 1,
          options: [{ name: "word", description: "A word or short phrase", type: 3, required: true, min_length: 2, max_length: 32 }],
        },
        {
          name: "remove",
          description: "Stop following a word",
          type: 1,
          options: [{ name: "word", description: "A word or short phrase", type: 3, required: true, min_length: 2, max_length: 32 }],
        },
        { name: "list", description: "The words you follow", type: 1 },
      ],
    },
  ],
  plan: () => ({ reply: true, ephemeral: true }),

  async onCommand(invocation, _config, rt) {
    if (invocation.name !== "highlight" || !rt.user) return null;
    const userId = rt.user.id;
    const mine = await readJson<string[]>(rt, `mine:${userId}`, []);
    if (invocation.subcommand === "list") {
      return ME(mine.length ? rt.t("You follow: {words}", { words: mine.map((w) => `\`${w}\``).join(", ") }) : rt.t("You follow no words yet."));
    }
    const word = highlightWord(invocation.options.word);
    if (!word) return ME(rt.t("A word is 2 to 32 characters, without *."));
    if (invocation.subcommand === "add") {
      if (mine.includes(word)) return ME(rt.t("You already follow {word}.", { word }));
      if (mine.length >= MAX_HIGHLIGHTS) return ME(rt.t("You follow {n} words, the most you can. Remove one first.", { n: MAX_HIGHLIGHTS }));
      await rt.lists.join(listOf(word), userId);
      await rt.kv.set(`mine:${userId}`, JSON.stringify([...mine, word]));
      const index = await readJson<string[]>(rt, "index", []);
      if (!index.includes(word)) await rt.kv.set("index", JSON.stringify([...index, word]));
      return ME(rt.t("I will DM you when someone says {word}.", { word }));
    }
    if (invocation.subcommand === "remove") {
      if (!mine.includes(word)) return ME(rt.t("You do not follow {word}.", { word }));
      await rt.lists.leave(listOf(word), userId);
      await rt.kv.set(`mine:${userId}`, JSON.stringify(mine.filter((w) => w !== word)));
      if ((await rt.lists.count(listOf(word))) === 0) {
        const index = await readJson<string[]>(rt, "index", []);
        await rt.kv.set("index", JSON.stringify(index.filter((w) => w !== word)));
      }
      return ME(rt.t("Removed {word}.", { word }));
    }
    return null;
  },

  async onEvent(event, config, rt) {
    if (event.type !== "MESSAGE_CREATE" || event.isBot || !event.user || !event.channelId || !event.messageId || !event.content) return;
    if (config.ignoredChannels.includes(event.channelId)) return;
    const index = await readJson<string[]>(rt, "index", []);
    if (!index.length) return;
    const content = event.content;
    const said = index.filter((w) => matchesTrigger(content, w, "word"));
    if (!said.length) return;

    const author = event.user;
    const channelId = event.channelId;
    const link = `https://discord.com/channels/${rt.guildId}/${channelId}/${event.messageId}`;
    const cache: ViewCache = {};
    const told = new Set<string>([author.id]);
    let sent = 0;
    for (const word of said) {
      for (const userId of await rt.lists.members(listOf(word), 200)) {
        if (told.has(userId) || sent >= 20) continue;
        told.add(userId);
        const key = `cd:${userId}`;
        const last = Number(await rt.kv.get(key)) || 0;
        if (config.cooldownMinutes > 0 && nowMs(rt) - last < config.cooldownMinutes * 60_000) continue;
        if (!(await canView(rt.rest, rt.guildId, channelId, userId, cache))) continue;
        await rt.kv.set(key, nowMs(rt));
        sent++;
        try {
          const dm = await rt.rest.openDm(userId);
          await rt.rest.sendMessage(dm, {
            embeds: [
              {
                title: clip(rt.t("Someone said {word}", { word }), 256),
                description: clip(`**${author.name}:** ${content}`, 1500),
                color: 0xfee75c,
                fields: [{ name: rt.t("Where it was said"), value: `<#${channelId}> · [${rt.t("Jump to the message")}](${link})` }],
                timestamp: rt.now().toISOString(),
              },
            ],
          });
        } catch {
          /* closed DMs */
        }
      }
    }
  },
});

export const UTILITY_MODULES: DcModule[] = [autoresponderModule as DcModule, afkModule as DcModule, highlightsModule as DcModule];
for (const m of UTILITY_MODULES) registerDcModule(m);

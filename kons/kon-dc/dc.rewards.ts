/**
 * kon-dc — built-in modules for rewards and interactivity
 * ============================================================================
 *
 *   economy             coins: /balance /daily (streaks) /work /pay /shop (a select to buy) /buy
 *                       /inventory /leaderboard, and /economy give|take for the staff
 *   leveling            XP for chatting, level-up messages, role rewards per level, coins per level,
 *                       XP multipliers by role, channels and roles that give none; /rank /levels
 *   giveaways           /giveaway start|end|reroll: an Enter button with a live count, a timer, fair
 *                       random winners, an optional role requirement and coins for the winners
 *   role-menus          panels of buttons or a select that give and take roles (toggle or one-of)
 *   reminders           /remind: a DM (or a message here) after a while
 *   scheduled-messages  messages posted every N minutes or at a time of day
 *   suggestions         /suggest: a card with 👍 👎 and a thread to discuss it
 *   polls               /poll: Discord's own poll
 *
 * Coins and XP live in the server's shared economy (`rt.economy`): the currency `coins` the
 * Economy module shows is the one blueprints give with `wallet_add`, and `xp` is the one Levels
 * counts. Each module reads only its own state (`rt.kv`, `rt.lists`).
 */

import { randomInt, randomUUID } from "node:crypto";

import { z } from "zod";

import { INTENTS, LocalId, Snowflake, WEEKDAYS, type Choice, type Schedule } from "./dc.contract";
import {
  baseVars,
  clip,
  customId,
  defineDcModule,
  duration,
  hasPermissions,
  levelOf,
  xpFor,
  messageOf,
  permissionBits,
  registerDcModule,
  render,
  type DcModule,
  type ModuleRuntime,
  type Reply,
} from "./dc.modules";
import type { MessagePayload } from "./dc.rest";

// ── Shared helpers ──────────────────────────────────────────────────────────────────────────────

const ME = (text: string): Reply => ({ content: clip(text), ephemeral: true });
const number = (n: number) => new Intl.NumberFormat("en-US").format(n);
const BLURPLE = 0x5865f2;
const GOLD = 0xf1c40f;
const GREEN = 0x57f287;

/** A user option's id (Discord sends the id as the value). */
const idOf = (v: unknown) => (typeof v === "string" && /^\d{15,20}$/.test(v) ? v : null);

const ItemIdSchema = z.string().regex(/^[a-z0-9_-]{1,64}$/, "Lowercase letters, digits, _ and - (up to 64)");
const Emoji = z.string().min(1).max(64);

const MANAGE_GUILD = permissionBits(["manage_guild"]);

const dayOf = (d: Date) => Math.floor(d.getTime() / 86_400_000);

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "A colour as #rrggbb");
/** Card colours a module lets the server choose. */
const cardSettings = {
  cardAccent: Hex.optional().meta({ title: "Card accent colour", description: "#rrggbb: the bar, the highlights" }),
  cardBackground: Hex.optional().meta({ title: "Card background colour", description: "#rrggbb" }),
};
const themeOf = (c: { cardAccent?: string; cardBackground?: string }) => ({ accent: c.cardAccent, background: c.cardBackground });

// ── Economy ─────────────────────────────────────────────────────────────────────────────────────

const ShopItem = z
  .object({
    id: ItemIdSchema.meta({ title: "Item id", description: "Lowercase, e.g. vip-pass; what inventories count" }),
    name: z.string().min(1).max(80).meta({ title: "Name" }),
    price: z.number().int().min(0).max(1_000_000_000).meta({ title: "Price" }),
    description: z.string().max(100).optional().meta({ title: "Description" }),
    emoji: Emoji.optional().meta({ title: "Emoji" }),
    roleId: Snowflake.optional().meta({ title: "Role it gives", description: "Optional; the bot's role must be above it" }),
    stock: z.number().int().min(1).max(1_000_000).optional().meta({ title: "Stock", description: "How many can be sold; empty = unlimited" }),
    oncePerMember: z.boolean().default(false).meta({ title: "One per member" }),
  })
  .strict();

const EconomyConfig = z
  .object({
    currencyName: z.string().min(1).max(32).default("coins").meta({ title: "Currency name", description: "What members read: coins, gems, tickets…" }),
    symbol: Emoji.default("🪙").meta({ title: "Symbol" }),
    dailyAmount: z.number().int().min(0).max(1_000_000).default(100).meta({ title: "Daily amount", description: "What /daily gives; 0 switches /daily off" }),
    streakBonus: z.number().int().min(0).max(1_000_000).default(10).meta({ title: "Streak bonus", description: "Extra per day in a row" }),
    streakMax: z.number().int().min(1).max(365).default(7).meta({ title: "Longest streak counted (days)" }),
    workMin: z.number().int().min(0).max(1_000_000).default(10).meta({ title: "Work: least" }),
    workMax: z.number().int().min(0).max(1_000_000).default(50).meta({ title: "Work: most", description: "0 switches /work off" }),
    workCooldownMinutes: z.number().int().min(1).max(10_080).default(60).meta({ title: "Work cooldown (minutes)" }),
    workMessages: z
      .array(z.string().min(1).max(200))
      .max(20)
      .default(["You streamed for a while and earned {{amount}}.", "You coached a newcomer: +{{amount}}.", "You won a casual bracket: +{{amount}}."])
      .meta({ title: "Work messages", description: "{{amount}} is what they earned" }),
    transfers: z.boolean().default(true).meta({ title: "Members can /pay each other" }),
    shop: z.array(ShopItem).max(25).default([]).meta({ title: "Shop", description: "What /shop sells" }),
    ...cardSettings,
  })
  .strict();
type EconomyConfig = z.output<typeof EconomyConfig>;

const COINS = "coins";

async function buy(item: z.output<typeof ShopItem>, config: EconomyConfig, rt: ModuleRuntime): Promise<Reply> {
  const user = rt.user!;
  if (item.oncePerMember && (await rt.economy.items(user.id)).some((i) => i.item === item.id)) {
    return ME(rt.t("You already have **{item}**.", { item: item.name }));
  }
  if (item.stock !== undefined) {
    const sold = Number((await rt.kv.get(`sold:${item.id}`)) ?? 0);
    if (sold >= item.stock) return ME(rt.t("**{item}** is sold out.", { item: item.name }));
  }
  const left = await rt.economy.take(user.id, COINS, item.price);
  if (left === null) {
    const { balance } = await rt.economy.get(user.id, COINS);
    return ME(rt.t("**{item}** costs {symbol} {price}; you have {balance}.", { item: item.name, symbol: config.symbol, price: number(item.price), balance: number(balance) }));
  }
  if (item.stock !== undefined) await rt.kv.incr(`sold:${item.id}`, 1);
  await rt.economy.addItem(user.id, item.id, 1);
  if (item.roleId) {
    try {
      await rt.rest.addRole(rt.guildId, user.id, item.roleId);
    } catch (err) {
      rt.logger.warn("Economy: the shop could not give a role", { item: item.id, message: messageOf(err) });
    }
  }
  return ME(rt.t("You bought **{item}** for {symbol} {price}. {symbol} {left} left.", { item: item.name, symbol: config.symbol, price: number(item.price), left: number(left) }));
}

function shopMessage(config: EconomyConfig, rt: Pick<ModuleRuntime, "t">): MessagePayload {
  const lines = config.shop.map((i) => `${i.emoji ?? "•"} **${i.name}** — ${config.symbol} ${number(i.price)}${i.description ? `\n   ${i.description}` : ""}`);
  return {
    embeds: [{ title: `🛒 ${rt.t("Shop")}`, description: clip(lines.join("\n") || rt.t("Nothing for sale yet."), 4000), color: GOLD }],
    components: config.shop.length
      ? [
          {
            type: 1,
            components: [
              {
                type: 3,
                custom_id: customId("economy", "buy"),
                placeholder: rt.t("Buy something"),
                options: config.shop.map((i) => ({
                  label: clip(`${i.name} — ${number(i.price)}`, 100),
                  value: i.id,
                  ...(i.description ? { description: clip(i.description, 100) } : {}),
                  ...(i.emoji ? { emoji: { name: i.emoji } } : {}),
                })),
              },
            ],
          },
        ]
      : [],
  };
}

export const economyModule = defineDcModule({
  id: "economy",
  name: "Economy",
  description: "Coins with /daily (streaks), /work, /pay, a /shop that sells items and roles, /inventory and a /leaderboard.",
  config: EconomyConfig,
  intents: 0,
  events: [],
  commands: (config) => [
    { name: "balance", description: `Your ${config.currencyName}`, type: 1, options: [{ name: "member", description: "Someone else", type: 6 }] },
    ...(config.dailyAmount > 0 ? [{ name: "daily", description: `Collect your daily ${config.currencyName}`, type: 1 as const }] : []),
    ...(config.workMax > 0 ? [{ name: "work", description: `Work for ${config.currencyName}`, type: 1 as const }] : []),
    ...(config.transfers
      ? [
          {
            name: "pay",
            description: `Give ${config.currencyName} to a member`,
            type: 1 as const,
            options: [
              { name: "member", description: "Who", type: 6, required: true },
              { name: "amount", description: "How many", type: 4, required: true, min_value: 1 },
            ],
          },
        ]
      : []),
    { name: "shop", description: "What you can buy", type: 1 },
    {
      name: "buy",
      description: "Buy from the shop",
      type: 1,
      options: [{ name: "item", description: "What", type: 3, required: true, autocomplete: true }],
    },
    { name: "inventory", description: "What you own", type: 1, options: [{ name: "member", description: "Someone else", type: 6 }] },
    { name: "leaderboard", description: `Who has the most ${config.currencyName}`, type: 1 },
    {
      name: "economy",
      description: "Staff: give or take coins",
      type: 1,
      default_member_permissions: MANAGE_GUILD,
      options: ["give", "take"].map((name) => ({
        name,
        description: `${name === "give" ? "Give" : "Take"} ${config.currencyName}`,
        type: 1,
        options: [
          { name: "member", description: "Who", type: 6, required: true },
          { name: "amount", description: "How many", type: 4, required: true, min_value: 1 },
        ],
      })),
    },
  ],
  plan: (target) => ({ reply: true, ephemeral: target.kind !== "command" || !["leaderboard", "shop", "pay"].includes(target.name) }),

  async onAutocomplete(request, config) {
    const typed = request.focused.toLowerCase();
    return config.shop
      .filter((i) => i.name.toLowerCase().includes(typed) || i.id.includes(typed))
      .slice(0, 25)
      .map((i): Choice => ({ name: clip(`${i.name} — ${number(i.price)}`, 100), value: i.id }));
  },

  async onComponent(use, config, rt) {
    if (use.id !== "buy" || !rt.user) return null;
    const item = config.shop.find((i) => i.id === use.values[0]);
    return item ? buy(item, config, rt) : ME(rt.t("That item is not sold any more."));
  },

  async onCommand(invocation, config, rt) {
    const user = rt.user;
    if (!user) return null;
    const sym = config.symbol;
    switch (invocation.name) {
      case "balance": {
        const who = idOf(invocation.options.member) ?? user.id;
        const { balance, rank } = await rt.economy.get(who, COINS);
        const text = rt.t("<@{who}> has {symbol} **{balance}** {currency} (#{rank} in the server).", { who, symbol: sym, balance: number(balance), currency: config.currencyName, rank });
        const streak = Number((await rt.kv.get(`streak:${who}`)) ?? 0);
        const items = (await rt.economy.items(who)).reduce((n, i) => n + i.quantity, 0);
        const lines = [streak > 1 ? rt.t("{n}-day streak", { n: streak }) : "", items ? rt.t(items === 1 ? "{n} item" : "{n} items", { n: number(items) }) : ""].filter(Boolean);
        const card = await rt.cards.wallet({ user: who, currencyName: config.currencyName, balance, rank, lines, theme: themeOf(config) });
        return card ? { content: text, files: [card], ephemeral: true } : ME(text);
      }
      case "daily": {
        const today = dayOf(rt.now());
        const last = Number((await rt.kv.get(`daily:${user.id}`)) ?? -1);
        if (last === today) {
          const next = (today + 1) * 86_400;
          return ME(rt.t("You already collected today. Come back <t:{next}:R>.", { next }));
        }
        const streak = last === today - 1 ? Number((await rt.kv.get(`streak:${user.id}`)) ?? 0) + 1 : 1;
        await rt.kv.set(`daily:${user.id}`, today);
        await rt.kv.set(`streak:${user.id}`, streak);
        const amount = config.dailyAmount + config.streakBonus * (Math.min(streak, config.streakMax) - 1);
        const balance = await rt.economy.add(user.id, COINS, amount);
        const fire = streak > 1 ? ` 🔥 ${rt.t("{n}-day streak!", { n: streak })}` : "";
        return ME(`+${sym} **${number(amount)}**${fire} ${rt.t("You have {symbol} {balance}.", { symbol: sym, balance: number(balance) })}`);
      }
      case "work": {
        const key = `work:${user.id}`;
        const last = Number((await rt.kv.get(key)) ?? 0);
        const now = Math.floor(rt.now().getTime() / 1000);
        const wait = config.workCooldownMinutes * 60 - (now - last);
        if (wait > 0) return ME(rt.t("You are tired. Work again in {time}.", { time: duration(wait) }));
        await rt.kv.set(key, now);
        const amount = randomInt(Math.min(config.workMin, config.workMax), Math.max(config.workMin, config.workMax) + 1);
        const balance = await rt.economy.add(user.id, COINS, amount);
        const line = config.workMessages[randomInt(0, Math.max(1, config.workMessages.length))] ?? "+{{amount}}";
        return ME(`${render(line, { amount: `${sym} ${number(amount)}` })} ${rt.t("You have {symbol} {balance}.", { symbol: sym, balance: number(balance) })}`);
      }
      case "pay": {
        const to = idOf(invocation.options.member);
        const amount = Math.trunc(Number(invocation.options.amount));
        if (!to || to === user.id) return ME(rt.t("Pick another member."));
        if (!Number.isFinite(amount) || amount < 1) return ME(rt.t("Pay at least 1."));
        const left = await rt.economy.take(user.id, COINS, amount);
        if (left === null) return ME(rt.t("You do not have {symbol} {amount}.", { symbol: sym, amount: number(amount) }));
        await rt.economy.add(to, COINS, amount);
        return { content: rt.t("{name} paid <@{to}> {symbol} **{amount}**.", { name: user.name, to, symbol: sym, amount: number(amount) }) };
      }
      case "shop":
        return { ...shopMessage(config, rt) };
      case "buy": {
        const want = String(invocation.options.item ?? "").toLowerCase();
        const item = config.shop.find((i) => i.id === want || i.name.toLowerCase() === want);
        return item ? buy(item, config, rt) : ME(rt.t("There is no such item in the shop."));
      }
      case "inventory": {
        const who = idOf(invocation.options.member) ?? user.id;
        const items = await rt.economy.items(who);
        const name = (id: string) => config.shop.find((i) => i.id === id)?.name ?? id;
        const lines = items.map((i) => `• ${name(i.item)} × ${number(i.quantity)}`);
        return { embeds: [{ title: `🎒 ${rt.t("Inventory")}`, description: `<@${who}>\n${lines.join("\n") || rt.t("Nothing yet.")}`, color: BLURPLE }], ephemeral: true };
      }
      case "leaderboard": {
        const rows = await rt.economy.top(COINS, 10);
        const card = await rt.cards.leaderboard({
          title: rt.t("Top {currency}", { currency: config.currencyName }),
          unit: config.currencyName,
          rows: rows.map((r) => ({ user: r.userId, value: r.balance })),
          theme: themeOf(config),
        });
        if (card) return { files: [card] };
        const lines = rows.map((r, n) => `**${n + 1}.** <@${r.userId}> — ${sym} ${number(r.balance)}`);
        return { embeds: [{ title: `🏆 ${rt.t("Top {currency}", { currency: config.currencyName })}`, description: lines.join("\n") || rt.t("Nobody yet."), color: GOLD }] };
      }
      case "economy": {
        if (!hasPermissions(rt.memberPermissions, ["manage_guild"])) return ME(rt.t("Only the staff (Manage Server) can do that."));
        const to = idOf(invocation.options.member);
        const amount = Math.abs(Math.trunc(Number(invocation.options.amount)));
        if (!to || !amount) return ME(rt.t("Pick a member and an amount."));
        const balance = invocation.subcommand === "take" ? await rt.economy.add(to, COINS, -amount) : await rt.economy.add(to, COINS, amount);
        return ME(rt.t("<@{to}> now has {symbol} {balance}.", { to, symbol: sym, balance: number(balance) }));
      }
    }
    return null;
  },
});

// ── Levels ──────────────────────────────────────────────────────────────────────────────────────

export { levelOf, xpFor };

const LevelingConfig = z
  .object({
    xpPerMessage: z.number().int().min(1).max(1000).default(10).meta({ title: "XP per message", description: "Or the least, with a most" }),
    xpPerMessageMax: z.number().int().min(1).max(1000).optional().meta({ title: "XP per message: most", description: "Random between the two" }),
    cooldownSeconds: z.number().int().min(0).max(3600).default(60).meta({ title: "Cooldown (seconds)", description: "Between two messages that give XP" }),
    announceChannelId: Snowflake.optional().meta({ title: "Announce channel id", description: "Where to announce a new level; empty = where they wrote" }),
    announce: z.boolean().default(true).meta({ title: "Announce new levels" }),
    levelUpMessage: z
      .string()
      .min(1)
      .max(500)
      .default("{{user.mention}} reached **level {{level}}**! 🎉")
      .meta({ title: "Level-up message", description: "{{user.mention}}, {{level}}, {{reward}}" }),
    rewards: z
      .array(
        z
          .object({
            level: z.number().int().min(1).max(500).meta({ title: "Level" }),
            roleId: Snowflake.meta({ title: "Role id" }),
          })
          .strict()
      )
      .max(25)
      .default([])
      .meta({ title: "Role rewards", description: "A role at a level" }),
    keepOldRewards: z.boolean().default(true).meta({ title: "Keep lower reward roles", description: "Off: only the highest reached" }),
    coinsPerLevel: z.number().int().min(0).max(1_000_000).default(0).meta({ title: "Coins per level up", description: "Paid into the Economy module's coins" }),
    multipliers: z
      .array(
        z
          .object({
            roleId: Snowflake.meta({ title: "Role id" }),
            multiplier: z.number().min(0).max(10).meta({ title: "Multiplier", description: "2 = double XP; 0 = none" }),
          })
          .strict()
      )
      .max(10)
      .default([])
      .meta({ title: "XP multipliers", description: "Boosters, patrons: the highest applies" }),
    ignoredChannelIds: z.array(Snowflake).max(50).default([]).meta({ title: "Channels with no XP" }),
    voiceXpPerMinute: z.number().int().min(0).max(100).default(0).meta({ title: "XP per minute in voice", description: "0 = none; unmuted, and not alone (see below)" }),
    voiceAlone: z.boolean().default(false).meta({ title: "Voice XP when alone in the channel" }),
    globalXp: z.boolean().default(true).meta({ title: "Also give global XP", description: "The profile's global level, the same in every server" }),
    ...cardSettings,
  })
  .strict();
type LevelingConfig = z.output<typeof LevelingConfig>;

const XP = "xp";

async function grantLevelRewards(level: number, previous: number, config: LevelingConfig, userId: string, rt: ModuleRuntime): Promise<string[]> {
  const earned = config.rewards.filter((r) => r.level > previous && r.level <= level);
  const names: string[] = [];
  for (const r of earned) {
    try {
      await rt.rest.addRole(rt.guildId, userId, r.roleId);
      names.push(`<@&${r.roleId}>`);
    } catch (err) {
      rt.logger.warn("Levels: a reward role could not be given", { roleId: r.roleId, message: messageOf(err) });
    }
  }
  if (!config.keepOldRewards && earned.length) {
    const top = Math.max(...earned.map((r) => r.level));
    for (const r of config.rewards.filter((x) => x.level < top)) {
      await rt.rest.removeRole(rt.guildId, userId, r.roleId).catch(() => undefined);
    }
  }
  if (config.coinsPerLevel > 0) await rt.economy.add(userId, COINS, config.coinsPerLevel * (level - previous));
  return names;
}

/** Adds XP and does what a new level brings. Gives the new total and the level reached (if any). */
async function addXp(amount: number, config: LevelingConfig, rt: ModuleRuntime, userId: string, announceIn: string | null) {
  const xp = await rt.economy.add(userId, XP, amount);
  if (config.globalXp && amount > 0) await rt.economy.add(userId, XP, amount, true);
  const level = levelOf(xp);
  const before = levelOf(xp - amount);
  if (level > before) {
    const rewards = await grantLevelRewards(level, before, config, userId, rt);
    rt.emit("dc:level:up", { guildId: rt.guildId, userId, level, moduleId: "leveling" });
    const channel = config.announceChannelId ?? announceIn;
    if (config.announce && channel) {
      const text = render(config.levelUpMessage, {
        ...baseVars({ ...rt, user: { id: userId, name: rt.user?.id === userId ? rt.user.name : userId } }),
        level,
        reward: rewards.join(" "),
      });
      await rt.rest.sendMessage(channel, clip(text));
    }
  }
  return { xp, level };
}

export const levelingModule = defineDcModule({
  id: "leveling",
  name: "Levels",
  description: "XP for chatting, level-up messages, role rewards per level, coins per level and multipliers; /rank and /levels. Never reads message text.",
  config: LevelingConfig,
  intents: INTENTS.GUILD_MESSAGES | INTENTS.GUILD_VOICE_STATES,
  events: ["MESSAGE_CREATE", "VOICE_STATE_UPDATE"],
  // Voice XP also arrives while members stay in voice, not only when they leave.
  schedules: (config) => (config.voiceXpPerMinute > 0 ? [{ key: "voice", schedule: { everyMinutes: 10, timezone: "UTC" } }] : []),
  async onSchedule(key, _payload, config, rt) {
    if (key !== "voice" || config.voiceXpPerMinute <= 0) return;
    const sessions = await rt.voice.sessions();
    const perChannel = new Map<string, number>();
    for (const s of sessions) perChannel.set(s.channelId, (perChannel.get(s.channelId) ?? 0) + 1);
    for (const s of sessions) {
      const minutes = await rt.voice.claimMinutes(s.userId);
      if (!minutes || s.muted || (!config.voiceAlone && (perChannel.get(s.channelId) ?? 0) < 2)) continue;
      if (config.ignoredChannelIds.includes(s.channelId)) continue;
      await addXp(minutes * config.voiceXpPerMinute, config, rt, s.userId, null);
    }
  },
  commands: () => [
    { name: "rank", description: "Your level and XP in this server", type: 1, options: [{ name: "member", description: "Someone else", type: 6 }] },
    { name: "levels", description: "The server's top levels", type: 1 },
    {
      name: "xp",
      description: "Staff: give XP",
      type: 1,
      default_member_permissions: MANAGE_GUILD,
      options: [
        { name: "member", description: "Who", type: 6, required: true },
        { name: "amount", description: "How much (negative takes)", type: 4, required: true },
      ],
    },
  ],
  plan: (target) => ({ reply: true, ephemeral: !(target.kind === "command" && target.name === "levels") }),
  async onEvent(event, config, rt) {
    if (event.type === "VOICE_STATE_UPDATE") {
      // Leaving, moving, muting: the minutes so far are settled under the state they were spent in.
      const v = event.voice;
      if (!v?.from || !rt.user || event.isBot || config.voiceXpPerMinute <= 0) return;
      const was = (await rt.voice.sessions()).find((s) => s.userId === rt.user!.id);
      const minutes = await rt.voice.claimMinutes(rt.user.id);
      const company = (await rt.voice.members(v.from)).length;
      if (!minutes || was?.muted || (!config.voiceAlone && company < 2) || config.ignoredChannelIds.includes(v.from)) return;
      await addXp(minutes * config.voiceXpPerMinute, config, rt, rt.user.id, null);
      return;
    }
    if (event.type !== "MESSAGE_CREATE" || !rt.user || event.isBot) return;
    if (event.channelId && config.ignoredChannelIds.includes(event.channelId)) return;
    const boost = config.multipliers.filter((m) => event.memberRoles?.includes(m.roleId)).map((m) => m.multiplier);
    const multiplier = boost.length ? Math.max(...boost) : 1;
    if (multiplier === 0) return;
    if (!(await cooled(rt, `last:${rt.user.id}`, config.cooldownSeconds))) return;
    const max = Math.max(config.xpPerMessage, config.xpPerMessageMax ?? config.xpPerMessage);
    const base = max > config.xpPerMessage ? randomInt(config.xpPerMessage, max + 1) : config.xpPerMessage;
    await addXp(Math.round(base * multiplier), config, rt, rt.user.id, event.channelId);
  },
  async onCommand(invocation, config, rt) {
    if (!rt.user) return null;
    if (invocation.name === "rank") {
      const who = idOf(invocation.options.member) ?? rt.user.id;
      const { balance: xp, rank } = await rt.economy.get(who, XP);
      const level = levelOf(xp);
      const from = xpFor(level);
      const to = xpFor(level + 1);
      const bar = "▰".repeat(Math.round(((xp - from) / (to - from)) * 10)).padEnd(10, "▱");
      const card = await rt.cards.rank({ user: who, level, current: xp - from, needed: to - from, totalXp: xp, rank, theme: themeOf(config) });
      if (card) return { content: rt.t("Level {level} · {xp} XP", { level, xp: number(xp) }), files: [card], ephemeral: true };
      return {
        content: rt.t("Level {level} · {xp} XP", { level, xp: number(xp) }),
        embeds: [
          {
            title: rt.t("Level {level}", { level }),
            description: `${rt.t("<@{who}> · #{rank} in the server", { who, rank })}\n${bar} ${rt.t("{have} / {need} XP to level {next}", { have: number(xp - from), need: number(to - from), next: level + 1 })}`,
            color: BLURPLE,
          },
        ],
        ephemeral: true,
      };
    }
    if (invocation.name === "levels") {
      const rows = await rt.economy.top(XP, 10);
      const card = await rt.cards.leaderboard({
        title: rt.t("Levels"),
        unit: "XP",
        rows: rows.map((r) => ({ user: r.userId, value: r.balance, sub: rt.t("XP · lv {level}", { level: levelOf(r.balance) }) })),
        theme: themeOf(config),
      });
      if (card) return { files: [card] };
      const lines = rows.map((r, n) => `**${n + 1}.** <@${r.userId}> — ${rt.t("level {level} ({xp} XP)", { level: levelOf(r.balance), xp: number(r.balance) })}`);
      return { embeds: [{ title: `🏆 ${rt.t("Levels")}`, description: lines.join("\n") || rt.t("Nobody yet."), color: BLURPLE }] };
    }
    if (invocation.name === "xp") {
      if (!hasPermissions(rt.memberPermissions, ["manage_guild"])) return ME(rt.t("Only the staff (Manage Server) can do that."));
      const who = idOf(invocation.options.member);
      const amount = Math.trunc(Number(invocation.options.amount));
      if (!who || !amount) return ME(rt.t("Pick a member and an amount."));
      const { xp, level } = await addXp(amount, config, rt, who, rt.channelId);
      return ME(rt.t("<@{who}> has {xp} XP (level {level}).", { who, xp: number(xp), level }));
    }
    return null;
  },
});

async function cooled(rt: ModuleRuntime, key: string, seconds: number) {
  if (seconds <= 0) return true;
  const now = Math.floor(rt.now().getTime() / 1000);
  const last = Number((await rt.kv.get(key)) ?? 0);
  if (now - last < seconds) return false;
  await rt.kv.set(key, now);
  return true;
}

// ── Giveaways ───────────────────────────────────────────────────────────────────────────────────

interface Giveaway {
  prize: string;
  ends: number;
  winners: number;
  channelId: string;
  messageId: string | null;
  hostId: string;
  roleId: string | null;
  coins: number;
  ended: boolean;
  picked: string[];
}

const GiveawaysConfig = z
  .object({
    emoji: Emoji.default("🎉").meta({ title: "Emoji" }),
    color: z.number().int().min(0).max(0xffffff).default(0xeb459e).meta({ title: "Color", description: "As a number (0xEB459E = 15418782)" }),
    hostRoleIds: z.array(Snowflake).max(10).default([]).meta({ title: "Host role ids", description: "Who may start giveaways besides the staff (Manage Server)" }),
  })
  .strict();
type GiveawaysConfig = z.output<typeof GiveawaysConfig>;

const gaKey = (id: string) => `ga:${id}`;
const gaList = (id: string) => `ga-${id}`;

async function loadGiveaway(rt: ModuleRuntime, id: string): Promise<Giveaway | null> {
  const raw = await rt.kv.get(gaKey(id));
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as Giveaway;
  } catch {
    return null;
  }
}
const saveGiveaway = (rt: ModuleRuntime, id: string, g: Giveaway) => rt.kv.set(gaKey(id), JSON.stringify(g));

async function giveawayMessage(id: string, g: Giveaway, config: GiveawaysConfig, rt: ModuleRuntime): Promise<MessagePayload> {
  const entries = await rt.lists.count(gaList(id));
  const lines = g.ended
    ? [
        rt.t("Ended <t:{at}:R>", { at: Math.floor(g.ends / 1000) }),
        g.picked.length
          ? rt.t(g.picked.length > 1 ? "Winners: {who}" : "Winner: {who}", { who: g.picked.map((u) => `<@${u}>`).join(", ") })
          : rt.t("No valid entries."),
      ]
    : [
        rt.t("Ends <t:{at}:R> (<t:{at}:f>)", { at: Math.floor(g.ends / 1000) }),
        rt.t(g.winners > 1 ? "{n} winners" : "{n} winner", { n: g.winners }),
      ];
  if (g.roleId) lines.push(rt.t("Only for <@&{role}>", { role: g.roleId }));
  if (g.coins) lines.push(rt.t("Each winner also gets 🪙 {coins}", { coins: number(g.coins) }));
  lines.push(rt.t("Hosted by <@{host}> · id `{id}`", { host: g.hostId, id }));
  return {
    embeds: [{ title: `${config.emoji} ${clip(g.prize, 240)}`, description: lines.join("\n"), color: g.ended ? 0x99aab5 : config.color, footer: { text: rt.t(entries === 1 ? "{n} entry" : "{n} entries", { n: entries }) } }],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: g.ended ? 2 : 1,
            label: g.ended ? rt.t("Ended") : rt.t("Enter ({n})", { n: entries }),
            emoji: { name: config.emoji },
            custom_id: customId("giveaways", `enter-${id}`),
            disabled: g.ended,
          },
        ],
      },
    ],
  };
}

async function endGiveaway(id: string, config: GiveawaysConfig, rt: ModuleRuntime, reroll = false): Promise<Giveaway | null> {
  const g = await loadGiveaway(rt, id);
  if (!g || (g.ended && !reroll)) return g;
  const pool = gaList(id);
  // A reroll draws among those who did not win before.
  if (reroll) for (const w of g.picked) await rt.lists.leave(pool, w);
  g.picked = await rt.lists.pick(pool, g.winners);
  g.ended = true;
  await saveGiveaway(rt, id, g);
  if (g.coins) for (const w of g.picked) await rt.economy.add(w, COINS, g.coins);
  if (g.messageId) {
    await rt.rest.editMessage(g.channelId, g.messageId, await giveawayMessage(id, g, config, rt)).catch(() => undefined);
  }
  const text = g.picked.length
    ? `${config.emoji} ${rt.t("{who} won **{prize}**!", { who: g.picked.map((u) => `<@${u}>`).join(", "), prize: clip(g.prize, 200) })}${reroll ? ` ${rt.t("(reroll)")}` : ""}`
    : rt.t("Nobody entered **{prize}**.", { prize: clip(g.prize, 200) });
  await rt.rest.sendMessage(g.channelId, text);
  rt.emit("dc:giveaway:ended", { guildId: rt.guildId, moduleId: "giveaways", giveawayId: id, winners: g.picked });
  return g;
}

export const giveawaysModule = defineDcModule({
  id: "giveaways",
  name: "Giveaways",
  description: "/giveaway start|end|reroll: an Enter button with a live count, a timer, fair random winners, a role requirement and coins for the winners.",
  config: GiveawaysConfig,
  intents: 0,
  events: [],
  commands: () => [
    {
      name: "giveaway",
      description: "Run a giveaway",
      type: 1,
      options: [
        {
          name: "start",
          description: "Start one here",
          type: 1,
          options: [
            { name: "prize", description: "What they win", type: 3, required: true, max_length: 200 },
            { name: "minutes", description: "How long it runs", type: 4, required: true, min_value: 1, max_value: 43_200 },
            { name: "winners", description: "How many win (default 1)", type: 4, min_value: 1, max_value: 20 },
            { name: "role", description: "Only members with this role may enter", type: 8 },
            { name: "coins", description: "Coins each winner also gets", type: 4, min_value: 1, max_value: 1_000_000_000 },
          ],
        },
        { name: "end", description: "End one now", type: 1, options: [{ name: "id", description: "Its id (in the card)", type: 3, required: true }] },
        { name: "reroll", description: "Draw again", type: 1, options: [{ name: "id", description: "Its id (in the card)", type: 3, required: true }] },
      ],
    },
  ],
  plan: () => ({ reply: true, ephemeral: true }),

  async onCommand(invocation, config, rt) {
    if (invocation.name !== "giveaway" || !rt.user) return null;
    const staff = hasPermissions(rt.memberPermissions, ["manage_guild"]);
    const host = config.hostRoleIds.some((r) => rt.memberRoles.includes(r));
    if (!staff && !host) return ME(rt.t("Only the staff (Manage Server) and giveaway hosts can run giveaways."));
    if (invocation.subcommand === "start") {
      if (!rt.channelId) return ME(rt.t("Run it in a channel."));
      const id = randomUUID().replace(/-/g, "").slice(0, 8);
      const minutes = Math.min(43_200, Math.max(1, Math.trunc(Number(invocation.options.minutes))));
      const g: Giveaway = {
        prize: String(invocation.options.prize ?? "A prize").slice(0, 200),
        ends: rt.now().getTime() + minutes * 60_000,
        winners: Math.min(20, Math.max(1, Math.trunc(Number(invocation.options.winners ?? 1)))),
        channelId: rt.channelId,
        messageId: null,
        hostId: rt.user.id,
        roleId: idOf(invocation.options.role),
        coins: Math.max(0, Math.trunc(Number(invocation.options.coins ?? 0))),
        ended: false,
        picked: [],
      };
      const sent = await rt.rest.sendMessage(g.channelId, await giveawayMessage(id, g, config, rt));
      g.messageId = sent.id;
      await saveGiveaway(rt, id, g);
      await rt.schedule.at(new Date(g.ends), { id }, `end-${id}`);
      return ME(rt.t("Giveaway `{id}` started; it ends <t:{ends}:R>.", { id, ends: Math.floor(g.ends / 1000) }));
    }
    const id = String(invocation.options.id ?? "").trim().toLowerCase();
    if (!(await loadGiveaway(rt, id))) return ME(rt.t("No giveaway with that id."));
    if (invocation.subcommand === "end") {
      await rt.schedule.cancel(`end-${id}`);
      await endGiveaway(id, config, rt);
      return ME(rt.t("Ended."));
    }
    const g = await loadGiveaway(rt, id);
    if (!g?.ended) return ME(rt.t("It has not ended yet."));
    await endGiveaway(id, config, rt, true);
    return ME(rt.t("Rerolled."));
  },

  async onComponent(use, config, rt) {
    const id = /^enter-([a-z0-9]{1,16})$/.exec(use.id)?.[1];
    if (!id || !rt.user) return null;
    const g = await loadGiveaway(rt, id);
    if (!g || g.ended) return ME(rt.t("This giveaway has ended."));
    if (g.roleId && !rt.memberRoles.includes(g.roleId)) return ME(rt.t("Only members with <@&{role}> may enter.", { role: g.roleId }));
    const list = gaList(id);
    const joined = await rt.lists.join(list, rt.user.id);
    if (!joined) await rt.lists.leave(list, rt.user.id);
    if (g.messageId) await rt.rest.editMessage(g.channelId, g.messageId, await giveawayMessage(id, g, config, rt)).catch(() => undefined);
    return ME(joined ? rt.t("You are in! {emoji} Good luck.", { emoji: config.emoji }) : rt.t("You left the giveaway."));
  },

  async onSchedule(key, payload, config, rt) {
    const id = typeof payload.id === "string" ? payload.id : key.replace(/^end-/, "");
    await endGiveaway(id, config, rt);
  },
});

// ── Role menus ──────────────────────────────────────────────────────────────────────────────────

const RoleMenu = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{1,20}$/, "Lowercase letters, digits and _ (up to 20)").meta({ title: "Menu id" }),
    title: z.string().min(1).max(256).meta({ title: "Title" }),
    description: z.string().max(2000).optional().meta({ title: "Description" }),
    style: z.enum(["buttons", "select"]).default("buttons").meta({ title: "Style" }),
    mode: z.enum(["toggle", "one"]).default("toggle").meta({ title: "Mode", description: "toggle: any number; one: picking one removes the others" }),
    requiredRoleId: Snowflake.optional().meta({ title: "Required role id", description: "Only members with it may use the menu" }),
    roles: z
      .array(
        z
          .object({
            roleId: Snowflake.meta({ title: "Role id" }),
            label: z.string().min(1).max(80).meta({ title: "Label" }),
            emoji: Emoji.optional().meta({ title: "Emoji" }),
            description: z.string().max(100).optional().meta({ title: "Description" }),
          })
          .strict()
      )
      .min(1)
      .max(25)
      .meta({ title: "Roles" }),
  })
  .strict();
type RoleMenu = z.output<typeof RoleMenu>;

const RoleMenusConfig = z
  .object({
    menus: z
      .array(RoleMenu)
      .min(1)
      .max(10)
      .refine((m) => new Set(m.map((x) => x.id)).size === m.length, { message: "Two menus with the same id" })
      .meta({ title: "Menus", description: "Each is a panel: post it in a channel from Servers → Panels" }),
  })
  .strict();

function roleMenuMessage(menu: RoleMenu): MessagePayload {
  const lines = menu.roles.map((r) => `${r.emoji ?? "•"} <@&${r.roleId}>${r.description ? ` — ${r.description}` : ""}`);
  const components: Array<Record<string, unknown>> = [];
  if (menu.style === "select") {
    components.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: customId("role-menus", `s-${menu.id}`),
          placeholder: menu.mode === "one" ? "Pick one" : "Pick your roles",
          min_values: 0,
          max_values: menu.mode === "one" ? 1 : menu.roles.length,
          options: menu.roles.map((r, n) => ({
            label: r.label,
            value: String(n),
            ...(r.description ? { description: r.description } : {}),
            ...(r.emoji ? { emoji: { name: r.emoji } } : {}),
          })),
        },
      ],
    });
  } else {
    for (let i = 0; i < menu.roles.length; i += 5) {
      components.push({
        type: 1,
        components: menu.roles.slice(i, i + 5).map((r, n) => ({
          type: 2,
          style: 2,
          label: r.label,
          custom_id: customId("role-menus", `b-${menu.id}-${i + n}`),
          ...(r.emoji ? { emoji: { name: r.emoji } } : {}),
        })),
      });
    }
  }
  return { embeds: [{ title: menu.title, description: clip([menu.description, lines.join("\n")].filter(Boolean).join("\n\n"), 4000), color: BLURPLE }], components };
}

export const roleMenusModule = defineDcModule({
  id: "role-menus",
  name: "Role menus",
  description: "Panels of buttons or a select that give and take roles: pronouns, games, regions, pings. The bot's role must be above them.",
  config: RoleMenusConfig,
  intents: 0,
  events: [],
  panelIds: [],
  panelsOf: (config) => config.menus.map((m) => m.id),
  commands: () => [
    {
      name: "rolemenu",
      description: "Staff: post a role menu here",
      type: 1,
      default_member_permissions: permissionBits(["manage_roles"]),
      options: [{ name: "post", description: "Post a menu in this channel", type: 1, options: [{ name: "menu", description: "Which", type: 3, required: true, autocomplete: true }] }],
    },
  ],
  plan: () => ({ reply: true, ephemeral: true }),
  async renderPanel(panelId, config) {
    const menu = config.menus.find((m) => m.id === panelId);
    return menu ? roleMenuMessage(menu) : null;
  },
  async onAutocomplete(request, config) {
    const typed = request.focused.toLowerCase();
    return config.menus.filter((m) => m.id.includes(typed) || m.title.toLowerCase().includes(typed)).map((m) => ({ name: clip(m.title, 100), value: m.id }));
  },
  async onCommand(invocation, config, rt) {
    if (invocation.name !== "rolemenu" || !rt.channelId) return null;
    if (!hasPermissions(rt.memberPermissions, ["manage_roles"])) return ME(rt.t("Only the staff (Manage Roles) can post menus."));
    const menu = config.menus.find((m) => m.id === String(invocation.options.menu ?? ""));
    if (!menu) return ME(rt.t("No menu with that id."));
    await rt.panels.post(menu.id, rt.channelId);
    return ME(rt.t("Posted **{title}**.", { title: menu.title }));
  },
  async onComponent(use, config, rt) {
    if (!rt.user) return null;
    const m = /^(b|s)-([a-z0-9_]{1,20})(?:-(\d{1,2}))?$/.exec(use.id);
    const menu = m && config.menus.find((x) => x.id === m[2]);
    if (!m || !menu) return ME(rt.t("This menu is not active any more."));
    if (menu.requiredRoleId && !rt.memberRoles.includes(menu.requiredRoleId)) return ME(rt.t("This menu is for <@&{role}> only.", { role: menu.requiredRoleId }));
    const have = new Set(rt.memberRoles);
    const menuRoles = menu.roles.map((r) => r.roleId);
    let wanted: Set<string>;
    if (m[1] === "b") {
      const role = menu.roles[Number(m[3])]?.roleId;
      if (!role) return ME(rt.t("This button is not active any more."));
      if (have.has(role)) wanted = new Set(menuRoles.filter((r) => have.has(r) && r !== role));
      else wanted = new Set(menu.mode === "one" ? [role] : [...menuRoles.filter((r) => have.has(r)), role]);
    } else {
      wanted = new Set(use.values.map((v) => menu.roles[Number(v)]?.roleId).filter((r): r is string => !!r));
    }
    const added: string[] = [];
    const removed: string[] = [];
    try {
      for (const r of menuRoles) {
        if (wanted.has(r) && !have.has(r)) {
          await rt.rest.addRole(rt.guildId, rt.user.id, r);
          added.push(`<@&${r}>`);
        } else if (!wanted.has(r) && have.has(r)) {
          await rt.rest.removeRole(rt.guildId, rt.user.id, r);
          removed.push(`<@&${r}>`);
        }
      }
    } catch (err) {
      rt.logger.warn("Role menu: Discord refused a role", { message: messageOf(err) });
      return ME(rt.t("I could not change that role: my role must be above it, with Manage Roles."));
    }
    const parts = [added.length && rt.t("Added {roles}", { roles: added.join(", ") }), removed.length && rt.t("Removed {roles}", { roles: removed.join(", ") })].filter(Boolean);
    return ME(parts.join(" · ") || rt.t("Nothing changed."));
  },
});

// ── Reminders ───────────────────────────────────────────────────────────────────────────────────

export const remindersModule = defineDcModule({
  id: "reminders",
  name: "Reminders",
  description: "/remind: the bot reminds you by DM (or in the channel) after a while.",
  config: z
    .object({
      maxPerMember: z.number().int().min(1).max(50).default(10).meta({ title: "Pending reminders per member" }),
    })
    .strict(),
  intents: 0,
  events: [],
  commands: () => [
    {
      name: "remind",
      description: "Remind me later",
      type: 1,
      options: [
        { name: "what", description: "What to remind you of", type: 3, required: true, max_length: 500 },
        { name: "minutes", description: "In how many minutes", type: 4, required: true, min_value: 1, max_value: 43_200 },
        { name: "here", description: "In this channel instead of a DM", type: 5 },
      ],
    },
  ],
  plan: () => ({ reply: true, ephemeral: true }),
  async onCommand(invocation, config, rt) {
    if (invocation.name !== "remind" || !rt.user) return null;
    const pending = `pending:${rt.user.id}`;
    if (Number((await rt.kv.get(pending)) ?? 0) >= config.maxPerMember) return ME(rt.t("You already have {n} reminders waiting.", { n: config.maxPerMember }));
    const minutes = Math.min(43_200, Math.max(1, Math.trunc(Number(invocation.options.minutes))));
    const when = new Date(rt.now().getTime() + minutes * 60_000);
    await rt.kv.incr(pending, 1);
    await rt.schedule.at(when, {
      userId: rt.user.id,
      what: String(invocation.options.what ?? "").slice(0, 500),
      channelId: invocation.options.here === true ? rt.channelId : null,
    });
    return ME(rt.t("I will remind you <t:{at}:R>.", { at: Math.floor(when.getTime() / 1000) }));
  },
  async onSchedule(_key, payload, _config, rt) {
    const userId = typeof payload.userId === "string" ? payload.userId : null;
    if (!userId) return;
    await rt.kv.incr(`pending:${userId}`, -1);
    const text = clip(`⏰ <@${userId}> ${String(payload.what ?? "")}`);
    if (typeof payload.channelId === "string") {
      await rt.rest.sendMessage(payload.channelId, text);
      return;
    }
    try {
      await rt.rest.sendMessage(await rt.rest.openDm(userId), text);
    } catch (err) {
      rt.logger.info("Reminder not delivered (closed DMs)", { message: messageOf(err) });
    }
  },
});

// ── Scheduled messages ──────────────────────────────────────────────────────────────────────────

const ScheduledMessage = z
  .object({
    id: LocalId.meta({ title: "Id" }),
    channelId: Snowflake.meta({ title: "Channel id" }),
    content: z.string().min(1).max(2000).meta({ title: "Message", description: "{{now.unix|time:D}} and the other placeholders work" }),
    everyMinutes: z.number().int().min(5).max(43_200).optional().meta({ title: "Every N minutes", description: "Or a time of day below" }),
    at: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional()
      .meta({ title: "Time of day (HH:MM)" }),
    days: z.array(z.enum(WEEKDAYS)).max(7).optional().meta({ title: "Days", description: "mon … sun; empty = every day" }),
    timezone: z.string().max(64).default("UTC").meta({ title: "Time zone", description: "e.g. America/Lima" }),
  })
  .strict()
  .refine((m) => !!m.everyMinutes !== !!m.at, { message: "Every N minutes, or a time of day: one of the two" });

export const scheduledMessagesModule = defineDcModule({
  id: "scheduled-messages",
  name: "Scheduled messages",
  description: "Posts messages on a schedule: every N minutes, or at a time of day on some weekdays, in your time zone.",
  config: z
    .object({
      messages: z
        .array(ScheduledMessage)
        .min(1)
        .max(25)
        .refine((m) => new Set(m.map((x) => x.id)).size === m.length, { message: "Two messages with the same id" })
        .meta({ title: "Messages" }),
    })
    .strict(),
  intents: 0,
  events: [],
  schedules: (config) =>
    config.messages.map((m) => ({
      key: m.id,
      schedule: (m.everyMinutes ? { everyMinutes: m.everyMinutes, timezone: m.timezone } : { at: m.at, days: m.days?.length ? m.days : undefined, timezone: m.timezone }) as Schedule,
    })),
  async onSchedule(key, _payload, config, rt) {
    const m = config.messages.find((x) => x.id === key);
    if (m) await rt.rest.sendMessage(m.channelId, clip(render(m.content, baseVars(rt))));
  },
});

// ── Suggestions and polls ───────────────────────────────────────────────────────────────────────

export const suggestionsModule = defineDcModule({
  id: "suggestions",
  name: "Suggestions",
  description: "/suggest posts a card in a channel with 👍 and 👎, and a thread to discuss it.",
  config: z
    .object({
      channelId: Snowflake.meta({ title: "Channel id", description: "Where suggestions go" }),
      thread: z.boolean().default(true).meta({ title: "Open a thread on each" }),
      upEmoji: Emoji.default("👍").meta({ title: "Up emoji" }),
      downEmoji: Emoji.default("👎").meta({ title: "Down emoji" }),
    })
    .strict(),
  intents: 0,
  events: [],
  commands: () => [
    { name: "suggest", description: "Suggest something", type: 1, options: [{ name: "idea", description: "Your idea", type: 3, required: true, max_length: 1500 }] },
  ],
  plan: () => ({ reply: true, ephemeral: true }),
  async onCommand(invocation, config, rt) {
    if (invocation.name !== "suggest" || !rt.user) return null;
    const n = await rt.kv.incr("seq", 1);
    const idea = String(invocation.options.idea ?? "").slice(0, 1500);
    const sent = await rt.rest.sendMessage(config.channelId, {
      embeds: [{ title: `Suggestion #${n}`, description: idea, color: BLURPLE, footer: { text: `by ${rt.user.name}` } }],
    });
    if (sent.id) {
      await rt.rest.react(config.channelId, sent.id, config.upEmoji).catch(() => undefined);
      await rt.rest.react(config.channelId, sent.id, config.downEmoji).catch(() => undefined);
      if (config.thread) await rt.rest.createThread(config.channelId, { name: `Suggestion #${n}`, messageId: sent.id }).catch(() => undefined);
    }
    return ME(rt.t("Posted as suggestion #{n} in <#{channel}>.", { n, channel: config.channelId }));
  },
});

export const pollsModule = defineDcModule({
  id: "polls",
  name: "Polls",
  description: "/poll posts one of Discord's own polls (votes, timer and results are Discord's).",
  config: z.object({}).strict(),
  intents: 0,
  events: [],
  commands: () => [
    {
      name: "poll",
      description: "Ask the server",
      type: 1,
      options: [
        { name: "question", description: "The question", type: 3, required: true, max_length: 300 },
        { name: "answers", description: "Answers separated by ;  (2 to 10)", type: 3, required: true, max_length: 600 },
        { name: "hours", description: "How long (default 24)", type: 4, min_value: 1, max_value: 768 },
        { name: "multiple", description: "Several answers allowed", type: 5 },
      ],
    },
  ],
  plan: () => ({ reply: true, ephemeral: true }),
  async onCommand(invocation, _config, rt) {
    if (invocation.name !== "poll" || !rt.channelId) return null;
    const answers = String(invocation.options.answers ?? "")
      .split(";")
      .map((a) => a.trim().slice(0, 55))
      .filter(Boolean)
      .slice(0, 10);
    if (answers.length < 2) return ME(rt.t("Give at least two answers, separated by ;"));
    await rt.rest.sendMessage(rt.channelId, {
      poll: {
        question: { text: String(invocation.options.question ?? "").slice(0, 300) },
        answers: answers.map((text) => ({ poll_media: { text } })),
        duration: Math.min(768, Math.max(1, Math.trunc(Number(invocation.options.hours ?? 24)))),
        allow_multiselect: invocation.options.multiple === true,
      },
    });
    return ME(rt.t("Poll posted."));
  },
});

export const REWARD_MODULES: DcModule[] = [
  economyModule,
  levelingModule,
  giveawaysModule,
  roleMenusModule,
  remindersModule,
  scheduledMessagesModule,
  suggestionsModule,
  pollsModule,
] as DcModule[];

for (const m of REWARD_MODULES) registerDcModule(m);

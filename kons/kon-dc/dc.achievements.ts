/**
 * kon-dc — achievements: goals members unlock once, with a reward and an announcement
 * ============================================================================
 *
 * Each achievement has a condition on one shared number:
 *
 *   messages, voice-minutes   the server's activity (`rt.activity`, all time)
 *   level                     the Levels module's XP (`xp`), through `levelOf`
 *   coins                     the Economy balance
 *   daily-streak              the global daily's streak (`rt.profiles`, /credits daily)
 *   pet-level                 the Pets module's `pet-xp`, through `levelOf`
 *
 * The member's numbers are checked when they write (at most once per `checkEverySeconds`), when
 * they leave a voice channel, and when they run /achievements. An unlock is claimed in one write
 * (`kv.incr` → 1), so it is given once; the reward is coins, a role and/or a catalog item (a
 * badge), and it is announced in a channel (the one set, or where the member wrote) or by DM.
 *
 *   /achievements [member]    what is unlocked and how far the rest are
 */

import { z } from "@kitsuden/engine/zod";

import { INTENTS, LocalId, Snowflake } from "./dc.contract";
import { COINS, ME, PET_XP, claimCooldown, idOf, nowSec, number } from "./dc.fun";
import { clip, defineDcModule, levelOf, messageOf, registerDcModule, type DcModule, type ModuleRuntime } from "./dc.modules";

const ID = "achievements";
const METRICS = ["messages", "voice-minutes", "level", "coins", "daily-streak", "pet-level"] as const;
type Metric = (typeof METRICS)[number];

const Achievement = z
  .object({
    id: LocalId.meta({ title: "Id", description: "Lowercase; never change it (unlocks are kept by it)" }),
    name: z.string().min(1).max(80).meta({ title: "Name" }),
    description: z.string().max(200).optional().meta({ title: "Description" }),
    emoji: z.string().min(1).max(64).optional().meta({ title: "Emoji" }),
    metric: z.enum(METRICS).meta({ title: "Condition", description: "messages, voice-minutes, level, coins, daily-streak or pet-level" }),
    goal: z.number().int().min(1).max(1_000_000_000).meta({ title: "At least" }),
    rewardCoins: z.number().int().min(0).max(1_000_000_000).default(0).meta({ title: "Reward: coins" }),
    rewardRoleId: Snowflake.optional().meta({ title: "Reward: role id", description: "The bot's role must be above it" }),
    rewardItem: z.string().regex(/^[a-z0-9_-]{1,64}$/).optional().meta({ title: "Reward: item id", description: "A catalog item, e.g. a badge" }),
  })
  .strict();
type Achievement = z.output<typeof Achievement>;

const AchievementsConfig = z
  .object({
    achievements: z
      .array(Achievement)
      .max(50)
      .default([
        { id: "first-words", name: "First words", emoji: "💬", metric: "messages", goal: 1, rewardCoins: 0 },
        { id: "chatterbox", name: "Chatterbox", emoji: "🗣️", metric: "messages", goal: 1000, rewardCoins: 500 },
        { id: "level-10", name: "Level 10", emoji: "⭐", metric: "level", goal: 10, rewardCoins: 1000 },
      ])
      .refine((a) => new Set(a.map((x) => x.id)).size === a.length, { message: "Two achievements with the same id" })
      .meta({ title: "Achievements" }),
    announce: z.enum(["channel", "dm", "off"]).default("channel").meta({ title: "Announce unlocks", description: "channel, dm or off" }),
    announceChannelId: Snowflake.optional().meta({ title: "Announce channel id", description: "Empty = where the member wrote" }),
    checkEverySeconds: z.number().int().min(0).max(3600).default(60).meta({ title: "Check a member at most every N seconds" }),
    symbol: z.string().min(1).max(64).default("🪙").meta({ title: "Coin symbol" }),
  })
  .strict();
type AchievementsConfig = z.output<typeof AchievementsConfig>;

const gotKey = (a: Achievement, userId: string) => `got:${a.id}:${userId}`;

/** The member's numbers, each read once and only when an achievement needs it. */
function metricsOf(userId: string, rt: ModuleRuntime, extraVoice = 0) {
  const cache = new Map<Metric, Promise<number>>();
  const read = async (m: Metric): Promise<number> => {
    switch (m) {
      case "messages":
        return (await rt.activity.of(userId, null)).messages;
      case "voice-minutes":
        return (await rt.activity.of(userId, null)).voiceMinutes + extraVoice;
      case "level":
        return levelOf((await rt.economy.get(userId, "xp")).balance);
      case "coins":
        return (await rt.economy.get(userId, COINS)).balance;
      case "daily-streak":
        return (await rt.profiles.get(userId)).dailyStreak;
      case "pet-level":
        return levelOf((await rt.economy.get(userId, PET_XP)).balance);
    }
  };
  return (m: Metric) => {
    if (!cache.has(m)) cache.set(m, read(m));
    return cache.get(m)!;
  };
}

async function reward(a: Achievement, userId: string, config: AchievementsConfig, rt: ModuleRuntime): Promise<string[]> {
  const got: string[] = [];
  if (a.rewardCoins > 0) {
    await rt.economy.add(userId, COINS, a.rewardCoins);
    got.push(`${config.symbol} ${number(a.rewardCoins)}`);
  }
  if (a.rewardRoleId) {
    try {
      await rt.rest.addRole(rt.guildId, userId, a.rewardRoleId);
      got.push(`<@&${a.rewardRoleId}>`);
    } catch (err) {
      rt.logger.warn("Achievements: Discord refused the role (is the bot's role above it?)", { message: messageOf(err) });
    }
  }
  if (a.rewardItem) {
    const item = await rt.catalog.get(a.rewardItem);
    await rt.economy.addItem(userId, a.rewardItem, 1, item?.global ?? false);
    got.push(`${item?.emoji ?? "🎁"} ${item?.name ?? a.rewardItem}`);
  }
  return got;
}

async function announce(a: Achievement, userId: string, got: string[], where: string | null, config: AchievementsConfig, rt: ModuleRuntime) {
  if (config.announce === "off") return;
  const lines = [`🏆 ${rt.t("<@{who}> unlocked **{name}**!", { who: userId, name: `${a.emoji ? `${a.emoji} ` : ""}${a.name}` })}`];
  if (a.description) lines.push(a.description);
  if (got.length) lines.push(rt.t("Reward: {what}", { what: got.join(", ") }));
  const text = clip(lines.join("\n"));
  try {
    if (config.announce === "dm") await rt.rest.sendMessage(await rt.rest.openDm(userId), text);
    else {
      const channel = config.announceChannelId ?? where;
      if (channel) await rt.rest.sendMessage(channel, text);
    }
  } catch (err) {
    rt.logger.warn("Achievements: the announcement could not be sent", { message: messageOf(err) });
  }
}

/** Checks a member's achievements; unlocks (once each) those reached. Gives the ids unlocked now. */
export async function checkAchievements(userId: string, config: AchievementsConfig, rt: ModuleRuntime, where: string | null, extraVoice = 0): Promise<string[]> {
  const value = metricsOf(userId, rt, extraVoice);
  const unlocked: string[] = [];
  for (const a of config.achievements) {
    if (Number(await rt.kv.get(gotKey(a, userId))) > 0) continue;
    if ((await value(a.metric)) < a.goal) continue;
    // Claimed in one write: two checks at once unlock it once.
    if ((await rt.kv.incr(gotKey(a, userId), 1)) !== 1) continue;
    unlocked.push(a.id);
    const got = await reward(a, userId, config, rt);
    rt.emit("dc:achievement:unlocked", { guildId: rt.guildId, userId, achievement: a.id });
    await announce(a, userId, got, where, config, rt);
  }
  return unlocked;
}

export const achievementsModule = defineDcModule({
  id: ID,
  name: "Achievements",
  description: "Goals on messages, voice minutes, level, coins, daily streak or pet level, unlocked once with a reward and an announcement.",
  config: AchievementsConfig,
  intents: INTENTS.GUILD_MESSAGES | INTENTS.GUILD_VOICE_STATES,
  events: ["MESSAGE_CREATE", "VOICE_STATE_UPDATE"],
  commands: () => [{ name: "achievements", description: "Achievements unlocked and to unlock", type: 1, options: [{ name: "member", description: "Someone else's", type: 6 }] }],
  plan: () => ({ reply: true }),

  async onEvent(event, config, rt) {
    if (!event.user || event.isBot || !config.achievements.length) return;
    const userId = event.user.id;
    let extraVoice = 0;
    if (event.type === "VOICE_STATE_UPDATE") {
      // Minutes of the session that just ended are counted after the modules run: added here.
      if (!event.voice?.from || event.voice.from === event.voice.to) return;
      extraVoice = event.voice.minutes;
    }
    if ((await claimCooldown(rt.kv, `seen:${userId}`, config.checkEverySeconds, nowSec(rt))) > 0) return;
    await checkAchievements(userId, config, rt, event.type === "MESSAGE_CREATE" ? event.channelId : null, extraVoice);
  },

  async onCommand(invocation, config, rt) {
    const user = rt.user;
    if (invocation.name !== "achievements" || !user) return null;
    if (!config.achievements.length) return ME(rt.t("This server has no achievements yet."));
    const who = idOf(invocation.options.member) ?? user.id;
    await checkAchievements(who, config, rt, rt.channelId);
    const value = metricsOf(who, rt);
    const lines: string[] = [];
    let count = 0;
    for (const a of config.achievements) {
      const done = Number(await rt.kv.get(gotKey(a, who))) > 0;
      if (done) count++;
      const head = `${done ? "✅" : "🔒"} ${a.emoji ?? ""} **${a.name}**`.replace("  ", " ");
      const progress = done ? "" : ` (${number(Math.min(await value(a.metric), a.goal))}/${number(a.goal)})`;
      lines.push(`${head}${progress}${a.description ? ` — ${a.description}` : ""}`);
    }
    return {
      embeds: [
        {
          title: `🏆 ${rt.t("Achievements")} · ${count}/${config.achievements.length}`,
          description: clip(`<@${who}>\n${lines.join("\n")}`, 4000),
          color: 0xf1c40f,
        },
      ],
    };
  },
});

registerDcModule(achievementsModule as unknown as DcModule);

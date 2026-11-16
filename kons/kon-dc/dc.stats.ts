/**
 * kon-dc — activity: who writes and talks the most, by day, week, month or all time
 * ============================================================================
 *
 *   /stats [member] [period]          messages and voice minutes, and the place in the server
 *   /top <messages|voice> [period]    a leaderboard of the period (an image card when possible)
 *   weekly post                       every week, in a channel: the most active of the last 7 days,
 *                                     with coins and a role for the first places if you want
 *
 * The engine counts every message (never its text) and every voice minute per member and day
 * (dc_activity), as soon as some module asks the gateway for messages or voice: this one does.
 */

import { z } from "zod";

import { INTENTS, Snowflake, WEEKDAYS } from "./dc.contract";
import { clip, defineDcModule, messageOf, registerDcModule, type ActivityMetric, type DcModule, type ModuleRuntime, type Reply } from "./dc.modules";

const ME = (text: string): Reply => ({ content: clip(text), ephemeral: true });
const idOf = (v: unknown) => (typeof v === "string" && /^\d{15,20}$/.test(v) ? v : null);
const number = (n: number) => new Intl.NumberFormat("en-US").format(n);

const PERIODS = { day: 0, week: 6, month: 29, all: null } as const;
type Period = keyof typeof PERIODS;
const PERIOD_NAME: Record<Period, string> = { day: "today", week: "this week", month: "this month", all: "all time" };
const unitOf = (metric: ActivityMetric) => (metric === "voice" ? "min in voice" : "messages");
const periodOf = (v: unknown): Period => (typeof v === "string" && v in PERIODS ? (v as Period) : "week");

const hours = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`);

const StatsConfig = z
  .object({
    weeklyChannelId: Snowflake.optional().meta({ title: "Weekly post channel id", description: "Empty = no weekly post" }),
    weeklyDay: z.enum(WEEKDAYS).default("mon").meta({ title: "Weekly post day" }),
    weeklyAt: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("12:00")
      .meta({ title: "Weekly post time (HH:MM)" }),
    timezone: z.string().max(64).default("UTC").meta({ title: "Time zone", description: "e.g. America/Lima" }),
    weeklyMetric: z.enum(["messages", "voice"]).default("messages").meta({ title: "Weekly ranking by" }),
    prizes: z
      .array(z.number().int().min(0).max(1_000_000))
      .max(10)
      .default([])
      .meta({ title: "Weekly coins by place", description: "e.g. 500, 250, 100 for the first three" }),
    championRoleId: Snowflake.optional().meta({ title: "Weekly champion role id", description: "Moves to the week's first place" }),
  })
  .strict();
type StatsConfig = z.output<typeof StatsConfig>;

async function leaderboard(rt: ModuleRuntime, metric: ActivityMetric, period: Period, title: string): Promise<Reply> {
  const rows = await rt.activity.top(metric, PERIODS[period], 10);
  const unit = rt.t(unitOf(metric));
  const card = await rt.cards.leaderboard({ title, unit, rows: rows.map((r) => ({ user: r.userId, value: r.value })) });
  if (card) return { files: [card] };
  const lines = rows.map((r, i) => `**${i + 1}.** <@${r.userId}> — ${metric === "voice" ? hours(r.value) : rt.t("{n} messages", { n: number(r.value) })}`);
  return { embeds: [{ title, description: lines.join("\n") || rt.t("Nobody yet."), color: 0x5865f2 }] };
}

async function weeklyPost(config: StatsConfig, rt: ModuleRuntime) {
  if (!config.weeklyChannelId) return;
  const rows = await rt.activity.top(config.weeklyMetric, 6, 10);
  const post = await leaderboard(rt, config.weeklyMetric, "week", rt.t("Most active this week ({by})", { by: rt.t(config.weeklyMetric) }));
  const paid: string[] = [];
  for (const [i, prize] of config.prizes.entries()) {
    const r = rows[i];
    if (!r || prize <= 0) continue;
    await rt.economy.add(r.userId, "coins", prize);
    paid.push(`<@${r.userId}> +${number(prize)}`);
  }
  if (config.championRoleId) {
    const last = await rt.kv.get("champion");
    const winner = rows[0]?.userId;
    try {
      if (typeof last === "string" && last && last !== winner) await rt.rest.removeRole(rt.guildId, last, config.championRoleId);
      if (winner && winner !== last) await rt.rest.addRole(rt.guildId, winner, config.championRoleId);
      await rt.kv.set("champion", winner ?? "");
    } catch (err) {
      rt.logger.warn("Stats: could not move the champion role", { message: messageOf(err) });
    }
  }
  await rt.rest.sendMessage(config.weeklyChannelId, {
    content: clip(
      [
        rows[0] ? `🏆 ${rt.t("<@{who}> was the most active this week!", { who: rows[0].userId })}` : rt.t("A quiet week."),
        paid.length ? rt.t("Prizes: {list}", { list: paid.join(" · ") }) : "",
      ]
        .filter(Boolean)
        .join("\n")
    ),
    ...(post.files ? { files: post.files } : {}),
    ...(post.embeds ? { embeds: post.embeds } : {}),
  });
}

const periodOption = {
  name: "period",
  description: "Which period (default: this week)",
  type: 3,
  choices: [
    { name: "today", value: "day" },
    { name: "this week", value: "week" },
    { name: "this month", value: "month" },
    { name: "all time", value: "all" },
  ],
};

export const statsModule = defineDcModule({
  id: "stats",
  name: "Activity stats",
  description: "Counts messages and voice minutes per day: /stats, /top by day, week, month or all time, and a weekly ranking with prizes and a champion role.",
  config: StatsConfig,
  intents: INTENTS.GUILD_MESSAGES | INTENTS.GUILD_VOICE_STATES,
  events: ["MESSAGE_CREATE", "VOICE_STATE_UPDATE"],
  commands: () => [
    { name: "stats", description: "Messages and voice time", type: 1, options: [{ name: "member", description: "Someone else", type: 6 }, periodOption] },
    {
      name: "top",
      description: "The most active",
      type: 1,
      options: [
        { name: "by", description: "Messages or voice", type: 3, required: true, choices: [{ name: "messages", value: "messages" }, { name: "voice", value: "voice" }] },
        periodOption,
      ],
    },
  ],
  plan: (target) => ({ reply: true, ephemeral: !(target.kind === "command" && target.name === "top") }),
  schedules: (config) =>
    config.weeklyChannelId ? [{ key: "weekly", schedule: { at: config.weeklyAt, days: [config.weeklyDay], timezone: config.timezone } }] : [],
  async onSchedule(key, _payload, config, rt) {
    if (key === "weekly") await weeklyPost(config, rt);
  },
  async onCommand(invocation, _config, rt) {
    if (!rt.user) return null;
    const period = periodOf(invocation.options.period);
    if (invocation.name === "stats") {
      const who = idOf(invocation.options.member) ?? rt.user.id;
      const a = await rt.activity.of(who, PERIODS[period]);
      const v = await rt.activity.of(who, PERIODS[period], "voice");
      return ME(
        rt.t("<@{who}>, {period}: **{messages}** messages (#{rank}) · **{voice}** in voice (#{voiceRank}).", {
          who,
          period: rt.t(PERIOD_NAME[period]),
          messages: number(a.messages),
          rank: a.rank,
          voice: hours(a.voiceMinutes),
          voiceRank: v.rank,
        })
      );
    }
    if (invocation.name === "top") {
      const metric: ActivityMetric = invocation.options.by === "voice" ? "voice" : "messages";
      return leaderboard(rt, metric, period, rt.t(metric === "voice" ? "Most time in voice, {period}" : "Most messages, {period}", { period: rt.t(PERIOD_NAME[period]) }));
    }
    return null;
  },
});

export const STATS_MODULES: DcModule[] = [statsModule as DcModule];
for (const m of STATS_MODULES) registerDcModule(m);

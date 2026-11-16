/**
 * kon-dc — reaction roles, scheduled purges and birthdays
 * ============================================================================
 *
 *   reaction-roles  react to a message to get a role, take the reaction away to lose it
 *   auto-purge      a channel cleared on a schedule (pins kept; Discord deletes in bulk only
 *                   messages younger than 14 days)
 *   birthdays       /birthday set | remove | upcoming; on the day, a greeting in a channel and a
 *                   role for 24 hours (and coins, if you like)
 */

import { z } from "zod";

import { INTENTS, LocalId, Snowflake } from "./dc.contract";
import { baseVars, clip, defineDcModule, messageOf, registerDcModule, render, type DcModule, type Reply } from "./dc.modules";

const ME = (text: string): Reply => ({ content: clip(text), ephemeral: true });

// ── Reaction roles ──────────────────────────────────────────────────────────────────────────────

export const reactionRolesModule = defineDcModule({
  id: "reaction-roles",
  name: "Reaction roles",
  description: "React to a message to get a role; remove the reaction to lose it.",
  config: z
    .object({
      rules: z
        .array(
          z
            .object({
              messageId: Snowflake.meta({ title: "Message id" }),
              emoji: z.string().min(1).max(64).meta({ title: "Emoji", description: "A unicode emoji, or name:id for a custom one" }),
              roleId: Snowflake.meta({ title: "Role id" }),
            })
            .strict()
        )
        .min(1)
        .max(100)
        .meta({ title: "Rules" }),
      keepOnRemove: z.boolean().default(false).meta({ title: "Keep the role when the reaction is removed" }),
    })
    .strict(),
  intents: INTENTS.GUILD_MESSAGE_REACTIONS,
  events: ["MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE"],
  async onEvent(event, config, rt) {
    if (!rt.user || event.isBot || !event.messageId || !event.emoji) return;
    const rule = config.rules.find((r) => r.messageId === event.messageId && r.emoji === event.emoji);
    if (!rule) return;
    try {
      if (event.type === "MESSAGE_REACTION_ADD") await rt.rest.addRole(rt.guildId, rt.user.id, rule.roleId);
      else if (event.type === "MESSAGE_REACTION_REMOVE" && !config.keepOnRemove) await rt.rest.removeRole(rt.guildId, rt.user.id, rule.roleId);
    } catch (err) {
      rt.logger.warn("Reaction roles: Discord refused the role (is the bot's role above it?)", { message: messageOf(err) });
    }
  },
});

// ── Auto purge ──────────────────────────────────────────────────────────────────────────────────

const Purge = z
  .object({
    id: LocalId.meta({ title: "Id" }),
    channelId: Snowflake.meta({ title: "Channel id" }),
    everyHours: z.number().int().min(1).max(720).default(24).meta({ title: "Every N hours" }),
    olderThanHours: z.number().int().min(0).max(335).default(0).meta({ title: "Only messages older than N hours", description: "0 = all" }),
    keepPinned: z.boolean().default(true).meta({ title: "Keep pinned messages" }),
  })
  .strict();

export const autoPurgeModule = defineDcModule({
  id: "auto-purge",
  name: "Auto purge",
  description: "Clears channels on a schedule (up to 100 messages a run, younger than 14 days; pins kept).",
  config: z
    .object({
      purges: z
        .array(Purge)
        .min(1)
        .max(20)
        .refine((p) => new Set(p.map((x) => x.id)).size === p.length, { message: "Two purges with the same id" })
        .meta({ title: "Purges" }),
    })
    .strict(),
  intents: 0,
  events: [],
  schedules: (config) => config.purges.map((p) => ({ key: p.id, schedule: { everyMinutes: p.everyHours * 60, timezone: "UTC" } })),
  async onSchedule(key, _payload, config, rt) {
    const p = config.purges.find((x) => x.id === key);
    if (!p) return;
    const now = rt.now().getTime();
    const twoWeeks = now - 13.5 * 86_400_000;
    const cut = now - p.olderThanHours * 3_600_000;
    const ids = (await rt.rest.recentMessages(p.channelId, 100))
      .filter((m) => !(p.keepPinned && m.pinned))
      .filter((m) => {
        const t = Date.parse(m.timestamp);
        return t > twoWeeks && t <= cut;
      })
      .map((m) => m.id);
    if (ids.length) await rt.rest.bulkDelete(p.channelId, ids);
    rt.emit("dc:purge:done", { guildId: rt.guildId, channelId: p.channelId, deleted: ids.length });
  },
});

// ── Birthdays ───────────────────────────────────────────────────────────────────────────────────

const BirthdaysConfig = z
  .object({
    channelId: Snowflake.meta({ title: "Greeting channel id" }),
    message: z.string().min(1).max(2000).default("🎂 Happy birthday, {{user.mention}}!").meta({ title: "Greeting", description: "{{user.mention}} is filled in" }),
    roleId: Snowflake.optional().meta({ title: "Birthday role id", description: "Given for the day" }),
    coins: z.number().int().min(0).max(1_000_000).default(0).meta({ title: "Coins as a present" }),
    at: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("09:00")
      .meta({ title: "Time of the greeting (HH:MM)" }),
    timezone: z.string().max(64).default("UTC").meta({ title: "Time zone", description: "e.g. America/Lima" }),
  })
  .strict();

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const mmdd = (month: number, day: number) => `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/** Today's month and day in a time zone. */
function todayIn(now: Date, timeZone: string): { month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric", day: "numeric" }).formatToParts(now);
  return { month: Number(parts.find((p) => p.type === "month")?.value), day: Number(parts.find((p) => p.type === "day")?.value) };
}

export const birthdaysModule = defineDcModule({
  id: "birthdays",
  name: "Birthdays",
  description: "/birthday set: on the day, a greeting, a role for 24 hours and a present in coins.",
  config: BirthdaysConfig,
  intents: 0,
  events: [],
  commands: () => [
    {
      name: "birthday",
      description: "Your birthday",
      type: 1,
      options: [
        {
          name: "set",
          description: "Tell the server your birthday",
          type: 1,
          options: [
            { name: "day", description: "1-31", type: 4, required: true, min_value: 1, max_value: 31 },
            { name: "month", description: "1-12", type: 4, required: true, min_value: 1, max_value: 12 },
          ],
        },
        { name: "remove", description: "Forget it", type: 1 },
        { name: "upcoming", description: "The next birthdays", type: 1 },
      ],
    },
  ],
  plan: (target) => ({ reply: true, ephemeral: !(target.kind === "command" && target.subcommand === "upcoming") }),
  schedules: (config) => [{ key: "daily", schedule: { at: config.at, timezone: config.timezone } }],

  async onCommand(invocation, config, rt) {
    if (invocation.name !== "birthday" || !rt.user) return null;
    const user = rt.user;
    const old = await rt.kv.get(`bday:${user.id}`);
    const forgetOld = async () => {
      if (typeof old === "string" && old) await rt.lists.leave(`bday-${old}`, user.id);
    };
    if (invocation.subcommand === "remove") {
      await forgetOld();
      await rt.kv.set(`bday:${user.id}`, "");
      return ME(rt.t("Forgotten."));
    }
    if (invocation.subcommand === "set") {
      const day = Math.trunc(Number(invocation.options.day));
      const month = Math.trunc(Number(invocation.options.month));
      // Checked before anything changes: a wrong date keeps the one saved.
      if (!(month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN[month - 1])) return ME(rt.t("That day does not exist."));
      await forgetOld();
      const key = mmdd(month, day);
      await rt.kv.set(`bday:${user.id}`, key);
      await rt.lists.join(`bday-${key}`, user.id);
      return ME(rt.t("Saved: {day}/{month}.", { day, month }));
    }
    // The next 30 days.
    const lines: string[] = [];
    const start = rt.now().getTime();
    for (let i = 0; i < 30 && lines.length < 15; i++) {
      const d = new Date(start + i * 86_400_000);
      const { month, day } = todayIn(d, config.timezone);
      for (const id of await rt.lists.members(`bday-${mmdd(month, day)}`, 20)) lines.push(`**${day} ${MONTHS[month - 1]}** · <@${id}>`);
    }
    return { embeds: [{ title: "🎂 Upcoming birthdays", description: lines.join("\n") || "None in the next 30 days.", color: 0xeb459e }] };
  },

  async onSchedule(key, payload, config, rt) {
    if (key.startsWith("unrole-")) {
      if (config.roleId && typeof payload.userId === "string") await rt.rest.removeRole(rt.guildId, payload.userId, config.roleId).catch(() => undefined);
      return;
    }
    if (key !== "daily") return;
    const { month, day } = todayIn(rt.now(), config.timezone);
    const today = [...(await rt.lists.members(`bday-${mmdd(month, day)}`, 200))];
    // 29 February birthdays are celebrated on 28 February in other years.
    if (month === 2 && day === 28) {
      const y = new Date(rt.now()).getUTCFullYear();
      if (!(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) today.push(...(await rt.lists.members("bday-02-29", 200)));
    }
    for (const userId of today) {
      await rt.rest.sendMessage(config.channelId, clip(render(config.message, baseVars({ ...rt, user: { id: userId, name: userId } }))));
      if (config.coins > 0) await rt.economy.add(userId, "coins", config.coins);
      if (config.roleId) {
        await rt.rest.addRole(rt.guildId, userId, config.roleId).catch(() => undefined);
        await rt.schedule.at(new Date(rt.now().getTime() + 24 * 3_600_000), { userId }, `unrole-${userId}`);
      }
      rt.emit("dc:birthday", { guildId: rt.guildId, userId });
    }
  },
});

export const EXTRA_MODULES: DcModule[] = [reactionRolesModule as DcModule, autoPurgeModule as DcModule, birthdaysModule as DcModule];
for (const m of EXTRA_MODULES) registerDcModule(m);

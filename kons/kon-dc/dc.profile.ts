/**
 * kon-dc — the profile: what follows a member across every server of this bot
 * ============================================================================
 *
 *   /profile view [member]   a profile card (image): bio, colour, badges, global level, credits,
 *                            reputation, and the level and place in this server
 *   /profile bio <text>      /profile color <#rrggbb>   /profile clear
 *   /rep <member>            one reputation point, once a day (across the bot)
 *   /credits daily           global credits once a day, more with a streak
 *   /credits balance [member]   /credits top            the bot-wide leaderboard
 *
 * Credits and global XP are GLOBAL balances (`rt.economy.*(…, global: true)`): the same in every
 * server. The Levels module adds global XP as it adds this server's XP. Blueprints read and give
 * them with `global: true` on the wallet steps.
 */

import { z } from "@kitsuden/engine/zod";

import {
  clip,
  defineDcModule,
  levelOf,
  RARITY_COLOR,
  registerDcModule,
  type DcModule,
  type ModuleRuntime,
  type Reply,
} from "./dc.modules";

const ME = (text: string): Reply => ({ content: clip(text), ephemeral: true });
const idOf = (v: unknown) => (typeof v === "string" && /^\d{15,20}$/.test(v) ? v : null);
const number = (n: number) => new Intl.NumberFormat("en-US").format(n);
const dayOf = (d: Date) => Math.floor(d.getTime() / 86_400_000);

/** The global currencies' ids. */
export const CREDITS = "credits";
export const GLOBAL_XP = "xp";

const ProfileConfig = z
  .object({
    creditsName: z.string().min(1).max(32).default("credits").meta({ title: "Name of the global currency" }),
    dailyCredits: z.number().int().min(0).max(1_000_000).default(200).meta({ title: "Global daily", description: "Credits /credits daily gives; 0 switches it off" }),
    streakBonus: z.number().int().min(0).max(1_000_000).default(20).meta({ title: "Streak bonus per day" }),
    streakMax: z.number().int().min(1).max(365).default(7).meta({ title: "Longest streak counted (days)" }),
    repHours: z.number().int().min(1).max(168).default(24).meta({ title: "Hours between two /rep" }),
  })
  .strict();

/** Remembers the member's name and avatar: global leaderboards show people from other servers. */
async function seen(rt: ModuleRuntime) {
  if (rt.user) await rt.profiles.update(rt.user.id, { name: rt.user.name.slice(0, 100), avatar: rt.user.avatar ?? null });
}

export const profileModule = defineDcModule({
  id: "profile",
  name: "Profile",
  description: "A profile card that follows members across every server of this bot: bio, colour, badges, global level, credits and reputation; /rep and a global daily.",
  config: ProfileConfig,
  intents: 0,
  events: [],
  commands: (config) => [
    {
      name: "profile",
      description: "Your profile, the same in every server",
      type: 1,
      options: [
        { name: "view", description: "See a profile", type: 1, options: [{ name: "member", description: "Someone else", type: 6 }] },
        { name: "bio", description: "Write your bio", type: 1, options: [{ name: "text", description: "Up to 200 characters", type: 3, required: true, max_length: 200 }] },
        { name: "color", description: "Your profile's colour", type: 1, options: [{ name: "hex", description: "#rrggbb", type: 3, required: true, min_length: 7, max_length: 7 }] },
        { name: "clear", description: "Clear your bio and colour", type: 1 },
      ],
    },
    { name: "rep", description: "Give someone a reputation point", type: 1, options: [{ name: "member", description: "Who", type: 6, required: true }] },
    {
      name: "credits",
      description: `Your ${config.creditsName}, the same in every server`,
      type: 1,
      options: [
        ...(config.dailyCredits > 0 ? [{ name: "daily", description: `Collect your daily ${config.creditsName}`, type: 1 }] : []),
        { name: "balance", description: "A balance", type: 1, options: [{ name: "member", description: "Someone else", type: 6 }] },
        { name: "top", description: "The richest across the bot", type: 1 },
      ],
    },
  ],
  plan: (target) => ({
    reply: true,
    ephemeral: !(target.kind === "command" && ((target.name === "profile" && target.subcommand === "view") || target.name === "rep" || target.subcommand === "top")),
  }),

  async onCommand(invocation, config, rt) {
    const user = rt.user;
    if (!user) return null;
    await seen(rt);
    const sub = invocation.subcommand;

    if (invocation.name === "profile") {
      if (sub === "bio") {
        await rt.profiles.update(user.id, { bio: String(invocation.options.text ?? "").slice(0, 200) });
        return ME(rt.t("Bio saved."));
      }
      if (sub === "color") {
        const hex = String(invocation.options.hex ?? "");
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return ME(rt.t("Write the colour as #rrggbb, e.g. #5865f2."));
        await rt.profiles.update(user.id, { accent: hex.toLowerCase() });
        return ME(rt.t("Colour saved: {hex}.", { hex: hex.toLowerCase() }));
      }
      if (sub === "clear") {
        await rt.profiles.update(user.id, { bio: null, accent: null });
        return ME(rt.t("Bio and colour cleared."));
      }
      const who = idOf(invocation.options.member) ?? user.id;
      const profile = await rt.profiles.get(who);
      const { balance: gxp } = await rt.economy.get(who, GLOBAL_XP, true);
      const { balance: credits } = await rt.economy.get(who, CREDITS, true);
      const server = await rt.economy.get(who, "xp");
      const card = await rt.cards.profile({
        user: who === user.id ? { id: user.id, name: user.name, avatar: user.avatar ?? null } : profile.name ? { id: who, name: profile.name, avatar: profile.avatar } : who,
        bio: profile.bio,
        rep: profile.rep,
        globalLevel: levelOf(gxp),
        credits,
        creditsName: config.creditsName,
        serverLevel: server.balance > 0 ? levelOf(server.balance) : null,
        serverRank: server.balance > 0 ? server.rank : null,
        badges: await Promise.all(
          profile.badges.map(async (b) => {
            const item = await rt.catalog.get(b);
            return { label: item?.name ?? b, color: item?.color ?? (item ? RARITY_COLOR[item.rarity] : undefined) };
          })
        ),
        backgroundUrl: profile.background ? ((await rt.catalog.get(profile.background))?.imageUrl ?? null) : null,
        theme: profile.accent ? { accent: profile.accent } : undefined,
      });
      const text = rt.t("<@{who}> · global level {level} · {credits} {currency} · +{rep} rep", { who, level: levelOf(gxp), credits: number(credits), currency: config.creditsName, rep: number(profile.rep) });
      if (card) return { content: text, files: [card] };
      return {
        embeds: [
          {
            title: profile.name ?? "Profile",
            description: `<@${who}>\n${profile.bio ?? rt.t("No bio yet.")}`,
            color: profile.accent ? parseInt(profile.accent.slice(1), 16) : 0x5865f2,
            fields: [
              { name: rt.t("Global level"), value: String(levelOf(gxp)), inline: true },
              { name: config.creditsName, value: number(credits), inline: true },
              { name: rt.t("Reputation"), value: `+${number(profile.rep)}`, inline: true },
            ],
          },
        ],
      };
    }

    if (invocation.name === "rep") {
      const to = idOf(invocation.options.member);
      if (!to || to === user.id) return ME(rt.t("Give reputation to someone else."));
      const r = await rt.profiles.giveRep(user.id, to, config.repHours);
      if (!r.ok) return ME(rt.t("You can give reputation again <t:{at}:R>.", { at: Math.floor(r.nextAt.getTime() / 1000) }));
      rt.emit("dc:reward:granted", { guildId: rt.guildId, userId: to, currency: "rep", amount: 1, balance: r.rep, moduleId: "profile", global: true });
      return { content: rt.t("{name} gave <@{to}> a reputation point (+{rep}).", { name: user.name, to, rep: number(r.rep) }) };
    }

    if (invocation.name === "credits") {
      if (sub === "daily") {
        const streak = await rt.profiles.claimDaily(user.id, dayOf(rt.now()));
        if (streak === null) return ME(rt.t("You already collected today. Come back <t:{next}:R>.", { next: (dayOf(rt.now()) + 1) * 86_400 }));
        const amount = config.dailyCredits + config.streakBonus * (Math.min(streak, config.streakMax) - 1);
        const balance = await rt.economy.add(user.id, CREDITS, amount, true);
        return ME(`+**${number(amount)}** ${config.creditsName}${streak > 1 ? ` · ${rt.t("{n}-day streak", { n: streak })}` : ""}. ${rt.t("You have {balance} in every server.", { balance: number(balance) })}`);
      }
      if (sub === "top") {
        const rows = await rt.economy.top(CREDITS, 10, true);
        const names = await Promise.all(rows.map((r) => rt.profiles.get(r.userId)));
        const card = await rt.cards.leaderboard({
          title: rt.t("Top {currency}", { currency: config.creditsName }),
          unit: config.creditsName,
          rows: rows.map((r, i) => ({ user: names[i].name ? { id: r.userId, name: names[i].name!, avatar: names[i].avatar } : r.userId, value: r.balance })),
        });
        if (card) return { files: [card] };
        return { embeds: [{ title: rt.t("Top {currency}", { currency: config.creditsName }), description: rows.map((r, i) => `**${i + 1}.** <@${r.userId}> — ${number(r.balance)}`).join("\n") || "Nobody yet.", color: 0xf1c40f }] };
      }
      const who = idOf(invocation.options.member) ?? user.id;
      const { balance, rank } = await rt.economy.get(who, CREDITS, true);
      const card = await rt.cards.wallet({ user: who, currencyName: config.creditsName, balance, rank, place: rt.t("across the bot") });
      const text = rt.t("<@{who}> has **{balance}** {currency} (#{rank} across the bot).", { who, balance: number(balance), currency: config.creditsName, rank });
      return card ? { content: text, files: [card], ephemeral: true } : ME(text);
    }
    return null;
  },
});

export const PROFILE_MODULES: DcModule[] = [profileModule as DcModule];
for (const m of PROFILE_MODULES) registerDcModule(m);

/**
 * kon-dc — built-in modules for keeping a server in order
 * ============================================================================
 *
 *   moderation  /warn /warnings /clearwarnings /timeout /untimeout /kick /ban /purge, numbered cases,
 *               a log channel, a DM to the member, and automatic steps at N warnings
 *   automod     Discord's OWN AutoMod rules, set up from settings: banned words, invite links, other
 *               links (with allowed sites), mention spam and spam. Discord blocks the messages itself:
 *               the bot reads no message text and needs no privileged intent for it
 *   logs        joins, leaves, bans, edited and deleted messages, into one channel
 *   tickets     a panel with "Open a ticket": a private thread per member, closed with a button;
 *               on close, a .txt transcript in a log channel and, if you like, by DM to the member
 *
 * Discord shows the moderation commands only to members with the matching permission
 * (`default_member_permissions`), and the module checks the permission again on every use.
 */

import { z } from "zod";

import { INTENTS, Snowflake } from "./dc.contract";
import {
  baseVars,
  clip,
  customId,
  defineDcModule,
  duration,
  hasPermissions,
  messageOf,
  permissionBits,
  registerDcModule,
  render,
  type DcModule,
  type ModuleRuntime,
  type Reply,
} from "./dc.modules";
import { DiscordApiError, type MessagePayload, type TranscriptMessage } from "./dc.rest";

const ME = (text: string): Reply => ({ content: clip(text), ephemeral: true });
const idOf = (v: unknown) => (typeof v === "string" && /^\d{15,20}$/.test(v) ? v : null);
const RED = 0xed4245;
const ORANGE = 0xe67e22;
const GREY = 0x99aab5;
const GREEN = 0x57f287;

/** Discord's refusal, said so a moderator knows what to fix. */
function refusal(err: unknown): string {
  if (err instanceof DiscordApiError && err.status === 403) {
    return "Discord refused: my role must be above that member's, with the permission for it.";
  }
  if (err instanceof DiscordApiError && err.status === 404) return "Discord does not know that member here.";
  return "Something went wrong talking to Discord.";
}

// ── Moderation ──────────────────────────────────────────────────────────────────────────────────

const ModerationConfig = z
  .object({
    logChannelId: Snowflake.optional().meta({ title: "Log channel id", description: "Every action is posted there" }),
    dmMember: z.boolean().default(true).meta({ title: "Tell the member by DM" }),
    escalation: z
      .array(
        z
          .object({
            warnings: z.number().int().min(1).max(100).meta({ title: "At this many warnings" }),
            action: z.enum(["timeout", "kick", "ban"]).meta({ title: "Do" }),
            minutes: z.number().int().min(1).max(40_320).optional().meta({ title: "Timeout minutes" }),
          })
          .strict()
      )
      .max(10)
      .default([])
      .meta({ title: "Automatic steps", description: "e.g. 3 warnings → 60 min timeout, 5 → kick" }),
  })
  .strict();
type ModerationConfig = z.output<typeof ModerationConfig>;

interface Case {
  n: number;
  action: string;
  userId: string;
  moderatorId: string;
  reason: string;
  at: number;
}

async function recordCase(rt: ModuleRuntime, config: ModerationConfig, action: string, userId: string, reason: string, extra = ""): Promise<Case> {
  const n = await rt.kv.incr("case-seq", 1);
  const c: Case = { n, action, userId, moderatorId: rt.user?.id ?? "", reason: reason.slice(0, 400), at: rt.now().getTime() };
  await rt.kv.set(`case:${n}`, JSON.stringify(c));
  rt.emit("dc:moderation:action", { guildId: rt.guildId, userId, action, moderatorId: c.moderatorId, caseId: n });
  if (config.logChannelId) {
    const color = action === "ban" ? RED : action === "warn" ? ORANGE : GREY;
    await rt.rest
      .sendMessage(config.logChannelId, {
        embeds: [
          {
            title: `Case #${n} · ${action}`,
            description: `**Member:** <@${userId}>\n**By:** <@${c.moderatorId}>\n**Reason:** ${c.reason || "—"}${extra ? `\n${extra}` : ""}`,
            color,
            timestamp: new Date(c.at).toISOString(),
          },
        ],
      })
      .catch((err) => rt.logger.warn("Moderation: the log channel refused", { message: messageOf(err) }));
  }
  return c;
}

async function tell(rt: ModuleRuntime, config: ModerationConfig, userId: string, text: string) {
  if (!config.dmMember) return;
  try {
    await rt.rest.sendMessage(await rt.rest.openDm(userId), clip(text));
  } catch {
    /* closed DMs */
  }
}

async function timeoutMember(rt: ModuleRuntime, userId: string, minutes: number, reason: string) {
  const until = minutes > 0 ? new Date(rt.now().getTime() + minutes * 60_000).toISOString() : null;
  await rt.rest.editMember(rt.guildId, userId, { communicationDisabledUntil: until }, reason);
}

const memberOpt = { name: "member", description: "Who", type: 6, required: true };
const reasonOpt = { name: "reason", description: "Why (shown in the log and the audit log)", type: 3, max_length: 400 };

const PERMS = {
  moderate: permissionBits(["moderate_members"]),
  kick: permissionBits(["kick_members"]),
  ban: permissionBits(["ban_members"]),
  messages: permissionBits(["manage_messages"]),
};

export const moderationModule = defineDcModule({
  id: "moderation",
  name: "Moderation",
  description: "/warn /warnings /timeout /kick /ban /purge with numbered cases, a log channel, a DM to the member and automatic steps at N warnings.",
  config: ModerationConfig,
  intents: 0,
  events: [],
  commands: () => [
    { name: "warn", description: "Warn a member", type: 1, default_member_permissions: PERMS.moderate, options: [memberOpt, { ...reasonOpt, required: true }] },
    { name: "warnings", description: "A member's warnings", type: 1, default_member_permissions: PERMS.moderate, options: [memberOpt] },
    { name: "clearwarnings", description: "Forget a member's warnings", type: 1, default_member_permissions: PERMS.moderate, options: [memberOpt] },
    {
      name: "timeout",
      description: "Time a member out",
      type: 1,
      default_member_permissions: PERMS.moderate,
      options: [memberOpt, { name: "minutes", description: "How long (up to 28 days)", type: 4, required: true, min_value: 1, max_value: 40_320 }, reasonOpt],
    },
    { name: "untimeout", description: "Lift a timeout", type: 1, default_member_permissions: PERMS.moderate, options: [memberOpt] },
    { name: "kick", description: "Remove a member", type: 1, default_member_permissions: PERMS.kick, options: [memberOpt, reasonOpt] },
    {
      name: "ban",
      description: "Ban a member",
      type: 1,
      default_member_permissions: PERMS.ban,
      options: [memberOpt, reasonOpt, { name: "delete_hours", description: "Delete their messages of the last N hours", type: 4, min_value: 0, max_value: 168 }],
    },
    {
      name: "slowmode",
      description: "Seconds between two messages of a member here",
      type: 1,
      default_member_permissions: PERMS.messages,
      options: [{ name: "seconds", description: "0 = off, up to 21600", type: 4, required: true, min_value: 0, max_value: 21600 }],
    },
    {
      name: "purge",
      description: "Delete the latest messages here",
      type: 1,
      default_member_permissions: PERMS.messages,
      options: [
        { name: "count", description: "How many (up to 100)", type: 4, required: true, min_value: 1, max_value: 100 },
        { name: "member", description: "Only theirs", type: 6 },
      ],
    },
  ],
  plan: () => ({ reply: true, ephemeral: true }),

  async onCommand(invocation, config, rt) {
    if (!rt.user) return null;
    const need: Record<string, Parameters<typeof hasPermissions>[1]> = {
      kick: ["kick_members"],
      ban: ["ban_members"],
      purge: ["manage_messages"],
      slowmode: ["manage_messages"],
    };
    const required = need[invocation.name] ?? ["moderate_members"];
    if (!hasPermissions(rt.memberPermissions, required)) return ME(rt.t("You do not have the permission for that."));
    const target = idOf(invocation.options.member);
    const reason = String(invocation.options.reason ?? "").slice(0, 400);
    const by = `${rt.user.name}: ${reason || "no reason"}`;

    try {
      switch (invocation.name) {
        case "warn": {
          if (!target) return ME(rt.t("Pick a member."));
          const count = await rt.kv.incr(`warns:${target}`, 1);
          const c = await recordCase(rt, config, "warn", target, reason, `**Warnings:** ${count}`);
          await tell(rt, config, target, `You were warned in the server: ${reason}`);
          const step = [...config.escalation].sort((a, b) => b.warnings - a.warnings).find((e) => e.warnings === count);
          let after = "";
          if (step) {
            if (step.action === "timeout") await timeoutMember(rt, target, step.minutes ?? 60, `${count} warnings`);
            else if (step.action === "kick") await rt.rest.kick(rt.guildId, target, `${count} warnings`);
            else await rt.rest.ban(rt.guildId, target, `${count} warnings`);
            await recordCase(rt, config, step.action, target, `Automatic: ${count} warnings`);
            after = ` ${rt.t("They reached {count} warnings: {action}.", { count, action: `${rt.t(step.action)}${step.action === "timeout" ? ` ${duration((step.minutes ?? 60) * 60)}` : ""}` })}`;
          }
          return ME(`${rt.t("Case #{n}: <@{who}> warned ({count} so far).", { n: c.n, who: target, count })}${after}`);
        }
        case "warnings": {
          if (!target) return ME(rt.t("Pick a member."));
          const count = Number((await rt.kv.get(`warns:${target}`)) ?? 0);
          return ME(rt.t(count === 1 ? "<@{who}> has {n} warning." : "<@{who}> has {n} warnings.", { who: target, n: count }));
        }
        case "clearwarnings": {
          if (!target) return ME(rt.t("Pick a member."));
          await rt.kv.set(`warns:${target}`, 0);
          await recordCase(rt, config, "clear warnings", target, reason);
          return ME(rt.t("<@{who}>'s warnings are cleared.", { who: target }));
        }
        case "timeout": {
          if (!target) return ME(rt.t("Pick a member."));
          const minutes = Math.min(40_320, Math.max(1, Math.trunc(Number(invocation.options.minutes))));
          await timeoutMember(rt, target, minutes, by);
          const c = await recordCase(rt, config, "timeout", target, reason, `**For:** ${duration(minutes * 60)}`);
          await tell(rt, config, target, `You were timed out for ${duration(minutes * 60)}: ${reason || "no reason given"}`);
          return ME(rt.t("Case #{n}: <@{who}> timed out for {time}.", { n: c.n, who: target, time: duration(minutes * 60) }));
        }
        case "untimeout": {
          if (!target) return ME(rt.t("Pick a member."));
          await timeoutMember(rt, target, 0, by);
          const c = await recordCase(rt, config, "untimeout", target, reason);
          return ME(rt.t("Case #{n}: <@{who}> can talk again.", { n: c.n, who: target }));
        }
        case "kick": {
          if (!target) return ME(rt.t("Pick a member."));
          await tell(rt, config, target, `You were removed from the server: ${reason || "no reason given"}`);
          await rt.rest.kick(rt.guildId, target, by);
          const c = await recordCase(rt, config, "kick", target, reason);
          return ME(rt.t("Case #{n}: <@{who}> was removed.", { n: c.n, who: target }));
        }
        case "ban": {
          if (!target) return ME(rt.t("Pick a member."));
          await tell(rt, config, target, `You were banned from the server: ${reason || "no reason given"}`);
          await rt.rest.ban(rt.guildId, target, by, Math.min(168, Math.max(0, Number(invocation.options.delete_hours ?? 0))) * 3600);
          const c = await recordCase(rt, config, "ban", target, reason);
          return ME(rt.t("Case #{n}: <@{who}> was banned.", { n: c.n, who: target }));
        }
        case "slowmode": {
          if (!rt.channelId) return ME(rt.t("Run it in a channel."));
          const seconds = Math.max(0, Math.min(21600, Math.trunc(Number(invocation.options.seconds ?? 0))));
          await rt.rest.editChannel(rt.channelId, { slowmode: seconds });
          return ME(seconds ? rt.t("Slowmode: one message every {time}.", { time: duration(seconds) }) : rt.t("Slowmode off."));
        }
        case "purge": {
          if (!rt.channelId) return ME(rt.t("Run it in a channel."));
          const want = Math.min(100, Math.max(1, Math.trunc(Number(invocation.options.count))));
          const from = idOf(invocation.options.member);
          const twoWeeks = rt.now().getTime() - 13.5 * 86_400_000;
          const recent = await rt.rest.recentMessages(rt.channelId, 100);
          const ids = recent
            .filter((m) => (!from || m.authorId === from) && Date.parse(m.timestamp) > twoWeeks)
            .slice(0, want)
            .map((m) => m.id);
          await rt.rest.bulkDelete(rt.channelId, ids);
          await recordCase(rt, config, "purge", from ?? rt.user.id, `${ids.length} messages in <#${rt.channelId}>`);
          return ME(rt.t(ids.length === 1 ? "Deleted {n} message." : "Deleted {n} messages.", { n: ids.length }));
        }
      }
    } catch (err) {
      rt.logger.warn("Moderation action failed", { command: invocation.name, message: messageOf(err) });
      return ME(rt.t(refusal(err)));
    }
    return null;
  },
});

// ── AutoMod (Discord's own) ─────────────────────────────────────────────────────────────────────

const RULE_PREFIX = "kitsuden: ";

const AutomodConfig = z
  .object({
    bannedWords: z
      .array(z.string().min(1).max(60))
      .max(1000)
      .default([])
      .meta({ title: "Banned words", description: "Whole words; *word* matches inside other words" }),
    blockInvites: z.boolean().default(true).meta({ title: "Block invite links to other servers" }),
    blockLinks: z.boolean().default(false).meta({ title: "Block other links" }),
    allowedSites: z
      .array(z.string().min(1).max(60))
      .max(100)
      .default([])
      .meta({ title: "Sites allowed when links are blocked", description: "e.g. youtube.com, twitch.tv" }),
    mentionLimit: z.number().int().min(0).max(50).default(5).meta({ title: "Most mentions in one message", description: "0 = no limit" }),
    blockSpam: z.boolean().default(true).meta({ title: "Block suspected spam" }),
    alertChannelId: Snowflake.optional().meta({ title: "Alert channel id", description: "Where Discord reports what it blocked" }),
    timeoutSeconds: z.number().int().min(0).max(2_419_200).default(0).meta({ title: "Timeout on a blocked message (seconds)", description: "0 = none" }),
    exemptRoleIds: z.array(Snowflake).max(20).default([]).meta({ title: "Exempt role ids" }),
    exemptChannelIds: z.array(Snowflake).max(50).default([]).meta({ title: "Exempt channel ids" }),
    blockMessage: z.string().max(150).default("This message was blocked by the server's rules.").meta({ title: "What the member reads" }),
  })
  .strict();
type AutomodConfig = z.output<typeof AutomodConfig>;

/** The AutoMod rules these settings mean, by name. Discord runs them; the bot only writes them. */
export function automodRules(config: AutomodConfig): Array<Record<string, unknown>> {
  const actions = (extra: boolean) => [
    { type: 1, metadata: { custom_message: config.blockMessage } },
    ...(config.alertChannelId ? [{ type: 2, metadata: { channel_id: config.alertChannelId } }] : []),
    ...(extra && config.timeoutSeconds ? [{ type: 3, metadata: { duration_seconds: config.timeoutSeconds } }] : []),
  ];
  const base = { event_type: 1, enabled: true, exempt_roles: config.exemptRoleIds, exempt_channels: config.exemptChannelIds };
  const rules: Array<Record<string, unknown>> = [];
  const patterns: string[] = [];
  if (config.blockInvites) patterns.push(String.raw`(discord\.gg|discord(app)?\.com/invite)/[a-zA-Z0-9-]+`);
  if (config.blockLinks) patterns.push(String.raw`https?://\S+`);
  if (config.bannedWords.length || patterns.length) {
    rules.push({
      ...base,
      name: `${RULE_PREFIX}words and links`,
      trigger_type: 1,
      trigger_metadata: {
        keyword_filter: config.bannedWords.slice(0, 1000),
        regex_patterns: patterns,
        allow_list: config.blockLinks ? config.allowedSites.map((s) => `*${s.replace(/^\*|\*$/g, "")}*`) : [],
      },
      actions: actions(true),
    });
  }
  if (config.mentionLimit > 0) {
    rules.push({
      ...base,
      name: `${RULE_PREFIX}mention spam`,
      trigger_type: 5,
      trigger_metadata: { mention_total_limit: config.mentionLimit, mention_raid_protection_enabled: true },
      actions: actions(true),
    });
  }
  if (config.blockSpam) {
    rules.push({ ...base, name: `${RULE_PREFIX}spam`, trigger_type: 3, actions: actions(false) });
  }
  return rules;
}

export const automodModule = defineDcModule({
  id: "automod",
  name: "AutoMod",
  description: "Sets up Discord's own AutoMod: banned words, invite links, other links, mention spam and spam. Discord blocks the messages; the bot reads no text.",
  config: AutomodConfig,
  intents: 0,
  events: [],
  async onConfigure(enabled, config, rt) {
    const existing = (await rt.rest.listAutoModRules(rt.guildId)).filter((r) => r.name.startsWith(RULE_PREFIX));
    const wanted = enabled ? automodRules(config) : [];
    for (const rule of wanted) {
      const found = existing.find((r) => r.name === rule.name);
      // A rule's trigger type cannot change: edit sends everything but it.
      if (found) {
        const { trigger_type: _t, event_type: _e, ...changes } = rule;
        await rt.rest.editAutoModRule(rt.guildId, found.id, changes);
      } else await rt.rest.createAutoModRule(rt.guildId, rule);
    }
    for (const r of existing) {
      if (!wanted.some((w) => w.name === r.name)) await rt.rest.deleteAutoModRule(rt.guildId, r.id);
    }
  },
});

// ── Logs ────────────────────────────────────────────────────────────────────────────────────────

const LogsConfig = z
  .object({
    channelId: Snowflake.meta({ title: "Log channel id" }),
    joins: z.boolean().default(true).meta({ title: "Joins" }),
    leaves: z.boolean().default(true).meta({ title: "Leaves" }),
    bans: z.boolean().default(true).meta({ title: "Bans" }),
    edits: z.boolean().default(true).meta({ title: "Edited messages", description: "The new text shows only with the Message Content intent" }),
    deletes: z.boolean().default(true).meta({ title: "Deleted messages" }),
    ignoredChannelIds: z.array(Snowflake).max(50).default([]).meta({ title: "Channels not logged" }),
    keepMessagesHours: z
      .number()
      .int()
      .min(0)
      .max(168)
      .default(0)
      .meta({
        title: "Keep message text (hours)",
        description: "So a deleted or edited message shows what it said. 0 = off. Needs the privileged Message Content intent; text is erased when it expires",
      }),
  })
  .strict();

export const logsModule = defineDcModule({
  id: "logs",
  name: "Logs",
  description: "Posts joins, leaves, bans, edited and deleted messages in one channel.",
  config: LogsConfig,
  intents: INTENTS.GUILD_MEMBERS | INTENTS.GUILD_MESSAGES | INTENTS.GUILD_MODERATION,
  // The privileged Message Content intent only when the server asked to keep text.
  intentsFor: (config) => INTENTS.GUILD_MEMBERS | INTENTS.GUILD_MESSAGES | INTENTS.GUILD_MODERATION | (config.keepMessagesHours > 0 ? INTENTS.MESSAGE_CONTENT : 0),
  events: ["GUILD_MEMBER_ADD", "GUILD_MEMBER_REMOVE", "GUILD_BAN_ADD", "MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_DELETE"],
  async onEvent(event, config, rt) {
    if (event.channelId && (config.ignoredChannelIds.includes(event.channelId) || event.channelId === config.channelId)) return;
    if (event.type === "MESSAGE_CREATE") {
      if (config.keepMessagesHours > 0 && event.user && !event.isBot && event.messageId && event.channelId && event.content) {
        await rt.messages.remember({ messageId: event.messageId, channelId: event.channelId, authorId: event.user.id, content: event.content }, config.keepMessagesHours);
      }
      return;
    }
    const link = event.channelId && event.messageId ? `https://discord.com/channels/${rt.guildId}/${event.channelId}/${event.messageId}` : "";
    const who = event.user ? `<@${event.user.id}> (${event.user.name})` : "Someone";
    let embed: Record<string, unknown> | null = null;
    switch (event.type) {
      case "GUILD_MEMBER_ADD":
        if (config.joins) embed = { title: "Joined", description: who, color: GREEN };
        break;
      case "GUILD_MEMBER_REMOVE":
        if (config.leaves) embed = { title: "Left", description: who, color: GREY };
        break;
      case "GUILD_BAN_ADD":
        if (config.bans) embed = { title: "Banned", description: who, color: RED };
        break;
      case "MESSAGE_UPDATE":
        // An embed loading also arrives as an edit, with no author: not a member's edit.
        if (config.edits && event.user && !event.isBot) {
          const before = config.keepMessagesHours > 0 && event.messageId ? await rt.messages.recall(event.messageId) : null;
          if (before && event.content && before.content === event.content) break;
          const fields = [
            ...(before?.content ? [{ name: "Before", value: clip(before.content, 1024) }] : []),
            ...(event.content ? [{ name: before ? "After" : "Now", value: clip(event.content, 1024) }] : []),
          ];
          embed = { title: "Message edited", description: `${who} in <#${event.channelId}> · [jump](${link})`, color: ORANGE, ...(fields.length ? { fields } : {}) };
          if (event.content && event.messageId && event.channelId && config.keepMessagesHours > 0) {
            await rt.messages.remember({ messageId: event.messageId, channelId: event.channelId, authorId: event.user.id, content: event.content }, config.keepMessagesHours);
          }
        }
        break;
      case "MESSAGE_DELETE": {
        if (!config.deletes) break;
        const was = event.messageId ? await rt.messages.recall(event.messageId) : null;
        embed = was
          ? { title: "Message deleted", description: `By <@${was.authorId}> in <#${event.channelId}>`, color: RED, fields: [{ name: "It said", value: clip(was.content || "(no text)", 1024) }] }
          : { title: "Message deleted", description: `In <#${event.channelId}> · id ${event.messageId ?? "?"}`, color: RED };
        if (was && event.messageId) await rt.messages.forget(event.messageId);
        break;
      }
    }
    if (embed) await rt.rest.sendMessage(config.channelId, { embeds: [{ ...embed, timestamp: rt.now().toISOString() }] });
  },
});

// ── Tickets ─────────────────────────────────────────────────────────────────────────────────────

const TicketsConfig = z
  .object({
    title: z.string().min(1).max(256).default("Need help?").meta({ title: "Panel title" }),
    description: z.string().max(2000).default("Press the button to open a private ticket with the staff.").meta({ title: "Panel text" }),
    buttonLabel: z.string().min(1).max(80).default("Open a ticket").meta({ title: "Button label" }),
    welcome: z
      .string()
      .min(1)
      .max(2000)
      .default("Hi {{user.mention}}, tell us what you need. The staff will answer here.")
      .meta({ title: "First message in the ticket" }),
    maxOpen: z.number().int().min(1).max(5).default(1).meta({ title: "Open tickets per member" }),
    logChannelId: Snowflake.optional().meta({ title: "Log channel id", description: "Opened and closed tickets are noted there" }),
    transcriptChannelId: Snowflake.optional().meta({ title: "Transcript channel id", description: "On close, the conversation as a .txt file; empty = none" }),
    transcriptDm: z.boolean().default(false).meta({ title: "Send the transcript to the member by DM" }),
    transcriptMaxMessages: z.number().int().min(50).max(5000).default(1000).meta({ title: "Messages in a transcript at most", description: "The newest are kept" }),
  })
  .strict();
type TicketsConfig = z.output<typeof TicketsConfig>;

/** One page per Discord call: 100 messages. */
const TRANSCRIPT_PAGE = 100;

/** Two digits. */
const p2 = (n: number) => String(n).padStart(2, "0");
const stamp = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
};

/**
 * A ticket's thread as plain text, oldest first: the newest `max` messages, read 100 at a time.
 * Discord sends the text only when the app has the Message Content intent switched on in the
 * Developer Portal; without it a line says the message had no readable text.
 */
export async function ticketTranscript(rt: ModuleRuntime, threadId: string, header: string[], max: number): Promise<{ text: string; count: number }> {
  const messages: TranscriptMessage[] = [];
  let before: string | undefined;
  while (messages.length < max) {
    const want = Math.min(TRANSCRIPT_PAGE, max - messages.length);
    const page = await rt.rest.messagePage(threadId, want, before);
    messages.push(...page.slice(0, want));
    if (page.length < want) break;
    before = page[page.length - 1].id;
  }
  messages.reverse();
  const lines = [...header, `${messages.length} messages (UTC)`, ""];
  for (const m of messages) {
    const body = m.content || (m.attachments.length || m.embeds ? "" : "(no text)");
    lines.push(`[${stamp(m.timestamp)}] ${m.authorName}${m.bot ? " [bot]" : ""} (${m.authorId ?? "?"}): ${body}`);
    for (const url of m.attachments) lines.push(`    attachment: ${url}`);
    if (m.embeds) lines.push(`    (${m.embeds} embed${m.embeds === 1 ? "" : "s"})`);
  }
  return { text: lines.join("\n") + "\n", count: messages.length };
}

/** Collects the transcript and posts it where the settings say; a failure never stops the close. */
async function sendTranscript(rt: ModuleRuntime, config: TicketsConfig, threadId: string, ownerId: string, closedBy: string) {
  if (!config.transcriptChannelId && !config.transcriptDm) return;
  let transcript: { text: string; count: number };
  try {
    transcript = await ticketTranscript(
      rt,
      threadId,
      [`Ticket ${threadId} in server ${rt.guildId}`, `Opened by ${ownerId} · closed by ${closedBy} at ${stamp(rt.now().toISOString())}`],
      config.transcriptMaxMessages
    );
  } catch (err) {
    rt.logger.warn("Tickets: the transcript could not be read (the bot needs Read Message History)", { message: messageOf(err) });
    return;
  }
  const file = () => ({ name: `transcript-${threadId}.txt`, data: new TextEncoder().encode(transcript.text), contentType: "text/plain; charset=utf-8" });
  if (config.transcriptChannelId) {
    await rt.rest
      .sendMessage(config.transcriptChannelId, {
        content: clip(rt.t("Transcript of <#{thread}> (opened by <@{owner}>, {n} messages).", { thread: threadId, owner: ownerId, n: transcript.count })),
        files: [file()],
      })
      .catch((err) => rt.logger.warn("Tickets: the transcript could not be posted", { message: messageOf(err) }));
  }
  if (config.transcriptDm) {
    try {
      await rt.rest.sendMessage(await rt.rest.openDm(ownerId), { content: clip(rt.t("The transcript of your ticket.")), files: [file()] });
    } catch (err) {
      rt.logger.info("Tickets: transcript not delivered by DM (closed DMs)", { message: messageOf(err) });
    }
  }
  rt.emit("dc:ticket:transcript", { guildId: rt.guildId, threadId, ownerId, messages: transcript.count });
}

export const ticketsModule = defineDcModule({
  id: "tickets",
  name: "Tickets",
  description: "A panel with 'Open a ticket': a private thread per member that the staff (Manage Threads) sees, closed with a button.",
  config: TicketsConfig,
  intents: 0,
  events: [],
  panelIds: ["ticket"],
  commands: () => [
    { name: "tickets", description: "Staff: post the ticket panel here", type: 1, default_member_permissions: permissionBits(["manage_threads"]) },
  ],
  plan: (target) => ({ reply: true, ephemeral: true, update: false, ...(target.kind === "component" && target.id === "close" ? { reply: false } : {}) }),
  async onCommand(invocation, _config, rt) {
    if (invocation.name !== "tickets" || !rt.channelId) return null;
    if (!hasPermissions(rt.memberPermissions, ["manage_threads"])) return ME(rt.t("Only the staff (Manage Threads) can post it."));
    await rt.panels.post("ticket", rt.channelId);
    return ME(rt.t("Ticket panel posted."));
  },
  async renderPanel(panelId, config): Promise<MessagePayload | null> {
    if (panelId !== "ticket") return null;
    return {
      embeds: [{ title: config.title, description: config.description, color: 0x5865f2 }],
      components: [{ type: 1, components: [{ type: 2, style: 1, label: config.buttonLabel, emoji: { name: "🎫" }, custom_id: customId("tickets", "open") }] }],
    };
  },
  async onComponent(use, config, rt) {
    if (!rt.user || !rt.channelId) return null;
    if (use.id === "open") {
      const open = Number((await rt.kv.get(`open:${rt.user.id}`)) ?? 0);
      if (open >= config.maxOpen) return ME(rt.t("You already have an open ticket."));
      const n = await rt.kv.incr("seq", 1);
      let thread: { id: string };
      try {
        thread = await rt.rest.createThread(rt.channelId, { name: `ticket-${n}-${rt.user.name}`.slice(0, 100), private: true, autoArchiveMinutes: 10_080 });
        await rt.rest.addThreadMember(thread.id, rt.user.id);
      } catch (err) {
        rt.logger.warn("Tickets: could not open a thread", { message: messageOf(err) });
        return ME(rt.t("I could not open a private thread here (I need Create Private Threads)."));
      }
      await rt.kv.set(`ticket:${thread.id}`, rt.user.id);
      await rt.kv.incr(`open:${rt.user.id}`, 1);
      await rt.rest.sendMessage(thread.id, {
        content: clip(render(config.welcome, baseVars(rt))),
        components: [{ type: 1, components: [{ type: 2, style: 4, label: "Close", emoji: { name: "🔒" }, custom_id: customId("tickets", "close") }] }],
      });
      if (config.logChannelId) await rt.rest.sendMessage(config.logChannelId, `🎫 Ticket #${n} opened by <@${rt.user.id}>: <#${thread.id}>`).catch(() => undefined);
      return ME(rt.t("Your ticket: <#{thread}>", { thread: thread.id }));
    }
    if (use.id === "close") {
      const owner = await rt.kv.get(`ticket:${rt.channelId}`);
      if (typeof owner !== "string") return ME(rt.t("This is not a ticket."));
      const staff = hasPermissions(rt.memberPermissions, ["manage_threads"]);
      if (owner !== rt.user.id && !staff) return ME(rt.t("Only the member who opened it or the staff can close it."));
      await rt.kv.set(`ticket:${rt.channelId}`, "closed");
      await rt.kv.incr(`open:${owner}`, -1);
      await rt.rest.sendMessage(rt.channelId, `🔒 Closed by <@${rt.user.id}>.`);
      // Read before the thread is archived and locked.
      await sendTranscript(rt, config, rt.channelId, owner, rt.user.id);
      await rt.rest.setThreadState(rt.channelId, { archived: true, locked: true });
      if (config.logChannelId) await rt.rest.sendMessage(config.logChannelId, `🔒 Ticket <#${rt.channelId}> closed by <@${rt.user.id}>`).catch(() => undefined);
      return null;
    }
    return null;
  },
});

export const MODERATION_MODULES: DcModule[] = [moderationModule, automodModule, logsModule, ticketsModule] as DcModule[];

for (const m of MODERATION_MODULES) registerDcModule(m);

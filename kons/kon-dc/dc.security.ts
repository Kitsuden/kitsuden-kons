/**
 * kon-dc — security: anti-nuke, a join gate, raid mode, captcha verification and lockdown
 * ============================================================================
 *
 *   ANTI-NUKE  Discord's audit log arrives live (GUILD_AUDIT_LOG_ENTRY_CREATE). Each executor's
 *              destructive actions are counted per window: deleting channels or roles, banning,
 *              kicking, creating webhooks, adding bots… Past a limit the executor is punished
 *              (their roles stripped and a quarantine role given, or kicked, or banned) and the
 *              alert channel is told. The owner, the bot itself, trusted members and roles are
 *              never acted on. A bot added by an untrusted member is removed.
 *   JOIN GATE  new accounts (younger than N days), no avatar, a word in the name, unverified bots:
 *              kicked, banned or quarantined as they join.
 *   RAID MODE  more than N joins in a minute: for M minutes everyone who joins meets the gate.
 *   CAPTCHA    a "Verify" panel: the member gets a code as an image and types it in a form; the
 *              verified role is the prize. Raid scripts do not read images.
 *   LOCKDOWN   /lockdown on: @everyone loses Send Messages, Add Reactions, Connect and threads,
 *              /lockdown off puts back exactly what it had.
 *
 * Needs the bot's role above the roles it strips, and Manage Roles, Kick, Ban, View Audit Log.
 */

import { randomInt } from "node:crypto";

import { z } from "@kitsuden/engine/zod";

import { INTENTS, Snowflake } from "./dc.contract";
import { clip, customId, defineDcModule, hasPermissions, messageOf, permissionBits, registerDcModule, type DcModule, type ModuleRuntime, type Reply } from "./dc.modules";

const ME = (text: string): Reply => ({ content: clip(text), ephemeral: true });

/** Discord's audit log action types this module counts. */
export const AUDIT = {
  channelCreate: 10,
  channelDelete: 12,
  kick: 20,
  ban: 22,
  botAdd: 28,
  roleCreate: 30,
  roleDelete: 32,
  webhookCreate: 50,
  webhookDelete: 52,
} as const;
type Watched = keyof typeof AUDIT;

const LOCKED = 1n << 11n /* send messages */ | (1n << 6n) /* reactions */ | (1n << 20n) /* connect */ | (1n << 35n) | (1n << 36n) /* threads */ | (1n << 38n); /* send in threads */

const Limit = z.number().int().min(0).max(100);

const SecurityConfig = z
  .object({
    alertChannelId: Snowflake.optional().meta({ title: "Alert channel id", description: "Where every action is reported" }),
    trustedUserIds: z.array(Snowflake).max(50).default([]).meta({ title: "Trusted member ids", description: "Never acted on" }),
    trustedRoleIds: z.array(Snowflake).max(25).default([]).meta({ title: "Trusted role ids" }),
    quarantineRoleId: Snowflake.optional().meta({ title: "Quarantine role id", description: "A role that can see nothing; given to who is caught" }),

    antiNuke: z.boolean().default(true).meta({ title: "Anti-nuke" }),
    windowSeconds: z.number().int().min(10).max(3600).default(60).meta({ title: "Anti-nuke window (seconds)" }),
    punishment: z.enum(["strip", "kick", "ban"]).default("strip").meta({ title: "Punishment", description: "strip: take their roles (and quarantine)" }),
    limitChannelDelete: Limit.default(3).meta({ title: "Channel deletions per window", description: "0 = not counted" }),
    limitRoleDelete: Limit.default(3).meta({ title: "Role deletions per window" }),
    limitBan: Limit.default(5).meta({ title: "Bans per window" }),
    limitKick: Limit.default(5).meta({ title: "Kicks per window" }),
    limitWebhookCreate: Limit.default(3).meta({ title: "Webhooks created per window" }),
    limitChannelCreate: Limit.default(8).meta({ title: "Channels created per window" }),
    limitRoleCreate: Limit.default(8).meta({ title: "Roles created per window" }),
    removeUntrustedBots: z.boolean().default(true).meta({ title: "Remove bots added by untrusted members" }),

    minAccountDays: z.number().int().min(0).max(365).default(0).meta({ title: "Join gate: least account age (days)", description: "0 = no check" }),
    requireAvatar: z.boolean().default(false).meta({ title: "Join gate: refuse accounts without an avatar" }),
    blockedNames: z.array(z.string().min(2).max(40)).max(50).default([]).meta({ title: "Join gate: words not allowed in names" }),
    gateAction: z.enum(["kick", "ban", "quarantine"]).default("kick").meta({ title: "Join gate action" }),

    raidJoinsPerMinute: z.number().int().min(0).max(1000).default(0).meta({ title: "Raid: joins per minute that start raid mode", description: "0 = off" }),
    raidMinutes: z.number().int().min(1).max(1440).default(15).meta({ title: "Raid mode lasts (minutes)" }),

    verifiedRoleId: Snowflake.optional().meta({ title: "Verified role id", description: "What the captcha gives" }),
  })
  .strict();
type SecurityConfig = z.output<typeof SecurityConfig>;

const LIMIT_OF: Record<Watched, keyof SecurityConfig | null> = {
  channelDelete: "limitChannelDelete",
  roleDelete: "limitRoleDelete",
  ban: "limitBan",
  kick: "limitKick",
  webhookCreate: "limitWebhookCreate",
  webhookDelete: null,
  channelCreate: "limitChannelCreate",
  roleCreate: "limitRoleCreate",
  botAdd: null,
};

async function alert(rt: ModuleRuntime, config: SecurityConfig, title: string, text: string, color = 0xed4245) {
  rt.emit("dc:security:alert", { guildId: rt.guildId, title });
  if (!config.alertChannelId) return;
  await rt.rest
    .sendMessage(config.alertChannelId, { embeds: [{ title: `🛡️ ${title}`, description: clip(text, 4000), color, timestamp: rt.now().toISOString() }] })
    .catch((err) => rt.logger.warn("Security: the alert channel refused", { message: messageOf(err) }));
}

/** May the security module act on this member? Never on the owner, the bot, or the trusted. */
async function protectedMember(rt: ModuleRuntime, config: SecurityConfig, userId: string, roles?: string[]): Promise<boolean> {
  if (userId === rt.botUserId || config.trustedUserIds.includes(userId)) return true;
  let owner = await rt.kv.get("owner");
  if (typeof owner !== "string" || !owner) {
    owner = (await rt.rest.getGuildOwner(rt.guildId).catch(() => null)) ?? "";
    await rt.kv.set("owner", owner as string);
  }
  if (owner === userId) return true;
  const r = roles ?? (await rt.rest.getMember(rt.guildId, userId).catch(() => ({ roles: [] as string[] }))).roles;
  return r.some((x) => config.trustedRoleIds.includes(x));
}

async function punish(rt: ModuleRuntime, config: SecurityConfig, userId: string, how: "strip" | "kick" | "ban" | "quarantine", reason: string) {
  if (how === "kick") return rt.rest.kick(rt.guildId, userId, reason);
  if (how === "ban") return rt.rest.ban(rt.guildId, userId, reason, 0);
  const member = await rt.rest.getMember(rt.guildId, userId);
  if (how === "strip") for (const role of member.roles) await rt.rest.removeRole(rt.guildId, userId, role).catch(() => undefined);
  if (config.quarantineRoleId) await rt.rest.addRole(rt.guildId, userId, config.quarantineRoleId);
}

/** Counts an action in the window (this bucket and the previous one): the total. */
async function count(rt: ModuleRuntime, key: string, windowSeconds: number): Promise<number> {
  const bucket = Math.floor(rt.now().getTime() / 1000 / windowSeconds);
  const now = await rt.kv.incr(`n:${key}:${bucket}`, 1);
  const before = Number((await rt.kv.get(`n:${key}:${bucket - 1}`)) ?? 0);
  return now + before;
}

const CAPTCHA_CHARS = "ACDEFHJKMNPRTUVWXY34679";
const CAPTCHA_MINUTES = 5;

export const securityModule = defineDcModule({
  id: "security",
  name: "Security",
  description: "Anti-nuke from the live audit log, a join gate, raid mode, captcha verification and /lockdown.",
  config: SecurityConfig,
  intents: INTENTS.GUILD_MODERATION | INTENTS.GUILD_MEMBERS,
  events: ["GUILD_AUDIT_LOG_ENTRY_CREATE", "GUILD_MEMBER_ADD"],
  panelIds: ["verify"],
  commands: () => [
    {
      name: "lockdown",
      description: "Staff: close or reopen the server",
      type: 1,
      default_member_permissions: permissionBits(["manage_guild"]),
      options: [
        { name: "on", description: "Nobody but the staff writes, reacts or joins voice", type: 1 },
        { name: "off", description: "Put everything back", type: 1 },
      ],
    },
    { name: "verify-panel", description: "Staff: post the verification panel here", type: 1, default_member_permissions: permissionBits(["manage_guild"]) },
  ],
  plan: (target) => {
    if (target.kind === "component" && target.id === "code") {
      return {
        modal: {
          custom_id: customId("security", "captcha"),
          title: "Verification",
          components: [{ type: 1, components: [{ type: 4, custom_id: "code", label: "The code in the image", style: 1, required: true, min_length: 4, max_length: 8 }] }],
        },
      };
    }
    return { reply: true, ephemeral: true };
  },

  async renderPanel(panelId) {
    if (panelId !== "verify") return null;
    return {
      embeds: [{ title: "Verification", description: "Press the button, read the code in the image and type it. It takes ten seconds.", color: 0x5865f2 }],
      components: [{ type: 1, components: [{ type: 2, style: 3, label: "Verify", emoji: { name: "✅" }, custom_id: customId("security", "verify") }] }],
    };
  },

  async onEvent(event, config, rt) {
    // ── Anti-nuke ──
    if (event.type === "GUILD_AUDIT_LOG_ENTRY_CREATE" && event.audit && event.user && config.antiNuke) {
      const kind = (Object.keys(AUDIT) as Watched[]).find((k) => AUDIT[k] === event.audit!.action);
      if (!kind) return;
      const executor = event.user.id;
      if (await protectedMember(rt, config, executor)) return;
      if (kind === "botAdd") {
        if (config.removeUntrustedBots && event.audit.targetId) {
          await rt.rest.kick(rt.guildId, event.audit.targetId, "Anti-nuke: added by an untrusted member").catch(() => undefined);
          await alert(rt, config, "Bot removed", `<@${executor}> added <@${event.audit.targetId}>; it was removed.`, 0xe67e22);
        }
        return;
      }
      const limitKey = LIMIT_OF[kind];
      const limit = limitKey ? Number(config[limitKey]) : 0;
      if (!limit) return;
      const n = await count(rt, `${executor}:${kind}`, config.windowSeconds);
      if (n !== limit + 1) return;
      try {
        await punish(rt, config, executor, config.punishment, `Anti-nuke: ${n} × ${kind} in ${config.windowSeconds}s`);
        await alert(rt, config, "Nuke attempt stopped", `<@${executor}>: ${n} × ${kind} in ${config.windowSeconds} s → ${config.punishment}.`);
      } catch (err) {
        await alert(rt, config, "Nuke attempt NOT stopped", `<@${executor}>: ${n} × ${kind}. I could not act (${messageOf(err)}): my role must be above theirs.`);
      }
      return;
    }

    // ── Join gate and raid mode ──
    if (event.type !== "GUILD_MEMBER_ADD" || !event.user || !event.account) return;
    const a = event.account;
    const userId = event.user.id;
    if (a.bot) {
      if (config.removeUntrustedBots && !a.verifiedBot && !config.trustedUserIds.includes(userId)) {
        await rt.rest.kick(rt.guildId, userId, "Join gate: unverified bot").catch(() => undefined);
        await alert(rt, config, "Unverified bot removed", `<@${userId}> joined and was removed.`, 0xe67e22);
      }
      return;
    }
    let raid = Number((await rt.kv.get("raid-until")) ?? 0) > rt.now().getTime();
    if (config.raidJoinsPerMinute > 0) {
      const joins = await count(rt, "joins", 60);
      if (!raid && joins > config.raidJoinsPerMinute) {
        raid = true;
        await rt.kv.set("raid-until", rt.now().getTime() + config.raidMinutes * 60_000);
        await alert(rt, config, "Raid mode on", `${joins} joins in a minute. For ${config.raidMinutes} minutes everyone who joins meets the gate (${config.gateAction}).`);
      }
    }
    const reasons: string[] = [];
    if (raid) reasons.push("raid mode");
    if (config.minAccountDays > 0 && rt.now().getTime() - a.createdAt < config.minAccountDays * 86_400_000) reasons.push(`account younger than ${config.minAccountDays} days`);
    if (config.requireAvatar && !a.hasAvatar) reasons.push("no avatar");
    const name = a.username.toLowerCase();
    const word = config.blockedNames.find((w) => name.includes(w.toLowerCase()));
    if (word) reasons.push(`"${word}" in the name`);
    if (!reasons.length || config.trustedUserIds.includes(userId)) return;
    try {
      await punish(rt, config, userId, config.gateAction, `Join gate: ${reasons.join(", ")}`);
      await alert(rt, config, "Join gate", `<@${userId}> (${a.username}): ${reasons.join(", ")} → ${config.gateAction}.`, 0xe67e22);
    } catch (err) {
      rt.logger.warn("Security: the join gate could not act", { message: messageOf(err) });
    }
  },

  async onComponent(use, config, rt) {
    if (!rt.user) return null;
    if (use.id === "verify") {
      if (config.verifiedRoleId && rt.memberRoles.includes(config.verifiedRoleId)) return ME(rt.t("You are already verified."));
      const code = Array.from({ length: 5 }, () => CAPTCHA_CHARS[randomInt(0, CAPTCHA_CHARS.length)]).join("");
      await rt.kv.set(`captcha:${rt.user.id}`, `${code}|${rt.now().getTime() + CAPTCHA_MINUTES * 60_000}`);
      const image = await rt.cards.captcha(code);
      const enter = { type: 1, components: [{ type: 2, style: 1, label: "Enter the code", custom_id: customId("security", "code") }] };
      return image
        ? { content: `Type the code in the image (${CAPTCHA_MINUTES} minutes).`, files: [image], components: [enter], ephemeral: true }
        : { content: `Your code: ||${code.split("").join("​")}|| (${CAPTCHA_MINUTES} minutes).`, components: [enter], ephemeral: true };
    }
    return null;
  },

  async onModal(submit, config, rt) {
    if (submit.id !== "captcha" || !rt.user) return null;
    const raw = await rt.kv.get(`captcha:${rt.user.id}`);
    const [code, until] = typeof raw === "string" ? raw.split("|") : ["", "0"];
    if (!code || Number(until) < rt.now().getTime()) return ME(rt.t("That code expired: press Verify again."));
    await rt.kv.set(`captcha:${rt.user.id}`, "");
    if ((submit.fields.code ?? "").trim().toUpperCase() !== code) return ME(rt.t("That is not the code: press Verify for a new one."));
    if (config.verifiedRoleId) await rt.rest.addRole(rt.guildId, rt.user.id, config.verifiedRoleId);
    if (config.quarantineRoleId && rt.memberRoles.includes(config.quarantineRoleId)) await rt.rest.removeRole(rt.guildId, rt.user.id, config.quarantineRoleId);
    rt.emit("dc:security:verified", { guildId: rt.guildId, userId: rt.user.id });
    return ME(rt.t("Verified. Welcome!"));
  },

  async onCommand(invocation, config, rt) {
    if (!hasPermissions(rt.memberPermissions, ["manage_guild"])) return ME(rt.t("Only the staff (Manage Server) can do that."));
    if (invocation.name === "verify-panel") {
      if (!rt.channelId) return null;
      await rt.panels.post("verify", rt.channelId);
      return ME(rt.t("Verification panel posted."));
    }
    if (invocation.name !== "lockdown") return null;
    const everyone = (await rt.rest.listRoles(rt.guildId)).find((r) => r.id === rt.guildId);
    if (!everyone) return ME(rt.t("I could not read the @everyone role."));
    if (invocation.subcommand === "on") {
      if (await rt.kv.get("lockdown")) return ME(rt.t("The server is already locked."));
      await rt.kv.set("lockdown", everyone.permissions);
      await rt.rest.editRole(rt.guildId, rt.guildId, { permissions: String(BigInt(everyone.permissions) & ~LOCKED) }, `Lockdown by ${rt.user?.name ?? "staff"}`);
      await alert(rt, config, "Lockdown on", `By <@${rt.user?.id}>. /lockdown off reopens the server.`);
      return { content: "🔒 The server is locked: only the staff can write or join voice." };
    }
    const before = await rt.kv.get("lockdown");
    if (typeof before !== "string" || !before) return ME(rt.t("The server is not locked."));
    await rt.rest.editRole(rt.guildId, rt.guildId, { permissions: before }, `Lockdown lifted by ${rt.user?.name ?? "staff"}`);
    await rt.kv.set("lockdown", "");
    await alert(rt, config, "Lockdown off", `By <@${rt.user?.id}>.`, 0x57f287);
    return { content: "🔓 The server is open again." };
  },
});

export const SECURITY_MODULES: DcModule[] = [securityModule as DcModule];
for (const m of SECURITY_MODULES) registerDcModule(m);

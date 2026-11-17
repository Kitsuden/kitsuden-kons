/**
 * kon-dc — community modules other bots charge for or spread over several bots
 * ============================================================================
 *
 *   invites       which invite each new member used (MEE6's invite tracker): /invites count |
 *                 leaderboard, a join message with the inviter, rewards (coins, a role) at N invites
 *   sticky-roles  a member's roles saved when they leave and given back when they rejoin (Carl-bot's
 *                 role persistence), with roles left out, or only some kept
 *   temp-roles    /temprole add | remove | list: a role for a while (Dyno); the removal is a schedule,
 *                 so a restart forgets nothing
 *   voice-roles   a role while a member is in a voice channel (Dyno's voice text linking): per
 *                 channel, or for any channel
 *
 * State lives in each module's `rt.kv` and `rt.lists`; the invite count is the shared economy's
 * `invites` currency, so the leaderboard is one query and blueprints and the member page can read it.
 */

import { z } from "@kitsuden/engine/zod";

import { INTENTS, Snowflake } from "./dc.contract";
import {
  baseVars,
  clip,
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
import type { InviteInfo } from "./dc.rest";

const ME = (text: string): Reply => ({ content: clip(text), ephemeral: true });
const idOf = (v: unknown) => (typeof v === "string" && /^\d{15,20}$/.test(v) ? v : null);
const number = (n: number) => new Intl.NumberFormat("en-US").format(n);
const BLURPLE = 0x5865f2;
const DAY_MS = 86_400_000;

// ── Invites ─────────────────────────────────────────────────────────────────────────────────────

/** The economy currency that holds each member's net invites (joined − left; fakes never count). */
export const INVITES_CURRENCY = "invites";
/** Invites kept in the copy: a server with more is unusual, and the rest are not tracked. */
const MAX_CACHED_INVITES = 1000;

const InvitesConfig = z
  .object({
    channelId: Snowflake.optional().meta({ title: "Join message channel id", description: "Empty = no join message" }),
    joinMessage: z
      .string()
      .min(1)
      .max(2000)
      .default("{{user.mention}} joined, invited by {{inviter.mention}} ({{inviter.count}} invites).")
      .meta({ title: "Join message", description: "{{user.mention}}, {{inviter.mention}}, {{inviter.name}}, {{inviter.count}}, {{invite.code}}" }),
    unknownMessage: z
      .string()
      .max(2000)
      .default("{{user.mention}} joined.")
      .meta({ title: "Join message when the invite is unknown", description: "Vanity URL, Server Discovery, two joins at once; empty = say nothing" }),
    fakeAccountDays: z
      .number()
      .int()
      .min(0)
      .max(365)
      .default(7)
      .meta({ title: "Fake: accounts younger than N days", description: "They are counted as fake, not as invites; 0 = never" }),
    rewards: z
      .array(
        z
          .object({
            invites: z.number().int().min(1).max(100_000).meta({ title: "Invites" }),
            roleId: Snowflake.optional().meta({ title: "Role id" }),
            coins: z.number().int().min(0).max(1_000_000).default(0).meta({ title: "Coins" }),
          })
          .strict()
      )
      .max(25)
      .default([])
      .meta({ title: "Rewards", description: "A role and/or coins the first time a member reaches N invites" }),
  })
  .strict();
type InvitesConfig = z.output<typeof InvitesConfig>;

/** Our copy of the server's invites: code → uses, max uses, inviter, and whether Discord deleted it. */
type InviteCache = Record<string, { u: number; m: number; i: string | null; g?: 1 }>;

async function loadCache(rt: ModuleRuntime): Promise<InviteCache | null> {
  const raw = await rt.kv.get("cache");
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as InviteCache) : null;
  } catch {
    return null;
  }
}

async function saveCache(rt: ModuleRuntime, cache: InviteCache): Promise<void> {
  const entries = Object.entries(cache).slice(0, MAX_CACHED_INVITES);
  await rt.kv.set("cache", JSON.stringify(Object.fromEntries(entries)));
}

const cacheOf = (list: InviteInfo[]): InviteCache =>
  Object.fromEntries(list.slice(0, MAX_CACHED_INVITES).map((i) => [i.code, { u: i.uses, m: i.maxUses, i: i.inviterId }]));

/** Reads the server's invites from Discord; null when the bot may not (it needs Manage Server). */
async function liveInvites(rt: ModuleRuntime): Promise<InviteInfo[] | null> {
  try {
    return await rt.rest.listInvites(rt.guildId);
  } catch (err) {
    rt.logger.warn("Invites: Discord refused the invite list (the bot needs Manage Server)", { message: messageOf(err) });
    return null;
  }
}

/**
 * Which invite a join used: the one whose use count went up. When none went up, an invite that
 * Discord deleted at its last use. When two went up (two joins at once, or joins the bot missed),
 * nobody is credited rather than the wrong member.
 */
export function usedInvite(before: InviteCache, now: InviteInfo[]): InviteInfo | null {
  const grew = now.filter((i) => i.uses > (before[i.code]?.u ?? 0));
  if (grew.length === 1) return grew[0];
  if (grew.length > 1) return null;
  const live = new Set(now.map((i) => i.code));
  const spent = Object.entries(before).filter(([code, c]) => !live.has(code) && c.m > 0 && c.u + 1 >= c.m);
  if (spent.length === 1) {
    const [code, c] = spent[0];
    return { code, uses: c.u + 1, maxUses: c.m, inviterId: c.i };
  }
  return null;
}

async function inviteCounts(rt: ModuleRuntime, userId: string) {
  // In series: a module's reads may share one connection.
  const joins = Number((await rt.kv.get(`joins:${userId}`)) ?? 0);
  const left = Number((await rt.kv.get(`left:${userId}`)) ?? 0);
  const fake = Number((await rt.kv.get(`fake:${userId}`)) ?? 0);
  const { balance } = await rt.economy.get(userId, INVITES_CURRENCY);
  return { joins, left, fake, net: balance };
}

async function grantInviteRewards(rt: ModuleRuntime, config: InvitesConfig, inviterId: string, net: number) {
  for (const r of config.rewards.filter((x) => x.invites === net)) {
    // One SQL write claims it: a member who loses an invite and gets it back is not paid twice.
    if ((await rt.kv.incr(`reward:${inviterId}:${r.invites}`, 1)) !== 1) continue;
    if (r.coins > 0) await rt.economy.add(inviterId, "coins", r.coins);
    if (r.roleId) {
      await rt.rest.addRole(rt.guildId, inviterId, r.roleId).catch((err) =>
        rt.logger.warn("Invites: a reward role could not be given", { roleId: r.roleId, message: messageOf(err) })
      );
    }
    rt.emit("dc:invites:reward", { guildId: rt.guildId, userId: inviterId, invites: r.invites });
  }
}

export const invitesModule = defineDcModule({
  id: "invites",
  name: "Invite tracker",
  description: "Who invited whom: /invites count and leaderboard, a join message with the inviter, fake accounts apart, rewards at N invites.",
  config: InvitesConfig,
  intents: INTENTS.GUILD_MEMBERS | INTENTS.GUILD_INVITES,
  events: ["GUILD_CREATE", "GUILD_MEMBER_ADD", "GUILD_MEMBER_REMOVE", "INVITE_CREATE", "INVITE_DELETE"],
  commands: () => [
    {
      name: "invites",
      description: "Invites to this server",
      type: 1,
      options: [
        { name: "count", description: "How many members someone brought", type: 1, options: [{ name: "member", description: "Someone else", type: 6 }] },
        { name: "leaderboard", description: "Who brought the most members", type: 1 },
      ],
    },
  ],
  plan: (target) => ({ reply: true, ephemeral: !(target.kind === "command" && target.subcommand === "leaderboard") }),

  async onConfigure(enabled, _config, rt) {
    if (!enabled) return;
    const list = await liveInvites(rt);
    if (list) await saveCache(rt, cacheOf(list));
  },

  async onEvent(event, config, rt) {
    if (event.type === "GUILD_CREATE") {
      const list = await liveInvites(rt);
      if (list) await saveCache(rt, cacheOf(list));
      return;
    }
    if (event.type === "INVITE_CREATE" && event.invite) {
      const cache = (await loadCache(rt)) ?? {};
      cache[event.invite.code] = { u: event.invite.uses, m: event.invite.maxUses, i: event.invite.inviterId };
      await saveCache(rt, cache);
      return;
    }
    if (event.type === "INVITE_DELETE" && event.invite) {
      // Kept, marked: an invite deleted at its last use still tells who brought the member who used it.
      const cache = (await loadCache(rt)) ?? {};
      if (cache[event.invite.code]) cache[event.invite.code].g = 1;
      await saveCache(rt, cache);
      return;
    }
    const member = event.user;
    if (!member || event.isBot) return;

    if (event.type === "GUILD_MEMBER_REMOVE") {
      const by = await rt.kv.get(`by:${member.id}`);
      if (typeof by !== "string" || !by || (await rt.kv.get(`gone:${member.id}`)) === true) return;
      await rt.kv.set(`gone:${member.id}`, true);
      const [inviterId, fake] = by.split(":");
      if (fake === "f") return;
      await rt.kv.incr(`left:${inviterId}`, 1);
      await rt.economy.add(inviterId, INVITES_CURRENCY, -1);
      return;
    }

    if (event.type !== "GUILD_MEMBER_ADD") return;
    const before = await loadCache(rt);
    const live = await liveInvites(rt);
    if (live) await saveCache(rt, cacheOf(live));
    let used = before && live ? usedInvite(before, live) : null;
    let inviterId = used?.inviterId ?? null;

    // A member who comes back stays credited to whoever brought them the first time.
    const earlier = await rt.kv.get(`by:${member.id}`);
    if (typeof earlier === "string" && earlier) {
      const [firstInviter, fake] = earlier.split(":");
      if ((await rt.kv.get(`gone:${member.id}`)) === true && fake !== "f") {
        await rt.kv.incr(`left:${firstInviter}`, -1);
        await rt.economy.add(firstInviter, INVITES_CURRENCY, 1);
      }
      await rt.kv.set(`gone:${member.id}`, false);
      inviterId = firstInviter;
    } else if (inviterId && inviterId !== member.id) {
      const young = config.fakeAccountDays > 0 && !!event.account?.createdAt && rt.now().getTime() - event.account.createdAt < config.fakeAccountDays * DAY_MS;
      await rt.kv.set(`by:${member.id}`, young ? `${inviterId}:f` : inviterId);
      if (young) await rt.kv.incr(`fake:${inviterId}`, 1);
      else {
        await rt.kv.incr(`joins:${inviterId}`, 1);
        const net = await rt.economy.add(inviterId, INVITES_CURRENCY, 1);
        await grantInviteRewards(rt, config, inviterId, net);
      }
      rt.emit("dc:invites:joined", { guildId: rt.guildId, userId: member.id, inviterId, code: used?.code ?? null, fake: young });
    } else {
      inviterId = null;
    }

    if (!config.channelId) return;
    if (!inviterId) {
      if (config.unknownMessage.trim()) await rt.rest.sendMessage(config.channelId, clip(render(config.unknownMessage, baseVars(rt))));
      return;
    }
    const { net } = await inviteCounts(rt, inviterId);
    const text = render(config.joinMessage, {
      ...baseVars(rt),
      "inviter.id": inviterId,
      "inviter.mention": `<@${inviterId}>`,
      "inviter.name": (await rt.profiles.get(inviterId)).name ?? inviterId,
      "inviter.count": net,
      "invite.code": used?.code ?? "",
    });
    await rt.rest.sendMessage(config.channelId, clip(text));
  },

  async onCommand(invocation, _config, rt) {
    if (invocation.name !== "invites" || !rt.user) return null;
    if (invocation.subcommand === "leaderboard") {
      const rows = (await rt.economy.top(INVITES_CURRENCY, 10)).filter((r) => r.balance > 0);
      const lines = rows.map((r, n) => `**${n + 1}.** <@${r.userId}> — ${rt.t("{n} invites", { n: number(r.balance) })}`);
      return { embeds: [{ title: `📨 ${rt.t("Top inviters")}`, description: lines.join("\n") || rt.t("Nobody yet."), color: BLURPLE }] };
    }
    const who = idOf(invocation.options.member) ?? rt.user.id;
    const c = await inviteCounts(rt, who);
    return ME(rt.t("<@{who}> has {net} invites ({joins} joined, {left} left, {fake} fake).", { who, net: c.net, joins: c.joins, left: c.left, fake: c.fake }));
  },
});

// ── Sticky roles ────────────────────────────────────────────────────────────────────────────────

/** Roles given back at most, one call each. */
const MAX_RESTORED_ROLES = 50;

const StickyRolesConfig = z
  .object({
    excludedRoleIds: z.array(Snowflake).max(100).default([]).meta({ title: "Roles never given back", description: "Muted, verified, temporary…" }),
    onlyRoleIds: z.array(Snowflake).max(100).default([]).meta({ title: "Keep only these roles", description: "Empty = every role but the ones left out" }),
  })
  .strict();

const rolesKey = (userId: string) => `roles:${userId}`;

export const stickyRolesModule = defineDcModule({
  id: "sticky-roles",
  name: "Sticky roles",
  description: "Saves a member's roles when they leave and gives them back when they rejoin, except the roles you leave out.",
  config: StickyRolesConfig,
  intents: INTENTS.GUILD_MEMBERS,
  events: ["GUILD_MEMBER_ADD", "GUILD_MEMBER_UPDATE", "GUILD_MEMBER_REMOVE"],
  async onEvent(event, config, rt) {
    const member = event.user;
    if (!member || event.isBot) return;
    // Discord's leave event carries no roles: the copy is kept from joins and role changes.
    if (event.type === "GUILD_MEMBER_UPDATE") {
      if ((await rt.kv.get(`gone:${member.id}`)) === true) return;
      await rt.kv.set(rolesKey(member.id), (event.memberRoles ?? []).join(","));
      return;
    }
    if (event.type === "GUILD_MEMBER_REMOVE") {
      if (typeof (await rt.kv.get(rolesKey(member.id))) === "string") await rt.kv.set(`gone:${member.id}`, true);
      return;
    }
    if (event.type !== "GUILD_MEMBER_ADD") return;
    if ((await rt.kv.get(`gone:${member.id}`)) !== true) {
      await rt.kv.set(rolesKey(member.id), (event.memberRoles ?? []).join(","));
      return;
    }
    await rt.kv.set(`gone:${member.id}`, false);
    const saved = await rt.kv.get(rolesKey(member.id));
    const roles = (typeof saved === "string" ? saved.split(",") : [])
      .filter((r) => /^\d{15,20}$/.test(r) && r !== rt.guildId)
      .filter((r) => !config.excludedRoleIds.includes(r))
      .filter((r) => !config.onlyRoleIds.length || config.onlyRoleIds.includes(r))
      .filter((r) => !(event.memberRoles ?? []).includes(r))
      .slice(0, MAX_RESTORED_ROLES);
    const given: string[] = [];
    for (const roleId of roles) {
      try {
        await rt.rest.addRole(rt.guildId, member.id, roleId);
        given.push(roleId);
      } catch (err) {
        // A deleted role, one above the bot's, or a managed one (boosters, integrations).
        rt.logger.info("Sticky roles: a role was not given back", { roleId, message: messageOf(err) });
      }
    }
    if (given.length) rt.emit("dc:sticky-roles:restored", { guildId: rt.guildId, userId: member.id, roles: given });
  },
});

// ── Temporary roles ─────────────────────────────────────────────────────────────────────────────

const TempRolesConfig = z
  .object({
    maxDays: z.number().int().min(1).max(365).default(365).meta({ title: "Longest duration (days)" }),
    allowedRoleIds: z.array(Snowflake).max(100).default([]).meta({ title: "Roles that may be given", description: "Empty = any role below the giver's highest" }),
    logChannelId: Snowflake.optional().meta({ title: "Log channel id" }),
  })
  .strict();

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS };

/**
 * "30m", "2h", "1d12h", "1w": milliseconds, or null. Read character by character (no regular
 * expression on what a member typed).
 */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (!s || s.length > 32) return null;
  let total = 0;
  let digits = "";
  let parts = 0;
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") {
      digits += ch;
      continue;
    }
    if (ch === " ") continue;
    const unit = UNIT_MS[ch];
    if (!unit || !digits || digits.length > 6) return null;
    total += Number(digits) * unit;
    digits = "";
    parts++;
  }
  // A bare number is minutes.
  if (digits) {
    if (parts || digits.length > 6) return null;
    total = Number(digits) * UNIT_MS.m;
  }
  return total > 0 ? total : null;
}

type TempRoleMap = Record<string, number>;

async function tempRolesOf(rt: ModuleRuntime, userId: string): Promise<TempRoleMap> {
  const raw = await rt.kv.get(`tr:${userId}`);
  if (typeof raw !== "string" || !raw) return {};
  try {
    return JSON.parse(raw) as TempRoleMap;
  } catch {
    return {};
  }
}

async function saveTempRoles(rt: ModuleRuntime, userId: string, map: TempRoleMap) {
  await rt.kv.set(`tr:${userId}`, JSON.stringify(map));
  if (Object.keys(map).length) await rt.lists.join("active", userId);
  else await rt.lists.leave("active", userId);
}

/** May this member hand out this role? Below their highest role (the owner may give any). */
async function mayGive(rt: ModuleRuntime, roleId: string, allowed: string[]): Promise<string | null> {
  if (roleId === rt.guildId) return rt.t("That role cannot be given.");
  if (allowed.length && !allowed.includes(roleId)) return rt.t("That role is not one of the roles this server gives for a while.");
  if (rt.user && (await rt.rest.getGuildOwner(rt.guildId).catch(() => null)) === rt.user.id) return null;
  const roles = await rt.rest.listRoles(rt.guildId);
  const target = roles.find((r) => r.id === roleId);
  if (!target) return rt.t("That role does not exist.");
  if (target.managed) return rt.t("That role cannot be given.");
  const highest = Math.max(0, ...roles.filter((r) => rt.memberRoles.includes(r.id)).map((r) => r.position));
  return target.position < highest ? null : rt.t("You can only give roles below your highest role.");
}

const scheduleKey = (userId: string, roleId: string) => `tr-${userId}-${roleId}`;

export const tempRolesModule = defineDcModule({
  id: "temp-roles",
  name: "Temporary roles",
  description: "/temprole add <member> <role> <duration>: the role goes away by itself, even after a restart; /temprole remove and list.",
  config: TempRolesConfig,
  intents: 0,
  events: [],
  commands: () => [
    {
      name: "temprole",
      description: "Staff: roles for a while",
      type: 1,
      default_member_permissions: permissionBits(["manage_roles"]),
      options: [
        {
          name: "add",
          description: "Give a role for a while",
          type: 1,
          options: [
            { name: "member", description: "Who", type: 6, required: true },
            { name: "role", description: "Which role", type: 8, required: true },
            { name: "duration", description: "30m, 2h, 7d, 1w, 1d12h", type: 3, required: true, max_length: 32 },
          ],
        },
        {
          name: "remove",
          description: "Take a temporary role now",
          type: 1,
          options: [
            { name: "member", description: "Who", type: 6, required: true },
            { name: "role", description: "Which role", type: 8, required: true },
          ],
        },
        { name: "list", description: "Temporary roles and when they end", type: 1, options: [{ name: "member", description: "Only this member", type: 6 }] },
      ],
    },
  ],
  plan: () => ({ reply: true, ephemeral: true }),

  async onCommand(invocation, config, rt) {
    if (invocation.name !== "temprole" || !rt.user) return null;
    if (!hasPermissions(rt.memberPermissions, ["manage_roles"])) return ME(rt.t("Only the staff (Manage Roles) can do that."));
    const who = idOf(invocation.options.member);
    const roleId = idOf(invocation.options.role);

    if (invocation.subcommand === "list") {
      const members = who ? [who] : await rt.lists.members("active", 50);
      const lines: string[] = [];
      for (const userId of members) {
        for (const [role, until] of Object.entries(await tempRolesOf(rt, userId))) lines.push(`<@${userId}> · <@&${role}> · <t:${Math.floor(until / 1000)}:R>`);
      }
      return { embeds: [{ title: `⏳ ${rt.t("Temporary roles")}`, description: lines.slice(0, 50).join("\n") || rt.t("None."), color: BLURPLE }], ephemeral: true };
    }

    if (!who || !roleId) return ME(rt.t("Pick a member and a role."));

    if (invocation.subcommand === "remove") {
      const map = await tempRolesOf(rt, who);
      if (!(roleId in map)) return ME(rt.t("<@{who}> has no temporary <@&{role}>.", { who, role: roleId }));
      delete map[roleId];
      await saveTempRoles(rt, who, map);
      await rt.schedule.cancel(scheduleKey(who, roleId));
      await rt.rest.removeRole(rt.guildId, who, roleId).catch(() => undefined);
      return ME(rt.t("<@&{role}> taken from <@{who}>.", { who, role: roleId }));
    }

    if (invocation.subcommand !== "add") return null;
    const ms = parseDuration(String(invocation.options.duration ?? ""));
    if (!ms) return ME(rt.t("Write the duration like 30m, 2h, 7d or 1d12h."));
    if (ms > config.maxDays * DAY_MS) return ME(rt.t("At most {days} days.", { days: config.maxDays }));
    const refused = await mayGive(rt, roleId, config.allowedRoleIds);
    if (refused) return ME(refused);
    try {
      await rt.rest.addRole(rt.guildId, who, roleId);
    } catch (err) {
      rt.logger.warn("Temp roles: Discord refused the role", { message: messageOf(err) });
      return ME(rt.t("I could not give that role: my role must be above it, with Manage Roles."));
    }
    const until = rt.now().getTime() + ms;
    const map = await tempRolesOf(rt, who);
    map[roleId] = until;
    await saveTempRoles(rt, who, map);
    await rt.schedule.at(new Date(until), { userId: who, roleId }, scheduleKey(who, roleId));
    if (config.logChannelId) {
      await rt.rest
        .sendMessage(config.logChannelId, `⏳ <@&${roleId}> → <@${who}> (${duration(ms / 1000)}, <@${rt.user.id}>)`)
        .catch(() => undefined);
    }
    return ME(rt.t("<@{who}> has <@&{role}> until <t:{at}:f>.", { who, role: roleId, at: Math.floor(until / 1000) }));
  },

  async onSchedule(_key, payload, config, rt) {
    const userId = idOf(payload.userId);
    const roleId = idOf(payload.roleId);
    if (!userId || !roleId) return;
    const map = await tempRolesOf(rt, userId);
    delete map[roleId];
    await saveTempRoles(rt, userId, map);
    try {
      await rt.rest.removeRole(rt.guildId, userId, roleId);
    } catch (err) {
      // The member left, or the role is gone: nothing to take.
      rt.logger.info("Temp roles: the role could not be taken", { message: messageOf(err) });
    }
    if (config.logChannelId) await rt.rest.sendMessage(config.logChannelId, `⌛ <@&${roleId}> ✕ <@${userId}>`).catch(() => undefined);
    rt.emit("dc:temp-role:expired", { guildId: rt.guildId, userId, roleId });
  },
});

// ── Voice roles ─────────────────────────────────────────────────────────────────────────────────

const VoiceRolesConfig = z
  .object({
    links: z
      .array(
        z
          .object({
            channelId: Snowflake.meta({ title: "Voice channel id" }),
            roleId: Snowflake.meta({ title: "Role id" }),
          })
          .strict()
      )
      .max(50)
      .default([])
      .meta({ title: "Per channel", description: "This role while in that voice channel" }),
    anyChannelRoleId: Snowflake.optional().meta({ title: "Role in any voice channel" }),
    ignoredChannelIds: z.array(Snowflake).max(50).default([]).meta({ title: "Voice channels that give no role", description: "AFK, stages…" }),
  })
  .strict()
  .refine((c) => c.links.length > 0 || !!c.anyChannelRoleId, { message: "Link at least one channel, or set the role for any channel" });
type VoiceRolesConfig = z.output<typeof VoiceRolesConfig>;

function voiceRolesFor(channelId: string | null, config: VoiceRolesConfig): Set<string> {
  const roles = new Set<string>();
  if (!channelId || config.ignoredChannelIds.includes(channelId)) return roles;
  for (const l of config.links) if (l.channelId === channelId) roles.add(l.roleId);
  if (config.anyChannelRoleId) roles.add(config.anyChannelRoleId);
  return roles;
}

export const voiceRolesModule = defineDcModule({
  id: "voice-roles",
  name: "Voice roles",
  description: "A role while a member is in a voice channel (one per channel, or one for any): taken back when they leave.",
  config: VoiceRolesConfig,
  intents: INTENTS.GUILD_VOICE_STATES,
  events: ["VOICE_STATE_UPDATE"],
  async onEvent(event, config, rt) {
    const v = event.voice;
    if (event.type !== "VOICE_STATE_UPDATE" || !v || !rt.user || event.isBot || v.from === v.to) return;
    const before = voiceRolesFor(v.from, config);
    const after = voiceRolesFor(v.to, config);
    for (const roleId of before) {
      if (after.has(roleId)) continue;
      await rt.rest.removeRole(rt.guildId, rt.user.id, roleId).catch((err) => rt.logger.info("Voice roles: a role was not taken", { message: messageOf(err) }));
    }
    for (const roleId of after) {
      if (before.has(roleId) || (event.memberRoles ?? []).includes(roleId)) continue;
      await rt.rest.addRole(rt.guildId, rt.user.id, roleId).catch((err) => rt.logger.warn("Voice roles: a role was not given", { message: messageOf(err) }));
    }
  },
});

export const COMMUNITY_MODULES: DcModule[] = [invitesModule, stickyRolesModule, tempRolesModule, voiceRolesModule] as DcModule[];
for (const m of COMMUNITY_MODULES) registerDcModule(m);

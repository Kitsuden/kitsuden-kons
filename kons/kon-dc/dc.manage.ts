/**
 * kon-dc — what the admin view manages beyond settings: the overview, each server's economy,
 * a member's file, activity and the work the bot has scheduled.
 *
 *   GET    /api/dc/overview                               totals and the last 30 days, every server
 *   GET    /api/dc/guilds/:guildId/economy                a currency's ranking in a server
 *   PUT    /api/dc/guilds/:guildId/economy/:userId        set or adjust a member's balance
 *   GET    /api/dc/guilds/:guildId/members/:userId        a member: balances, items, activity, profile
 *   GET    /api/dc/guilds/:guildId/activity               messages and voice per day, top members
 *   GET    /api/dc/guilds/:guildId/schedules              work the bot will do later
 *   DELETE /api/dc/guilds/:guildId/schedules/:id          cancel one
 *
 * They run inside the request's transaction: queries in series, nothing goes to Discord.
 */

import { AppError, defineOperation, isUuid, type AnyOperation } from "@kitsuden/engine";
import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { DC_EVENTS, Snowflake } from "./dc.contract";
import type { DcDb } from "./dc.engine";
import {
  dcActivity,
  dcBlueprints,
  dcGuildModules,
  dcGuildPlans,
  dcGuilds,
  dcInventory,
  dcItems,
  dcProfiles,
  dcSchedules,
  dcWallets,
} from "./dc.schema";

type Team = (action: "view" | "create" | "update" | "delete") => { policy: { resource: string; action: string } };

export interface ManageDeps {
  db: DcDb;
  team: Team;
  now: () => Date;
  guildOr404: (guildId: string) => Promise<{ id: string; name: string }>;
  /** Drop the engine's cache of a server (after a write the bot reads). */
  forget: (guildId: string) => void;
  emit: (event: string, data: Record<string, unknown>) => void;
}

const DAY_MS = 86_400_000;
const dayOf = (d: Date) => Math.floor(d.getTime() / DAY_MS);
const dateOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

const Currency = z
  .string()
  .regex(/^[a-z0-9_-]{1,32}$/, "lowercase letters, digits, - and _")
  .describe("Currency: coins, xp or any other a module or blueprint uses");

const DayPoint = z.object({ date: z.string().describe("YYYY-MM-DD, UTC"), messages: z.number().int(), voiceMinutes: z.number().int() });
const Ranked = z.object({ userId: z.string(), name: z.string().nullable(), value: z.number() });

/** Every day of the window, zeros included, so a chart has no holes. */
function series(rows: { day: number; messages: number; voiceMinutes: number }[], from: number, to: number) {
  const byDay = new Map(rows.map((r) => [Number(r.day), r]));
  const out: z.infer<typeof DayPoint>[] = [];
  for (let d = from; d <= to; d++) {
    const r = byDay.get(d);
    out.push({ date: dateOf(d), messages: Number(r?.messages ?? 0), voiceMinutes: Number(r?.voiceMinutes ?? 0) });
  }
  return out;
}

export function manageOperations({ db, team, now, guildOr404, forget, emit }: ManageDeps): AnyOperation[] {
  const GuildParam = z.object({ guildId: Snowflake.describe("Discord server id") });

  async function namesOf(ids: string[]): Promise<Map<string, string | null>> {
    if (!ids.length) return new Map();
    const rows = await db.select({ userId: dcProfiles.userId, name: dcProfiles.name }).from(dcProfiles).where(inArray(dcProfiles.userId, ids));
    return new Map(rows.map((r) => [r.userId, r.name]));
  }

  return [
    defineOperation({
      id: "get-overview",
      method: "GET",
      route: "/overview",
      summary: "Discord bot overview",
      description:
        "Totals across every server the bot knows (servers, modules on, blueprints, catalog items, premium servers, members with a balance) and messages and voice minutes per day for the last 30 days, with the busiest servers.",
      access: "session",
      permission: team("view"),
      output: {
        schema: z.object({
          totals: z.object({
            guilds: z.number().int(),
            activeGuilds: z.number().int().describe("The bot is still in them"),
            modulesOn: z.number().int(),
            blueprints: z.number().int(),
            publishedBlueprints: z.number().int(),
            items: z.number().int(),
            premiumGuilds: z.number().int(),
            members: z.number().int().describe("Distinct members with a balance in any server"),
          }),
          days: z.array(DayPoint),
          topGuilds: z.array(z.object({ guildId: z.string(), name: z.string(), messages: z.number().int(), voiceMinutes: z.number().int() })),
        }),
      },
      handle: async () => {
        const today = dayOf(now());
        const from = today - 29;
        const [g] = await db.select({ all: count(), active: sql<number>`count(*) filter (where ${dcGuilds.leftAt} is null)` }).from(dcGuilds);
        const [m] = await db.select({ n: count() }).from(dcGuildModules).where(eq(dcGuildModules.enabled, true));
        const [b] = await db
          .select({ all: count(), published: sql<number>`count(*) filter (where ${dcBlueprints.status} = 'published')` })
          .from(dcBlueprints);
        const [i] = await db.select({ n: count() }).from(dcItems);
        const [p] = await db
          .select({ n: count() })
          .from(dcGuildPlans)
          .where(and(eq(dcGuildPlans.plan, "premium"), sql`(${dcGuildPlans.until} is null or ${dcGuildPlans.until} > ${now().toISOString()})`));
        const [w] = await db.select({ n: sql<number>`count(distinct ${dcWallets.userId})` }).from(dcWallets);
        const perDay = await db
          .select({
            day: dcActivity.day,
            messages: sql<number>`sum(${dcActivity.messages})::int`,
            voiceMinutes: sql<number>`sum(${dcActivity.voiceMinutes})::int`,
          })
          .from(dcActivity)
          .where(gte(dcActivity.day, from))
          .groupBy(dcActivity.day);
        const top = await db
          .select({
            guildId: dcActivity.guildId,
            name: dcGuilds.name,
            messages: sql<number>`sum(${dcActivity.messages})::int`,
            voiceMinutes: sql<number>`sum(${dcActivity.voiceMinutes})::int`,
          })
          .from(dcActivity)
          .innerJoin(dcGuilds, eq(dcGuilds.id, dcActivity.guildId))
          .where(gte(dcActivity.day, from))
          .groupBy(dcActivity.guildId, dcGuilds.name)
          .orderBy(desc(sql`sum(${dcActivity.messages})`))
          .limit(5);
        return {
          totals: {
            guilds: Number(g?.all ?? 0),
            activeGuilds: Number(g?.active ?? 0),
            modulesOn: Number(m?.n ?? 0),
            blueprints: Number(b?.all ?? 0),
            publishedBlueprints: Number(b?.published ?? 0),
            items: Number(i?.n ?? 0),
            premiumGuilds: Number(p?.n ?? 0),
            members: Number(w?.n ?? 0),
          },
          days: series(perDay, from, today),
          topGuilds: top.map((t) => ({ ...t, messages: Number(t.messages), voiceMinutes: Number(t.voiceMinutes) })),
        };
      },
    }),

    defineOperation({
      id: "get-guild-economy",
      method: "GET",
      route: "/guilds/:guildId/economy",
      summary: "A currency's ranking in a Discord server",
      description:
        "The currencies members hold in this server and, for the one asked (coins by default), the members by balance, highest first, with the total in circulation.",
      access: "session",
      permission: team("view"),
      input: {
        params: GuildParam,
        query: z.object({
          currency: Currency.optional(),
          limit: z.coerce.number().int().min(1).max(200).optional().describe("Members to return (default 50)"),
        }),
      },
      output: {
        schema: z.object({
          currency: z.string(),
          currencies: z.array(z.object({ currency: z.string(), members: z.number().int(), total: z.number() })),
          total: z.number(),
          docs: z.array(Ranked),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params, query }) => {
        await guildOr404(params.guildId);
        const currencies = (
          await db
            .select({ currency: dcWallets.currency, members: count(), total: sql<number>`coalesce(sum(${dcWallets.balance}), 0)::bigint` })
            .from(dcWallets)
            .where(eq(dcWallets.guildId, params.guildId))
            .groupBy(dcWallets.currency)
            .orderBy(asc(dcWallets.currency))
        ).map((r) => ({ currency: r.currency, members: Number(r.members), total: Number(r.total) }));
        const currency = query.currency ?? (currencies.some((c) => c.currency === "coins") ? "coins" : (currencies[0]?.currency ?? "coins"));
        const rows = await db
          .select({ userId: dcWallets.userId, value: dcWallets.balance })
          .from(dcWallets)
          .where(and(eq(dcWallets.guildId, params.guildId), eq(dcWallets.currency, currency)))
          .orderBy(desc(dcWallets.balance), asc(dcWallets.userId))
          .limit(query.limit ?? 50);
        const names = await namesOf(rows.map((r) => r.userId));
        return {
          currency,
          currencies,
          total: currencies.find((c) => c.currency === currency)?.total ?? 0,
          docs: rows.map((r) => ({ userId: r.userId, name: names.get(r.userId) ?? null, value: Number(r.value) })),
        };
      },
    }),

    defineOperation({
      id: "set-member-balance",
      method: "PUT",
      route: "/guilds/:guildId/economy/:userId",
      summary: "Set or adjust a member's balance",
      description:
        "Gives (`add` > 0), takes (`add` < 0, never below zero) or sets (`set`) a member's balance of one currency in this server. For XP the member's level follows the new figure the next time they earn some.",
      access: "session",
      permission: team("update"),
      input: {
        params: GuildParam.extend({ userId: Snowflake.describe("Discord user id") }),
        body: z
          .object({
            currency: Currency,
            add: z.number().int().min(-1e12).max(1e12).optional(),
            set: z.number().int().min(0).max(1e15).optional(),
            reason: z.string().max(200).optional(),
          })
          .refine((b) => (b.add === undefined) !== (b.set === undefined), "Send `add` or `set`, one of them"),
      },
      output: { schema: z.object({ userId: z.string(), currency: z.string(), balance: z.number() }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_VALIDATION"],
      handle: async ({ params, body }) => {
        await guildOr404(params.guildId);
        const start = body.set ?? Math.max(0, body.add ?? 0);
        const [row] = await db
          .insert(dcWallets)
          .values({ guildId: params.guildId, userId: params.userId, currency: body.currency, balance: start })
          .onConflictDoUpdate({
            target: [dcWallets.guildId, dcWallets.currency, dcWallets.userId],
            set: {
              balance: body.set !== undefined ? body.set : sql`greatest(0, ${dcWallets.balance} + ${body.add ?? 0})`,
              updatedAt: new Date(),
            },
          })
          .returning({ balance: dcWallets.balance });
        forget(params.guildId);
        emit(DC_EVENTS.economyAdjusted, {
          guildId: params.guildId,
          userId: params.userId,
          currency: body.currency,
          balance: Number(row?.balance ?? 0),
          reason: body.reason ?? null,
        });
        return { userId: params.userId, currency: body.currency, balance: Number(row?.balance ?? 0) };
      },
    }),

    defineOperation({
      id: "get-guild-member",
      method: "GET",
      route: "/guilds/:guildId/members/:userId",
      summary: "A member of a Discord server",
      description: "A member's balances and items in this server, their messages and voice minutes of the last 30 days, and their bot profile.",
      access: "session",
      permission: team("view"),
      input: { params: GuildParam.extend({ userId: Snowflake.describe("Discord user id") }) },
      output: {
        schema: z.object({
          userId: z.string(),
          profile: z
            .object({ name: z.string().nullable(), bio: z.string().nullable(), rep: z.number().int(), badges: z.array(z.string()), dailyStreak: z.number().int() })
            .nullable(),
          balances: z.array(z.object({ currency: z.string(), balance: z.number() })),
          items: z.array(z.object({ item: z.string(), name: z.string().nullable(), emoji: z.string().nullable(), quantity: z.number().int() })),
          activity: z.object({ messages: z.number().int(), voiceMinutes: z.number().int(), days: z.array(DayPoint) }),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }) => {
        await guildOr404(params.guildId);
        const [profile] = await db.select().from(dcProfiles).where(eq(dcProfiles.userId, params.userId)).limit(1);
        const balances = await db
          .select({ currency: dcWallets.currency, balance: dcWallets.balance })
          .from(dcWallets)
          .where(and(eq(dcWallets.guildId, params.guildId), eq(dcWallets.userId, params.userId)))
          .orderBy(asc(dcWallets.currency));
        const owned = await db
          .select({ item: dcInventory.item, quantity: dcInventory.quantity })
          .from(dcInventory)
          .where(and(eq(dcInventory.guildId, params.guildId), eq(dcInventory.userId, params.userId), sql`${dcInventory.quantity} > 0`))
          .orderBy(asc(dcInventory.item));
        const catalog = owned.length
          ? await db
              .select({ item: dcItems.item, name: dcItems.name, emoji: dcItems.emoji, guildId: dcItems.guildId })
              .from(dcItems)
              .where(
                and(
                  inArray(
                    dcItems.item,
                    owned.map((o) => o.item)
                  ),
                  sql`(${dcItems.guildId} = ${params.guildId} or ${dcItems.guildId} is null)`
                )
              )
          : [];
        // A server's own item wins over a global one of the same id.
        const info = new Map<string, { name: string; emoji: string | null }>();
        for (const c of [...catalog].sort((a, b) => (a.guildId ? 1 : 0) - (b.guildId ? 1 : 0))) info.set(c.item, { name: c.name, emoji: c.emoji });
        const today = dayOf(now());
        const from = today - 29;
        const days = await db
          .select({ day: dcActivity.day, messages: dcActivity.messages, voiceMinutes: dcActivity.voiceMinutes })
          .from(dcActivity)
          .where(and(eq(dcActivity.guildId, params.guildId), eq(dcActivity.userId, params.userId), gte(dcActivity.day, from)));
        const points = series(days, from, today);
        return {
          userId: params.userId,
          profile: profile
            ? { name: profile.name, bio: profile.bio, rep: profile.rep, badges: profile.badges ?? [], dailyStreak: profile.dailyStreak }
            : null,
          balances: balances.map((b) => ({ currency: b.currency, balance: Number(b.balance) })),
          items: owned.map((o) => ({ item: o.item, name: info.get(o.item)?.name ?? null, emoji: info.get(o.item)?.emoji ?? null, quantity: o.quantity })),
          activity: {
            messages: points.reduce((s, p) => s + p.messages, 0),
            voiceMinutes: points.reduce((s, p) => s + p.voiceMinutes, 0),
            days: points,
          },
        };
      },
    }),

    defineOperation({
      id: "get-guild-activity",
      method: "GET",
      route: "/guilds/:guildId/activity",
      summary: "Activity in a Discord server",
      description:
        "Messages and voice minutes per day (UTC) over the window asked for, and the members who wrote and talked most in it. Counted while the `stats` or `leveling` module is on.",
      access: "session",
      permission: team("view"),
      input: {
        params: GuildParam,
        query: z.object({ days: z.coerce.number().int().min(1).max(365).optional().describe("Window in days, today included (default 30)") }),
      },
      output: {
        schema: z.object({
          days: z.array(DayPoint),
          totals: z.object({ messages: z.number().int(), voiceMinutes: z.number().int(), members: z.number().int() }),
          topMessages: z.array(Ranked),
          topVoice: z.array(Ranked),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params, query }) => {
        await guildOr404(params.guildId);
        const today = dayOf(now());
        const from = today - ((query.days ?? 30) - 1);
        const where = and(eq(dcActivity.guildId, params.guildId), gte(dcActivity.day, from));
        const perDay = await db
          .select({
            day: dcActivity.day,
            messages: sql<number>`sum(${dcActivity.messages})::int`,
            voiceMinutes: sql<number>`sum(${dcActivity.voiceMinutes})::int`,
          })
          .from(dcActivity)
          .where(where)
          .groupBy(dcActivity.day);
        const perMember = await db
          .select({
            userId: dcActivity.userId,
            messages: sql<number>`sum(${dcActivity.messages})::int`,
            voiceMinutes: sql<number>`sum(${dcActivity.voiceMinutes})::int`,
          })
          .from(dcActivity)
          .where(where)
          .groupBy(dcActivity.userId);
        const rank = (key: "messages" | "voiceMinutes") =>
          perMember
            .map((r) => ({ userId: r.userId, value: Number(r[key]) }))
            .filter((r) => r.value > 0)
            .sort((a, b) => b.value - a.value || a.userId.localeCompare(b.userId))
            .slice(0, 10);
        const topMessages = rank("messages");
        const topVoice = rank("voiceMinutes");
        const names = await namesOf([...new Set([...topMessages, ...topVoice].map((r) => r.userId))]);
        const named = (rows: { userId: string; value: number }[]) => rows.map((r) => ({ ...r, name: names.get(r.userId) ?? null }));
        const days = series(perDay, from, today);
        return {
          days,
          totals: {
            messages: days.reduce((s, p) => s + p.messages, 0),
            voiceMinutes: days.reduce((s, p) => s + p.voiceMinutes, 0),
            members: perMember.length,
          },
          topMessages: named(topMessages),
          topVoice: named(topVoice),
        };
      },
    }),

    defineOperation({
      id: "list-guild-schedules",
      method: "GET",
      route: "/guilds/:guildId/schedules",
      summary: "Work a Discord server's bot will do later",
      description:
        "Giveaway draws, reminders, scheduled messages, birthday checks, blueprint `later` steps and other work queued for this server, soonest first. Recurring ones carry their `spec`.",
      access: "session",
      permission: team("view"),
      input: { params: GuildParam },
      output: {
        schema: z.object({
          docs: z.array(
            z.object({
              id: z.string(),
              moduleId: z.string(),
              key: z.string(),
              runAt: z.string().datetime({ offset: true }),
              recurring: z.boolean(),
              spec: z.record(z.string(), z.unknown()).nullable(),
              payload: z.record(z.string(), z.unknown()),
            })
          ),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }) => {
        await guildOr404(params.guildId);
        const rows = await db.select().from(dcSchedules).where(eq(dcSchedules.guildId, params.guildId)).orderBy(asc(dcSchedules.runAt)).limit(500);
        return {
          docs: rows.map((r) => ({
            id: r.id,
            moduleId: r.moduleId,
            key: r.key,
            runAt: r.runAt.toISOString(),
            recurring: !!r.spec,
            spec: r.spec ?? null,
            payload: r.payload ?? {},
          })),
        };
      },
    }),

    defineOperation({
      id: "cancel-guild-schedule",
      method: "DELETE",
      route: "/guilds/:guildId/schedules/:id",
      summary: "Cancel work a Discord server's bot would do later",
      description:
        "Removes one queued job. A recurring one that a module declares comes back while that module stays on (switch the module off, or change its settings, to stop it for good).",
      access: "session",
      permission: team("delete"),
      input: { params: GuildParam.extend({ id: z.string().describe("Schedule id (uuid)") }) },
      output: { schema: z.object({ deleted: z.literal(true) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }) => {
        await guildOr404(params.guildId);
        if (!isUuid(params.id)) throw AppError.notFound("Schedule not found");
        const gone = await db
          .delete(dcSchedules)
          .where(and(eq(dcSchedules.id, params.id), eq(dcSchedules.guildId, params.guildId)))
          .returning({ id: dcSchedules.id });
        if (!gone.length) throw AppError.notFound("Schedule not found");
        return { deleted: true as const };
      },
    }),
  ];
}


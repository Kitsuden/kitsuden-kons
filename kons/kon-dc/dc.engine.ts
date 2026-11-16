/**
 * kon-dc — the engine: modules per server, interactions, gateway and kon events, panels, commands
 * ============================================================================
 *
 * Three ways in, none holding a socket in this process:
 *
 *   · INTERACTIONS (slash commands, autocomplete, buttons, selects, modals): Discord POSTs them,
 *     signed, to `/api/dc/interactions`. They need no gateway at all: a bot made of commands and
 *     panels runs with the API alone.
 *   · GATEWAY EVENTS (joins, messages, reactions): the Go worker holds the WebSocket and POSTs
 *     batches to `/api/dc/gateway/events` with an agent key that only has the kon's fine scope.
 *   · KON EVENTS: other kons emit on the core's bus (`broadcast:match:updated`,
 *     `blog:post:published`…). The modules switched on that listen to one run, and the live panels
 *     that name it are redrawn (debounced: ten score changes in a second are one redraw).
 *
 * Work that calls Discord, another kon or a model runs OUTSIDE the request's transaction
 * (`ctx.db.background`), through a small bounded queue: a burst never piles up connections, and what
 * does not fit is dropped and counted.
 *
 * Discord answers an interaction within 3 seconds or shows an error. A module gets ~2 s to answer
 * directly; past that the kon answers "thinking…" (deferred, as a new message or as an update of the
 * message the button is on) and edits it when done. A modal must be the immediate answer, so it is
 * decided by `plan`, with no I/O.
 */

import { randomInt, randomUUID } from "node:crypto";

import { AppError } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  DC_EVENTS,
  GATEWAY_CONTRACT_VERSION,
  GATEWAY_EVENTS,
  INTENTS,
  type Choice,
  type GatewayConfig,
  type GatewayEventBatch,
  type GatewayEventEnvelope,
  type GatewayEventName,
  type GatewayIngestResult,
  type Schedule,
} from "./dc.contract";
import { createCardKit, sharpRenderer, type ImageFetcher, type PngRenderer } from "./dc.cards";
import { twitchClient, type TwitchClient } from "./dc.feeds";
import { safeFetchText, type TextFetcher } from "./dc.http";
import { langOf, localizeCommand, translate, type Lang } from "./dc.i18n";
import { createKitsudenClient, type KitsudenClient } from "./dc.kitsuden";
import {
  blueprintModule,
  messageOf,
  parseCustomId,
  publicReason,
  registeredModule,
  registeredModules,
  type DcEvent,
  type DcModule,
  type Economy,
  type ModuleLists,
  type ModuleScheduler,
  type Profile,
  type Profiles,
  type Catalog,
  type VoiceTools,
  type Activity,
  type Characters,
  type MessageCache,
  type ActivityMetric,
  type CatalogItem,
  RARITY_WEIGHT,
  type InteractionPlan,
  type InteractionTarget,
  type ModuleKv,
  type ModulePanels,
  type ModuleRuntime,
  type Reply,
  type Scalar,
} from "./dc.modules";
import {
  DiscordApiError,
  createDiscordRest,
  discordSettings,
  type DiscordRest,
  type DiscordSettings,
  type MessagePayload,
  type SlashCommandPayload,
} from "./dc.rest";
import { eventVerdict, premiumFromExtensions, settingsForGuild } from "./dc.extensions";
import * as schema from "./dc.schema";
import {
  dcBlueprints,
  dcGlobalInventory,
  dcGuildPlans,
  dcGlobalWallets,
  dcGuildModules,
  dcGuilds,
  dcInventory,
  dcItems,
  dcKv,
  dcListMembers,
  dcPanels,
  dcProfiles,
  dcSchedules,
  dcActivity,
  dcCharacters,
  dcMessageCache,
  dcVoiceSessions,
  dcWallets,
  type DcItem,
  type DcSchedule,
} from "./dc.schema";

export type DcDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DcEngineOptions {
  /** Defaults to the environment, read on each use. */
  settings?: () => DiscordSettings;
  /** Defaults to `fetch` against Discord. Tests pass a double. */
  rest?: (settings: DiscordSettings) => DiscordRest;
  /** Defaults to `fetch` against this Kitsuden with the bot's agent key. Tests pass a double. */
  kitsuden?: (settings: DiscordSettings) => KitsudenClient;
  /** How long a module may take before the answer is deferred. */
  directAnswerMs?: number;
  /** How long kon events are gathered before a panel is redrawn. */
  panelDebounceMs?: number;
  /** How often due schedules are looked for (default 20 s; 0 = never by itself, tests call `tick`). */
  scheduleTickMs?: number;
  /** The clock (tests move it). */
  now?: () => Date;
  /**
   * SVG → PNG for image cards. Default: `sharp`, loaded at run time (the API ships it); null turns
   * images off (the modules answer with embeds).
   */
  renderPng?: (() => Promise<PngRenderer | null>) | null;
  /** Fetches avatars for cards. Default: Discord's CDN only. */
  fetchImage?: ImageFetcher;
  /** Fetches feeds. Default: dc.http's checked fetch. */
  fetchText?: TextFetcher;
  /** Twitch's live check. Default: Helix with TWITCH_CLIENT_ID/SECRET, or none. */
  twitch?: TwitchClient | null;
  /** The member page's Discord login (code → user). Default: Discord's OAuth2. */
  oauth?: import("./dc.member").OAuthExchange;
  /** Receives the engine once built (tests drive `tick` and `idle`). */
  onEngine?: (engine: DcEngine) => void;
}

export interface ActiveModule {
  module: DcModule;
  config: Record<string, unknown>;
}

/** Interaction types and response types (https://discord.com/developers/docs/interactions/receiving-and-responding). */
const I_PING = 1;
const I_COMMAND = 2;
const I_COMPONENT = 3;
const I_AUTOCOMPLETE = 4;
const I_MODAL = 5;
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const DEFERRED_CHANNEL_MESSAGE = 5;
const DEFERRED_UPDATE_MESSAGE = 6;
const UPDATE_MESSAGE = 7;
const AUTOCOMPLETE_RESULT = 8;
const MODAL = 9;
const EPHEMERAL = 1 << 6;

const QUEUE_LIMIT = 1000;
const CONCURRENCY = 4;
const MODULE_CACHE_MS = 5000;
/** A module may run on kon events this many times per window and server: a loop between kons stops here. */
const KON_EVENT_BURST = 30;
const KON_EVENT_WINDOW_MS = 10_000;
/** Autocomplete cannot be deferred: past this, no suggestions. */
const AUTOCOMPLETE_MS = 2500;

const UserShape = z.looseObject({
  id: z.string(),
  username: z.string().optional(),
  global_name: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
  bot: z.boolean().optional(),
});

type OptionNode = { name: string; type?: number; value?: Scalar; focused?: boolean; options?: OptionNode[] };
const OptionShape: z.ZodType<OptionNode> = z.lazy(() =>
  z.looseObject({
    name: z.string(),
    type: z.number().int().optional(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    focused: z.boolean().optional(),
    options: z.array(OptionShape).optional(),
  })
);

const InteractionShape = z.looseObject({
  type: z.number().int(),
  id: z.string().optional(),
  token: z.string().optional(),
  guild_id: z.string().optional(),
  channel_id: z.string().optional(),
  locale: z.string().optional(),
  guild_locale: z.string().optional(),
  member: z.looseObject({ user: UserShape.optional(), roles: z.array(z.string()).optional(), permissions: z.string().optional() }).optional(),
  user: UserShape.optional(),
  message: z.looseObject({ id: z.string() }).optional(),
  data: z
    .looseObject({
      name: z.string().optional(),
      /** 1 slash command, 2 user context menu, 3 message context menu. */
      type: z.number().int().optional(),
      target_id: z.string().optional(),
      resolved: z
        .looseObject({
          users: z.record(z.string(), UserShape).optional(),
          messages: z
            .record(z.string(), z.looseObject({ id: z.string(), content: z.string().optional(), author: UserShape.optional() }))
            .optional(),
        })
        .optional(),
      options: z.array(OptionShape).optional(),
      custom_id: z.string().optional(),
      values: z.array(z.string()).optional(),
      components: z
        .array(z.looseObject({ components: z.array(z.looseObject({ custom_id: z.string(), value: z.string().optional() })).optional() }))
        .optional(),
    })
    .optional(),
});
type Interaction = z.infer<typeof InteractionShape>;

function userRef(u: z.infer<typeof UserShape> | undefined) {
  return u ? { id: u.id, name: u.global_name || u.username || u.id, avatar: u.avatar ?? null } : null;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** The gateway payload reduced to what modules use. Unknown shapes give `null`, never a throw. */
export function normalizeEvent(e: GatewayEventEnvelope): DcEvent | null {
  const d = e.d;
  const guildId = str(d.guild_id);
  if (!guildId) return null;
  const parsedUser = (v: unknown) => {
    const r = UserShape.safeParse(v);
    return r.success ? r.data : undefined;
  };
  const rolesOf = (member: unknown) => {
    const roles = (member as { roles?: unknown } | undefined)?.roles;
    return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === "string") : [];
  };
  switch (e.t) {
    case "GUILD_MEMBER_ADD": {
      const u = parsedUser(d.user);
      const flags = Number((d.user as { public_flags?: unknown } | undefined)?.public_flags ?? 0);
      return {
        type: e.t,
        guildId,
        channelId: null,
        user: userRef(u),
        isBot: !!u?.bot,
        content: null,
        emoji: null,
        memberRoles: rolesOf(d),
        account: u
          ? {
              // A snowflake carries its creation time: ms since 2015-01-01.
              createdAt: /^\d{15,20}$/.test(u.id) ? Number((BigInt(u.id) >> 22n) + 1420070400000n) : 0,
              hasAvatar: !!u.avatar,
              bot: !!u.bot,
              verifiedBot: (flags & (1 << 16)) !== 0,
              username: `${u.username ?? ""} ${u.global_name ?? ""}`.trim(),
            }
          : undefined,
      };
    }
    case "GUILD_MEMBER_REMOVE":
    case "GUILD_BAN_ADD": {
      const u = parsedUser(d.user);
      return { type: e.t, guildId, channelId: null, user: userRef(u), isBot: !!u?.bot, content: null, emoji: null, memberRoles: rolesOf(d) };
    }
    case "GUILD_AUDIT_LOG_ENTRY_CREATE": {
      const executor = str(d.user_id);
      const action = Number(d.action_type);
      if (!executor || !Number.isInteger(action)) return null;
      return {
        type: e.t,
        guildId,
        channelId: null,
        user: { id: executor, name: executor },
        isBot: false,
        content: null,
        emoji: null,
        audit: { action, targetId: str(d.target_id) },
      };
    }
    case "MESSAGE_CREATE":
    case "MESSAGE_UPDATE": {
      const u = parsedUser(d.author);
      return {
        type: e.t,
        guildId,
        channelId: str(d.channel_id),
        messageId: str(d.id),
        user: userRef(u),
        isBot: !!u?.bot || d.webhook_id !== undefined,
        content: str(d.content),
        emoji: null,
        memberRoles: rolesOf(d.member),
        mentions: Array.isArray(d.mentions)
          ? d.mentions
              .map((m) => str((m as { id?: unknown } | null)?.id))
              .filter((id): id is string => !!id && /^\d{15,20}$/.test(id))
              .slice(0, 50)
          : [],
      };
    }
    case "MESSAGE_DELETE":
      return { type: e.t, guildId, channelId: str(d.channel_id), messageId: str(d.id), user: null, isBot: false, content: null, emoji: null };
    case "VOICE_STATE_UPDATE": {
      const member = d.member as { user?: unknown } | undefined;
      const u = parsedUser(member?.user);
      const id = str(d.user_id) ?? u?.id ?? null;
      if (!id) return null;
      const muted = d.self_mute === true || d.self_deaf === true || d.mute === true || d.deaf === true;
      return {
        type: e.t,
        guildId,
        channelId: str(d.channel_id),
        user: { id, name: u?.global_name || u?.username || id, avatar: u?.avatar ?? null },
        isBot: !!u?.bot,
        content: null,
        emoji: null,
        memberRoles: rolesOf(member),
        // `from` and `minutes` come from the session table, in dispatchEvent.
        voice: { from: null, to: str(d.channel_id), muted, minutes: 0 },
      };
    }
    case "MESSAGE_REACTION_ADD":
    case "MESSAGE_REACTION_REMOVE": {
      const member = d.member as { user?: unknown } | undefined;
      const u = parsedUser(member?.user);
      const id = str(d.user_id);
      const emoji = d.emoji as { name?: unknown; id?: unknown } | undefined;
      const name = str(emoji?.name);
      return {
        type: e.t,
        guildId,
        channelId: str(d.channel_id),
        messageId: str(d.message_id),
        user: id ? { id, name: u?.global_name || u?.username || id } : null,
        isBot: !!u?.bot,
        content: null,
        // A custom emoji is name:id, as Discord writes it in reactions.
        emoji: name && str(emoji?.id) ? `${name}:${str(emoji?.id)}` : name,
        memberRoles: rolesOf(member),
      };
    }
    default:
      return null;
  }
}

// ── Schedules: when a recurring one runs next ─────────────────────────────────

const WEEKDAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** The wall-clock parts of an instant in a time zone. */
function zoned(t: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute"), s: get("second") };
}

/** The instant of a wall-clock time in a time zone (daylight saving included). */
function fromZoned(y: number, m: number, d: number, h: number, mi: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const offsetAt = (t: number) => {
    const z = zoned(t, timeZone);
    return Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi, z.s) - Math.floor(t / 1000) * 1000;
  };
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

/** JSON with object keys sorted, dropping undefined: equal data, equal text. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}

/** When a recurring schedule runs next, strictly after `after`. */
export function nextRun(spec: Schedule, after: Date): Date {
  if (spec.everyMinutes) return new Date(after.getTime() + spec.everyMinutes * 60_000);
  const [h, mi] = (spec.at ?? "00:00").split(":").map(Number);
  const tz = spec.timezone ?? "UTC";
  const today = zoned(after.getTime(), tz);
  const allowed = new Set((spec.days ?? Object.keys(WEEKDAY_INDEX)).map((d) => WEEKDAY_INDEX[d]));
  for (let add = 0; add <= 8; add++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + add));
    if (!allowed.has(day.getUTCDay())) continue;
    const t = fromZoned(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, tz);
    if (t > after.getTime()) return new Date(t);
  }
  return new Date(after.getTime() + 86_400_000);
}

/** A command's options, flattened from a subcommand when there is one; and the option being typed. */
function readOptions(nodes: OptionNode[] | undefined) {
  let subcommand: string | null = null;
  let list = nodes ?? [];
  // Type 1 is a subcommand (blueprints have no subcommand groups).
  const sub = list.find((o) => o.type === 1);
  if (sub) {
    subcommand = sub.name;
    list = sub.options ?? [];
  }
  const options: Record<string, Scalar> = {};
  let focused: { name: string; value: string } | null = null;
  for (const o of list) {
    if (o.value === undefined) continue;
    options[o.name] = o.value;
    if (o.focused) focused = { name: o.name, value: String(o.value) };
  }
  return { subcommand, options, focused };
}

export function createDcEngine(ctx: KonContext, options: DcEngineOptions = {}) {
  const db = () => ctx.db.instance as DcDb;
  const settings = options.settings ?? (() => discordSettings());
  const restFor = options.rest ?? ((s: DiscordSettings) => createDiscordRest(s));
  /** A server's Discord client: its branded bot's credentials when an extension has them. */
  const restOf = (guildId: string | null | undefined) => restFor(settingsForGuild(settings(), guildId));
  const kitsudenFor = options.kitsuden ?? ((s: DiscordSettings) => createKitsudenClient(s));
  const directAnswerMs = options.directAnswerMs ?? 2000;
  const panelDebounceMs = options.panelDebounceMs ?? 750;
  const clock = options.now ?? (() => new Date());
  const renderPng: () => Promise<PngRenderer | null> =
    options.renderPng === null ? async () => null : (options.renderPng ?? sharpRenderer);

  const asSystem = <T>(fn: () => Promise<T>): Promise<T> => (ctx.db.asSystem ? ctx.db.asSystem(fn) : fn());
  const background = <T>(fn: () => Promise<T>): Promise<T> => (ctx.db.background ? ctx.db.background(fn) : fn());
  const emit = (event: string, data: unknown) => {
    try {
      ctx.events?.emit(event, data);
    } catch (err) {
      ctx.logger.warn("Discord: an event could not be emitted", { event, message: messageOf(err) });
    }
  };

  const stats = { interactions: 0, gatewayEvents: 0, konEvents: 0, dropped: 0, lastGatewayBatchAt: null as string | null };

  // ── Modules ────────────────────────────────────────────────────────────────

  /** A module by id, if it exists and is not switched off for the installation. Blueprints: published only. */
  async function moduleById(id: string): Promise<DcModule | null> {
    if (settings().disabledModules.has(id)) return null;
    if (id.startsWith("blueprint-")) {
      const bpId = id.slice("blueprint-".length);
      if (!z.guid().safeParse(bpId).success) return null;
      const [row] = await db()
        .select()
        .from(dcBlueprints)
        .where(and(eq(dcBlueprints.id, bpId), eq(dcBlueprints.status, "published")))
        .limit(1);
      return row ? blueprintModule(row) : null;
    }
    return registeredModule(id) ?? null;
  }

  /** Every module that can be switched on: built-in ones and published blueprints. */
  async function availableModules(): Promise<DcModule[]> {
    const disabled = settings().disabledModules;
    const rows = await db().select().from(dcBlueprints).where(eq(dcBlueprints.status, "published"));
    return [...registeredModules(), ...rows.map(blueprintModule)].filter((m) => !disabled.has(m.id));
  }

  const cache = new Map<string, { at: number; modules: ActiveModule[] }>();
  /** Each server's preferred locale, read with its modules. */
  const guildLocale = new Map<string, string | null>();

  /** What is on in a server, with its settings parsed. A setting that no longer validates turns the module off. */
  async function activeModules(guildId: string): Promise<ActiveModule[]> {
    const hit = cache.get(guildId);
    if (hit && Date.now() - hit.at < MODULE_CACHE_MS) return hit.modules;
    const rows = await db()
      .select({ moduleId: dcGuildModules.moduleId, config: dcGuildModules.config, locale: dcGuilds.locale })
      .from(dcGuildModules)
      .innerJoin(dcGuilds, eq(dcGuilds.id, dcGuildModules.guildId))
      .where(and(eq(dcGuildModules.guildId, guildId), eq(dcGuildModules.enabled, true), isNull(dcGuilds.leftAt)));
    if (rows[0]) guildLocale.set(guildId, rows[0].locale);
    const premium = await isPremium(guildId);
    const s = settings();
    const active: ActiveModule[] = [];
    for (const row of rows) {
      // A premium module of a server whose plan ended stops by itself; its settings stay.
      if (!premium && s.premiumModules?.has(row.moduleId)) continue;
      const module = await moduleById(row.moduleId);
      if (!module) continue;
      const parsed = module.config.safeParse(row.config ?? {});
      if (!parsed.success) {
        ctx.logger.warn("Discord module skipped: its settings no longer validate", { guildId, moduleId: row.moduleId });
        continue;
      }
      active.push({ module, config: parsed.data as Record<string, unknown> });
    }
    cache.set(guildId, { at: Date.now(), modules: active });
    return active;
  }

  /** Is the server on the premium plan now? */
  async function isPremium(guildId: string): Promise<boolean> {
    // A billing system (an extension) answers first; null leaves it to this kon's plan table.
    const billed = await premiumFromExtensions(guildId);
    if (billed !== null) return billed;
    const [row] = await db().select({ plan: dcGuildPlans.plan, until: dcGuildPlans.until }).from(dcGuildPlans).where(eq(dcGuildPlans.guildId, guildId)).limit(1);
    return !!row && row.plan === "premium" && (row.until === null || row.until.getTime() > clock().getTime());
  }

  /** What switching a module on would break: a premium module on a free server, too many blueprints. */
  async function planRefusal(guildId: string, moduleId: string): Promise<string | null> {
    const s = settings();
    if (await isPremium(guildId)) return null;
    if (s.premiumModules?.has(moduleId)) return `"${moduleId}" is a premium module: this server needs the premium plan`;
    if (moduleId.startsWith("blueprint-") && s.freeBlueprints !== null && s.freeBlueprints !== undefined) {
      const on = await db()
        .select({ moduleId: dcGuildModules.moduleId })
        .from(dcGuildModules)
        .where(and(eq(dcGuildModules.guildId, guildId), eq(dcGuildModules.enabled, true)));
      const blueprints = on.filter((r) => r.moduleId.startsWith("blueprint-") && r.moduleId !== moduleId).length;
      if (blueprints >= s.freeBlueprints) return `A free server can have ${s.freeBlueprints} blueprints on: this server needs the premium plan for more`;
    }
    return null;
  }

  function forget(guildId?: string) {
    if (guildId) cache.delete(guildId);
    else cache.clear();
    recurringDirty = true;
    // Which kon events matter may have changed.
    void subscribe().catch(() => undefined);
  }

  /** Command names → module, refusing two modules with the same command. */
  function commandTable(active: ActiveModule[]) {
    const table = new Map<string, { active: ActiveModule; payload: SlashCommandPayload }>();
    const clashes: string[] = [];
    for (const a of active) {
      for (const payload of a.module.commands?.(a.config) ?? []) {
        // A slash command and a context menu may share a name.
        const key = `${payload.type}:${payload.name}`;
        const other = table.get(key);
        if (other) clashes.push(`${payload.type === 1 ? "/" : "menu "}${payload.name} (${other.active.module.id} and ${a.module.id})`);
        else table.set(key, { active: a, payload });
      }
    }
    return { table, clashes };
  }

  // ── State per module ───────────────────────────────────────────────────────

  function kvFor(guildId: string, namespace: string): ModuleKv {
    const where = (key: string) =>
      and(eq(dcKv.guildId, guildId), eq(dcKv.namespace, namespace), eq(dcKv.key, key.slice(0, 120)));
    return {
      async get(key) {
        // Read as text and parsed once here: a driver that already parses jsonb, plus drizzle parsing
        // the string again, turns the string "666666666666666666" (a role id) into a rounded number.
        const [row] = await db()
          .select({ value: sql<string>`${dcKv.value}::text` })
          .from(dcKv)
          .where(where(key))
          .limit(1);
        if (!row) return undefined;
        try {
          return JSON.parse(row.value) as unknown;
        } catch {
          return row.value;
        }
      },
      async set(key, value) {
        await db()
          .insert(dcKv)
          .values({ guildId, namespace, key: key.slice(0, 120), value })
          .onConflictDoUpdate({
            target: [dcKv.guildId, dcKv.namespace, dcKv.key],
            set: { value, updatedAt: new Date() },
          });
      },
      async incr(key, by) {
        const [row] = await db()
          .insert(dcKv)
          .values({ guildId, namespace, key: key.slice(0, 120), value: by })
          .onConflictDoUpdate({
            target: [dcKv.guildId, dcKv.namespace, dcKv.key],
            set: {
              value: sql`to_jsonb(COALESCE((${dcKv.value} #>> '{}')::numeric, 0) + ${by})`,
              updatedAt: new Date(),
            },
          })
          .returning({ value: dcKv.value });
        return Number(row?.value ?? by);
      },
    };
  }

  // ── Economy (shared by every module of a server) ───────────────────────────

  const walletKey = [dcWallets.guildId, dcWallets.currency, dcWallets.userId];
  const itemKey = [dcInventory.guildId, dcInventory.userId, dcInventory.item];
  const whole = (n: number) => (Number.isFinite(n) ? Math.trunc(n) : 0);

  function economyFor(guildId: string, moduleId: string): Economy {
    const wallet = (userId: string, currency: string) =>
      and(eq(dcWallets.guildId, guildId), eq(dcWallets.currency, currency), eq(dcWallets.userId, userId));
    const globalWallet = (userId: string, currency: string) => and(eq(dcGlobalWallets.currency, currency), eq(dcGlobalWallets.userId, userId));
    const granted = (userId: string, currency: string, amount: number, balance: number, global: boolean) => {
      if (amount > 0) emit(DC_EVENTS.rewardGranted, { guildId, userId, currency, amount, balance, moduleId, global });
    };
    return {
      async add(userId, currency, amount, global = false) {
        const n = whole(amount);
        let balance: number;
        if (global) {
          const [row] = await db()
            .insert(dcGlobalWallets)
            .values({ userId, currency, balance: Math.max(0, n) })
            .onConflictDoUpdate({
              target: [dcGlobalWallets.currency, dcGlobalWallets.userId],
              set: { balance: sql`GREATEST(0, ${dcGlobalWallets.balance} + ${n}::bigint)`, updatedAt: new Date() },
            })
            .returning({ balance: dcGlobalWallets.balance });
          balance = Number(row?.balance ?? 0);
        } else {
          const [row] = await db()
            .insert(dcWallets)
            .values({ guildId, userId, currency, balance: Math.max(0, n) })
            .onConflictDoUpdate({
              target: walletKey,
              set: { balance: sql`GREATEST(0, ${dcWallets.balance} + ${n}::bigint)`, updatedAt: new Date() },
            })
            .returning({ balance: dcWallets.balance });
          balance = Number(row?.balance ?? 0);
        }
        granted(userId, currency, n, balance, global);
        return balance;
      },
      async take(userId, currency, amount, global = false) {
        const n = Math.abs(whole(amount));
        if (n === 0) return (await this.get(userId, currency, global)).balance;
        const rows = global
          ? await db()
              .update(dcGlobalWallets)
              .set({ balance: sql`${dcGlobalWallets.balance} - ${n}::bigint`, updatedAt: new Date() })
              .where(and(globalWallet(userId, currency), gte(dcGlobalWallets.balance, n)))
              .returning({ balance: dcGlobalWallets.balance })
          : await db()
              .update(dcWallets)
              .set({ balance: sql`${dcWallets.balance} - ${n}::bigint`, updatedAt: new Date() })
              .where(and(wallet(userId, currency), gte(dcWallets.balance, n)))
              .returning({ balance: dcWallets.balance });
        return rows[0] ? Number(rows[0].balance) : null;
      },
      async get(userId, currency, global = false) {
        if (global) {
          const [row] = await db().select({ balance: dcGlobalWallets.balance }).from(dcGlobalWallets).where(globalWallet(userId, currency)).limit(1);
          const balance = Number(row?.balance ?? 0);
          const [above] = await db()
            .select({ n: count() })
            .from(dcGlobalWallets)
            .where(and(eq(dcGlobalWallets.currency, currency), gt(dcGlobalWallets.balance, balance)));
          return { balance, rank: Number(above?.n ?? 0) + 1 };
        }
        const [row] = await db().select({ balance: dcWallets.balance }).from(dcWallets).where(wallet(userId, currency)).limit(1);
        const balance = Number(row?.balance ?? 0);
        const [above] = await db()
          .select({ n: count() })
          .from(dcWallets)
          .where(and(eq(dcWallets.guildId, guildId), eq(dcWallets.currency, currency), gt(dcWallets.balance, balance)));
        return { balance, rank: Number(above?.n ?? 0) + 1 };
      },
      async top(currency, limit, global = false) {
        const n = Math.min(100, Math.max(1, limit));
        const rows = global
          ? await db()
              .select({ userId: dcGlobalWallets.userId, balance: dcGlobalWallets.balance })
              .from(dcGlobalWallets)
              .where(and(eq(dcGlobalWallets.currency, currency), gt(dcGlobalWallets.balance, 0)))
              .orderBy(desc(dcGlobalWallets.balance), asc(dcGlobalWallets.updatedAt))
              .limit(n)
          : await db()
              .select({ userId: dcWallets.userId, balance: dcWallets.balance })
              .from(dcWallets)
              .where(and(eq(dcWallets.guildId, guildId), eq(dcWallets.currency, currency), gt(dcWallets.balance, 0)))
              .orderBy(desc(dcWallets.balance), asc(dcWallets.updatedAt))
              .limit(n);
        return rows.map((r) => ({ userId: r.userId, balance: Number(r.balance) }));
      },
      async addItem(userId, item, quantity, global = false) {
        const n = Math.max(0, whole(quantity));
        if (global) {
          const [g] = await db()
            .insert(dcGlobalInventory)
            .values({ userId, item, quantity: n })
            .onConflictDoUpdate({
              target: [dcGlobalInventory.userId, dcGlobalInventory.item],
              set: { quantity: sql`${dcGlobalInventory.quantity} + ${n}::integer`, updatedAt: new Date() },
            })
            .returning({ quantity: dcGlobalInventory.quantity });
          if (n > 0) emit(DC_EVENTS.itemGranted, { guildId, userId, item, quantity: n, moduleId, global: true });
          return Number(g?.quantity ?? n);
        }
        const [row] = await db()
          .insert(dcInventory)
          .values({ guildId, userId, item, quantity: n })
          .onConflictDoUpdate({ target: itemKey, set: { quantity: sql`${dcInventory.quantity} + ${n}::integer`, updatedAt: new Date() } })
          .returning({ quantity: dcInventory.quantity });
        if (n > 0) emit(DC_EVENTS.itemGranted, { guildId, userId, item, quantity: n, moduleId });
        return Number(row?.quantity ?? n);
      },
      async takeItem(userId, item, quantity, global = false) {
        const n = Math.max(0, whole(quantity));
        if (global) {
          const [g] = await db()
            .update(dcGlobalInventory)
            .set({ quantity: sql`${dcGlobalInventory.quantity} - ${n}::integer`, updatedAt: new Date() })
            .where(and(eq(dcGlobalInventory.userId, userId), eq(dcGlobalInventory.item, item), gte(dcGlobalInventory.quantity, n)))
            .returning({ quantity: dcGlobalInventory.quantity });
          return g ? Number(g.quantity) : null;
        }
        const [row] = await db()
          .update(dcInventory)
          .set({ quantity: sql`${dcInventory.quantity} - ${n}::integer`, updatedAt: new Date() })
          .where(and(eq(dcInventory.guildId, guildId), eq(dcInventory.userId, userId), eq(dcInventory.item, item), gte(dcInventory.quantity, n)))
          .returning({ quantity: dcInventory.quantity });
        return row ? Number(row.quantity) : null;
      },
      async items(userId, global = false) {
        if (global) {
          return db()
            .select({ item: dcGlobalInventory.item, quantity: dcGlobalInventory.quantity })
            .from(dcGlobalInventory)
            .where(and(eq(dcGlobalInventory.userId, userId), gt(dcGlobalInventory.quantity, 0)))
            .orderBy(asc(dcGlobalInventory.item));
        }
        const rows = await db()
          .select({ item: dcInventory.item, quantity: dcInventory.quantity })
          .from(dcInventory)
          .where(and(eq(dcInventory.guildId, guildId), eq(dcInventory.userId, userId), gt(dcInventory.quantity, 0)))
          .orderBy(asc(dcInventory.item));
        return rows;
      },
    };
  }

  // ── Activity per day ───────────────────────────────────────────────────────

  const today = () => Math.floor(clock().getTime() / 86_400_000);

  async function countActivity(guildId: string, userId: string, messages: number, voiceMinutes: number) {
    if (!/^\d{15,20}$/.test(userId) || (messages <= 0 && voiceMinutes <= 0)) return;
    await db()
      .insert(dcActivity)
      .values({ guildId, userId, day: today(), messages, voiceMinutes })
      .onConflictDoUpdate({
        target: [dcActivity.guildId, dcActivity.userId, dcActivity.day],
        set: { messages: sql`${dcActivity.messages} + ${messages}::integer`, voiceMinutes: sql`${dcActivity.voiceMinutes} + ${voiceMinutes}::integer` },
      });
  }

  function activityFor(guildId: string): Activity {
    const since = (days: number | null) => (days === null ? undefined : gte(dcActivity.day, today() - days));
    const column = (metric: ActivityMetric) => (metric === "voice" ? dcActivity.voiceMinutes : dcActivity.messages);
    return {
      async of(userId, days, metric = "messages") {
        const [mine] = await db()
          .select({ messages: sql<number>`COALESCE(SUM(${dcActivity.messages}), 0)`, voice: sql<number>`COALESCE(SUM(${dcActivity.voiceMinutes}), 0)` })
          .from(dcActivity)
          .where(and(eq(dcActivity.guildId, guildId), eq(dcActivity.userId, userId), since(days)));
        const value = Number(metric === "voice" ? mine?.voice : mine?.messages) || 0;
        const totals = db()
          .select({ userId: dcActivity.userId, total: sql<number>`SUM(${column(metric)})`.as("total") })
          .from(dcActivity)
          .where(and(eq(dcActivity.guildId, guildId), since(days)))
          .groupBy(dcActivity.userId)
          .as("totals");
        const [above] = await db().select({ n: count() }).from(totals).where(gt(totals.total, value));
        return { messages: Number(mine?.messages) || 0, voiceMinutes: Number(mine?.voice) || 0, rank: Number(above?.n ?? 0) + 1 };
      },
      async top(metric, days, limit) {
        const total = sql<number>`SUM(${column(metric)})`;
        const rows = await db()
          .select({ userId: dcActivity.userId, value: total })
          .from(dcActivity)
          .where(and(eq(dcActivity.guildId, guildId), since(days)))
          .groupBy(dcActivity.userId)
          .having(gt(total, 0))
          .orderBy(desc(total))
          .limit(Math.min(100, Math.max(1, limit)));
        return rows.map((r) => ({ userId: r.userId, value: Number(r.value) }));
      },
    };
  }

  // ── Message cache ──────────────────────────────────────────────────────────

  function messagesFor(guildId: string): MessageCache {
    return {
      async remember(m, hours) {
        if (hours <= 0 || !/^\d{15,20}$/.test(m.messageId)) return;
        const expiresAt = new Date(clock().getTime() + Math.min(168, hours) * 3_600_000);
        const content = m.content.slice(0, 4000);
        await db()
          .insert(dcMessageCache)
          .values({ messageId: m.messageId, guildId, channelId: m.channelId, authorId: m.authorId, content, expiresAt })
          .onConflictDoUpdate({ target: dcMessageCache.messageId, set: { content, expiresAt } });
      },
      async recall(messageId) {
        const [row] = await db()
          .select({ channelId: dcMessageCache.channelId, authorId: dcMessageCache.authorId, content: dcMessageCache.content })
          .from(dcMessageCache)
          .where(and(eq(dcMessageCache.messageId, messageId), eq(dcMessageCache.guildId, guildId), gt(dcMessageCache.expiresAt, clock())))
          .limit(1);
        return row ?? null;
      },
      async forget(messageId) {
        await db().delete(dcMessageCache).where(and(eq(dcMessageCache.messageId, messageId), eq(dcMessageCache.guildId, guildId)));
      },
    };
  }

  // ── Characters ─────────────────────────────────────────────────────────────

  const characters: Characters = {
    async list(userId) {
      return db()
        .select({ id: dcCharacters.id, name: dcCharacters.name, prefix: dcCharacters.prefix, suffix: dcCharacters.suffix, avatarUrl: dcCharacters.avatarUrl, messages: dcCharacters.messages })
        .from(dcCharacters)
        .where(eq(dcCharacters.userId, userId))
        .orderBy(asc(dcCharacters.name));
    },
    async save(userId, c) {
      const [row] = await db()
        .insert(dcCharacters)
        .values({ userId, ...c })
        .onConflictDoUpdate({ target: [dcCharacters.userId, dcCharacters.name], set: { prefix: c.prefix, suffix: c.suffix, avatarUrl: c.avatarUrl } })
        .returning();
      return { id: row.id, name: row.name, prefix: row.prefix, suffix: row.suffix, avatarUrl: row.avatarUrl, messages: row.messages };
    },
    async remove(userId, name) {
      const rows = await db().delete(dcCharacters).where(and(eq(dcCharacters.userId, userId), eq(dcCharacters.name, name))).returning({ id: dcCharacters.id });
      return rows.length > 0;
    },
    async counted(id) {
      await db().update(dcCharacters).set({ messages: sql`${dcCharacters.messages} + 1` }).where(eq(dcCharacters.id, id));
    },
  };

  // ── Voice sessions ─────────────────────────────────────────────────────────

  function voiceFor(guildId: string): VoiceTools {
    return {
      async claimMinutes(userId) {
        const [row] = await db()
          .select()
          .from(dcVoiceSessions)
          .where(and(eq(dcVoiceSessions.guildId, guildId), eq(dcVoiceSessions.userId, userId)))
          .limit(1);
        if (!row) return 0;
        const now = clock();
        const minutes = Math.floor((now.getTime() - row.creditedAt.getTime()) / 60_000);
        if (minutes <= 0) return 0;
        // Only whole minutes are claimed: the rest stays for the next claim. One write wins.
        const claimed = await db()
          .update(dcVoiceSessions)
          .set({ creditedAt: new Date(row.creditedAt.getTime() + minutes * 60_000) })
          .where(and(eq(dcVoiceSessions.guildId, guildId), eq(dcVoiceSessions.userId, userId), eq(dcVoiceSessions.creditedAt, row.creditedAt)))
          .returning({ userId: dcVoiceSessions.userId });
        return claimed.length ? minutes : 0;
      },
      async members(channelId) {
        const rows = await db()
          .select({ userId: dcVoiceSessions.userId })
          .from(dcVoiceSessions)
          .where(and(eq(dcVoiceSessions.guildId, guildId), eq(dcVoiceSessions.channelId, channelId)));
        return rows.map((r) => r.userId);
      },
      async sessions() {
        return db()
          .select({ userId: dcVoiceSessions.userId, channelId: dcVoiceSessions.channelId, muted: dcVoiceSessions.muted })
          .from(dcVoiceSessions)
          .where(eq(dcVoiceSessions.guildId, guildId));
      },
    };
  }

  // ── The item catalog ───────────────────────────────────────────────────────

  const asItem = (r: DcItem): CatalogItem => ({
    item: r.item,
    global: r.guildId === null,
    name: r.name,
    description: r.description,
    emoji: r.emoji,
    rarity: r.rarity,
    kind: r.kind,
    imageUrl: r.imageUrl,
    color: r.color,
    price: r.price === null ? null : Number(r.price),
    currency: r.currency,
    sellPrice: r.sellPrice === null ? null : Number(r.sellPrice),
    tradeable: r.tradeable,
    stock: r.stock,
    sold: r.sold,
    roleId: r.roleId,
    dropWeight: r.dropWeight,
  });

  function catalogFor(guildId: string): Catalog {
    async function all(): Promise<CatalogItem[]> {
      const rows = await db()
        .select()
        .from(dcItems)
        .where(and(eq(dcItems.enabled, true), or(eq(dcItems.guildId, guildId), isNull(dcItems.guildId))))
        .orderBy(asc(dcItems.name));
      // A server's own item wins over a global one with the same id.
      const byId = new Map<string, CatalogItem>();
      for (const r of rows) {
        const item = asItem(r);
        const there = byId.get(item.item);
        if (!there || (there.global && !item.global)) byId.set(item.item, item);
      }
      return [...byId.values()];
    }
    return {
      async list(filter = {}) {
        return (await all()).filter(
          (i) =>
            (!filter.kind || i.kind === filter.kind) &&
            (!filter.rarity || i.rarity === filter.rarity) &&
            (!filter.forSale || (i.price !== null && (i.stock === null || i.sold < i.stock)))
        );
      },
      async get(item) {
        return (await all()).find((i) => i.item === item) ?? null;
      },
      async random(filter = {}) {
        const pool = (await all()).filter((i) => (!filter.kind || i.kind === filter.kind) && (!filter.rarity || i.rarity === filter.rarity) && i.dropWeight > 0);
        const weight = (i: CatalogItem) => RARITY_WEIGHT[i.rarity] * i.dropWeight;
        const total = pool.reduce((n, i) => n + weight(i), 0);
        if (!total) return null;
        let roll = randomInt(0, total);
        for (const i of pool) {
          roll -= weight(i);
          if (roll < 0) return i;
        }
        return pool[pool.length - 1];
      },
      async reserve(item) {
        const rows = await db()
          .update(dcItems)
          .set({ sold: sql`${dcItems.sold} + 1`, updatedAt: new Date() })
          .where(
            and(
              eq(dcItems.item, item.item),
              item.global ? isNull(dcItems.guildId) : eq(dcItems.guildId, guildId),
              or(isNull(dcItems.stock), lt(dcItems.sold, dcItems.stock))
            )
          )
          .returning({ id: dcItems.id });
        return rows.length > 0;
      },
    };
  }

  // ── Profiles (the same in every server) ────────────────────────────────────

  const emptyProfile = (userId: string): Profile => ({ userId, name: null, avatar: null, bio: null, accent: null, rep: 0, badges: [], background: null });
  const asProfile = (r: typeof dcProfiles.$inferSelect): Profile => ({
    userId: r.userId,
    name: r.name,
    avatar: r.avatar,
    bio: r.bio,
    accent: r.accent,
    rep: r.rep,
    badges: Array.isArray(r.badges) ? r.badges.filter((b): b is string => typeof b === "string") : [],
    background: r.background,
  });

  const profiles: Profiles = {
    async get(userId) {
      const [row] = await db().select().from(dcProfiles).where(eq(dcProfiles.userId, userId)).limit(1);
      return row ? asProfile(row) : emptyProfile(userId);
    },
    async update(userId, patch) {
      const values = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const [row] = await db()
        .insert(dcProfiles)
        .values({ userId, ...values })
        .onConflictDoUpdate({ target: dcProfiles.userId, set: { ...values, updatedAt: new Date() } })
        .returning();
      return asProfile(row);
    },
    async giveRep(from, to, hours) {
      const now = clock();
      const since = new Date(now.getTime() - hours * 3_600_000);
      await db().insert(dcProfiles).values({ userId: from }).onConflictDoNothing();
      // Claimed in one write: two /rep at once give one point.
      const claimed = await db()
        .update(dcProfiles)
        .set({ repGivenAt: now })
        .where(and(eq(dcProfiles.userId, from), or(isNull(dcProfiles.repGivenAt), lt(dcProfiles.repGivenAt, since))))
        .returning({ userId: dcProfiles.userId });
      if (!claimed.length) {
        const [row] = await db().select({ at: dcProfiles.repGivenAt }).from(dcProfiles).where(eq(dcProfiles.userId, from)).limit(1);
        return { ok: false, nextAt: new Date((row?.at ?? now).getTime() + hours * 3_600_000) };
      }
      const [row] = await db()
        .insert(dcProfiles)
        .values({ userId: to, rep: 1 })
        .onConflictDoUpdate({ target: dcProfiles.userId, set: { rep: sql`${dcProfiles.rep} + 1`, updatedAt: now } })
        .returning({ rep: dcProfiles.rep });
      return { ok: true, rep: Number(row?.rep ?? 1) };
    },
    async claimDaily(userId, day) {
      await db().insert(dcProfiles).values({ userId }).onConflictDoNothing();
      const [row] = await db()
        .update(dcProfiles)
        .set({
          dailyDay: day,
          dailyStreak: sql`CASE WHEN ${dcProfiles.dailyDay} = ${day - 1} THEN ${dcProfiles.dailyStreak} + 1 ELSE 1 END`,
          updatedAt: new Date(),
        })
        .where(and(eq(dcProfiles.userId, userId), or(isNull(dcProfiles.dailyDay), lt(dcProfiles.dailyDay, day))))
        .returning({ streak: dcProfiles.dailyStreak });
      return row ? Number(row.streak) : null;
    },
    async topRep(limit) {
      const rows = await db()
        .select({ userId: dcProfiles.userId, rep: dcProfiles.rep })
        .from(dcProfiles)
        .where(gt(dcProfiles.rep, 0))
        .orderBy(desc(dcProfiles.rep))
        .limit(Math.min(100, Math.max(1, limit)));
      return rows;
    },
  };

  // ── Lists of members ───────────────────────────────────────────────────────

  function listsFor(guildId: string, namespace: string): ModuleLists {
    const inList = (list: string) => and(eq(dcListMembers.guildId, guildId), eq(dcListMembers.namespace, namespace), eq(dcListMembers.list, list));
    const valid = (userId: string) => /^\d{15,20}$/.test(userId);
    return {
      async join(list, userId) {
        if (!valid(userId)) return false;
        const rows = await db().insert(dcListMembers).values({ guildId, namespace, list, userId }).onConflictDoNothing().returning({ userId: dcListMembers.userId });
        return rows.length > 0;
      },
      async leave(list, userId) {
        const rows = await db().delete(dcListMembers).where(and(inList(list), eq(dcListMembers.userId, userId))).returning({ userId: dcListMembers.userId });
        return rows.length > 0;
      },
      async has(list, userId) {
        const rows = await db().select({ userId: dcListMembers.userId }).from(dcListMembers).where(and(inList(list), eq(dcListMembers.userId, userId))).limit(1);
        return rows.length > 0;
      },
      async count(list) {
        const [row] = await db().select({ n: count() }).from(dcListMembers).where(inList(list));
        return Number(row?.n ?? 0);
      },
      async members(list, limit = 100) {
        const rows = await db()
          .select({ userId: dcListMembers.userId })
          .from(dcListMembers)
          .where(inList(list))
          .orderBy(asc(dcListMembers.joinedAt))
          .limit(Math.min(10_000, Math.max(1, limit)));
        return rows.map((r) => r.userId);
      },
      async pick(list, howMany, remove) {
        const all = await this.members(list, 10_000);
        // A fair draw: Fisher–Yates with the system's cryptographic random numbers.
        for (let i = all.length - 1; i > 0; i--) {
          const j = randomInt(0, i + 1);
          [all[i], all[j]] = [all[j], all[i]];
        }
        const winners = all.slice(0, Math.max(0, howMany));
        if (remove && winners.length) await db().delete(dcListMembers).where(and(inList(list), inArray(dcListMembers.userId, winners)));
        return winners;
      },
      async clear(list) {
        await db().delete(dcListMembers).where(inList(list));
      },
    };
  }

  // ── Schedules ──────────────────────────────────────────────────────────────

  function schedulerFor(guildId: string, moduleId: string): ModuleScheduler {
    return {
      async at(when, payload, key) {
        const k = (key ?? `once:${randomUUID()}`).slice(0, 120);
        await db()
          .insert(dcSchedules)
          .values({ guildId, moduleId, key: k, runAt: when, spec: null, payload })
          .onConflictDoUpdate({ target: [dcSchedules.guildId, dcSchedules.moduleId, dcSchedules.key], set: { runAt: when, spec: null, payload } });
      },
      async cancel(key) {
        await db().delete(dcSchedules).where(and(eq(dcSchedules.guildId, guildId), eq(dcSchedules.moduleId, moduleId), eq(dcSchedules.key, key)));
      },
    };
  }

  /** Recurring schedules are re-read when modules change (and every few minutes). */
  let recurringDirty = true;
  let recurringCheckedAt = 0;
  const RECURRING_RECHECK_MS = 5 * 60_000;

  async function syncRecurring(now: Date) {
    if (!recurringDirty && now.getTime() - recurringCheckedAt < RECURRING_RECHECK_MS) return;
    recurringDirty = false;
    recurringCheckedAt = now.getTime();
    const guildRows = await db()
      .selectDistinct({ guildId: dcGuildModules.guildId })
      .from(dcGuildModules)
      .innerJoin(dcGuilds, eq(dcGuilds.id, dcGuildModules.guildId))
      .where(and(eq(dcGuildModules.enabled, true), isNull(dcGuilds.leftAt)));
    const wanted = new Map<string, { guildId: string; moduleId: string; key: string; spec: Schedule }>();
    for (const { guildId } of guildRows) {
      for (const a of await activeModules(guildId)) {
        for (const s of a.module.schedules?.(a.config) ?? []) {
          wanted.set(`${guildId}|${a.module.id}|cron:${s.key}`, { guildId, moduleId: a.module.id, key: `cron:${s.key}`, spec: s.schedule });
        }
      }
    }
    const existing = await db().select().from(dcSchedules).where(isNotNull(dcSchedules.spec));
    const have = new Map(existing.map((r) => [`${r.guildId}|${r.moduleId}|${r.key}`, r]));
    for (const [k, row] of have) {
      if (!wanted.has(k)) await db().delete(dcSchedules).where(eq(dcSchedules.id, row.id));
    }
    for (const [k, w] of wanted) {
      const row = have.get(k);
      // jsonb reorders keys: compare in a stable order, or every recheck would push the run back.
      if (row && stableJson(row.spec) === stableJson(w.spec)) continue;
      const runAt = nextRun(w.spec, now);
      await db()
        .insert(dcSchedules)
        .values({ guildId: w.guildId, moduleId: w.moduleId, key: w.key, runAt, spec: w.spec as unknown as Record<string, unknown>, payload: {} })
        .onConflictDoUpdate({
          target: [dcSchedules.guildId, dcSchedules.moduleId, dcSchedules.key],
          set: { runAt, spec: w.spec as unknown as Record<string, unknown> },
        });
    }
  }

  async function runSchedule(row: DcSchedule) {
    const active = (await activeModules(row.guildId)).find((a) => a.module.id === row.moduleId);
    if (!active?.module.onSchedule) {
      // The module is off: a recurring row waits for the next sync to be dropped; a one-off is gone.
      return;
    }
    const p = row.payload ?? {};
    const user = p.user && typeof p.user === "object" ? (p.user as { id?: unknown; name?: unknown }) : null;
    const where: Where = {
      guildId: row.guildId,
      channelId: typeof p.channelId === "string" ? p.channelId : null,
      messageId: typeof p.messageId === "string" ? p.messageId : null,
      user: user && typeof user.id === "string" ? { id: user.id, name: typeof user.name === "string" ? user.name : user.id } : null,
      memberRoles: [],
      memberPermissions: null,
    };
    try {
      await active.module.onSchedule(row.key.replace(/^cron:/, ""), p, active.config, runtimeFor(active, where));
    } catch (err) {
      ctx.logger.warn("Discord schedule failed", { moduleId: row.moduleId, key: row.key, message: messageOf(err) });
    }
  }

  let ticking = false;
  /** Runs what is due (and re-reads recurring schedules when modules changed). Gives how many it queued. */
  async function tick(): Promise<number> {
    if (ticking) return 0;
    ticking = true;
    try {
      return await background(() =>
        asSystem(async () => {
          const now = clock();
          await syncRecurring(now);
          // Message text kept for logs goes when it expires.
          await db().delete(dcMessageCache).where(lte(dcMessageCache.expiresAt, now));
          const due = await db().select().from(dcSchedules).where(lte(dcSchedules.runAt, now)).orderBy(asc(dcSchedules.runAt)).limit(50);
          let queued = 0;
          for (const row of due) {
            // Claim it: only the replica whose write lands runs it.
            const claimed = row.spec
              ? await db()
                  .update(dcSchedules)
                  .set({ runAt: nextRun(row.spec as unknown as Schedule, now) })
                  .where(and(eq(dcSchedules.id, row.id), eq(dcSchedules.runAt, row.runAt)))
                  .returning({ id: dcSchedules.id })
              : await db().delete(dcSchedules).where(eq(dcSchedules.id, row.id)).returning({ id: dcSchedules.id });
            if (!claimed.length) continue;
            if (schedule(() => asSystem(() => runSchedule(row)))) queued++;
          }
          return queued;
        })
      );
    } finally {
      ticking = false;
    }
  }

  // ── Panels ─────────────────────────────────────────────────────────────────

  function panelsFor(guildId: string, active: ActiveModule, rt: () => ModuleRuntime): ModulePanels {
    const moduleId = active.module.id;
    return {
      async post(panelId, channelId) {
        if (!active.module.renderPanel) return null;
        const payload = await active.module.renderPanel(panelId, active.config, rt());
        if (!payload) return null;
        const sent = await rt().rest.sendMessage(channelId, payload);
        if (sent.id) {
          await db()
            .insert(dcPanels)
            .values({ messageId: sent.id, guildId, channelId, moduleId, panelId, refreshedAt: new Date() })
            .onConflictDoNothing();
        }
        return sent.id;
      },
      async refresh(panelId) {
        await redrawPanels(guildId, active, panelId);
      },
    };
  }

  async function redrawPanels(guildId: string, active: ActiveModule, panelId?: string) {
    if (!active.module.renderPanel) return;
    const moduleId = active.module.id;
    const rows = await db()
      .select()
      .from(dcPanels)
      .where(
        panelId
          ? and(eq(dcPanels.guildId, guildId), eq(dcPanels.moduleId, moduleId), eq(dcPanels.panelId, panelId))
          : and(eq(dcPanels.guildId, guildId), eq(dcPanels.moduleId, moduleId))
      );
    // The same panel in several channels is drawn once.
    const drawn = new Map<string, MessagePayload | null>();
    for (const row of rows) {
      const runtime = runtimeFor(active, { guildId, channelId: row.channelId, messageId: row.messageId, user: null, memberRoles: [], memberPermissions: null });
      if (!drawn.has(row.panelId)) drawn.set(row.panelId, await active.module.renderPanel(row.panelId, active.config, runtime));
      const payload = drawn.get(row.panelId);
      if (!payload) continue;
      try {
        await runtime.rest.editMessage(row.channelId, row.messageId, payload);
        await db().update(dcPanels).set({ refreshedAt: new Date() }).where(eq(dcPanels.messageId, row.messageId));
      } catch (err) {
        // Deleted in Discord, or the bot lost the channel: forget the panel.
        if (err instanceof DiscordApiError && (err.status === 404 || err.status === 403)) {
          await db().delete(dcPanels).where(eq(dcPanels.messageId, row.messageId));
        } else {
          ctx.logger.warn("Discord panel redraw failed", { moduleId, panelId: row.panelId, message: messageOf(err) });
        }
      }
    }
  }

  const pendingRedraws = new Map<string, ReturnType<typeof setTimeout>>();
  function redrawSoon(guildId: string, moduleId: string, panelId: string) {
    const key = `${guildId}|${moduleId}|${panelId}`;
    if (pendingRedraws.has(key)) return;
    pendingRedraws.set(
      key,
      setTimeout(() => {
        pendingRedraws.delete(key);
        schedule(async () => {
          const active = (await activeModules(guildId)).find((a) => a.module.id === moduleId);
          if (active) await redrawPanels(guildId, active, panelId);
        });
      }, panelDebounceMs)
    );
  }

  // ── Runtime ────────────────────────────────────────────────────────────────

  interface Where {
    guildId: string;
    channelId: string | null;
    messageId: string | null;
    user: ModuleRuntime["user"];
    memberRoles: string[];
    memberPermissions: string | null;
    /** The member's Discord locale (interactions), or null: the server's is used. */
    locale?: string | null;
  }

  function runtimeFor(active: ActiveModule, where: Where, rest?: DiscordRest): ModuleRuntime {
    const s = settings();
    const rt: ModuleRuntime = {
      ...where,
      kv: kvFor(where.guildId, active.module.id),
      rest: rest ?? restOf(where.guildId),
      kitsuden: kitsudenFor(s),
      panels: undefined as unknown as ModulePanels,
      economy: economyFor(where.guildId, active.module.id),
      profiles,
      catalog: catalogFor(where.guildId),
      voice: voiceFor(where.guildId),
      botUserId: s.applicationId,
      characters,
      messages: messagesFor(where.guildId),
      activity: activityFor(where.guildId),
      fetchText: options.fetchText ?? safeFetchText,
      twitch: options.twitch === undefined ? twitchClient() : options.twitch,
      itemUsed: async (item, userId) => {
        for (const a of await activeModules(where.guildId)) {
          if (!a.module.onItemUsed) continue;
          const user = where.user?.id === userId ? where.user : { id: userId, name: userId };
          schedule(async () => {
            try {
              await a.module.onItemUsed!(item, userId, a.config, runtimeFor(a, { ...where, user }));
            } catch (err) {
              ctx.logger.warn("Discord module failed on an item use", { moduleId: a.module.id, item, message: messageOf(err) });
            }
          });
        }
      },
      lists: listsFor(where.guildId, active.module.id),
      schedule: schedulerFor(where.guildId, active.module.id),
      now: clock,
      lang: langOf(where.locale ?? guildLocale.get(where.guildId)),
      t: (text, vars) => translate(langOf(where.locale ?? guildLocale.get(where.guildId)), text, vars),
      cards: createCardKit({
        guildId: where.guildId,
        rest: rest ?? restOf(where.guildId),
        render: renderPng,
        fetchImage: options.fetchImage,
        known: where.user ? { id: where.user.id, name: where.user.name, avatar: where.user.avatar ?? null } : null,
      }),
      emit,
      agents: ctx.agents,
      logger: ctx.logger,
    };
    rt.panels = panelsFor(where.guildId, active, () => rt);
    return rt;
  }

  // ── Background queue ───────────────────────────────────────────────────────

  let running = 0;
  const queue: Array<() => Promise<void>> = [];
  const idleWaiters: Array<() => void> = [];

  function pump() {
    while (running < CONCURRENCY && queue.length) {
      const task = queue.shift()!;
      running++;
      background(task)
        .catch((err) => ctx.logger.error("Discord task failed", { message: messageOf(err) }))
        .finally(() => {
          running--;
          pump();
          if (running === 0 && queue.length === 0 && pendingRedraws.size === 0) idleWaiters.splice(0).forEach((w) => w());
        });
    }
  }

  function schedule(task: () => Promise<void>): boolean {
    if (queue.length >= QUEUE_LIMIT) {
      stats.dropped++;
      return false;
    }
    queue.push(task);
    pump();
    return true;
  }

  /** Resolves when the queue and the pending panel redraws are done. For tests and graceful shutdown. */
  async function idle(): Promise<void> {
    for (;;) {
      if (running === 0 && queue.length === 0 && pendingRedraws.size === 0) return;
      if (running === 0 && queue.length === 0) {
        await new Promise((r) => setTimeout(r, Math.max(10, panelDebounceMs / 4)));
        continue;
      }
      await new Promise<void>((resolve) => idleWaiters.push(resolve));
    }
  }

  // ── Kon events (the core's bus) ────────────────────────────────────────────

  const subscribed = new Set<string>();
  const bursts = new Map<string, { since: number; count: number }>();

  function withinBurst(key: string): boolean {
    const now = Date.now();
    const b = bursts.get(key);
    if (!b || now - b.since > KON_EVENT_WINDOW_MS) {
      bursts.set(key, { since: now, count: 1 });
      return true;
    }
    b.count++;
    return b.count <= KON_EVENT_BURST;
  }

  /** The kon events some module switched on anywhere listens to, or some panel redraws on. */
  async function wantedKonEvents(): Promise<Set<string>> {
    const rows = await background(() =>
      db()
        .select({ guildId: dcGuildModules.guildId, moduleId: dcGuildModules.moduleId, config: dcGuildModules.config })
        .from(dcGuildModules)
        .where(eq(dcGuildModules.enabled, true))
    );
    const names = new Set<string>();
    for (const row of rows) {
      const module = await background(() => moduleById(row.moduleId));
      if (!module) continue;
      const parsed = module.config.safeParse(row.config ?? {});
      if (!parsed.success) continue;
      module.konEvents?.(parsed.data).forEach((n) => names.add(n));
      for (const list of Object.values(module.panelRefreshOn?.(parsed.data) ?? {})) list.forEach((n) => names.add(n));
    }
    return names;
  }

  /** Listens to every kon event something needs. The bus has no `off`: a handler stays and checks. */
  async function subscribe(): Promise<void> {
    if (!ctx.events?.on) return;
    for (const name of await wantedKonEvents()) {
      if (name.startsWith("dc:") || subscribed.has(name)) continue;
      subscribed.add(name);
      ctx.events.on(name, (data) => {
        if (!schedule(() => onKonEvent(name, data))) ctx.logger.warn("Discord: kon event dropped, the queue is full", { event: name });
      });
    }
  }

  async function onKonEvent(name: string, data: unknown): Promise<void> {
    stats.konEvents++;
    const rows = await db()
      .select({ guildId: dcGuildModules.guildId })
      .from(dcGuildModules)
      .innerJoin(dcGuilds, eq(dcGuilds.id, dcGuildModules.guildId))
      .where(and(eq(dcGuildModules.enabled, true), isNull(dcGuilds.leftAt)));
    for (const guildId of new Set(rows.map((r) => r.guildId))) {
      for (const a of await activeModules(guildId)) {
        const listens = a.module.konEvents?.(a.config).includes(name) ?? false;
        const panels = Object.entries(a.module.panelRefreshOn?.(a.config) ?? {})
          .filter(([, events]) => events.includes(name))
          .map(([panelId]) => panelId);
        if (!listens && panels.length === 0) continue;
        if (!withinBurst(`${guildId}|${a.module.id}`)) {
          ctx.logger.warn("Discord: a module is reacting to kon events too fast; skipped", { guildId, moduleId: a.module.id, event: name });
          continue;
        }
        if (listens && a.module.onKonEvent) {
          try {
            await a.module.onKonEvent(name, data, a.config, runtimeFor(a, { guildId, channelId: null, messageId: null, user: null, memberRoles: [], memberPermissions: null }));
          } catch (err) {
            ctx.logger.warn("Discord module failed on a kon event", { moduleId: a.module.id, event: name, message: messageOf(err) });
          }
        }
        for (const panelId of panels) redrawSoon(guildId, a.module.id, panelId);
      }
    }
  }

  // Started in the background: the routes do not wait for it.
  void subscribe().catch((err) => ctx.logger.warn("Discord: could not read which kon events to listen to", { message: messageOf(err) }));

  // ── Gateway ────────────────────────────────────────────────────────────────

  async function gatewayConfig(): Promise<GatewayConfig> {
    const rows = await asSystem(() =>
      db()
        .select({ moduleId: dcGuildModules.moduleId, config: dcGuildModules.config })
        .from(dcGuildModules)
        .innerJoin(dcGuilds, eq(dcGuilds.id, dcGuildModules.guildId))
        .where(and(eq(dcGuildModules.enabled, true), isNull(dcGuilds.leftAt)))
    );
    let intents: number = INTENTS.GUILDS;
    const events = new Set<GatewayEventName>(["GUILD_CREATE", "GUILD_UPDATE", "GUILD_DELETE"]);
    for (const { moduleId, config } of rows) {
      const module = await asSystem(() => moduleById(moduleId));
      if (!module) continue;
      const parsed = module.intentsFor ? module.config.safeParse(config ?? {}) : null;
      intents |= parsed?.success ? module.intentsFor!(parsed.data) : module.intents;
      module.events.forEach((e) => events.add(e));
    }
    const sorted = GATEWAY_EVENTS.filter((e) => events.has(e));
    return { contract: GATEWAY_CONTRACT_VERSION, intents, events: sorted, revision: `${intents}:${sorted.join(",")}` };
  }

  async function dispatchEvent(envelope: GatewayEventEnvelope): Promise<void> {
    const event = normalizeEvent(envelope);
    if (!event) return;
    // Extensions (security) see the event first and may stop it before any module.
    if ((await eventVerdict(event, { rest: restOf(event.guildId) }, (m) => ctx.logger.warn(`Discord: ${m}`))) === "drop") return;
    // Voice: where the member was comes from the sessions; they are updated after the modules ran.
    let afterVoice: (() => Promise<void>) | null = null;
    if (event.type === "VOICE_STATE_UPDATE" && event.user && event.voice) {
      const userId = event.user.id;
      const [was] = await db()
        .select()
        .from(dcVoiceSessions)
        .where(and(eq(dcVoiceSessions.guildId, event.guildId), eq(dcVoiceSessions.userId, userId)))
        .limit(1);
      const to = event.voice.to;
      event.voice = { ...event.voice, from: was?.channelId ?? null, minutes: was ? Math.floor((clock().getTime() - was.joinedAt.getTime()) / 60_000) : 0 };
      afterVoice = async () => {
        if (was && was.channelId !== to) {
          await countActivity(event.guildId, userId, 0, Math.floor((clock().getTime() - was.joinedAt.getTime()) / 60_000));
        }
        if (!to) {
          await db().delete(dcVoiceSessions).where(and(eq(dcVoiceSessions.guildId, event.guildId), eq(dcVoiceSessions.userId, userId)));
          return;
        }
        const now = clock();
        const moved = was?.channelId !== to;
        await db()
          .insert(dcVoiceSessions)
          .values({ guildId: event.guildId, userId, channelId: to, muted: event.voice!.muted, joinedAt: now, creditedAt: now })
          .onConflictDoUpdate({
            target: [dcVoiceSessions.guildId, dcVoiceSessions.userId],
            set: moved ? { channelId: to, muted: event.voice!.muted, joinedAt: now, creditedAt: now } : { muted: event.voice!.muted },
          });
      };
      if (event.isBot) {
        await afterVoice();
        return;
      }
    }
    if (event.type === "GUILD_MEMBER_ADD" && event.user && !event.isBot) {
      emit(DC_EVENTS.memberJoined, { guildId: event.guildId, userId: event.user.id });
    }
    if (event.type === "GUILD_MEMBER_REMOVE" && event.user && !event.isBot) {
      emit(DC_EVENTS.memberLeft, { guildId: event.guildId, userId: event.user.id });
    }
    const rest = restOf(event.guildId);
    if (event.type === "MESSAGE_CREATE" && event.user && !event.isBot) {
      await countActivity(event.guildId, event.user.id, 1, 0).catch((err) =>
        ctx.logger.warn("Discord: activity not counted", { message: messageOf(err) })
      );
    }
    try {
      await runEvent(event, rest);
    } finally {
      await afterVoice?.();
    }
  }

  async function runEvent(event: DcEvent, rest: DiscordRest) {
    for (const a of await activeModules(event.guildId)) {
      if (!a.module.onEvent || !a.module.events.includes(event.type)) continue;
      try {
        const rt = runtimeFor(
          a,
          {
            guildId: event.guildId,
            channelId: event.channelId,
            messageId: event.messageId ?? null,
            user: event.user,
            memberRoles: event.memberRoles ?? [],
            memberPermissions: null,
          },
          rest
        );
        await a.module.onEvent(event, a.config, rt);
      } catch (err) {
        ctx.logger.warn("Discord module failed on an event", { moduleId: a.module.id, event: event.type, message: messageOf(err) });
      }
    }
  }

  async function ingest(batch: GatewayEventBatch): Promise<GatewayIngestResult> {
    let accepted = 0;
    let dropped = 0;
    stats.lastGatewayBatchAt = new Date().toISOString();
    for (const e of batch.events) {
      stats.gatewayEvents++;
      if (e.t === "GUILD_CREATE" || e.t === "GUILD_UPDATE") {
        const id = str(e.d.id);
        const name = (str(e.d.name) ?? "Unknown server").slice(0, 100);
        const locale = (str(e.d.preferred_locale) ?? "").slice(0, 10) || null;
        if (!id || !/^\d{15,20}$/.test(id)) continue;
        await asSystem(() =>
          db()
            .insert(dcGuilds)
            .values({ id, name, locale })
            .onConflictDoUpdate({ target: dcGuilds.id, set: { name, locale, leftAt: null, updatedAt: new Date() } })
        );
        guildLocale.set(id, locale);
        cache.delete(id);
        accepted++;
      } else if (e.t === "GUILD_DELETE") {
        const id = str(e.d.id);
        // `unavailable: true` is an outage, not a removal.
        if (!id || e.d.unavailable === true) continue;
        await asSystem(() => db().update(dcGuilds).set({ leftAt: new Date(), updatedAt: new Date() }).where(eq(dcGuilds.id, id)));
        cache.delete(id);
        accepted++;
      } else if (schedule(() => dispatchEvent(e))) accepted++;
      else dropped++;
    }
    if (dropped) ctx.logger.warn("Discord events dropped: the queue is full", { dropped });
    return { accepted, dropped };
  }

  // ── Interactions ───────────────────────────────────────────────────────────

  const allowedMentions = { parse: ["users"] };

  const say = (content: string, ephemeral = true) => ({
    type: CHANNEL_MESSAGE,
    data: { content, flags: ephemeral ? EPHEMERAL : 0, allowed_mentions: allowedMentions },
  });

  /** A finished reply as Discord's response body. */
  function responseOf(reply: Reply | null, plan: InteractionPlan, canUpdate: boolean): { type: number; data?: Record<string, unknown> } {
    if (reply?.modal) return { type: MODAL, data: reply.modal as unknown as Record<string, unknown> };
    // A button that only acts (its effect shows elsewhere, e.g. a live panel): acknowledge, say nothing.
    if (!reply && canUpdate) return { type: DEFERRED_UPDATE_MESSAGE };
    const body: MessagePayload = reply
      ? { content: reply.content, embeds: reply.embeds, components: reply.components, files: reply.files?.length ? reply.files : undefined }
      : { content: "Done." };
    if (!body.content && !body.embeds?.length && !body.files?.length) body.content = "Done.";
    const update = canUpdate && (reply?.update ?? plan.update ?? false);
    if (update) return { type: UPDATE_MESSAGE, data: { ...strip(body), allowed_mentions: allowedMentions } };
    const ephemeral = reply?.ephemeral ?? plan.ephemeral ?? false;
    return { type: CHANNEL_MESSAGE, data: { ...strip(body), flags: ephemeral ? EPHEMERAL : 0, allowed_mentions: allowedMentions } };
  }

  const strip = (m: MessagePayload) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined));

  /** What the member reads when a module failed: another kon's refusal as it said it, or a plain sorry. */
  const failure = (err: unknown, lang: Lang = "en") => {
    const reason = publicReason(err);
    return reason ? `⚠️ ${reason}` : translate(lang, "Something went wrong running that.");
  };

  /**
   * Runs the module with a deadline: its answer in time, or "thinking…" now and an edit when it is
   * ready. With `update`, the deferred answer keeps the message the component is on and edits it.
   */
  async function answer(
    work: () => Promise<Reply | null>,
    plan: InteractionPlan,
    token: string | undefined,
    rest: DiscordRest,
    canUpdate: boolean,
    logMeta: Record<string, unknown>,
    budgetMs = directAnswerMs,
    lang: Lang = "en"
  ) {
    const running = background(work);
    const outcome = await Promise.race([
      running.then(
        (reply) => ({ state: "done" as const, reply }),
        (error: unknown) => ({ state: "failed" as const, error })
      ),
      new Promise<{ state: "late" }>((r) => setTimeout(() => r({ state: "late" }), Math.max(50, budgetMs))),
    ]);

    // Files cannot ride in the JSON answer: a reply with a card is deferred and sent as an edit.
    if (outcome.state === "done" && !outcome.reply?.files?.length) return responseOf(outcome.reply, plan, canUpdate);
    if (outcome.state === "failed") {
      ctx.logger.warn("Discord interaction failed", { ...logMeta, message: messageOf(outcome.error) });
      return say(failure(outcome.error, lang));
    }
    // A component that does not answer with a new message keeps its message: "thinking…" would
    // replace nothing, so it is acknowledged as an update, and only an update edits the message.
    const asUpdate = canUpdate && (outcome.state === "done" ? !!outcome.reply?.update : !plan.reply);
    void running
      .then(async (reply) => {
        if (!token) return;
        if (asUpdate && !reply?.update) {
          // A component that only acts kept its message; what it says (a short balance, a cooldown) goes apart.
          if (reply?.content) await rest.followup(token, reply.content, reply.ephemeral ?? true);
          return;
        }
        const r = responseOf(reply, plan, canUpdate);
        if (r.type === MODAL || !r.data) return;
        const { flags: _flags, allowed_mentions: _m, ...body } = r.data as Record<string, unknown>;
        await rest.editOriginal(token, body as MessagePayload);
      })
      .catch(async (err) => {
        ctx.logger.warn("Discord deferred interaction failed", { ...logMeta, message: messageOf(err) });
        if (!token) return;
        // Never overwrite a panel with an error: the member gets it apart, privately.
        if (asUpdate) await rest.followup(token, failure(err, lang), true).catch(() => undefined);
        else await rest.editOriginal(token, failure(err, lang)).catch(() => undefined);
      });
    if (asUpdate) return { type: DEFERRED_UPDATE_MESSAGE };
    const privately = outcome.state === "done" ? (outcome.reply?.ephemeral ?? plan.ephemeral) : plan.ephemeral;
    return { type: DEFERRED_CHANNEL_MESSAGE, data: { flags: privately ? EPHEMERAL : 0 } };
  }

  async function interaction(body: unknown): Promise<Record<string, unknown>> {
    const parsed = InteractionShape.safeParse(body);
    if (!parsed.success) throw AppError.badRequest("Not an interaction");
    const i = parsed.data;
    if (i.type === I_PING) return { type: PONG };
    const lang = langOf(i.locale ?? i.guild_locale);
    if (!i.data) return say(translate(lang, "This kind of interaction is not supported."));
    if (!i.guild_id) return say(translate(lang, "This bot works inside servers only."));
    stats.interactions++;

    const guildId = i.guild_id;
    const where: Where = {
      guildId,
      channelId: i.channel_id ?? null,
      messageId: i.message?.id ?? null,
      user: userRef(i.member?.user ?? i.user),
      memberRoles: i.member?.roles ?? [],
      memberPermissions: i.member?.permissions ?? null,
      locale: i.locale ?? i.guild_locale ?? null,
    };
    const rest = restOf(where.guildId);

    if (i.type === I_COMMAND || i.type === I_AUTOCOMPLETE) return command(i, where, rest);
    if (i.type === I_COMPONENT || i.type === I_MODAL) return componentOrModal(i, where, rest);
    return say(translate(lang, "This kind of interaction is not supported."));
  }

  /** Discord waits 3 s for the first answer: a modal that needs a read gets most of it. */
  const MODAL_READ_MS = 2000;

  /** A plan's modal, now or after a quick read. `undefined` = none (or the read was too slow). */
  async function modalOf(plan: InteractionPlan, logMeta: Record<string, unknown>) {
    if (plan.modal) return plan.modal;
    if (!plan.modalAsync) return undefined;
    const read = plan.modalAsync;
    // In the request, not in the background: it is short (state, at most a few GETs to other kons,
    // capped at 2 s) and Discord is waiting for exactly this answer.
    const modal = await Promise.race([
      asSystem(() => read()).catch((err) => {
        ctx.logger.warn("Discord modal could not be prepared", { ...logMeta, message: messageOf(err) });
        return null;
      }),
      new Promise<null>((r) => setTimeout(() => r(null), MODAL_READ_MS)),
    ]);
    return modal ?? undefined;
  }

  /** What a context menu was used on. */
  function targetOf(i: Interaction) {
    const id = i.data?.target_id;
    if (!id) return null;
    const message = i.data?.resolved?.messages?.[id];
    if (message) return { id, content: message.content ?? "", authorId: message.author?.id, name: message.author ? userRef(message.author)?.name : undefined };
    const user = i.data?.resolved?.users?.[id];
    return { id, name: user ? userRef(user)?.name : undefined };
  }

  async function command(i: Interaction, where: Where, rest: DiscordRest) {
    const started = Date.now();
    const name = i.data?.name ?? "";
    const type = i.data?.type ?? 1;
    const { table } = commandTable(await asSystem(() => activeModules(where.guildId)));
    const entry = table.get(`${type}:${name}`);
    const { subcommand, options, focused } = readOptions(i.data?.options);
    const target = targetOf(i);

    if (i.type === I_AUTOCOMPLETE) {
      if (!entry?.active.module.onAutocomplete || !focused) return { type: AUTOCOMPLETE_RESULT, data: { choices: [] } };
      const module = entry.active.module;
      const rt = runtimeFor(entry.active, where, rest);
      const choices = await Promise.race([
        background(() =>
          module.onAutocomplete!({ command: name, subcommand, option: focused.name, focused: focused.value, options }, entry.active.config, rt)
        ).catch((err): Choice[] => {
          ctx.logger.warn("Discord autocomplete failed", { moduleId: module.id, command: name, message: messageOf(err) });
          return [];
        }),
        new Promise<Choice[]>((r) => setTimeout(() => r([]), AUTOCOMPLETE_MS)),
      ]);
      return { type: AUTOCOMPLETE_RESULT, data: { choices: choices.slice(0, 25) } };
    }

    if (!entry?.active.module.onCommand) return say(translate(langOf(where.locale), "This command is not active on this server."));
    const { module, config } = entry.active;
    const rt = runtimeFor(entry.active, where, rest);
    const planTarget: InteractionTarget = { kind: "command", name, subcommand, options, type, target };
    const plan = module.plan?.(planTarget, config, where, () => rt) ?? {};
    if (plan.deny) return say(plan.deny);
    const modal = await modalOf(plan, { moduleId: module.id, command: name });
    if (modal) return { type: MODAL, data: modal };

    emit(DC_EVENTS.commandUsed, { guildId: where.guildId, moduleId: module.id, command: subcommand ? `${name} ${subcommand}` : name, userId: where.user?.id ?? null });
    return answer(
      () => module.onCommand!({ name, subcommand, options, type, target }, config, rt),
      plan,
      i.token,
      rest,
      false,
      { moduleId: module.id, command: name },
      Math.min(directAnswerMs, 2500 - (Date.now() - started)),
      langOf(where.locale)
    );
  }

  async function componentOrModal(i: Interaction, where: Where, rest: DiscordRest) {
    const id = parseCustomId(i.data?.custom_id ?? "");
    const lang = langOf(where.locale);
    if (!id) return say(translate(lang, "This button belongs to another bot or an old version."));
    const active = (await asSystem(() => activeModules(where.guildId))).find((a) => a.module.id === id.moduleId);
    if (!active) return say(translate(lang, "This is not active on this server any more."));
    const { module, config } = active;
    const rt = runtimeFor(active, where, rest);

    if (i.type === I_COMPONENT) {
      const started = Date.now();
      if (!module.onComponent) return say(translate(lang, "This is not active on this server any more."));
      const values = i.data?.values ?? [];
      const plan = module.plan?.({ kind: "component", id: id.localId, values }, config, where, () => rt) ?? {};
      if (plan.deny) return say(plan.deny);
      const modal = await modalOf(plan, { moduleId: module.id, component: id.localId });
      if (modal) return { type: MODAL, data: modal };
      emit(DC_EVENTS.componentUsed, { guildId: where.guildId, moduleId: module.id, componentId: id.localId, userId: where.user?.id ?? null, values });
      return answer(
        () => module.onComponent!({ id: id.localId, values }, config, rt),
        plan,
        i.token,
        rest,
        true,
        { moduleId: module.id, component: id.localId },
        Math.min(directAnswerMs, 2500 - (Date.now() - started))
      );
    }

    if (!module.onModal) return say(translate(lang, "This form is not active on this server any more."));
    const fields: Record<string, string> = {};
    for (const row of i.data?.components ?? []) {
      for (const c of row.components ?? []) fields[c.custom_id] = c.value ?? "";
    }
    const plan = module.plan?.({ kind: "modal", id: id.localId, fields }, config, where, () => rt) ?? {};
    if (plan.deny) return say(plan.deny);
    emit(DC_EVENTS.modalSubmitted, { guildId: where.guildId, moduleId: module.id, modalId: id.localId, userId: where.user?.id ?? null });
    // A modal opened from a component may update that component's message.
    return answer(() => module.onModal!({ id: id.localId, fields }, config, rt), plan, i.token, rest, !!i.message, {
      moduleId: module.id,
      modal: id.localId,
    });
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  /** The slash commands a server should have now, refusing clashes. Does not call Discord. */
  async function commandsFor(guildId: string): Promise<SlashCommandPayload[]> {
    cache.delete(guildId);
    const { table, clashes } = commandTable(await activeModules(guildId));
    if (clashes.length) throw AppError.conflict(`Two modules declare the same command: ${clashes.join(", ")}`);
    // Built-in commands show their descriptions in the member's language (Discord picks it).
    return [...table.values()].map((t) => (t.active.module.id.startsWith("blueprint-") ? t.payload : localizeCommand(t.payload)));
  }

  async function syncCommands(guildId: string): Promise<SlashCommandPayload[]> {
    const commands = await commandsFor(guildId);
    const s = settingsForGuild(settings(), guildId);
    if (!s.botToken || !s.applicationId) {
      throw AppError.conflict("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN in the API before syncing commands");
    }
    // Overwrites the server's command list: commands of modules switched off disappear.
    try {
      await background(() => restFor(s).syncGuildCommands(guildId, commands));
    } catch (err) {
      throw AppError.badRequest("Discord refused the command list", { reason: messageOf(err) });
    }
    return commands;
  }

  // ── Panels from the panel ──────────────────────────────────────────────────

  /** Posts one panel of a module switched on in a server, from the admin panel. */
  async function postPanel(guildId: string, moduleId: string, panelId: string, channelId: string): Promise<string | null> {
    cache.delete(guildId);
    const active = (await activeModules(guildId)).find((a) => a.module.id === moduleId);
    if (!active) throw AppError.conflict(`Module "${moduleId}" is not on in this server`);
    if (!active.module.renderPanel) throw AppError.badRequest(`Module "${moduleId}" has no panels`);
    const runtime = runtimeFor(active, { guildId, channelId, messageId: null, user: null, memberRoles: [], memberPermissions: null });
    try {
      return await background(() => runtime.panels.post(panelId, channelId));
    } catch (err) {
      throw AppError.badRequest("Discord refused the panel", { reason: publicReason(err) ?? messageOf(err) });
    }
  }

  async function refreshPanels(guildId: string, moduleId?: string): Promise<number> {
    cache.delete(guildId);
    const rows = await db()
      .select({ moduleId: dcPanels.moduleId })
      .from(dcPanels)
      .where(moduleId ? and(eq(dcPanels.guildId, guildId), eq(dcPanels.moduleId, moduleId)) : eq(dcPanels.guildId, guildId));
    const ids = [...new Set(rows.map((r) => r.moduleId))];
    const active = (await activeModules(guildId)).filter((a) => ids.includes(a.module.id));
    for (const a of active) await background(() => redrawPanels(guildId, a));
    return rows.length;
  }

  /**
   * A runtime for one module switched on in a server, acting for `user` (the member page reads and
   * buys with it). Null when the module is off there.
   */
  async function runtimeOf(guildId: string, moduleId: string, user: { id: string; name: string; avatar?: string | null } | null, locale: string | null = null) {
    const active = (await activeModules(guildId)).find((a) => a.module.id === moduleId);
    if (!active) return null;
    const [guild] = await db().select({ name: dcGuilds.name }).from(dcGuilds).where(eq(dcGuilds.id, guildId)).limit(1);
    return {
      config: active.config,
      guildName: guild?.name ?? "",
      rt: runtimeFor(active, { guildId, channelId: null, messageId: null, user, memberRoles: [], memberPermissions: null, locale }),
    };
  }

  /** Tells a module it was switched on, off or reconfigured in a server (AutoMod rules and the like). */
  function configure(guildId: string, moduleId: string, enabled: boolean, config: Record<string, unknown>) {
    recurringDirty = true;
    // Blueprints never set anything up in Discord: only built-in (registered) modules have this hook.
    const module = registeredModule(moduleId);
    if (!module?.onConfigure) return;
    const active: ActiveModule = { module, config };
    // Through the queue: it runs after the request commits, outside its transaction.
    schedule(() =>
      asSystem(async () => {
        try {
          await module.onConfigure!(enabled, config, runtimeFor(active, { guildId, channelId: null, messageId: null, user: null, memberRoles: [], memberPermissions: null }));
        } catch (err) {
          ctx.logger.warn("Discord module could not set itself up in the server", { guildId, moduleId, message: messageOf(err) });
        }
      })
    );
  }

  async function forgetPanelsOf(moduleIds: string[]) {
    if (moduleIds.length) await db().delete(dcPanels).where(inArray(dcPanels.moduleId, moduleIds));
  }

  const engine = {
    availableModules,
    activeModules,
    moduleById,
    forget,
    commandsFor,
    syncCommands,
    gatewayConfig,
    ingest,
    interaction,
    postPanel,
    refreshPanels,
    forgetPanelsOf,
    subscribe,
    onKonEvent,
    configure,
    runtimeOf,
    asSystem,
    isPremium,
    planRefusal,
    tick,
    stats: () => ({ ...stats, queued: queue.length, running, subscribedEvents: [...subscribed].sort() }),
    idle,
    emit,
    /** Runs outside the request's transaction (a model, Discord). */
    background,
  };
  const tickMs = options.scheduleTickMs ?? 20_000;
  if (tickMs > 0) {
    const timer = setInterval(() => {
      void tick().catch((err) => ctx.logger.warn("Discord schedule tick failed", { message: messageOf(err) }));
    }, tickMs);
    (timer as { unref?: () => void }).unref?.();
  }
  options.onEngine?.(engine);
  return engine;
}

export type DcEngine = ReturnType<typeof createDcEngine>;

/**
 * kon-dc — modules: the SDK, the built-in ones and blueprints as modules
 * ============================================================================
 *
 * A MODULE is one thing a bot can do in a server (welcome new members, give XP, answer with AI, run a
 * broadcast booth…). Each one declares:
 *
 *   · `config`   — a zod schema for its per-server settings. The panel, an agent over MCP and
 *                  `PUT /guilds/:guildId/modules/:moduleId` are all validated by it (422 if wrong);
 *   · `intents` and `events` — what it needs from the gateway. The worker identifies with the union
 *                  of what the modules switched on anywhere need;
 *   · `konEvents` — events of OTHER kons it reacts to (`broadcast:match:updated`), from the core's bus;
 *   · `commands` — slash commands, answered over HTTP (interactions), with no gateway;
 *   · `plan`     — decided BEFORE running, with no I/O: open a modal at once, defer as an update or a
 *                  new message, private or not, or refuse (role gate);
 *   · `onCommand` / `onComponent` / `onModal` / `onAutocomplete` / `onEvent` / `onKonEvent` /
 *     `renderPanel` — the behaviour, with a runtime that only reaches this server, this module's own
 *     state, Discord's REST API and other kons through the bot's agent key.
 *
 * Modules are on or off PER SERVER (`dc_guild_modules`), and an installation can switch one off
 * everywhere with `DISCORD_DISABLED_MODULES`. Another kon adds its own with
 * `registerDcModule(defineDcModule({...}))` and depends on this kon by package name.
 *
 * A BLUEPRINT (dc.contract.ts) becomes a module too (`blueprint-<uuid>`): its commands, components,
 * modals, panels and triggers run the declarative steps below. No generated code runs anywhere.
 */

import { runAi, type AiPurpose, type AiRunner } from "./dc.extensions";
import { randomInt } from "node:crypto";

import type { KonContext } from "@kitsuden/shared";
import { z } from "zod";

import {
  BLUEPRINT_EVENT_PREFIX,
  INTENTS,
  PERMISSIONS,
  Snowflake,
  Steps,
  allComponents,
  type PermissionName,
  type Schedule,
  type Access,
  type ActiveComponent,
  type AnyStep,
  type BlueprintCommand,
  type BlueprintCommandOption,
  type BlueprintDefinition,
  type BlueprintModal,
  type BlueprintStep,
  type Choice,
  type Condition,
  type Embed,
  type GatewayEventName,
  type KonSource,
  type MessageTemplate,
  type ScopeList,
} from "./dc.contract";
import { KonCallError, type KitsudenClient } from "./dc.kitsuden";
import type { CardKit } from "./dc.cards";
import type { Lang, Vars } from "./dc.i18n";
import type { TwitchClient } from "./dc.feeds";
import type { TextFetcher } from "./dc.http";
import {
  DiscordApiError,
  type DiscordFile,
  type DiscordRest,
  type MessagePayload,
  type SlashCommandOptionPayload,
  type SlashCommandPayload,
} from "./dc.rest";

// ── The SDK ─────────────────────────────────────────────────────────────────────────────────────

export interface DiscordUserRef {
  id: string;
  name: string;
  /** Discord's avatar hash, when known (interactions carry it): image cards draw it. */
  avatar?: string | null;
}

/** Level from XP: 100 XP for level 1, 400 for 2, 900 for 3… */
export function levelOf(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100));
}
/** XP needed to reach a level. */
export const xpFor = (level: number) => level * level * 100;

/** A module's own state in one server. Keys never reach another module's. */
export interface ModuleKv {
  get(key: string): Promise<unknown>;
  set(key: string, value: string | number | boolean): Promise<void>;
  incr(key: string, by: number): Promise<number>;
}

/** The live panels of THIS module in THIS server. */
export interface ModulePanels {
  post(panelId: string, channelId: string): Promise<string | null>;
  refresh(panelId?: string): Promise<void>;
}

/**
 * The server's economy: balances per currency (`coins`, `xp`, anything) and items, SHARED by every
 * module of the server on purpose. Amounts are whole numbers; a balance never goes below 0.
 */
export interface Economy {
  /**
   * Adds (or with a negative amount takes, stopping at 0); gives the new balance. With `global`, the
   * balance is the member's across every server of this bot (credits, global XP), not this server's.
   */
  add(userId: string, currency: string, amount: number, global?: boolean): Promise<number>;
  /** Takes all of `amount` or nothing: the new balance, or null when it was short. */
  take(userId: string, currency: string, amount: number, global?: boolean): Promise<number | null>;
  get(userId: string, currency: string, global?: boolean): Promise<{ balance: number; rank: number }>;
  top(currency: string, limit: number, global?: boolean): Promise<Array<{ userId: string; balance: number }>>;
  /** With `global`, the bot-wide inventory (global catalog items: badges, backgrounds). */
  addItem(userId: string, item: string, quantity: number, global?: boolean): Promise<number>;
  /** All or nothing, like `take`. */
  takeItem(userId: string, item: string, quantity: number, global?: boolean): Promise<number | null>;
  items(userId: string, global?: boolean): Promise<Array<{ item: string; quantity: number }>>;
}

/** An item of the catalog (dc_items): a server's, or global (`global`: every server shows it). */
export interface CatalogItem {
  item: string;
  global: boolean;
  name: string;
  description: string | null;
  emoji: string | null;
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
  kind: "item" | "consumable" | "role" | "badge" | "background" | "pet";
  imageUrl: string | null;
  color: string | null;
  price: number | null;
  currency: string;
  sellPrice: number | null;
  tradeable: boolean;
  stock: number | null;
  sold: number;
  roleId: string | null;
  dropWeight: number;
}

/** The catalog this server sees: its own items, and the global ones (its own win on the same id). */
export interface Catalog {
  list(filter?: { kind?: CatalogItem["kind"]; rarity?: CatalogItem["rarity"]; forSale?: boolean }): Promise<CatalogItem[]>;
  get(item: string): Promise<CatalogItem | null>;
  /** One item at random, by rarity and drop weight (common 60, uncommon 25, rare 10, epic 4, legendary 1). */
  random(filter?: { kind?: CatalogItem["kind"]; rarity?: CatalogItem["rarity"] }): Promise<CatalogItem | null>;
  /** Counts one sale; false when the stock is gone. */
  reserve(item: CatalogItem): Promise<boolean>;
}

/** How often each rarity drops, before an item's own weight. */
export const RARITY_WEIGHT: Record<CatalogItem["rarity"], number> = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 };
export const RARITY_COLOR: Record<CatalogItem["rarity"], string> = {
  common: "#95a5a6",
  uncommon: "#2ecc71",
  rare: "#3498db",
  epic: "#9b59b6",
  legendary: "#f1c40f",
};

/** A member's profile: the same in every server of this bot. */
export interface Profile {
  userId: string;
  name: string | null;
  avatar: string | null;
  bio: string | null;
  accent: string | null;
  rep: number;
  /** Catalog item ids shown as badges. */
  badges: string[];
  /** A catalog item id drawn behind the profile card. */
  background: string | null;
}

export interface Profiles {
  /** The profile, or an empty one (nothing is written to read it). */
  get(userId: string): Promise<Profile>;
  update(userId: string, patch: Partial<Pick<Profile, "name" | "avatar" | "bio" | "accent" | "badges" | "background">>): Promise<Profile>;
  /** One reputation point from one member to another, once per `hours`. */
  giveRep(from: string, to: string, hours: number): Promise<{ ok: true; rep: number } | { ok: false; nextAt: Date }>;
  /** The most reputation, across the bot. */
  topRep(limit: number): Promise<Array<{ userId: string; rep: number }>>;
  /** Claims the global daily for `day` (days since 1970): the streak, or null when already claimed. */
  claimDaily(userId: string, day: number): Promise<number | null>;
}

/** Lists of members kept by this module (giveaway entries, a queue, a team). */
export interface ModuleLists {
  /** True when the member was not in it. */
  join(list: string, userId: string): Promise<boolean>;
  /** True when the member was in it. */
  leave(list: string, userId: string): Promise<boolean>;
  has(list: string, userId: string): Promise<boolean>;
  count(list: string): Promise<number>;
  members(list: string, limit?: number): Promise<string[]>;
  /** Random members; with `remove`, they leave the list. */
  pick(list: string, count: number, remove?: boolean): Promise<string[]>;
  clear(list: string): Promise<void>;
}

/** Work for later in this server, for this module (`onSchedule` runs it). */
export interface ModuleScheduler {
  /** Runs `onSchedule(key, payload)` at `when`. A key already scheduled is moved. */
  at(when: Date, payload: Record<string, unknown>, key?: string): Promise<void>;
  cancel(key: string): Promise<void>;
}

export interface ModuleRuntime {
  guildId: string;
  channelId: string | null;
  /** The message a button or select was on. */
  messageId: string | null;
  user: DiscordUserRef | null;
  /** Roles of the member who acted (interactions and messages carry them; empty for other events). */
  memberRoles: string[];
  /** The member's permissions in the channel, as Discord's bitfield string (interactions only). */
  memberPermissions: string | null;
  kv: ModuleKv;
  rest: DiscordRest;
  /** Other kons, through the bot's agent key (dc.kitsuden.ts). */
  kitsuden: KitsudenClient;
  panels: ModulePanels;
  economy: Economy;
  /** Profiles, shared by every server of this bot. */
  profiles: Profiles;
  /** The item catalog (this server's items and the global ones). */
  catalog: Catalog;
  lists: ModuleLists;
  schedule: ModuleScheduler;
  /** Image cards (rank, wallet, leaderboard, stat) as PNG files; null from each when no renderer. */
  cards: CardKit;
  /** Recent message text (opt-in, expires). */
  messages: MessageCache;
  /** Members' characters (proxied by webhooks). */
  characters: Characters;
  /** The bot's own user id (its actions are never treated as an attack), when known. */
  botUserId: string | null;
  /** Voice sessions in this server. */
  voice: VoiceTools;
  /** Messages and voice minutes per day. */
  activity: Activity;
  /** Fetches a feed (https only, no private addresses: dc.http.ts). */
  fetchText: TextFetcher;
  /** Who is live on Twitch; null when the API has no Twitch app keys. */
  twitch: TwitchClient | null;
  /** Tells every module of this server that a member used an item (blueprint `item_used` triggers). */
  itemUsed(item: string, userId: string): Promise<void>;
  /** The language the bot answers in: the member's in interactions, the server's otherwise. */
  lang: Lang;
  /** A built-in module's text in `lang`: `rt.t("You have {n} coins.", { n })`. */
  t(text: string, vars?: Vars): string;
  /** The time, from the engine (tests move it). */
  now(): Date;
  /** Emits on the core's bus (after the request commits). */
  emit(event: string, data: unknown): void;
  agents: KonContext["agents"];
  logger: KonContext["logger"];
}

export type Scalar = string | number | boolean;

export interface CommandInvocation {
  name: string;
  subcommand: string | null;
  options: Record<string, Scalar>;
  /** 1 slash command (default), 2 user context menu, 3 message context menu. */
  type?: number;
  /** For a context menu: the member or message it was used on. */
  target?: { id: string; name?: string; content?: string; authorId?: string } | null;
}

export interface ComponentUse {
  id: string;
  values: string[];
}

export interface ModalSubmit {
  id: string;
  fields: Record<string, string>;
}

export interface AutocompleteRequest {
  command: string;
  subcommand: string | null;
  option: string;
  focused: string;
  options: Record<string, Scalar>;
}

/** A modal as Discord takes it. */
export interface ModalPayload {
  custom_id: string;
  title: string;
  components: Array<Record<string, unknown>>;
}

/**
 * The answer to an interaction. `update` replaces the message a component is on; `modal` opens a
 * modal (only as the immediate answer).
 */
export interface Reply extends MessagePayload {
  ephemeral?: boolean;
  update?: boolean;
  modal?: ModalPayload;
}
/** Kept for modules written against 0.1. */
export type CommandReply = Reply;

export type InteractionTarget =
  | ({ kind: "command" } & CommandInvocation)
  | ({ kind: "component" } & ComponentUse)
  | ({ kind: "modal" } & ModalSubmit);

/** Decided before running, with no I/O (or a quick one, for `modalAsync`). */
export interface InteractionPlan {
  /** Refuse with this text (only the member sees it). */
  deny?: string;
  /** Open this modal as the answer. */
  modal?: ModalPayload;
  /**
   * Decide the modal with a quick read (state, another kon): the engine waits ~2 s for it. `null`
   * means "no modal after all": the steps run.
   */
  modalAsync?: () => Promise<ModalPayload | null>;
  /** The answer replaces the message the component is on. */
  update?: boolean;
  /** It answers with a new message (a `reply`). A component without one only acts. */
  reply?: boolean;
  ephemeral?: boolean;
}

/** A gateway event, reduced to what modules use. */
export interface DcEvent {
  type: GatewayEventName;
  guildId: string;
  channelId: string | null;
  messageId?: string | null;
  user: DiscordUserRef | null;
  isBot: boolean;
  content: string | null;
  emoji: string | null;
  /** The member's roles, when Discord sends them (messages, joins). */
  memberRoles?: string[];
  /** GUILD_AUDIT_LOG_ENTRY_CREATE: what a moderator, a bot or an integration did (the user is who did it). */
  audit?: { action: number; targetId: string | null };
  /** GUILD_MEMBER_ADD: the account's age and flags, for join gates. */
  account?: { createdAt: number; hasAvatar: boolean; bot: boolean; verifiedBot: boolean; username: string };
  /** VOICE_STATE_UPDATE: the channel left (null: was not in voice), the one joined (null: left voice). */
  voice?: { from: string | null; to: string | null; muted: boolean; minutes: number };
}

export type ActivityMetric = "messages" | "voice";

/** Activity per member and day in this server (the engine counts it from the gateway). */
export interface Activity {
  /** A member's totals since `days` days ago (0 = today only; null = all time), and their place. */
  of(userId: string, days: number | null, metric?: ActivityMetric): Promise<{ messages: number; voiceMinutes: number; rank: number }>;
  /** The most active since `days` days ago. */
  top(metric: ActivityMetric, days: number | null, limit: number): Promise<Array<{ userId: string; value: number }>>;
}

/** A character a member speaks through. */
export interface Character {
  id: string;
  name: string;
  prefix: string;
  suffix: string;
  avatarUrl: string | null;
  messages: number;
}

/** A member's characters, the same in every server of this bot. */
export interface Characters {
  list(userId: string): Promise<Character[]>;
  /** Adds or replaces (by name). */
  save(userId: string, c: Omit<Character, "id" | "messages">): Promise<Character>;
  remove(userId: string, name: string): Promise<boolean>;
  counted(id: string): Promise<void>;
}

/** Recent message text, kept for a while so logs can show what was deleted or edited. */
export interface MessageCache {
  remember(m: { messageId: string; channelId: string; authorId: string; content: string }, hours: number): Promise<void>;
  recall(messageId: string): Promise<{ channelId: string; authorId: string; content: string } | null>;
  forget(messageId: string): Promise<void>;
}

/** Voice sessions in this server (the engine keeps them from the gateway). */
export interface VoiceTools {
  /** Whole minutes in voice since the last claim (or since joining), and marks them claimed. */
  claimMinutes(userId: string): Promise<number>;
  /** Members in a voice channel now. */
  members(channelId: string): Promise<string[]>;
  /** Everyone in voice in this server now. */
  sessions(): Promise<Array<{ userId: string; channelId: string; muted: boolean }>>;
}

/** A recurring schedule a module asks for (its `onSchedule` runs with this key). */
export interface ModuleSchedule {
  key: string;
  schedule: Schedule;
}

export interface DcModule<C extends z.ZodType = z.ZodType> {
  /** Lowercase, `a-z0-9-`. `blueprint-*` is reserved. Part of the stored state: never rename it. */
  id: string;
  name: string;
  description: string;
  config: C;
  intents: number;
  events: GatewayEventName[];
  /** Events of other kons this module reacts to, given its settings in one server. */
  konEvents?(config: z.output<C>): string[];
  /** The live panels it can post (`renderPanel` draws them). */
  panelIds?: string[];
  /** Panels that depend on its settings in a server (role menus: one per menu). */
  panelsOf?(config: z.output<C>): string[];
  /** Panels and the kon events that redraw them. */
  panelRefreshOn?(config: z.output<C>): Record<string, string[]>;
  commands?(config: z.output<C>): SlashCommandPayload[];
  plan?(
    target: InteractionTarget,
    config: z.output<C>,
    rt: Pick<ModuleRuntime, "guildId" | "channelId" | "user" | "memberRoles" | "memberPermissions"> & { messageId?: string | null; locale?: string | null },
    /** For `modalAsync`: a runtime to read with. */
    full?: () => ModuleRuntime
  ): InteractionPlan;
  onCommand?(invocation: CommandInvocation, config: z.output<C>, rt: ModuleRuntime): Promise<Reply | null>;
  onComponent?(use: ComponentUse, config: z.output<C>, rt: ModuleRuntime): Promise<Reply | null>;
  onModal?(submit: ModalSubmit, config: z.output<C>, rt: ModuleRuntime): Promise<Reply | null>;
  onAutocomplete?(request: AutocompleteRequest, config: z.output<C>, rt: ModuleRuntime): Promise<Choice[]>;
  onEvent?(event: DcEvent, config: z.output<C>, rt: ModuleRuntime): Promise<void>;
  onKonEvent?(name: string, data: unknown, config: z.output<C>, rt: ModuleRuntime): Promise<void>;
  renderPanel?(panelId: string, config: z.output<C>, rt: ModuleRuntime): Promise<MessagePayload | null>;
  /** Intents that depend on the settings (a privileged one only when a setting needs it); default `intents`. */
  intentsFor?(config: z.output<C>): number;
  /** Recurring schedules, given its settings in one server (scheduled messages, `schedule` triggers). */
  schedules?(config: z.output<C>): ModuleSchedule[];
  /** A schedule is due: a recurring one (its key) or one set with `rt.schedule.at`. */
  onSchedule?(key: string, payload: Record<string, unknown>, config: z.output<C>, rt: ModuleRuntime): Promise<void>;
  /**
   * The module was switched on or its settings changed in a server (it was switched off: `enabled`
   * false). For modules that set something up in Discord itself (AutoMod rules). Runs in the
   * background; a failure is logged, the settings stay saved.
   */
  onConfigure?(enabled: boolean, config: z.output<C>, rt: ModuleRuntime): Promise<void>;
  /** A member used an item of the catalog (the Items module's /items use, or a blueprint). */
  onItemUsed?(item: string, userId: string, config: z.output<C>, rt: ModuleRuntime): Promise<void>;
}

export function defineDcModule<C extends z.ZodType>(module: DcModule<C>): DcModule<C> {
  return module;
}

const MODULE_ID = /^[a-z][a-z0-9-]{1,40}$/;
// On globalThis, like the extension registry: an extension that loads its own copy of kon-dc must
// still register its modules into the copy that runs.
const MODULES_KEY = Symbol.for("kitsuden.kon-dc.modules.v1");
const modulesHolder = globalThis as unknown as Record<symbol, Map<string, DcModule> | undefined>;
const registry: Map<string, DcModule> = (modulesHolder[MODULES_KEY] ??= new Map<string, DcModule>());

/** Adds a module for every server of this installation. Throws on a bad or repeated id. */
export function registerDcModule(module: DcModule): void {
  if (!MODULE_ID.test(module.id) || module.id.startsWith("blueprint-")) {
    throw new Error(`Invalid Discord module id "${module.id}"`);
  }
  const existing = registry.get(module.id);
  if (existing && existing !== module) throw new Error(`Discord module "${module.id}" is already registered`);
  registry.set(module.id, module as DcModule);
}

export function registeredModules(): DcModule[] {
  return [...registry.values()];
}

export function registeredModule(id: string): DcModule | undefined {
  return registry.get(id);
}

// ── Component ids ───────────────────────────────────────────────────────────────────────────────

/** `dc:<moduleId>:<localId>`: ≤ 96 characters, under Discord's 100. */
export function customId(moduleId: string, localId: string): string {
  return `dc:${moduleId}:${localId}`;
}

export function parseCustomId(value: string): { moduleId: string; localId: string } | null {
  const m = /^dc:([a-z][a-z0-9-]{1,59}):([a-z0-9_-]{1,32})$/.exec(value);
  return m ? { moduleId: m[1], localId: m[2] } : null;
}

// ── Templates ───────────────────────────────────────────────────────────────────────────────────

export type Scope = Record<string, unknown>;

/** `{{path}}` or `{{path|filter|filter:arg}}`: group 1 is the path, group 2 the filters. */
// Unambiguous on purpose (no backtracking blow-up): filters start with "|" and hold no "|", "{" or
// "}"; applyFilters trims them and ignores unknown names.
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.:$-]+)\s*((?:\|[^|{}]{0,80}){0,10})\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([a-zA-Z0-9_.:$-]+)\s*((?:\|[^|{}]{0,80}){0,10})\}\}$/;

const asNumber = (v: unknown) => (typeof v === "number" ? v : Number(String(v ?? "").trim() || NaN));

/**
 * Filters, applied left to right. Unknown filters leave the value alone (an old bot keeps working
 * when a filter is renamed). None runs code: each is a fixed function.
 */
const FILTERS: Record<string, (v: unknown, arg: string) => unknown> = {
  upper: (v) => toText(v).toUpperCase(),
  lower: (v) => toText(v).toLowerCase(),
  title: (v) => toText(v).replace(/\p{L}[\p{L}']*/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
  trim: (v) => toText(v).trim(),
  length: (v) => (Array.isArray(v) ? v.length : toText(v).length),
  number: (v) => (Number.isFinite(asNumber(v)) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(asNumber(v)) : toText(v)),
  round: (v, arg) => {
    const n = asNumber(v);
    const d = Math.min(6, Math.max(0, Number(arg) || 0));
    return Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : v;
  },
  floor: (v) => (Number.isFinite(asNumber(v)) ? Math.floor(asNumber(v)) : v),
  ceil: (v) => (Number.isFinite(asNumber(v)) ? Math.ceil(asNumber(v)) : v),
  abs: (v) => (Number.isFinite(asNumber(v)) ? Math.abs(asNumber(v)) : v),
  truncate: (v, arg) => {
    const max = Math.max(1, Math.min(2000, Number(arg) || 100));
    const t = toText(v);
    return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
  },
  default: (v, arg) => (v === undefined || v === null || toText(v).trim() === "" ? arg : v),
  plural: (v, arg) => {
    const [one, many] = arg.split(",");
    return asNumber(v) === 1 ? (one ?? "") : (many ?? one ?? "");
  },
  pad: (v, arg) => toText(v).padStart(Math.min(20, Math.max(0, Number(arg) || 2)), "0"),
  json: (v) => JSON.stringify(v ?? null),
  join: (v, arg) => (Array.isArray(v) ? v.map(toText).join(arg || ", ") : toText(v)),
  mention: (v) => (/^\d{15,20}$/.test(toText(v)) ? `<@${toText(v)}>` : toText(v)),
  /** `{{var.ends|time:R}}` → Discord's timestamp: R relative, f date and time, d date, t time. */
  time: (v, arg) => {
    const n = asNumber(v);
    const secs = Number.isFinite(n) ? Math.floor(n) : Math.floor(Date.parse(toText(v)) / 1000);
    return Number.isFinite(secs) ? `<t:${secs}:${/^[tTdDfFR]$/.test(arg) ? arg : "R"}>` : "";
  },
  /** `{{var.xp|bar:500}}` → ▰▰▰▱▱▱▱▱▱▱ (ten blocks, full at the argument). */
  bar: (v, arg) => {
    const max = asNumber(arg);
    const n = asNumber(v);
    if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(n)) return "";
    const full = Math.max(0, Math.min(10, Math.round((n / max) * 10)));
    return "▰".repeat(full) + "▱".repeat(10 - full);
  },
};

function applyFilters(value: unknown, filters: string | undefined): unknown {
  if (!filters) return value;
  let v = value;
  for (const raw of filters.split("|").slice(1)) {
    const f = raw.trim();
    const colon = f.indexOf(":");
    const name = colon === -1 ? f : f.slice(0, colon);
    const arg = colon === -1 ? "" : f.slice(colon + 1);
    const fn = Object.hasOwn(FILTERS, name) ? FILTERS[name] : undefined;
    if (fn) v = fn(v, arg);
  }
  return v;
}

/**
 * A value by name: a flat key first (`user.id`), then a dotted path into objects (`call.match.sideA`).
 * Own properties only: `__proto__` or `constructor` in a template never walk out of the data.
 */
export function lookup(scope: unknown, path: string): unknown {
  if (scope && typeof scope === "object" && Object.hasOwn(scope, path)) return (scope as Scope)[path];
  let cur: unknown = scope;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Scope)[part];
  }
  return cur;
}

const toText = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** A placeholder's value with its filters applied, keeping its type. */
export function valueOf(scope: Scope, path: string, filters?: string): unknown {
  return applyFilters(lookup(scope, path), filters);
}

export function render(template: string, scope: Scope): string {
  return template.replace(PLACEHOLDER, (_m, key: string, filters: string) => toText(valueOf(scope, key, filters)));
}

/** For URLs: each substituted value is encoded, so `{{option.q}}` cannot add a path or a parameter. */
export function renderPath(template: string, scope: Scope): string {
  return template.replace(PLACEHOLDER, (_m, key: string, filters: string) => encodeURIComponent(toText(valueOf(scope, key, filters))));
}

/** A template that is exactly one placeholder keeps the value's type (a list stays a list). */
export function renderValue(template: string, scope: Scope): unknown {
  const whole = WHOLE_PLACEHOLDER.exec(template);
  return whole ? valueOf(scope, whole[1], whole[2]) : render(template, scope);
}

const MISSING = Symbol("missing");

function renderJsonValue(value: unknown, scope: Scope): unknown {
  if (typeof value === "string") {
    const whole = WHOLE_PLACEHOLDER.exec(value);
    if (whole) {
      const v = valueOf(scope, whole[1], whole[2]);
      return v === undefined || v === null || v === "" ? MISSING : v;
    }
    return render(value, scope);
  }
  if (Array.isArray(value)) return value.map((v) => renderJsonValue(v, scope)).filter((v) => v !== MISSING);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      const r = renderJsonValue(v, scope);
      if (r !== MISSING) out[k] = r;
    }
    return out;
  }
  return value;
}

/**
 * JSON whose strings are templates. `"{{x}}"` alone keeps x's type (a number stays a number), and
 * when x is missing or empty the key (or array item) is left out: "leave it as it is".
 */
export function renderJson(value: unknown, scope: Scope): unknown {
  const r = renderJsonValue(value, scope);
  return r === MISSING ? null : r;
}

/** Variables every step sees. `{{kv.<key>}}` is resolved separately (it needs a read). */
export function baseVars(
  rt: Pick<ModuleRuntime, "guildId" | "channelId" | "user"> & { messageId?: string | null },
  options: Record<string, Scalar> = {}
): Scope {
  const now = "now" in rt && typeof rt.now === "function" ? (rt.now as () => Date)() : new Date();
  const vars: Scope = {
    "guild.id": rt.guildId,
    "channel.id": rt.channelId ?? "",
    "channel.mention": rt.channelId ? `<#${rt.channelId}>` : "",
    "message.id": rt.messageId ?? "",
    "user.id": rt.user?.id ?? "",
    "user.name": rt.user?.name ?? "",
    "user.mention": rt.user ? `<@${rt.user.id}>` : "",
    now: now.toISOString(),
    "now.unix": Math.floor(now.getTime() / 1000),
  };
  // Raw values: `"{{option.firstto}}"` alone in a body stays a number, a boolean a boolean.
  for (const [k, v] of Object.entries(options)) vars[`option.${k}`] = v;
  return vars;
}

/** Discord refuses messages over 2000 characters. */
export function clip(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The items of a list operand: a list value, a JSON array, or comma-separated text. */
function listOf(template: string, scope: Scope): string[] {
  const v = renderValue(template, scope);
  if (Array.isArray(v)) return v.map((x) => toText(x).trim().toLowerCase());
  const text = toText(v).trim();
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((x) => toText(x).trim().toLowerCase());
    } catch {
      /* plain text */
    }
  }
  return text.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

export function holds(condition: Condition | undefined, scope: Scope): boolean {
  if (!condition) return true;
  const left = render(condition.left, scope);
  const right = render(condition.right ?? "", scope);
  switch (condition.op) {
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "contains":
      return left.toLowerCase().includes(right.toLowerCase());
    case "starts_with":
      return left.toLowerCase().startsWith(right.toLowerCase());
    case "ends_with":
      return left.toLowerCase().endsWith(right.toLowerCase());
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = Number(left);
      const b = Number(right);
      if (!Number.isFinite(a) || !Number.isFinite(b) || left.trim() === "" || right.trim() === "") return false;
      if (condition.op === "gt") return a > b;
      if (condition.op === "gte") return a >= b;
      if (condition.op === "lt") return a < b;
      return a <= b;
    }
    case "empty":
      return left.trim() === "";
    case "not_empty":
      return left.trim() !== "";
    case "in":
    case "not_in": {
      const found = listOf(condition.right ?? "", scope).includes(left.trim().toLowerCase());
      return condition.op === "in" ? found : !found;
    }
  }
}

/** A permission bitfield as Discord sends it, with every permission when it has Administrator. */
export function hasPermissions(bitfield: string | null | undefined, wanted: PermissionName[]): boolean {
  if (!wanted.length) return true;
  let bits: bigint;
  try {
    bits = BigInt(bitfield ?? "0");
  } catch {
    return false;
  }
  if (bits & PERMISSIONS.administrator) return true;
  return wanted.every((p) => (bits & PERMISSIONS[p]) === PERMISSIONS[p]);
}

/** The bitfield of some permissions, as a string (for `default_member_permissions`). */
export function permissionBits(names: PermissionName[]): string {
  return String(names.reduce((acc, n) => acc | PERMISSIONS[n], 0n));
}

export function allowed(access: Access | undefined, roles: string[], permissions: string | null = null): boolean {
  if (!access) return true;
  if (access.roles && !access.roles.some((r) => roles.includes(r))) return false;
  if (access.permissions && !hasPermissions(permissions, access.permissions)) return false;
  return true;
}

const denial = (access: Access) => access.message ?? "You do not have a role that may use this.";

/** Resolves every `{{kv.*}}` a piece of data mentions into the scope (one read each). */
async function withKv(data: unknown, scope: Scope, kv: ModuleKv): Promise<Scope> {
  const text = typeof data === "string" ? data : JSON.stringify(data ?? "");
  const out: Scope = { ...scope };
  for (const m of text.matchAll(PLACEHOLDER)) {
    const name = m[1];
    if (!name.startsWith("kv.") || Object.hasOwn(out, name)) continue;
    // `$user` in a key is the member's id: `{{kv.bio:$user}}` reads what `kv_set key: bio:{{user.id}}` wrote.
    const key = name
      .slice(3)
      .split("$user")
      .join(String(scope["user.id"] ?? ""))
      .toLowerCase()
      .slice(0, 120);
    const value = await kv.get(key);
    out[name] = value === undefined || value === null ? "" : value;
  }
  return out;
}

// ── Rendering messages ──────────────────────────────────────────────────────────────────────────

const STYLE: Record<string, number> = { primary: 1, secondary: 2, success: 3, danger: 4 };
const ENTITY_SELECT: Record<string, number> = { user_select: 5, role_select: 6, channel_select: 8 };
const ZWS = "​";

/** An embed color: a number, `#rrggbb`, `rrggbb`, or a template that gives one of those. */
export function colorOf(value: number | string | undefined, scope: Scope): number | null {
  if (value === undefined) return null;
  if (typeof value === "number") return value;
  const text = render(value, scope).trim().replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(text)) return parseInt(text, 16);
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 && n <= 0xffffff && text !== "" ? n : null;
}

function renderEmbed(e: Embed, scope: Scope): Record<string, unknown> {
  const t = (s: string | undefined, max: number) => (s === undefined ? undefined : clip(render(s, scope), max) || undefined);
  const out: Record<string, unknown> = {};
  const title = t(e.title, 256);
  const description = t(e.description, 4000);
  const url = t(e.url, 500);
  if (title) out.title = title;
  if (description) out.description = description;
  if (url && /^https?:\/\//.test(url)) out.url = url;
  const color = colorOf(e.color, scope);
  if (color !== null) out.color = color;
  if (e.fields?.length) {
    out.fields = e.fields.map((f) => ({
      name: clip(render(f.name, scope), 256) || ZWS,
      value: clip(render(f.value, scope), 1024) || ZWS,
      inline: f.inline ?? false,
    }));
  }
  const footer = t(e.footer, 2048);
  if (footer) out.footer = { text: footer };
  const thumb = t(e.thumbnail, 500);
  if (thumb && /^(https?|attachment):\/\//.test(thumb)) out.thumbnail = { url: thumb };
  const image = t(e.image, 500);
  if (image && /^(https?|attachment):\/\//.test(image)) out.image = { url: image };
  if (!out.title && !out.description && !out.fields) out.description = ZWS;
  return out;
}

/** Options of a select or autocomplete: read from another kon, or already in the scope. */
export async function listFrom(source: KonSource | ScopeList, scope: Scope, rt: Pick<ModuleRuntime, "kitsuden">, limit = 25) {
  let list: unknown;
  if ("scope" in source) list = lookup(scope, source.scope);
  else {
    const { data } = await rt.kitsuden.call("GET", renderPath(source.path, scope));
    list = source.items ? lookup(data, source.items) : data;
  }
  if (!Array.isArray(list)) return [];
  const out: Array<{ label: string; value: string; description?: string }> = [];
  for (const item of list) {
    const s = { ...scope, item };
    const label = clip(render(source.label, s), 100);
    const value = clip(render(source.value, s), 100);
    if (!label || !value) continue;
    const description = source.description ? clip(render(source.description, s), 100) : undefined;
    out.push({ label, value, ...(description ? { description } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}

async function renderComponent(c: ActiveComponent | { type: "link"; label: string; url: string; emoji?: string }, moduleId: string, scope: Scope, rt: ModuleRuntime) {
  const emoji = "emoji" in c && c.emoji ? { name: c.emoji } : undefined;
  switch (c.type) {
    case "link": {
      const url = render(c.url, scope);
      return { type: 2, style: 5, label: clip(render(c.label, scope), 80) || "Link", url: /^https?:\/\//.test(url) ? url : "https://discord.com", ...(emoji ? { emoji } : {}) };
    }
    case "button":
      return {
        type: 2,
        style: STYLE[c.styles?.find((s) => holds(s.if, scope))?.style ?? c.style ?? "secondary"],
        label: clip(render(c.label, scope), 80) || ZWS,
        custom_id: customId(moduleId, c.id),
        disabled: c.disabledIf ? holds(c.disabledIf, scope) : false,
        ...(emoji ? { emoji } : {}),
      };
    case "select": {
      let options: Array<{ label: string; value: string; description?: string; emoji?: { name: string }; default?: boolean }> = [];
      if (c.options) {
        options = c.options.map((o) => ({
          label: clip(render(o.label, scope), 100) || o.value,
          value: o.value,
          ...(o.description ? { description: o.description } : {}),
          ...(o.emoji ? { emoji: { name: o.emoji } } : {}),
        }));
      } else if (c.optionsFrom) {
        try {
          options = await listFrom(c.optionsFrom, scope, rt);
        } catch (err) {
          rt.logger.warn("Discord select: its source failed", { moduleId, select: c.id, message: messageOf(err) });
        }
      }
      const empty = options.length === 0;
      if (c.selected && !empty) {
        const picked = new Set(listOf(c.selected, scope));
        const max = c.maxValues ?? 1;
        let n = 0;
        options = options.map((o) => (picked.has(o.value.toLowerCase()) && n++ < max ? { ...o, default: true } : o));
      }
      return {
        type: 3,
        custom_id: customId(moduleId, c.id),
        ...(c.placeholder ? { placeholder: clip(render(c.placeholder, scope), 150) } : {}),
        // Discord refuses a select with no options: one disabled placeholder instead.
        options: empty ? [{ label: "Nothing to pick", value: "-" }] : options,
        disabled: empty,
        min_values: Math.min(c.minValues ?? 1, Math.max(options.length, 1)),
        max_values: Math.min(c.maxValues ?? 1, Math.max(options.length, 1)),
      };
    }
    default:
      return {
        type: ENTITY_SELECT[c.type],
        custom_id: customId(moduleId, c.id),
        ...(c.placeholder ? { placeholder: clip(render(c.placeholder, scope), 150) } : {}),
        min_values: c.minValues ?? 1,
        max_values: c.maxValues ?? 1,
      };
  }
}

/** A message template with every placeholder filled, components with their ids. */
export async function renderMessage(tpl: MessageTemplate, moduleId: string, scope: Scope, rt: ModuleRuntime): Promise<MessagePayload> {
  const s = await withKv(tpl, scope, rt.kv);
  const out: MessagePayload = {};
  if (tpl.content) out.content = clip(render(tpl.content, s)) || ZWS;
  if (tpl.embeds?.length) out.embeds = tpl.embeds.map((e) => renderEmbed(e, s));
  if (tpl.components?.length) {
    out.components = [];
    for (const row of tpl.components) {
      const rendered = [];
      for (const c of row) rendered.push(await renderComponent(c as ActiveComponent, moduleId, s, rt));
      out.components.push({ type: 1, components: rendered });
    }
  }
  if (!out.content && !out.embeds) out.content = ZWS;
  return out;
}

export function renderModal(modal: BlueprintModal, moduleId: string, scope: Scope): ModalPayload {
  return {
    custom_id: customId(moduleId, modal.id),
    title: clip(render(modal.title, scope), 45) || "Form",
    components: modal.inputs.map((i) => {
      const value = i.value ? clip(render(i.value, scope), 4000) : "";
      return {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: i.id,
            label: i.label,
            style: i.style === "paragraph" ? 2 : 1,
            required: i.required ?? false,
            ...(i.minLength !== undefined ? { min_length: i.minLength } : {}),
            ...(i.maxLength !== undefined ? { max_length: i.maxLength } : {}),
            ...(i.placeholder ? { placeholder: i.placeholder } : {}),
            ...(value ? { value } : {}),
          },
        ],
      };
    }),
  };
}

export const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── Steps (blueprints) ──────────────────────────────────────────────────────────────────────────

/** A failure the member may read as it is (a price they cannot pay, a number that is not one). */
export class StepError extends Error {}

/** Seconds since the last time `key` was stamped, and stamps it when `cooldown` has passed. */
async function cooledDown(kv: ModuleKv, key: string, cooldownSeconds: number, now = Date.now()): Promise<boolean> {
  if (cooldownSeconds <= 0) return true;
  const secs = Math.floor(now / 1000);
  const last = Number((await kv.get(key)) ?? 0);
  if (secs - last < cooldownSeconds) return false;
  await kv.set(key, secs);
  return true;
}

/** "1 h 20 min", "45 s". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [d && `${d} d`, h && `${h} h`, m && `${m} min`].filter(Boolean) as string[];
  return parts.length ? parts.slice(0, 2).join(" ") : `${s} s`;
}

/** A short stable id for a list of steps (the default key of its cooldown). */
function hashOf(value: unknown): string {
  let h = 0x811c9dc5;
  const text = JSON.stringify(value);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Arithmetic only: numbers, + - * / % ^, parentheses and min max round floor ceil abs sqrt. A small
 * parser, never `eval`. Throws on anything else.
 */
export function evaluate(expr: string): number {
  const src = expr.replace(/\s+/g, "");
  if (src.length > 300) throw new StepError("That calculation is too long.");
  let i = 0;
  const peek = () => src[i];
  const fail = (): never => {
    throw new StepError(`Could not compute "${expr.slice(0, 80)}".`);
  };
  const FUNCS: Record<string, (args: number[]) => number> = {
    min: (a) => Math.min(...a),
    max: (a) => Math.max(...a),
    round: (a) => Math.round(a[0]),
    floor: (a) => Math.floor(a[0]),
    ceil: (a) => Math.ceil(a[0]),
    abs: (a) => Math.abs(a[0]),
    sqrt: (a) => Math.sqrt(a[0]),
  };
  let depth = 0;
  function primary(): number {
    const c = peek();
    if (c === "(") {
      if (++depth > 20) fail();
      i++;
      const v = sum();
      if (peek() !== ")") fail();
      i++;
      depth--;
      return v;
    }
    if (c === "-") {
      i++;
      return -power();
    }
    if (c === "+") {
      i++;
      return power();
    }
    const num = /^(\d+(\.\d+)?|\.\d+)/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const name = /^[a-z]+/.exec(src.slice(i));
    if (name && Object.hasOwn(FUNCS, name[0]) && src[i + name[0].length] === "(") {
      i += name[0].length + 1;
      const args = [sum()];
      while (peek() === ",") {
        i++;
        args.push(sum());
      }
      if (peek() !== ")" || args.length > 20) fail();
      i++;
      return FUNCS[name[0]](args);
    }
    return fail();
  }
  function power(): number {
    const base = primary();
    if (peek() === "^") {
      i++;
      return base ** power();
    }
    return base;
  }
  function product(): number {
    let v = power();
    for (;;) {
      const c = peek();
      if (c !== "*" && c !== "/" && c !== "%") return v;
      i++;
      const r = power();
      v = c === "*" ? v * r : c === "/" ? v / r : v % r;
    }
  }
  function sum(): number {
    let v = product();
    for (;;) {
      const c = peek();
      if (c !== "+" && c !== "-") return v;
      i++;
      const r = product();
      v = c === "+" ? v + r : v - r;
    }
  }
  if (!src) fail();
  const result = sum();
  if (i !== src.length || !Number.isFinite(result)) fail();
  return result;
}

export interface StepContext {
  moduleId: string;
  modals: BlueprintModal[];
}

const SNOWFLAKE = /^\d{15,20}$/;
/** What a `later` remembers is capped: it lives in the database until it runs. */
const LATER_MAX_BYTES = 64_000;

/**
 * Runs the steps in order. Returns what a `reply` or `update_message` step said (the last one wins),
 * the answer of a `stop`, a short balance or a cooldown; or null. A step that fails stops the rest:
 * half a blueprint is better than steps acting on a state the earlier one did not leave. A refused
 * call to another kon (`KonCallError`) and a `StepError` reach the member as they are.
 *
 * `open_modal` does nothing here: Discord opens a modal only as the immediate answer, so the plan
 * (before any I/O, or with a quick read) decides it.
 */
export async function runSteps(steps: BlueprintStep[] | AnyStep[], rt: ModuleRuntime, vars: Scope, sc: StepContext): Promise<Reply | null> {
  let reply: Reply | null = null;
  const scope: Scope = { call: {}, sent: {}, var: {}, ...vars };
  const listKey = hashOf(steps);
  const filled = (data: unknown) => withKv(data, scope, rt.kv);
  const text = async (template: string) => clip(render(template, await filled(template)));
  const keyOf = (template: string) => render(template, scope).toLowerCase().slice(0, 120);
  const listName = (template: string) => render(template, scope).toLowerCase().trim().slice(0, 64) || "default";
  const setVar = (name: string, value: unknown) => {
    (scope.var as Scope)[name] = value;
  };
  const idFrom = (raw: string) => raw.trim().replace(/^<[@#][!&]?(\d+)>$/, "$1");
  const channelOf = (ref: string | undefined) => {
    const id = ref === undefined || ref === "$channel" ? rt.channelId : idFrom(render(ref, scope));
    return id && SNOWFLAKE.test(id) ? id : null;
  };
  const messageRef = (ref: string | undefined) => {
    const id = ref === undefined || ref === "$message" ? rt.messageId : idFrom(render(ref, scope));
    return id && SNOWFLAKE.test(id) ? id : null;
  };
  const userOf = (ref: string | undefined) => {
    const id = ref ? idFrom(render(ref, scope)) : rt.user?.id;
    return id && SNOWFLAKE.test(id) ? id : null;
  };
  const roleOf = (ref: string) => {
    const id = idFrom(render(ref, scope));
    return SNOWFLAKE.test(id) ? id : null;
  };
  const numberOf = async (ref: number | string, what: string) => {
    if (typeof ref === "number") return ref;
    const raw = render(ref, await filled(ref)).trim();
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) throw new StepError(`${what} is not a number: "${raw.slice(0, 40)}".`);
    return Math.trunc(n);
  };
  const short = (content: string | undefined, fallback: string): Reply => ({ content: clip(content ?? fallback), ephemeral: true });

  /** Cards drawn by `card` steps, waiting for the next message (reply, update, send, DM). */
  let pending: DiscordFile[] = [];
  /** Gives a message the waiting cards; an embed image naming a card that was not drawn is dropped. */
  const attach = (msg: MessagePayload): MessagePayload => {
    const names = new Set(pending.map((f) => f.name));
    const embeds = msg.embeds?.map((e) => {
      const out = { ...e };
      for (const k of ["image", "thumbnail"] as const) {
        const url = (out[k] as { url?: string } | undefined)?.url;
        if (url?.startsWith("attachment://") && !names.has(url.slice("attachment://".length))) delete out[k];
      }
      return out;
    });
    const files = pending;
    pending = [];
    return { ...msg, ...(embeds ? { embeds } : {}), ...(files.length ? { files } : {}) };
  };

  async function drawCard(step: Extract<BlueprintStep, { do: "card" }>) {
    const s = await filled(step);
    const theme = {
      accent: step.accent ? render(step.accent, s) : undefined,
      background: step.background ? render(step.background, s) : undefined,
    };
    const name = step.name ?? "card";
    const user = userOf(step.userId) ?? rt.user?.id ?? null;
    const currency = step.currency ?? "coins";
    switch (step.kind) {
      case "rank": {
        if (!user) return null;
        const { balance: xp, rank } = await rt.economy.get(user, "xp", step.global);
        const level = levelOf(xp);
        const from = xpFor(level);
        return rt.cards.rank({ user, level, current: xp - from, needed: xpFor(level + 1) - from, totalXp: xp, rank, theme }, name);
      }
      case "wallet": {
        if (!user) return null;
        const { balance, rank } = await rt.economy.get(user, currency, step.global);
        const label = step.title ? render(step.title, s) : currency;
        const lines = step.subtitle ? [render(step.subtitle, s)] : [];
        return rt.cards.wallet({ user, currencyName: label, balance, rank, lines, theme }, name);
      }
      case "leaderboard": {
        const rows = await rt.economy.top(currency, step.limit ?? 10, step.global);
        return rt.cards.leaderboard(
          {
            title: step.title ? render(step.title, s) : `Top ${currency}`,
            unit: currency,
            rows: rows.map((r) => ({ user: r.userId, value: r.balance, ...(currency === "xp" ? { sub: `level ${levelOf(r.balance)}` } : {}) })),
            theme,
          },
          name
        );
      }
      case "stat":
        return rt.cards.stat(
          {
            title: step.title ? render(step.title, s) : "",
            value: step.value ? render(step.value, s) : "",
            subtitle: step.subtitle ? render(step.subtitle, s) : undefined,
            user: step.userId || step.withMember ? user : null,
            theme,
          },
          name
        );
    }
  }

  for (const step of steps as BlueprintStep[]) {
    // A condition may read this blueprint's state (`{{kv.set}}`).
    if (step.if && !holds(step.if, await filled(step.if))) continue;
    switch (step.do) {
      case "reply":
        reply = { ...attach(await renderMessage(step, sc.moduleId, scope, rt)), ephemeral: step.ephemeral };
        break;
      case "update_message":
        reply = { ...attach(await renderMessage(step, sc.moduleId, scope, rt)), update: true };
        break;
      case "card": {
        const file = await drawCard(step);
        if (file) pending = [...pending.filter((f) => f.name !== file.name), file];
        break;
      }
      case "send_message": {
        const channel = channelOf(step.channelId);
        if (!channel) break;
        const sent = await rt.rest.sendMessage(channel, attach(await renderMessage(step, sc.moduleId, scope, rt)));
        if (step.saveAs) (scope.sent as Scope)[step.saveAs] = sent.id ?? "";
        break;
      }
      case "dm": {
        const user = userOf(step.userId);
        if (!user) break;
        try {
          const channel = await rt.rest.openDm(user);
          await rt.rest.sendMessage(channel, attach(await renderMessage(step, sc.moduleId, scope, rt)));
        } catch (err) {
          // Closed DMs are the member's choice, not an error of the bot.
          if (err instanceof DiscordApiError && (err.status === 403 || err.status === 400)) {
            rt.logger.info("Discord DM not delivered (closed DMs)", { moduleId: sc.moduleId });
          } else throw err;
        }
        break;
      }
      case "open_modal":
        break;
      case "stop":
        return step.content ? { content: await text(step.content), ephemeral: step.ephemeral ?? true } : reply;
      case "cooldown": {
        const who = step.per === "guild" ? "guild" : step.per === "channel" ? (rt.channelId ?? "none") : (rt.user?.id ?? "none");
        const key = `cd:${step.key ?? listKey}:${who}`;
        const secs = Math.floor(rt.now().getTime() / 1000);
        const last = Number((await rt.kv.get(key)) ?? 0);
        const left = step.seconds - (secs - last);
        if (left > 0) {
          scope["cooldown.left"] = duration(left);
          return short(step.message ? await text(step.message) : undefined, rt.t("Wait {time}.", { time: duration(left) }));
        }
        await rt.kv.set(key, secs);
        break;
      }
      case "set_var": {
        const s = await filled(step.value);
        const v = renderValue(step.value, s);
        setVar(step.name, typeof v === "string" ? v.slice(0, 2000) : v);
        break;
      }
      case "random": {
        if (step.pick) {
          const total = step.pick.reduce((acc, p) => acc + (p.weight ?? 1), 0);
          let roll = (randomInt(0, 1_000_000) / 1_000_000) * total;
          let chosen = step.pick[step.pick.length - 1].value;
          for (const p of step.pick) {
            roll -= p.weight ?? 1;
            if (roll < 0) {
              chosen = p.value;
              break;
            }
          }
          setVar(step.saveAs, render(chosen, await filled(chosen)));
        } else {
          setVar(step.saveAs, randomInt(step.min!, step.max! + 1));
        }
        break;
      }
      case "math": {
        const result = evaluate(render(step.expr, await filled(step.expr)));
        setVar(step.saveAs, Math.round(result * 1e6) / 1e6);
        break;
      }
      case "later": {
        const minutes = await numberOf(step.minutes, "The delay");
        if (minutes < 1 || minutes > 43_200) throw new StepError("A delay goes from 1 minute to 30 days.");
        const remembered = JSON.parse(JSON.stringify(scope)) as Scope;
        if (JSON.stringify(remembered).length > LATER_MAX_BYTES) throw new StepError("Too much to remember for later.");
        await rt.schedule.at(new Date(rt.now().getTime() + minutes * 60_000), {
          kind: "later",
          steps: step.steps as unknown as Record<string, unknown>[],
          vars: remembered,
          channelId: rt.channelId,
          messageId: rt.messageId,
          user: rt.user,
        } as Record<string, unknown>);
        break;
      }
      case "add_role":
      case "remove_role": {
        const user = userOf(step.userId);
        const role = roleOf(step.roleId);
        if (!user || !role) break;
        if (step.do === "add_role") await rt.rest.addRole(rt.guildId, user, role);
        else await rt.rest.removeRole(rt.guildId, user, role);
        break;
      }
      case "toggle_role": {
        const user = userOf(step.userId);
        const role = roleOf(step.roleId);
        if (!user || !role) break;
        const roles = user === rt.user?.id ? rt.memberRoles : (await rt.rest.getMember(rt.guildId, user)).roles;
        const has = roles.includes(role);
        if (has) await rt.rest.removeRole(rt.guildId, user, role);
        else await rt.rest.addRole(rt.guildId, user, role);
        if (step.saveAs) setVar(step.saveAs, has ? "removed" : "added");
        break;
      }
      case "timeout": {
        const user = userOf(step.userId);
        if (!user) break;
        const minutes = Math.min(40_320, Math.max(0, await numberOf(step.minutes, "The timeout")));
        const until = minutes ? new Date(rt.now().getTime() + minutes * 60_000).toISOString() : null;
        await rt.rest.editMember(rt.guildId, user, { communicationDisabledUntil: until }, step.reason ? await text(step.reason) : undefined);
        break;
      }
      case "kick": {
        const user = userOf(step.userId);
        if (user) await rt.rest.kick(rt.guildId, user, step.reason ? await text(step.reason) : undefined);
        break;
      }
      case "ban": {
        const user = userOf(step.userId);
        if (user) {
          await rt.rest.ban(rt.guildId, user, step.reason ? await text(step.reason) : undefined, (step.deleteMessageHours ?? 0) * 3600);
        }
        break;
      }
      case "set_nickname": {
        const user = userOf(step.userId);
        if (!user) break;
        const nick = (await text(step.nickname)).slice(0, 32);
        await rt.rest.editMember(rt.guildId, user, { nick: nick || null });
        break;
      }
      case "delete_message":
      case "pin_message":
      case "react": {
        const channel = channelOf(step.channelId);
        const message = messageRef(step.messageId);
        if (!channel || !message) break;
        if (step.do === "delete_message") await rt.rest.deleteMessage(channel, message);
        else if (step.do === "pin_message") await rt.rest.pinMessage(channel, message, !step.unpin);
        else await rt.rest.react(channel, message, step.emoji);
        break;
      }
      case "create_thread": {
        const channel = channelOf(step.channelId);
        if (!channel) break;
        const thread = await rt.rest.createThread(channel, {
          name: (await text(step.name)).slice(0, 100) || "thread",
          messageId: step.messageId ? (messageRef(step.messageId) ?? undefined) : undefined,
          private: step.private,
          autoArchiveMinutes: step.autoArchiveMinutes,
        });
        const invited = step.invite ? userOf(step.invite) : step.private ? rt.user?.id : null;
        if (invited) await rt.rest.addThreadMember(thread.id, invited);
        if (step.saveAs) (scope.sent as Scope)[step.saveAs] = thread.id;
        break;
      }
      case "close_thread": {
        const channel = channelOf(step.channelId);
        if (channel) await rt.rest.setThreadState(channel, { archived: true, locked: step.lock ?? true });
        break;
      }
      case "poll": {
        const channel = channelOf(step.channelId);
        if (!channel) break;
        const s = await filled(step);
        const sent = await rt.rest.sendMessage(channel, {
          poll: {
            question: { text: clip(render(step.question, s), 300) || "?" },
            answers: step.answers.map((a) => ({
              poll_media: { text: clip(render(a.text, s), 55) || "-", ...(a.emoji ? { emoji: { name: a.emoji } } : {}) },
            })),
            duration: step.hours ?? 24,
            allow_multiselect: step.multiselect ?? false,
          },
        });
        if (step.saveAs) (scope.sent as Scope)[step.saveAs] = sent.id ?? "";
        break;
      }
      case "wallet_add": {
        const user = userOf(step.userId);
        if (!user) break;
        const balance = await rt.economy.add(user, step.currency ?? "coins", await numberOf(step.amount, "The amount"), step.global);
        if (step.saveAs) setVar(step.saveAs, balance);
        break;
      }
      case "wallet_take": {
        const user = userOf(step.userId);
        if (!user) break;
        const currency = step.currency ?? "coins";
        const amount = Math.abs(await numberOf(step.amount, "The price"));
        const balance = await rt.economy.take(user, currency, amount, step.global);
        if (balance === null) return short(step.else ? await text(step.else) : undefined, rt.t("Not enough {currency}.", { currency }));
        if (step.saveAs) setVar(step.saveAs, balance);
        break;
      }
      case "wallet_get": {
        const user = userOf(step.userId);
        if (!user) break;
        const { balance, rank } = await rt.economy.get(user, step.currency ?? "coins", step.global);
        setVar(step.saveAs, balance);
        setVar(`${step.saveAs}_rank`, rank);
        break;
      }
      case "leaderboard": {
        const rows = await rt.economy.top(step.currency ?? "coins", step.limit ?? 10, step.global);
        const line = step.line ?? "**{{rank}}.** <@{{user}}> — {{balance|number}}";
        const lines = rows.map((r, n) => render(line, { ...scope, rank: n + 1, user: r.userId, balance: r.balance }));
        setVar(step.saveAs, clip(lines.join("\n") || "Nobody yet.", 4000));
        setVar(`${step.saveAs}_list`, rows);
        break;
      }
      case "item_add": {
        const user = userOf(step.userId);
        if (!user) break;
        const quantity = await rt.economy.addItem(user, step.item, Math.max(1, await numberOf(step.quantity ?? 1, "The quantity")));
        if (step.saveAs) setVar(step.saveAs, quantity);
        break;
      }
      case "item_take": {
        const user = userOf(step.userId);
        if (!user) break;
        const left = await rt.economy.takeItem(user, step.item, Math.max(1, await numberOf(step.quantity ?? 1, "The quantity")));
        if (left === null) return short(step.else ? await text(step.else) : undefined, `You do not have enough ${step.item}.`);
        if (step.saveAs) setVar(step.saveAs, left);
        break;
      }
      case "item_random": {
        const user = userOf(step.userId);
        const picked = await rt.catalog.random({ kind: step.kind, rarity: step.rarity });
        if (!picked) {
          setVar(step.saveAs, "");
          break;
        }
        const have = user ? await rt.economy.addItem(user, picked.item, 1, picked.global) : 0;
        setVar(step.saveAs, picked.item);
        setVar(`${step.saveAs}_name`, picked.name);
        setVar(`${step.saveAs}_emoji`, picked.emoji ?? "");
        setVar(`${step.saveAs}_rarity`, picked.rarity);
        setVar(`${step.saveAs}_color`, picked.color ?? RARITY_COLOR[picked.rarity]);
        setVar(`${step.saveAs}_image`, picked.imageUrl ?? "");
        setVar(`${step.saveAs}_count`, have);
        break;
      }
      case "item_transfer": {
        const from = userOf(step.from);
        const to = userOf(step.to);
        if (!from || !to || from === to) break;
        const item = await rt.catalog.get(step.item);
        const global = item?.global ?? false;
        if (item && !item.tradeable) return short(step.else ? await text(step.else) : undefined, `${item.name} cannot be given away.`);
        const n = Math.max(1, await numberOf(step.quantity ?? 1, "The quantity"));
        if ((await rt.economy.takeItem(from, step.item, n, global)) === null) {
          return short(step.else ? await text(step.else) : undefined, rt.t("Not enough {item}.", { item: item?.name ?? step.item }));
        }
        await rt.economy.addItem(to, step.item, n, global);
        break;
      }
      case "item_use": {
        const user = userOf(step.userId);
        if (!user) break;
        await rt.itemUsed(step.item, user);
        break;
      }
      case "slowmode": {
        const channel = channelOf(step.channelId);
        if (channel) await rt.rest.editChannel(channel, { slowmode: await numberOf(step.seconds, "The slowmode") });
        break;
      }
      case "activity_get": {
        const user = userOf(step.userId);
        if (!user) break;
        const days = step.days === undefined ? null : step.days;
        const a = await rt.activity.of(user, days, step.metric ?? "messages");
        setVar(step.saveAs, step.metric === "voice" ? a.voiceMinutes : a.messages);
        setVar(`${step.saveAs}_rank`, a.rank);
        break;
      }
      case "activity_top": {
        const rows = await rt.activity.top(step.metric ?? "messages", step.days ?? 7, step.limit ?? 10);
        const line = step.line ?? "**{{rank}}.** <@{{user}}> — {{value|number}}";
        setVar(step.saveAs, clip(rows.map((r, n) => render(line, { ...scope, rank: n + 1, user: r.userId, value: r.value })).join("\n") || "Nobody yet.", 4000));
        setVar(`${step.saveAs}_list`, rows);
        setVar(`${step.saveAs}_first`, rows[0]?.userId ?? "");
        break;
      }
      case "item_get": {
        const user = userOf(step.userId);
        if (!user) break;
        const items = await rt.economy.items(user);
        setVar(step.saveAs, items.find((x) => x.item === step.item)?.quantity ?? 0);
        break;
      }
      case "list_join": {
        const user = userOf(step.userId);
        if (!user) break;
        const list = listName(step.list);
        const mode = step.mode ?? "join";
        let status: string;
        if (mode === "leave" || (mode === "toggle" && (await rt.lists.has(list, user)))) {
          status = (await rt.lists.leave(list, user)) ? "left" : "already";
        } else {
          status = (await rt.lists.join(list, user)) ? "joined" : "already";
        }
        if (step.saveAs) {
          setVar(step.saveAs, status);
          setVar(`${step.saveAs}_count`, await rt.lists.count(list));
        }
        break;
      }
      case "list_pick": {
        const ids = await rt.lists.pick(listName(step.list), step.count ?? 1, step.remove);
        setVar(step.saveAs, ids.map((id) => `<@${id}>`).join(", "));
        setVar(`${step.saveAs}_list`, ids);
        setVar(`${step.saveAs}_count`, ids.length);
        break;
      }
      case "list_count":
        setVar(step.saveAs, await rt.lists.count(listName(step.list)));
        break;
      case "list_clear":
        await rt.lists.clear(listName(step.list));
        break;
      case "kv_increment":
        scope[`kv.${keyOf(step.key)}`] = await rt.kv.incr(keyOf(step.key), step.by);
        break;
      case "kv_set": {
        const value = typeof step.value === "string" ? render(step.value, await filled(step.value)).slice(0, 500) : step.value;
        await rt.kv.set(keyOf(step.key), value);
        scope[`kv.${keyOf(step.key)}`] = value;
        break;
      }
      case "ai_reply": {
        const who = rt.user?.id ?? "guild";
        scope["ai.reply"] = (await cooledDown(rt.kv, `ai-last:${who}`, step.cooldownSeconds ?? 10, rt.now().getTime()))
          ? await askAgent(rt, step.agentId, await text(step.prompt), "step")
          : rt.t("Wait {n} s between questions.", { n: step.cooldownSeconds ?? 10 });
        break;
      }
      case "kon_call": {
        const s = await filled(step);
        const body = step.body === undefined ? undefined : renderJson(step.body, s);
        const result = await rt.kitsuden.call(step.method ?? "GET", renderPath(step.path, s), body);
        if (step.saveAs) (scope.call as Scope)[step.saveAs] = result.data;
        break;
      }
      case "emit_event":
        rt.emit(`${BLUEPRINT_EVENT_PREFIX}${step.name}`, {
          guildId: rt.guildId,
          moduleId: sc.moduleId,
          userId: rt.user?.id ?? null,
          data: step.data === undefined ? null : renderJson(step.data, scope),
        });
        break;
      case "post_panel": {
        const channel = channelOf(step.channelId);
        if (channel) await rt.panels.post(step.panel, channel);
        break;
      }
      case "refresh_panels":
        await rt.panels.refresh(step.panel);
        break;
    }
  }
  // A card drawn with no message after it is the answer itself.
  if (pending.length) reply = reply ? { ...reply, files: [...(reply.files ?? []), ...pending] } : { files: pending, ephemeral: false };
  return reply;
}

/** A failure a member may read: another kon's refusal said as that kon said it, or a step's own. */
export function publicReason(err: unknown): string | null {
  return err instanceof KonCallError || err instanceof StepError ? err.message : null;
}

// ── Blueprints as modules ───────────────────────────────────────────────────────────────────────

const OPTION_TYPE: Record<string, number> = { string: 3, integer: 4, boolean: 5, user: 6, channel: 7, role: 8, number: 10 };
const COMMAND_TYPE = { slash: 1, user: 2, message: 3 } as const;

/** The intents a blueprint needs, from its triggers. */
export function blueprintIntents(definition: BlueprintDefinition): number {
  let intents = 0;
  for (const t of definition.triggers) {
    if (t.on === "member_join" || t.on === "member_leave") intents |= INTENTS.GUILD_MEMBERS;
    if (t.on === "message") {
      intents |= INTENTS.GUILD_MESSAGES;
      if (t.match?.contains || t.match?.startsWith) intents |= INTENTS.MESSAGE_CONTENT;
    }
    if (t.on === "reaction_add" || t.on === "reaction_remove") intents |= INTENTS.GUILD_MESSAGE_REACTIONS;
    if (t.on === "voice_join" || t.on === "voice_leave") intents |= INTENTS.GUILD_VOICE_STATES;
  }
  return intents;
}

const TRIGGER_EVENT: Record<string, GatewayEventName> = {
  member_join: "GUILD_MEMBER_ADD",
  member_leave: "GUILD_MEMBER_REMOVE",
  message: "MESSAGE_CREATE",
  reaction_add: "MESSAGE_REACTION_ADD",
  reaction_remove: "MESSAGE_REACTION_REMOVE",
  voice_join: "VOICE_STATE_UPDATE",
  voice_leave: "VOICE_STATE_UPDATE",
};

export function blueprintModuleId(blueprintId: string): string {
  return `blueprint-${blueprintId}`;
}

function optionPayload(o: BlueprintCommandOption): SlashCommandOptionPayload {
  return {
    name: o.name,
    description: o.description,
    type: OPTION_TYPE[o.type],
    ...(o.required ? { required: true } : {}),
    ...(o.choices ? { choices: o.choices } : {}),
    ...(o.autocomplete ? { autocomplete: true } : {}),
    ...(o.min !== undefined ? { min_value: o.min } : {}),
    ...(o.max !== undefined ? { max_value: o.max } : {}),
    ...(o.minLength !== undefined ? { min_length: o.minLength } : {}),
    ...(o.maxLength !== undefined ? { max_length: o.maxLength } : {}),
  };
}

function commandPayload(c: BlueprintCommand): SlashCommandPayload {
  const type = COMMAND_TYPE[c.type ?? "slash"];
  const perms = c.defaultPermissions ? { default_member_permissions: permissionBits(c.defaultPermissions) } : {};
  // Context menus have no description and no options.
  if (type !== 1) return { name: c.name, description: "", type, ...perms };
  if (c.subcommands) {
    return {
      name: c.name,
      description: c.description ?? c.name,
      type: 1,
      ...perms,
      options: c.subcommands.map((s) => ({
        name: s.name,
        description: s.description,
        type: 1,
        options: s.options?.map(optionPayload),
      })),
    };
  }
  return { name: c.name, description: c.description ?? c.name, type: 1, ...perms, options: c.options?.map(optionPayload) };
}

/** `{{target.*}}`: the member or message a context menu was used on. */
function targetVars(target: CommandInvocation["target"]): Scope {
  if (!target) return {};
  return {
    "target.id": target.id,
    "target.mention": `<@${target.authorId ?? target.id}>`,
    "target.name": target.name ?? "",
    "target.content": target.content ?? "",
    "target.author.id": target.authorId ?? "",
    "target.author.mention": target.authorId ? `<@${target.authorId}>` : "",
  };
}

/** Does this data mention a placeholder that needs a read (`{{kv.*}}`, `{{data.*}}`)? */
const needsRead = (value: unknown) => /\{\{\s*(kv|data)\./.test(JSON.stringify(value ?? ""));

/** Reads a panel's or a modal's data sources (GET, with the bot's key); a failed one is `null`. */
async function readSources(sources: Record<string, string> | undefined, scope: Scope, rt: ModuleRuntime, moduleId: string, what: string) {
  const data: Scope = {};
  if (!sources) return data;
  // A source may name this blueprint's state: `/broadcast/matches/{{kv.set}}`.
  const pathScope = await withKv(sources, scope, rt.kv);
  for (const [name, path] of Object.entries(sources)) {
    try {
      data[name] = (await rt.kitsuden.call("GET", renderPath(path, pathScope))).data;
    } catch (err) {
      rt.logger.warn("Discord: a data source failed", { moduleId, what, source: name, message: messageOf(err) });
      data[name] = null;
    }
  }
  return data;
}

/** A published blueprint as a module. Its settings are the blueprint itself: `config` is empty. */
export function blueprintModule(row: { id: string; name: string; description: string | null; definition: BlueprintDefinition }): DcModule {
  const def = row.definition;
  const moduleId = blueprintModuleId(row.id);
  const sc: StepContext = { moduleId, modals: def.modals };
  const components = allComponents(def).filter((c): c is ActiveComponent => c.type !== "link");

  const commandOf = (name: string, type: number | undefined) =>
    def.commands.find((c) => c.name === name && COMMAND_TYPE[c.type ?? "slash"] === (type ?? 1));

  const commandStepsOf = (name: string, sub: string | null, type?: number) => {
    const command = commandOf(name, type);
    if (!command) return null;
    const steps = sub ? command.subcommands?.find((s) => s.name === sub)?.steps : command.steps;
    return steps ? { command, steps } : null;
  };

  type PlanRt = Parameters<NonNullable<DcModule["plan"]>>[2];

  /**
   * The answer decided before running. Leading `open_modal` steps open the first modal whose `if`
   * holds (and that the member may use); when a condition or the modal needs a read (`{{kv.*}}`,
   * `data` sources), the engine waits briefly for `modalAsync`. Otherwise the rest of the steps run.
   */
  const planFor = (
    steps: BlueprintStep[] | AnyStep[],
    access: Access | undefined,
    scope: Scope,
    rt: PlanRt,
    full: (() => ModuleRuntime) | undefined
  ): InteractionPlan => {
    if (!allowed(access, rt.memberRoles, rt.memberPermissions)) return { deny: denial(access!) };
    const list = steps as BlueprintStep[];
    const leading: Extract<BlueprintStep, { do: "open_modal" }>[] = [];
    for (const s of list) {
      if (s.do !== "open_modal") break;
      leading.push(s);
    }
    const rest = list.slice(leading.length);
    const restPlan: InteractionPlan = {
      update: rest.some((s) => s.do === "update_message"),
      reply: rest.some((s) => s.do === "reply"),
      ephemeral: rest.some((s) => s.do === "reply" && s.ephemeral),
    };
    if (!leading.length) return restPlan;

    const candidates = leading.flatMap((step) => {
      const modal = def.modals.find((m) => m.id === step.modal);
      return modal ? [{ step, modal }] : [];
    });
    const usable = candidates.filter((c) => allowed(c.modal.access, rt.memberRoles, rt.memberPermissions));
    if (!usable.length) return candidates.length && !rest.length ? { deny: denial(candidates[0].modal.access!) } : restPlan;

    if (!usable.some((c) => needsRead(c.step.if) || needsRead(c.modal.inputs) || c.modal.data)) {
      const hit = usable.find((c) => holds(c.step.if, scope));
      return hit ? { modal: renderModal(hit.modal, moduleId, scope) } : restPlan;
    }
    if (!full) return restPlan;
    return {
      ...restPlan,
      modalAsync: async () => {
        const runtime = full();
        for (const c of usable) {
          if (c.step.if && !holds(c.step.if, await withKv(c.step.if, scope, runtime.kv))) continue;
          const data = await readSources(c.modal.data, scope, runtime, moduleId, `modal ${c.modal.id}`);
          const s = await withKv(c.modal.inputs, { ...scope, data }, runtime.kv);
          return renderModal(c.modal, moduleId, s);
        }
        return null;
      },
    };
  };

  const konTriggers = def.triggers.filter((t) => t.on === "kon_event");
  const refreshOn: Record<string, string[]> = {};
  for (const p of def.panels) if (p.refreshOn?.length) refreshOn[p.id] = p.refreshOn;
  const scheduled = def.triggers.flatMap((t, i) => (t.on === "schedule" && t.schedule ? [{ key: `trigger-${i}`, schedule: t.schedule }] : []));

  const componentVars = (values: string[]) => ({ value: values[0] ?? "", values: values.join(", "), values_list: [...values] });

  return {
    id: moduleId,
    name: row.name,
    description: row.description ?? "Blueprint",
    config: z.object({}).strict(),
    intents: blueprintIntents(def),
    events: [...new Set(def.triggers.flatMap((t) => (TRIGGER_EVENT[t.on] ? [TRIGGER_EVENT[t.on]] : [])))],
    konEvents: () => [...new Set(konTriggers.map((t) => t.event!))],
    panelIds: def.panels.map((p) => p.id),
    panelRefreshOn: () => refreshOn,
    commands: () => def.commands.map(commandPayload),
    schedules: () => scheduled,

    plan(target, _config, rt, full) {
      if (target.kind === "command") {
        const found = commandStepsOf(target.name, target.subcommand, target.type);
        if (!found) return {};
        const scope = { ...baseVars(rt, target.options), ...targetVars(target.target), subcommand: target.subcommand ?? "" };
        return planFor(found.steps, found.command.access, scope, rt, full);
      }
      if (target.kind === "component") {
        const c = components.find((x) => x.id === target.id);
        if (!c) return {};
        return planFor(c.steps, c.access, { ...baseVars(rt), ...componentVars(target.values) }, rt, full);
      }
      const modal = def.modals.find((m) => m.id === target.id);
      if (!modal) return {};
      if (!allowed(modal.access, rt.memberRoles, rt.memberPermissions)) return { deny: denial(modal.access!) };
      return {
        update: modal.steps.some((s) => s.do === "update_message"),
        reply: modal.steps.some((s) => s.do === "reply"),
        ephemeral: modal.steps.some((s) => s.do === "reply" && s.ephemeral),
      };
    },

    async onCommand(invocation, _config, rt) {
      const found = commandStepsOf(invocation.name, invocation.subcommand, invocation.type);
      if (!found) return null;
      if (!allowed(found.command.access, rt.memberRoles, rt.memberPermissions)) return { content: denial(found.command.access!), ephemeral: true };
      const vars = { ...baseVars(rt, invocation.options), ...targetVars(invocation.target), subcommand: invocation.subcommand ?? "" };
      return runSteps(found.steps, rt, vars, sc);
    },

    async onComponent(use, _config, rt) {
      const c = components.find((x) => x.id === use.id);
      if (!c) return null;
      if (!allowed(c.access, rt.memberRoles, rt.memberPermissions)) return { content: denial(c.access!), ephemeral: true };
      if (use.values.includes("-") && c.type === "select" && c.optionsFrom) return null;
      return runSteps(c.steps, rt, { ...baseVars(rt), ...componentVars(use.values) }, sc);
    },

    async onModal(submit, _config, rt) {
      const modal = def.modals.find((m) => m.id === submit.id);
      if (!modal) return null;
      if (!allowed(modal.access, rt.memberRoles, rt.memberPermissions)) return { content: denial(modal.access!), ephemeral: true };
      return runSteps(modal.steps, rt, { ...baseVars(rt), input: { ...submit.fields } }, sc);
    },

    async onAutocomplete(request, _config, rt) {
      const command = commandOf(request.command, 1);
      const options = request.subcommand ? command?.subcommands?.find((s) => s.name === request.subcommand)?.options : command?.options;
      const option = options?.find((o) => o.name === request.option);
      const source = option?.autocomplete;
      if (!source) return [];
      const typed = request.focused.toLowerCase();
      if ("choices" in source) {
        return source.choices.filter((c) => c.name.toLowerCase().includes(typed)).slice(0, 25);
      }
      const scope = { ...baseVars(rt, request.options), focused: request.focused };
      const list = await listFrom(source, scope, rt);
      const asNumber = option.type === "integer" || option.type === "number";
      return list
        .filter((o) => !typed || o.label.toLowerCase().includes(typed) || o.value.toLowerCase().includes(typed))
        .map((o) => ({ name: o.label, value: asNumber ? Number(o.value) : o.value }))
        .filter((o) => typeof o.value === "string" || Number.isFinite(o.value));
    },

    async onEvent(event, _config, rt) {
      if (event.isBot) return;
      for (const trigger of def.triggers) {
        if (TRIGGER_EVENT[trigger.on] !== event.type) continue;
        const m = trigger.match;
        if (m?.channelId && m.channelId !== event.channelId) continue;
        if (m?.emoji && m.emoji !== event.emoji) continue;
        const content = (event.content ?? "").toLowerCase();
        if (m?.contains && !content.includes(m.contains.toLowerCase())) continue;
        if (m?.startsWith && !content.startsWith(m.startsWith.toLowerCase())) continue;
        if (trigger.on === "voice_join" || trigger.on === "voice_leave") {
          const v = event.voice;
          if (!v) continue;
          const channel = trigger.on === "voice_join" ? v.to : v.from;
          if (!channel || v.from === v.to) continue;
          if (m?.channelId && m.channelId !== channel) continue;
        }
        const voice = event.voice ? { "voice.channel": (trigger.on === "voice_leave" ? event.voice.from : event.voice.to) ?? "", "voice.minutes": event.voice.minutes } : {};
        const scope = { ...baseVars(rt), emoji: event.emoji ?? "", ...voice };
        if (!holds(trigger.where, await withKv(trigger.where, scope, rt.kv))) continue;
        await runSteps(trigger.steps, rt, scope, sc);
      }
    },

    async onItemUsed(item, userId, _config, rt) {
      for (const trigger of def.triggers) {
        if (trigger.on !== "item_used" || (trigger.match?.item && trigger.match.item !== item)) continue;
        const scope = { ...baseVars({ ...rt, user: { id: userId, name: userId } }), item };
        if (!holds(trigger.where, await withKv(trigger.where, scope, rt.kv))) continue;
        await runSteps(trigger.steps, { ...rt, user: rt.user?.id === userId ? rt.user : { id: userId, name: userId } }, scope, sc);
      }
    },

    async onKonEvent(name, data, _config, rt) {
      for (const trigger of konTriggers) {
        if (trigger.event !== name) continue;
        const scope = { ...baseVars(rt), event: data };
        if (!holds(trigger.where, await withKv(trigger.where, scope, rt.kv))) continue;
        await runSteps(trigger.steps, rt, scope, sc);
      }
    },

    async onSchedule(key, payload, _config, rt) {
      if (key.startsWith("trigger-")) {
        const trigger = def.triggers[Number(key.slice("trigger-".length))];
        if (trigger?.on !== "schedule") return;
        const scope = baseVars(rt);
        if (!holds(trigger.where, await withKv(trigger.where, scope, rt.kv))) return;
        await runSteps(trigger.steps, rt, scope, sc);
        return;
      }
      if (payload.kind !== "later") return;
      // The steps were checked when the blueprint was saved; the row could have been edited since.
      const steps = Steps.safeParse(payload.steps);
      if (!steps.success) {
        rt.logger.warn("Discord: a scheduled `later` no longer validates; skipped", { moduleId });
        return;
      }
      const vars = (payload.vars && typeof payload.vars === "object" ? payload.vars : {}) as Scope;
      const now = rt.now();
      await runSteps(steps.data, rt, { ...vars, now: now.toISOString(), "now.unix": Math.floor(now.getTime() / 1000) }, sc);
    },

    async renderPanel(panelId, _config, rt) {
      const panel = def.panels.find((p) => p.id === panelId);
      if (!panel) return null;
      const data = await readSources(panel.data, baseVars(rt), rt, moduleId, `panel ${panelId}`);
      return renderMessage(panel, moduleId, { ...baseVars(rt), data }, rt);
    },
  };
}

// ── AI through the core's agents (BYOK) ─────────────────────────────────────────────────────────

/**
 * Anyone in a Discord server can type to the bot, so the agent runs with NO tools (`allowedTools: []`):
 * like a public kon-chat bot, it answers from its prompt and model only. The model and the key are the
 * agent's: an Anthropic, OpenAI or Gemini key of the owner, or a local Ollama.
 */
export async function askAgent(
  rt: Pick<ModuleRuntime, "agents" | "logger"> & Partial<Pick<ModuleRuntime, "guildId" | "user">>,
  agentId: string,
  message: string,
  purpose: AiPurpose = "ask",
  moduleId?: string
): Promise<string> {
  try {
    // An extension may answer with a server's own key or credits, or refuse; else the core's agents.
    const answer = await runAi(
      { guildId: rt.guildId ?? null, userId: rt.user?.id ?? null, purpose, moduleId, agentId },
      rt.agents as AiRunner | null | undefined,
      { message, allowedTools: [], context: "You are answering inside a Discord server. Answer in under 1800 characters, in plain text." }
    );
    if ("refused" in answer) return answer.refused;
    return clip(answer.text || "…", 1900);
  } catch (err) {
    rt.logger.warn("Discord AI answer failed", { agentId, message: messageOf(err) });
    return "I could not answer that right now.";
  }
}

// ── Built-in modules ────────────────────────────────────────────────────────────────────────────

export const welcomeModule = defineDcModule({
  id: "welcome",
  name: "Welcome",
  description: "Greets who joins (in a channel and, if you like, by DM) and says goodbye to who leaves.",
  config: z
    .object({
      channelId: Snowflake.meta({ title: "Channel id", description: "Where the welcome message goes" }),
      message: z
        .string()
        .min(1)
        .max(2000)
        .default("Welcome to the server, {{user.mention}}!")
        .meta({ title: "Message", description: "{{user.mention}} and {{user.name}} are filled in" }),
      dmMessage: z.string().min(1).max(2000).optional().meta({ title: "DM to the newcomer", description: "Rules, links, a first step; empty = none" }),
      leaveChannelId: Snowflake.optional().meta({ title: "Goodbye channel id", description: "Empty = no goodbye message" }),
      leaveMessage: z.string().min(1).max(2000).default("{{user.name}} left the server.").meta({ title: "Goodbye message" }),
    })
    .strict(),
  intents: INTENTS.GUILD_MEMBERS,
  events: ["GUILD_MEMBER_ADD", "GUILD_MEMBER_REMOVE"],
  async onEvent(event, config, rt) {
    if (event.isBot) return;
    if (event.type === "GUILD_MEMBER_REMOVE") {
      if (config.leaveChannelId) await rt.rest.sendMessage(config.leaveChannelId, clip(render(config.leaveMessage, baseVars(rt))));
      return;
    }
    if (event.type !== "GUILD_MEMBER_ADD") return;
    await rt.rest.sendMessage(config.channelId, clip(render(config.message, baseVars(rt))));
    if (config.dmMessage && rt.user) {
      try {
        await rt.rest.sendMessage(await rt.rest.openDm(rt.user.id), clip(render(config.dmMessage, baseVars(rt))));
      } catch {
        /* closed DMs */
      }
    }
  },
});

export const autoroleModule = defineDcModule({
  id: "autorole",
  name: "Auto role",
  description: "Gives roles to everyone who joins. The bot's own role must be above them.",
  config: z
    .object({ roleIds: z.array(Snowflake).min(1).max(5).meta({ title: "Role ids", description: "Up to 5; paste or type each id" }) })
    .strict(),
  intents: INTENTS.GUILD_MEMBERS,
  events: ["GUILD_MEMBER_ADD"],
  async onEvent(event, config, rt) {
    if (event.type !== "GUILD_MEMBER_ADD" || !rt.user || event.isBot) return;
    for (const roleId of config.roleIds) await rt.rest.addRole(rt.guildId, rt.user.id, roleId);
  },
});

export const aiModule = defineDcModule({
  id: "ai",
  name: "AI answers",
  description: "A slash command that asks one of the core's agents (your own key or Ollama). Never with tools.",
  config: z
    .object({
      agentId: z.string().min(1).max(100).meta({ title: "Agent", description: "The core agent identity that answers (its model and key)" }),
      commandName: z.string().regex(/^[a-z0-9_-]{1,32}$/).default("ask").meta({ title: "Command name" }),
      cooldownSeconds: z.number().int().min(0).max(3600).default(10).meta({ title: "Cooldown per member (seconds)" }),
      ephemeral: z.boolean().default(false).meta({ title: "Only the asker sees the answer" }),
    })
    .strict(),
  intents: 0,
  events: [],
  commands: (config) => [
    {
      name: config.commandName,
      description: "Ask the server's AI",
      type: 1,
      options: [{ name: "question", description: "Your question", type: 3, required: true }],
    },
  ],
  plan: (_target, config) => ({ ephemeral: config.ephemeral }),
  async onCommand(invocation, config, rt) {
    if (invocation.name !== config.commandName || !rt.user) return null;
    if (!(await cooledDown(rt.kv, `last:${rt.user.id}`, config.cooldownSeconds))) {
      return { content: rt.t("Wait {n} s between questions.", { n: config.cooldownSeconds }), ephemeral: true };
    }
    const question = String(invocation.options.question ?? "").slice(0, 1500);
    if (!question.trim()) return { content: "Ask something.", ephemeral: true };
    return { content: await askAgent(rt, config.agentId, question, "ask", "ai"), ephemeral: config.ephemeral };
  },
});

/**
 * Other kons, said in Discord without writing a blueprint: "when <kon event> happens, post <message>
 * in <channel>". `{{event.*}}` is the event's payload (`blog:post:published` → `{{event.title}}`).
 */
export const announcementsModule = defineDcModule({
  id: "announcements",
  name: "Kon announcements",
  description: "Posts in a channel when another kon emits an event (a post published, an order paid, a set updated…).",
  config: z
    .object({
      rules: z
        .array(
          z
            .object({
              event: z
                .string()
                .regex(/^[a-z0-9][a-z0-9-]{0,63}:[a-z0-9:._-]{1,200}$/)
                .meta({ title: "Event", description: "<kon>:<event>, e.g. blog:post:published" }),
              channelId: Snowflake.meta({ title: "Channel id" }),
              message: z.string().min(1).max(2000).meta({ title: "Message", description: "{{event.<field>}} is filled in" }),
            })
            .strict()
        )
        .min(1)
        .max(20)
        .refine((rules) => rules.every((r) => !r.event.startsWith("dc:")), { message: "Not the bot's own events (it would loop)" })
        .meta({ title: "Rules", description: "When an event happens, post a message in a channel" }),
    })
    .strict(),
  intents: 0,
  events: [],
  konEvents: (config) => [...new Set(config.rules.map((r) => r.event))],
  async onKonEvent(name, data, config, rt) {
    for (const rule of config.rules) {
      if (rule.event !== name) continue;
      await rt.rest.sendMessage(rule.channelId, clip(render(rule.message, { ...baseVars(rt), event: data })));
    }
  },
});

for (const m of [welcomeModule, autoroleModule, aiModule, announcementsModule]) registerDcModule(m as DcModule);

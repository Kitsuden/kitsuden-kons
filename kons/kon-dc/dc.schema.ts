/**
 * Discord — Drizzle schema
 * ============================================================================
 *
 * Only to TYPE the queries. The tables are created by `migrations/0000_initial.sql`
 * (kon.json: `schema.strategy = "sql"`), so this file and the migrations change together.
 *
 * These tables are exported from the kon's entry (`import { dcBlueprints } from
 * "@kitsuden/kon-dc"`): another kon or an app can join them in its own queries with the same
 * types, instead of declaring them again.
 *
 *   dc_guilds         — the servers the bot is in (from the gateway, or registered by hand)
 *   dc_blueprints     — declarative bot behaviour: slash commands and triggers made of steps
 *   dc_guild_modules  — which module is on in which server, and its settings
 *   dc_kv             — small per-server state the modules keep (XP, counters, cooldowns)
 *   dc_panels         — live panels: messages the bot keeps up to date
 *   dc_wallets        — balances per member and currency (coins, XP…), shared by every module
 *   dc_inventory      — items per member
 *   dc_list_members   — lists of members (giveaway entries, raffles, queues)
 *   dc_schedules      — work for later and recurring schedules
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import type { BlueprintDefinition } from "./dc.contract";

export const BLUEPRINT_STATUSES = ["draft", "published"] as const;
export type BlueprintStatus = (typeof BLUEPRINT_STATUSES)[number];

export const dcGuilds = pgTable("dc_guilds", {
  /** Discord snowflake. */
  id: varchar("id", { length: 20 }).primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  /** Discord's preferred locale of the server (es-ES, pt-BR…): the language of what the bot says by itself. */
  locale: varchar("locale", { length: 10 }),
  /** Set when the bot leaves the server or is removed; the row and its settings stay. */
  leftAt: timestamp("left_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dcBlueprints = pgTable("dc_blueprints", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  /** Validated by `BlueprintDefinition` (dc.contract.ts) on every write. */
  definition: jsonb("definition").$type<BlueprintDefinition>().notNull(),
  status: varchar("status", { length: 20 }).$type<BlueprintStatus>().notNull().default("draft"),
  /** Bumped on every change of `definition`: the export carries it. */
  revision: integer("revision").notNull().default(1),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dcGuildModules = pgTable(
  "dc_guild_modules",
  {
    guildId: varchar("guild_id", { length: 20 })
      .notNull()
      .references(() => dcGuilds.id, { onDelete: "cascade" }),
    /** A built-in module (`welcome`, `leveling`…) or `blueprint-<uuid>`. */
    moduleId: varchar("module_id", { length: 60 }).notNull(),
    enabled: boolean("enabled").notNull().default(false),
    /** Validated by the module's own zod schema on every write. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.moduleId] })]
);

export const dcKv = pgTable(
  "dc_kv",
  {
    guildId: varchar("guild_id", { length: 20 })
      .notNull()
      .references(() => dcGuilds.id, { onDelete: "cascade" }),
    /** The module that owns the key: modules never read each other's state. */
    namespace: varchar("namespace", { length: 60 }).notNull(),
    key: varchar("key", { length: 120 }).notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.namespace, t.key] })]
);

/** Live panels: messages the bot posted and keeps redrawing (a scoreboard, a queue, a menu). */
export const dcPanels = pgTable("dc_panels", {
  /** Discord's message id. */
  messageId: varchar("message_id", { length: 20 }).primaryKey(),
  guildId: varchar("guild_id", { length: 20 })
    .notNull()
    .references(() => dcGuilds.id, { onDelete: "cascade" }),
  channelId: varchar("channel_id", { length: 20 }).notNull(),
  moduleId: varchar("module_id", { length: 60 }).notNull(),
  panelId: varchar("panel_id", { length: 32 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Last redraw that Discord accepted. */
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
});

/** Balances per member and currency (`coins`, `xp`, any other): shared by every module of a server. */
export const dcWallets = pgTable(
  "dc_wallets",
  {
    guildId: varchar("guild_id", { length: 20 })
      .notNull()
      .references(() => dcGuilds.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 20 }).notNull(),
    currency: varchar("currency", { length: 32 }).notNull(),
    balance: bigint("balance", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.currency, t.userId] })]
);

/** Items per member (shop purchases, loot, badges). */
export const dcInventory = pgTable(
  "dc_inventory",
  {
    guildId: varchar("guild_id", { length: 20 })
      .notNull()
      .references(() => dcGuilds.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 20 }).notNull(),
    item: varchar("item", { length: 64 }).notNull(),
    quantity: integer("quantity").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.userId, t.item] })]
);

/** Lists of members (giveaway entries, raffles, queues), namespaced by module. */
export const dcListMembers = pgTable(
  "dc_list_members",
  {
    guildId: varchar("guild_id", { length: 20 })
      .notNull()
      .references(() => dcGuilds.id, { onDelete: "cascade" }),
    namespace: varchar("namespace", { length: 60 }).notNull(),
    list: varchar("list", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 20 }).notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.namespace, t.list, t.userId] })]
);

/** Work for later: one-off (`spec` null) or recurring (`spec` says when it runs next). */
export const dcSchedules = pgTable(
  "dc_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    guildId: varchar("guild_id", { length: 20 })
      .notNull()
      .references(() => dcGuilds.id, { onDelete: "cascade" }),
    moduleId: varchar("module_id", { length: 60 }).notNull(),
    key: varchar("key", { length: 120 }).notNull(),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    spec: jsonb("spec").$type<Record<string, unknown> | null>(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.guildId, t.moduleId, t.key)]
);

/** What follows a member across every server of this bot. */
export const dcProfiles = pgTable("dc_profiles", {
  userId: varchar("user_id", { length: 20 }).primaryKey(),
  name: varchar("name", { length: 100 }),
  avatar: varchar("avatar", { length: 64 }),
  bio: varchar("bio", { length: 300 }),
  accent: varchar("accent", { length: 7 }),
  rep: integer("rep").notNull().default(0),
  repGivenAt: timestamp("rep_given_at", { withTimezone: true }),
  badges: jsonb("badges").$type<string[]>().notNull().default([]),
  background: varchar("background", { length: 64 }),
  dailyDay: integer("daily_day"),
  dailyStreak: integer("daily_streak").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Global balances (credits, global XP): one per member and currency, for the whole bot. */
export const dcGlobalWallets = pgTable(
  "dc_global_wallets",
  {
    userId: varchar("user_id", { length: 20 }).notNull(),
    currency: varchar("currency", { length: 32 }).notNull(),
    balance: bigint("balance", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.currency, t.userId] })]
);

export const ITEM_RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;
export type ItemRarity = (typeof ITEM_RARITIES)[number];
export const ITEM_KINDS = ["item", "consumable", "role", "badge", "background", "pet"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** The catalog: what items are. `guildId` null = a global item (every server shows it). */
export const dcItems = pgTable("dc_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  guildId: varchar("guild_id", { length: 20 }).references(() => dcGuilds.id, { onDelete: "cascade" }),
  item: varchar("item", { length: 64 }).notNull(),
  name: varchar("name", { length: 80 }).notNull(),
  description: varchar("description", { length: 300 }),
  emoji: varchar("emoji", { length: 64 }),
  rarity: varchar("rarity", { length: 12 }).$type<ItemRarity>().notNull().default("common"),
  kind: varchar("kind", { length: 12 }).$type<ItemKind>().notNull().default("item"),
  imageUrl: varchar("image_url", { length: 500 }),
  color: varchar("color", { length: 7 }),
  price: bigint("price", { mode: "number" }),
  currency: varchar("currency", { length: 32 }).notNull().default("coins"),
  sellPrice: bigint("sell_price", { mode: "number" }),
  tradeable: boolean("tradeable").notNull().default(true),
  stock: integer("stock"),
  sold: integer("sold").notNull().default(0),
  roleId: varchar("role_id", { length: 20 }),
  dropWeight: integer("drop_weight").notNull().default(1),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Global items members own (badges, backgrounds): the same in every server. */
export const dcGlobalInventory = pgTable(
  "dc_global_inventory",
  {
    userId: varchar("user_id", { length: 20 }).notNull(),
    item: varchar("item", { length: 64 }).notNull(),
    quantity: integer("quantity").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.item] })]
);

/** Who is in which voice channel, and since when (voice XP, temporary channels). */
export const dcVoiceSessions = pgTable(
  "dc_voice_sessions",
  {
    guildId: varchar("guild_id", { length: 20 })
      .notNull()
      .references(() => dcGuilds.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 20 }).notNull(),
    channelId: varchar("channel_id", { length: 20 }).notNull(),
    muted: boolean("muted").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    creditedAt: timestamp("credited_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.userId] })]
);

/** Messages and voice minutes per member and day (days since 1970, UTC). */
export const dcActivity = pgTable(
  "dc_activity",
  {
    guildId: varchar("guild_id", { length: 20 })
      .notNull()
      .references(() => dcGuilds.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 20 }).notNull(),
    day: integer("day").notNull(),
    messages: integer("messages").notNull().default(0),
    voiceMinutes: integer("voice_minutes").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.userId, t.day] })]
);

/** Characters members speak through (a webhook reposts their message with this name and avatar). */
export const dcCharacters = pgTable(
  "dc_characters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: varchar("user_id", { length: 20 }).notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    prefix: varchar("prefix", { length: 20 }).notNull().default(""),
    suffix: varchar("suffix", { length: 20 }).notNull().default(""),
    avatarUrl: varchar("avatar_url", { length: 500 }),
    messages: integer("messages").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.userId, t.name)]
);

/** Recent message text for logs (opt-in, expires). */
export const dcMessageCache = pgTable("dc_message_cache", {
  messageId: varchar("message_id", { length: 20 }).primaryKey(),
  guildId: varchar("guild_id", { length: 20 })
    .notNull()
    .references(() => dcGuilds.id, { onDelete: "cascade" }),
  channelId: varchar("channel_id", { length: 20 }).notNull(),
  authorId: varchar("author_id", { length: 20 }).notNull(),
  content: varchar("content", { length: 4000 }).notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** A server's plan: premium unlocks the installation's premium modules. */
export const dcGuildPlans = pgTable("dc_guild_plans", {
  guildId: varchar("guild_id", { length: 20 })
    .primaryKey()
    .references(() => dcGuilds.id, { onDelete: "cascade" }),
  plan: varchar("plan", { length: 20 }).$type<"free" | "premium">().notNull().default("free"),
  until: timestamp("until", { withTimezone: true }),
  source: varchar("source", { length: 100 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DcItem = InferSelectModel<typeof dcItems>;
export type DcProfile = InferSelectModel<typeof dcProfiles>;
export type DcSchedule = InferSelectModel<typeof dcSchedules>;
export type DcPanel = InferSelectModel<typeof dcPanels>;
export type DcGuild = InferSelectModel<typeof dcGuilds>;
export type NewDcGuild = InferInsertModel<typeof dcGuilds>;
export type DcBlueprint = InferSelectModel<typeof dcBlueprints>;
export type NewDcBlueprint = InferInsertModel<typeof dcBlueprints>;
export type DcGuildModule = InferSelectModel<typeof dcGuildModules>;
export type DcKvEntry = InferSelectModel<typeof dcKv>;

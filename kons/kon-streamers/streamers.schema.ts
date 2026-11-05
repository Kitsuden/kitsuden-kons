/**
 * Kitsuden CMS — Streamers Module Schema
 *
 * Drizzle ORM schema for streamers and game associations.
 */

import { relations } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";
// Note: currentGameId references games.id from kon-games.
// We avoid cross-kon imports; FK is enforced at application level.

// ═══════════════════════════════════════════════
// Enums
// ═══════════════════════════════════════════════

export const streamerPlatformEnum = pgEnum("streamers_platform", ["twitch", "youtube", "kick"]);

// ═══════════════════════════════════════════════
// Streamers Table
// ═══════════════════════════════════════════════

export const streamers = pgTable(
  "streamers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: varchar("display_name", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 200 }).notNull(),
    platform: streamerPlatformEnum("platform").notNull(),
    channelId: varchar("channel_id", { length: 200 }).notNull(),
    channelUrl: text("channel_url"),
    bio: text("bio"),
    isLive: boolean("is_live").default(false),
    currentStreamTitle: text("current_stream_title"),
    currentGameId: uuid("current_game_id"), // References games.id from kon-games (app-level FK)
    viewerCount: integer("viewer_count").default(0),
    followerCount: integer("follower_count").default(0),
    avatarId: uuid("avatar_id"), // References media.id
    thumbnailId: uuid("thumbnail_id"), // References media.id
    socialLinks: text("social_links"), // JSON string
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("streamers_slug_idx").on(t.slug),
    uniqueIndex("streamers_channel_idx").on(t.platform, t.channelId),
    index("streamers_platform_idx").on(t.platform),
    index("streamers_live_idx").on(t.isLive),
  ]
);

// ═══════════════════════════════════════════════
// Junction Table: Streamers ↔ Games
// ═══════════════════════════════════════════════

export const gamesToStreamers = pgTable(
  "games_to_streamers",
  {
    gameId: uuid("game_id")
      // .references(() => games.id) removed to avoid cross-kon import
      .notNull(),
    streamerId: uuid("streamer_id")
      .references(() => streamers.id, { onDelete: "cascade" })
      .notNull(),
    isPrimary: boolean("is_primary").default(false), // Main game for this streamer
  },
  (t) => [uniqueIndex("gs_unique").on(t.gameId, t.streamerId)]
);

// ═══════════════════════════════════════════════
// Relations
// ═══════════════════════════════════════════════

export const streamersRelations = relations(streamers, ({ many }) => ({
  // currentGame relation removed to avoid cross-kon import
  // Resolve via application-level join using currentGameId
  games: many(gamesToStreamers),
}));

export const gamesToStreamersRelations = relations(gamesToStreamers, ({ one }) => ({
  // game: one(games) relation removed to avoid cross-kon import
  streamer: one(streamers, { fields: [gamesToStreamers.streamerId], references: [streamers.id] }),
}));

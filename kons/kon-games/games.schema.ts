/**
 * Kitsuden CMS — Games Module Schema
 *
 * Drizzle ORM schema for games, collections, and junction tables.
 * This schema is dynamically merged by schema-merger.ts when Kitsuden CMS is active.
 *
 * Media: ids in the core media library (/api/media) for cover art, screenshots, platform icons
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
  date,
  real,
  jsonb,
  uniqueIndex,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";

// ─── Block Type ─────────────────────────────────
import type { BlockEditorial } from "./games.editorial";

interface PageBlock {
  id: string;
  type: string;
  /** From the loader: regenerated on every reload. Edits NEVER go here. */
  data: Record<string, unknown>;
  order: number;
  /** What is edited by hand (Inti, agents): survives reloads. See `games.editorial.ts`. */
  editorial?: BlockEditorial;
}

// ─── Focal Point Type ───────────────────────────
export interface FocalPoint {
  x: number; // 0-100 (percentage from left)
  y: number; // 0-100 (percentage from top)
}

// ═══════════════════════════════════════════════
// Enums
// ═══════════════════════════════════════════════

export const contentStatusEnum = pgEnum("games_content_status", ["draft", "published", "archived"]);

export const tagCategoryEnum = pgEnum("games_tag_category", [
  "genre",
  "feature",
  "topic",
  "series",
]);

// ═══════════════════════════════════════════════
// Reference to Core Tables (imported at runtime)
// ═══════════════════════════════════════════════

// Note: These reference the core schema's media table
// The actual FK is created via the uuid reference

// ═══════════════════════════════════════════════
// Games Table
// ═══════════════════════════════════════════════

export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar("title", { length: 500 }).notNull(),
    slug: varchar("slug", { length: 500 }).notNull(),
    subtitle: varchar("subtitle", { length: 500 }),
    description: jsonb("description"), // Lexical rich text JSON
    excerpt: text("excerpt"),
    releaseDate: date("release_date"),
    status: contentStatusEnum("status").default("draft").notNull(),
    developer: varchar("developer", { length: 200 }),
    publisher: varchar("publisher", { length: 200 }),
    metacriticScore: integer("metacritic_score"),
    userRating: real("user_rating"),

    // Media fields (ids in the core media library, /api/media)
    coverArtId: uuid("cover_art_id"), // References media.id
    coverFocalPoint: jsonb("cover_focal_point").$type<FocalPoint>(),
    // Focal point for smart cropping: { x: 50, y: 50 } (center by default)

    trailerUrl: text("trailer_url"),
    externalIds: jsonb("external_ids").$type<{
      igdbId?: number;
      steamAppId?: number;
      twitchGameId?: string;
    }>(),
    specs: jsonb("specs").$type<Record<string, unknown>>(),

    // Screenshots with media references
    screenshots: jsonb("screenshots").$type<
      Array<{
        mediaId: string;
        caption?: string;
        focalPoint?: FocalPoint;
        order?: number;
      }>
    >(),

    blocks: jsonb("blocks").default([]).$type<PageBlock[]>(),
    isFeaturedOnHome: boolean("is_featured_on_home").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("games_slug_idx").on(t.slug),
    index("games_status_idx").on(t.status),
    index("games_metacritic_idx").on(t.metacriticScore),
    index("games_release_idx").on(t.releaseDate),
    index("games_cover_art_idx").on(t.coverArtId),
  ]
);

// ═══════════════════════════════════════════════
// Platforms Table
// ═══════════════════════════════════════════════

export const platforms = pgTable(
  "platforms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 100 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    shortName: varchar("short_name", { length: 20 }),
    manufacturer: varchar("manufacturer", { length: 100 }),

    // Media field (ids in the core media library, /api/media)
    iconId: uuid("icon_id"), // References media.id

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("platforms_slug_idx").on(t.slug)]
);

// ═══════════════════════════════════════════════
// Tags Table
// ═══════════════════════════════════════════════

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 100 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    color: varchar("color", { length: 7 }),
    category: tagCategoryEnum("category"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("tags_slug_idx").on(t.slug)]
);

// ═══════════════════════════════════════════════
// Game Collections (Curated sections)
// ═══════════════════════════════════════════════

export const gameCollections = pgTable(
  "game_collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar("title", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 200 }).notNull(),
    description: text("description"),
    displayOrder: integer("display_order").default(0).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("gc_slug_idx").on(t.slug)]
);

export const gameCollectionEntries = pgTable(
  "game_collection_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    collectionId: uuid("collection_id")
      .references(() => gameCollections.id, { onDelete: "cascade" })
      .notNull(),
    gameId: uuid("game_id")
      .references(() => games.id, { onDelete: "cascade" })
      .notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
  },
  (t) => [uniqueIndex("gce_unique").on(t.collectionId, t.gameId)]
);

// ═══════════════════════════════════════════════
// Junction Tables (Many-to-Many)
// ═══════════════════════════════════════════════

export const gamesToPlatforms = pgTable(
  "games_to_platforms",
  {
    gameId: uuid("game_id")
      .references(() => games.id, { onDelete: "cascade" })
      .notNull(),
    platformId: uuid("platform_id")
      .references(() => platforms.id, { onDelete: "cascade" })
      .notNull(),
  },
  (t) => [uniqueIndex("gp_unique").on(t.gameId, t.platformId)]
);

export const gamesToTags = pgTable(
  "games_to_tags",
  {
    gameId: uuid("game_id")
      .references(() => games.id, { onDelete: "cascade" })
      .notNull(),
    tagId: uuid("tag_id")
      .references(() => tags.id, { onDelete: "cascade" })
      .notNull(),
  },
  (t) => [uniqueIndex("gt_unique").on(t.gameId, t.tagId)]
);

// ═══════════════════════════════════════════════
// Relations
// ═══════════════════════════════════════════════

export const gamesRelations = relations(games, ({ many }) => ({
  platforms: many(gamesToPlatforms),
  tags: many(gamesToTags),
  collections: many(gameCollectionEntries),
}));

export const platformsRelations = relations(platforms, ({ many }) => ({
  games: many(gamesToPlatforms),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  games: many(gamesToTags),
}));

export const gameCollectionsRelations = relations(gameCollections, ({ many }) => ({
  entries: many(gameCollectionEntries),
}));

export const gameCollectionEntriesRelations = relations(gameCollectionEntries, ({ one }) => ({
  collection: one(gameCollections, {
    fields: [gameCollectionEntries.collectionId],
    references: [gameCollections.id],
  }),
  game: one(games, {
    fields: [gameCollectionEntries.gameId],
    references: [games.id],
  }),
}));

export const gamesToPlatformsRelations = relations(gamesToPlatforms, ({ one }) => ({
  game: one(games, { fields: [gamesToPlatforms.gameId], references: [games.id] }),
  platform: one(platforms, { fields: [gamesToPlatforms.platformId], references: [platforms.id] }),
}));

export const gamesToTagsRelations = relations(gamesToTags, ({ one }) => ({
  game: one(games, { fields: [gamesToTags.gameId], references: [games.id] }),
  tag: one(tags, { fields: [gamesToTags.tagId], references: [tags.id] }),
}));

// ═══════════════════════════════════════════════
// Media Transform URL Helpers
// ═══════════════════════════════════════════════

/**
 * Generate a transform URL for media assets
 * Uses the core media library's transform endpoints (/api/media)
 */
export function getMediaTransformUrl(
  mediaId: string | null | undefined,
  preset: "hero" | "card" | "thumbnail" | "gallery" | "original" = "original",
  focalPoint?: FocalPoint
): string | null {
  if (!mediaId) return null;

  const baseUrl = `/api/media/transform/${mediaId}`;
  const params = new URLSearchParams();

  params.append("preset", preset);

  // Add focal point for smart cropping if provided
  if (focalPoint) {
    params.append("fpx", focalPoint.x.toString());
    params.append("fpy", focalPoint.y.toString());
  }

  const queryString = params.toString();
  return queryString ? `${baseUrl}?${queryString}` : baseUrl;
}

/**
 * Generate a preset URL using the core media library's preset endpoint
 */
export function getMediaPresetUrl(
  mediaId: string | null | undefined,
  preset: string
): string | null {
  if (!mediaId) return null;
  return `/api/media/preset/${mediaId}/${preset}`;
}

/**
 * Build cover art URLs with all available transforms
 */
export function buildCoverArtUrls(
  mediaId: string | null | undefined,
  _focalPoint?: FocalPoint
): {
  hero: string | null;
  card: string | null;
  thumbnail: string | null;
  original: string | null;
} {
  return {
    hero: getMediaPresetUrl(mediaId, "hero"),
    card: getMediaPresetUrl(mediaId, "card"),
    thumbnail: getMediaPresetUrl(mediaId, "thumbnail"),
    original: getMediaTransformUrl(mediaId, "original"),
  };
}

/**
 * Build screenshot URLs with gallery transforms
 */
export function buildScreenshotUrls(
  screenshot: { mediaId: string; focalPoint?: FocalPoint } | null | undefined
): {
  gallery: string | null;
  thumbnail: string | null;
  original: string | null;
} | null {
  if (!screenshot?.mediaId) return null;

  return {
    gallery: getMediaPresetUrl(screenshot.mediaId, "gallery"),
    thumbnail: getMediaPresetUrl(screenshot.mediaId, "thumbnail"),
    original: getMediaTransformUrl(screenshot.mediaId, "original", screenshot.focalPoint),
  };
}

/**
 * Build platform icon URLs
 */
export function buildPlatformIconUrls(iconId: string | null | undefined): {
  thumbnail: string | null;
  original: string | null;
} {
  return {
    thumbnail: getMediaPresetUrl(iconId, "thumbnail"),
    original: getMediaTransformUrl(iconId, "original"),
  };
}

import { createId } from "@paralleldrive/cuid2";
import { pgTable, text, timestamp, real, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

import type { MapDefinition } from "./maps.engine.js";

/**
 * Maps — maps, categories and markers
 * ============================================================================
 * EDITORIAL content: published by the site team and read by everyone.
 * No ownership columns — there is nothing personal to isolate with RLS.
 *
 * Coordinates are NORMALIZED [0..1]: uploading an HD version of the image
 * does not move any marker. The rule lives in the engine (`validateMarker`).
 */

export const gameMaps = pgTable(
  "game_maps",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    definition: jsonb("definition").$type<MapDefinition>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("game_maps_slug_idx").on(t.slug)]
);

export const mapCategories = pgTable(
  "map_categories",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    mapId: text("map_id").notNull(),
    categoryId: text("category_id").notNull(),
    name: text("name").notNull(),
    icon: text("icon"),
    color: text("color").default("#00d2a8").notNull(),
  },
  (t) => [uniqueIndex("map_categories_idx").on(t.mapId, t.categoryId)]
);

export const mapMarkers = pgTable(
  "map_markers",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    mapId: text("map_id").notNull(),
    layerId: text("layer_id").notNull(),
    categoryId: text("category_id").notNull(),
    x: real("x").notNull(),
    y: real("y").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  // The viewer's hot query: all the markers of a map.
  (t) => [index("map_markers_map_idx").on(t.mapId, t.layerId)]
);

export type GameMap = typeof gameMaps.$inferSelect;
export type MapMarker = typeof mapMarkers.$inferSelect;

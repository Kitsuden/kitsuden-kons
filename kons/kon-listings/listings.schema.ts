/**
 * Listings — Drizzle schema
 * ============================================================================
 *
 * Only to TYPE the queries. The tables are created by `migrations/0000_initial.sql`
 * (kon.json: `schema.strategy = "sql"`), so this file and the migrations change together.
 */

import { boolean, jsonb, numeric, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const STATUSES = ["draft", "published", "paused", "closed"] as const;
export type Status = (typeof STATUSES)[number];

export interface ListingImage {
  url: string;
  title?: string | null;
}

export const listingsItems = pgTable("listings_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  vertical: varchar("vertical", { length: 30 }).notNull(),
  slug: varchar("slug", { length: 160 }).notNull(),
  reference: varchar("reference", { length: 100 }),
  title: varchar("title", { length: 200 }).notNull(),
  description: text("description"),
  status: varchar("status", { length: 20 }).$type<Status>().notNull().default("draft"),
  price: numeric("price", { precision: 14, scale: 2 }),
  currency: varchar("currency", { length: 3 }),
  country: varchar("country", { length: 2 }),
  region: varchar("region", { length: 120 }),
  city: varchar("city", { length: 120 }),
  district: varchar("district", { length: 120 }),
  address: varchar("address", { length: 300 }),
  postcode: varchar("postcode", { length: 20 }),
  latitude: numeric("latitude", { precision: 9, scale: 6 }),
  longitude: numeric("longitude", { precision: 9, scale: 6 }),
  attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
  images: jsonb("images").$type<ListingImage[]>().notNull().default([]),
  createdBy: text("created_by"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface FeedSettingsColumn {
  agencyName?: string;
  contactPhone?: string;
  contactEmail?: string;
}

export const listingsFeeds = pgTable("listings_feeds", {
  id: uuid("id").primaryKey().defaultRandom(),
  portal: varchar("portal", { length: 30 }).notNull(),
  vertical: varchar("vertical", { length: 30 }).notNull(),
  token: varchar("token", { length: 64 }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  listingUrl: varchar("listing_url", { length: 500 }).notNull(),
  settings: jsonb("settings").$type<FeedSettingsColumn>().notNull().default({}),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const listingsInquiries = pgTable("listings_inquiries", {
  id: uuid("id").primaryKey().defaultRandom(),
  listingId: uuid("listing_id").notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  email: varchar("email", { length: 254 }).notNull(),
  phone: varchar("phone", { length: 40 }),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ListingsItem = typeof listingsItems.$inferSelect;
export type NewListingsItem = typeof listingsItems.$inferInsert;
export type ListingsFeed = typeof listingsFeeds.$inferSelect;
export type ListingsInquiry = typeof listingsInquiries.$inferSelect;

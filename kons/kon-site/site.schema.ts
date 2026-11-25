import { createId } from "@paralleldrive/cuid2";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Site — sites and their domains
 * ============================================================================
 * EDITORIAL configuration: written by the installation's admins, read by every visitor's
 * frontend. No ownership columns: there is nothing personal to isolate with RLS.
 */

/** One entry of a site's menu. A second level is allowed, a third is not. */
export interface SiteMenuLink {
  label: string;
  href: string;
  newTab?: boolean;
}
export interface SiteMenuItem extends SiteMenuLink {
  children?: SiteMenuLink[];
}

export const siteSites = pgTable(
  "site_sites",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** BCP 47 tag of the site's default language (`es`, `pt-BR`), or null for the frontend's own. */
    locale: text("locale"),
    logoUrl: text("logo_url"),
    faviconUrl: text("favicon_url"),
    /** Named colours (`primary`, `accent`…) as hex. The frontend decides what each name paints. */
    colors: jsonb("colors").$type<Record<string, string>>().default({}).notNull(),
    menu: jsonb("menu").$type<SiteMenuItem[]>().default([]).notNull(),
    /** Whatever else a site's template reads (social links, footer text). Capped at 16 KB. */
    extra: jsonb("extra").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("site_sites_slug_idx").on(t.slug)]
);

export const siteDomains = pgTable(
  "site_domains",
  {
    /** Normalized: lower case, no port, no trailing dot (`normalizeHost`). */
    host: text("host").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => siteSites.id, { onDelete: "cascade" }),
    isPrimary: boolean("is_primary").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("site_domains_site_idx").on(t.siteId)]
);

export type Site = typeof siteSites.$inferSelect;
export type SiteDomain = typeof siteDomains.$inferSelect;

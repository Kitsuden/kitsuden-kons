/**
 * @kitsuden/kon-site
 * ============================================================================
 *
 * Several public sites from one Kitsuden. Each site has the frame its frontend draws (name, logo,
 * colours, menu) and the domains that lead to it; a frontend asks `GET /resolve?host=` with the
 * request's `Host` and gets the site to render.
 *
 * Why a kon and not the core: the core's `site_settings` is one row for the installation's own
 * panel and links. Products that serve no public site (a Discord bot, an inbox) never need this.
 *
 * What it does NOT do: render anything, issue certificates or route traffic. The proxy in front
 * (Caddy, Traefik, Coolify) sends every domain to the frontend; this kon only says which site a
 * host is.
 */

import { defineKonSdk, defineOperation, operationsRouter, type AnyOperation } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Hono } from "hono";
import { z } from "@kitsuden/engine/zod";

import { hostCandidates, normalizeHost } from "./site.hosts.js";
import "./site.policy.js";
import { siteDomains, siteSites, type Site } from "./site.schema.js";
import manifest from "./kon.json" with { type: "json" };

export * from "./site.hosts.js";
export * from "./site.schema.js";
export { registerSitePolicy } from "./site.policy.js";

export const KON_ID = "kon-site";

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

// ── Inputs ─────────────────────────────────────────────────────────────────

const Slug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug: lowercase letters, numbers and hyphens");

/** An image a page loads: http(s), or a path on the site itself. Never `javascript:` or `data:`. */
const AssetUrl = z
  .string()
  .min(1)
  .max(2000)
  .refine((u) => /^https?:\/\/[^\s]+$/i.test(u) || /^\/(?!\/)[^\s]*$/.test(u), "an http(s) URL or a path starting with /");

/** Where a menu entry leads: what `AssetUrl` takes, plus `mailto:`, `tel:` and `#anchor`. */
const Href = z
  .string()
  .min(1)
  .max(2000)
  .refine(
    (u) => /^https?:\/\/[^\s]+$/i.test(u) || /^\/(?!\/)[^\s]*$/.test(u) || /^(mailto:|tel:|#)[^\s]*$/i.test(u),
    "an http(s) URL, a path starting with /, mailto:, tel: or #anchor"
  );

const MenuLink = z.object({
  label: z.string().min(1).max(100),
  href: Href,
  newTab: z.boolean().optional().describe("Open in a new tab"),
});
const MenuItem = MenuLink.extend({
  children: z.array(MenuLink).max(20).optional().describe("A second level; there is no third"),
});

const Hex = z.string().regex(/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "a hex colour (#rgb, #rrggbb, #rrggbbaa)");
const Colors = z
  .record(z.string().regex(/^[a-z][a-zA-Z0-9-]{0,31}$/, "colour name: letters, digits, hyphens"), Hex)
  .refine((r) => Object.keys(r).length <= 24, "at most 24 colours")
  .describe("Named colours, e.g. { primary: '#e11d48', accent: '#0ea5e9' }");

const EXTRA_MAX_BYTES = 16 * 1024;
const Extra = z
  .record(z.string(), z.unknown())
  .refine((r) => new TextEncoder().encode(JSON.stringify(r)).length <= EXTRA_MAX_BYTES, "extra: at most 16 KB of JSON")
  .describe("Anything else the site's template reads (social links, footer text)");

const Locale = z
  .string()
  .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, "a language tag such as es, en or pt-BR");

/** Left out on a rewrite keeps the stored value; `null` clears it. */
const SaveSite = z.object({
  slug: Slug,
  name: z.string().min(1).max(200),
  description: z.string().max(500).nullable().optional(),
  locale: Locale.nullable().optional(),
  logoUrl: AssetUrl.nullable().optional(),
  faviconUrl: AssetUrl.nullable().optional(),
  colors: Colors.optional(),
  menu: z.array(MenuItem).max(50).optional(),
  extra: Extra.optional(),
});

const HostParam = z.object({ host: z.string().describe("Domain, e.g. example.com") });
const SlugParam = z.object({ slug: z.string().describe("Site slug") });

const SaveDomain = z.object({
  site: Slug.describe("Slug of the site this domain leads to"),
  primary: z.boolean().optional().describe("The site's canonical domain; setting it unsets the site's previous one"),
});

// ── Outputs ────────────────────────────────────────────────────────────────

const PublicSite = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  locale: z.string().nullable(),
  logoUrl: z.string().nullable(),
  faviconUrl: z.string().nullable(),
  colors: z.record(z.string(), z.string()),
  menu: z.array(z.record(z.string(), z.unknown())),
  extra: z.record(z.string(), z.unknown()),
  primaryHost: z.string().nullable().describe("The canonical domain, or null when none is marked"),
});

const Domain = z.object({
  host: z.string(),
  site: z.string().describe("Site slug"),
  primary: z.boolean(),
  createdAt: z.string(),
});

const SiteSummary = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  hosts: z.array(z.string()),
  primaryHost: z.string().nullable(),
  updatedAt: z.string(),
});

type Db = PgDatabase<PgQueryResultHKT, Record<string, never>>;

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

async function primaryHostOf(db: Db, siteId: string): Promise<string | null> {
  const [row] = await db
    .select({ host: siteDomains.host })
    .from(siteDomains)
    .where(and(eq(siteDomains.siteId, siteId), eq(siteDomains.isPrimary, true)))
    .limit(1);
  return row?.host ?? null;
}

function publicSite(site: Site, primaryHost: string | null): z.output<typeof PublicSite> {
  return {
    slug: site.slug,
    name: site.name,
    description: site.description ?? null,
    locale: site.locale ?? null,
    logoUrl: site.logoUrl ?? null,
    faviconUrl: site.faviconUrl ?? null,
    colors: site.colors ?? {},
    menu: (site.menu ?? []) as unknown as Array<Record<string, unknown>>,
    extra: site.extra ?? {},
    primaryHost,
  };
}

async function siteBySlug(db: Db, slug: string): Promise<Site | undefined> {
  const [row] = await db.select().from(siteSites).where(eq(siteSites.slug, slug)).limit(1);
  return row;
}

export function siteOperations(ctx: KonContext): AnyOperation[] {
  const db = ctx.db.instance as Db;

  return [
    /**
     * The hot path: every page the frontend renders starts here. One lookup by primary key (two
     * with the `www.` fallback). The frontend may cache the answer; nothing here does, so a change
     * in the panel is seen on the next request by every replica.
     */
    defineOperation({
      id: "resolve-host",
      method: "GET",
      route: "/resolve",
      summary: "Which site a host is",
      description:
        "The site a request's `Host` leads to, with what its frontend draws: name, description, locale, logo, favicon, named colours, menu, `extra` and the canonical domain (`primaryHost`). Send the Host header as it arrived (`example.com:4321` is fine: the port and case are ignored). A host registered without `www.` also answers with `www.`. 404 when no site has the host, 400 when it is not a host name. Public.",
      access: "public",
      input: { query: z.object({ host: z.string().min(1).max(260).describe("The request's Host header") }) },
      output: { schema: z.object({ data: PublicSite }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_VALIDATION"],
      handle: async ({ query }, { c }) => {
        const host = normalizeHost(query.host);
        if (!host) return c.json({ error: "Not a host name" }, 400);
        const candidates = hostCandidates(host);
        const rows = await db
          .select({ host: siteDomains.host, siteId: siteDomains.siteId })
          .from(siteDomains)
          .where(inArray(siteDomains.host, candidates));
        const hit = candidates.map((h) => rows.find((r) => r.host === h)).find(Boolean);
        if (!hit) return c.json({ error: "No site has this host" }, 404);
        const [site] = await db.select().from(siteSites).where(eq(siteSites.id, hit.siteId)).limit(1);
        if (!site) return c.json({ error: "No site has this host" }, 404);
        return c.json({ data: publicSite(site, await primaryHostOf(db, site.id)) });
      },
    }),

    defineOperation({
      id: "get-site",
      method: "GET",
      route: "/sites/:slug",
      summary: "Read a site by slug",
      description:
        "The same public configuration as resolve-host, by slug: for a frontend that knows which site it is (a build-time profile) instead of reading the Host. 404 when the slug does not exist. Public.",
      access: "public",
      input: { params: SlugParam },
      output: { schema: z.object({ data: PublicSite }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }, { c }) => {
        const site = await siteBySlug(db, params.slug);
        if (!site) return c.json({ error: "Not found" }, 404);
        return c.json({ data: publicSite(site, await primaryHostOf(db, site.id)) });
      },
    }),

    defineOperation({
      id: "list-sites",
      method: "GET",
      route: "/sites",
      summary: "List sites",
      description:
        "Every site by name with its domains (`hosts`) and canonical domain. Site staff (admin/editor), or an agent with site:list.",
      access: "session",
      permission: { policy: { resource: "site", action: "list" } },
      unpaginated: "The public sites one installation serves: a handful, listed whole for the panel.",
      output: { schema: z.object({ data: z.array(SiteSummary) }) },
      handle: async (_input, { c }) => {
        const sites = await db.select().from(siteSites).orderBy(asc(siteSites.name));
        const domains = await db.select().from(siteDomains).orderBy(asc(siteDomains.host));
        return c.json({
          data: sites.map((s) => {
            const own = domains.filter((d) => d.siteId === s.id);
            return {
              id: s.id,
              slug: s.slug,
              name: s.name,
              hosts: own.map((d) => d.host),
              primaryHost: own.find((d) => d.isPrimary)?.host ?? null,
              updatedAt: iso(s.updatedAt),
            };
          }),
        });
      },
    }),

    defineOperation({
      id: "save-site",
      method: "PUT",
      route: "/sites",
      summary: "Create or rewrite a site",
      description:
        "Upsert by slug: 201 when it creates the site, 200 when it rewrites it. On a rewrite a field left out keeps its value and `null` clears it; `colors`, `menu` and `extra` are replaced whole when sent. Images are http(s) URLs or site paths; menu links also take mailto:, tel: and #anchor; at most two menu levels. Admins, or an agent with site:create (site:update to rewrite).",
      access: "session",
      permission: { policy: { resource: "site", action: "create" } },
      // Changes what every visitor of the site sees at once.
      sensitive: true,
      input: { body: SaveSite },
      output: {
        schema: z.object({ data: PublicSite }),
        otherStatuses: [201 as const],
        description: "Rewritten (200) or created (201)",
      },
      handle: async ({ body }, { c, can }) => {
        const existing = await siteBySlug(db, body.slug);
        if (existing && !(await can(existing, "update"))) return c.json({ error: "Forbidden" }, 403);
        const values = {
          name: body.name,
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.locale !== undefined ? { locale: body.locale } : {}),
          ...(body.logoUrl !== undefined ? { logoUrl: body.logoUrl } : {}),
          ...(body.faviconUrl !== undefined ? { faviconUrl: body.faviconUrl } : {}),
          ...(body.colors !== undefined ? { colors: body.colors } : {}),
          ...(body.menu !== undefined ? { menu: body.menu } : {}),
          ...(body.extra !== undefined ? { extra: body.extra } : {}),
        };
        const [row] = existing
          ? await db
              .update(siteSites)
              .set({ ...values, updatedAt: new Date() })
              .where(eq(siteSites.id, existing.id))
              .returning()
          : await db
              .insert(siteSites)
              .values({ slug: body.slug, ...values })
              .returning();
        return c.json({ data: publicSite(row!, await primaryHostOf(db, row!.id)) }, existing ? 200 : 201);
      },
    }),

    defineOperation({
      id: "delete-site",
      method: "DELETE",
      route: "/sites/:slug",
      summary: "Delete a site",
      description:
        "Removes the site and every domain that led to it: those hosts answer 404 on resolve-host from then on. 404 when the slug does not exist. Admins, or an agent with site:delete.",
      access: "session",
      permission: { policy: { resource: "site", action: "delete" } },
      sensitive: true,
      input: { params: SlugParam },
      output: { status: 204 },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }, { c }) => {
        const removed = await db
          .delete(siteSites)
          .where(eq(siteSites.slug, params.slug))
          .returning({ id: siteSites.id });
        if (removed.length === 0) return c.json({ error: "Not found" }, 404);
        return c.body(null, 204);
      },
    }),

    defineOperation({
      id: "list-domains",
      method: "GET",
      route: "/domains",
      summary: "List domains",
      description:
        "Every domain with the site it leads to and whether it is that site's canonical one. `site` keeps one site's domains. Site staff (admin/editor), or an agent with site:list.",
      access: "session",
      permission: { policy: { resource: "site", action: "list" } },
      unpaginated: "The domains of the installation's few sites: listed whole for the panel.",
      input: { query: z.object({ site: Slug.optional().describe("Only this site's domains") }) },
      output: { schema: z.object({ data: z.array(Domain) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ query }, { c }) => {
        let siteId: string | undefined;
        if (query.site) {
          const site = await siteBySlug(db, query.site);
          if (!site) return c.json({ error: "Site not found" }, 404);
          siteId = site.id;
        }
        const rows = await db
          .select({
            host: siteDomains.host,
            site: siteSites.slug,
            primary: siteDomains.isPrimary,
            createdAt: siteDomains.createdAt,
          })
          .from(siteDomains)
          .innerJoin(siteSites, eq(siteSites.id, siteDomains.siteId))
          .where(siteId ? eq(siteDomains.siteId, siteId) : undefined)
          .orderBy(asc(siteDomains.host));
        return c.json({ data: rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })) });
      },
    }),

    defineOperation({
      id: "save-domain",
      method: "PUT",
      route: "/domains/:host",
      summary: "Point a domain at a site",
      description:
        "Says which site a host leads to: 201 when the domain is new, 200 when it moves or changes. The host is stored normalized (lower case, no port, no trailing dot); a URL, a path or an IPv6 literal is a 400. `primary: true` makes it the site's canonical domain and unsets the previous one; left out keeps what the domain had. This does not touch DNS or certificates: the proxy in front must already send the domain to the frontend. Admins, or an agent with site:update.",
      access: "session",
      permission: { policy: { resource: "site", action: "update" } },
      // Pointing a live domain at another site changes what its visitors see.
      sensitive: true,
      input: { params: HostParam, body: SaveDomain },
      output: {
        schema: z.object({ data: Domain }),
        otherStatuses: [201 as const],
        description: "Changed (200) or created (201)",
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_VALIDATION"],
      handle: async ({ params, body }, { c }) => {
        const host = normalizeHost(params.host);
        if (!host) return c.json({ error: "Not a host name" }, 400);
        const site = await siteBySlug(db, body.site);
        if (!site) return c.json({ error: "Site not found" }, 404);

        const [existing] = await db.select().from(siteDomains).where(eq(siteDomains.host, host)).limit(1);
        const primary = body.primary ?? (existing && existing.siteId === site.id ? existing.isPrimary : false);
        // Before writing this one: the partial unique index allows one primary per site.
        if (primary) {
          await db
            .update(siteDomains)
            .set({ isPrimary: false })
            .where(and(eq(siteDomains.siteId, site.id), eq(siteDomains.isPrimary, true), ne(siteDomains.host, host)));
        }
        const [row] = existing
          ? await db
              .update(siteDomains)
              .set({ siteId: site.id, isPrimary: primary })
              .where(eq(siteDomains.host, host))
              .returning()
          : await db.insert(siteDomains).values({ host, siteId: site.id, isPrimary: primary }).returning();
        return c.json(
          { data: { host: row!.host, site: site.slug, primary: row!.isPrimary, createdAt: iso(row!.createdAt) } },
          existing ? 200 : 201
        );
      },
    }),

    defineOperation({
      id: "delete-domain",
      method: "DELETE",
      route: "/domains/:host",
      summary: "Remove a domain",
      description:
        "The host stops leading to its site (resolve-host answers 404 for it). The site itself stays. 404 when the host is not registered. Admins, or an agent with site:update.",
      access: "session",
      permission: { policy: { resource: "site", action: "update" } },
      sensitive: true,
      input: { params: HostParam },
      output: { status: 204 },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_VALIDATION"],
      handle: async ({ params }, { c }) => {
        const host = normalizeHost(params.host);
        if (!host) return c.json({ error: "Not a host name" }, 400);
        const removed = await db
          .delete(siteDomains)
          .where(eq(siteDomains.host, host))
          .returning({ host: siteDomains.host });
        if (removed.length === 0) return c.json({ error: "Not found" }, 404);
        return c.body(null, 204);
      },
    }),
  ];
}

export function createKonSite(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, siteOperations(ctx), ctx);
}

export const kon = defineKonSdk({
  id: KON_ID,
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  icon: manifest.icon,
  mountPath: manifest.mount.path,
  operations: (ctx: KonContext) => siteOperations(ctx),
  tables: konTables,
  // kon.json `admin` is the one list of admin views; the definition copies it.
  admin: {
    category: manifest.admin.category as "content",
    views: manifest.admin.views.map((v) => ({ id: v.id, type: v.type as "grid", title: v.title, table: v.table })),
  },
  dependencies: { kons: [], core: ["auth"] },
  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info("🌐 Sites ready: GET /api/site/resolve?host= says which site a host is");
    },
  },
});

export default kon;

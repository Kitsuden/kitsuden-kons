-- 0001 — Sites and the domains that lead to them
-- Idempotent. Editorial configuration: no ownership columns, nothing personal.
--
-- One Kitsuden can serve several public sites. `site_sites` holds what a site's frontend needs to
-- draw its frame (name, logo, colours, menu) and `site_domains` says which site a request's
-- `Host` belongs to.
CREATE TABLE IF NOT EXISTS site_sites (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  locale TEXT,
  logo_url TEXT,
  favicon_url TEXT,
  colors JSONB NOT NULL DEFAULT '{}'::jsonb,
  menu JSONB NOT NULL DEFAULT '[]'::jsonb,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS site_sites_slug_idx ON site_sites (slug);

-- The host is stored normalized (lower case, no port, no trailing dot) and is the key: one host
-- leads to one site. Removing a site removes its domains.
CREATE TABLE IF NOT EXISTS site_domains (
  host TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES site_sites (id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_domains_site_idx ON site_domains (site_id);
-- At most one primary domain per site: the one canonical links point at.
CREATE UNIQUE INDEX IF NOT EXISTS site_domains_primary_idx ON site_domains (site_id) WHERE is_primary;

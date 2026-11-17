-- kon-listings — initial schema
-- ============================================================================
-- A kon's tables are created HERE, never from code: the API connects with a role without the
-- CREATE privilege (which is what makes row security effective). Applied by `pnpm db:migrate`,
-- by `kitsuden kon add`, or by the panel when the kon is switched on.
--
-- A migration that was applied is history: to change a table, add 0001_<what>.sql.

-- Listings: properties, vehicles, job offers. The columns every kind shares are columns (they are
-- what a portal and a search filter on); what one kind adds lives in `attributes`, checked against
-- the vertical's file (verticals/<id>.json) on every write.
CREATE TABLE IF NOT EXISTS listings_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vertical      varchar(30)  NOT NULL,
  slug          varchar(160) NOT NULL UNIQUE,
  reference     varchar(100),
  title         varchar(200) NOT NULL,
  description   text,
  status        varchar(20)  NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'published', 'paused', 'closed')),
  price         numeric(14, 2) CHECK (price IS NULL OR price >= 0),
  currency      varchar(3),
  country       varchar(2),
  region        varchar(120),
  city          varchar(120),
  district      varchar(120),
  address       varchar(300),
  postcode      varchar(20),
  latitude      numeric(9, 6) CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude     numeric(9, 6) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  attributes    jsonb NOT NULL DEFAULT '{}'::jsonb,
  images        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by    text,
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS listings_items_public_idx ON listings_items (vertical, status, published_at DESC);
CREATE INDEX IF NOT EXISTS listings_items_city_idx ON listings_items (vertical, lower(city));
CREATE INDEX IF NOT EXISTS listings_items_reference_idx ON listings_items (reference);

-- Feeds: one per portal and vertical. A portal reads its feed from a public URL that carries
-- `token`; whoever has the URL reads what is already published, nothing else.
CREATE TABLE IF NOT EXISTS listings_feeds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal        varchar(30)  NOT NULL,
  vertical      varchar(30)  NOT NULL,
  token         varchar(64)  NOT NULL UNIQUE,
  enabled       boolean      NOT NULL DEFAULT true,
  -- Where a listing lives on the agency's own site, with {slug} or {id}: the link the portal shows.
  listing_url   varchar(500) NOT NULL,
  settings      jsonb        NOT NULL DEFAULT '{}'::jsonb,
  last_read_at  timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (portal, vertical)
);

-- Inquiries: what a visitor asks about a listing from the agency's site. Personal data (kon.json
-- → sensitivity): only the team reads it.
CREATE TABLE IF NOT EXISTS listings_inquiries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  uuid NOT NULL REFERENCES listings_items (id) ON DELETE CASCADE,
  name        varchar(120) NOT NULL,
  email       varchar(254) NOT NULL,
  phone       varchar(40),
  message     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS listings_inquiries_listing_idx ON listings_inquiries (listing_id, created_at DESC);

-- Row security, with the core's helpers (agent-functions.sql), so the database says the same as
-- listings.policy.ts even if a query forgets a filter:
--   · the team (admin, editor), the system, and an agent with the kon's scope;
--   · anyone, signed in or not, reads a listing that is published. Feeds and inquiries: team only.
SELECT kitsuden_rls_team('listings_items', 'listings', 'listings-item:view', 'listings-item:update');
SELECT kitsuden_rls_public_read('listings_items', $$status = 'published'$$);
SELECT kitsuden_rls_team('listings_feeds', 'listings', 'listings-feed:view', 'listings-feed:update');
SELECT kitsuden_rls_team('listings_inquiries', 'listings', 'listings-inquiry:view', 'listings-inquiry:update');

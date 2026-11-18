-- kon-dc — the item catalog: what items ARE (inventories only count them)
-- ============================================================================
-- A row per item: a server's own (guild_id set) or a global one (guild_id NULL) that every server
-- shows, like profile badges and backgrounds. Global items live in dc_global_inventory.

CREATE TABLE IF NOT EXISTS dc_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id     varchar(20) REFERENCES dc_guilds (id) ON DELETE CASCADE,
  item         varchar(64) NOT NULL CHECK (item ~ '^[a-z0-9_-]{1,64}$'),
  name         varchar(80) NOT NULL,
  description  varchar(300),
  emoji        varchar(64),
  rarity       varchar(12) NOT NULL DEFAULT 'common'
               CHECK (rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary')),
  kind         varchar(12) NOT NULL DEFAULT 'item'
               CHECK (kind IN ('item', 'consumable', 'role', 'badge', 'background', 'pet')),
  image_url    varchar(500),
  color        varchar(7) CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  -- For sale when price is set; currency is a server currency, or a global one for global items.
  price        bigint CHECK (price IS NULL OR price >= 0),
  currency     varchar(32) NOT NULL DEFAULT 'coins',
  sell_price   bigint CHECK (sell_price IS NULL OR sell_price >= 0),
  tradeable    boolean NOT NULL DEFAULT true,
  stock        integer CHECK (stock IS NULL OR stock >= 0),
  sold         integer NOT NULL DEFAULT 0 CHECK (sold >= 0),
  role_id      varchar(20) CHECK (role_id IS NULL OR role_id ~ '^[0-9]{15,20}$'),
  -- Loot tables: how often it drops, besides its rarity (0 = never from random drops).
  drop_weight  integer NOT NULL DEFAULT 1 CHECK (drop_weight >= 0),
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One id per server, and one global: NULL guild ids would not collide in a plain UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS dc_items_item_idx ON dc_items (COALESCE(guild_id, ''), item);

CREATE TABLE IF NOT EXISTS dc_global_inventory (
  user_id     varchar(20) NOT NULL CHECK (user_id ~ '^[0-9]{15,20}$'),
  item        varchar(64) NOT NULL CHECK (item ~ '^[a-z0-9_-]{1,64}$'),
  quantity    integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item)
);

SELECT kitsuden_rls_team('dc_items', 'dc', 'dc-bot:view', 'dc-bot:update');
SELECT kitsuden_rls_team('dc_global_inventory', 'dc', 'dc-bot:view', 'dc-bot:update');

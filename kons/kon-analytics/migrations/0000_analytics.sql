-- kon-analytics — views per subject and day
--
-- ONE row per (subject, day) with a counter that goes up. No IP, no cookie, no
-- user agent: nobody's path can be rebuilt from this and no consent banner is
-- needed. The price is that it counts VIEWS and not unique visitors,
-- and that is what the interface calls it.

CREATE TABLE IF NOT EXISTS analytics_views (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type varchar(40) NOT NULL,
  subject_id   uuid NOT NULL,
  day          date NOT NULL,
  views        integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The natural key: it is what makes the counter's UPSERT atomic.
CREATE UNIQUE INDEX IF NOT EXISTS analytics_views_sujeto_dia_idx
  ON analytics_views (subject_type, subject_id, day);

-- The home page query: the most viewed of the last N days.
CREATE INDEX IF NOT EXISTS analytics_views_tipo_dia_idx
  ON analytics_views (subject_type, day);

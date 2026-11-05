-- Streamers: columns the schema declares and the table did not have
-- ============================================================================
--
-- kon-streamers had no `migrations/` folder. Its two tables are created by the
-- core's base migration, and since then `streamers.schema.ts` grew six
-- columns that no migration added.
--
-- It is silent drift, the most expensive case: the table EXISTS, so startup
-- does not complain and the query that asks for `bio` or `updated_at` fails in
-- production with `column ... does not exist`. And in Drizzle selecting the whole
-- model is enough to ask for all of them, so the listing fails, not some rare field.
--
-- The schema verifier caught it with `--todos-los-kons` (all kons) against a clean
-- database. With the kons that are active out of the box it did not show up:
-- kon-streamers ships switched off.

ALTER TABLE streamers ADD COLUMN IF NOT EXISTS bio             text;
ALTER TABLE streamers ADD COLUMN IF NOT EXISTS current_game_id uuid;
ALTER TABLE streamers ADD COLUMN IF NOT EXISTS thumbnail_id    uuid;
ALTER TABLE streamers ADD COLUMN IF NOT EXISTS social_links    text;
ALTER TABLE streamers ADD COLUMN IF NOT EXISTS updated_at      timestamptz NOT NULL DEFAULT now();

ALTER TABLE games_to_streamers ADD COLUMN IF NOT EXISTS is_primary boolean DEFAULT false;

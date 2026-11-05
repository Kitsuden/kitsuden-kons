-- Streamers: one row per platform + channel, and the live-status index
-- ============================================================================
--
-- `streamers.schema.ts` declared `streamers_channel_idx` (unique on platform + channel_id) and
-- `streamers_live_idx`, but no migration created them. Create and update promised a 409 on a
-- duplicated channel and the database let the duplicate in; the sync job then updated every copy.
--
-- Duplicates are NOT merged here: each copy may have its own games, bio and slug, and which one to
-- keep is a person's call. If the table already holds a duplicated platform + channel, this file
-- stops with a message that names them; delete or fix the extra rows and run the migrations again.

DO $$
DECLARE
  dupes text;
BEGIN
  SELECT string_agg(format('%s/%s (%s rows)', platform, channel_id, n), ', ')
    INTO dupes
    FROM (
      SELECT platform, channel_id, count(*) AS n
        FROM streamers
       GROUP BY platform, channel_id
      HAVING count(*) > 1
       LIMIT 20
    ) d;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'kon-streamers 0002: duplicated platform + channel in streamers: %. Keep one row per channel (delete or change the others) and run the migrations again.', dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS streamers_channel_idx ON streamers USING btree (platform, channel_id);
CREATE INDEX IF NOT EXISTS streamers_live_idx ON streamers USING btree (is_live);

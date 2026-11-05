-- Booking security (review 2026-10-15)
-- ----------------------------------------------------------------------------
--
-- 1. USER IDS ARE TEXT.
--    `user_id`, `approved_by_id`… were `uuid`, but `auth_users.id` (better-auth)
--    is `text` and its ids are NOT shaped like UUIDs. Storing the session's id
--    (the only correct thing to do) failed with `invalid input syntax for type
--    uuid`; the old route "worked" because it took the `userId` from the BODY.
--    Postgres does not allow changing the type of a column that a policy uses,
--    so the policies are dropped first (they are recreated below).
--
-- 2. REAL RLS.
--    Both tables were already in `rls-owned-tables.sql` (owner | admin), but
--    the kon's routes did not set a context, and a policy with an empty context
--    lets everything through. Now the kon sets it per request (booking.context.ts)
--    and this file leaves the policies complete even if nobody applies
--    `rls-owned-tables.sql` afterwards (hot activation from the panel):
--      · owner or admin (the same policy, same name, as the shared file);
--      · `editor` = front-desk staff: sees and manages all of them;
--      · the owner of a BOOKING sees the NON-internal notes on their booking,
--        whoever wrote them; and only writes non-internal notes on their own
--        bookings (RESTRICTIVE insert policy).
--
-- 3. OCCUPANCY WITHOUT PERSONAL DATA.
--    With RLS, a user only sees THEIR bookings, so the conflict check when
--    booking did not see other people's: double booking. Occupancy comes from
--    `booking_huecos_ocupados()`, SECURITY DEFINER, which returns only start
--    and end: not who, not the title, not the id.
--
-- Idempotent: every CREATE POLICY has its DROP before it.

DROP POLICY IF EXISTS booking_reservations_owner_isolation ON booking_reservations;
DROP POLICY IF EXISTS booking_reservations_staff ON booking_reservations;
DROP POLICY IF EXISTS booking_notes_owner_isolation ON booking_notes;
DROP POLICY IF EXISTS booking_notes_staff ON booking_notes;
DROP POLICY IF EXISTS booking_notes_dueno_de_reserva ON booking_notes;
DROP POLICY IF EXISTS booking_notes_insercion ON booking_notes;

ALTER TABLE booking_reservations ALTER COLUMN user_id TYPE text USING user_id::text;
ALTER TABLE booking_reservations ALTER COLUMN approved_by_id TYPE text USING approved_by_id::text;
ALTER TABLE booking_reservations ALTER COLUMN checked_in_by_id TYPE text USING checked_in_by_id::text;
ALTER TABLE booking_reservations ALTER COLUMN cancelled_by_id TYPE text USING cancelled_by_id::text;
ALTER TABLE booking_notes ALTER COLUMN user_id TYPE text USING user_id::text;
ALTER TABLE booking_blackout_dates ALTER COLUMN created_by_id TYPE text USING created_by_id::text;

ALTER TABLE booking_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE booking_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_notes FORCE ROW LEVEL SECURITY;

-- ── Bookings ────────────────────────────────────────────────────────────────

CREATE POLICY booking_reservations_owner_isolation ON booking_reservations
  FOR ALL TO PUBLIC
  USING (
    current_setting('app.current_user_id', true) = ''
    OR current_setting('app.current_user_id', true) IS NULL
    OR current_setting('app.current_user_role', true) = 'admin'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    current_setting('app.current_user_id', true) = ''
    OR current_setting('app.current_user_id', true) IS NULL
    OR current_setting('app.current_user_role', true) = 'admin'
    OR user_id::text = current_setting('app.current_user_id', true)
  );

CREATE POLICY booking_reservations_staff ON booking_reservations
  FOR ALL TO PUBLIC
  USING (current_setting('app.current_user_role', true) = 'editor')
  WITH CHECK (current_setting('app.current_user_role', true) = 'editor');

-- ── Notes ───────────────────────────────────────────────────────────────────

CREATE POLICY booking_notes_owner_isolation ON booking_notes
  FOR ALL TO PUBLIC
  USING (
    current_setting('app.current_user_id', true) = ''
    OR current_setting('app.current_user_id', true) IS NULL
    OR current_setting('app.current_user_role', true) = 'admin'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    current_setting('app.current_user_id', true) = ''
    OR current_setting('app.current_user_id', true) IS NULL
    OR current_setting('app.current_user_role', true) = 'admin'
    OR user_id::text = current_setting('app.current_user_id', true)
  );

CREATE POLICY booking_notes_staff ON booking_notes
  FOR ALL TO PUBLIC
  USING (current_setting('app.current_user_role', true) = 'editor')
  WITH CHECK (current_setting('app.current_user_role', true) = 'editor');

-- The booking's owner reads the non-internal notes of THEIR booking. The subquery
-- goes through the RLS of booking_reservations in turn: it only finds their own.
CREATE POLICY booking_notes_dueno_de_reserva ON booking_notes
  FOR SELECT TO PUBLIC
  USING (
    NOT coalesce(is_internal, false)
    AND EXISTS (
      SELECT 1 FROM booking_reservations r
      WHERE r.id = booking_notes.booking_id
        AND r.user_id::text = current_setting('app.current_user_id', true)
    )
  );

-- RESTRICTIVE: on top of the above, whoever is not staff may only insert notes
-- that are NOT internal, and only on THEIR OWN bookings.
CREATE POLICY booking_notes_insercion ON booking_notes
  AS RESTRICTIVE FOR INSERT TO PUBLIC
  WITH CHECK (
    current_setting('app.current_user_id', true) = ''
    OR current_setting('app.current_user_id', true) IS NULL
    OR current_setting('app.current_user_role', true) IN ('admin', 'editor')
    OR (
      NOT coalesce(is_internal, false)
      AND EXISTS (
        SELECT 1 FROM booking_reservations r
        WHERE r.id = booking_notes.booking_id
          AND r.user_id::text = current_setting('app.current_user_id', true)
      )
    )
  );

-- ── Public occupancy ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION booking_huecos_ocupados(
  p_room_id uuid,
  p_desde timestamptz,
  p_hasta timestamptz
)
RETURNS TABLE (start_time timestamptz, end_time timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT r.start_time, r.end_time
  FROM booking_reservations r
  WHERE r.room_id = p_room_id
    AND r.status IN ('pending', 'confirmed', 'checked_in')
    AND r.start_time < p_hasta
    AND r.end_time > p_desde
  ORDER BY r.start_time
  LIMIT 1000
$$;

REVOKE ALL ON FUNCTION booking_huecos_ocupados(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking_huecos_ocupados(uuid, timestamptz, timestamptz) TO PUBLIC;

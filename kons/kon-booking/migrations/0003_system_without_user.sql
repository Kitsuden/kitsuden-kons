-- 0003 — Booking: "system" means empty id AND empty role (2026-10-23)
-- ============================================================================
-- Idempotent: DROP POLICY IF EXISTS / CREATE OR REPLACE.
--
-- 0002_booking_security treated any context with an empty `app.current_user_id`
-- as the system. The kon set its own context and gave anonymous users an id that
-- matched nothing (`anonimo`), so it went unnoticed. Since 2026-10-23 the
-- context is set by the HOST for every kon, following the core convention:
-- anonymous users carry id '' and role `anonymous`. With 0002_booking_security they
-- would have gone through these policies as if they were the system. It is the
-- same hatch the core closed in rls-owned-tables.sql.
--
-- `booking_reservations_owner_isolation` and `booking_notes_owner_isolation`
-- are rewritten on every startup by rls-owned-tables.sql, already with the
-- strict condition; what remains here is the restrictive insert policy for notes.

DO $$
BEGIN
  IF to_regclass('public.booking_notes') IS NULL THEN
    RETURN;
  END IF;
  DROP POLICY IF EXISTS booking_notes_insercion ON booking_notes;
  CREATE POLICY booking_notes_insercion ON booking_notes
    AS RESTRICTIVE FOR INSERT TO PUBLIC
    WITH CHECK (
      (COALESCE(current_setting('app.current_user_id', true), '') = ''
     AND COALESCE(current_setting('app.current_user_role', true), '') = '')
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
END $$;

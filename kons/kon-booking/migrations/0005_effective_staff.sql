-- 0005 — Booking: staff is the TEAM again (admin + editor) (2026-10-26)
-- ============================================================================
-- Idempotent: DROP POLICY IF EXISTS / CREATE POLICY.
--
-- Owner's decision: "editors manage bookings again" (front-desk staff). In the
-- phase D fixes (0004) the RLS staff became only the effective admin; now it is
-- `kitsuden_effective_staff('booking')` (core,
-- apps/api/src/db/agent-functions.sql): a human admin or editor, or an agent
-- that opens the whole kon. An agent's fine-grained front-desk permission
-- (`booking:listAll`, `booking:manage`) is kept, as in 0004. It is the same
-- rule as booking.policy.ts (`isEffectiveStaff(user, "booking")`).
--
-- 0004 is not edited (the runner stores its checksum): this one replaces it.
-- `booking_reservations_owner_isolation` (owner or admin) is rewritten on every
-- startup by rls-owned-tables.sql: it is not touched (permissive policies are
-- combined with OR, so the staff policy is enough).

DO $$
DECLARE
  personal CONSTANT text :=
    $Q$(kitsuden_effective_staff('booking')
        OR kitsuden_agent_can_in_kon('booking', 'booking:listAll')
        OR kitsuden_agent_can_in_kon('booking', 'booking:manage'))$Q$;
BEGIN
  IF to_regclass('public.booking_reservations') IS NOT NULL THEN
    DROP POLICY IF EXISTS booking_reservations_staff ON booking_reservations;
    EXECUTE format('CREATE POLICY booking_reservations_staff ON booking_reservations '
                   'FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)', personal, personal);
  END IF;

  IF to_regclass('public.booking_notes') IS NULL THEN
    RETURN;
  END IF;
  DROP POLICY IF EXISTS booking_notes_staff ON booking_notes;
  EXECUTE format('CREATE POLICY booking_notes_staff ON booking_notes '
                 'FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)', personal, personal);

  -- RESTRICTIVE: whoever is not staff only inserts notes that are NOT internal,
  -- and only on THEIR OWN bookings (as in 0003/0004, with the new staff definition).
  DROP POLICY IF EXISTS booking_notes_insercion ON booking_notes;
  EXECUTE format($P$
    CREATE POLICY booking_notes_insercion ON booking_notes
      AS RESTRICTIVE FOR INSERT TO PUBLIC
      WITH CHECK (
        (COALESCE(current_setting('app.current_user_id', true), '') = ''
         AND COALESCE(current_setting('app.current_user_role', true), '') = '')
        OR %s
        OR (
          NOT coalesce(is_internal, false)
          AND EXISTS (
            SELECT 1 FROM booking_reservations r
            WHERE r.id = booking_notes.booking_id
              AND r.user_id::text = current_setting('app.current_user_id', true)
          )
        )
      )
  $P$, personal);
END $$;

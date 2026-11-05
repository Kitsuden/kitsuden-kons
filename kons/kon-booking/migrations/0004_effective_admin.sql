-- 0004 — Booking: staff is the effective ADMIN (phase D fixes, 2026-10-25)
-- ============================================================================
-- Idempotent: DROP POLICY IF EXISTS / CREATE POLICY.
--
-- Owner's decision: bookings are open to anyone with a session (each person
-- books and sees THEIR OWN) and the ADMIN manages rooms and everything else.
-- Until now the RLS "staff" was the `editor` role (0002), and an agent with
-- `admin` or `booking:*` (role `agent`) could not see a single booking by
-- someone else: the list came back empty (phase D, e2e test over HTTP).
--
-- Now staff is `kitsuden_effective_admin('booking')` (core,
-- apps/api/src/db/agent-functions.sql): the human admin, or an agent that
-- opens the whole kon. Plus an agent with a fine-grained front-desk permission
-- (`booking:listAll`, `booking:manage`), which is what the app policy
-- (booking.policy.ts, `can()`) grants it. `editor` is no longer staff: the
-- same as booking.policy.ts says.
--
-- `booking_reservations_owner_isolation` (owner or admin) is rewritten on every
-- startup by rls-owned-tables.sql: it is not touched here.

DO $$
DECLARE
  personal CONSTANT text :=
    $Q$(kitsuden_effective_admin('booking')
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
  -- and only on THEIR OWN bookings (as in 0003, with the new staff definition).
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

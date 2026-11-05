-- RLS for kon-booking after the English rename: functions, triggers and policies come back with the new names.
--
-- The previous file dropped the old ones; between both files the tables stay closed, not open.

-- Functions: their bodies are text, so a rename does not reach them.
CREATE OR REPLACE FUNCTION booking_busy_slots(p_room_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(start_time timestamp with time zone, end_time timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT r.start_time, r.end_time
  FROM booking_reservations r
  WHERE r.room_id = p_room_id
    AND r.status IN ('pending', 'confirmed', 'checked_in')
    AND r.start_time < p_to
    AND r.end_time > p_from
  ORDER BY r.start_time
  LIMIT 1000
$function$;

-- Policies, with the new names and the core's English helpers.
DROP POLICY IF EXISTS booking_notes_owner_de_reserva ON booking_notes;
DROP POLICY IF EXISTS booking_notes_reservation_owner ON booking_notes;
CREATE POLICY booking_notes_reservation_owner ON booking_notes AS PERMISSIVE FOR SELECT USING (((NOT COALESCE(is_internal, false)) AND (EXISTS ( SELECT 1
   FROM booking_reservations r
  WHERE ((r.id = booking_notes.booking_id) AND (r.user_id = current_setting('app.current_user_id'::text, true)))))));
DROP POLICY IF EXISTS booking_notes_insercion ON booking_notes;
DROP POLICY IF EXISTS booking_notes_insert ON booking_notes;
CREATE POLICY booking_notes_insert ON booking_notes AS RESTRICTIVE FOR INSERT WITH CHECK ((((COALESCE(current_setting('app.current_user_id'::text, true), ''::text) = ''::text) AND (COALESCE(current_setting('app.current_user_role'::text, true), ''::text) = ''::text)) OR (kitsuden_effective_staff('booking'::text) OR kitsuden_agent_can_in_kon('booking'::text, 'booking:listAll'::text) OR kitsuden_agent_can_in_kon('booking'::text, 'booking:manage'::text)) OR ((NOT COALESCE(is_internal, false)) AND (EXISTS ( SELECT 1
   FROM booking_reservations r
  WHERE ((r.id = booking_notes.booking_id) AND (r.user_id = current_setting('app.current_user_id'::text, true))))))));
DROP POLICY IF EXISTS booking_notes_staff ON booking_notes;
CREATE POLICY booking_notes_staff ON booking_notes AS PERMISSIVE FOR ALL USING ((kitsuden_effective_staff('booking'::text) OR kitsuden_agent_can_in_kon('booking'::text, 'booking:listAll'::text) OR kitsuden_agent_can_in_kon('booking'::text, 'booking:manage'::text))) WITH CHECK ((kitsuden_effective_staff('booking'::text) OR kitsuden_agent_can_in_kon('booking'::text, 'booking:listAll'::text) OR kitsuden_agent_can_in_kon('booking'::text, 'booking:manage'::text)));
DROP POLICY IF EXISTS booking_reservations_staff ON booking_reservations;
CREATE POLICY booking_reservations_staff ON booking_reservations AS PERMISSIVE FOR ALL USING ((kitsuden_effective_staff('booking'::text) OR kitsuden_agent_can_in_kon('booking'::text, 'booking:listAll'::text) OR kitsuden_agent_can_in_kon('booking'::text, 'booking:manage'::text))) WITH CHECK ((kitsuden_effective_staff('booking'::text) OR kitsuden_agent_can_in_kon('booking'::text, 'booking:listAll'::text) OR kitsuden_agent_can_in_kon('booking'::text, 'booking:manage'::text)));

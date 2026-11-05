-- Rename tables to the kon prefix
-- ----------------------------------------------------------------------------
--
-- WATCH OUT for renames that "change nothing": this file used to have
--
--     ALTER TABLE IF EXISTS booking_notes RENAME TO booking_notes;  -- no change needed
--     ALTER TYPE  booking_status RENAME TO booking_status;          -- already correct
--
-- and neither of them is harmless. Postgres does NOT treat "rename to the same
-- name" as a no-op: it checks that the target is free and fails with
--
--     ERROR:  relation "booking_notes" already exists
--
-- Since the name was already correct, `0000_initial.sql` had just created that
-- table, so the chain ALWAYS blew up, on every new install, right after having
-- created everything correctly. The lines were removed: a rename that is not
-- needed is written by not writing it.

ALTER TABLE IF EXISTS rooms RENAME TO booking_rooms;
ALTER TABLE IF EXISTS amenities RENAME TO booking_amenities;
ALTER TABLE IF EXISTS room_amenities RENAME TO booking_room_amenities;
ALTER TABLE IF EXISTS bookings RENAME TO booking_reservations;
ALTER TABLE IF EXISTS blackout_dates RENAME TO booking_blackout_dates;

-- Rename enums (PostgreSQL syntax)
-- Note: rename only works if no columns reference the enum. If they do, 
-- we need to create new enum, alter columns, drop old.
DO $$
BEGIN
  -- `booking_status` already has the right name; there is nothing to rename.
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'room_type')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'booking_room_type') THEN
    ALTER TYPE room_type RENAME TO booking_room_type;
  END IF;
  
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'room_status')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'booking_room_status') THEN
    ALTER TYPE room_status RENAME TO booking_room_status;
  END IF;
  
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'recurrence_type')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'booking_recurrence_type') THEN
    ALTER TYPE recurrence_type RENAME TO booking_recurrence_type;
  END IF;
END $$;

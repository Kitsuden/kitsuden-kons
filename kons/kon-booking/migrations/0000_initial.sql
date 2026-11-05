-- Booking Kon - Initial Migration
-- This migration creates booking tables with conflict-safe checks

-- Create enums only if they don't exist
DO $$
BEGIN
    -- Booking status enum
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'booking_status') THEN
        CREATE TYPE booking_status AS ENUM (
            'pending',
            'confirmed',
            'checked_in',
            'checked_out',
            'cancelled',
            'rejected',
            'no_show'
        );
    END IF;

    -- Room type enum
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'room_type') THEN
        CREATE TYPE room_type AS ENUM (
            'meeting_room',
            'conference_room',
            'office',
            'desk',
            'studio',
            'event_space',
            'classroom',
            'auditorium',
            'other'
        );
    END IF;

    -- Room status enum
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'room_status') THEN
        CREATE TYPE room_status AS ENUM (
            'available',
            'maintenance',
            'closed',
            'reserved'
        );
    END IF;

    -- Recurrence type enum
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'recurrence_type') THEN
        CREATE TYPE recurrence_type AS ENUM (
            'none',
            'daily',
            'weekly',
            'monthly'
        );
    END IF;
END
$$;

-- Create rooms table
CREATE TABLE IF NOT EXISTS rooms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(200) NOT NULL,
    slug varchar(200) NOT NULL UNIQUE,
    description text,
    type room_type DEFAULT 'meeting_room' NOT NULL,
    status room_status DEFAULT 'available' NOT NULL,
    capacity integer DEFAULT 4 NOT NULL,
    location varchar(500),
    floor varchar(50),
    images jsonb DEFAULT '[]'::jsonb,
    cover_image_id uuid,
    hourly_rate decimal(10, 2),
    daily_rate decimal(10, 2),
    min_booking_hours integer DEFAULT 1,
    max_booking_hours integer DEFAULT 8,
    advance_booking_days integer DEFAULT 30,
    available_from time,
    available_until time,
    available_days jsonb DEFAULT '[1, 2, 3, 4, 5]'::jsonb,
    features jsonb DEFAULT '{}'::jsonb,
    requires_approval boolean DEFAULT false,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Create indexes for rooms
CREATE INDEX IF NOT EXISTS rooms_slug_idx ON rooms(slug);
CREATE INDEX IF NOT EXISTS rooms_type_idx ON rooms(type);
CREATE INDEX IF NOT EXISTS rooms_status_idx ON rooms(status);
CREATE INDEX IF NOT EXISTS rooms_capacity_idx ON rooms(capacity);
CREATE INDEX IF NOT EXISTS rooms_active_idx ON rooms(is_active);

-- Create amenities table
CREATE TABLE IF NOT EXISTS amenities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(100) NOT NULL,
    icon varchar(50),
    description text,
    category varchar(50),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS amenities_category_idx ON amenities(category);

-- Create room_amenities junction table
CREATE TABLE IF NOT EXISTS room_amenities (
    room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    amenity_id uuid NOT NULL REFERENCES amenities(id) ON DELETE CASCADE,
    quantity integer DEFAULT 1,
    notes text,
    PRIMARY KEY (room_id, amenity_id)
);

-- Create bookings table
CREATE TABLE IF NOT EXISTS bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id uuid,
    booked_for_name varchar(200),
    booked_for_email varchar(255),
    booked_for_phone varchar(50),
    organization_id uuid,
    department_id uuid,
    title varchar(500) NOT NULL,
    description text,
    event_type varchar(100),
    start_time timestamp with time zone NOT NULL,
    end_time timestamp with time zone NOT NULL,
    timezone varchar(50) DEFAULT 'UTC',
    status booking_status DEFAULT 'pending' NOT NULL,
    recurrence recurrence_type DEFAULT 'none' NOT NULL,
    recurrence_end_date date,
    parent_booking_id uuid,
    expected_attendees integer DEFAULT 1,
    max_attendees integer,
    attendees jsonb DEFAULT '[]'::jsonb,
    requested_amenities jsonb DEFAULT '[]'::jsonb,
    special_requests text,
    hourly_rate decimal(10, 2),
    total_hours decimal(5, 2),
    total_amount decimal(10, 2),
    approved_by_id uuid,
    approved_at timestamp with time zone,
    rejection_reason text,
    checked_in_at timestamp with time zone,
    checked_in_by_id uuid,
    checked_out_at timestamp with time zone,
    reminder_sent_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    cancelled_by_id uuid,
    cancellation_reason text,
    source varchar(50) DEFAULT 'web',
    external_calendar_id varchar(255),
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Create indexes for bookings
CREATE INDEX IF NOT EXISTS bookings_room_idx ON bookings(room_id);
CREATE INDEX IF NOT EXISTS bookings_user_idx ON bookings(user_id);
CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings(status);
CREATE INDEX IF NOT EXISTS bookings_time_idx ON bookings(start_time, end_time);
CREATE INDEX IF NOT EXISTS bookings_start_idx ON bookings(start_time);
CREATE INDEX IF NOT EXISTS bookings_end_idx ON bookings(end_time);
CREATE INDEX IF NOT EXISTS bookings_recurrence_idx ON bookings(parent_booking_id);
CREATE INDEX IF NOT EXISTS bookings_organization_idx ON bookings(organization_id);

-- Create booking_notes table
CREATE TABLE IF NOT EXISTS booking_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    user_id uuid,
    note text NOT NULL,
    is_internal boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS booking_notes_booking_idx ON booking_notes(booking_id);

-- Create blackout_dates table
CREATE TABLE IF NOT EXISTS blackout_dates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    start_date timestamp with time zone NOT NULL,
    end_date timestamp with time zone NOT NULL,
    reason varchar(500),
    is_recurring boolean DEFAULT false,
    created_by_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS blackout_room_idx ON blackout_dates(room_id);
CREATE INDEX IF NOT EXISTS blackout_dates_idx ON blackout_dates(start_date, end_date);

/**
 * Kitsuden CMS — Booking Engine Schema
 *
 * Drizzle ORM schema for room reservations with conflict detection,
 * amenities management, and booking workflows.
 */

import { relations } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  date,
  time,
  decimal,
  jsonb,
  uniqueIndex,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";

// ═══════════════════════════════════════════════
// Enums
// ═══════════════════════════════════════════════

export const bookingStatusEnum = pgEnum("booking_status", [
  "pending", // Awaiting confirmation
  "confirmed", // Confirmed booking
  "checked_in", // Guest checked in
  "checked_out", // Guest checked out
  "cancelled", // Cancelled by user
  "rejected", // Rejected by admin
  "no_show", // Guest didn't show up
]);

export const roomTypeEnum = pgEnum("booking_room_type", [
  "meeting_room",
  "conference_room",
  "office",
  "desk",
  "studio",
  "event_space",
  "classroom",
  "auditorium",
  "other",
]);

export const roomStatusEnum = pgEnum("booking_room_status", [
  "available",
  "maintenance",
  "closed",
  "reserved",
]);

export const recurrenceTypeEnum = pgEnum("booking_recurrence_type", [
  "none",
  "daily",
  "weekly",
  "monthly",
]);

// ═══════════════════════════════════════════════
// Rooms Table
// ═══════════════════════════════════════════════

export const rooms = pgTable(
  "booking_rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 200 }).notNull().unique(),
    description: text("description"),

    // Room classification
    type: roomTypeEnum("type").default("meeting_room").notNull(),
    status: roomStatusEnum("status").default("available").notNull(),

    // Capacity
    capacity: integer("capacity").default(4).notNull(),

    // Location
    location: varchar("location", { length: 500 }), // Floor, building, etc.
    floor: varchar("floor", { length: 50 }),

    // Media
    images: jsonb("images").$type<Array<{ mediaId: string; caption?: string }>>().default([]),
    coverImageId: uuid("cover_image_id"), // References media.id

    // Pricing (optional)
    hourlyRate: decimal("hourly_rate", { precision: 10, scale: 2 }),
    dailyRate: decimal("daily_rate", { precision: 10, scale: 2 }),

    // Booking settings
    minBookingHours: integer("min_booking_hours").default(1),
    maxBookingHours: integer("max_booking_hours").default(8),
    advanceBookingDays: integer("advance_booking_days").default(30), // How many days in advance

    // Availability windows
    availableFrom: time("available_from"), // e.g., "08:00:00"
    availableUntil: time("available_until"), // e.g., "18:00:00"
    availableDays: jsonb("available_days").$type<number[]>().default([1, 2, 3, 4, 5]), // 0=Sun, 6=Sat

    // Features
    features: jsonb("features").$type<RoomFeatures>().default({}),

    // Settings
    requiresApproval: boolean("requires_approval").default(false),
    isActive: boolean("is_active").default(true).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  ((t: any) => [
    uniqueIndex("booking_rooms_slug_idx").on(t.slug),
    index("booking_rooms_type_idx").on(t.type),
    index("booking_rooms_status_idx").on(t.status),
    index("booking_rooms_capacity_idx").on(t.capacity),
    index("booking_rooms_active_idx").on(t.isActive),
  ]) as any
);

export interface RoomFeatures {
  hasProjector?: boolean;
  hasWhiteboard?: boolean;
  hasVideoConferencing?: boolean;
  hasAudioSystem?: boolean;
  hasParking?: boolean;
  wheelchairAccessible?: boolean;
  naturalLight?: boolean;
  airConditioning?: boolean;
  wifi?: boolean;
  refreshments?: boolean;
  catering?: boolean;
  [key: string]: boolean | undefined;
}

// ═══════════════════════════════════════════════
// Amenities Table (Many-to-Many with Rooms)
// ═══════════════════════════════════════════════

export const amenities = pgTable(
  "booking_amenities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 100 }).notNull(),
    icon: varchar("icon", { length: 50 }), // Icon name or emoji
    description: text("description"),
    category: varchar("category", { length: 50 }), // tech, comfort, accessibility, etc.
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  ((t: any) => [index("booking_amenities_category_idx").on(t.category)]) as any
);

export const roomAmenities = pgTable(
  "booking_room_amenities",
  {
    roomId: uuid("room_id")
      .references(() => rooms.id, { onDelete: "cascade" })
      .notNull(),
    amenityId: uuid("amenity_id")
      .references(() => amenities.id, { onDelete: "cascade" })
      .notNull(),
    quantity: integer("quantity").default(1),
    notes: text("notes"),
  },
  ((t: any) => [uniqueIndex("booking_room_amenity_unique").on(t.roomId, t.amenityId)]) as any
);

// ═══════════════════════════════════════════════
// Bookings Table
// ═══════════════════════════════════════════════

export const bookings = pgTable(
  "booking_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Room reference
    roomId: uuid("room_id")
      .references(() => rooms.id, { onDelete: "cascade" })
      .notNull(),

    // User references
    // `text`, not `uuid`: better-auth ids (auth_users.id) are not UUIDs.
    userId: text("user_id"), // References auth_users.id - person who made the booking
    bookedForName: varchar("booked_for_name", { length: 200 }), // Name of person/guest
    bookedForEmail: varchar("booked_for_email", { length: 255 }),
    bookedForPhone: varchar("booked_for_phone", { length: 50 }),

    // Organization
    organizationId: uuid("organization_id"), // References organizations.id
    departmentId: uuid("department_id"), // References departments.id

    // Event details
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description"),
    eventType: varchar("event_type", { length: 100 }), // meeting, workshop, interview, etc.

    // Timing
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),
    endTime: timestamp("end_time", { withTimezone: true }).notNull(),
    timezone: varchar("timezone", { length: 50 }).default("UTC"),

    // Status & workflow
    status: bookingStatusEnum("status").default("pending").notNull(),

    // Recurrence
    recurrence: recurrenceTypeEnum("recurrence").default("none").notNull(),
    recurrenceEndDate: date("recurrence_end_date"),
    parentBookingId: uuid("parent_booking_id"), // For recurring series

    // Attendees
    expectedAttendees: integer("expected_attendees").default(1),
    maxAttendees: integer("max_attendees"), // For capacity planning
    attendees: jsonb("attendees").$type<BookingAttendee[]>().default([]),

    // Requirements
    requestedAmenities: jsonb("requested_amenities").$type<string[]>().default([]), // amenity IDs
    specialRequests: text("special_requests"),

    // Pricing (if applicable)
    hourlyRate: decimal("hourly_rate", { precision: 10, scale: 2 }),
    totalHours: decimal("total_hours", { precision: 5, scale: 2 }),
    totalAmount: decimal("total_amount", { precision: 10, scale: 2 }),

    // Approval workflow
    approvedById: text("approved_by_id"), // References auth_users.id
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),

    // Check-in/out
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    checkedInById: text("checked_in_by_id"),
    checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),

    // Reminders
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),

    // Cancellation
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledById: text("cancelled_by_id"),
    cancellationReason: text("cancellation_reason"),

    // Metadata
    source: varchar("source", { length: 50 }).default("web"), // web, api, admin, calendar_sync
    externalCalendarId: varchar("external_calendar_id", { length: 255 }), // Google/Outlook calendar ID
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  ((t: any) => [
    index("booking_reservations_room_idx").on(t.roomId),
    index("booking_reservations_user_idx").on(t.userId),
    index("booking_reservations_status_idx").on(t.status),
    index("booking_reservations_time_idx").on(t.startTime, t.endTime),
    index("booking_reservations_start_idx").on(t.startTime),
    index("booking_reservations_end_idx").on(t.endTime),
    index("booking_reservations_recurrence_idx").on(t.parentBookingId),
    index("booking_reservations_organization_idx").on(t.organizationId),
  ]) as any
);

export interface BookingAttendee {
  id: string;
  name: string;
  email: string;
  phone?: string;
  isOrganizer?: boolean;
  status?: "pending" | "accepted" | "declined" | "tentative";
}

// ═══════════════════════════════════════════════
// Booking Notes/Activity Log
// ═══════════════════════════════════════════════

export const bookingNotes = pgTable(
  "booking_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .references(() => bookings.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id"), // References auth_users.id
    note: text("note").notNull(),
    isInternal: boolean("is_internal").default(false), // Not visible to guest
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  ((t: any) => [index("booking_notes_booking_idx").on(t.bookingId)]) as any
);

// ═══════════════════════════════════════════════
// Blackout Dates (Room unavailability)
// ═══════════════════════════════════════════════

export const blackoutDates = pgTable(
  "booking_blackout_dates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .references(() => rooms.id, { onDelete: "cascade" })
      .notNull(),
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    endDate: timestamp("end_date", { withTimezone: true }).notNull(),
    reason: varchar("reason", { length: 500 }),
    isRecurring: boolean("is_recurring").default(false),
    createdById: text("created_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  ((t: any) => [
    index("booking_blackout_room_idx").on(t.roomId),
    index("booking_blackout_dates_idx").on(t.startDate, t.endDate),
  ]) as any
);

// ═══════════════════════════════════════════════
// Relations
// ═══════════════════════════════════════════════

export const roomsRelations = relations(rooms, ({ many }) => ({
  amenities: many(roomAmenities),
  bookings: many(bookings),
  blackoutDates: many(blackoutDates),
}));

export const amenitiesRelations = relations(amenities, ({ many }) => ({
  rooms: many(roomAmenities),
}));

export const roomAmenitiesRelations = relations(roomAmenities, ({ one }) => ({
  room: one(rooms, {
    fields: [roomAmenities.roomId],
    references: [rooms.id],
  }),
  amenity: one(amenities, {
    fields: [roomAmenities.amenityId],
    references: [amenities.id],
  }),
}));

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  room: one(rooms, {
    fields: [bookings.roomId],
    references: [rooms.id],
  }),
  parentBooking: one(bookings, {
    fields: [bookings.parentBookingId],
    references: [bookings.id],
  }),
  notes: many(bookingNotes),
}));

export const bookingNotesRelations = relations(bookingNotes, ({ one }) => ({
  booking: one(bookings, {
    fields: [bookingNotes.bookingId],
    references: [bookings.id],
  }),
}));

export const blackoutDatesRelations = relations(blackoutDates, ({ one }) => ({
  room: one(rooms, {
    fields: [blackoutDates.roomId],
    references: [rooms.id],
  }),
}));

// ═══════════════════════════════════════════════
// Type Exports
// ═══════════════════════════════════════════════

export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;
export type Amenity = typeof amenities.$inferSelect;
export type NewAmenity = typeof amenities.$inferInsert;
export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
export type BookingNote = typeof bookingNotes.$inferSelect;
export type NewBookingNote = typeof bookingNotes.$inferInsert;
export type BlackoutDate = typeof blackoutDates.$inferSelect;
export type NewBlackoutDate = typeof blackoutDates.$inferInsert;

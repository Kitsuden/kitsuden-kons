/**
 * Kitsuden CMS — Booking Engine Routes
 * ============================================================================
 *
 * Rooms, services, availability and bookings.
 *
 * ── WHAT WAS CLOSED (security review 2026-10-15) ───────────────────────────
 *
 * Before this review the kon treated "having an account" as "being on the team" and
 * read personal data without a session. What could be done, with public sign-up:
 *
 *   · `GET /bookings` and `GET /bookings/:id` WITHOUT a session: all bookings with
 *     the guest's name, email and phone, attendees and internal notes.
 *   · `GET /my-bookings?userId=<other>`: anyone's bookings (IDOR).
 *   · Any account: create/edit/DELETE rooms, block dates, approve or
 *     reject other people's bookings, check in, cancel other people's.
 *   · `POST /bookings` with `hourlyRate: 0` → free booking (the price came
 *     from the body), `userId` in another person's name, free-form `metadata`.
 *   · `GET /bookings` cached by the query: one user's response was
 *     served to another.
 *   · Ids that are not UUIDs and invalid dates → 500 with the Postgres error.
 *
 * Now: authorization with `can()` (booking.policy.ts), body validated with an
 * allowlist (the SDK rejects unknown fields, like `validateRequest`),
 * actor ids come from the session, RLS with the context set per request
 * (booking.context.ts) and errors with the engine's envelope.
 *
 * Since 2026-10-26 each route is a kon SDK OPERATION (operations.ts):
 * each handler's body is the old one; what were middlewares
 * (`validateRequest`, `managesRooms`) is now its declaration.
 */

import {
  AppError,
  authorize,
  can,
  eqEnum,
  isUuid,
  respondError,
  operationsRouter,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { eq, and, or, gte, lte, gt, lt, sql, asc, desc, inArray, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { rlsContext, dbDe, userOf } from "./booking.context";
import type { BookingDb } from "./booking.db";
import { isStaff, registerBookingPolicy } from "./booking.policy";
import { MANAGES_ROOMS, MANAGES_ROOMS_IN_HANDLER, KON_ID, registry } from "./operations";
import {
  rooms,
  amenities,
  roomAmenities,
  bookings,
  bookingNotes,
  blackoutDates,
} from "./booking.schema";

registerBookingPolicy();

type Booking = typeof bookings.$inferSelect;

/** Statuses that occupy the room. */
const OCCUPYING = ["pending", "confirmed", "checked_in"] as const;

function getMediaTransformUrl(
  mediaId: string | null | undefined,
  preset: "thumbnail" | "small" | "medium" | "large" | "hero"
): string | null {
  if (!mediaId) return null;
  return `/api/media/preset/${mediaId}/${preset}`;
}

function transformRoomImages<
  T extends {
    coverImageId?: string | null;
    images?: Array<{ mediaId: string; caption?: string }> | null;
  },
>(
  room: T
): T & { coverImageUrl: string | null; imageUrls: Array<{ url: string; caption?: string }> } {
  return {
    ...room,
    coverImageUrl: getMediaTransformUrl(room.coverImageId, "medium"),
    imageUrls:
      room.images?.map((img) => ({
        url: getMediaTransformUrl(img.mediaId, "small")!,
        caption: img.caption,
      })) || [],
  };
}

/**
 * What the OWNER sees of their booking. It removes the ids of the staff who approved it or
 * checked it in and the desk's internal `metadata`.
 */
function forOwner(b: Booking) {
  const { approvedById, checkedInById, cancelledById, metadata, externalCalendarId, ...rest } = b;
  void approvedById;
  void checkedInById;
  void cancelledById;
  void metadata;
  void externalCalendarId;
  return rest;
}

function view(user: ReturnType<typeof userOf>, b: Booking) {
  return isStaff(user) ? b : forOwner(b);
}

/** Overlap of [start, end) with the given columns. */
function overlaps(startCol: AnyPgColumn, colFin: AnyPgColumn, start: Date, fin: Date) {
  return and(lt(startCol, fin), gt(colFin, start));
}

/**
 * Occupied slots of a room, WITHOUT data on who occupies them.
 *
 * With RLS, a user only sees their own bookings; if the conflict check
 * queried the table, it would not see other people's and the room would end up
 * booked twice. The SECURITY DEFINER function of migration 0002 reads
 * all of them and returns only start and end.
 */
async function takenSlots(
  db: BookingDb,
  roomId: string,
  from: Date,
  until: Date
): Promise<Array<{ startTime: Date; endTime: Date }>> {
  const res = await db.execute(
    sql`select start_time, end_time from booking_busy_slots(${roomId}::uuid, ${from.toISOString()}::timestamptz, ${until.toISOString()}::timestamptz)`
  );
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Array<{
    start_time: string | Date;
    end_time: string | Date;
  }>;
  return rows.map((f) => ({ startTime: new Date(f.start_time), endTime: new Date(f.end_time) }));
}

// ── Input schemas (allowlist) ────────────────────────────────────────────────

const DateField = z.string().datetime({ offset: true });
const Uuid = z.guid();
const Hour = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "HH:MM format");
const Money = z
  .union([z.number().nonnegative().max(1e8), z.string().regex(/^\d{1,8}(\.\d{1,2})?$/)])
  .transform((v) => String(v));
const Text = (max: number) => z.string().trim().max(max);

const ImageField = z.object({ mediaId: Uuid, caption: Text(300).optional() });
const Features = z
  .record(z.string().max(60), z.boolean())
  .refine((r) => Object.keys(r).length <= 50, "Maximum 50 features");

const RoomBase = {
  name: Text(200).min(1),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(200),
  description: Text(5000).nullable(),
  type: z.enum([
    "meeting_room",
    "conference_room",
    "office",
    "desk",
    "studio",
    "event_space",
    "classroom",
    "auditorium",
    "other",
  ]),
  status: z.enum(["available", "maintenance", "closed", "reserved"]),
  capacity: z.number().int().min(1).max(100000),
  location: Text(500).nullable(),
  floor: Text(50).nullable(),
  images: z.array(ImageField).max(50),
  coverImageId: Uuid.nullable(),
  hourlyRate: Money.nullable(),
  dailyRate: Money.nullable(),
  minBookingHours: z
    .number()
    .int()
    .min(0)
    .max(24 * 365),
  maxBookingHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365),
  advanceBookingDays: z.number().int().min(0).max(3650),
  availableFrom: Hour.nullable(),
  availableUntil: Hour.nullable(),
  availableDays: z.array(z.number().int().min(0).max(6)).max(7),
  features: Features,
  requiresApproval: z.boolean(),
  amenityIds: z.array(Uuid).max(100),
};

const CreateRoom = z.object(RoomBase).partial().required({ name: true });
const EditRoom = z.object({ ...RoomBase, isActive: z.boolean() }).partial();

const CreateService = z.object({
  name: Text(100).min(1),
  icon: Text(50).optional(),
  description: Text(2000).optional(),
  category: Text(50).optional(),
});

const Attendee = z.object({
  id: z.string().max(100),
  name: Text(200),
  email: z.string().email().max(255),
  phone: Text(50).optional(),
  isOrganizer: z.boolean().optional(),
  status: z.enum(["pending", "accepted", "declined", "tentative"]).optional(),
});

const CreateBooking = z.object({
  roomId: Uuid,
  title: Text(500).min(1),
  description: Text(5000).optional(),
  eventType: Text(100).optional(),
  startTime: DateField,
  endTime: DateField,
  timezone: Text(50).optional(),
  expectedAttendees: z.number().int().min(1).max(100000).optional(),
  attendees: z.array(Attendee).max(200).optional(),
  requestedAmenities: z.array(Uuid).max(50).optional(),
  specialRequests: Text(2000).optional(),
  bookedForName: Text(200).optional(),
  bookedForEmail: z.string().email().max(255).optional(),
  bookedForPhone: Text(50).optional(),
});

const EditBooking = z.object({
  title: Text(500).min(1).optional(),
  description: Text(5000).nullable().optional(),
  eventType: Text(100).nullable().optional(),
  expectedAttendees: z.number().int().min(1).max(100000).optional(),
  attendees: z.array(Attendee).max(200).optional(),
  specialRequests: Text(2000).nullable().optional(),
  // Staff only: the handler checks it.
  status: z
    .enum(["pending", "confirmed", "checked_in", "checked_out", "cancelled", "rejected", "no_show"])
    .optional(),
  rejectionReason: Text(2000).optional(),
  cancellationReason: Text(2000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const Cancel = z.object({ reason: Text(2000).optional() });
const Note = z.object({ note: Text(5000).min(1), isInternal: z.boolean().optional() });
const Blocking = z.object({
  startDate: DateField,
  endDate: DateField,
  reason: Text(500).optional(),
  isRecurring: z.boolean().optional(),
});

// ── Parameters, query and outputs (OpenAPI and MCP) ──────────────────────────
//
// Ids go as text: the handler gives 404 to whatever is not a uuid (or, in a
// room's record, looks it up as a slug). Validating them here would turn that 404
// into a 422. The query, with `passthrough`: unknown keys used to be ignored.

const ParamId = z.object({
  id: z.string().describe("Room id (uuid); `GET /rooms/:id` also takes the slug"),
});
const BookingParam = z.object({ id: z.string().describe("Booking id (uuid)") });
const BlockParam = z.object({ blackoutId: z.string().describe("Blackout id (uuid)") });

const FreeQuery = z.object({}).passthrough();

/** A row (room, service, booking, note, block): loose on purpose. */
const Row = z.object({ id: z.string() }).passthrough();
const RowList = z.object({ docs: z.array(Row) }).passthrough();
const ListWithTotal = z.object({ docs: z.array(Row), totalDocs: z.number().int() }).passthrough();

function validId(id: string | undefined, that: string): string {
  if (!id || !isUuid(id)) throw AppError.notFound(`${that} not found`);
  return id;
}

function dateFromQuery(value: string | undefined, name: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw AppError.badRequest(`${name} is not a valid date`);
  return d;
}

function limitOf(value: string | undefined, defaultValue = 50, max = 100): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return defaultValue;
  return Math.min(n, max);
}

function offsetDe(value: string | undefined): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : 0;
}

/**
 * The kon's operations, in the order in which the routes were registered (the
 * same resolution order as before).
 */
export function bookingOperations(ctx: KonContext): AnyOperation[] {
  const bookingRoutes = registry();
  const { cache } = ctx;

  const invalidateCache = async (pattern: string) => {
    try {
      await cache.invalidate(pattern);
    } catch {
      // The cache is auxiliary: if it is not there, the next read goes to the database.
    }
  };

  const requireSession = (c: Context) => {
    const user = userOf(c);
    if (!user) throw AppError.unauthenticated();
    return user;
  };

  async function loadBooking(db: BookingDb, id: string | undefined): Promise<Booking> {
    const [b] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, validId(id, "Reservation")))
      .limit(1);
    // 404 both if it does not exist and if RLS hides it: its existence is not confirmed.
    if (!b) throw AppError.notFound("Booking not found");
    return b;
  }

  /** 404 —not 403— when it cannot be seen: do not confirm that the booking exists. */
  async function visibleBooking(c: Context, id: string | undefined): Promise<Booking> {
    const b = await loadBooking(dbDe(c), id);
    if (!(await can(userOf(c), "view", b, "booking"))) {
      throw AppError.notFound("Booking not found");
    }
    return b;
  }

  // ═══════════════════════════════════════════════
  // ROOMS
  // ═══════════════════════════════════════════════

  bookingRoutes.get(
    "/rooms",
    {
      id: "list-rooms",
      summary: "List bookable rooms",
      description:
        "Active rooms ordered by name (up to 500), with cover and image URLs. Filters: `type`, `minCapacity`, `maxCapacity` and `features` (comma-separated feature keys that must be true). Public.",
      access: "public",
      input: {
        query: z
          .object({
            type: z.string().optional().describe("Room type (meeting_room, office, studio…)"),
            minCapacity: z.string().optional(),
            maxCapacity: z.string().optional(),
            features: z.string().optional().describe("Comma-separated feature keys, max 20"),
          })
          .passthrough(),
      },
      output: { schema: ListWithTotal },
    },
    async (c) => {
      const query = c.req.query();
      const minCapacity = query.minCapacity ? Number.parseInt(query.minCapacity, 10) : null;
      const maxCapacity = query.maxCapacity ? Number.parseInt(query.maxCapacity, 10) : null;
      const features = (query.features?.split(",") ?? []).filter(Boolean).slice(0, 20);
      if (features.some((f) => f.length > 60)) throw AppError.badRequest("Invalid feature");

      const conditions = [eq(rooms.isActive, true)];
      const typeFilter = eqEnum(rooms.type, query.type);
      if (typeFilter) conditions.push(typeFilter);
      if (minCapacity && Number.isFinite(minCapacity))
        conditions.push(gte(rooms.capacity, minCapacity));
      if (maxCapacity && Number.isFinite(maxCapacity))
        conditions.push(lte(rooms.capacity, maxCapacity));
      for (const feature of features) {
        conditions.push(sql`${rooms.features}->>${feature} = 'true'`);
      }

      const roomList = await dbDe(c)
        .select({
          id: rooms.id,
          name: rooms.name,
          slug: rooms.slug,
          description: rooms.description,
          type: rooms.type,
          status: rooms.status,
          capacity: rooms.capacity,
          location: rooms.location,
          floor: rooms.floor,
          coverImageId: rooms.coverImageId,
          images: rooms.images,
          hourlyRate: rooms.hourlyRate,
          features: rooms.features,
          requiresApproval: rooms.requiresApproval,
        })
        .from(rooms)
        .where(and(...conditions))
        .orderBy(asc(rooms.name))
        .limit(500);

      const docs = roomList.map((room) => transformRoomImages(room));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  bookingRoutes.get(
    "/rooms/:id",
    {
      id: "get-room",
      summary: "Read a room",
      description:
        "One room by id or slug, with its amenities and image URLs. With `include_bookings=true` it adds the next occupied slots: staff get the next 10 confirmed bookings (id, title, times, status); anyone else only start and end times. An inactive room is a 404 except for staff.",
      access: "optional",
      input: {
        params: ParamId,
        query: z
          .object({
            include_bookings: z.string().optional().describe("`true` to add upcoming bookings"),
          })
          .passthrough(),
      },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const id = c.req.param("id");
      const user = userOf(c);
      const db = dbDe(c);
      const includeBookings = c.req.query("include_bookings") === "true";

      const [room] = await db
        .select()
        .from(rooms)
        .where(isUuid(id) ? eq(rooms.id, id) : eq(rooms.slug, id))
        .limit(1);

      if (!room || !(await can(user, "view", room, "booking-room"))) {
        throw AppError.notFound("Room not found");
      }

      const roomAmenitiesList = await db
        .select({
          id: amenities.id,
          name: amenities.name,
          icon: amenities.icon,
          description: amenities.description,
          category: amenities.category,
          quantity: roomAmenities.quantity,
          notes: roomAmenities.notes,
        })
        .from(roomAmenities)
        .innerJoin(amenities, eq(roomAmenities.amenityId, amenities.id))
        .where(eq(roomAmenities.roomId, room.id));

      const result: Record<string, unknown> = transformRoomImages({
        ...room,
        amenities: roomAmenitiesList,
      });

      if (includeBookings) {
        // For whoever is not staff, only the occupied SLOTS: the title and id of
        // someone else's booking are another person's data.
        if (isStaff(user)) {
          result.upcomingBookings = await db
            .select({
              id: bookings.id,
              title: bookings.title,
              startTime: bookings.startTime,
              endTime: bookings.endTime,
              status: bookings.status,
            })
            .from(bookings)
            .where(
              and(
                eq(bookings.roomId, room.id),
                gte(bookings.endTime, new Date()),
                eq(bookings.status, "confirmed")
              )
            )
            .orderBy(asc(bookings.startTime))
            .limit(10);
        } else {
          const now = new Date();
          const inOneYear = new Date(now.getTime() + 366 * 24 * 60 * 60 * 1000);
          result.upcomingBookings = (await takenSlots(db, room.id, now, inOneYear)).slice(
            0,
            10
          );
        }
      }

      return c.json(result);
    }
  );

  /**
   * The PERMISSION before the body (phase D fixes, 2026-10-25): with validation
   * first, an account without permission got a 422 for an empty body
   * and learned the schema of a route that is not theirs. While the core's gate
   * only let the admin in this went unnoticed; now that the route is open
   * to whoever has a session, a 403 does not wait for a 422.
   *
   * It was the `managesRooms` middleware; now it is the operation's `permission`
   * (`MANAGES_ROOMS`), which the SDK checks before reading the body.
   */
  bookingRoutes.post(
    "/rooms",
    {
      id: "create-room",
      summary: "Create a room",
      description:
        "Creates a bookable room (name required; slug derived from the name if absent, 409 if taken) and links its amenities (`amenityIds`). Prices come from here, never from a booking. Staff only (admin or editor, or an agent with the whole kon).",
      access: "session",
      permission: MANAGES_ROOMS,
      input: { body: CreateRoom },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      // The permission was already checked by the operation, before the body (`MANAGES_ROOMS`).
      const body = input.body as z.infer<typeof CreateRoom>;
      const db = dbDe(c);

      const slug =
        body.slug ||
        body.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 200);
      if (!slug) throw AppError.validation("The name does not produce a valid slug");

      const [existing] = await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(eq(rooms.slug, slug))
        .limit(1);
      if (existing) throw AppError.conflict("A room with that slug already exists");

      const [room] = await db
        .insert(rooms)
        .values({
          name: body.name,
          slug,
          description: body.description ?? null,
          type: body.type ?? "meeting_room",
          status: body.status ?? "available",
          capacity: body.capacity ?? 4,
          location: body.location ?? null,
          floor: body.floor ?? null,
          images: body.images ?? [],
          coverImageId: body.coverImageId ?? null,
          hourlyRate: body.hourlyRate ?? null,
          dailyRate: body.dailyRate ?? null,
          minBookingHours: body.minBookingHours ?? 1,
          maxBookingHours: body.maxBookingHours ?? 8,
          advanceBookingDays: body.advanceBookingDays ?? 30,
          availableFrom: body.availableFrom ?? null,
          availableUntil: body.availableUntil ?? null,
          availableDays: body.availableDays ?? [1, 2, 3, 4, 5],
          features: body.features ?? {},
          requiresApproval: body.requiresApproval ?? false,
        })
        .returning();

      if (body.amenityIds?.length) {
        await db.insert(roomAmenities).values(
          Array.from(new Set(body.amenityIds)).map((amenityId) => ({
            roomId: room.id,
            amenityId,
            quantity: 1,
          }))
        );
      }

      await invalidateCache("rooms:*");
      return c.json(room, 201);
    }
  );

  bookingRoutes.patch(
    "/rooms/:id",
    {
      id: "update-room",
      summary: "Edit a room",
      description:
        "Partial update of a room (any create field plus `isActive`). `amenityIds`, when sent, replaces the room's amenity list. 409 if the new slug is taken. Staff only (admin or editor, or an agent with the whole kon).",
      access: "session",
      // Checked after validating the body, as always on this route.
      permission: MANAGES_ROOMS_IN_HANDLER,
      input: { params: ParamId, body: EditRoom },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      await h.authorize({ isActive: true }, "manage");
      const id = validId(c.req.param("id"), "Room");
      const body = input.body as z.infer<typeof EditRoom>;
      const db = dbDe(c);

      const { amenityIds, ...fields } = body;
      if (fields.slug !== undefined) {
        const [existing] = await db
          .select({ id: rooms.id })
          .from(rooms)
          .where(and(eq(rooms.slug, fields.slug), sql`${rooms.id} <> ${id}`))
          .limit(1);
        if (existing) throw AppError.conflict("A room with that slug already exists");
      }

      const [updated] = await db
        .update(rooms)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(rooms.id, id))
        .returning();
      if (!updated) throw AppError.notFound("Room not found");

      if (amenityIds !== undefined) {
        await db.delete(roomAmenities).where(eq(roomAmenities.roomId, id));
        if (amenityIds.length > 0) {
          await db.insert(roomAmenities).values(
            Array.from(new Set(amenityIds)).map((amenityId) => ({
              roomId: id,
              amenityId,
              quantity: 1,
            }))
          );
        }
      }

      await invalidateCache("rooms:*");
      return c.json(updated);
    }
  );

  bookingRoutes.delete(
    "/rooms/:id",
    {
      id: "delete-room",
      summary: "Delete a room",
      description:
        "Deletes a room and, in cascade, ALL its bookings, notes, amenity links and blackouts. Cannot be undone. Admin only: a human admin account or an agent with `admin`, `booking:*`, `kon:booking:*` or `kon:booking:delete-room` (editors cannot).",
      access: "session",
      input: { params: ParamId },
      output: { schema: z.object({ success: z.boolean(), id: z.string() }) },
      errors: ["KITSUDEN_E_FORBIDDEN", "KITSUDEN_E_NOT_FOUND"],
      // Deleting a room cascades ALL its bookings: the effective admin, through the policy
      // (`booking-room:deleteRoom`), so an agent with the kon's scopes passes too.
      permission: { policy: { resource: "booking-room", action: "deleteRoom" } },
    },
    async (c) => {
      const id = validId(c.req.param("id"), "Room");

      const [deleted] = await dbDe(c).delete(rooms).where(eq(rooms.id, id)).returning();
      if (!deleted) throw AppError.notFound("Room not found");

      await invalidateCache("rooms:*");
      return c.json({ success: true, id: deleted.id });
    }
  );

  // ═══════════════════════════════════════════════
  // AMENITIES
  // ═══════════════════════════════════════════════

  bookingRoutes.get(
    "/amenities",
    {
      id: "list-services",
      summary: "List amenities",
      description:
        "Active amenities (projector, whiteboard…) ordered by name, up to 500, optionally filtered by `category`. Public.",
      access: "public",
      input: {
        query: z.object({ category: z.string().optional() }).passthrough(),
      },
      output: { schema: RowList },
    },
    async (c) => {
      const category = c.req.query("category");
      const conditions = [eq(amenities.isActive, true)];
      if (category) conditions.push(eq(amenities.category, category.slice(0, 50)));

      const list = await dbDe(c)
        .select()
        .from(amenities)
        .where(and(...conditions))
        .orderBy(asc(amenities.name))
        .limit(500);

      return c.json({ docs: list });
    }
  );

  bookingRoutes.post(
    "/amenities",
    {
      id: "create-service",
      summary: "Create an amenity",
      description:
        "Creates an amenity (name, optional icon, description and category) that rooms can then list in `amenityIds`. Staff only (admin or editor, or an agent with the whole kon).",
      access: "session",
      permission: MANAGES_ROOMS,
      input: { body: CreateService },
      output: { status: 201, schema: Row },
    },
    async (c, input) => {
      // The permission was already checked by the operation, before the body (`MANAGES_ROOMS`).
      const body = input.body as z.infer<typeof CreateService>;
      const [amenity] = await dbDe(c).insert(amenities).values(body).returning();
      return c.json(amenity, 201);
    }
  );

  // ═══════════════════════════════════════════════
  // AVAILABILITY
  // ═══════════════════════════════════════════════

  bookingRoutes.get(
    "/availability",
    {
      id: "check-availability",
      summary: "Check whether a room is free",
      description:
        "Whether a room can be booked between `startTime` and `endTime` (ISO 8601, all three required). If free: the room, the duration and the estimated cost at the room's hourly rate. If not: the reason; staff also get the ids of the clashing bookings and the blackout details.",
      access: "optional",
      input: {
        query: z
          .object({
            roomId: z.string().optional().describe("Room id (uuid)"),
            startTime: z.string().optional().describe("ISO 8601"),
            endTime: z.string().optional().describe("ISO 8601"),
          })
          .passthrough(),
      },
      output: { schema: z.object({ available: z.boolean() }).passthrough() },
    },
    async (c) => {
      const user = userOf(c);
      const db = dbDe(c);
      const roomId = c.req.query("roomId");
      const startTime = dateFromQuery(c.req.query("startTime"), "startTime");
      const endTime = dateFromQuery(c.req.query("endTime"), "endTime");

      if (!roomId || !startTime || !endTime) {
        throw AppError.badRequest("roomId, startTime and endTime are required");
      }
      if (endTime <= startTime) throw AppError.badRequest("endTime must be after startTime");
      if (!isUuid(roomId))
        return c.json({ available: false, reason: "Room not found or inactive" });

      const [room] = await db
        .select()
        .from(rooms)
        .where(and(eq(rooms.id, roomId), eq(rooms.isActive, true)))
        .limit(1);

      if (!room) return c.json({ available: false, reason: "Room not found or inactive" });
      if (room.status !== "available") {
        return c.json({ available: false, reason: `Room is ${room.status}` });
      }

      const occupied = await takenSlots(db, roomId, startTime, endTime);
      if (occupied.length > 0) {
        // The ids of the conflicting bookings, for staff only.
        const ids = isStaff(user)
          ? (
              await db
                .select({ id: bookings.id })
                .from(bookings)
                .where(
                  and(
                    eq(bookings.roomId, roomId),
                    overlaps(bookings.startTime, bookings.endTime, startTime, endTime),
                    inArray(bookings.status, [...OCCUPYING])
                  )
                )
                .limit(50)
            ).map((b) => b.id)
          : null;
        return c.json({
          available: false,
          reason: "Time slot is already booked",
          ...(ids ? { conflictingBookings: ids } : {}),
        });
      }

      const blackouts = await db
        .select({
          id: blackoutDates.id,
          startDate: blackoutDates.startDate,
          endDate: blackoutDates.endDate,
          reason: blackoutDates.reason,
        })
        .from(blackoutDates)
        .where(
          and(
            eq(blackoutDates.roomId, roomId),
            overlaps(blackoutDates.startDate, blackoutDates.endDate, startTime, endTime)
          )
        )
        .limit(50);

      if (blackouts.length > 0) {
        return c.json({
          available: false,
          reason: "Room is unavailable during this time",
          blackoutPeriods: isStaff(user)
            ? blackouts
            : blackouts.map((b) => ({ startDate: b.startDate, endDate: b.endDate })),
        });
      }

      const durationMs = endTime.getTime() - startTime.getTime();
      const durationHours = durationMs / (1000 * 60 * 60);
      const totalAmount = room.hourlyRate
        ? (Number.parseFloat(room.hourlyRate) * durationHours).toFixed(2)
        : null;

      return c.json({
        available: true,
        room: transformRoomImages({
          id: room.id,
          name: room.name,
          capacity: room.capacity,
          hourlyRate: room.hourlyRate,
          coverImageId: room.coverImageId,
          images: room.images,
        }),
        duration: {
          hours: Math.round(durationHours * 100) / 100,
          minutes: Math.round(durationMs / (1000 * 60)),
        },
        estimatedCost: totalAmount,
      });
    }
  );

  bookingRoutes.get(
    "/rooms/:id/slots",
    {
      id: "list-room-slots",
      summary: "Bookable time slots of a room for one day",
      description:
        "Slots every 30 minutes within the room's opening hours (UTC; 08:00-18:00 by default) for `date` (YYYY-MM-DD, today by default), each lasting `duration` minutes (15-1440, 60 by default), marked available or not. Says nothing about who booked. Public.",
      access: "public",
      input: {
        params: ParamId,
        query: z
          .object({
            date: z.string().optional().describe("YYYY-MM-DD (UTC)"),
            duration: z.string().optional().describe("Minutes, 15-1440"),
          })
          .passthrough(),
      },
      output: {
        schema: z.object({
          roomId: z.string(),
          date: z.string(),
          durationMinutes: z.number().int(),
          slots: z.array(z.object({ start: z.string(), end: z.string(), available: z.boolean() })),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const id = validId(c.req.param("id"), "Room");
      const db = dbDe(c);
      const date = c.req.query("date") || new Date().toISOString().split("T")[0];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date).getTime())) {
        throw AppError.badRequest("date must have the format YYYY-MM-DD");
      }
      const duration = Number.parseInt(c.req.query("duration") || "60", 10);
      if (!Number.isFinite(duration) || duration < 15 || duration > 24 * 60) {
        throw AppError.badRequest("duration must be between 15 and 1440 minutes");
      }

      const [room] = await db
        .select()
        .from(rooms)
        .where(and(eq(rooms.id, id), eq(rooms.isActive, true)))
        .limit(1);
      if (!room) throw AppError.notFound("Room not found");

      // Everything in UTC: `new Date("YYYY-MM-DD")` is midnight UTC, and with
      // `setHours` (the server's LOCAL time) a server west of UTC
      // returned the slots of the PREVIOUS day (phase D, 2026-10-25). The room's
      // hours are read in UTC, like all the dates the API returns.
      const requestedDate = new Date(`${date}T00:00:00.000Z`);
      const dayStart = new Date(requestedDate);
      const dayEnd = new Date(requestedDate);
      dayEnd.setUTCHours(23, 59, 59, 999);
      const closing = new Date(requestedDate);

      const existingBookings = await takenSlots(db, id, dayStart, dayEnd);

      const slots: Array<{ start: string; end: string; available: boolean }> = [];
      const slotDuration = 30;
      const startHour = room.availableFrom
        ? Number.parseInt(room.availableFrom.split(":")[0], 10)
        : 8;
      const endHour = room.availableUntil
        ? Number.parseInt(room.availableUntil.split(":")[0], 10)
        : 18;
      closing.setUTCHours(endHour, 0, 0, 0);

      for (let hour = startHour; hour < endHour; hour++) {
        for (let minute = 0; minute < 60; minute += slotDuration) {
          const slotStart = new Date(requestedDate);
          slotStart.setUTCHours(hour, minute, 0, 0);
          const slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);

          const hasConflict = existingBookings.some((booking) => {
            const bs = new Date(booking.startTime);
            const be = new Date(booking.endTime);
            return slotStart < be && slotEnd > bs;
          });

          // It must end within THAT day's hours (instants, not `getHours()`).
          if (slotEnd.getTime() <= closing.getTime()) {
            slots.push({
              start: slotStart.toISOString(),
              end: slotEnd.toISOString(),
              available: !hasConflict,
            });
          }
        }
      }

      return c.json({ roomId: id, date, durationMinutes: duration, slots });
    }
  );

  // ═══════════════════════════════════════════════
  // BOOKINGS
  // ═══════════════════════════════════════════════

  /**
   * List of bookings. A user sees THEIR OWN (the query's `userId` filter
   * is ignored for them); staff see all and can filter. No cache: the
   * response depends on who is asking.
   */
  bookingRoutes.get(
    "/bookings",
    {
      id: "list-reservations",
      summary: "List bookings",
      description:
        "Bookings, newest start first, with the room name. An account sees only ITS OWN (the `userId` filter is ignored for it); staff see everyone's and may filter by `userId`. Other filters: `roomId`, `status`, `startAfter`, `startBefore` (ISO 8601), `limit` (max 100) and `offset`.",
      access: "session",
      input: {
        query: z
          .object({
            userId: z.string().optional().describe("Staff only"),
            roomId: z.string().optional(),
            status: z.string().optional(),
            startAfter: z.string().optional(),
            startBefore: z.string().optional(),
            limit: z.string().optional(),
            offset: z.string().optional(),
          })
          .passthrough(),
      },
      output: { schema: ListWithTotal },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const user = requireSession(c);
      const query = c.req.query();
      const staff = await can(user, "listAll", null, "booking");

      const conditions: SQL[] = [];
      if (!staff) conditions.push(eq(bookings.userId, user.id!));
      else if (query.userId) conditions.push(eq(bookings.userId, query.userId.slice(0, 200)));
      if (query.roomId) conditions.push(eq(bookings.roomId, validId(query.roomId, "Room")));
      const statusFilter = eqEnum(bookings.status, query.status);
      if (statusFilter) conditions.push(statusFilter);
      const startAfter = dateFromQuery(query.startAfter, "startAfter");
      const startBefore = dateFromQuery(query.startBefore, "startBefore");
      if (startAfter) conditions.push(gte(bookings.startTime, startAfter));
      if (startBefore) conditions.push(lte(bookings.startTime, startBefore));

      const db = dbDe(c);
      const bookingList = await db
        .select({
          id: bookings.id,
          roomId: bookings.roomId,
          userId: bookings.userId,
          title: bookings.title,
          eventType: bookings.eventType,
          startTime: bookings.startTime,
          endTime: bookings.endTime,
          status: bookings.status,
          expectedAttendees: bookings.expectedAttendees,
          createdAt: bookings.createdAt,
        })
        .from(bookings)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(bookings.startTime))
        .limit(limitOf(query.limit))
        .offset(offsetDe(query.offset));

      const roomIds = Array.from(new Set(bookingList.map((b) => b.roomId)));
      const roomData = roomIds.length
        ? await db
            .select({ id: rooms.id, name: rooms.name, coverImageId: rooms.coverImageId })
            .from(rooms)
            .where(inArray(rooms.id, roomIds))
        : [];
      const roomMap = new Map(roomData.map((r) => [r.id, r]));

      return c.json({
        docs: bookingList.map((b) => {
          const roomInfo = roomMap.get(b.roomId);
          return {
            ...b,
            roomName: roomInfo?.name,
            roomCoverImageUrl: getMediaTransformUrl(roomInfo?.coverImageId, "thumbnail"),
          };
        }),
        totalDocs: bookingList.length,
      });
    }
  );

  bookingRoutes.get(
    "/bookings/:id",
    {
      id: "get-reservation",
      summary: "Read a booking",
      description:
        "One booking with its room and notes. The owner sees it without staff fields and without internal notes; staff see everything. Someone else's booking is a 404 (its existence is not confirmed).",
      access: "session",
      input: { params: BookingParam },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      requireSession(c);
      const user = userOf(c);
      const booking = await visibleBooking(c, c.req.param("id"));
      const db = dbDe(c);

      const [room] = await db
        .select({
          id: rooms.id,
          name: rooms.name,
          location: rooms.location,
          capacity: rooms.capacity,
          coverImageId: rooms.coverImageId,
        })
        .from(rooms)
        .where(eq(rooms.id, booking.roomId))
        .limit(1);

      const viewInternal = await can(user, "viewInternalNotes", booking, "booking");
      const notes = await db
        .select()
        .from(bookingNotes)
        .where(
          viewInternal
            ? eq(bookingNotes.bookingId, booking.id)
            : and(eq(bookingNotes.bookingId, booking.id), eq(bookingNotes.isInternal, false))
        )
        .orderBy(desc(bookingNotes.createdAt))
        .limit(200);

      return c.json({
        ...view(user, booking),
        room: room ? transformRoomImages(room) : null,
        notes,
      });
    }
  );

  bookingRoutes.post(
    "/bookings",
    {
      id: "create-reservation",
      summary: "Book a room",
      description:
        "Books a room in the caller's name (the user comes from the session, the price from the room). Confirmed at once, or pending when the room requires approval. 404 if the room does not exist or is inactive; 409 if it is not available, overlaps another booking or a blackout; 422 for past times or limits of the room (duration, advance days, capacity).",
      access: "session",
      input: { body: CreateBooking },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const user = requireSession(c);
      await authorize(user, "create", null, "booking");
      const body = input.body as z.infer<typeof CreateBooking>;
      const db = dbDe(c);

      const startTime = new Date(body.startTime);
      const endTime = new Date(body.endTime);
      if (endTime <= startTime) throw AppError.validation("endTime must be after startTime");
      if (startTime.getTime() < Date.now() - 5 * 60 * 1000) {
        throw AppError.validation("Cannot book in the past");
      }

      // FOR UPDATE: serializes bookings of the SAME room. Without the lock, two
      // simultaneous requests both passed the conflict check and
      // the room ended up booked twice.
      const [room] = await db
        .select()
        .from(rooms)
        .where(and(eq(rooms.id, body.roomId), eq(rooms.isActive, true)))
        .limit(1)
        .for("update");
      if (!room) throw AppError.notFound("Room not found or inactive");
      if (room.status !== "available") throw AppError.conflict(`The room is ${room.status}`);

      const durationHours = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);
      if (room.maxBookingHours && durationHours > room.maxBookingHours) {
        throw AppError.validation(`The booking cannot last more than ${room.maxBookingHours} h`);
      }
      if (room.minBookingHours && durationHours < room.minBookingHours) {
        throw AppError.validation(`The booking must last at least ${room.minBookingHours} h`);
      }
      if (
        room.advanceBookingDays !== null &&
        room.advanceBookingDays !== undefined &&
        startTime.getTime() > Date.now() + room.advanceBookingDays * 24 * 60 * 60 * 1000
      ) {
        throw AppError.validation(
          `Booking is only possible with ${room.advanceBookingDays} days of notice`
        );
      }
      if (body.expectedAttendees && body.expectedAttendees > room.capacity) {
        throw AppError.validation(`The room holds ${room.capacity} people`);
      }

      if ((await takenSlots(db, body.roomId, startTime, endTime)).length > 0) {
        throw AppError.conflict("The time slot overlaps with another booking");
      }

      const [blocking] = await db
        .select({ id: blackoutDates.id })
        .from(blackoutDates)
        .where(
          and(
            eq(blackoutDates.roomId, body.roomId),
            overlaps(blackoutDates.startDate, blackoutDates.endDate, startTime, endTime)
          )
        )
        .limit(1);
      if (blocking) throw AppError.conflict("The room is not available at that time");

      // The price ALWAYS comes from the room, never from the body.
      const hourlyRate = room.hourlyRate;
      const totalAmount = hourlyRate
        ? (Number.parseFloat(hourlyRate) * durationHours).toFixed(2)
        : null;

      const [booking] = await db
        .insert(bookings)
        .values({
          roomId: body.roomId,
          userId: user.id!, // from the session, never from the body
          bookedForName: body.bookedForName,
          bookedForEmail: body.bookedForEmail,
          bookedForPhone: body.bookedForPhone,
          title: body.title,
          description: body.description,
          eventType: body.eventType,
          startTime,
          endTime,
          timezone: body.timezone || "UTC",
          status: room.requiresApproval ? "pending" : "confirmed",
          expectedAttendees: body.expectedAttendees ?? 1,
          attendees: body.attendees ?? [],
          requestedAmenities: body.requestedAmenities ?? [],
          specialRequests: body.specialRequests,
          hourlyRate,
          totalHours: durationHours.toFixed(2),
          totalAmount,
          source: "web",
          metadata: {},
        })
        .returning();

      await invalidateCache(`rooms:${body.roomId}*`);
      return c.json(view(user, booking), 201);
    }
  );

  bookingRoutes.patch(
    "/bookings/:id",
    {
      id: "update-reservation",
      summary: "Edit a booking",
      description:
        "Updates the descriptive fields of a booking. The owner may edit while pending or confirmed and may only change `status` to cancelled; staff may change any status (approve, reject, check-in/out, no-show) and `metadata`/`rejectionReason` (403 for anyone else). Someone else's booking is a 404.",
      access: "session",
      input: { params: BookingParam, body: EditBooking },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
    },
    async (c, input) => {
      const user = requireSession(c);
      const existing = await visibleBooking(c, c.req.param("id"));
      await authorize(user, "update", existing, "booking");
      const body = input.body as z.infer<typeof EditBooking>;
      const staff = await can(user, "manage", existing, "booking");

      const staffOnly = ["metadata", "rejectionReason"] as const;
      if (!staff && staffOnly.some((k) => body[k] !== undefined)) {
        throw AppError.forbidden("Only staff can change that field");
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      for (const k of [
        "title",
        "description",
        "eventType",
        "expectedAttendees",
        "attendees",
        "specialRequests",
        "metadata",
      ] as const) {
        if (body[k] !== undefined) updates[k] = body[k];
      }

      if (body.status !== undefined && body.status !== existing.status) {
        // The owner can only cancel; the rest of the workflow belongs to the front desk.
        if (!staff && body.status !== "cancelled") {
          throw AppError.forbidden("Only staff can change a booking's status");
        }
        updates.status = body.status;
        switch (body.status) {
          case "confirmed":
            updates.approvedById = user.id;
            updates.approvedAt = new Date();
            break;
          case "cancelled":
            updates.cancelledAt = new Date();
            updates.cancelledById = user.id;
            updates.cancellationReason = body.cancellationReason ?? null;
            break;
          case "rejected":
            updates.rejectionReason = body.rejectionReason ?? null;
            break;
          case "checked_in":
            updates.checkedInAt = new Date();
            updates.checkedInById = user.id;
            break;
          case "checked_out":
            updates.checkedOutAt = new Date();
            break;
        }
      }

      const [updated] = await dbDe(c)
        .update(bookings)
        .set(updates)
        .where(eq(bookings.id, existing.id))
        .returning();

      await invalidateCache(`rooms:${existing.roomId}*`);
      return c.json(view(user, updated));
    }
  );

  bookingRoutes.post(
    "/bookings/:id/cancel",
    {
      id: "cancel-reservation",
      summary: "Cancel a booking",
      description:
        "Cancels a booking with an optional `reason`. The owner, while it is pending or confirmed; staff, always. Someone else's booking is a 404; a booking its owner can no longer cancel is a 403.",
      access: "session",
      input: { params: BookingParam, body: Cancel },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
    },
    async (c, input) => {
      const user = requireSession(c);
      const existing = await visibleBooking(c, c.req.param("id"));
      await authorize(user, "cancel", existing, "booking");
      const body = input.body as z.infer<typeof Cancel>;

      const [updated] = await dbDe(c)
        .update(bookings)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledById: user.id,
          cancellationReason: body.reason ?? null,
          updatedAt: new Date(),
        })
        .where(eq(bookings.id, existing.id))
        .returning();

      await invalidateCache(`rooms:${existing.roomId}*`);
      return c.json(view(user, updated));
    }
  );

  bookingRoutes.post(
    "/bookings/:id/check-in",
    {
      id: "check-in",
      summary: "Check a booking in",
      description:
        "Marks a confirmed booking as checked in, recording who did it (from the session). Staff only (403 for the owner); 400 if the booking is not confirmed; someone else's booking is a 404 for a non-staff account.",
      access: "session",
      input: { params: BookingParam },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN", "KITSUDEN_E_BAD_REQUEST"],
    },
    async (c) => {
      const user = requireSession(c);
      const existing = await visibleBooking(c, c.req.param("id"));
      await authorize(user, "manage", existing, "booking");
      if (existing.status !== "confirmed") {
        throw AppError.badRequest(`Cannot check in with status ${existing.status}`);
      }

      const [updated] = await dbDe(c)
        .update(bookings)
        .set({
          status: "checked_in",
          checkedInAt: new Date(),
          checkedInById: user.id,
          updatedAt: new Date(),
        })
        .where(eq(bookings.id, existing.id))
        .returning();
      return c.json(updated);
    }
  );

  bookingRoutes.post(
    "/bookings/:id/check-out",
    {
      id: "check-out",
      summary: "Check a booking out",
      description:
        "Marks a checked-in booking as checked out. Staff only (403 for the owner); 400 if the booking is not checked in; someone else's booking is a 404 for a non-staff account.",
      access: "session",
      input: { params: BookingParam },
      output: { schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN", "KITSUDEN_E_BAD_REQUEST"],
    },
    async (c) => {
      const user = requireSession(c);
      const existing = await visibleBooking(c, c.req.param("id"));
      await authorize(user, "manage", existing, "booking");
      if (existing.status !== "checked_in") {
        throw AppError.badRequest(`Cannot check out with status ${existing.status}`);
      }

      const [updated] = await dbDe(c)
        .update(bookings)
        .set({ status: "checked_out", checkedOutAt: new Date(), updatedAt: new Date() })
        .where(eq(bookings.id, existing.id))
        .returning();
      return c.json(updated);
    }
  );

  bookingRoutes.post(
    "/bookings/:id/notes",
    {
      id: "annotate-reservation",
      summary: "Add a note to a booking",
      description:
        "Adds a note to a booking: the owner or staff. `isInternal: true` (hidden from the owner) is staff only (403). Someone else's booking is a 404.",
      access: "session",
      input: { params: BookingParam, body: Note },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN"],
    },
    async (c, input) => {
      const user = requireSession(c);
      const existing = await visibleBooking(c, c.req.param("id"));
      await authorize(user, "addNote", existing, "booking");
      const body = input.body as z.infer<typeof Note>;

      const internal = body.isInternal === true;
      if (internal && !(await can(user, "viewInternalNotes", existing, "booking"))) {
        throw AppError.forbidden("Only staff can write internal notes");
      }

      const [note] = await dbDe(c)
        .insert(bookingNotes)
        .values({ bookingId: existing.id, userId: user.id!, note: body.note, isInternal: internal })
        .returning();
      return c.json(note, 201);
    }
  );

  // ═══════════════════════════════════════════════
  // BLACKOUT DATES
  // ═══════════════════════════════════════════════

  bookingRoutes.get(
    "/rooms/:id/blackout",
    {
      id: "list-blackouts",
      summary: "Blackout periods of a room",
      description:
        "Periods in which a room cannot be booked, ordered by start (up to 500). Staff also see the reason and who created them.",
      access: "optional",
      input: { params: ParamId },
      output: { schema: RowList },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const id = validId(c.req.param("id"), "Room");
      const staff = isStaff(userOf(c));
      const list = await dbDe(c)
        .select()
        .from(blackoutDates)
        .where(eq(blackoutDates.roomId, id))
        .orderBy(asc(blackoutDates.startDate))
        .limit(500);

      return c.json({
        docs: staff
          ? list
          : list.map((b) => ({
              id: b.id,
              roomId: b.roomId,
              startDate: b.startDate,
              endDate: b.endDate,
              isRecurring: b.isRecurring,
            })),
      });
    }
  );

  bookingRoutes.post(
    "/rooms/:id/blackout",
    {
      id: "create-blackout",
      summary: "Block a room for a period",
      description:
        "Creates a blackout period (`startDate` to `endDate`, ISO 8601, optional reason and recurrence) in which the room cannot be booked. Existing bookings are not touched. Staff only (admin or editor, or an agent with the whole kon).",
      access: "session",
      permission: MANAGES_ROOMS,
      input: { params: ParamId, body: Blocking },
      output: { status: 201, schema: Row },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      // The permission was already checked by the operation, before the body (`MANAGES_ROOMS`).
      const user = userOf(c);
      const id = validId(c.req.param("id"), "Room");
      const body = input.body as z.infer<typeof Blocking>;
      const startDate = new Date(body.startDate);
      const endDate = new Date(body.endDate);
      if (endDate <= startDate) throw AppError.validation("endDate must be after startDate");

      const db = dbDe(c);
      const [room] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, id)).limit(1);
      if (!room) throw AppError.notFound("Room not found");

      const [blackout] = await db
        .insert(blackoutDates)
        .values({
          roomId: id,
          startDate,
          endDate,
          reason: body.reason,
          isRecurring: body.isRecurring ?? false,
          createdById: user!.id,
        })
        .returning();

      await invalidateCache(`rooms:${id}*`);
      return c.json(blackout, 201);
    }
  );

  bookingRoutes.delete(
    "/blackout/:blackoutId",
    {
      id: "delete-blackout",
      summary: "Remove a blackout period",
      description:
        "Deletes a blackout period, making the room bookable again in it. Staff only (admin or editor, or an agent with the whole kon).",
      access: "session",
      permission: MANAGES_ROOMS,
      input: { params: BlockParam },
      output: { schema: z.object({ success: z.boolean() }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      // The permission is checked by the operation (`MANAGES_ROOMS`): 403 before 404, as before.
      const blackoutId = validId(c.req.param("blackoutId"), "Blackout");

      const [deleted] = await dbDe(c)
        .delete(blackoutDates)
        .where(eq(blackoutDates.id, blackoutId))
        .returning();
      if (!deleted) throw AppError.notFound("Block not found");

      await invalidateCache("rooms:*");
      return c.json({ success: true });
    }
  );

  // ═══════════════════════════════════════════════
  // MY BOOKINGS — the user comes from the SESSION
  // ═══════════════════════════════════════════════

  /**
   * It used to read `?userId=` from the query and did not require a session: anyone, without an
   * account, listed any person's bookings. The parameter is ignored.
   */
  bookingRoutes.get(
    "/my-bookings",
    {
      id: "list-my-reservations",
      summary: "My upcoming bookings",
      description:
        "The caller's upcoming bookings (pending, confirmed or checked in, not yet ended), soonest first, with the room name. The user comes from the session; a `userId` in the query is ignored.",
      access: "session",
      input: { query: FreeQuery },
      output: { schema: RowList },
    },
    async (c) => {
      const user = requireSession(c);
      const db = dbDe(c);

      const upcoming = await db
        .select({
          id: bookings.id,
          roomId: bookings.roomId,
          title: bookings.title,
          startTime: bookings.startTime,
          endTime: bookings.endTime,
          status: bookings.status,
        })
        .from(bookings)
        .where(
          and(
            eq(bookings.userId, user.id!),
            gte(bookings.endTime, new Date()),
            or(...OCCUPYING.map((s) => eq(bookings.status, s)))
          )
        )
        .orderBy(asc(bookings.startTime))
        .limit(200);

      const roomIds = Array.from(new Set(upcoming.map((b) => b.roomId)));
      const roomData = roomIds.length
        ? await db
            .select({ id: rooms.id, name: rooms.name, coverImageId: rooms.coverImageId })
            .from(rooms)
            .where(inArray(rooms.id, roomIds))
        : [];
      const roomMap = new Map(roomData.map((r) => [r.id, r]));

      return c.json({
        docs: upcoming.map((b) => {
          const roomInfo = roomMap.get(b.roomId);
          return {
            ...b,
            roomName: roomInfo?.name,
            roomCoverImageUrl: getMediaTransformUrl(roomInfo?.coverImageId, "thumbnail"),
          };
        }),
      });
    }
  );

  return bookingRoutes.ops;
}

/**
 * The kon's router: the operations, behind what always went in front of
 * all the routes (the request's `db` and the session for `dbDe`/`userOf`,
 * booking.context.ts) and with errors in the engine's envelope (those that
 * are not `AppError`, like a SQLSTATE 23505 → 409, are translated by `respondError`).
 */
export function createBookingRouter(ctx: KonContext): Hono {
  const router = new Hono();
  const root = ctx.db.instance as BookingDb;

  router.onError((err, c) => respondError(c, err));
  router.use("*", rlsContext(root, ctx.auth));
  router.route("/", operationsRouter(KON_ID, bookingOperations(ctx), ctx));
  return router;
}

// Legacy export for backward compatibility
export { createBookingRouter as bookingRoutes };

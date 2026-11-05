# kon-booking

Room and resource booking for Kitsuden: rooms with amenities and opening hours, conflict-free
bookings, blackout periods and a front-desk workflow (approve, reject, check-in, check-out). For
teams whose members book shared spaces and a desk that manages them.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | business | 1.0.1 | `/api/booking` | kon-media; core `auth` |

## Install

Inside a Kitsuden project:

```bash
kitsuden kon add booking
```

`kon-media` is added with it (a dependency in `kon.json`). The manifest does not set
`defaultEnabled: false`, so `--enable` is not needed. Restart the API afterwards. No environment
variables are required.

## What it adds

- **Rooms** (`booking_rooms`): name, slug, type, status, capacity, location, images, hourly and
  daily rate, opening hours and days, minimum and maximum duration, booking window in days, a map
  of boolean features, and whether bookings need approval.
- **Amenities** (`booking_amenities`) and their link to rooms (`booking_room_amenities`, with a
  quantity and notes per room).
- **Bookings** (`booking_reservations`): who booked (always the caller), the room, start and end,
  status, attendees, requested amenities and the price computed from the room's hourly rate.
- **Booking notes** (`booking_notes`): public notes, and internal notes only staff see.
- **Blackout dates** (`booking_blackout_dates`): periods in which a room cannot be booked.

Room types: `meeting_room`, `conference_room`, `office`, `desk`, `studio`, `event_space`,
`classroom`, `auditorium`, `other`. Room statuses: `available`, `maintenance`, `closed`,
`reserved`; only `available` rooms take bookings.

Booking statuses: `pending` (room requires approval), `confirmed`, `checked_in`, `checked_out`,
`cancelled`, `rejected`, `no_show`. `pending`, `confirmed` and `checked_in` occupy the room.

A new booking is refused when it overlaps an occupying booking or a blackout period, starts in the
past, breaks the room's duration or advance-days limits, or exceeds its capacity. The overlap check
reads all bookings of the room through the database function `booking_busy_slots` (security
definer, returns only start and end), so a user cannot double-book a slot that row security hides
from them. The room row is locked (`FOR UPDATE`) while a booking is created.

The schema has recurrence columns (`recurrence`, `recurrence_end_date`, `parent_booking_id`) but
no route writes them: recurring bookings are not implemented.

## HTTP API

All paths are under `/api/booking`. "Staff" means a human admin or editor, or an agent whose key
opens the whole kon (see [Who can do what](#who-can-do-what)).

### Rooms, amenities and availability

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/booking/rooms` | any session (see note) | Active rooms by name, up to 500. Filters `type`, `minCapacity`, `maxCapacity`, `features` (comma-separated keys that must be true). |
| `GET /api/booking/rooms/:id` | any session (see note) | One room by id or slug, with amenities. `include_bookings=true` adds upcoming occupied slots (staff: id, title and status of the next 10 confirmed bookings). An inactive room is a 404 except for staff. |
| `POST /api/booking/rooms` | staff | Create a room (slug derived from the name if absent; 409 if taken). `amenityIds` links amenities. |
| `PATCH /api/booking/rooms/:id` | staff | Partial update, plus `isActive`. `amenityIds` replaces the amenity list. |
| `DELETE /api/booking/rooms/:id` | admin (not editors) | Delete a room and, in cascade, all its bookings, notes, amenity links and blackouts. |
| `GET /api/booking/rooms/:id/slots` | any session (see note) | 30-minute steps of `duration` minutes (15-1440, default 60) for `date` (YYYY-MM-DD, UTC) within the room's hours (default 08:00-18:00 UTC), each marked available or not. |
| `GET /api/booking/rooms/:id/blackout` | any session (see note) | Blackout periods of a room. Staff also see the reason and who created them. |
| `POST /api/booking/rooms/:id/blackout` | staff | Create a blackout period (`startDate`, `endDate`, optional `reason`, `isRecurring`). Existing bookings are not touched. |
| `DELETE /api/booking/blackout/:blackoutId` | staff | Remove a blackout period. |
| `GET /api/booking/amenities` | any session (see note) | Active amenities, optional `category` filter. |
| `POST /api/booking/amenities` | staff | Create an amenity. |
| `GET /api/booking/availability` | any session (see note) | `roomId`, `startTime`, `endTime` (all required): whether the slot is free, with duration and estimated cost; if not, the reason. Staff also get the clashing booking ids and blackout details. |

### Bookings

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/booking/bookings` | signed in | A user gets their own; staff get all and may filter by `userId`. Filters `roomId`, `status`, `startAfter`, `startBefore`, `limit` (max 100), `offset`. |
| `POST /api/booking/bookings` | signed in | Book a room in the caller's name: `confirmed`, or `pending` if the room requires approval. 404 unknown room, 409 conflict, 422 limits. |
| `GET /api/booking/bookings/:id` | owner or staff | One booking with room and notes. The owner does not see staff fields or internal notes. |
| `PATCH /api/booking/bookings/:id` | owner or staff | Edit descriptive fields. The owner (while pending or confirmed) may only change `status` to `cancelled`; staff may set any status, `metadata` and `rejectionReason`. |
| `POST /api/booking/bookings/:id/cancel` | owner or staff | Cancel with an optional `reason`. The owner only while pending or confirmed. |
| `POST /api/booking/bookings/:id/check-in` | staff | `confirmed` to `checked_in` (400 otherwise). |
| `POST /api/booking/bookings/:id/check-out` | staff | `checked_in` to `checked_out` (400 otherwise). |
| `POST /api/booking/bookings/:id/notes` | owner or staff | Add a note. `isInternal: true` is staff only. |
| `GET /api/booking/my-bookings` | signed in | The caller's upcoming occupying bookings. A `userId` query parameter is ignored. |

Bodies are strict: unknown fields (for example `userId` or `hourlyRate` on a booking) are a 422.
Ids that are not UUIDs are a 404, not a 500.

**Note on anonymous access.** Inside the kon, the room, amenity, slot, blackout and availability
reads are declared public or optional-session, so a host may open them. The standard Kitsuden host
deliberately does not: it puts the whole `/api/booking` prefix behind a session gate
(`{ prefix: "/api/booking", role: "session" }` in the core's `apps/api/src/middleware/auth-guard.ts`),
so an anonymous request gets 401 on every route. An agent passes that gate when it may act as a
user (`user:act`, `admin`, or a `booking` scope) or holds the operation's fine scope.

## Who can do what

The policy is `booking.policy.ts` (resources `booking-room` and `booking`); row security is in the
migrations (current rules in `migrations/0007_english_rls.sql`).

| Actor | Rooms, amenities, blackouts | Bookings |
| --- | --- | --- |
| Signed-in user | Read | Create in their own name; read, edit, cancel and add notes to their own |
| Staff: `admin` or `editor` account, or an agent with `admin`, `booking:*` or `kon:booking:*` | Create and edit | Read and manage all (approve, reject, check-in/out, internal notes) |
| Admin: `admin` account, or an agent with `admin`, `booking:*`, `kon:booking:*` or `kon:booking:delete-room` | Delete rooms | — |

Deleting a room goes through the policy action `booking-room:deleteRoom`
(`isEffectiveAdmin(user, "booking")`): editors are staff but cannot delete rooms, because the
delete cascades to every booking of the room.

In the database, `booking_reservations` and `booking_notes` have row security: a user sees only
their own rows; staff (`kitsuden_effective_staff('booking')`) and agents with `booking:listAll` or
`booking:manage` in this kon see all. Rooms, amenities and blackouts have no row security.

**404 instead of 403.** Someone else's booking answers 404 on read, edit, cancel, notes,
check-in and check-out, whether row security hid it or the policy refused it: its existence is not
confirmed. The owner gets 403 when the booking is theirs but the action is not (checking in,
writing an internal note, cancelling a booking that is no longer pending or confirmed).

## Configuration

None. The kon reads no environment variables or settings. Room defaults (08:00-18:00 UTC when no
hours are set, weekdays, 1-8 hours, 30 days ahead, capacity 4) are per room and set through the
API.

## Agents and MCP

Every route is a kon SDK operation, so each one is an MCP tool named `booking__<operation>` with
the fine scope `kon:booking:<operation>`. An agent also gets them with `booking:*`,
`kon:booking:*`, `admin`, or the policy scopes `<resource>:<action>` (for example
`booking-room:manage`, `booking:manage`).

| Operations | Writes |
| --- | --- |
| `list-rooms`, `get-room`, `list-room-slots`, `list-blackouts`, `list-services`, `check-availability` | no |
| `list-reservations`, `get-reservation`, `list-my-reservations` | no |
| `create-room`, `update-room`, `create-service`, `create-blackout` | yes |
| `create-reservation`, `update-reservation`, `cancel-reservation`, `check-in`, `check-out`, `annotate-reservation` | yes |
| `delete-room`, `delete-blackout` | yes, sensitive (DELETE) |

`delete-room` and `delete-blackout` are sensitive by default: when an admin turns on human
approval, an agent's call comes back `202 KITSUDEN_E_APPROVAL_REQUIRED`. An admin can mark other
operations sensitive in the panel. Details for agents: [AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/kon-booking-security.test.ts` | Roles, strict bodies, conflicts under row security, 404 for other people's bookings, internal notes, editor as staff, database RLS |
| `tests/unit/kon-booking-agent-delete-room.test.ts` | Room deletion through the policy (admin agents yes, editors no); anonymous public reads at kon level |
| `tests/unit/booking-slots-timezone.test.ts` | Slots computed in UTC on a server in another time zone |
| `tests/unit/effective-agents-in-kons.test.ts` | Agents with `admin`, `booking:*`, `kon:booking:*` see and manage all bookings |

From the repository root, one file at a time:

```bash
pnpm vitest run tests/unit/kon-booking-security.test.ts
pnpm vitest run tests/unit/kon-booking-agent-delete-room.test.ts
pnpm vitest run tests/unit/booking-slots-timezone.test.ts
pnpm vitest run tests/unit/effective-agents-in-kons.test.ts
```

## License

MIT

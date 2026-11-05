# AGENTS.md — kon-booking

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

Room booking mounted at `/api/booking`: rooms, amenities, blackout periods and bookings with a
front-desk workflow. A user books and manages their own bookings; staff (admin or editor, or an
agent opening the whole kon) manage rooms and every booking. Human docs: [README.md](README.md).

## Calling it

- **Gate first.** The host requires a session on all of `/api/booking`. An agent key passes when
  it may act as a user (`user:act`, `admin`, or any `booking:`/`kon:booking:` scope) or holds the
  fine scope of the operation it calls.
- **Read as a user:** `kon:booking:list-rooms`, `kon:booking:get-room`,
  `kon:booking:check-availability`, `kon:booking:list-room-slots`,
  `kon:booking:list-my-reservations`. These see rooms and the agent's own bookings only.
- **Book:** `kon:booking:create-reservation` (plus `kon:booking:cancel-reservation`,
  `kon:booking:update-reservation`, `kon:booking:annotate-reservation` for the agent's own
  bookings). The booking is made in the agent's own id.
- **Front desk (all bookings, rooms, blackouts):** `booking:*` or `kon:booking:*` (or `admin`).
  Without them, the agent is not staff: `list-reservations` returns only its own bookings and
  other bookings are 404. The policy scopes `booking:listAll` / `booking:manage` also open the
  rows in the database.
- **MCP tools** are `booking__<operation>`, one per route (ids in `booking.routes.ts`). Path and
  query parameters go flat; the body goes whole under `body`. Reads return `{ docs, totalDocs }`
  or a single row; writes return the row written; deletes return `{ success, id }` or
  `{ success }`.
- **Approval.** `booking__delete-room` and `booking__delete-blackout` are DELETE operations,
  sensitive by default. With human approval on, they (and any operation an admin marks) come back
  `202 KITSUDEN_E_APPROVAL_REQUIRED`: report the proposal, do not retry.
- **404** on a booking means "not yours, or does not exist"; the kon does not say which. A
  non-UUID id is also a 404. On a room, 404 means missing or inactive (inactive is visible to
  staff).
- **Idempotency.** POST and PATCH are not idempotent: send `Idempotency-Key` over REST or
  `idempotency_key` over MCP when retrying `create-reservation`, or the retry may hit 409 against
  your own first booking.
- **Refused on purpose:**
  - `userId`, `hourlyRate`, `totalAmount` or `status` in a new booking: 422 (strict body). The
    user comes from the session and the price from the room.
  - Deleting a room without `admin`, `booking:*`, `kon:booking:*` or
    `kon:booking:delete-room`: 403 (policy action `booking-room:deleteRoom`). Editors are staff
    but cannot delete rooms, because the delete cascades to every booking.
  - A non-staff caller setting a status other than `cancelled`, or `metadata`/`rejectionReason`:
    403. Internal notes from a non-staff caller: 403.
  - Booking a past slot, beyond `advanceBookingDays`, outside min/max hours or over capacity: 422.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | `defineKonSdk` definition: id, version, tables and admin views from `kon.json`, startup table check, `createRouter` |
| `kon.json` | Manifest: id, version, mount path, tables, admin grid views, dependency on kon-media |
| `operations.ts` | `KON_ID`, the `registry()` that turns `get/post/...` calls into SDK operations, `MANAGES_ROOMS` permissions |
| `booking.routes.ts` | Every operation (rooms, amenities, availability, slots, bookings, notes, blackouts, my-bookings) and `createBookingRouter` |
| `booking.policy.ts` | `booking-room` and `booking` policies; `isStaff` = `isEffectiveStaff(user, "booking")`; `deleteRoom` = `isEffectiveAdmin(user, "booking")` |
| `booking.context.ts` | `rlsContext`, `dbDe` (the request's RLS transaction) and `userOf` |
| `booking.db.ts` | `BookingDb` type: Drizzle database typed with the schema |
| `booking.schema.ts` | Drizzle tables and enums (`booking_*`) |
| `migrations/` | SQL migrations 0000-0007 and `history.json` |
| `package.json`, `tsconfig.json` | Package metadata and shipped files; TypeScript config |

## Rules that must hold

- **The user and the price come from the server.** `create-reservation` sets `userId` from the
  session and `hourlyRate`/`totalAmount` from the room; the body schema rejects them.
  Guard: `tests/unit/kon-booking-security.test.ts` ("userId in the body is REJECTED", "hourlyRate
  in the body is REJECTED").
- **No double booking under row security.** The overlap check goes through
  `booking_busy_slots` (security definer, `migrations/0007_english_rls.sql`), never through a
  plain select, and the room row is locked `FOR UPDATE`. Guard: "B can NOT book over A even though
  RLS hides A's booking from them".
- **The occupancy function returns only start and end.** Guard: "the occupancy function returns
  no personal data".
- **Other people's bookings are 404, not 403** (`visibleBooking` in `booking.routes.ts`). Guard:
  "B does not see, edit, cancel or annotate A's booking: 404".
- **Anonymous and non-staff never see who booked.** `get-room` and `check-availability` return
  only slots to non-staff. Guard: "the room's public record gives occupied slots, NOT titles or
  ids".
- **Staff is one rule in code and database:** `isEffectiveStaff(user, "booking")` and
  `kitsuden_effective_staff('booking')`. Guards: "decision 2026-10-26" block and
  `tests/unit/effective-agents-in-kons.test.ts`.
- **Only the effective admin deletes rooms** (`booking-room:deleteRoom` =
  `isEffectiveAdmin(user, "booking")`, declared on `delete-room`). Guards: "an editor does NOT
  delete rooms" and `tests/unit/kon-booking-agent-delete-room.test.ts`.
- **Status transitions:** check-in only from `confirmed`, check-out only from `checked_in`; the
  owner may only move to `cancelled`, and only while `pending` or `confirmed`.
- **Slots are computed in UTC.** Guard: `tests/unit/booking-slots-timezone.test.ts`.
- **Manage permission before the body** on `create-room`, `create-service`, `create-blackout`,
  `delete-blackout` (`MANAGES_ROOMS`): a caller without permission gets 403, not a 422 that leaks
  the schema.

## Changing it

- New migration: the next number in `migrations/` (now `0008_...sql`). Never edit an applied one.
  `migrations/history.json` records files renamed after being applied (`renamed`) and checksums
  of earlier wordings (`previousChecksums`) so the runner does not apply them again; add to it
  only when you rename or reword an applied migration.
- Row security uses the core helpers (`kitsuden_effective_staff`, `kitsuden_agent_can_in_kon`);
  recreate a policy with `DROP POLICY IF EXISTS` then `CREATE POLICY`.
- Tables are created only by migrations, never in `onStartup`.
- New file at the kon's root: run `pnpm kon:sync` (it updates package.json `files` and kon.json).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- Operation ids are part of the contract (MCP tool name and fine scope): do not rename them.
- Do not use `Promise.all` on `dbDe(c)`: it is one transaction.

## Tests

```bash
pnpm vitest run tests/unit/kon-booking-security.test.ts      # after any change to routes, policy or migrations
pnpm vitest run tests/unit/kon-booking-agent-delete-room.test.ts  # delete-room policy, anonymous reads
pnpm vitest run tests/unit/booking-slots-timezone.test.ts    # after touching list-room-slots
pnpm vitest run tests/unit/effective-agents-in-kons.test.ts  # after touching isStaff or RLS
```

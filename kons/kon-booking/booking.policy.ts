/**
 * Booking — Authorization policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "booking-room" and
 * "booking" policies. `registerBookingPolicy()` exists because the tests call
 * `resetAuthz()` and they have to be registered again.
 *
 * The model, one line per actor:
 *
 *   · anonymous → sees rooms, services and free slots. NEVER a booking: not
 *                who booked, nor the title (it may say "dismissal
 *                interview with John Doe"), nor its ids.
 *   · user     → all of the above + create bookings IN THEIR OWN NAME and manage
 *                THEIR OWN (view, edit the descriptive parts, cancel, add notes).
 *                Sign-up is public: having an account is not being on the team.
 *   · staff    → the TEAM: human admin or editor (the "front
 *                desk staff"), or an agent with `admin`, `booking:*` or
 *                `kon:booking:*`. Sees and manages all bookings (approve,
 *                reject, check-in/out), rooms, services and blocks.
 *                Owner decision (2026-10-26): "editors
 *                manage bookings again". In phase D it was left to the
 *                admin only; now it is the engine's common rule
 *                (`isEffectiveStaff`) and, in the database, `kitsuden_effective_staff`
 *                (migration 0005).
 *                DELETING a room is narrower: it cascades all its
 *                bookings, so editors cannot. Only the effective admin
 *                (`isEffectiveAdmin`: a human admin, or an agent with
 *                `admin`, `booking:*` or `kon:booking:*`) passes
 *                `booking-room:deleteRoom`.
 *
 * Creating bookings requires a session: an anonymous form would let a bot
 * block all the rooms with fake bookings without leaving a trace.
 */
import { definePolicy, isEffectiveAdmin, isEffectiveStaff, type AuthzUser } from "@kitsuden/engine";

/** Human admin or editor, or an agent with the whole kon (engine's common rule: effective-actor). */
export function isStaff(user: AuthzUser | null): boolean {
  return isEffectiveStaff(user, "booking");
}

export interface BookingResource {
  userId: string | null;
  status: string;
}

export interface RoomResource {
  isActive: boolean;
}

/** Statuses in which the owner can still touch their booking. */
const EDITABLES = new Set(["pending", "confirmed"]);

function isOwner(user: AuthzUser | null, r: BookingResource): boolean {
  return !!user?.id && !!r.userId && r.userId === user.id;
}

export function registerBookingPolicy(): void {
  definePolicy<RoomResource>("booking-room", {
    view: (user, room) => room.isActive || isStaff(user),
    manage: (user) => isStaff(user),
    // Deleting a room cascades every booking, note and blackout of it: admin, not editor.
    deleteRoom: (user) => isEffectiveAdmin(user, "booking"),
  });

  definePolicy<BookingResource | null>("booking", {
    create: (user) => !!user?.id,
    // See the list of ALL bookings (with other people's data).
    listAll: (user) => isStaff(user),
    view: (user, r) => isStaff(user) || (!!r && isOwner(user, r)),
    update: (user, r) => isStaff(user) || (!!r && isOwner(user, r) && EDITABLES.has(r.status)),
    cancel: (user, r) => isStaff(user) || (!!r && isOwner(user, r) && EDITABLES.has(r.status)),
    // Front-desk workflow: approve, reject, check-in/out, no-show.
    manage: (user) => isStaff(user),
    addNote: (user, r) => isStaff(user) || (!!r && isOwner(user, r)),
    viewInternalNotes: (user) => isStaff(user),
  });
}

registerBookingPolicy();

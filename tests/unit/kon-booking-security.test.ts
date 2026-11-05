/**
 * kon-booking — authorization, validation and RLS with the REAL routes
 * ============================================================================
 *
 * Mounts `createBookingRouter` on PGlite with the kon's migrations and runs
 * as a NON-superuser role (see helpers/kon-with-users.ts), so what
 * is tested here is the sum of the two layers: the kon's policy and the database
 * RLS. Five actors: anonymous, A, B, staff (editor) and admin.
 *
 * The booking STAFF is the TEAM: admin and editor (owner's decision of
 * 2026-10-26, migration 0005; between 2026-10-25 and that date it
 * was admin only). Final block: what the editor can do as front desk.
 *
 * Each block corresponds to a hole that existed before 2026-10-15 (see the
 * header of booking.routes.ts): without the fix, these tests fail.
 */

import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it, afterAll } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createBookingRouter } from "../../kons/kon-booking/booking.routes";
import { registerBookingPolicy } from "../../kons/kon-booking/booking.policy";

import {
  USERS,
  testAuth,
  databaseWithRls,
  asAppRole,
  requestAs,
  sqlAs,
} from "./helpers/kon-with-users";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
let roomId: string;
let bookingA: string;
let bookingB: string;

const HOUR = 60 * 60 * 1000;
function slot(daysFromToday: number, hour: number, hours = 1) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  d.setUTCHours(hour, 0, 0, 0);
  return {
    startTime: d.toISOString(),
    endTime: new Date(d.getTime() + hours * HOUR).toISOString(),
  };
}

async function json(res: Response): Promise<any> {
  return res.json();
}

beforeAll(async () => {
  client = await databaseWithRls("kon-booking", [
    "0000_initial.sql",
    "0001_rename_tables.sql",
    "0002_booking_security.sql",
    "0003_system_without_user.sql",
    "0004_effective_admin.sql",
    "0005_effective_staff.sql",
    "0006_english_names.sql",
    "0007_english_rls.sql",
  ]);
  const db = await asAppRole(client);

  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({
    db: host.db as never,
    auth: auth as never,
  });
  const app = host.mount(createBookingRouter(ctx));
  request = requestAs(app);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerBookingPolicy();
});

describe("rooms: public read, staff management", () => {
  it("an anonymous user and a user do NOT create rooms; staff does", async () => {
    const room = { name: "Sala Norte", capacity: 6, hourlyRate: "10.00" };
    expect((await request("anon", "POST", "/rooms", room)).status).toBe(401);
    expect((await request("a", "POST", "/rooms", room)).status).toBe(403);

    const res = await request("admin", "POST", "/rooms", room);
    expect(res.status).toBe(201);
    roomId = (await json(res)).id;
  });

  it("the room list is public", async () => {
    const res = await request("anon", "GET", "/rooms");
    expect(res.status).toBe(200);
    expect((await json(res)).docs.map((r: any) => r.id)).toContain(roomId);
  });

  it("a field not on the allowlist is rejected (422), not saved", async () => {
    const res = await request("admin", "PATCH", `/rooms/${roomId}`, {
      name: "x",
      createdAt: "2000",
      isAdmin: true,
    });
    expect(res.status).toBe(422);
  });

  it("an editor does NOT delete rooms (it takes all bookings with it); neither does a user", async () => {
    expect((await request("a", "DELETE", `/rooms/${roomId}`)).status).toBe(403);
    expect((await request("staff", "DELETE", `/rooms/${roomId}`)).status).toBe(403);
  });

  it("an id that is not a UUID gives 404, not a 500 with the Postgres error", async () => {
    const res = await request("anon", "GET", "/rooms/no-existe/slots");
    expect(res.status).toBe(404);
    const body = JSON.stringify(await json(res));
    expect(body).not.toMatch(/invalid input syntax|uuid/i);
  });

  it("invalid parameters give 400 without internals", async () => {
    const res = await request("anon", "GET", `/rooms/${roomId}/slots?date=hola&duration=999999`);
    expect(res.status).toBe(400);
  });
});

describe("create bookings", () => {
  it("without a session you cannot book", async () => {
    const res = await request("anon", "POST", "/bookings", {
      roomId: roomId,
      title: "x",
      ...slot(2, 10),
    });
    expect(res.status).toBe(401);
  });

  it("userId in the body is REJECTED: you do not book in someone else's name", async () => {
    const res = await request("a", "POST", "/bookings", {
      roomId: roomId,
      title: "Suplantación",
      userId: USERS.b.id,
      ...slot(2, 10),
    });
    expect(res.status).toBe(422);
  });

  it("hourlyRate in the body is REJECTED: the price comes from the room", async () => {
    const res = await request("a", "POST", "/bookings", {
      roomId: roomId,
      title: "Gratis",
      hourlyRate: "0",
      ...slot(2, 10),
    });
    expect(res.status).toBe(422);
  });

  it("A books in THEIR name (better-auth id, not uuid) and pays the room's rate", async () => {
    const res = await request("a", "POST", "/bookings", {
      roomId: roomId,
      title: "Entrevista confidencial con Carla",
      bookedForEmail: "carla@example.com",
      ...slot(2, 10, 2),
    });
    expect(res.status).toBe(201);
    const b = await json(res);
    expect(b.userId).toBe(USERS.a.id);
    expect(b.totalAmount).toBe("20.00");
    bookingA = b.id;
  });

  it("B can NOT book over A even though RLS hides A's booking from them", async () => {
    const res = await request("b", "POST", "/bookings", {
      roomId: roomId,
      title: "Pisada",
      ...slot(2, 11),
    });
    expect(res.status).toBe(409);
  });

  it("B books another slot", async () => {
    const res = await request("b", "POST", "/bookings", {
      roomId: roomId,
      title: "Reunión de B",
      ...slot(3, 10),
    });
    expect(res.status).toBe(201);
    bookingB = (await json(res)).id;
  });

  it("you cannot book in the past", async () => {
    const res = await request("a", "POST", "/bookings", {
      roomId: roomId,
      title: "Ayer",
      ...slot(-1, 10),
    });
    expect(res.status).toBe(422);
  });
});

describe("read bookings: nobody sees anyone else's", () => {
  it("an anonymous user does not list bookings", async () => {
    expect((await request("anon", "GET", "/bookings")).status).toBe(401);
    expect((await request("anon", "GET", `/bookings/${bookingA}`)).status).toBe(401);
  });

  it("my-bookings ignores ?userId= and uses the session (it was an IDOR without login)", async () => {
    expect((await request("anon", "GET", `/my-bookings?userId=${USERS.a.id}`)).status).toBe(401);
    const res = await request("b", "GET", `/my-bookings?userId=${USERS.a.id}`);
    const ids = (await json(res)).docs.map((d: any) => d.id);
    expect(ids).toContain(bookingB);
    expect(ids).not.toContain(bookingA);
  });

  it("B lists ONLY their own, even if they ask for A's by filter", async () => {
    const res = await request("b", "GET", `/bookings?userId=${USERS.a.id}`);
    const ids = (await json(res)).docs.map((d: any) => d.id);
    expect(ids).toEqual([bookingB]);
  });

  it("B does not see, edit, cancel or annotate A's booking: 404 (does not confirm it exists)", async () => {
    expect((await request("b", "GET", `/bookings/${bookingA}`)).status).toBe(404);
    expect((await request("b", "PATCH", `/bookings/${bookingA}`, { title: "hackeada" })).status).toBe(
      404
    );
    expect((await request("b", "POST", `/bookings/${bookingA}/cancel`, {})).status).toBe(404);
    expect((await request("b", "POST", `/bookings/${bookingA}/notes`, { note: "hola" })).status).toBe(
      404
    );
  });

  it("the room's public record gives occupied slots, NOT titles or ids", async () => {
    // Confirm A's (requiresApproval=false → already confirmed).
    const res = await request("anon", "GET", `/rooms/${roomId}?include_bookings=true`);
    const body = await json(res);
    expect(body.upcomingBookings.length).toBeGreaterThan(0);
    const text = JSON.stringify(body.upcomingBookings);
    expect(text).not.toContain("Carla");
    expect(text).not.toContain(bookingA);
    expect(Object.keys(body.upcomingBookings[0]).sort()).toEqual(["endTime", "startTime"]);
  });

  it("availability says occupied without giving ids to an anonymous user; staff do see them", async () => {
    const f = slot(2, 10);
    const q = `/availability?roomId=${roomId}&startTime=${encodeURIComponent(f.startTime)}&endTime=${encodeURIComponent(f.endTime)}`;
    const anon = await json(await request("anon", "GET", q));
    expect(anon.available).toBe(false);
    expect(anon.conflictingBookings).toBeUndefined();
    const staff = await json(await request("admin", "GET", q));
    expect(staff.conflictingBookings).toContain(bookingA);
  });

  it("staff lists all", async () => {
    const ids = (await json(await request("admin", "GET", "/bookings"))).docs.map((d: any) => d.id);
    expect(ids).toEqual(expect.arrayContaining([bookingA, bookingB]));
  });
});

describe("workflow: the owner cancels, the staff decides", () => {
  it("A cannot confirm or check themselves in", async () => {
    expect(
      (await request("a", "PATCH", `/bookings/${bookingA}`, { status: "checked_in" })).status
    ).toBe(403);
    expect((await request("a", "POST", `/bookings/${bookingA}/check-in`)).status).toBe(403);
    expect(
      (await request("a", "PATCH", `/bookings/${bookingA}`, { metadata: { vip: true } })).status
    ).toBe(403);
  });

  it("A cannot write an internal note; staff can, and A does not see it", async () => {
    expect(
      (await request("a", "POST", `/bookings/${bookingA}/notes`, { note: "x", isInternal: true }))
        .status
    ).toBe(403);
    expect(
      (
        await request("admin", "POST", `/bookings/${bookingA}/notes`, {
          note: "cliente difícil",
          isInternal: true,
        })
      ).status
    ).toBe(201);
    expect(
      (
        await request("admin", "POST", `/bookings/${bookingA}/notes`, {
          note: "Sala lista",
          isInternal: false,
        })
      ).status
    ).toBe(201);

    const viewA = await json(await request("a", "GET", `/bookings/${bookingA}`));
    const notes = viewA.notes.map((n: any) => n.note);
    expect(notes).toContain("Sala lista"); // staff wrote it, but it belongs to THEIR booking
    expect(notes).not.toContain("cliente difícil");
    expect(viewA.metadata).toBeUndefined();
  });

  it("staff checks in with their own id, not one from the body", async () => {
    expect((await request("admin", "POST", `/bookings/${bookingA}/check-in`, {})).status).toBe(200);
    const [row] = await sqlAs<{ checked_in_by_id: string }>(
      client,
      "admin",
      `select checked_in_by_id from booking_reservations where id = $1`,
      [bookingA]
    );
    expect(row.checked_in_by_id).toBe(USERS.admin.id);
  });

  it("B cancels their own", async () => {
    const res = await request("b", "POST", `/bookings/${bookingB}/cancel`, { reason: "ya no" });
    expect(res.status).toBe(200);
    expect((await json(res)).status).toBe("cancelled");
  });

  it("the admin deletes rooms", async () => {
    const res = await request("admin", "POST", "/rooms", { name: "Temporal" });
    const id = (await json(res)).id;
    expect((await request("admin", "DELETE", `/rooms/${id}`)).status).toBe(200);
  });
});

describe("decision 2026-10-26: the editor is front-desk staff (admin + editor)", () => {
  it("an editor creates and edits rooms, services and blocks", async () => {
    const res = await request("staff", "POST", "/rooms", { name: "Del editor", capacity: 4 });
    expect(res.status).toBe(201);
    const id = (await json(res)).id;
    expect((await request("staff", "PATCH", `/rooms/${id}`, { name: "Del editor (2)" })).status).toBe(200);
    expect((await request("staff", "POST", "/amenities", { name: "Pizarra del editor" })).status).toBe(201);
    // Deleting the room is still the admin's (it takes all its bookings with it).
    expect((await request("staff", "DELETE", `/rooms/${id}`)).status).toBe(403);
  });

  it("an editor sees ALL bookings and manages other people's", async () => {
    const ids = (await json(await request("staff", "GET", "/bookings"))).docs.map((d: any) => d.id);
    expect(ids).toContain(bookingA);
    expect((await request("staff", "GET", `/bookings/${bookingA}`)).status).toBe(200);
    // A new booking from B: the editor sees it and cancels it (front-desk management).
    const res = await request("b", "POST", "/bookings", { roomId: roomId, title: "De B", ...slot(6, 10) });
    expect(res.status).toBe(201);
    const deB = (await json(res)).id;
    expect((await request("staff", "GET", `/bookings/${deB}`)).status).toBe(200);
    expect((await request("staff", "POST", `/bookings/${deB}/cancel`, { reason: "mostrador" })).status).toBe(200);
  });

  it("in the database, the editor sees other people's bookings and writes internal notes", async () => {
    const rows = await sqlAs(client, "staff", `select id from booking_reservations where id = $1`, [
      bookingA,
    ]);
    expect(rows).toHaveLength(1);
    const note = await sqlAs(
      client,
      "staff",
      `insert into booking_notes (booking_id, user_id, note, is_internal) values ($1, $2, 'mostrador', true) returning id`,
      [bookingA, USERS.staff.id]
    );
    expect(note).toHaveLength(1);
  });

  it("a normal user still sees only THEIR OWN (not staff)", async () => {
    const ids = (await json(await request("b", "GET", "/bookings"))).docs.map((d: any) => d.id);
    expect(ids).not.toContain(bookingA);
    expect((await request("b", "POST", "/rooms", { name: "De B" })).status).toBe(403);
  });
});

describe("RLS in the database (without going through the routes)", () => {
  it("with B's context, A's booking does not exist", async () => {
    const rows = await sqlAs(client, "b", `select id from booking_reservations where id = $1`, [
      bookingA,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("an anonymous user (context 'anonimo', not empty) sees no bookings", async () => {
    const rows = await sqlAs(client, "anon", `select id from booking_reservations`);
    expect(rows).toHaveLength(0);
  });

  it("B cannot insert a booking in A's name", async () => {
    await expect(
      sqlAs(
        client,
        "b",
        `insert into booking_reservations (room_id, user_id, title, start_time, end_time)
         values ($1, $2, 'x', now() + interval '9 days', now() + interval '9 days 1 hour')`,
        [roomId, USERS.a.id]
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("B cannot sneak a note (not even an internal one) into A's booking", async () => {
    await expect(
      sqlAs(
        client,
        "b",
        `insert into booking_notes (booking_id, user_id, note, is_internal) values ($1, $2, 'x', false)`,
        [bookingA, USERS.b.id]
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("the occupancy function returns no personal data", async () => {
    const rows = await sqlAs<Record<string, unknown>>(
      client,
      "anon",
      `select * from booking_busy_slots($1::uuid, now(), now() + interval '30 days')`,
      [roomId]
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]).sort()).toEqual(["end_time", "start_time"]);
  });
});

/**
 * kon-booking — the slots of `GET /rooms/:id/slots` belong to the REQUESTED DAY
 * ============================================================================
 *
 * Phase D (2026-10-25), tested over HTTP against a server in America/Bogota
 * (UTC-5): `?date=2026-10-25` returned the slots of the 24th. `new Date("YYYY-MM-DD")`
 * is midnight UTC and then `setHours` was used (the server's LOCAL time): west
 * of UTC the day went back one, and the bookings of the requested day
 * did not mark their slots as taken. Now the day and the room's hours
 * (`availableFrom`/`availableUntil`, default 08–18) are UTC, like
 * all the dates the API returns, whatever the server's zone.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createBookingRouter } from "../../kons/kon-booking/booking.routes";
import { registerBookingPolicy } from "../../kons/kon-booking/booking.policy";

import { testAuth, databaseWithRls, asAppRole, requestAs } from "./helpers/kon-with-users";

const TZ_BEFORE = process.env.TZ;
let client: PGlite;
let request: ReturnType<typeof requestAs>;
let roomId: string;

beforeAll(async () => {
  // A zone west of UTC: it is where the day shifted.
  process.env.TZ = "America/Bogota";
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
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never });
  request = requestAs(host.mount(createBookingRouter(ctx)));
});

afterAll(async () => {
  process.env.TZ = TZ_BEFORE;
  await client?.close();
});

beforeEach(() => {
  registerBookingPolicy();
});

function tomorrow(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

describe("GET /rooms/:id/slots on a server with a UTC-5 zone", () => {
  it("the slots fall on the requested day, from 08:00 to 18:00 UTC", async () => {
    const res = await request("admin", "POST", "/rooms", { name: "Sala Zona", capacity: 4 });
    expect(res.status).toBe(201);
    roomId = (await res.json()).id;

    const day = tomorrow();
    const r = await request("anon", "GET", `/rooms/${roomId}/slots?date=${day}`);
    expect(r.status).toBe(200);
    const { slots } = await r.json();
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].start).toBe(`${day}T08:00:00.000Z`);
    expect(slots.at(-1).end).toBe(`${day}T18:00:00.000Z`);
    for (const s of slots) expect(s.start.slice(0, 10)).toBe(day);
  });

  it("a booking on that day marks its slot as taken", async () => {
    const day = tomorrow();
    const reservation = await request("a", "POST", "/bookings", {
      roomId: roomId,
      title: "Reunión",
      startTime: `${day}T10:00:00.000Z`,
      endTime: `${day}T11:00:00.000Z`,
    });
    expect(reservation.status).toBe(201);

    const { slots } = await (await request("anon", "GET", `/rooms/${roomId}/slots?date=${day}`)).json();
    const ten = slots.find((s: any) => s.start === `${day}T10:00:00.000Z`);
    const eight = slots.find((s: any) => s.start === `${day}T08:00:00.000Z`);
    expect(ten?.available).toBe(false);
    expect(eight?.available).toBe(true);
  });
});

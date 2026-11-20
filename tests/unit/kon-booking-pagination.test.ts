/**
 * kon-booking — pages of the lists that used to stop at a cap with no sign
 * ============================================================================
 *
 * `list-rooms` (500), `list-blackouts` (500) and `list-my-reservations` (200)
 * returned their first N rows and nothing said more existed (api-contract,
 * 2026-11-18). Now they take `limit` and `offset` and answer `hasMore`; with no
 * `limit` they still return up to the old cap. Also `get-room`'s camelCase
 * `includeBookings`, with the old `include_bookings` still accepted.
 *
 * Same harness as kon-booking-security.test.ts: the real router on PGlite with
 * the kon's migrations, as a non-superuser role.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createBookingRouter } from "../../kons/kon-booking/booking.routes";
import { registerBookingPolicy } from "../../kons/kon-booking/booking.policy";

import { testAuth, databaseWithRls, asAppRole, requestAs } from "./helpers/kon-with-users";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
let roomId: string;

const HOUR = 60 * 60 * 1000;
function slot(daysFromToday: number, hour: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  d.setUTCHours(hour, 0, 0, 0);
  return { startTime: d.toISOString(), endTime: new Date(d.getTime() + HOUR).toISOString() };
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
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never });
  request = requestAs(host.mount(createBookingRouter(ctx)));

  const first = await request("admin", "POST", "/rooms", { name: "Sala A", capacity: 6 });
  expect(first.status).toBe(201);
  roomId = (await json(first)).id;
  expect((await request("admin", "POST", "/rooms", { name: "Sala B", capacity: 4 })).status).toBe(
    201
  );

  for (const days of [5, 6]) {
    const f = slot(days, 0);
    const res = await request("admin", "POST", `/rooms/${roomId}/blackout`, {
      startDate: f.startTime,
      endDate: f.endTime,
    });
    expect(res.status).toBe(201);
  }

  for (const days of [2, 3]) {
    const res = await request("a", "POST", "/bookings", { roomId, title: "Mine", ...slot(days, 10) });
    expect(res.status).toBe(201);
  }
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerBookingPolicy();
});

describe("list-rooms pages", () => {
  it("limit=1 returns one room and says more follow", async () => {
    const page = await json(await request("anon", "GET", "/rooms?limit=1"));
    expect(page.docs).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    const next = await json(await request("anon", "GET", "/rooms?limit=1&offset=1"));
    expect(next.docs).toHaveLength(1);
    expect(next.docs[0].id).not.toBe(page.docs[0].id);
    expect(next.hasMore).toBe(false);
  });

  it("without limit it returns every room, hasMore false", async () => {
    const all = await json(await request("anon", "GET", "/rooms"));
    expect(all.docs).toHaveLength(2);
    expect(all.hasMore).toBe(false);
  });

  it("a limit above the cap is a 422", async () => {
    expect((await request("anon", "GET", "/rooms?limit=501")).status).toBe(422);
  });
});

describe("list-blackouts pages", () => {
  it("limit=1 returns one period and says more follow; no limit returns both", async () => {
    const page = await json(await request("anon", "GET", `/rooms/${roomId}/blackout?limit=1`));
    expect(page.docs).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    const all = await json(await request("anon", "GET", `/rooms/${roomId}/blackout`));
    expect(all.docs).toHaveLength(2);
    expect(all.hasMore).toBe(false);
  });
});

describe("list-my-reservations pages", () => {
  it("limit=1 returns one booking and says more follow; no limit returns both", async () => {
    const page = await json(await request("a", "GET", "/my-bookings?limit=1"));
    expect(page.docs).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    const all = await json(await request("a", "GET", "/my-bookings"));
    expect(all.docs).toHaveLength(2);
    expect(all.hasMore).toBe(false);
  });
});

describe("get-room: includeBookings", () => {
  it("the camelCase name adds the upcoming slots", async () => {
    const body = await json(await request("anon", "GET", `/rooms/${roomId}?includeBookings=true`));
    expect(body.upcomingBookings).toHaveLength(2);
  });

  it("the deprecated include_bookings still works", async () => {
    const body = await json(await request("anon", "GET", `/rooms/${roomId}?include_bookings=true`));
    expect(body.upcomingBookings).toHaveLength(2);
  });

  it("without either, no upcoming slots", async () => {
    const body = await json(await request("anon", "GET", `/rooms/${roomId}`));
    expect(body.upcomingBookings).toBeUndefined();
  });
});

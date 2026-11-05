/**
 * kon-booking — deleting a room goes through the policy, and the public reads are public
 * ============================================================================
 *
 * `DELETE /api/booking/rooms/:id` checked `user.role === "admin"` in the handler, so no agent key
 * could delete a room whatever its scopes. Now the operation declares
 * `booking-room:deleteRoom` (`isEffectiveAdmin(user, "booking")`): a human admin or an agent that
 * opens the whole kon (or holds the operation's fine scope) passes; an editor, a user and an agent
 * without the kon's scopes do not.
 *
 * The second block mounts the kon alone and checks that the reads declared `access: "public"` or
 * `"optional"` answer an anonymous caller. (On a standard install the host's session gate on
 * `/api/booking` answers 401 before the kon runs; that rule lives in the core, see README.md.)
 */

import type { PGlite } from "@electric-sql/pglite";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createBookingRouter } from "../../kons/kon-booking/booking.routes";
import { registerBookingPolicy } from "../../kons/kon-booking/booking.policy";

import { testAuth, dropToAppRole, migratedBase, requestAs } from "./helpers/safe-kons-bench";

const json = async (r: Response): Promise<any> => r.json();
const agent = (...scopes: string[]) => ({ agent: scopes });

let client: PGlite;
let request: ReturnType<typeof requestAs>;

async function newRoom(name: string): Promise<string> {
  const res = await request("admin", "POST", "/rooms", { name, capacity: 4, hourlyRate: "10.00" });
  expect(res.status).toBe(201);
  return (await json(res)).id;
}

beforeAll(async () => {
  registerBookingPolicy();
  const migrations = readdirSync(resolve(__dirname, "../../kons/kon-booking/migrations"))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  client = await migratedBase("kon-booking", migrations);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as any, auth: auth as any });
  request = requestAs(host.mount(createBookingRouter(ctx)));
});

afterAll(async () => client?.close());

describe("delete-room goes through the policy (booking-room:deleteRoom)", () => {
  test.each([["admin"], ["booking:*"], ["kon:booking:*"], ["kon:booking:delete-room"]])(
    "an agent with %s deletes a room (before: 403 for every agent)",
    async (scope) => {
      const id = await newRoom(`Agent room ${scope}`);
      const res = await request(agent("mcp:connect", scope), "DELETE", `/rooms/${id}`);
      expect(res.status).toBe(200);
      expect((await json(res)).id).toBe(id);
      expect((await request("admin", "GET", `/rooms/${id}`)).status).toBe(404);
    }
  );

  test("an agent without the kon's scopes, a user and an editor are refused", async () => {
    const id = await newRoom("Kept room");
    expect((await request(agent("mcp:connect"), "DELETE", `/rooms/${id}`)).status).toBe(403);
    expect((await request(agent("user:act"), "DELETE", `/rooms/${id}`)).status).toBe(403);
    expect((await request("a", "DELETE", `/rooms/${id}`)).status).toBe(403);
    expect((await request("staff", "DELETE", `/rooms/${id}`)).status).toBe(403);
    expect((await request("anon", "DELETE", `/rooms/${id}`)).status).toBe(401);
    expect((await request("admin", "GET", `/rooms/${id}`)).status).toBe(200);
  });

  test("a denial wins: `admin` + `!kon:booking:delete-room` cannot delete", async () => {
    const id = await newRoom("Denied room");
    const res = await request(agent("admin", "!kon:booking:delete-room"), "DELETE", `/rooms/${id}`);
    expect(res.status).toBe(403);
  });

  test("the human admin still deletes rooms", async () => {
    const id = await newRoom("Admin room");
    expect((await request("admin", "DELETE", `/rooms/${id}`)).status).toBe(200);
  });
});

describe("the public reads answer an anonymous caller (kon level)", () => {
  test("rooms, one room, slots, blackouts, amenities and availability", async () => {
    const id = await newRoom("Public room");
    const day = new Date(Date.now() + 2 * 86_400_000);
    day.setUTCHours(10, 0, 0, 0);
    const end = new Date(day.getTime() + 3_600_000);
    const date = day.toISOString().slice(0, 10);

    expect((await request("anon", "GET", "/rooms")).status).toBe(200);
    expect((await request("anon", "GET", `/rooms/${id}`)).status).toBe(200);
    expect((await request("anon", "GET", `/rooms/${id}/slots?date=${date}`)).status).toBe(200);
    expect((await request("anon", "GET", `/rooms/${id}/blackout`)).status).toBe(200);
    expect((await request("anon", "GET", "/amenities")).status).toBe(200);
    const q = `roomId=${id}&startTime=${encodeURIComponent(day.toISOString())}&endTime=${encodeURIComponent(end.toISOString())}`;
    expect((await request("anon", "GET", `/availability?${q}`)).status).toBe(200);
  });
});

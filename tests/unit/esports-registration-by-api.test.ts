/**
 * kon-esports: public registration can be OPENED through the API
 * ============================================================================
 *
 * Phase D (e2e against the real API, 2026-10-25): the tournament is born with
 * `registration_mode = 'closed'` (on purpose), but neither `POST /tournaments`
 * nor `PATCH /tournaments/:id` accepted `registrationMode`:
 *
 *     PATCH /api/esports/tournaments/:id  { "registrationMode": "open" }
 *     → 422 «Unknown field «registrationMode». Valid fields: title, …»
 *
 * No other route wrote it. Result: `POST /public/tournament/:id/register`
 * always answered 409 «This tournament does not accept public registration» and the
 * whole flow (registration → bracket → reports) only worked by touching the database with SQL.
 * The same with the window, the waiting list, the rules, guests, report deadline,
 * mandatory screenshot and roster size.
 */
import { resetAuthz, respondError } from "@kitsuden/engine";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { registerEsportsPolicy } from "../../kons/kon-esports/esports.policy";
import { createEsportsRouter } from "../../kons/kon-esports/esports.routes";

function mount() {
  const writtenItem: { set?: Record<string, unknown>; values?: Record<string, unknown> } = {};
  const row = (o: Record<string, unknown>) => ({ id: "t1", title: "T", ...o });
  const instance = {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        writtenItem.set = v;
        return { where: () => ({ returning: async () => [row(v)] }) };
      },
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        writtenItem.values = v;
        return { returning: async () => [row(v)] };
      },
    }),
  };
  const withAdmin = async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: "u-admin", role: "admin" });
    await next();
  };
  const ctx = {
    db: { instance },
    auth: { requireAuth: withAdmin, optionalAuth: withAdmin, requireAdmin: withAdmin },
    cache: { invalidate: async () => {}, get: async () => null, set: async () => {} },
    config: {},
    logger: console,
  } as never;
  const app = new Hono();
  app.onError((err, c) => respondError(c, err));
  app.route("/", createEsportsRouter(ctx));
  return { app, written: writtenItem };
}

const send = (app: ReturnType<typeof mount>["app"], method: string, route: string, body: unknown) =>
  app.request(route, {
    method: method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  resetAuthz();
  registerEsportsPolicy();
});

describe("kon-esports: writable registration fields", () => {
  it("PATCH opens public registration with its window and options", async () => {
    const { app, written: writtenItem } = mount();
    const r = await send(app, "PATCH", "/tournaments/0b9f7c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b", {
      registrationMode: "open",
      registrationOpensAt: "2026-11-01T10:00:00.000Z",
      registrationClosesAt: "2026-11-02T10:00:00.000Z",
      waitlistEnabled: true,
      requiresRulesAcceptance: true,
      allowGuestRegistration: false,
      reportGraceMinutes: 15,
      requiresEvidence: true,
    });
    expect(r.status).toBe(200);
    expect(writtenItem.set?.registrationMode).toBe("open");
    expect(writtenItem.set?.registrationOpensAt).toBeInstanceOf(Date);
    expect(writtenItem.set?.waitlistEnabled).toBe(true);
    expect(writtenItem.set?.reportGraceMinutes).toBe(15);
  });

  it("POST creates the tournament with registration already open", async () => {
    const { app, written: writtenItem } = mount();
    const r = await send(app, "POST", "/tournaments", {
      title: "Abierto",
      registrationMode: "approval",
      minRosterSize: 5,
      maxRosterSize: 7,
    });
    expect(r.status).toBe(201);
    expect(writtenItem.values?.registrationMode).toBe("approval");
    expect(writtenItem.values?.minRosterSize).toBe(5);
  });

  it("an invented mode or a reversed window are rejected", async () => {
    const { app } = mount();
    expect((await send(app, "PATCH", "/tournaments/0b9f7c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b", { registrationMode: "abierto" })).status).toBe(422);
    expect(
      (
        await send(app, "PATCH", "/tournaments/0b9f7c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b", {
          registrationOpensAt: "2026-11-02T10:00:00.000Z",
          registrationClosesAt: "2026-11-01T10:00:00.000Z",
        })
      ).status
    ).toBe(422);
    expect(
      (await send(app, "PATCH", "/tournaments/0b9f7c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b", { minRosterSize: 6, maxRosterSize: 5 })).status
    ).toBe(422);
  });
});

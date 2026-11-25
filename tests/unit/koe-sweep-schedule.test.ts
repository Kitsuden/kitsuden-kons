/**
 * kon-koe: the sweep as a core kon schedule (`koe:sweep`)
 * ============================================================================
 *
 * On a core that runs kon schedules (marked with `ctx.workers`) the sweep is one run per minute
 * across every replica; on an older core the per-process interval stays. The tick sweeps at the
 * schedule's instant, the same on every replica.
 */
import { describe, expect, it } from "vitest";

import koe from "../../kons/kon-koe/index";
import { hostSchedulesKons } from "../../kons/kon-koe/koe.automation";

describe("koe sweep schedule", () => {
  it("is declared as the kon schedule `sweep`, every minute", () => {
    const schedules = (koe as unknown as { schedules?: Array<{ id: string; cron: string; run: unknown }> }).schedules;
    expect(schedules?.map((s) => [s.id, s.cron])).toEqual([["sweep", "* * * * *"]]);
    expect(typeof schedules?.[0]?.run).toBe("function");
  });

  it("knows whether the host runs the schedule, so the interval starts only where it does not", () => {
    expect(hostSchedulesKons({} as never)).toBe(false);
    expect(hostSchedulesKons({ workers: { supported: true } } as never)).toBe(true);
  });
});

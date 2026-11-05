/**
 * Net worth and push ingestion
 * ============================================================================
 *
 * Two findings that changed the design after investigating how commercial
 * products solve it:
 *
 *   1. **The official API DOES give the price of each item**, of all ten
 *      players, in spectator mode too. Summing it gives the net worth, which is
 *      EXACT — not an estimate. The gap Riot leaves is smaller than
 *      it looks: unspent gold is missing, not the material advantage.
 *
 *   2. **The server cannot reach the user's `127.0.0.1:2999`.** If
 *      the spectator is at home and the overlay is served by a server, ingestion
 *      has to go the other way: a local agent pushes the frames.
 */

import { describe, expect, test, afterEach } from "vitest";

import { emptyFrame, type LiveFrame } from "../../kons/kon-broadcast/live/frame";
import { readGold } from "../../kons/kon-broadcast/live/gold";
import {
  buildFrame,
  createRiotLiveClientAdapter,
  netWorthOf,
} from "../../kons/kon-broadcast/live/ingest.riot";
import {
  clearPushedFrames,
  createPushAdapter,
  latestPushedFrame,
  PUSH_TTL_MS,
  receivePushedFrame,
} from "../../kons/kon-broadcast/live/ingest.push";

afterEach(() => clearPushedFrames());

// ── Net worth ────────────────────────────────────────────────────────────────

describe("net worth: exact, not estimated", () => {
  test("sums the price of the items carried", () => {
    expect(
      netWorthOf({
        items: [
          { itemID: 3078, price: 3333, count: 1 },
          { itemID: 3047, price: 1100, count: 1 },
        ],
      })
    ).toBe(4433);
  });

  test("consumables do NOT count", () => {
    // A potion is not power on the map, and counting it would make the
    // net worth go up and down every time someone passes by the shop — noise that on the
    // chart is mistaken for real progress.
    expect(
      netWorthOf({
        items: [
          { itemID: 3078, price: 3333, count: 1 },
          { itemID: 2003, price: 50, count: 5, consumable: true },
        ],
      })
    ).toBe(3333);
  });

  test("multiplies by the quantity", () => {
    expect(netWorthOf({ items: [{ itemID: 3340, price: 400, count: 3 }] })).toBe(1200);
  });

  test("without inventory it returns null, NOT zero", () => {
    // Zero would say "has nothing"; null says "we don't know". On screen they are
    // different decisions: one is drawn, the other hides the widget.
    expect(netWorthOf({})).toBeNull();
  });

  test("an empty inventory IS zero", () => {
    expect(netWorthOf({ items: [] })).toBe(0);
  });
});

describe("team net worth", () => {
  const payload = (items: unknown[]) => ({
    gameData: { gameTime: 600 },
    allPlayers: [
      { team: "ORDER", championName: "Ahri", riotIdGameName: "A", scores: {}, items },
      {
        team: "CHAOS",
        championName: "Zed",
        riotIdGameName: "B",
        scores: {},
        items: [{ itemID: 3020, price: 1100, count: 1 }],
      },
    ],
    events: { Events: [] },
  });

  test("the frame carries exact net worth and marks it as such", () => {
    const frame = buildFrame(payload([{ itemID: 3078, price: 3333, count: 1 }]) as never, "test");
    expect(frame.blue.netWorth).toBe(3333);
    expect(frame.red.netWorth).toBe(1100);
    expect(frame.precision.netWorth).toBe("exact");
    // Gold is still absent: they are different things and are declared separately.
    expect(frame.precision.gold).toBe("unavailable");
  });

  test("if one player lacks inventory, the whole team is unknown", () => {
    // Summing what is there would give a number that LOOKS complete, and in a
    // comparison between teams that is worse than giving no number.
    const frame = buildFrame(
      {
        gameData: { gameTime: 600 },
        allPlayers: [
          { team: "ORDER", championName: "A", scores: {}, items: [{ itemID: 1, price: 100 }] },
          { team: "ORDER", championName: "B", scores: {} },
        ],
        events: { Events: [] },
      } as never,
      "test"
    );
    expect(frame.blue.netWorth).toBeNull();
    expect(frame.precision.netWorth).toBe("unavailable");
  });

  test("the adapter declares it gives net worth even if it gives no gold", () => {
    // It is the distinction most people overlook, and the one that lets the panel
    // say "there is no gold but there is exact net worth" before starting.
    const caps = createRiotLiveClientAdapter().capabilities;
    expect(caps.gold).toBe(false);
    expect(caps.netWorth).toBe(true);
  });
});

describe("what is drawn: net worth before estimate", () => {
  function withNetWorth(blue: number, red: number): LiveFrame {
    const f = emptyFrame("test");
    f.gameTime = 900;
    f.blue.netWorth = blue;
    f.red.netWorth = red;
    f.precision.netWorth = "exact";
    return f;
  }

  test("with exact net worth it is NOT estimated", () => {
    const reading = readGold(withNetWorth(42000, 38000));
    expect(reading).toMatchObject({
      blue: 42000,
      red: 38000,
      diff: 4000,
      precision: "exact",
      basis: "networth",
    });
  });

  test("exact gold beats net worth: it is more complete", () => {
    const f = withNetWorth(42000, 38000);
    f.blue.gold = 50000;
    f.red.gold = 44000;
    f.precision.gold = "exact";
    expect(readGold(f).basis).toBe("gold");
  });

  test("with neither, it is estimated and says so", () => {
    const f = emptyFrame("test");
    f.gameTime = 900;
    const reading = readGold(f);
    expect(reading.precision).toBe("estimated");
    expect(reading.basis).toBe("estimated-gold");
  });
});

// ── Push ─────────────────────────────────────────────────────────────────────

describe("push ingestion: the user spectates on THEIR PC", () => {
  const frame = (clock: number) => ({ ...emptyFrame("push"), gameTime: clock });

  test("returns the last pushed frame", async () => {
    receivePushedFrame("g1", frame(300) as LiveFrame, 1000);
    const adapter = createPushAdapter("g1", () => 1000);
    expect((await adapter.poll({}))?.gameTime).toBe(300);
  });

  test("each game has its own mailbox: two games do not overwrite each other", async () => {
    receivePushedFrame("g1", frame(300) as LiveFrame, 1000);
    receivePushedFrame("g2", frame(900) as LiveFrame, 1000);

    expect((await createPushAdapter("g1", () => 1000).poll({}))?.gameTime).toBe(300);
    expect((await createPushAdapter("g2", () => 1000).poll({}))?.gameTime).toBe(900);
  });

  test("a frame EXPIRES: if the agent closes, the overlay does not freeze", async () => {
    // Without expiry, an agent closed mid-game leaves minute 23 on
    // screen forever — and that LOOKS like it works, which is the worst.
    receivePushedFrame("g1", frame(1380) as LiveFrame, 1000);

    const justInTime = createPushAdapter("g1", () => 1000 + PUSH_TTL_MS - 1);
    expect(await justInTime.poll({})).not.toBeNull();

    const tooLate = createPushAdapter("g1", () => 1000 + PUSH_TTL_MS + 1);
    expect(await tooLate.poll({})).toBeNull();
  });

  test("with nothing pushed it returns null, it does not throw", async () => {
    expect(await createPushAdapter("nunca", () => 1000).poll({})).toBeNull();
  });

  test("emptying the mailbox keeps resuming from rescuing an old frame", () => {
    receivePushedFrame("g1", frame(600) as LiveFrame, 1000);
    clearPushedFrames("g1");
    expect(latestPushedFrame("g1", 1000)).toBeNull();
  });

  test("the agent does not promise what the local API does not give", () => {
    // It inherits the limits of the source at the other end of the pipe.
    const caps = createPushAdapter("g1").capabilities;
    expect(caps.gold).toBe(false);
    expect(caps.netWorth).toBe(true);
    expect(caps.spectator).toBe(true);
  });
});

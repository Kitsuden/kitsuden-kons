/**
 * MOBA live — gold, objectives, stats and ingestion
 * ============================================================================
 *
 * What is pinned here is what the overlay CANNOT compute on its own,
 * because it runs inside OBS where there are no tests and a failure goes on air.
 *
 * The central point: **Riot does not publish gold in spectator mode**. The
 * estimate exists, is marked as such, and estimates the DIFFERENCE —which is the one
 * that can be estimated well— and not the total.
 */

import { describe, expect, test, afterEach } from "vitest";

import {
  emptyFrame,
  registerIngestAdapter,
  listIngestAdapters,
  resetIngestAdapters,
  type LiveFrame,
  type LivePlayerFrame,
  type TeamSide,
} from "../../kons/kon-broadcast/live/frame";
import {
  earnedGold,
  goldExtremes,
  leader,
  passiveGold,
  pushGoldPoint,
  readGold,
} from "../../kons/kon-broadcast/live/gold";
import {
  allTimers,
  clock,
  mapPressure,
  objectiveTimer,
  soulState,
  TOWERS_PER_TEAM,
} from "../../kons/kon-broadcast/live/objectives";
import { mvp, timeline, compareTeams } from "../../kons/kon-broadcast/live/stats";
import {
  championSlug,
  createRiotLiveClientAdapter,
} from "../../kons/kon-broadcast/live/ingest.riot";

// ── Ayudas ───────────────────────────────────────────────────────────────────

function player(team: TeamSide, over: Partial<LivePlayerFrame> = {}): LivePlayerFrame {
  return {
    slot: 0,
    team,
    riotId: "Jugador",
    role: null,
    championId: "ahri",
    // The Data Dragon key is SEPARATE from the slug and mandatory: Riot's
    // CDN is case-sensitive and has names that are not derived from the visible one
    // (Wukong is `MonkeyKing`). It was missing from this fixture.
    championKey: "Ahri",
    championName: "Ahri",
    level: 1,
    kills: 0,
    deaths: 0,
    assists: 0,
    creepScore: 0,
    visionScore: 0,
    items: [],
    summonerSpells: [],
    isDead: false,
    respawnIn: 0,
    gold: null,
    netWorth: null,
    ...over,
  };
}

function frame(over: Partial<LiveFrame> = {}): LiveFrame {
  return { ...emptyFrame("test"), ...over };
}

afterEach(() => resetIngestAdapters());

// ── Gold ─────────────────────────────────────────────────────────────────────

describe("gold: the difference is estimated, not the total", () => {
  test("passive gold does NOT start until 1:50", () => {
    expect(passiveGold(0)).toBe(500);
    expect(passiveGold(109)).toBe(500);
    expect(passiveGold(120)).toBeGreaterThan(500);
  });

  test("the passive cancels out in the difference", () => {
    // It is the property that makes the estimate useful: both teams earn
    // exactly the same gold just for existing.
    const f = frame({ gameTime: 1200 });
    const early = readGold(frame({ gameTime: 60 }));
    const late = readGold(f);

    expect(early.diff).toBe(0);
    expect(late.diff).toBe(0);
    // …even though the total has grown.
    expect(late.blue).toBeGreaterThan(early.blue);
  });

  test("the difference comes from what the API DOES publish", () => {
    const f = frame({
      gameTime: 600,
      blue: {
        side: "blue",
        players: [player("blue", { creepScore: 100, kills: 3 })],
        objectives: { towers: 2, inhibitors: 0, barons: 0, heralds: 0, voidgrubs: 0, dragons: [] },
        gold: null,
        netWorth: null,
        kills: 3,
      },
    });

    const gold = readGold(f);
    expect(gold.diff).toBeGreaterThan(0);
    expect(gold.precision).toBe("estimated");
  });

  test("if the source gives EXACT gold, the estimate is not used", () => {
    // The estimate is a fallback, not a preference.
    const f = frame({
      gameTime: 900,
      precision: {
        gold: "exact",
        netWorth: "unavailable",
        items: "exact",
        vision: "exact",
        objectives: "exact",
      },
      // `netWorth: null` is exactly what this case describes: the precision
      // above says `netWorth: "unavailable"`, meaning the source does not publish it.
      // Null and 0 are not collapsed — zero is "they have nothing", null is "unknown".
      blue: {
        side: "blue",
        players: [],
        objectives: emptyObjectives(),
        gold: 30000,
        netWorth: null,
        kills: 0,
      },
      red: {
        side: "red",
        players: [],
        objectives: emptyObjectives(),
        gold: 25000,
        netWorth: null,
        kills: 0,
      },
    });

    const gold = readGold(f);
    expect(gold).toMatchObject({ blue: 30000, red: 25000, diff: 5000, precision: "exact" });
  });

  test("a team with more objectives earns more gold", () => {
    const poor = earnedGold({
      side: "blue",
      players: [],
      objectives: emptyObjectives(),
      gold: null,
      netWorth: null,
      kills: 0,
    });
    const rich = earnedGold({
      side: "blue",
      players: [],
      objectives: { ...emptyObjectives(), towers: 3, barons: 1 },
      gold: null,
      netWorth: null,
      kills: 0,
    });
    expect(rich).toBeGreaterThan(poor);
  });
});

describe("gold difference series", () => {
  test("subsamples: two consecutive readings do not give two points", () => {
    // At 5 Hz for 40 minutes that would be 12,000 points for 460px of width.
    let series = pushGoldPoint([], { at: 100, diff: 500 });
    series = pushGoldPoint(series, { at: 103, diff: 700 });
    expect(series).toHaveLength(1);
    // …but keeps the MOST RECENT value of the window.
    expect(series[0].diff).toBe(700);
  });

  test("once the window has passed it does add a point", () => {
    let series = pushGoldPoint([], { at: 100, diff: 500 });
    series = pushGoldPoint(series, { at: 115, diff: 700 });
    expect(series).toHaveLength(2);
  });

  test("a LATE frame is discarded", () => {
    // After a reconnection they may arrive out of order; inserting it would draw a
    // backward spike in the chart.
    let series = pushGoldPoint([], { at: 300, diff: 1000 });
    series = pushGoldPoint(series, { at: 120, diff: -400 });
    expect(series).toHaveLength(1);
    expect(series[0].at).toBe(300);
  });

  test("the series has a ceiling: it does not grow without limit", () => {
    let series: { at: number; diff: number }[] = [];
    for (let i = 0; i < 900; i++) series = pushGoldPoint(series, { at: i * 15, diff: i });
    expect(series.length).toBeLessThanOrEqual(600);
    // And it keeps the RECENT data, not the old.
    expect(series[series.length - 1].diff).toBe(899);
  });

  test("the extremes are the caster's data", () => {
    const extremes = goldExtremes([
      { at: 0, diff: 0 },
      { at: 60, diff: 3000 },
      { at: 120, diff: -4500 },
    ]);
    expect(extremes).toEqual({ blue: 3000, red: 4500 });
  });

  test("the leader has a threshold so it does not flicker on a tie", () => {
    expect(leader(50)).toBeNull();
    expect(leader(-50)).toBeNull();
    expect(leader(2000)).toBe("blue");
    expect(leader(-2000)).toBe("red");
  });
});

// ── Objectives ───────────────────────────────────────────────────────────────

describe("objective timers", () => {
  test("before the first spawn it counts toward it", () => {
    const t = objectiveTimer("dragon", 60, null);
    expect(t.nextSpawn).toBe(300);
    expect(t.countdown).toBe(240);
    expect(t.available).toBe(false);
  });

  test("after a death it counts from THAT death, not accumulating", () => {
    // A frame lost to a reconnection cannot throw the clock off for the rest
    // of the game.
    const t = objectiveTimer("dragon", 700, 600);
    expect(t.nextSpawn).toBe(900);
    expect(t.countdown).toBe(200);
  });

  test("when it is already on the map, the counter is 0 and not negative", () => {
    const t = objectiveTimer("baron", 1500, null);
    expect(t.countdown).toBe(0);
    expect(t.available).toBe(true);
  });

  test("the herald is TURNED OFF when it no longer respawns", () => {
    // Drawing it counting down to a moment that never arrives is worse than hiding it.
    const t = objectiveTimer("herald", 1100, 1000);
    expect(t.nextSpawn).toBeNull();
    expect(t.countdown).toBeNull();
  });

  test("the four timers come from the frame", () => {
    const timers = allTimers(frame({ gameTime: 300 }));
    expect(timers.map((t) => t.kind).sort()).toEqual(["baron", "dragon", "herald", "voidgrub"]);
  });
});

describe("dragon soul", () => {
  const withDragons = (blue: number, red: number, type = "infernal") =>
    frame({
      gameTime: 1800,
      blue: {
        side: "blue",
        players: [],
        objectives: {
          ...emptyObjectives(),
          dragons: Array.from({ length: blue }, (_, i) => ({
            type,
            team: "blue" as const,
            at: 300 + i * 300,
          })),
        },
        gold: null,
        netWorth: null,
        kills: 0,
      },
      red: {
        side: "red",
        players: [],
        objectives: {
          ...emptyObjectives(),
          dragons: Array.from({ length: red }, (_, i) => ({
            type,
            team: "red" as const,
            at: 400 + i * 300,
          })),
        },
        gold: null,
        netWorth: null,
        kills: 0,
      },
    });

  test("four dragons give the soul", () => {
    expect(soulState(withDragons(4, 1)).holder).toBe("blue");
  });

  test("three dragons do NOT give the soul, but they do warn", () => {
    // "One dragon away" changes how the next five minutes are played.
    const state = soulState(withDragons(3, 1));
    expect(state.holder).toBeNull();
    expect(state.onPoint).toBe("blue");
  });

  test("if BOTH are at one, neither is highlighted", () => {
    // There are two stories, not one: highlighting one would be taking sides.
    expect(soulState(withDragons(3, 3)).onPoint).toBeNull();
  });

  test("the elder dragon does NOT define the soul type", () => {
    const f = withDragons(2, 0);
    f.blue.objectives.dragons.push({ type: "elder", team: "blue", at: 2400 });
    expect(soulState(f).type).toBe("infernal");
  });
});

describe("map pressure", () => {
  test("the towers a team has left are those the rival did NOT destroy", () => {
    // Inverting it is the classic mistake and on screen it is noticed right away.
    const f = frame({
      red: {
        side: "red",
        players: [],
        objectives: { ...emptyObjectives(), towers: 4 },
        gold: null,
        netWorth: null,
        kills: 0,
      },
    });
    expect(mapPressure(f).towersLeft.blue).toBe(TOWERS_PER_TEAM - 4);
    expect(mapPressure(f).towersLeft.red).toBe(TOWERS_PER_TEAM);
  });

  test("the baron buff expires and stops being drawn", () => {
    const active = frame({
      gameTime: 1300,
      events: [{ id: 1, at: 1250, type: "BaronKill", team: "blue" }],
    });
    expect(mapPressure(active).baronBuff).toMatchObject({ team: "blue" });

    const expired = frame({
      gameTime: 1600,
      events: [{ id: 1, at: 1250, type: "BaronKill", team: "blue" }],
    });
    expect(mapPressure(expired).baronBuff).toBeNull();
  });

  test("the clock is drawn in mm:ss", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65)).toBe("1:05");
    expect(clock(2400)).toBe("40:00");
    expect(clock(-5)).toBe("0:00");
  });
});

// ── Stats ────────────────────────────────────────────────────────────────────

describe("MVP", () => {
  test("a support with no kills can be MVP", () => {
    // It is the case a KDA ranking misses, and the one that justifies the
    // formula: 0/2/18 on a team with 20 kills is the player of the game.
    const f = frame({
      blue: {
        side: "blue",
        players: [
          player("blue", { riotId: "Support", kills: 0, deaths: 2, assists: 18, visionScore: 90 }),
          player("blue", { riotId: "ADC", kills: 8, deaths: 4, assists: 2, creepScore: 280 }),
        ],
        objectives: emptyObjectives(),
        gold: null,
        netWorth: null,
        kills: 20,
      },
    });

    expect(mvp(f, { winner: "blue" })?.player.riotId).toBe("Support");
  });

  test("a team with 0 kills does not send NaN to the overlay", () => {
    // In a 3-minute stomp it happens, and a division by zero would turn off the widget.
    const f = frame({
      blue: {
        side: "blue",
        players: [player("blue", { riotId: "X" })],
        objectives: emptyObjectives(),
        gold: null,
        netWorth: null,
        kills: 0,
      },
    });
    const best = mvp(f);
    expect(best).not.toBeNull();
    expect(Number.isFinite(best!.score)).toBe(true);
  });

  test("winning weighs: between two equal performances, the winner's comes out", () => {
    const stats = { kills: 5, deaths: 2, assists: 5, creepScore: 200 };
    const f = frame({
      blue: {
        side: "blue",
        players: [player("blue", { riotId: "Ganador", ...stats })],
        objectives: emptyObjectives(),
        gold: null,
        netWorth: null,
        kills: 10,
      },
      red: {
        side: "red",
        players: [player("red", { riotId: "Perdedor", ...stats })],
        objectives: emptyObjectives(),
        gold: null,
        netWorth: null,
        kills: 10,
      },
    });
    expect(mvp(f, { winner: "blue" })?.player.riotId).toBe("Ganador");
  });

  test("without players it returns null, it does not blow up", () => {
    expect(mvp(frame())).toBeNull();
  });
});

describe("timeline", () => {
  test("trims by WEIGHT, not by time", () => {
    // Keeping the last N events would throw away the minute-25 baron and
    // leave ten deaths in a row from the end.
    const events = [
      { id: 1, at: 100, type: "FirstBlood" as const },
      { id: 2, at: 1500, type: "BaronKill" as const, team: "blue" as const },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: 10 + i,
        at: 2000 + i,
        type: "ChampionKill" as const,
      })),
    ];

    const result = timeline(frame({ events }), 5);
    expect(result).toHaveLength(5);
    expect(result.some((e) => e.type === "BaronKill")).toBe(true);
  });

  test("the result comes out sorted by time even if trimmed by weight", () => {
    const events = [
      { id: 1, at: 900, type: "DragonKill" as const },
      { id: 2, at: 100, type: "FirstBlood" as const },
      { id: 3, at: 1500, type: "BaronKill" as const },
    ];
    const result = timeline(frame({ events }), 2);
    expect(result.map((e) => e.at)).toEqual([...result.map((e) => e.at)].sort((a, b) => a - b));
  });
});

describe("team comparison", () => {
  test("aggregates what goes under the scoreboard", () => {
    const f = frame({
      blue: {
        side: "blue",
        players: [player("blue", { creepScore: 150 })],
        objectives: { ...emptyObjectives(), towers: 3 },
        gold: null,
        netWorth: null,
        kills: 7,
      },
    });
    const c = compareTeams(f);
    expect(c.kills.blue).toBe(7);
    expect(c.towers.blue).toBe(3);
    expect(c.creepScore.blue).toBe(150);
    expect(c.gold.precision).toBe("estimated");
  });
});

// ── Ingesta ──────────────────────────────────────────────────────────────────

describe("Riot adapter", () => {
  test("declares that it can NOT give gold", () => {
    // This line is what allows warning before the game starts, instead
    // of when the caster asks why the widget is missing.
    const adapter = createRiotLiveClientAdapter();
    expect(adapter.capabilities.gold).toBe(false);
    expect(adapter.capabilities.objectives).toBe(true);
    expect(adapter.capabilities.spectator).toBe(true);
  });

  test("without a game it returns null, it does not throw", () => {
    // Between games of a series the client answers 404 for minutes. It is
    // normal operation, not an error to fill the log with.
    const adapter = createRiotLiveClientAdapter({
      fetchImpl: async () => new Response("", { status: 404 }),
    });
    return expect(adapter.poll({})).resolves.toBeNull();
  });

  test("a network failure does not throw either", () => {
    const adapter = createRiotLiveClientAdapter({
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    return expect(adapter.poll({})).resolves.toBeNull();
  });

  test("converts Riot's teams to the screen vocabulary", async () => {
    const adapter = createRiotLiveClientAdapter({
      fetchImpl: async () =>
        Response.json({
          gameData: { gameTime: 615.4 },
          allPlayers: [
            {
              team: "ORDER",
              championName: "Ahri",
              riotIdGameName: "Faker",
              level: 11,
              scores: { kills: 4, deaths: 1, assists: 6, creepScore: 140, wardScore: 12 },
              items: [{ itemID: 3020, slot: 1 }],
            },
            { team: "CHAOS", championName: "Zed", summonerName: "Chovy", level: 10, scores: {} },
          ],
          events: {
            Events: [
              { EventID: 1, EventName: "GameStart", EventTime: 0 },
              {
                EventID: 2,
                EventName: "DragonKill",
                EventTime: 340,
                KillerName: "Faker",
                DragonType: "Infernal",
              },
              { EventID: 3, EventName: "MinionsSpawning", EventTime: 65 },
            ],
          },
        }),
    });

    const result = await adapter.poll({});
    expect(result).not.toBeNull();
    expect(result!.gameTime).toBe(615);
    expect(result!.blue.players[0].riotId).toBe("Faker");
    expect(result!.red.players[0].championName).toBe("Zed");

    // Gold comes out null: the source does not publish it and a zero is not made up.
    expect(result!.blue.players[0].gold).toBeNull();
    expect(result!.precision.gold).toBe("unavailable");

    // The dragon is attributed to the team that killed it.
    expect(result!.blue.objectives.dragons).toHaveLength(1);
    expect(result!.blue.objectives.dragons[0].type).toBe("infernal");

    // Events with no value on screen do not fill the timeline.
    expect(result!.events.some((e) => e.type === "GameStart")).toBe(true);
    expect(result!.events).toHaveLength(2);
  });

  test("an empty response during loading does not count as a game", async () => {
    const adapter = createRiotLiveClientAdapter({
      fetchImpl: async () => Response.json({ allPlayers: [] }),
    });
    expect(await adapter.poll({})).toBeNull();
  });

  test("the champion slug survives apostrophes, accents and spaces", () => {
    // The name comes in the client's language and the graphic needs a key.
    expect(championSlug("Kai'Sa")).toBe("kaisa");
    expect(championSlug("Lee Sin")).toBe("leesin");
    expect(championSlug("Nunu & Willump")).toBe("nunuwillump");
    expect(championSlug(undefined)).toBe("");
  });
});

describe("adapter registry", () => {
  test("a third party can contribute a better source without touching the kon", () => {
    // It is the point that makes this competitive: whoever has exact gold registers it
    // and the rest —overlay, panel, stats— works the same.
    registerIngestAdapter({
      id: "mi-fuente",
      name: "Fuente propia",
      capabilities: {
        gold: true,
        netWorth: true,
        items: true,
        vision: true,
        objectives: true,
        events: true,
        spectator: true,
      },
      poll: async () => null,
    });
    expect(listIngestAdapters().map((a) => a.id)).toContain("mi-fuente");
  });

  test("an adapter without poll is rejected on registration, not on the first frame", () => {
    expect(() =>
      registerIngestAdapter({ id: "roto", name: "Roto", capabilities: {} as never } as never)
    ).toThrow(/poll/);
  });
});

function emptyObjectives() {
  return { towers: 0, inhibitors: 0, barons: 0, heralds: 0, voidgrubs: 0, dragons: [] };
}

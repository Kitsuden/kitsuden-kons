/**
 * MOBA overlay — render in a real DOM
 * ============================================================================
 *
 * The rest of the logic is tested as pure functions, but the graphic is
 * the only thing that runs INSIDE OBS: no console anyone watches, no way to
 * recover, and live. A `querySelector` returning `null` because of an
 * attribute renamed in the HTML is not detected by any TypeScript test.
 *
 * Here the real HTML is loaded, the real render is run and what remains
 * in the DOM is checked. The transport —WebSocket and fetch— is cut because that is
 * infrastructure, not render.
 *
 * What is pinned:
 *
 *   1. The HTML and the JS do not drift apart: every `[data-…]` the JS looks for
 *      exists in the HTML.
 *   2. Estimated gold is MARKED. It is the promise made to the caster.
 *   3. Draft and post-game cover the HUD; leaving it underneath looks like a
 *      production failure.
 *   4. Nothing a user writes goes through `innerHTML`.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { beforeEach, describe, expect, test } from "vitest";

import { mountJsdom } from "../../.kitsuden/tests/unit/dom-in-test";

// jsdom is set up here and not with vitest's environment comment (NOTE: that
// comment is detected on ANY line of the file, even quoted in a
// note, and would set up a second jsdom): see dom-in-test.ts
await mountJsdom();

const ROOT = resolve(__dirname, "../..");
const GRAPHICS = join(ROOT, "kons/kon-broadcast/graphics");

const HTML = readFileSync(join(GRAPHICS, "overlay-live.html"), "utf8");
const JS = readFileSync(join(GRAPHICS, "overlay-live.js"), "utf8");

/**
 * Loads the overlay and returns its `render`.
 *
 * The file is cut before the transport section: `connect()` would open a
 * WebSocket and `loadSnapshot()` a fetch, and neither has anything to
 * do with what is being checked.
 */
function loadRender(): (state: unknown) => void {
  const cut = JS.indexOf("// ── Transport");
  expect(cut).toBeGreaterThan(0); // if someone renames the section, they find out here

  const body = HTML.slice(HTML.indexOf("<body>") + 6, HTML.indexOf("</body>"));
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");

  const factory = new Function(`${JS.slice(0, cut)}\nreturn render;`);
  return factory() as (state: unknown) => void;
}

// ── Sample state ─────────────────────────────────────────────────────────────

const TEAMS = {
  blue: { name: "T1", tag: "T1", logoUrl: null, color: "#3b6fff" },
  red: { name: "Gen.G", tag: "GEN", logoUrl: null, color: "#e8b64c" },
};

function state(over: Record<string, unknown> = {}) {
  return {
    gameId: "g1",
    gameNumber: 2,
    clock: 1042,
    status: "live",
    teams: TEAMS,
    series: { title: "LCK", stage: "Semifinal", bestOf: 5, blueScore: 2, redScore: 1 },
    theme: {
      accent: "#4c8dff",
      surface: "#070a10",
      surfaceOpacity: 0.86,
      corners: "sharp",
      fontFamily: null,
    },
    sponsors: [{ name: "Patrocinador", logoUrl: null }],
    casters: [{ name: "Caster Uno", handle: "@uno" }],
    players: {
      blue: [
        {
          slot: 0,
          team: "blue",
          riotId: "Zeus",
          championId: "jax",
          championKey: "Jax",
          championName: "Jax",
          level: 14,
          kills: 4,
          deaths: 1,
          assists: 6,
          creepScore: 210,
          items: ["3078", "3047"],
          isDead: false,
          respawnIn: 0,
        },
      ],
      red: [
        {
          slot: 0,
          team: "red",
          riotId: "Kiin",
          championId: "ksante",
          championKey: "KSante",
          championName: "K'Sante",
          level: 13,
          kills: 1,
          deaths: 4,
          assists: 2,
          creepScore: 190,
          items: [],
          isDead: true,
          respawnIn: 22,
        },
      ],
    },
    comparison: {
      kills: { blue: 11, red: 6 },
      towers: { blue: 4, red: 1 },
      dragons: { blue: 3, red: 1 },
      barons: { blue: 1, red: 0 },
      gold: {
        blue: 42100,
        red: 36800,
        diff: 5300,
        precision: "estimated",
        basis: "estimated-gold",
      },
      creepScore: { blue: 640, red: 590 },
    },
    objectives: {
      timers: [
        { kind: "dragon", nextSpawn: 1200, countdown: 158, available: false },
        { kind: "baron", nextSpawn: 1200, countdown: 0, available: true },
        { kind: "herald", nextSpawn: null, countdown: null, available: false },
      ],
      soul: { holder: null, type: "infernal", blue: 3, red: 1, onPoint: "blue" },
      pressure: {
        towersLeft: { blue: 10, red: 7 },
        inhibitors: { blue: 0, red: 0 },
        baronBuff: null,
      },
    },
    goldSeries: [
      { at: 0, diff: 0 },
      { at: 300, diff: 900 },
      { at: 600, diff: -400 },
      { at: 1042, diff: 5300 },
    ],
    timeline: [
      { at: 240, type: "FirstBlood", team: "blue", label: "First blood", weight: 2 },
      { at: 980, type: "BaronKill", team: "blue", label: "Baron", weight: 3 },
    ],
    mvp: null,
    draft: null,
    precision: {
      gold: "estimated",
      netWorth: "unavailable",
      items: "exact",
      vision: "exact",
      objectives: "exact",
    },
    source: "riot-live-client",
    countdown: null,
    ...over,
  };
}

let render: (state: unknown) => void;
beforeEach(() => {
  render = loadRender();
});

// ── HUD ──────────────────────────────────────────────────────────────────────

describe("live HUD", () => {
  test("draws scoreboard, clock and team labels", () => {
    render(state());

    expect(document.querySelector("[data-tag-blue]")?.textContent).toBe("T1");
    expect(document.querySelector("[data-tag-red]")?.textContent).toBe("GEN");
    expect(document.querySelector("[data-kills-blue]")?.textContent).toBe("11");
    expect(document.querySelector("[data-clock]")?.textContent).toBe("17:22");
    expect(document.querySelector("[data-stage]")?.textContent).toBe("Semifinal");
  });

  test("series markers are as many as wins needed", () => {
    // Bo5 → 3 to win. Drawing 5 dots would imply all 5 are played.
    render(state());
    const dots = document.querySelectorAll("[data-dots-blue] .dot");
    expect(dots).toHaveLength(3);
    expect([...dots].filter((d) => (d as HTMLElement).dataset.won === "1")).toHaveLength(2);
  });

  test("marks gold as ESTIMATED", () => {
    // Riot does not publish it in spectator; whoever reads it aloud has to
    // know it is a calculation. It is the kon's central promise.
    render(state());
    const value = document.querySelector("[data-gold-diff]");
    expect(value?.classList.contains("estimated")).toBe(true);
    expect(value?.textContent).toBe("+5.3k");
  });

  test("with EXACT gold it does not carry the mark", () => {
    const s = state();
    (s.comparison as { gold: { precision: string } }).gold.precision = "exact";
    render(s);
    expect(document.querySelector("[data-gold-diff]")?.classList.contains("estimated")).toBe(false);
  });

  test("the gold chart draws a line with one point per reading", () => {
    render(state());
    const d = document.querySelector("[data-gold-path]")?.getAttribute("d") ?? "";
    expect(d).toMatch(/^M/);
    expect(d.split("L")).toHaveLength(4);
  });

  test("an objective that no longer returns is REMOVED, not drawn in gray", () => {
    // On screen gray is mistaken for "no data yet".
    render(state());
    const rows = document.querySelectorAll("[data-timers] .timer-row");
    expect(rows).toHaveLength(2); // the herald (countdown null) disappears
  });

  test("an available objective is distinguished from one counting down", () => {
    render(state());
    const rows = [...document.querySelectorAll("[data-timers] .timer-row")] as HTMLElement[];
    expect(rows[0].dataset.available).toBe("0");
    expect(rows[0].querySelector(".timer-value")?.textContent).toBe("2:38");
    expect(rows[1].dataset.available).toBe("1");
    expect(rows[1].querySelector(".timer-value")?.textContent).toBe("ON MAP");
  });

  test("warns that a team is one dragon from the soul", () => {
    // It changes how the next five minutes are played: arriving only when it
    // already has it is arriving late.
    render(state());
    const soul = document.querySelector("[data-soul]") as HTMLElement;
    expect(soul.hidden).toBe(false);
    expect(soul.textContent).toMatch(/One dragon from soul/);
  });

  test("a dead player is dimmed and shows their respawn", () => {
    render(state());
    const red = document.querySelectorAll('[data-layer="players-red"] .player');
    expect((red[0] as HTMLElement).dataset.dead).toBe("1");
    expect(red[0].querySelector(".respawn")?.textContent).toBe("22");
  });

  test("without exact items no empty slots are drawn", () => {
    const s = state();
    (s.precision as { items: string }).items = "unavailable";
    render(s);
    expect(document.querySelectorAll('[data-layer="players"] .item')).toHaveLength(0);
  });
});

// ── Full screens ─────────────────────────────────────────────────────────────

describe("the draft and the post-game COVER the HUD", () => {
  const drafting = state({
    draft: {
      bans: { blue: ["ahri", null], red: ["zed"] },
      picks: { blue: ["jax"], red: [] },
      awaiting: { index: 7, team: "red", action: "pick", phase: 1 },
      complete: false,
    },
  });

  test("during the draft the scoreboard is not visible", () => {
    render(drafting);
    expect((document.querySelector('[data-layer="draft"]') as HTMLElement).hidden).toBe(false);
    expect((document.querySelector('[data-layer="matchbar"]') as HTMLElement).hidden).toBe(true);
    expect((document.querySelector('[data-layer="gold"]') as HTMLElement).hidden).toBe(true);
  });

  test("the current turn is highlighted, and only that one", () => {
    render(drafting);
    const picks = [...document.querySelectorAll("[data-picks-red] .pick")] as HTMLElement[];
    expect(picks.filter((p) => p.dataset.awaiting === "1")).toHaveLength(1);
    expect(picks[0].dataset.awaiting).toBe("1"); // the first free red slot
  });

  test("a skipped ban is marked differently from a turn not yet reached", () => {
    render(drafting);
    const bans = [...document.querySelectorAll("[data-bans-blue] .ban")] as HTMLElement[];
    expect(bans[0].dataset.passed).toBe("0"); // banned ahri
    expect(bans[1].dataset.passed).toBe("1"); // skipped
    expect(bans[2].dataset.passed).toBe("0"); // not their turn yet
  });

  test("a completed draft returns the HUD", () => {
    render(state({ draft: { bans: {}, picks: {}, awaiting: null, complete: true } }));
    expect((document.querySelector('[data-layer="draft"]') as HTMLElement).hidden).toBe(true);
    expect((document.querySelector('[data-layer="matchbar"]') as HTMLElement).hidden).toBe(false);
  });

  test("the post-game shows winner and MVP", () => {
    render(
      state({
        status: "finished",
        mvp: { player: { riotId: "Zeus" }, score: 88, reasons: ["82% de participación"] },
      })
    );
    expect((document.querySelector('[data-layer="postgame"]') as HTMLElement).hidden).toBe(false);
    expect(document.querySelector("[data-mvp-name]")?.textContent).toBe("Zeus");
    expect(document.querySelector("[data-mvp-reasons]")?.textContent).toMatch(/participación/);
  });
});

// ── Robustez ─────────────────────────────────────────────────────────────────

describe("does not crash with incomplete data", () => {
  test("before starting, with no players or events", () => {
    // It is the state between games of a series, which lasts minutes on air.
    const empty = state({
      players: { blue: [], red: [] },
      timeline: [],
      goldSeries: [],
      objectives: { timers: [], soul: null, pressure: null },
      source: null,
    });
    expect(() => render(empty)).not.toThrow();
    expect((document.querySelector('[data-layer="players"]') as HTMLElement).hidden).toBe(true);
  });

  test("a null state does not erase what was already on screen", () => {
    render(state());
    render(null);
    expect(document.querySelector("[data-tag-blue]")?.textContent).toBe("T1");
  });

  test("the series theme is applied as CSS variables", () => {
    render(state());
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--blue")).toBe("#3b6fff");
    expect(root.getPropertyValue("--red")).toBe("#e8b64c");
    // The surface color is decomposed so it can carry opacity.
    expect(root.getPropertyValue("--surface")).toBe("7, 10, 16");
  });

  test("`?layers=` limits which layers appear in this OBS source", () => {
    // It is what allows mounting the overlay in several Browser Sources.
    const original = window.location.search;
    Object.defineProperty(window, "location", {
      value: { ...window.location, search: "?game=g1&layers=matchbar" },
      writable: true,
    });

    const scoped = loadRender();
    scoped(state());
    expect((document.querySelector('[data-layer="matchbar"]') as HTMLElement).hidden).toBe(false);
    expect((document.querySelector('[data-layer="gold"]') as HTMLElement).hidden).toBe(true);

    Object.defineProperty(window, "location", {
      value: { ...window.location, search: original },
      writable: true,
    });
  });
});

describe("pre-game screen", () => {
  test("the countdown covers the HUD: there is no game to show yet", () => {
    render(state({ countdown: 185 }));
    expect((document.querySelector('[data-layer="pregame"]') as HTMLElement).hidden).toBe(false);
    expect((document.querySelector('[data-layer="matchbar"]') as HTMLElement).hidden).toBe(true);
    expect(document.querySelector("[data-countdown]")?.textContent).toBe("3:05");
  });

  test("without a countdown it does not appear", () => {
    render(state());
    expect((document.querySelector('[data-layer="pregame"]') as HTMLElement).hidden).toBe(true);
  });

  test("shows the teams and the format while waiting", () => {
    // It is air time that would otherwise stay black: whoever enters before
    // the hour decides there whether to stay.
    render(state({ countdown: 60 }));
    expect(document.querySelector("[data-pre-blue]")?.textContent).toBe("T1");
    expect(document.querySelector("[data-pre-red]")?.textContent).toBe("Gen.G");
    expect(document.querySelector("[data-pre-format]")?.textContent).toBe("BEST OF 5");
  });

  test("the pre-game beats the draft: there can be only one full screen", () => {
    render(
      state({
        countdown: 60,
        draft: { bans: {}, picks: {}, awaiting: null, complete: false },
      })
    );
    expect((document.querySelector('[data-layer="pregame"]') as HTMLElement).hidden).toBe(false);
    expect((document.querySelector('[data-layer="draft"]') as HTMLElement).hidden).toBe(true);
  });
});

describe("Data Dragon assets", () => {
  test("the portrait uses the CDN key, not the slug", () => {
    // The CDN is case-sensitive and has names that are not derived from the
    // visible name (Wukong is `MonkeyKing`): using the slug would give 404.
    expect(JS).toMatch(/img\/champion\/\$\{key\}\.png/);
    expect(JS).toMatch(/championArt\(p\.championKey\)/);
  });

  test("the version is resolved against versions.json, it is not fixed", () => {
    // Fixing it leaves the items of each new patch without an image within days.
    expect(JS).toMatch(/api\/versions\.json/);
    expect(JS).not.toMatch(/cdn\/1[0-9]\.[0-9]+\.[0-9]+\/img/);
  });

  test("an image that fails is HIDDEN, it does not leave the broken icon", () => {
    // Live, a broken image icon looks worse than a gap.
    expect(JS).toMatch(/addEventListener\("error"/);
  });

  test("the overlay starts even if the CDN does not respond", () => {
    // The scoreboard and times are what cannot be missing; the portraits can.
    render(state());
    expect(document.querySelector("[data-clock]")?.textContent).toBe("17:22");
    expect(document.querySelectorAll('[data-layer="players"] .player')).toHaveLength(1);
  });
});

describe("graphic security", () => {
  test("a player's name NEVER goes through innerHTML", () => {
    // A Riot ID with markup would be an injection into the screen that goes on air.
    const s = state();
    (s.players as { blue: { riotId: string }[] }).blue[0].riotId = "<img src=x onerror=alert(1)>";
    render(s);

    expect(document.querySelectorAll("img[src='x']")).toHaveLength(0);
    expect(document.querySelector('[data-layer="players"] .player-name')?.textContent).toBe(
      "<img src=x onerror=alert(1)>"
    );
  });

  test("the team name neither", () => {
    const s = state();
    (s.teams as { blue: { tag: string } }).blue.tag = "<b>X</b>";
    render(s);
    expect(document.querySelector("[data-tag-blue]")?.querySelector("b")).toBeNull();
  });

  test("the JS does not use innerHTML anywhere", () => {
    // Static assertion: the day someone writes it, it fails here and not
    // live with a malicious player name.
    expect(JS).not.toMatch(/\.innerHTML\s*=/);
  });
});

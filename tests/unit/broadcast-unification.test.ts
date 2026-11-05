/**
 * Broadcast is ONE kon with sections, not two kons
 * ============================================================================
 *
 * ── WHAT THERE WAS ─────────────────────────────────────────────────────────
 *
 * `kon-broadcast` and `kon-broadcast-moba`. On paper, two domains: fighting games and
 * MOBA. Measured, the same container written twice:
 *
 *     moba_series          broadcast_matches
 *     ───────────          ─────────────────
 *     title            ↔   event_title
 *     stage            ↔   round
 *     best_of          ↔   first_to
 *     blue_team        ↔   side_a
 *     blue_score       ↔   side_a.score
 *     casters          ↔   casters
 *     tournament_id    ↔   tournament_id
 *     bracket_match_id ↔   bracket_match_id
 *
 * and the two `report` handlers were the SAME code: look up, check
 * permission, 409 if it does not come from the bracket, `checkReportable`, `reportToBracket`.
 *
 * The real difference was not the container. It was that MOBA stores each game
 * separately —draft, gold, objectives, telemetry— and fighting games do not. That is an optional
 * child table, not a separate kon.
 *
 * ── WHAT WAS GAINED BY MERGING ─────────────────────────────────────────────
 *
 * A safeguard. The MOBA bridge checked that the series had FINISHED
 * before reporting; the fighting-game one did not, so a Bo5 at 1-0 advanced the bracket
 * with whoever was winning the first game. Being one now, it protects
 * both. See `broadcast-bracket-bridge.test.ts`.
 *
 * ── WHAT THIS FILE WATCHES ─────────────────────────────────────────────────
 *
 * That the duplicate kon does not reappear, that sections can really be
 * switched off, and the two conversions where an oversight costs a tournament
 * round: `bestOf` ↔ `firstTo` and the swapping of sides between games.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  bestOfFromFirstTo,
  firstToFromBestOf,
} from "../../kons/kon-broadcast/broadcast.schema";
import { EXPLANATION, resolveSections } from "../../kons/kon-broadcast/broadcast.sections";
import {
  seriesHistory,
  sidesOf,
  toSeriesKeyed,
  toSideKeyed,
} from "../../kons/kon-broadcast/live/sides";

const ROOT = join(__dirname, "..", "..");
const KON = join(ROOT, "kons", "kon-broadcast");

describe("the duplicate kon no longer exists", () => {
  it("`kon-broadcast-moba` is not in the tree", () => {
    expect(
      existsSync(join(ROOT, "kons", "kon-broadcast-moba")),
      "if it reappears, check why: almost everything it had was Broadcast's container " +
        "under other names."
    ).toBe(false);
  });

  it("nobody references it", () => {
    /**
     * A deleted kon still named in the configuration or in a grimoire gives
     * a startup failure that does not say what is missing — or worse, it is silently
     * ignored and the user believes they have something that is not there.
     */
    const sites = [
      join(ROOT, ".kitsuden", "apps", "api", "kitsuden.config.ts"),
      join(ROOT, "extras", "from-core", "packages", "grimoires", "grimoire-viggo", "grimoire.json"),
      join(ROOT, ".kitsuden", "apps", "api", "src", "db", "schema-kons.generated.ts"),
    ];

    for (const file of sites) {
      const text = readFileSync(file, "utf-8");
      expect(text.includes("kon-broadcast-moba"), `${file} still names it`).toBe(false);
      expect(text.includes("mobaSeries"), `${file} still names its tables`).toBe(false);
    }
  });

  it("the live subsystem lives inside Broadcast", () => {
    for (const mod of ["draft", "frame", "gold", "objectives", "session", "sides", "stats"]) {
      expect(existsSync(join(KON, "live", `${mod}.ts`)), `live/ is missing${mod}.ts`).toBe(true);
    }
    // And there is a single bridge to the bracket, not two.
    const bridges = readdirSync(KON).filter((f) => f.endsWith(".bracket.ts"));
    expect(bridges).toEqual(["broadcast.bracket.ts"]);
  });

  it("no vocabulary of the old kon remains inside", () => {
    /**
     * `MobaFrame` inside `kon-broadcast` breaks nothing, but it is the sign
     * that the merge was left half-done — and the next person to read it will believe there
     * is a MOBA kon somewhere.
     */
    for (const file of readdirSync(join(KON, "live"))) {
      const text = readFileSync(join(KON, "live", file), "utf-8");
      const remains = [...text.matchAll(/\bMoba[A-Z]\w*/g)].map((m) => m[0]);
      expect(remains, `live/${file} keeps types with the Moba prefix`).toEqual([]);
    }
  });
});

describe("sections are switched on and off", () => {
  const withValue = (config: Record<string, unknown>) => ({ konConfig: { "kon-broadcast": config } });

  it("with no configuration, the new ones come off and the established ones on", () => {
    /**
     * `standings` and `catalog` already worked before the merge: switching them off
     * would break existing installations without warning. `games`, `draft` and `live`
     * are new routes — and `live` also opens a loop against an external
     * service, which is not switched on just because.
     */
    expect(resolveSections({ konConfig: undefined })).toEqual({
      games: false,
      draft: false,
      live: false,
      standings: true,
      catalog: true,
    });
  });

  it("a section is switched on from the grimoire", () => {
    expect(resolveSections(withValue({ enableGames: true })).games).toBe(true);
    expect(resolveSections(withValue({ enableStandings: false })).standings).toBe(false);
  });

  it("a value that is not a boolean does not count as on", () => {
    // `konSetting` checks the type at runtime because the manifest is edited by
    // whoever packages the grimoire: a text `"true"` must not switch anything on.
    expect(resolveSections(withValue({ enableGames: "true" })).games).toBe(false);
    expect(resolveSections(withValue({ enableGames: 1 })).games).toBe(false);
  });

  it("the draft switches on the games by itself, and says so", () => {
    /**
     * `draft` and `live` write to a game's row: without `games` they have
     * nowhere to. Rejecting the configuration would leave the kon unable to start over
     * a badly set option, in production, on a Saturday. It is resolved and a warning is given.
     */
    const warnings: string[] = [];
    const s = resolveSections(withValue({ enableDraft: true }), (m) => warnings.push(m));

    expect(s.draft).toBe(true);
    expect(s.games, "the draft has nowhere to write without games").toBe(true);
    expect(warnings, "switching it on silently leaves the operator not knowing what happened").toHaveLength(1);
    expect(warnings[0]).toMatch(/games/);
  });

  it("each section is explained in one sentence", () => {
    // It is what the 409 and the panel show. A section without an explanation forces
    // reading the code to know what is being switched on.
    for (const key of ["games", "draft", "live", "standings", "catalog"] as const) {
      expect(EXPLANATION[key]?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it("a switched-off section answers 409 and says where to switch it on", () => {
    /**
     * The route is not left unmounted: a 404 does not distinguish "off" from "does not
     * exist", and does not tell the panel what to do. It is the same lesson as the
     * empty state of the tier list editor.
     */
    const routes = readFileSync(join(KON, "live", "routes.ts"), "utf-8");
    const sections = readFileSync(join(KON, "broadcast.sections.ts"), "utf-8");

    expect(sections).toContain("enableWith");
    expect(sections, "the 409 has to name the section").toContain("section: section");

    // And ALL the subsystem's routes go through the guard: one without it would be
    // an open door to writing to a table the installation does not use.
    const definitions = [...routes.matchAll(/app\.(get|post)\(\s*"([^"]+)"([^;]*?)=>/g)];

    /**
     * That the list is NOT empty is part of the check. A regex that stops
     * matching turns this guardian into one that always passes without looking at anything —
     * the worst possible failure in a probe, because it goes unnoticed.
     */
    expect(
      definitions.length,
      "no route was located: the pattern stopped matching and this test was passing vacuously."
    ).toBeGreaterThanOrEqual(10);

    const withoutGuard = definitions.filter((m) => !m[0].includes("requires(")).map((m) => m[2]);

    expect(withoutGuard, "these live-section routes do not check whether it is switched on").toEqual(
      []
    );
  });
});

describe("`bestOf` and `firstTo` are not the same number", () => {
  /**
   * It is the conversion that, done badly, closes the matchup one game early
   * and advances the bracket with the wrong winner. The two models
   * used different fields —`best_of` in MOBA, `first_to` in fighting games— so on
   * merging one had to be chosen and converted.
   */
  it("a Bo3 is won on reaching 2", () => {
    expect(firstToFromBestOf(3)).toBe(2);
    expect(firstToFromBestOf(5)).toBe(3);
    expect(firstToFromBestOf(1)).toBe(1);
    expect(firstToFromBestOf(7)).toBe(4);
  });

  it("and is announced the other way round", () => {
    expect(bestOfFromFirstTo(2)).toBe(3);
    expect(bestOfFromFirstTo(3)).toBe(5);
    expect(bestOfFromFirstTo(1)).toBe(1);
  });

  it("round trip loses nothing", () => {
    for (const bo of [1, 3, 5, 7, 9]) {
      expect(bestOfFromFirstTo(firstToFromBestOf(bo))).toBe(bo);
    }
  });

  it("a zero does not give a threshold of zero", () => {
    // A `firstTo` of 0 would make any score close the matchup.
    expect(firstToFromBestOf(0)).toBeGreaterThanOrEqual(1);
    expect(bestOfFromFirstTo(0)).toBeGreaterThanOrEqual(1);
  });
});

describe("sides are swapped between games", () => {
  /**
   * There are two coordinate systems: the MATCHUP side (A and B, who
   * is who in the bracket) and the GAME side (blue and red, where it is
   * played). Confusing them gives the point to the wrong team from the
   * second game on — and in Fearless, it blocks the characters from the rival.
   */
  const side = (name: string) => ({ name, score: 0 }) as never;
  const match = { sideA: side("A"), sideB: side("B") };

  it("with sides not swapped, A is first", () => {
    const s = sidesOf(match, { sideAFirst: true });
    expect(s.blue.name).toBe("A");
    expect(s.red.name).toBe("B");
  });

  it("swapped, A plays on the second side", () => {
    const s = sidesOf(match, { sideAFirst: false });
    expect(s.blue.name).toBe("B");
    expect(s.red.name).toBe("A");
  });

  it("the draft history is stored per MATCHUP, not per game", () => {
    /**
     * It is the reason for being of `toSeriesKeyed`. Stored by game side, Fearless
     * in `team` mode would block the characters from the opposite side as soon as
     * the teams switched places.
     */
    const inTheGame = { blue: ["ahri"], red: ["yasuo"] };

    // Game with swapped sides: the game's "blue" is B.
    const saved = toSeriesKeyed(inTheGame, false);
    expect(saved, "what the game's blue picked belongs to side B").toEqual({
      blue: ["yasuo"],
      red: ["ahri"],
    });

    // And when read for the same game it is seen again as it was.
    expect(toSideKeyed(saved, false)).toEqual(inTheGame);
  });

  it("round trip is the identity, swapped or not", () => {
    const h = { blue: ["a", "b"], red: ["c"] };
    for (const swap of [true, false]) {
      expect(toSideKeyed(toSeriesKeyed(h, swap), swap)).toEqual(h);
    }
  });

  it("the accumulated history adds up all the games", () => {
    const total = seriesHistory([
      { drafted: { blue: ["ahri"], red: ["yasuo"] } },
      { drafted: { blue: ["lux"], red: [] } },
      { drafted: null },
    ]);
    expect(total).toEqual({ blue: ["ahri", "lux"], red: ["yasuo"] });
  });
});

describe("each graphic loads ITS own script", () => {
  /**
   * ── THE FAILURE THIS CATCHES ──────────────────────────────────────────────
   *
   * When the MOBA overlay was brought in, `graphics/overlay.js` was copied as
   * `overlay-live.js`, but its HTML still said:
   *
   *     <script type="module" src="./overlay.js"></script>
   *
   * and that file is now the FIGHTING-game overlay. The live graphic would have
   * loaded the wrong program: with no network error —the file exists— and no
   * console error. It simply does not draw any of what is expected, live.
   *
   * It is what a file rename always breaks and no unit test sees: the
   * ones that exercise the overlay read the JS directly, so they
   * pass even if the HTML points somewhere else.
   */
  const GRAPHICS = join(KON, "graphics");

  it("each overlay's HTML points to its twin", () => {
    const htmls = readdirSync(GRAPHICS).filter((f) => f.endsWith(".html"));
    expect(htmls.length, "no graphic was found").toBeGreaterThan(1);

    for (const html of htmls) {
      const expected = `./${html.replace(/\.html$/, ".js")}`;
      const text = readFileSync(join(GRAPHICS, html), "utf-8");
      const scripts = [...text.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);

      expect(scripts, `${html} loads no script`).not.toEqual([]);
      expect(
        scripts,
        `${html} carga ${scripts.join(", ")} instead of ${expected}: live ` +
          `it gives no error, it simply draws something else.`
      ).toContain(expected);
    }
  });

  it("each overlay's JS exists", () => {
    for (const html of readdirSync(GRAPHICS).filter((f) => f.endsWith(".html"))) {
      const js = html.replace(/\.html$/, ".js");
      expect(existsSync(join(GRAPHICS, js)), `graphics/ is missing${js}`).toBe(true);
    }
  });
});

describe("the OBS URL copied from the panel is the one that works", () => {
  /**
   * ── THE FAILURE ───────────────────────────────────────────────────────────
   *
   * The panel built the overlay URL against `admin-asset/`:
   *
   *     /api/kons/kon-broadcast/admin-asset/graphics/overlay-live.html?game=…
   *
   * and that route REJECTS `.html` on purpose —a page on the same origin
   * as the admin could read its cookies—. The graphics go through `graphics/`,
   * which does admit it and applies its CSP.
   *
   * Measured against the running API:
   *
   *     …/admin-asset/graphics/overlay-live.html  → 400 «Invalid asset path»
   *     …/graphics/overlay-live.html              → 200, 21556 bytes
   *
   * It came like that from the original kon. It did not fail in the panel —it draws the URL anyway—
   * but in OBS, live, with a blank Browser Source and nobody knowing
   * why.
   */
  it("no panel points an .html at `admin-asset`", () => {
    const ADMIN = join(KON, "admin");
    for (const file of readdirSync(ADMIN).filter((f) => f.endsWith(".js"))) {
      const text = readFileSync(join(ADMIN, file), "utf-8");
      const bad = [...text.matchAll(/admin-asset\/[^`"'\s]*\.html/g)].map((m) => m[0]);
      expect(
        bad,
        `${file} builds an overlay URL against admin-asset: it will give 400 ` + "in OBS, not here."
      ).toEqual([]);
    }
  });

  it("and the documentation neither", () => {
    const guide = readFileSync(join(KON, "VIEWER-GUIDE.md"), "utf-8");
    expect(guide).not.toMatch(/admin-asset\/[^\s`]*\.html/);
    expect(guide, "the guide has to give the route that serves").toContain(
      "/graphics/overlay-live.html"
    );
  });
});

/**
 * FGC extensions — flags, ticker, crew battle and doubles
 * ============================================================================
 *
 * The five gaps that separated the kon from the reference NodeCG bundles
 * (fighter-scoreboard, omnilays, nodecg-for-smash). Round robin
 * has its own suite; the rest goes here.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  activate,
  crewBattleOver,
  crewScore,
  loseStock,
  CREW_PROFILES,
  type CrewMemberState,
} from "../../kons/kon-broadcast/classifications/crew";
import { DOUBLES_PROFILES } from "../../kons/kon-broadcast/classifications/doubles";

const ROOT = resolve(__dirname, "../..");
const GRAPHICS = join(ROOT, "kons/kon-broadcast/graphics");

// ── Flags ────────────────────────────────────────────────────────────────────

describe("country and flag", () => {
  test("the flag is derived from the ISO code in the graphic, with no CDN or table", () => {
    const js = readFileSync(join(GRAPHICS, "overlay.js"), "utf8");
    // Unicode regional indicators: two letters → emoji. An odd code paints
    // nothing, which live is the correct behavior.
    expect(js).toMatch(/0x1f1e6/);
    expect(js).not.toMatch(/flagcdn|flagsapi|countryflags/i);
  });

  test("the versus profile DECLARES country: Zod drops what is not declared", () => {
    // Without the line in the schema, validating a side would erase the saved country
    // on linking — the classic silent failure of strict schemas.
    const profiles = readFileSync(
      join(ROOT, "kons/kon-broadcast/classifications/versus.ts"),
      "utf8"
    );
    expect(profiles).toMatch(/country:/);
  });

  test("the country is a SNAPSHOT on the side: VODs are not rewritten", () => {
    const schema = readFileSync(
      join(ROOT, "kons/kon-broadcast/broadcast.schema.ts"),
      "utf8"
    );
    expect(schema).toMatch(/country: string \| null/);
  });
});

// ── Ticker ───────────────────────────────────────────────────────────────────

describe("top banner", () => {
  test("it is a field, not a queue", () => {
    // There is one current message and the operator overwrites or removes it: a queue
    // would force managing it live, which nobody does well in a hurry.
    const schema = readFileSync(
      join(ROOT, "kons/kon-broadcast/broadcast.schema.ts"),
      "utf8"
    );
    expect(schema).toMatch(/ticker: text\("ticker"\)/);
  });

  test("the overlay only scrolls it when it does NOT fit", () => {
    const js = readFileSync(join(GRAPHICS, "overlay.js"), "utf8");
    // A short message that moves forces the eye to chase it.
    expect(js).toMatch(/scrollWidth/);
    expect(js).toMatch(/data-scroll|dataset\.scroll/);
  });
});

// ── Doubles ──────────────────────────────────────────────────────────────────

describe("doubles ranking", () => {
  const generic = DOUBLES_PROFILES.find((p) => p.id === "doubles")!;

  test("the pair is of EXACTLY two", () => {
    const side = {
      name: "Team Guapos",
      players: [
        { name: "P1", char: "mario" },
        { name: "P2", char: "fox" },
      ],
    };
    expect(generic.sideSchema.safeParse(side).success).toBe(true);

    // A "double" of one or three is a data error, not a variant.
    expect(
      generic.sideSchema.safeParse({ ...side, players: side.players.slice(0, 1) }).success
    ).toBe(false);
    expect(
      generic.sideSchema.safeParse({
        ...side,
        players: [...side.players, { name: "P3" }],
      }).success
    ).toBe(false);
  });

  test("the country goes PER PLAYER: mixed pairs exist", () => {
    const result = generic.sideSchema.safeParse({
      name: "MexUSA",
      players: [
        { name: "P1", country: "MX" },
        { name: "P2", country: "US" },
      ],
    });
    expect(result.success).toBe(true);
  });
});

// ── Crew battle ──────────────────────────────────────────────────────────────

describe("crew battle", () => {
  const member = (name: string, over: Partial<CrewMemberState> = {}): CrewMemberState => ({
    name,
    stocksLeft: 3,
    out: false,
    active: false,
    ...over,
  });

  test("the score is the SUM of live stocks, not a separate number", () => {
    // Keeping it by hand throws off the total and the breakdown at the first typo.
    const roster = [member("a"), member("b", { stocksLeft: 1 }), member("c", { out: true })];
    expect(crewScore(roster)).toBe(4);
  });

  test("losing the last stock eliminates and DEACTIVATES, but does not activate the next", () => {
    // The order of entry is a tactical decision of the captain, not a fixed queue.
    const roster = [member("a", { stocksLeft: 1, active: true }), member("b")];
    const after = loseStock(roster);
    expect(after[0]).toMatchObject({ out: true, active: false, stocksLeft: 0 });
    expect(after[1].active).toBe(false);
  });

  test("activating an eliminated player is rejected with a reason", () => {
    // It is the most likely panel mistake between games, and on screen it would look
    // like a dead player playing.
    const roster = [member("a", { out: true, stocksLeft: 0 }), member("b")];
    const result = activate(roster, "a");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/already eliminated/);
  });

  test("activating one deactivates the rest: at most one plays", () => {
    const roster = [member("a", { active: true }), member("b")];
    const result = activate(roster, "b");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.roster.map((m) => m.active)).toEqual([false, true]);
    }
  });

  test("the battle ends when one side runs out of live stocks", () => {
    const alive = [member("a")];
    const dead = [member("x", { out: true, stocksLeft: 0 })];
    expect(crewBattleOver(alive, dead)).toBe("a");
    expect(crewBattleOver(dead, alive)).toBe("b");
    expect(crewBattleOver(alive, alive)).toBeNull();
  });

  test("the roster allows crews from 3 to 10", () => {
    const profile = CREW_PROFILES[0];
    const roster = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `p${i}`, stocksLeft: 3 }));

    expect(profile.sideSchema.safeParse({ name: "Crew", roster: roster(5) }).success).toBe(true);
    expect(profile.sideSchema.safeParse({ name: "Crew", roster: roster(2) }).success).toBe(false);
    expect(profile.sideSchema.safeParse({ name: "Crew", roster: roster(11) }).success).toBe(false);
  });
});

// ── The overlay paints the rosters ───────────────────────────────────────────

describe("overlay: doubles and crew on screen", () => {
  test("decides by the SHAPE of the data, not by the profile id", () => {
    // That way a third party's profile with the same shape works without touching the
    // core graphic.
    const js = readFileSync(join(GRAPHICS, "overlay.js"), "utf8");
    expect(js).toMatch(/side\?\.roster/);
    expect(js).toMatch(/side\?\.players/);
    expect(js).not.toMatch(/profileId === "smash-crew"/);
  });

  test("the HTML has the roster slots on both sides", () => {
    const html = readFileSync(join(GRAPHICS, "overlay.html"), "utf8");
    expect(html).toMatch(/data-roster-a/);
    expect(html).toMatch(/data-roster-b/);
  });
});

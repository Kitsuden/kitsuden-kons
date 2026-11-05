/**
 * Game profiles — classification as a kon, variant as data
 * ============================================================================
 *
 * What is pinned here is that the decomposition holds:
 *
 *   1. Adding a game does NOT require a new kon.
 *   2. An unknown profile does NOT let the payload through (deny-by-default).
 *   3. Two classifications with different game shapes coexist in the same
 *      registry — which is the proof that the chosen axis generalizes.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  getGameProfile,
  listClassifications,
  listGameProfiles,
  registerGameProfile,
  resetGameProfiles,
  resolveProfileId,
  validateSide,
} from "../../kons/kon-broadcast/broadcast.profiles";
import { VERSUS_PROFILES } from "../../kons/kon-broadcast/classifications/versus";
import { TEAM_PROFILES } from "../../kons/kon-broadcast/classifications/team";

const ROOT = resolve(__dirname, "../..");

function registerAll() {
  for (const p of [...VERSUS_PROFILES, ...TEAM_PROFILES]) registerGameProfile(p);
}

afterEach(() => {
  resetGameProfiles();
});

// ── The decomposition axis ───────────────────────────────────────────────────

describe("classification vs profile", () => {
  test("two classifications coexist in the same registry", () => {
    registerAll();
    expect(listClassifications().sort()).toEqual(["team", "versus"]);
  });

  test("adding a game is adding a PROFILE, not a kon", () => {
    registerAll();
    // Four fighting games —plus the generic duel— share a single
    // classification kon.
    const versus = listGameProfiles("versus");
    expect(versus.map((p) => p.id).sort()).toEqual(["1v1", "2xko", "ggst", "sf6", "tekken8"]);
    expect(new Set(versus.map((p) => p.classification)).size).toBe(1);
  });

  test("a GENERIC duel exists so no default game has to be fixed", () => {
    registerAll();
    const generic = getGameProfile("1v1");
    expect(generic).not.toBeNull();
    expect(generic!.shape).toBe("duel");
    // One pick per side: it is the common minimum: games without selection leave it
    // empty, and none runs short of room for its own.
    expect(generic!.defaults.rosterSize).toBe(1);
  });

  test("no grimoire fixes a SPECIFIC game as the default", () => {
    // A default with a proper name meant that whoever did not touch the
    // configuration ended up broadcasting with another game's terminology and
    // number of picks.
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "extras/from-core/packages/grimoires/grimoire-viggo/grimoire.json"), "utf8")
    ) as { konConfig?: Record<string, Record<string, unknown>> };

    const configured = manifest.konConfig?.["kon-broadcast"]?.gameProfile;
    expect(configured).toBe("1v1");
  });

  test("the classification determines the SHAPE of the game", () => {
    registerAll();
    expect(getGameProfile("2xko")!.shape).toBe("duel");
    expect(getGameProfile("lol")!.shape).toBe("team");
  });

  test("each profile brings its own terminology", () => {
    registerAll();
    // A panel that says "character" in LoL is noticed in production.
    expect(getGameProfile("2xko")!.labels.pick).toBe("champion");
    expect(getGameProfile("sf6")!.labels.pick).toBe("character");
    expect(getGameProfile("valorant")!.labels.pick).toBe("agent");
    expect(getGameProfile("lol")!.labels.competitor).toBe("team");
  });

  test("a malformed profile is rejected on registration, not live", () => {
    expect(() => registerGameProfile({ id: "malo" } as never)).toThrow(/classification/);
    expect(() => registerGameProfile({ id: "x", classification: "versus" } as never)).toThrow(
      /sideSchema/
    );
  });
});

// ── Payload validation ───────────────────────────────────────────────────────

describe("validation by profile — duel", () => {
  test("2XKO accepts a duo of two champions", () => {
    registerAll();
    const r = validateSide("2xko", { name: "PUNK", chars: ["ahri", "darius"] });
    expect(r.ok).toBe(true);
  });

  test("2XKO REJECTS three champions", () => {
    registerAll();
    // The limit is exact because the graphic does not know how to draw three.
    const r = validateSide("2xko", { name: "PUNK", chars: ["a", "b", "c"] });
    expect(r.ok).toBe(false);
  });

  test("SF6 only admits one character", () => {
    registerAll();
    expect(validateSide("sf6", { name: "PUNK", chars: ["ken"] }).ok).toBe(true);
    expect(validateSide("sf6", { name: "PUNK", chars: ["ken", "ryu"] }).ok).toBe(false);
  });

  test("fills in the profile's defaults", () => {
    registerAll();
    const r = validateSide<{ score: number; losers: boolean; chars: string[] }>("sf6", {
      name: "DAIGO",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.score).toBe(0);
      expect(r.value.losers).toBe(false);
      expect(r.value.chars).toEqual([]);
    }
  });

  test("a malformed color is rejected", () => {
    registerAll();
    expect(validateSide("sf6", { name: "X", color: "verde" }).ok).toBe(false);
  });
});

describe("validation by profile — teams", () => {
  const roster = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}` }));

  test("LoL requires EXACTLY five players", () => {
    registerAll();
    expect(validateSide("lol", { name: "T1", roster: roster(5) }).ok).toBe(true);
    // Four players is a data error, not a variant: better that it fails
    // here than goes on air with a gap.
    expect(validateSide("lol", { name: "T1", roster: roster(4) }).ok).toBe(false);
    expect(validateSide("lol", { name: "T1", roster: roster(6) }).ok).toBe(false);
  });

  test("LoL admits up to five bans; Valorant none", () => {
    registerAll();
    expect(
      validateSide("lol", { name: "T1", roster: roster(5), bans: ["a", "b", "c", "d", "e"] }).ok
    ).toBe(true);
    expect(validateSide("valorant", { name: "SEN", roster: roster(5), bans: ["x"] }).ok).toBe(
      false
    );
  });

  test("a duel payload is NOT valid for a team profile", () => {
    registerAll();
    // That is the point: each classification has its shape, and the registry enforces it.
    expect(validateSide("lol", { name: "PUNK", chars: ["ahri"] }).ok).toBe(false);
  });
});

// ── Deny-by-default ──────────────────────────────────────────────────────────

describe("unknown profile", () => {
  test("does NOT let the payload through", () => {
    registerAll();
    const r = validateSide("juego-inventado", { any: "cosa" });
    // Accepting it would disable the whole validation over a misspelled id, and it would
    // not be noticed until the overlay draws garbage live.
    expect(r.ok).toBe(false);
  });

  test("the error says what is registered and what to check", () => {
    registerAll();
    const r = validateSide("juego-inventado", {});
    if (!r.ok) {
      expect(r.error).toMatch(/2xko/);
      expect(r.error).toMatch(/kon for its classification/);
    }
  });

  test("with no classifications installed nothing slips through either", () => {
    // The registry is never completely empty: Broadcast contributes the generic
    // duel so it can work alone. But a specific game still
    // requires its classification kon.
    const r = validateSide("2xko", { name: "X" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/2xko/);
      // The message lists what IS there, so the operator knows what is missing.
      expect(r.error).toMatch(/1v1/);
    }
  });

  test("the generic duel survives a reset: it is built in, not from a kon", () => {
    // If it depended on the `versus` classification, an overlay-only deployment
    // would be left with no profile at all and could not create even a set.
    resetGameProfiles();
    expect(getGameProfile("1v1")).not.toBeNull();
  });
});

// ── Resolution of the effective profile ──────────────────────────────────────

describe("profile precedence", () => {
  test("the set's wins over the grimoire's", () => {
    // Without this, changing the global configuration would rewrite the profile of sets
    // already created, and with it the shape of their payload.
    expect(
      resolveProfileId({ matchProfileId: "sf6", configuredProfileId: "2xko", fallback: "ggst" })
    ).toBe("sf6");
  });

  test("the grimoire wins over the fallback", () => {
    expect(resolveProfileId({ configuredProfileId: "2xko", fallback: "ggst" })).toBe("2xko");
  });

  test("with nothing configured, explicit null", () => {
    expect(resolveProfileId({})).toBeNull();
  });
});

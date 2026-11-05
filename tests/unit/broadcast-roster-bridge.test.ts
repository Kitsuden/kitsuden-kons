/**
 * Broadcast ↔ esports player registry bridge
 * ============================================================================
 *
 * What is pinned here:
 *
 *   1. **The players table is not duplicated.** Broadcast references
 *      `esports_players` and stores a snapshot of what went on air.
 *   2. **The snapshot is not rewritten.** If a player changes gamertag,
 *      the sets already played and their VODs keep saying what they said.
 *   3. **It degrades without `kon-esports`.** Working without a registry (small event,
 *      last-minute guest) is a valid mode of use, not an error.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  applyPlayerToSide,
  type RosterPlayer,
} from "../../kons/kon-broadcast/broadcast.roster";
import { defaultSide } from "../../kons/kon-broadcast/broadcast.schema";

const ROOT = resolve(__dirname, "../..");
const BROADCAST = join(ROOT, "kons/kon-broadcast");

// ── Do not duplicate ─────────────────────────────────────────────────────────

describe("the player registry is not duplicated", () => {
  test("Broadcast does NOT declare its own players table", () => {
    const schema = readFileSync(join(BROADCAST, "broadcast.schema.ts"), "utf8");
    // `esports_players` already exists with alias, avatar, bio and social links. Duplicating it
    // would split a person's history across two places.
    expect(schema).not.toMatch(/pgTable\(\s*["']broadcast_players["']/);
    expect(schema).not.toMatch(/pgTable\(\s*["']players["']/);
  });

  test("the scoreboard side REFERENCES the player", () => {
    const schema = readFileSync(join(BROADCAST, "broadcast.schema.ts"), "utf8");
    // Required-but-nullable, not optional: `undefined` and `null` would mean
    // the same thing and drizzle's insert type rejects the ambiguity.
    expect(schema).toMatch(/playerId: string \| null/);
  });

  test("esports is OPTIONAL, not a hard dependency", () => {
    /**
     * ── WHY IT CHANGED ────────────────────────────────────────────────────
     *
     * It was declared as a hard dependency "to load after
     * esports". But this very file, in the test below, says the
     * opposite: the bridge uses a DYNAMIC import precisely so that Broadcast
     * works without esports. Both things could not be true.
     *
     * Measured: `loadEsports()` is only called from inside async functions
     * —request handlers—, never when the module loads. So load order
     * does not matter, and the hard dependency only served to force an
     * overlay-only deployment to install the whole tournaments kon.
     *
     * `kon-broadcast-moba`, which made exactly the same bridge, declared
     * `kons: []`. On merging the two one had to be chosen, and what the
     * code already did was chosen.
     */
    const manifest = JSON.parse(readFileSync(join(BROADCAST, "kon.json"), "utf8"));
    expect(manifest.dependencies.kons).not.toContain("kon-esports");
    expect(
      manifest.optionalDependencies?.kons,
      "it must stay declared as optional: removing it entirely would suggest " +
        "that Broadcast cannot talk to the bracket."
    ).toContain("kon-esports");
  });

  test("the esports module is loaded LAZILY, not at startup", () => {
    /**
     * It is what makes load order irrelevant — and therefore what
     * supports the dependency being optional. If it were ever called
     * in the module body, optionality would silently stop being true
     * and Broadcast would fail at startup without esports.
     */
    for (const file of ["broadcast.bracket.ts", "broadcast.roster.ts"]) {
      const source = readFileSync(join(BROADCAST, file), "utf8");
      const inModuleBody = /^(?:const|let|await)[^\n]*loadEsports\(\)/m.test(source);
      expect(
        inModuleBody,
        `${file} calls loadEsports() at module load: that turns ` +
          "kon-esports back into a hard requirement."
      ).toBe(false);
    }
  });

  test("the bridge uses a DYNAMIC import, not a static one", () => {
    const roster = readFileSync(join(BROADCAST, "broadcast.roster.ts"), "utf8");
    // A static import would put the esports schema in Broadcast's build and
    // Broadcast would stop working without it — breaking the plugin model.
    expect(roster).toMatch(/await import\(["']@kitsuden\/kon-esports["']\)/);
    expect(roster).not.toMatch(/^import .* from ["']@kitsuden\/kon-esports["']/m);
  });
});

// ── The snapshot ─────────────────────────────────────────────────────────────

describe("linking a player", () => {
  // Annotated as `RosterPlayer` on purpose: without the type, a missing field
  // is only noticed in the five places that use `player`, and with the message of the
  // place of use, not of the error. Here `country` was missing, which is NOT optional.
  const player: RosterPlayer = {
    id: "p-punk",
    name: "PUNK",
    country: null,
    avatarId: null,
    socialLinks: null,
  };

  test("fills in the reference and the gamertag", () => {
    const side = defaultSide("PLAYER 1", "#00d2a8");
    const bound = applyPlayerToSide(side, player);

    expect(bound.playerId).toBe("p-punk");
    expect(bound.name).toBe("PUNK");
  });

  test("KEEPS what belongs to this set, not to the player's record", () => {
    // The score, the duo and the losers side belong to the specific set: bringing them
    // from the record would erase them in the middle of a live broadcast.
    const side = {
      ...defaultSide("PLAYER 1", "#00d2a8"),
      score: 2,
      chars: ["ahri", "darius"],
      losers: true,
    };

    const bound = applyPlayerToSide(side, player);

    expect(bound.score).toBe(2);
    expect(bound.chars).toEqual(["ahri", "darius"]);
    expect(bound.losers).toBe(true);
  });

  test("respects the sponsor already written by default", () => {
    // A player can change teams between tournaments and the record can be stale:
    // what the operator just typed wins.
    const side = { ...defaultSide("PLAYER 1", "#00d2a8"), sponsor: "PG" };
    expect(applyPlayerToSide(side, player).sponsor).toBe("PG");
  });

  test("but it can be explicitly requested to bring it from the record", () => {
    const side = { ...defaultSide("PLAYER 1", "#00d2a8"), sponsor: "PG" };
    expect(applyPlayerToSide(side, player, { overwriteSponsor: true }).sponsor).toBe("");
  });

  test("does not mutate the original side", () => {
    const side = defaultSide("PLAYER 1", "#00d2a8");
    applyPlayerToSide(side, player);
    expect(side.playerId).toBeNull();
    expect(side.name).toBe("PLAYER 1");
  });
});

// ── Degradation ──────────────────────────────────────────────────────────────

describe("without kon-esports enabled", () => {
  test("the route answers 409 with an explanation, not 500", () => {
    const routes = readFileSync(join(BROADCAST, "broadcast.routes.ts"), "utf8");
    // Working without a registry is valid: a 500 would treat it as a breakdown.
    expect(routes).toMatch(/lookup\.available/);
    expect(routes).toMatch(/409/);
  });

  test("the message says what to do, not just what failed", () => {
    const roster = readFileSync(join(BROADCAST, "broadcast.roster.ts"), "utf8");
    expect(roster).toMatch(/Enable it to link players/);
    expect(roster).toMatch(/type the gamertag by hand/);
  });

  test("unlinking keeps the name on screen", () => {
    const routes = readFileSync(join(BROADCAST, "broadcast.routes.ts"), "utf8");
    // Dropping the reference cannot leave the scoreboard empty live.
    expect(routes).toMatch(/playerId: null as string \| null/);
    expect(routes).toMatch(/the name already typed is kept/);
  });
});

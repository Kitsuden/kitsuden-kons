/**
 * Broadcast ↔ esports bracket bridge
 * ============================================================================
 *
 * What is pinned here:
 *
 *   1. **Bracket advancement is NOT reimplemented.** The scoreboard reuses
 *      `applyResult` from `kon-esports`. Two implementations of double
 *      elimination diverge, and it is only discovered in a live tournament.
 *   2. **Nothing is reported halfway.** A set without both sides linked, or
 *      tied, cannot advance the bracket: advancing is hard to undo.
 *   3. **It degrades without `kon-esports`.** Broadcasting without a tournaments module is a valid
 *      mode of use — it answers 409 with an explanation, not 500.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { checkReportable, roundLabel } from "../../kons/kon-broadcast/broadcast.bracket";

const ROOT = resolve(__dirname, "../..");
const BROADCAST = join(ROOT, "kons/kon-broadcast");
const ESPORTS = join(ROOT, "kons/kon-esports");

// ── Round names ──────────────────────────────────────────────────────────────

describe("the overlay renders readable rounds, not engine ids", () => {
  test("bracket of 8: the last winners round is the final", () => {
    expect(roundLabel("W3M1", 8)).toBe("Winners Final");
    expect(roundLabel("W2M1", 8)).toBe("Winners Semifinal");
    expect(roundLabel("W1M1", 8)).toBe("Winners Cuartos");
  });

  test("losers runs through almost twice the rounds for the same bracket", () => {
    // With 8 participants, winners has 3 rounds and losers 4.
    expect(roundLabel("L4M1", 8)).toBe("Losers Final");
    expect(roundLabel("L3M1", 8)).toBe("Losers Semifinal");
  });

  test("the grand finals have their own name", () => {
    expect(roundLabel("GF", 8)).toBe("Grand Final");
    expect(roundLabel("GFR", 8)).toBe("Grand Final Reset");
  });

  test("an id it does not recognize is returned as is, not invented", () => {
    // Preferable to rendering "Winners NaN" live.
    expect(roundLabel("RARO", 8)).toBe("RARO");
  });
});

// ── Guards before touching the bracket ───────────────────────────────────────

describe("a set that cannot be attributed is not reported", () => {
  const side = (participantId: string | null, score: number) => ({ participantId, score });

  test("whoever is ahead on the scoreboard the operator was already keeping wins", () => {
    expect(checkReportable({ a: side("p1", 3), b: side("p2", 1), firstTo: 3 })).toEqual({
      ok: true,
      winner: "a",
    });
    expect(checkReportable({ a: side("p1", 0), b: side("p2", 2), firstTo: 2 })).toEqual({
      ok: true,
      winner: "b",
    });
  });

  test("a tie has no winner to report", () => {
    const result = checkReportable({ a: side("p1", 2), b: side("p2", 2), firstTo: 3 });
    expect(result.ok).toBe(false);
  });

  test("0-0 neither: an unplayed set does not close the bracket", () => {
    expect(checkReportable({ a: side("p1", 0), b: side("p2", 0), firstTo: 2 }).ok).toBe(false);
  });

  test("a half-played set is NOT reported, even if there is a difference", () => {
    /**
     * ── WHAT WAS MISSING ──────────────────────────────────────────────────
     *
     * This check did NOT exist in the fighting-game bridge: it was enough for the
     * scores to be different. A Bo5 at 1-0 was reported and put whoever was
     * winning the first game into the next round.
     *
     * The MOBA bridge did have it. On merging the two kons —which turned out to
     * be the same code with other names— it was seen that one of the two
     * protected something the other did not, and this is what stays.
     */
    const result = checkReportable({ a: side("p1", 1), b: side("p2", 0), firstTo: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/The set is not over/);
      expect(result.reason, "it has to say how much is missing").toMatch(/3/);
    }
  });

  test("without linking on BOTH sides it is not reported", () => {
    // With only one side linked, the result is not attributable: the engine
    // needs the id of the winning participant, not a typed name.
    const result = checkReportable({ a: side("p1", 3), b: side(null, 1), firstTo: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/from-set/);
  });
});

// ── The bracket logic lives in one place ─────────────────────────────────────

describe("bracket advancement is not duplicated", () => {
  test("the bridge delegates to esports' `applyResult`", () => {
    const bridge = readFileSync(join(BROADCAST, "broadcast.bracket.ts"), "utf8");
    expect(bridge).toMatch(/applyResult/);
    // If Broadcast called the pure engine directly, it would be rebuilding
    // the bracket on its own and might persist it differently.
    expect(bridge).not.toMatch(/\breportResult\s*\(/);
    expect(bridge).not.toMatch(/\bcreateBracket\s*\(/);
  });

  test("esports exposes bracket persistence as a public API", () => {
    // Without this re-export, the only way to integrate would be to copy the logic.
    const index = readFileSync(join(ESPORTS, "index.ts"), "utf8");
    expect(index).toMatch(/export \* from "\.\/bracket\.persistence"/);
  });

  test("the esports routes use the SAME persistence as the bridge", () => {
    const routes = readFileSync(join(ESPORTS, "esports.routes.ts"), "utf8");
    expect(routes).toMatch(/from "\.\/bracket\.persistence"/);
    // The closures that used to duplicate this no longer exist.
    expect(routes).not.toMatch(/async function (persistBracket|loadBracket)\(/);
  });
});

// ── Degradation without the tournaments kon ─────────────────────────────────

describe("Broadcast keeps working without `kon-esports`", () => {
  test("the esports import is DYNAMIC", () => {
    const bridge = readFileSync(join(BROADCAST, "broadcast.bracket.ts"), "utf8");
    // A static import would put the esports schema in Broadcast's
    // compilation graph, and Broadcast would stop starting without it.
    expect(bridge).toMatch(/await import\("@kitsuden\/kon-esports"\)/);
    expect(bridge).not.toMatch(/^import .* from "@kitsuden\/kon-esports"/m);
  });

  test("its absence is answered with 409 and an explanation, not 500", () => {
    const routes = readFileSync(join(BROADCAST, "broadcast.routes.ts"), "utf8");
    expect(routes).toMatch(
      /if \(!pairing\.available\) return c\.json\(\{ error: pairing\.reason \}, 409\)/
    );
  });
});

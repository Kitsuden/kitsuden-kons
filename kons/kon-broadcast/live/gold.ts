/**
 * Gold estimate and difference series
 * ============================================================================
 *
 * Riot's Live Client Data API **does not publish gold in spectator mode**. It is
 * their decision, not a gap that can be worked around by asking for another endpoint.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DIFFERENCE IS ESTIMATED, NOT THE TOTAL
 *
 * This is what makes the estimate useful. Passive gold —what
 * everyone gets for existing— is IDENTICAL for all ten players, so
 * subtracting the two teams cancels it ENTIRELY. The same goes for starting gold.
 *
 * What does not cancel is what really separates the teams: minions,
 * kills and objectives. And those are exactly the data the API does publish.
 *
 * Result: the estimated TOTAL carries the error of all the constants; the
 * DIFFERENCE only carries that of those that do not cancel. That is why the overlay
 * paints the difference chart —which is also the one read live— and
 * treats the total as a supporting number.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The constants are APPROXIMATIONS and change with every patch. They are together and
 * configurable on purpose: when Riot touches the numbers, they are adjusted here
 * and there is no need to hunt for them scattered around the code.
 */

import type { LiveFrame, TeamFrame, TeamSide } from "./frame.js";

/**
 * Gold model. All values are approximate and per patch.
 *
 * Exact numbers are not the goal: the goal is for the difference CURVE
 * to have the right shape and for the jumps to occur when they occur.
 */
export interface GoldModel {
  /** Starting gold. Cancels in the difference; it is there for the total. */
  starting: number;
  /** Average gold per minion, averaging melee, caster and siege. */
  perCreep: number;
  /** Base of a kill, without bounties or streaks. */
  perKill: number;
  /** Assist share. Less than the kill and shared. */
  perAssist: number;
  perTower: number;
  perInhibitor: number;
  perDragon: number;
  perBaron: number;
  perHerald: number;
  perVoidgrub: number;
}

/**
 * Starting values. Approximate and adjustable per deployment.
 *
 * `perCreep` comes from averaging the wave: melee and caster minions are worth less
 * than the siege one, and the proportion changes with the minute. 21 is the average that
 * best follows the curve over a full game.
 */
export const DEFAULT_GOLD_MODEL: GoldModel = {
  starting: 500,
  perCreep: 21,
  perKill: 300,
  perAssist: 150,
  perTower: 250,
  perInhibitor: 50,
  perDragon: 25,
  perBaron: 300,
  perHerald: 100,
  perVoidgrub: 40,
};

/**
 * Passive gold accumulated up to a given second.
 *
 * It is computed even though it cancels in the difference, because the TOTAL does
 * need it and because having it explicit documents why it cancels.
 */
export function passiveGold(gameTime: number, model: GoldModel = DEFAULT_GOLD_MODEL): number {
  // The passive trickle starts at 1:50 and gives 20.4 gold every 10 s.
  const START = 110;
  const PER_TICK = 20.4;
  const TICK = 10;
  if (gameTime <= START) return model.starting;
  return model.starting + Math.floor((gameTime - START) / TICK) * PER_TICK;
}

/** A team's gold from what it has ACHIEVED, without the passive or the starting gold. */
export function earnedGold(team: TeamFrame, model: GoldModel = DEFAULT_GOLD_MODEL): number {
  const creeps = team.players.reduce((sum, p) => sum + p.creepScore, 0);
  const kills = team.players.reduce((sum, p) => sum + p.kills, 0);
  const assists = team.players.reduce((sum, p) => sum + p.assists, 0);
  const o = team.objectives;

  return (
    creeps * model.perCreep +
    kills * model.perKill +
    assists * model.perAssist +
    o.towers * model.perTower +
    o.inhibitors * model.perInhibitor +
    o.dragons.length * model.perDragon +
    o.barons * model.perBaron +
    o.heralds * model.perHerald +
    o.voidgrubs * model.perVoidgrub
  );
}

export interface GoldReading {
  blue: number;
  red: number;
  /** Positive = blue lead. It is the number that is painted. */
  diff: number;
  precision: "exact" | "estimated";
  /**
   * What is being measured. It is not the same and the overlay labels it differently:
   *
   * `networth`      — net worth: price of what they carry. EXACT, and it is
   *                   what is compared live ("3k lead").
   * `gold`          — total gold, as given by a source that publishes it.
   * `estimated-gold`— gold reconstructed from minions, kills and objectives.
   */
  basis: "networth" | "gold" | "estimated-gold";
}

/**
 * Material lead of the two teams.
 *
 * Order of preference, and the order is the decision:
 *
 *   1. **Exact gold**, if the source publishes it. It is the most complete.
 *   2. **Net worth**, which the official API DOES give exactly by summing the price of
 *      items. It is preferred over the estimate because an exact number for something
 *      slightly different is worth more than an approximate one for what was asked —and
 *      besides, net worth is what a caster compares aloud—.
 *   3. **Estimated gold**, only when neither of the two exists.
 *
 * The estimate is the last resort, not the normal path.
 */
export function readGold(frame: LiveFrame, model: GoldModel = DEFAULT_GOLD_MODEL): GoldReading {
  if (frame.precision.gold === "exact" && frame.blue.gold !== null && frame.red.gold !== null) {
    return {
      blue: frame.blue.gold,
      red: frame.red.gold,
      diff: frame.blue.gold - frame.red.gold,
      precision: "exact",
      basis: "gold",
    };
  }

  if (
    frame.precision.netWorth === "exact" &&
    frame.blue.netWorth !== null &&
    frame.red.netWorth !== null
  ) {
    return {
      blue: frame.blue.netWorth,
      red: frame.red.netWorth,
      diff: frame.blue.netWorth - frame.red.netWorth,
      precision: "exact",
      basis: "networth",
    };
  }

  const passive = passiveGold(frame.gameTime, model) * 5; // five players
  const blue = Math.round(passive + earnedGold(frame.blue, model));
  const red = Math.round(passive + earnedGold(frame.red, model));

  return { blue, red, diff: blue - red, precision: "estimated", basis: "estimated-gold" };
}

// ── Time series ──────────────────────────────────────────────────────────────

export interface GoldPoint {
  at: number;
  diff: number;
}

/**
 * Adds a reading to the gold difference series.
 *
 * Two things that keep the chart from degrading over a 40-minute
 * game:
 *
 *   1. **Minimum sampling.** The ingest runs at 2-5 Hz; storing every frame would give
 *      12,000 points that nobody can distinguish in 400 pixels of width.
 *   2. **Time never goes backwards.** After a reconnection an old frame can arrive;
 *      inserting it would draw a backwards spike in the chart.
 */
export function pushGoldPoint(
  series: GoldPoint[],
  point: GoldPoint,
  options: { minIntervalSeconds?: number; maxPoints?: number } = {}
): GoldPoint[] {
  const minInterval = options.minIntervalSeconds ?? 10;
  const maxPoints = options.maxPoints ?? 600;

  const last = series[series.length - 1];
  if (last) {
    if (point.at < last.at) return series; // late frame
    if (point.at - last.at < minInterval) {
      // Within the same window: the point is updated instead of adding one,
      // so the chart reflects the latest value without growing.
      const next = series.slice(0, -1);
      next.push(point);
      return next;
    }
  }

  const next = [...series, point];
  return next.length > maxPoints ? next.slice(next.length - maxPoints) : next;
}

/** Each team's largest lead over the whole game. It is caster data. */
export function goldExtremes(series: GoldPoint[]): { blue: number; red: number } {
  let blue = 0;
  let red = 0;
  for (const p of series) {
    if (p.diff > blue) blue = p.diff;
    if (-p.diff > red) red = -p.diff;
  }
  return { blue, red };
}

/** Who is ahead, with a threshold so it does not flicker on a tie. */
export function leader(diff: number, threshold = 100): TeamSide | null {
  if (diff > threshold) return "blue";
  if (diff < -threshold) return "red";
  return null;
}

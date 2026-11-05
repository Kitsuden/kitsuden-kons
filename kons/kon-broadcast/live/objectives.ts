/**
 * Objectives: timers, dragon soul and map state
 * ============================================================================
 *
 * This is what separates a scoreboard from an esports HUD. The caster does not need to be
 * told how many dragons each team has —that is visible—; they need to know
 * **how long until the next one** and **who is one dragon from soul**.
 *
 * Everything here is pure: state goes in, what to paint comes out. The times
 * are patch constants and live together for the same reason as the gold ones: when
 * Riot changes them, they are touched in one place.
 */

import type { DragonKill, LiveFrame, TeamSide } from "./frame.js";

/** Map times, in seconds. They change per patch. */
export interface ObjectiveTimings {
  dragonFirstSpawn: number;
  dragonRespawn: number;
  baronFirstSpawn: number;
  baronRespawn: number;
  heraldFirstSpawn: number;
  /** Herald respawn. Optional: in some patches it does not respawn. */
  heraldRespawn?: number;
  /** The herald stops spawning when Baron arrives. */
  heraldDespawn: number;
  voidgrubFirstSpawn: number;
  /** Dragons needed for soul. */
  soulThreshold: number;
}

export const DEFAULT_TIMINGS: ObjectiveTimings = {
  dragonFirstSpawn: 5 * 60,
  dragonRespawn: 5 * 60,
  baronFirstSpawn: 20 * 60,
  baronRespawn: 6 * 60,
  heraldFirstSpawn: 14 * 60,
  heraldRespawn: 6 * 60,
  heraldDespawn: 20 * 60,
  voidgrubFirstSpawn: 6 * 60,
  soulThreshold: 4,
};

export type ObjectiveKind = "dragon" | "baron" | "herald" | "voidgrub";

export interface ObjectiveTimer {
  kind: ObjectiveKind;
  /** `null` if it will not spawn again (herald after minute 20). */
  nextSpawn: number | null;
  /** Seconds remaining. Never negative: if it is already up, it is 0. */
  countdown: number | null;
  /** It is on the map right now. */
  available: boolean;
}

/**
 * When an objective returns.
 *
 * It is computed from the last death, not accumulated from the start: a frame
 * lost to a reconnection cannot throw the clock off for the rest of the game.
 */
export function objectiveTimer(
  kind: ObjectiveKind,
  gameTime: number,
  lastKillAt: number | null,
  timings: ObjectiveTimings = DEFAULT_TIMINGS
): ObjectiveTimer {
  const spec = {
    dragon: { first: timings.dragonFirstSpawn, respawn: timings.dragonRespawn, until: null },
    baron: { first: timings.baronFirstSpawn, respawn: timings.baronRespawn, until: null },
    herald: {
      first: timings.heraldFirstSpawn,
      respawn: timings.heraldRespawn ?? Infinity,
      until: timings.heraldDespawn,
    },
    voidgrub: { first: timings.voidgrubFirstSpawn, respawn: Infinity, until: null },
  }[kind] as { first: number; respawn: number; until: number | null };

  const nextSpawn = lastKillAt === null ? spec.first : lastKillAt + spec.respawn;

  // An objective that no longer returns (herald past minute 20) is turned off instead
  // of staying counting toward an instant that never comes.
  if (spec.until !== null && nextSpawn >= spec.until) {
    return { kind, nextSpawn: null, countdown: null, available: false };
  }
  if (!Number.isFinite(nextSpawn)) {
    return { kind, nextSpawn: null, countdown: null, available: false };
  }

  const countdown = Math.max(0, Math.ceil(nextSpawn - gameTime));
  return { kind, nextSpawn, countdown, available: countdown === 0 };
}

/** Last instant at which each objective type fell, looking at both teams. */
export function lastKills(frame: LiveFrame): Record<ObjectiveKind, number | null> {
  const dragons = [...frame.blue.objectives.dragons, ...frame.red.objectives.dragons];
  const lastDragon = dragons.length ? Math.max(...dragons.map((d) => d.at)) : null;

  // Baron, herald and larvae carry no instant in the cumulative counter: it is
  // recovered from the event log, which does carry it.
  const lastOf = (type: string): number | null => {
    const found = frame.events.filter((e) => e.type === type);
    return found.length ? Math.max(...found.map((e) => e.at)) : null;
  };

  return {
    dragon: lastDragon,
    baron: lastOf("BaronKill"),
    herald: lastOf("HeraldKill"),
    voidgrub: lastOf("VoidgrubKill"),
  };
}

/** The four timers, ready to paint. */
export function allTimers(
  frame: LiveFrame,
  timings: ObjectiveTimings = DEFAULT_TIMINGS
): ObjectiveTimer[] {
  const last = lastKills(frame);
  return (["dragon", "baron", "herald", "voidgrub"] as ObjectiveKind[]).map((kind) =>
    objectiveTimer(kind, frame.gameTime, last[kind], timings)
  );
}

// ── Dragon soul ──────────────────────────────────────────────────────────────

export interface SoulState {
  /** Team that already has the soul, or `null`. */
  holder: TeamSide | null;
  /** Type of the soul. Set by the terrain, which is deduced from the fallen dragons. */
  type: string | null;
  blue: number;
  red: number;
  /** Team ONE dragon from soul. It is the datum the caster will repeat. */
  onPoint: TeamSide | null;
}

/**
 * Soul state.
 *
 * `onPoint` is computed separately from `holder` because they are two distinct
 * narrative moments: "one dragon away" changes how the next five
 * minutes are played, and "already has it" changes the game. An overlay that only looks at the
 * second arrives late.
 */
export function soulState(
  frame: LiveFrame,
  timings: ObjectiveTimings = DEFAULT_TIMINGS
): SoulState {
  const blueDragons = frame.blue.objectives.dragons;
  const redDragons = frame.red.objectives.dragons;
  const blue = blueDragons.length;
  const red = redDragons.length;

  // The terrain is set by the type of the dragons that are falling; the elder does not
  // count, because it appears later and does not define the soul.
  const elemental = [...blueDragons, ...redDragons]
    .filter((d) => d.type !== "elder")
    .sort((a, b) => a.at - b.at);
  const type = elemental.length ? (elemental[elemental.length - 1] as DragonKill).type : null;

  const need = timings.soulThreshold;
  const holder = blue >= need ? "blue" : red >= need ? "red" : null;

  let onPoint: TeamSide | null = null;
  if (!holder) {
    if (blue === need - 1) onPoint = "blue";
    else if (red === need - 1) onPoint = "red";
    // If BOTH are one away, there is no single story to tell: there are two.
    if (blue === need - 1 && red === need - 1) onPoint = null;
  }

  return { holder, type: holder ? type : type, blue, red, onPoint };
}

// ── Map state ────────────────────────────────────────────────────────────────

export interface MapPressure {
  /** Towers remaining for each team, out of 11. */
  towersLeft: { blue: number; red: number };
  /** Fallen inhibitors. */
  inhibitors: { blue: number; red: number };
  /** Baron active right now on some team, with what remains of it. */
  baronBuff: { team: TeamSide; expiresIn: number } | null;
}

/** Total towers on a side: 3 lanes × 3 + 2 at the nexus. */
export const TOWERS_PER_TEAM = 11;

/** Duration of the Baron buff, in seconds. */
export const BARON_BUFF_DURATION = 180;

/**
 * Map pressure.
 *
 * Towers are counted as DESTROYED by the opponent, so "towers remaining for
 * blue" is 11 minus those red has taken down. Inverting it is the classic mistake
 * and on screen it is noticed immediately.
 */
export function mapPressure(frame: LiveFrame): MapPressure {
  const lastBaron = [...frame.events]
    .filter((e) => e.type === "BaronKill")
    .sort((a, b) => b.at - a.at)[0];

  let baronBuff: MapPressure["baronBuff"] = null;
  if (lastBaron?.team) {
    const expiresIn = Math.ceil(lastBaron.at + BARON_BUFF_DURATION - frame.gameTime);
    if (expiresIn > 0) baronBuff = { team: lastBaron.team, expiresIn };
  }

  return {
    towersLeft: {
      blue: TOWERS_PER_TEAM - frame.red.objectives.towers,
      red: TOWERS_PER_TEAM - frame.blue.objectives.towers,
    },
    inhibitors: {
      blue: frame.red.objectives.inhibitors,
      red: frame.blue.objectives.inhibitors,
    },
    baronBuff,
  };
}

/** `mm:ss`. A live broadcast's clock is not painted in raw seconds. */
export function clock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

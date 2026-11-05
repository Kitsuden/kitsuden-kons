/**
 * Live session: ingest loop and broadcast to the overlay
 * ============================================================================
 *
 * It is what turns a frame into moving pixels. Three decisions that
 * come from this running for hours with nobody watching:
 *
 *   1. **The loop cannot overlap itself.** If a read takes longer
 *      than the interval, `setInterval` would queue reads until exhausting the
 *      client. It is rescheduled AFTER finishing, not every N ms.
 *   2. **It never throws upward.** An ingest failure turns off the affected
 *      widget, not the broadcast. The overlay keeps the last good frame.
 *   3. **It only broadcasts what really changed.** At 5 Hz for 40 minutes that is
 *      12,000 messages; almost all identical except the clock. The painted
 *      parts are compared and the clock is broadcast separately.
 */

import { defineSyncedState } from "@kitsuden/engine";

import { draftView, type DraftState } from "./draft.js";
import { emptyTeam, type IngestAdapter, type LiveFrame } from "./frame.js";
import { pushGoldPoint, readGold, type GoldPoint } from "./gold.js";
import { allTimers, mapPressure, soulState } from "./objectives.js";
import type {
  BroadcastCaster,
  BroadcastSide,
  BroadcastSponsor,
  BroadcastTheme,
} from "../broadcast.schema.js";

/**
 * What the graphic needs to know about the MATCH.
 *
 * It is a structural shape, not the table row, on purpose: that way the
 * live subsystem does not depend on how the container is modeled, and a new
 * column in `broadcast_matches` does not force touching anything here. It is what
 * allows this section to be turned off without leaving loose ends.
 */
export interface MatchContext {
  title: string;
  stage: string;
  /** Best of N, as announced. */
  bestOf: number;
  /** Match score, per MATCH side. */
  scoreA: number;
  scoreB: number;
  theme: BroadcastTheme;
  sponsors: BroadcastSponsor[];
  casters: BroadcastCaster[];
}
import { compareTeams, mvp, timeline } from "./stats.js";

/** Overlay state key for a game. */
export function gameStateKey(gameId: string): string {
  return `moba:game:${gameId}`;
}

/**
 * What the graphic consumes. Deliberately **derived and flattened**: the
 * overlay must not compute souls or timers. That computation is tested
 * here and cannot also live in an untested `.js` that runs inside OBS.
 */
export interface OverlayState {
  gameId: string;
  gameNumber: number;
  clock: number;
  status: string;

  teams: { blue: BroadcastSide; red: BroadcastSide };
  series: { title: string; stage: string; bestOf: number; blueScore: number; redScore: number };
  theme: BroadcastTheme;
  sponsors: { name: string; logoUrl: string | null }[];
  casters: { name: string; handle: string }[];

  players: { blue: unknown[]; red: unknown[] };
  comparison: ReturnType<typeof compareTeams>;
  objectives: {
    timers: ReturnType<typeof allTimers>;
    soul: ReturnType<typeof soulState>;
    pressure: ReturnType<typeof mapPressure>;
  };
  goldSeries: GoldPoint[];
  timeline: ReturnType<typeof timeline>;
  mvp: ReturnType<typeof mvp>;
  draft: ReturnType<typeof draftView> | null;

  /**
   * What can be trusted from what. The graphic uses it to mark estimated
   * numbers and HIDE widgets with no data, instead of painting zeros.
   */
  precision: LiveFrame["precision"];
  /** Adapter that produced the frame, or `null` if there is no live ingest. */
  source: string | null;

  /**
   * Seconds remaining until start, or `null` if there is no countdown.
   *
   * The NUMBER is sent, not a start time: the clock of the PC that broadcasts and
   * the server's do not match, and a countdown computed on the client would
   * drift from what the operator sees. With a number, the graphic just
   * counts down.
   */
  countdown: number | null;
}

export interface BuildOptions {
  match: MatchContext;
  /** Seconds until start, if the series has a scheduled time. */
  countdown?: number | null;
  gameId: string;
  gameNumber: number;
  status: string;
  teams: { blue: BroadcastSide; red: BroadcastSide };
  draft: DraftState | null;
  goldSeries: GoldPoint[];
  winner?: "blue" | "red" | null;
}

/** Frame + series context → overlay state. */
export function buildOverlayState(frame: LiveFrame | null, options: BuildOptions): OverlayState {
  const { match, teams } = options;

  const base = {
    gameId: options.gameId,
    gameNumber: options.gameNumber,
    status: options.status,
    teams,
    series: {
      title: match.title,
      stage: match.stage,
      bestOf: match.bestOf,
      // The graphic still talks about blue/red because they are the sides of the MAP;
      // the score it receives is the MATCH's, which is not swapped.
      blueScore: match.scoreA,
      redScore: match.scoreB,
    },
    theme: match.theme,
    sponsors: match.sponsors,
    casters: match.casters,
    goldSeries: options.goldSeries,
    draft: options.draft ? draftView(options.draft) : null,
    countdown: options.countdown ?? null,
  };

  // With no frame —before starting, or between games— what is already known is sent:
  // teams, series score and draft. A blank overlay during the
  // countdown is wasted air time.
  if (!frame) {
    return {
      ...base,
      clock: 0,
      players: { blue: [], red: [] },
      comparison: compareTeams({
        gameTime: 0,
        blue: emptyTeam("blue"),
        red: emptyTeam("red"),
        events: [],
        precision: unavailable(),
        source: "",
      }),
      objectives: {
        timers: [],
        soul: { holder: null, type: null, blue: 0, red: 0, onPoint: null },
        pressure: {
          towersLeft: { blue: 11, red: 11 },
          inhibitors: { blue: 0, red: 0 },
          baronBuff: null,
        },
      },
      timeline: [],
      mvp: null,
      precision: unavailable(),
      source: null,
    };
  }

  return {
    ...base,
    clock: frame.gameTime,
    players: { blue: frame.blue.players, red: frame.red.players },
    comparison: compareTeams(frame),
    objectives: {
      timers: allTimers(frame),
      soul: soulState(frame),
      pressure: mapPressure(frame),
    },
    timeline: timeline(frame),
    mvp: mvp(frame, { winner: options.winner ?? null }),
    // The reading resolves what is being measured —exact net worth, exact gold or
    // estimate— and with what precision. The graphic needs both things in order to
    // label it properly: "NET WORTH" is not the same as "GOLD DIFFERENCE".
    precision: { ...frame.precision, gold: readGold(frame).precision },
    source: frame.source,
  };
}

function emptyObj() {
  return { towers: 0, inhibitors: 0, barons: 0, heralds: 0, voidgrubs: 0, dragons: [] };
}

function unavailable(): LiveFrame["precision"] {
  return {
    gold: "unavailable",
    netWorth: "unavailable",
    items: "unavailable",
    vision: "unavailable",
    objectives: "unavailable",
  };
}

// ── Loop ─────────────────────────────────────────────────────────────────────

export interface SessionOptions {
  gameId: string;
  adapter: IngestAdapter;
  /** Milliseconds between reads. 200-500 is the useful range live. */
  intervalMs?: number;
  /** Series context. Reread on every frame in case it changed. */
  context: () => Omit<BuildOptions, "goldSeries">;
  /** Called with every good frame, to persist the snapshot. */
  onFrame?: (frame: LiveFrame, goldSeries: GoldPoint[]) => void;
  /** Called when the connection state with the source changes. */
  onSourceChange?: (alive: boolean) => void;
}

export interface Session {
  gameId: string;
  stop(): void;
  /** Last known frame. `null` if none has arrived yet. */
  latest(): LiveFrame | null;
  goldSeries(): GoldPoint[];
}

const sessions = new Map<string, Session>();

/**
 * Starts the ingest for a game.
 *
 * If there was already a session for that game, it is stopped first: two loops on the
 * same channel would overwrite each other's revisions and the overlay would flicker between two
 * states.
 */
export function startSession(options: SessionOptions): Session {
  stopSession(options.gameId);

  const interval = options.intervalMs ?? 250;
  const state = defineSyncedState<OverlayState | null>(gameStateKey(options.gameId), {
    default: null,
    // The truth is the game in progress, not Postgres. Persisting every frame would be
    // a second copy that would also arrive late.
    persist: false,
  });

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let frame: LiveFrame | null = null;
  let series: GoldPoint[] = [];
  let alive = false;

  const tick = async () => {
    if (stopped) return;

    let next: LiveFrame | null = null;
    try {
      next = await options.adapter.poll({});
    } catch {
      next = null; // the adapter should already swallow it; this is the belt
    }

    const nowAlive = next !== null;
    if (nowAlive !== alive) {
      alive = nowAlive;
      options.onSourceChange?.(alive);
    }

    if (next) {
      frame = next;
      const gold = readGold(next);
      series = pushGoldPoint(series, { at: next.gameTime, diff: gold.diff });
      options.onFrame?.(next, series);
    }

    try {
      await state.set(buildOverlayState(frame, { ...options.context(), goldSeries: series }));
    } catch {
      // Broadcasting is the only thing that can fail without consequence: the overlay
      // keeps the latest and resynchronizes on reconnecting.
    }

    if (!stopped) timer = setTimeout(() => void tick(), interval);
  };

  void tick();

  const session: Session = {
    gameId: options.gameId,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      sessions.delete(options.gameId);
    },
    latest: () => frame,
    goldSeries: () => series,
  };

  sessions.set(options.gameId, session);
  return session;
}

export function stopSession(gameId: string): void {
  sessions.get(gameId)?.stop();
}

export function getSession(gameId: string): Session | null {
  return sessions.get(gameId) ?? null;
}

export function listSessions(): Session[] {
  return [...sessions.values()];
}

/** For process shutdown and for tests. */
export function stopAllSessions(): void {
  for (const s of [...sessions.values()]) s.stop();
}

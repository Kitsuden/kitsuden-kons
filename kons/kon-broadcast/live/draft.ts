/**
 * Draft: ban and pick order, and Fearless mode
 * ============================================================================
 *
 * The draft is half the content of a competitive broadcast: it is ten
 * minutes of tension before anyone moves a character. An overlay that
 * only appears when the game starts misses that half.
 *
 * Everything here is a PURE state machine. It knows nothing about the network, the
 * database, or who sends it the picks: state and an action go in, the next
 * state comes out. That allows testing the full draft order —twenty
 * steps— in milliseconds, instead of discovering live that turn 14 goes to the
 * wrong team.
 */

import type { TeamSide } from "./frame.js";

export type DraftAction = "ban" | "pick";

export interface DraftStep {
  index: number;
  team: TeamSide;
  action: DraftAction;
  /** Draft phase: 1 = first round, 2 = second. */
  phase: 1 | 2;
}

/**
 * Standard competitive draft order (tournament format).
 *
 * Bans 1: B R B R B R
 * Picks 1:  B RR BB R
 * Bans 2: R B R B
 * Picks 2:  R BB R
 *
 * The order is not symmetric on purpose: it offsets the first-pick advantage
 * by giving the red team the counter-pick at the end of each phase. Changing it breaks
 * the reading of the draft for anyone who follows esports.
 */
export const STANDARD_DRAFT_ORDER: DraftStep[] = [
  // ── Ban phase 1 ──
  { index: 0, team: "blue", action: "ban", phase: 1 },
  { index: 1, team: "red", action: "ban", phase: 1 },
  { index: 2, team: "blue", action: "ban", phase: 1 },
  { index: 3, team: "red", action: "ban", phase: 1 },
  { index: 4, team: "blue", action: "ban", phase: 1 },
  { index: 5, team: "red", action: "ban", phase: 1 },
  // ── Pick phase 1 ──
  { index: 6, team: "blue", action: "pick", phase: 1 },
  { index: 7, team: "red", action: "pick", phase: 1 },
  { index: 8, team: "red", action: "pick", phase: 1 },
  { index: 9, team: "blue", action: "pick", phase: 1 },
  { index: 10, team: "blue", action: "pick", phase: 1 },
  { index: 11, team: "red", action: "pick", phase: 1 },
  // ── Ban phase 2 ──
  { index: 12, team: "red", action: "ban", phase: 2 },
  { index: 13, team: "blue", action: "ban", phase: 2 },
  { index: 14, team: "red", action: "ban", phase: 2 },
  { index: 15, team: "blue", action: "ban", phase: 2 },
  // ── Pick phase 2 ──
  { index: 16, team: "red", action: "pick", phase: 2 },
  { index: 17, team: "blue", action: "pick", phase: 2 },
  { index: 18, team: "blue", action: "pick", phase: 2 },
  { index: 19, team: "red", action: "pick", phase: 2 },
];

export interface DraftSelection {
  index: number;
  team: TeamSide;
  action: DraftAction;
  /** `null` = skipped ban, which is different from "the turn has not arrived yet". */
  championId: string | null;
}

export interface DraftState {
  selections: DraftSelection[];
  /** Step in progress. `null` = draft finished. */
  current: DraftStep | null;
  complete: boolean;
}

export function emptyDraft(order: DraftStep[] = STANDARD_DRAFT_ORDER): DraftState {
  return { selections: [], current: order[0] ?? null, complete: order.length === 0 };
}

// ── Fearless ─────────────────────────────────────────────────────────────────

/**
 * Fearless Draft variants.
 *
 * `off`    — normal draft.
 * `global` — a champion picked in any earlier game is out for
 *            BOTH teams for the rest of the series.
 * `team`   — only out for the team that picked it; the opponent can
 *            take it.
 *
 * Both variants really exist on different circuits, and confusing them
 * invalidates a series' entire draft. That is why it is an explicit mode and not a
 * boolean called `fearless`.
 */
/**
 * Re-exported for convenience: the type is defined by the SCHEMA, because the mode is
 * stored on the match and survives this section being turned off.
 * Defining it here too made two truths exist under the same name.
 */
export type { FearlessMode } from "../broadcast.schema.js";
import type { FearlessMode } from "../broadcast.schema.js";

export interface SeriesHistory {
  /** Champions picked in earlier games, per team. */
  blue: string[];
  red: string[];
}

/**
 * Champions unavailable to a team in this game.
 *
 * Only PICKS count, not bans: banning a champion in game 1 does not
 * burn it for the rest of the series — only playing it does.
 */
export function fearlessLocked(
  mode: FearlessMode,
  history: SeriesHistory,
  team: TeamSide
): Set<string> {
  if (mode === "off") return new Set();
  if (mode === "team") return new Set(history[team]);
  return new Set([...history.blue, ...history.red]);
}

// ── Transition ───────────────────────────────────────────────────────────────

export type DraftResult = { ok: true; state: DraftState } | { ok: false; reason: string };

export interface ApplyOptions {
  order?: DraftStep[];
  fearless?: { mode: FearlessMode; history: SeriesHistory };
}

/**
 * Applies a pick to the draft.
 *
 * Rejects, in this order and for different reasons:
 *
 *   1. Draft finished — there is no turn to apply anything to.
 *   2. Champion already used in THIS draft — two teams cannot take the same one.
 *   3. Champion burned by Fearless — it is the format's rule, and skipping it
 *      invalidates the series, so it is checked here and not in the interface.
 *
 * A skipped ban (`championId: null`) is valid: in competition a ban is skipped
 * by mistake or on purpose, and the draft has to continue.
 */
export function applySelection(
  state: DraftState,
  championId: string | null,
  options: ApplyOptions = {}
): DraftResult {
  const order = options.order ?? STANDARD_DRAFT_ORDER;
  const step = state.current;

  if (!step) return { ok: false, reason: "The draft is already complete" };

  if (championId !== null) {
    const used = state.selections.some((s) => s.championId === championId && s.action === "pick");
    const banned = state.selections.some((s) => s.championId === championId && s.action === "ban");
    if (used || banned) {
      return { ok: false, reason: `"${championId}" is already out in this draft` };
    }

    if (options.fearless && options.fearless.mode !== "off") {
      const locked = fearlessLocked(options.fearless.mode, options.fearless.history, step.team);
      if (locked.has(championId)) {
        return {
          ok: false,
          reason: `"${championId}" was already played in this series (Fearless ${options.fearless.mode})`,
        };
      }
    }
  }

  const selections = [
    ...state.selections,
    { index: step.index, team: step.team, action: step.action, championId },
  ];
  const next = order[step.index + 1] ?? null;

  return {
    ok: true,
    state: { selections, current: next, complete: next === null },
  };
}

/**
 * Undoes the last step.
 *
 * It exists because in a production booth people press the wrong button. Without this, a wrong
 * pick forces restarting the whole draft in front of the audience.
 */
export function undoSelection(
  state: DraftState,
  order: DraftStep[] = STANDARD_DRAFT_ORDER
): DraftState {
  if (state.selections.length === 0) return state;
  const selections = state.selections.slice(0, -1);
  return {
    selections,
    current: order[selections.length] ?? null,
    complete: false,
  };
}

// ── Reading for the overlay ──────────────────────────────────────────────────

export interface DraftView {
  bans: { blue: (string | null)[]; red: (string | null)[] };
  picks: { blue: string[]; red: string[] };
  /** Current turn, to highlight the slot being waited on. */
  awaiting: DraftStep | null;
  complete: boolean;
}

/**
 * View of the draft grouped by team and action.
 *
 * The overlay paints rows of bans and columns of picks; giving it the picks
 * in chronological order would force it to regroup on the client, which is where
 * it can be tested least.
 */
export function draftView(state: DraftState): DraftView {
  const pick = (team: TeamSide) =>
    state.selections
      .filter((s) => s.team === team && s.action === "pick" && s.championId)
      .map((s) => s.championId as string);

  const ban = (team: TeamSide) =>
    state.selections.filter((s) => s.team === team && s.action === "ban").map((s) => s.championId);

  return {
    bans: { blue: ban("blue"), red: ban("red") },
    picks: { blue: pick("blue"), red: pick("red") },
    awaiting: state.current,
    complete: state.complete,
  };
}

/** Champions this draft contributes to the series history. */
export function draftedChampions(state: DraftState): SeriesHistory {
  const of = (team: TeamSide) =>
    state.selections
      .filter((s) => s.team === team && s.action === "pick" && s.championId)
      .map((s) => s.championId as string);

  return { blue: of("blue"), red: of("red") };
}

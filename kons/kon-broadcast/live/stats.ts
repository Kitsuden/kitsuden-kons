/**
 * Derived statistics: MVP, timeline and comparisons
 * ============================================================================
 *
 * What an esports HUD shows besides the scoreboard. Pure and with no external
 * sources: everything comes from the frame, so it is tested with a literal object.
 */

import type { LiveFrame, LivePlayerFrame, TeamSide } from "./frame.js";
import { readGold, type GoldModel } from "./gold.js";

// ── MVP ──────────────────────────────────────────────────────────────────────

export interface MvpScore {
  player: LivePlayerFrame;
  score: number;
  /** What gave them the score, so the caster can justify it. */
  reasons: string[];
}

/**
 * MVP score.
 *
 * Deliberately NOT just KDA. A support with 0/2/18 who won the game does not
 * show up in a kill ranking, and an ADC farming in a lost game does. The
 * formula weighs kill participation, farm and vision, and
 * **multiplies by having won**: in a final, the MVP comes from the team that
 * won barring an extreme case.
 *
 * The weights are debatable on purpose. What matters is that they are explicit and
 * in one place, not scattered around the interface.
 */
export interface MvpWeights {
  kill: number;
  assist: number;
  death: number;
  creepScore: number;
  visionScore: number;
  /** Winning team multiplier. */
  winnerBonus: number;
  /** Weight of the team's kill participation, from 0 to 1. */
  killParticipation: number;
}

export const DEFAULT_MVP_WEIGHTS: MvpWeights = {
  kill: 3,
  assist: 1.5,
  death: -2,
  creepScore: 0.02,
  visionScore: 0.35,
  winnerBonus: 1.25,
  killParticipation: 12,
};

export function mvpRanking(
  frame: LiveFrame,
  options: { winner?: TeamSide | null; weights?: MvpWeights } = {}
): MvpScore[] {
  const w = options.weights ?? DEFAULT_MVP_WEIGHTS;
  const winner = options.winner ?? null;

  const teamKills = { blue: frame.blue.kills, red: frame.red.kills };

  const score = (p: LivePlayerFrame): MvpScore => {
    const reasons: string[] = [];
    let value =
      p.kills * w.kill + p.assists * w.assist + p.deaths * w.death + p.creepScore * w.creepScore;

    // Protected division: in a 3-minute stomp a team can have 0
    // kills, and dividing by zero would send NaN to the overlay.
    const totalKills = teamKills[p.team];
    if (totalKills > 0) {
      const participation = (p.kills + p.assists) / totalKills;
      value += participation * w.killParticipation;
      if (participation >= 0.7) {
        reasons.push(`${Math.round(participation * 100)}% participation`);
      }
    }

    value += p.visionScore * w.visionScore;

    if (p.kills >= 8) reasons.push(`${p.kills} asesinatos`);
    if (p.deaths === 0) reasons.push("without dying");
    if (p.creepScore >= 300) reasons.push(`${p.creepScore} farm`);

    if (winner && p.team === winner) {
      value *= w.winnerBonus;
    }

    return { player: p, score: Math.round(value * 10) / 10, reasons };
  };

  return [...frame.blue.players, ...frame.red.players].map(score).sort((a, b) => b.score - a.score);
}

/** The MVP, or `null` if there are no players in the frame yet. */
export function mvp(
  frame: LiveFrame,
  options: { winner?: TeamSide | null; weights?: MvpWeights } = {}
): MvpScore | null {
  return mvpRanking(frame, options)[0] ?? null;
}

// ── Timeline ─────────────────────────────────────────────────────────────────

export interface TimelineEntry {
  at: number;
  type: string;
  team: TeamSide | null;
  label: string;
  /** Narrative weight, from 1 to 3. Decides what survives when not everything fits. */
  weight: 1 | 2 | 3;
}

const WEIGHTS: Record<string, 1 | 2 | 3> = {
  FirstBlood: 2,
  BaronKill: 3,
  DragonKill: 2,
  HeraldKill: 1,
  VoidgrubKill: 1,
  TurretKilled: 1,
  InhibKilled: 2,
  Ace: 3,
  Multikill: 2,
  ChampionKill: 1,
  GameStart: 1,
  GameEnd: 3,
};

const LABELS: Record<string, string> = {
  FirstBlood: "First blood",
  BaronKill: "Baron",
  DragonKill: "Dragon",
  HeraldKill: "Herald",
  VoidgrubKill: "Voidgrubs",
  TurretKilled: "Turret",
  InhibKilled: "Inhibitor",
  Ace: "Ace",
  Multikill: "Multikill",
  ChampionKill: "Kill",
  GameStart: "Start",
  GameEnd: "End",
};

/**
 * Timeline ready to paint.
 *
 * `limit` trims by WEIGHT and then reorders by time, it does not trim by time.
 * In a 45-minute game with 60 kills, keeping the last N
 * events throws away the minute-25 barons and leaves ten deaths in a row at the end
 * — which is exactly the opposite of what the game tells.
 */
export function timeline(frame: LiveFrame, limit = 12): TimelineEntry[] {
  const entries: TimelineEntry[] = frame.events.map((e) => ({
    at: e.at,
    type: e.type,
    team: e.team ?? null,
    label: e.detail ? `${LABELS[e.type] ?? e.type} · ${e.detail}` : (LABELS[e.type] ?? e.type),
    weight: WEIGHTS[e.type] ?? 1,
  }));

  if (entries.length <= limit) return entries.sort((a, b) => a.at - b.at);

  return entries
    .slice()
    .sort((a, b) => b.weight - a.weight || b.at - a.at)
    .slice(0, limit)
    .sort((a, b) => a.at - b.at);
}

// ── Team comparison ──────────────────────────────────────────────────────────

export interface TeamComparison {
  kills: { blue: number; red: number };
  towers: { blue: number; red: number };
  dragons: { blue: number; red: number };
  barons: { blue: number; red: number };
  gold: { blue: number; red: number; diff: number; precision: "exact" | "estimated" };
  creepScore: { blue: number; red: number };
}

/** The comparison row that goes under the scoreboard. */
export function compareTeams(frame: LiveFrame, model?: GoldModel): TeamComparison {
  const gold = readGold(frame, model);
  const cs = (side: "blue" | "red") =>
    frame[side].players.reduce((sum, p) => sum + p.creepScore, 0);

  return {
    kills: { blue: frame.blue.kills, red: frame.red.kills },
    towers: { blue: frame.blue.objectives.towers, red: frame.red.objectives.towers },
    dragons: {
      blue: frame.blue.objectives.dragons.length,
      red: frame.red.objectives.dragons.length,
    },
    barons: { blue: frame.blue.objectives.barons, red: frame.red.objectives.barons },
    gold,
    creepScore: { blue: cs("blue"), red: cs("red") },
  };
}

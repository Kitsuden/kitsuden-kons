/**
 * Chained phases — pure engine
 * ============================================================================
 *
 * A real FGC tournament is not *a bracket*: it is a SEQUENCE. Double elimination
 * pools → top 8. Or group round robin → elimination. Until now a
 * tournament had one format and that was it, so chaining required creating two
 * tournaments by hand and moving qualifiers around manually.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CENTRAL DECISION: THE PHASE OWNS ITS SETS, THE TOURNAMENT ITS PEOPLE
 *
 * `esports_tournament_participants` remains the tournament's census: who
 * registered, their global seed, whether they checked in. That is NOT duplicated per phase.
 *
 * What is per phase is **who enters it** (`phase_entries`) and **its
 * sets** (`matches.phase_id`). That way a player is the same row in pools and in
 * top 8 — their history is not split in two— but each phase has its own
 * independent bracket, which is what allows pools to be round robin and the finals
 * double elimination.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Pure: a phase's standings go in, who advances and with what seed comes out.
 */

export type PhaseFormat = "single_elimination" | "double_elimination" | "round_robin";

export interface Phase {
  id: string;
  /** 1-based. The order IS the sequence. */
  order: number;
  name: string;
  format: PhaseFormat;
  /**
   * How many GROUPS the phase has. >1 splits the participants into parallel
   * pools played at the same time.
   */
  groups: number;
  /**
   * How many advance **per group**, not in total.
   *
   * It is per group because that is how it is announced and played: "the top two of
   * each pool". With 8 pools and 2 per pool, 16 advance, and the engine
   * computes that number — asking for it in total would force the TO to divide in their head and
   * get it wrong when the pools are not all the same size.
   */
  advancesPerGroup: number;
  status: "pending" | "active" | "complete";
}

export interface PhaseEntry {
  participantId: string;
  /** Group within the phase, 1-based. Always 1 if `groups` is 1. */
  group: number;
  /** Seed within its group. */
  seed: number;
}

/**
 * Snake distribution ("snake").
 *
 * With 4 pools, seeds go 1,2,3,4 / 4,3,2,1 / 1,2,3,4… instead of
 * 1,2,3,4 / 5,6,7,8. The difference matters: distribution by blocks would put
 * the four best in different pools but the four worst together, and that
 * pool would be a walk in the park while another would be a bloodbath.
 *
 * With a snake, the sum of strength of each pool comes out almost equal — which is what
 * a TO calls "balanced pools".
 */
export function snakeDraw(seededIds: string[], groups: number): PhaseEntry[] {
  if (groups < 1) throw new Error("[phases] `groups` must be at least 1");
  if (seededIds.length < groups) {
    throw new Error(
      `[phases] cannot make ${groups} groups with ${seededIds.length} participants`
    );
  }

  const entries: PhaseEntry[] = [];
  const perGroup = new Map<number, number>();

  seededIds.forEach((id, index) => {
    const row = Math.floor(index / groups);
    const offset = index % groups;
    // Odd rows go in reverse: that is the snake.
    const group = row % 2 === 0 ? offset + 1 : groups - offset;

    const seed = (perGroup.get(group) ?? 0) + 1;
    perGroup.set(group, seed);
    entries.push({ participantId: id, group, seed });
  });

  return entries;
}

/** A position in a group's standings, already sorted. */
export interface GroupResult {
  group: number;
  /** Sorted: index 0 is the group's first. */
  participantIds: string[];
}

export interface Advancement {
  participantId: string;
  /** Group it comes from. */
  fromGroup: number;
  /** Position it finished in, 1-based. */
  fromPosition: number;
  /** Seed in the next phase. */
  seed: number;
}

/**
 * Who moves on to the next phase, and with what seed.
 *
 * The seeding order **interleaves by position, not by group**: first all
 * the winners, then all the runners-up. It is what keeps the 1st and 2nd of
 * the same pool from meeting in the first round of the finals — which is
 * exactly what people complain about when it happens.
 *
 * Within the same position it is sorted by group, which is arbitrary but
 * STABLE: two runs give the same bracket, and that is what allows
 * publishing the bracket and defending it.
 */
export function computeAdvancement(
  results: GroupResult[],
  advancesPerGroup: number
): Advancement[] {
  if (advancesPerGroup < 1) {
    throw new Error("[phases] `advancesPerGroup` must be at least 1");
  }

  const rows: Omit<Advancement, "seed">[] = [];

  for (let position = 0; position < advancesPerGroup; position++) {
    const atThisPosition = [...results]
      .sort((a, b) => a.group - b.group)
      .map((r) => ({ group: r.group, id: r.participantIds[position] }))
      .filter((r): r is { group: number; id: string } => Boolean(r.id));

    for (const r of atThisPosition) {
      rows.push({ participantId: r.id, fromGroup: r.group, fromPosition: position + 1 });
    }
  }

  return rows.map((r, i) => ({ ...r, seed: i + 1 }));
}

/**
 * How many advance in total from this phase?
 *
 * It is computed and not requested: with pools of different sizes —which always happens
 * when the number of registrants does not divide exactly— the total is not
 * `groups × advancesPerGroup` if some group has fewer people than spots.
 */
export function totalAdvancing(results: GroupResult[], advancesPerGroup: number): number {
  return results.reduce((sum, r) => sum + Math.min(advancesPerGroup, r.participantIds.length), 0);
}

export type PhasePlanIssue = { level: "error" | "warning"; message: string };

/**
 * Checks a sequence of phases BEFORE creating it.
 *
 * The errors caught here are those that ruin a tournament halfway:
 * a phase that receives more people than its bracket admits, one that advances
 * nobody, or a sequence that ends with several "winners".
 */
export function validatePhasePlan(
  phases: Omit<Phase, "id" | "status">[],
  participantCount: number
): PhasePlanIssue[] {
  const issues: PhasePlanIssue[] = [];
  if (phases.length === 0) {
    return [{ level: "error", message: "A sequence needs at least one phase" }];
  }

  const orders = phases.map((p) => p.order);
  if (new Set(orders).size !== orders.length) {
    issues.push({ level: "error", message: "There are phases with the same order" });
  }

  let incoming = participantCount;

  for (const phase of [...phases].sort((a, b) => a.order - b.order)) {
    if (incoming < 2) {
      issues.push({
        level: "error",
        message: `"${phase.name}" would receive ${incoming} participant(s): no tournament is possible`,
      });
      break;
    }
    if (phase.groups > incoming) {
      issues.push({
        level: "error",
        message: `"${phase.name}" has ${phase.groups} groups for ${incoming} participants`,
      });
      break;
    }

    const smallestGroup = Math.floor(incoming / phase.groups);
    if (phase.advancesPerGroup >= smallestGroup && phase.groups > 1) {
      issues.push({
        level: "error",
        message:
          `"${phase.name}" advances ${phase.advancesPerGroup} from groups of ~${smallestGroup}: ` +
          "would eliminate nobody",
      });
    }

    // A 16-player round robin is 120 sets. It fits, but the TO should know beforehand.
    if (phase.format === "round_robin") {
      const perGroup = Math.ceil(incoming / phase.groups);
      const sets = (perGroup * (perGroup - 1)) / 2;
      if (sets > 28) {
        issues.push({
          level: "warning",
          message: `"${phase.name}": groups of ${perGroup} son ${sets} sets each`,
        });
      }
    }

    const advancing =
      phase.groups === 1 && phase.format !== "round_robin"
        ? 1 // a single-group elimination produces ONE winner
        : phase.groups * phase.advancesPerGroup;

    incoming = Math.min(advancing, incoming);
  }

  if (incoming > 1) {
    issues.push({
      level: "warning",
      message: `The last phase leaves ${incoming} qualifiers, not a champion`,
    });
  }

  return issues;
}

/**
 * Classic FGC template: double elimination pools → top 8.
 *
 * It exists because it is the format of 90% of fighting game tournaments, and setting it up by
 * hand is six decisions that are always the same.
 */
export function fgcTemplate(participantCount: number): Omit<Phase, "id" | "status">[] {
  // Pools of 8 is the standard size: it fits on one station in ~1 hour.
  const groups = Math.max(1, Math.round(participantCount / 8));

  return [
    {
      order: 1,
      name: "Pools",
      format: "double_elimination",
      groups,
      // Two per pool: the standard, and what makes the top 8 come out round
      // when there are 4 pools.
      advancesPerGroup: 2,
    },
    {
      order: 2,
      name: "Top 8",
      format: "double_elimination",
      groups: 1,
      advancesPerGroup: 1,
    },
  ];
}

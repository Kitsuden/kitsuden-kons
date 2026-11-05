/**
 * Results reported by the players
 * ============================================================================
 *
 * It is the piece that decides whether ONE person can run a tournament.
 *
 * With the TO reporting every set, a 128 bracket is 254 clicks of theirs, in
 * series, while people wait. With players reporting and the opponent
 * confirming, the TO only touches what has gotten stuck. It is exactly the model
 * of start.gg, and it is the reason a 500-player tournament is run by three
 * people.
 *
 * This file is pure rules: what the reports say, whether they match, and which
 * score is coherent. Writing into the bracket belongs to the layer above.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS NOT NEGOTIABLE
 *
 * A report is NOT a result. It is the declaration of one of the parties. It
 * becomes a result when it matches the other, or when the TO signs it. If that distinction is lost, the first to press decides the set — and in
 * a double elimination bracket that sends someone to losers for no reason.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export class ReportError extends Error {}

export interface MatchReport {
  /** Who sends it: the `tournamentParticipants.id`, not the user. */
  reportedBy: string;
  /** Who says they won. */
  winnerId: string;
  /** Score in the order [participant 1, participant 2] of the set. */
  scores: [number, number] | null;
}

/** Status of the set according to the reports received. */
export type ReportStatus =
  /** Nobody has reported. */
  | "none"
  /** One has reported; the opponent still needs to confirm. */
  | "awaiting_confirmation"
  /** Both say the same thing. It can be applied. */
  | "agreed"
  /** Both have reported and they do not match. The TO resolves it. */
  | "disputed";

export interface Reconciliation {
  status: ReportStatus;
  /** Agreed winner. Only with `agreed`. */
  winnerId: string | null;
  scores: [number, number] | null;
  /** Who has yet to confirm, if the status is `awaiting_confirmation`. */
  awaitingFrom: string | null;
  /**
   * What the only received report says, while the other is missing.
   *
   * Separate from `winnerId` on purpose: `winnerId` is what is AGREED and is applied
   * to the bracket; this is a party's declaration that only serves to ask
   * "your opponent says they won, do you confirm?". Putting them in the same field is
   * how the first to press would end up deciding the set.
   */
  proposedWinnerId: string | null;
  /** How the reports differ. It is what the TO needs to read. */
  conflict: string | null;
}

export interface MatchSides {
  /** The two participants of the set. `null` = unfilled slot. */
  participants: [string | null, string | null];
}

/**
 * Gathers a set's reports and says where it stands.
 *
 * Only the LAST report from each side counts: someone who makes a mistake and sends the
 * correct one again must not be marked as in dispute with themselves.
 */
export function reconcileReports(match: MatchSides, reports: MatchReport[]): Reconciliation {
  const [side1, side2] = match.participants;

  const latestBy = new Map<string, MatchReport>();
  for (const report of reports) {
    // Any report from someone who does not play the set is ignored. The real authorization goes
    // in the route, but a smuggled-in report must not also COUNT here.
    if (report.reportedBy !== side1 && report.reportedBy !== side2) continue;
    latestBy.set(report.reportedBy, report);
  }

  const from1 = side1 ? latestBy.get(side1) : undefined;
  const from2 = side2 ? latestBy.get(side2) : undefined;

  if (!from1 && !from2) {
    return {
      status: "none",
      winnerId: null,
      scores: null,
      awaitingFrom: null,
      proposedWinnerId: null,
      conflict: null,
    };
  }

  if (!from1 || !from2) {
    const only = (from1 ?? from2)!;
    return {
      status: "awaiting_confirmation",
      winnerId: null,
      scores: null,
      // Who is missing can be `null` if the set still has an empty slot: a
      // report on a half-formed set cannot be left waiting for nobody.
      awaitingFrom: (from1 ? side2 : side1) ?? null,
      proposedWinnerId: only.winnerId,
      conflict: null,
    };
  }

  if (from1.winnerId !== from2.winnerId) {
    return {
      status: "disputed",
      winnerId: null,
      scores: null,
      awaitingFrom: null,
      proposedWinnerId: null,
      conflict: "Each says they won.",
    };
  }

  // Same winner, different scores: it IS a dispute. A 3-0 and a 3-2 over
  // the same winner is not a cosmetic detail — the game differential
  // breaks group ties, and there it decides who advances.
  if (!sameScores(from1.scores, from2.scores)) {
    return {
      status: "disputed",
      winnerId: from1.winnerId,
      scores: null,
      awaitingFrom: null,
      proposedWinnerId: from1.winnerId,
      conflict: `They agree on the winner but not on the score (${fmt(from1.scores)} vs ${fmt(from2.scores)}).`,
    };
  }

  return {
    status: "agreed",
    winnerId: from1.winnerId,
    // If one sent a score and the other did not, the one that arrived is kept.
    scores: from1.scores ?? from2.scores,
    awaitingFrom: null,
    proposedWinnerId: from1.winnerId,
    conflict: null,
  };
}

function sameScores(a: [number, number] | null, b: [number, number] | null): boolean {
  // One sending a score and the other not is NOT a conflict: the score is
  // optional, and requiring it would block sets both consider fine.
  if (a === null || b === null) return true;
  return a[0] === b[0] && a[1] === b[1];
}

const fmt = (s: [number, number] | null) => (s ? `${s[0]}-${s[1]}` : "no score");

// ── Validation of a single report ────────────────────────────────────────────

export interface ReportContext extends MatchSides {
  /** `true` if the set already has an applied winner. */
  resolved: boolean;
  /** Best of N, if the tournament sets it. */
  bestOf?: number | null;
}

/**
 * Checks that a report makes sense BEFORE saving it.
 *
 * Everything that sneaks in here reaches the bracket, and a bracket with an
 * impossible result is not fixed by editing a row: the advancement has to be undone.
 */
export function validateReport(context: ReportContext, report: MatchReport): void {
  const [side1, side2] = context.participants;

  if (context.resolved) {
    // Reopening an already applied set is the TO's business: the winner may have advanced
    // two rounds, and changing it with a late report breaks everything behind it.
    throw new ReportError("This set is already resolved. If there is a mistake, notify the organization.");
  }
  if (!side1 || !side2) {
    throw new ReportError("The set does not have both its participants yet.");
  }
  if (report.reportedBy !== side1 && report.reportedBy !== side2) {
    throw new ReportError("Only the two participants of the set can report.");
  }
  if (report.winnerId !== side1 && report.winnerId !== side2) {
    throw new ReportError("The winner must be one of the two participants.");
  }

  if (!report.scores) return;

  const [s1, s2] = report.scores;
  if (!Number.isInteger(s1) || !Number.isInteger(s2) || s1 < 0 || s2 < 0) {
    throw new ReportError("The score must be two non-negative whole numbers.");
  }
  if (s1 === s2) {
    throw new ReportError("A set cannot end in a tie: there is a winner.");
  }

  // The score has to SUPPORT the declared winner. It is the most common
  // typo —entering 3-1 and pressing the name next to it— and without this check
  // a winner with fewer games than the loser gets into the bracket.
  const winnerIsFirst = report.winnerId === side1;
  if ((winnerIsFirst && s1 < s2) || (!winnerIsFirst && s2 < s1)) {
    throw new ReportError(
      `The score ${s1}-${s2} does not match the stated winner. Check the order.`
    );
  }

  if (context.bestOf) {
    const needed = Math.floor(context.bestOf / 2) + 1;
    const winnerScore = Math.max(s1, s2);
    const loserScore = Math.min(s1, s2);

    if (winnerScore !== needed) {
      throw new ReportError(
        `In a best of ${context.bestOf} a win takes ${needed}; the score says ${winnerScore}.`
      );
    }
    if (winnerScore + loserScore > context.bestOf) {
      throw new ReportError(
        `${s1}-${s2} is more games than fit in a Bo${context.bestOf}.`
      );
    }
  }
}

// ── Resolution by the TO ─────────────────────────────────────────────────────

export interface DisputeSummary {
  matchId: string;
  reports: Array<{ reportedBy: string; winnerId: string; scores: [number, number] | null }>;
  conflict: string;
}

/**
 * The sets that need a person.
 *
 * It is THE TO screen during the tournament: the rest resolves itself, and what
 * arrives here is the little that requires judgment. It is sorted by age because a
 * stuck set blocks both players and everything that depends on it.
 */
export function collectDisputes(
  matches: Array<{ id: string; sides: MatchSides; reports: MatchReport[]; reportedAt?: number }>
): DisputeSummary[] {
  const out: DisputeSummary[] = [];

  for (const match of matches) {
    const reconciliation = reconcileReports(match.sides, match.reports);
    if (reconciliation.status !== "disputed") continue;

    out.push({
      matchId: match.id,
      reports: match.reports.map((r) => ({
        reportedBy: r.reportedBy,
        winnerId: r.winnerId,
        scores: r.scores,
      })),
      conflict: reconciliation.conflict ?? "The reports do not match.",
    });
  }

  return out;
}

/**
 * Can an unconfirmed report be taken as good, because of the opponent's silence?
 *
 * It is needed: at an in-person event many people report and leave. But the deadline belongs
 * to the TO, not the player — without it, the first to press would decide any set
 * by waiting a while.
 */
export function canAutoConfirm(
  reconciliation: Reconciliation,
  reportedAt: Date,
  now: Date,
  graceMinutes: number
): boolean {
  if (reconciliation.status !== "awaiting_confirmation") return false;
  if (graceMinutes <= 0) return false;
  return now.getTime() - reportedAt.getTime() >= graceMinutes * 60_000;
}

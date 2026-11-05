/**
 * Check-in — pure engine
 * ============================================================================
 *
 * In a 128-player tournament with open registration, between 15% and 30% do
 * not show up. Without check-in that is 20-40 first-round sets waiting for
 * someone who is not there, and half an hour lost before starting.
 *
 * Check-in turns "registered" into "is here now". What is done with those
 * who do not confirm is a TO decision, not the engine's — that is why there are
 * two outcomes (`drop` and `dq`) and neither is the silent default.
 *
 * Pure, like the rest: a state and a time go in, a decision comes out.
 */

export type CheckInState =
  /** Not open yet. The time can be seen, but not confirmed. */
  | "scheduled"
  /** Open: participants confirm. */
  | "open"
  /** Closed: confirmation is no longer accepted. */
  | "closed"
  /** The tournament does not use check-in. */
  | "disabled";

export interface CheckInWindow {
  opensAt: Date | null;
  closesAt: Date | null;
}

/**
 * State of the check-in window.
 *
 * Without `closesAt` the window does not close by itself: there are tournaments
 * where the TO closes by hand when they see the room full, and forcing a time
 * would require inventing one.
 */
export function checkInState(window: CheckInWindow, now: Date): CheckInState {
  if (!window.opensAt) return "disabled";
  if (now < window.opensAt) return "scheduled";
  if (window.closesAt && now >= window.closesAt) return "closed";
  return "open";
}

/** Seconds left until it opens or closes. `null` if not applicable. */
export function checkInCountdown(window: CheckInWindow, now: Date): number | null {
  const state = checkInState(window, now);
  if (state === "scheduled" && window.opensAt) {
    return Math.ceil((window.opensAt.getTime() - now.getTime()) / 1000);
  }
  if (state === "open" && window.closesAt) {
    return Math.ceil((window.closesAt.getTime() - now.getTime()) / 1000);
  }
  return null;
}

export type CheckInResult = { ok: true } | { ok: false; reason: string };

/**
 * Can this participant confirm now?
 *
 * Confirming twice is accepted silently (`ok`), not rejected: the player
 * who presses the button twice because they did not see the change should not
 * get an error, and the final result is the same.
 */
export function canCheckIn(
  window: CheckInWindow,
  participant: { status: string; checkedInAt: Date | null },
  now: Date
): CheckInResult {
  const state = checkInState(window, now);

  if (state === "disabled") return { ok: false, reason: "This tournament does not use check-in" };
  if (state === "scheduled") {
    return { ok: false, reason: "Check-in has not opened yet" };
  }
  if (state === "closed") return { ok: false, reason: "Check-in has already closed" };

  // A rejected player does not confirm: if allowed, they would show up in the list of
  // present players and someone would put them in the bracket.
  if (participant.status === "Rejected") {
    return { ok: false, reason: "Your registration was rejected" };
  }

  return { ok: true };
}

/**
 * What check-in needs from a participant.
 *
 * It is called `CheckInParticipant` and not `Participant` because the bracket
 * engine already exports a `Participant` with another meaning —the one who
 * competes, with their seeding rating—. Two types with the same name and
 * different fields in the same package is a trap for whoever imports with
 * autocomplete.
 */
export interface CheckInParticipant {
  id: string;
  status: string;
  checkedInAt: Date | null;
  eliminated: boolean;
}

export interface CheckInSummary {
  total: number;
  checkedIn: number;
  missing: number;
  /** Ids of those who have NOT confirmed and could have. */
  missingIds: string[];
  /**
   * And those who HAVE. It exists for symmetry with `missingIds`, so the panel can
   * offer to undo a check-in: `DELETE /participant/:id/check-in` existed
   * from the start and there was no way to know whom to apply it to, so
   * one extra click at the table was permanent.
   */
  checkedInIds: string[];
}

/**
 * Summary for the TO panel.
 *
 * Rejected players do NOT count as absent: they were never going to play, and counting them
 * would inflate the number the TO uses to decide whether to wait five more minutes.
 */
export function checkInSummary(participants: CheckInParticipant[]): CheckInSummary {
  const eligible = participants.filter((p) => p.status !== "Rejected");
  const missing = eligible.filter((p) => !p.checkedInAt);

  return {
    total: eligible.length,
    checkedIn: eligible.length - missing.length,
    missing: missing.length,
    missingIds: missing.map((p) => p.id),
    checkedInIds: eligible.filter((p) => p.checkedInAt).map((p) => p.id),
  };
}

/**
 * What to do with someone who did not confirm.
 *
 * `drop` — leaves the tournament. It is correct BEFORE generating the bracket: the
 *          bracket is computed over who is present, so byes fall where they should.
 * `dq`   — stays in the bracket but marked as eliminated. It is correct
 *          AFTER generating it: removing them then would redo the whole bracket and
 *          move people who already know when they play.
 *
 * Choosing wrong here is the costly mistake: doing `drop` with the bracket
 * published reorders pairings that people already have on their phones.
 */
export type NoShowAction = "drop" | "dq";

export interface NoShowPlan {
  action: NoShowAction;
  participantIds: string[];
  /** How many would be left playing. Used to warn before executing. */
  remaining: number;
}

export function planNoShows(participants: CheckInParticipant[], action: NoShowAction): NoShowPlan {
  const summary = checkInSummary(participants);
  return {
    action,
    participantIds: summary.missingIds,
    remaining: summary.checkedIn,
  };
}

/**
 * Is it safe to execute this plan?
 *
 * With fewer than two participants there is no tournament, and finding out AFTER having
 * deleted registrations is irreversible. It is checked beforehand.
 */
export function validateNoShowPlan(plan: NoShowPlan): CheckInResult {
  if (plan.participantIds.length === 0) {
    return { ok: false, reason: "There are no absentees: everyone has confirmed" };
  }
  if (plan.remaining < 2) {
    return {
      ok: false,
      reason:
        `Only ${plan.remaining} participant(s) have confirmed; ` +
        "removing the absentees would leave the tournament with no possible bracket.",
    };
  }
  return { ok: true };
}

/**
 * Public registration
 * ============================================================================
 *
 * What separates a bracket engine from a tournament platform: that
 * people can sign up on their own. Until now registering required a CMS session, which
 * meant the TO had to type in 128 people — exactly the reason
 * nobody would leave start.gg.
 *
 * This file is only RULES: what status the registration has, whether one more
 * fits, and who is next when someone leaves. No database, so that tests can
 * pin down the cases that really hurt.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MOST NOTICEABLE DECISION: THE WAITING LIST IS NOT RENUMBERED
 *
 * The natural thing would be that when #3 leaves, #4 becomes #3. It is a mistake:
 *
 *   · It rewrites N rows every time someone is deleted, and people delete themselves in
 *     bursts when the schedule is announced.
 *   · With two withdrawals at once, two concurrent promotions compute the same
 *     slot and end up with DUPLICATE positions — two people "number 3", and
 *     one of them is left out for no visible reason.
 *
 * So `waitlistPosition` is an ARRIVAL ORDER number that only grows and
 * is never reused, and "you are 3rd in the queue" is COMPUTED by counting how many
 * are ahead. One write per registration, zero per someone else's withdrawal.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type RegistrationMode = "closed" | "open" | "approval";

/** What needs to be known about the tournament in order to decide. */
export interface RegistrationTournament {
  registrationMode: RegistrationMode;
  registrationOpensAt: Date | null;
  registrationClosesAt: Date | null;
  maxParticipants: number;
  waitlistEnabled: boolean;
  requiresRulesAcceptance: boolean;
  /** `true` if teams compete. Decides whether entering without an account is allowed. */
  isTeamEvent: boolean;
  /** Only consulted in 1v1: in teams the account is always mandatory. */
  allowGuestRegistration: boolean;
  /**
   * `true` when the bracket is already generated.
   *
   * It is what truly CLOSES registration, beyond the clock: putting someone
   * into an already seeded bracket would force redoing the draw and moving
   * pairings that people are already looking at.
   */
  bracketGenerated: boolean;
}

export type RegistrationState =
  /** The tournament does not allow public registration. */
  | "closed"
  /** Not open yet. */
  | "scheduled"
  | "open"
  /** Open, but with no spots: goes onto the waiting list if there is one. */
  | "full"
  /** Closed by the clock. */
  | "ended"
  /** Closed because the bracket already exists. */
  | "locked";

export interface RegistrationCounts {
  /** Actually registered (not counting the waiting list). */
  registered: number;
  waitlisted: number;
}

export function registrationState(
  tournament: RegistrationTournament,
  counts: RegistrationCounts,
  now: Date
): RegistrationState {
  // Order matters: `locked` beats everything else because it is irreversible.
  // A tournament with the bracket made and the window still open would keep
  // saying "open" and accepting people who fit in no bracket.
  if (tournament.bracketGenerated) return "locked";
  if (tournament.registrationMode === "closed") return "closed";

  if (tournament.registrationOpensAt && now < tournament.registrationOpensAt) return "scheduled";
  if (tournament.registrationClosesAt && now >= tournament.registrationClosesAt) return "ended";

  return counts.registered >= tournament.maxParticipants ? "full" : "open";
}

/** Free spots. Never negative: a tournament may have gone over by hand. */
export function spotsLeft(tournament: RegistrationTournament, counts: RegistrationCounts): number {
  return Math.max(0, tournament.maxParticipants - counts.registered);
}

export interface RegistrationAttempt {
  acceptedRules: boolean;
  /** `true` if that identity is already registered in this tournament. */
  alreadyRegistered: boolean;
  /** `true` if signing up WITHOUT an account, with only their email. */
  isGuest: boolean;
}

/**
 * Does this tournament allow someone to enter without an account?
 *
 * **In teams, NEVER, and it is not configurable.** A team needs a captain who
 * answers, invitations someone accepts and a roster that is still the
 * same next week; none of that rests on an identity that is
 * created and forgotten the same afternoon. Leaving it as a checkbox a TO
 * could tick by accident would leave the door open to ghost rosters.
 *
 * In 1v1 yes, and by default: asking for an account in a community 1v1 is where
 * half the people are lost.
 */
export function guestRegistrationAllowed(tournament: RegistrationTournament): boolean {
  if (tournament.isTeamEvent) return false;
  return tournament.allowGuestRegistration;
}

/**
 * Is this an email that can be used to make contact?
 *
 * Deliberately basic check: the real validation is that the
 * personal link does —or does not— reach that mailbox. An elaborate regular expression
 * rejects odd valid addresses and does not catch made-up ones.
 */
export function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 5 || trimmed.length > 160) return false;
  if (/\s/.test(trimmed)) return false;
  const at = trimmed.indexOf("@");
  if (at <= 0 || at !== trimmed.lastIndexOf("@")) return false;
  const domain = trimmed.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

export type RegistrationOutcome =
  | { ok: true; result: "registered" }
  | { ok: true; result: "waitlisted" }
  | { ok: true; result: "pending_approval" }
  | { ok: false; reason: string; state: RegistrationState };

/**
 * Decides what happens with a registration. Does NOT write.
 *
 * It returns the reason in plain language because this message is read by a player,
 * not a developer: "registration closes on the 3rd at 8:00 PM" settles
 * the doubt; "409 Conflict" generates a message to the TO.
 */
export function planRegistration(
  tournament: RegistrationTournament,
  counts: RegistrationCounts,
  attempt: RegistrationAttempt,
  now: Date
): RegistrationOutcome {
  const state = registrationState(tournament, counts, now);

  // Checked BEFORE the window: someone already registered who presses again
  // deserves to know they are already in, not that "registration has closed".
  if (attempt.alreadyRegistered) {
    return { ok: false, reason: "You are already registered in this tournament.", state };
  }

  switch (state) {
    case "closed":
      return { ok: false, reason: "This tournament does not allow public registration.", state };
    case "scheduled":
      return {
        ok: false,
        reason: tournament.registrationOpensAt
          ? `Registration opens on ${tournament.registrationOpensAt.toISOString()}.`
          : "Registration is not open yet.",
        state,
      };
    case "ended":
      return { ok: false, reason: "Registration has already closed.", state };
    case "locked":
      return {
        ok: false,
        reason: "The bracket is already generated; no more registrations are accepted.",
        state,
      };
  }

  if (attempt.isGuest && !guestRegistrationAllowed(tournament)) {
    // Checked BEFORE the spots: whoever cannot enter this way
    // must be told what they are missing, not how many people there are. The message separates the
    // two cases because they lead to different actions — in a team tournament
    // an account AND a team are needed; in a closed 1v1, just an account.
    return {
      ok: false,
      reason: tournament.isTeamEvent
        ? "Team tournaments require an account: the team needs a captain who answers and a roster that accepts."
        : "This tournament requires an account to register.",
      state,
    };
  }

  if (tournament.requiresRulesAcceptance && !attempt.acceptedRules) {
    // Before looking at spots: accepting the rules is an entry requirement, and
    // telling someone who has not accepted them "you are on the waiting list" would be
    // promising them a spot they will not get.
    return { ok: false, reason: "The rules must be accepted in order to register.", state };
  }

  if (state === "full") {
    if (!tournament.waitlistEnabled) {
      return { ok: false, reason: "The tournament is full.", state };
    }
    return { ok: true, result: "waitlisted" };
  }

  return {
    ok: true,
    result: tournament.registrationMode === "approval" ? "pending_approval" : "registered",
  };
}

// ── Waiting list ─────────────────────────────────────────────────────────────

export interface WaitlistEntry {
  participantId: string;
  /** Arrival order. It only grows; it is never reused or renumbered. */
  waitlistPosition: number;
}

/**
 * Spot IN THE QUEUE (1 = next to get in).
 *
 * It is computed, not stored. `waitlistPosition` is arrival order and has
 * gaps as soon as someone in the queue is deleted; showing that number would say "you are
 * 47th" in a queue of three.
 */
export function queuePlace(entries: WaitlistEntry[], participantId: string): number | null {
  const sorted = [...entries].sort((a, b) => a.waitlistPosition - b.waitlistPosition);
  const index = sorted.findIndex((e) => e.participantId === participantId);
  return index === -1 ? null : index + 1;
}

/**
 * Who is next to get in when spots become free.
 *
 * Strictly by arrival order. It sounds obvious and is exactly what must be
 * hardened: as soon as one exception is allowed ("this one has a better rating") the
 * waiting list is no longer defensible against a complaint.
 */
export function planPromotions(entries: WaitlistEntry[], freeSpots: number): string[] {
  if (freeSpots <= 0) return [];
  return [...entries]
    .sort((a, b) => a.waitlistPosition - b.waitlistPosition)
    .slice(0, freeSpots)
    .map((e) => e.participantId);
}

/** Next arrival number. Monotonic even if the queue has emptied. */
export function nextWaitlistPosition(entries: WaitlistEntry[]): number {
  return entries.reduce((max, e) => Math.max(max, e.waitlistPosition), 0) + 1;
}

// ── Bajas ────────────────────────────────────────────────────────────────────

export type WithdrawalOutcome = { ok: true; freesSpot: boolean } | { ok: false; reason: string };

/**
 * Can someone withdraw on their own?
 *
 * With the bracket already generated, NO. It is not a technical restriction: withdrawing
 * would leave a hole in a bracket people have already seen, and whoever leaves
 * halfway through a tournament does not "unregister", they are disqualified — which is a decision
 * of the TO and leaves a trace.
 */
export function planWithdrawal(
  tournament: RegistrationTournament,
  participant: { waitlisted: boolean }
): WithdrawalOutcome {
  if (tournament.bracketGenerated) {
    return {
      ok: false,
      reason:
        "The bracket is already generated. Talk to the organization: from here on " +
        "a withdrawal is a disqualification, and the TO applies it.",
    };
  }
  // Leaving the waiting list does not free a spot: that person did not occupy
  // any. Confusing the two would promote someone over a phantom withdrawal.
  return { ok: true, freesSpot: !participant.waitlisted };
}

/**
 * Public registration and result reports
 * ============================================================================
 *
 * The two pieces that turn a bracket engine into a tournament
 * platform. What is pinned here are the failures that are not seen until there are
 * people in front:
 *
 *   · Someone sneaks into an already-seeded bracket.
 *   · A withdrawal from the waiting list "frees" a spot it never occupied.
 *   · Two people end up being the same position in the queue.
 *   · The first to press decides the set.
 *   · An impossible score enters the bracket and the advance has to be undone.
 */

import { describe, expect, test } from "vitest";

import {
  accessTokenMatches,
  hashAccessToken,
  issueAccessToken,
  participantLink,
  readAccessToken,
} from "../../kons/kon-esports/guest-access";
import {
  guestRegistrationAllowed,
  looksLikeEmail,
  nextWaitlistPosition,
  planPromotions,
  planRegistration,
  planWithdrawal,
  queuePlace,
  registrationState,
  spotsLeft,
  type RegistrationTournament,
} from "../../kons/kon-esports/registration";
import {
  canAutoConfirm,
  collectDisputes,
  reconcileReports,
  ReportError,
  validateReport,
  type MatchReport,
} from "../../kons/kon-esports/reporting";

// ── Registration ─────────────────────────────────────────────────────────────

const NOW = new Date("2026-08-09T12:00:00Z");

const tournament = (over: Partial<RegistrationTournament> = {}): RegistrationTournament => ({
  registrationMode: "open",
  registrationOpensAt: null,
  registrationClosesAt: null,
  maxParticipants: 16,
  waitlistEnabled: false,
  requiresRulesAcceptance: false,
  isTeamEvent: false,
  allowGuestRegistration: true,
  bracketGenerated: false,
  ...over,
});

const counts = (registered: number, waitlisted = 0) => ({ registered, waitlisted });

describe("registration status", () => {
  test("open when there is no window and room is left", () => {
    expect(registrationState(tournament(), counts(3), NOW)).toBe("open");
  });

  test("`closed` is the DEFAULT: opening it is a decision", () => {
    // A tournament does not start admitting the public just by existing.
    expect(registrationState(tournament({ registrationMode: "closed" }), counts(0), NOW)).toBe(
      "closed"
    );
  });

  test("before the time it is `scheduled`, not `closed`", () => {
    // The difference matters: one you return to, the other you do not.
    const t = tournament({ registrationOpensAt: new Date("2026-08-10T00:00:00Z") });
    expect(registrationState(t, counts(0), NOW)).toBe("scheduled");
  });

  test("past the closing time, `ended`", () => {
    const t = tournament({ registrationClosesAt: new Date("2026-08-09T11:00:00Z") });
    expect(registrationState(t, counts(0), NOW)).toBe("ended");
  });

  test("full when capacity is reached", () => {
    expect(registrationState(tournament(), counts(16), NOW)).toBe("full");
  });

  test("THE GENERATED BRACKET beats everything else", () => {
    // It is what truly closes registration: with the window open and
    // free spots, it would still say "open" and accept people who do not fit in
    // any bracket. Redoing the draw would move pairings that people are already
    // looking at.
    const t = tournament({
      bracketGenerated: true,
      registrationClosesAt: new Date("2026-08-30T00:00:00Z"),
    });
    expect(registrationState(t, counts(2), NOW)).toBe("locked");
  });

  test("free spots are never negative", () => {
    // A TO may have added people by hand above capacity.
    expect(spotsLeft(tournament(), counts(20))).toBe(0);
  });
});

describe("apuntarse", () => {
  const attempt = (over = {}) => ({
    acceptedRules: true,
    alreadyRegistered: false,
    isGuest: false,
    ...over,
  });

  test("with room, it gets in", () => {
    expect(planRegistration(tournament(), counts(3), attempt(), NOW)).toEqual({
      ok: true,
      result: "registered",
    });
  });

  test("in `approval` mode it stays pending, not inside", () => {
    const t = tournament({ registrationMode: "approval" });
    expect(planRegistration(t, counts(3), attempt(), NOW)).toEqual({
      ok: true,
      result: "pending_approval",
    });
  });

  test("whoever is already registered reads THAT THEY ARE IN, not that it closed", () => {
    // It is the message that avoids the message to the TO. It is checked before the
    // window precisely for that reason.
    const t = tournament({ registrationClosesAt: new Date("2026-08-09T11:00:00Z") });
    const result = planRegistration(t, counts(5), attempt({ alreadyRegistered: true }), NOW);
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/already registered/);
  });

  test("full WITH waiting list: to the queue", () => {
    const t = tournament({ waitlistEnabled: true });
    expect(planRegistration(t, counts(16), attempt(), NOW)).toEqual({
      ok: true,
      result: "waitlisted",
    });
  });

  test("full WITHOUT waiting list: out", () => {
    const result = planRegistration(tournament(), counts(16), attempt(), NOW);
    expect(result).toMatchObject({ ok: false, state: "full" });
  });

  test("without accepting the rules you do NOT get in, NOT EVEN to the waiting list", () => {
    // Telling "you are in the queue" to someone who has not accepted would be promising them a
    // spot they will not receive.
    const t = tournament({ requiresRulesAcceptance: true, waitlistEnabled: true });
    const result = planRegistration(t, counts(16), attempt({ acceptedRules: false }), NOW);
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/rules must be accepted/);
  });

  test("with the bracket made, the reason SAYS so", () => {
    const t = tournament({ bracketGenerated: true });
    const result = planRegistration(t, counts(2), attempt(), NOW);
    expect((result as { reason: string }).reason).toMatch(/bracket is already generated/);
  });
});

describe("waiting list", () => {
  const queue = [
    { participantId: "a", waitlistPosition: 1 },
    { participantId: "b", waitlistPosition: 2 },
    { participantId: "c", waitlistPosition: 3 },
  ];

  test("the place in the queue is CALCULATED, not stored", () => {
    // After #1 leaves, `b` still has position 2 but is 1st in the queue.
    // Showing the stored number would say "you are 2nd" when nobody is
    // ahead — or "you are 47" in a queue of three.
    const afterDeparture = queue.filter((e) => e.participantId !== "a");
    expect(queuePlace(afterDeparture, "b")).toBe(1);
    expect(queuePlace(afterDeparture, "c")).toBe(2);
  });

  test("whoever is not in the queue has no place", () => {
    expect(queuePlace(queue, "zzz")).toBeNull();
  });

  test("promotes STRICTLY in order of arrival", () => {
    // As soon as an exception is admitted ("this one has a better rating"), the waiting
    // list is no longer defensible in the face of a complaint.
    expect(planPromotions(queue, 2)).toEqual(["a", "b"]);
  });

  test("arrival order rules even if the rows come unordered", () => {
    const shuffled = [queue[2], queue[0], queue[1]];
    expect(planPromotions(shuffled, 1)).toEqual(["a"]);
  });

  test("without free spots it promotes nobody", () => {
    expect(planPromotions(queue, 0)).toEqual([]);
    expect(planPromotions(queue, -3)).toEqual([]);
  });

  test("more spots than queue does not invent people", () => {
    expect(planPromotions(queue, 99)).toEqual(["a", "b", "c"]);
  });

  test("the arrival number is NOT reused", () => {
    // Reusing it is how two people end up being the same slot: two
    // concurrent registrations compute the same free gap.
    const afterDepartures = [{ participantId: "c", waitlistPosition: 3 }];
    expect(nextWaitlistPosition(afterDepartures)).toBe(4);
  });

  test("the empty queue starts at 1", () => {
    expect(nextWaitlistPosition([])).toBe(1);
  });
});

describe("withdrawing", () => {
  test("a registrant frees a spot", () => {
    expect(planWithdrawal(tournament(), { waitlisted: false })).toEqual({
      ok: true,
      freesSpot: true,
    });
  });

  test("leaving the QUEUE frees nothing", () => {
    // That person did not occupy a spot. Confusing it would promote someone over
    // a phantom withdrawal and put one too many into the tournament.
    expect(planWithdrawal(tournament(), { waitlisted: true })).toEqual({
      ok: true,
      freesSpot: false,
    });
  });

  test("with the bracket made, one does NOT delete oneself", () => {
    // It would leave a gap in a bracket that people have already seen. From then on
    // a withdrawal is a disqualification, and the TO applies it.
    const result = planWithdrawal(tournament({ bracketGenerated: true }), { waitlisted: false });
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/a withdrawal is a disqualification/);
  });
});

// ── Signing up WITHOUT an account ────────────────────────────────────────────

describe("guests: 1v1 yes, teams NEVER", () => {
  const guest = (over = {}) => ({
    acceptedRules: true,
    alreadyRegistered: false,
    isGuest: true,
    ...over,
  });

  test("in 1v1 you can get in with just the email", () => {
    // It is the route that decides whether a community grows: someone arriving from a tweet
    // does not want one more account, they want to play.
    expect(guestRegistrationAllowed(tournament())).toBe(true);
    expect(planRegistration(tournament(), counts(3), guest(), NOW)).toEqual({
      ok: true,
      result: "registered",
    });
  });

  test("in TEAMS it is not admitted, even if the tournament has it enabled", () => {
    // The checkbox is not even consulted: a team needs a captain who answers and
    // invitations that someone accepts, and that cannot rest on identities
    // that are created and forgotten the same afternoon. Making it configurable would be
    // leaving the door open to ghost rosters.
    const teamEvent = tournament({ isTeamEvent: true, allowGuestRegistration: true });
    expect(guestRegistrationAllowed(teamEvent)).toBe(false);

    const result = planRegistration(teamEvent, counts(0), guest(), NOW);
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/needs a captain/);
  });

  test("a 1v1 can require an account on purpose", () => {
    // There are communities with an annual ranking, or that already had multiple accounts.
    const closed = tournament({ allowGuestRegistration: false });
    const result = planRegistration(closed, counts(0), guest(), NOW);
    expect((result as { reason: string }).reason).toMatch(/requires an account/);
  });

  test("the team and closed-1v1 messages are DIFFERENT", () => {
    // They lead to different actions: in teams an account AND a team are needed; in a
    // closed 1v1, only an account.
    const team = planRegistration(tournament({ isTeamEvent: true }), counts(0), guest(), NOW);
    const only = planRegistration(
      tournament({ allowGuestRegistration: false }),
      counts(0),
      guest(),
      NOW
    );
    expect((team as { reason: string }).reason).not.toBe((only as { reason: string }).reason);
  });

  test("with an account, a team tournament does NOT reject for this", () => {
    // The restriction is about getting in WITHOUT an account, not about the format.
    const teamEvent = tournament({ isTeamEvent: true });
    expect(planRegistration(teamEvent, counts(0), { ...guest(), isGuest: false }, NOW).ok).toBe(
      true
    );
  });

  test("the 'account needed' notice comes BEFORE the spots one", () => {
    // Someone who cannot get in this way has to be told what they lack, not
    // how many people there are.
    const full = tournament({ isTeamEvent: true, maxParticipants: 4 });
    const result = planRegistration(full, counts(4), guest(), NOW);
    expect((result as { reason: string }).reason).toMatch(/needs a captain/);
  });
});

describe("the guest's email", () => {
  test("accepts what is a mailbox", () => {
    for (const email of ["ana@ejemplo.com", "a.b+torneo@sub.ejemplo.co.uk"]) {
      expect(looksLikeEmail(email)).toBe(true);
    }
  });

  test("rejects what cannot receive a link", () => {
    for (const bad of ["", "ana", "ana@", "@ejemplo.com", "ana@ejemplo", "a b@x.com", "a@@x.com"]) {
      expect(looksLikeEmail(bad), bad).toBe(false);
    }
  });

  test("validation is BASIC on purpose", () => {
    // The real check is whether the link reaches that inbox or not. An
    // elaborate regular expression rejects odd but valid addresses and does not
    // catch a single made-up one.
    expect(looksLikeEmail("raro!#$%@ejemplo.com")).toBe(true);
  });
});

// ── The personal link ────────────────────────────────────────────────────────

describe("guest's personal link", () => {
  test("each link is different", () => {
    const a = issueAccessToken();
    const b = issueAccessToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });

  test("the HASH is stored, not the link", () => {
    // In the clear, a database leak would give the ability to report results
    // on behalf of everyone.
    const { token, hash } = issueAccessToken();
    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  test("the hash is deterministic: that is why it can be indexed", () => {
    const { token, hash } = issueAccessToken();
    expect(hashAccessToken(token)).toBe(hash);
  });

  test("the token travels through URL and email without breaking", () => {
    // base64url: nothing to escape, nothing that breaks when copied.
    expect(issueAccessToken().token).not.toMatch(/[+/=]/);
  });

  test("comparing different hashes gives false, and does not blow up with different lengths", () => {
    expect(accessTokenMatches("abc", "abcd")).toBe(false);
    const { hash } = issueAccessToken();
    expect(accessTokenMatches(hash, hash)).toBe(true);
  });

  test("the token is read from the header AND from the query", () => {
    // The header is the right way; the query is what is needed, because the
    // link arrives by email and is opened by clicking.
    const headers = new Headers({ "x-participant-token": "de-cabecera" });
    expect(readAccessToken(headers, "https://x.com/t/1/me")).toBe("de-cabecera");
    expect(readAccessToken(new Headers(), "https://x.com/t/1/me?token=de-query")).toBe("de-query");
  });

  test("the header WINS over the query", () => {
    const headers = new Headers({ "x-participant-token": "good" });
    expect(readAccessToken(headers, "https://x.com/?token=vieja")).toBe("good");
  });

  test("without a token, null; never an empty string", () => {
    // An empty string would hash the same and look up a constant hash in the
    // database — which is how a credential failure turns into a hit.
    expect(readAccessToken(new Headers(), "https://x.com/")).toBeNull();
    expect(
      readAccessToken(new Headers({ "x-participant-token": "  " }), "https://x.com/")
    ).toBeNull();
    expect(readAccessToken(new Headers(), "https://x.com/?token=")).toBeNull();
  });

  test("the link carries the tournament and the escaped token", () => {
    const link = participantLink("https://mi-sitio.com/", "t-1", "a+b/c");
    expect(link).toBe("https://mi-sitio.com/t/t-1/me?token=a%2Bb%2Fc");
  });
});

// ── Result reports ───────────────────────────────────────────────────────────

const sides = { participants: ["p1", "p2"] as [string | null, string | null] };
const report = (
  by: string,
  winner: string,
  scores: [number, number] | null = null
): MatchReport => ({
  reportedBy: by,
  winnerId: winner,
  scores,
});

describe("reconcile reports", () => {
  test("without reports, there is nothing", () => {
    expect(reconcileReports(sides, [])).toMatchObject({ status: "none", winnerId: null });
  });

  test("a single report does NOT resolve the set", () => {
    // It is the rule that stops the first to press from deciding. The proposed
    // winner travels separately, so we can ask "do you confirm?".
    const result = reconcileReports(sides, [report("p1", "p1", [3, 1])]);
    expect(result.status).toBe("awaiting_confirmation");
    expect(result.winnerId).toBeNull();
    expect(result.proposedWinnerId).toBe("p1");
    expect(result.awaitingFrom).toBe("p2");
  });

  test("both agree: it can be applied", () => {
    const result = reconcileReports(sides, [
      report("p1", "p1", [3, 1]),
      report("p2", "p1", [3, 1]),
    ]);
    expect(result).toMatchObject({ status: "agreed", winnerId: "p1", scores: [3, 1] });
  });

  test("each says they won: dispute", () => {
    const result = reconcileReports(sides, [report("p1", "p1"), report("p2", "p2")]);
    expect(result.status).toBe("disputed");
    expect(result.winnerId).toBeNull();
  });

  test("same winner and a different SCORE is ALSO a dispute", () => {
    // This is not a cosmetic detail: the game differential breaks ties in groups, and
    // there it decides who advances to the next phase.
    const result = reconcileReports(sides, [
      report("p1", "p1", [3, 0]),
      report("p2", "p1", [3, 2]),
    ]);
    expect(result.status).toBe("disputed");
    expect(result.conflict).toMatch(/3-0.*3-2/);
  });

  test("one sending a score and the other not is NOT a conflict", () => {
    // The score is optional; requiring it would block sets that both consider
    // fine. The one that arrived is kept.
    const result = reconcileReports(sides, [report("p1", "p1", [3, 1]), report("p2", "p1", null)]);
    expect(result).toMatchObject({ status: "agreed", winnerId: "p1", scores: [3, 1] });
  });

  test("only the LAST report from each side counts", () => {
    // Whoever makes a mistake and corrects it cannot end up in dispute with themselves.
    const result = reconcileReports(sides, [
      report("p1", "p2", [0, 3]),
      report("p1", "p1", [3, 0]),
      report("p2", "p1", [3, 0]),
    ]);
    expect(result).toMatchObject({ status: "agreed", winnerId: "p1" });
  });

  test("a report from someone NOT in the set does not count", () => {
    // Authorization lives in the route, but a smuggled-in report must not add up
    // here either and turn a "confirmation missing" into an agreement.
    const result = reconcileReports(sides, [report("p1", "p1"), report("intruso", "p1")]);
    expect(result.status).toBe("awaiting_confirmation");
  });

  test("a set with an empty slot waits for no one", () => {
    const halfSet = { participants: ["p1", null] as [string | null, string | null] };
    const result = reconcileReports(halfSet, [report("p1", "p1")]);
    expect(result.status).toBe("awaiting_confirmation");
    expect(result.awaitingFrom).toBeNull();
  });
});

describe("validate a report before saving it", () => {
  const context = (over = {}) => ({ ...sides, resolved: false, ...over });

  test("a correct report passes", () => {
    expect(() => validateReport(context(), report("p1", "p1", [3, 1]))).not.toThrow();
  });

  test("an ALREADY RESOLVED set is not reopened by a report", () => {
    // The winner may have advanced two rounds; changing it breaks what came before.
    expect(() => validateReport(context({ resolved: true }), report("p1", "p1"))).toThrow(
      ReportError
    );
  });

  test("only the two in the set report", () => {
    expect(() => validateReport(context(), report("intruso", "p1"))).toThrow(
      /Only the two participants/
    );
  });

  test("the winner has to be one of the two", () => {
    expect(() => validateReport(context(), report("p1", "fantasma"))).toThrow(/one of the two/);
  });

  test("the score has to SUPPORT the winner", () => {
    // The most common typo: entering 3-1 and clicking the name next to it.
    // Without this, a winner with fewer games than the loser enters the bracket.
    expect(() => validateReport(context(), report("p1", "p2", [3, 1]))).toThrow(/does not match/);
  });

  test("there are no ties", () => {
    expect(() => validateReport(context(), report("p1", "p1", [2, 2]))).toThrow(/tie/);
  });

  test("no negatives or decimals", () => {
    expect(() => validateReport(context(), report("p1", "p1", [3, -1]))).toThrow(/whole numbers/);
    expect(() => validateReport(context(), report("p1", "p1", [3, 1.5]))).toThrow(/whole numbers/);
  });

  test("a Bo3 does not allow a 3-2", () => {
    expect(() => validateReport(context({ bestOf: 3 }), report("p1", "p1", [3, 2]))).toThrow(
      /a win takes 2/
    );
  });

  test("a Bo5 does allow a 3-2", () => {
    expect(() => validateReport(context({ bestOf: 5 }), report("p1", "p1", [3, 2]))).not.toThrow();
  });

  test("without a score it is accepted: the score is optional", () => {
    expect(() => validateReport(context({ bestOf: 3 }), report("p1", "p1", null))).not.toThrow();
  });
});

describe("what reaches the TO", () => {
  test("only the disputes, with the reason written down", () => {
    // This is THE TO screen during the tournament: everything else resolves itself.
    const disputes = collectDisputes([
      { id: "m1", sides, reports: [report("p1", "p1"), report("p2", "p1")] },
      { id: "m2", sides, reports: [report("p1", "p1"), report("p2", "p2")] },
      { id: "m3", sides, reports: [report("p1", "p1")] },
    ]);

    expect(disputes.map((d) => d.matchId)).toEqual(["m2"]);
    expect(disputes[0].conflict).toMatch(/Each says they won/);
  });
});

describe("auto-confirmation by silence", () => {
  const pending = reconcileReports(sides, [report("p1", "p1", [3, 0])]);
  const reportedAt = new Date("2026-08-09T12:00:00Z");

  test("once the deadline has passed, it can be taken as good", () => {
    // Needed: at an in-person event many people report and leave.
    const later = new Date("2026-08-09T12:31:00Z");
    expect(canAutoConfirm(pending, reportedAt, later, 30)).toBe(true);
  });

  test("before the deadline, no", () => {
    const soon = new Date("2026-08-09T12:10:00Z");
    expect(canAutoConfirm(pending, reportedAt, soon, 30)).toBe(false);
  });

  test("with deadline 0 it NEVER auto-confirms", () => {
    // It is the default value: without a deadline, the first to press would decide
    // any set just by waiting a while.
    const muchLater = new Date("2026-08-10T00:00:00Z");
    expect(canAutoConfirm(pending, reportedAt, muchLater, 0)).toBe(false);
  });

  test("a dispute is not auto-confirmed no matter how much time passes", () => {
    const disputed = reconcileReports(sides, [report("p1", "p1"), report("p2", "p2")]);
    const muchLater = new Date("2026-08-10T00:00:00Z");
    expect(canAutoConfirm(disputed, reportedAt, muchLater, 30)).toBe(false);
  });
});

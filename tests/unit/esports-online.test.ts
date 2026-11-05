/**
 * Online operation: notices, teams and broadcasting
 * ============================================================================
 *
 * What changes when the tournament does NOT happen in a room. And what breaks:
 *
 *   · The same notice arrives four times and people mute the bot.
 *   · A "complete" team shows up with three people because the substitutes
 *     counted.
 *   · The Twitch embed loads BLACK, with no error, on tournament day.
 *   · The room code ends up where anyone can read it.
 */

import { describe, expect, test } from "vitest";

import {
  canWatch,
  channelUrl,
  checkInvite,
  checkRoster,
  dedupeKeyFor,
  embedUrl,
  normalizeHost,
  planMatchReady,
  planQueue,
  planStreamCall,
  NOTIFICATION_TYPES,
  type MatchNotificationInput,
  type RosterMember,
} from "../../kons/kon-esports/online";

// ── Notices ──────────────────────────────────────────────────────────────────

const side = (id: string, name: string, handle: string | null = null) => ({
  participantId: id,
  displayName: name,
  contactHandle: handle,
});

const matchInput = (over: Partial<MatchNotificationInput> = {}): MatchNotificationInput => ({
  matchId: "m1",
  bracketMatchId: "W2M1",
  roundLabel: "Winners Round 2",
  sides: [side("p1", "Ahri", "ahri#1"), side("p2", "Zed", "zed#2")],
  ...over,
});

describe("avisos", () => {
  test("the dedup key comes from the FACT, never from the moment", () => {
    // If it carried the time, every bot retry would be a new notice and
    // people would get the same DM four times — which is how a tournament bot
    // ends up muted.
    const a = dedupeKeyFor("match.ready", "m1", "p1");
    const b = dedupeKeyFor("match.ready", "m1", "p1");
    expect(a).toBe(b);
    expect(a).not.toBe(dedupeKeyFor("match.ready", "m1", "p2"));
  });

  test("a notice with no recipient is told apart from a personal one", () => {
    expect(dedupeKeyFor("checkin.open", "t1", null)).toContain("all");
  });

  test("a ready set generates ONE notice per player, each with THEIR rival", () => {
    // A generic notice would oblige the bot to resolve who is whose rival, and
    // for a bot writing DMs that goes wrong the first time.
    const planned = planMatchReady(matchInput());

    expect(planned).toHaveLength(2);
    expect(planned[0].payload).toMatchObject({ you: "Ahri", opponent: "Zed" });
    expect(planned[1].payload).toMatchObject({ you: "Zed", opponent: "Ahri" });
  });

  test("the payload is SELF-CONTAINED: the bot needs no other call", () => {
    const payload = planMatchReady(matchInput())[0].payload;
    for (const key of ["matchId", "bracketMatchId", "round", "you", "opponent"]) {
      expect(payload).toHaveProperty(key);
    }
  });

  test("a half-formed set notifies NOBODY", () => {
    // Notifying about a set with no rival sends someone to wait for nobody.
    expect(planMatchReady(matchInput({ sides: [side("p1", "Ahri"), null] }))).toEqual([]);
  });

  test("the room code travels ONLY in the notice of whoever plays", () => {
    const planned = planMatchReady(
      matchInput({ station: { name: "Sala 3", accessDetails: "código 8842" } })
    );
    expect(planned).toHaveLength(2);
    for (const notification of planned) {
      expect(notification.payload.stationAccess).toBe("código 8842");
      // And it is addressed: `participantId` is never null in this type.
      expect(notification.participantId).not.toBeNull();
    }
  });

  test("going on camera is a SEPARATE notice from set ready", () => {
    // It happens later, and sometimes much later: a set can be ready twenty
    // minutes before production decides to put it on. Putting it in the same
    // notice would force delaying the first.
    const planned = planStreamCall(
      matchInput({ stream: { platform: "twitch", channel: "micomunidad" } })
    );
    expect(planned.map((n) => n.type)).toEqual(["match.stream", "match.stream"]);
    expect(planned[0].payload).toMatchObject({ platform: "twitch", channel: "micomunidad" });
  });

  test("with no stream configured, no camera notice is sent", () => {
    expect(planStreamCall(matchInput())).toEqual([]);
  });

  test("the types are a CLOSED list", () => {
    // A bot receiving a type it does not know cannot write the message.
    // With a free string, adding one would pass without anyone noticing until
    // seeing empty DMs.
    expect(NOTIFICATION_TYPES).toContain("match.ready");
    expect(new Set(NOTIFICATION_TYPES).size).toBe(NOTIFICATION_TYPES.length);
  });
});

// ── Teams ────────────────────────────────────────────────────────────────────

const member = (id: string, role: RosterMember["role"], name = id): RosterMember => ({
  playerId: id,
  role,
  displayName: name,
});

describe("templates", () => {
  const rules = { minRosterSize: 5, maxRosterSize: 5 };

  test("a complete roster passes", () => {
    const roster = [
      member("1", "captain"),
      member("2", "player"),
      member("3", "player"),
      member("4", "player"),
      member("5", "player"),
    ];
    expect(checkRoster(roster, rules)).toMatchObject({ ok: true, starters: 5, subs: 0 });
  });

  test("SUBSTITUTES DO NOT COUNT toward the minimum", () => {
    // It is the trap that makes a team of 3 show up to a 5v5: without
    // distinguishing them, 3 starters + 2 substitutes passes entirely.
    const roster = [
      member("1", "captain"),
      member("2", "player"),
      member("3", "player"),
      member("4", "sub"),
      member("5", "sub"),
    ];
    const check = checkRoster(roster, rules);

    expect(check.ok).toBe(false);
    expect(check.starters).toBe(3);
    expect(check.subs).toBe(2);
    expect(check.issues.join(" ")).toMatch(/substitutes do not count/);
  });

  test("without a captain there is no team", () => {
    // Nobody answers for it: not to invite, not to report, not to
    // complain.
    const roster = [member("1", "player"), member("2", "player")];
    expect(
      checkRoster(roster, { minRosterSize: null, maxRosterSize: null }).issues.join(" ")
    ).toMatch(/has no captain/);
  });

  test("two captains neither", () => {
    const roster = [member("1", "captain"), member("2", "captain")];
    expect(
      checkRoster(roster, { minRosterSize: null, maxRosterSize: null }).issues.join(" ")
    ).toMatch(/2 captains/);
  });

  test("the same person twice is detected", () => {
    const roster = [member("1", "captain", "Ahri"), member("1", "player", "Ahri")];
    expect(
      checkRoster(roster, { minRosterSize: null, maxRosterSize: null }).issues.join(" ")
    ).toMatch(/twice/);
  });

  test("having too many starters is also a problem", () => {
    const roster = Array.from({ length: 7 }, (_, i) =>
      member(String(i), i === 0 ? "captain" : "player")
    );
    expect(checkRoster(roster, rules).issues.join(" ")).toMatch(/Too many starters/);
  });

  test("without roster rules, any size is valid", () => {
    const roster = [member("1", "captain")];
    expect(checkRoster(roster, { minRosterSize: null, maxRosterSize: null }).ok).toBe(true);
  });

  test("returns ALL the problems, not the first", () => {
    const roster = [member("1", "player"), member("1", "player")];
    expect(
      checkRoster(roster, { minRosterSize: 5, maxRosterSize: null }).issues.length
    ).toBeGreaterThan(1);
  });
});

describe("invitations", () => {
  const NOW = new Date("2026-08-09T12:00:00Z");

  test("a pending one within the deadline is valid", () => {
    expect(checkInvite({ status: "pending", expiresAt: null }, NOW)).toEqual({ ok: true });
  });

  test("whoever ALREADY accepted is told they are already in", () => {
    // And not that it "has expired", which is what would come out if the deadline were
    // looked at before the status.
    const result = checkInvite(
      { status: "accepted", expiresAt: new Date("2020-01-01T00:00:00Z") },
      NOW
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/already on this team/);
  });

  test("an expired one says so and explains what to do", () => {
    const result = checkInvite(
      { status: "pending", expiresAt: new Date("2026-08-01T00:00:00Z") },
      NOW
    );
    expect((result as { reason: string }).reason).toMatch(/expired.*captain/s);
  });

  test("a withdrawn one cannot be used", () => {
    expect(checkInvite({ status: "revoked", expiresAt: null }, NOW).ok).toBe(false);
  });
});

// ── Broadcasting ─────────────────────────────────────────────────────────────

describe("stream links", () => {
  test("the channel, not a URL pasted by hand", () => {
    expect(channelUrl("twitch", "micomunidad")).toBe("https://www.twitch.tv/micomunidad");
    expect(channelUrl("kick", "micomunidad")).toBe("https://kick.com/micomunidad");
  });

  test("YouTube distinguishes handle from channel id", () => {
    expect(channelUrl("youtube", "@micanal")).toContain("%40micanal/live");
    expect(channelUrl("youtube", "UC123")).toContain("channel/UC123/live");
  });
});

describe("embebido", () => {
  test("Twitch REQUIRES the domain that embeds", () => {
    // Without `parent`, or with one that does not match, Twitch gives no error: it loads the
    // player and stays BLACK. A black stream on tournament day, with
    // nothing in the console, is one of the most expensive failures to diagnose.
    const url = embedUrl("twitch", "micomunidad", "mi-sitio.com")!;
    expect(url).toContain("parent=mi-sitio.com");
    expect(url).toContain("channel=micomunidad");
  });

  test("without a valid domain NO Twitch embed is generated", () => {
    // Returning a URL without `parent` would be returning a black screen.
    expect(embedUrl("twitch", "x", "")).toBeNull();
    expect(embedUrl("twitch", "x", "no es un dominio")).toBeNull();
  });

  test("the `parent` is the HOSTNAME: no scheme, no slash, no port", () => {
    for (const input of ["https://mi-sitio.com", "mi-sitio.com/", "https://mi-sitio.com:8443/x"]) {
      expect(normalizeHost(input)).toBe("mi-sitio.com");
    }
  });

  test("localhost is valid, so it can be tested in development", () => {
    expect(normalizeHost("http://localhost:5173")).toBe("localhost");
  });

  test("the host is normalized to lowercase", () => {
    expect(normalizeHost("Mi-Sitio.COM")).toBe("mi-sitio.com");
  });
});

describe("who can see the stream", () => {
  test("`registered` requires a session", () => {
    expect(canWatch("registered", false)).toBe(false);
    expect(canWatch("registered", true)).toBe(true);
  });

  test("`public` requires nothing", () => {
    expect(canWatch("public", false)).toBe(true);
  });
});

describe("broadcast queue", () => {
  const queue = [
    { matchId: "a", position: 1 },
    { matchId: "b", position: 2 },
    { matchId: "c", position: 3 },
  ];

  test("inserting at the start pushes the rest", () => {
    expect(planQueue(queue, "d", 1)).toEqual([
      { matchId: "d", position: 1 },
      { matchId: "a", position: 2 },
      { matchId: "b", position: 3 },
      { matchId: "c", position: 4 },
    ]);
  });

  test("positions stay DENSE, with no gaps", () => {
    // Unlike the registration waiting list: here the queue is ordered by
    // a person dragging and "the next one is 3" is read at a glance in
    // a booth. A gap here reads as a tool error.
    const result = planQueue(queue, "b", null);
    expect(result.map((q) => q.position)).toEqual([1, 2]);
    expect(result.map((q) => q.matchId)).toEqual(["a", "c"]);
  });

  test("moving one that was already there does not duplicate it", () => {
    const result = planQueue(queue, "c", 1);
    expect(result.map((q) => q.matchId)).toEqual(["c", "a", "b"]);
    expect(result).toHaveLength(3);
  });

  test("an impossible position is clamped, it does not fail", () => {
    // The booth is operated in a hurry; rejecting an odd number would stop the broadcast
    // over a slip of the finger.
    expect(planQueue(queue, "d", 99).at(-1)).toEqual({ matchId: "d", position: 4 });
    expect(planQueue(queue, "d", -5)[0]).toEqual({ matchId: "d", position: 1 });
  });

  test("an empty queue admits the first", () => {
    expect(planQueue([], "a", 1)).toEqual([{ matchId: "a", position: 1 }]);
  });
});

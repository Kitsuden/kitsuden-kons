/**
 * Online operation: notices, teams, play spot and broadcast
 * ============================================================================
 *
 * Pure rules for the four things that change when the tournament does NOT take place in
 * a room. No database, so that tests can pin down what really
 * breaks an online tournament — which is almost never what it looks like.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Notices
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The facts that deserve a message.
 *
 * Closed list on purpose. A bot that receives a type it does not know cannot
 * write the message, so adding types is a contract change — and with
 * a free-form string that would happen without anyone noticing until seeing empty DMs.
 */
export const NOTIFICATION_TYPES = [
  /** Your set now has both its players: time to play. */
  "match.ready",
  /** You have been told where: setup, room or code. */
  "match.station",
  /** Your set goes on camera. */
  "match.stream",
  /** Your opponent has reported; you still need to confirm. */
  "report.awaiting_confirmation",
  /** The TO has resolved a dispute of yours. */
  "report.resolved",
  /** Check-in has opened. */
  "checkin.open",
  /** Check-in is about to close on you. */
  "checkin.closing",
  /** You have gotten in from the waiting list. */
  "waitlist.promoted",
  /** You have been invited to a team. */
  "team.invited",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * Deduplication key.
 *
 * It is built from the FACT, never from the moment. The bot retries, the TO presses
 * again and a reconnection repeats the query; if the key carried the time,
 * each attempt would be a new notice and people would receive the same DM four
 * times — which is exactly how a tournament bot ends up muted.
 */
export function dedupeKeyFor(
  type: NotificationType,
  subjectId: string,
  recipientId: string | null
): string {
  return `${type}:${subjectId}:${recipientId ?? "all"}`;
}

export interface NotificationRecipient {
  participantId: string;
  /** Discord handle, if they gave one when registering. */
  contactHandle: string | null;
  displayName: string;
}

export interface PlannedNotification {
  type: NotificationType;
  participantId: string | null;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

export interface MatchNotificationInput {
  matchId: string;
  /** Readable bracket id (`W2M1`). It is what people see on the web. */
  bracketMatchId: string | null;
  roundLabel: string | null;
  sides: [NotificationRecipient | null, NotificationRecipient | null];
  station?: { name: string; accessDetails: string | null } | null;
  stream?: { platform: string; channel: string } | null;
}

/**
 * "Your set is ready" notices: one per player, each with THEIR opponent.
 *
 * A single generic notice would force the bot to resolve who is whose opponent,
 * and for a bot writing DMs that goes wrong on the first try. Here it comes out
 * chewed up already: each message knows who it goes to and against whom.
 *
 * Returns `[]` if a side is missing. A half-formed set is not ready, and
 * notifying about it sends someone to wait for nobody.
 */
export function planMatchReady(input: MatchNotificationInput): PlannedNotification[] {
  const [a, b] = input.sides;
  if (!a || !b) return [];

  const forSide = (me: NotificationRecipient, rival: NotificationRecipient) => ({
    type: "match.ready" as const,
    participantId: me.participantId,
    dedupeKey: dedupeKeyFor("match.ready", input.matchId, me.participantId),
    payload: {
      matchId: input.matchId,
      bracketMatchId: input.bracketMatchId,
      round: input.roundLabel,
      // The name is COPIED, not referenced: the notice must say what was
      // true when it happened, even if someone later renames.
      you: me.displayName,
      opponent: rival.displayName,
      opponentHandle: rival.contactHandle,
      contactHandle: me.contactHandle,
      station: input.station?.name ?? null,
      // The room code ONLY travels to whoever plays the set.
      stationAccess: input.station?.accessDetails ?? null,
      stream: input.stream ? `${input.stream.platform}/${input.stream.channel}` : null,
    },
  });

  return [forSide(a, b), forSide(b, a)];
}

/**
 * "You're going on camera" notice.
 *
 * Separate from `match.ready` because it happens AFTER and often much later:
 * a set can be ready twenty minutes before production decides
 * to put it up. Putting it in the same notice would force delaying the first.
 */
export function planStreamCall(input: MatchNotificationInput): PlannedNotification[] {
  const [a, b] = input.sides;
  const stream = input.stream;
  if (!a || !b || !stream) return [];

  return [a, b].map((side) => ({
    type: "match.stream" as const,
    participantId: side.participantId,
    dedupeKey: dedupeKeyFor("match.stream", input.matchId, side.participantId),
    payload: {
      matchId: input.matchId,
      bracketMatchId: input.bracketMatchId,
      you: side.displayName,
      opponent: (side === a ? b : a).displayName,
      platform: stream.platform,
      channel: stream.channel,
    },
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Teams
// ═══════════════════════════════════════════════════════════════════════════

export type TeamRole = "captain" | "player" | "sub";

export interface RosterMember {
  playerId: string;
  role: TeamRole;
  displayName: string;
}

export interface RosterRules {
  /** Minimum starters. `null` = the tournament does not set it. */
  minRosterSize: number | null;
  maxRosterSize: number | null;
}

export interface RosterCheck {
  ok: boolean;
  /** Starters: captain and players. Substitutes do NOT count. */
  starters: number;
  subs: number;
  issues: string[];
}

/**
 * Is this team fit to register?
 *
 * The trap this closes: **substitutes do not count toward the minimum**. Without
 * distinguishing them, a team of 3 starters with 2 substitutes passes as complete
 * for a 5v5 and on tournament day three people show up.
 */
export function checkRoster(members: RosterMember[], rules: RosterRules): RosterCheck {
  const starters = members.filter((m) => m.role !== "sub").length;
  const subs = members.filter((m) => m.role === "sub").length;
  const captains = members.filter((m) => m.role === "captain").length;
  const issues: string[] = [];

  if (captains === 0) {
    // Without a captain there is nobody to answer for the team: not to invite, not
    // to report, not to complain.
    issues.push("The team has no captain.");
  }
  if (captains > 1) {
    issues.push(`The team has ${captains} captains; there can be only one.`);
  }

  const ids = new Set<string>();
  for (const member of members) {
    if (ids.has(member.playerId)) {
      issues.push(`"${member.displayName}" is on the roster twice.`);
    }
    ids.add(member.playerId);
  }

  if (rules.minRosterSize !== null && starters < rules.minRosterSize) {
    issues.push(
      `Need ${rules.minRosterSize} starters and there are ${starters}` +
        (subs > 0 ? ` (the ${subs} substitutes do not count).` : ".")
    );
  }
  if (rules.maxRosterSize !== null && starters > rules.maxRosterSize) {
    issues.push(`Too many starters: ${starters} for a maximum of ${rules.maxRosterSize}.`);
  }

  return { ok: issues.length === 0, starters, subs, issues };
}

export interface TeamInvite {
  status: "pending" | "accepted" | "declined" | "revoked";
  expiresAt: Date | null;
}

export type InviteCheck = { ok: true } | { ok: false; reason: string };

/**
 * Is this invitation still valid?
 *
 * The states are checked BEFORE the expiry so the message is the
 * useful one: someone who already accepted must be told they are already in, not that the link
 * has expired.
 */
export function checkInvite(invite: TeamInvite, now: Date): InviteCheck {
  if (invite.status === "accepted") return { ok: false, reason: "You are already on this team." };
  if (invite.status === "declined") {
    return { ok: false, reason: "You already declined this invitation. Ask the captain for another." };
  }
  if (invite.status === "revoked") return { ok: false, reason: "The invitation was withdrawn." };
  if (invite.expiresAt && now >= invite.expiresAt) {
    return { ok: false, reason: "The invitation has expired. Ask the captain for a new one." };
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// Broadcast
// ═══════════════════════════════════════════════════════════════════════════

export type StreamPlatform = "twitch" | "youtube" | "kick";
export type ViewerAccess = "public" | "registered";

/** Link to the channel, to open it externally. */
export function channelUrl(platform: StreamPlatform, channel: string): string {
  const safe = encodeURIComponent(channel.trim());
  switch (platform) {
    case "twitch":
      return `https://www.twitch.tv/${safe}`;
    case "kick":
      return `https://kick.com/${safe}`;
    case "youtube":
      // The YouTube channel can be a handle (`@canal`) or a channel id;
      // `/live` leads to the current broadcast whichever it is.
      return `https://www.youtube.com/${channel.startsWith("@") ? safe : `channel/${safe}`}/live`;
  }
}

/**
 * URL to put in an `<iframe>`.
 *
 * **`parentHost` is mandatory and is THE trap of this.** Twitch requires the
 * embedding domain in `?parent=`, and if it does not match EXACTLY it gives no error:
 * it loads the player and stays black. A black stream on tournament day,
 * with nothing in the console, is among the most expensive failures to diagnose.
 *
 * And it must be the HOSTNAME (`mi-sitio.com`), not the URL: with a scheme or a
 * trailing slash, Twitch rejects it just as silently.
 */
export function embedUrl(
  platform: StreamPlatform,
  channel: string,
  parentHost: string
): string | null {
  const host = normalizeHost(parentHost);
  const safe = encodeURIComponent(channel.trim());

  switch (platform) {
    case "twitch":
      if (!host) return null;
      return `https://player.twitch.tv/?channel=${safe}&parent=${host}&autoplay=false`;
    case "youtube":
      return `https://www.youtube.com/embed/live_stream?channel=${safe}`;
    case "kick":
      return `https://player.kick.com/${safe}`;
  }
}

/** Leaves `mi-sitio.com` from almost anything passed to it. `null` if it is not valid. */
export function normalizeHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let host = trimmed;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
      .hostname;
  } catch {
    return null;
  }

  // Twitch does not accept a port or a slash. `localhost` DOES work, and is needed to
  // be able to test the embed in development.
  return /^[a-z0-9.-]+$/i.test(host) ? host.toLowerCase() : null;
}

/**
 * Can this person watch the stream FROM THE WEB?
 *
 * Watch what this is: a door, not a lock. It blocks Kitsuden's page and
 * embed, but the Twitch channel is still public on
 * Twitch. It serves to make watching the tournament the reason to have an account, not to
 * keep anything secret — and confusing the two would be selling a
 * privacy that does not exist.
 */
export function canWatch(access: ViewerAccess, isAuthenticated: boolean): boolean {
  return access === "public" || isAuthenticated;
}

export interface QueuedMatch {
  matchId: string;
  position: number;
}

/**
 * Puts a set in the broadcast queue, or moves it.
 *
 * Positions are REDISTRIBUTED densely (1..n) on purpose, unlike
 * the registration waiting list: here the queue is ordered by a person
 * dragging, it is short, and "the next one is 3" has to be readable at a
 * glance in a production booth. Gaps that were harmless there
 * read here as a tool error.
 */
export function planQueue(
  queue: QueuedMatch[],
  matchId: string,
  desiredPosition: number | null
): QueuedMatch[] {
  const without = queue
    .filter((q) => q.matchId !== matchId)
    .sort((a, b) => a.position - b.position);

  // `null` = take it out of the queue.
  if (desiredPosition === null) {
    return without.map((q, index) => ({ matchId: q.matchId, position: index + 1 }));
  }

  const target = Math.max(1, Math.min(desiredPosition, without.length + 1));
  const next = [...without];
  next.splice(target - 1, 0, { matchId, position: target });

  return next.map((q, index) => ({ matchId: q.matchId, position: index + 1 }));
}

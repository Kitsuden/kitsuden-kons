/**
 * Bracket engine — pure, deterministic, no database
 * ============================================================================
 *
 * Replaces the previous generator, which did `Math.log2(maxParticipants)` and
 * only knew single elimination without seeding or byes.
 *
 * Nothing from the host is imported here on purpose: it is bracket arithmetic,
 * and keeping it pure makes it exhaustively testable and reusable from the
 * CLI, a job or the kon itself. The routes only persist what this returns.
 *
 * What it covers:
 *   - **Standard seeding** (1 vs N, 2 vs N-1…) so top seeds do not meet
 *     until the end.
 *   - **Byes** when the number of participants is not a power of two: the
 *     best seeds receive them, as the rules dictate.
 *   - **Single and double elimination**, with correct routing to the losers
 *     bracket — which is where almost every implementation breaks.
 *   - **Grand final with bracket reset**: if the player coming from losers
 *     wins, a second set is played, because the other had not yet lost any.
 *   - **DQ / no-show**, distinguishing "loses the set" from "is eliminated".
 *
 * Everything is deterministic: the same inputs produce the same bracket, byte
 * for byte. The random shuffle uses an LCG with an explicit seed so a draw is
 * reproducible and auditable in case of a complaint.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type BracketFormat = "single_elimination" | "double_elimination";
export type SeedMethod = "as_entered" | "random" | "by_rating";
export type BracketSide = "winners" | "losers" | "grand_final";
/**
 * `bye`  — advanced without playing because their opponent could never arrive.
 * `void` — the whole set disappears: no occupant could reach either of the
 *          two slots (happens with byes in non-power-of-two brackets, or
 *          when a total DQ empties a branch of the losers bracket).
 */
export type MatchStatus = "pending" | "ready" | "done" | "bye" | "void";

export interface Participant {
  id: string;
  name: string;
  /** Score for `by_rating` seeding. Higher = better seed. */
  rating?: number;
}

/** Where a player goes after the set. `slot` is 0 or 1 of the destination match. */
export interface Progression {
  matchId: string;
  slot: 0 | 1;
}

export interface BracketMatch {
  /** Readable, stable id: `W2M1`, `L3M2`, `GF`, `GFR`. */
  id: string;
  side: BracketSide;
  round: number;
  order: number;
  /** Occupants. `null` = slot to be filled; a bye leaves the opponent as `null`. */
  participants: [string | null, string | null];
  winnerTo: Progression | null;
  loserTo: Progression | null;
  winnerId: string | null;
  loserId: string | null;
  status: MatchStatus;
  /** Participant disqualified in this set, if any. */
  dqId?: string | null;
}

export interface Bracket {
  format: BracketFormat;
  /** Bracket size: the power of two that encloses the participants. */
  size: number;
  participants: Participant[];
  /** Seeding order: `seeds[0]` is seed 1. */
  seeds: string[];
  matches: BracketMatch[];
  /** Definitively eliminated (DQ), even if they had life left in losers. */
  eliminated: string[];
  championId: string | null;
}

export interface CreateBracketOptions {
  format?: BracketFormat;
  seeding?: SeedMethod;
  /** Seed of the random draw. Required to reproduce it. */
  shuffleSeed?: number;
}

export interface ReportOptions {
  winnerId: string;
  /** Disqualified participant. Loses the set. */
  dqId?: string;
  /**
   * Total DQ: besides losing, they are out of the tournament even if the format
   * gave them another life in losers. It is the difference between "did not show
   * up for this set" and "left the venue".
   */
  eliminate?: boolean;
}

// ── Utilities ────────────────────────────────────────────────────────────────

/** Power of two equal or greater. */
function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Standard seeding order of a bracket of size `size`.
 *
 * It is built by reflection: at each doubling, each seed `s` is paired
 * with `total + 1 - s`. For 8 it gives [1,8,4,5,2,7,3,6], which read two by
 * two are the first-round matchups. This is what guarantees that 1 and 2
 * can only meet in the final.
 */
export function standardSeedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const total = order.length * 2 + 1;
    const next: number[] = [];
    for (const s of order) {
      next.push(s, total - s);
    }
    order = next;
  }
  return order;
}

/** Small LCG: random but reproducible draw from a seed. */
function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Sorts the participants according to the chosen seeding method. */
export function seedParticipants(
  participants: Participant[],
  method: SeedMethod = "as_entered",
  shuffleSeed = 1
): Participant[] {
  switch (method) {
    case "random":
      return seededShuffle(participants, shuffleSeed);
    case "by_rating":
      // Higher rating = better seed. Ties broken by name so it is deterministic.
      return [...participants].sort(
        (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.name.localeCompare(b.name)
      );
    case "as_entered":
    default:
      return [...participants];
  }
}

// ── Construction ─────────────────────────────────────────────────────────────

const wId = (r: number, m: number) => `W${r}M${m}`;
const lId = (r: number, m: number) => `L${r}M${m}`;
const GF = "GF";
const GF_RESET = "GFR";

function emptyMatch(id: string, side: BracketSide, round: number, order: number): BracketMatch {
  return {
    id,
    side,
    round,
    order,
    participants: [null, null],
    winnerTo: null,
    loserTo: null,
    winnerId: null,
    loserId: null,
    status: "pending",
    dqId: null,
  };
}

/**
 * Builds the complete bracket with all matchups and their routing.
 *
 * ALL matches are generated upfront, empty, with `winnerTo`/`loserTo`
 * already pointing at their destination. Advancing someone is then writing
 * into a slot — there is no need to recompute the structure after each
 * result, which is where inconsistencies come from when an already reported
 * set has to be corrected.
 */
export function createBracket(
  participants: Participant[],
  options: CreateBracketOptions = {}
): Bracket {
  const format = options.format ?? "single_elimination";
  const seeding = options.seeding ?? "as_entered";

  if (participants.length < 2) {
    throw new Error("At least 2 participants are needed to generate a bracket");
  }

  const seeded = seedParticipants(participants, seeding, options.shuffleSeed ?? 1);
  const size = nextPowerOfTwo(seeded.length);
  const k = Math.log2(size);

  // Bracket with gaps: seeds that do not exist are byes.
  const bySeed: (Participant | null)[] = Array.from({ length: size }, (_, i) => seeded[i] ?? null);

  const matches: BracketMatch[] = [];

  // ── Winners bracket ──
  for (let r = 1; r <= k; r++) {
    const count = size / Math.pow(2, r);
    for (let m = 1; m <= count; m++) {
      const match = emptyMatch(wId(r, m), "winners", r, m);
      if (r < k) {
        match.winnerTo = { matchId: wId(r + 1, Math.ceil(m / 2)), slot: ((m - 1) % 2) as 0 | 1 };
      }
      matches.push(match);
    }
  }

  // Seed the first round with the standard order.
  const order = standardSeedOrder(size);
  for (let m = 1; m <= size / 2; m++) {
    const match = matches.find((x) => x.id === wId(1, m))!;
    const seedA = order[(m - 1) * 2];
    const seedB = order[(m - 1) * 2 + 1];
    match.participants = [bySeed[seedA - 1]?.id ?? null, bySeed[seedB - 1]?.id ?? null];
  }

  // ── Losers bracket (double elimination only) ──
  if (format === "double_elimination" && k >= 2) {
    // With k winners rounds, losers has 2k-2. They alternate:
    //   odd  → "minor": losers survivors against each other
    //   even → "major": survivors vs those who just dropped from winners
    const lbRounds = 2 * k - 2;
    for (let r = 1; r <= lbRounds; r++) {
      const count = losersMatchCount(k, r);
      for (let m = 1; m <= count; m++) {
        const match = emptyMatch(lId(r, m), "losers", r, m);
        if (r < lbRounds) {
          const nextCount = losersMatchCount(k, r + 1);
          const isMajorNext = (r + 1) % 2 === 0;
          // In a "major" round the survivor takes slot 0 and the one who drops
          // from winners enters through slot 1.
          match.winnerTo = isMajorNext
            ? { matchId: lId(r + 1, m), slot: 0 }
            : { matchId: lId(r + 1, Math.ceil(m / 2)), slot: ((m - 1) % 2) as 0 | 1 };
          if (!isMajorNext && nextCount === count) {
            match.winnerTo = { matchId: lId(r + 1, m), slot: 0 };
          }
        } else {
          match.winnerTo = { matchId: GF, slot: 1 };
        }
        matches.push(match);
      }
    }

    // Route the winners losers toward losers.
    routeWinnersLosers(matches, k);

    // ── Grand final ──
    const gf = emptyMatch(GF, "grand_final", 1, 1);
    gf.winnerTo = null;
    matches.push(gf);

    const reset = emptyMatch(GF_RESET, "grand_final", 2, 1);
    matches.push(reset);

    // The winners champion enters through slot 0 of the grand final.
    const wbFinal = matches.find((x) => x.id === wId(k, 1))!;
    wbFinal.winnerTo = { matchId: GF, slot: 0 };
  } else if (format === "double_elimination" && k === 1) {
    // Two participants: they play one set, and if the undefeated one loses
    // there is a rematch. The "losers bracket" is zero rounds.
    const wbFinal = matches.find((x) => x.id === wId(1, 1))!;
    wbFinal.winnerTo = { matchId: GF, slot: 0 };
    wbFinal.loserTo = { matchId: GF, slot: 1 };
    matches.push(emptyMatch(GF, "grand_final", 1, 1));
    matches.push(emptyMatch(GF_RESET, "grand_final", 2, 1));
  }

  const bracket: Bracket = {
    format,
    size,
    participants: seeded,
    seeds: seeded.map((p) => p.id),
    matches,
    eliminated: [],
    championId: null,
  };

  // Resolve the first-round byes in cascade.
  return settleByes(bracket);
}

/** Number of matches in round `r` of the losers bracket. */
function losersMatchCount(k: number, r: number): number {
  // r=1 is fed by the losers of WB1: size/4 matches.
  // From there, each "minor" (odd) round halves and each
  // "major" (even) round keeps the size because those dropping from winners enter.
  if (r === 1) return Math.pow(2, k - 2);
  const halvings = Math.floor((r - 1) / 2);
  return Math.max(1, Math.pow(2, k - 2 - halvings));
}

/**
 * Connects each winners-bracket loser with their losers-bracket match.
 *
 * The order is reversed in alternate rounds (`reverse`) to separate those
 * who already met: without this, two players who faced each other in winners
 * meet again immediately in losers, which is exactly what the format tries
 * to avoid.
 */
function routeWinnersLosers(matches: BracketMatch[], k: number): void {
  // WB round 1 → LB round 1 (two losers per losers match).
  const wb1 = matches.filter((m) => m.side === "winners" && m.round === 1);
  wb1.forEach((m, i) => {
    m.loserTo = { matchId: lId(1, Math.floor(i / 2) + 1), slot: (i % 2) as 0 | 1 };
  });

  // WB round j (j>=2) → LB round 2(j-1), which is a "major" round.
  for (let j = 2; j <= k; j++) {
    const wbRound = matches.filter((m) => m.side === "winners" && m.round === j);
    const lbRound = 2 * (j - 1);
    const targets = matches.filter((m) => m.side === "losers" && m.round === lbRound);
    if (targets.length === 0) continue;

    const reverse = j % 2 === 0;
    wbRound.forEach((m, i) => {
      const idx = reverse ? targets.length - 1 - (i % targets.length) : i % targets.length;
      m.loserTo = { matchId: targets[idx].id, slot: 1 };
    });
  }
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** A match is ready when both its occupants are decided. */
function refreshStatus(m: BracketMatch): void {
  if (m.status === "done" || m.status === "bye" || m.status === "void") return;
  const [a, b] = m.participants;
  m.status = a !== null && b !== null ? "ready" : "pending";
}

/** The match that feeds a specific slot, if any. */
function feederFor(bracket: Bracket, matchId: string, slot: 0 | 1): BracketMatch | null {
  return (
    bracket.matches.find(
      (m) =>
        (m.winnerTo?.matchId === matchId && m.winnerTo.slot === slot) ||
        (m.loserTo?.matchId === matchId && m.loserTo.slot === slot)
    ) ?? null
  );
}

/**
 * Will this slot stay empty forever?
 *
 * It is the engine's key question. An 11-player double elimination bracket has
 * byes in winners, and those byes produce no loser: the slot that loser
 * was going to occupy in losers will never be filled. Without answering this,
 * the bracket keeps waiting for someone who does not exist and the tournament
 * never ends.
 */
function slotIsDead(bracket: Bracket, match: BracketMatch, slot: 0 | 1): boolean {
  if (match.participants[slot] !== null) return false;

  const feeder = feederFor(bracket, match.id, slot);
  if (!feeder) return true; // nobody points at this slot
  if (feeder.status === "pending" || feeder.status === "ready") return false; // someone can still arrive
  if (feeder.status === "void") return true;

  const viaWinner = feeder.winnerTo?.matchId === match.id && feeder.winnerTo.slot === slot;
  if (viaWinner) return feeder.winnerId === null;

  // Arrives via the loser path: nobody will come if the feeder was a bye
  // (there was no loser) or if that loser was eliminated by total DQ.
  return feeder.loserId === null || bracket.eliminated.includes(feeder.loserId);
}

/**
 * Resolves walkovers in cascade until a fixed point.
 *
 * One walkover uncovers the next: if someone advances without playing, they
 * also produce no loser, and that kills another slot further down. That is
 * why it iterates until nothing changes, instead of making a single pass.
 */
function settleByes(bracket: Bracket): Bracket {
  let changed = true;
  let guard = 0;

  while (changed && guard++ < 1000) {
    changed = false;

    for (const m of bracket.matches) {
      if (m.status === "done" || m.status === "bye" || m.status === "void") continue;

      // The bracket reset is not fed by any routing: `reportResult`
      // fills it in when resolving the grand final. If we treated it like the
      // rest, finding no feeder we would write it off before it was born.
      if (m.id === GF_RESET) continue;

      const [a, b] = m.participants;
      if (a !== null && b !== null) {
        m.status = "ready";
        continue;
      }

      const deadA = slotIsDead(bracket, m, 0);
      const deadB = slotIsDead(bracket, m, 1);

      if (a !== null && deadB) {
        m.status = "bye";
        m.winnerId = a;
        advance(bracket, m, a, null);
        changed = true;
      } else if (b !== null && deadA) {
        m.status = "bye";
        m.winnerId = b;
        advance(bracket, m, b, null);
        changed = true;
      } else if (a === null && b === null && deadA && deadB) {
        // Entire branch empty: the set is not played and delivers to nobody either.
        m.status = "void";
        changed = true;
      } else {
        m.status = "pending";
      }
    }
  }

  // The grand final of a double bracket can end up with no losers opponent.
  for (const m of bracket.matches) refreshStatus(m);

  // Champion by walkover: if the last survivor of the bracket advanced without playing.
  if (bracket.championId === null) {
    const gf = bracket.matches.find((m) => m.id === GF);
    if (gf && gf.status === "bye" && gf.winnerId) {
      bracket.championId = gf.winnerId;
      const reset = bracket.matches.find((m) => m.id === GF_RESET);
      if (reset && reset.status !== "done") reset.status = "void";
    } else if (bracket.format === "single_elimination") {
      const final = bracket.matches.find((m) => m.winnerTo === null && m.side === "winners");
      if (final && final.status === "bye" && final.winnerId) {
        bracket.championId = final.winnerId;
      }
    }
  }

  return bracket;
}

/** Writes winner and loser into their destinations. */
function advance(
  bracket: Bracket,
  match: BracketMatch,
  winnerId: string,
  loserId: string | null
): void {
  if (match.winnerTo) {
    const target = bracket.matches.find((m) => m.id === match.winnerTo!.matchId);
    if (target) {
      target.participants[match.winnerTo.slot] = winnerId;
      refreshStatus(target);
    }
  }
  if (loserId && match.loserTo && !bracket.eliminated.includes(loserId)) {
    const target = bracket.matches.find((m) => m.id === match.loserTo!.matchId);
    if (target) {
      target.participants[match.loserTo.slot] = loserId;
      refreshStatus(target);
    }
  }
}

/**
 * Reports the result of a set and advances the bracket.
 *
 * Returns a NEW bracket: the original is not mutated, so the route can
 * compare, validate or discard without having broken anything.
 */
export function reportResult(bracket: Bracket, matchId: string, result: ReportOptions): Bracket {
  const next: Bracket = structuredClone(bracket);
  const match = next.matches.find((m) => m.id === matchId);
  if (!match) throw new Error(`Match "${matchId}" does not exist in the bracket`);
  if (match.status === "done") throw new Error(`Match "${matchId}" already has a result`);
  if (match.status === "bye") throw new Error(`Match "${matchId}" es un bye`);
  if (match.status === "void") throw new Error(`Match "${matchId}" is not played`);

  const [a, b] = match.participants;
  if (a === null || b === null) {
    throw new Error(`Match "${matchId}" does not yet have both participants`);
  }
  if (result.winnerId !== a && result.winnerId !== b) {
    throw new Error(`"${result.winnerId}" does not play match "${matchId}"`);
  }

  const loserId = result.winnerId === a ? b : a;

  match.winnerId = result.winnerId;
  match.loserId = loserId;
  match.status = "done";
  match.dqId = result.dqId ?? null;

  // Total DQ: out of the tournament even if the format gave them another life.
  if (result.eliminate && !next.eliminated.includes(loserId)) {
    next.eliminated.push(loserId);
  }

  advance(next, match, result.winnerId, loserId);

  // ── Grand final y bracket reset ──
  if (match.id === GF) {
    const fromWinners = match.participants[0];
    if (result.winnerId === fromWinners) {
      // The undefeated one wins: it is over, no reset.
      next.championId = result.winnerId;
      const reset = next.matches.find((m) => m.id === GF_RESET);
      if (reset) reset.status = "void"; // is never played
    } else {
      // The one from losers wins: both have a loss, it is replayed.
      const reset = next.matches.find((m) => m.id === GF_RESET);
      if (reset) {
        reset.participants = [match.participants[0], match.participants[1]];
        refreshStatus(reset);
      }
    }
  } else if (match.id === GF_RESET) {
    next.championId = result.winnerId;
  } else if (next.format === "single_elimination" && !match.winnerTo) {
    // The final of a single bracket has no destination: its winner is the champion.
    next.championId = result.winnerId;
  }

  return settleByes(next);
}

// ── Query ────────────────────────────────────────────────────────────────────

/** Sets playable right now: they have both occupants and have not been reported. */
export function playableMatches(bracket: Bracket): BracketMatch[] {
  return bracket.matches.filter((m) => m.status === "ready");
}

/** Is the tournament over? */
export function isComplete(bracket: Bracket): boolean {
  return bracket.championId !== null;
}

/**
 * Status of each participant: active, eliminated or champion, and how many
 * losses they have (which in double elimination decides whether they are alive).
 */
export function getStandings(bracket: Bracket): {
  participantId: string;
  name: string;
  losses: number;
  status: "active" | "eliminated" | "champion";
}[] {
  const maxLosses = bracket.format === "double_elimination" ? 2 : 1;

  return bracket.participants.map((p) => {
    const losses = bracket.matches.filter((m) => m.loserId === p.id).length;
    let status: "active" | "eliminated" | "champion" = "active";
    if (bracket.championId === p.id) status = "champion";
    else if (bracket.eliminated.includes(p.id) || losses >= maxLosses) status = "eliminated";

    return { participantId: p.id, name: p.name, losses, status };
  });
}

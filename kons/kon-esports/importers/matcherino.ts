/**
 * Matcherino importer
 * ============================================================================
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIRST THING, BECAUSE IT CHANGES HOW THIS FILE MUST BE TREATED
 *
 * **Matcherino does not publish an API.** There is no developer portal, no token, and no
 * contract. What there is, is the internal endpoint its own website uses:
 *
 *     GET https://matcherino.com/__api/bounties/findById?id=<id>
 *
 * It is public and unauthenticated —it returns the same thing anyone sees on the
 * page— but it is INTERNAL: it may change shape or disappear without notice or
 * a version to consult. So nothing is assumed here: every field is read
 * defensively, and if the shape stops fitting the importer SAYS so instead of
 * bringing back a half-empty tournament that looks correct.
 *
 * For the same reason, this must not be run in a loop against their servers. Pool
 * synchronization is on request, not a poll.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * And why import from Matcherino, if it is not a bracket platform: because it
 * is where **the money** is. Matcherino is prize crowdfunding — the pot
 * is filled by the public buying things, and that figure growing is THE number
 * a TO wants on screen. The bracket may be on start.gg and the pot here:
 * they are two different imports onto the same tournament, and that is fine.
 */

import { ImportError, type ImportedParticipant, type ImportedTournament } from "./import.types.js";

const BASE = "https://matcherino.com/__api";

/** Defensive cap: if the response carries more, something has changed meaning. */
const MAX_PARTICIPANTS = 5000;

// ── Reference ────────────────────────────────────────────────────────────────

/**
 * Extracts the numeric id from what a TO has at hand.
 *
 * The URL works (`matcherino.com/t/my-tournament` carries no id, but
 * `matcherino.com/tournaments/112858` does), the bare id, or the link with
 * `?bountyId=`. What does not work is guessing: a slug without an id requires a query
 * this endpoint does not offer, and it is better to say so than to fail internally.
 */
export function parseMatcherinoRef(reference: string): string {
  const trimmed = reference.trim();

  if (/^\d+$/.test(trimmed)) return trimmed;

  const fromQuery = trimmed.match(/[?&](?:bountyId|id)=(\d+)/i);
  if (fromQuery) return fromQuery[1];

  const fromPath = trimmed.match(/matcherino\.com\/(?:tournaments?|bounties?|t)\/(\d+)/i);
  if (fromPath) return fromPath[1];

  const anyNumber = trimmed.match(/matcherino\.com\/[^?#]*?(\d{4,})/i);
  if (anyNumber) return anyNumber[1];

  throw new ImportError(
    "Could not find the numeric id. Matcherino identifies tournaments by a " +
      "number: open it, and use the URL that carries it (or paste the bare number). " +
      "A short link with only the name is not enough."
  );
}

// ── Client ───────────────────────────────────────────────────────────────────

interface MatcherinoEnvelope<T> {
  status: number;
  error?: { message?: string } | null;
  body: T | null;
}

async function get<T>(path: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/${path}`, {
      headers: { accept: "application/json" },
      // Bounded: the pool resync calls it with the request transaction
      // already open (it read the tournament), and Postgres cuts it at
      // 60 s of waiting. Two calls at most: 2 × 10 s.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new ImportError(`Could not contact Matcherino: ${(err as Error).message}`, true);
  }

  const text = await res.text();

  // Empty body with 200: it really happens on these endpoints (`/teams`
  // returns it when there are no teams). It is not an error, it is "there is nothing".
  if (!text.trim()) return null;

  let payload: MatcherinoEnvelope<T>;
  try {
    payload = JSON.parse(text) as MatcherinoEnvelope<T>;
  } catch {
    // HTML where JSON should be = the internal endpoint changed or there is a
    // portal in front. Saying so saves half an hour of debugging.
    throw new ImportError(
      "Matcherino responded with something that is not JSON. It is an internal, " +
        "undocumented endpoint: it may have changed.",
      false
    );
  }

  if (payload.status >= 400 || res.status >= 400) {
    const message = payload.error?.message ?? `HTTP ${res.status}`;
    // "Bounty not found" is what it answers for an id that does not exist.
    throw new ImportError(`Matcherino: ${message}`, res.status >= 500);
  }

  return payload.body ?? null;
}

// ── Shape of the response (the little we depend on) ──────────────────────────

/**
 * Only the fields that are used.
 *
 * Everything optional on purpose: it is a contract nobody signed, and declaring it
 * mandatory would only make TypeScript lie to us about what arrives.
 */
interface Bounty {
  id?: number;
  title?: string | null;
  status?: string | null;
  startAt?: string | null;
  isTeam?: boolean;
  teamSignups?: boolean;
  game?: { title?: string | null } | null;
  /** Pool in CENTS. It is the field this importer exists for. */
  balance?: number | null;
  donorCount?: number | null;
  bracketEntrants?: number | null;
  individualParticipants?: Array<{
    userId?: number | null;
    displayName?: string | null;
    avatar?: string | null;
    authProvider?: string | null;
    socialMediaIdentifier?: string | null;
  }> | null;
}

interface MatcherinoTeam {
  id?: number | null;
  name?: string | null;
  members?: Array<{ userId?: number | null; displayName?: string | null }> | null;
}

// ── Import ───────────────────────────────────────────────────────────────────

export async function importFromMatcherino(reference: string): Promise<ImportedTournament> {
  const id = parseMatcherinoRef(reference);
  const warnings: string[] = [];

  const bounty = await get<Bounty>(`bounties/findById?id=${encodeURIComponent(id)}`);
  if (!bounty) throw new ImportError(`Matcherino returns nothing for tournament ${id}`);

  const isTeamEvent = Boolean(bounty.isTeam || bounty.teamSignups);
  const participants = isTeamEvent
    ? await fetchTeams(id, bounty, warnings)
    : fetchIndividuals(bounty, warnings);

  return {
    source: "matcherino",
    externalId: id,
    url: `https://matcherino.com/tournaments/${id}`,
    title: bounty.title?.trim() || `Matcherino tournament ${id}`,
    gameName: bounty.game?.title ?? null,
    startsAt: bounty.startAt ?? null,
    isTeamEvent,
    participants,
    // Matcherino does NOT publish the bracket here: `bracketEntrants` is a number,
    // not the sets. Returning [] is the honest thing; the bracket is imported from start.gg
    // o se genera en Kitsuden.
    sets: [],
    prizePool: readPrizePool(bounty, warnings),
    warnings,
  };
}

/**
 * The pool. It is what is actually being fetched here.
 *
 * `balance` arrives in cents and as an integer. It is not divided by 100 at any point
 * along the way: converting to decimal only to go back to cents when saving is the
 * classic way to lose a cent to rounding on something people have
 * paid for out of their own pocket.
 */
function readPrizePool(bounty: Bounty, warnings: string[]) {
  const cents = bounty.balance;

  if (typeof cents !== "number" || !Number.isFinite(cents)) {
    warnings.push("Matcherino did not return the prize pool in a recognizable format.");
    return null;
  }
  if (cents < 0) {
    warnings.push(`The pool arrived negative (${cents}); ignored.`);
    return null;
  }

  return {
    cents: Math.round(cents),
    // Matcherino operates in USD and does not publish the currency on this endpoint.
    // It is set explicitly instead of leaving it empty: a figure without a currency in
    // an overlay is worse than not showing it.
    currency: "USD",
    contributors: typeof bounty.donorCount === "number" ? bounty.donorCount : null,
  };
}

function fetchIndividuals(bounty: Bounty, warnings: string[]): ImportedParticipant[] {
  const raw = bounty.individualParticipants;

  if (!Array.isArray(raw)) {
    warnings.push(
      "Matcherino did not return the list of registrants. It may be a tournament with the " +
        "registration hidden, or the internal endpoint has changed."
    );
    return [];
  }
  if (raw.length > MAX_PARTICIPANTS) {
    warnings.push(
      `Received ${raw.length} registrants; importing the first ${MAX_PARTICIPANTS}.`
    );
  }

  const out: ImportedParticipant[] = [];
  let withoutId = 0;

  for (const entry of raw.slice(0, MAX_PARTICIPANTS)) {
    // Without `userId` there is no stable identity, and without a stable identity
    // re-importing would duplicate that person. They are counted and a warning is given.
    if (typeof entry.userId !== "number") {
      withoutId += 1;
      continue;
    }
    out.push({
      externalId: String(entry.userId),
      name:
        entry.displayName?.trim() ||
        entry.socialMediaIdentifier?.trim() ||
        `User ${entry.userId}`,
      avatarUrl: entry.avatar?.trim() || null,
      // Matcherino does not publish the country or the seeding.
      country: null,
      seed: null,
    });
  }

  if (withoutId > 0) {
    warnings.push(`${withoutId} registrant(s) without a stable identifier; not imported.`);
  }

  return out;
}

/**
 * Teams.
 *
 * The endpoint exists (`/__api/teams?bountyId=`) but returns empty on the
 * tournaments it could be tried with, so its exact shape is NOT
 * verified. It is read with maximum caution and, if it does not fit, a warning is given instead of
 * inventing: importing teams halfway is worse than not importing them, because the
 * bracket is generated anyway and the failure appears on the day of the event.
 */
async function fetchTeams(
  id: string,
  bounty: Bounty,
  warnings: string[]
): Promise<ImportedParticipant[]> {
  let raw: unknown;
  try {
    raw = await get<unknown>(`teams?bountyId=${encodeURIComponent(id)}`);
  } catch (err) {
    warnings.push(`Could not fetch the teams: ${(err as Error).message}`);
    return [];
  }

  // The envelope may carry the array bare or inside a key.
  const list: MatcherinoTeam[] | null = Array.isArray(raw)
    ? (raw as MatcherinoTeam[])
    : Array.isArray((raw as { teams?: unknown })?.teams)
      ? (raw as { teams: MatcherinoTeam[] }).teams
      : null;

  if (!list) {
    warnings.push(
      "It is a team tournament, but Matcherino did not return a list of teams " +
        "that can be recognized. The teams will have to be created by hand or imported " +
        "from start.gg."
    );
    return [];
  }

  const out: ImportedParticipant[] = [];
  for (const team of list.slice(0, MAX_PARTICIPANTS)) {
    if (typeof team.id !== "number") continue;
    out.push({
      externalId: `team-${team.id}`,
      name: team.name?.trim() || `Team ${team.id}`,
      members: (team.members ?? [])
        .filter((m) => typeof m.userId === "number")
        .map((m) => ({
          externalId: String(m.userId),
          name: m.displayName?.trim() || `User ${m.userId}`,
        })),
    });
  }

  // Cross-check against the number the response itself declares: if it does not add up,
  // the TO has to know BEFORE generating the bracket.
  const declared = bounty.bracketEntrants;
  if (typeof declared === "number" && declared > 0 && out.length !== declared) {
    warnings.push(
      `Matcherino declares ${declared} participants in the bracket, but only ` +
        `managed to read ${out.length}.`
    );
  }

  return out;
}

/**
 * start.gg importer
 * ============================================================================
 *
 * start.gg is where the FGC lives: if someone organizes a tournament today, it is there,
 * with registrations closed and a seeded bracket. Asking them to type it in
 * again to see it in an overlay is asking them not to use it.
 *
 * Documented GraphQL API, with a personal token. The two published limits
 * dominate the design of this file:
 *
 *   · **80 requests per 60 seconds.** A 256-player tournament paginated by 50
 *     is ~11 requests; there is margin, but not to fire them all at once.
 *     That is why it paginates IN SERIES and not with `Promise.all`.
 *   · **1000 objects per request, counting nested ones.** A high `perPage`
 *     with nested participants does not fail on time: it fails with "Query
 *     complexity too high", an error that does not say how much to lower. Hence
 *     the conservative page sizes.
 *
 * What it does NOT do: write to start.gg. Reporting results there requires
 * organizer permissions and turns an error of ours into an error in THEIR
 * bracket, with people waiting. The import is one-way.
 */

import {
  ImportError,
  type ImportedParticipant,
  type ImportedSet,
  type ImportedTournament,
} from "./import.types.js";

const ENDPOINT = "https://api.start.gg/gql/alpha";

/**
 * Page sizes.
 *
 * Low on purpose: start.gg's limit is on OBJECTS (1000, nested ones
 * included), not rows. Each entrant carries its participants inside, so
 * 50 entrants with 8 members are already 450 objects.
 */
const ENTRANTS_PER_PAGE = 50;
const SETS_PER_PAGE = 40;

/** Page cap. A 1024-player event fits comfortably; an infinite loop does not. */
const MAX_PAGES = 60;

// ── Reference ────────────────────────────────────────────────────────────────

export interface StartggRef {
  tournamentSlug: string;
  eventSlug: string;
}

/**
 * Understands what a TO has at hand: the URL from the address bar.
 *
 * `https://www.start.gg/tournament/my-tournament/event/singles/brackets/123/456`
 *
 * It is accepted with and without `www`, with `/details`, `/overview` or any tail:
 * copying the URL from halfway into the event is NORMAL, and
 * rejecting it would require explaining which one is the right one.
 */
export function parseStartggUrl(reference: string): StartggRef {
  const trimmed = reference.trim();

  // Short form, the one that appears in the API itself: `tournament/x/event/y`.
  const direct = trimmed.match(/^tournament\/([^/]+)\/event\/([^/?#]+)/i);
  if (direct) return { tournamentSlug: direct[1], eventSlug: direct[2] };

  let path: string;
  try {
    // Chrome hides the scheme in the address bar, so what gets
    // copied from there starts with `start.gg/...` and `new URL` rejects it. Adding it
    // here is cheaper than explaining to a TO that the "https://" is missing.
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (!/(^|\.)(start\.gg|smash\.gg)$/i.test(url.hostname)) {
      throw new ImportError(`"${url.hostname}" is not a start.gg URL`);
    }
    path = url.pathname;
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw new ImportError(
      "The reference is not recognized. Paste the EVENT URL, something like " +
        "https://start.gg/tournament/my-tournament/event/singles"
    );
  }

  const match = path.match(/tournament\/([^/]+)\/event\/([^/?#]+)/i);
  if (!match) {
    throw new ImportError(
      "That URL is for the tournament, not an event. In start.gg a tournament contains " +
        "several events (Singles, Doubles…) and each has its own bracket: " +
        "open the one you want to import and copy that URL."
    );
  }

  return { tournamentSlug: match[1], eventSlug: match[2] };
}

// ── Client ───────────────────────────────────────────────────────────────────

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function query<T>(
  token: string,
  document: string,
  variables: Record<string, unknown>
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: document, variables }),
      // No start.gg page can hang the whole import.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // Network down: retrying later may work, and the caller must be able to
    // distinguish it from an invalid token, which will not.
    throw new ImportError(`Could not contact start.gg: ${(err as Error).message}`, true);
  }

  if (res.status === 401 || res.status === 403) {
    throw new ImportError(
      "start.gg rejected the token. Tokens expire after a year; generate a new one " +
        "at start.gg/admin/profile/developer."
    );
  }
  if (res.status === 429) {
    throw new ImportError(
      "start.gg rate-limited the request (80 requests/minute). Retry in a minute.",
      true
    );
  }
  if (!res.ok) {
    throw new ImportError(`start.gg responded ${res.status}`, res.status >= 500);
  }

  const payload = (await res.json()) as GraphQLResponse<T>;

  if (payload.errors?.length) {
    const message = payload.errors.map((e) => e.message).join("; ");
    // GraphQL answers 200 with errors inside; without this a rejected query
    // would pass for a valid response and the import would come out empty with no explanation.
    throw new ImportError(`start.gg: ${message}`, /complexity|rate limit/i.test(message));
  }
  if (!payload.data) throw new ImportError("start.gg returned an empty response");

  return payload.data;
}

// ── Queries ──────────────────────────────────────────────────────────────────

const EVENT_QUERY = `
  query EventBySlug($slug: String!) {
    event(slug: $slug) {
      id
      name
      startAt
      teamRosterSize { minPlayers }
      videogame { name }
      tournament { id name slug }
    }
  }
`;

const ENTRANTS_QUERY = `
  query EventEntrants($eventId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) {
      entrants(query: { page: $page, perPage: $perPage }) {
        pageInfo { totalPages }
        nodes {
          id
          name
          initialSeedNum
          participants {
            id
            gamerTag
            user { location { country } }
          }
        }
      }
    }
  }
`;

const SETS_QUERY = `
  query EventSets($eventId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) {
      sets(page: $page, perPage: $perPage, sortType: STANDARD) {
        pageInfo { totalPages }
        nodes {
          id
          winnerId
          fullRoundText
          slots {
            entrant { id }
            standing { stats { score { value } } }
          }
        }
      }
    }
  }
`;

// ── Response shapes ──────────────────────────────────────────────────────────

interface EventNode {
  id: number;
  name: string;
  startAt: number | null;
  teamRosterSize: { minPlayers: number | null } | null;
  videogame: { name: string } | null;
  tournament: { id: number; name: string; slug: string } | null;
}

interface EntrantNode {
  id: number;
  name: string | null;
  initialSeedNum: number | null;
  participants: Array<{
    id: number;
    gamerTag: string | null;
    user: { location: { country: string | null } | null } | null;
  }> | null;
}

interface SetNode {
  id: string | number;
  winnerId: number | null;
  fullRoundText: string | null;
  slots: Array<{
    entrant: { id: number } | null;
    standing: { stats: { score: { value: number | null } | null } | null } | null;
  }> | null;
}

// ── Import ───────────────────────────────────────────────────────────────────

/**
 * Fetches a whole event from start.gg.
 *
 * `fetchImpl` is injected so this can be tested without a network: it is the only way
 * to pin down in a test what happens with a half-finished bracket, a missing country or a
 * `winnerId` that points to an entrant who is no longer there.
 */
export async function importFromStartgg(
  reference: string,
  token: string,
  options: { includeSets?: boolean } = {}
): Promise<ImportedTournament> {
  if (!token) {
    throw new ImportError(
      "start.gg requires a personal token. Generate it at start.gg/admin/profile/developer."
    );
  }

  const ref = parseStartggUrl(reference);
  const slug = `tournament/${ref.tournamentSlug}/event/${ref.eventSlug}`;
  const warnings: string[] = [];

  const { event } = await query<{ event: EventNode | null }>(token, EVENT_QUERY, { slug });
  if (!event) {
    throw new ImportError(
      `start.gg cannot find "${slug}". Check the URL, and that the event is public.`
    );
  }

  // A non-null `teamRosterSize` is what marks a team event. The name
  // ("Doubles", "3v3") will not do: it is free text written by the organizer.
  const isTeamEvent = (event.teamRosterSize?.minPlayers ?? 1) > 1;

  const participants = await fetchEntrants(token, event.id, isTeamEvent, warnings);

  let sets: ImportedSet[] = [];
  if (options.includeSets !== false) {
    sets = await fetchSets(token, event.id, warnings);
  }

  return {
    source: "startgg",
    externalId: String(event.id),
    url: `https://www.start.gg/${slug}`,
    title: event.tournament ? `${event.tournament.name} — ${event.name}` : event.name,
    gameName: event.videogame?.name ?? null,
    // start.gg publishes the start time in epoch seconds; the rest of the system
    // speaks ISO. Converting here keeps every consumer from having to remember the detail.
    startsAt: event.startAt ? new Date(event.startAt * 1000).toISOString() : null,
    isTeamEvent,
    participants,
    sets,
    // start.gg does not publish the pool through the API: it lives in the rules text.
    prizePool: null,
    warnings,
  };
}

async function fetchEntrants(
  token: string,
  eventId: number,
  isTeamEvent: boolean,
  warnings: string[]
): Promise<ImportedParticipant[]> {
  const out: ImportedParticipant[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const data = await query<{
      event: { entrants: { pageInfo: { totalPages: number }; nodes: EntrantNode[] } };
    }>(token, ENTRANTS_QUERY, { eventId, page, perPage: ENTRANTS_PER_PAGE });

    const connection = data.event?.entrants;
    if (!connection) break;
    totalPages = connection.pageInfo?.totalPages ?? 1;

    for (const node of connection.nodes ?? []) {
      const members = (node.participants ?? []).map((p) => ({
        externalId: String(p.id),
        name: p.gamerTag ?? `Participant ${p.id}`,
      }));

      // The country is only taken when the entrant is ONE person. In a team,
      // the first member's would draw the flag of whoever comes first in the
      // list, which is worse than drawing none.
      const country =
        !isTeamEvent && node.participants?.length === 1
          ? normalizeCountry(node.participants[0].user?.location?.country)
          : null;

      out.push({
        externalId: String(node.id),
        name: node.name ?? members[0]?.name ?? `Entrant ${node.id}`,
        country,
        seed: node.initialSeedNum ?? null,
        members: isTeamEvent ? members : undefined,
      });
    }

    page += 1;
  } while (page <= totalPages && page <= MAX_PAGES);

  if (totalPages > MAX_PAGES) {
    warnings.push(
      `The event has ${totalPages} pages of registrants and we fetched ${MAX_PAGES}. ` +
        "Participants are missing."
    );
  }

  return out;
}

async function fetchSets(
  token: string,
  eventId: number,
  warnings: string[]
): Promise<ImportedSet[]> {
  const out: ImportedSet[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const data = await query<{
      event: { sets: { pageInfo: { totalPages: number }; nodes: SetNode[] } };
    }>(token, SETS_QUERY, { eventId, page, perPage: SETS_PER_PAGE });

    const connection = data.event?.sets;
    if (!connection) break;
    totalPages = connection.pageInfo?.totalPages ?? 1;

    for (const node of connection.nodes ?? []) {
      const slots = node.slots ?? [];
      const left = slots[0]?.entrant?.id ?? null;
      const right = slots[1]?.entrant?.id ?? null;

      const scoreOf = (index: number) => slots[index]?.standing?.stats?.score?.value ?? null;
      const leftScore = scoreOf(0);
      const rightScore = scoreOf(1);

      out.push({
        externalId: String(node.id),
        participants: [left === null ? null : String(left), right === null ? null : String(right)],
        winnerExternalId: node.winnerId === null ? null : String(node.winnerId),
        roundLabel: node.fullRoundText ?? null,
        // A DQ on start.gg travels as a score of -1. Bringing it as is would draw
        // "-1" on the overlay; with no score you see the set and who won, which is
        // what is true.
        scores:
          leftScore !== null && rightScore !== null && leftScore >= 0 && rightScore >= 0
            ? [leftScore, rightScore]
            : null,
      });
    }

    page += 1;
  } while (page <= totalPages && page <= MAX_PAGES);

  if (totalPages > MAX_PAGES) {
    warnings.push(`The bracket has ${totalPages} pages of sets and we fetched ${MAX_PAGES}.`);
  }

  return out;
}

/**
 * start.gg publishes the country as a name ("Japan") or as a code, depending on where
 * the data comes from. Only the two-letter code is accepted here: inventing the
 * mapping of 200 translated names is a table that goes out of date, and
 * a wrong flag on a broadcast is worse than no flag.
 */
function normalizeCountry(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

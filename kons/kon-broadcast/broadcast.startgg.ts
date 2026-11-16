/**
 * start.gg → scoreboard
 * ============================================================================
 *
 * The operator's shortcut before a set: list an event's open sets, pick one, and the scoreboard takes
 * the round, both gamertags and sponsors, and which side comes from losers. It is the import Viggo
 * had in its Discord booth, here for every caller (panel, MCP, the kon-dc booth).
 *
 * It does NOT build a bracket: that is kon-esports' `import-tournament`. This only reads, and only to
 * fill one set.
 *
 * The token is the operator's (start.gg → Developer settings) or `STARTGG_TOKEN` in the API. It is
 * used for the request and never stored or echoed.
 */

import { z } from "zod";

const ENDPOINT = "https://api.start.gg/gql/alpha";

/** start.gg set states: 1 created, 2 in progress, 3 completed, 6 called. */
export const STARTGG_STATES: Record<number, string> = { 1: "open", 2: "in progress", 3: "done", 6: "called" };

export const StartggEventRef = z
  .string()
  .min(3)
  .max(300)
  .describe("Event slug or URL: tournament/<t>/event/<e>");

export interface StartggSetSummary {
  id: string;
  round: string;
  state: string;
  entrants: [string, string];
  losers: boolean;
}

export class StartggError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** `https://www.start.gg/tournament/x/event/y/overview` → `tournament/x/event/y`. */
export function eventSlug(ref: string): string {
  const m = /tournament\/[a-z0-9-]+\/event\/[a-z0-9-]+/i.exec(ref.trim());
  if (!m) throw new StartggError("Expected an event: tournament/<tournament>/event/<event>", 422);
  return m[0].toLowerCase();
}

/** "Sponsor | Gamertag" → both; a plain name has no sponsor. */
export function splitEntrant(name: string): { sponsor: string; name: string } {
  const i = name.indexOf("|");
  if (i < 0) return { sponsor: "", name: name.trim() };
  return { sponsor: name.slice(0, i).trim().slice(0, 20), name: name.slice(i + 1).trim() };
}

export const isLosersRound = (round: string) => /losers/i.test(round);

export function startggToken(given: string | undefined): string {
  const token = given?.trim() || process.env.STARTGG_TOKEN?.trim();
  if (!token) throw new StartggError("A start.gg token is needed: pass `token` or set STARTGG_TOKEN in the API", 422);
  return token;
}

async function gql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new StartggError("start.gg did not answer", 502);
  }
  if (res.status === 401 || res.status === 403) throw new StartggError("start.gg refused the token", 422);
  if (!res.ok) throw new StartggError(`start.gg answered ${res.status}`, 502);
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: Array<{ message?: string }> } | null;
  if (!body?.data) throw new StartggError(body?.errors?.[0]?.message ?? "start.gg sent no data", 502);
  return body.data;
}

interface RawSet {
  id: string | number;
  fullRoundText: string | null;
  state: number | null;
  slots: Array<{ entrant: { name: string | null } | null } | null> | null;
}

function summary(s: RawSet): StartggSetSummary | null {
  const names = (s.slots ?? []).map((slot) => slot?.entrant?.name?.trim() ?? "");
  if (names.length < 2 || !names[0] || !names[1]) return null;
  const round = s.fullRoundText ?? "";
  return {
    id: String(s.id),
    round,
    state: STARTGG_STATES[s.state ?? 0] ?? "unknown",
    entrants: [names[0], names[1]],
    losers: isLosersRound(round),
  };
}

/** An event's sets with two known entrants, unfinished first. Up to 60. */
export async function listEventSets(token: string, ref: string): Promise<{ event: string; sets: StartggSetSummary[] }> {
  const data = await gql<{
    event: { name: string; tournament: { name: string } | null; sets: { nodes: RawSet[] | null } | null } | null;
  }>(
    token,
    `query Sets($slug: String!) { event(slug: $slug) { name tournament { name }
       sets(page: 1, perPage: 60, sortType: STANDARD) { nodes { id fullRoundText state slots { entrant { name } } } } } }`,
    { slug: eventSlug(ref) }
  );
  if (!data.event) throw new StartggError("start.gg has no such event", 404);
  const sets = (data.event.sets?.nodes ?? []).map(summary).filter((s): s is StartggSetSummary => !!s);
  sets.sort((a, b) => Number(a.state === "done") - Number(b.state === "done"));
  const event = [data.event.tournament?.name, data.event.name].filter(Boolean).join(" · ");
  return { event, sets };
}

/** One set by its start.gg id. */
export async function getStartggSet(token: string, setId: string): Promise<StartggSetSummary & { event: string }> {
  const data = await gql<{
    set: (RawSet & { event: { name: string; tournament: { name: string } | null } | null }) | null;
  }>(
    token,
    `query One($id: ID!) { set(id: $id) { id fullRoundText state slots { entrant { name } } event { name tournament { name } } } }`,
    { id: setId }
  );
  const s = data.set ? summary(data.set) : null;
  if (!data.set || !s) throw new StartggError("start.gg has no such set, or it has no two entrants yet", 404);
  const event = [data.set.event?.tournament?.name, data.set.event?.name].filter(Boolean).join(" · ");
  return { ...s, event };
}

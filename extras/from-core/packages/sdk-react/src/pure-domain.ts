/**
 * Domain without React — the part of the hooks that can be tested on its own
 * ============================================================================
 *
 * The hooks in `domain.ts` are thin on purpose: they request, store state and
 * call this. What has rules lives here —how a tier list is grouped, which set
 * is open, what comes next in a Swiss— without depending on React, so a test
 * can exercise it without mounting components.
 *
 * It is also the part an agent usually writes badly when doing it from
 * scratch: an element placed in a row that no longer exists, a bye treated as a
 * playable set, pairing the next round while the current one is half finished.
 */

// ── Calling the API ──────────────────────────────────────────────────────────

export interface KitsudenConfig {
  /** Base URL of the API, ending in `/api`. */
  baseUrl?: string;
  /** Agent token (`kitsuden_agent_*`). Without it, cookies are used. */
  token?: string;
  /** For tests or environments without a global `fetch`. */
  fetch?: typeof fetch;
}

/** API error with the body intact and the suggestions in the message. */
export class KitsudenRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly method: string,
    readonly path: string
  ) {
    super(errorMessage(status, body, method, path));
    this.name = "KitsudenRequestError";
  }
}

interface ErrorBody {
  error?:
    | string
    | {
        message?: string;
        details?: { unknownKeys?: { key: string; didYouMean: string | null }[] };
      };
  message?: string;
}

function errorMessage(status: number, body: unknown, method: string, path: string): string {
  const b = (body ?? null) as ErrorBody | null;
  const principal =
    typeof b?.error === "string" ? b.error : (b?.error?.message ?? b?.message ?? `HTTP ${status}`);
  const unknownMany = typeof b?.error === "object" ? (b.error.details?.unknownKeys ?? []) : [];
  const hints = unknownMany.map((k) =>
    k.didYouMean ? `«${k.key}» → «${k.didYouMean}»` : `«${k.key}» does not exist`
  );
  return `${method} ${path} → ${status}: ${principal}${hints.length ? ` (${hints.join(", ")})` : ""}`;
}

export async function requestFromKitsuden<T>(
  config: KitsudenConfig,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const base = (config.baseUrl ?? "/api").replace(/\/+$/, "");
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (config.token) headers.authorization = `Bearer ${config.token}`;

  const res = await (config.fetch ?? fetch)(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "include",
  });

  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // No era JSON.
  }
  if (!res.ok) throw new KitsudenRequestError(res.status, data, method, path);
  return data as T;
}

// ── Tier lists ───────────────────────────────────────────────────────────────

export interface TierDef {
  id: string;
  label: string;
  color?: string;
}

export interface TierItem {
  id: string;
  label: string;
  imageUrl?: string | null;
}

export interface TierListData {
  slug: string;
  title: string;
  tiers: TierDef[];
  items: TierItem[];
  /** `itemId → tierId`. Anything not in here goes unranked. */
  placement: Record<string, string>;
  catalogDatasetId?: string | null;
}

export interface TierRow {
  tier: TierDef;
  items: TierItem[];
}

export interface TierListView {
  rows: TierRow[];
  withoutRanking: TierItem[];
}

/**
 * Groups the elements by row, in row order.
 *
 * An element placed in a row that no longer exists goes UNRANKED, it does not
 * disappear: if someone deletes row "F", its characters must stay in view so
 * they can be placed again.
 */
export function tierListView(list: TierListData): TierListView {
  const rows = list.tiers.map((tier) => ({ tier, items: [] as TierItem[] }));
  const byId = new Map(rows.map((f) => [f.tier.id, f]));
  const withoutRanking: TierItem[] = [];

  for (const item of list.items) {
    const row = byId.get(list.placement[item.id]);
    if (row) row.items.push(item);
    else withoutRanking.push(item);
  }

  return { rows: rows, withoutRanking };
}

/** Moves an element locally, to draw the change before the API responds. */
export function moveInTierList(
  list: TierListData,
  itemId: string,
  tierId: string | null
): TierListData {
  const placement = { ...list.placement };
  if (tierId === null) delete placement[itemId];
  else placement[itemId] = tierId;
  return { ...list, placement };
}

// ── Tournaments ──────────────────────────────────────────────────────────────

export interface TournamentParticipant {
  id: string;
  player?: { alias?: string | null } | null;
  team?: { name?: string | null } | null;
}

export interface TournamentDetail {
  id: string;
  title: string;
  status: string;
  bracketFormat: string;
  participants?: TournamentParticipant[];
}

export interface SetRow {
  id: string;
  round: number;
  participant1Id: string | null;
  participant2Id: string | null;
  winnerId: string | null;
  status?: string;
  bracketMatchId?: string | null;
}

export interface OpenSet {
  /** Id of the ROW: it is what gets sent when reporting. */
  matchId: string;
  turn: number;
  sides: [{ id: string; name: string }, { id: string; name: string }];
}

/** `participantId → display name`. Player or team; if there is none, a piece of the id. */
export function participantNames(
  tournament: Pick<TournamentDetail, "participants">
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const p of tournament.participants ?? []) {
    names[p.id] = p.player?.alias ?? p.team?.name ?? p.id.slice(0, 8);
  }
  return names;
}

/**
 * The sets that can be reported right now.
 *
 * Out: those that already have a winner and the BYES: a bye is resolved from
 * the moment it is paired, and offering it for reporting invites "correcting"
 * something that was not played. Also out: those still waiting for an occupant
 * (TBD in a bracket).
 */
export function openSets(rows: SetRow[], names: Record<string, string>): OpenSet[] {
  return rows
    .filter((f) => !f.winnerId && f.participant1Id && f.participant2Id)
    .filter((f) => f.status !== "Bye" && f.status !== "Completed")
    .sort((a, b) => a.round - b.round)
    .map((f) => ({
      matchId: f.id,
      turn: f.round,
      sides: [
        {
          id: f.participant1Id!,
          name: names[f.participant1Id!] ?? f.participant1Id!.slice(0, 8),
        },
        {
          id: f.participant2Id!,
          name: names[f.participant2Id!] ?? f.participant2Id!.slice(0, 8),
        },
      ],
    }));
}

export interface SwissStatus {
  round: number;
  totalRounds: number;
  complete: boolean;
}

/**
 * What to do next in a Swiss.
 *
 * Pairing with result-less sets from the current round is rejected by the
 * API —it would force undoing pairings—, so a "next round" button should
 * only appear when this says `emparejar`.
 */
export function nextSwissStep(
  status: SwissStatus,
  pendingSets: number
): "report" | "emparejar" | "terminado" {
  if (status.complete) return "terminado";
  if (pendingSets > 0) return "report";
  return "emparejar";
}

/**
 * Domain hooks — state and rules, without imposing appearance
 * ============================================================================
 *
 * ── WHAT FOR ───────────────────────────────────────────────────────────────
 *
 * An AI generates a beautiful interface in one prompt. What it does badly is talk
 * to the backend: which route a set is reported to, which id is sent —the row's
 * or the player's—, when the next round can be paired, how a
 * piece is moved without the screen flickering.
 *
 * These hooks solve that part and return data and actions. They paint
 * nothing: whoever uses them writes the component, with their own design.
 *
 * ── WHAT THEY DO NOT DO ────────────────────────────────────────────────────
 *
 * Real time. Esports does not publish synced state yet, so it is
 * refreshed by polling (`pollMs`). When it does publish it, these hooks are the only
 * place that will need to change.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  moveInTierList,
  participantNames,
  requestFromKitsuden,
  openSets,
  nextSwissStep,
  tierListView,
  type SwissStatus,
  type SetRow,
  type KitsudenConfig,
  type TierListData,
  type TournamentDetail,
} from "./pure-domain.js";
import { useKitsudenQuery } from "./index.js";

/** Refreshes every `ms` while the component is mounted. `0` disables it. */
function usePolling(refetch: () => void, ms: number): void {
  useEffect(() => {
    if (!ms) return;
    const id = setInterval(refetch, ms);
    return () => clearInterval(id);
  }, [refetch, ms]);
}

// ── Tier list ────────────────────────────────────────────────────────────────

/**
 * A tier list template, grouped by rows, with the actions it has.
 *
 *     const { vista, colocar, sincronizar } = useTierList(config, "campeones");
 *     vista?.filas.map(({ tier, items }) => …)
 *     await colocar(item.id, "s");     // null returns it to the pool
 *
 * `place` is OPTIMISTIC: it moves the item immediately and, if the API rejects it,
 * puts it back where it was and rethrows the error. Without that, dragging an item
 * feels broken even if it works.
 */
export function useTierList(config: KitsudenConfig, slug: string) {
  const query = useKitsudenQuery(
    () =>
      requestFromKitsuden<{ data: TierListData }>(
        config,
        "GET",
        `/tierlist/templates/${encodeURIComponent(slug)}`
      ),
    [config.baseUrl, config.token, slug]
  );

  const [list, setList] = useState<TierListData | null>(null);
  useEffect(() => {
    if (query.data) setList(query.data.data);
  }, [query.data]);

  const place = useCallback(
    async (itemId: string, tierId: string | null) => {
      if (!list) return;
      const earlier = list;
      setList(moveInTierList(list, itemId, tierId));
      try {
        const r = await requestFromKitsuden<{ data: TierListData }>(
          config,
          "POST",
          `/tierlist/templates/${encodeURIComponent(slug)}/place`,
          { itemId, tierId }
        );
        setList(r.data);
      } catch (error) {
        setList(earlier);
        throw error;
      }
    },
    [config, slug, list]
  );

  /**
   * Pulls in what is new from the catalog. What is already placed does not move; what leaves the
   * catalog stops taking up space.
   */
  const sync = useCallback(
    async (options: { datasetId?: string; confirm?: boolean } = {}) => {
      const r = await requestFromKitsuden<unknown>(
        config,
        "POST",
        `/tierlist/templates/${encodeURIComponent(slug)}/sync`,
        options
      );
      query.refetch();
      return r;
    },
    [config, slug, query]
  );

  const view = useMemo(() => (list ? tierListView(list) : null), [list]);

  return {
    list: list,
    view: view,
    loading: query.loading,
    error: query.error,
    refetch: query.refetch,
    place,
    sync: sync,
  };
}

// ── Bracket / sets of a tournament ───────────────────────────────────────────

interface TournamentStatus {
  tournament: TournamentDetail;
  rows: SetRow[];
  /** Swiss: `{ round, totalRounds, complete, standings }`. Others: the format's table. */
  classification: unknown;
}

/**
 * A tournament's open sets, with names, and the actions to advance it.
 *
 *     const { sets, reportar, nextStep, pairNextRound } =
 *       useBracket(config, tournamentId);
 *     sets.map((s) => <button onClick={() => reportar(s.matchId, s.lados[0].id)} />)
 *
 * `report` sends the ROW id (`matchId`) and the PARTICIPANT id: they are the
 * two ids most often confused with the player's. It works the same in
 * elimination, round robin and Swiss.
 */
export function useBracket(
  config: KitsudenConfig,
  tournamentId: string,
  options: { pollMs?: number } = {}
) {
  const id = encodeURIComponent(tournamentId);

  const query = useKitsudenQuery<TournamentStatus>(async () => {
    const tournament = await requestFromKitsuden<TournamentDetail>(config, "GET", `/esports/tournaments/${id}`);
    const rows = await requestFromKitsuden<SetRow[]>(
      config,
      "GET",
      `/esports/matches/tournament/${id}`
    );

    let classification: unknown = null;
    if (tournament.bracketFormat === "swiss") {
      classification = (
        await requestFromKitsuden<{ data: unknown }>(config, "GET", `/esports/tournament/${id}/swiss`)
      ).data;
    } else if (tournament.bracketFormat === "round_robin") {
      classification = await requestFromKitsuden<unknown>(
        config,
        "GET",
        `/esports/matches/tournament/${id}/standings`
      );
    } else if (rows.length > 0) {
      classification = (
        await requestFromKitsuden<{ standings: unknown }>(
          config,
          "GET",
          `/esports/matches/tournament/${id}/bracket`
        )
      ).standings;
    }

    return { tournament, rows: rows, classification };
  }, [config.baseUrl, config.token, tournamentId]);

  usePolling(query.refetch, options.pollMs ?? 15_000);

  const names = useMemo(
    () => (query.data ? participantNames(query.data.tournament) : {}),
    [query.data]
  );
  const sets = useMemo(
    () => (query.data ? openSets(query.data.rows, names) : []),
    [query.data, names]
  );

  const nextStep = useMemo(() => {
    const d = query.data;
    if (!d || d.tournament.bracketFormat !== "swiss" || !d.classification) return null;
    return nextSwissStep(d.classification as SwissStatus, sets.length);
  }, [query.data, sets.length]);

  const report = useCallback(
    async (
      matchId: string,
      winnerId: string,
      marker?: { participant1Score?: number; participant2Score?: number }
    ) => {
      const r = await requestFromKitsuden<unknown>(
        config,
        "POST",
        `/esports/matches/tournament/${id}/report`,
        { matchId, winnerId, ...marker }
      );
      query.refetch();
      return r;
    },
    [config, id, query]
  );

  const pairNextRound = useCallback(async () => {
    const r = await requestFromKitsuden<unknown>(
      config,
      "POST",
      `/esports/tournament/${id}/swiss/next-round`
    );
    query.refetch();
    return r;
  }, [config, id, query]);

  return {
    tournament: query.data?.tournament ?? null,
    sets,
    names,
    classification: query.data?.classification ?? null,
    nextStep,
    loading: query.loading,
    error: query.error,
    refetch: query.refetch,
    report: report,
    pairNextRound,
  };
}

// ── Check-in ─────────────────────────────────────────────────────────────────

export interface CheckInStatus {
  state: "disabled" | "scheduled" | "open" | "closed";
  countdown: number | null;
  summary: {
    total: number;
    checkedIn: number;
    missing: number;
    missingIds: string[];
    checkedInIds: string[];
  };
}

/**
 * A tournament's check-in for the TO's desk.
 *
 * It refreshes by itself every 10 s: it is watched while people are arriving, and reloading
 * by hand is exactly what nobody does with sixty people in front of them.
 *
 * `resolveMissing("drop")` is for BEFORE generating the bracket; `"dq"` for
 * after. The API asks for confirmation in two steps and this hook respects that:
 * without `confirmar: true` it only returns the plan.
 */
export function useCheckIn(
  config: KitsudenConfig,
  tournamentId: string,
  options: { pollMs?: number } = {}
) {
  const id = encodeURIComponent(tournamentId);

  const query = useKitsudenQuery(
    () => requestFromKitsuden<CheckInStatus>(config, "GET", `/esports/tournament/${id}/check-in`),
    [config.baseUrl, config.token, tournamentId]
  );
  usePolling(query.refetch, options.pollMs ?? 10_000);

  const mark = useCallback(
    async (participantId: string) => {
      await requestFromKitsuden(
        config,
        "POST",
        `/esports/participant/${encodeURIComponent(participantId)}/check-in`
      );
      query.refetch();
    },
    [config, query]
  );

  const undo = useCallback(
    async (participantId: string) => {
      await requestFromKitsuden(
        config,
        "DELETE",
        `/esports/participant/${encodeURIComponent(participantId)}/check-in`
      );
      query.refetch();
    },
    [config, query]
  );

  const openWindow = useCallback(
    async (opensAt: Date | null, closesAt: Date | null) => {
      await requestFromKitsuden(config, "POST", `/esports/tournament/${id}/check-in/window`, {
        opensAt: opensAt?.toISOString() ?? null,
        closesAt: closesAt?.toISOString() ?? null,
      });
      query.refetch();
    },
    [config, id, query]
  );

  const resolveMissing = useCallback(
    async (action: "drop" | "dq", confirm = false) => {
      const r = await requestFromKitsuden<unknown>(
        config,
        "POST",
        `/esports/tournament/${id}/check-in/resolve`,
        {
          action,
          ...(confirm ? { confirm: true } : {}),
        }
      );
      if (confirm) query.refetch();
      return r;
    },
    [config, id, query]
  );

  return {
    status: query.data,
    loading: query.loading,
    error: query.error,
    refetch: query.refetch,
    mark,
    undo,
    openWindow,
    resolveMissing,
  };
}

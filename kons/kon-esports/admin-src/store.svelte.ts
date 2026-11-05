/**
 * The booth's state and every call it makes: the chosen tournament, its check-in, phases, sets,
 * stations, Swiss standings and disputed reports, plus the note and error each section shows.
 *
 * The view is a kon tab, not a record view, so nobody passes it a tournament: it lists them and
 * the TO chooses (the last one is remembered). A `params.tournamentId`, if the host ever sends
 * one, takes precedence.
 */
import { getContext, setContext } from "svelte";

import { ApiError, message, seg, type Api } from "./api";
import type {
  AliveRow,
  Bracket,
  BracketFormat,
  BracketSet,
  CheckIn,
  Dispute,
  MatchRow,
  Messages,
  NameEntry,
  Phase,
  ResolvePlan,
  Scope,
  Station,
  SwissState,
  TournamentItem,
  TournamentRecord,
} from "./types";

const STORAGE_KEY = "kitsuden.esports.to-panel.tournament";

/** Server warnings do not block, but they require the TO to say they know about them. */
const IS_NOTICE = /avisos|warnings/;

const FORMAT_NAME: Record<string, string> = {
  single_elimination: "single elimination",
  double_elimination: "double elimination",
  swiss: "swiss",
  round_robin: "round robin",
};

export interface Ask {
  title: string;
  description?: string;
  confirmLabel?: string;
  variant?: "primary" | "danger";
}

const KEY = Symbol("to-panel");

export class Booth {
  tournaments = $state<TournamentItem[]>([]);
  tid = $state<string | null>(null);
  format = $state<BracketFormat | null>(null);
  tournamentState = $state("");

  names = $state<Record<string, NameEntry>>({});
  checkIn = $state<CheckIn | null>(null);
  phases = $state<Phase[]>([]);
  activePhase = $state<string | null>(null);
  stations = $state<Station[]>([]);
  /** Every set of the bracket (not only the playable ones): regenerating asks if any has a result. */
  bracketSets = $state<BracketSet[]>([]);
  rows = $state<MatchRow[]>([]);
  /** What the Sets section lists, and what it says when there is nothing. */
  openSets = $state<BracketSet[]>([]);
  setsEmpty = $state("");
  alive = $state<AliveRow[]>([]);
  swiss = $state<SwissState | null>(null);
  disputes = $state<Dispute[]>([]);

  msg = $state<Record<Scope, Messages>>({
    pick: { note: null, err: null },
    checkin: { note: null, err: null },
    phase: { note: null, err: null },
    sets: { note: null, err: null },
    disputes: { note: null, err: null },
    swiss: { note: null, err: null },
    stations: { note: null, err: null },
  });

  /** The confirmation on screen; `answer` settles the promise `confirm` returned. */
  ask = $state<Ask | null>(null);
  private settle: ((yes: boolean) => void) | null = null;

  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(readonly api: Api) {}

  rowById = $derived(new Map(this.rows.map((r) => [r.id, r])));

  /** "Who is still alive" is computed inside the bracket: Swiss and round robin have none. */
  bracketOnly = $derived(this.format !== "swiss" && this.format !== "round_robin");

  generateLabel = $derived(this.format === "swiss" ? "Pair first round" : "Generate bracket");

  phase = $derived(this.phases.find((p) => p.id === this.activePhase) ?? null);

  name(participantId: string | null | undefined) {
    if (!participantId) return "TBD";
    return this.names[participantId]?.name || participantId.slice(0, 8);
  }

  note(scope: Scope, text: string | null) {
    this.msg[scope].note = text;
  }

  error(scope: Scope, text: string | null) {
    this.msg[scope].err = text;
  }

  /** `window.confirm` as a dialog: resolves `true` only if the TO confirms. */
  confirm(ask: Ask): Promise<boolean> {
    this.settle?.(false);
    this.ask = ask;
    return new Promise((resolve) => (this.settle = resolve));
  }

  answer(yes: boolean) {
    const settle = this.settle;
    this.settle = null;
    this.ask = null;
    settle?.(yes);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.answer(false);
  }

  // ── Choose tournament ──────────────────────────────────────────────────────

  async boot() {
    this.error("pick", null);
    try {
      const rows = await this.api.get<TournamentItem[] | { data?: TournamentItem[] }>("/tournaments");
      this.tournaments = Array.isArray(rows) ? rows : (rows?.data ?? []);
    } catch (e) {
      this.error("pick", message(e));
      this.tournaments = [];
    }

    if (this.tournaments.length === 0) {
      this.tid = null;
      this.format = null;
      this.tournamentState = "";
      return;
    }

    // The last one chosen is remembered: a TO reloads the tab many times in an afternoon.
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Browser with capped storage: it does not remember.
    }

    const chosen =
      this.tid ?? (this.tournaments.some((t) => t.id === saved) ? saved : null) ?? this.tournaments[0].id;
    this.choose(chosen);
  }

  choose(id: string | null) {
    if (id !== this.tid) this.bracketSets = [];
    this.tid = id;
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Remembering is a convenience, not a requirement.
    }

    const t = this.tournaments.find((x) => x.id === id);
    this.tournamentState = t ? `${t.format ?? ""} ${t.status ? `· ${t.status}` : ""}`.trim() : "";

    if (id) void this.load();
  }

  /** A `tournamentId` in `params` (a record view) wins over the selector. */
  fromParams(id: string | null | undefined) {
    if (id && id !== this.tid) {
      this.tid = id;
      void this.load();
    }
  }

  async load() {
    const tid = this.tid;
    if (!tid) return;
    clearInterval(this.timer);

    // The format comes from the record, not the list: `GET /bracket` throws for Swiss and
    // round robin.
    await this.loadTournament();
    await this.refreshCheckIn();
    await this.refreshPhases();
    await this.refreshStations();
    await this.refreshSets();
    await this.refreshSwiss();
    await this.refreshDisputes();

    if (this.tid !== tid) return;
    clearInterval(this.timer);
    // Check-in is watched while people arrive, and disputed reports arrive while the TO is not
    // looking: both refresh on their own.
    this.timer = setInterval(() => {
      void this.refreshCheckIn();
      void this.refreshDisputes();
    }, 10_000);
  }

  async loadTournament() {
    const tid = this.tid;
    try {
      const t = await this.api.get<TournamentRecord>(`/tournaments/${seg(tid!)}`);
      if (this.tid !== tid) return;
      this.format = t.bracketFormat ?? null;

      const names = { ...this.names };
      for (const p of t.participants ?? []) {
        names[p.id] = {
          name: p.player?.alias ?? p.team?.name ?? p.id.slice(0, 8),
          country: p.player?.country ?? null,
        };
      }
      this.names = names;

      this.tournamentState = [this.format ? (FORMAT_NAME[this.format] ?? this.format) : null, t.status]
        .filter(Boolean)
        .join(" · ");

      // Leaving the previous tournament's "who is still alive" would show real, wrong names.
      if (!this.bracketOnly) this.alive = [];
    } catch (e) {
      this.error("pick", message(e));
    }
  }

  // ── Check-in ───────────────────────────────────────────────────────────────

  async refreshCheckIn() {
    const tid = this.tid;
    if (!tid) return;
    try {
      const data = await this.api.get<CheckIn>(`/tournament/${seg(tid)}/check-in`);
      if (this.tid === tid) this.checkIn = data;
    } catch (e) {
      this.error("checkin", message(e));
    }
  }

  async setWindow(opens: string, closes: string) {
    try {
      await this.api.post(`/tournament/${seg(this.tid!)}/check-in/window`, {
        opensAt: opens ? new Date(opens).toISOString() : null,
        closesAt: closes ? new Date(closes).toISOString() : null,
      });
      await this.refreshCheckIn();
    } catch (e) {
      this.error("checkin", message(e));
    }
  }

  async markCheckIn(participantId: string, present: boolean) {
    try {
      const path = `/participant/${seg(participantId)}/check-in`;
      await (present ? this.api.post(path) : this.api.del(path));
      await this.refreshCheckIn();
    } catch (e) {
      this.error("checkin", message(e));
    }
  }

  /** Two steps: the preview gives the number, and only then is it confirmed. It is irreversible. */
  async resolveAbsentees(action: "drop" | "dq") {
    this.error("checkin", null);
    const path = `/tournament/${seg(this.tid!)}/check-in/resolve`;
    try {
      const preview = await this.api.post<ResolvePlan>(path, { action });
      const n = preview.plan.participantIds.length;
      if (n === 0) {
        this.note("checkin", "There are no absentees to resolve.");
        return;
      }
      const verb = action === "drop" ? "Remove" : "Disqualify";
      const ok = await this.confirm({
        title: `${verb} ${n} absentee(s)?`,
        description: `Would leave ${preview.plan.remaining} playing.`,
        confirmLabel: verb,
        variant: "danger",
      });
      if (!ok) return;

      const done = await this.api.post<ResolvePlan>(path, { action, confirm: true });
      this.note("checkin", `${done.plan.participantIds.length} absentee(s) resolved with "${action}".`);
      await this.refreshCheckIn();
    } catch (e) {
      this.error("checkin", message(e));
    }
  }

  // ── Bracket and phases ─────────────────────────────────────────────────────

  async generate() {
    this.error("phase", null);
    if (this.bracketSets.some((m) => m.winnerId)) {
      const ok = await this.confirm({
        title: "This tournament already has sets with results.",
        description: "Regenerating the bracket redoes the pairings from scratch. Continue?",
        confirmLabel: "Regenerate",
        variant: "danger",
      });
      if (!ok) return;
    }
    try {
      const res = await this.api.post<{ rounds?: number }>(`/tournament/${seg(this.tid!)}/generate`);
      this.note("phase", res?.rounds ? `Bracket generated: ${res.rounds} round(s).` : "Bracket generated.");
      await this.refreshSets();
      await this.refreshPhases();
    } catch (e) {
      this.error("phase", message(e));
    }
  }

  async refreshPhases() {
    const tid = this.tid;
    try {
      const { data } = await this.api.get<{ data?: Phase[] }>(`/tournament/${seg(tid!)}/phases`);
      if (this.tid !== tid) return;
      this.phases = data ?? [];
      // The ACTIVE phase is selected: it is the one the TO is running.
      this.activePhase = this.phases.find((p) => p.status === "active")?.id ?? this.phases[0]?.id ?? null;
    } catch (e) {
      this.error("phase", message(e));
    }
  }

  selectPhase(id: string) {
    this.activePhase = id;
    void this.refreshSets();
  }

  async planTemplate() {
    this.error("phase", null);
    const path = `/tournament/${seg(this.tid!)}/phases`;
    try {
      let result: { issues?: { message: string }[] };
      try {
        result = await this.api.post(path, { template: "fgc" });
      } catch (e) {
        // Warnings do not block, but they require the TO to say they know about them.
        if (!(e instanceof ApiError) || !(e.status === 409 || IS_NOTICE.test(e.message))) throw e;
        const issues = (e.payload as { issues?: { message: string }[] } | null)?.issues ?? [];
        const ok = await this.confirm({
          title: "Continue anyway?",
          description: [e.message, ...issues.map((i) => i.message)].join(" · "),
          confirmLabel: "Continue",
          variant: "primary",
        });
        if (!ok) return;
        result = await this.api.post(path, { template: "fgc", force: true });
      }
      const issues = result?.issues ?? [];
      this.note("phase", issues.length ? issues.map((i) => i.message).join(" · ") : null);
      await this.refreshPhases();
    } catch (e) {
      this.error("phase", message(e));
    }
  }

  async startPhase() {
    if (!this.activePhase) return;
    this.error("phase", null);
    try {
      await this.api.post(`/phase/${seg(this.activePhase)}/start`);
      await this.refreshPhases();
      await this.refreshSets();
    } catch (e) {
      this.error("phase", message(e));
    }
  }

  async advancePhase() {
    if (!this.activePhase) return;
    this.error("phase", null);
    try {
      const { data } = await this.api.post<{ data: { advancing: unknown[] } }>(
        `/phase/${seg(this.activePhase)}/advance`
      );
      this.note("phase", `${data.advancing.length} qualifiers seeded into the next phase.`);
      await this.refreshPhases();
      await this.refreshSets();
    } catch (e) {
      this.error("phase", message(e));
    }
  }

  // ── Stations ───────────────────────────────────────────────────────────────

  async refreshStations() {
    const tid = this.tid;
    try {
      const res = await this.api.get<{ data?: Station[] }>(`/tournament/${seg(tid!)}/stations`);
      if (this.tid === tid) this.stations = res.data ?? [];
    } catch (e) {
      this.error("stations", message(e));
    }
  }

  /** Returns whether it was added, so the form clears only then. */
  async addStation(name: string, kind: string, access: string): Promise<boolean> {
    if (!name.trim()) {
      this.error("stations", "Give the station a name.");
      return false;
    }
    this.error("stations", null);
    try {
      await this.api.post(`/tournament/${seg(this.tid!)}/stations`, {
        name: name.trim(),
        kind,
        accessDetails: access.trim() || undefined,
      });
      await this.refreshStations();
      await this.refreshSets();
      return true;
    } catch (e) {
      this.error("stations", message(e));
      return false;
    }
  }

  // ── Sets ───────────────────────────────────────────────────────────────────

  /** Each format keeps its sets in a different place: the bracket, or the rows. */
  async refreshSets() {
    this.error("sets", null);
    await this.loadRows();
    if (this.format === "swiss" || this.format === "round_robin") return this.setsFromRows();
    return this.loadBracket();
  }

  async loadRows() {
    const tid = this.tid;
    try {
      const rows = await this.api.get<MatchRow[]>(`/matches/tournament/${seg(tid!)}`);
      if (this.tid === tid) this.rows = Array.isArray(rows) ? rows : [];
    } catch {
      // Decoration for the bracket; without a bracket it shows as an empty list.
      this.rows = [];
    }
  }

  /** Swiss and round robin: the sets are the rows, reported by row (`matchId`). */
  setsFromRows() {
    this.openSets = this.rows
      .filter((f) => !f.winnerId && f.status !== "Bye" && f.status !== "Completed")
      .map((f) => ({
        id: f.bracketMatchId ?? f.id,
        rowId: f.id,
        participants: [f.participant1Id, f.participant2Id],
        winnerId: f.winnerId,
      }));
    this.setsEmpty = this.rows.length ? "There are no open sets in this round." : "There are no pairings yet.";
  }

  async loadBracket() {
    const tid = this.tid;
    try {
      const data = await this.api.get<Bracket>(`/matches/tournament/${seg(tid!)}/bracket`);
      if (this.tid !== tid) return;
      // The bracket brings names already resolved; they are merged with the record's.
      this.names = { ...this.names, ...(data.names ?? {}) };
      const all = [...(data.winners ?? []), ...(data.losers ?? []), ...(data.grandFinal ?? [])];
      this.bracketSets = all;
      this.alive = data.standings ?? [];

      // Only what is PLAYABLE: a 128 bracket is 254 sets and the TO runs the ~10 still open.
      this.openSets = all.filter((m) => m.status !== "void" && m.status !== "bye" && !m.winnerId);
      this.setsEmpty = all.length
        ? "There are no pending sets. Start a phase or advance to the next one."
        : 'There is no bracket yet. Press "Generate bracket" once check-in is done.';
    } catch (e) {
      this.openSets = [];
      this.setsEmpty = "";
      this.error("sets", message(e));
    }
  }

  async assignStation(set: BracketSet, stationId: string | null) {
    this.error("sets", null);
    try {
      await this.api.post(`/match/${seg(set.rowId!)}/station`, { stationId });
      await this.refreshSets();
    } catch (e) {
      this.error("sets", message(e));
    }
  }

  /** `position: null` takes it out of the queue, so one button adds and removes. */
  async queueStream(set: BracketSet, enter: boolean) {
    this.error("sets", null);
    try {
      await this.api.post(`/match/${seg(set.rowId!)}/stream-queue`, {
        position: enter ? this.nextInQueue() : null,
      });
      await this.refreshSets();
    } catch (e) {
      this.error("sets", message(e));
    }
  }

  nextInQueue() {
    let max = 0;
    for (const f of this.rows) {
      if (typeof f.streamQueuePosition === "number") max = Math.max(max, f.streamQueuePosition);
    }
    return max + 1;
  }

  async report(set: BracketSet, winnerId: string | null | undefined) {
    if (!winnerId) return;
    // Advancing a bracket is hard to undo: it is confirmed.
    const ok = await this.confirm({
      title: `Does ${this.name(winnerId)} win set ${set.id}?`,
      confirmLabel: "Report",
      variant: "primary",
    });
    if (!ok) return;
    try {
      await this.api.post(`/matches/tournament/${seg(this.tid!)}/report`, {
        // The row if known: with phases, the engine id can repeat.
        ...(set.rowId ? { matchId: set.rowId } : { bracketMatchId: set.id }),
        winnerId,
      });
      await this.refreshSets();
      await this.refreshSwiss();
      await this.refreshDisputes();
    } catch (e) {
      this.error("sets", message(e));
    }
  }

  // ── Swiss ──────────────────────────────────────────────────────────────────

  async refreshSwiss() {
    if (this.format !== "swiss") {
      this.swiss = null;
      return;
    }
    const tid = this.tid;
    this.error("swiss", null);
    try {
      const { data } = await this.api.get<{ data: SwissState }>(`/tournament/${seg(tid!)}/swiss`);
      if (this.tid === tid) this.swiss = data;
    } catch (e) {
      this.error("swiss", message(e));
    }
  }

  async swissNextRound() {
    this.error("swiss", null);
    try {
      const { data } = await this.api.post<{ data: { round: number; warnings?: string[] } }>(
        `/tournament/${seg(this.tid!)}/swiss/next-round`
      );
      // The pairer's warnings (forced rematches, repeated byes) are what a judge needs first.
      const warnings = (data.warnings ?? []).join(" · ");
      this.note("swiss", `Round ${data.round} paired.${warnings ? ` ${warnings}` : ""}`);
      await this.refreshSwiss();
      await this.refreshSets();
    } catch (e) {
      this.error("swiss", message(e));
    }
  }

  async swissCut() {
    this.error("swiss", null);
    try {
      const res = await this.api.get<{
        data?: { participantId: string }[] & { provisional?: boolean };
        provisional?: boolean;
      }>(`/tournament/${seg(this.tid!)}/swiss/cut?size=8`);
      const pass = (res.data ?? []).map((s) => this.name(s.participantId));
      // Says whether the cut is PROVISIONAL: a top 8 before the last round is not final.
      const provisional = res.provisional ?? res.data?.provisional;
      this.note("swiss", (provisional ? "PROVISIONAL cut (rounds remaining): " : "Cut: ") + pass.join(", "));
    } catch (e) {
      this.error("swiss", message(e));
    }
  }

  // ── Reports that do not match ──────────────────────────────────────────────

  async refreshDisputes() {
    const tid = this.tid;
    if (!tid) return;
    try {
      const data = await this.api.get<{ disputed?: Dispute[] }>(`/tournament/${seg(tid)}/pending-reports`);
      if (this.tid === tid) this.disputes = data.disputed ?? [];
    } catch (e) {
      // A failure here cannot take down the rest of the panel: it is shown and we move on.
      this.error("disputes", message(e));
    }
  }

  /** The two involved, taken from the reports (which always name both). */
  sidesOf(d: Dispute) {
    const seen: string[] = [];
    for (const r of d.reports ?? []) {
      for (const id of [r.reportedBy, r.winnerId]) {
        if (id && !seen.includes(id)) seen.push(id);
      }
    }
    return seen.slice(0, 2);
  }

  async resolveDispute(d: Dispute, winnerId: string) {
    const ok = await this.confirm({
      title: `Give ${d.bracketMatchId ? `set ${d.bracketMatchId}` : "the set"} to ${this.name(winnerId)}?`,
      confirmLabel: "Give",
      variant: "primary",
    });
    if (!ok) return;
    this.error("disputes", null);
    try {
      await this.api.post(`/match/${seg(d.matchId)}/resolve`, { winnerId });
      await this.refreshDisputes();
      await this.refreshSets();
    } catch (e) {
      this.error("disputes", message(e));
    }
  }
}

export const provideBooth = (b: Booth) => setContext(KEY, b);
export const useBooth = () => getContext<Booth>(KEY);

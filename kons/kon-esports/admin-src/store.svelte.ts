/**
 * The booth's state and every call it makes: the chosen tournament, its check-in, phases, sets,
 * stations, Swiss standings and disputed reports, and whether each of them is loading, loaded or
 * failed. The result of an action is a toast; what the TO has to read and keep (the warnings of a
 * phase plan or a pairing, the cut) stays on screen as a notice.
 *
 * The view is a kon tab, not a record view, so nobody passes it a tournament: it lists them and
 * the TO chooses (the last one is remembered). A `params.tournamentId`, if the host ever sends
 * one, takes precedence.
 */
import { getContext, setContext } from "svelte";

import { ApiError, seg, type Api } from "./api";
import type {
  AliveRow,
  Bracket,
  BracketFormat,
  BracketSet,
  CheckIn,
  Dispute,
  MatchRow,
  NameEntry,
  Notice,
  Phase,
  ResolvePlan,
  Station,
  SwissState,
  TournamentItem,
  TournamentRecord,
} from "./types";
import { createLoad, type Load } from "./ui/load.svelte";
import { failed, toast } from "./ui/notify";

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

/** What a list says when it has nothing, and which tab holds the next step. */
export interface Nothing {
  title: string;
  description?: string;
  goTo?: { tab: string; label: string };
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
  setsEmpty = $state<Nothing>({ title: "No sets yet" });
  alive = $state<AliveRow[]>([]);
  swiss = $state<SwissState | null>(null);
  disputes = $state<Dispute[]>([]);

  /** The tab on screen. */
  tab = $state("checkin");

  /** What the server said that the TO has to read: a phase plan's issues, a pairing's warnings, the cut. */
  notice = $state<{ phase: Notice | null; swiss: Notice | null }>({ phase: null, swiss: null });

  /** The list of tournaments. */
  list = createLoad(async () => {
    const rows = await this.api.get<TournamentItem[] | { data?: TournamentItem[] }>("/tournaments");
    this.tournaments = Array.isArray(rows) ? rows : (rows?.data ?? []);
  });

  /** The list's state for the screen: its Retry boots again, which also chooses the tournament. */
  picker: Load = this.makePicker();

  /** One load per part of the chosen tournament; made again when another tournament is chosen. */
  loads = $state.raw(this.makeLoads());
  private loadedTid: string | null = null;

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

  private makePicker(): Load {
    const list = this.list;
    return {
      load: () => this.boot(),
      get status() {
        return list.status;
      },
      get loading() {
        return list.loading;
      },
      get ready() {
        return list.ready;
      },
      get error() {
        return list.error;
      },
      get retrying() {
        return list.retrying;
      },
    };
  }

  private makeLoads() {
    return {
      record: createLoad(() => this.fetchTournament()),
      checkIn: createLoad(() => this.fetchCheckIn()),
      phases: createLoad(() => this.fetchPhases()),
      stations: createLoad(() => this.fetchStations()),
      sets: createLoad(() => this.fetchSets()),
      swiss: createLoad(() => this.fetchSwiss()),
      disputes: createLoad(() => this.fetchDisputes()),
    };
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
    await this.list.load();
    if (this.list.error !== null) this.tournaments = [];

    if (this.tournaments.length === 0) {
      clearInterval(this.timer);
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

    // Another tournament: nothing of the previous one stays on screen while this one loads.
    if (tid !== this.loadedTid) {
      this.loadedTid = tid;
      this.loads = this.makeLoads();
      this.checkIn = null;
      this.phases = [];
      this.activePhase = null;
      this.stations = [];
      this.rows = [];
      this.openSets = [];
      this.alive = [];
      this.swiss = null;
      this.disputes = [];
      this.notice = { phase: null, swiss: null };
    }

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

  loadTournament() {
    return this.loads.record.load();
  }

  private async fetchTournament() {
    const tid = this.tid;
    {
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
    }
  }

  // ── Check-in ───────────────────────────────────────────────────────────────

  async refreshCheckIn() {
    if (!this.tid) return;
    await this.loads.checkIn.load();
  }

  private async fetchCheckIn() {
    const tid = this.tid;
    if (!tid) return;
    const data = await this.api.get<CheckIn>(`/tournament/${seg(tid)}/check-in`);
    if (this.tid === tid) this.checkIn = data;
  }

  async setWindow(opens: string, closes: string) {
    try {
      await this.api.post(`/tournament/${seg(this.tid!)}/check-in/window`, {
        opensAt: opens ? new Date(opens).toISOString() : null,
        closesAt: closes ? new Date(closes).toISOString() : null,
      });
      toast.success(opens || closes ? "Check-in window saved" : "Check-in window cleared");
      await this.refreshCheckIn();
    } catch (e) {
      failed("Could not schedule check-in", e);
    }
  }

  async markCheckIn(participantId: string, present: boolean) {
    try {
      const path = `/participant/${seg(participantId)}/check-in`;
      await (present ? this.api.post(path) : this.api.del(path));
      toast.success(`${this.name(participantId)} is ${present ? "checked in" : "marked absent"}`);
      await this.refreshCheckIn();
    } catch (e) {
      failed(`Could not mark ${this.name(participantId)} ${present ? "present" : "absent"}`, e);
    }
  }

  /** Two steps: the preview gives the number, and only then is it confirmed. It is irreversible. */
  async resolveAbsentees(action: "drop" | "dq") {
    const path = `/tournament/${seg(this.tid!)}/check-in/resolve`;
    try {
      const preview = await this.api.post<ResolvePlan>(path, { action });
      const n = preview.plan.participantIds.length;
      if (n === 0) {
        toast.info("There are no absentees to resolve");
        return;
      }
      const verb = action === "drop" ? "Remove" : "Disqualify";
      const ok = await this.confirm({
        title: `${verb} ${n} ${n === 1 ? "absentee" : "absentees"}?`,
        description: `${preview.plan.remaining} would stay in the tournament. This cannot be undone.`,
        confirmLabel: verb,
        variant: "danger",
      });
      if (!ok) return;

      const done = await this.api.post<ResolvePlan>(path, { action, confirm: true });
      const count = done.plan.participantIds.length;
      toast.success(
        `${count} ${count === 1 ? "absentee" : "absentees"} ${action === "drop" ? "removed" : "disqualified"}`
      );
      await this.refreshCheckIn();
    } catch (e) {
      failed(`Could not ${action === "drop" ? "remove" : "disqualify"} the absentees`, e);
    }
  }

  // ── Bracket and phases ─────────────────────────────────────────────────────

  async generate() {
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
      toast.success(
        this.format === "swiss" ? "First round paired" : "Bracket generated",
        res?.rounds ? { description: `${res.rounds} ${res.rounds === 1 ? "round" : "rounds"}` } : undefined
      );
      await this.refreshSets();
      await this.refreshPhases();
    } catch (e) {
      failed(this.format === "swiss" ? "Could not pair the first round" : "Could not generate the bracket", e);
    }
  }

  refreshPhases() {
    return this.loads.phases.load();
  }

  private async fetchPhases() {
    const tid = this.tid;
    const { data } = await this.api.get<{ data?: Phase[] }>(`/tournament/${seg(tid!)}/phases`);
    if (this.tid !== tid) return;
    this.phases = data ?? [];
    // The ACTIVE phase is selected: it is the one the TO is running.
    this.activePhase = this.phases.find((p) => p.status === "active")?.id ?? this.phases[0]?.id ?? null;
  }

  selectPhase(id: string) {
    this.activePhase = id;
    void this.refreshSets();
  }

  async planTemplate() {
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
      this.notice.phase = issues.length
        ? { variant: "warning", title: "The phase plan has warnings", text: issues.map((i) => i.message).join(" · ") }
        : null;
      toast.success("Phases planned");
      await this.refreshPhases();
    } catch (e) {
      failed("Could not plan the phases", e);
    }
  }

  async startPhase() {
    if (!this.activePhase) return;
    const name = this.phase?.name ?? "The phase";
    try {
      await this.api.post(`/phase/${seg(this.activePhase)}/start`);
      toast.success(`${name} started`);
      await this.refreshPhases();
      await this.refreshSets();
    } catch (e) {
      failed(`Could not start ${name}`, e);
    }
  }

  async advancePhase() {
    if (!this.activePhase) return;
    try {
      const { data } = await this.api.post<{ data: { advancing: unknown[] } }>(
        `/phase/${seg(this.activePhase)}/advance`
      );
      toast.success(`${data.advancing.length} qualifiers seeded into the next phase`);
      await this.refreshPhases();
      await this.refreshSets();
    } catch (e) {
      failed("Could not advance to the next phase", e);
    }
  }

  // ── Stations ───────────────────────────────────────────────────────────────

  refreshStations() {
    return this.loads.stations.load();
  }

  private async fetchStations() {
    const tid = this.tid;
    const res = await this.api.get<{ data?: Station[] }>(`/tournament/${seg(tid!)}/stations`);
    if (this.tid === tid) this.stations = res.data ?? [];
  }

  /** Returns whether it was added, so the form clears only then. */
  async addStation(name: string, kind: string, access: string): Promise<boolean> {
    if (!name.trim()) {
      toast.error("Give the station a name");
      return false;
    }
    try {
      await this.api.post(`/tournament/${seg(this.tid!)}/stations`, {
        name: name.trim(),
        kind,
        accessDetails: access.trim() || undefined,
      });
      toast.success(`Station ${name.trim()} added`);
      await this.refreshStations();
      await this.refreshSets();
      return true;
    } catch (e) {
      failed("Could not add the station", e);
      return false;
    }
  }

  // ── Sets ───────────────────────────────────────────────────────────────────

  /** Each format keeps its sets in a different place: the bracket, or the rows. */
  refreshSets() {
    return this.loads.sets.load();
  }

  private async fetchSets() {
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
    this.setsEmpty = this.rows.length
      ? { title: "No open sets in this round" }
      : { title: "No pairings yet", goTo: { tab: "bracket", label: "Open Bracket" } };
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
        ? {
            title: "No pending sets",
            description: "Start a phase or advance to the next one.",
            goTo: { tab: "bracket", label: "Open Bracket" },
          }
        : {
            title: "No bracket yet",
            description: "Generate it once check-in is done.",
            goTo: { tab: "bracket", label: "Open Bracket" },
          };
    } catch (e) {
      this.openSets = [];
      throw e;
    }
  }

  async assignStation(set: BracketSet, stationId: string | null) {
    try {
      await this.api.post(`/match/${seg(set.rowId!)}/station`, { stationId });
      const station = this.stations.find((s) => s.id === stationId);
      toast.success(station ? `${set.id} plays at ${station.name}` : `${set.id} has no station`);
      await this.refreshSets();
    } catch (e) {
      failed(`Could not set the station of ${set.id}`, e);
    }
  }

  /** `position: null` takes it out of the queue, so one button adds and removes. */
  async queueStream(set: BracketSet, enter: boolean) {
    try {
      await this.api.post(`/match/${seg(set.rowId!)}/stream-queue`, {
        position: enter ? this.nextInQueue() : null,
      });
      toast.success(enter ? `${set.id} is in the broadcast queue` : `${set.id} is out of the broadcast queue`);
      await this.refreshSets();
    } catch (e) {
      failed(`Could not change the broadcast queue for ${set.id}`, e);
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
      toast.success(`${this.name(winnerId)} wins ${set.id}`);
      await this.refreshSets();
      await this.refreshSwiss();
      await this.refreshDisputes();
    } catch (e) {
      failed(`Could not report ${set.id}`, e);
    }
  }

  // ── Swiss ──────────────────────────────────────────────────────────────────

  refreshSwiss() {
    return this.loads.swiss.load();
  }

  private async fetchSwiss() {
    if (this.format !== "swiss") {
      this.swiss = null;
      return;
    }
    const tid = this.tid;
    const { data } = await this.api.get<{ data: SwissState }>(`/tournament/${seg(tid!)}/swiss`);
    if (this.tid === tid) this.swiss = data;
  }

  async swissNextRound() {
    try {
      const { data } = await this.api.post<{ data: { round: number; warnings?: string[] } }>(
        `/tournament/${seg(this.tid!)}/swiss/next-round`
      );
      // The pairer's warnings (forced rematches, repeated byes) are what a judge needs first.
      const warnings = (data.warnings ?? []).join(" · ");
      this.notice.swiss = warnings
        ? { variant: "warning", title: `Round ${data.round}: pairing warnings`, text: warnings }
        : null;
      toast.success(`Round ${data.round} paired`);
      await this.refreshSwiss();
      await this.refreshSets();
    } catch (e) {
      failed("Could not pair the next round", e);
    }
  }

  async swissCut() {
    try {
      const res = await this.api.get<{
        data?: { participantId: string }[] & { provisional?: boolean };
        provisional?: boolean;
      }>(`/tournament/${seg(this.tid!)}/swiss/cut?size=8`);
      const pass = (res.data ?? []).map((s) => this.name(s.participantId));
      // Says whether the cut is PROVISIONAL: a top 8 before the last round is not final.
      const provisional = res.provisional ?? res.data?.provisional;
      this.notice.swiss = {
        variant: provisional ? "warning" : "info",
        title: provisional ? "Provisional cut (rounds remaining)" : "Cut",
        text: pass.join(", ") || "Nobody yet",
      };
    } catch (e) {
      failed("Could not read the cut", e);
    }
  }

  // ── Reports that do not match ──────────────────────────────────────────────

  async refreshDisputes() {
    if (!this.tid) return;
    // A failure here cannot take down the rest of the panel: its tab shows it and we move on.
    await this.loads.disputes.load();
  }

  private async fetchDisputes() {
    const tid = this.tid;
    if (!tid) return;
    const data = await this.api.get<{ disputed?: Dispute[] }>(`/tournament/${seg(tid)}/pending-reports`);
    if (this.tid === tid) this.disputes = data.disputed ?? [];
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
    try {
      await this.api.post(`/match/${seg(d.matchId)}/resolve`, { winnerId });
      toast.success(`${d.bracketMatchId ? `Set ${d.bracketMatchId}` : "The set"} goes to ${this.name(winnerId)}`);
      await this.refreshDisputes();
      await this.refreshSets();
    } catch (e) {
      failed("Could not rule on the report", e);
    }
  }
}

export const provideBooth = (b: Booth) => setContext(KEY, b);
export const useBooth = () => getContext<Booth>(KEY);

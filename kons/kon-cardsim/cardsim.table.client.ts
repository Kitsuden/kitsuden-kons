/**
 * `@kitsuden/kon-cardsim/table` — playing another person, in the browser
 * ============================================================================
 *
 * Three pieces, none of them tied to Svelte or the DOM tree:
 *
 *   · `createTableApi`    — the kon's table routes (rooms, seats, actions, undo, rematch…), with
 *                           the player's session cookie.
 *   · `connectRealtime`   — the host's WebSocket (`/api/realtime`): subscribes to the table's
 *                           channels, pings, and reconnects with backoff, resubscribing.
 *   · `createTableSession` — the table as a store: the seat's view, the clocks, the pending undo,
 *                           shared image sources; acts with `expectActionCount` so a retry is
 *                           never applied twice; falls back to polling while the socket is down.
 *
 * ── WHAT THE SOCKET BRINGS ─────────────────────────────────────────────────
 *
 * "Something happened at the table" (`cardsim.relay.ts`), never the state. On each event the
 * client asks for ITS seat's view (`get-session`): the server's `viewFor` stays the only place that
 * decides what each seat may see, so a socket listener cannot learn a secret.
 */

import type { GameDefinition, SessionView, Action } from "./cardsim.engine.js";
import type { ImageSource } from "./cardsim.images.js";
import {
  parseTableEvent,
  playersChannel,
  tableChannel,
  type SharedSource,
  type TableEvent,
} from "./cardsim.relay.js";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> | null = null
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// ── The routes ───────────────────────────────────────────────────────────────

export interface RoomSummary {
  id: string;
  code: string | null;
  gameId: string;
  name: string | null;
  seats: (string | null)[];
  hasPassword: boolean;
  allowSpectators: boolean;
}

export interface TableRead {
  data: SessionView;
  definition: GameDefinition;
  seat: number | null;
  actionCount: number;
  undoRequest: { by: number; toActionCount: number } | null;
  matchId: string | null;
  status: string;
  clocks: number[] | null;
  timedOut: number | null;
}

export interface CreateRoomInput {
  gameId: string;
  deckIds: string[];
  name?: string;
  visibility?: "public" | "private";
  password?: string;
  allowSpectators?: boolean;
  bestOf?: number;
  timeControlSeconds?: number;
  incrementSeconds?: number;
}

export function createTableApi(options: { apiBase: string; fetcher?: Fetcher }) {
  const base = options.apiBase.replace(/\/+$/, "");
  const fetcher: Fetcher = options.fetcher ?? ((u, i) => fetch(u, i));

  async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetcher(`${base}${path}`, {
        method,
        credentials: "include",
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "offline");
    }
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = json?.error;
      const message =
        typeof err === "string"
          ? err
          : err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
            ? (err as { message: string }).message
            : `HTTP ${res.status}`;
      throw new ApiError(res.status, message, json);
    }
    return json as T;
  }

  /** Writes carry an `Idempotency-Key`: the host answers a retry with the first response. */
  const write = <T>(method: string, path: string, body?: unknown) =>
    call<T>(method, path, body, { "idempotency-key": newKey() });

  return {
    getGame: (slug: string) =>
      call<{ data: { id: string; slug: string; name: string; imageMode?: string; definition: GameDefinition } }>(
        "GET",
        `/games/${encodeURIComponent(slug)}`
      ),
    lookupCards: (slug: string, ids: string[]) =>
      call<{ data: Array<{ cardId: string; name: string; imageUrl?: string | null; data?: Record<string, unknown> }> }>(
        "POST",
        `/games/${encodeURIComponent(slug)}/cards/lookup`,
        { ids }
      ),
    listRooms: (gameId: string) =>
      call<{ data: RoomSummary[] }>("GET", `/sessions?gameId=${encodeURIComponent(gameId)}`),
    findRoom: (code: string) =>
      call<{ data: { id: string; gameId: string; status: string; hasPassword: boolean; allowSpectators: boolean } }>(
        "GET",
        `/rooms/${encodeURIComponent(code.trim())}`
      ),
    myDecks: (gameId: string) =>
      call<{ data: Array<{ id: string; name: string; updatedAt?: string }> }>(
        "GET",
        `/decks?gameId=${encodeURIComponent(gameId)}`
      ),
    importDeck: (input: { gameId: string; name?: string; content: string }) =>
      write<{ data: { id: string; name: string } }>("POST", "/decks/import", { format: "text", ...input }),
    createRoom: (input: CreateRoomInput) =>
      write<{ data: { id: string; code: string; seats: (string | null)[]; matchId: string | null } }>(
        "POST",
        "/sessions",
        input
      ),
    takeSeat: (id: string, input: { seat: number; deckId: string; password?: string }) =>
      write<{ data: { seat: number; seats: (string | null)[]; status: string } }>(
        "POST",
        `/sessions/${encodeURIComponent(id)}/join`,
        input
      ),
    getSession: (id: string) => call<TableRead>("GET", `/sessions/${encodeURIComponent(id)}`),
    sendAction: (id: string, input: { seat: number; action: Action | Record<string, unknown>; expectActionCount?: number }) =>
      write<{ data: SessionView; actionCount: number; result: unknown; clocks: number[] | null }>(
        "POST",
        `/sessions/${encodeURIComponent(id)}/action`,
        input
      ),
    requestUndo: (id: string, toActionCount: number) =>
      write<{ data: SessionView | { pending: boolean; toActionCount: number }; actionCount?: number }>(
        "POST",
        `/sessions/${encodeURIComponent(id)}/undo`,
        { toActionCount }
      ),
    cancelUndo: (id: string) => write<null>("DELETE", `/sessions/${encodeURIComponent(id)}/undo`),
    rematch: (id: string) =>
      write<{ data: { id: string; gameIndex: number } }>("POST", `/sessions/${encodeURIComponent(id)}/rematch`),
    shareSource: (id: string, source: SharedSource & { enabled?: boolean }) =>
      write<{ data: { shared: boolean } }>("POST", `/sessions/${encodeURIComponent(id)}/share-source`, { source }),
  };
}

export type TableApi = ReturnType<typeof createTableApi>;

// ── The socket ───────────────────────────────────────────────────────────────

/** `https://api.example.org/api/cardsim` → `wss://api.example.org/api/realtime`. */
export function realtimeUrl(apiBase: string, origin?: string): string {
  const url = new URL(apiBase, origin ?? (typeof location !== "undefined" ? location.href : undefined));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/realtime";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export type ConnectionStatus = "connecting" | "live" | "down";

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface RealtimeOptions {
  url: string;
  channels: string[];
  onEvent(channel: string, data: unknown): void;
  /** Called after every (re)connection: events may have been missed while down. */
  onResync?(): void;
  onStatus?(status: ConnectionStatus): void;
  createSocket?: (url: string) => SocketLike;
  minDelayMs?: number;
  maxDelayMs?: number;
  pingMs?: number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * One socket, its channels, and reconnection with exponential backoff and jitter (1 s doubling to
 * 30 s): a server restart does not get every client knocking at the same instant.
 */
export function connectRealtime(options: RealtimeOptions) {
  const min = options.minDelayMs ?? 1000;
  const max = options.maxDelayMs ?? 30_000;
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const createSocket =
    options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);

  let channels = [...options.channels];
  let socket: SocketLike | null = null;
  let attempt = 0;
  let closed = false;
  let retry: unknown = null;
  let ping: unknown = null;
  const confirmed = new Set<string>();

  const status = (s: ConnectionStatus) => options.onStatus?.(s);
  const send = (frame: Record<string, unknown>) => {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(frame));
  };

  function schedulePing() {
    if (ping) clearTimer(ping);
    ping = setTimer(() => {
      send({ type: "ping" });
      schedulePing();
    }, options.pingMs ?? 25_000);
  }

  function open() {
    if (closed) return;
    status("connecting");
    confirmed.clear();
    let s: SocketLike;
    try {
      s = createSocket(options.url);
    } catch {
      return reconnect();
    }
    socket = s;
    s.onmessage = (ev) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (frame.type === "connected") {
        for (const channel of channels) send({ type: "subscribe", channel });
        schedulePing();
      } else if (frame.type === "subscribed" && typeof frame.channel === "string") {
        confirmed.add(frame.channel);
        // Live once the table channel is confirmed: the others are extras.
        if (frame.channel === channels[0]) {
          attempt = 0;
          status("live");
          options.onResync?.();
        }
      } else if (frame.type === "message" && typeof frame.channel === "string") {
        options.onEvent(frame.channel, frame.data);
      }
    };
    s.onclose = () => {
      if (socket === s) socket = null;
      if (ping) clearTimer(ping);
      reconnect();
    };
    s.onerror = () => {
      /* onclose follows */
    };
  }

  function reconnect() {
    if (closed) return;
    status("down");
    const delay = Math.min(max, min * 2 ** attempt) * (0.5 + random() * 0.5);
    attempt = Math.min(attempt + 1, 16);
    retry = setTimer(open, delay);
  }

  open();

  return {
    /** Changes the channels (a rematch moves the table): unsubscribes the old, subscribes the new. */
    setChannels(next: string[]) {
      for (const c of channels) if (!next.includes(c)) send({ type: "unsubscribe", channel: c });
      for (const c of next) if (!channels.includes(c)) send({ type: "subscribe", channel: c });
      channels = [...next];
    },
    isSubscribed: (channel: string) => confirmed.has(channel),
    close() {
      closed = true;
      if (retry) clearTimer(retry);
      if (ping) clearTimer(ping);
      const s = socket;
      socket = null;
      s?.close(1000);
    },
  };
}

// ── The table as a store ─────────────────────────────────────────────────────

export interface TableState {
  sessionId: string;
  seat: number | null;
  view: SessionView | null;
  definition: GameDefinition | null;
  actionCount: number;
  status: string;
  clocks: number[] | null;
  /** When `clocks` was read, to count down locally between reads. */
  clocksAt: number;
  timedOut: number | null;
  undoRequest: { by: number; toActionCount: number } | null;
  matchId: string | null;
  /** The rematch that was started (by either player). */
  rematchId: string | null;
  connection: ConnectionStatus | "polling";
  /** Sources the other players offered, waiting for this player's yes or no. */
  offers: Array<{ by: number; source: SharedSource }>;
  busy: boolean;
  error: { kind: "stale" | "refused" | "offline" | "auth" | "other"; message: string } | null;
}

export interface TableSessionOptions {
  api: TableApi;
  sessionId: string;
  /** The socket factory; without it, the table polls. */
  realtime?: (opts: Pick<RealtimeOptions, "channels" | "onEvent" | "onResync" | "onStatus">) => {
    setChannels(c: string[]): void;
    close(): void;
  };
  pollMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function errorOf(e: unknown): TableState["error"] {
  if (e instanceof ApiError) {
    if (e.status === 0) return { kind: "offline", message: e.message };
    if (e.status === 401 || e.status === 403) return { kind: "auth", message: e.message };
    if (e.status === 409 && e.body?.stale) return { kind: "stale", message: e.message };
    if (e.status === 409 || e.status === 422) return { kind: "refused", message: e.message };
    return { kind: "other", message: e.message };
  }
  return { kind: "other", message: e instanceof Error ? e.message : String(e) };
}

export function createTableSession(options: TableSessionOptions) {
  const { api } = options;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const pollMs = options.pollMs ?? 3000;

  let state: TableState = {
    sessionId: options.sessionId,
    seat: null,
    view: null,
    definition: null,
    actionCount: 0,
    status: "open",
    clocks: null,
    clocksAt: now(),
    timedOut: null,
    undoRequest: null,
    matchId: null,
    rematchId: null,
    connection: options.realtime ? "connecting" : "polling",
    offers: [],
    busy: false,
    error: null,
  };
  const listeners = new Set<(s: TableState) => void>();
  const emit = (patch: Partial<TableState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l(state);
  };

  let stopped = false;
  let refreshing: Promise<void> | null = null;
  let again = false;
  let poll: unknown = null;
  let clockTimer: unknown = null;
  let socket: ReturnType<NonNullable<TableSessionOptions["realtime"]>> | null = null;

  /** One read at a time; a read asked for during another runs once after it. */
  function refresh(): Promise<void> {
    if (refreshing) {
      again = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        again = false;
        try {
          const r = await api.getSession(state.sessionId);
          emit({
            seat: r.seat,
            view: r.data,
            definition: r.definition,
            actionCount: r.actionCount,
            status: r.status,
            clocks: r.clocks,
            clocksAt: now(),
            timedOut: r.timedOut,
            undoRequest: r.undoRequest,
            matchId: r.matchId,
            error: state.error?.kind === "offline" ? null : state.error,
          });
          scheduleClock();
        } catch (e) {
          emit({ error: errorOf(e) });
        }
      } while (again && !stopped);
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /** Reading enforces the clock on the server: ask again when the active player's runs out. */
  function scheduleClock() {
    if (clockTimer) clearTimer(clockTimer);
    clockTimer = null;
    const view = state.view as (SessionView & { activePlayer?: number; pending?: { player: number } | null }) | null;
    if (!state.clocks || state.status !== "playing" || !view) return;
    const active = view.pending?.player ?? view.activePlayer ?? 0;
    const left = state.clocks[active] ?? 0;
    clockTimer = setTimer(() => void refresh(), Math.max(250, left + 300));
  }

  function startPolling() {
    if (poll || stopped) return;
    const tick = () => {
      poll = setTimer(() => {
        if (stopped || state.connection === "live") {
          poll = null;
          return;
        }
        void refresh().finally(tick);
      }, pollMs);
    };
    tick();
  }

  function onEvent(_channel: string, data: unknown) {
    const event = parseTableEvent(data);
    if (!event) return;
    handle(event);
  }

  function handle(event: TableEvent) {
    switch (event.type) {
      case "sourceShared":
        if (event.by !== state.seat) emit({ offers: [...state.offers, { by: event.by, source: event.source }] });
        return;
      case "rematch":
        emit({ rematchId: event.sessionId });
        return;
      case "action":
        // Our own action brings our view back with its response. The server broadcasts BEFORE it
        // answers, so the echo usually arrives while the request is still in flight: skip it then
        // too, or every play costs a second read.
        if (event.by === state.seat && (inFlight > 0 || event.actionCount <= state.actionCount)) return;
        void refresh();
        return;
      default:
        void refresh();
    }
  }

  function channels() {
    return [tableChannel(state.sessionId), playersChannel(state.sessionId)];
  }

  function connect() {
    if (!options.realtime) {
      startPolling();
      return;
    }
    socket = options.realtime({
      channels: channels(),
      onEvent,
      onResync: () => void refresh(),
      onStatus: (s) => {
        emit({ connection: s });
        if (s !== "live") startPolling();
      },
    });
  }

  let queue: Promise<unknown> = Promise.resolve();
  let inFlight = 0;

  /** Actions go one after another, each against the count the player saw. */
  function act(action: Record<string, unknown>): Promise<boolean> {
    const run = async () => {
      if (state.seat === null) return false;
      emit({ busy: true, error: null });
      inFlight++;
      try {
        const r = await api.sendAction(state.sessionId, {
          seat: state.seat,
          action,
          expectActionCount: state.actionCount,
        });
        emit({ view: r.data, actionCount: r.actionCount, clocks: r.clocks, clocksAt: now(), busy: false });
        if (r.result) void refresh();
        else scheduleClock();
        return true;
      } catch (e) {
        emit({ busy: false, error: errorOf(e) });
        // The table moved (or this went through and the answer was lost): show what is there.
        void refresh();
        return false;
      } finally {
        inFlight--;
      }
    };
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  }

  async function guarded<T>(task: () => Promise<T>): Promise<T | null> {
    emit({ busy: true, error: null });
    try {
      return await task();
    } catch (e) {
      emit({ error: errorOf(e) });
      return null;
    } finally {
      emit({ busy: false });
      void refresh();
    }
  }

  return {
    get state() {
      return state;
    },
    subscribe(listener: (s: TableState) => void) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    async start() {
      await refresh();
      connect();
    },
    refresh,
    act,
    /** Ask to take back the last action (solo: at once; with a rival: they must accept). */
    askUndo: () =>
      state.actionCount > 0 ? guarded(() => api.requestUndo(state.sessionId, state.actionCount - 1)) : Promise.resolve(null),
    /** Accept the other player's request: asking for the same count applies it. */
    acceptUndo: () =>
      state.undoRequest ? guarded(() => api.requestUndo(state.sessionId, state.undoRequest!.toActionCount)) : Promise.resolve(null),
    declineUndo: () => guarded(() => api.cancelUndo(state.sessionId)),
    concede: () => act({ type: "concede" }),
    async rematch() {
      const r = await guarded(() => api.rematch(state.sessionId));
      if (r) emit({ rematchId: r.data.id });
      return r?.data.id ?? null;
    },
    /** Moves this store to another table (the rematch), keeping the socket. */
    async follow(sessionId: string) {
      emit({ sessionId, rematchId: null, offers: [], view: null, actionCount: 0, undoRequest: null, error: null });
      socket?.setChannels(channels());
      await refresh();
    },
    share: (source: ImageSource) =>
      source.kind === "template" || source.kind === "pack"
        ? guarded(() => api.shareSource(state.sessionId, { kind: source.kind, label: source.label, url: source.url }))
        : Promise.resolve(null),
    dismissOffer(index: number) {
      emit({ offers: state.offers.filter((_, i) => i !== index) });
    },
    clearError() {
      emit({ error: null });
    },
    /** The clocks as of now: the server's, minus what ran since it was read. */
    clocksNow(): number[] | null {
      if (!state.clocks) return null;
      const view = state.view as (SessionView & { activePlayer?: number; pending?: { player: number } | null }) | null;
      if (state.status !== "playing" || !view) return state.clocks;
      const active = view.pending?.player ?? view.activePlayer ?? 0;
      const ran = now() - state.clocksAt;
      return state.clocks.map((ms, i) => (i === active ? Math.max(0, ms - ran) : ms));
    },
    stop() {
      stopped = true;
      if (poll) clearTimer(poll);
      if (clockTimer) clearTimer(clockTimer);
      socket?.close();
      listeners.clear();
    },
  };
}

export type TableSession = ReturnType<typeof createTableSession>;

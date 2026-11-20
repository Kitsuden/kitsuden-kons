/**
 * `@kitsuden/kon-cardsim/table`: the two-player table's browser client
 * ============================================================================
 *
 * The socket and the timers are fakes the test drives by hand, so reconnection, backoff and
 * polling are checked step by step instead of by waiting.
 */

import { describe, expect, test } from "vitest";

import {
  ApiError,
  connectRealtime,
  createTableSession,
  realtimeUrl,
  type SocketLike,
  type TableApi,
  type TableRead,
} from "../../kons/kon-cardsim/cardsim.table.client";

// ── Fakes ────────────────────────────────────────────────────────────────────

function timers() {
  const pending: { id: number; fn: () => void; ms: number }[] = [];
  let next = 0;
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++next;
      pending.push({ id, fn, ms });
      return id;
    },
    clearTimer: (id: unknown) => {
      const i = pending.findIndex((t) => t.id === id);
      if (i >= 0) pending.splice(i, 1);
    },
    /** Runs the oldest pending timer with this delay (or any, if no delay given). */
    fire(ms?: number) {
      const i = pending.findIndex((t) => ms === undefined || t.ms === ms);
      if (i < 0) throw new Error(`no timer of ${ms} ms (have ${pending.map((t) => t.ms).join(", ")})`);
      const [t] = pending.splice(i, 1);
      t.fn();
    },
  };
}

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: any[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  server(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** The server confirms each subscription it was asked for. */
  confirmAll() {
    for (const f of this.sent.filter((f) => f.type === "subscribe")) this.server({ type: "subscribed", channel: f.channel });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function view(over: Partial<TableRead> = {}): TableRead {
  return {
    data: {
      turn: 1,
      activePlayer: 0,
      phase: "main",
      globals: {},
      players: [],
      board: {},
      log: [],
      result: null,
      pending: null,
    },
    definition: {} as never,
    seat: 0,
    actionCount: 3,
    undoRequest: null,
    matchId: null,
    status: "playing",
    clocks: null,
    timedOut: null,
    ...over,
  };
}

function fakeApi(start: TableRead = view()) {
  let current = start;
  const calls: { name: string; args: unknown[] }[] = [];
  const log = (name: string, ...args: unknown[]) => calls.push({ name, args });
  let sendImpl: (input: any) => Promise<any> = async (input) => {
    current = { ...current, actionCount: current.actionCount + 1 };
    return { data: current.data, actionCount: current.actionCount, result: null, clocks: current.clocks };
  };
  const api = {
    getSession: async (id: string) => {
      log("getSession", id);
      return current;
    },
    sendAction: async (id: string, input: any) => {
      log("sendAction", id, input);
      return sendImpl(input);
    },
    requestUndo: async (id: string, n: number) => (log("requestUndo", id, n), { data: { pending: true, toActionCount: n } }),
    cancelUndo: async (id: string) => (log("cancelUndo", id), null),
    rematch: async (id: string) => (log("rematch", id), { data: { id: "next", gameIndex: 1 } }),
    shareSource: async (id: string, s: unknown) => (log("shareSource", id, s), { data: { shared: true } }),
  } as unknown as TableApi;
  return {
    api,
    calls,
    count: (name: string) => calls.filter((c) => c.name === name).length,
    set: (v: Partial<TableRead>) => (current = { ...current, ...v }),
    onSend: (fn: typeof sendImpl) => (sendImpl = fn),
  };
}

// ── The socket ───────────────────────────────────────────────────────────────

describe("realtimeUrl", () => {
  test("http(s) API → ws(s) /api/realtime on the same host", () => {
    expect(realtimeUrl("https://api.example.org/api/cardsim")).toBe("wss://api.example.org/api/realtime");
    expect(realtimeUrl("http://localhost:3000/api/cardsim/")).toBe("ws://localhost:3000/api/realtime");
    expect(realtimeUrl("/api/cardsim", "https://site.example.org/tcg/x")).toBe("wss://site.example.org/api/realtime");
  });
});

describe("connectRealtime", () => {
  function setup() {
    const t = timers();
    const sockets: FakeSocket[] = [];
    const events: [string, unknown][] = [];
    const statuses: string[] = [];
    let resyncs = 0;
    const conn = connectRealtime({
      url: "ws://x/api/realtime",
      channels: ["kon:cardsim:session:s1", "kon:cardsim:session:s1:players"],
      onEvent: (c, d) => events.push([c, d]),
      onResync: () => resyncs++,
      onStatus: (s) => statuses.push(s),
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      random: () => 1,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    return { t, sockets, events, statuses, conn, resyncs: () => resyncs };
  }

  test("subscribes once the server says hello, and is live when the table channel is confirmed", () => {
    const { sockets, statuses, resyncs } = setup();
    sockets[0].server({ type: "connected" });
    expect(sockets[0].sent).toEqual([
      { type: "subscribe", channel: "kon:cardsim:session:s1" },
      { type: "subscribe", channel: "kon:cardsim:session:s1:players" },
    ]);
    sockets[0].confirmAll();
    expect(statuses).toEqual(["connecting", "live"]);
    expect(resyncs()).toBe(1);
  });

  test("passes channel messages on, ignores everything else", () => {
    const { sockets, events } = setup();
    sockets[0].server({ type: "connected" });
    sockets[0].server({ type: "message", channel: "kon:cardsim:session:s1", data: { type: "undo", toActionCount: 2 } });
    sockets[0].server({ type: "pong" });
    sockets[0].onmessage?.({ data: "not json" });
    expect(events).toEqual([["kon:cardsim:session:s1", { type: "undo", toActionCount: 2 }]]);
  });

  test("reconnects with growing delays and subscribes again", () => {
    const { t, sockets, statuses, resyncs } = setup();
    sockets[0].server({ type: "connected" });
    sockets[0].confirmAll();
    sockets[0].close();
    expect(statuses.at(-1)).toBe("down");
    t.fire(1000);
    sockets[1].close();
    t.fire(2000);
    sockets[2].close();
    t.fire(4000);
    sockets[3].server({ type: "connected" });
    expect(sockets[3].sent.filter((f) => f.type === "subscribe")).toHaveLength(2);
    sockets[3].confirmAll();
    expect(resyncs()).toBe(2);
    // Back to the shortest delay after a good connection.
    sockets[3].close();
    expect(t.pending.some((p) => p.ms === 1000)).toBe(true);
  });

  test("the delay stops growing at 30 s", () => {
    const { t, sockets } = setup();
    for (let i = 0; i < 8; i++) {
      sockets[i].close();
      t.fire();
    }
    sockets[8].close();
    expect(t.pending.at(-1)!.ms).toBe(30_000);
  });

  test("pings while connected; close() stops everything", () => {
    const { t, sockets, conn } = setup();
    sockets[0].server({ type: "connected" });
    t.fire(25_000);
    expect(sockets[0].sent.at(-1)).toEqual({ type: "ping" });
    conn.close();
    expect(t.pending).toEqual([]);
    expect(sockets).toHaveLength(1);
  });

  test("changing channels unsubscribes the old and subscribes the new", () => {
    const { sockets, conn } = setup();
    sockets[0].server({ type: "connected" });
    sockets[0].sent.length = 0;
    conn.setChannels(["kon:cardsim:session:s2", "kon:cardsim:session:s2:players"]);
    expect(sockets[0].sent.map((f) => `${f.type} ${f.channel}`)).toEqual([
      "unsubscribe kon:cardsim:session:s1",
      "unsubscribe kon:cardsim:session:s1:players",
      "subscribe kon:cardsim:session:s2",
      "subscribe kon:cardsim:session:s2:players",
    ]);
  });
});

// ── The table store ──────────────────────────────────────────────────────────

describe("createTableSession", () => {
  function withSocket(api: TableApi, t = timers()) {
    let hooks!: { onEvent: (c: string, d: unknown) => void; onResync?: () => void; onStatus?: (s: any) => void };
    let channels: string[] = [];
    const table = createTableSession({
      api,
      sessionId: "s1",
      realtime: (opts) => {
        hooks = opts as typeof hooks;
        channels = opts.channels;
        return { setChannels: (c) => (channels = c), close: () => {} };
      },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    return { table, t, event: (d: unknown) => hooks.onEvent("kon:cardsim:session:s1", d), hooks: () => hooks, channels: () => channels };
  }

  test("reads the table, then listens on its two channels", async () => {
    const f = fakeApi();
    const { table, channels } = withSocket(f.api);
    await table.start();
    expect(f.count("getSession")).toBe(1);
    expect(table.state.actionCount).toBe(3);
    expect(channels()).toEqual(["kon:cardsim:session:s1", "kon:cardsim:session:s1:players"]);
  });

  test("an event from the other seat makes it read its view again; a malformed one does not", async () => {
    const f = fakeApi();
    const { table, event } = withSocket(f.api);
    await table.start();
    f.set({ actionCount: 4 });
    event({ type: "action", actionCount: 4, actionType: "draw", by: 1, finished: false });
    await tick();
    expect(f.count("getSession")).toBe(2);
    expect(table.state.actionCount).toBe(4);
    event({ type: "action", action: { type: "draw" } });
    event({ type: "hack" });
    await tick();
    expect(f.count("getSession")).toBe(2);
  });

  test("its own action's echo is not read twice", async () => {
    const f = fakeApi();
    const { table, event } = withSocket(f.api);
    await table.start();
    await table.act({ type: "draw", count: 1 });
    event({ type: "action", actionCount: 4, actionType: "draw", by: 0, finished: false });
    await tick();
    expect(f.count("getSession")).toBe(1);
  });

  test("the echo of its own action arriving BEFORE the response is not read either", async () => {
    const f = fakeApi();
    const { table, event } = withSocket(f.api);
    await table.start();
    // The server broadcasts and only then answers: deliver the echo mid-request.
    f.onSend(async () => {
      event({ type: "action", actionCount: 4, actionType: "draw", by: 0, finished: false });
      await tick();
      return { data: view().data, actionCount: 4, result: null, clocks: null };
    });
    await table.act({ type: "draw", count: 1 });
    await tick();
    expect(f.count("getSession")).toBe(1);
    expect(table.state.actionCount).toBe(4);
  });

  test("actions go one at a time, each with the count it saw", async () => {
    const f = fakeApi();
    const { table } = withSocket(f.api);
    await table.start();
    await Promise.all([table.act({ type: "draw", count: 1 }), table.act({ type: "endTurn" })]);
    const sends = f.calls.filter((c) => c.name === "sendAction").map((c) => (c.args[1] as any).expectActionCount);
    expect(sends).toEqual([3, 4]);
    expect(table.state.actionCount).toBe(5);
  });

  test("a stale action is reported and the table is read again", async () => {
    const f = fakeApi();
    const { table } = withSocket(f.api);
    await table.start();
    f.onSend(async () => {
      throw new ApiError(409, "The table moved since you looked", { stale: true, actionCount: 7 });
    });
    f.set({ actionCount: 7 });
    expect(await table.act({ type: "draw", count: 1 })).toBe(false);
    await tick();
    expect(table.state.error?.kind).toBe("stale");
    expect(table.state.actionCount).toBe(7);
  });

  test("offers from the other player wait for an answer; its own are ignored", async () => {
    const f = fakeApi();
    const { table, event } = withSocket(f.api);
    await table.start();
    const source = { kind: "pack", label: "P", url: "https://e.org/p.json" };
    event({ type: "sourceShared", by: 0, source });
    event({ type: "sourceShared", by: 1, source });
    expect(table.state.offers).toEqual([{ by: 1, source }]);
    table.dismissOffer(0);
    expect(table.state.offers).toEqual([]);
  });

  test("a rematch is announced, and following it moves the channels", async () => {
    const f = fakeApi();
    const { table, event, channels } = withSocket(f.api);
    await table.start();
    event({ type: "rematch", sessionId: "s2" });
    expect(table.state.rematchId).toBe("s2");
    await table.follow("s2");
    expect(channels()).toEqual(["kon:cardsim:session:s2", "kon:cardsim:session:s2:players"]);
    expect(f.calls.at(-1)).toEqual({ name: "getSession", args: ["s2"] });
  });

  test("accepting an undo asks for the same count; declining cancels it", async () => {
    const f = fakeApi(view({ undoRequest: { by: 1, toActionCount: 2 } }));
    const { table } = withSocket(f.api);
    await table.start();
    await table.acceptUndo();
    await table.declineUndo();
    expect(f.calls.filter((c) => c.name !== "getSession").map((c) => [c.name, c.args[1]])).toEqual([
      ["requestUndo", 2],
      ["cancelUndo", undefined],
    ]);
  });

  test("only templates and packs are shared", async () => {
    const f = fakeApi();
    const { table } = withSocket(f.api);
    await table.start();
    await table.share({ kind: "folder", label: "Mine", enabled: true });
    await table.share({ kind: "template", label: "T", url: "https://e.org/{id}.png", enabled: true });
    expect(f.calls.filter((c) => c.name === "shareSource").map((c) => c.args[1])).toEqual([
      { kind: "template", label: "T", url: "https://e.org/{id}.png" },
    ]);
  });

  test("without a socket (or while it is down) it polls", async () => {
    const f = fakeApi();
    const t = timers();
    const table = createTableSession({ api: f.api, sessionId: "s1", pollMs: 3000, setTimer: t.setTimer, clearTimer: t.clearTimer });
    await table.start();
    t.fire(3000);
    await tick();
    t.fire(3000);
    await tick();
    expect(f.count("getSession")).toBe(3);
    table.stop();
    expect(t.pending.filter((p) => p.ms === 3000)).toEqual([]);
  });

  test("with a clock, it reads the table again when the active player's time is up", async () => {
    const f = fakeApi(view({ clocks: [5000, 60_000] }));
    const t = timers();
    const { table } = withSocket(f.api, t);
    await table.start();
    expect(t.pending.some((p) => p.ms === 5300)).toBe(true);
    t.fire(5300);
    await tick();
    expect(f.count("getSession")).toBe(2);
  });
});

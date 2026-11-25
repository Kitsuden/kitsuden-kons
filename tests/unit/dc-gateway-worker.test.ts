/**
 * kon-dc: the Discord gateway as a core kon worker (dc.gateway.ts)
 * ============================================================================
 *
 * Driven against a fake Discord: a socket that answers HELLO, READY and dispatches, and records
 * what the worker sends. What must hold is what the Go worker in `gateway/` guarantees: identify
 * with the engine's intents, forward only the events the modules asked for, resume after a drop,
 * identify again when the intents change, never retry a fatal close, close for good on stop, and
 * never block a shard on a slow engine.
 */
import { describe, expect, it } from "vitest";

import {
  Forwarder,
  gatewayWorkerEnabled,
  runGateway,
  shardSettings,
  trimPayload,
  type GatewayOptions,
  type GatewaySocket,
} from "../../kons/kon-dc/dc.gateway";
import type { GatewayConfig, GatewayEventBatch, GatewayEventEnvelope } from "../../kons/kon-dc/dc.contract";

const quiet = { info() {}, warn() {}, error() {} };

/** A fake gateway connection. `script` reacts to what the worker sends. */
class FakeSocket implements GatewaySocket {
  readyState = 1;
  sent: Array<{ op: number; d: any }> = [];
  closed: { code: number; reason: string } | null = null;
  private listeners: Record<string, Array<(e: any) => void>> = {};

  constructor(
    readonly url: string,
    private readonly script: (ws: FakeSocket, msg: { op: number; d: any }) => void
  ) {
    // Discord greets first.
    setTimeout(() => this.emit({ op: 10, d: { heartbeat_interval: 60_000 }, s: null, t: null }), 0);
  }

  addEventListener(type: string, fn: (e: any) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string): void {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    this.script(this, msg);
  }
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = 3;
    setTimeout(() => this.fire("close", { code, reason }), 0);
  }
  /** Discord closes the connection. */
  serverClose(code: number): void {
    this.closed = { code, reason: "server" };
    this.readyState = 3;
    this.fire("close", { code, reason: "server" });
  }
  emit(frame: { op: number; d: any; s: number | null; t: string | null }): void {
    this.fire("message", { data: JSON.stringify(frame) });
  }
  private fire(type: string, e: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(e);
  }
}

const gatewayBot = (over: Partial<{ shards: number; remaining: number }> = {}) =>
  (async () =>
    new Response(
      JSON.stringify({
        url: "wss://gateway.fake",
        shards: over.shards ?? 1,
        session_start_limit: { remaining: over.remaining ?? 1000, reset_after: 0, max_concurrency: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as unknown as typeof fetch;

const config = (intents: number, events: string[], revision = `${intents}:${events.join(",")}`): GatewayConfig =>
  ({ contract: 1, intents, events, revision }) as GatewayConfig;

function until(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function harness(script: (ws: FakeSocket, msg: { op: number; d: any }, n: number) => void, over: Partial<GatewayOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const batches: GatewayEventBatch[] = [];
  let cfg = config(1 | 512, ["GUILD_CREATE", "MESSAGE_CREATE"]);
  const opts: GatewayOptions = {
    token: "bot-token",
    apiBase: "https://discord.fake/api/v10",
    config: async () => cfg,
    ingest: async (batch) => {
      batches.push(batch);
      return { accepted: batch.events.length, dropped: 0 };
    },
    logger: quiet,
    fetch: gatewayBot(),
    socket: (url) => {
      const n = sockets.length;
      const ws = new FakeSocket(url, (w, m) => script(w, m, n));
      sockets.push(ws);
      return ws;
    },
    random: () => 0,
    batchIntervalMs: 50,
    configEveryMs: 1000,
    identifyIntervalMs: 0,
    reconnectMs: 10,
    ...over,
  };
  return { opts, sockets, batches, setConfig: (c: GatewayConfig) => (cfg = c) };
}

/** Answers IDENTIFY with READY and RESUME with RESUMED, then sends `then`. */
const discord =
  (then: (ws: FakeSocket, n: number) => void = () => {}) =>
  (ws: FakeSocket, msg: { op: number; d: any }, n: number) => {
    if (msg.op === 2) {
      ws.emit({ op: 0, t: "READY", s: 1, d: { session_id: `sess-${n}`, resume_gateway_url: "wss://resume.fake", user: { username: "bot" }, guilds: [] } });
      then(ws, n);
    }
    if (msg.op === 6) {
      ws.emit({ op: 0, t: "RESUMED", s: msg.d.seq + 1, d: {} });
      then(ws, n);
    }
  };

describe("dc gateway worker", () => {
  it("identifies with the engine's intents and forwards only the events asked for, trimmed", async () => {
    const h = harness(
      discord((ws) => {
        ws.emit({ op: 0, t: "GUILD_CREATE", s: 2, d: { id: "123456789012345678", name: "Server", preferred_locale: "es-ES", members: new Array(50).fill({}) } });
        ws.emit({ op: 0, t: "TYPING_START", s: 3, d: { channel_id: "1" } });
        ws.emit({ op: 0, t: "MESSAGE_CREATE", s: 4, d: { id: "m1", content: "hi" } });
      })
    );
    const stop = new AbortController();
    const running = runGateway(h.opts, stop.signal);

    await until(() => h.batches.flatMap((b) => b.events).length >= 2);
    const identify = h.sockets[0]!.sent.find((m) => m.op === 2)!;
    expect(identify.d).toMatchObject({ token: "bot-token", intents: 513, shard: [0, 1] });
    expect(h.sockets[0]!.url).toBe("wss://gateway.fake/?v=10&encoding=json");

    const events = h.batches.flatMap((b) => b.events);
    expect(events.map((e) => e.t)).toEqual(["GUILD_CREATE", "MESSAGE_CREATE"]);
    expect(events[0]!.d).toEqual({ id: "123456789012345678", name: "Server", preferred_locale: "es-ES" });
    expect(events[0]).toMatchObject({ s: 2, shard: [0, 1] });
    expect(h.batches[0]!.contract).toBe(1);

    stop.abort();
    await running;
    // Shutting down ends the session for good (1000), it does not leave it to time out.
    expect(h.sockets[0]!.closed?.code).toBe(1000);
  });

  it("resumes the same session after Discord drops the connection", async () => {
    const h = harness(
      discord((ws, n) => {
        if (n === 0) {
          ws.emit({ op: 0, t: "MESSAGE_CREATE", s: 7, d: { id: "m" } });
          setTimeout(() => ws.serverClose(1006), 5);
        }
      })
    );
    const stop = new AbortController();
    const running = runGateway(h.opts, stop.signal);
    await until(() => h.sockets.length >= 2 && h.sockets[1]!.sent.some((m) => m.op === 6));
    const resume = h.sockets[1]!.sent.find((m) => m.op === 6)!;
    expect(resume.d).toEqual({ token: "bot-token", session_id: "sess-0", seq: 7 });
    expect(h.sockets[1]!.url).toBe("wss://resume.fake/?v=10&encoding=json");
    stop.abort();
    await running;
  });

  it("a fatal close (bad token) is not retried; the worker waits to be stopped", async () => {
    const h = harness((ws, msg) => {
      if (msg.op === 2) setTimeout(() => ws.serverClose(4004), 0);
    });
    const stop = new AbortController();
    let done = false;
    const running = runGateway(h.opts, stop.signal).then(() => (done = true));
    await until(() => h.sockets[0]?.closed?.code === 4004);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.sockets).toHaveLength(1);
    expect(done).toBe(false);
    stop.abort();
    await running;
  });

  it("new intents from the engine end the session and identify again with them", async () => {
    const h = harness(discord());
    const stop = new AbortController();
    const running = runGateway({ ...h.opts, configEveryMs: 1000 }, stop.signal);
    await until(() => h.sockets[0]?.sent.some((m) => m.op === 2) ?? false);
    h.setConfig(config(1 | 2 | 512, ["GUILD_CREATE", "GUILD_MEMBER_ADD"]));
    await until(() => h.sockets.length >= 2 && h.sockets[1]!.sent.some((m) => m.op === 2), 5000);
    expect(h.sockets[0]!.closed?.code).toBe(1000);
    expect(h.sockets[1]!.sent.find((m) => m.op === 2)!.d.intents).toBe(515);
    stop.abort();
    await running;
  });

  it("disallowed intents (4014) wait for the next config instead of reconnecting", async () => {
    const h = harness((ws, msg, n) => {
      if (msg.op === 2 && n === 0) setTimeout(() => ws.serverClose(4014), 0);
      if (msg.op === 2 && n > 0) ws.emit({ op: 0, t: "READY", s: 1, d: { session_id: "s", resume_gateway_url: "wss://r" } });
    });
    const stop = new AbortController();
    const running = runGateway(h.opts, stop.signal);
    await until(() => h.sockets[0]?.closed?.code === 4014);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.sockets).toHaveLength(1);
    h.setConfig(config(1, ["GUILD_CREATE"]));
    // The new socket exists before it has greeted and identified: wait for the IDENTIFY itself.
    await until(() => h.sockets[1]?.sent.some((m) => m.op === 2) ?? false, 5000);
    expect(h.sockets[1]!.sent.find((m) => m.op === 2)!.d.intents).toBe(1);
    stop.abort();
    await running;
  });

  it("a missed heartbeat ACK drops the zombie with a resumable close", async () => {
    const h = harness(() => {});
    const sockets: FakeSocket[] = [];
    // Sockets that greet with a 30 ms heartbeat and never acknowledge one.
    const greet = (url: string) => {
      const ws = new FakeSocket(url, (w, m) => {
        if (m.op === 2) w.emit({ op: 0, t: "READY", s: 1, d: { session_id: "z", resume_gateway_url: "wss://r" } });
      });
      const original = ws.emit.bind(ws);
      ws.emit = (frame) => original(frame.op === 10 ? { ...frame, d: { heartbeat_interval: 30 } } : frame);
      sockets.push(ws);
      return ws;
    };
    const stop = new AbortController();
    const running = runGateway({ ...h.opts, socket: greet }, stop.signal);
    await until(() => sockets[0]?.closed !== null && sockets[0]?.closed !== undefined, 3000);
    expect(sockets[0]!.closed!.code).toBe(4000);
    stop.abort();
    await running;
  });
});

describe("Forwarder", () => {
  const ev = (s: number, t = "MESSAGE_CREATE"): GatewayEventEnvelope =>
    ({ t, s, shard: [0, 1], receivedAt: new Date().toISOString(), d: {} }) as GatewayEventEnvelope;

  it("drops the oldest events when the buffer is full, never blocking the shard", () => {
    const f = new Forwarder(async () => ({ accepted: 0, dropped: 0 }), quiet, 50, 3, 1000);
    f.setEvents(["MESSAGE_CREATE"]);
    for (let s = 1; s <= 5; s++) f.push(ev(s));
    expect(f.pending).toBe(3);
    expect(f.dropped).toBe(2);
    f.push(ev(6, "TYPING_START"));
    expect(f.filtered).toBe(1);
  });

  it("gives a failed batch back and sends it once the engine recovers", async () => {
    let fail = true;
    const got: number[] = [];
    const f = new Forwarder(
      async (b) => {
        if (fail) throw new Error("db down");
        got.push(...b.events.map((e) => e.s));
        return { accepted: b.events.length, dropped: 0 };
      },
      quiet,
      2,
      100,
      20
    );
    f.setEvents(["MESSAGE_CREATE"]);
    const stop = new AbortController();
    const running = f.run(stop.signal);
    f.push(ev(1));
    f.push(ev(2));
    f.push(ev(3));
    await new Promise((r) => setTimeout(r, 60));
    expect(got).toEqual([]);
    fail = false;
    await until(() => got.length === 3);
    expect(got).toEqual([1, 2, 3]);
    stop.abort();
    await running;
  });
});

describe("settings", () => {
  it("the worker runs only with DISCORD_GATEWAY=worker", () => {
    expect(gatewayWorkerEnabled({ DISCORD_GATEWAY: "worker" })).toBe(true);
    expect(gatewayWorkerEnabled({ DISCORD_GATEWAY: " Worker " })).toBe(true);
    expect(gatewayWorkerEnabled({})).toBe(false);
    expect(gatewayWorkerEnabled({ DISCORD_GATEWAY: "external" })).toBe(false);
  });

  it("reads the shard settings like the Go worker, and refuses bad ones", () => {
    expect(shardSettings({})).toEqual({ shardCount: 0, shardIds: [] });
    expect(shardSettings({ DISCORD_SHARD_COUNT: "4", DISCORD_SHARD_IDS: "0, 2" })).toEqual({ shardCount: 4, shardIds: [0, 2] });
    expect(() => shardSettings({ DISCORD_SHARD_COUNT: "-1" })).toThrow();
    expect(() => shardSettings({ DISCORD_SHARD_IDS: "a" })).toThrow();
  });

  it("keeps only id, name, unavailable and preferred_locale of a server", () => {
    expect(trimPayload("GUILD_UPDATE", { id: "1", name: "n", channels: [1], preferred_locale: "pt-BR" })).toEqual({
      id: "1",
      name: "n",
      preferred_locale: "pt-BR",
    });
    expect(trimPayload("MESSAGE_CREATE", { id: "m", content: "x" })).toEqual({ id: "m", content: "x" });
  });
});

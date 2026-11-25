/**
 * kon-dc — the Discord gateway as a kon worker
 * ============================================================================
 *
 * The same job as the Go worker in `gateway/`, inside the Kitsuden API image: keep the gateway
 * WebSocket connected (heartbeats, resume, identify again when the intents change) and hand the
 * dispatches the modules asked for to the engine in batches. It runs as a core kon worker
 * (`workers` in the kon definition), so the core starts it, keeps one copy across every replica
 * (a Postgres advisory lock) and stops it on shutdown or when the kon is switched off.
 *
 * Which to use:
 *   · DISCORD_GATEWAY=worker — this file. No second image, no agent key, no HTTP hop: the batch goes
 *     straight to `engine.ingest`. Run the API image once more with KITSUDEN_WORKERS=only (and
 *     KITSUDEN_WORKERS=off on the API) when the bot must survive API redeploys.
 *   · unset (default) — no gateway here. Run `gateway/` (Go) as before, or nothing for a bot made of
 *     slash commands and panels only. Never both: two connections deliver every event twice.
 *
 * The rules are the Go worker's, kept in step on purpose (gateway/shard.go, forwarder.go):
 *   · a missed heartbeat ACK is a zombie connection: drop it with a resumable close and resume;
 *   · close codes 4004/4010/4011/4012 are fatal (a bad token does not get better by retrying);
 *     4013/4014 wait for the next config revision; 4007/4009 start a fresh session;
 *   · IDENTIFY at most once per 5 s per `shard % max_concurrency` bucket;
 *   · the shard never blocks on the engine: a bounded buffer drops the OLDEST events when full.
 *
 * Nothing here reads the environment or the database: `runGateway` gets everything it needs, so
 * the tests drive it with a fake socket and a fake clock-free engine.
 */

import {
  GATEWAY_CONTRACT_VERSION,
  type GatewayConfig,
  type GatewayEventBatch,
  type GatewayEventEnvelope,
  type GatewayEventName,
  type GatewayIngestResult,
} from "./dc.contract";

// Gateway opcodes (https://discord.com/developers/docs/topics/opcodes-and-status-codes).
const OP = { dispatch: 0, heartbeat: 1, identify: 2, resume: 6, reconnect: 7, invalidSession: 9, hello: 10, heartbeatAck: 11 } as const;

/** Close codes after which reconnecting with the same settings cannot work. */
const FATAL_CLOSES: Record<number, string> = {
  4004: "authentication failed: check DISCORD_BOT_TOKEN",
  4010: "invalid shard",
  4011: "sharding required: set DISCORD_SHARD_COUNT or leave it 0",
  4012: "invalid API version",
};
/** Close codes only a different config fixes: wait for the next revision instead of hammering. */
const CONFIG_CLOSES: Record<number, string> = {
  4013: "invalid intents",
  4014: "disallowed intents: enable Server Members / Message Content in the Developer Portal (Bot page), or switch off the modules that need them",
};
/** Close codes after which the session cannot be resumed. */
const FRESH_SESSION_CLOSES = new Set([4007, 4009]);

/**
 * Our own closes. Discord ends the session on 1000/1001, so a close we want to RESUME after uses a
 * 4xxx code (the browser WebSocket API allows 1000 and 3000–4999 only).
 */
const CLOSE_RESUMABLE = 4000;
const CLOSE_FOR_GOOD = 1000;

/** The part of the WebSocket API this file uses: the global one in Node 22+ and Bun. */
export interface GatewaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", fn: () => void): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: (e: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", fn: (e: unknown) => void): void;
}
export type SocketFactory = (url: string) => GatewaySocket;

export interface GatewayLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface GatewayOptions {
  token: string;
  /** `https://discord.com/api/v10` (DISCORD_API_BASE). */
  apiBase: string;
  /** What to identify with and forward: the engine's `gatewayConfig`. */
  config(): Promise<GatewayConfig>;
  /** Where batches go: the engine's `ingest`. */
  ingest(batch: GatewayEventBatch): Promise<GatewayIngestResult>;
  logger: GatewayLogger;
  /** 0 = what Discord recommends (DISCORD_SHARD_COUNT). */
  shardCount?: number;
  /** Only these shards, for several workers (DISCORD_SHARD_IDS); empty = all. */
  shardIds?: number[];
  configEveryMs?: number;
  batchMax?: number;
  batchIntervalMs?: number;
  bufferSize?: number;
  /** Tests inject these. Discord's own rules are the defaults: 5 s between IDENTIFYs, 1 s first reconnect. */
  identifyIntervalMs?: number;
  reconnectMs?: number;
  socket?: SocketFactory;
  fetch?: typeof fetch;
  random?: () => number;
}

interface Inbound {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

class FatalError extends Error {}
class BlockedError extends Error {}

/** One IDENTIFY per 5 s per bucket, where bucket = shard id % max_concurrency. */
export class IdentifyGate {
  private chains = new Map<number, Promise<void>>();
  private last = new Map<number, number>();
  constructor(
    private readonly concurrency: number,
    private readonly intervalMs = 5000
  ) {}

  wait(shard: number, signal: AbortSignal): Promise<void> {
    const key = shard % Math.max(1, this.concurrency);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(async () => {
      const wait = (this.last.get(key) ?? -Infinity) + this.intervalMs - Date.now();
      if (wait > 0) await sleep(wait, signal);
      this.last.set(key, Date.now());
    });
    this.chains.set(key, next.catch(() => undefined));
    return next;
  }
}

/**
 * Batches events for the engine. Shards push and never wait; when the engine fails long enough to
 * fill the buffer, the OLDEST events are dropped and counted: a stale "someone sent a message" is
 * worth less than a gateway session lost to missed heartbeats.
 */
export class Forwarder {
  forwarded = 0;
  dropped = 0;
  filtered = 0;
  private buf: GatewayEventEnvelope[] = [];
  private events = new Set<string>();
  private wake: (() => void) | null = null;

  constructor(
    private readonly ingest: GatewayOptions["ingest"],
    private readonly logger: GatewayLogger,
    private readonly max: number,
    private readonly capacity: number,
    private readonly intervalMs: number
  ) {}

  setEvents(events: readonly string[]): void {
    this.events = new Set(events);
  }

  push(e: GatewayEventEnvelope): void {
    if (!this.events.has(e.t)) {
      this.filtered++;
      return;
    }
    if (this.buf.length >= this.capacity) {
      this.buf.shift();
      this.dropped++;
    }
    this.buf.push(e);
    if (this.buf.length >= this.max) this.wake?.();
  }

  /** Sends until the signal aborts, backing off while the engine fails. */
  async run(signal: AbortSignal): Promise<void> {
    let backoff = 0;
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, this.intervalMs);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        this.wake = done;
        signal.addEventListener("abort", done, { once: true });
      });
      this.wake = null;
      if (signal.aborted) return;
      if (backoff > 0) await sleep(backoff, signal);
      while (!signal.aborted && this.buf.length > 0) {
        const batch = this.buf.splice(0, this.max);
        try {
          const res = await this.ingest({ contract: GATEWAY_CONTRACT_VERSION, events: batch });
          backoff = 0;
          this.forwarded += res.accepted;
          this.dropped += res.dropped;
          if (res.dropped > 0) this.logger.warn("Discord gateway: the engine's queue is full; it dropped events", { dropped: res.dropped });
        } catch (err) {
          this.giveBack(batch);
          backoff = Math.min(Math.max(backoff * 2, 500), 30_000);
          this.logger.warn("Discord gateway: the engine failed a batch; will retry", { events: batch.length, retryInMs: backoff, message: messageOf(err) });
          break;
        }
      }
    }
  }

  /** A failed batch goes back to the front, within capacity. */
  private giveBack(batch: GatewayEventEnvelope[]): void {
    const room = this.capacity - this.buf.length;
    if (room <= 0) {
      this.dropped += batch.length;
      return;
    }
    if (batch.length > room) {
      this.dropped += batch.length - room;
      batch = batch.slice(batch.length - room);
    }
    this.buf = [...batch, ...this.buf];
  }

  get pending(): number {
    return this.buf.length;
  }
}

/** One gateway connection. It resumes when it can and identifies again when it must. */
export class Shard {
  ready = false;
  reconnects = 0;
  problem: string | null = null;
  fatal = false;

  private intents: number;
  private sessionId = "";
  private resumeUrl = "";
  private seq = -1;
  private reidentify: (() => void) | null = null;
  private wantsReidentify = false;

  constructor(
    readonly id: number,
    readonly count: number,
    private readonly o: {
      token: string;
      gatewayUrl: string;
      intents: number;
      forwarder: Forwarder;
      gate: IdentifyGate;
      logger: GatewayLogger;
      socket: SocketFactory;
      random: () => number;
      reconnectMs: number;
    }
  ) {
    this.intents = o.intents;
  }

  /** New intents end the session on purpose: intents are fixed per session. */
  setIntents(intents: number): void {
    if (intents === this.intents && this.problem === null) return;
    this.intents = intents;
    this.wantsReidentify = true;
    this.reidentify?.();
  }

  private resetSession(): void {
    this.sessionId = "";
    this.resumeUrl = "";
    this.seq = -1;
  }

  /** Keeps the shard connected until the signal aborts or a fatal close. */
  async run(signal: AbortSignal): Promise<void> {
    const first = this.o.reconnectMs;
    let backoff = first;
    while (!signal.aborted) {
      const start = Date.now();
      let err: unknown;
      try {
        await this.connect(signal);
      } catch (e) {
        err = e;
      }
      this.ready = false;
      if (signal.aborted) return;
      if (err instanceof FatalError) {
        this.problem = err.message;
        this.fatal = true;
        this.o.logger.error("Discord gateway closed for good", { shard: this.id, reason: err.message });
        return;
      }
      if (err instanceof BlockedError) {
        this.problem = err.message;
        this.resetSession();
        this.o.logger.error("Discord gateway refused the intents; waiting for a config change", { shard: this.id, reason: err.message });
        await new Promise<void>((resolve) => {
          const done = () => {
            this.reidentify = null;
            signal.removeEventListener("abort", done);
            resolve();
          };
          this.reidentify = done;
          if (this.wantsReidentify) done();
          signal.addEventListener("abort", done, { once: true });
        });
        this.wantsReidentify = false;
        this.problem = null;
        continue;
      }
      this.reconnects++;
      if (Date.now() - start > 60_000) backoff = first;
      const wait = backoff + Math.floor(this.o.random() * (backoff / 2 + 1));
      this.o.logger.warn("Discord gateway connection ended; reconnecting", {
        shard: this.id,
        message: messageOf(err),
        inMs: wait,
        resume: this.sessionId !== "",
      });
      await sleep(wait, signal);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }

  private connect(signal: AbortSignal): Promise<void> {
    const resuming = this.sessionId !== "" && this.seq >= 0;
    const base = resuming && this.resumeUrl ? this.resumeUrl : this.o.gatewayUrl;
    const ws = this.o.socket(`${base.replace(/\/+$/, "")}/?v=10&encoding=json`);

    return new Promise<void>((resolve, reject) => {
      let heartbeat: ReturnType<typeof setTimeout> | null = null;
      let acked = true;
      let settled = false;
      let helloSeen = false;
      const send = (op: number, d: unknown) => ws.send(JSON.stringify({ op, d }));
      const sendHeartbeat = () => send(OP.heartbeat, this.seq >= 0 ? this.seq : null);

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (heartbeat) clearTimeout(heartbeat);
        this.reidentify = null;
        signal.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve();
      };
      const onAbort = () => {
        try {
          ws.close(CLOSE_FOR_GOOD, "shutting down");
        } catch {
          /* already closed */
        }
        finish();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      // Intents changed while connected: a normal close ends the session on purpose.
      this.reidentify = () => {
        this.o.logger.info("Discord gateway: intents changed; identifying again", { shard: this.id });
        this.wantsReidentify = false;
        this.resetSession();
        ws.close(CLOSE_FOR_GOOD, "re-identify");
      };

      ws.addEventListener("error", () => {
        /* a close event follows with the reason */
      });

      ws.addEventListener("close", (e) => {
        const code = e.code;
        if (FATAL_CLOSES[code]) return finish(new FatalError(`${code} ${FATAL_CLOSES[code]}`));
        if (CONFIG_CLOSES[code]) return finish(new BlockedError(`${code} ${CONFIG_CLOSES[code]}`));
        if (FRESH_SESSION_CLOSES.has(code)) this.resetSession();
        finish(new Error(`closed ${code}${e.reason ? ` ${e.reason}` : ""}`));
      });

      ws.addEventListener("message", (e) => {
        let p: Inbound;
        try {
          p = JSON.parse(typeof e.data === "string" ? e.data : String(e.data)) as Inbound;
        } catch {
          this.o.logger.warn("Discord gateway: unreadable frame", { shard: this.id });
          return;
        }
        if (typeof p.s === "number") this.seq = p.s;

        if (!helloSeen) {
          const interval = (p.d as { heartbeat_interval?: number } | null)?.heartbeat_interval;
          if (p.op !== OP.hello || typeof interval !== "number" || interval <= 0) {
            ws.close(CLOSE_RESUMABLE, "expected HELLO");
            return;
          }
          helloSeen = true;
          // Heartbeats. A missed ACK means a zombie connection: drop it resumably and resume.
          const beat = (delay: number) => {
            heartbeat = setTimeout(() => {
              if (!acked) {
                this.o.logger.warn("Discord gateway: heartbeat not acknowledged; dropping the zombie connection", { shard: this.id });
                ws.close(CLOSE_RESUMABLE, "zombie");
                return;
              }
              acked = false;
              try {
                sendHeartbeat();
              } catch {
                return;
              }
              beat(interval);
            }, delay);
          };
          beat(Math.floor(this.o.random() * interval));
          void this.hello(resuming, send, signal).catch((err) => {
            this.o.logger.warn("Discord gateway: could not identify", { shard: this.id, message: messageOf(err) });
            ws.close(CLOSE_RESUMABLE, "identify failed");
          });
          return;
        }

        switch (p.op) {
          case OP.dispatch:
            this.dispatch(p);
            break;
          case OP.heartbeat:
            sendHeartbeat();
            break;
          case OP.heartbeatAck:
            acked = true;
            break;
          case OP.reconnect:
            ws.close(CLOSE_RESUMABLE, "reconnect requested");
            break;
          case OP.invalidSession: {
            if (p.d !== true) this.resetSession();
            // Discord asks for a random 1–5 s wait before the next IDENTIFY.
            const wait = 1000 + Math.floor(this.o.random() * 4000);
            void sleep(wait, signal).then(() => ws.close(CLOSE_RESUMABLE, "invalid session"));
            break;
          }
        }
      });
    });
  }

  private async hello(resuming: boolean, send: (op: number, d: unknown) => void, signal: AbortSignal): Promise<void> {
    if (resuming) {
      send(OP.resume, { token: this.o.token, session_id: this.sessionId, seq: this.seq });
      return;
    }
    await this.o.gate.wait(this.id, signal);
    if (signal.aborted) return;
    send(OP.identify, {
      token: this.o.token,
      intents: this.intents,
      shard: [this.id, this.count],
      properties: { os: "linux", browser: "kitsuden", device: "kitsuden" },
    });
  }

  private dispatch(p: Inbound): void {
    const d = (p.d ?? {}) as Record<string, unknown>;
    if (p.t === "READY") {
      this.sessionId = typeof d.session_id === "string" ? d.session_id : "";
      this.resumeUrl = typeof d.resume_gateway_url === "string" ? d.resume_gateway_url : "";
      this.ready = true;
      this.problem = null;
      const user = d.user as { username?: string } | undefined;
      this.o.logger.info("Discord gateway ready", {
        shard: this.id,
        bot: user?.username,
        guilds: Array.isArray(d.guilds) ? d.guilds.length : 0,
        intents: this.intents,
      });
      return;
    }
    if (p.t === "RESUMED") {
      this.ready = true;
      this.o.logger.info("Discord gateway resumed", { shard: this.id });
      return;
    }
    if (typeof p.s !== "number" || !p.t) return;
    this.o.forwarder.push({
      t: p.t as GatewayEventName,
      s: p.s,
      shard: [this.id, this.count],
      receivedAt: new Date().toISOString(),
      d: trimPayload(p.t, d),
    });
  }
}

/**
 * Only what the engine stores of a server: a full GUILD_CREATE (members, channels…) can be
 * megabytes. `preferred_locale` is kept: the engine stores it as the server's language.
 */
export function trimPayload(t: string, d: Record<string, unknown>): Record<string, unknown> {
  if (t !== "GUILD_CREATE" && t !== "GUILD_UPDATE") return d;
  const out: Record<string, unknown> = { id: d.id, name: d.name };
  if (d.unavailable !== undefined) out.unavailable = d.unavailable;
  if (d.preferred_locale !== undefined) out.preferred_locale = d.preferred_locale;
  return out;
}

interface GatewayBot {
  url: string;
  shards: number;
  session_start_limit: { remaining: number; reset_after: number; max_concurrency: number };
}

async function fetchGatewayBot(o: GatewayOptions): Promise<GatewayBot> {
  const res = await (o.fetch ?? fetch)(`${o.apiBase.replace(/\/+$/, "")}/gateway/bot`, {
    headers: { Authorization: `Bot ${o.token}`, "User-Agent": "DiscordBot (https://github.com/Kitsuden/kitsuden-kons, kon-dc)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new FatalError("Discord rejected DISCORD_BOT_TOKEN");
  if (!res.ok) throw new Error(`GET /gateway/bot: HTTP ${res.status}`);
  return (await res.json()) as GatewayBot;
}

/** Retries `fn` with exponential backoff until it works, the signal aborts, or a FatalError. */
async function retry<T>(what: string, o: GatewayOptions, signal: AbortSignal, fn: () => Promise<T>): Promise<T | null> {
  let wait = 1000;
  while (!signal.aborted) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof FatalError) throw err;
      o.logger.warn(`Discord gateway: ${what} failed; retrying`, { message: messageOf(err), inMs: wait });
      await sleep(wait, signal);
      wait = Math.min(wait * 2, 60_000);
    }
  }
  return null;
}

/** What `runGateway` exposes while it runs, for the kon's status. */
export interface GatewayState {
  shards: Shard[];
  forwarder: Forwarder | null;
  problem: string | null;
}

/**
 * Runs the gateway until `signal` aborts. It never returns early on its own: a fatal problem (a bad
 * token) is logged and kept in `state.problem`, and the worker then idles until it is stopped, so
 * the core does not restart it into the same refusal every minute.
 */
export async function runGateway(o: GatewayOptions, signal: AbortSignal, state: GatewayState = { shards: [], forwarder: null, problem: null }): Promise<void> {
  const random = o.random ?? Math.random;
  const socket: SocketFactory =
    o.socket ??
    ((url) => {
      const WS = (globalThis as { WebSocket?: new (url: string) => GatewaySocket }).WebSocket;
      if (!WS) throw new FatalError("this runtime has no WebSocket (Node 22+ or Bun is needed)");
      return new WS(url);
    });

  const idle = async (problem: string) => {
    state.problem = problem;
    o.logger.error(`Discord gateway stopped: ${problem}`);
    await sleep(2 ** 31 - 1, signal);
  };

  let cfg: GatewayConfig | null;
  let gb: GatewayBot | null;
  try {
    cfg = await retry("reading the gateway config", o, signal, () => o.config());
    gb = await retry("GET /gateway/bot", o, signal, () => fetchGatewayBot(o));
  } catch (err) {
    return idle(messageOf(err));
  }
  if (!cfg || !gb || signal.aborted) return;

  if (gb.session_start_limit.remaining === 0) {
    o.logger.warn("Discord gateway: the daily session-start limit is used up; waiting", { ms: gb.session_start_limit.reset_after });
    await sleep(gb.session_start_limit.reset_after, signal);
    if (signal.aborted) return;
  }

  const count = o.shardCount && o.shardCount > 0 ? o.shardCount : Math.max(1, gb.shards);
  const ids = o.shardIds?.length ? o.shardIds : Array.from({ length: count }, (_, i) => i);
  if (ids.some((id) => id >= count)) return idle(`DISCORD_SHARD_IDS has a shard outside the shard count (${count})`);

  const forwarder = new Forwarder(o.ingest, o.logger, Math.min(Math.max(o.batchMax ?? 50, 1), 100), Math.max(o.bufferSize ?? 10_000, 100), Math.max(o.batchIntervalMs ?? 250, 50));
  forwarder.setEvents(cfg.events);
  const gate = new IdentifyGate(gb.session_start_limit.max_concurrency, o.identifyIntervalMs ?? 5000);
  const reconnectMs = o.reconnectMs ?? 1000;
  const shards = ids.map(
    (id) =>
      new Shard(id, count, { token: o.token, gatewayUrl: gb.url, intents: cfg.intents, forwarder, gate, logger: o.logger, socket, random, reconnectMs })
  );
  state.shards = shards;
  state.forwarder = forwarder;
  o.logger.info("Discord gateway starting", { shards: ids, shardCount: count, intents: cfg.intents, events: cfg.events });

  // A module switched on or off changes the intents: identify again with them.
  const poll = async () => {
    let revision = cfg.revision;
    while (!signal.aborted) {
      await sleep(Math.max(o.configEveryMs ?? 60_000, 1_000), signal);
      if (signal.aborted) return;
      try {
        const next = await o.config();
        if (next.revision === revision) continue;
        o.logger.info("Discord gateway config changed", { intents: next.intents, events: next.events });
        revision = next.revision;
        forwarder.setEvents(next.events);
        for (const s of shards) s.setIntents(next.intents);
      } catch (err) {
        o.logger.warn("Discord gateway: could not refresh the config", { message: messageOf(err) });
      }
    }
  };

  // The forwarder and the poller run until the signal aborts, so this waits for the stop even when
  // every shard closed for good (their `problem` says why).
  await Promise.all([forwarder.run(signal), poll(), ...shards.map((s) => s.run(signal))]);
}

/** `DISCORD_GATEWAY=worker` turns the worker on; anything else leaves the gateway to `gateway/` (Go) or to nobody. */
export function gatewayWorkerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.DISCORD_GATEWAY ?? "").trim().toLowerCase() === "worker";
}

/** DISCORD_SHARD_COUNT / DISCORD_SHARD_IDS, read like the Go worker reads them. Throws on a bad value. */
export function shardSettings(env: Record<string, string | undefined> = process.env): { shardCount: number; shardIds: number[] } {
  const rawCount = (env.DISCORD_SHARD_COUNT ?? "").trim();
  const shardCount = rawCount === "" ? 0 : Number(rawCount);
  if (!Number.isInteger(shardCount) || shardCount < 0) throw new Error("DISCORD_SHARD_COUNT must be a non-negative integer");
  const rawIds = (env.DISCORD_SHARD_IDS ?? "").trim();
  const shardIds = rawIds === "" ? [] : rawIds.split(",").map((p) => Number(p.trim()));
  if (shardIds.some((id) => !Number.isInteger(id) || id < 0)) throw new Error("DISCORD_SHARD_IDS must be a comma-separated list of shard numbers");
  return { shardCount, shardIds };
}

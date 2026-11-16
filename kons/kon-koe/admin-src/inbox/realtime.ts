/**
 * The core's realtime WebSocket (`/api/realtime`), for the inbox.
 *
 * Protocol (apps/api/src/lib/realtime.ts in Kitsuden): the client sends `{ type: "subscribe", channel }`,
 * `{ type: "unsubscribe", channel }` and `{ type: "ping" }`; the server sends `{ type: "message", channel,
 * data }`, `subscribed`, `pong` and `error`. The socket carries the session cookie; koe authorizes each
 * `kon:koe:*` channel (koe.realtime.ts) on subscribe and again every minute.
 *
 * What arrives is small on purpose ("conversation X changed"): the inbox re-reads through REST. So a socket
 * that cannot open (an origin the API does not list, a proxy without WebSocket) costs liveness, not
 * correctness: the inbox polls while `state` is not "live". It reconnects with exponential backoff and
 * jitter, and subscribes again to everything after each reconnect.
 */

export type LiveState = "connecting" | "live" | "offline";

export interface Frame {
  channel: string;
  data: Record<string, unknown>;
}

export class Realtime {
  private socket: WebSocket | null = null;
  private channels = new Set<string>();
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly onFrame: (f: Frame) => void,
    private readonly onState: (s: LiveState) => void
  ) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.socket?.close();
    this.socket = null;
  }

  subscribe(channel: string): void {
    if (this.channels.has(channel)) return;
    this.channels.add(channel);
    this.send({ type: "subscribe", channel });
  }

  unsubscribe(channel: string): void {
    if (!this.channels.delete(channel)) return;
    this.send({ type: "unsubscribe", channel });
  }

  /** Reconnect now (the browser came back online, the tab became visible). */
  nudge(): void {
    if (this.stopped || (this.socket && this.socket.readyState <= WebSocket.OPEN)) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.attempt = 0;
    this.open();
  }

  private send(frame: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private open(): void {
    if (this.stopped || typeof WebSocket === "undefined") {
      this.onState("offline");
      return;
    }
    this.onState(this.attempt === 0 ? "connecting" : "offline");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.retry();
      return;
    }
    this.socket = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.onState("live");
      for (const channel of this.channels) ws.send(JSON.stringify({ type: "subscribe", channel }));
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ type: "ping" }), 25_000);
    };
    ws.onmessage = (ev) => {
      let frame: { type?: string; channel?: string; data?: unknown };
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (frame.type === "message" && typeof frame.channel === "string" && frame.data && typeof frame.data === "object") {
        this.onFrame({ channel: frame.channel, data: frame.data as Record<string, unknown> });
      }
    };
    ws.onclose = () => {
      if (this.socket === ws) this.socket = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.retry();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private retry(): void {
    if (this.stopped) return;
    this.onState("offline");
    this.attempt++;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5)) + Math.random() * 1000;
    this.retryTimer = setTimeout(() => this.open(), delay);
  }
}

/** `/api/koe` → `ws(s)://<host>/api/realtime`: the core's socket next to the kon's mount. */
export function realtimeUrl(koeBase: string): string {
  const u = new URL(koeBase.replace(/\/+$/, ""), window.location.href);
  u.pathname = u.pathname.replace(/\/[^/]+$/, "/realtime");
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.search = "";
  u.hash = "";
  return u.href;
}

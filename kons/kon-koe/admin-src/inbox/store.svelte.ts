/**
 * The inbox's state: who I am, the list and its filters, the open conversation, notices, and the live
 * connection that keeps them fresh.
 *
 * Everything shown is read through koe's REST operations, which apply row-level security: the realtime
 * frames only say "this changed" (koe.realtime.ts), and the store re-reads. Without a socket (or while it
 * reconnects) it polls: the open thread every few seconds, the list a little slower.
 */

import { ApiError, createApi, seg, type Api } from "../api";
import type {
  Channel,
  Conversation,
  ConversationEvent,
  Counts,
  Me,
  Member,
  Message,
  MessageStatus,
  Note,
  Notice,
  Team,
  WindowDetail,
} from "../types";
import { Realtime, realtimeUrl, type Frame, type LiveState } from "./realtime";

export type Filter = "mine" | "unassigned" | "queued" | "bot" | "snoozed" | "open" | "resolved";
export const FILTERS: Filter[] = ["mine", "unassigned", "queued", "bot", "snoozed", "open", "resolved"];

const FILTER_QUERY: Record<Filter, Record<string, string>> = {
  mine: { state: "open", assignee: "me" },
  unassigned: { state: "open", assignee: "none" },
  queued: { state: "queued" },
  bot: { state: "bot" },
  snoozed: { state: "snoozed" },
  open: { state: "open" },
  resolved: { state: "resolved" },
};

/** Which counter (GET /conversations/counts) goes with each filter. */
export const FILTER_COUNT: Partial<Record<Filter, keyof Counts>> = { mine: "mine", unassigned: "unassigned", queued: "queued", bot: "bot", snoozed: "snoozed" };

export type Auth = "loading" | "ok" | "signed-out" | "not-member" | "error";
export type Load = "loading" | "ready" | "error";

export type TimelineItem =
  | { type: "message"; at: string; id: string; message: Message; reactions: string[] }
  | { type: "note"; at: string; id: string; note: Note }
  | { type: "event"; at: string; id: string; event: ConversationEvent };

/** The emoji of a reaction message and the message it is about. */
export function reactionOf(m: Message): { target: string | null; emoji: string } | null {
  if (m.kind !== "reaction") return null;
  const r = (m.payload?.reaction ?? {}) as { messageId?: string; emoji?: string };
  const emoji = String(r.emoji ?? m.payload?.emoji ?? m.body ?? "");
  return { target: m.replyToId ?? r.messageId ?? null, emoji };
}

/** Messages, notes and history in one line of time; reactions ride on the message they react to. */
export function timeline(messages: Message[], notes: Note[], events: ConversationEvent[], history: boolean): TimelineItem[] {
  const reactions = new Map<string, string[]>();
  for (const m of messages) {
    const r = reactionOf(m);
    if (r?.target && r.emoji) reactions.set(r.target, [...(reactions.get(r.target) ?? []), r.emoji]);
  }
  const items: TimelineItem[] = [];
  for (const m of messages) {
    if (m.kind === "reaction") continue;
    items.push({ type: "message", at: m.createdAt, id: m.id, message: m, reactions: reactions.get(m.id) ?? [] });
  }
  for (const n of notes) items.push({ type: "note", at: n.createdAt, id: `note-${n.id}`, note: n });
  if (history) for (const e of events) items.push({ type: "event", at: e.createdAt, id: `event-${e.id}`, event: e });
  // Before the first loaded message, notes and events belong to the earlier pages.
  const first = messages[0]?.createdAt;
  return items.filter((i) => i.type === "message" || !first || i.at >= first).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function debounce(fn: () => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn();
    }, ms);
  };
}

const PAGE = 50;

export class Inbox {
  readonly api: Api;

  auth = $state<Auth>("loading");
  authError = $state("");
  me = $state<Me | null>(null);
  available = $state(true);
  members = $state<Member[]>([]);
  teams = $state<Team[]>([]);
  channels = $state<Channel[]>([]);
  counts = $state<Counts>({});
  copilot = $state(false);

  filter = $state<Filter>("mine");
  teamId = $state("");
  channelId = $state("");
  label = $state("");
  q = $state("");
  list = $state<Conversation[]>([]);
  next = $state<string | null>(null);
  listLoad = $state<Load>("loading");
  listError = $state("");
  loadingMore = $state(false);

  openId = $state<string | null>(null);
  current = $state<Conversation | null>(null);
  messages = $state<Message[]>([]);
  hasEarlier = $state(false);
  notes = $state<Note[]>([]);
  events = $state<ConversationEvent[]>([]);
  window = $state<WindowDetail | null>(null);
  threadLoad = $state<Load>("loading");
  threadError = $state("");
  typing = $state<{ userId: string; at: number } | null>(null);

  notices = $state<Notice[]>([]);
  live = $state<LiveState>("connecting");
  now = $state(Date.now());

  /** Set by the view: a notice or an assignment arrived live. */
  onNotice: ((n: { title: string; conversationId: string | null }) => void) | null = null;

  private realtime: Realtime | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private listTurn = 0;
  private threadTurn = 0;
  private lastListAt = 0;
  private lastThreadAt = 0;
  private lastReadAt = 0;
  private cleanups: Array<() => void> = [];

  readonly base: string;

  constructor(base: string) {
    this.base = base;
    this.api = createApi(() => this.base);
  }

  // ── Start and stop ──────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.auth = "loading";
    try {
      this.me = (await this.api.get<{ data: Me }>("me")).data;
      this.available = this.me.member?.available ?? true;
      this.auth = "ok";
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) this.auth = "signed-out";
      else if (e instanceof ApiError && e.status === 403) this.auth = "not-member";
      else {
        this.auth = "error";
        this.authError = e instanceof Error ? e.message : String(e);
      }
      return;
    }

    void this.loadDirectory();
    void this.loadList();
    void this.loadCounts();
    void this.loadNotices();
    void this.heartbeat();

    this.realtime = new Realtime(
      realtimeUrl(this.base),
      (f) => this.onFrame(f),
      (s) => (this.live = s)
    );
    this.realtime.subscribe("kon:koe:inbox");
    this.realtime.subscribe(`kon:koe:user:${this.me.userId}`);
    this.realtime.start();

    this.timers.push(setInterval(() => void this.heartbeat(), 30_000));
    this.timers.push(setInterval(() => this.poll(), 5_000));
    this.timers.push(setInterval(() => (this.now = Date.now()), 30_000));
    this.timers.push(
      setInterval(() => {
        if (this.typing && Date.now() - this.typing.at > 6_000) this.typing = null;
      }, 2_000)
    );

    const visible = () => {
      if (document.visibilityState !== "visible") return;
      this.realtime?.nudge();
      this.refreshList();
      if (this.openId) void this.refreshThread();
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", visible);
    this.cleanups.push(() => document.removeEventListener("visibilitychange", visible));
    this.cleanups.push(() => window.removeEventListener("online", visible));
  }

  stop(): void {
    this.realtime?.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const c of this.cleanups) c();
    this.cleanups = [];
  }

  private async loadDirectory(): Promise<void> {
    const [members, teams, channels] = await Promise.all([
      this.api.get<{ data?: Member[] }>("members").catch(() => ({ data: [] as Member[] })),
      this.api.get<{ data?: Team[] }>("teams").catch(() => ({ data: [] as Team[] })),
      this.api.get<{ data?: Channel[] }>("channels").catch(() => ({ data: [] as Channel[] })),
    ]);
    this.members = members.data ?? [];
    this.teams = teams.data ?? [];
    this.channels = channels.data ?? [];
    try {
      const c = await this.api.get<{ data?: { enabled?: boolean } }>("config/copilot");
      this.copilot = !!c.data?.enabled;
    } catch {
      this.copilot = false;
    }
  }

  // ── Who is who ──────────────────────────────────────────────────────────

  nameOf(userId: string | null | undefined): string {
    if (!userId) return "";
    return this.members.find((m) => m.userId === userId)?.displayName ?? (userId === this.me?.userId ? this.me?.member?.displayName ?? "You" : userId);
  }

  channelOf(id: string | null | undefined): Channel | undefined {
    return this.channels.find((c) => c.id === id);
  }

  teamName(id: string | null | undefined): string {
    return this.teams.find((t) => t.id === id)?.name ?? "";
  }

  /** The channel can hand a conversation back to a bot. */
  hasBot(channelId: string | null | undefined): boolean {
    const c = this.channelOf(channelId);
    return !!c && (!!c.botSlug || !!c.settings?.flowId);
  }

  // ── The list ────────────────────────────────────────────────────────────

  private query(): Record<string, string | number> {
    return {
      ...FILTER_QUERY[this.filter],
      ...(this.teamId ? { teamId: this.teamId } : {}),
      ...(this.channelId ? { channelId: this.channelId } : {}),
      ...(this.label.trim() ? { label: this.label.trim() } : {}),
      ...(this.q.trim() ? { q: this.q.trim() } : {}),
      limit: 30,
    };
  }

  async loadList(): Promise<void> {
    const turn = ++this.listTurn;
    if (!this.list.length) this.listLoad = "loading";
    try {
      const res = await this.api.get<{ data: Conversation[]; next: string | null }>("conversations", this.query());
      if (turn !== this.listTurn) return;
      this.list = res.data ?? [];
      this.next = res.next;
      this.listLoad = "ready";
      this.lastListAt = Date.now();
    } catch (e) {
      if (turn !== this.listTurn) return;
      this.listLoad = "error";
      this.listError = e instanceof Error ? e.message : String(e);
    }
  }

  async loadMore(): Promise<void> {
    if (!this.next || this.loadingMore) return;
    this.loadingMore = true;
    try {
      const res = await this.api.get<{ data: Conversation[]; next: string | null }>("conversations", { ...this.query(), before: this.next });
      const known = new Set(this.list.map((c) => c.id));
      this.list = [...this.list, ...(res.data ?? []).filter((c) => !known.has(c.id))];
      this.next = res.next;
    } finally {
      this.loadingMore = false;
    }
  }

  async loadCounts(): Promise<void> {
    try {
      this.counts = (await this.api.get<{ data: Counts }>("conversations/counts")).data ?? {};
    } catch {
      /* the counters keep their last value */
    }
  }

  /** Filters changed: the list starts over. */
  setFilter(f: Filter): void {
    this.filter = f;
    this.list = [];
    void this.loadList();
  }

  refreshList = debounce(() => {
    void this.loadList();
    void this.loadCounts();
  }, 400);

  // ── The open conversation ───────────────────────────────────────────────

  async open(id: string | null): Promise<void> {
    if (id === this.openId) return;
    if (this.openId) this.realtime?.unsubscribe(`kon:koe:conversation:${this.openId}`);
    this.openId = id;
    this.current = id ? this.list.find((c) => c.id === id) ?? null : null;
    this.messages = [];
    this.notes = [];
    this.events = [];
    this.window = null;
    this.typing = null;
    this.hasEarlier = false;
    if (!id) return;
    this.threadLoad = "loading";
    this.realtime?.subscribe(`kon:koe:conversation:${id}`);
    await this.loadThread();
    void this.markRead();
  }

  async loadThread(): Promise<void> {
    const id = this.openId;
    if (!id) return;
    const turn = ++this.threadTurn;
    try {
      const [conv, msgs, notes, events, win] = await Promise.all([
        this.api.get<{ data: Conversation }>(`conversations/${seg(id)}`),
        this.api.get<{ data: Message[] }>(`conversations/${seg(id)}/messages`, { limit: PAGE }),
        this.api.get<{ data: Note[] }>(`conversations/${seg(id)}/notes`),
        this.api.get<{ data: ConversationEvent[] }>(`conversations/${seg(id)}/events`),
        this.api.get<{ data: WindowDetail }>(`conversations/${seg(id)}/window`).catch(() => ({ data: null })),
      ]);
      if (turn !== this.threadTurn || id !== this.openId) return;
      this.current = conv.data;
      this.messages = msgs.data ?? [];
      this.hasEarlier = (msgs.data ?? []).length === PAGE;
      this.notes = notes.data ?? [];
      this.events = events.data ?? [];
      this.window = win.data;
      this.threadLoad = "ready";
      this.lastThreadAt = Date.now();
    } catch (e) {
      if (turn !== this.threadTurn || id !== this.openId) return;
      this.threadLoad = "error";
      this.threadError = e instanceof Error ? e.message : String(e);
    }
  }

  /** New messages and statuses: the latest page, merged by id, keeping earlier pages already loaded. */
  async refreshMessages(): Promise<void> {
    const id = this.openId;
    if (!id) return;
    try {
      const latest = (await this.api.get<{ data: Message[] }>(`conversations/${seg(id)}/messages`, { limit: PAGE })).data ?? [];
      if (id !== this.openId) return;
      this.mergeMessages(latest);
      this.lastThreadAt = Date.now();
    } catch {
      /* the next event or poll tries again */
    }
  }

  private mergeMessages(rows: Message[]): void {
    const byId = new Map(this.messages.map((m) => [m.id, m]));
    for (const m of rows) byId.set(m.id, m);
    this.messages = [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async refreshConversation(): Promise<void> {
    const id = this.openId;
    if (!id) return;
    try {
      const [conv, win] = await Promise.all([
        this.api.get<{ data: Conversation }>(`conversations/${seg(id)}`),
        this.api.get<{ data: WindowDetail }>(`conversations/${seg(id)}/window`).catch(() => ({ data: this.window })),
      ]);
      if (id !== this.openId) return;
      this.current = conv.data;
      this.window = win.data;
    } catch (e) {
      // Reassigned away from me: it is no longer mine to see.
      if (e instanceof ApiError && e.status === 404 && id === this.openId) {
        this.threadLoad = "error";
        this.threadError = e.message;
      }
    }
  }

  async loadEvents(): Promise<void> {
    const id = this.openId;
    if (!id) return;
    const events = (await this.api.get<{ data: ConversationEvent[] }>(`conversations/${seg(id)}/events`).catch(() => null))?.data;
    if (events && id === this.openId) this.events = events;
  }

  async loadNotes(): Promise<void> {
    const id = this.openId;
    if (!id) return;
    const notes = (await this.api.get<{ data: Note[] }>(`conversations/${seg(id)}/notes`).catch(() => null))?.data;
    if (notes && id === this.openId) this.notes = notes;
  }

  async refreshThread(): Promise<void> {
    await Promise.all([this.refreshMessages(), this.refreshConversation(), this.loadNotes(), this.loadEvents()]);
  }

  async loadEarlier(): Promise<void> {
    const id = this.openId;
    const first = this.messages[0]?.createdAt;
    if (!id || !first) return;
    const older = (await this.api.get<{ data: Message[] }>(`conversations/${seg(id)}/messages`, { limit: PAGE, before: first })).data ?? [];
    if (id !== this.openId) return;
    this.hasEarlier = older.length === PAGE;
    this.mergeMessages(older);
  }

  async markRead(): Promise<void> {
    const id = this.openId;
    if (!id || document.visibilityState !== "visible") return;
    const conv = this.current ?? this.list.find((c) => c.id === id);
    if (conv && !conv.unreadCount && Date.now() - this.lastReadAt < 30_000) return;
    this.lastReadAt = Date.now();
    this.list = this.list.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c));
    if (this.current?.id === id) this.current = { ...this.current, unreadCount: 0 };
    await this.api.post(`conversations/${seg(id)}/read`, {}).catch(() => {});
    void this.loadCounts();
  }

  // ── Doing things ────────────────────────────────────────────────────────

  /** take, assign, release, return-to-bot, snooze, resolve, transfer: the answer is the conversation row. */
  async act(action: "take" | "assign" | "release" | "return-to-bot" | "snooze" | "resolve" | "transfer", body: Record<string, unknown> = {}): Promise<void> {
    const id = this.openId;
    if (!id) return;
    const res = await this.api.post<{ data: Partial<Conversation> }>(`conversations/${seg(id)}/${action}`, body);
    if (this.current?.id === id) this.current = { ...this.current, ...res.data, contact: this.current.contact, channel: this.current.channel, window: this.current.window };
    this.refreshList();
    void this.loadEvents();
  }

  async send(body: Record<string, unknown>): Promise<Message> {
    const id = this.openId!;
    const res = await this.api.post<{ data: Message }>(`conversations/${seg(id)}/messages`, body);
    if (id === this.openId) this.mergeMessages([{ ...res.data, media: res.data.media ?? null }]);
    return res.data;
  }

  async addNote(body: string, mentions: string[]): Promise<void> {
    const id = this.openId!;
    const res = await this.api.post<{ data: Note }>(`conversations/${seg(id)}/notes`, { body, ...(mentions.length ? { mentions } : {}) });
    if (id === this.openId && !this.notes.some((n) => n.id === res.data.id)) this.notes = [...this.notes, res.data];
  }

  async update(patch: { labels?: string[]; priority?: Conversation["priority"] }): Promise<void> {
    const id = this.openId!;
    const res = await this.api.patch<{ data: Partial<Conversation> }>(`conversations/${seg(id)}`, patch);
    if (this.current?.id === id) this.current = { ...this.current, ...res.data, contact: this.current.contact, channel: this.current.channel, window: this.current.window };
    this.list = this.list.map((c) => (c.id === id ? { ...c, ...patch } : c));
  }

  private typingSentAt = 0;
  /** Tells the others I am writing (the collision warning), at most every 4 seconds. */
  typingNow(): void {
    const id = this.openId;
    if (!id || Date.now() - this.typingSentAt < 4_000) return;
    this.typingSentAt = Date.now();
    void this.api.post(`conversations/${seg(id)}/typing`, {}).catch(() => {});
  }

  async heartbeat(available?: boolean): Promise<void> {
    if (available !== undefined) this.available = available;
    try {
      await this.api.post("me/heartbeat", available === undefined ? {} : { available });
    } catch (e) {
      if (available !== undefined) {
        this.available = !available;
        throw e;
      }
    }
  }

  // ── Notices ─────────────────────────────────────────────────────────────

  async loadNotices(): Promise<void> {
    try {
      this.notices = (await this.api.get<{ data: Notice[] }>("notices", { limit: 30 })).data ?? [];
    } catch {
      /* keep */
    }
  }

  get unreadNotices(): number {
    return this.notices.filter((n) => !n.readAt).length;
  }

  async readNotices(ids?: string[]): Promise<void> {
    const at = new Date().toISOString();
    this.notices = this.notices.map((n) => (!ids || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? at } : n));
    await this.api.post("notices/read", ids ? { ids } : {}).catch(() => {});
  }

  // ── Live ────────────────────────────────────────────────────────────────

  private refreshMessagesSoon = debounce(() => void this.refreshMessages(), 150);
  private refreshConversationSoon = debounce(() => {
    void this.refreshConversation();
    void this.loadEvents();
  }, 250);

  private onFrame(f: Frame): void {
    const d = f.data;
    if (f.channel === "kon:koe:inbox") {
      this.refreshList();
      if (d.id && d.id === this.openId) this.refreshConversationSoon();
      return;
    }
    if (this.me && f.channel === `kon:koe:user:${this.me.userId}`) {
      if (d.type === "notice") {
        void this.loadNotices();
        this.onNotice?.({ title: String(d.title ?? ""), conversationId: (d.conversationId as string | null) ?? null });
      } else if (d.type === "assigned") {
        this.refreshList();
      }
      return;
    }
    if (this.openId && f.channel === `kon:koe:conversation:${this.openId}`) {
      switch (d.type) {
        case "message":
          this.refreshMessagesSoon();
          if (d.direction === "in") {
            this.refreshConversationSoon();
            setTimeout(() => void this.markRead(), 500);
          }
          break;
        case "status": {
          const status = d.status as MessageStatus;
          this.messages = this.messages.map((m) => (m.id === d.messageId ? { ...m, status } : m));
          if (status === "failed" || !this.messages.some((m) => m.id === d.messageId)) this.refreshMessagesSoon();
          break;
        }
        case "seen":
          this.refreshMessagesSoon();
          break;
        case "typing":
          if (d.userId && d.userId !== this.me?.userId) this.typing = { userId: String(d.userId), at: Date.now() };
          break;
        case "note":
          void this.loadNotes();
          break;
        case "conversation":
          this.refreshConversationSoon();
          break;
      }
    }
  }

  /** The floor under the socket: poll what is on screen while it is not live, slowly while it is. */
  private poll(): void {
    if (this.auth !== "ok") return;
    const hidden = document.visibilityState !== "visible";
    const live = this.live === "live";
    const listEvery = hidden ? 120_000 : live ? 60_000 : 15_000;
    const threadEvery = hidden ? 120_000 : live ? 60_000 : 5_000;
    if (Date.now() - this.lastListAt >= listEvery) {
      this.lastListAt = Date.now();
      void this.loadList();
      void this.loadCounts();
    }
    if (this.openId && Date.now() - this.lastThreadAt >= threadEvery) {
      this.lastThreadAt = Date.now();
      void this.refreshMessages();
      void this.refreshConversation();
    }
  }
}

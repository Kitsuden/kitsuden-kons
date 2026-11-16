/**
 * Discord — REST client, request signatures and settings
 * ============================================================================
 *
 * Plain `fetch`: no Discord library and no WebSocket in the API process. The only long-lived
 * connection (the gateway) belongs to the Go worker in gateway/.
 *
 * Settings are read from the environment on each use, so a test or an operator can change them
 * without restarting:
 *
 *   DISCORD_APPLICATION_ID    the application (Developer Portal → General Information)
 *   DISCORD_PUBLIC_KEY        hex Ed25519 key that signs interactions (same page)
 *   DISCORD_BOT_TOKEN         the bot token: registers slash commands and acts (roles, messages)
 *   DISCORD_DISABLED_MODULES  comma-separated module ids switched off for the whole installation
 *   DISCORD_API_BASE          optional, for tests (default https://discord.com/api/v10)
 *
 * And for blueprints that call other kons (`kon_call`, select options and autocomplete fed by a kon,
 * panel data):
 *
 *   DISCORD_KITSUDEN_API_URL    this Kitsuden's API origin as the API sees it (http://kitsuden_api:3000)
 *   DISCORD_KITSUDEN_API_TOKEN  the BOT'S agent key. Its scopes are everything a server can reach in
 *                               other kons (e.g. `kon:broadcast:scoreboard`): give it the least.
 */

export interface DiscordSettings {
  applicationId: string | null;
  publicKey: string | null;
  botToken: string | null;
  disabledModules: Set<string>;
  apiBase: string;
  kitsudenApiUrl?: string | null;
  kitsudenApiToken?: string | null;
  /** The member page's Discord login (OAuth2, `identify` only). */
  clientSecret?: string | null;
  oauthRedirectUrl?: string | null;
  /** Signs members' sessions; at least 32 characters. */
  memberSecret?: string | null;
  /** Modules only servers with the premium plan can switch on (DISCORD_PREMIUM_MODULES). */
  premiumModules?: Set<string>;
  /** Blueprints a free server can have on at once (DISCORD_FREE_BLUEPRINTS; null = no limit). */
  freeBlueprints?: number | null;
}

export function discordSettings(env: Record<string, string | undefined> = process.env): DiscordSettings {
  const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
  return {
    applicationId: clean(env.DISCORD_APPLICATION_ID),
    publicKey: clean(env.DISCORD_PUBLIC_KEY),
    botToken: clean(env.DISCORD_BOT_TOKEN),
    disabledModules: new Set(
      (env.DISCORD_DISABLED_MODULES ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    ),
    apiBase: clean(env.DISCORD_API_BASE) ?? "https://discord.com/api/v10",
    kitsudenApiUrl: clean(env.DISCORD_KITSUDEN_API_URL)?.replace(/\/+$/, "") ?? null,
    kitsudenApiToken: clean(env.DISCORD_KITSUDEN_API_TOKEN),
    clientSecret: clean(env.DISCORD_CLIENT_SECRET),
    oauthRedirectUrl: clean(env.DISCORD_OAUTH_REDIRECT_URL),
    memberSecret: clean(env.DISCORD_MEMBER_SECRET),
    premiumModules: new Set(
      (env.DISCORD_PREMIUM_MODULES ?? "")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
    ),
    freeBlueprints: clean(env.DISCORD_FREE_BLUEPRINTS) !== null && Number.isInteger(Number(env.DISCORD_FREE_BLUEPRINTS)) ? Number(env.DISCORD_FREE_BLUEPRINTS) : null,
  };
}

// ── Interaction signatures ─────────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Interactions older than this are refused even with a valid signature (replays). */
const MAX_SKEW_SECONDS = 5 * 60;

const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * Verifies `X-Signature-Ed25519` over `timestamp + body`, as Discord requires. Discord sends a
 * request with a bad signature on purpose when the endpoint is saved, and expects a 401 for it.
 */
export async function verifyInteraction(
  publicKeyHex: string,
  signatureHex: string | undefined,
  timestamp: string | undefined,
  rawBody: string,
  now: number = Date.now()
): Promise<boolean> {
  if (!signatureHex || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > MAX_SKEW_SECONDS) return false;
  const signature = hexToBytes(signatureHex);
  const publicKey = hexToBytes(publicKeyHex);
  if (!signature || signature.length !== 64 || !publicKey || publicKey.length !== 32) return false;

  let key = keyCache.get(publicKeyHex);
  if (!key) {
    key = crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    keyCache.set(publicKeyHex, key);
  }
  try {
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      await key,
      signature,
      new TextEncoder().encode(timestamp + rawBody)
    );
  } catch {
    keyCache.delete(publicKeyHex);
    return false;
  }
}

// ── REST ───────────────────────────────────────────────────────────────────────────────────────

export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    readonly route: string,
    readonly body: string
  ) {
    super(`Discord answered ${status} on ${route}`);
  }
}

/** A message as Discord takes it: text, embeds and component rows already rendered. */
export interface MessagePayload {
  content?: string;
  embeds?: Array<Record<string, unknown>>;
  components?: Array<Record<string, unknown>>;
  /** A Discord poll (https://discord.com/developers/docs/resources/poll). */
  poll?: Record<string, unknown>;
  /** Files sent with the message (a rank card); an embed shows one with `attachment://<name>`. */
  files?: DiscordFile[];
}

/** A file attached to a message. */
export interface DiscordFile {
  /** `card.png`: letters, digits, `.`, `_` and `-`. */
  name: string;
  data: Uint8Array;
  contentType: string;
}

/** A member as the moderation, role and card steps need it. */
export interface MemberInfo {
  roles: string[];
  nick: string | null;
  /** The account behind the member (name and avatar for cards). */
  user?: { id: string; name: string; avatar: string | null } | null;
  /** A server-specific avatar, when the member set one. */
  avatar?: string | null;
}

/** A channel to create or change. */
export interface ChannelSpec {
  name: string;
  type: number;
  parentId?: string | null;
  userLimit?: number;
  /** Seconds between two messages of a member (slowmode), 0-21600. */
  slowmode?: number;
  overwrites?: Array<{ id: string; type: 0 | 1; allow: string; deny: string }>;
}

/** A thread to open: on a message, or on its own (public or private). */
export interface ThreadSpec {
  name: string;
  messageId?: string;
  private?: boolean;
  autoArchiveMinutes?: number;
}

export interface DiscordRest {
  syncGuildCommands(guildId: string, commands: SlashCommandPayload[]): Promise<unknown[]>;
  /** Posts a message; gives back its id. A plain string is a message with only text. */
  sendMessage(channelId: string, message: string | MessagePayload): Promise<{ id: string | null }>;
  /** Replaces a message the bot posted (live panels). */
  editMessage(channelId: string, messageId: string, message: MessagePayload): Promise<void>;
  addRole(guildId: string, userId: string, roleId: string): Promise<void>;
  removeRole(guildId: string, userId: string, roleId: string): Promise<void>;
  /**
   * Edits the deferred answer of an interaction, or the message a deferred button was on (no bot
   * token needed: the interaction token is the key).
   */
  editOriginal(interactionToken: string, message: string | MessagePayload): Promise<void>;
  /** A new message after the answer (only the member sees it when `ephemeral`). */
  followup(interactionToken: string, content: string, ephemeral: boolean): Promise<void>;
  /** The DM channel with a member (Discord gives the same one each time). */
  openDm(userId: string): Promise<string>;
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  pinMessage(channelId: string, messageId: string, pinned: boolean): Promise<void>;
  /** `emoji` is a unicode emoji or `name:id`. */
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  getMember(guildId: string, userId: string): Promise<MemberInfo>;
  /** Nickname (null resets it) and timeout (`communicationDisabledUntil`, null lifts it). */
  editMember(
    guildId: string,
    userId: string,
    changes: { nick?: string | null; communicationDisabledUntil?: string | null },
    reason?: string
  ): Promise<void>;
  kick(guildId: string, userId: string, reason?: string): Promise<void>;
  ban(guildId: string, userId: string, reason?: string, deleteMessageSeconds?: number): Promise<void>;
  createThread(channelId: string, spec: ThreadSpec): Promise<{ id: string }>;
  addThreadMember(threadId: string, userId: string): Promise<void>;
  /** Archive and lock (or reopen) a thread. */
  setThreadState(threadId: string, state: { archived: boolean; locked?: boolean }): Promise<void>;
  /** The latest messages of a channel (ids and author ids), newest first. */
  recentMessages(channelId: string, limit: number): Promise<Array<{ id: string; authorId: string | null; timestamp: string; pinned?: boolean }>>;
  /** Deletes 2–100 messages younger than 14 days at once (one alone is a plain delete). */
  bulkDelete(channelId: string, messageIds: string[]): Promise<void>;
  /** A channel in a server (type 2 voice, 0 text, 4 category); gives its id. */
  createChannel(guildId: string, spec: ChannelSpec): Promise<{ id: string }>;
  editChannel(channelId: string, changes: Partial<Omit<ChannelSpec, "type">>): Promise<void>;
  deleteChannel(channelId: string): Promise<void>;
  /** Moves a member to a voice channel (null disconnects them). */
  moveMember(guildId: string, userId: string, channelId: string | null): Promise<void>;
  /** Allows or denies permissions for a role (type 0) or a member (type 1) in a channel. */
  setChannelPermission(channelId: string, targetId: string, type: 0 | 1, allow: string, deny: string): Promise<void>;
  /** The server's roles (the @everyone role's id is the server's id). */
  listRoles(guildId: string): Promise<Array<{ id: string; name: string; permissions: string; position: number; managed: boolean }>>;
  editRole(guildId: string, roleId: string, changes: { permissions?: string }, reason?: string): Promise<void>;
  /** The server's owner (never acted on by anti-nuke). */
  getGuildOwner(guildId: string): Promise<string | null>;
  /** A webhook in a channel (the bot owns it); its token posts as any name and avatar. */
  createWebhook(channelId: string, name: string): Promise<{ id: string; token: string }>;
  /** Posts through a webhook. A 404 means it was deleted: make a new one. */
  executeWebhook(webhookId: string, token: string, message: MessagePayload & { username?: string; avatarUrl?: string; threadId?: string }): Promise<{ id: string | null }>;
  listAutoModRules(guildId: string): Promise<Array<{ id: string; name: string }>>;
  createAutoModRule(guildId: string, rule: Record<string, unknown>): Promise<void>;
  editAutoModRule(guildId: string, ruleId: string, rule: Record<string, unknown>): Promise<void>;
  deleteAutoModRule(guildId: string, ruleId: string): Promise<void>;
}

/** One option of an application command, as Discord takes it (subcommands are options of type 1). */
export interface SlashCommandOptionPayload {
  name: string;
  description: string;
  type: number;
  required?: boolean;
  choices?: Array<{ name: string; value: string | number }>;
  autocomplete?: boolean;
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
  options?: SlashCommandOptionPayload[];
}

/** The body of one application command, as Discord takes it. */
export interface SlashCommandPayload {
  name: string;
  /** Empty for context menus (Discord refuses a description there). */
  description: string;
  /** 1 slash command, 2 user context menu (right click on a member), 3 message context menu. */
  type: 1 | 2 | 3;
  options?: SlashCommandOptionPayload[];
  /** Who sees the command by default: a permission bitfield as a string. Discord enforces it; admins can change it. */
  default_member_permissions?: string;
}

/** Discord refuses attachments over 10 MB for bots without boosts; cards weigh a few hundred KB. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const FILE_NAME = /^[a-zA-Z0-9._-]{1,64}$/;

/**
 * A body as Discord takes it: JSON, or — when it carries `files` — multipart with `payload_json`
 * and one `files[n]` part per file (https://discord.com/developers/docs/reference#uploading-files).
 */
export function encodeBody(body: unknown): string | FormData | undefined {
  if (body === undefined) return undefined;
  const files = (body as { files?: DiscordFile[] } | null)?.files;
  if (!files?.length) {
    if (body && typeof body === "object" && "files" in body) {
      const { files: _f, ...rest } = body as Record<string, unknown>;
      return JSON.stringify(rest);
    }
    return JSON.stringify(body);
  }
  const { files: _files, ...payload } = body as Record<string, unknown>;
  const form = new FormData();
  const usable = files.filter((f) => FILE_NAME.test(f.name) && f.data.byteLength <= MAX_FILE_BYTES).slice(0, 10);
  form.append("payload_json", JSON.stringify({ ...payload, attachments: usable.map((f, id) => ({ id, filename: f.name })) }));
  usable.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data as Uint8Array<ArrayBuffer>], { type: f.contentType }), f.name));
  return form;
}

// ── Rate limits ─────────────────────────────────────────────────────────────────────────────────

/** The longest Discord may make a call wait before it fails instead. */
const MAX_WAIT_SECONDS = 10;

/**
 * Discord limits each ROUTE (its "major parameter" — the channel, server or webhook — counts; other
 * ids do not) and every bot globally (50 requests a second). The headers say what is left and when
 * it resets: a call waits for its bucket instead of being refused. Shared by the whole process, as
 * the limits are the bot's, not one client's.
 */
export function rateKey(method: string, route: string): string {
  const path = route.split("?")[0];
  let major = true;
  let webhook = "";
  const normal = path
    .replace(/\/webhooks\/(\d{15,20})\/[^/]+/, (_m, id: string) => {
      major = false;
      webhook = id;
      return "/webhooks/@hook/:token";
    })
    .replace(/\/(channels|guilds)\/(\d{15,20})|\/(\d{15,20})/g, (_m, kind?: string, id?: string) => {
      if (kind && id && major) {
        major = false;
        return `/${kind}/${id}`;
      }
      return kind ? `/${kind}/:id` : "/:id";
    });
  // Reactions share one bucket per message whatever the emoji.
  return `${method} ${normal.replace(/\/reactions\/[^/]+/, "/reactions/:emoji").replace("@hook", webhook)}`;
}

export function createRateLimiter(now: () => number = Date.now, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  const buckets = new Map<string, { remaining: number; resetAt: number }>();
  let globalUntil = 0;
  return {
    async before(key: string, global = true) {
      for (let i = 0; i < 3; i++) {
        const b = buckets.get(key);
        const waitBucket = b && b.remaining <= 0 ? b.resetAt - now() : 0;
        const waitGlobal = global ? globalUntil - now() : 0;
        const wait = Math.max(waitBucket, waitGlobal);
        if (wait <= 0) return;
        if (wait > MAX_WAIT_SECONDS * 1000) throw new DiscordApiError(429, key, `rate limited for ${Math.ceil(wait / 1000)}s`);
        await sleep(wait);
      }
    },
    after(key: string, headers: Headers) {
      const remaining = headers.get("x-ratelimit-remaining");
      const resetAfter = headers.get("x-ratelimit-reset-after");
      if (remaining === null || resetAfter === null) return;
      buckets.set(key, { remaining: Number(remaining), resetAt: now() + Number(resetAfter) * 1000 });
      if (buckets.size > 5000) buckets.delete(buckets.keys().next().value!);
    },
    limited(key: string, seconds: number, global: boolean) {
      const until = now() + seconds * 1000;
      if (global) globalUntil = until;
      else buckets.set(key, { remaining: 0, resetAt: until });
    },
    /** For tests and the status page. */
    state: () => ({ buckets: buckets.size, globalUntil }),
  };
}

const limiter = createRateLimiter();

/** Mentions in what the bot writes ping users only: never @everyone, @here or a role. */
const ALLOWED_MENTIONS = { parse: ["users"] };

const USER_AGENT = "DiscordBot (https://github.com/Kitsuden/kitsuden-kons, 0.1)";

export function createDiscordRest(
  settings: DiscordSettings = discordSettings(),
  fetchImpl: typeof fetch = fetch
): DiscordRest {
  async function call(method: string, route: string, body?: unknown, auth = true, reason?: string): Promise<unknown> {
    if (auth && !settings.botToken) throw new Error("DISCORD_BOT_TOKEN is not set");
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    // Shown in the server's audit log next to the bot's action.
    if (reason) headers["x-audit-log-reason"] = encodeURIComponent(reason.slice(0, 400));
    if (auth) headers.authorization = `Bot ${settings.botToken}`;
    const encoded = encodeBody(body);
    if (typeof encoded === "string") headers["content-type"] = "application/json";

    const key = rateKey(method, route);
    const shown = `${method} ${route.replace(/\d{15,20}/g, ":id")}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      // Wait for the route's bucket (and the global limit) instead of being refused.
      await limiter.before(key, auth);
      const res = await fetchImpl(`${settings.apiBase}${route}`, { method, headers, body: encoded });
      limiter.after(key, res.headers);
      if (res.status === 429) {
        const info = (await res.json().catch(() => ({}))) as { retry_after?: number; global?: boolean };
        const wait = Number(info.retry_after ?? res.headers.get("retry-after") ?? 1);
        limiter.limited(key, wait, info.global === true || res.headers.get("x-ratelimit-global") === "true");
        if (wait <= MAX_WAIT_SECONDS && attempt < 3) continue;
        throw new DiscordApiError(429, shown, `rate limited for ${wait}s`);
      }
      if (!res.ok) throw new DiscordApiError(res.status, shown, await res.text());
      return res.status === 204 ? null : res.json();
    }
    throw new DiscordApiError(429, shown, "rate limited");
  }

  const app = () => {
    if (!settings.applicationId) throw new Error("DISCORD_APPLICATION_ID is not set");
    return settings.applicationId;
  };

  return {
    async syncGuildCommands(guildId, commands) {
      return (await call("PUT", `/applications/${app()}/guilds/${guildId}/commands`, commands)) as unknown[];
    },
    async sendMessage(channelId, message) {
      const body = typeof message === "string" ? { content: message } : message;
      const sent = (await call("POST", `/channels/${channelId}/messages`, { ...body, allowed_mentions: ALLOWED_MENTIONS })) as {
        id?: string;
      } | null;
      return { id: sent?.id ?? null };
    },
    async editMessage(channelId, messageId, message) {
      await call("PATCH", `/channels/${channelId}/messages/${messageId}`, { ...message, allowed_mentions: ALLOWED_MENTIONS });
    },
    async addRole(guildId, userId, roleId) {
      await call("PUT", `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
    },
    async removeRole(guildId, userId, roleId) {
      await call("DELETE", `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
    },
    async editOriginal(interactionToken, message) {
      const body = typeof message === "string" ? { content: message } : message;
      await call(
        "PATCH",
        `/webhooks/${app()}/${interactionToken}/messages/@original`,
        { ...body, allowed_mentions: ALLOWED_MENTIONS },
        false
      );
    },
    async followup(interactionToken, content, ephemeral) {
      await call(
        "POST",
        `/webhooks/${app()}/${interactionToken}`,
        { content, flags: ephemeral ? 1 << 6 : 0, allowed_mentions: ALLOWED_MENTIONS },
        false
      );
    },
    async openDm(userId) {
      const channel = (await call("POST", "/users/@me/channels", { recipient_id: userId })) as { id: string };
      return channel.id;
    },
    async deleteMessage(channelId, messageId) {
      await call("DELETE", `/channels/${channelId}/messages/${messageId}`);
    },
    async pinMessage(channelId, messageId, pinned) {
      await call(pinned ? "PUT" : "DELETE", `/channels/${channelId}/pins/${messageId}`);
    },
    async react(channelId, messageId, emoji) {
      await call("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
    },
    async getMember(guildId, userId) {
      const m = (await call("GET", `/guilds/${guildId}/members/${userId}`)) as {
        roles?: string[];
        nick?: string | null;
        avatar?: string | null;
        user?: { id: string; username?: string; global_name?: string | null; avatar?: string | null };
      };
      return {
        roles: m.roles ?? [],
        nick: m.nick ?? null,
        avatar: m.avatar ?? null,
        user: m.user ? { id: m.user.id, name: m.nick || m.user.global_name || m.user.username || m.user.id, avatar: m.user.avatar ?? null } : null,
      };
    },
    async editMember(guildId, userId, changes, reason) {
      const body: Record<string, unknown> = {};
      if (changes.nick !== undefined) body.nick = changes.nick;
      if (changes.communicationDisabledUntil !== undefined) body.communication_disabled_until = changes.communicationDisabledUntil;
      await call("PATCH", `/guilds/${guildId}/members/${userId}`, body, true, reason);
    },
    async kick(guildId, userId, reason) {
      await call("DELETE", `/guilds/${guildId}/members/${userId}`, undefined, true, reason);
    },
    async ban(guildId, userId, reason, deleteMessageSeconds) {
      await call("PUT", `/guilds/${guildId}/bans/${userId}`, { delete_message_seconds: deleteMessageSeconds ?? 0 }, true, reason);
    },
    async createThread(channelId, spec) {
      const body: Record<string, unknown> = { name: spec.name.slice(0, 100) };
      if (spec.autoArchiveMinutes) body.auto_archive_duration = spec.autoArchiveMinutes;
      const route = spec.messageId ? `/channels/${channelId}/messages/${spec.messageId}/threads` : `/channels/${channelId}/threads`;
      // 12 = private thread, 11 = public thread (the type only applies without a starting message).
      if (!spec.messageId) {
        body.type = spec.private ? 12 : 11;
        if (spec.private) body.invitable = false;
      }
      const thread = (await call("POST", route, body)) as { id: string };
      return { id: thread.id };
    },
    async addThreadMember(threadId, userId) {
      await call("PUT", `/channels/${threadId}/thread-members/${userId}`);
    },
    async setThreadState(threadId, state) {
      await call("PATCH", `/channels/${threadId}`, { archived: state.archived, ...(state.locked !== undefined ? { locked: state.locked } : {}) });
    },
    async recentMessages(channelId, limit) {
      const list = (await call("GET", `/channels/${channelId}/messages?limit=${Math.min(100, Math.max(1, limit))}`)) as Array<{
        id: string;
        timestamp: string;
        pinned?: boolean;
        author?: { id: string };
      }>;
      return list.map((m) => ({ id: m.id, authorId: m.author?.id ?? null, timestamp: m.timestamp, pinned: !!m.pinned }));
    },
    async bulkDelete(channelId, messageIds) {
      if (messageIds.length === 1) await call("DELETE", `/channels/${channelId}/messages/${messageIds[0]}`);
      else if (messageIds.length > 1) await call("POST", `/channels/${channelId}/messages/bulk-delete`, { messages: messageIds.slice(0, 100) });
    },
    async createChannel(guildId, spec) {
      const ch = (await call("POST", `/guilds/${guildId}/channels`, {
        name: spec.name.slice(0, 100),
        type: spec.type,
        ...(spec.parentId ? { parent_id: spec.parentId } : {}),
        ...(spec.userLimit !== undefined ? { user_limit: spec.userLimit } : {}),
        ...(spec.overwrites ? { permission_overwrites: spec.overwrites } : {}),
      })) as { id: string };
      return { id: ch.id };
    },
    async editChannel(channelId, changes) {
      await call("PATCH", `/channels/${channelId}`, {
        ...(changes.name !== undefined ? { name: changes.name.slice(0, 100) } : {}),
        ...(changes.userLimit !== undefined ? { user_limit: changes.userLimit } : {}),
        ...(changes.slowmode !== undefined ? { rate_limit_per_user: Math.max(0, Math.min(21600, changes.slowmode)) } : {}),
        ...(changes.parentId !== undefined ? { parent_id: changes.parentId } : {}),
        ...(changes.overwrites ? { permission_overwrites: changes.overwrites } : {}),
      });
    },
    async deleteChannel(channelId) {
      await call("DELETE", `/channels/${channelId}`);
    },
    async moveMember(guildId, userId, channelId) {
      await call("PATCH", `/guilds/${guildId}/members/${userId}`, { channel_id: channelId });
    },
    async setChannelPermission(channelId, targetId, type, allow, deny) {
      await call("PUT", `/channels/${channelId}/permissions/${targetId}`, { type, allow, deny });
    },
    async listRoles(guildId) {
      return (await call("GET", `/guilds/${guildId}/roles`)) as Array<{ id: string; name: string; permissions: string; position: number; managed: boolean }>;
    },
    async editRole(guildId, roleId, changes, reason) {
      await call("PATCH", `/guilds/${guildId}/roles/${roleId}`, changes, true, reason);
    },
    async getGuildOwner(guildId) {
      const g = (await call("GET", `/guilds/${guildId}`)) as { owner_id?: string };
      return g.owner_id ?? null;
    },
    async createWebhook(channelId, name) {
      const w = (await call("POST", `/channels/${channelId}/webhooks`, { name: name.slice(0, 80) })) as { id: string; token: string };
      return { id: w.id, token: w.token };
    },
    async executeWebhook(webhookId, token, message) {
      const { username, avatarUrl, threadId, ...body } = message;
      const q = `?wait=true${threadId ? `&thread_id=${threadId}` : ""}`;
      const sent = (await call(
        "POST",
        `/webhooks/${webhookId}/${token}${q}`,
        {
          ...body,
          ...(username ? { username: username.slice(0, 80) } : {}),
          ...(avatarUrl && /^https:\/\//.test(avatarUrl) ? { avatar_url: avatarUrl } : {}),
          allowed_mentions: ALLOWED_MENTIONS,
        },
        false
      )) as { id?: string } | null;
      return { id: sent?.id ?? null };
    },
    async listAutoModRules(guildId) {
      return (await call("GET", `/guilds/${guildId}/auto-moderation/rules`)) as Array<{ id: string; name: string }>;
    },
    async createAutoModRule(guildId, rule) {
      await call("POST", `/guilds/${guildId}/auto-moderation/rules`, rule);
    },
    async editAutoModRule(guildId, ruleId, rule) {
      await call("PATCH", `/guilds/${guildId}/auto-moderation/rules/${ruleId}`, rule);
    },
    async deleteAutoModRule(guildId, ruleId) {
      await call("DELETE", `/guilds/${guildId}/auto-moderation/rules/${ruleId}`);
    },
  };
}

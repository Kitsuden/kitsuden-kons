/**
 * kon-dc — the member page: a server's rankings, store and the member's own stats on the web
 * ============================================================================
 *
 *   GET  /api/dc/member/page/:guildId           the page (HTML, served by this kon)
 *   GET  /api/dc/member/page.js                 its script
 *   GET  /api/dc/member/login?guildId=…         to Discord's login (OAuth2, scope `identify` only)
 *   GET  /api/dc/member/callback                back from Discord: a signed session cookie
 *   POST /api/dc/member/logout
 *   GET  /api/dc/member/guilds/:guildId         rankings, the store and, logged in, "me"
 *   POST /api/dc/member/guilds/:guildId/buy     buy from the store (logged in, and in the server)
 *
 * A server is public only while its "member-page" module is on, and shows what that module allows.
 * The session is a cookie signed with DISCORD_MEMBER_SECRET (HttpOnly, SameSite=Lax, 7 days): it
 * holds the Discord user id, name and avatar, nothing else. The login's `state` is signed and tied
 * to a cookie of the browser that started it. Buying asks Discord whether the member is really in
 * the server. POSTs take JSON only, so another site cannot post a form here.
 *
 * Needs, besides the bot's settings: DISCORD_CLIENT_SECRET, DISCORD_OAUTH_REDIRECT_URL (this API's
 * `/api/dc/member/callback`, also added in the Developer Portal → OAuth2 → Redirects) and
 * DISCORD_MEMBER_SECRET (32+ random characters).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

import { z } from "zod";

import { Snowflake } from "./dc.contract";
import { defineDcModule, levelOf, registerDcModule, type DcModule, type ModuleRuntime } from "./dc.modules";
import type { DiscordSettings } from "./dc.rest";

// ── The module (its settings decide what is public) ─────────────────────────────────────────────

const MemberPageConfig = z
  .object({
    title: z.string().min(1).max(80).optional().meta({ title: "Page title", description: "Default: the server's name" }),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#5865f2")
      .meta({ title: "Accent colour" }),
    showCoins: z.boolean().default(true).meta({ title: "Show the coins ranking" }),
    showLevels: z.boolean().default(true).meta({ title: "Show the levels ranking" }),
    showActivity: z.boolean().default(true).meta({ title: "Show this week's most active" }),
    showStore: z.boolean().default(true).meta({ title: "Show the store" }),
    allowBuying: z.boolean().default(true).meta({ title: "Members can buy from the page" }),
  })
  .strict();
export type MemberPageConfig = z.output<typeof MemberPageConfig>;

export const memberPageModule = defineDcModule({
  id: "member-page",
  name: "Member page",
  description: "A web page for the server: rankings, the store and each member's own stats, with a Discord login.",
  config: MemberPageConfig,
  intents: 0,
  events: [],
});

export const MEMBER_MODULES: DcModule[] = [memberPageModule as DcModule];
for (const m of MEMBER_MODULES) registerDcModule(m);

// ── Sessions ────────────────────────────────────────────────────────────────────────────────────

export interface MemberSession {
  id: string;
  name: string;
  avatar: string | null;
  exp: number;
}

const SESSION_COOKIE = "dc_member";
const STATE_COOKIE = "dc_oauth";
const SESSION_DAYS = 7;

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString();

function signValue(secret: string, payload: unknown): string {
  const body = b64(JSON.stringify(payload));
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function readSigned<T>(secret: string, value: string | undefined): T | null {
  if (!value) return null;
  const [body, mac] = value.split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const data = JSON.parse(unb64(body)) as T & { exp?: number };
    if (typeof data.exp === "number" && data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

/** A secret is usable when long enough; otherwise the page has no login. */
export const memberSecretOf = (s: DiscordSettings) => (s.memberSecret && s.memberSecret.length >= 32 ? s.memberSecret : null);

export const sessionCookie = { name: SESSION_COOKIE, state: STATE_COOKIE };

export function newSession(secret: string, user: { id: string; name: string; avatar: string | null }): string {
  return signValue(secret, { ...user, exp: Date.now() + SESSION_DAYS * 86_400_000 } satisfies MemberSession);
}

export function readSession(secret: string | null, cookie: string | undefined): MemberSession | null {
  if (!secret) return null;
  const s = readSigned<MemberSession>(secret, cookie);
  return s && /^\d{15,20}$/.test(s.id) ? s : null;
}

export function newState(secret: string, guildId: string): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString("base64url");
  return { nonce, state: signValue(secret, { g: guildId, n: nonce, exp: Date.now() + 10 * 60_000 }) };
}

export function readState(secret: string, state: string | undefined, nonce: string | undefined): string | null {
  const s = readSigned<{ g: string; n: string }>(secret, state);
  if (!s || !nonce || s.n !== nonce || !/^\d{15,20}$/.test(s.g)) return null;
  return s.g;
}

// ── Discord OAuth2 ──────────────────────────────────────────────────────────────────────────────

export interface DiscordUser {
  id: string;
  name: string;
  avatar: string | null;
}

/** Code → the user who logged in. Injected in tests. */
export type OAuthExchange = (code: string, settings: DiscordSettings) => Promise<DiscordUser>;

export const discordOAuth: OAuthExchange = async (code, s) => {
  if (!s.applicationId || !s.clientSecret || !s.oauthRedirectUrl) throw new Error("The Discord login is not configured");
  const token = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: s.applicationId,
      client_secret: s.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: s.oauthRedirectUrl,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!token.ok) throw new Error(`Discord refused the login (${token.status})`);
  const { access_token } = (await token.json()) as { access_token: string };
  const me = await fetch("https://discord.com/api/v10/users/@me", { headers: { authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(8000) });
  if (!me.ok) throw new Error(`Discord did not say who logged in (${me.status})`);
  const u = (await me.json()) as { id: string; username: string; global_name?: string | null; avatar?: string | null };
  return { id: u.id, name: u.global_name || u.username, avatar: u.avatar ?? null };
};

export function authorizeUrl(s: DiscordSettings, state: string): string {
  const q = new URLSearchParams({ client_id: s.applicationId ?? "", redirect_uri: s.oauthRedirectUrl ?? "", response_type: "code", scope: "identify", state, prompt: "none" });
  return `https://discord.com/oauth2/authorize?${q}`;
}

// ── What the page shows ─────────────────────────────────────────────────────────────────────────

/** Names and avatars for ranking rows: from profiles, else from Discord (cached ten minutes). */
const nameCache = new Map<string, { at: number; user: DiscordUser }>();

export async function peopleOf(rt: ModuleRuntime, ids: string[]): Promise<Map<string, DiscordUser>> {
  const out = new Map<string, DiscordUser>();
  for (const id of [...new Set(ids)]) {
    const key = `${rt.guildId}:${id}`;
    const hit = nameCache.get(key);
    if (hit && Date.now() - hit.at < 600_000) {
      out.set(id, hit.user);
      continue;
    }
    const p = await rt.profiles.get(id);
    let user: DiscordUser = { id, name: p.name ?? `Member ${id.slice(-4)}`, avatar: p.avatar };
    if (!p.name) {
      try {
        const m = await rt.rest.getMember(rt.guildId, id);
        if (m.user) user = { id, name: m.user.name, avatar: m.user.avatar };
      } catch {
        /* left the server */
      }
    }
    nameCache.set(key, { at: Date.now(), user });
    out.set(id, user);
  }
  return out;
}

export async function pageData(rt: ModuleRuntime, config: MemberPageConfig, guildName: string, me: MemberSession | null) {
  const rows = async (list: Array<{ userId: string; value: number }>, extra?: (v: number) => Record<string, unknown>) => {
    const people = await peopleOf(rt, list.map((r) => r.userId));
    return list.map((r, i) => ({ rank: i + 1, ...people.get(r.userId)!, value: r.value, ...(extra ? extra(r.value) : {}) }));
  };
  const leaderboards: Record<string, unknown> = {};
  if (config.showCoins) leaderboards.coins = await rows((await rt.economy.top("coins", 10)).map((r) => ({ userId: r.userId, value: r.balance })));
  if (config.showLevels) leaderboards.levels = await rows((await rt.economy.top("xp", 10)).map((r) => ({ userId: r.userId, value: r.balance })), (v) => ({ level: levelOf(v) }));
  if (config.showActivity) leaderboards.week = await rows(await rt.activity.top("messages", 6, 10));
  const store = config.showStore
    ? (await rt.catalog.list({ forSale: true })).map((i) => ({
        item: i.item,
        name: i.name,
        emoji: i.emoji,
        description: i.description,
        rarity: i.rarity,
        kind: i.kind,
        price: i.price,
        currency: i.global && i.currency === "coins" ? "credits" : i.currency,
        imageUrl: i.imageUrl && /^https:\/\//.test(i.imageUrl) ? i.imageUrl : null,
        left: i.stock === null ? null : i.stock - i.sold,
      }))
    : [];
  let mine: Record<string, unknown> | null = null;
  if (me) {
    const coins = await rt.economy.get(me.id, "coins");
    const xp = await rt.economy.get(me.id, "xp");
    const credits = await rt.economy.get(me.id, "credits", true);
    const catalog = new Map((await rt.catalog.list()).map((i) => [i.item, i]));
    const items = [...(await rt.economy.items(me.id)), ...(await rt.economy.items(me.id, true))].map((x) => ({
      item: x.item,
      quantity: x.quantity,
      name: catalog.get(x.item)?.name ?? x.item,
      emoji: catalog.get(x.item)?.emoji ?? null,
      rarity: catalog.get(x.item)?.rarity ?? null,
    }));
    const profile = await rt.profiles.get(me.id);
    const week = await rt.activity.of(me.id, 6);
    mine = {
      id: me.id,
      name: me.name,
      avatar: me.avatar,
      coins: coins.balance,
      coinsRank: coins.rank,
      xp: xp.balance,
      level: levelOf(xp.balance),
      levelRank: xp.rank,
      credits: credits.balance,
      rep: profile.rep,
      bio: profile.bio,
      weekMessages: week.messages,
      weekVoiceMinutes: week.voiceMinutes,
      items,
    };
  }
  return {
    guild: { id: rt.guildId, name: guildName },
    page: { title: config.title ?? guildName, accent: config.accent, canBuy: config.allowBuying && config.showStore },
    leaderboards,
    store,
    me: mine,
  };
}

// ── The page itself ─────────────────────────────────────────────────────────────────────────────

let files: { html: string; js: string } | null = null;

/** The page's HTML and script, read once from member/ next to this file. */
export function pageFiles(): { html: string; js: string } {
  files ??= {
    html: readFileSync(new URL("./member/page.html", import.meta.url), "utf8"),
    js: readFileSync(new URL("./member/page.js", import.meta.url), "utf8"),
  };
  return files;
}

/** No inline script, images only from Discord and https, nothing framed. */
export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src https: data:; connect-src 'self'; form-action 'self' https://discord.com; frame-ancestors 'none'; base-uri 'none'";

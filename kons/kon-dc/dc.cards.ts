/**
 * kon-dc — image cards (rank, wallet, leaderboard, a stat card)
 * ============================================================================
 *
 * A card is SVG drawn here (fixed layouts, escaped text, colours from a validated theme) and turned
 * into PNG by a renderer: `sharp` (libvips + librsvg), which the API already ships. Kitsuden's API
 * resolves it at run time; with no renderer the modules fall back to embeds, never to an error.
 *
 *   · Avatars are fetched from Discord's CDN ONLY (cdn.discordapp.com), as PNG, at most 1 MB and
 *     3 s, and inlined as data URIs: the SVG never makes the renderer fetch anything itself.
 *   · Text needs a font in the image the API runs in: Debian has DejaVu; on Alpine add
 *     `font-dejavu` (or Noto). With no font, librsvg draws boxes, not text.
 *   · Nothing user-written becomes markup: every text goes through `xml()`, every colour through
 *     `hex()`, every number through `Number()`.
 */

import { randomInt } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { DiscordFile, DiscordRest } from "./dc.rest";

// ── Renderer ────────────────────────────────────────────────────────────────────────────────────

/** SVG in, PNG out. */
export type PngRenderer = (svg: string) => Promise<Uint8Array>;

let sharpLoad: Promise<PngRenderer | null> | null = null;

/**
 * `sharp` as a renderer, if this process can load it: from the kon's own location, or from the
 * API's working directory (kons run inside the API, which depends on sharp). Null when neither has it.
 */
export function sharpRenderer(): Promise<PngRenderer | null> {
  sharpLoad ??= (async () => {
    const name = "sharp";
    type Sharp = (input: Buffer, opts?: Record<string, unknown>) => { png(): { toBuffer(): Promise<Buffer> } };
    const attempts: Array<() => Promise<unknown>> = [
      () => import(/* @vite-ignore */ name),
      async () => createRequire(join(process.cwd(), "index.js"))(name),
    ];
    for (const attempt of attempts) {
      try {
        const mod = (await attempt()) as { default?: Sharp } & Sharp;
        const sharp = (mod.default ?? mod) as Sharp;
        if (typeof sharp !== "function") continue;
        return async (svg: string) => new Uint8Array(await sharp(Buffer.from(svg), { density: 96 }).png().toBuffer());
      } catch {
        /* try the next place */
      }
    }
    return null;
  })();
  return sharpLoad;
}

// ── Avatars ─────────────────────────────────────────────────────────────────────────────────────

export interface CardUser {
  id: string;
  name: string;
  /** Discord's avatar hash (null = the default avatar). */
  avatar?: string | null;
  /** A server avatar hash, when the member set one (needs the guild id). */
  guildAvatar?: string | null;
}

/** Fetches an image. Injected in tests; the default only reaches Discord's CDN. */
export type ImageFetcher = (url: string) => Promise<Uint8Array | null>;

const CDN = "https://cdn.discordapp.com/";
const MAX_AVATAR_BYTES = 1024 * 1024;

export function avatarUrl(user: CardUser, guildId?: string): string {
  if (user.guildAvatar && guildId) return `${CDN}guilds/${guildId}/users/${user.id}/avatars/${user.guildAvatar}.png?size=128`;
  if (user.avatar && /^(a_)?[0-9a-f]{32}$/.test(user.avatar)) return `${CDN}avatars/${user.id}/${user.avatar}.png?size=128`;
  // The default avatars: (id >> 22) % 6 for the new usernames.
  const index = /^\d{15,20}$/.test(user.id) ? Number((BigInt(user.id) >> 22n) % 6n) : 0;
  return `${CDN}embed/avatars/${index}.png`;
}

/**
 * Where card images may come from: Discord's CDN and media proxy, plus the hosts an installation
 * names in DISCORD_CARD_IMAGE_HOSTS (comma-separated, e.g. its own media host for item art).
 */
export function imageHostAllowed(url: string, env: Record<string, string | undefined> = process.env): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const extra = (env.DISCORD_CARD_IMAGE_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return ["cdn.discordapp.com", "media.discordapp.net", ...extra].includes(u.hostname.toLowerCase());
}

export const fetchDiscordImage: ImageFetcher = async (url) => {
  if (!imageHostAllowed(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "error" });
    if (!res.ok || !/^image\/(png|jpeg)/.test(res.headers.get("content-type") ?? "")) return null;
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_AVATAR_BYTES) return null;
    const data = new Uint8Array(await res.arrayBuffer());
    return data.byteLength <= MAX_AVATAR_BYTES ? data : null;
  } catch {
    return null;
  }
};

const dataUri = (png: Uint8Array) => `data:image/png;base64,${Buffer.from(png).toString("base64")}`;

// ── Safe pieces of SVG ──────────────────────────────────────────────────────────────────────────

/** Text for markup: escaped, without control characters, cut to `max`. */
export function xml(text: unknown, max = 60): string {
  const s = String(text ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  const cut = [...s].length > max ? `${[...s].slice(0, max - 1).join("")}…` : s;
  return cut.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A colour, or the fallback: only `#rrggbb` passes. */
export function hex(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

const num = (n: unknown) => (Number.isFinite(Number(n)) ? Number(n) : 0);
const fmt = (n: unknown) => new Intl.NumberFormat("en-US", { notation: num(n) >= 1e6 ? "compact" : "standard", maximumFractionDigits: 1 }).format(num(n));

/** Colours of a card. Every field is checked by `hex()`. */
export interface CardTheme {
  background?: string;
  panel?: string;
  accent?: string;
  text?: string;
  muted?: string;
}

const DEFAULT_THEME: Required<CardTheme> = {
  background: "#1e1f22",
  panel: "#2b2d31",
  accent: "#5865f2",
  text: "#f2f3f5",
  muted: "#b5bac1",
};

function themeOf(t: CardTheme | undefined): Required<CardTheme> {
  return {
    background: hex(t?.background, DEFAULT_THEME.background),
    panel: hex(t?.panel, DEFAULT_THEME.panel),
    accent: hex(t?.accent, DEFAULT_THEME.accent),
    text: hex(t?.text, DEFAULT_THEME.text),
    muted: hex(t?.muted, DEFAULT_THEME.muted),
  };
}

const FONT = `font-family="DejaVu Sans, Noto Sans, Segoe UI, Arial, sans-serif"`;

/** A round avatar at (x, y) with diameter d: the image, or the name's initial on the accent. */
function avatar(id: string, png: Uint8Array | null, name: string, x: number, y: number, d: number, th: Required<CardTheme>): string {
  const r = d / 2;
  const clip = `<clipPath id="${id}"><circle cx="${x + r}" cy="${y + r}" r="${r}"/></clipPath>`;
  const inner = png
    ? `<image href="${dataUri(png)}" x="${x}" y="${y}" width="${d}" height="${d}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${x + r}" cy="${y + r}" r="${r}" fill="${th.accent}"/><text x="${x + r}" y="${y + r + d * 0.17}" text-anchor="middle" font-size="${Math.round(d * 0.45)}" font-weight="700" fill="${th.text}" ${FONT}>${xml([...name][0]?.toUpperCase() ?? "?", 1)}</text>`;
  return `<defs>${clip}</defs>${inner}`;
}

// ── Templates ───────────────────────────────────────────────────────────────────────────────────

export interface RankCardData {
  user: CardUser;
  level: number;
  /** XP into this level, and how much the level takes. */
  current: number;
  needed: number;
  totalXp: number;
  rank: number;
  theme?: CardTheme;
}

export function rankSvg(d: RankCardData, avatarPng: Uint8Array | null): string {
  const th = themeOf(d.theme);
  const W = 934;
  const H = 282;
  const ratio = Math.max(0, Math.min(1, num(d.current) / Math.max(1, num(d.needed))));
  const barX = 268;
  const barW = 620;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" rx="24" fill="${th.background}"/>
<rect x="18" y="18" width="${W - 36}" height="${H - 36}" rx="18" fill="${th.panel}"/>
${avatar("av", avatarPng, d.user.name, 54, 61, 160, th)}
<circle cx="134" cy="141" r="82" fill="none" stroke="${th.accent}" stroke-width="5"/>
<text x="${barX}" y="122" font-size="40" font-weight="700" fill="${th.text}" ${FONT}>${xml(d.user.name, 22)}</text>
<text x="${barX + barW}" y="78" text-anchor="end" font-size="26" fill="${th.muted}" ${FONT}>RANK <tspan font-size="46" font-weight="700" fill="${th.text}">#${fmt(d.rank)}</tspan>  LEVEL <tspan font-size="46" font-weight="700" fill="${th.accent}">${fmt(d.level)}</tspan></text>
<text x="${barX + barW}" y="122" text-anchor="end" font-size="24" fill="${th.muted}" ${FONT}><tspan fill="${th.text}">${fmt(d.current)}</tspan> / ${fmt(d.needed)} XP</text>
<rect x="${barX}" y="150" width="${barW}" height="38" rx="19" fill="${th.background}"/>
<rect x="${barX}" y="150" width="${Math.max(38, Math.round(barW * ratio))}" height="38" rx="19" fill="${th.accent}"/>
<text x="${barX}" y="230" font-size="22" fill="${th.muted}" ${FONT}>${fmt(d.totalXp)} XP in total</text>
</svg>`;
}

export interface WalletCardData {
  user: CardUser;
  currencyName: string;
  balance: number;
  rank: number;
  /** Small lines under the balance: "🔥 4-day streak", "3 items". Text only. */
  lines?: string[];
  /** After the rank: "in the server" (default), "across the bot". */
  place?: string;
  theme?: CardTheme;
}

export function walletSvg(d: WalletCardData, avatarPng: Uint8Array | null): string {
  const th = themeOf(d.theme);
  const W = 720;
  const H = 260;
  const lines = (d.lines ?? []).slice(0, 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${th.panel}"/><stop offset="1" stop-color="${th.background}"/></linearGradient></defs>
<rect width="${W}" height="${H}" rx="24" fill="url(#g)"/>
<rect x="0" y="0" width="10" height="${H}" rx="5" fill="${th.accent}"/>
${avatar("av", avatarPng, d.user.name, 40, 40, 72, th)}
<text x="130" y="72" font-size="28" font-weight="700" fill="${th.text}" ${FONT}>${xml(d.user.name, 24)}</text>
<text x="130" y="104" font-size="20" fill="${th.muted}" ${FONT}>Wallet · #${fmt(d.rank)} ${xml(d.place ?? "in the server", 24)}</text>
<text x="40" y="190" font-size="64" font-weight="700" fill="${th.text}" ${FONT}>${fmt(d.balance)}<tspan dx="12" font-size="28" font-weight="400" fill="${th.accent}">${xml(d.currencyName, 20)}</tspan></text>
${lines.map((l, i) => `<text x="${W - 40}" y="${170 + i * 30}" text-anchor="end" font-size="20" fill="${th.muted}" ${FONT}>${xml(l, 34)}</text>`).join("\n")}
</svg>`;
}

export interface LeaderboardRow {
  user: CardUser;
  value: number;
  /** A second figure: "level 12". */
  sub?: string;
}

export interface LeaderboardCardData {
  title: string;
  unit: string;
  rows: LeaderboardRow[];
  theme?: CardTheme;
}

export function leaderboardSvg(d: LeaderboardCardData, avatars: Array<Uint8Array | null>): string {
  const th = themeOf(d.theme);
  const rows = d.rows.slice(0, 10);
  const W = 800;
  const H = 110 + Math.max(1, rows.length) * 70;
  const medal = ["#f1c40f", "#bdc3c7", "#cd7f32"];
  const body = rows.length
    ? rows
        .map((r, i) => {
          const y = 96 + i * 70;
          return `<rect x="24" y="${y}" width="${W - 48}" height="60" rx="14" fill="${th.panel}"/>
<text x="64" y="${y + 40}" text-anchor="middle" font-size="26" font-weight="700" fill="${medal[i] ?? th.muted}" ${FONT}>${i + 1}</text>
${avatar(`a${i}`, avatars[i] ?? null, r.user.name, 104, y + 8, 44, th)}
<text x="164" y="${y + 39}" font-size="24" font-weight="600" fill="${th.text}" ${FONT}>${xml(r.user.name, 26)}</text>
<text x="${W - 48}" y="${y + 39}" text-anchor="end" font-size="24" font-weight="700" fill="${th.text}" ${FONT}>${fmt(r.value)}<tspan dx="8" font-size="18" font-weight="400" fill="${th.muted}">${xml(r.sub ?? d.unit, 18)}</tspan></text>`;
        })
        .join("\n")
    : `<text x="${W / 2}" y="150" text-anchor="middle" font-size="24" fill="${th.muted}" ${FONT}>Nobody yet.</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" rx="24" fill="${th.background}"/>
<text x="32" y="62" font-size="34" font-weight="700" fill="${th.text}" ${FONT}>${xml(d.title, 32)}</text>
<rect x="32" y="74" width="80" height="5" rx="2.5" fill="${th.accent}"/>
${body}
</svg>`;
}

export interface StatCardData {
  title: string;
  value: string;
  subtitle?: string;
  user?: CardUser | null;
  theme?: CardTheme;
}

/** A generic card for blueprints: a title, a big value, a line under it, maybe a member. */
export function statSvg(d: StatCardData, avatarPng: Uint8Array | null): string {
  const th = themeOf(d.theme);
  const W = 720;
  const H = 240;
  const x = d.user ? 150 : 40;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" rx="24" fill="${th.background}"/>
<rect x="16" y="16" width="${W - 32}" height="${H - 32}" rx="18" fill="${th.panel}"/>
${d.user ? avatar("av", avatarPng, d.user.name, 40, 64, 96, th) : ""}
<text x="${x}" y="80" font-size="26" fill="${th.muted}" ${FONT}>${xml(d.title, 40)}</text>
<text x="${x}" y="152" font-size="58" font-weight="700" fill="${th.text}" ${FONT}>${xml(d.value, 18)}</text>
${d.subtitle ? `<text x="${x}" y="194" font-size="22" fill="${th.accent}" ${FONT}>${xml(d.subtitle, 44)}</text>` : ""}
</svg>`;
}

export interface ProfileCardData {
  user: CardUser;
  bio?: string | null;
  rep: number;
  globalLevel: number;
  credits: number;
  creditsName?: string;
  /** This server: its level and place, when the member has XP here. */
  serverLevel?: number | null;
  serverRank?: number | null;
  /** Badges as short labels with a colour (catalog items). */
  badges?: Array<{ label: string; color?: string }>;
  /** A background image (PNG bytes, already fetched from an allowed place). */
  backgroundPng?: Uint8Array | null;
  theme?: CardTheme;
}

/** Splits text into at most `lines` lines of about `width` characters, on spaces. */
export function wrap(text: string, width: number, lines: number): string[] {
  const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if ([...next].length > width && line) {
      out.push(line);
      line = w;
      if (out.length === lines) break;
    } else line = next;
  }
  if (out.length < lines && line) out.push(line);
  if (out.length === lines && words.join(" ").length > out.join(" ").length) out[lines - 1] = `${out[lines - 1].replace(/.?$/, "")}…`;
  return out.map((l) => [...l].slice(0, width + 1).join(""));
}

export function profileSvg(d: ProfileCardData, avatarPng: Uint8Array | null): string {
  const th = themeOf(d.theme);
  const W = 900;
  const H = 460;
  const banner = d.backgroundPng
    ? `<defs><clipPath id="bn"><rect width="${W}" height="160" rx="24"/></clipPath></defs><image href="${dataUri(d.backgroundPng)}" width="${W}" height="160" preserveAspectRatio="xMidYMid slice" clip-path="url(#bn)"/>`
    : `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${th.accent}"/><stop offset="1" stop-color="${th.panel}"/></linearGradient></defs><rect width="${W}" height="160" rx="24" fill="url(#bg)"/>`;
  const bio = wrap(d.bio || "No bio yet.", 52, 3);
  const tiles: Array<[string, string]> = [
    ["Global level", fmt(d.globalLevel)],
    [xml(d.creditsName ?? "Credits", 14), fmt(d.credits)],
    ["Reputation", `+${fmt(d.rep)}`],
    ["This server", d.serverLevel != null ? `Lv ${fmt(d.serverLevel)}${d.serverRank ? ` · #${fmt(d.serverRank)}` : ""}` : "—"],
  ];
  const tileW = (W - 80 - 3 * 16) / 4;
  const badges = (d.badges ?? []).slice(0, 6);
  let bx = W - 32;
  const pills = badges
    .map((b) => {
      const label = xml(b.label, 14);
      const w = 24 + [...b.label.slice(0, 14)].length * 11;
      bx -= w + 8;
      return `<rect x="${bx}" y="24" width="${w}" height="32" rx="16" fill="${hex(b.color, th.panel)}" fill-opacity="0.92"/><text x="${bx + w / 2}" y="46" text-anchor="middle" font-size="16" font-weight="600" fill="${th.text}" ${FONT}>${label}</text>`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" rx="24" fill="${th.background}"/>
${banner}
${pills}
<circle cx="125" cy="160" r="86" fill="${th.background}"/>
${avatar("av", avatarPng, d.user.name, 45, 80, 160, th)}
<text x="230" y="205" font-size="38" font-weight="700" fill="${th.text}" ${FONT}>${xml(d.user.name, 24)}</text>
${bio.map((l, i) => `<text x="230" y="${242 + i * 28}" font-size="21" fill="${th.muted}" ${FONT}>${xml(l, 60)}</text>`).join("\n")}
${tiles
  .map(([label, value], i) => {
    const x = 40 + i * (tileW + 16);
    return `<rect x="${x}" y="340" width="${tileW}" height="88" rx="16" fill="${th.panel}"/>
<text x="${x + 18}" y="372" font-size="17" fill="${th.muted}" ${FONT}>${label}</text>
<text x="${x + 18}" y="410" font-size="28" font-weight="700" fill="${i === 0 ? th.accent : th.text}" ${FONT}>${xml(value, 16)}</text>`;
  })
  .join("\n")}
</svg>`;
}

/**
 * A verification code drawn so a script has to read an image: each letter turned and moved a
 * little, over noise lines. Not a wall against a determined bot, a filter for raid scripts.
 */
export function captchaSvg(code: string, rand: (max: number) => number = (m) => Math.floor(Math.random() * m)): string {
  const W = 360;
  const H = 120;
  const chars = [...code.slice(0, 8)];
  const step = (W - 60) / Math.max(1, chars.length);
  const noise = Array.from({ length: 7 }, () => `<line x1="${rand(W)}" y1="${rand(H)}" x2="${rand(W)}" y2="${rand(H)}" stroke="#${["5865f2", "eb459e", "57f287", "fee75c"][rand(4)]}" stroke-width="${2 + rand(3)}" opacity="0.7"/>`).join("");
  const dots = Array.from({ length: 60 }, () => `<circle cx="${rand(W)}" cy="${rand(H)}" r="${1 + rand(2)}" fill="#b5bac1" opacity="0.5"/>`).join("");
  const letters = chars
    .map((c, i) => {
      const x = 40 + i * step + rand(10);
      const y = 76 + rand(18) - 9;
      return `<text x="${x}" y="${y}" font-size="${46 + rand(12)}" font-weight="700" fill="#f2f3f5" transform="rotate(${rand(40) - 20} ${x} ${y})" ${FONT}>${xml(c, 1)}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" rx="16" fill="#2b2d31"/>${dots}${letters}${noise}</svg>`;
}

// ── The kit a module uses ───────────────────────────────────────────────────────────────────────

/** What modules and blueprint steps call. Each method gives a PNG file, or null with no renderer. */
export interface CardKit {
  available(): Promise<boolean>;
  rank(d: Omit<RankCardData, "user"> & { user: CardUser | string }, name?: string): Promise<DiscordFile | null>;
  wallet(d: Omit<WalletCardData, "user"> & { user: CardUser | string }, name?: string): Promise<DiscordFile | null>;
  leaderboard(d: Omit<LeaderboardCardData, "rows"> & { rows: Array<Omit<LeaderboardRow, "user"> & { user: CardUser | string }> }, name?: string): Promise<DiscordFile | null>;
  stat(d: Omit<StatCardData, "user"> & { user?: CardUser | string | null }, name?: string): Promise<DiscordFile | null>;
  /** A verification code as an image. */
  captcha(code: string, name?: string): Promise<DiscordFile | null>;
  /** `backgroundUrl` is fetched like an avatar (Discord's CDN or the catalog's allowed hosts). */
  profile(d: Omit<ProfileCardData, "user" | "backgroundPng"> & { user: CardUser | string; backgroundUrl?: string | null }, name?: string): Promise<DiscordFile | null>;
}

export interface CardKitOptions {
  guildId: string;
  rest: Pick<DiscordRest, "getMember">;
  /** null: no images (the modules use embeds). */
  render: () => Promise<PngRenderer | null>;
  fetchImage?: ImageFetcher;
  /** Who acted: their name and avatar are known without a REST call. */
  known?: CardUser | null;
}

const FILE = /^[a-z0-9_-]{1,40}$/;

export function createCardKit(o: CardKitOptions): CardKit {
  const fetchImage = o.fetchImage ?? fetchDiscordImage;
  const people = new Map<string, CardUser>();
  if (o.known) people.set(o.known.id, o.known);

  /** A member's name and avatar: from what is known, or from Discord (a member who left keeps the id). */
  async function who(u: CardUser | string): Promise<CardUser> {
    if (typeof u !== "string") return u;
    const hit = people.get(u);
    if (hit) return hit;
    let found: CardUser = { id: u, name: u, avatar: null };
    try {
      const m = await o.rest.getMember(o.guildId, u);
      if (m.user) found = { id: u, name: m.user.name, avatar: m.user.avatar, guildAvatar: m.avatar ?? null };
    } catch {
      /* left the server, or no permission: the id stays */
    }
    people.set(u, found);
    return found;
  }

  const face = async (u: CardUser | null | undefined) => (u ? await fetchImage(avatarUrl(u, o.guildId)) : null);

  async function png(svg: string, name: string): Promise<DiscordFile | null> {
    const render = await o.render();
    if (!render) return null;
    const safe = FILE.test(name) ? name : "card";
    return { name: `${safe}.png`, data: await render(svg), contentType: "image/png" };
  }

  return {
    async available() {
      return (await o.render()) !== null;
    },
    async rank(d, name = "rank") {
      if (!(await o.render())) return null;
      const user = await who(d.user);
      return png(rankSvg({ ...d, user }, await face(user)), name);
    },
    async wallet(d, name = "wallet") {
      if (!(await o.render())) return null;
      const user = await who(d.user);
      return png(walletSvg({ ...d, user }, await face(user)), name);
    },
    async leaderboard(d, name = "leaderboard") {
      if (!(await o.render())) return null;
      const rows = await Promise.all(d.rows.slice(0, 10).map(async (r) => ({ ...r, user: await who(r.user) })));
      const faces = await Promise.all(rows.map((r) => face(r.user)));
      return png(leaderboardSvg({ ...d, rows }, faces), name);
    },
    async profile(d, name = "profile") {
      if (!(await o.render())) return null;
      const user = await who(d.user);
      const backgroundPng = d.backgroundUrl ? await fetchImage(d.backgroundUrl) : null;
      return png(profileSvg({ ...d, user, backgroundPng }, await face(user)), name);
    },
    async captcha(code, name = "captcha") {
      return png(captchaSvg(code, (m) => randomInt(0, m)), name);
    },
    async stat(d, name = "card") {
      if (!(await o.render())) return null;
      const user = d.user ? await who(d.user) : null;
      return png(statSvg({ ...d, user }, await face(user)), name);
    },
  };
}

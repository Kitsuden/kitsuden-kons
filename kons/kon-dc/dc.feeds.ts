/**
 * kon-dc — feeds: new posts, videos and streams, said in a channel
 * ============================================================================
 *
 *   rss       any RSS or Atom URL (https; fetched through dc.http's checks: no private addresses)
 *   youtube   a channel id (UC…): its videos feed
 *   reddit    a subreddit: its new posts
 *   twitch    a login: when it goes live (needs TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in the API)
 *
 * Polled every N minutes (a recurring schedule). The first poll of a feed only remembers what is
 * already there, so switching it on never floods a channel. At most 3 new items per feed and poll.
 */

import { z } from "zod";

import { LocalId, Snowflake } from "./dc.contract";
import { parseFeed, type FeedEntry, type TextFetcher } from "./dc.http";
import { baseVars, clip, defineDcModule, messageOf, registerDcModule, render, type DcModule, type ModuleRuntime } from "./dc.modules";

// ── Twitch ──────────────────────────────────────────────────────────────────────────────────────

export interface LiveStream {
  login: string;
  name: string;
  title: string;
  game: string;
  startedAt: string;
  thumbnail: string;
}

/** Who of these logins is live. Injected in tests; the default asks Twitch's Helix API. */
export type TwitchClient = (logins: string[]) => Promise<LiveStream[]>;

let token: { value: string; until: number } | null = null;

export function twitchClient(env: Record<string, string | undefined> = process.env): TwitchClient | null {
  const id = env.TWITCH_CLIENT_ID?.trim();
  const secret = env.TWITCH_CLIENT_SECRET?.trim();
  if (!id || !secret) return null;
  return async (logins) => {
    if (!logins.length) return [];
    if (!token || token.until < Date.now()) {
      const res = await fetch("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Twitch refused the app credentials (${res.status})`);
      const t = (await res.json()) as { access_token: string; expires_in: number };
      token = { value: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 };
    }
    const q = logins.slice(0, 100).map((l) => `user_login=${encodeURIComponent(l)}`).join("&");
    const res = await fetch(`https://api.twitch.tv/helix/streams?${q}`, {
      headers: { "client-id": id, authorization: `Bearer ${token.value}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Twitch answered ${res.status}`);
    const data = (await res.json()) as { data: Array<{ user_login: string; user_name: string; title: string; game_name: string; started_at: string; thumbnail_url: string }> };
    return data.data.map((s) => ({
      login: s.user_login.toLowerCase(),
      name: s.user_name,
      title: s.title,
      game: s.game_name,
      startedAt: s.started_at,
      thumbnail: s.thumbnail_url.replace("{width}", "640").replace("{height}", "360"),
    }));
  };
}

// ── The module ──────────────────────────────────────────────────────────────────────────────────

const KINDS = ["rss", "youtube", "reddit", "twitch"] as const;

const DEFAULT_MESSAGE: Record<(typeof KINDS)[number], string> = {
  rss: "📰 **{{feed.title}}**\n{{feed.link}}",
  youtube: "▶️ New video from {{feed.author}}: **{{feed.title}}**\n{{feed.link}}",
  reddit: "New in r/{{feed.source}}: **{{feed.title}}**\n{{feed.link}}",
  twitch: "🔴 **{{stream.name}}** is live: {{stream.title}} ({{stream.game}})\nhttps://twitch.tv/{{stream.login}}",
};

const Feed = z
  .object({
    id: LocalId.meta({ title: "Id" }),
    kind: z.enum(KINDS).meta({ title: "Kind" }),
    source: z.string().min(1).max(500).meta({ title: "Source", description: "rss: an https URL · youtube: a channel id (UC…) · reddit: a subreddit · twitch: a login" }),
    channelId: Snowflake.meta({ title: "Channel id" }),
    message: z.string().min(1).max(2000).optional().meta({ title: "Message", description: "{{feed.title}} {{feed.link}} {{feed.author}}; twitch: {{stream.name}} {{stream.title}} {{stream.game}}" }),
  })
  .strict()
  .superRefine((f, ctx) => {
    const ok =
      f.kind === "rss"
        ? /^https:\/\//.test(f.source)
        : f.kind === "youtube"
          ? /^UC[\w-]{22}$/.test(f.source)
          : f.kind === "reddit"
            ? /^[A-Za-z0-9_]{2,21}$/.test(f.source)
            : /^[a-zA-Z0-9_]{3,25}$/.test(f.source);
    if (!ok) ctx.addIssue({ code: "custom", path: ["source"], message: `Not a ${f.kind} source` });
  });
type Feed = z.output<typeof Feed>;

const FeedsConfig = z
  .object({
    feeds: z
      .array(Feed)
      .min(1)
      .max(25)
      .refine((f) => new Set(f.map((x) => x.id)).size === f.length, { message: "Two feeds with the same id" })
      .meta({ title: "Feeds" }),
    everyMinutes: z.number().int().min(5).max(1440).default(10).meta({ title: "Check every N minutes" }),
  })
  .strict();

export function feedUrl(f: Pick<Feed, "kind" | "source">): string | null {
  if (f.kind === "rss") return f.source;
  if (f.kind === "youtube") return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(f.source)}`;
  if (f.kind === "reddit") return `https://www.reddit.com/r/${encodeURIComponent(f.source)}/new/.rss`;
  return null;
}

const SEEN_KEEP = 60;

async function pollFeed(f: Feed, rt: ModuleRuntime, fetchText: TextFetcher) {
  const url = feedUrl(f);
  if (!url) return;
  const res = await fetchText(url);
  if (res.status !== 200) throw new Error(`answered ${res.status}`);
  const entries = parseFeed(res.text);
  const raw = await rt.kv.get(`seen:${f.id}`);
  const seen = new Set<string>(typeof raw === "string" ? (JSON.parse(raw) as string[]) : []);
  const first = raw === undefined;
  const fresh = entries.filter((e) => !seen.has(e.id));
  const remember = [...fresh.map((e) => e.id), ...seen].slice(0, SEEN_KEEP);
  await rt.kv.set(`seen:${f.id}`, JSON.stringify(remember));
  if (first) return;
  // Oldest first, at most 3: a feed that was down for a day does not post 30 messages.
  for (const e of fresh.slice(0, 3).reverse()) await post(f, e, rt);
}

async function post(f: Feed, e: FeedEntry, rt: ModuleRuntime) {
  const scope = { ...baseVars(rt), feed: { ...e, source: f.source, id: f.id } };
  await rt.rest.sendMessage(f.channelId, clip(render(f.message ?? DEFAULT_MESSAGE[f.kind], scope)));
  rt.emit("dc:feed:new", { guildId: rt.guildId, feedId: f.id, kind: f.kind, link: e.link, title: e.title });
}

async function pollTwitch(feeds: Feed[], rt: ModuleRuntime, twitch: TwitchClient | null) {
  if (!feeds.length) return;
  if (!twitch) {
    rt.logger.warn("Feeds: Twitch feeds need TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in the API");
    return;
  }
  const live = new Map((await twitch(feeds.map((f) => f.source.toLowerCase()))).map((s) => [s.login, s]));
  for (const f of feeds) {
    const s = live.get(f.source.toLowerCase());
    const last = await rt.kv.get(`live:${f.id}`);
    if (!s) {
      if (last) await rt.kv.set(`live:${f.id}`, "");
      continue;
    }
    if (last === s.startedAt) continue;
    await rt.kv.set(`live:${f.id}`, s.startedAt);
    await rt.rest.sendMessage(f.channelId, {
      content: clip(render(f.message ?? DEFAULT_MESSAGE.twitch, { ...baseVars(rt), stream: s })),
      embeds: [{ title: clip(s.title || s.name, 256), url: `https://twitch.tv/${s.login}`, color: 0x9146ff, image: { url: s.thumbnail }, footer: { text: s.game } }],
    });
    rt.emit("dc:feed:new", { guildId: rt.guildId, feedId: f.id, kind: "twitch", link: `https://twitch.tv/${s.login}`, title: s.title });
  }
}

export const feedsModule = defineDcModule({
  id: "feeds",
  name: "Feeds",
  description: "Posts new RSS items, YouTube videos, Reddit posts and Twitch streams going live in a channel.",
  config: FeedsConfig,
  intents: 0,
  events: [],
  schedules: (config) => [{ key: "poll", schedule: { everyMinutes: config.everyMinutes, timezone: "UTC" } }],
  async onSchedule(key, _payload, config, rt) {
    if (key !== "poll") return;
    for (const f of config.feeds.filter((x) => x.kind !== "twitch")) {
      try {
        await pollFeed(f, rt, rt.fetchText);
      } catch (err) {
        rt.logger.warn("Feeds: a feed failed", { feed: f.id, kind: f.kind, message: messageOf(err) });
      }
    }
    try {
      await pollTwitch(config.feeds.filter((x) => x.kind === "twitch"), rt, rt.twitch);
    } catch (err) {
      rt.logger.warn("Feeds: Twitch failed", { message: messageOf(err) });
    }
  },
});

export const FEED_MODULES: DcModule[] = [feedsModule as DcModule];
for (const m of FEED_MODULES) registerDcModule(m);

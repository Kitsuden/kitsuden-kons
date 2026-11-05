/**
 * Adapter: Riot's Live Client Data API
 * ============================================================================
 *
 * The OFFICIAL, permitted source. It runs at `https://127.0.0.1:2999` inside the
 * PC that has the client open —the spectator's, in a production— and
 * needs no API key or agreement with Riot.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SOURCE DOES NOT GIVE, AND WHY IT IS NOT DISGUISED
 *
 * **Gold.** Riot deliberately omits it in spectator context. There is no other
 * endpoint: it is their product decision. Products that show exact gold
 * read process memory, which is an integration of a different
 * nature and with a different risk.
 *
 * Here `gold: false` is declared in the capabilities and the frame comes out with
 * `gold: null`. The estimator in `moba.gold.ts` fills in the DIFFERENCE —which is
 * the one that can be estimated well— and the overlay paints it marked as an estimate.
 *
 * The alternative was to paint an invented number that looks like a real
 * one. Live, that is not a detail: the caster says it aloud.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The certificate is self-signed (`riotgames.com` issued by Riot). TLS verification is not
 * disabled globally: it is accepted only for this host,
 * because turning it off for the whole process would affect any other outgoing
 * request of the server.
 */

import {
  emptyFrame,
  emptyObjectives,
  type IngestAdapter,
  type LiveEvent,
  type LiveFrame,
  type LivePlayerFrame,
  type TeamFrame,
  type TeamSide,
} from "./frame.js";

const DEFAULT_BASE = "https://127.0.0.1:2999";

/** What Riot calls the teams versus what they are called on screen. */
function toSide(team: string): TeamSide {
  return team === "CHAOS" ? "red" : "blue";
}

interface RiotPlayer {
  championName?: string;
  isDead?: boolean;
  items?: {
    itemID?: number;
    slot?: number;
    price?: number;
    count?: number;
    consumable?: boolean;
  }[];
  level?: number;
  position?: string;
  rawChampionName?: string;
  respawnTimer?: number;
  riotId?: string;
  riotIdGameName?: string;
  scores?: {
    assists?: number;
    creepScore?: number;
    deaths?: number;
    kills?: number;
    wardScore?: number;
  };
  skinID?: number;
  summonerName?: string;
  summonerSpells?: { summonerSpellOne?: { rawDisplayName?: string; displayName?: string } };
  team?: string;
}

interface RiotEvent {
  EventID?: number;
  EventName?: string;
  EventTime?: number;
  KillerName?: string;
  VictimName?: string;
  Assisters?: string[];
  DragonType?: string;
  Stolen?: string;
  TurretKilled?: string;
  InhibKilled?: string;
  KillStreak?: number;
  Acer?: string;
  AcingTeam?: string;
  Recipient?: string;
}

interface RiotAllGameData {
  activePlayer?: { currentGold?: number };
  allPlayers?: RiotPlayer[];
  events?: { Events?: RiotEvent[] };
  gameData?: { gameTime?: number; gameMode?: string };
}

/**
 * Champion name → stable slug.
 *
 * It is normalized here and not in the overlay because the name the API returns
 * varies with the client language (`Lee Sin`, `Kai'Sa`, `Nunu y Willump`) and the
 * graphic needs something that works as a key to look up the portrait.
 */
/**
 * Data Dragon key from the game's internal name.
 *
 * `rawChampionName` arrives as `game_character_displayname_LeeSin`. What comes
 * after the last underscore IS the CDN key, with its capitalization and its
 * oddities —Wukong is `MonkeyKing`—. That is why it is taken from there and not from the
 * displayed name, which changes with the client language.
 */
export function championKey(raw: string | undefined, fallback?: string): string {
  const fromRaw = raw?.split("_").pop();
  if (fromRaw && /^[A-Za-z]+$/.test(fromRaw)) return fromRaw;
  // Without `rawChampionName` it is approximated from the visible name. It fails with
  // special cases, and that is why it is the fallback and not the main path.
  return (fallback ?? "").replace(/[^A-Za-z]/g, "");
}

export function championSlug(name: string | undefined): string {
  if (!name) return "";
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

/** Player's role. The API gives it in uppercase and sometimes empty. */
function toRole(position: string | undefined): string | null {
  if (!position) return null;
  const map: Record<string, string> = {
    TOP: "top",
    JUNGLE: "jungle",
    MIDDLE: "mid",
    BOTTOM: "bot",
    UTILITY: "support",
  };
  return map[position.toUpperCase()] ?? position.toLowerCase();
}

/** Displayable name. Riot switched from `summonerName` to `riotId` midway through its life. */
function displayName(p: RiotPlayer): string {
  return p.riotIdGameName || p.riotId?.split("#")[0] || p.summonerName || "";
}

export function toPlayerFrame(p: RiotPlayer, slot: number): LivePlayerFrame {
  const scores = p.scores ?? {};
  return {
    slot,
    team: toSide(p.team ?? "ORDER"),
    riotId: displayName(p),
    role: toRole(p.position),
    championId:
      championSlug(p.rawChampionName?.replace(/^game_character_displayname_/i, "")) ||
      championSlug(p.championName),
    championKey: championKey(p.rawChampionName, p.championName),
    championName: p.championName ?? "",
    level: p.level ?? 1,
    kills: scores.kills ?? 0,
    deaths: scores.deaths ?? 0,
    assists: scores.assists ?? 0,
    creepScore: scores.creepScore ?? 0,
    visionScore: scores.wardScore ?? 0,
    // Empty slots are NOT filled with zeros: an inventory of 3 items
    // has 3 entries, and the graphic decides how to paint the gaps.
    items: (p.items ?? [])
      .slice()
      .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
      .map((i) => String(i.itemID ?? ""))
      .filter(Boolean),
    summonerSpells: [],
    isDead: Boolean(p.isDead),
    respawnIn: Math.max(0, Math.round(p.respawnTimer ?? 0)),
    gold: null, // the API does not publish it in spectator — see header
    netWorth: netWorthOf(p),
  };
}

/**
 * A player's net worth: sum of the price of what they carry.
 *
 * **It is not an estimate.** The API delivers `price` on every item in the
 * inventory, for all ten players, including in spectator. This only sums it.
 *
 * Consumables are EXCLUDED: a potion is not power on the map, and counting
 * it would make net worth rise and fall every time someone buys potions —
 * noise that on the chart is mistaken for real progress.
 */
export function netWorthOf(p: RiotPlayer): number | null {
  const items = p.items;
  // Without an inventory it is unknown: `0` would say "has nothing", which is different.
  if (!items) return null;
  return items
    .filter((i) => !i.consumable)
    .reduce((sum, i) => sum + (i.price ?? 0) * (i.count ?? 1), 0);
}

/** Riot event → normalized event. `null` if it is not of interest on screen. */
export function toEvent(e: RiotEvent, playersByName: Map<string, TeamSide>): LiveEvent | null {
  const at = Math.round(e.EventTime ?? 0);
  const id = e.EventID ?? 0;
  const killerTeam = e.KillerName ? playersByName.get(e.KillerName) : undefined;

  switch (e.EventName) {
    case "GameStart":
      return { id, at, type: "GameStart" };
    case "FirstBlood":
      return {
        id,
        at,
        type: "FirstBlood",
        actor: e.Recipient,
        team: e.Recipient ? playersByName.get(e.Recipient) : undefined,
      };
    case "ChampionKill":
      return {
        id,
        at,
        type: "ChampionKill",
        actor: e.KillerName,
        victim: e.VictimName,
        assisters: e.Assisters,
        team: killerTeam,
      };
    case "Multikill":
      return {
        id,
        at,
        type: "Multikill",
        actor: e.KillerName,
        team: killerTeam,
        detail: `x${e.KillStreak ?? 2}`,
      };
    case "Ace":
      return {
        id,
        at,
        type: "Ace",
        actor: e.Acer,
        team: e.AcingTeam ? toSide(e.AcingTeam) : undefined,
      };
    case "TurretKilled":
      return { id, at, type: "TurretKilled", actor: e.KillerName, team: killerTeam };
    case "InhibKilled":
      return { id, at, type: "InhibKilled", actor: e.KillerName, team: killerTeam };
    case "DragonKill":
      return {
        id,
        at,
        type: "DragonKill",
        actor: e.KillerName,
        team: killerTeam,
        detail: (e.DragonType ?? "").toLowerCase() || undefined,
      };
    case "BaronKill":
      return { id, at, type: "BaronKill", actor: e.KillerName, team: killerTeam };
    case "HeraldKill":
      return { id, at, type: "HeraldKill", actor: e.KillerName, team: killerTeam };
    case "GameEnd":
      return { id, at, type: "GameEnd" };
    default:
      // Events of which nothing is painted (`MinionsSpawning`,
      // `InhibRespawningSoon`…). Returning them would fill the timeline with
      // noise the caster is not going to mention.
      return null;
  }
}

/** Distributes players and events across the frame's two teams. */
export function buildFrame(data: RiotAllGameData, source: string): LiveFrame {
  const frame = emptyFrame(source);
  frame.gameTime = Math.round(data.gameData?.gameTime ?? 0);

  const all = data.allPlayers ?? [];
  const byTeam: Record<TeamSide, LivePlayerFrame[]> = { blue: [], red: [] };
  const teamOf = new Map<string, TeamSide>();

  for (const raw of all) {
    const side = toSide(raw.team ?? "ORDER");
    const player = toPlayerFrame(raw, byTeam[side].length);
    byTeam[side].push(player);
    if (player.riotId) teamOf.set(player.riotId, side);
    // Events reference by `summonerName` even though the player is displayed
    // by Riot ID: both must be resolvable.
    if (raw.summonerName) teamOf.set(raw.summonerName, side);
    if (raw.riotId) teamOf.set(raw.riotId, side);
  }

  const events = (data.events?.Events ?? [])
    .map((e) => toEvent(e, teamOf))
    .filter((e): e is LiveEvent => e !== null)
    .sort((a, b) => a.at - b.at);

  const build = (side: TeamSide): TeamFrame => {
    const players = byTeam[side];
    const objectives = emptyObjectives();

    for (const e of events) {
      if (e.team !== side) continue;
      if (e.type === "TurretKilled") objectives.towers++;
      else if (e.type === "InhibKilled") objectives.inhibitors++;
      else if (e.type === "BaronKill") objectives.barons++;
      else if (e.type === "HeraldKill") objectives.heralds++;
      else if (e.type === "VoidgrubKill") objectives.voidgrubs++;
      else if (e.type === "DragonKill") {
        objectives.dragons.push({ type: e.detail ?? "unknown", team: side, at: e.at });
      }
    }

    // If any player is missing their inventory, the TEAM's net worth is
    // unknown: summing what there is would give a number that looks complete.
    const worths = players.map((p) => p.netWorth);
    const netWorth = worths.every((w) => w !== null)
      ? worths.reduce((sum, w) => sum + (w as number), 0)
      : null;

    return {
      side,
      players,
      objectives,
      gold: null,
      netWorth,
      kills: players.reduce((sum, p) => sum + p.kills, 0),
    };
  };

  frame.blue = build("blue");
  frame.red = build("red");
  frame.events = events;
  frame.precision = {
    gold: "unavailable", // the estimator raises it to "estimated" when reading it
    // Net worth IS exact: it comes from summing prices the API delivers.
    netWorth: frame.blue.netWorth !== null && frame.red.netWorth !== null ? "exact" : "unavailable",
    items: "exact",
    vision: "exact",
    objectives: "exact",
  };

  return frame;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export interface RiotAdapterOptions {
  /** Client base. Configurable for relays and test environments. */
  baseUrl?: string;
  /** Milliseconds before giving up on a read. */
  timeoutMs?: number;
  /**
   * Injectable for tests. By default it uses `fetch` with relaxed TLS ONLY
   * for Riot's local host.
   */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * Builds the adapter.
 *
 * `poll` returns `null` —it does not throw— when there is no game. Between games of a
 * series the client responds 404 for minutes, and that is normal
 * operation: treating it as an error would fill the production log with noise and
 * hide the real failures.
 */
export function createRiotLiveClientAdapter(options: RiotAdapterOptions = {}): IngestAdapter {
  const base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 2000;
  const doFetch = options.fetchImpl ?? defaultFetch;

  return {
    id: "riot-live-client",
    name: "Riot Live Client Data",
    capabilities: {
      // Gold on hand is the only thing this source CANNOT give. Declaring it
      // here is what lets the panel warn before the game starts.
      gold: false,
      // Net worth it CAN, and exactly: the API publishes the price of every item of
      // the ten players. It is the difference most people overlook.
      netWorth: true,
      items: true,
      vision: true,
      objectives: true,
      events: true,
      spectator: true,
    },
    async poll({ signal } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      signal?.addEventListener("abort", () => controller.abort(), { once: true });

      try {
        const res = await doFetch(`${base}/liveclientdata/allgamedata`, {
          signal: controller.signal,
        });
        // 404 = no game. It is the normal state between games.
        if (!res.ok) return null;

        const data = (await res.json()) as RiotAllGameData;
        // The client responds with an empty object while loading.
        if (!data?.allPlayers?.length) return null;

        return buildFrame(data, "riot-live-client");
      } catch {
        // Timeout, closed client, TLS: none of this can bring the ingest down.
        // The loop retries and the overlay keeps the last good frame.
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * `fetch` that accepts Riot's self-signed certificate **only for its host**.
 *
 * `NODE_TLS_REJECT_UNAUTHORIZED` is not touched: that would disable verification
 * for EVERY outgoing request of the server —webhooks, payment gateways, S3—
 * just to talk to a local game client.
 */
function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  const runtime = globalThis as { Bun?: unknown };
  if (runtime.Bun) {
    // Bun allows relaxing TLS per request.
    return fetch(url, { ...init, tls: { rejectUnauthorized: false } } as RequestInit);
  }
  return fetch(url, init);
}

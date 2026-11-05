/**
 * Bridge to the `kon-esports` player registry
 * ============================================================================
 *
 * **The player table is NOT duplicated here.** `kon-esports` already has
 * `esports_players` with alias, avatar, bio and socials; Broadcast queries it and
 * keeps a snapshot of what goes on air (see `BroadcastSide`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why a DYNAMIC import and not a normal dependency
 *
 * A static `import` of `@kitsuden/kon-esports` would pull its schema into
 * Broadcast's build graph, and then Broadcast would stop working without it.
 * That breaks the plugin model: a small event may want only the
 * overlay, without the whole tournament module.
 *
 * With a dynamic import, Broadcast works ON ITS OWN (you type gamertags by hand) and
 * **gains** autocomplete when `kon-esports` is enabled. Its absence
 * is a normal case, not an error — which is why an explicit result is returned
 * instead of throwing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** What Broadcast needs from a player. Deliberately minimal. */
export interface RosterPlayer {
  id: string;
  /** Gamertag. En `esports_players` se llama `alias`. */
  name: string;
  /** ISO alpha-2 country, if the record has one. */
  country: string | null;
  avatarId?: string | null;
  /** Socials JSON exactly as esports stores it. */
  socialLinks?: string | null;
}

export type RosterLookup =
  | { available: true; player: RosterPlayer }
  | { available: true; player: null } // the kon is there, but that player does not exist
  | { available: false; reason: string }; // the kon is not enabled

/** Loaded esports module, or `null` if it is not available. */
type EsportsModule = {
  players: unknown;
} | null;

let cached: EsportsModule | undefined;

/**
 * Loads the esports schema once.
 *
 * The result is cached INCLUDING the failure: if the kon is not installed, there
 * is no point retrying the import on every panel request.
 */
async function loadEsports(): Promise<EsportsModule> {
  if (cached !== undefined) return cached;
  try {
    const mod = (await import("@kitsuden/kon-esports")) as { players?: unknown };
    cached = mod.players ? { players: mod.players } : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** For tests only: forgets the cached result. */
export function resetRosterCache(): void {
  cached = undefined;
}

/**
 * Looks up a player in the esports registry.
 *
 * `db` is received as a parameter (the kon's executor) so the query
 * respects the transaction and RLS of the current request.
 */
export async function lookupPlayer(
  db: {
    select: () => {
      from: (t: unknown) => { where: (c: unknown) => { limit: (n: number) => Promise<unknown[]> } };
    };
  },
  playerId: string
): Promise<RosterLookup> {
  const esports = await loadEsports();
  if (!esports) {
    return {
      available: false,
      reason:
        "The kon 'kon-esports' is not enabled. Enable it to link players from the registry, " +
        "or type the gamertag by hand.",
    };
  }

  const { eq } = await import("drizzle-orm");
  const players = esports.players as { id: unknown };

  const rows = await db
    .select()
    .from(players)
    .where(eq(players.id as never, playerId))
    .limit(1);

  const row = rows[0] as
    | {
        id: string;
        alias: string;
        country?: string | null;
        avatarId?: string | null;
        socialLinks?: string | null;
      }
    | undefined;

  if (!row) return { available: true, player: null };

  return {
    available: true,
    player: {
      id: row.id,
      // `alias` in esports is the gamertag that Broadcast paints as `name`.
      name: row.alias,
      country: row.country ?? null,
      avatarId: row.avatarId ?? null,
      socialLinks: row.socialLinks ?? null,
    },
  };
}

/**
 * Applies a registry player to one side of the scoreboard.
 *
 * Fills in `playerId` and `name`, and **keeps what is specific to the set**: the
 * score, the character duo and the losers side do not come from the player's
 * record — they belong to this particular set. `sponsor` is also respected if the
 * operator already typed it, because a player can change teams between
 * tournaments and the record may be out of date.
 */
export function applyPlayerToSide<
  T extends { playerId: string | null; name: string; sponsor: string; country?: string | null },
>(side: T, player: RosterPlayer, options: { overwriteSponsor?: boolean } = {}): T {
  return {
    ...side,
    playerId: player.id,
    name: player.name,
    // The country comes from the record when linking; after that it is a snapshot of the set.
    country: player.country ?? side.country ?? null,
    sponsor: options.overwriteSponsor ? "" : side.sponsor,
  };
}

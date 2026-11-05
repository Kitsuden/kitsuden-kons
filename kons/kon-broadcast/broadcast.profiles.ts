/**
 * Game profiles — classification and variants
 * ============================================================================
 *
 * The axis of decomposition is NOT "one kon per game". If it were, every game
 * would duplicate the set lifecycle, the synchronized state, the serving of
 * graphics, the panel and the player linking.
 *
 * The right axis is **what really changes**:
 *
 *   - **Classification** → changes the BEHAVIOR at runtime. A 1v1 with
 *     manual entry and a 5v5 with draft and telemetry are not the same program.
 *     Each classification is a module in `classifications/` (versus, doubles,
 *     team, crew). There used to be four kons and they were merged: they contributed neither tables
 *     nor routes, and all four wrote to THIS same registry.
 *
 *   - **Profile** → changes only the SHAPE OF THE DATA. 2XKO carries a character duo,
 *     SF6 a single one, Tekken one with a rank. It is the same program with another
 *     schema. Each profile is DATA, registered by its classification kon.
 *
 * This works because `side_a` and `side_b` in `broadcast_matches` are already `jsonb`:
 * the storage is already polymorphic. What was FGC-specific was the TypeScript
 * type, not the table. The profile contributes the Zod schema that validates that
 * payload.
 *
 * A profile can come from a third party without touching Broadcast: it contributes its schema, its
 * graphic and its panel, and the last two are already loaded at runtime by the
 * artifact mechanism.
 */

import { z, type ZodType } from "zod";

// ── Contract ─────────────────────────────────────────────────────────────────

/**
 * How a matchup is composed. It is what the classification kon decides
 * and what makes the graphic and the panel different.
 */
export type MatchShape =
  /** Two sides, ONE competitor per side. FGC, chess, 1v1 in general. */
  | "duel"
  /** Two sides, SEVERAL competitors per side. MOBA, team FPS. */
  | "team"
  /** N participants without sides. Battle royale, races. Not yet implemented. */
  | "freeforall";

export interface GameProfile<S = unknown> {
  /** Stable game id: `2xko`, `sf6`, `lol`. */
  id: string;
  /** Classification kon that contributes it: `versus`, `team`. */
  classification: string;
  name: string;
  shape: MatchShape;

  /**
   * Schema of ONE side's payload. This is the profile's real contract: what is
   * validated before writing to the jsonb and before broadcasting to the overlay.
   */
  sideSchema: ZodType<S>;

  /** Defaults when creating a set with this profile. */
  defaults: {
    firstTo: number;
    /** Competitors per side. 1 in a duel, 5 in LoL. */
    rosterSize: number;
  };

  /**
   * Terminology for the interface. A generic panel that says "character" in
   * LoL or "champion" in Tekken stands out, and in production it stands out a lot.
   */
  labels: {
    /** "character", "champion", "agent". */
    pick: string;
    picks: string;
    /** "player", "team". */
    competitor: string;
    /** "set", "series", "game". */
    bout: string;
  };

  /** Graphic that serves this profile, relative to the package that provides it. */
  graphics?: { konId: string; src: string };
  /** Operator panel, as a Web Component. */
  panel?: { konId: string; element: string; src: string };
}

export type ProfileValidation<S> =
  | { ok: true; value: S }
  | { ok: false; error: string; issues?: unknown };

// ── Registry ─────────────────────────────────────────────────────────────────

const registry = new Map<string, GameProfile<unknown>>();

/**
 * Registers a profile. Called by the classification kons in their `onStartup`.
 *
 * Overriding is allowed on purpose: a deployment may want to tweak the
 * 2XKO profile without forking the kon. What is NOT allowed is registering a
 * profile without a classification or without a schema — that is a programming
 * error and must fail at startup, not on the first live set.
 */
export function registerGameProfile<S>(profile: GameProfile<S>): void {
  if (!profile.id || !profile.classification) {
    throw new Error("[broadcast] a game profile needs `id` and `classification`");
  }
  if (!profile.sideSchema) {
    throw new Error(`[broadcast] profile "${profile.id}" does not declare \`sideSchema\``);
  }
  registry.set(profile.id, profile as GameProfile<unknown>);
}

export function getGameProfile(id: string): GameProfile<unknown> | null {
  return registry.get(id) ?? null;
}

/** Available profiles, optionally filtered by classification. */
export function listGameProfiles(classification?: string): GameProfile<unknown>[] {
  const all = [...registry.values()];
  return classification ? all.filter((p) => p.classification === classification) : all;
}

/** Classifications with at least one registered profile. */
export function listClassifications(): string[] {
  return [...new Set([...registry.values()].map((p) => p.classification))];
}

/** Empties the registry. For tests. */
export function resetGameProfiles(): void {
  registry.clear();
  registerBuiltinProfiles();
}

// ── Series profile ───────────────────────────────────────────────────────────

/**
 * Generic duel. Provided by **Broadcast**, not by a classification.
 *
 * It lives here for two reasons, and both matter:
 *
 *   1. **Broadcast has to work on its own.** If the only profile came from
 *      the `versus` classification, a deployment that only wants the overlay
 *      would end up with no registered profile and the deny-by-default validation
 *      would reject even the first set. Broadcasting with no classifications
 *      installed is a valid way to use it.
 *   2. **No grimoire should pin a specific game as the default.** With a
 *      generic one available, the configuration can say "1v1" instead of
 *      having the TO pick the wrong game.
 *
 * One pick per side is the common minimum: games with no selection leave it empty.
 */
export const GENERIC_DUEL_PROFILE_ID = "1v1";

const genericDuelSide = z.object({
  playerId: z.string().nullable().optional(),
  participantId: z.string().nullable().optional(),
  /** ISO alpha-2, uppercase. The flag is derived from this in the graphic. */
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional(),
  sponsor: z.string().max(20).default(""),
  name: z.string().min(1).max(40),
  chars: z.array(z.string().min(1).max(40)).max(1).default([]),
  score: z.number().int().min(0).max(99).default(0),
  losers: z.boolean().default(false),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#00d2a8"),
});

function registerBuiltinProfiles(): void {
  registerGameProfile({
    id: GENERIC_DUEL_PROFILE_ID,
    classification: "versus",
    name: "Generic 1v1",
    shape: "duel",
    sideSchema: genericDuelSide,
    // FT2 is the most common pool format; FT3 is a finals decision.
    defaults: { firstTo: 2, rosterSize: 1 },
    labels: {
      pick: "character",
      picks: "characters",
      competitor: "player",
      bout: "set",
    },
    graphics: { konId: "kon-broadcast", src: "./graphics/overlay.html" },
    panel: {
      konId: "kon-broadcast",
      element: "broadcast-scoreboard",
      src: "./admin/scoreboard.js",
    },
  });
}

registerBuiltinProfiles();

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validates one side's payload against its profile.
 *
 * **Deny-by-default:** an unknown profile does NOT let the payload through. The
 * alternative —accepting anything when the profile is not recognized— would
 * mean a misspelled id in the configuration disables validation entirely
 * and nobody finds out until the overlay paints garbage live.
 */
export function validateSide<S = unknown>(
  profileId: string,
  payload: unknown
): ProfileValidation<S> {
  const profile = registry.get(profileId);
  if (!profile) {
    return {
      ok: false,
      error:
        `Game profile "${profileId}" is unknown. ` +
        `Registered: ${[...registry.keys()].join(", ") || "none"}. ` +
        `Is the kon for its classification enabled?`,
    };
  }

  const result = profile.sideSchema.safeParse(payload);
  if (!result.success) {
    return {
      ok: false,
      error: `The payload does not match profile "${profileId}"`,
      issues: result.error.issues,
    };
  }
  return { ok: true, value: result.data as S };
}

/**
 * Effective profile of a set.
 *
 * Resolved with explicit precedence: the set's value wins over the grimoire's,
 * and the grimoire's over the default. Without this, changing the global
 * configuration would rewrite the profile of existing sets — and with it, the
 * shape of their payload.
 */
export function resolveProfileId(input: {
  matchProfileId?: string | null;
  configuredProfileId?: string | null;
  fallback?: string;
}): string | null {
  return input.matchProfileId || input.configuredProfileId || input.fallback || null;
}

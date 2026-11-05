import {
  repo,
  can,
  defineSyncedState,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import { type KonContext, konSetting } from "@kitsuden/shared";
import { z } from "zod";

import { checkReportable, fetchPairing, reportToBracket } from "./broadcast.bracket.js";
import "./broadcast.policy.js"; // registers the "broadcast" policy
import { CLASSIFICATIONS, DEFAULT_CLASSIFICATIONS } from "./classifications/index.js";
import { getGameProfile, resolveProfileId, validateSide } from "./broadcast.profiles.js";
import { applyPlayerToSide, lookupPlayer } from "./broadcast.roster.js";
import {
  broadcastMatches,
  broadcastChampions,
  defaultSide,
  DEFAULT_SCREENS,
  DEFAULT_THEME,
  firstToFromBestOf,
  type BroadcastSide,
  type BroadcastMatch,
  type NewBroadcastMatch,
} from "./broadcast.schema.js";
import { EXPLANATION, KON_ID, requiresSection, resolveSections } from "./broadcast.sections.js";
import { liveOperations, republishGames } from "./live/routes.js";
import { ANY_ACCOUNT, registry, onTheSet } from "./operations.js";

// ── FormRequests: declarative validation with Zod ────────────────────────────

/**
 * The SHAPE of a side is not validated here: the set's game profile provides it.
 *
 * This schema only checks that an object arrives. Fixing the fields in the route
 * is what tied the kon to a single game —`chars` with a maximum of 2 was the
 * 2XKO rule— and made it impossible for a third party to provide a profile without touching this
 * file. The real validation happens in the handler, against `sideSchema`.
 */
const LooseSide = z.record(z.string(), z.unknown());

const CasterSchema = z.object({ name: z.string(), handle: z.string() });

/** Six-digit hex colors: that is what the graphic understands. */
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const ThemeSchema = z.object({
  accent: Hex.default(DEFAULT_THEME.accent),
  surface: Hex.default(DEFAULT_THEME.surface),
  surfaceOpacity: z.number().min(0).max(1).default(DEFAULT_THEME.surfaceOpacity),
  corners: z.enum(["sharp", "soft"]).default(DEFAULT_THEME.corners),
  fontFamily: z.string().max(80).nullable().default(null),
});

const SponsorSchema = z.object({
  name: z.string().min(1).max(60),
  logoUrl: z.string().url().nullable().default(null),
});

const CreateMatch = z.object({
  eventTitle: z.string().min(1).optional(),
  round: z.string().min(1).optional(),
  firstTo: z.number().int().min(1).max(9).optional(),
  /**
   * Alternative to `firstTo`, in the way people say it. They are NOT the
   * same number —a Bo3 is won on reaching 2— so it is converted in a
   * single place instead of letting every caller compute it.
   */
  bestOf: z
    .number()
    .int()
    .refine((v) => [1, 3, 5, 7, 9].includes(v), { message: "bestOf must be 1, 3, 5, 7 or 9" })
    .optional(),
  theme: ThemeSchema.optional(),
  sponsors: z.array(SponsorSchema).max(8).optional(),
  /** ISO 8601. Feeds the pre-match countdown. */
  startsAt: z.string().datetime().nullable().optional(),
  fearless: z.enum(["off", "global", "team"]).optional(),
  /** The set's game profile. If missing, the one configured by the grimoire is used. */
  profileId: z.string().min(1).optional(),
  sideA: LooseSide.optional(),
  sideB: LooseSide.optional(),
  casters: z.array(CasterSchema).max(4).optional(),
  startggSetId: z.string().optional(),
});

const UpdateMatch = CreateMatch.partial().extend({
  /**
   * On air. `true` sets `status: "live"` and `live: true` (and takes the operator's other live
   * set off air: one per operator); `false` takes it off air (`status: "draft"`). A reported set
   * cannot go back on air (409). A live set is visible to every signed-in account.
   */
  live: z.boolean().optional(),
});

/** Builds a scoreboard set from a bracket pairing. */
const FromSet = z.object({
  /** uuid from kon-esports (like the playerId of BindPlayer). */
  tournamentId: z.guid(),
  /** Engine id: `W2M1`, `L3M2`, `GF`. */
  bracketMatchId: z.string().min(1),
  eventTitle: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  firstTo: z.number().int().min(1).max(9).optional(),
  bestOf: z
    .number()
    .int()
    .refine((v) => [1, 3, 5, 7, 9].includes(v), { message: "bestOf must be 1, 3, 5, 7 or 9" })
    .optional(),
  fearless: z.enum(["off", "global", "team"]).optional(),
});

/**
 * Character roster load.
 *
 * Fighting games have no public portrait CDN, so the deployment
 * provides them. It is accepted in bulk because that is how a roster arrives.
 */
const ImportChampions = z.object({
  champions: z
    .array(
      z.object({
        /** Stable slug: it is the idempotency key and what matches `chars`. */
        slug: z
          .string()
          .min(1)
          .max(40)
          .regex(/^[a-z0-9-]+$/, "the slug must be lowercase, with no spaces"),
        name: z.string().min(1).max(60),
        season: z.number().int().min(1).max(99).optional(),
        portraitUrl: z.string().url().nullable().optional(),
        sortOrder: z.number().int().min(0).max(999).optional(),
      })
    )
    .min(1)
    .max(200),
  /** Empties the roster before loading. To switch games without mixing. */
  replace: z.boolean().optional(),
});

/** Closes the set and returns the result to the bracket. */
const ReportSet = z.object({
  /**
   * DQ: disqualified participant. Loses the set even if the score says anything
   * else —a no-show is recorded with a zero score—.
   */
  dqParticipantId: z.guid().optional(),
  /** Full DQ: besides losing, they are out of the tournament. */
  eliminate: z.boolean().optional(),
});

/** Top banner. `null` removes it. */
const TickerUpdate = z.object({
  text: z.string().min(1).max(140).nullable(),
});

/** Score: relative delta (`+1`/`-1`) or absolute value. */
const ScoreUpdate = z
  .object({
    side: z.enum(["a", "b"]),
    delta: z.number().int().optional(),
    value: z.number().int().min(0).optional(),
  })
  .refine((v) => v.delta !== undefined || v.value !== undefined, {
    message: "`delta` or `value` is required",
  });

/** On-air screens: pre-set versus, K.O. banner, lower third. */
const ScreensUpdate = z.object({
  ko: z.boolean().optional(),
  versus: z.boolean().optional(),
  casters: z.boolean().optional(),
  /** Set result: who won and how. It is left up after the K.O. */
  result: z.boolean().optional(),
});

/** Links a side to a player from the `kon-esports` registry. */
const BindPlayer = z.object({
  side: z.enum(["a", "b"]),
  /** `null` unlinks and keeps the hand-typed name. */
  // kon-esports ids are uuids: any other value reached the WHERE and Postgres
  // returned 22P02 → 500 (phase D). Now it is a 422 naming the field.
  playerId: z.guid().nullable(),
  /** Also bring the sponsor from the record, overwriting what was typed. */
  overwriteSponsor: z.boolean().optional(),
});

// ── Outputs and parameters (OpenAPI and MCP) ─────────────────────────────────
//
// Loose on purpose (`passthrough`): a set stores its sides in the shape of
// its game profile, which each classification provides.

export const ParamId = z.object({ id: z.string().describe("Set id (broadcast match)") });

export const SetOut = z
  .object({
    id: z.string(),
    eventTitle: z.string(),
    round: z.string(),
    firstTo: z.number().int(),
    profileId: z.string().nullable(),
    status: z.string(),
    sideA: z.record(z.string(), z.unknown()),
    sideB: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const OverlayOut = z.object({
  data: z.record(z.string(), z.unknown()),
  channel: z.string(),
  revision: z.number(),
});

// ── Operations ───────────────────────────────────────────────────────────────

/**
 * Profile used when nobody has chosen one.
 *
 * It is a generic duel, not a specific game: a default with a proper name
 * meant that anyone who did not touch the configuration ended up broadcasting with the
 * terminology and pick count of ANOTHER game.
 */
const FALLBACK_PROFILE = "1v1";

export function broadcastOperations(ctx: KonContext): AnyOperation[] {
  const app = registry();
  const db = ctx.db.instance;

  /** What the active grimoire declares as this deployment's profile. */
  const configuredProfileId = konSetting<string>(ctx, KON_ID, "gameProfile");

  /**
   * Which parts of Broadcast are turned on in this installation.
   *
   * Resolved ONCE at mount time and not per request: mounting routes is a
   * startup concern, and rereading it on every call would give a kon that changes shape
   * in the middle of a broadcast.
   */
  const sections = resolveSections(ctx, (m) => ctx.logger.info(m));
  const requires = (section: Parameters<typeof requiresSection>[1]) => requiresSection(sections, section);

  /** Effective profile of a set: its own, the grimoire's, or the generic one. */
  const profileOf = (match: { profileId?: string | null } | null) =>
    resolveProfileId({
      matchProfileId: match?.profileId,
      configuredProfileId,
      fallback: FALLBACK_PROFILE,
    }) as string;

  /**
   * Validates a WHOLE side after merging the patch onto what was already there.
   *
   * The result is validated and not the patch because a patch is always
   * incomplete —touching the sponsor does not resend the name— and validating it on its own
   * would reject legitimate changes. Merging first also avoids the opposite
   * failure: accepting a patch that leaves the side in an invalid state.
   */
  const mergeSide = (
    profileId: string,
    current: BroadcastSide,
    patch: Record<string, unknown> | undefined
  ): { ok: true; value: BroadcastSide } | { ok: false; error: string; issues?: unknown } => {
    if (!patch) return { ok: true, value: current };
    const result = validateSide<BroadcastSide>(profileId, { ...current, ...patch });
    return result.ok ? { ok: true, value: result.value } : result;
  };

  /**
   * Which sections exist and which are turned on.
   *
   * Public and sessionless on purpose: the panel needs it BEFORE knowing who
   * you are to decide which tabs to draw, and it reveals nothing —they are the names
   * of the parts of an open-source kon—.
   *
   * Without this, a panel that offered the draft on an installation with the section
   * turned off would lead to a 404, and a 404 does not say "turn this on".
   */
  app.get(
    "/sections",
    {
      id: "sections",
      summary: "Broadcast sections and game profile",
      description:
        "Which parts of Broadcast are on in this installation (standings, catalog, games, draft, live) with what each one does, and the configured game profile.",
      access: "public",
      output: {
        schema: z.object({
          data: z.array(
            z.object({ id: z.string(), enabled: z.boolean(), description: z.string() })
          ),
          profile: z.string().nullable(),
        }),
      },
    },
    (c) =>
      c.json({
        data: Object.entries(sections).map(([id, enabled]) => ({
          id,
          enabled,
          description: EXPLANATION[id as keyof typeof EXPLANATION],
        })),
        profile: configuredProfileId ?? null,
      })
  );

  // Who reaches each operation is stated by its `access`: the overlay and the roster are
  // READ without a session (OBS opens the Browser Source without cookies, and they expose nothing
  // that is not already on screen); sets and writing the roster require a session.
  // Before, these were two `app.use` calls per prefix (`/matches/*`, `/champions`).

  // ── Overlay (public, read-only) ────────────────────────────────────────────

  app.get(
    "/overlay/:id",
    {
      id: "set-overlay",
      summary: "Overlay state of a set (OBS)",
      description:
        "What the OBS overlay paints for the set (event, players, casters, screens, ticker) and the channel to subscribe to for live updates; `revision` orders the messages.",
      access: "public",
      input: { params: ParamId },
      output: { schema: OverlayOut },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const id = c.req.param("id");
      const match = await repo(broadcastMatches, { db }).find(id);
      if (!match) return c.json({ error: "Not found" }, 404);

      // Snapshot + the channel to subscribe to. From here on the overlay does not
      // ask for anything again: it receives every change over WebSocket. `revision` lets it
      // discard late messages after a reconnection.
      const state = overlayState(id);
      const payload = toOverlayPayload(match);
      if (state.get() === null) await state.set(payload);

      return c.json({
        data: state.get() ?? payload,
        channel: state.channel,
        revision: state.revision,
      });
    }
  );

  // ── Sets ───────────────────────────────────────────────────────────────────

  /**
   * Classification catalog.
   *
   * Returns WHICH classifications exist, not which are active: the selection
   * is stored by the host in the module settings (`PATCH /api/modules/kon-broadcast`),
   * which is where the panel-editable settings already lived.
   *
   * Separating the two is deliberate. The kon knows which classifications it ships —
   * it is its code—; where an operator's choice is persisted is the host's
   * concern, and duplicating that storage here would have created two sources of
   * truth that drift apart as soon as someone edits one.
   *
   * Replaces the four satellite kons: before, "which classifications do I have" was
   * answered by looking at which ones were installed.
   */
  app.get(
    "/classifications",
    {
      id: "classifications",
      summary: "Available standings packs (game profiles)",
      description:
        "The classification packs this kon brings (versus, team, doubles, crew) and the games each adds. 409 when the standings section is off.",
      access: "public",
      before: [requires("standings")],
      output: {
        schema: z.object({
          data: z.array(z.record(z.string(), z.unknown())),
          default: z.array(z.string()),
        }),
      },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      return c.json({
        data: CLASSIFICATIONS.map((classification) => ({
          id: classification.id,
          name: classification.name,
          description: classification.description,
          // How many games it provides: that is what makes enabling it or not tangible.
          games: classification.profiles.map((p) => ({ id: p.id, name: p.name ?? p.id })),
        })),
        default: DEFAULT_CLASSIFICATIONS,
      });
    }
  );

  app.get(
    "/matches",
    {
      id: "list-sets",
      summary: "List broadcast sets",
      description: "Your sets (and the live ones), newest first, 20 per page.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: {
        query: z.object({ page: z.string().optional().describe("1-based page") }).passthrough(),
      },
      output: { schema: z.object({ docs: z.array(SetOut) }).passthrough() },
    },
    async (c) => {
      const page = Number(c.req.query("page")) || 1;
      const result = await repo(broadcastMatches, { db }).orderBy("-createdAt").paginate(page, 20);

      /**
       * The list goes through the SAME rule as `GET /matches/:id`.
       *
       * Before, it returned every set to any session (sign-up is public):
       * other operators' sets, ones not yet on air, with their
       * `ownerId`, the tournament and the start.gg set. Viewing one by id already required
       * `view`; listing them did not.
       */
      const user = (c.get("user") ?? null) as AuthzUser | null;
      const docs = [];
      for (const match of result.docs) {
        if (await can(user, "view", match, "broadcast")) docs.push(match);
      }
      return c.json({ ...result, docs });
    }
  );

  app.get(
    "/matches/:id",
    {
      id: "get-set",
      summary: "Read a broadcast set",
      description:
        "One set with both sides, screens, theme, sponsors and casters. Someone else's set is a 404.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId },
      output: { schema: z.object({ data: SetOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const match = await repo(broadcastMatches, { db }).find(c.req.param("id"));
      const user = (c.get("user") ?? null) as AuthzUser | null;
      // 404 (not 403) so the existence of the resource is not leaked.
      if (!match || !(await can(user, "view", match, "broadcast"))) {
        return c.json({ error: "Not found" }, 404);
      }
      return c.json({ data: match });
    }
  );

  app.post(
    "/matches",
    {
      id: "create-set",
      summary: "Create a broadcast set",
      description:
        "Creates a set for the scoreboard overlay: event, round, best-of (`bestOf`) or first-to, game profile, sides (validated against the profile), theme, sponsors, casters. Returns the set and its overlay channel. Admin/editor, or an agent with broadcast:create.",
      access: "session",
      permission: onTheSet("create"),
      input: { body: CreateMatch },
      output: { status: 201, schema: z.object({ data: SetOut, channel: z.string() }) },
    },
    async (c, input, h) => {
      const user = (c.get("user") ?? null) as AuthzUser | null;
      if (!(await h.can({}))) {
        return c.json({ error: "Forbidden" }, 403);
      }
      const data = input.body as z.infer<typeof CreateMatch>;

      const profileId = profileOf({ profileId: data.profileId });
      const profile = getGameProfile(profileId);
      if (!profile) {
        // Deny-by-default: an unknown profile cannot create a set. Letting it
        // through would mean an overlay with data its graphic does not know how to paint.
        return c.json(
          {
            error: `Game profile "${profileId}" is unknown. Is the kon for its classification enabled?`,
          },
          400
        );
      }

      const a = mergeSide(profileId, defaultSide("PLAYER 1", "#00d2a8"), data.sideA);
      const b = mergeSide(profileId, defaultSide("PLAYER 2", "#ff5c72"), data.sideB);
      if (!a.ok) return c.json({ error: a.error, issues: a.issues }, 422);
      if (!b.ok) return c.json({ error: b.error, issues: b.issues }, 422);

      const match = await repo(broadcastMatches, { db }).create({
        eventTitle: data.eventTitle ?? "TOURNAMENT",
        round: data.round ?? "Winners Finals",
        // The default format comes from the profile: FT2 in pools for most
        // games, FT3 where that is how it is played. Before, it was a fixed 3 for everyone.
        // `bestOf` wins if present: it is what people type. The conversion is
        // in a single place so nobody stores a 3 where a 2 belonged.
        firstTo:
          data.bestOf !== undefined
            ? firstToFromBestOf(data.bestOf)
            : (data.firstTo ?? profile.defaults.firstTo),
        profileId,
        sideA: a.value,
        sideB: b.value,
        casters: data.casters ?? [],
        screens: { ...DEFAULT_SCREENS },
        theme: data.theme ?? { ...DEFAULT_THEME },
        sponsors: data.sponsors ?? [],
        startsAt: data.startsAt ? new Date(data.startsAt) : null,
        fearless: data.fearless ?? "off",
        startggSetId: data.startggSetId ?? null,
        ownerId: user?.id ?? null,
      });

      await publishOverlay(match);
      return c.json({ data: match, channel: overlayStateKey(match.id) }, 201);
    }
  );

  app.patch(
    "/matches/:id",
    {
      id: "update-set",
      summary: "Edit a broadcast set",
      description:
        "Updates event, round, format, theme, sponsors, casters or sides (merged over the current ones and validated against the profile). `live: true` puts the set on air (status `live`, visible to every signed-in account; the owner's other live set goes off air), `live: false` takes it off (status `draft`). The game profile cannot change (409); a reported set cannot go on air (409). Owner or admin; someone else's set is a 404.",
      access: "session",
      permission: onTheSet("update"),
      input: { params: ParamId, body: UpdateMatch },
      output: { schema: z.object({ data: SetOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const id = c.req.param("id");
      const match = await repo(broadcastMatches, { db }).find(id);
      if (!match || !(await h.can(match, "update"))) {
        return c.json({ error: "Not found" }, 404);
      }
      const data = input.body as z.infer<typeof UpdateMatch>;

      // A set's profile is NOT changed via PATCH: it would reinterpret the payload already
      // stored with another schema. Switching games means creating another set.
      if (data.profileId && data.profileId !== match.profileId) {
        return c.json(
          {
            error:
              "A set's game profile cannot be changed. Create a new set with the profile you want.",
          },
          409
        );
      }

      // Sides arrive partial: they are merged onto the existing JSON so as not to
      // lose the character selection when touching only the sponsor, for example.
      // The merge is validated as a whole against the set's profile.
      const profileId = profileOf(match);
      const a = mergeSide(profileId, match.sideA, data.sideA);
      const b = mergeSide(profileId, match.sideB, data.sideB);
      if (!a.ok) return c.json({ error: a.error, issues: a.issues }, 422);
      if (!b.ok) return c.json({ error: b.error, issues: b.issues }, 422);

      /**
       * `bestOf` and `startsAt` must NOT go in the `...data`: the first is not the
       * column —it has to be converted— and the second arrives as ISO text where the
       * column expects a date. Slipping them in as-is stored a `firstTo` of 3
       * where a 2 belonged, which makes the match close one game early.
       */
      const { bestOf, startsAt, live, ...rest } = data;

      // On air / off air: `status` and the `live` flag move together. A reported set is closed.
      if (live === true && match.status === "reported") {
        return c.json({ error: "A reported set cannot go back on air" }, 409);
      }
      const onAir =
        live === true
          ? { status: "live", live: true }
          : live === false && match.status === "live"
            ? { status: "draft", live: false }
            : live === false
              ? { live: false }
              : {};
      if (live === true && match.ownerId) {
        // One set on air per operator (the `live` column's rule).
        const others = await repo(broadcastMatches, { db })
          .filter({ ownerId: match.ownerId, live: true })
          .all();
        for (const other of others) {
          if (other.id === id) continue;
          const [off] = await repo(broadcastMatches, { db })
            .filter({ id: other.id })
            .update({
              live: false,
              ...(other.status === "live" ? { status: "draft" } : {}),
              updatedAt: new Date(),
            });
          if (off) await publishOverlay(off);
        }
      }

      const patch: Partial<NewBroadcastMatch> = {
        ...rest,
        ...onAir,
        profileId: match.profileId,
        sideA: a.value,
        sideB: b.value,
        ...(bestOf !== undefined ? { firstTo: firstToFromBestOf(bestOf) } : {}),
        ...(startsAt !== undefined ? { startsAt: startsAt ? new Date(startsAt) : null } : {}),
        updatedAt: new Date(),
      } as Partial<NewBroadcastMatch>;

      const [updated] = await repo(broadcastMatches, { db }).filter({ id }).update(patch);
      await publishOverlay(updated);
      // Theme, sponsors, casters and score are also painted in the graphic
      // of each game: without this, changing a team's color left the
      // already-open overlays with the old color until they reconnected.
      await republishGames(ctx, updated, sections);
      return c.json({ data: updated });
    }
  );

  app.delete(
    "/matches/:id",
    {
      id: "delete-set",
      summary: "Delete a broadcast set",
      description: "Deletes a set. Admin only; otherwise a 404.",
      access: "session",
      permission: onTheSet("delete"),
      input: { params: ParamId },
      output: { schema: z.object({ success: z.literal(true) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, _input, h) => {
      const id = c.req.param("id");
      const match = await repo(broadcastMatches, { db }).find(id);
      if (!match || !(await h.can(match, "delete"))) {
        return c.json({ error: "Not found" }, 404);
      }
      await repo(broadcastMatches, { db }).filter({ id }).delete();
      return c.json({ success: true });
    }
  );

  // ── Live operation ─────────────────────────────────────────────────────────

  /** Score: what were the `+` / `−` buttons in the original dashboard. */
  app.post(
    "/matches/:id/score",
    {
      id: "scoreboard",
      summary: "Change the score of a side",
      description:
        "`delta` (+1/-1) or an absolute `value` for side a or b; never below zero. Pushed to the overlay at once. Owner or admin.",
      access: "session",
      permission: onTheSet("update"),
      input: { params: ParamId, body: ScoreUpdate },
      output: { schema: z.object({ data: SetOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const id = c.req.param("id");
      const match = await repo(broadcastMatches, { db }).find(id);
      if (!match || !(await h.can(match, "update"))) {
        return c.json({ error: "Not found" }, 404);
      }

      const { side, delta, value } = input.body as z.infer<typeof ScoreUpdate>;
      const key = side === "a" ? "sideA" : "sideB";
      const current = match[key];
      const next = value !== undefined ? value : current.score + (delta ?? 0);

      const [updated] = await repo(broadcastMatches, { db })
        .filter({ id })
        .update({
          [key]: { ...current, score: Math.max(0, next) },
          updatedAt: new Date(),
        } as Partial<NewBroadcastMatch>);

      await publishOverlay(updated);
      return c.json({ data: updated });
    }
  );

  /** Screens: versus before the set, K.O. when closing it, casters' lower third. */
  app.post(
    "/matches/:id/screens",
    {
      id: "screens",
      summary: "Show or hide overlay screens",
      description:
        "Turns the versus, K.O., casters lower third and result screens on or off. Owner or admin.",
      access: "session",
      permission: onTheSet("update"),
      idempotent: true,
      input: { params: ParamId, body: ScreensUpdate },
      output: { schema: z.object({ data: SetOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const id = c.req.param("id");
      const match = await repo(broadcastMatches, { db }).find(id);
      if (!match || !(await h.can(match, "update"))) {
        return c.json({ error: "Not found" }, 404);
      }
      const data = input.body as z.infer<typeof ScreensUpdate>;

      const [updated] = await repo(broadcastMatches, { db })
        .filter({ id })
        .update({
          screens: { ...match.screens, ...data },
          updatedAt: new Date(),
        } as Partial<NewBroadcastMatch>);

      await publishOverlay(updated);
      return c.json({ data: updated });
    }
  );

  /**
   * Top banner: the notice that rotates while the set continues.
   *
   * It is its own route —and not just another PATCH field— because it is operated
   * live: the message is set and removed without going through side validation,
   * and the panel can give it its own button.
   */
  app.post(
    "/matches/:id/ticker",
    {
      id: "caption",
      summary: "Set or clear the ticker",
      description: "The top ticker text (max 140); `null` removes it. Owner or admin.",
      access: "session",
      permission: onTheSet("update"),
      idempotent: true,
      input: { params: ParamId, body: TickerUpdate },
      output: { schema: z.object({ data: SetOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const id = c.req.param("id");
      const match = await repo(broadcastMatches, { db }).find(id);
      if (!match || !(await h.can(match, "update"))) {
        return c.json({ error: "Not found" }, 404);
      }

      const { text } = input.body as z.infer<typeof TickerUpdate>;
      const [updated] = await repo(broadcastMatches, { db })
        .filter({ id })
        .update({ ticker: text, updatedAt: new Date() } as Partial<NewBroadcastMatch>);

      await publishOverlay(updated);
      return c.json({ data: updated });
    }
  );

  /** Side swap: the change of seats in grand finals. */
  app.post(
    "/matches/:id/swap",
    {
      id: "swap-sides",
      summary: "Swap sides",
      description: "Swaps side A and side B (the grand finals side switch). Owner or admin.",
      access: "session",
      permission: onTheSet("update"),
      input: { params: ParamId },
      output: { schema: z.object({ data: SetOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const id = c.req.param("id");
      const match = await repo(broadcastMatches, { db }).find(id);
      if (!match || !(await h.can(match, "update"))) {
        return c.json({ error: "Not found" }, 404);
      }

      const [updated] = await repo(broadcastMatches, { db })
        .filter({ id })
        .update({
          sideA: match.sideB,
          sideB: match.sideA,
          updatedAt: new Date(),
        } as Partial<NewBroadcastMatch>);

      await publishOverlay(updated);
      return c.json({ data: updated });
    }
  );

  /**
   * Links a side to a player from the esports registry.
   *
   * This removes the real friction of running a tournament: in an FGC scene it is
   * the same players every week, and typing gamertag and sponsor on every set
   * is what makes people abandon an overlay tool.
   *
   * If `kon-esports` is not enabled it responds 409 with an explanation, not
   * a 500: working without a registry is a valid way to use it.
   */
  app.post(
    "/matches/:id/bind",
    {
      id: "link-player",
      summary: "Bind a side to an esports player",
      description:
        "Fills a side from a kon-esports player (gamertag, country, sponsor with `overwriteSponsor`); `playerId: null` unbinds and keeps the typed name. 409 when kon-esports is not available. Owner or admin.",
      access: "session",
      permission: onTheSet("update"),
      idempotent: true,
      input: { params: ParamId, body: BindPlayer },
      output: { schema: z.object({ data: SetOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const id = c.req.param("id");
      const match = await repo(broadcastMatches, { db }).find(id);
      if (!match || !(await h.can(match, "update"))) {
        return c.json({ error: "Not found" }, 404);
      }

      const { side, playerId, overwriteSponsor } = input.body as z.infer<typeof BindPlayer>;
      const key = side === "a" ? "sideA" : "sideB";
      const current = match[key];

      // Unlinking: the name already typed is kept, only the
      // reference is dropped. Deleting it would leave the scoreboard empty on air.
      let nextSide = { ...current, playerId: null as string | null };

      if (playerId) {
        const lookup = await lookupPlayer(db, playerId);
        if (!lookup.available) return c.json({ error: lookup.reason }, 409);
        if (!lookup.player) return c.json({ error: "That player does not exist in the registry" }, 404);
        nextSide = applyPlayerToSide(current, lookup.player, { overwriteSponsor });
      }

      const [updated] = await repo(broadcastMatches, { db })
        .filter({ id })
        .update({ [key]: nextSide, updatedAt: new Date() } as Partial<NewBroadcastMatch>);

      await publishOverlay(updated);
      return c.json({ data: updated });
    }
  );

  // ── Bridge to the bracket ──────────────────────────────────────────────────

  /**
   * Builds a scoreboard set from a bracket pairing.
   *
   * This is the integration that removes real duplicated work: the two names, the
   * round and the losers side come from the bracket, which already has them. Without this, the
   * operator reads the bracket on one screen and types on another.
   */
  app.post(
    "/matches/from-set",
    {
      id: "create-set-from-bracket",
      summary: "Create a broadcast set from a bracket set",
      description:
        "Builds the set from a kon-esports pairing (`tournamentId` + engine id like W2M1): names, round and losers side come from the bracket, so reporting it later advances that bracket. 409 when kon-esports is not available. Admin/editor, or an agent with broadcast:create.",
      access: "session",
      permission: onTheSet("create"),
      input: { body: FromSet },
      output: { status: 201, schema: z.object({ data: SetOut, channel: z.string() }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const user = (c.get("user") ?? null) as AuthzUser | null;
      if (!(await h.can({}))) {
        return c.json({ error: "Forbidden" }, 403);
      }
      const data = input.body as z.infer<typeof FromSet>;

      const profileId = profileOf({ profileId: data.profileId });
      const profile = getGameProfile(profileId);
      if (!profile) {
        return c.json({ error: `Game profile "${profileId}" is unknown` }, 400);
      }

      const pairing = await fetchPairing(db, data.tournamentId, data.bracketMatchId);
      // 409, not 500: working without the tournament module is a valid way to use it.
      if (!pairing.available) return c.json({ error: pairing.reason }, 409);
      if (!pairing.value) return c.json({ error: pairing.reason }, 404);

      const { a, b, round } = pairing.value;

      const seatToSide = (seat: typeof a, fallbackName: string, color: string): BroadcastSide => ({
        ...defaultSide(seat.name || fallbackName, color),
        playerId: seat.playerId,
        participantId: seat.participantId,
        losers: seat.losers,
      });

      const match = await repo(broadcastMatches, { db }).create({
        eventTitle: data.eventTitle ?? "TOURNAMENT",
        round,
        // `bestOf` and `fearless` were accepted in validation and NOT stored:
        // zod let them through, the handler ignored them, and whoever built a Bo5
        // from the bracket found an FT2 with nothing saying so. It is the
        // usual silent failure — validating a field is not using it.
        firstTo:
          data.bestOf !== undefined
            ? firstToFromBestOf(data.bestOf)
            : (data.firstTo ?? profile.defaults.firstTo),
        profileId,
        sideA: seatToSide(a, "TBD", "#00d2a8"),
        sideB: seatToSide(b, "TBD", "#ff5c72"),
        casters: [],
        screens: { ...DEFAULT_SCREENS },
        theme: { ...DEFAULT_THEME },
        sponsors: [],
        fearless: data.fearless ?? "off",
        tournamentId: data.tournamentId,
        bracketMatchId: data.bracketMatchId,
        ownerId: user?.id ?? null,
      });

      await publishOverlay(match);
      return c.json({ data: match, channel: overlayStateKey(match.id) }, 201);
    }
  );

  /**
   * Closes the set and returns the result to the bracket.
   *
   * The winner is NOT sent: it is deduced from the score the operator has already been
   * keeping live. Asking for it again would be asking something the
   * tool already knows, and would open the door to the overlay and the bracket
   * reporting different things for the same set.
   */
  app.post(
    "/matches/:id/report",
    {
      id: "report-to-bracket",
      summary: "Report the set to the bracket",
      description:
        "Closes a set built from the bracket and sends the result: the winner comes from the score already kept live. Optional DQ. 409 if the set was not built from a bracket or is not decided yet. Owner or admin.",
      access: "session",
      permission: onTheSet("update"),
      input: { params: ParamId, body: ReportSet },
      output: { schema: z.object({ data: SetOut, bracket: z.record(z.string(), z.unknown()) }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const id = c.req.param("id");
      const match = await repo(broadcastMatches, { db }).find(id);
      if (!match || !(await h.can(match, "update"))) {
        return c.json({ error: "Not found" }, 404);
      }
      if (!match.tournamentId || !match.bracketMatchId) {
        return c.json({ error: "This set was not built from a bracket" }, 409);
      }

      const data = input.body as z.infer<typeof ReportSet>;
      const check = checkReportable({ a: match.sideA, b: match.sideB, firstTo: match.firstTo });
      if (!check.ok) return c.json({ error: check.reason }, 409);

      const winner = check.winner === "a" ? match.sideA : match.sideB;

      const result = await reportToBracket(db, match.tournamentId, match.bracketMatchId, {
        winnerParticipantId: winner.participantId!,
        dqParticipantId: data.dqParticipantId,
        eliminate: data.eliminate,
        scores: { participant1: match.sideA.score, participant2: match.sideB.score },
      });

      if (!result.available) return c.json({ error: result.reason }, 409);
      if (!result.value) return c.json({ error: result.reason }, 409);

      // The set is left closed on the scoreboard. It is not deleted: VODs still
      // reference it and the TO may want to review what went on air.
      const [updated] = await repo(broadcastMatches, { db })
        .filter({ id })
        .update({ status: "reported", live: false, updatedAt: new Date() });

      await publishOverlay(updated);
      return c.json({
        data: updated,
        bracket: { championId: result.value.championId, complete: result.value.complete },
      });
    }
  );

  // ── Character roster ───────────────────────────────────────────────────────

  app.get(
    "/champions",
    {
      id: "list-characters",
      summary: "Character roster",
      description:
        "The characters (slug, name, portrait) that the overlay paints, in display order. 409 when the catalog section is off.",
      access: "public",
      before: [requires("catalog")],
      output: { schema: z.object({ data: z.array(z.record(z.string(), z.unknown())) }) },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const rows = await repo(broadcastChampions, { db }).orderBy("sortOrder").all();
      return c.json({ data: rows });
    }
  );

  /**
   * Loads or updates the roster.
   *
   * In bulk and not one by one because that is how it is used: a roster arrives whole,
   * from a CSV or a script, and the week's new game adds two characters
   * at once. It is **idempotent by `slug`** — resending the full list after
   * a patch updates the portraits without duplicating anything.
   *
   * Fighting games have no public CDN equivalent to League's Data Dragon,
   * so the images are provided by the deployment. That is why this exists.
   */
  app.post(
    "/champions",
    {
      id: "load-characters",
      summary: "Load the character roster",
      description:
        "Creates or updates characters by `slug` (idempotent: resending the whole list updates portraits without duplicates). `replace: true` empties the roster first. Admin/editor, or an agent with broadcast:create.",
      access: "session",
      permission: onTheSet("create"),
      // `replace` empties the whole roster.
      sensitive: true,
      idempotent: true,
      before: [requires("catalog")],
      input: { body: ImportChampions },
      output: {
        schema: z.object({
          data: z.array(z.record(z.string(), z.unknown())),
          count: z.number().int(),
        }),
      },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      if (!(await h.can({}))) {
        return c.json({ error: "Forbidden" }, 403);
      }

      const { champions, replace } = input.body as z.infer<typeof ImportChampions>;

      // `replace` empties the roster before loading: that is what is wanted when switching
      // games, and without it the characters of two titles would end up mixed.
      if (replace) await repo(broadcastChampions, { db }).filter({}).delete();

      const existing = await repo(broadcastChampions, { db }).all();
      const bySlug = new Map(existing.map((row) => [row.slug, row]));

      const saved = [];
      for (const [index, champ] of champions.entries()) {
        const previous = bySlug.get(champ.slug);
        const values = {
          slug: champ.slug,
          name: champ.name,
          season: champ.season ?? 1,
          portraitUrl: champ.portraitUrl ?? null,
          // Without an explicit order, arrival order is respected: a roster usually comes
          // already sorted the way it should be shown.
          sortOrder: champ.sortOrder ?? index,
        };

        if (previous) {
          const [updated] = await repo(broadcastChampions, { db })
            .filter({ id: previous.id })
            .update(values);
          saved.push(updated);
        } else {
          saved.push(await repo(broadcastChampions, { db }).create(values));
        }
      }

      return c.json({ data: saved, count: saved.length });
    }
  );

  /**
   * Live section: games, draft and ingest.
   *
   * ALWAYS mounted, even when turned off: its routes respond 409 saying what
   * is missing and where to turn it on. Not mounting it would give a 404 indistinguishable from
   * a route that does not exist, and the panel could not explain anything.
   */
  return [...app.ops, ...liveOperations(ctx, sections)];
}

// ── Live state ───────────────────────────────────────────────────────────────

export type OverlayPayload = ReturnType<typeof toOverlayPayload>;

/** Synced state key of a set. The overlay subscribes to this channel. */
export function overlayStateKey(matchId: string): string {
  return `broadcast:match:${matchId}`;
}

/**
 * Synced state of a set's overlay.
 *
 * `persist: false` on purpose: the source of truth is Postgres, and this is the live
 * PROJECTION of what is on screen. Persisting both would be
 * a double write with two truths that end up diverging.
 *
 * Debounce does not apply here either: in a live broadcast, broadcasting late is worse than
 * broadcasting too much.
 */
function overlayState(matchId: string) {
  return defineSyncedState<OverlayPayload | null>(overlayStateKey(matchId), {
    default: null,
    persist: false,
  });
}

/**
 * Publishes the set's state to all subscribed overlays.
 *
 * This is what makes this a competitor to NodeCG and not a REST API:
 * the operator presses `+` and the OBS scoreboard changes, with no polling. It never throws
 * — if the transport is down, the Postgres mutation was already done and the
 * overlay recovers on reconnect by asking for the snapshot.
 */
async function publishOverlay(match: BroadcastMatch): Promise<void> {
  try {
    await overlayState(match.id).set(toOverlayPayload(match));
  } catch {
    // The live broadcast does not go down because the broadcast fails.
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Payload consumed by the OBS overlay. Deliberately does NOT include ownerId,
 * timestamps or the start.gg id: only what is seen goes on screen.
 */
function toOverlayPayload(match: BroadcastMatch) {
  return {
    event: {
      title: match.eventTitle,
      round: match.round,
      firstTo: match.firstTo,
      /**
       * The graphic needs to know which profile the set was created with in order to paint the
       * right number of picks and use the game's terminology. It is the only part
       * of the binding that goes on air: `tournamentId` and `participantId`
       * are for management and do not appear on screen.
       */
      profileId: match.profileId,
    },
    players: { a: match.sideA, b: match.sideB },
    casters: match.casters,
    flags: match.screens,
    ticker: match.ticker ?? null,
  };
}

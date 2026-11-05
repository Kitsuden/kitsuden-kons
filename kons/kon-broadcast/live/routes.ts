/**
 * LIVE section — games, draft and ingest
 * ============================================================================
 *
 * Everything that only exists when a match stores each game
 * separately. It came from `kon-broadcast-moba`, which was an entire kon duplicating the
 * container, the bridge to the bracket and the overlay serving to get here.
 *
 * What is NOT here, on purpose: creating the match, building it from the
 * bracket, reporting it, the scoreboard, the screens and the banner. That is Broadcast's
 * core and works the same with this section turned off.
 *
 * ── THE THREE SUB-SECTIONS ─────────────────────────────────────────────────
 *
 *   · `games` — the per-game row. It is the base of the other two.
 *   · `draft` — turns, bans and Fearless.
 *   · `live`  — live telemetry.
 *
 * They are mounted separately because they are different needs: there are productions with
 * draft and without telemetry (narrated by hand) and ones with telemetry and without draft
 * (a shooter). Mounting all three together would force loading a polling loop
 * against an external service just to paint some bans.
 *
 * ── TWO COORDINATE SYSTEMS ─────────────────────────────────────────────────
 *
 * The match has side A and side B; the game has blue and red, and they are
 * swapped. All the translation lives in `sides.ts`. Here it is only called.
 */

import { repo, can, attemptSql, type AuthzUser, type AnyOperation } from "@kitsuden/engine";
import { defineSyncedState } from "@kitsuden/engine";
import type { OperationContext, KonContext } from "@kitsuden/shared";
import type { Context } from "hono";
import { z } from "zod";

import {
  bestOfFromFirstTo,
  broadcastGames,
  broadcastMatches,
  countdownFor,
  type BroadcastGame,
  type BroadcastMatch,
  type NewBroadcastGame,
  type NewBroadcastMatch,
} from "../broadcast.schema.js";
import { requiresSection, type BroadcastSections } from "../broadcast.sections.js";
import { ANY_ACCOUNT, registry, onTheSet } from "../operations.js";

import { applySelection, emptyDraft, draftedChampions, undoSelection } from "./draft.js";
import { getIngestAdapter, listIngestAdapters, registerIngestAdapter } from "./frame.js";
import { createPushAdapter, clearPushedFrames, receivePushedFrame } from "./ingest.push.js";
import { ingestTokenMatches, issueIngestToken, publicGame } from "./ingest-token.js";
import { buildFrame } from "./ingest.riot.js";
import {
  buildOverlayState,
  gameStateKey,
  getSession,
  startSession,
  stopSession,
  type MatchContext,
  type OverlayState,
} from "./session.js";
import { seriesHistory, sidesOf, toSeriesKeyed, toSideKeyed } from "./sides.js";

// ── Validation ───────────────────────────────────────────────────────────────

const CreateGame = z.object({
  /** Whether the match's side A starts on the blue side of THIS game. */
  sideAFirst: z.boolean().optional(),
  patch: z.string().max(12).optional(),
});

const DraftPick = z.object({
  /** `null` skips the ban. It is different from the turn not having arrived. */
  championId: z.string().min(1).max(40).nullable(),
});

const StartIngest = z.object({
  adapterId: z.string().min(1).optional(),
  intervalMs: z.number().int().min(100).max(5000).optional(),
});

const FinishGame = z.object({
  winner: z.enum(["blue", "red"]),
  duration: z.number().int().min(0).optional(),
});

/** What arrives from the local agent: the RAW payload of Riot's API. */
const PushedFrame = z
  .object({ raw: z.unknown().describe("Raw payload of the Riot Live Client API") })
  .passthrough();

// ── Outputs and parameters ───────────────────────────────────────────────────

const ParamId = z.object({
  id: z.string().describe("Game id (or the set id on /matches/:id/games)"),
});
const ParamGameId = z.object({ gameId: z.string().describe("Game id") });

/** A game, without the ingest token (`publicGame`). */
const GameOut = z
  .object({ id: z.string(), matchId: z.string(), gameNumber: z.number().int() })
  .passthrough();
const Obj = z.record(z.string(), z.unknown());

/** Default adapter: Riot's official one. */
const DEFAULT_ADAPTER = "riot-live-client";

/**
 * Handle of a game's channel.
 *
 * `persist: false` just as in the session: the truth is the game in progress, and
 * persisting the derived state would be a second copy that also arrives late.
 */
function syncedFor(gameId: string) {
  return defineSyncedState<OverlayState | null>(gameStateKey(gameId), {
    default: null,
    persist: false,
  });
}

export function liveOperations(
  ctx: KonContext,
  sections: BroadcastSections
): AnyOperation[] {
  const app = registry();
  const db = ctx.db.instance;
  const background = ctx.db.background ?? (<T>(fn: () => T) => fn());

  /**
   * `/games/*` requires a session (`access: "session"` on each operation), with ONE
   * exception: the local agent's push, which authenticates with its own token
   * because the caller is a process on the user's PC, with no browser or
   * cookies (`access: "publico"`, and the handler checks the token).
   */

  const requires = (section: keyof BroadcastSections) => requiresSection(sections, section);

  // ── Game overlay (public, read-only) ───────────────────────────────────────

  // Consumed by OBS as a Browser Source, with no session.
  app.get(
    "/live/overlay/:gameId",
    {
      id: "game-overlay",
      summary: "Overlay state of a game (OBS)",
      description:
        "What the per-game OBS overlay paints (teams, draft, live stats, countdown) and the channel to subscribe to. 409 when the games section is off.",
      access: "public",
      before: [requires("games")],
      input: { params: ParamGameId },
      output: { schema: z.object({ data: Obj, channel: z.string(), revision: z.number() }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const built = await buildStateFor(c.req.param("gameId"));
      if (!built) return c.json({ error: "Not found" }, 404);

      const { state, synced } = built;
      // If there is a live session, its state wins: it is more recent than what is persisted.
      const live = synced.get();

      return c.json({ data: live ?? state, channel: synced.channel, revision: synced.revision });
    }
  );

  // ── Games ──────────────────────────────────────────────────────────────────

  app.post(
    "/matches/:id/games",
    {
      id: "create-game",
      summary: "Add a game to a set",
      description:
        "Adds the next game of the set (up to its best-of). Sides alternate by default (`sideAFirst` overrides). Returns the game and its overlay channel. Owner or admin; 409 when the set is full or the games section is off.",
      access: "session",
      permission: onTheSet("update"),
      before: [requires("games")],
      input: { params: ParamId, body: CreateGame },
      output: { status: 201, schema: z.object({ data: GameOut, channel: z.string() }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const matchId = c.req.param("id");
      const match = await repo(broadcastMatches, { db }).find(matchId);
      if (!match || !(await h.can(match, "update"))) {
        return c.json({ error: "Not found" }, 404);
      }
      const data = input.body as z.infer<typeof CreateGame>;

      const existing = await repo(broadcastGames, { db }).filter({ matchId }).all();
      const bestOf = bestOfFromFirstTo(match.firstTo);
      if (existing.length >= bestOf) {
        return c.json({ error: `Un Bo${bestOf} does not accept more games` }, 409);
      }

      // By default the sides ALTERNATE: it is what happens in competition, and
      // making it the default saves the mistake of leaving them fixed for the whole set.
      const auto = existing.length % 2 === 0;

      const game = await repo(broadcastGames, { db }).create({
        matchId,
        gameNumber: existing.length + 1,
        sideAFirst: data.sideAFirst ?? auto,
        draft: emptyDraft(),
        drafted: { blue: [], red: [] },
        patch: data.patch ?? null,
        goldSeries: [],
      } as NewBroadcastGame);

      await publishGame(match, game);
      return c.json({ data: publicGame(game), channel: gameStateKey(game.id) }, 201);
    }
  );

  app.get(
    "/matches/:id/games",
    {
      id: "list-games",
      summary: "Games of a set",
      description:
        "The games of the set in order (without ingest tokens). Someone else's set is a 404.",
      access: "session",
      permission: ANY_ACCOUNT,
      before: [requires("games")],
      input: { params: ParamId },
      output: { schema: z.object({ data: z.array(GameOut) }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const matchId = c.req.param("id");
      const match = await repo(broadcastMatches, { db }).find(matchId);
      const user = (c.get("user") ?? null) as AuthzUser | null;
      if (!match || !(await can(user, "view", match, "broadcast"))) {
        return c.json({ error: "Not found" }, 404);
      }
      const games = await repo(broadcastGames, { db })
        .filter({ matchId })
        .orderBy("gameNumber")
        .all();
      return c.json({ data: games.map(publicGame) });
    }
  );

  app.get(
    "/games/:id",
    {
      id: "get-game",
      summary: "Read a game",
      description: "One game (draft, status, winner, snapshot) without its ingest token.",
      access: "session",
      permission: ANY_ACCOUNT,
      before: [requires("games")],
      input: { params: ParamId },
      output: { schema: z.object({ data: GameOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const game = await repo(broadcastGames, { db }).find(c.req.param("id"));
      if (!game) return c.json({ error: "Not found" }, 404);
      const match = await repo(broadcastMatches, { db }).find(game.matchId);
      const user = (c.get("user") ?? null) as AuthzUser | null;
      if (!match || !(await can(user, "view", match, "broadcast"))) {
        return c.json({ error: "Not found" }, 404);
      }
      // Without the ingest token: any session can VIEW a live set.
      return c.json({ data: publicGame(game) });
    }
  );

  // ── Draft ──────────────────────────────────────────────────────────────────

  /**
   * Applies a draft step.
   *
   * Fearless is checked here, on the server, and not in the panel: it is a
   * rule of the FORMAT, and an invalid draft does not invalidate a screen, it invalidates
   * the match. A panel can have a bug or be out of date;
   * this cannot.
   */
  app.post(
    "/games/:id/draft",
    {
      id: "draft-step",
      summary: "Apply a draft step",
      description:
        "Picks or bans `championId` in the current turn (`null` skips a ban). Fearless rules of the set are enforced here (409 with the reason). Owner or admin.",
      access: "session",
      permission: onTheSet("update"),
      before: [requires("draft")],
      input: { params: ParamId, body: DraftPick },
      output: { schema: z.object({ data: GameOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const loaded = await loadGame(c.req.param("id"), c, h);
      if ("error" in loaded) return loaded.error;
      const { game, match } = loaded;

      const { championId } = input.body as z.infer<typeof DraftPick>;
      const state = game.draft ?? emptyDraft();

      const history = await fearlessHistory(match, game);
      const result = applySelection(state, championId, {
        fearless: { mode: match.fearless, history },
      });

      if (!result.ok) return c.json({ error: result.reason }, 409);

      const bySide = draftedChampions(result.state);
      const [updated] = await repo(broadcastGames, { db })
        .filter({ id: game.id })
        .update({
          draft: result.state,
          // It is normalized to MATCH keys when saving: if it were done
          // on reading, every consumer would have to remember to, and one would forget.
          drafted: toSeriesKeyed(bySide, game.sideAFirst),
          updatedAt: new Date(),
        } as Partial<NewBroadcastGame>);

      await publishGame(match, updated);
      return c.json({ data: publicGame(updated) });
    }
  );

  /** Undoes the last step. In a production booth people press the wrong button. */
  app.post(
    "/games/:id/draft/undo",
    {
      id: "undo-draft",
      summary: "Undo the last draft step",
      description: "Reverts the last pick or ban. Owner or admin.",
      access: "session",
      permission: onTheSet("update"),
      before: [requires("draft")],
      input: { params: ParamId },
      output: { schema: z.object({ data: GameOut }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, _input, h) => {
      const loaded = await loadGame(c.req.param("id"), c, h);
      if ("error" in loaded) return loaded.error;
      const { game, match } = loaded;

      const state = undoSelection(game.draft ?? emptyDraft());
      const [updated] = await repo(broadcastGames, { db })
        .filter({ id: game.id })
        .update({
          draft: state,
          drafted: toSeriesKeyed(draftedChampions(state), game.sideAFirst),
          updatedAt: new Date(),
        } as Partial<NewBroadcastGame>);

      await publishGame(match, updated);
      return c.json({ data: publicGame(updated) });
    }
  );

  /** Characters locked by Fearless, per side of THIS game. */
  app.get(
    "/games/:id/fearless",
    {
      id: "game-fearless",
      summary: "Fearless locks of a game",
      description:
        "The Fearless mode of the set and the characters each side of THIS game can no longer pick. Owner or admin.",
      access: "session",
      permission: onTheSet("update"),
      before: [requires("draft")],
      input: { params: ParamId },
      output: { schema: z.object({ data: Obj }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, _input, h) => {
      const loaded = await loadGame(c.req.param("id"), c, h);
      if ("error" in loaded) return loaded.error;
      const { game, match } = loaded;

      const history = await fearlessHistory(match, game);
      return c.json({ data: { mode: match.fearless, locked: history } });
    }
  );

  // ── Ingesta ────────────────────────────────────────────────────────────────

  app.get(
    "/live/adapters",
    {
      id: "ingest-adapters",
      summary: "Live data adapters",
      description:
        "The telemetry sources available (id, name, what each publishes: gold, net worth…).",
      access: "session",
      permission: ANY_ACCOUNT,
      before: [requires("live")],
      output: { schema: z.object({ data: z.array(Obj) }) },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    (c) =>
      c.json({
        data: listIngestAdapters().map((a) => ({
          id: a.id,
          name: a.name,
          capabilities: a.capabilities,
        })),
      })
  );

  app.post(
    "/games/:id/ingest/start",
    {
      id: "start-ingest",
      summary: "Start live telemetry",
      description:
        "Starts polling the adapter (`adapterId`, default the Riot live client; `push` for the local agent) for this game; the overlay updates by itself. Returns warnings about what the source cannot provide. Owner or admin.",
      access: "session",
      permission: onTheSet("update"),
      before: [requires("live")],
      input: { params: ParamId, body: StartIngest },
      output: { schema: Obj },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const loaded = await loadGame(c.req.param("id"), c, h);
      if ("error" in loaded) return loaded.error;
      const { game, match } = loaded;

      const { adapterId, intervalMs } = input.body as z.infer<typeof StartIngest>;
      const id = adapterId ?? DEFAULT_ADAPTER;
      // The push adapter is PER GAME: it is built on the fly if requested,
      // because its mailbox is tied to this specific game.
      const adapter = id === "push" ? createPushAdapter(game.id) : getIngestAdapter(id);
      if (!adapter) {
        return c.json(
          {
            error: `Adapter "${id}" is unknown`,
            available: listIngestAdapters().map((a) => a.id),
          },
          400
        );
      }

      await repo(broadcastGames, { db })
        .filter({ id: game.id })
        .update({
          ingestId: id,
          status: "live",
          startedAt: game.startedAt ?? new Date(),
          updatedAt: new Date(),
        } as Partial<NewBroadcastGame>);

      // The live session keeps beating after this request has responded: its
      // timers and its `onFrame` are created OUTSIDE the request's
      // transaction (which is committed on responding), with the system connection.
      background(() =>
        startSession({
          gameId: game.id,
          adapter,
          intervalMs,
          context: () => buildContext(match, { ...game, status: "live" }),
          // The snapshot is persisted sparingly: it is for recovering after a
          // restart and for the post-game, not a continuous log.
          onFrame: (frame, goldSeries) => {
            void repo(broadcastGames, { db })
              .filter({ id: game.id })
              .update({
                snapshot: frame,
                goldSeries,
                updatedAt: new Date(),
              } as Partial<NewBroadcastGame>)
              .catch(() => {
                /* persisting cannot bring down the broadcast */
              });
          },
        })
      );

      return c.json({
        data: { gameId: game.id, adapter: id, capabilities: adapter.capabilities },
        channel: gameStateKey(game.id),
        // It is warned about in advance, not when the widget is missing live.
        warnings: warningsFor(adapter.capabilities),
      });
    }
  );

  /**
   * Issues an ingest token for the user's local agent.
   *
   * **It is not the user's session.** It goes in a configuration file or on
   * the command line of a process that runs on their PC, so it has to be
   * assumed it can leak: that is why it is tied to ONE game and all it
   * allows is pushing frames to that game. It is revoked by requesting it
   * again.
   */
  app.post(
    "/games/:id/ingest/push-token",
    {
      id: "ingest-token",
      summary: "Issue the local agent token",
      description:
        "Issues the token (shown ONCE) that lets the local agent push frames to THIS game only, with the command to run it. Asking again revokes the previous one. Owner or admin.",
      access: "session",
      permission: onTheSet("update"),
      before: [requires("live")],
      input: { params: ParamId },
      output: { schema: Obj },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, _input, h) => {
      const loaded = await loadGame(c.req.param("id"), c, h);
      if ("error" in loaded) return loaded.error;
      const { game, match } = loaded;

      // The hash is stored; the token is shown here only once.
      const { token, stored } = issueIngestToken();

      // The adapter is registered HERE, with the game id inside: each
      // game has its own mailbox, so two simultaneous ones do not overwrite each other's frames.
      registerIngestAdapter(createPushAdapter(game.id));
      await repo(broadcastGames, { db })
        .filter({ id: game.id })
        .update({ ingestToken: stored, updatedAt: new Date() } as Partial<NewBroadcastGame>);

      return c.json({
        data: {
          token,
          gameId: game.id,
          command: `node agent.mjs --url ${ctx.config.siteUrl} --game ${game.id} --token ${token}`,
        },
        // The agent cannot give what the local API does not publish.
        capabilities: createPushAdapter(game.id).capabilities,
        match: match.id,
      });
    }
  );

  /**
   * Receives a frame from the local agent.
   *
   * Auth by TOKEN, not by session: the caller is a process on the
   * user's PC, with no browser or cookies. That is why this route is exempted in the
   * `/games/*` middleware — see the registration above.
   *
   * It accepts Riot's RAW payload (`raw`) so the agent can be dumb:
   * all the normalization lives here, on the server, where it can be fixed
   * without asking anyone to update an executable.
   */
  app.post(
    "/games/:id/ingest/push",
    {
      id: "push-frame",
      summary: "Push a frame (local agent)",
      description:
        "Receives a raw Riot Live Client payload from the local agent, authenticated by the X-Broadcast-Ingest-Token header (not a session).",
      access: "public",
      mcp: {
        exclude:
          "the local ingest agent authenticates with the per-game ingest token header, not an agent key",
      },
      // The token's 401 comes BEFORE the body (it does not say which games
      // exist), and its 400 "`raw` is missing" is the usual one: the handler validates.
      before: [requires("live")],
      input: { params: ParamId, body: PushedFrame.optional(), validatesHandler: true },
      output: { schema: Obj },
      errors: ["KITSUDEN_E_UNAUTHENTICATED", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const id = c.req.param("id");
      const token = c.req.header("x-broadcast-ingest-token") ?? c.req.header("x-moba-ingest-token");
      if (!token) return c.json({ error: "Missing ingest token" }, 401);

      const game = await repo(broadcastGames, { db }).find(id);
      // Same 401 for a nonexistent game and an incorrect token: distinguishing them
      // would allow probing which ids exist.
      // Comparison in CONSTANT TIME over hashes (`ingest-token.ts`); before it
      // was a `!==` on the plaintext token.
      if (!game || !ingestTokenMatches(token, game.ingestToken)) {
        return c.json({ error: "Invalid ingest token" }, 401);
      }

      const body = (await c.req.json().catch(() => null)) as { raw?: unknown } | null;
      if (!body?.raw) return c.json({ error: "`raw` is missing" }, 400);

      const frame = buildFrame(body.raw as never, "push");
      if (!frame.blue.players.length && !frame.red.players.length) {
        // It is not an error: the agent also pushes during loading.
        return c.json({ accepted: false, reason: "no players in the payload" });
      }

      receivePushedFrame(id, frame, Date.now());
      return c.json({ accepted: true, clock: frame.gameTime });
    }
  );

  app.post(
    "/games/:id/ingest/stop",
    {
      id: "stop-ingest",
      summary: "Stop live telemetry",
      description:
        "Stops the telemetry session of the game and empties its frame inbox. Owner or admin.",
      access: "session",
      permission: onTheSet("update"),
      idempotent: true,
      before: [requires("live")],
      input: { params: ParamId },
      output: { schema: z.object({ success: z.literal(true) }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, _input, h) => {
      const loaded = await loadGame(c.req.param("id"), c, h);
      if ("error" in loaded) return loaded.error;

      stopSession(loaded.game.id);
      // The mailbox is emptied: otherwise, resuming the ingest would pick up an old frame
      // and the overlay would start showing the minute at which it stopped.
      clearPushedFrames(loaded.game.id);
      return c.json({ success: true });
    }
  );

  // ── Closing ────────────────────────────────────────────────────────────────

  /**
   * Closes the game and updates the match's score.
   *
   * The winner arrives by GAME SIDE and is translated to match side
   * before adding: with the sides alternating, adding the side directly would give
   * the point to the wrong side from the second game on.
   */
  app.post(
    "/games/:id/finish",
    {
      id: "close-game",
      summary: "Finish a game",
      description:
        "Closes the game with the winning side of THIS game (blue/red) and adds the point to the right side of the set (sides alternate). Owner or admin.",
      access: "session",
      permission: onTheSet("update"),
      before: [requires("games")],
      input: { params: ParamId, body: FinishGame },
      output: { schema: z.object({ data: z.object({ game: GameOut, match: Obj }) }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input, h) => {
      const loaded = await loadGame(c.req.param("id"), c, h);
      if ("error" in loaded) return loaded.error;
      const { game, match } = loaded;

      const { winner, duration } = input.body as z.infer<typeof FinishGame>;
      stopSession(game.id);

      const [updated] = await repo(broadcastGames, { db })
        .filter({ id: game.id })
        .update({
          winner,
          duration: duration ?? game.snapshot?.gameTime ?? null,
          status: "finished",
          endedAt: new Date(),
          updatedAt: new Date(),
        } as Partial<NewBroadcastGame>);

      const winnerIsSideA = winner === "blue" ? game.sideAFirst : !game.sideAFirst;
      const sideA = { ...match.sideA, score: match.sideA.score + (winnerIsSideA ? 1 : 0) };
      const sideB = { ...match.sideB, score: match.sideB.score + (winnerIsSideA ? 0 : 1) };

      // `firstTo` IS what must be reached; it is not recomputed from `bestOf`,
      // which is the way of saying it and not the threshold.
      const decided = sideA.score >= match.firstTo || sideB.score >= match.firstTo;

      const [next] = await repo(broadcastMatches, { db })
        .filter({ id: match.id })
        .update({
          sideA,
          sideB,
          status: decided ? "finished" : match.status,
          updatedAt: new Date(),
        } as Partial<NewBroadcastMatch>);

      await publishGame(next, updated);
      return c.json({ data: { game: publicGame(updated), match: next } });
    }
  );

  // ── Router helpers ─────────────────────────────────────────────────────────

  /** Loads game + match checking permissions. */
  async function loadGame(
    id: string,
    c: Context,
    h: OperationContext
  ): Promise<{ game: BroadcastGame; match: BroadcastMatch } | { error: Response }> {
    const game = await repo(broadcastGames, { db }).find(id);
    if (!game) return { error: c.json({ error: "Not found" }, 404) };

    const match = await repo(broadcastMatches, { db }).find(game.matchId);
    // The policy (`update`) on the set, plus the SDK scopes.
    if (!match || !(await h.can(match, "update"))) {
      return { error: c.json({ error: "Not found" }, 404) };
    }
    return { game, match };
  }

  /** Fearless history translated to the sides of THIS game. */
  async function fearlessHistory(match: BroadcastMatch, game: BroadcastGame) {
    const previous = (
      await repo(broadcastGames, { db }).filter({ matchId: match.id }).all()
    ).filter((g) => g.gameNumber < game.gameNumber);
    return toSideKeyed(seriesHistory(previous), game.sideAFirst);
  }

  function contextOf(match: BroadcastMatch): MatchContext {
    return {
      title: match.eventTitle,
      stage: match.round,
      bestOf: bestOfFromFirstTo(match.firstTo),
      scoreA: match.sideA.score,
      scoreB: match.sideB.score,
      theme: match.theme,
      sponsors: match.sponsors,
      casters: match.casters,
    };
  }

  function buildContext(match: BroadcastMatch, game: BroadcastGame) {
    return {
      match: contextOf(match),
      // It is recomputed on EVERY publication: it is what makes the countdown
      // advance on its own without the graphic having to know the server's time.
      countdown: countdownFor(match.startsAt ?? null, new Date()),
      gameId: game.id,
      gameNumber: game.gameNumber,
      status: game.status,
      teams: sidesOf(match, game),
      draft: game.draft ?? null,
      winner: (game.winner as "blue" | "red" | null) ?? null,
    };
  }

  /** Broadcasts the state of a game that has NO live ingest session. */
  async function publishGame(match: BroadcastMatch, game: BroadcastGame): Promise<void> {
    try {
      const session = getSession(game.id);
      const frame = session?.latest() ?? game.snapshot ?? null;
      const goldSeries = session?.goldSeries() ?? game.goldSeries ?? [];
      const state = buildOverlayState(frame, { ...buildContext(match, game), goldSeries });
      await syncedFor(game.id).set(state);
    } catch {
      // Broadcasting never brings down the request: the overlay resynchronizes on
      // reconnecting by asking for the snapshot.
    }
  }

  async function buildStateFor(gameId: string) {
    const game = await repo(broadcastGames, { db }).find(gameId);
    if (!game) return null;
    const match = await repo(broadcastMatches, { db }).find(game.matchId);
    if (!match) return null;

    const session = getSession(gameId);
    const state = buildOverlayState(session?.latest() ?? game.snapshot ?? null, {
      ...buildContext(match, game),
      goldSeries: session?.goldSeries() ?? game.goldSeries ?? [],
    });

    return { state, synced: syncedFor(gameId) };
  }

  return app.ops;
}

/**
 * Re-emits all of a match's games after changing common data
 * (theme, sponsors, casters, score).
 *
 * It is exported so the core can call it when editing the container without
 * knowing anything about the subsystem: otherwise, changing a team's color would leave the
 * overlays of already-open games with the old color until they reconnect.
 */
export async function republishGames(
  ctx: KonContext,
  match: BroadcastMatch,
  sections: BroadcastSections
): Promise<void> {
  if (!sections.games) return;
  const db = ctx.db.instance;
  try {
    // In its SAVEPOINT: a failure is swallowed (below), and without it the request's
    // transaction would be left aborted and the mutation that originated it would be lost.
    const games = await attemptSql(
      () => repo(broadcastGames, { db }).filter({ matchId: match.id }).all(),
      []
    );
    for (const game of games) {
      const session = getSession(game.id);
      const state = buildOverlayState(session?.latest() ?? game.snapshot ?? null, {
        match: {
          title: match.eventTitle,
          stage: match.round,
          bestOf: bestOfFromFirstTo(match.firstTo),
          scoreA: match.sideA.score,
          scoreB: match.sideB.score,
          theme: match.theme,
          sponsors: match.sponsors,
          casters: match.casters,
        },
        countdown: countdownFor(match.startsAt ?? null, new Date()),
        gameId: game.id,
        gameNumber: game.gameNumber,
        status: game.status,
        teams: sidesOf(match, game),
        draft: game.draft ?? null,
        winner: (game.winner as "blue" | "red" | null) ?? null,
        goldSeries: session?.goldSeries() ?? game.goldSeries ?? [],
      });
      await syncedFor(game.id).set(state);
    }
  } catch {
    // Same as above: broadcasting cannot bring down the core's request.
  }
}

/**
 * Warnings the panel shows BEFORE starting, not when a widget is missing.
 *
 * The nuance matters: without gold but WITH net worth, the overlay still gives an
 * exact number —the price of what they carry—, which is also what is
 * compared live. Saying only "there is no gold" would make people think there is nothing.
 */
function warningsFor(capabilities: { gold: boolean; netWorth: boolean }): string[] {
  if (capabilities.gold) return [];
  if (capabilities.netWorth) {
    return [
      "This source does not publish gold on hand (Riot omits it in spectator mode), " +
        "but it does publish the inventory with prices: the overlay will show NET WORTH, which is exact.",
    ];
  }
  return [
    "This source publishes neither gold nor inventory. The lead will be shown as estimated " +
      "from minions, kills and objectives, and marked as such.",
  ];
}

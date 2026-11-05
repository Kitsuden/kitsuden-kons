import { defineKonSdk, operationsRouter } from "@kitsuden/engine";
import type { KonContext, KonDefinition } from "@kitsuden/shared";
import type { Hono } from "hono";

import { broadcastOperations } from "./broadcast.routes.js";
import { KON_ID } from "./broadcast.sections.js";
import { registerClassifications } from "./classifications/index.js";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

export * from "./broadcast.schema.js";
export * from "./broadcast.profiles.js";
export * from "./broadcast.roster.js";
export * from "./broadcast.bracket.js";
export * from "./broadcast.sections.js";
export * from "./classifications/index.js";

// ── Live section ─────────────────────────────────────────────────────────────
// It came from `kon-broadcast-moba`, which has been removed: it was an entire kon
// duplicating the container, the bridge to the bracket and the overlay serving in order
// to get to this. It is re-exported so anyone who used it still has it.
export * from "./live/draft.js";
export * from "./live/frame.js";
export * from "./live/gold.js";
export * from "./live/objectives.js";
export * from "./live/session.js";
export * from "./live/sides.js";
export * from "./live/stats.js";
export * from "./live/ingest.riot.js";

export function createKonBroadcast(ctx: KonContext): Hono {
  // The profiles of the four classifications are registered when building the
  // router, which is when the kon really comes into play.
  //
  // Before, they came from four satellite kons (`-crew`, `-doubles`, `-team`,
  // `-versus`) that contributed neither tables nor routes: they only called
  // `registerGameProfile` on THIS registry. See classifications/index.ts.
  // WITHOUT an argument: all four are registered.
  //
  // The profile registry is a catalog, not a list of what is enabled.
  // Having them all inside is exactly what happened with the four satellite
  // kons installed, so this changes nobody's behavior.
  //
  // Which classifications the interface OFFERS is decided in
  // `GET /api/broadcast/classifications`, which reads the saved settings. It is
  // separated on purpose: filtering here would force rebuilding the router in order to
  // change a setting, and the router is built only once at startup.
  registerClassifications();

  return operationsRouter(KON_ID, broadcastOperations(ctx), ctx);
}

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`broadcastOperations`), with its OpenAPI, its MCP tool and its fine-grained scope.
 * `createRouter` is the usual one because it registers the classifications first.
 */
const definition = defineKonSdk({
  id: KON_ID,
  name: "Broadcast",
  version: manifest.version,
  description:
    "Broadcast graphics for tournaments: scoreboard, versus, K.O. and casters. Multi-game through profiles.",
  icon: "Tv",
  mountPath: "/api/broadcast",
  operations: (ctx: KonContext) => broadcastOperations(ctx),

  tables: konTables,

  // kon.json `admin` is the one list of admin views; the definition copies it. The `element`
  // views are framework-agnostic Web Components the admin loads at runtime from `admin/*.js`.
  // The live booth always appears (the manifest is static); the panel itself asks
  // `GET /sections` and says what to turn on when its section is off.
  admin: {
    category: manifest.admin.category as "content",
    views: manifest.admin.views.map((v) => ({
      id: v.id,
      type: v.type as "grid" | "element",
      title: v.title,
      ...("table" in v ? { table: v.table } : {}),
      ...("element" in v ? { element: v.element, src: v.src } : {}),
    })),
  },

  /**
   * `kon-esports` is OPTIONAL, not required.
   *
   * The bracket bridge imports it dynamically and the kon works without it —the
   * scoreboard is typed by hand, which is what half of productions do—. It was
   * declared as a hard dependency, so an overlay-only deployment was
   * forced to install the whole tournament kon. The `broadcast.bracket.ts` file itself
   * says so: "working without kon-esports … and gains the bracket
   * when it is there".
   *
   * It stays in `kons: []` and the optionality is documented in `kon.json`
   * (`optionalDependencies`), which is where the manifest schema
   * declares it. It is NOT added to the `defineKon` type: today nobody reads that field at
   * runtime, and a field nobody consumes is a promise that is not kept.
   */
  dependencies: {
    kons: [],
    core: ["auth"],
  },

  hooks: {
    onStartup: async (ctx) => {
      // Registers the kon's emails in the shared Mailer. From
      // here on, `emailQueue.add("broadcast.match-scheduled", data)` works from
      // any part of the app — the host does not need to know anything.
      const { mail } = await import("@kitsuden/engine");
      const { registerBroadcastMails } = await import("./broadcast.mails.js");
      registerBroadcastMails(mail);

      /**
       * Riot's official source is always registered, whether the `live` section is
       * turned on or not: registering it only declares that it EXISTS. Nothing polls until
       * someone calls `POST /games/:id/ingest/start`, and that route is
       * guarded by the section.
       *
       * Other sources —memory reading, production relay, league feed—
       * are added by whoever has them with `registerIngestAdapter`, without touching the kon.
       */
      const { registerIngestAdapter } = await import("./live/frame.js");
      const { createRiotLiveClientAdapter } = await import("./live/ingest.riot.js");
      registerIngestAdapter(createRiotLiveClientAdapter());

      ctx.logger.info("🎬 Broadcast kon initialized — overlay at /api/broadcast/overlay/:id");
    },
    onEnable: async (ctx) => {
      ctx.logger.info("✅ Broadcast kon enabled");
    },
    onDisable: async (ctx) => {
      // Without this, the ingest loops would keep reading the Riot client
      // after the kon is shut down.
      const { stopAllSessions } = await import("./live/session.js");
      stopAllSessions();
      ctx.logger.info("🛑 Broadcast kon disabled — ingestion stopped");
    },
  },
});

export const kon: KonDefinition = { ...definition, createRouter: createKonBroadcast };

export default kon;

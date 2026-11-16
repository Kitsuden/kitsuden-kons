/**
 * @kitsuden/kon-dc — Discord bots as configuration, not code
 * ============================================================================
 *
 * A bot here is a set of MODULES switched on per server (welcome, autorole, leveling, AI answers,
 * kon announcements…) plus BLUEPRINTS: declarative commands, buttons, selects, modals, live panels and
 * triggers anyone can write, export and import, that run fixed steps and never code.
 *
 *   ┌──────────────┐  signed HTTP (interactions)      ┌─────────────────────────────┐
 *   │   Discord    │ ───────────────────────────────▶│  Kitsuden API + kon-dc      │
 *   │              │◀─────────── REST ───────────────│  (modules, blueprints, DB)  │
 *   │   gateway    │                                  └──────▲──────────────▲───────┘
 *   └──────┬───────┘                    HTTP + agent key     │              │ core bus + agent key
 *          │ WebSocket               ┌───────────────────────┴─────┐  ┌─────┴─────────────────┐
 *          └────────────────────────▶│  gateway/ (Go, ~10 MB RSS)  │  │ other kons (broadcast,│
 *                                     └─────────────────────────────┘  │ blog, shop, esports…) │
 *                                                                      └───────────────────────┘
 *
 * The API never holds the gateway socket: the Go worker does, so restarting or redeploying the API
 * does not drop the bot's session, and a bot made of commands and panels needs no worker at all.
 * The worker identifies with only the intents the switched-on modules need (GET /gateway/config).
 *
 * With other kons it talks both ways, and only through their public faces:
 *   · it LISTENS to their events on the core's bus (`broadcast:match:updated` redraws a panel,
 *     `blog:post:published` is announced) and EMITS its own (`dc:member:joined`, `dc:command:used`,
 *     `dc:blueprint:<name>`…) for them and for the core's actions;
 *   · it CALLS their REST operations with the bot's own agent key, whose scopes are the ceiling.
 *
 * Mount: /api/dc. Version and tables come from kon.json, the one place they are written.
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonContext, KonDefinition } from "@kitsuden/shared";

import manifest from "./kon.json" with { type: "json" };
import { discordSettings } from "./dc.rest";
import { createDcRouter, dcOperations } from "./dc.routes";

// Shared with other kons and apps: the tables, the zod contract, the module SDK and the templates.
export * from "./dc.schema";
export * from "./dc.contract";
export {
  baseVars,
  defineDcModule,
  registerDcModule,
  registeredModules,
  render,
  renderJson,
  evaluate,
  hasPermissions,
  permissionBits,
  StepError,
  type AutocompleteRequest,
  type CommandInvocation,
  type CommandReply,
  type ComponentUse,
  type DcEvent,
  type DcModule,
  type Economy,
  type InteractionPlan,
  type InteractionTarget,
  type ModalSubmit,
  type ModuleKv,
  type ModuleLists,
  type ModulePanels,
  type ModuleRuntime,
  type ModuleSchedule,
  type ModuleScheduler,
  type Reply,
} from "./dc.modules";
export { REWARD_MODULES, levelOf, xpFor } from "./dc.rewards";
export { MODERATION_MODULES, automodRules } from "./dc.moderation";
export { nextRun } from "./dc.engine";
export { createCardKit, rankSvg, walletSvg, leaderboardSvg, statSvg, sharpRenderer, type CardKit, type CardTheme, type PngRenderer } from "./dc.cards";
export { stepCatalog, STEP_CATEGORIES, type StepEntry } from "./dc.catalog";
export { KonCallError, createKitsudenClient, type KitsudenClient } from "./dc.kitsuden";
export { BOOTH_SCOPES, TEMPLATES, buildTemplate, type BlueprintTemplate } from "./dc.templates";
export { verifyInteraction, type MessagePayload, type SlashCommandPayload } from "./dc.rest";
export { registerDcPolicy, isStaff } from "./dc.policy";
export { createDcRouter, dcOperations, KON_ID } from "./dc.routes";

export const kon: KonDefinition = defineKonSdk({
  id: manifest.id,
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  icon: manifest.icon,
  mountPath: manifest.mount.path,
  operations: (ctx: KonContext) => dcOperations(ctx),
  tables: manifest.tables.map((t) => t.name),
  // Discord retries an interaction it did not get an answer to; the worker batches. Both are well
  // under this, which is there for someone hammering the public endpoint without a signature.
  rateLimits: [{ path: "/interactions", limit: 600, window: 60, message: "Too many requests" }],
  // kon.json `admin` is the one list of views. `bot` is the Svelte + tallao panel (admin-src/), built
  // to admin/bot.js and loaded by the admin at runtime as a Web Component.
  admin: {
    category: manifest.admin.category as "tools",
    views: manifest.admin.views.map((v) => ({
      id: v.id,
      type: v.type as "grid" | "element",
      title: v.title,
      ...("table" in v ? { table: v.table } : {}),
      ...("element" in v ? { element: v.element, src: v.src } : {}),
    })),
  },
  dependencies: { kons: [], core: ["auth"] },
  hooks: {
    onStartup: async (ctx) => {
      const s = discordSettings();
      const missing = [
        !s.publicKey && "DISCORD_PUBLIC_KEY (interactions)",
        !s.applicationId && "DISCORD_APPLICATION_ID",
        !s.botToken && "DISCORD_BOT_TOKEN (command sync, roles, messages, panels)",
      ].filter(Boolean);
      if (missing.length) ctx.logger.warn(`⚠️ Discord mounted without ${missing.join(", ")}`);
      else ctx.logger.info("✅ Discord ready");
      if (!s.kitsudenApiUrl || !s.kitsudenApiToken) {
        ctx.logger.info("Discord: DISCORD_KITSUDEN_API_URL/_TOKEN not set; blueprints cannot call other kons");
      }
      if (!ctx.agents) ctx.logger.info("Discord: this host has no agent engine; the AI module answers that it is unavailable");
    },
  },
});

export default kon;

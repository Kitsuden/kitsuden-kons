/**
 * @kitsuden/kon-koe
 * ============================================================================
 *
 * koe (声, "voice"): one inbox for WhatsApp Cloud API, Messenger, Instagram and web chat, built for
 * automation and AI agents first, and for teams that sell and collect over chat.
 *
 * ── HOW IT IS PUT TOGETHER ───────────────────────────────────────────────
 *
 *   in        Meta webhook → signature → stored + queued → koe.inbound.ts (one job per body)
 *   who       koe.states.ts (the state machine: bot, queued, human, snoozed, resolved), applied by
 *             koe.conversations.ts with the row locked; assignment and SLAs there too
 *   out       koe.send.ts: the ONE way out (window, templates, consent, bot silence), then a delivery job
 *   window    koe.window.ts: 24 h, templates, human-agent tag, free entry — computed, never stored
 *   live      koe.realtime.ts (kon:koe:* channels, authorized per conversation) + koe.notify.ts (web push)
 *   media     koe.media.ts (download before URLs expire, voice notes, stickers, quick replies)
 *   bots      koe.bot.ts (flows without AI, or a kon-chat bot through a queue; relay to people)
 *   rules     koe.automation.ts (events, rule steps, campaigns, sequences, sales and collections, sweep)
 *
 * Every queue handler is idempotent: the Postgres queue delivers at least once.
 */

import { defineKonSdk, queue } from "@kitsuden/engine";
import type { KonContext, KonDefinition } from "@kitsuden/shared";

import "./koe.policy.js";
import { aiOperations, processBotReply, processBotTurn } from "./koe.bot.js";
import { automationOperations, koeActionHandlers, koeReports, processAutomation, startSweep } from "./koe.automation.js";
import { dbOf, KON_ID, QUEUES, setKoeContext } from "./koe.common.js";
import { koeEvents } from "./koe.events.js";
import { processWebhook } from "./koe.inbound.js";
import { processMedia, mediaOperations } from "./koe.media.js";
import { processNotify } from "./koe.notify.js";
import { inboxOperations, markReadOnChannel } from "./koe.ops.inbox.js";
import { setupOperations } from "./koe.ops.setup.js";
import { webOperations } from "./koe.ops.web.js";
import { quickReplyOperations } from "./koe.quickreplies.js";
import { registerRealtime } from "./koe.realtime.js";
import { deliver } from "./koe.send.js";
import { registry } from "./operations.js";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

export * from "./koe.schema.js";
export { transition, TRANSITIONS, botMaySpeak } from "./koe.states.js";
export { checkWindow, windowOf, POLICIES } from "./koe.window.js";
export { send } from "./koe.send.js";
export { applyMessage, applyEvent, receiveWebhook, processWebhook } from "./koe.inbound.js";

const MODULES = [inboxOperations, setupOperations, mediaOperations, quickReplyOperations, aiOperations, automationOperations, webOperations];

export function koeOperations(ctx: KonContext) {
  setKoeContext(ctx);
  const app = registry();
  for (const add of MODULES) add(app, ctx);
  return app.ops;
}

/** Queue handlers; registered at startup and by the tests. */
export function registerKoeQueues(ctx: KonContext): void {
  setKoeContext(ctx);
  queue.handle(QUEUES.inbound, (job) => processWebhook(ctx, job as never), { concurrency: 4 });
  queue.handle(
    QUEUES.outbound,
    async (job) => {
      if (job.name === "read") {
        const p = job.payload as { conversationId: string; externalId: string };
        return markReadOnChannel(ctx, dbOf(ctx), p.conversationId, p.externalId);
      }
      return deliver(ctx, job as never);
    },
    { concurrency: 8 }
  );
  queue.handle(QUEUES.media, (job) => processMedia(ctx, job as never), { concurrency: 2 });
  queue.handle(QUEUES.bot, (job) => processBotTurn(ctx, job as never), { concurrency: 4 });
  queue.handle(QUEUES.botReplies, (job) => processBotReply(ctx, job as never), { concurrency: 4 });
  queue.handle(QUEUES.notify, (job) => processNotify(ctx, job as never), { concurrency: 4 });
  queue.handle(QUEUES.automation, (job) => processAutomation(ctx, job as never), { concurrency: 2 });
}

export const kon: KonDefinition = defineKonSdk({
  id: KON_ID,
  name: "koe",
  version: manifest.version,
  description: manifest.description,
  icon: "MessagesSquare",
  mountPath: manifest.mount.path,
  operations: (ctx: KonContext) => koeOperations(ctx),
  tables: konTables,

  // Meta retries webhooks for days: a generous limit, failing open. The web chat widget is anyone's.
  rateLimits: [
    { path: "/webhooks/*", limit: 1200, window: 60 },
    { path: "/public/webchat/*", limit: 60, window: 60, message: "Too many messages. Try again in a minute." },
  ],

  // Groups of tools for agents (`kon:koe/<group>`): a model picks better among ten than among a hundred.
  mcpToolsets: {
    inbox: [
      "list-conversations",
      "count-conversations",
      "get-conversation",
      "list-messages",
      "conversation-window",
      "send-message",
      "handoff-conversation",
      "add-note",
      "list-notes",
      "resolve-conversation",
      "get-contact",
      "list-templates",
      "list-quick-replies",
      "send-quick-reply",
      "copilot-draft-reply",
      "copilot-summarize-conversation",
      "copilot-translate",
    ],
    supervisor: ["list-conversations", "count-conversations", "assign-conversation", "transfer-conversation", "list-members", "list-teams", "conversation-history"],
  },

  events: koeEvents,
  actionHandlers: koeActionHandlers,
  reports: koeReports,
  secretColumns: [
    { table: "koe_channels", column: "access_token" },
    { table: "koe_channels", column: "app_secret" },
    { table: "koe_config", column: "private_secret", idColumn: "key" },
  ],

  admin: {
    category: "tools",
    views: [{ id: "koe", type: "element", title: "koe", element: "koe-admin", src: "admin/koe-admin.js" }],
  },

  dependencies: { kons: [], core: ["auth"] },

  hooks: {
    onStartup: async (ctx) => {
      registerRealtime(ctx);
      registerKoeQueues(ctx);
      startSweep(ctx);
      ctx.logger.info(ctx.secrets ? "✅ koe ready" : "⚠️ koe mounted without a secrets key: Meta channels cannot be connected (web chat works)");
    },
  },
});

export default kon;

/** The router the manifest names (`mount.router`). */
export function createKonKoe(ctx: KonContext) {
  return kon.createRouter(ctx);
}

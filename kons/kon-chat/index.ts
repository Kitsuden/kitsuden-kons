/**
 * @kitsuden/kon-chat
 * ============================================================================
 *
 * Chatbots in minutes, over the agents the core already runs. A bot is a channel to one agent identity: the
 * agent brings the model, the prompt and the permissions; the bot adds who may talk to it, what it knows and
 * which tools it may touch.
 *
 * ── TWO KINDS OF QUESTION, TWO WAYS TO ANSWER ──────────────────────────────
 *
 *   - "What does the contract say?", "how do refunds work?": text an admin gave the bot. It is cut into chunks
 *     and searched before answering (chat.knowledge.ts).
 *   - "What stage is the Acme deal in?", "how many open deals do we have?": live data. It is never copied into
 *     the bot; a team bot reads it with tools (`kon:crm/assistant`), with its agent's access, at the moment of
 *     asking, so the answer is exact and nobody reads more than they may.
 *
 * ── PUBLIC BOTS NEVER HAVE TOOLS ───────────────────────────────────────────
 *
 * A visitor on a website is anyone. A public bot answers from its knowledge and nothing else: whatever is
 * taught to it, a stranger can read.
 */

import { defineKonSdk, operationsRouter, type AnyOperation } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import type { Hono } from "hono";

import "./chat.policy.js";
import { chatOperations } from "./chat.operations.js";
import { KON_ID } from "./operations.js";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

export * from "./chat.schema.js";
export { chunkText, search } from "./chat.knowledge.js";

export function createKonChat(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, chatOperations(ctx) as AnyOperation[], ctx);
}

export const kon = defineKonSdk({
  id: KON_ID,
  name: "Chat",
  version: manifest.version,
  description: "Chatbots over the core's agents: for the team with tools, or public on a website with what you teach them",
  icon: "MessageCircle",
  mountPath: "/api/chat",
  operations: (ctx: KonContext) => chatOperations(ctx),

  tables: konTables,

  // Visitors with no account: a wide limit per connection, and the kon's own per-visitor and per-bot ones.
  rateLimits: [{ path: "/public/bots/*", limit: 30, window: 60, message: "Too many messages. Try again in a minute." }],

  admin: {
    category: "tools",
    views: [
      {
        id: "chatbots",
        type: "element",
        title: "Chatbots",
        element: "chat-admin",
        src: "admin/chat-admin.js",
      },
    ],
  },

  dependencies: { kons: [], core: ["auth"] },

  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info(ctx.agents ? "✅ Chat ready" : "⚠️ Chat mounted, but this host has no agent engine: bots cannot answer");
    },
  },
});

export default kon;

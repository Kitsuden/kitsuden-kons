/**
 * kon-dc — operations (kon SDK, Kitsuden's docs/kons/README.md)
 * ============================================================================
 *
 *   Configuration (the team)
 *   GET    /api/dc/modules                              modules that can be switched on
 *   GET    /api/dc/guilds                               servers the bot knows
 *   PUT    /api/dc/guilds/:guildId                      register or rename a server
 *   GET    /api/dc/guilds/:guildId/modules              what is on in a server
 *   PUT    /api/dc/guilds/:guildId/modules/:moduleId    switch a module on/off, with settings
 *   GET    /api/dc/guilds/:guildId/commands             the slash commands it should have
 *   POST   /api/dc/guilds/:guildId/commands/sync        push them to Discord
 *   GET    /api/dc/blueprints                           blueprints
 *   POST   /api/dc/blueprints                           create one
 *   GET    /api/dc/blueprints/:id                       one
 *   PATCH  /api/dc/blueprints/:id                       change it
 *   DELETE /api/dc/blueprints/:id                       delete it (and switch it off everywhere)
 *   GET    /api/dc/export                               everything, as one portable file
 *   POST   /api/dc/import                               load such a file
 *   GET    /api/dc/status                               what is configured, URLs, counters
 *   POST   /api/dc/blueprints/validate                  check a definition without saving
 *   GET    /api/dc/templates                            ready-made blueprints
 *   POST   /api/dc/templates/:templateId/install        install one as a draft
 *   GET    /api/dc/guilds/:guildId/panels               live panels in a server
 *   POST   /api/dc/guilds/:guildId/panels               post one
 *   POST   /api/dc/guilds/:guildId/panels/refresh       redraw them now
 *   GET    /api/dc/overview                             totals and the last 30 days (dc.manage.ts)
 *   GET    /api/dc/guilds/:guildId/economy              a currency's ranking
 *   PUT    /api/dc/guilds/:guildId/economy/:userId      give, take or set a balance
 *   POST   /api/dc/guilds/:guildId/import/levels        members' XP from another bot's export
 *   GET    /api/dc/guilds/:guildId/members/:userId      a member's balances, items, activity
 *   GET    /api/dc/guilds/:guildId/activity             activity per day and top members
 *   GET    /api/dc/guilds/:guildId/schedules            work queued for later
 *   DELETE /api/dc/guilds/:guildId/schedules/:id        cancel one
 *
 *   Public, no data
 *   GET    /api/dc/blueprints/schema                    the blueprint format as JSON Schema
 *   GET    /api/dc/contract                             the gateway wire format as JSON Schema
 *
 *   Discord and the gateway worker
 *   POST   /api/dc/interactions                         slash commands (signed by Discord)
 *   GET    /api/dc/gateway/config                       intents and events for the worker
 *   POST   /api/dc/gateway/events                       events from the worker
 *
 * Rules for handlers (they run inside the request's RLS transaction): queries in series; calls to
 * Discord or a model go outside it (the engine's `background`); `asSystem` only after the route has
 * authorized the caller.
 */

import { AppError, defineOperation, isUuid, operationsRouter, type AnyOperation } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "@kitsuden/engine/zod";

import {
  BlueprintDefinition,
  DcExport,
  GatewayConfig,
  GatewayEventBatch,
  GatewayIngestResult,
  DC_EVENTS,
  Snowflake,
  allComponents,
  blueprintJsonSchema,
  gatewayContractJsonSchemas,
} from "./dc.contract";
import { createDcEngine, dcEngineOf, type DcDb, type DcEngineOptions } from "./dc.engine";
import { blueprintModuleId } from "./dc.modules";
// The built-in modules register themselves when imported.
import "./dc.community";
import "./dc.extras";
import "./dc.feeds";
import "./dc.items";
import "./dc.moderation";
import "./dc.profile";
import "./dc.security";
import "./dc.starboard";
import "./dc.stats";
import "./dc.tags";
import "./dc.utilities";
import "./dc.voice";
import "./dc.webhooks";
import "./dc.rewards";
import "./dc.games";
import "./dc.pets";
import "./dc.housing";
import "./dc.achievements";
import "./dc.counting";
import { RESOURCE, registerDcPolicy } from "./dc.policy";
import { discordSettings, verifyInteraction } from "./dc.rest";
import { BLUEPRINT_STATUSES, ITEM_KINDS, ITEM_RARITIES, dcBlueprints, dcGuildModules, dcGuildPlans, dcGuilds, dcItems, dcPanels } from "./dc.schema";
import { blueprintGuide, extractJson, stepCatalog } from "./dc.catalog";
import { extensionTemplates, publicKeysOf, reportStaffAction, runAi, type AiRunner, type StaffAction } from "./dc.extensions";
import { purchaseItem } from "./dc.items";
import { manageOperations } from "./dc.manage";
import {
  PAGE_CSP,
  authorizeUrl,
  discordOAuth,
  memberSecretOf,
  newSession,
  newState,
  pageData,
  pageFiles,
  readSession,
  readState,
  sessionCookie,
  type DiscordUser,
  type MemberPageConfig,
  type OAuthExchange,
} from "./dc.member";
import { TEMPLATES, buildTemplate } from "./dc.templates";

registerDcPolicy();

/** A URL without its trailing slashes (no regex: CodeQL flags `/\/+$/` on input). */
function trimSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

/** The kon's id: part of the fine scope of each operation (`kon:dc:<op>`). */
export const KON_ID = "kon-dc";

/** A real interaction weighs a few KB. */
const MAX_INTERACTION_BYTES = 64_000;

/**
 * What the invite link asks for: what the built-in modules and the blueprint steps use. Never
 * Administrator: a server owner can untick any of these and the steps that need it fail alone.
 *   view channels, send messages, send in threads, create public and private threads, manage
 *   threads, embed links, attach files, read history (to edit its panels), add reactions, manage
 *   messages (delete, pin, purge), manage roles (role menus, rewards), manage nicknames, kick, ban,
 *   moderate members (timeouts), manage server (AutoMod rules).
 */
const BOT_PERMISSIONS = String(
  [10n, 11n, 38n, 35n, 36n, 34n, 14n, 15n, 16n, 6n, 13n, 28n, 27n, 1n, 2n, 40n, 5n].reduce((acc, bit) => acc | (1n << bit), 0n)
);

// ── Schemas: those of the route, the OpenAPI and the MCP tool ─────────────────

const GuildParam = z.object({ guildId: Snowflake.describe("Discord server id") });
const GuildModuleParam = GuildParam.extend({
  moduleId: z.string().min(1).max(60).describe("Module id: a built-in one (see GET /modules: welcome, economy, leveling, giveaways, role-menus, moderation…) or `blueprint-<uuid>`"),
});
const BlueprintParam = z.object({ id: z.string().describe("Blueprint id (uuid; anything else is a 404)") });
/** An optional page: without `limit` a list answers every row, as it always did. */
const OptionalPage = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().describe("Rows per page (1-500). Without it, every row."),
  offset: z.coerce.number().int().min(0).default(0).describe("Rows to skip."),
});
/** Runs a list query whole, or one page of it with `hasMore`. */
async function pageOf<T>(run: (limit: number | undefined, offset: number) => Promise<T[]>, page: { limit?: number; offset: number }) {
  if (page.limit === undefined) return { docs: await run(undefined, page.offset), hasMore: false };
  const rows = await run(page.limit + 1, page.offset);
  return { docs: rows.slice(0, page.limit), hasMore: rows.length > page.limit };
}

const Guild = z.object({
  id: z.string(),
  name: z.string(),
  leftAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});

const ModuleInfo = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  intents: z.number().int(),
  events: z.array(z.string()),
  configSchema: z.record(z.string(), z.unknown()).describe("JSON Schema of the module's settings"),
  panels: z.array(z.string()).describe("Live panels it can post"),
});

const PanelOut = z.object({
  messageId: z.string(),
  guildId: z.string(),
  channelId: z.string(),
  moduleId: z.string(),
  panelId: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  refreshedAt: z.string().datetime({ offset: true }).nullable(),
});

const GuildModuleState = ModuleInfo.extend({
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
});

const SetModule = z.object({
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()).optional().describe("Validated by the module's own schema (see GET /modules)"),
});

const SlashCommand = z.object({
  name: z.string(),
  description: z.string().describe("Empty for context menus"),
  type: z.number().int().describe("1 slash command, 2 user context menu, 3 message context menu"),
  default_member_permissions: z.string().optional().describe("Who sees it by default (permission bitfield)"),
  options: z
    .array(z.object({ name: z.string(), description: z.string(), type: z.number().int(), required: z.boolean().optional() }))
    .optional(),
});

const Blueprint = z.object({
  id: z.guid(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(BLUEPRINT_STATUSES),
  revision: z.number().int(),
  definition: BlueprintDefinition,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

const NewBlueprint = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(BLUEPRINT_STATUSES).optional(),
  definition: BlueprintDefinition,
});
const EditBlueprint = NewBlueprint.partial();

const ItemIn = z.object({
  guildId: Snowflake.nullable().describe("The server; null = a global item every server shows"),
  item: z.string().regex(/^[a-z0-9_-]{1,64}$/).describe("Its id: what inventories and steps name"),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).nullable().optional(),
  emoji: z.string().min(1).max(64).nullable().optional(),
  rarity: z.enum(ITEM_RARITIES).default("common"),
  kind: z.enum(ITEM_KINDS).default("item"),
  imageUrl: z.string().url().max(500).regex(/^https:\/\//, "https only").nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  price: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  currency: z.string().regex(/^[a-z0-9_-]{1,32}$/).default("coins"),
  sellPrice: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  tradeable: z.boolean().default(true),
  stock: z.number().int().min(0).max(10_000_000).nullable().optional(),
  roleId: Snowflake.nullable().optional(),
  dropWeight: z.number().int().min(0).max(10_000).default(1),
  enabled: z.boolean().default(true),
});

const ItemOut = ItemIn.extend({
  id: z.guid(),
  sold: z.number().int(),
  description: z.string().nullable(),
  emoji: z.string().nullable(),
  imageUrl: z.string().nullable(),
  color: z.string().nullable(),
  price: z.number().nullable(),
  sellPrice: z.number().nullable(),
  stock: z.number().nullable(),
  roleId: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

const PlanOut = z.object({
  plan: z.enum(["free", "premium"]),
  until: z.string().nullable(),
  source: z.string().nullable(),
  active: z.boolean().describe("Premium now (the plan, and its date not passed)"),
  premiumModules: z.array(z.string()).describe("Modules only premium servers can switch on (DISCORD_PREMIUM_MODULES)"),
  freeBlueprints: z.number().int().nullable().describe("Blueprints a free server can have on (DISCORD_FREE_BLUEPRINTS)"),
});

const ImportResult = z.object({
  blueprints: z.number().int(),
  guilds: z.number().int(),
  modules: z.number().int(),
  skipped: z.array(z.string()).describe("Modules that do not exist here or whose settings did not validate"),
});

function moduleInfo(
  m: { id: string; name: string; description: string; intents: number; events: string[]; config: z.ZodType; panelIds?: string[]; panelsOf?: (c: never) => string[] },
  config?: Record<string, unknown>
) {
  // Panels that depend on settings (one per role menu) are listed from the server's settings.
  let panels = [...(m.panelIds ?? [])];
  if (m.panelsOf && config) {
    const parsed = m.config.safeParse(config);
    if (parsed.success) panels = [...new Set([...panels, ...m.panelsOf(parsed.data as never)])];
  }
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    intents: m.intents,
    events: [...m.events],
    configSchema: z.toJSONSchema(m.config, { io: "input", unrepresentable: "any" }) as Record<string, unknown>,
    panels,
  };
}

/** The kon's operations, with their injected context. */
export function dcOperations(ctx: KonContext, options: DcEngineOptions = {}): AnyOperation[] {
  const db = ctx.db.instance as DcDb;
  // With the default options, the context's one engine (shared with the gateway worker); tests that
  // inject a clock, a REST client or settings get their own.
  const engine = Object.keys(options).length === 0 ? dcEngineOf(ctx) : createDcEngine(ctx, options);
  const asSystem = <T>(fn: () => Promise<T>): Promise<T> => (ctx.db.asSystem ? ctx.db.asSystem(fn) : fn());
  const team = (action: "view" | "create" | "update" | "delete") => ({ policy: { resource: RESOURCE, action } });

  /** The member page's routes: the page, the Discord login, a server's data, buying. */
  function memberOperations(): AnyOperation[] {
    const settingsNow = () => options.settings?.() ?? discordSettings();
    const exchange = options.oauth ?? discordOAuth;
    const cookies = (header: string | undefined) =>
      Object.fromEntries(
        (header ?? "")
          .split(/;\s*/)
          .filter(Boolean)
          .map((kv) => {
            const raw = kv.slice(kv.indexOf("=") + 1);
            try {
              return [kv.split("=")[0], decodeURIComponent(raw)];
            } catch {
              return [kv.split("=")[0], ""];
            }
          })
      ) as Record<string, string>;
    const secure = (url: string) => url.startsWith("https://");
    const cookie = (name: string, value: string, maxAge: number, url: string) =>
      `${name}=${encodeURIComponent(value)}; Path=/api/dc/member; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(url) ? "; Secure" : ""}`;
    const sessionOf = (c: { req: { header(n: string): string | undefined } }) =>
      readSession(memberSecretOf(settingsNow()), cookies(c.req.header("cookie"))[sessionCookie.name]);
    const NO_MCP = { exclude: "A page and a login for people in a browser, not for agents" } as const;

    return [
      defineOperation({
        id: "member-page",
        method: "GET",
        route: "/member/page/:guildId",
        summary: "The member page (HTML)",
        description: "A server's public page: rankings, the store and, after a Discord login, the member's own stats. 404 unless the server's member-page module is on.",
        access: "public",
        input: { params: GuildParam },
        output: { schema: z.unknown() },
        mcp: NO_MCP,
        handle: async ({ params }, { c }) => {
          const found = await engine.asSystem(() => engine.runtimeOf(params.guildId, "member-page", null));
          if (!found) return c.text("Not found", 404);
          c.header("content-security-policy", PAGE_CSP);
          c.header("x-content-type-options", "nosniff");
          c.header("referrer-policy", "no-referrer");
          return c.html(pageFiles().html);
        },
      }),

      defineOperation({
        id: "member-page-script",
        method: "GET",
        route: "/member/page.js",
        summary: "The member page's script",
        description: "The script of the member page (no data).",
        access: "public",
        output: { type: "text/javascript" },
        mcp: NO_MCP,
        handle: async (_input, { c }) => {
          c.header("content-type", "text/javascript; charset=utf-8");
          c.header("cache-control", "public, max-age=300");
          return c.body(pageFiles().js);
        },
      }),

      defineOperation({
        id: "member-login",
        method: "GET",
        route: "/member/login",
        summary: "Log in with Discord",
        description: "Sends the browser to Discord's login (scope identify) and back to /member/callback. 404 when this installation has no Discord login set up.",
        access: "public",
        input: { query: z.object({ guildId: Snowflake }) },
        output: { status: 302 },
        // Not set up is not an outage (a 503 would tell the browser to retry): there is no login here.
        errors: ["KITSUDEN_E_NOT_FOUND"],
        mcp: NO_MCP,
        handle: async ({ query }, { c }) => {
          const s = settingsNow();
          const secret = memberSecretOf(s);
          if (!secret || !s.clientSecret || !s.oauthRedirectUrl || !s.applicationId) return c.text("The Discord login is not configured here.", 404);
          const { state, nonce } = newState(secret, query.guildId);
          c.header("set-cookie", cookie(sessionCookie.state, nonce, 600, s.oauthRedirectUrl), { append: true });
          return c.redirect(authorizeUrl(s, state), 302);
        },
      }),

      defineOperation({
        id: "member-callback",
        method: "GET",
        route: "/member/callback",
        summary: "Back from Discord's login",
        description: "Checks the state, asks Discord who logged in, and sets the member's session cookie. 404 when this installation has no Discord login set up; 502 when Discord does not complete the login.",
        access: "public",
        input: { query: z.object({ code: z.string().max(200).optional(), state: z.string().max(500).optional(), error: z.string().max(100).optional() }) },
        output: { status: 302 },
        errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_BAD_GATEWAY"],
        mcp: NO_MCP,
        handle: async ({ query }, { c }) => {
          const s = settingsNow();
          const secret = memberSecretOf(s);
          if (!secret || !s.oauthRedirectUrl) return c.text("The Discord login is not configured here.", 404);
          const guildId = readState(secret, query.state, cookies(c.req.header("cookie"))[sessionCookie.state]);
          if (!guildId) return c.text("This login link expired or came from another browser. Try again.", 400);
          const back = `/api/dc/member/page/${guildId}`;
          c.header("set-cookie", cookie(sessionCookie.state, "", 0, s.oauthRedirectUrl), { append: true });
          if (!query.code || query.error) return c.redirect(back, 302);
          let user: DiscordUser;
          try {
            user = await engine.background(() => exchange(query.code!, s));
          } catch (err) {
            ctx.logger.warn("Member page: the Discord login failed", { message: err instanceof Error ? err.message : String(err) });
            return c.text("Discord did not complete the login. Try again.", 502);
          }
          c.header("set-cookie", cookie(sessionCookie.name, newSession(secret, user), 7 * 86_400, s.oauthRedirectUrl), { append: true });
          return c.redirect(back, 302);
        },
      }),

      defineOperation({
        id: "member-logout",
        method: "POST",
        route: "/member/logout",
        summary: "Log out of the member page",
        description: "Clears the member's session cookie.",
        access: "public",
        output: { schema: z.object({ ok: z.boolean() }) },
        mcp: NO_MCP,
        handle: async (_input, { c }) => {
          c.header("set-cookie", cookie(sessionCookie.name, "", 0, settingsNow().oauthRedirectUrl ?? ""), { append: true });
          return { ok: true };
        },
      }),

      defineOperation({
        id: "member-guild",
        method: "GET",
        route: "/member/guilds/:guildId",
        summary: "A server's member page data",
        description: "Rankings (coins, levels, this week's activity), the store, and — with a member session — the member's balances, levels, items and week. Only what the server's member-page module allows; 404 when it is off.",
        access: "public",
        input: { params: GuildParam },
        output: { schema: z.record(z.string(), z.unknown()) },
        mcp: NO_MCP,
        handle: async ({ params }, { c }) => {
          const me = sessionOf(c);
          const data = await engine.asSystem(async () => {
            const found = await engine.runtimeOf(params.guildId, "member-page", me ? { id: me.id, name: me.name, avatar: me.avatar } : null, c.req.header("accept-language") ?? null);
            if (!found) return null;
            return pageData(found.rt, found.config as MemberPageConfig, found.guildName, me);
          });
          if (!data) return c.json({ error: "Not found" }, 404);
          c.header("cache-control", "private, no-store");
          return { ...data, login: !!memberSecretOf(settingsNow()) && !!settingsNow().clientSecret };
        },
      }),

      defineOperation({
        id: "member-buy",
        method: "POST",
        route: "/member/guilds/:guildId/buy",
        summary: "Buy from the member page",
        description: "Buys one of an item of the store for the logged-in member, who must be in the server. JSON only.",
        access: "public",
        input: { params: GuildParam, body: z.object({ item: z.string().regex(/^[a-z0-9_-]{1,64}$/) }) },
        output: { schema: z.object({ ok: z.boolean(), message: z.string() }) },
        // 401 without a member session (the Discord login, not a Kitsuden one); 403 when buying is off or the member left the server.
        errors: ["KITSUDEN_E_UNAUTHENTICATED", "KITSUDEN_E_FORBIDDEN", "KITSUDEN_E_UNSUPPORTED_MEDIA_TYPE"],
        mcp: NO_MCP,
        handle: async ({ params, body }, { c }) => {
          // A form from another site cannot send JSON without a preflight this API refuses.
          if (!(c.req.header("content-type") ?? "").startsWith("application/json")) return c.json({ error: "JSON only" }, 415);
          const me = sessionOf(c);
          if (!me) return c.json({ error: "Log in with Discord first" }, 401);
          const result = await engine.asSystem(async () => {
            const found = await engine.runtimeOf(params.guildId, "member-page", { id: me.id, name: me.name, avatar: me.avatar }, c.req.header("accept-language") ?? null);
            if (!found) return { status: 404 as const };
            const config = found.config as MemberPageConfig;
            if (!config.allowBuying || !config.showStore) return { status: 403 as const, message: "Buying from the page is off in this server." };
            try {
              await found.rt.rest.getMember(params.guildId, me.id);
            } catch {
              return { status: 403 as const, message: "Join the server to buy from its store." };
            }
            const item = await found.rt.catalog.get(body.item);
            if (!item || item.price === null) return { status: 404 as const, message: "There is no such item." };
            return { status: 200 as const, ...(await purchaseItem(item, found.rt)) };
          });
          if (result.status !== 200) return c.json({ error: "message" in result ? result.message : "Not found" }, result.status);
          return { ok: result.ok, message: result.message };
        },
      }),
    ];
  }

  async function guildOr404(guildId: string) {
    const [row] = await db.select().from(dcGuilds).where(eq(dcGuilds.id, guildId)).limit(1);
    if (!row) throw AppError.notFound("Server not found: it registers itself when the bot joins, or with PUT /guilds/:guildId");
    return row;
  }

  async function blueprintOr404(id: string) {
    if (!isUuid(id)) throw AppError.notFound("Blueprint not found");
    const [row] = await db.select().from(dcBlueprints).where(eq(dcBlueprints.id, id)).limit(1);
    if (!row) throw AppError.notFound("Blueprint not found");
    return row;
  }

  /** Who made a change: the session's user, or an agent's key. */
  function actorOf(who: unknown): StaffAction["actor"] {
    const user = (who ?? null) as { id?: string; kind?: string; agentId?: string } | null;
    if (!user) return { id: null, kind: "system" };
    return { id: user.id ?? user.agentId ?? null, kind: user.agentId || user.kind === "agent" ? "agent" : "user" };
  }

  // Writes made by the team (not Discord's interactions, the worker, the member page or checks that save
  // nothing) are told to the extensions once they succeed: an Enterprise audit log hangs here.
  const NOT_STAFF = new Set(["receive-interaction", "ingest-gateway-events", "validate-blueprint", "generate-blueprint"]);
  const reported = (op: AnyOperation): AnyOperation => {
    if (op.method === "GET" || NOT_STAFF.has(op.id) || op.id.startsWith("member-")) return op;
    const handle: AnyOperation["handle"] = async (input, h) => {
      const out = await op.handle(input, h);
      const params = (input.params ?? {}) as Record<string, unknown>;
      await reportStaffAction(
        {
          kind: op.id,
          guildId: typeof params.guildId === "string" ? params.guildId : null,
          actor: actorOf(h.user),
          detail: { params, body: input.body ?? null },
        },
        (m) => ctx.logger.warn(`Discord: ${m}`)
      );
      return out;
    };
    return { ...op, handle };
  };

  return operationList().map(reported);

  function operationList(): AnyOperation[] {
  return [
    // ── Modules and servers ────────────────────────────────────────────────

    defineOperation({
      id: "list-modules",
      method: "GET",
      route: "/modules",
      summary: "List Discord modules",
      description:
        "Every module a server can switch on: the built-in ones (welcome, autorole, ai, announcements, economy, leveling, giveaways, role-menus, reminders, scheduled-messages, suggestions, polls, moderation, automod, logs, tickets) and each published blueprint (`blueprint-<uuid>`), with the JSON Schema of its settings and the gateway intents it needs. Modules switched off for the installation (DISCORD_DISABLED_MODULES) are not listed.",
      access: "session",
      permission: team("view"),
      unpaginated: "The built-in modules this kon ships plus the published blueprints: a catalogue, not data that grows with use.",
      output: { schema: z.object({ docs: z.array(ModuleInfo) }) },
      handle: async () => ({ docs: (await engine.availableModules()).map((m) => moduleInfo(m)) }),
    }),

    defineOperation({
      id: "list-guilds",
      method: "GET",
      route: "/guilds",
      summary: "List Discord servers",
      description:
        "Servers the bot is or was in (`leftAt` set when it left), by name. Without `limit` every server; with `limit` (1-500) and `offset` one page, and `hasMore` says whether another follows.",
      access: "session",
      permission: team("view"),
      input: { query: OptionalPage },
      output: { schema: z.object({ docs: z.array(Guild), hasMore: z.boolean() }) },
      handle: async ({ query }) =>
        pageOf((limit, offset) => {
          const q = db.select().from(dcGuilds).orderBy(asc(dcGuilds.name), asc(dcGuilds.id)).offset(offset);
          return limit === undefined ? q : q.limit(limit);
        }, query),
    }),

    defineOperation({
      id: "register-guild",
      method: "PUT",
      route: "/guilds/:guildId",
      summary: "Register a Discord server",
      description:
        "Adds or renames a server by its id. The gateway worker does this by itself when the bot joins; use it for a bot that runs with slash commands only (no worker).",
      access: "session",
      permission: team("update"),
      input: { params: GuildParam, body: z.object({ name: z.string().trim().min(1).max(100) }) },
      output: { schema: Guild },
      handle: async ({ params, body }) => {
        const [row] = await db
          .insert(dcGuilds)
          .values({ id: params.guildId, name: body.name })
          .onConflictDoUpdate({ target: dcGuilds.id, set: { name: body.name, updatedAt: new Date() } })
          .returning();
        return row;
      },
    }),

    defineOperation({
      id: "list-guild-modules",
      method: "GET",
      route: "/guilds/:guildId/modules",
      summary: "Modules of a Discord server",
      description: "Every available module with whether it is on in this server and its current settings.",
      access: "session",
      permission: team("view"),
      unpaginated: "One row per available module (the built-in catalogue plus published blueprints), whatever the server switched on.",
      input: { params: GuildParam },
      output: { schema: z.object({ docs: z.array(GuildModuleState) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }) => {
        await guildOr404(params.guildId);
        const states = await db.select().from(dcGuildModules).where(eq(dcGuildModules.guildId, params.guildId));
        const byId = new Map(states.map((s) => [s.moduleId, s]));
        const docs = (await engine.availableModules()).map((m) => ({
          ...moduleInfo(m, byId.get(m.id)?.config ?? undefined),
          enabled: byId.get(m.id)?.enabled ?? false,
          config: byId.get(m.id)?.config ?? {},
        }));
        return { docs };
      },
    }),

    defineOperation({
      id: "set-guild-module",
      method: "PUT",
      route: "/guilds/:guildId/modules/:moduleId",
      summary: "Switch a module on or off in a Discord server",
      description:
        "Turns a module on or off in one server and stores its settings, validated by the module's own schema (422 with the problems if they do not fit). Switching a module with slash commands on or off changes the server's commands only after POST /guilds/:guildId/commands/sync.",
      access: "session",
      permission: team("update"),
      input: { params: GuildModuleParam, body: SetModule },
      output: { schema: z.object({ moduleId: z.string(), enabled: z.boolean(), config: z.record(z.string(), z.unknown()) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params, body }) => {
        await guildOr404(params.guildId);
        const module = await engine.moduleById(params.moduleId);
        if (!module) throw AppError.notFound(`Module "${params.moduleId}" does not exist or is switched off here`);
        const parsed = module.config.safeParse(body.config ?? {});
        // Settings are checked even to switch a module off: what is stored must always be readable.
        if (!parsed.success) {
          throw AppError.validation(`Invalid settings for module "${module.id}"`, z.flattenError(parsed.error));
        }
        const config = parsed.data as Record<string, unknown>;
        if (body.enabled) {
          const refusal = await engine.planRefusal(params.guildId, module.id);
          if (refusal) throw AppError.conflict(refusal);
        }
        await db
          .insert(dcGuildModules)
          .values({ guildId: params.guildId, moduleId: module.id, enabled: body.enabled, config })
          .onConflictDoUpdate({
            target: [dcGuildModules.guildId, dcGuildModules.moduleId],
            set: { enabled: body.enabled, config, updatedAt: new Date() },
          });
        engine.forget(params.guildId);
        engine.configure(params.guildId, module.id, body.enabled, config);
        engine.emit(DC_EVENTS.moduleSwitched, { guildId: params.guildId, moduleId: module.id, enabled: body.enabled });
        return { moduleId: module.id, enabled: body.enabled, config };
      },
    }),

    defineOperation({
      id: "get-guild-plan",
      method: "GET",
      route: "/guilds/:guildId/plan",
      summary: "A Discord server's plan",
      description: "Whether the server is on the premium plan (and until when), and which modules this installation keeps for premium servers.",
      access: "session",
      permission: team("view"),
      input: { params: GuildParam },
      output: { schema: PlanOut },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }) => {
        await guildOr404(params.guildId);
        const [row] = await db.select().from(dcGuildPlans).where(eq(dcGuildPlans.guildId, params.guildId)).limit(1);
        const s = options.settings?.() ?? discordSettings();
        return {
          plan: row?.plan ?? "free",
          until: row?.until ? row.until.toISOString() : null,
          source: row?.source ?? null,
          active: await engine.isPremium(params.guildId),
          premiumModules: [...(s.premiumModules ?? [])].sort(),
          freeBlueprints: s.freeBlueprints ?? null,
        };
      },
    }),

    defineOperation({
      id: "set-guild-plan",
      method: "PUT",
      route: "/guilds/:guildId/plan",
      summary: "Set a Discord server's plan",
      description:
        "Puts a server on the premium plan (until a date, or with no end) or back on free. The team does it by hand; a shop kon can do it when an order is paid, with its own key and this operation's scope. Premium modules of a server whose plan ends stop by themselves (their settings stay).",
      access: "session",
      permission: team("update"),
      input: {
        params: GuildParam,
        body: z.object({
          plan: z.enum(["free", "premium"]),
          until: z.string().datetime({ offset: true }).nullable().optional().describe("When premium ends; null or absent = no end"),
          source: z.string().max(100).optional().describe("Where it came from: an order id, \"gift\"…"),
        }),
      },
      output: { schema: PlanOut },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params, body }) => {
        await guildOr404(params.guildId);
        const until = body.until ? new Date(body.until) : null;
        await db
          .insert(dcGuildPlans)
          .values({ guildId: params.guildId, plan: body.plan, until, source: body.source ?? null })
          .onConflictDoUpdate({ target: dcGuildPlans.guildId, set: { plan: body.plan, until, source: body.source ?? null, updatedAt: new Date() } });
        engine.forget(params.guildId);
        engine.emit(DC_EVENTS.planChanged, { guildId: params.guildId, plan: body.plan, until: until?.toISOString() ?? null });
        const s = options.settings?.() ?? discordSettings();
        return {
          plan: body.plan,
          until: until?.toISOString() ?? null,
          source: body.source ?? null,
          active: await engine.isPremium(params.guildId),
          premiumModules: [...(s.premiumModules ?? [])].sort(),
          freeBlueprints: s.freeBlueprints ?? null,
        };
      },
    }),

    defineOperation({
      id: "list-guild-commands",
      method: "GET",
      route: "/guilds/:guildId/commands",
      summary: "Slash commands a Discord server should have",
      description: "The commands of the modules switched on in this server. 409 if two modules declare the same command.",
      access: "session",
      permission: team("view"),
      unpaginated: "The slash commands of one server's active modules, which Discord itself caps per server.",
      input: { params: GuildParam },
      output: { schema: z.object({ docs: z.array(SlashCommand) }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      handle: async ({ params }) => {
        await guildOr404(params.guildId);
        return { docs: await engine.commandsFor(params.guildId) };
      },
    }),

    defineOperation({
      id: "sync-guild-commands",
      method: "POST",
      route: "/guilds/:guildId/commands/sync",
      summary: "Push slash commands to a Discord server",
      description:
        "Replaces the server's slash commands with those of its active modules (server commands update at once). Needs DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN in the API (409 without them, or when two modules clash).",
      access: "session",
      permission: team("update"),
      input: { params: GuildParam },
      output: { schema: z.object({ synced: z.array(SlashCommand) }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      handle: async ({ params }) => {
        await guildOr404(params.guildId);
        return { synced: await engine.syncCommands(params.guildId) };
      },
    }),

    // ── What the admin view manages: overview, economy, members, activity, schedules ──

    ...manageOperations({
      db,
      team,
      now: () => options.now?.() ?? new Date(),
      guildOr404,
      forget: (guildId) => engine.forget(guildId),
      emit: (event, data) => engine.emit(event, data),
    }),

    // ── The member page (public; a server is shown while its "member-page" module is on) ──

    ...memberOperations(),

    // ── The item catalog ───────────────────────────────────────────────────

    defineOperation({
      id: "list-items",
      method: "GET",
      route: "/items",
      summary: "List catalog items",
      description:
        "Items of the catalog: a server's (`guildId`), the global ones (`guildId=global`, shown in every server: profile badges and backgrounds), or all. Sorted by name. Without `limit` every item; with `limit` (1-500) and `offset` one page, and `hasMore` says whether another follows.",
      access: "session",
      permission: team("view"),
      input: { query: OptionalPage.extend({ guildId: z.union([Snowflake, z.literal("global")]).optional().describe("A server id, or `global`") }) },
      output: { schema: z.object({ docs: z.array(ItemOut), hasMore: z.boolean() }) },
      handle: async ({ query }) => {
        const where =
          query.guildId === "global" ? isNull(dcItems.guildId) : query.guildId ? eq(dcItems.guildId, query.guildId) : undefined;
        return pageOf((limit, offset) => {
          const q = db.select().from(dcItems).where(where).orderBy(asc(dcItems.name), asc(dcItems.id)).offset(offset);
          return limit === undefined ? q : q.limit(limit);
        }, query);
      },
    }),

    defineOperation({
      id: "save-item",
      method: "PUT",
      route: "/items",
      summary: "Create or change a catalog item",
      description:
        "Saves an item by its id in a server (`guildId`) or globally (`guildId: null`). Its kind decides what using it does: a consumable is used up (blueprints' `item_used` triggers run), a role item gives `roleId`, badges and backgrounds go on the profile. `price` puts it on sale (global items are paid in credits).",
      access: "session",
      permission: team("update"),
      input: { body: ItemIn },
      output: { schema: ItemOut },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ body }) => {
        if (body.guildId) await guildOr404(body.guildId);
        const sameGuild = body.guildId ? eq(dcItems.guildId, body.guildId) : isNull(dcItems.guildId);
        const [existing] = await db.select({ id: dcItems.id }).from(dcItems).where(and(sameGuild, eq(dcItems.item, body.item))).limit(1);
        const values = { ...body, guildId: body.guildId ?? null, updatedAt: new Date() };
        const [row] = existing
          ? await db.update(dcItems).set(values).where(eq(dcItems.id, existing.id)).returning()
          : await db.insert(dcItems).values(values).returning();
        return row;
      },
    }),

    defineOperation({
      id: "delete-item",
      method: "DELETE",
      route: "/items/:id",
      summary: "Delete a catalog item",
      description: "Removes an item from the catalog. Inventories keep their counts under the id, shown as the bare id until an item with it exists again.",
      access: "session",
      permission: team("delete"),
      input: { params: z.object({ id: z.string() }) },
      output: { status: 204 },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }) => {
        if (!isUuid(params.id)) throw AppError.notFound("Item not found");
        const rows = await db.delete(dcItems).where(eq(dcItems.id, params.id)).returning({ id: dcItems.id });
        if (!rows.length) throw AppError.notFound("Item not found");
        return null;
      },
    }),

    // ── Blueprints ─────────────────────────────────────────────────────────

    defineOperation({
      id: "get-blueprint-schema",
      method: "GET",
      route: "/blueprints/schema",
      summary: "Blueprint format (JSON Schema)",
      description:
        "The JSON Schema of a blueprint definition: slash commands (subcommands, choices, autocomplete), buttons, selects, modals, embeds, live panels and triggers (gateway and other kons' events), made of steps (reply, update_message, send_message, open_modal, add_role, remove_role, kv_increment, kv_set, ai_reply, kon_call, emit_event, post_panel, refresh_panels). Give it to an editor, or to a model asked to write a blueprint. Holds no data.",
      access: "public",
      output: { schema: z.record(z.string(), z.unknown()) },
      handle: async () => blueprintJsonSchema() as Record<string, unknown>,
    }),

    defineOperation({
      id: "get-step-catalog",
      method: "GET",
      route: "/blueprints/steps",
      summary: "Blueprint steps, for editors",
      description:
        "Every step a blueprint can run, with its name, category (Messages, Discord, Rewards, Flow and data, Kons and AI), what it does, a valid example and a form schema (JSON Schema a form can draw; `jsonFields` stay JSON, `numberFields` are typed as text and stored as numbers). Holds no data.",
      access: "public",
      output: { schema: z.object({ docs: z.array(z.record(z.string(), z.unknown())) }) },
      handle: async () => ({ docs: stepCatalog() as unknown as Array<Record<string, unknown>> }),
    }),

    defineOperation({
      id: "generate-blueprint",
      method: "POST",
      route: "/blueprints/generate",
      summary: "Describe a bot, get a blueprint",
      description:
        "Asks one of the core's agents (its model and key; never with tools) to write a blueprint from a description, checks it against the format, and asks once more with the problems when it does not fit. Nothing is saved: the answer is a definition to open in the editor (with the problems, if any are left). 409 when this installation has no agents.",
      access: "session",
      permission: team("create"),
      input: {
        body: z.object({
          prompt: z.string().trim().min(10).max(2000).describe("What the bot should do, in your words"),
          agentId: z.string().min(1).max(100).describe("A core agent identity: its model writes the blueprint"),
        }),
      },
      output: {
        schema: z.object({
          definition: z.record(z.string(), z.unknown()).nullable(),
          problems: z.array(z.object({ path: z.string(), message: z.string() })),
          attempts: z.number().int(),
        }),
      },
      errors: ["KITSUDEN_E_CONFLICT", "KITSUDEN_E_NOT_FOUND"],
      handle: async ({ body }) => {
        if (!ctx.agents) throw AppError.conflict("This installation has no agents: set one up in the core first");
        const core = ctx.agents as unknown as AiRunner;
        // The core throws a plain Error for an unknown or switched-off agent: that is the caller's mistake, not a 500.
        const agents: AiRunner = {
          run: async (request) => {
            try {
              return await core.run(request);
            } catch (err) {
              const message = err instanceof Error ? err.message : "";
              if (message.startsWith("Agent not found")) throw AppError.notFound(`No agent "${body.agentId}"`);
              if (message.startsWith("Agent is inactive")) throw AppError.conflict(`The agent "${body.agentId}" is switched off`);
              throw err;
            }
          },
        };
        const guide = blueprintGuide();
        let message = `Write a kon-dc blueprint for this bot:\n\n${body.prompt}`;
        let problems: Array<{ path: string; message: string }> = [];
        let last: Record<string, unknown> | null = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          // The model runs outside the request's transaction, like every slow call of this kon.
          // An extension may answer with a server's key or credits, or refuse (no credits left).
          const run = await engine.background(() =>
            runAi({ guildId: null, userId: null, purpose: "builder", agentId: body.agentId }, agents, { message, allowedTools: [], context: guide })
          );
          if ("refused" in run) throw AppError.conflict(run.refused);
          const candidate = extractJson(run.text);
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            problems = [{ path: "(answer)", message: "The model did not answer with a JSON object" }];
          } else {
            last = candidate as Record<string, unknown>;
            const parsed = BlueprintDefinition.safeParse(candidate);
            if (parsed.success) return { definition: parsed.data as Record<string, unknown>, problems: [], attempts: attempt };
            problems = parsed.error.issues.map((i) => ({ path: i.path.join(".") || "(definition)", message: i.message }));
          }
          const list = problems
            .slice(0, 20)
            .map((p) => `- ${p.path}: ${p.message}`)
            .join("\n");
          message = `Your blueprint for this bot:\n${body.prompt.slice(0, 1000)}\n\nhas these problems:\n${list}\n\nAnswer again with the whole corrected definition in a json code block.`;
        }
        return { definition: last, problems, attempts: 2 };
      },
    }),

    defineOperation({
      id: "list-blueprints",
      method: "GET",
      route: "/blueprints",
      summary: "List Discord blueprints",
      description:
        "Blueprints, most recently changed first, drafts included. Without `limit` every blueprint; with `limit` (1-500) and `offset` one page, and `hasMore` says whether another follows.",
      access: "session",
      permission: team("view"),
      input: { query: OptionalPage },
      output: { schema: z.object({ docs: z.array(Blueprint), hasMore: z.boolean() }) },
      handle: async ({ query }) =>
        pageOf((limit, offset) => {
          const q = db.select().from(dcBlueprints).orderBy(desc(dcBlueprints.updatedAt), desc(dcBlueprints.id)).offset(offset);
          return limit === undefined ? q : q.limit(limit);
        }, query),
    }),

    defineOperation({
      id: "get-blueprint",
      method: "GET",
      route: "/blueprints/:id",
      summary: "Get a Discord blueprint",
      description: "One blueprint by id.",
      access: "session",
      permission: team("view"),
      input: { params: BlueprintParam },
      output: { schema: Blueprint },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }) => blueprintOr404(params.id),
    }),

    defineOperation({
      id: "create-blueprint",
      method: "POST",
      route: "/blueprints",
      summary: "Create a Discord blueprint",
      description:
        "Creates a blueprint (draft unless status is given). A published blueprint appears as module `blueprint-<id>`, which each server switches on like any other module. The definition is data, validated by GET /blueprints/schema: no code runs.",
      access: "session",
      permission: team("create"),
      input: { body: NewBlueprint },
      output: { status: 201, schema: Blueprint },
      handle: async ({ body }, { user }) => {
        const [row] = await db
          .insert(dcBlueprints)
          .values({
            name: body.name,
            description: body.description ?? null,
            status: body.status ?? "draft",
            definition: body.definition,
            createdBy: user?.id ?? null,
          })
          .returning();
        return row;
      },
    }),

    defineOperation({
      id: "update-blueprint",
      method: "PATCH",
      route: "/blueprints/:id",
      summary: "Change a Discord blueprint",
      description:
        "Changes the given fields. A new definition bumps `revision`. Servers using it run the new version within seconds; new or renamed slash commands need POST /guilds/:guildId/commands/sync.",
      access: "session",
      permission: team("update"),
      input: { params: BlueprintParam, body: EditBlueprint },
      output: { schema: Blueprint },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params, body }) => {
        const row = await blueprintOr404(params.id);
        const [updated] = await db
          .update(dcBlueprints)
          .set({
            ...body,
            revision: body.definition ? row.revision + 1 : row.revision,
            updatedAt: new Date(),
          })
          .where(eq(dcBlueprints.id, row.id))
          .returning();
        engine.forget();
        return updated;
      },
    }),

    defineOperation({
      id: "delete-blueprint",
      method: "DELETE",
      route: "/blueprints/:id",
      summary: "Delete a Discord blueprint",
      description: "Deletes a blueprint and switches it off in every server. Cannot be undone; export first to keep a copy.",
      access: "session",
      permission: team("delete"),
      sensitive: true,
      input: { params: BlueprintParam },
      output: { status: 204 },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }) => {
        const row = await blueprintOr404(params.id);
        await db.delete(dcGuildModules).where(eq(dcGuildModules.moduleId, blueprintModuleId(row.id)));
        await engine.forgetPanelsOf([blueprintModuleId(row.id)]);
        await db.delete(dcBlueprints).where(eq(dcBlueprints.id, row.id));
        engine.forget();
      },
    }),

    // ── Export / import: no lock-in ────────────────────────────────────────

    defineOperation({
      id: "export",
      method: "GET",
      route: "/export",
      summary: "Export the Discord bot",
      description:
        "Every blueprint and every server's modules and settings as one portable JSON file (`kitsuden.dc/export`). Holds no token or key: those stay in the environment.",
      access: "session",
      permission: team("view"),
      output: { schema: DcExport },
      handle: async () => {
        const blueprints = await db.select().from(dcBlueprints).orderBy(asc(dcBlueprints.createdAt));
        const guilds = await db.select().from(dcGuilds).orderBy(asc(dcGuilds.name));
        const modules = await db.select().from(dcGuildModules);
        return {
          kind: "kitsuden.dc/export" as const,
          format: 1 as const,
          exportedAt: new Date().toISOString(),
          blueprints: blueprints.map((b) => ({
            id: b.id,
            name: b.name,
            description: b.description,
            status: b.status,
            revision: b.revision,
            definition: b.definition,
          })),
          guilds: guilds.map((g) => ({
            id: g.id,
            name: g.name,
            modules: modules
              .filter((m) => m.guildId === g.id)
              .map((m) => ({ moduleId: m.moduleId, enabled: m.enabled, config: m.config })),
          })),
        };
      },
    }),

    defineOperation({
      id: "import",
      method: "POST",
      route: "/import",
      summary: "Import a Discord bot export",
      description:
        "Loads a file from GET /export: blueprints by id (overwriting those with the same id), servers, and each server's modules (a module that does not exist here, or whose settings do not validate, is skipped and listed). Run POST /guilds/:guildId/commands/sync afterwards.",
      access: "session",
      permission: team("update"),
      sensitive: true,
      input: { body: DcExport },
      output: { schema: ImportResult },
      handle: async ({ body }) => {
        for (const b of body.blueprints) {
          const values = {
            name: b.name,
            description: b.description,
            status: b.status,
            revision: b.revision,
            definition: b.definition,
            updatedAt: new Date(),
          };
          await db
            .insert(dcBlueprints)
            .values({ id: b.id, ...values })
            .onConflictDoUpdate({ target: dcBlueprints.id, set: values });
        }
        let modules = 0;
        const skipped: string[] = [];
        for (const g of body.guilds) {
          await db
            .insert(dcGuilds)
            .values({ id: g.id, name: g.name })
            .onConflictDoUpdate({ target: dcGuilds.id, set: { name: g.name, updatedAt: new Date() } });
          for (const m of g.modules) {
            const module = await engine.moduleById(m.moduleId);
            const parsed = module?.config.safeParse(m.config);
            if (!module || !parsed?.success) {
              skipped.push(`${g.id}/${m.moduleId}`);
              continue;
            }
            const config = parsed.data as Record<string, unknown>;
            await db
              .insert(dcGuildModules)
              .values({ guildId: g.id, moduleId: module.id, enabled: m.enabled, config })
              .onConflictDoUpdate({
                target: [dcGuildModules.guildId, dcGuildModules.moduleId],
                set: { enabled: m.enabled, config, updatedAt: new Date() },
              });
            modules++;
          }
        }
        engine.forget();
        return { blueprints: body.blueprints.length, guilds: body.guilds.length, modules, skipped };
      },
    }),


    // ── Status, validation, templates and panels (the admin view) ─────────────

    defineOperation({
      id: "get-status",
      method: "GET",
      route: "/status",
      summary: "Discord bot status",
      description:
        "What the installation has configured (booleans only, never a value), the Interactions Endpoint URL to paste in the Developer Portal, the invite link, the modules switched off for the installation, the kon events the bot listens to, and counters since the API started (interactions, gateway events, kon events, dropped work, last batch from the worker).",
      access: "session",
      permission: team("view"),
      output: {
        schema: z.object({
          configured: z.object({
            publicKey: z.boolean(),
            applicationId: z.boolean(),
            botToken: z.boolean(),
            kitsudenApi: z.boolean().describe("DISCORD_KITSUDEN_API_URL and _TOKEN: blueprints can call other kons"),
          }),
          interactionsUrl: z.string(),
          inviteUrl: z.string().nullable(),
          disabledModules: z.array(z.string()),
          stats: z.record(z.string(), z.unknown()),
        }),
      },
      handle: async () => {
        const s = options.settings?.() ?? discordSettings();
        return {
          configured: {
            publicKey: !!s.publicKey,
            applicationId: !!s.applicationId,
            botToken: !!s.botToken,
            kitsudenApi: !!(s.kitsudenApiUrl && s.kitsudenApiToken),
          },
          interactionsUrl: `${trimSlashes(ctx.config?.siteUrl ?? "")}/api/dc/interactions`,
          inviteUrl: s.applicationId
            ? `https://discord.com/oauth2/authorize?client_id=${s.applicationId}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}`
            : null,
          disabledModules: [...s.disabledModules].sort(),
          stats: engine.stats(),
        };
      },
    }),

    defineOperation({
      id: "validate-blueprint",
      method: "POST",
      route: "/blueprints/validate",
      summary: "Check a blueprint definition",
      description:
        "Validates a definition without saving it: `valid`, and each problem with where it is (`path`). For an editor that checks as you type, or an agent before it creates one.",
      access: "session",
      permission: team("view"),
      idempotent: true,
      input: { body: z.object({ definition: z.unknown() }) },
      output: {
        schema: z.object({
          valid: z.boolean(),
          problems: z.array(z.object({ path: z.string(), message: z.string() })),
          summary: z
            .object({ commands: z.number().int(), triggers: z.number().int(), modals: z.number().int(), panels: z.number().int(), components: z.number().int() })
            .nullable(),
        }),
      },
      handle: async ({ body }) => {
        const parsed = BlueprintDefinition.safeParse(body.definition);
        if (!parsed.success) {
          return {
            valid: false,
            problems: parsed.error.issues.map((i) => ({ path: i.path.join(".") || "(definition)", message: i.message })),
            summary: null,
          };
        }
        const d = parsed.data;
        return {
          valid: true,
          problems: [],
          summary: {
            commands: d.commands.length,
            triggers: d.triggers.length,
            modals: d.modals.length,
            panels: d.panels.length,
            components: allComponents(d).length,
          },
        };
      },
    }),

    defineOperation({
      id: "list-templates",
      method: "GET",
      route: "/templates",
      summary: "Blueprint templates",
      description:
        "Ready-made blueprints (broadcast booth, feedback form…) with the JSON Schema of their settings and what they need: other kons, and the scopes the bot's agent key must have for them.",
      access: "session",
      permission: team("view"),
      unpaginated: "The templates this kon and its extensions ship in code: a fixed catalogue.",
      output: {
        schema: z.object({
          docs: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              description: z.string(),
              needs: z.object({ kons: z.array(z.string()), scopes: z.array(z.string()) }),
              optionsSchema: z.record(z.string(), z.unknown()),
            })
          ),
        }),
      },
      handle: async () => ({
        docs: [...TEMPLATES, ...extensionTemplates()].map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          needs: { kons: [...t.needs.kons], scopes: [...t.needs.scopes] },
          optionsSchema: z.toJSONSchema(t.options, { io: "input", unrepresentable: "any" }) as Record<string, unknown>,
        })),
      }),
    }),

    defineOperation({
      id: "install-template",
      method: "POST",
      route: "/templates/:templateId/install",
      summary: "Install a blueprint template",
      description:
        "Creates a DRAFT blueprint from a template and its settings (422 if they do not fit its schema). Publish it, switch it on in a server and sync the commands, as with any blueprint.",
      access: "session",
      permission: team("create"),
      input: {
        params: z.object({ templateId: z.string().max(60) }),
        body: z.object({ name: z.string().trim().min(1).max(100).optional(), options: z.record(z.string(), z.unknown()).optional() }),
      },
      output: { status: 201, schema: Blueprint },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params, body }, { user }) => {
        const template = [...TEMPLATES, ...extensionTemplates()].find((t) => t.id === params.templateId);
        if (!template) throw AppError.notFound("Template not found");
        const opts = template.options.safeParse(body.options ?? {});
        if (!opts.success) throw AppError.validation("Invalid template settings", z.flattenError(opts.error));
        const definition = buildTemplate(template, opts.data);
        const [row] = await db
          .insert(dcBlueprints)
          .values({ name: body.name ?? template.name, description: template.description, status: "draft", definition, createdBy: user?.id ?? null })
          .returning();
        return row;
      },
    }),

    defineOperation({
      id: "list-panels",
      method: "GET",
      route: "/guilds/:guildId/panels",
      summary: "Live panels of a Discord server",
      description: "The messages the bot keeps up to date in this server: channel, message, module, panel and last redraw.",
      access: "session",
      permission: team("view"),
      unpaginated: "The live panels a server's staff posted, a few per server: each is a message the bot redraws.",
      input: { params: GuildParam },
      output: { schema: z.object({ docs: z.array(PanelOut) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }) => {
        await guildOr404(params.guildId);
        return { docs: await db.select().from(dcPanels).where(eq(dcPanels.guildId, params.guildId)).orderBy(desc(dcPanels.createdAt)) };
      },
    }),

    defineOperation({
      id: "post-panel",
      method: "POST",
      route: "/guilds/:guildId/panels",
      summary: "Post a live panel",
      description:
        "Posts one panel of a module switched on in this server (`panels` in GET /guilds/:guildId/modules) in a channel. The bot keeps it up to date: on the kon events the panel names, and after its own buttons.",
      access: "session",
      permission: team("update"),
      input: {
        params: GuildParam,
        body: z.object({ moduleId: z.string().min(1).max(60), panelId: z.string().min(1).max(32), channelId: Snowflake }),
      },
      output: { status: 201, schema: z.object({ messageId: z.string().nullable() }) },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      handle: async ({ params, body }) => {
        await guildOr404(params.guildId);
        return { messageId: await engine.postPanel(params.guildId, body.moduleId, body.panelId, body.channelId) };
      },
    }),

    defineOperation({
      id: "refresh-panels",
      method: "POST",
      route: "/guilds/:guildId/panels/refresh",
      summary: "Redraw live panels",
      description: "Redraws the server's panels now (all, or one module's). Panels that were deleted in Discord are forgotten.",
      access: "session",
      permission: team("update"),
      idempotent: true,
      input: { params: GuildParam, body: z.object({ moduleId: z.string().min(1).max(60).optional() }) },
      output: { schema: z.object({ panels: z.number().int() }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params, body }) => {
        await guildOr404(params.guildId);
        return { panels: await engine.refreshPanels(params.guildId, body.moduleId) };
      },
    }),

    // ── Discord and the gateway worker ─────────────────────────────────────

    defineOperation({
      id: "get-contract",
      method: "GET",
      route: "/contract",
      summary: "Gateway wire format (JSON Schema)",
      description:
        "JSON Schemas of what the gateway worker and this kon exchange (gateway-config, gateway-event-batch, gateway-ingest-result). The Go worker's types are checked against them. Holds no data.",
      access: "public",
      output: { schema: z.record(z.string(), z.unknown()) },
      handle: async () => gatewayContractJsonSchemas(),
    }),

    defineOperation({
      id: "receive-interaction",
      method: "POST",
      route: "/interactions",
      summary: "Receive a Discord interaction",
      description:
        "Discord's Interactions Endpoint URL: verifies the Ed25519 signature over the raw body (401 if invalid), answers PING, and runs the slash commands, autocomplete, buttons, selects and modals of the modules switched on in that server. Public: the signature is the authentication.",
      access: "public",
      // WITHOUT `body`: the signature covers the exact bytes Discord sent.
      output: { schema: z.record(z.string(), z.unknown()) },
      // 404 when no bot is set up here (no public key): there is no endpoint for Discord to call.
      errors: ["KITSUDEN_E_UNAUTHENTICATED", "KITSUDEN_E_PAYLOAD_TOO_LARGE", "KITSUDEN_E_BAD_REQUEST", "KITSUDEN_E_NOT_FOUND"],
      mcp: { exclude: "Called by Discord with a signed raw body, never by an agent" },
      handle: async (_input, { c }) => {
        const settings = options.settings?.() ?? discordSettings();
        const keys = publicKeysOf(settings.publicKey);
        if (!keys.length) return c.json({ error: "DISCORD_PUBLIC_KEY is not set" }, 404);
        if (Number(c.req.header("content-length") ?? "0") > MAX_INTERACTION_BYTES) {
          return c.json({ error: "Payload too large" }, 413);
        }
        const raw = await c.req.text();
        if (raw.length > MAX_INTERACTION_BYTES) return c.json({ error: "Payload too large" }, 413);
        // The installation's bot, or a branded bot an extension knows: any of their keys may sign.
        let valid = false;
        for (const key of keys) {
          if (await verifyInteraction(key, c.req.header("x-signature-ed25519"), c.req.header("x-signature-timestamp"), raw)) {
            valid = true;
            break;
          }
        }
        if (!valid) return c.json({ error: "Invalid request signature" }, 401);
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return c.json({ error: "Invalid JSON" }, 400);
        }
        // Authenticated by the signature: from here the kon reads its settings as the system.
        return c.json(await engine.interaction(body));
      },
    }),

    defineOperation({
      id: "gateway-config",
      method: "GET",
      route: "/gateway/config",
      summary: "Gateway worker configuration",
      description:
        "The intents to identify with and the event types to forward: the union of what the modules switched on in any server need. The worker polls it and re-identifies when `revision` changes. For the worker's key (`kon:dc:gateway-config`) or an admin.",
      access: "session",
      permission: { roles: ["admin"] },
      output: { schema: GatewayConfig },
      mcp: { exclude: "For the gateway worker process, not for agents" },
      handle: async () => engine.gatewayConfig(),
    }),

    defineOperation({
      id: "ingest-gateway-events",
      method: "POST",
      route: "/gateway/events",
      summary: "Receive events from the gateway worker",
      description:
        "A batch of up to 100 gateway dispatches. Server joins and leaves are stored at once; the rest are queued for the modules and the call answers 202 with how many were accepted and dropped. For the worker's key (`kon:dc:ingest-gateway-events`) or an admin.",
      access: "session",
      permission: { roles: ["admin"] },
      input: { body: GatewayEventBatch },
      output: { status: 202, schema: GatewayIngestResult },
      mcp: { exclude: "For the gateway worker process, not for agents" },
      handle: async ({ body }) => asSystem(() => engine.ingest(body)),
    }),
  ];
  }
}

/** The REST router, generated from the operations. */
export function createDcRouter(ctx: KonContext, options: DcEngineOptions = {}): Hono {
  return operationsRouter(KON_ID, dcOperations(ctx, options), ctx);
}

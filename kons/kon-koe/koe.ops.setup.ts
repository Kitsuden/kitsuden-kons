/**
 * Setting koe up, and the doors from outside: members, teams, channels, templates, Meta webhooks, web chat
 * ============================================================================
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { AppError, asSystem } from "@kitsuden/engine";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "@kitsuden/engine/zod";

import { graph } from "./channels/graph";
import { verifySignature } from "./channels/graph";
import { webchatMessage } from "./channels/webchat";
import { appSecretOf, authOf, channelById, publicChannel, seal } from "./koe.channels";
import { dbOf, emit, newId, type Db } from "./koe.common";
import { applyMessage, parseAny, receiveWebhook } from "./koe.inbound";
import { channelOf } from "./koe.realtime";
import { CONFIGURE, requireLead, requireMember, USE } from "./koe.policy";
import { koeChannels, koeConfig, koeConversations, koeIdentities, koeMedia, koeMembers, koeMessages, koeTeamMembers, koeTeams, koeTemplates, type Channel, type Message, type Template } from "./koe.schema";
import { createTemplate, deleteTemplate, fillTemplate, syncTemplates } from "./koe.templates";
import { Output, ParamId, type OperationsModule } from "./operations";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const Settings = z
  .object({
    greeting: z.string().max(1000).optional(),
    autoResolveHours: z.number().int().min(1).max(24 * 90).optional(),
    optOutKeywords: z.array(z.string().min(1).max(40)).max(20).optional(),
    optInKeywords: z.array(z.string().min(1).max(40)).max(20).optional(),
    handoffKeywords: z.array(z.string().min(1).max(40)).max(20).optional(),
    ratePerSecond: z.number().int().min(1).max(500).optional(),
    graphVersion: z.string().regex(/^v\d{1,2}\.\d$/).optional(),
    allowedOrigins: z.array(z.string().url().max(300)).max(20).optional(),
    preChatForm: z.boolean().optional(),
    reopenAs: z.enum(["bot", "queued"]).optional(),
    flowId: z.string().max(100).optional(),
    maxBotFailures: z.number().int().min(1).max(20).optional(),
  })
  .strict();

const ChannelFields = z.object({
  kind: z.enum(["whatsapp", "messenger", "instagram", "webchat"]),
  name: z.string().trim().min(1).max(200),
  externalId: z.string().trim().min(1).max(100).optional().describe("WhatsApp phone_number_id, Facebook page id, Instagram account id. Web chat: generated"),
  accountId: z.string().trim().max(100).nullable().optional().describe("WhatsApp Business Account id (templates live there)"),
  display: z.string().trim().max(200).nullable().optional(),
  accessToken: z.string().min(10).max(2000).optional().describe("System user token (WhatsApp) or page token. Stored sealed, never returned"),
  appSecret: z.string().min(10).max(500).optional().describe("The Meta app's secret, to check webhook signatures. Stored sealed"),
  botSlug: z.string().max(60).nullable().optional().describe("The kon-chat bot that answers in the `bot` state"),
  defaultTeamId: z.string().max(100).nullable().optional(),
  settings: Settings.optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

const TeamFields = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,59}$/),
  name: z.string().trim().min(1).max(200),
  purpose: z.enum(["support", "sales", "collections"]).optional(),
  timezone: z.string().min(1).max(60).optional(),
  businessHours: z.record(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]), z.array(z.tuple([z.string().regex(/^\d\d:\d\d$/), z.string().regex(/^\d\d:\d\d$/)])).max(4)).optional(),
  assignment: z.enum(["round_robin", "load", "manual"]).optional(),
  slaFirstResponseS: z.number().int().positive().max(30 * 86400).nullable().optional(),
  slaResolutionS: z.number().int().positive().max(90 * 86400).nullable().optional(),
});

const TemplateComponentSchema = z
  .object({
    type: z.enum(["HEADER", "BODY", "FOOTER", "BUTTONS"]),
    format: z.enum(["TEXT", "IMAGE", "VIDEO", "DOCUMENT", "LOCATION"]).optional(),
    text: z.string().max(1024).optional(),
    buttons: z.array(z.object({ type: z.string().max(30), text: z.string().max(25), url: z.string().max(2000).optional(), phone_number: z.string().max(20).optional(), example: z.unknown().optional() }).passthrough()).max(10).optional(),
    example: z.unknown().optional(),
  })
  .passthrough();

export const setupOperations: OperationsModule = (app, ctx) => {
  const db = (): Db => dbOf(ctx);

  // ── Members ─────────────────────────────────────────────────────────────

  app.get(
    "/members",
    { id: "list-members", summary: "Who is on koe", description: "Every member with role, availability, capacity and teams.", access: "session", permission: USE, unpaginated: "The people an admin put on the koe team: the staff of one inbox, read whole for assignment.", output: { schema: Output } },
    async (c, _i, h) => {
      await requireMember(db(), h.user);
      const members = (await db().select().from(koeMembers).orderBy(asc(koeMembers.displayName))) as Array<typeof koeMembers.$inferSelect>;
      const links = (await db().select().from(koeTeamMembers)) as Array<{ teamId: string; userId: string }>;
      return c.json({ data: members.map((m) => ({ ...m, teamIds: links.filter((l) => l.userId === m.userId).map((l) => l.teamId) })) });
    }
  );

  app.put(
    "/members/:userId",
    {
      id: "put-member",
      summary: "Add or change a member",
      description: "Puts a Kitsuden account on the koe team: `agent` answers their teams' conversations, `supervisor` sees and reassigns all and edits shared setup, `admin` also connects channels. Admins only.",
      access: "session",
      permission: CONFIGURE,
      sensitive: true,
      input: {
        params: z.object({ userId: z.string().min(1).max(100) }),
        body: z.object({ role: z.enum(["agent", "supervisor", "admin"]), displayName: z.string().trim().min(1).max(200), maxConcurrent: z.number().int().min(0).max(500).optional(), available: z.boolean().optional() }),
      },
      output: { schema: Output },
    },
    async (c, input) => {
      const [row] = (await db()
        .insert(koeMembers)
        .values({ userId: input.params.userId, ...input.body })
        .onConflictDoUpdate({ target: koeMembers.userId, set: input.body })
        .returning()) as unknown[];
      return c.json({ data: row });
    }
  );

  app.delete(
    "/members/:userId",
    {
      id: "remove-member",
      summary: "Remove a member",
      description: "Takes the account off koe. Their open conversations go back to the queue first. Admins only.",
      access: "session",
      permission: CONFIGURE,
      input: { params: z.object({ userId: z.string().min(1).max(100) }) },
      output: { schema: Output },
    },
    async (c, input) => {
      await db()
        .update(koeConversations)
        .set({ state: "queued", assigneeId: null, updatedAt: new Date() })
        .where(and(eq(koeConversations.assigneeId, input.params.userId), inArray(koeConversations.state, ["human", "snoozed"])));
      await db().delete(koeMembers).where(eq(koeMembers.userId, input.params.userId));
      return c.json({ data: { removed: input.params.userId } });
    }
  );

  // ── Teams ───────────────────────────────────────────────────────────────

  app.get(
    "/teams",
    { id: "list-teams", summary: "Teams", description: "Support, sales and collections teams with their hours, assignment rule, SLAs and members.", access: "session", permission: USE, unpaginated: "The teams leads set up (support, sales, collections): a handful per installation.", output: { schema: Output } },
    async (c, _i, h) => {
      await requireMember(db(), h.user);
      const teams = (await db().select().from(koeTeams).orderBy(asc(koeTeams.name))) as Array<typeof koeTeams.$inferSelect>;
      const links = (await db().select().from(koeTeamMembers)) as Array<{ teamId: string; userId: string }>;
      return c.json({ data: teams.map((t) => ({ ...t, memberIds: links.filter((l) => l.teamId === t.id).map((l) => l.userId) })) });
    }
  );

  app.post(
    "/teams",
    { id: "create-team", summary: "Create a team", description: "Supervisors and admins.", access: "session", permission: USE, input: { body: TeamFields }, output: { schema: Output, status: 201 }, errors: ["KITSUDEN_E_CONFLICT"] },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const [exists] = (await db().select({ id: koeTeams.id }).from(koeTeams).where(eq(koeTeams.slug, input.body.slug)).limit(1)) as unknown[];
      if (exists) throw AppError.conflict("That slug is taken");
      const [row] = (await db().insert(koeTeams).values({ id: newId(), ...input.body }).returning()) as unknown[];
      return c.json({ data: row }, 201);
    }
  );

  app.patch(
    "/teams/:id",
    { id: "update-team", summary: "Change a team", description: "Supervisors and admins. An empty body changes nothing and returns the team.", access: "session", permission: USE, input: { params: ParamId, body: TeamFields.partial() }, output: { schema: Output } },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      // Nothing to change is not an error: answer the team as it is (an UPDATE with no columns would fail).
      const [row] = (Object.keys(input.body).length
        ? await db().update(koeTeams).set(input.body).where(eq(koeTeams.id, input.params.id)).returning()
        : await db().select().from(koeTeams).where(eq(koeTeams.id, input.params.id)).limit(1)) as unknown[];
      if (!row) throw AppError.notFound("Team not found");
      return c.json({ data: row });
    }
  );

  app.delete(
    "/teams/:id",
    { id: "delete-team", summary: "Delete a team", description: "Its conversations stay, without a team. Supervisors and admins.", access: "session", permission: USE, input: { params: ParamId }, output: { schema: Output } },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      await db().delete(koeTeams).where(eq(koeTeams.id, input.params.id));
      return c.json({ data: { deleted: input.params.id } });
    }
  );

  app.put(
    "/teams/:id/members",
    {
      id: "set-team-members",
      summary: "Who is on a team",
      description: "Replaces the team's members (koe member user ids). Supervisors and admins.",
      access: "session",
      permission: USE,
      input: { params: ParamId, body: z.object({ userIds: z.array(z.string().min(1).max(100)).max(500) }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const [team] = (await db().select({ id: koeTeams.id }).from(koeTeams).where(eq(koeTeams.id, input.params.id)).limit(1)) as unknown[];
      if (!team) throw AppError.notFound("Team not found");
      await db().delete(koeTeamMembers).where(eq(koeTeamMembers.teamId, input.params.id));
      const ids = [...new Set(input.body.userIds)];
      if (ids.length) await db().insert(koeTeamMembers).values(ids.map((userId) => ({ teamId: input.params.id, userId })));
      return c.json({ data: { teamId: input.params.id, userIds: ids } });
    }
  );

  // ── Channels ────────────────────────────────────────────────────────────

  app.get(
    "/channels",
    { id: "list-channels", summary: "Channels", description: "Connected WhatsApp numbers, pages, Instagram accounts and web chats, with status and quality. Credentials are never returned.", access: "session", permission: USE, unpaginated: "The numbers, pages and web chats an admin connected: a handful per installation.", output: { schema: Output } },
    async (c, _i, h) => {
      await requireMember(db(), h.user);
      const rows = (await db().select().from(koeChannels).orderBy(asc(koeChannels.name))) as Channel[];
      return c.json({ data: rows.map(publicChannel) });
    }
  );

  app.post(
    "/channels",
    {
      id: "create-channel",
      summary: "Connect a channel",
      description:
        "A WhatsApp number (phone_number_id + WABA id + system user token + app secret), a Facebook page or Instagram account (id + page token + app secret), or a web chat (only a name: its public key is generated). Tokens are sealed. Admins only.",
      access: "session",
      permission: CONFIGURE,
      sensitive: true,
      input: { body: ChannelFields },
      output: { schema: Output, status: 201 },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const b = input.body as z.infer<typeof ChannelFields>;
      if (b.kind !== "webchat" && (!b.externalId || !b.accessToken || !b.appSecret)) throw AppError.validation("A Meta channel needs externalId, accessToken and appSecret");
      const externalId = b.kind === "webchat" ? `wc${newId()}` : b.externalId!;
      const [dup] = (await db().select({ id: koeChannels.id }).from(koeChannels).where(and(eq(koeChannels.kind, b.kind), eq(koeChannels.externalId, externalId))).limit(1)) as unknown[];
      if (dup) throw AppError.conflict("That channel is already connected");
      const [row] = (await db()
        .insert(koeChannels)
        .values({
          id: newId(),
          kind: b.kind,
          name: b.name,
          externalId,
          accountId: b.accountId ?? null,
          display: b.display ?? null,
          accessToken: b.accessToken ? seal(ctx, b.accessToken) : null,
          appSecret: b.appSecret ? seal(ctx, b.appSecret) : null,
          botSlug: b.botSlug ?? null,
          defaultTeamId: b.defaultTeamId ?? null,
          settings: b.settings ?? {},
          status: b.status ?? "active",
        })
        .returning()) as Channel[];
      emit(ctx, "channel.connected", { channelId: row!.id, kind: row!.kind });
      return c.json({ data: publicChannel(row!) }, 201);
    }
  );

  app.patch(
    "/channels/:id",
    {
      id: "update-channel",
      summary: "Change a channel",
      description: "Name, bot, default team, settings, status, or new credentials (sealed). Admins only.",
      access: "session",
      permission: CONFIGURE,
      sensitive: true,
      input: { params: ParamId, body: ChannelFields.omit({ kind: true }).partial() },
      output: { schema: Output },
    },
    async (c, input) => {
      const [current] = (await db().select().from(koeChannels).where(eq(koeChannels.id, input.params.id)).limit(1)) as Channel[];
      if (!current) throw AppError.notFound("Channel not found");
      const { accessToken, appSecret, settings, ...rest } = input.body as Partial<z.infer<typeof ChannelFields>>;
      const set: Record<string, unknown> = { ...rest, updatedAt: new Date() };
      if (current.kind === "webchat") delete set.externalId;
      if (accessToken) {
        set.accessToken = seal(ctx, accessToken);
        if (current.status === "error") Object.assign(set, { status: "active", statusDetail: null });
      }
      if (appSecret) set.appSecret = seal(ctx, appSecret);
      if (settings) set.settings = { ...(current.settings ?? {}), ...settings };
      const [row] = (await db().update(koeChannels).set(set).where(eq(koeChannels.id, input.params.id)).returning()) as Channel[];
      return c.json({ data: publicChannel(row!) });
    }
  );

  app.delete(
    "/channels/:id",
    { id: "delete-channel", summary: "Disconnect a channel", description: "Deletes the channel with its conversations and messages. Admins only.", access: "session", permission: CONFIGURE, input: { params: ParamId }, output: { schema: Output } },
    async (c, input) => {
      await db().delete(koeChannels).where(eq(koeChannels.id, input.params.id));
      return c.json({ data: { deleted: input.params.id } });
    }
  );

  app.post(
    "/channels/:id/check",
    {
      id: "check-channel",
      summary: "Check a channel's connection",
      description: "Asks Meta for the number or page with the stored token: answers its name, quality and messaging limit, or what is wrong. Admins only.",
      access: "session",
      permission: CONFIGURE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input) => {
      const [channel] = (await db().select().from(koeChannels).where(eq(koeChannels.id, input.params.id)).limit(1)) as Channel[];
      if (!channel) throw AppError.notFound("Channel not found");
      if (channel.kind === "webchat") return c.json({ data: { ok: true } });
      try {
        const auth = await authOf(ctx, channel, "check-channel");
        const fields = channel.kind === "whatsapp" ? "display_phone_number,verified_name,quality_rating,messaging_limit_tier,throughput" : "name,username";
        const info = await graph({ path: channel.externalId, token: auth.accessToken, version: auth.graphVersion, query: { fields } });
        const set: Record<string, unknown> = { status: "active", statusDetail: null, updatedAt: new Date() };
        if (info.quality_rating) set.quality = String(info.quality_rating).toLowerCase();
        if (info.messaging_limit_tier) set.messagingLimit = String(info.messaging_limit_tier);
        if (info.display_phone_number || info.name) set.display = String(info.display_phone_number ?? info.name);
        await db().update(koeChannels).set(set).where(eq(koeChannels.id, channel.id));
        return c.json({ data: { ok: true, info } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db().update(koeChannels).set({ status: "error", statusDetail: message.slice(0, 500), updatedAt: new Date() }).where(eq(koeChannels.id, channel.id));
        return c.json({ data: { ok: false, error: message } });
      }
    }
  );

  // ── Meta webhook verify token ───────────────────────────────────────────

  app.put(
    "/config/meta",
    {
      id: "set-meta-webhook-token",
      summary: "Set the Meta webhook verify token",
      description: "The token you type in the Meta app's webhook settings. Only its hash is stored. Admins only.",
      access: "session",
      permission: CONFIGURE,
      sensitive: true,
      input: { body: z.object({ verifyToken: z.string().min(16).max(200) }) },
      output: { schema: Output },
      mcp: { exclude: "a secret typed by a person into Meta" },
    },
    async (c, input) => {
      const value = { verifyTokenHash: sha256(input.body.verifyToken) };
      await db().insert(koeConfig).values({ key: "meta", value }).onConflictDoUpdate({ target: koeConfig.key, set: { value, updatedAt: new Date() } });
      return c.json({ data: { ok: true, webhookPath: "/webhooks/meta" } });
    }
  );

  app.get(
    "/webhooks/meta",
    {
      id: "verify-meta-webhook",
      summary: "Meta webhook verification",
      description: "Meta calls it once when the webhook is set up; it answers the challenge if the verify token matches.",
      access: "public",
      input: { query: z.object({ "hub.mode": z.string().max(40).optional(), "hub.verify_token": z.string().max(200).optional(), "hub.challenge": z.string().max(200).optional() }).passthrough() },
      output: { type: "text/plain", description: "The challenge" },
      // 403 when the verify token or the mode does not match.
      errors: ["KITSUDEN_E_FORBIDDEN"],
      mcp: { exclude: "called by Meta" },
    },
    async (c, input) => {
      const q = input.query as Record<string, string | undefined>;
      const [cfg] = (await asSystem(() => db().select().from(koeConfig).where(eq(koeConfig.key, "meta")).limit(1))) as Array<typeof koeConfig.$inferSelect>;
      const expected = String(cfg?.value?.verifyTokenHash ?? "");
      const given = q["hub.verify_token"] ? sha256(q["hub.verify_token"]) : "";
      const ok = q["hub.mode"] === "subscribe" && expected.length === 64 && given.length === 64 && timingSafeEqual(Buffer.from(expected), Buffer.from(given));
      if (!ok) return c.text("Forbidden", 403);
      return c.text(q["hub.challenge"] ?? "", 200);
    }
  );

  app.post(
    "/webhooks/meta",
    {
      id: "receive-meta-webhook",
      summary: "Meta webhook",
      description: "WhatsApp, Messenger and Instagram events. The signature is checked against the app secret of the channels the body names; the body is stored and processed by a job.",
      access: "public",
      output: { schema: Output },
      // 400 for a body that is not JSON, 401 for a bad signature, 413 past 3 MB.
      errors: ["KITSUDEN_E_BAD_REQUEST", "KITSUDEN_E_UNAUTHENTICATED", "KITSUDEN_E_PAYLOAD_TOO_LARGE"],
      mcp: { exclude: "called by Meta" },
    },
    async (c) => {
      const raw = await c.req.text();
      if (raw.length > 3_000_000) return c.json({ error: "too large" }, 413);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return c.json({ error: "invalid json" }, 400);
      }
      // Which channels does it talk about? Their app secrets are the only ones that may sign it.
      const ids = new Set<string>();
      for (const e of parseAny(body)) {
        if ("channelExternalId" in e && e.channelExternalId) ids.add(`${e.channelKind}:${e.channelExternalId}`);
        if ("accountId" in e && e.accountId) ids.add(`account:${e.accountId}`);
      }
      if (ids.size === 0) return c.json({ ok: true }); // nothing koe knows about
      const signature = c.req.header("x-hub-signature-256");
      const channels = (await asSystem(() => db().select().from(koeChannels))) as Channel[];
      const candidates = channels.filter((ch) => ids.has(`${ch.kind}:${ch.externalId}`) || (ch.accountId && ids.has(`account:${ch.accountId}`)));
      let verified = false;
      for (const ch of candidates) {
        const secret = await appSecretOf(ctx, ch).catch(() => null);
        if (secret && verifySignature(raw, signature, secret)) {
          verified = true;
          break;
        }
      }
      if (!verified) return c.json({ error: "invalid signature" }, 401);
      await receiveWebhook(db(), "meta", sha256(raw), body);
      return c.json({ ok: true });
    }
  );

  // ── Templates ───────────────────────────────────────────────────────────

  app.get(
    "/templates",
    {
      id: "list-templates",
      summary: "WhatsApp templates",
      description: "The local copy of each channel's templates with status (approved, pending, rejected, paused…), category, language, quality and variables.",
      access: "session",
      permission: USE,
      unpaginated: "The message templates of the connected WhatsApp accounts, a catalogue Meta caps per WhatsApp Business Account, read whole for the template picker.",
      input: { query: z.object({ channelId: z.string().max(100).optional(), status: z.string().max(20).optional() }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const where = [...(input.query.channelId ? [eq(koeTemplates.channelId, input.query.channelId)] : []), ...(input.query.status ? [eq(koeTemplates.status, input.query.status as Template["status"])] : [])];
      return c.json({ data: await db().select().from(koeTemplates).where(where.length ? and(...where) : undefined).orderBy(asc(koeTemplates.name)) });
    }
  );

  app.post(
    "/channels/:id/templates/sync",
    { id: "sync-templates", summary: "Refresh templates from Meta", description: "Reads every template of the channel's WhatsApp Business Account. Supervisors and admins.", access: "session", permission: USE, input: { params: ParamId }, output: { schema: Output } },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const channel = await channelById(db(), input.params.id);
      if (!channel) throw AppError.notFound("Channel not found");
      return c.json({ data: await syncTemplates(ctx, db(), channel) });
    }
  );

  app.post(
    "/channels/:id/templates",
    {
      id: "create-template",
      summary: "Submit a template to Meta",
      description: "Creates it in the WhatsApp Business Account; it starts `pending` until Meta reviews it (the status webhook updates it). Supervisors and admins.",
      access: "session",
      permission: USE,
      sensitive: true,
      input: {
        params: ParamId,
        body: z.object({
          name: z.string().regex(/^[a-z0-9_]{1,512}$/),
          language: z.string().min(2).max(10),
          category: z.enum(["marketing", "utility", "authentication"]),
          components: z.array(TemplateComponentSchema).min(1).max(4),
        }),
      },
      output: { schema: Output, status: 201 },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const channel = await channelById(db(), input.params.id);
      if (!channel) throw AppError.notFound("Channel not found");
      return c.json({ data: await createTemplate(ctx, db(), channel, input.body as never) }, 201);
    }
  );

  app.delete(
    "/templates/:id",
    { id: "delete-template", summary: "Delete a template", description: "Deletes it in Meta (all its languages) and marks the copy deleted. Supervisors and admins.", access: "session", permission: USE, input: { params: ParamId }, output: { schema: Output } },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const [t] = (await db().select().from(koeTemplates).where(eq(koeTemplates.id, input.params.id)).limit(1)) as Template[];
      if (!t) throw AppError.notFound("Template not found");
      await deleteTemplate(ctx, db(), t);
      return c.json({ data: { deleted: t.id } });
    }
  );

  app.post(
    "/templates/:id/preview",
    {
      id: "preview-template",
      summary: "Preview a filled template",
      description: "The text the contact will read with these values; 422 names every missing value.",
      access: "session",
      permission: USE,
      readOnly: true,
      input: { params: ParamId, body: z.object({ values: z.record(z.string(), z.string().max(1024)).default({}), hasHeaderMedia: z.boolean().optional() }) },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const [t] = (await db().select().from(koeTemplates).where(eq(koeTemplates.id, input.params.id)).limit(1)) as Template[];
      if (!t) throw AppError.notFound("Template not found");
      const filled = fillTemplate(t, { values: input.body.values, headerMedia: input.body.hasHeaderMedia ? { link: "preview" } : undefined });
      return c.json({ data: { preview: filled.preview } });
    }
  );

  // ── Web chat (public) ───────────────────────────────────────────────────

  const visitorHash = (visitorId: string) => sha256(`koe-visitor:${visitorId}`);
  const Visitor = z.object({ visitorId: z.string().min(24).max(200).describe("A random key the visitor's browser keeps; only its hash is stored") });

  const webchatChannel = async (key: string, origin: string | undefined): Promise<Channel> => {
    const [ch] = (await asSystem(() => db().select().from(koeChannels).where(and(eq(koeChannels.kind, "webchat"), eq(koeChannels.externalId, key))).limit(1))) as Channel[];
    if (!ch || ch.status !== "active") throw AppError.notFound("Chat not found");
    const allowed = ch.settings?.allowedOrigins ?? [];
    if (allowed.length && (!origin || !allowed.some((o) => new URL(o).origin === origin))) throw AppError.forbidden("This chat is not available on this site");
    return ch;
  };

  app.get(
    "/public/webchat/:key/config",
    {
      id: "webchat-config",
      summary: "Web chat settings",
      description: "Name, greeting and whether to ask name and email first. For the widget.",
      access: "public",
      input: { params: z.object({ key: z.string().min(3).max(100) }) },
      output: { schema: Output },
      mcp: { exclude: "for the embedded widget" },
    },
    async (c, input) => {
      const ch = await webchatChannel(input.params.key, c.req.header("origin") ?? undefined);
      return c.json({ data: { name: ch.display ?? ch.name, greeting: ch.settings?.greeting ?? null, preChatForm: !!ch.settings?.preChatForm } });
    }
  );

  app.post(
    "/public/webchat/:key/messages",
    {
      id: "webchat-send",
      summary: "A visitor writes",
      description: "The widget's message. `clientMessageId` makes a retried request the same message. Answers come on the realtime channel it returns, or by polling.",
      access: "public",
      input: {
        params: z.object({ key: z.string().min(3).max(100) }),
        body: Visitor.extend({
          clientMessageId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
          text: z.string().trim().min(1).max(4000).optional(),
          reply: z.object({ id: z.string().max(200), title: z.string().max(100) }).optional().describe("A button or list option the visitor chose"),
          name: z.string().trim().max(200).optional(),
          email: z.string().email().max(300).optional(),
        }),
      },
      output: { schema: Output, status: 201 },
      mcp: { exclude: "for the embedded widget" },
    },
    async (c, input) => {
      const b = input.body;
      if (!b.text && !b.reply) throw AppError.validation("Write a message");
      const ch = await webchatChannel(input.params.key, c.req.header("origin") ?? undefined);
      const hash = visitorHash(b.visitorId);
      const event = webchatMessage(ch.externalId, hash, {
        text: b.text ?? b.reply?.title,
        kind: b.reply ? "button_reply" : "text",
        payload: b.reply ? { id: b.reply.id, title: b.reply.title } : undefined,
        name: b.name,
        email: b.email,
        clientMessageId: b.clientMessageId,
      });
      const applied = await asSystem(() => applyMessage(ctx, db(), event));
      if (!applied) throw AppError.notFound("Chat not found");
      return c.json({ data: { id: applied.message.id, at: applied.message.createdAt, channel: channelOf.visitor(hash) } }, 201);
    }
  );

  app.get(
    "/public/webchat/:key/messages",
    {
      id: "webchat-history",
      summary: "A visitor's conversation",
      description: "The visitor's messages and the answers, oldest first; `after` (ISO date) for only the new ones. Internal notes and who answered are never included.",
      access: "public",
      input: { params: z.object({ key: z.string().min(3).max(100) }), query: Visitor.extend({ after: z.string().datetime().optional() }) },
      output: { schema: Output },
      mcp: { exclude: "for the embedded widget" },
    },
    async (c, input) => {
      const ch = await webchatChannel(input.params.key, c.req.header("origin") ?? undefined);
      const hash = visitorHash(input.query.visitorId);
      const rows = await asSystem(async () => {
        const [identity] = (await db().select().from(koeIdentities).where(and(eq(koeIdentities.channelId, ch.id), eq(koeIdentities.externalId, hash))).limit(1)) as Array<{ id: string }>;
        if (!identity) return [] as Message[];
        const convs = (await db().select({ id: koeConversations.id }).from(koeConversations).where(eq(koeConversations.identityId, identity.id))) as Array<{ id: string }>;
        if (!convs.length) return [] as Message[];
        const all = (await db()
          .select()
          .from(koeMessages)
          .where(inArray(koeMessages.conversationId, convs.map((x) => x.id)))
          .orderBy(asc(koeMessages.createdAt))) as Message[];
        return all.filter((m) => m.status !== "failed" && m.status !== "queued" && (!input.query.after || m.createdAt > new Date(input.query.after))).slice(-200);
      });
      const media = rows.some((r) => r.mediaId)
        ? ((await asSystem(() => db().select().from(koeMedia).where(inArray(koeMedia.id, rows.map((r) => r.mediaId).filter((x): x is string => !!x))))) as Array<typeof koeMedia.$inferSelect>)
        : [];
      const data = [];
      for (const m of rows) {
        const md = m.mediaId ? media.find((x) => x.id === m.mediaId) : undefined;
        data.push({
          id: m.id,
          direction: m.direction,
          kind: m.kind,
          body: m.body,
          interactive: (m.payload as Record<string, unknown>).interactive ?? null,
          media: md?.storageKey ? { url: await ctx.storage.getSignedDownloadUrl(md.storageKey, 3600).catch(() => null), mime: md.mime, filename: md.filename } : null,
          at: m.createdAt,
        });
      }
      return c.json({ data, channel: channelOf.visitor(hash) });
    }
  );
};

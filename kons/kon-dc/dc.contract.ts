/**
 * kon-dc — the shared contract
 * ============================================================================
 *
 * Every shape that crosses a boundary is declared here ONCE, with zod:
 *
 *   · BlueprintDefinition — what a bot does, as data (no code). It is what the panel edits, what an
 *     agent writes over MCP, what `GET /export` hands out and `POST /import` takes back. A blueprint
 *     that passes this schema can only do what the steps below allow: there is no code to sandbox.
 *     It covers the Discord builder surface: slash commands with subcommands, choices and
 *     autocomplete; buttons, selects (static, fed by another kon, or users/roles/channels); modals;
 *     embeds; live PANELS (messages the bot keeps up to date); triggers on gateway events AND on
 *     other kons' events; role gates; and calls to other kons' operations.
 *   · GatewayConfig / GatewayEventBatch / GatewayIngestResult — the wire between the Go gateway
 *     worker (gateway/) and this kon. `GET /api/dc/contract` serves them as JSON Schema, and
 *     `gateway/contract/*.schema.json` is that output committed next to the Go types. A guard test
 *     fails when the Go struct tags, the committed JSON Schema and these schemas drift apart.
 *
 * Import them from the kon's entry (`import { BlueprintDefinition } from "@kitsuden/kon-dc"`): an app
 * that builds blueprints, or another kon that adds a module, validates with the same schemas.
 */

import { z } from "zod";

/** Version of the blueprint format. Bumped only for a change old blueprints cannot be read with. */
export const BLUEPRINT_FORMAT = 1;

/** Version of the gateway wire format the worker and the kon speak. */
export const GATEWAY_CONTRACT_VERSION = 1;

/** A Discord id (snowflake): 15–20 digits. */
export const Snowflake = z.string().regex(/^\d{15,20}$/, "Expected a Discord id (15–20 digits)");

// ── Gateway intents (https://discord.com/developers/docs/events/gateway#gateway-intents) ─────────

export const INTENTS = {
  GUILDS: 1 << 0,
  /** Privileged: switch it on in the Developer Portal (Bot → Server Members Intent). */
  GUILD_MEMBERS: 1 << 1,
  /** Bans (GUILD_BAN_ADD). */
  GUILD_MODERATION: 1 << 2,
  /** Who joins, leaves or moves between voice channels (VOICE_STATE_UPDATE). */
  GUILD_VOICE_STATES: 1 << 7,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  /** Privileged: switch it on in the Developer Portal (Bot → Message Content Intent). */
  MESSAGE_CONTENT: 1 << 15,
} as const;

/** The dispatch events the kon understands. The worker forwards only those the config asks for. */
export const GATEWAY_EVENTS = [
  "GUILD_CREATE",
  "GUILD_UPDATE",
  "GUILD_DELETE",
  "GUILD_MEMBER_ADD",
  "GUILD_MEMBER_REMOVE",
  "GUILD_BAN_ADD",
  "MESSAGE_CREATE",
  "MESSAGE_UPDATE",
  "MESSAGE_DELETE",
  "MESSAGE_REACTION_ADD",
  "MESSAGE_REACTION_REMOVE",
  "VOICE_STATE_UPDATE",
  "GUILD_AUDIT_LOG_ENTRY_CREATE",
] as const;
export type GatewayEventName = (typeof GATEWAY_EVENTS)[number];

/**
 * The events this kon emits on the core's bus, for other kons and for the core's actions engine
 * (an action with `triggerConfig.eventName` = one of these runs on it). Payloads never carry message
 * text: only ids and names.
 */
export const DC_EVENTS = {
  /** `{ guildId, userId }` */
  memberJoined: "dc:member:joined",
  /** `{ guildId, moduleId, command, userId }` */
  commandUsed: "dc:command:used",
  /** `{ guildId, moduleId, componentId, userId, values }` */
  componentUsed: "dc:component:used",
  /** `{ guildId, moduleId, modalId, userId }` */
  modalSubmitted: "dc:modal:submitted",
  /** `{ guildId, moduleId, enabled }` */
  moduleSwitched: "dc:module:switched",
  /** `{ guildId, userId }` */
  memberLeft: "dc:member:left",
  /** `{ guildId, userId, currency, amount, balance, moduleId }`: coins, XP or any currency given */
  rewardGranted: "dc:reward:granted",
  /** `{ guildId, userId, level, moduleId }` */
  levelUp: "dc:level:up",
  /** `{ guildId, userId, item, quantity, moduleId }` */
  itemGranted: "dc:item:granted",
  /** `{ guildId, moduleId, giveawayId, winners }` (user ids) */
  giveawayEnded: "dc:giveaway:ended",
  /** `{ guildId, userId, action, moderatorId, caseId }` */
  moderationAction: "dc:moderation:action",
  /** `{ guildId, userId, currency, balance, reason }`: the team gave, took or set a balance by hand */
  economyAdjusted: "dc:economy:adjusted",
  /** `{ guildId, plan, until }` */
  planChanged: "dc:plan:changed",
} as const;

/** Prefix of what a blueprint's `emit_event` step sends: `dc:blueprint:<name>`. Never another kon's name. */
export const BLUEPRINT_EVENT_PREFIX = "dc:blueprint:";

// ── Building blocks ─────────────────────────────────────────────────────────────────────────────

/**
 * Text with placeholders, resolved when the step runs:
 *   {{user.id}} {{user.name}} {{user.mention}} {{guild.id}} {{channel.id}} {{message.id}}
 *   {{option.<name>}}        a slash-command option (subcommand options too)
 *   {{subcommand}}           the subcommand that ran
 *   {{value}} {{values}}     what a select picked (the first, and all joined with ", ")
 *   {{values_list}}          the same as a list, for a JSON body (`"chars": "{{values_list}}"`)
 *   {{input.<id>}}           a modal's field
 *   {{focused}}              what the member is typing (autocomplete sources)
 *   {{kv.<key>}}             this blueprint's state in the server; `$user` in the key is the
 *                            member's id ({{kv.bio:$user}} reads what kv_set bio:{{user.id}} wrote)
 *   {{ai.reply}}             the last `ai_reply`
 *   {{call.<saveAs>.<path>}} the answer of a `kon_call` step (dotted path into its JSON)
 *   {{data.<name>.<path>}}   a panel's data source
 *   {{event.<path>}}         the payload of the kon event a trigger runs on
 *   {{item.<path>}}          one element of a list source (select options, autocomplete)
 *   {{sent.<saveAs>}}        the id of a message sent by `send_message`, a thread, a poll
 *   {{var.<name>}}           what `set_var`, `random`, `math`, `wallet_*`, `item_*`, `list_*`,
 *                            `leaderboard` and `toggle_role` saved
 *   {{now}} {{now.unix}}     the time (ISO, and seconds; `<t:{{now.unix}}:R>` is "a moment ago")
 * Unknown placeholders render empty.
 *
 * Filters change a value: `{{user.name|upper}}`, `{{var.coins|number}}`, `{{input.name|default:anon}}`.
 *   upper lower title trim length number round floor ceil abs truncate:<n> default:<text>
 *   plural:<one>,<many> pad:<n> json
 */
export const Template = z.string().min(1).max(2000);
const Label = z.string().min(1).max(80);

/** Ids inside one blueprint: buttons, selects, modals, inputs, panels, saved results. */
export const LocalId = z.string().regex(/^[a-z0-9_-]{1,32}$/, "Lowercase letters, digits, _ and - (up to 32)");

/** `"$channel"` is the channel the command, button or message came from. A template may give an id. */
const ChannelRef = z.union([Snowflake, z.literal("$channel"), z.string().regex(/^\{\{[a-zA-Z0-9_.:-]+\}\}$/)]);

/** A role: an id, or a template that gives one (`{{value}}` from a role menu, `{{option.role}}`). */
const RoleRef = z.union([Snowflake, z.string().regex(/^\{\{[a-zA-Z0-9_.:|-]+\}\}$/)]);

/** A number, or a template that renders one (`{{option.amount}}`, `{{var.prize}}`). */
const NumberRef = z.union([z.number(), z.string().min(5).max(200).regex(/\{\{/, "A number, or a template like {{option.amount}}")]);

/** A message: `"$message"` is the one the button or select is on; a template gives an id (`{{sent.panel}}`). */
const MessageRef = z.union([Snowflake, z.literal("$message"), z.string().regex(/^\{\{[a-zA-Z0-9_.:|-]+\}\}$/)]);

/** A member: whoever triggered it when left out; a template gives another (`{{option.user}}`, a mention works). */
const UserRef = z.string().max(100);

/** A name for a value saved by a step: `{{var.<name>}}`. */
const VarName = LocalId;

/** A currency of the server's economy: `coins` by default, `xp` is what the Levels module counts. */
export const CurrencyId = z.string().regex(/^[a-z0-9_-]{1,32}$/).default("coins");

/** An item of the server's inventory system. */
const ItemId = z.string().regex(/^[a-z0-9_-]{1,64}$/, "Lowercase letters, digits, _ and - (up to 64)");

/** A list of members kept by the bot: giveaway entries, a queue, a raffle, a team. */
const ListName = z.string().min(1).max(64).describe("May contain {{...}}; expanded before use");

const KvKeyTemplate = z
  .string()
  .min(1)
  .max(100)
  .describe("Key in this blueprint's state. May contain {{user.id}}; expanded before use");

/**
 * A kon event name on the core's bus: `<kon>:<what>` (`broadcast:match:updated`). Same rule as the
 * core's actions engine.
 */
export const KonEventName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}:[a-z0-9:._-]{1,200}$/, "Expected <kon>:<event>");

/**
 * A path of this Kitsuden's API, after `/api` (`/broadcast/matches/{{option.set}}/score`). The bot
 * calls it with ITS OWN agent key (DISCORD_KITSUDEN_API_TOKEN): whatever that key's scopes do not
 * allow is a 403, so the key, not the blueprint, decides what a server can reach.
 */
export const KonPath = z
  .string()
  .min(2)
  .max(500)
  .regex(/^\/[a-z0-9][a-z0-9-]*(\/|$|\?)/, "Starts with /<kon mount>/, e.g. /broadcast/matches")
  .refine((p) => !p.includes("..") && !p.includes("//") && !p.includes("\\"), { message: "No '..', '//' or '\\'" })
  .refine((p) => !/^\/dc\/(interactions|gateway)/.test(p), { message: "Not the bot's own Discord endpoints" });

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Any JSON; strings inside are templates. A string that is exactly `{{path}}` keeps the value's type
 * (a number stays a number, an object an object), and when that value is missing or empty the key is
 * LEFT OUT: a blank modal field or an option nobody typed means "leave it as it is", not "set it to
 * empty".
 */
export type JsonTemplate = string | number | boolean | null | JsonTemplate[] | { [k: string]: JsonTemplate };
export const JsonTemplate: z.ZodType<JsonTemplate> = z.lazy(() =>
  z.union([
    z.string().max(2000),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonTemplate).max(50),
    z.record(z.string().max(60), JsonTemplate),
  ])
);

/**
 * A list read from another kon (`GET` only): the options of a select, the suggestions of an
 * autocomplete. `items` is where the array is in the answer (`docs`, `data.champions`; none = the
 * answer itself); `label`, `value` and `description` are templates over `{{item.*}}`. Up to 25 are used.
 */
export const KonSource = z
  .object({
    path: KonPath,
    items: z.string().max(100).optional(),
    label: Template,
    value: Template,
    description: Template.optional(),
  })
  .strict();
export type KonSource = z.infer<typeof KonSource>;

/**
 * A list already in the step's scope: what an earlier `kon_call` answered (`call.sets.sets`), a
 * panel's data. For a select shown right after a call (pick one of the sets start.gg listed).
 */
export const ScopeList = z
  .object({
    scope: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/),
    label: Template,
    value: Template,
    description: Template.optional(),
  })
  .strict();
export type ScopeList = z.infer<typeof ScopeList>;

/** A guard on a step or a trigger. Both sides are templates. */
export const Condition = z
  .object({
    left: z.string().max(500),
    op: z
      .enum(["eq", "neq", "contains", "starts_with", "ends_with", "gt", "gte", "lt", "lte", "empty", "not_empty", "in", "not_in"])
      .describe("`in`/`not_in`: `right` is a list (comma-separated, or a JSON array from a call)"),
    right: z.string().max(500).optional(),
  })
  .strict();
export type Condition = z.infer<typeof Condition>;

/** Discord permissions a gate can ask for (the member needs ALL of those listed). */
export const PERMISSIONS = {
  administrator: 1n << 3n,
  manage_channels: 1n << 4n,
  manage_guild: 1n << 5n,
  manage_messages: 1n << 13n,
  manage_nicknames: 1n << 27n,
  manage_roles: 1n << 28n,
  manage_events: 1n << 33n,
  manage_threads: 1n << 34n,
  kick_members: 1n << 1n,
  ban_members: 1n << 2n,
  moderate_members: 1n << 40n,
} as const;
export type PermissionName = keyof typeof PERMISSIONS;
export const PermissionName = z.enum(Object.keys(PERMISSIONS) as [PermissionName, ...PermissionName[]]);

/**
 * Who may press a button, use a command, submit a modal: members with ANY of `roles`, and with ALL
 * of `permissions` (administrators pass every permission check).
 */
export const Access = z
  .object({
    roles: z.array(Snowflake).min(1).max(25).optional(),
    permissions: z.array(PermissionName).min(1).max(10).optional(),
    message: z.string().min(1).max(200).optional().describe("What the others see (only them)"),
  })
  .strict()
  .refine((a) => !!a.roles || !!a.permissions, { message: "An access rule needs `roles` or `permissions`" });
export type Access = z.infer<typeof Access>;

export const Embed = z
  .object({
    title: z.string().min(1).max(256).optional(),
    description: z.string().min(1).max(4000).optional(),
    url: z.string().max(500).optional(),
    color: z
      .union([z.number().int().min(0).max(0xffffff), z.string().max(200)])
      .optional()
      .describe("A number, `#rrggbb`, or a template that gives one ({{data.team.color}})"),
    fields: z
      .array(z.object({ name: z.string().min(1).max(256), value: z.string().min(1).max(1024), inline: z.boolean().optional() }).strict())
      .max(25)
      .optional(),
    footer: z.string().min(1).max(2048).optional(),
    thumbnail: z.string().max(500).optional().describe("Image URL (template)"),
    image: z.string().max(500).optional().describe("Image URL (template), or attachment://card.png for a card step's image"),
  })
  .strict();
export type Embed = z.infer<typeof Embed>;

export const BUTTON_STYLES = ["primary", "secondary", "success", "danger"] as const;

/**
 * A step as the TYPES see it inside a component. A button's steps may send messages with more
 * buttons, a cycle TypeScript cannot infer; validation at run time is the full `BlueprintStep`.
 */
export interface AnyStep {
  do: string;
  [key: string]: unknown;
}
function lazySteps(): z.ZodType<AnyStep[]> {
  return z.lazy((): z.ZodType => Steps) as unknown as z.ZodType<AnyStep[]>;
}

export const ButtonComponent = z
  .object({
    type: z.literal("button"),
    id: LocalId,
    label: Label,
    style: z.enum(BUTTON_STYLES).default("secondary"),
    styles: z
      .array(z.object({ if: Condition, style: z.enum(BUTTON_STYLES) }).strict())
      .max(5)
      .optional()
      .describe("Style by state: the first whose condition holds wins (`style` otherwise)"),
    emoji: z.string().min(1).max(64).optional(),
    disabledIf: Condition.optional(),
    access: Access.optional(),
    steps: lazySteps(),
  })
  .strict();

export const LinkButtonComponent = z
  .object({ type: z.literal("link"), label: Label, url: z.string().min(1).max(512), emoji: z.string().min(1).max(64).optional() })
  .strict();

export const SelectComponent = z
  .object({
    type: z.literal("select"),
    id: LocalId,
    placeholder: z.string().min(1).max(150).optional(),
    options: z
      .array(
        z
          .object({
            label: Label,
            value: z.string().min(1).max(100),
            description: z.string().min(1).max(100).optional(),
            emoji: z.string().min(1).max(64).optional(),
          })
          .strict()
      )
      .min(1)
      .max(25)
      .optional(),
    optionsFrom: z.union([KonSource, ScopeList]).optional(),
    selected: z
      .string()
      .max(500)
      .optional()
      .describe("Values shown as already picked: a template giving one or several (comma-separated, or a list)"),
    minValues: z.number().int().min(0).max(25).optional(),
    maxValues: z.number().int().min(1).max(25).optional(),
    access: Access.optional(),
    steps: lazySteps(),
  })
  .strict()
  .refine((s) => !!s.options !== !!s.optionsFrom, { message: "A select has `options` or `optionsFrom`, one of the two" });

export const EntitySelectComponent = z
  .object({
    type: z.enum(["user_select", "role_select", "channel_select"]),
    id: LocalId,
    placeholder: z.string().min(1).max(150).optional(),
    minValues: z.number().int().min(0).max(25).optional(),
    maxValues: z.number().int().min(1).max(25).optional(),
    access: Access.optional(),
    steps: lazySteps(),
  })
  .strict();

export const MessageComponent = z.union([ButtonComponent, LinkButtonComponent, SelectComponent, EntitySelectComponent]);
export type MessageComponent = z.infer<typeof MessageComponent>;
/** A component that answers when used (everything but a link). */
export type ActiveComponent = Exclude<MessageComponent, { type: "link" }>;

/** One row: up to 5 buttons, or exactly one select. */
export const ComponentRow = z
  .array(MessageComponent)
  .min(1)
  .max(5)
  .refine((row) => row.length === 1 || row.every((c) => c.type === "button" || c.type === "link"), {
    message: "A select takes a whole row",
  });
export type ComponentRow = z.infer<typeof ComponentRow>;

/** What a message says: text, embeds, rows of components. Every string is a template. */
const MessageFields = {
  content: Template.optional(),
  embeds: z.array(Embed).max(10).optional(),
  components: z.array(ComponentRow).max(5).optional(),
};
export interface MessageTemplate {
  content?: string;
  embeds?: Embed[];
  components?: ComponentRow[];
}

const hasBody = (m: { content?: string; embeds?: unknown[] }) => !!m.content || !!m.embeds?.length;

// ── Steps ───────────────────────────────────────────────────────────────────────────────────────

const If = { if: Condition.optional().describe("Run this step only when the condition holds") };

export const BlueprintStep = z.discriminatedUnion("do", [
  z
    .object({ do: z.literal("reply"), ...If, ...MessageFields, ephemeral: z.boolean().optional() })
    .strict()
    .describe("Answer the interaction (command, button, select, modal)"),
  z
    .object({ do: z.literal("update_message"), ...If, ...MessageFields })
    .strict()
    .describe("Replace the message the button or select is on (components and their modals only)"),
  z
    .object({ do: z.literal("send_message"), ...If, channelId: ChannelRef, ...MessageFields, saveAs: LocalId.optional() })
    .strict()
    .describe("Post a message in a channel; `saveAs` keeps its id as {{sent.<saveAs>}}"),
  z.object({ do: z.literal("open_modal"), ...If, modal: LocalId }).strict().describe("Open a modal (must be the only step)"),
  z
    .object({ do: z.literal("add_role"), ...If, roleId: RoleRef, userId: z.string().max(100).optional() })
    .strict()
    .describe("Give a role (to whoever triggered it, or to `userId`, a template)"),
  z
    .object({ do: z.literal("remove_role"), ...If, roleId: RoleRef, userId: z.string().max(100).optional() })
    .strict()
    .describe("Take a role"),
  z
    .object({ do: z.literal("kv_increment"), ...If, key: KvKeyTemplate, by: z.number().int().min(-1000).max(1000) })
    .strict()
    .describe("Add to a number in this blueprint's state"),
  z
    .object({ do: z.literal("kv_set"), ...If, key: KvKeyTemplate, value: z.union([z.string().max(500), z.number(), z.boolean()]) })
    .strict()
    .describe("Set a value in this blueprint's state (strings are templates)"),
  z
    .object({
      do: z.literal("ai_reply"),
      ...If,
      agentId: z.string().min(1).max(100).describe("A core agent identity: it brings the model (your key, or Ollama)"),
      prompt: Template,
      cooldownSeconds: z.number().int().min(0).max(3600).default(10).describe("Per member: a model costs money"),
    })
    .strict()
    .describe("Ask a core agent; its answer is {{ai.reply}} for the next steps. Never with tools"),
  z
    .object({
      do: z.literal("kon_call"),
      ...If,
      method: z.enum(HTTP_METHODS).default("GET"),
      path: KonPath,
      body: JsonTemplate.optional(),
      saveAs: LocalId.optional(),
    })
    .strict()
    .describe("Call another kon's operation with the bot's agent key; the answer is {{call.<saveAs>.*}}"),
  z
    .object({
      do: z.literal("emit_event"),
      ...If,
      name: z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,99}$/),
      data: JsonTemplate.optional(),
    })
    .strict()
    .describe("Emit `dc:blueprint:<name>` on the core's bus: other kons and actions react to it"),
  z
    .object({ do: z.literal("post_panel"), ...If, panel: LocalId, channelId: ChannelRef })
    .strict()
    .describe("Post a live panel; the bot keeps it up to date"),
  z
    .object({ do: z.literal("refresh_panels"), ...If, panel: LocalId.optional() })
    .strict()
    .describe("Redraw this blueprint's panels in the server (all, or one)"),

  // ── Flow ──
  z
    .object({
      do: z.literal("stop"),
      ...If,
      content: Template.optional(),
      ephemeral: z.boolean().default(true),
    })
    .strict()
    .describe("Stop here (with `if`: a check). With `content`, that is the answer (only the member sees it by default)"),
  z
    .object({
      do: z.literal("cooldown"),
      ...If,
      seconds: z.number().int().min(1).max(30 * 24 * 3600),
      per: z.enum(["user", "channel", "guild"]).default("user"),
      key: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional().describe("Share one cooldown between commands (default: this list of steps)"),
      message: Template.optional().describe("Default: 'Wait <time>.' ({{cooldown.left}} is the time left)"),
    })
    .strict()
    .describe("Stop with a message when this ran less than `seconds` ago (for the member, the channel or the server)"),
  z
    .object({ do: z.literal("set_var"), ...If, name: VarName, value: z.string().max(2000) })
    .strict()
    .describe("Save a text as {{var.<name>}} (a template, with filters)"),
  z
    .object({
      do: z.literal("random"),
      ...If,
      saveAs: VarName,
      min: z.number().int().optional(),
      max: z.number().int().optional(),
      pick: z
        .array(z.object({ value: z.string().min(1).max(500), weight: z.number().positive().max(1_000_000).default(1) }).strict())
        .min(1)
        .max(100)
        .optional()
        .describe("A loot table: one value, by weight"),
    })
    .strict()
    .refine((s) => (s.pick ? s.min === undefined && s.max === undefined : s.min !== undefined && s.max !== undefined && s.min <= s.max), {
      message: "`random` takes `min` and `max` (min ≤ max), or `pick`",
    })
    .describe("A random whole number between min and max, or one of `pick` by weight: {{var.<saveAs>}}"),
  z
    .object({
      do: z.literal("math"),
      ...If,
      saveAs: VarName,
      expr: z.string().min(1).max(300).describe("Numbers, + - * / % ( ), min() max() round() floor() ceil() abs(); placeholders are filled first"),
    })
    .strict()
    .describe("Arithmetic (never code): {{var.<saveAs>}}"),
  z
    .object({
      do: z.literal("later"),
      ...If,
      minutes: NumberRef.describe("1 minute to 30 days"),
      steps: lazySteps(),
    })
    .strict()
    .describe("Run these steps later (reminders, timed roles, ends of events). They see the values of now"),

  // ── Discord actions ──
  z
    .object({ do: z.literal("dm"), ...If, userId: UserRef.optional(), ...MessageFields })
    .strict()
    .describe("Send a direct message (fails quietly when the member closed their DMs)"),
  z
    .object({ do: z.literal("delete_message"), ...If, channelId: ChannelRef.default("$channel"), messageId: MessageRef.default("$message") })
    .strict()
    .describe("Delete a message (the one the button is on, by default)"),
  z
    .object({
      do: z.literal("pin_message"),
      ...If,
      channelId: ChannelRef.default("$channel"),
      messageId: MessageRef.default("$message"),
      unpin: z.boolean().optional(),
    })
    .strict()
    .describe("Pin (or unpin) a message"),
  z
    .object({
      do: z.literal("react"),
      ...If,
      channelId: ChannelRef.default("$channel"),
      messageId: MessageRef.default("$message"),
      emoji: z.string().min(1).max(64).describe("A unicode emoji, or name:id for a custom one"),
    })
    .strict()
    .describe("Add a reaction from the bot"),
  z
    .object({ do: z.literal("toggle_role"), ...If, roleId: RoleRef, userId: UserRef.optional(), saveAs: VarName.optional() })
    .strict()
    .describe("Give the role if missing, take it if present; {{var.<saveAs>}} is `added` or `removed`"),
  z
    .object({
      do: z.literal("timeout"),
      ...If,
      userId: UserRef,
      minutes: NumberRef.describe("Up to 40320 (28 days); 0 lifts it"),
      reason: z.string().max(400).optional(),
    })
    .strict()
    .describe("Time a member out (they cannot write or speak)"),
  z
    .object({ do: z.literal("kick"), ...If, userId: UserRef, reason: z.string().max(400).optional() })
    .strict()
    .describe("Remove a member from the server"),
  z
    .object({
      do: z.literal("ban"),
      ...If,
      userId: UserRef,
      reason: z.string().max(400).optional(),
      deleteMessageHours: z.number().int().min(0).max(168).optional(),
    })
    .strict()
    .describe("Ban a member"),
  z
    .object({ do: z.literal("set_nickname"), ...If, userId: UserRef.optional(), nickname: z.string().max(200) })
    .strict()
    .describe("Change a member's nickname (empty = back to their name)"),
  z
    .object({
      do: z.literal("create_thread"),
      ...If,
      channelId: ChannelRef.default("$channel"),
      messageId: MessageRef.optional().describe("Start it on this message; without it, a thread of its own"),
      name: z.string().min(1).max(100),
      private: z.boolean().optional().describe("Only invited members and moderators see it"),
      invite: UserRef.optional().describe("Add this member (default: whoever triggered it, for a private thread)"),
      autoArchiveMinutes: z.union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)]).optional(),
      saveAs: LocalId.optional().describe("Its id as {{sent.<saveAs>}}: send_message there with channelId {{sent.<saveAs>}}"),
    })
    .strict()
    .describe("Open a thread (tickets, matches, help desks)"),
  z
    .object({
      do: z.literal("close_thread"),
      ...If,
      channelId: ChannelRef.default("$channel"),
      lock: z.boolean().default(true),
    })
    .strict()
    .describe("Archive a thread (and lock it so only moderators reopen it)"),
  z
    .object({
      do: z.literal("poll"),
      ...If,
      channelId: ChannelRef.default("$channel"),
      question: z.string().min(1).max(300),
      answers: z
        .array(z.object({ text: z.string().min(1).max(55), emoji: z.string().min(1).max(64).optional() }).strict())
        .min(2)
        .max(10),
      hours: z.number().int().min(1).max(768).default(24),
      multiselect: z.boolean().optional(),
      saveAs: LocalId.optional(),
    })
    .strict()
    .describe("Post a Discord poll (votes and results are Discord's own)"),

  z
    .object({
      do: z.literal("card"),
      ...If,
      global: z.boolean().optional().describe("The member's balance across every server of this bot (credits, global XP)"),
      kind: z.enum(["rank", "wallet", "leaderboard", "stat"]).describe("rank: level and XP; wallet: a balance; leaderboard: the top 10; stat: your title and value"),
      userId: UserRef.optional().describe("Whose card (default: whoever triggered it)"),
      currency: CurrencyId.describe("For wallet and leaderboard (xp shows levels)"),
      title: z.string().max(200).optional().describe("wallet: the currency's name; leaderboard and stat: the title"),
      value: z.string().max(200).optional().describe("stat: the big value (a template)"),
      subtitle: z.string().max(200).optional().describe("stat and wallet: a line under it"),
      withMember: z.boolean().optional().describe("stat: draw the member's avatar"),
      limit: z.number().int().min(1).max(10).optional(),
      accent: z.string().max(200).optional().describe("#rrggbb or a template giving one"),
      background: z.string().max(200).optional().describe("#rrggbb or a template giving one"),
      name: LocalId.default("card").describe("The file: card.png; an embed shows it with image: attachment://card.png"),
    })
    .strict()
    .describe("Draw an image card; the next message (or the answer itself) carries it as <name>.png"),

  // ── Economy: currencies, items, lists (shared by every module of the server) ──
  z
    .object({
      do: z.literal("wallet_add"),
      ...If,
      global: z.boolean().optional().describe("The member's balance across every server of this bot (credits, global XP)"),
      currency: CurrencyId,
      amount: NumberRef,
      userId: UserRef.optional(),
      saveAs: VarName.optional().describe("The new balance"),
    })
    .strict()
    .describe("Give coins, XP or any currency (a negative amount takes, never below 0)"),
  z
    .object({
      do: z.literal("wallet_take"),
      ...If,
      global: z.boolean().optional().describe("The member's balance across every server of this bot (credits, global XP)"),
      currency: CurrencyId,
      amount: NumberRef,
      userId: UserRef.optional(),
      saveAs: VarName.optional().describe("The new balance"),
      else: Template.optional().describe("When the balance is short: this answer, and stop (default: 'Not enough <currency>.')"),
    })
    .strict()
    .describe("Charge a price: all or nothing"),
  z
    .object({
      do: z.literal("wallet_get"),
      ...If,
      global: z.boolean().optional().describe("The member's balance across every server of this bot (credits, global XP)"),
      currency: CurrencyId,
      userId: UserRef.optional(),
      saveAs: VarName,
    })
    .strict()
    .describe("Read a balance into {{var.<saveAs>}} (and the place in the server into {{var.<saveAs>_rank}})"),
  z
    .object({
      do: z.literal("leaderboard"),
      ...If,
      global: z.boolean().optional().describe("The member's balance across every server of this bot (credits, global XP)"),
      currency: CurrencyId,
      limit: z.number().int().min(1).max(25).default(10),
      line: z.string().max(200).default("**{{rank}}.** <@{{user}}> — {{balance|number}}").describe("One line: {{rank}} {{user}} {{balance}}"),
      saveAs: VarName,
    })
    .strict()
    .describe("The top balances as text in {{var.<saveAs>}}"),
  z
    .object({
      do: z.literal("item_add"),
      ...If,
      item: ItemId,
      quantity: NumberRef.default(1),
      userId: UserRef.optional(),
      saveAs: VarName.optional(),
    })
    .strict()
    .describe("Put an item in a member's inventory; {{var.<saveAs>}} is how many they have now"),
  z
    .object({
      do: z.literal("item_take"),
      ...If,
      item: ItemId,
      quantity: NumberRef.default(1),
      userId: UserRef.optional(),
      saveAs: VarName.optional(),
      else: Template.optional(),
    })
    .strict()
    .describe("Use up an item: all or nothing, like `wallet_take`"),
  z
    .object({
      do: z.literal("slowmode"),
      ...If,
      channelId: ChannelRef.default("$channel"),
      seconds: NumberRef.describe("0 (off) to 21600 (6 h)"),
    })
    .strict()
    .describe("Set a channel's slowmode"),
  z
    .object({
      do: z.literal("activity_get"),
      ...If,
      metric: z.enum(["messages", "voice"]).default("messages").describe("voice: minutes"),
      days: z.number().int().min(0).max(3650).optional().describe("Since how many days ago (0 = today); none = all time"),
      userId: UserRef.optional(),
      saveAs: VarName.describe("The count; {{var.<saveAs>_rank}} the place"),
    })
    .strict()
    .describe("A member's messages or voice minutes in a period"),
  z
    .object({
      do: z.literal("activity_top"),
      ...If,
      metric: z.enum(["messages", "voice"]).default("messages"),
      days: z.number().int().min(0).max(3650).default(7).describe("The last N days (7 = this week)"),
      limit: z.number().int().min(1).max(25).default(10),
      line: z.string().max(200).default("**{{rank}}.** <@{{user}}> — {{value|number}}"),
      saveAs: VarName.describe("Text; {{var.<saveAs>_first}} is the winner's id, _list the rows"),
    })
    .strict()
    .describe("The most active members of a period, as text (weekly leaderboards)"),
  z
    .object({
      do: z.literal("item_random"),
      ...If,
      kind: z.enum(["item", "consumable", "role", "badge", "background", "pet"]).optional(),
      rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]).optional().describe("Only this rarity; none = weighted by rarity"),
      userId: UserRef.optional().describe("Who gets it (default: whoever triggered it)"),
      saveAs: VarName.describe("{{var.<saveAs>}} the id; _name _emoji _rarity _color _image _count"),
    })
    .strict()
    .describe("A random catalog item (common 60, uncommon 25, rare 10, epic 4, legendary 1, times its drop weight) into the inventory"),
  z
    .object({
      do: z.literal("item_transfer"),
      ...If,
      item: ItemId,
      quantity: NumberRef.default(1),
      from: UserRef.optional().describe("Default: whoever triggered it"),
      to: UserRef,
      else: Template.optional(),
    })
    .strict()
    .describe("Move items from one member to another: all or nothing (items marked not tradeable refuse)"),
  z
    .object({ do: z.literal("item_use"), ...If, item: ItemId, userId: UserRef.optional() })
    .strict()
    .describe("Tell every module a member used an item (runs `item_used` triggers); take it first with item_take"),
  z
    .object({ do: z.literal("item_get"), ...If, item: ItemId, userId: UserRef.optional(), saveAs: VarName })
    .strict()
    .describe("How many of an item a member has"),
  z
    .object({
      do: z.literal("list_join"),
      ...If,
      list: ListName,
      userId: UserRef.optional(),
      mode: z.enum(["join", "leave", "toggle"]).default("join"),
      saveAs: VarName.optional().describe("`joined`, `left` or `already`; {{var.<saveAs>_count}} is how many are in"),
    })
    .strict()
    .describe("Join or leave a list of members (entries, a queue, a team)"),
  z
    .object({
      do: z.literal("list_pick"),
      ...If,
      list: ListName,
      count: z.number().int().min(1).max(50).default(1),
      remove: z.boolean().optional().describe("Take the winners out of the list"),
      saveAs: VarName.describe("Mentions joined with ', '; {{var.<saveAs>_list}} as a list of ids"),
    })
    .strict()
    .describe("Draw random members from a list (raffles, giveaways)"),
  z
    .object({ do: z.literal("list_count"), ...If, list: ListName, saveAs: VarName })
    .strict()
    .describe("How many members are in a list"),
  z
    .object({ do: z.literal("list_clear"), ...If, list: ListName })
    .strict()
    .describe("Empty a list"),
]);
export type BlueprintStep = z.infer<typeof BlueprintStep>;

export const Steps = z.array(BlueprintStep).min(1).max(25);

// ── Commands ────────────────────────────────────────────────────────────────────────────────────

export const COMMAND_OPTION_TYPES = ["string", "integer", "number", "boolean", "user", "role", "channel"] as const;

export const Choice = z.object({ name: z.string().min(1).max(100), value: z.union([z.string().min(1).max(100), z.number()]) }).strict();
export type Choice = z.infer<typeof Choice>;

export const BlueprintCommandOption = z
  .object({
    name: z.string().regex(/^[a-z0-9_-]{1,32}$/, "Lowercase, 1–32 characters"),
    description: z.string().min(1).max(100),
    type: z.enum(COMMAND_OPTION_TYPES),
    required: z.boolean().optional(),
    choices: z.array(Choice).min(1).max(25).optional().describe("Fixed values to pick from"),
    autocomplete: z
      .union([z.object({ choices: z.array(Choice).min(1).max(200) }).strict(), KonSource])
      .optional()
      .describe("Suggestions while typing: a fixed list filtered by what is typed, or another kon's list"),
    min: z.number().optional(),
    max: z.number().optional(),
    minLength: z.number().int().min(0).max(6000).optional(),
    maxLength: z.number().int().min(1).max(6000).optional(),
  })
  .strict()
  .refine((o) => !(o.choices && o.autocomplete), { message: "`choices` or `autocomplete`, not both" })
  .refine((o) => !(o.choices || o.autocomplete) || ["string", "integer", "number"].includes(o.type), {
    message: "Choices and autocomplete apply to string, integer and number options",
  });
export type BlueprintCommandOption = z.infer<typeof BlueprintCommandOption>;

export const BlueprintSubcommand = z
  .object({
    name: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    description: z.string().min(1).max(100),
    options: z.array(BlueprintCommandOption).max(25).optional(),
    steps: Steps,
  })
  .strict();

export const BlueprintCommand = z
  .object({
    /**
     * `slash` (default) is typed as /name; `user` and `message` are context menus: right click on a
     * member or a message → Apps → name. They take no options; `{{target.*}}` is what was clicked.
     */
    type: z.enum(["slash", "user", "message"]).default("slash"),
    name: z.string().min(1).max(32).describe("Slash: lowercase, no spaces. Context menu: any text (e.g. 'Give a cookie')"),
    description: z.string().min(1).max(100).optional().describe("Required for slash commands"),
    options: z.array(BlueprintCommandOption).max(25).optional(),
    subcommands: z.array(BlueprintSubcommand).min(1).max(25).optional(),
    access: Access.optional(),
    /**
     * Who sees the command at all (Discord hides it from the rest; server admins can change it in
     * Server Settings → Integrations). `access` still checks on every use.
     */
    defaultPermissions: z.array(PermissionName).min(1).max(10).optional(),
    steps: Steps.optional(),
  })
  .strict()
  .refine((c) => !!c.steps !== !!c.subcommands, { message: "A command has `steps` or `subcommands`, one of the two" })
  .refine((c) => !(c.subcommands && c.options), { message: "With subcommands, options go in each subcommand" })
  .refine((c) => c.type !== "slash" || /^[a-z0-9_-]{1,32}$/.test(c.name), {
    message: "A slash command's name is lowercase, 1–32 characters, no spaces",
  })
  .refine((c) => c.type !== "slash" || !!c.description, { message: "A slash command needs a description" })
  .refine((c) => c.type === "slash" || (!c.options && !c.subcommands), { message: "A context menu takes no options or subcommands" });
export type BlueprintCommand = z.infer<typeof BlueprintCommand>;

// ── Triggers, modals, panels ────────────────────────────────────────────────────────────────────

export const BLUEPRINT_TRIGGERS = ["member_join", "member_leave", "message", "reaction_add", "kon_event", "schedule", "item_used", "voice_join", "voice_leave", "reaction_remove"] as const;

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * When a `schedule` trigger runs: every N minutes, or at a time of day (on some weekdays) in a time
 * zone. Scheduled steps have no channel or member: `send_message` names its channel.
 */
export const Schedule = z
  .object({
    everyMinutes: z.number().int().min(5).max(43_200).optional(),
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24 h").optional(),
    days: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional().describe("Default: every day"),
    timezone: z.string().max(64).default("UTC").refine(isTimeZone, { message: "Not a time zone (e.g. America/Lima)" }),
  })
  .strict()
  .refine((s) => !!s.everyMinutes !== !!s.at, { message: "A schedule has `everyMinutes` or `at`, one of the two" })
  .refine((s) => !s.days || !!s.at, { message: "`days` goes with `at`" });
export type Schedule = z.output<typeof Schedule>;

export const BlueprintTrigger = z
  .object({
    on: z.enum(BLUEPRINT_TRIGGERS),
    /** For `kon_event`: the event of another kon (`broadcast:match:updated`). */
    event: KonEventName.optional(),
    /**
     * Plain text matching only (no regular expressions: a blueprint is data anyone may import, and a
     * crafted pattern would hang the API). `contains`/`startsWith` need the privileged Message
     * Content intent.
     */
    match: z
      .object({
        contains: z.string().min(1).max(100).optional(),
        startsWith: z.string().min(1).max(100).optional(),
        channelId: Snowflake.optional(),
        emoji: z.string().min(1).max(64).optional(),
        item: z.string().regex(/^[a-z0-9_-]{1,64}$/).optional().describe("item_used: only this item"),
      })
      .strict()
      .optional(),
    where: Condition.optional().describe("Extra guard, e.g. on {{event.status}}"),
    /** For `schedule`: when it runs. */
    schedule: Schedule.optional(),
    steps: Steps,
  })
  .strict()
  .refine((t) => (t.on === "schedule") === !!t.schedule, { message: "`schedule` is required with on: schedule, and only there" })
  .refine((t) => !t.match?.emoji || t.on === "reaction_add" || t.on === "reaction_remove", { message: "`emoji` only applies to reaction_add and reaction_remove" })
  .refine((t) => !t.match?.item || t.on === "item_used", { message: "`item` only applies to item_used" })
  .refine((t) => !(t.match?.contains || t.match?.startsWith) || t.on === "message", {
    message: "`contains` and `startsWith` only apply to message",
  })
  .refine((t) => (t.on === "kon_event") === !!t.event, { message: "`event` is required with kon_event, and only there" })
  .refine((t) => !t.event?.startsWith(BLUEPRINT_EVENT_PREFIX), {
    message: "A blueprint cannot listen to blueprint events (it would loop)",
  });
export type BlueprintTrigger = z.infer<typeof BlueprintTrigger>;

export const BlueprintModal = z
  .object({
    id: LocalId,
    title: z.string().min(1).max(45),
    inputs: z
      .array(
        z
          .object({
            id: LocalId,
            label: z.string().min(1).max(45),
            style: z.enum(["short", "paragraph"]).default("short"),
            required: z.boolean().optional(),
            minLength: z.number().int().min(0).max(4000).optional(),
            maxLength: z.number().int().min(1).max(4000).optional(),
            placeholder: z.string().min(1).max(100).optional(),
            value: z.string().max(4000).optional().describe("Prefilled text (template: {{kv.*}}, {{data.<name>.*}} and the rest)"),
          })
          .strict()
      )
      .min(1)
      .max(5),
    /** Read before the modal opens, to prefill it: `{{data.<name>.*}}`. GET only, and fast (Discord waits 3 s). */
    data: z.record(LocalId, KonPath).optional(),
    access: Access.optional(),
    steps: Steps,
  })
  .strict()
  .refine((m) => Object.keys(m.data ?? {}).length <= 3, { message: "Up to 3 data sources" });
export type BlueprintModal = z.infer<typeof BlueprintModal>;

export const BlueprintPanel = z
  .object({
    id: LocalId,
    /** Read before each redraw: `{{data.<name>.*}}`. GET only. */
    data: z.record(LocalId, KonPath).optional(),
    ...MessageFields,
    /** Kon events that redraw every copy of this panel (`broadcast:match:updated`). */
    refreshOn: z.array(KonEventName).max(10).optional(),
  })
  .strict()
  .refine(hasBody, { message: "A panel needs `content` or `embeds`" })
  .refine((p) => Object.keys(p.data ?? {}).length <= 5, { message: "Up to 5 data sources" });
export type BlueprintPanel = z.infer<typeof BlueprintPanel>;

// ── The definition ──────────────────────────────────────────────────────────────────────────────

/** Where a step list lives: decides which steps make sense there. */
export type StepPlace = "command" | "component" | "modal" | "trigger" | "later";

export interface PlacedSteps {
  place: StepPlace;
  where: string;
  steps: BlueprintStep[];
}

interface DefinitionShape {
  commands: BlueprintCommand[];
  triggers: BlueprintTrigger[];
  modals: BlueprintModal[];
  panels: BlueprintPanel[];
}

const stepsOf = (steps: AnyStep[]) => steps as unknown as BlueprintStep[];

/** Every component of the blueprint, wherever its message is (panels, replies, sent messages). */
export function allComponents(def: DefinitionShape): MessageComponent[] {
  const out: MessageComponent[] = [];
  const seen = new Set<unknown>();
  const visitSteps = (steps: BlueprintStep[]) => {
    for (const s of steps) {
      if ((s.do === "reply" || s.do === "update_message" || s.do === "send_message" || s.do === "dm") && s.components) {
        for (const c of s.components.flat()) visit(c);
      }
      if (s.do === "later") visitSteps(stepsOf(s.steps));
    }
  };
  const visit = (c: MessageComponent) => {
    if (seen.has(c)) return;
    seen.add(c);
    out.push(c);
    if (c.type !== "link") visitSteps(stepsOf(c.steps));
  };
  for (const p of def.panels) (p.components ?? []).flat().forEach(visit);
  for (const c of def.commands) {
    if (c.steps) visitSteps(c.steps);
    c.subcommands?.forEach((s) => visitSteps(s.steps));
  }
  def.triggers.forEach((t) => visitSteps(t.steps));
  def.modals.forEach((m) => visitSteps(m.steps));
  return out;
}

/** Every step list with where it is (the steps of a `later` are a list of their own). */
export function placedSteps(def: DefinitionShape): PlacedSteps[] {
  const out: PlacedSteps[] = [];
  const add = (place: StepPlace, where: string, steps: BlueprintStep[]) => {
    out.push({ place, where, steps });
    steps.forEach((s, i) => {
      if (s.do === "later") add("later", `${where} › later ${i + 1}`, stepsOf(s.steps));
    });
  };
  for (const c of def.commands) {
    if (c.steps) add("command", `/${c.name}`, c.steps);
    c.subcommands?.forEach((s) => add("command", `/${c.name} ${s.name}`, s.steps));
  }
  def.triggers.forEach((t, i) => add("trigger", `trigger ${i + 1} (${t.on})`, t.steps));
  def.modals.forEach((m) => add("modal", `modal ${m.id}`, m.steps));
  for (const c of allComponents(def)) {
    if (c.type !== "link") add("component", `component ${c.id}`, stepsOf(c.steps));
  }
  return out;
}

/** Steps that answer an interaction: they make no sense where nobody is waiting for an answer. */
const ANSWERS = new Set(["reply", "update_message", "open_modal"]);

/** The problems a parsed definition has across its parts. Empty = fine. */
export function crossCheck(def: DefinitionShape): string[] {
  const problems: string[] = [];
  if (def.commands.length + def.triggers.length + def.panels.length === 0) {
    problems.push("A blueprint needs a command, a trigger or a panel");
  }
  if (new Set(def.commands.map((c) => c.name)).size !== def.commands.length) problems.push("Two commands with the same name");
  const modalIds = new Set(def.modals.map((m) => m.id));
  const panelIds = new Set(def.panels.map((p) => p.id));
  if (modalIds.size !== def.modals.length) problems.push("Two modals with the same id");
  if (panelIds.size !== def.panels.length) problems.push("Two panels with the same id");
  const componentIds = allComponents(def).flatMap((c) => (c.type === "link" ? [] : [c.id]));
  if (new Set(componentIds).size !== componentIds.length) problems.push("Two buttons or selects with the same id");

  for (const { place, where, steps } of placedSteps(def)) {
    const quiet = place === "trigger" || place === "later";
    steps.forEach((s, index) => {
      if (quiet && ANSWERS.has(s.do)) {
        problems.push(`${where}: \`${s.do}\` answers an interaction; nobody is waiting here (use \`send_message\` or \`dm\`)`);
        return;
      }
      if (s.do === "update_message" && place !== "component" && place !== "modal") {
        problems.push(`${where}: \`update_message\` only works on a button, a select or their modal`);
      }
      if (s.do === "open_modal") {
        // Discord opens a modal only as the immediate answer: the open_modal steps come first, and
        // the first whose `if` holds wins; the rest run only when none does.
        if (steps.slice(0, index).some((x) => x.do !== "open_modal")) {
          problems.push(`${where}: \`open_modal\` steps go first (Discord opens a modal only as the immediate answer)`);
        }
        if (place === "modal") problems.push(`${where}: a modal opens from a command or a component`);
        if (!modalIds.has(s.modal)) problems.push(`${where}: no modal "${s.modal}"`);
      }
      if ((s.do === "post_panel" || s.do === "refresh_panels") && s.panel && !panelIds.has(s.panel)) {
        problems.push(`${where}: no panel "${s.panel}"`);
      }
      if ((s.do === "reply" || s.do === "update_message" || s.do === "send_message" || s.do === "dm") && !hasBody(s)) {
        problems.push(`${where}: \`${s.do}\` needs \`content\` or \`embeds\``);
      }
      if (s.do === "later" && place === "later") problems.push(`${where}: a \`later\` inside a \`later\` (schedule it once)`);
    });
  }
  return problems;
}

export const BlueprintDefinition = z
  .object({
    format: z.literal(BLUEPRINT_FORMAT).default(BLUEPRINT_FORMAT),
    commands: z.array(BlueprintCommand).max(25).default([]),
    triggers: z.array(BlueprintTrigger).max(25).default([]),
    modals: z.array(BlueprintModal).max(25).default([]),
    panels: z.array(BlueprintPanel).max(10).default([]),
  })
  .strict()
  .superRefine((def, ctx) => {
    for (const message of crossCheck(def)) ctx.addIssue({ code: "custom", message });
  });
export type BlueprintDefinition = z.output<typeof BlueprintDefinition>;
export type BlueprintDefinitionInput = z.input<typeof BlueprintDefinition>;

/** The portable file: what `GET /export` gives and `POST /import` takes. No secrets, ever. */
export const DcExport = z
  .object({
    kind: z.literal("kitsuden.dc/export"),
    format: z.literal(BLUEPRINT_FORMAT),
    exportedAt: z.string(),
    blueprints: z
      .array(
        z
          .object({
            id: z.guid(),
            name: z.string().min(1).max(100),
            description: z.string().max(2000).nullable(),
            status: z.enum(["draft", "published"]),
            revision: z.number().int().min(1),
            definition: BlueprintDefinition,
          })
          .strict()
      )
      .max(500),
    guilds: z
      .array(
        z
          .object({
            id: Snowflake,
            name: z.string().min(1).max(100),
            modules: z
              .array(
                z
                  .object({
                    moduleId: z.string().min(1).max(60),
                    enabled: z.boolean(),
                    config: z.record(z.string(), z.unknown()),
                  })
                  .strict()
              )
              .max(200),
          })
          .strict()
      )
      .max(1000),
  })
  .strict();
export type DcExport = z.output<typeof DcExport>;

// ── Gateway worker ⇄ kon ────────────────────────────────────────────────────────────────────────

/** `GET /api/dc/gateway/config`: what the worker identifies with and what it forwards. */
export const GatewayConfig = z
  .object({
    contract: z.literal(GATEWAY_CONTRACT_VERSION),
    intents: z.number().int().min(0).describe("Bitfield sent in IDENTIFY"),
    events: z.array(z.enum(GATEWAY_EVENTS)).describe("Dispatch types to forward; the rest are dropped in the worker"),
    revision: z.string().describe("Changes when intents or events change: the worker re-identifies"),
  })
  .strict();
export type GatewayConfig = z.output<typeof GatewayConfig>;

/** One gateway dispatch as the worker forwards it. `d` is Discord's payload, trimmed by the worker. */
export const GatewayEventEnvelope = z
  .object({
    t: z.enum(GATEWAY_EVENTS),
    s: z.number().int().min(0).describe("Sequence number on its shard"),
    shard: z.tuple([z.number().int().min(0), z.number().int().min(1)]).describe("[shard id, shard count]"),
    receivedAt: z.string().describe("RFC 3339, when the worker read it"),
    d: z.record(z.string(), z.unknown()),
  })
  .strict();
export type GatewayEventEnvelope = z.output<typeof GatewayEventEnvelope>;

/** `POST /api/dc/gateway/events`. */
export const GatewayEventBatch = z
  .object({
    contract: z.literal(GATEWAY_CONTRACT_VERSION),
    events: z.array(GatewayEventEnvelope).min(1).max(100),
  })
  .strict();
export type GatewayEventBatch = z.output<typeof GatewayEventBatch>;

export const GatewayIngestResult = z
  .object({
    accepted: z.number().int().min(0),
    dropped: z.number().int().min(0).describe("Events the kon could not queue (busy); not retried"),
  })
  .strict();
export type GatewayIngestResult = z.output<typeof GatewayIngestResult>;

/**
 * The gateway contract as JSON Schema (draft 2020-12), keyed by the file name it is committed under in
 * `gateway/contract/`. The input side of each schema: what goes over the wire.
 */
export function gatewayContractJsonSchemas(): Record<string, unknown> {
  const opts = { target: "draft-2020-12" as const, io: "input" as const };
  return {
    "gateway-config": z.toJSONSchema(GatewayConfig, opts),
    "gateway-event-batch": z.toJSONSchema(GatewayEventBatch, opts),
    "gateway-ingest-result": z.toJSONSchema(GatewayIngestResult, opts),
  };
}

/** The blueprint format as JSON Schema, for editors and for an LLM asked to write one. */
export function blueprintJsonSchema(): unknown {
  return z.toJSONSchema(BlueprintDefinition, { target: "draft-2020-12", io: "input", unrepresentable: "any" });
}

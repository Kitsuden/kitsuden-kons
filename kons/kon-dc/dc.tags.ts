/**
 * kon-dc — tags and the embed builder
 * ============================================================================
 *
 *   tags    `/tag <name>` posts a saved text; `/tags create | edit | delete` (staff, through a form)
 *           and `/tags list | info` (everyone). Names autocomplete. Stored per server.
 *   embeds  `/embed post [channel]` opens a form (title, description, color, image URL, footer) and
 *           posts the embed; `/embed edit <message link>` opens it again, filled in, for a message
 *           the bot posted. Staff only.
 *
 * Who is staff is a Discord permission (Manage Messages by default) or one of some roles, checked
 * when the form opens AND again when it is submitted.
 */

import { z } from "zod";

import { PermissionName, Snowflake } from "./dc.contract";
import { langOf, translate } from "./dc.i18n";
import {
  baseVars,
  clip,
  customId,
  defineDcModule,
  hasPermissions,
  permissionBits,
  registerDcModule,
  render,
  type DcModule,
  type ModalPayload,
  type ModuleRuntime,
  type Reply,
} from "./dc.modules";
import { DiscordApiError, type ChannelInfo } from "./dc.rest";

const ME = (text: string): Reply => ({ content: clip(text), ephemeral: true });

const Staff = {
  staffPermission: PermissionName.default("manage_messages").meta({ title: "Staff permission", description: "Members with it are staff" }),
  staffRoles: z.array(Snowflake).max(25).default([]).meta({ title: "Staff roles", description: "Members with one of these are staff too" }),
};

const isStaff = (config: { staffPermission: PermissionName; staffRoles: string[] }, roles: string[], permissions: string | null) =>
  hasPermissions(permissions, [config.staffPermission]) || config.staffRoles.some((r) => roles.includes(r));

async function readJson<T>(rt: Pick<ModuleRuntime, "kv">, key: string, fallback: T): Promise<T> {
  const raw = await rt.kv.get(key);
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ── Tags ────────────────────────────────────────────────────────────────────────────────────────

const TagsConfig = z
  .object({
    ...Staff,
    maxTags: z.number().int().min(1).max(500).default(200).meta({ title: "Most tags in the server" }),
  })
  .strict();

interface Tag {
  content: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
}

/** A tag name: lower case, spaces as `-`, letters, digits, `-` and `_`, up to 30 (it rides in a form's id). */
export function tagName(value: unknown): string | null {
  const n = String(value ?? "")
    .trim()
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .join("-");
  return /^[a-z0-9_-]{1,30}$/.test(n) ? n : null;
}

function tagModal(id: string, title: string, label: string, value: string): ModalPayload {
  return {
    custom_id: customId("tags", id),
    title: clip(title, 45),
    components: [
      {
        type: 1,
        components: [{ type: 4, custom_id: "content", label: clip(label, 45), style: 2, required: true, max_length: 2000, ...(value ? { value } : {}) }],
      },
    ],
  };
}

const nameOpt = { name: "name", description: "The tag's name", type: 3, required: true, max_length: 30, autocomplete: true };

export const tagsModule = defineDcModule({
  id: "tags",
  name: "Tags",
  description: "/tag <name> posts a saved text; the staff create, edit and delete them, everyone lists them.",
  config: TagsConfig,
  intents: 0,
  events: [],
  commands: () => [
    { name: "tag", description: "Post a saved text", type: 1, options: [nameOpt] },
    {
      name: "tags",
      description: "The server's saved texts",
      type: 1,
      options: [
        { name: "create", description: "Staff: a new tag", type: 1, options: [{ ...nameOpt, autocomplete: false }] },
        { name: "edit", description: "Staff: change a tag", type: 1, options: [nameOpt] },
        { name: "delete", description: "Staff: delete a tag", type: 1, options: [nameOpt] },
        { name: "list", description: "Every tag", type: 1 },
        { name: "info", description: "Who made a tag, and how often it is used", type: 1, options: [nameOpt] },
      ],
    },
  ],

  plan(target, config, where, full) {
    const lang = langOf(where.locale);
    if (target.kind === "command" && target.name === "tag") return { reply: true, ephemeral: false };
    if (target.kind === "command" && target.name === "tags" && ["create", "edit", "delete"].includes(target.subcommand ?? "")) {
      if (!isStaff(config, where.memberRoles, where.memberPermissions)) return { deny: translate(lang, "Only the staff can change tags.") };
      const name = tagName(target.options.name);
      if (!name) return { deny: translate(lang, "A tag name is up to 30 letters, digits, - or _.") };
      const title = translate(lang, "Tag {name}", { name });
      const label = translate(lang, "Tag text");
      if (target.subcommand === "create") return { modal: tagModal(`c-${name}`, title, label, "") };
      if (target.subcommand === "edit" && full) {
        // A tag that does not exist opens no form: the command then says so.
        return {
          reply: true,
          ephemeral: true,
          modalAsync: async () => {
            const tag = await readJson<Tag | null>(full(), `tag:${name}`, null);
            return tag ? tagModal(`e-${name}`, title, label, tag.content) : null;
          },
        };
      }
    }
    return { reply: true, ephemeral: true };
  },

  async onAutocomplete(request, _config, rt) {
    const typed = request.focused.toLowerCase();
    const names = await readJson<string[]>(rt, "index", []);
    const starts = names.filter((n) => n.startsWith(typed));
    const inside = names.filter((n) => !n.startsWith(typed) && n.includes(typed));
    return [...starts, ...inside].slice(0, 25).map((n) => ({ name: n, value: n }));
  },

  async onCommand(invocation, config, rt) {
    if (!rt.user) return null;
    const name = tagName(invocation.options.name);
    if (invocation.name === "tag") {
      const tag = name ? await readJson<Tag | null>(rt, `tag:${name}`, null) : null;
      if (!tag || !name) return ME(rt.t("There is no tag called {name}.", { name: String(invocation.options.name ?? "") }));
      await rt.kv.incr(`uses:${name}`, 1);
      return { content: clip(render(tag.content, baseVars(rt))) };
    }
    if (invocation.name !== "tags") return null;
    switch (invocation.subcommand) {
      case "list": {
        const names = await readJson<string[]>(rt, "index", []);
        if (!names.length) return ME(rt.t("This server has no tags yet."));
        return ME(clip(`**${rt.t("Tags ({n})", { n: names.length })}:** ${[...names].sort().map((n) => `\`${n}\``).join(", ")}`));
      }
      case "info": {
        const tag = name ? await readJson<Tag | null>(rt, `tag:${name}`, null) : null;
        if (!tag || !name) return ME(rt.t("There is no tag called {name}.", { name: String(invocation.options.name ?? "") }));
        const uses = Number(await rt.kv.get(`uses:${name}`)) || 0;
        return ME(
          rt.t("Tag {name}: made by <@{owner}> <t:{created}:R>, changed <t:{updated}:R>, used {uses} times.", {
            name,
            owner: tag.ownerId,
            created: Math.floor(tag.createdAt / 1000),
            updated: Math.floor(tag.updatedAt / 1000),
            uses,
          })
        );
      }
      case "delete": {
        if (!isStaff(config, rt.memberRoles, rt.memberPermissions)) return ME(rt.t("Only the staff can change tags."));
        if (!name || !(await readJson<Tag | null>(rt, `tag:${name}`, null))) return ME(rt.t("There is no tag called {name}.", { name: name ?? "" }));
        await rt.kv.set(`tag:${name}`, "");
        await rt.kv.set(`uses:${name}`, 0);
        const names = await readJson<string[]>(rt, "index", []);
        await rt.kv.set("index", JSON.stringify(names.filter((n) => n !== name)));
        return ME(rt.t("Deleted the tag {name}.", { name }));
      }
      case "edit":
        // Reached only when no form opened: the tag is not there.
        return ME(rt.t("There is no tag called {name}.", { name: name ?? "" }));
      default:
        return null;
    }
  },

  async onModal(submit, config, rt) {
    if (!rt.user) return null;
    if (!isStaff(config, rt.memberRoles, rt.memberPermissions)) return ME(rt.t("Only the staff can change tags."));
    const creating = submit.id.startsWith("c-");
    const name = tagName(submit.id.slice(2));
    if (!name || !(creating || submit.id.startsWith("e-"))) return null;
    const content = (submit.fields.content ?? "").trim().slice(0, 2000);
    if (!content) return ME(rt.t("A tag needs some text."));
    const old = await readJson<Tag | null>(rt, `tag:${name}`, null);
    const now = rt.now().getTime();
    if (creating) {
      if (old) return ME(rt.t("A tag called {name} already exists.", { name }));
      const names = await readJson<string[]>(rt, "index", []);
      if (names.length >= config.maxTags) return ME(rt.t("This server has {n} tags, the most it can have.", { n: names.length }));
      await rt.kv.set(`tag:${name}`, JSON.stringify({ content, ownerId: rt.user.id, createdAt: now, updatedAt: now } satisfies Tag));
      if (!names.includes(name)) await rt.kv.set("index", JSON.stringify([...names, name]));
      return ME(rt.t("Saved the tag {name}.", { name }));
    }
    if (!old) return ME(rt.t("There is no tag called {name}.", { name }));
    await rt.kv.set(`tag:${name}`, JSON.stringify({ ...old, content, updatedAt: now } satisfies Tag));
    return ME(rt.t("Saved the tag {name}.", { name }));
  },
});

// ── Embed builder ───────────────────────────────────────────────────────────────────────────────

const EmbedsConfig = z.object({ ...Staff }).strict();

/** A snowflake in base 36 (≤ 13 characters), so two fit in a form's 32-character id. */
export const short = (id: string) => BigInt(id).toString(36);
export function unshort(value: string): string | null {
  if (!/^[0-9a-z]{1,13}$/.test(value)) return null;
  let n = 0n;
  for (const c of value) n = n * 36n + BigInt(parseInt(c, 36));
  const id = n.toString();
  return /^\d{15,20}$/.test(id) ? id : null;
}

/** `https://discord.com/channels/<server>/<channel>/<message>` (also ptb., canary., discordapp.com). */
export function messageLink(value: unknown): { guildId: string; channelId: string; messageId: string } | null {
  const parts = String(value ?? "")
    .trim()
    .split("/");
  // ["https:", "", host, "channels", guild, channel, message]
  if (parts.length !== 7 || parts[0] !== "https:" || parts[1] !== "" || parts[3] !== "channels") return null;
  const hosts = ["discord.com", "ptb.discord.com", "canary.discord.com", "discordapp.com"];
  if (!hosts.includes(parts[2].toLowerCase())) return null;
  const [guildId, channelId, messageId] = parts.slice(4);
  const snow = (s: string) => /^\d{15,20}$/.test(s);
  return snow(guildId) && snow(channelId) && snow(messageId) ? { guildId, channelId, messageId } : null;
}

interface EmbedFields {
  title: string;
  description: string;
  color: string;
  image: string;
  footer: string;
}

function embedModal(id: string, lang: ReturnType<typeof langOf>, v: Partial<EmbedFields> = {}): ModalPayload {
  const field = (custom_id: keyof EmbedFields, label: string, style: 1 | 2, max: number, placeholder?: string) => ({
    type: 1,
    components: [
      {
        type: 4,
        custom_id,
        label: translate(lang, label),
        style,
        required: false,
        max_length: max,
        ...(placeholder ? { placeholder } : {}),
        ...(v[custom_id] ? { value: v[custom_id] } : {}),
      },
    ],
  });
  return {
    custom_id: customId("embeds", id),
    title: translate(lang, "Embed builder"),
    components: [
      field("title", "Embed title", 1, 256),
      field("description", "Embed text", 2, 4000),
      field("color", "Embed color", 1, 7, "#5865F2"),
      field("image", "Image URL", 1, 500, "https://"),
      field("footer", "Footer text", 1, 2048),
    ],
  };
}

/** The embed from the form's fields, or the sentence that says what is wrong. */
export function buildEmbed(f: Partial<EmbedFields>): { embed: Record<string, unknown> } | { problem: string } {
  const title = (f.title ?? "").trim();
  const description = (f.description ?? "").trim();
  if (!title && !description) return { problem: "Give the embed a title or a description." };
  const embed: Record<string, unknown> = { color: 0x5865f2 };
  if (title) embed.title = clip(title, 256);
  if (description) embed.description = clip(description, 4000);
  const color = (f.color ?? "").trim().replace(/^#/, "");
  if (color) {
    if (!/^[0-9a-fA-F]{6}$/.test(color)) return { problem: "A color is six hex digits, like #5865F2." };
    embed.color = parseInt(color, 16);
  }
  const image = (f.image ?? "").trim();
  if (image) {
    let ok = false;
    try {
      ok = new URL(image).protocol === "https:";
    } catch {
      ok = false;
    }
    if (!ok) return { problem: "The image must be an https:// link." };
    embed.image = { url: image.slice(0, 500) };
  }
  const footer = (f.footer ?? "").trim();
  if (footer) embed.footer = { text: clip(footer, 2048) };
  return { embed };
}

/** The fields of an embed already posted, to fill the form in. */
function fieldsOf(embed: Record<string, unknown> | undefined): Partial<EmbedFields> {
  if (!embed) return {};
  const color = typeof embed.color === "number" ? `#${embed.color.toString(16).padStart(6, "0").toUpperCase()}` : "";
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    title: str(embed.title),
    description: str(embed.description),
    color,
    image: str((embed.image as { url?: unknown } | undefined)?.url),
    footer: str((embed.footer as { text?: unknown } | undefined)?.text),
  };
}

const sameServer = (c: ChannelInfo | null, guildId: string) => !!c && c.guildId === guildId;

export const embedsModule = defineDcModule({
  id: "embeds",
  name: "Embed builder",
  description: "/embed post opens a form and posts an embed; /embed edit changes one the bot posted. Staff only.",
  config: EmbedsConfig,
  intents: 0,
  events: [],
  commands: (config) => [
    {
      name: "embed",
      description: "Staff: post or edit an embed",
      type: 1,
      // Discord hides it from members without the permission, unless staff roles are set.
      ...(config.staffRoles.length ? {} : { default_member_permissions: permissionBits([config.staffPermission]) }),
      options: [
        {
          name: "post",
          description: "Write an embed and post it",
          type: 1,
          options: [{ name: "channel", description: "Where (this channel if empty)", type: 7, channel_types: [0, 5, 10, 11, 12] }],
        },
        {
          name: "edit",
          description: "Change an embed the bot posted",
          type: 1,
          options: [{ name: "link", description: "The message's link (right click → Copy Message Link)", type: 3, required: true, max_length: 200 }],
        },
      ],
    },
  ],

  plan(target, config, where, full) {
    const lang = langOf(where.locale);
    if (target.kind !== "command") return { reply: true, ephemeral: true };
    if (!isStaff(config, where.memberRoles, where.memberPermissions)) return { deny: translate(lang, "Only the staff can post embeds.") };
    if (target.subcommand === "post") {
      const channel = typeof target.options.channel === "string" && /^\d{15,20}$/.test(target.options.channel) ? target.options.channel : where.channelId;
      if (!channel) return { deny: translate(lang, "Run it in a channel.") };
      return { modal: embedModal(`p-${short(channel)}`, lang) };
    }
    if (target.subcommand === "edit" && full) {
      const link = messageLink(target.options.link);
      if (!link || link.guildId !== where.guildId) return { deny: translate(lang, "That is not a link to a message in this server.") };
      return {
        reply: true,
        ephemeral: true,
        modalAsync: async () => {
          const rt = full();
          const m = await rt.rest.getMessage(link.channelId, link.messageId);
          if (rt.botUserId && m.authorId !== rt.botUserId) return null;
          return embedModal(`e-${short(link.channelId)}-${short(link.messageId)}`, lang, fieldsOf(m.embeds[0]));
        },
      };
    }
    return { reply: true, ephemeral: true };
  },

  async onCommand(invocation, config, rt) {
    if (invocation.name !== "embed") return null;
    if (!isStaff(config, rt.memberRoles, rt.memberPermissions)) return ME(rt.t("Only the staff can post embeds."));
    // Reached only when the form did not open: say why.
    if (invocation.subcommand === "edit") return ME(rt.t("I can only edit messages I posted, in a channel I can read."));
    return null;
  },

  async onModal(submit, config, rt) {
    if (!isStaff(config, rt.memberRoles, rt.memberPermissions)) return ME(rt.t("Only the staff can post embeds."));
    const [kind, a, b] = submit.id.split("-");
    const channelId = a ? unshort(a) : null;
    const messageId = b ? unshort(b) : null;
    if (!channelId || (kind !== "p" && kind !== "e") || (kind === "e" && !messageId)) return null;
    const built = buildEmbed(submit.fields);
    if ("problem" in built) return ME(rt.t(built.problem));
    // The form's id came back from Discord: the channel is checked to be in this server anyway.
    const channel = await rt.rest.getChannel(channelId).catch(() => null);
    if (!sameServer(channel, rt.guildId)) return ME(rt.t("That channel is not in this server."));
    try {
      if (kind === "p") {
        await rt.rest.sendMessage(channelId, { embeds: [built.embed] });
        return ME(rt.t("Posted in <#{channel}>.", { channel: channelId }));
      }
      await rt.rest.editMessage(channelId, messageId!, { embeds: [built.embed] });
      return ME(rt.t("Embed updated."));
    } catch (err) {
      if (err instanceof DiscordApiError && (err.status === 403 || err.status === 404)) {
        return ME(rt.t("Discord refused: I need to see that channel and send messages there."));
      }
      throw err;
    }
  },
});

export const TAG_MODULES: DcModule[] = [tagsModule as DcModule, embedsModule as DcModule];
for (const m of TAG_MODULES) registerDcModule(m);

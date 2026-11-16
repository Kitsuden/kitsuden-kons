/**
 * kon-dc — starboard
 * ============================================================================
 *
 * A message that reaches N reactions of one emoji (⭐ by default) is reposted to a starboard channel
 * as an embed: the author, the text, the first image, a jump link and the live count. More
 * reactions, or reactions taken away, update the count on the same post.
 *
 *   · a message is posted once: the post is claimed with one SQL write (`lists.join`), so two
 *     reactions at the same moment cannot post it twice;
 *   · self-stars (the author's own reaction) do not count unless the server allows them;
 *   · ignored channels and the starboard itself are never starred; messages from age-restricted
 *     channels are skipped unless the server allows them.
 *
 * The bot reads the message through Discord's REST API. Without the Message Content intent switched
 * on for the application, Discord gives an empty text for other members' messages: the post then
 * shows the author, the image and the link only.
 */

import { z } from "zod";

import { INTENTS, Snowflake } from "./dc.contract";
import { clip, defineDcModule, messageOf, registerDcModule, type DcModule, type ModuleRuntime } from "./dc.modules";
import { DiscordApiError, type MessageInfo, type MessagePayload } from "./dc.rest";

const StarboardConfig = z
  .object({
    channelId: Snowflake.meta({ title: "Starboard channel id" }),
    emoji: z.string().min(1).max(64).default("⭐").meta({ title: "Emoji", description: "A unicode emoji, or name:id for a custom one" }),
    threshold: z.number().int().min(1).max(100).default(3).meta({ title: "Reactions needed" }),
    selfStar: z.boolean().default(false).meta({ title: "Count the author's own reaction" }),
    ignoredChannels: z.array(Snowflake).max(100).default([]).meta({ title: "Never star messages from these channels" }),
    allowNsfw: z.boolean().default(false).meta({ title: "Star messages from age-restricted channels" }),
  })
  .strict();
type StarboardConfig = z.output<typeof StarboardConfig>;

const THREADS = new Set([10, 11, 12]);
const GOLD = 0xf1c40f;
const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

/** `⭐`, `name:id`, `<:name:id>` or `<a:name:id>` as reaction events name it (`name:id` or the unicode). */
export function emojiKey(value: string): string {
  let s = value.trim().replace(/️/g, "");
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1);
  const parts = s.split(":").filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}:${parts[parts.length - 1]}` : s;
}

/** How Discord draws it inside a message. */
const shown = (key: string) => (key.includes(":") ? `<:${key}>` : key);

function firstImage(m: MessageInfo): string | null {
  const a = m.attachments.find((x) => x.contentType?.startsWith("image/") || IMAGE_EXT.some((e) => x.filename.toLowerCase().endsWith(e)));
  if (a) return a.url;
  for (const e of m.embeds) {
    const url = (e.image as { url?: unknown } | undefined)?.url ?? (e.thumbnail as { url?: unknown } | undefined)?.url;
    if (typeof url === "string" && url.startsWith("https://")) return url;
  }
  return null;
}

export function starPost(m: MessageInfo, count: number, config: StarboardConfig, rt: Pick<ModuleRuntime, "guildId" | "t">): MessagePayload {
  const link = `https://discord.com/channels/${rt.guildId}/${m.channelId}/${m.id}`;
  const image = firstImage(m);
  const embed: Record<string, unknown> = {
    author: {
      name: clip(m.authorName || "?", 256),
      ...(m.authorId && m.authorAvatar ? { icon_url: `https://cdn.discordapp.com/avatars/${m.authorId}/${m.authorAvatar}.png` } : {}),
    },
    color: GOLD,
    fields: [{ name: rt.t("Original message"), value: `[${rt.t("Jump to the message")}](${link})` }],
    footer: { text: m.id },
  };
  if (m.content) embed.description = clip(m.content, 4000);
  if (image) embed.image = { url: image };
  if (m.timestamp) embed.timestamp = m.timestamp;
  return { content: `${shown(emojiKey(config.emoji))} **${count}** · <#${m.channelId}>`, embeds: [embed] };
}

/** Whether a channel (or a thread's parent) is age-restricted. */
async function ageRestricted(rt: ModuleRuntime, channelId: string): Promise<boolean> {
  let c = await rt.rest.getChannel(channelId);
  if (THREADS.has(c.type) && c.parentId) c = await rt.rest.getChannel(c.parentId);
  return c.nsfw;
}

export const starboardModule = defineDcModule({
  id: "starboard",
  name: "Starboard",
  description: "Messages that reach N reactions of an emoji are reposted to a starboard channel, with a live count.",
  config: StarboardConfig,
  intents: INTENTS.GUILD_MESSAGE_REACTIONS,
  events: ["MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE"],
  async onEvent(event, config, rt) {
    const { channelId, messageId } = event;
    if (!channelId || !messageId || !event.emoji) return;
    const key = emojiKey(config.emoji);
    if (emojiKey(event.emoji) !== key) return;
    if (channelId === config.channelId || config.ignoredChannels.includes(channelId)) return;

    let message: MessageInfo;
    try {
      message = await rt.rest.getMessage(channelId, messageId);
    } catch (err) {
      // Deleted, or a channel the bot cannot read.
      if (!(err instanceof DiscordApiError)) rt.logger.warn("Starboard: could not read the message", { message: messageOf(err) });
      return;
    }
    const raw = message.reactions.find((r) => emojiKey(r.emoji) === key)?.count ?? 0;
    const postKey = `post:${messageId}`;
    const posted = await rt.kv.get(postKey);
    const postId = typeof posted === "string" && posted ? posted : null;
    if (!postId && raw < config.threshold) return;

    let count = raw;
    if (!config.selfStar && message.authorId && raw > 0) {
      const users = await rt.rest.reactionUsers(channelId, messageId, key, 100).catch(() => [] as string[]);
      if (users.includes(message.authorId)) count -= 1;
    }

    let claimed = false;
    try {
      if (postId) {
        await rt.rest.editMessage(config.channelId, postId, starPost(message, count, config, rt));
        return;
      }
      if (count < config.threshold) return;
      if (!config.allowNsfw && (await ageRestricted(rt, channelId))) return;
      // The claim: one SQL write. Only the first of two reactions at once gets to post.
      if (!(await rt.lists.join("posted", messageId))) return;
      claimed = true;
      const sent = await rt.rest.sendMessage(config.channelId, starPost(message, count, config, rt));
      if (sent.id) await rt.kv.set(postKey, sent.id);
      rt.emit("dc:starboard:posted", { guildId: rt.guildId, channelId, messageId, authorId: message.authorId, count });
    } catch (err) {
      rt.logger.warn("Starboard: Discord refused the post", { message: messageOf(err) });
      // Not posted after all: the next reaction may try again.
      if (claimed) await rt.lists.leave("posted", messageId).catch(() => undefined);
    }
  },
});

export const STARBOARD_MODULES: DcModule[] = [starboardModule as DcModule];
for (const m of STARBOARD_MODULES) registerDcModule(m);

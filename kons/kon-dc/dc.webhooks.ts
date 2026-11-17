/**
 * kon-dc — speaking through webhooks: characters (roleplay proxies) and sticky messages
 * ============================================================================
 *
 *   characters   a member registers characters (name, avatar, brackets such as `k:text` or
 *                `[text]`), the same in every server. A message written with those brackets is
 *                deleted and posted again by a webhook with the character's name and avatar.
 *                Needs the privileged Message Content intent (Developer Portal → Bot), Manage
 *                Webhooks and Manage Messages. Attachments are not carried over.
 *                /character add | avatar | remove | list
 *   sticky       a message the bot keeps at the bottom of a channel: after others write, it is
 *                posted again (at most every N seconds) and the old copy deleted.
 *
 * A channel's webhook id and token are kept in the module's state (`hook:<channel>`): a token
 * posts in that channel only, and the team that can read dc_kv already runs the bot.
 */

import { z } from "@kitsuden/engine/zod";

import { INTENTS, Snowflake } from "./dc.contract";
import { clip, defineDcModule, messageOf, registerDcModule, type Character, type DcModule, type ModuleRuntime, type Reply } from "./dc.modules";
import { DiscordApiError } from "./dc.rest";

const ME = (text: string): Reply => ({ content: clip(text), ephemeral: true });

const MAX_CHARACTERS = 50;

/** Splits `k:text` or `[text]` into a prefix and a suffix around the word `text`. */
export function bracketsOf(example: string): { prefix: string; suffix: string } | null {
  const at = example.indexOf("text");
  if (at === -1) return null;
  const prefix = example.slice(0, at);
  const suffix = example.slice(at + 4);
  if (!prefix && !suffix) return null;
  if (prefix.length > 20 || suffix.length > 20) return null;
  return { prefix, suffix };
}

/** The character a message is written as, and the message without its brackets. */
export function matchCharacter(content: string, list: Character[]): { character: Character; text: string } | null {
  // The longest brackets first: `k:` must not win over `kk:`.
  const sorted = [...list].sort((a, b) => b.prefix.length + b.suffix.length - (a.prefix.length + a.suffix.length));
  for (const c of sorted) {
    if (content.startsWith(c.prefix) && content.endsWith(c.suffix) && content.length > c.prefix.length + c.suffix.length) {
      const text = content.slice(c.prefix.length, content.length - c.suffix.length).trim();
      if (text) return { character: c, text };
    }
  }
  return null;
}

/** The channel's webhook, made once and remembered. */
async function hookFor(rt: ModuleRuntime, channelId: string, fresh = false): Promise<{ id: string; token: string }> {
  const raw = await rt.kv.get(`hook:${channelId}`);
  if (!fresh && typeof raw === "string" && raw.includes("|")) {
    const [id, token] = raw.split("|");
    return { id, token };
  }
  const hook = await rt.rest.createWebhook(channelId, "Characters");
  await rt.kv.set(`hook:${channelId}`, `${hook.id}|${hook.token}`);
  return hook;
}

export const charactersModule = defineDcModule({
  id: "characters",
  name: "Characters",
  description: "Members speak as characters with their own name and avatar (like Tupperbox): brackets such as k:text, the same characters in every server.",
  config: z
    .object({
      ignoredChannelIds: z.array(Snowflake).max(50).default([]).meta({ title: "Channels where characters are off" }),
    })
    .strict(),
  intents: INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT,
  events: ["MESSAGE_CREATE"],
  commands: () => [
    {
      name: "character",
      description: "Your characters",
      type: 1,
      options: [
        {
          name: "add",
          description: "Create or change a character",
          type: 1,
          options: [
            { name: "name", description: "Its name", type: 3, required: true, max_length: 80 },
            { name: "brackets", description: "How you write as it: k:text, [text], text -k", type: 3, required: true, max_length: 44 },
            { name: "avatar", description: "An image link (https)", type: 3, max_length: 500 },
          ],
        },
        {
          name: "avatar",
          description: "Change its avatar",
          type: 1,
          options: [
            { name: "name", description: "Which", type: 3, required: true, autocomplete: true },
            { name: "url", description: "An image link (https)", type: 3, required: true, max_length: 500 },
          ],
        },
        { name: "remove", description: "Delete a character", type: 1, options: [{ name: "name", description: "Which", type: 3, required: true, autocomplete: true }] },
        { name: "list", description: "Your characters", type: 1 },
      ],
    },
  ],
  plan: () => ({ reply: true, ephemeral: true }),

  async onAutocomplete(request, _config, rt) {
    if (!rt.user) return [];
    const typed = request.focused.toLowerCase();
    return (await rt.characters.list(rt.user.id)).filter((c) => c.name.toLowerCase().includes(typed)).slice(0, 25).map((c) => ({ name: c.name, value: c.name }));
  },

  async onCommand(invocation, _config, rt) {
    const user = rt.user;
    if (invocation.name !== "character" || !user) return null;
    const o = invocation.options;
    const list = await rt.characters.list(user.id);
    switch (invocation.subcommand) {
      case "add": {
        const name = String(o.name ?? "").trim().slice(0, 80);
        const brackets = bracketsOf(String(o.brackets ?? ""));
        if (!name) return ME(rt.t("Give it a name."));
        if (!brackets) return ME(rt.t("Write the brackets with the word text in them: k:text, [text] or text -k."));
        const avatar = typeof o.avatar === "string" && /^https:\/\//.test(o.avatar) ? o.avatar : null;
        if (list.length >= MAX_CHARACTERS && !list.some((c) => c.name === name)) return ME(rt.t("Up to {n} characters.", { n: MAX_CHARACTERS }));
        const clash = list.find((c) => c.name !== name && c.prefix === brackets.prefix && c.suffix === brackets.suffix);
        if (clash) return ME(rt.t("{name} already uses those brackets.", { name: clash.name }));
        await rt.characters.save(user.id, { name, ...brackets, avatarUrl: avatar ?? list.find((c) => c.name === name)?.avatarUrl ?? null });
        return ME(rt.t("**{name}** is ready: write {example}.", { name, example: `${brackets.prefix}hello${brackets.suffix}` }));
      }
      case "avatar": {
        const c = list.find((x) => x.name === o.name);
        if (!c) return ME(rt.t("You have no character with that name."));
        if (typeof o.url !== "string" || !/^https:\/\//.test(o.url)) return ME(rt.t("An https image link."));
        await rt.characters.save(user.id, { name: c.name, prefix: c.prefix, suffix: c.suffix, avatarUrl: o.url });
        return ME(rt.t("{name} has a new avatar.", { name: c.name }));
      }
      case "remove":
        return ME((await rt.characters.remove(user.id, String(o.name ?? ""))) ? "Removed." : "You have no character with that name.");
      default:
        return {
          embeds: [
            {
              title: "Your characters",
              description: list.map((c) => `**${c.name}** · \`${c.prefix}text${c.suffix}\` · ${c.messages} messages`).join("\n") || "None yet: /character add.",
              color: 0x5865f2,
            },
          ],
          ephemeral: true,
        };
    }
  },

  async onEvent(event, config, rt) {
    if (event.type !== "MESSAGE_CREATE" || event.isBot || !rt.user || !event.channelId || !event.messageId || !event.content) return;
    if (config.ignoredChannelIds.includes(event.channelId)) return;
    const hit = matchCharacter(event.content, await rt.characters.list(rt.user.id));
    if (!hit) return;
    const message = { content: clip(hit.text), username: hit.character.name, avatarUrl: hit.character.avatarUrl ?? undefined };
    try {
      let hook = await hookFor(rt, event.channelId);
      try {
        await rt.rest.executeWebhook(hook.id, hook.token, message);
      } catch (err) {
        // Someone deleted the webhook: make a new one, once.
        if (!(err instanceof DiscordApiError && err.status === 404)) throw err;
        hook = await hookFor(rt, event.channelId, true);
        await rt.rest.executeWebhook(hook.id, hook.token, message);
      }
      await rt.rest.deleteMessage(event.channelId, event.messageId).catch(() => undefined);
      await rt.characters.counted(hit.character.id);
    } catch (err) {
      rt.logger.warn("Characters: could not proxy (Manage Webhooks? a thread?)", { message: messageOf(err) });
    }
  },
});

// ── Sticky messages ─────────────────────────────────────────────────────────────────────────────

export const stickyModule = defineDcModule({
  id: "sticky",
  name: "Sticky messages",
  description: "Keeps a message at the bottom of a channel: posted again after others write, the old copy deleted.",
  config: z
    .object({
      messages: z
        .array(
          z
            .object({
              channelId: Snowflake.meta({ title: "Channel id" }),
              content: z.string().min(1).max(2000).meta({ title: "Message" }),
            })
            .strict()
        )
        .min(1)
        .max(25)
        .meta({ title: "Sticky messages" }),
      everySeconds: z.number().int().min(5).max(3600).default(15).meta({ title: "Repost at most every N seconds" }),
    })
    .strict(),
  intents: INTENTS.GUILD_MESSAGES,
  events: ["MESSAGE_CREATE"],
  async onEvent(event, config, rt) {
    if (event.type !== "MESSAGE_CREATE" || event.isBot || !event.channelId) return;
    const sticky = config.messages.find((m) => m.channelId === event.channelId);
    if (!sticky) return;
    const now = Math.floor(rt.now().getTime() / 1000);
    const last = Number((await rt.kv.get(`at:${event.channelId}`)) ?? 0);
    if (now - last < config.everySeconds) return;
    await rt.kv.set(`at:${event.channelId}`, now);
    const old = await rt.kv.get(`msg:${event.channelId}`);
    if (typeof old === "string" && old) await rt.rest.deleteMessage(event.channelId, old).catch(() => undefined);
    const sent = await rt.rest.sendMessage(event.channelId, { content: clip(`📌 ${sticky.content}`) });
    await rt.kv.set(`msg:${event.channelId}`, sent.id ?? "");
  },
});

export const WEBHOOK_MODULES: DcModule[] = [charactersModule as DcModule, stickyModule as DcModule];
for (const m of WEBHOOK_MODULES) registerDcModule(m);

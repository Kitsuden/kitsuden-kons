/**
 * kon-dc — temporary voice channels ("join to create")
 * ============================================================================
 *
 * A member joins the HUB voice channel and the bot makes a room of their own (in a category, named
 * after them), moves them there, and deletes it when the last one leaves. The owner shapes it:
 *
 *   /voice rename <name>     /voice limit <0-99>     /voice lock     /voice unlock
 *
 * Needs the bot to have Manage Channels and Move Members. Rooms are remembered in the module's
 * state (`temp:<channel>` = owner), so a restart forgets nothing.
 */

import { z } from "@kitsuden/engine/zod";

import { INTENTS, Snowflake } from "./dc.contract";
import { baseVars, clip, defineDcModule, messageOf, registerDcModule, render, type DcModule, type ModuleRuntime, type Reply } from "./dc.modules";

const ME = (text: string): Reply => ({ content: clip(text), ephemeral: true });

/** Permission bits used on a room. */
const CONNECT = 1n << 20n;
const MANAGE_CHANNELS = 1n << 4n;
const MOVE_MEMBERS = 1n << 24n;

const TempVoiceConfig = z
  .object({
    hubChannelId: Snowflake.meta({ title: "Hub voice channel id", description: "Joining it creates a room" }),
    categoryId: Snowflake.optional().meta({ title: "Category id", description: "Where rooms are made; empty = the hub's own" }),
    nameTemplate: z.string().min(1).max(100).default("{{user.name}}'s room").meta({ title: "Room name", description: "{{user.name}} is filled in" }),
    userLimit: z.number().int().min(0).max(99).default(0).meta({ title: "Member limit", description: "0 = no limit" }),
  })
  .strict();

/** The room a member owns and is in, or null. */
async function ownRoom(rt: ModuleRuntime): Promise<string | null> {
  if (!rt.user) return null;
  const mine = (await rt.voice.sessions()).find((s) => s.userId === rt.user!.id);
  if (!mine) return null;
  return (await rt.kv.get(`temp:${mine.channelId}`)) === rt.user.id ? mine.channelId : null;
}

export const tempVoiceModule = defineDcModule({
  id: "temp-voice",
  name: "Temporary voice",
  description: "Join a hub voice channel and get a room of your own, deleted when it empties; /voice renames, limits and locks it.",
  config: TempVoiceConfig,
  intents: INTENTS.GUILD_VOICE_STATES,
  events: ["VOICE_STATE_UPDATE"],
  commands: () => [
    {
      name: "voice",
      description: "Your temporary voice room",
      type: 1,
      options: [
        { name: "rename", description: "Rename it", type: 1, options: [{ name: "name", description: "The new name", type: 3, required: true, max_length: 100 }] },
        { name: "limit", description: "How many may join (0 = no limit)", type: 1, options: [{ name: "members", description: "0-99", type: 4, required: true, min_value: 0, max_value: 99 }] },
        { name: "lock", description: "Nobody else may join", type: 1 },
        { name: "unlock", description: "Anyone may join", type: 1 },
      ],
    },
  ],
  plan: () => ({ reply: true, ephemeral: true }),

  async onEvent(event, config, rt) {
    const v = event.voice;
    if (event.type !== "VOICE_STATE_UPDATE" || !v || !rt.user || v.from === v.to) return;
    // Left a room: delete it when nobody else is in it (the sessions still count the one leaving).
    if (v.from && (await rt.kv.get(`temp:${v.from}`))) {
      const others = (await rt.voice.members(v.from)).filter((u) => u !== rt.user!.id);
      if (!others.length) {
        await rt.kv.set(`temp:${v.from}`, "");
        await rt.rest.deleteChannel(v.from).catch((err) => rt.logger.warn("Temp voice: could not delete a room", { message: messageOf(err) }));
      }
    }
    if (v.to !== config.hubChannelId) return;
    const owner = rt.user.id;
    const room = await rt.rest.createChannel(rt.guildId, {
      name: clip(render(config.nameTemplate, baseVars(rt)), 100) || "Room",
      type: 2,
      parentId: config.categoryId ?? null,
      userLimit: config.userLimit,
      overwrites: [{ id: owner, type: 1, allow: String(CONNECT | MANAGE_CHANNELS | MOVE_MEMBERS), deny: "0" }],
    });
    await rt.kv.set(`temp:${room.id}`, owner);
    try {
      await rt.rest.moveMember(rt.guildId, owner, room.id);
    } catch (err) {
      // They left the hub already: the empty room goes.
      rt.logger.info("Temp voice: could not move the member; room removed", { message: messageOf(err) });
      await rt.kv.set(`temp:${room.id}`, "");
      await rt.rest.deleteChannel(room.id).catch(() => undefined);
    }
  },

  async onCommand(invocation, _config, rt) {
    if (invocation.name !== "voice") return null;
    const room = await ownRoom(rt);
    if (!room) return ME(rt.t("Join your own room first (through the hub channel)."));
    switch (invocation.subcommand) {
      case "rename":
        await rt.rest.editChannel(room, { name: String(invocation.options.name ?? "Room") });
        return ME(rt.t("Renamed."));
      case "limit": {
        const n = Math.max(0, Math.min(99, Math.trunc(Number(invocation.options.members ?? 0))));
        await rt.rest.editChannel(room, { userLimit: n });
        return ME(n ? `Up to ${n} members.` : "No limit.");
      }
      case "lock":
      case "unlock":
        // The guild id is the id of @everyone.
        await rt.rest.setChannelPermission(room, rt.guildId, 0, "0", invocation.subcommand === "lock" ? String(CONNECT) : "0");
        return ME(invocation.subcommand === "lock" ? "Locked: nobody else may join." : "Unlocked.");
    }
    return null;
  },
});

export const VOICE_MODULES: DcModule[] = [tempVoiceModule as DcModule];
for (const m of VOICE_MODULES) registerDcModule(m);

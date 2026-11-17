/**
 * kon-dc — housing: a home for each member, furnished from their inventory
 * ============================================================================
 *
 *   /house view [member]          the rooms and what is placed in each (an embed)
 *   /house place <item> [room]    moves one `furniture` item of the catalog from the inventory into a
 *                                 room (the first with a free slot when no room is given)
 *   /house remove <item>          takes it back to the inventory
 *   /house unlock                 buys the next room with coins
 *
 * Furniture is a catalog kind (`dc_items.kind = 'furniture'`): the admin's Items tab sells it, the
 * Items module trades it. A placed item leaves the inventory (one write, `takeItem`), so it cannot
 * be sold or traded while it is in the house. The layout is this module's state, one JSON per
 * member, written under a short per-member lock (dc.fun.ts).
 */

import { z } from "@kitsuden/engine/zod";

import { COINS, ME, idOf, number, readJson, withLock } from "./dc.fun";
import { clip, defineDcModule, registerDcModule, type CatalogItem, type DcModule, type ModuleRuntime, type Reply } from "./dc.modules";
import type { Choice } from "./dc.contract";

const ID = "housing";

const Room = z
  .object({
    name: z.string().min(1).max(40).meta({ title: "Name" }),
    price: z.number().int().min(0).max(1_000_000_000).default(0).meta({ title: "Price to unlock", description: "0 = every member has it" }),
  })
  .strict();

const HousingConfig = z
  .object({
    rooms: z
      .array(Room)
      .min(1)
      .max(10)
      .default([
        { name: "Living room", price: 0 },
        { name: "Bedroom", price: 500 },
        { name: "Garden", price: 1500 },
      ])
      .meta({ title: "Rooms", description: "Unlocked in this order" }),
    slotsPerRoom: z.number().int().min(1).max(25).default(6).meta({ title: "Slots per room" }),
    symbol: z.string().min(1).max(64).default("🪙").meta({ title: "Coin symbol" }),
  })
  .strict();
type HousingConfig = z.output<typeof HousingConfig>;

export interface House {
  rooms: number;
  placed: Array<{ item: string; room: number }>;
}

/** Rooms every member has: the leading free ones (at least one). */
const freeRooms = (config: HousingConfig) => Math.max(1, config.rooms.findIndex((r) => r.price > 0) === -1 ? config.rooms.length : config.rooms.findIndex((r) => r.price > 0));

async function readHouse(rt: ModuleRuntime, userId: string, config: HousingConfig): Promise<House> {
  const h = await readJson<House>(rt.kv, `house:${userId}`);
  return { rooms: Math.max(freeRooms(config), Math.min(config.rooms.length, h?.rooms ?? 0)), placed: Array.isArray(h?.placed) ? h!.placed : [] };
}
const saveHouse = (rt: ModuleRuntime, userId: string, h: House) => rt.kv.set(`house:${userId}`, JSON.stringify(h));

async function furniture(rt: ModuleRuntime): Promise<Map<string, CatalogItem>> {
  return new Map((await rt.catalog.list({ kind: "furniture" })).map((i) => [i.item, i]));
}

async function view(userId: string, config: HousingConfig, rt: ModuleRuntime): Promise<Reply> {
  const h = await readHouse(rt, userId, config);
  const items = await furniture(rt);
  const fields = config.rooms.map((room, n) => {
    if (n >= h.rooms) return { name: `🔒 ${room.name}`, value: rt.t("Unlock it for {symbol} {price}.", { symbol: config.symbol, price: number(room.price) }), inline: true };
    const here = h.placed.filter((p) => p.room === n).map((p) => `${items.get(p.item)?.emoji ?? "🪑"} ${items.get(p.item)?.name ?? p.item}`);
    return { name: `${room.name} (${here.length}/${config.slotsPerRoom})`, value: clip(here.join("\n") || rt.t("Empty."), 1024), inline: true };
  });
  return { embeds: [{ title: `🏠 ${rt.t("Home")}`, description: `<@${userId}>`, fields, color: 0xe67e22 }] };
}

export const housingModule = defineDcModule({
  id: ID,
  name: "Housing",
  description: "A home for each member: rooms unlocked with coins, furnished with furniture items from their inventory.",
  config: HousingConfig,
  intents: 0,
  events: [],
  commands: (config) => [
    {
      name: "house",
      description: "Your home",
      type: 1,
      options: [
        { name: "view", description: "See a home", type: 1, options: [{ name: "member", description: "Someone else's", type: 6 }] },
        {
          name: "place",
          description: "Put furniture in a room",
          type: 1,
          options: [
            { name: "item", description: "Which furniture", type: 3, required: true, autocomplete: true },
            { name: "room", description: "Which room", type: 4, choices: config.rooms.map((r, n) => ({ name: clip(r.name, 100), value: n + 1 })) },
          ],
        },
        { name: "remove", description: "Take furniture back to the inventory", type: 1, options: [{ name: "item", description: "Which furniture", type: 3, required: true, autocomplete: true }] },
        { name: "unlock", description: "Buy the next room", type: 1 },
      ],
    },
  ],
  plan: (target) => ({ reply: true, ephemeral: !(target.kind === "command" && target.subcommand === "view") }),

  async onAutocomplete(request, config, rt) {
    if (!rt.user) return [];
    const typed = request.focused.toLowerCase();
    const items = await furniture(rt);
    let ids: string[];
    if (request.subcommand === "remove") ids = [...new Set((await readHouse(rt, rt.user.id, config)).placed.map((p) => p.item))];
    else ids = [...(await rt.economy.items(rt.user.id)), ...(await rt.economy.items(rt.user.id, true))].map((i) => i.item).filter((i) => items.has(i));
    return ids
      .map((id) => ({ id, name: items.get(id)?.name ?? id }))
      .filter((i) => i.name.toLowerCase().includes(typed) || i.id.includes(typed))
      .slice(0, 25)
      .map((i): Choice => ({ name: clip(i.name, 100), value: i.id }));
  },

  async onCommand(invocation, config, rt) {
    const user = rt.user;
    if (invocation.name !== "house" || !user) return null;
    const sub = invocation.subcommand;
    if (sub === "view") return view(idOf(invocation.options.member) ?? user.id, config, rt);

    const done = await withLock(rt, user.id, async (): Promise<Reply> => {
      const h = await readHouse(rt, user.id, config);
      if (sub === "unlock") {
        if (h.rooms >= config.rooms.length) return ME(rt.t("Every room is unlocked."));
        const room = config.rooms[h.rooms];
        if ((await rt.economy.take(user.id, COINS, room.price)) === null) {
          return ME(rt.t("**{room}** costs {symbol} {price}.", { room: room.name, symbol: config.symbol, price: number(room.price) }));
        }
        await saveHouse(rt, user.id, { ...h, rooms: h.rooms + 1 });
        return ME(rt.t("You unlocked **{room}**.", { room: room.name }));
      }
      const want = String(invocation.options.item ?? "").toLowerCase();
      const items = await furniture(rt);
      const item = items.get(want) ?? [...items.values()].find((i) => i.name.toLowerCase() === want);
      if (!item) return ME(rt.t("That is not furniture."));
      if (sub === "remove") {
        const at = h.placed.map((p) => p.item).lastIndexOf(item.item);
        if (at === -1) return ME(rt.t("**{item}** is not in your home.", { item: item.name }));
        h.placed.splice(at, 1);
        await saveHouse(rt, user.id, h);
        await rt.economy.addItem(user.id, item.item, 1, item.global);
        return ME(rt.t("**{item}** is back in your inventory.", { item: item.name }));
      }
      // place
      const used = (n: number) => h.placed.filter((p) => p.room === n).length;
      const asked = invocation.options.room === undefined ? null : Math.trunc(Number(invocation.options.room)) - 1;
      if (asked !== null && (asked < 0 || asked >= h.rooms)) return ME(rt.t("You have not unlocked that room."));
      const room = asked ?? Array.from({ length: h.rooms }, (_, n) => n).find((n) => used(n) < config.slotsPerRoom) ?? -1;
      if (room === -1 || used(room) >= config.slotsPerRoom) return ME(rt.t("That room is full."));
      if ((await rt.economy.takeItem(user.id, item.item, 1, item.global)) === null) return ME(rt.t("You have no **{item}**.", { item: item.name }));
      h.placed.push({ item: item.item, room });
      await saveHouse(rt, user.id, h);
      return ME(rt.t("**{item}** placed in **{room}**.", { item: item.name, room: config.rooms[room].name }));
    });
    return done ?? ME(rt.t("Busy: try again in a moment."));
  },
});

registerDcModule(housingModule as unknown as DcModule);

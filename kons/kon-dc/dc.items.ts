/**
 * kon-dc — the Items module: a store, inventories, using, equipping, gifting, selling and trading
 * ============================================================================
 *
 * Items are defined in the CATALOG (dc_items: `PUT /api/dc/items`, the admin's Items tab, or an
 * agent): name, emoji, rarity, kind, image, price, stock, sell price, whether it trades. A server's
 * items live in its inventories; GLOBAL items (no server) live in the member's bot-wide inventory
 * and are bought with global credits: profile badges and backgrounds are global items.
 *
 *   /items store             what is for sale here, with a select to buy
 *   /items buy <item>        /items info <item>        /items inventory [member]
 *   /items use <item>        a consumable is used up and every module hears it (a blueprint trigger
 *                            `item_used`), a role item gives its role
 *   /items equip <item>      a badge (up to 6) or a background on the profile; /items unequip
 *   /items gift <member> <item> [quantity]          /items sell <item> [quantity]
 *   /items trade <member> <give> [give_quantity] <want> [want_quantity]
 *                            an offer with Accept / Decline that only the other member can press,
 *                            for 10 minutes; both sides move at once or nothing does
 */

import { randomUUID } from "node:crypto";

import { z } from "@kitsuden/engine/zod";

import {
  RARITY_COLOR,
  clip,
  customId,
  defineDcModule,
  registerDcModule,
  type CatalogItem,
  type DcModule,
  type ModuleRuntime,
  type Reply,
} from "./dc.modules";
import type { Choice } from "./dc.contract";

const ME = (text: string): Reply => ({ content: clip(text), ephemeral: true });
const idOf = (v: unknown) => (typeof v === "string" && /^\d{15,20}$/.test(v) ? v : null);
const number = (n: number) => new Intl.NumberFormat("en-US").format(n);
const qty = (v: unknown) => Math.max(1, Math.min(1000, Math.trunc(Number(v ?? 1)) || 1));
const label = (i: CatalogItem) => `${i.emoji ? `${i.emoji} ` : ""}${i.name}`;
const colorOf = (i: CatalogItem) => parseInt((i.color ?? RARITY_COLOR[i.rarity]).slice(1), 16);

/** Global items are paid with the global currency of the same id (credits by default). */
const priceIn = (i: CatalogItem) => ({ currency: i.global && i.currency === "coins" ? "credits" : i.currency, global: i.global });

const TRADE_MINUTES = 10;
const MAX_BADGES = 6;

const ItemsConfig = z
  .object({
    allowTrades: z.boolean().default(true).meta({ title: "Members can trade and gift" }),
    allowSelling: z.boolean().default(true).meta({ title: "Members can sell items back" }),
  })
  .strict();

const itemOpt = (description = "Which item") => ({ name: "item", description, type: 3, required: true, autocomplete: true });

interface Trade {
  from: string;
  to: string;
  give: string;
  giveQty: number;
  want: string;
  wantQty: number;
  expires: number;
  channelId: string | null;
  done: boolean;
}

/** Buys one of an item for the runtime's member: all or nothing. Also used by the member page. */
export async function purchaseItem(i: CatalogItem, rt: ModuleRuntime): Promise<{ ok: boolean; message: string }> {
  const user = rt.user!;
  if (i.price === null) return { ok: false, message: rt.t("**{item}** is not for sale.", { item: i.name }) };
  const pay = priceIn(i);
  const left = await rt.economy.take(user.id, pay.currency, i.price, pay.global);
  if (left === null) return { ok: false, message: rt.t("**{item}** costs {price} {currency}.", { item: i.name, price: number(i.price), currency: pay.currency }) };
  if (!(await rt.catalog.reserve(i))) {
    await rt.economy.add(user.id, pay.currency, i.price, pay.global);
    return { ok: false, message: rt.t("**{item}** is sold out.", { item: i.name }) };
  }
  const have = await rt.economy.addItem(user.id, i.item, 1, i.global);
  if (i.kind === "role" && i.roleId) await rt.rest.addRole(rt.guildId, user.id, i.roleId).catch(() => undefined);
  return {
    ok: true,
    message: rt.t("You bought {item} for {price} {currency} (you have {have}). {left} {currency} left.", { item: label(i), price: number(i.price), currency: pay.currency, have, left: number(left) }),
  };
}

async function buyItem(i: CatalogItem, rt: ModuleRuntime): Promise<Reply> {
  return ME((await purchaseItem(i, rt)).message);
}

function tradeMessage(
  id: string,
  t: Trade,
  give: CatalogItem | null,
  want: CatalogItem | null,
  state: "open" | "done" | "declined" | "expired",
  tr: ModuleRuntime["t"]
) {
  const g = `${t.giveQty} × ${give ? label(give) : t.give}`;
  const w = `${t.wantQty} × ${want ? label(want) : t.want}`;
  const title = tr(state === "open" ? "Trade offer" : state === "done" ? "Trade done" : state === "declined" ? "Trade declined" : "Trade expired");
  return {
    embeds: [
      {
        title,
        description: `${tr("<@{who}> gives **{what}**", { who: t.from, what: g })}\n${tr("<@{who}> gives **{what}**", { who: t.to, what: w })}${state === "open" ? `\n\n${tr("Only <@{who}> can answer, until <t:{at}:t>.", { who: t.to, at: Math.floor(t.expires / 1000) })}` : ""}`,
        color: state === "done" ? 0x57f287 : state === "open" ? 0x5865f2 : 0x99aab5,
      },
    ],
    components:
      state === "open"
        ? [
            {
              type: 1,
              components: [
                { type: 2, style: 3, label: tr("Accept"), custom_id: customId("items", `ta-${id}`) },
                { type: 2, style: 4, label: tr("Decline"), custom_id: customId("items", `td-${id}`) },
              ],
            },
          ]
        : [],
  };
}

export const itemsModule = defineDcModule({
  id: "items",
  name: "Items",
  description: "A store from the item catalog, inventories, consumables, role items, badges and backgrounds for the profile, gifts, selling and trades between members.",
  config: ItemsConfig,
  intents: 0,
  events: [],
  commands: () => [
    {
      name: "items",
      description: "Items: store, inventory, trades",
      type: 1,
      options: [
        { name: "store", description: "What is for sale", type: 1 },
        { name: "buy", description: "Buy an item", type: 1, options: [itemOpt()] },
        { name: "info", description: "About an item", type: 1, options: [itemOpt()] },
        { name: "inventory", description: "What you own", type: 1, options: [{ name: "member", description: "Someone else", type: 6 }] },
        { name: "use", description: "Use an item", type: 1, options: [itemOpt()] },
        { name: "equip", description: "Show a badge or a background on your profile", type: 1, options: [itemOpt()] },
        { name: "unequip", description: "Take it off your profile", type: 1, options: [itemOpt()] },
        {
          name: "gift",
          description: "Give an item",
          type: 1,
          options: [{ name: "member", description: "Who", type: 6, required: true }, itemOpt(), { name: "quantity", description: "How many", type: 4, min_value: 1, max_value: 1000 }],
        },
        { name: "sell", description: "Sell an item back", type: 1, options: [itemOpt(), { name: "quantity", description: "How many", type: 4, min_value: 1, max_value: 1000 }] },
        {
          name: "trade",
          description: "Offer a trade",
          type: 1,
          options: [
            { name: "member", description: "With whom", type: 6, required: true },
            { name: "give", description: "What you give", type: 3, required: true, autocomplete: true },
            { name: "want", description: "What you want", type: 3, required: true, autocomplete: true },
            { name: "give_quantity", description: "How many you give", type: 4, min_value: 1, max_value: 1000 },
            { name: "want_quantity", description: "How many you want", type: 4, min_value: 1, max_value: 1000 },
          ],
        },
      ],
    },
  ],
  plan: (target) => ({ reply: true, ephemeral: !(target.kind === "command" && (target.subcommand === "store" || target.subcommand === "trade" || target.subcommand === "info")) }),

  async onAutocomplete(request, _config, rt) {
    const typed = request.focused.toLowerCase();
    const items = await rt.catalog.list(request.subcommand === "buy" ? { forSale: true } : {});
    return items
      .filter((i) => i.item.includes(typed) || i.name.toLowerCase().includes(typed))
      .slice(0, 25)
      .map((i): Choice => ({ name: clip(`${i.name}${i.price !== null && request.subcommand === "buy" ? ` — ${number(i.price)} ${priceIn(i).currency}` : ""}`, 100), value: i.item }));
  },

  async onComponent(use, _config, rt) {
    const user = rt.user;
    if (!user) return null;
    if (use.id === "buy") {
      const i = await rt.catalog.get(use.values[0] ?? "");
      return i ? buyItem(i, rt) : ME(rt.t("That item is not sold any more."));
    }
    const m = /^t([ad])-([a-z0-9]{1,16})$/.exec(use.id);
    if (!m) return null;
    const raw = await rt.kv.get(`trade:${m[2]}`);
    if (typeof raw !== "string") return ME(rt.t("This trade is gone."));
    const t = JSON.parse(raw) as Trade;
    if (user.id !== t.to) return ME(rt.t("Only <@{who}> can answer this trade.", { who: t.to }));
    const give = await rt.catalog.get(t.give);
    const want = await rt.catalog.get(t.want);
    if (t.done) return ME(rt.t("This trade is already closed."));
    t.done = true;
    await rt.kv.set(`trade:${m[2]}`, JSON.stringify(t));
    if (m[1] === "d") return { ...tradeMessage(m[2], t, give, want, "declined", rt.t), update: true };
    if (rt.now().getTime() > t.expires) return { ...tradeMessage(m[2], t, give, want, "expired", rt.t), update: true };
    if (!give || !want) return ME(rt.t("One of the items is not in the catalog any more."));
    // Both sides or nothing: take from the first, then the second; give back if the second fails.
    if ((await rt.economy.takeItem(t.from, give.item, t.giveQty, give.global)) === null) {
      return { ...tradeMessage(m[2], t, give, want, "declined", rt.t), content: rt.t("<@{who}> no longer has {n} × {item}.", { who: t.from, n: t.giveQty, item: give.name }), update: true };
    }
    if ((await rt.economy.takeItem(t.to, want.item, t.wantQty, want.global)) === null) {
      await rt.economy.addItem(t.from, give.item, t.giveQty, give.global);
      t.done = false;
      await rt.kv.set(`trade:${m[2]}`, JSON.stringify(t));
      return ME(rt.t("You do not have {n} × {item}.", { n: t.wantQty, item: want.name }));
    }
    await rt.economy.addItem(t.to, give.item, t.giveQty, give.global);
    await rt.economy.addItem(t.from, want.item, t.wantQty, want.global);
    rt.emit("dc:item:traded", { guildId: rt.guildId, from: t.from, to: t.to, give: give.item, giveQty: t.giveQty, want: want.item, wantQty: t.wantQty });
    return { ...tradeMessage(m[2], t, give, want, "done", rt.t), update: true };
  },

  async onCommand(invocation, config, rt) {
    const user = rt.user;
    if (invocation.name !== "items" || !user) return null;
    const o = invocation.options;
    const find = async (key = "item") => rt.catalog.get(String(o[key] ?? "").toLowerCase());

    switch (invocation.subcommand) {
      case "store": {
        const items = (await rt.catalog.list({ forSale: true })).slice(0, 25);
        if (!items.length) return { content: rt.t("Nothing for sale yet.") };
        const lines = items.map((i) => `${label(i)} — **${number(i.price!)}** ${priceIn(i).currency} · ${i.rarity}${i.stock !== null ? ` · ${i.stock - i.sold} left` : ""}`);
        return {
          embeds: [{ title: `🛒 ${rt.t("Store")}`, description: clip(lines.join("\n"), 4000), color: 0xf1c40f }],
          components: [
            {
              type: 1,
              components: [
                {
                  type: 3,
                  custom_id: customId("items", "buy"),
                  placeholder: rt.t("Buy something"),
                  options: items.map((i) => ({
                    label: clip(`${i.name} — ${number(i.price!)}`, 100),
                    value: i.item,
                    description: clip(`${i.rarity} ${i.kind}${i.description ? ` · ${i.description}` : ""}`, 100),
                    ...(i.emoji ? { emoji: { name: i.emoji } } : {}),
                  })),
                },
              ],
            },
          ],
        };
      }
      case "buy": {
        const i = await find();
        return i ? buyItem(i, rt) : ME(rt.t("There is no such item."));
      }
      case "info": {
        const i = await find();
        if (!i) return ME(rt.t("There is no such item."));
        const fields = [
          { name: rt.t("Rarity"), value: rt.t(i.rarity), inline: true },
          { name: rt.t("Kind"), value: rt.t(i.kind), inline: true },
          { name: rt.t("Price"), value: i.price === null ? rt.t("not for sale") : `${number(i.price)} ${priceIn(i).currency}`, inline: true },
          ...(i.stock !== null ? [{ name: rt.t("Stock"), value: rt.t("{left} of {stock}", { left: i.stock - i.sold, stock: i.stock }), inline: true }] : []),
          { name: rt.t("Trades"), value: i.tradeable ? rt.t("yes") : rt.t("no"), inline: true },
          ...(i.global ? [{ name: rt.t("Global"), value: rt.t("the same in every server"), inline: true }] : []),
        ];
        return {
          embeds: [
            {
              title: label(i),
              ...(i.description ? { description: i.description } : {}),
              color: colorOf(i),
              fields,
              ...(i.imageUrl && /^https:\/\//.test(i.imageUrl) ? { thumbnail: { url: i.imageUrl } } : {}),
            },
          ],
        };
      }
      case "inventory": {
        const who = idOf(o.member) ?? user.id;
        const [here, everywhere, catalog] = await Promise.all([rt.economy.items(who), rt.economy.items(who, true), rt.catalog.list()]);
        const byId = new Map(catalog.map((i) => [i.item, i]));
        const line = (x: { item: string; quantity: number }) => {
          const i = byId.get(x.item);
          return `${i ? label(i) : x.item} × ${number(x.quantity)}${i ? ` · ${i.rarity}` : ""}`;
        };
        const profile = await rt.profiles.get(who);
        return {
          embeds: [
            {
              title: `🎒 ${rt.t("Inventory")}`,
              description: `<@${who}>`,
              color: 0x5865f2,
              fields: [
                { name: rt.t("In this server"), value: clip(here.map(line).join("\n") || rt.t("Nothing yet."), 1024) },
                { name: rt.t("Global"), value: clip(everywhere.map(line).join("\n") || rt.t("Nothing yet."), 1024) },
                ...(profile.badges.length || profile.background
                  ? [{ name: rt.t("On the profile"), value: [...profile.badges, profile.background].filter(Boolean).map((b) => byId.get(b!)?.name ?? b).join(", ") }]
                  : []),
              ],
            },
          ],
          ephemeral: true,
        };
      }
      case "use": {
        const i = await find();
        if (!i) return ME(rt.t("There is no such item."));
        if (i.kind !== "consumable" && i.kind !== "role") return ME(rt.t("**{item}** is not something you use; equip badges and backgrounds.", { item: i.name }));
        if ((await rt.economy.takeItem(user.id, i.item, 1, i.global)) === null) return ME(rt.t("You have no {item}.", { item: i.name }));
        if (i.kind === "role" && i.roleId) await rt.rest.addRole(rt.guildId, user.id, i.roleId);
        await rt.itemUsed(i.item, user.id);
        rt.emit("dc:item:used", { guildId: rt.guildId, userId: user.id, item: i.item, moduleId: "items" });
        return ME(rt.t("You used {item}.", { item: label(i) }));
      }
      case "equip":
      case "unequip": {
        const i = await find();
        if (!i) return ME(rt.t("There is no such item."));
        if (i.kind !== "badge" && i.kind !== "background") return ME(rt.t("Only badges and backgrounds go on the profile."));
        const profile = await rt.profiles.get(user.id);
        if (invocation.subcommand === "unequip") {
          await rt.profiles.update(user.id, i.kind === "badge" ? { badges: profile.badges.filter((b) => b !== i.item) } : { background: null });
          return ME(rt.t("{item} is off your profile.", { item: label(i) }));
        }
        const owned = (await rt.economy.items(user.id, i.global)).some((x) => x.item === i.item);
        if (!owned) return ME(rt.t("You do not own {item}.", { item: label(i) }));
        if (i.kind === "background") {
          await rt.profiles.update(user.id, { background: i.item });
        } else {
          if (profile.badges.includes(i.item)) return ME(rt.t("It is already on your profile."));
          if (profile.badges.length >= MAX_BADGES) return ME(rt.t("Up to {n} badges: unequip one first.", { n: MAX_BADGES }));
          await rt.profiles.update(user.id, { badges: [...profile.badges, i.item] });
        }
        return ME(rt.t("{item} is on your profile.", { item: label(i) }));
      }
      case "gift": {
        if (!config.allowTrades) return ME(rt.t("Gifts are off in this server."));
        const to = idOf(o.member);
        const i = await find();
        const n = qty(o.quantity);
        if (!to || to === user.id) return ME(rt.t("Gift to someone else."));
        if (!i) return ME(rt.t("There is no such item."));
        if (!i.tradeable) return ME(rt.t("**{item}** cannot be given away.", { item: i.name }));
        if ((await rt.economy.takeItem(user.id, i.item, n, i.global)) === null) return ME(rt.t("You do not have {n} × {item}.", { n, item: i.name }));
        await rt.economy.addItem(to, i.item, n, i.global);
        return ME(rt.t("You gave <@{to}> {n} × {item}.", { to, n, item: label(i) }));
      }
      case "sell": {
        if (!config.allowSelling) return ME(rt.t("Selling is off in this server."));
        const i = await find();
        const n = qty(o.quantity);
        if (!i || i.sellPrice === null) return ME(rt.t("Nobody buys that here."));
        if ((await rt.economy.takeItem(user.id, i.item, n, i.global)) === null) return ME(rt.t("You do not have {n} × {item}.", { n, item: i.name }));
        const pay = priceIn(i);
        const balance = await rt.economy.add(user.id, pay.currency, i.sellPrice * n, pay.global);
        return ME(rt.t("You sold {n} × {item} for {price} {currency}. You have {balance}.", { n, item: label(i), price: number(i.sellPrice * n), currency: pay.currency, balance: number(balance) }));
      }
      case "trade": {
        if (!config.allowTrades) return ME(rt.t("Trades are off in this server."));
        const to = idOf(o.member);
        const give = await find("give");
        const want = await find("want");
        if (!to || to === user.id) return ME(rt.t("Trade with someone else."));
        if (!give || !want) return ME(rt.t("Name two items of the catalog."));
        if (!give.tradeable || !want.tradeable) return ME(rt.t("One of those items cannot be traded."));
        const t: Trade = {
          from: user.id,
          to,
          give: give.item,
          giveQty: qty(o.give_quantity),
          want: want.item,
          wantQty: qty(o.want_quantity),
          expires: rt.now().getTime() + TRADE_MINUTES * 60_000,
          channelId: rt.channelId,
          done: false,
        };
        const have = (await rt.economy.items(user.id, give.global)).find((x) => x.item === give.item)?.quantity ?? 0;
        if (have < t.giveQty) return ME(rt.t("You do not have {n} × {item}.", { n: t.giveQty, item: give.name }));
        const id = randomUUID().replace(/-/g, "").slice(0, 10);
        await rt.kv.set(`trade:${id}`, JSON.stringify(t));
        return { content: `<@${to}>`, ...tradeMessage(id, t, give, want, "open", rt.t) };
      }
    }
    return null;
  },
});

export const ITEM_MODULES: DcModule[] = [itemsModule as DcModule];
for (const m of ITEM_MODULES) registerDcModule(m);

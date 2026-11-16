/**
 * kon-dc — pets: a Tatsugotchi for each member
 * ============================================================================
 *
 *   /pet adopt <species> [name]   from the server's species list (name, emoji, image)
 *   /pet feed | play | walk       fullness, happiness and energy go up; each has a cooldown.
 *                                 Feeding uses one of the catalog's food item when the member has
 *                                 it, or costs coins
 *   /pet status [member]          an embed with the bars, the level and the mood
 *   /pet rename <name>            /pet release (with a confirm button)
 *
 * The three bars fall with time, computed from timestamps when the pet is read: no timers. The
 * pet's XP is the shared economy's `pet-xp` balance (levels like members' XP: `levelOf`), so the
 * Achievements module can read a pet's level. The rest is this module's state, one JSON per
 * member, written under a short per-member lock (dc.fun.ts); coins and items are taken in one write.
 */

import { z } from "zod";

import { LocalId } from "./dc.contract";
import { COINS, ME, PET_XP, bar, idOf, nowSec, number, plainName, readJson, withLock } from "./dc.fun";
import { clip, customId, defineDcModule, levelOf, registerDcModule, xpFor, type DcModule, type ModuleRuntime, type Reply } from "./dc.modules";

const ID = "pets";
const ACTIONS = ["feed", "play", "walk"] as const;
type Action = (typeof ACTIONS)[number];

const HttpsUrl = z.string().max(500).regex(/^https:\/\/\S+$/, "An https:// address");

const Species = z
  .object({
    id: LocalId.meta({ title: "Id", description: "Lowercase, e.g. cat" }),
    name: z.string().min(1).max(40).meta({ title: "Name" }),
    emoji: z.string().min(1).max(64).meta({ title: "Emoji" }),
    imageUrl: HttpsUrl.optional().meta({ title: "Image URL", description: "https; shown in the status embed" }),
  })
  .strict();

const PetsConfig = z
  .object({
    species: z
      .array(Species)
      .min(1)
      .max(25)
      .default([
        { id: "cat", name: "Cat", emoji: "🐱" },
        { id: "dog", name: "Dog", emoji: "🐶" },
        { id: "bunny", name: "Bunny", emoji: "🐰" },
        { id: "dragon", name: "Dragon", emoji: "🐉" },
      ])
      .refine((s) => new Set(s.map((x) => x.id)).size === s.length, { message: "Two species with the same id" })
      .meta({ title: "Species" }),
    adoptCost: z.number().int().min(0).max(1_000_000_000).default(0).meta({ title: "Adoption cost (coins)" }),
    feedCost: z.number().int().min(0).max(1_000_000).default(5).meta({ title: "Feeding cost (coins)", description: "When the member has no food item" }),
    foodItem: z.string().regex(/^[a-z0-9_-]{1,64}$/).optional().meta({ title: "Food item id", description: "A catalog item used up to feed, before coins" }),
    feedCooldownMinutes: z.number().int().min(0).max(10_080).default(30).meta({ title: "Feed cooldown (minutes)" }),
    playCooldownMinutes: z.number().int().min(0).max(10_080).default(30).meta({ title: "Play cooldown (minutes)" }),
    walkCooldownMinutes: z.number().int().min(0).max(10_080).default(60).meta({ title: "Walk cooldown (minutes)" }),
    hungerPerHour: z.number().min(0).max(100).default(4).meta({ title: "Fullness lost per hour" }),
    happinessPerHour: z.number().min(0).max(100).default(3).meta({ title: "Happiness lost per hour" }),
    energyPerHour: z.number().min(0).max(100).default(2).meta({ title: "Energy lost per hour" }),
    xpPerAction: z.number().int().min(0).max(10_000).default(10).meta({ title: "Pet XP per action" }),
    levelUpCoins: z.number().int().min(0).max(1_000_000).default(0).meta({ title: "Coins per new pet level" }),
    symbol: z.string().min(1).max(64).default("🪙").meta({ title: "Coin symbol" }),
  })
  .strict();
type PetsConfig = z.output<typeof PetsConfig>;

export interface Pet {
  species: string;
  name: string;
  adopted: number;
  food: number;
  happiness: number;
  energy: number;
  /** When the bars were last worked out (seconds). */
  at: number;
  last: Partial<Record<Action, number>>;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** The pet's bars now: each falls by its rate per hour since `at`. */
export function decayed(p: Pet, now: number, config: Pick<PetsConfig, "hungerPerHour" | "happinessPerHour" | "energyPerHour">): Pet {
  const hours = Math.max(0, now - p.at) / 3600;
  return {
    ...p,
    food: clamp(p.food - config.hungerPerHour * hours),
    happiness: clamp(p.happiness - config.happinessPerHour * hours),
    energy: clamp(p.energy - config.energyPerHour * hours),
    at: now,
  };
}

const petKey = (userId: string) => `pet:${userId}`;
const readPet = (rt: ModuleRuntime, userId: string) => readJson<Pet>(rt.kv, petKey(userId));
const savePet = (rt: ModuleRuntime, userId: string, p: Pet | null) => rt.kv.set(petKey(userId), p ? JSON.stringify(p) : "");

function moodOf(p: Pet, rt: ModuleRuntime): string {
  const avg = (p.food + p.happiness + p.energy) / 3;
  if (avg >= 70) return `😊 ${rt.t("Happy")}`;
  if (avg >= 40) return `🙂 ${rt.t("Fine")}`;
  if (avg >= 15) return `😟 ${rt.t("Sad")}`;
  return `😢 ${rt.t("Neglected")}`;
}

async function statusEmbed(userId: string, p: Pet, config: PetsConfig, rt: ModuleRuntime): Promise<Reply> {
  const species = config.species.find((s) => s.id === p.species);
  const xp = (await rt.economy.get(userId, PET_XP)).balance;
  const level = levelOf(xp);
  return {
    embeds: [
      {
        title: clip(`${species?.emoji ?? "🐾"} ${p.name}`, 256),
        description: rt.t("<@{who}>'s {species} · level {level}", { who: userId, species: species?.name ?? p.species, level }),
        fields: [
          { name: rt.t("Fullness"), value: bar(p.food), inline: false },
          { name: rt.t("Happiness"), value: bar(p.happiness), inline: false },
          { name: rt.t("Energy"), value: bar(p.energy), inline: false },
          { name: "XP", value: `${number(xp)} / ${number(xpFor(level + 1))}`, inline: true },
          { name: rt.t("Mood"), value: moodOf(p, rt), inline: true },
        ],
        ...(species?.imageUrl ? { thumbnail: { url: species.imageUrl } } : {}),
        color: 0x57f287,
      },
    ],
  };
}

const cooldownOf = (a: Action, c: PetsConfig) => (a === "feed" ? c.feedCooldownMinutes : a === "play" ? c.playCooldownMinutes : c.walkCooldownMinutes) * 60;

/** Pays for a meal: one food item if the member has it, else coins. Text = refused. */
async function payForFood(userId: string, config: PetsConfig, rt: ModuleRuntime): Promise<{ refused: string | null; used: string | null }> {
  if (config.foodItem) {
    const item = await rt.catalog.get(config.foodItem);
    if ((await rt.economy.takeItem(userId, config.foodItem, 1, item?.global ?? false)) !== null) return { refused: null, used: item?.name ?? config.foodItem };
  }
  if (config.feedCost <= 0) return { refused: null, used: null };
  if ((await rt.economy.take(userId, COINS, config.feedCost)) !== null) return { refused: null, used: `${config.symbol} ${number(config.feedCost)}` };
  return { refused: rt.t("Feeding costs {symbol} {amount}.", { symbol: config.symbol, amount: number(config.feedCost) }), used: null };
}

async function act(action: Action, config: PetsConfig, rt: ModuleRuntime): Promise<Reply> {
  const user = rt.user!;
  const done = await withLock(rt, user.id, async (): Promise<Reply> => {
    const stored = await readPet(rt, user.id);
    if (!stored) return ME(rt.t("You have no pet. Adopt one with /pet adopt."));
    const now = nowSec(rt);
    const wait = (stored.last[action] ?? 0) + cooldownOf(action, config) - now;
    if (wait > 0) return ME(rt.t("{name} needs a break. Try again <t:{at}:R>.", { name: stored.name, at: now + wait }));
    const p = decayed(stored, now, config);
    let paid: string | null = null;
    if (action === "feed") {
      const pay = await payForFood(user.id, config, rt);
      if (pay.refused) return ME(pay.refused);
      paid = pay.used;
      p.food = clamp(p.food + 35);
    } else if (action === "play") p.happiness = clamp(p.happiness + 30);
    else {
      p.energy = clamp(p.energy + 30);
      p.food = clamp(p.food - 5);
    }
    p.last = { ...p.last, [action]: now };
    await savePet(rt, user.id, p);
    const before = levelOf((await rt.economy.get(user.id, PET_XP)).balance);
    const xp = config.xpPerAction ? await rt.economy.add(user.id, PET_XP, config.xpPerAction) : (await rt.economy.get(user.id, PET_XP)).balance;
    const after = levelOf(xp);
    const lines = [
      action === "feed"
        ? rt.t("You fed {name}.", { name: p.name })
        : action === "play"
          ? rt.t("You played with {name}.", { name: p.name })
          : rt.t("You took {name} for a walk.", { name: p.name }),
    ];
    if (paid) lines.push(rt.t("Paid with {what}.", { what: paid }));
    if (after > before) {
      lines.push(`🎉 ${rt.t("{name} reached level {level}!", { name: p.name, level: after })}`);
      if (config.levelUpCoins > 0) {
        await rt.economy.add(user.id, COINS, config.levelUpCoins * (after - before));
        lines.push(`+${config.symbol} ${number(config.levelUpCoins * (after - before))}`);
      }
      rt.emit("dc:pet:level", { guildId: rt.guildId, userId: user.id, level: after });
    }
    const status = await statusEmbed(user.id, p, config, rt);
    return { ...status, content: clip(lines.join(" ")) };
  });
  return done ?? ME(rt.t("Busy: try again in a moment."));
}

export const petsModule = defineDcModule({
  id: ID,
  name: "Pets",
  description: "A pet for each member (Tatsugotchi): adopt, feed, play, walk; its bars fall with time and it levels up.",
  config: PetsConfig,
  intents: 0,
  events: [],
  commands: (config) => [
    {
      name: "pet",
      description: "Your pet",
      type: 1,
      options: [
        {
          name: "adopt",
          description: "Adopt a pet",
          type: 1,
          options: [
            { name: "species", description: "Which one", type: 3, required: true, choices: config.species.map((s) => ({ name: clip(s.name, 100), value: s.id })) },
            { name: "name", description: "Its name", type: 3, max_length: 32 },
          ],
        },
        { name: "feed", description: "Feed your pet", type: 1 },
        { name: "play", description: "Play with your pet", type: 1 },
        { name: "walk", description: "Take your pet for a walk", type: 1 },
        { name: "status", description: "How a pet is doing", type: 1, options: [{ name: "member", description: "Someone else's", type: 6 }] },
        { name: "rename", description: "Give your pet a new name", type: 1, options: [{ name: "name", description: "The new name", type: 3, required: true, max_length: 32 }] },
        { name: "release", description: "Let your pet go", type: 1 },
      ],
    },
  ],
  plan: (target) => (target.kind === "command" ? { reply: true, ephemeral: target.subcommand === "release" } : {}),

  async onCommand(invocation, config, rt) {
    const user = rt.user;
    if (invocation.name !== "pet" || !user) return null;
    const sub = invocation.subcommand;
    if (sub === "feed" || sub === "play" || sub === "walk") return act(sub, config, rt);
    if (sub === "status") {
      const who = idOf(invocation.options.member) ?? user.id;
      const p = await readPet(rt, who);
      if (!p) return ME(who === user.id ? rt.t("You have no pet. Adopt one with /pet adopt.") : rt.t("<@{who}> has no pet.", { who }));
      return statusEmbed(who, decayed(p, nowSec(rt), config), config, rt);
    }
    if (sub === "release") {
      const p = await readPet(rt, user.id);
      if (!p) return ME(rt.t("You have no pet. Adopt one with /pet adopt."));
      return {
        content: rt.t("Release **{name}**? This cannot be undone.", { name: p.name }),
        components: [{ type: 1, components: [{ type: 2, style: 4, label: rt.t("Release"), custom_id: customId(ID, `release-${user.id}`) }] }],
        ephemeral: true,
      };
    }
    const done = await withLock(rt, user.id, async (): Promise<Reply> => {
      const p = await readPet(rt, user.id);
      if (sub === "rename") {
        if (!p) return ME(rt.t("You have no pet. Adopt one with /pet adopt."));
        const name = plainName(String(invocation.options.name ?? ""));
        if (!name) return ME(rt.t("Give it a name."));
        await savePet(rt, user.id, { ...p, name });
        return ME(rt.t("Your pet is now called **{name}**.", { name }));
      }
      // adopt
      if (p) return ME(rt.t("You already have **{name}**.", { name: p.name }));
      const species = config.species.find((s) => s.id === invocation.options.species);
      if (!species) return ME(rt.t("There is no such species here."));
      if (config.adoptCost > 0 && (await rt.economy.take(user.id, COINS, config.adoptCost)) === null) {
        return ME(rt.t("Adopting costs {symbol} {amount}.", { symbol: config.symbol, amount: number(config.adoptCost) }));
      }
      const now = nowSec(rt);
      const pet: Pet = { species: species.id, name: plainName(String(invocation.options.name ?? "")) || species.name, adopted: now, food: 80, happiness: 80, energy: 80, at: now, last: {} };
      await savePet(rt, user.id, pet);
      const xp = (await rt.economy.get(user.id, PET_XP)).balance;
      if (xp > 0) await rt.economy.add(user.id, PET_XP, -xp);
      rt.emit("dc:pet:adopted", { guildId: rt.guildId, userId: user.id, species: species.id });
      return { ...(await statusEmbed(user.id, pet, config, rt)), content: rt.t("Welcome home, **{name}**!", { name: pet.name }) };
    });
    return done ?? ME(rt.t("Busy: try again in a moment."));
  },

  async onComponent(use, _config, rt) {
    const m = /^release-(\d{15,20})$/.exec(use.id);
    if (!m || !rt.user) return null;
    if (rt.user.id !== m[1]) return ME(rt.t("This is not your pet."));
    const done = await withLock(rt, m[1], async (): Promise<Reply> => {
      const p = await readPet(rt, m[1]);
      if (!p) return ME(rt.t("You have no pet. Adopt one with /pet adopt."));
      await savePet(rt, m[1], null);
      const xp = (await rt.economy.get(m[1], PET_XP)).balance;
      if (xp > 0) await rt.economy.add(m[1], PET_XP, -xp);
      return { content: rt.t("**{name}** went off to a new adventure. Goodbye!", { name: p.name }), components: [], update: true };
    });
    return done ?? ME(rt.t("Busy: try again in a moment."));
  },
});

registerDcModule(petsModule as unknown as DcModule);

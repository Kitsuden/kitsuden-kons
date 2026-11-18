/**
 * kon-dc's fun modules (Tatsu / MEE6 parity, part C): mini-games, pets, housing, achievements and
 * counting. Real Postgres (PGlite) with row security, a fake Discord and a movable clock.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";

import type { PGlite } from "@electric-sql/pglite";
import { AppError } from "@kitsuden/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { INTENTS } from "../../kons/kon-dc/dc.contract";
import { countOf } from "../../kons/kon-dc/dc.counting";
import { claimCooldown } from "../../kons/kon-dc/dc.fun";
import { handValue, payout, slotsMultiplier } from "../../kons/kon-dc/dc.games";
import { decayed } from "../../kons/kon-dc/dc.pets";
import type { ModuleKv } from "../../kons/kon-dc/dc.modules";
import { registerDcPolicy } from "../../kons/kon-dc/dc.policy";
import type { DiscordRest, DiscordSettings } from "../../kons/kon-dc/dc.rest";
import type { DcEngine } from "../../kons/kon-dc/dc.engine";
import { createDcRouter } from "../../kons/kon-dc/dc.routes";

import { dropToAppRole, migratedBase, requestAs, sqlAs, testAuth } from "./helpers/safe-kons-bench";

// Each interaction is a dozen queries on PGlite: the longer flows take a while.
vi.setConfig({ testTimeout: 120_000 });

const GUILD = "151515151515151515";
const CHANNEL = "222222222222222222";
const COUNT_CHANNEL = "252525252525252525";
const ROLE = "333333333333333333";
const MEMBER = "444444444444444444";
const OTHER = "777777777777777777";
const WORKER = { agent: ["kon:dc:gateway-config", "kon:dc:ingest-gateway-events"] };

const keys = generateKeyPairSync("ed25519");
const settings: DiscordSettings & Record<string, unknown> = {
  applicationId: "999999999999999999",
  publicKey: Buffer.from(keys.publicKey.export({ format: "der", type: "spki" })).subarray(-32).toString("hex"),
  botToken: "test-token",
  disabledModules: new Set(),
  apiBase: "http://discord.invalid",
};

const calls: Array<{ fn: string; args: unknown[] }> = [];
let messageSeq = 900000000000000000n;
const fakeRest = new Proxy({} as DiscordRest, {
  get(_t, fn: string) {
    return async (...args: unknown[]) => {
      calls.push({ fn, args });
      if (fn === "sendMessage") return { id: String(++messageSeq) };
      if (fn === "openDm") return "555555555555555555";
      if (fn === "syncGuildCommands") return [];
      if (fn === "getMember") return { roles: [], nick: null };
      return undefined;
    };
  },
});

const bus = new EventEmitter();
const emitted: Array<{ event: string; data: unknown }> = [];
const events = {
  emit: (e: string, d: unknown) => {
    emitted.push({ event: e, data: d });
    bus.emit(e, d);
  },
  on: (e: string, h: (d: unknown) => void) => void bus.on(e, h),
};

let client: PGlite;
let engine: DcEngine;
let clockOffsetMs = 0;
let request: ReturnType<typeof requestAs>;
let app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> };

async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function signed(body: unknown) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return app.request("/interactions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature-ed25519": sign(null, Buffer.from(ts + raw), keys.privateKey).toString("hex"), "x-signature-timestamp": ts },
    body: raw,
  });
}

const member = (id: string) => ({ user: { id, username: id === MEMBER ? "ana" : "beto", global_name: id === MEMBER ? "Ana" : "Beto" }, roles: [] });

function command(name: string, options: Record<string, unknown> = {}, who = MEMBER) {
  return { type: 2, id: "1", token: "interaction-token", guild_id: GUILD, channel_id: CHANNEL, member: member(who), data: { name, options: Object.entries(options).map(([n, value]) => ({ name: n, value })) } };
}

function sub(name: string, subcommand: string, options: Record<string, unknown> = {}, who = MEMBER) {
  return { ...command(name, {}, who), data: { name, options: [{ type: 1, name: subcommand, options: Object.entries(options).map(([n, value]) => ({ name: n, value })) }] } };
}

function component(customId: string, who = MEMBER) {
  return { type: 3, id: "2", token: "component-token", guild_id: GUILD, channel_id: CHANNEL, message: { id: "800000000000000001" }, member: member(who), data: { custom_id: customId, component_type: 2 } };
}

interface Seen {
  text: string;
  components: Array<{ components: Array<{ custom_id: string }> }>;
  ephemeral: boolean;
  update: boolean;
}

function seen(data: Record<string, unknown> | string, update: boolean): Seen {
  if (typeof data === "string") return { text: data, components: [], ephemeral: true, update };
  const embeds = (data.embeds as Array<{ title?: string; description?: string; fields?: Array<{ name: string; value: string }> }> | undefined) ?? [];
  const parts = [data.content as string | undefined, ...embeds.flatMap((e) => [e.title, e.description, ...(e.fields ?? []).map((f) => `${f.name}: ${f.value}`)])];
  return { text: parts.filter(Boolean).join("\n"), components: (data.components as Seen["components"]) ?? [], ephemeral: ((Number(data.flags) || 0) & 64) !== 0, update };
}

/** What the member sees after an interaction: the direct answer, or the deferred edit / follow-up. */
async function run(body: unknown): Promise<Seen> {
  calls.length = 0;
  const r = await (await signed(body)).json();
  if (r.type === 4 || r.type === 7) return seen(r.data, r.type === 7);
  const edit = await until(async () => calls.find((c) => c.fn === "editOriginal" || c.fn === "followup"));
  return seen(edit.args[1] as Record<string, unknown> | string, edit.fn === "editOriginal" && r.type === 6);
}

async function enable(moduleId: string, config: Record<string, unknown> = {}) {
  const r = await request("staff", "PUT", `/guilds/${GUILD}/modules/${moduleId}`, { enabled: true, config });
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
}

async function setCoins(userId: string, amount: number, currency = "coins") {
  expect((await request("staff", "PUT", `/guilds/${GUILD}/economy/${userId}`, { currency, set: amount })).status).toBe(200);
}

async function balance(userId: string, currency = "coins"): Promise<number> {
  const rows = await sqlAs<{ balance: string }>(client, "staff", `SELECT balance FROM dc_wallets WHERE guild_id = $1 AND user_id = $2 AND currency = $3`, [GUILD, userId, currency]);
  return Number(rows[0]?.balance ?? 0);
}

async function quantity(userId: string, item: string): Promise<number> {
  const rows = await sqlAs<{ quantity: number }>(client, "staff", `SELECT quantity FROM dc_inventory WHERE guild_id = $1 AND user_id = $2 AND item = $3`, [GUILD, userId, item]);
  return Number(rows[0]?.quantity ?? 0);
}

async function giveItem(userId: string, item: string, n: number) {
  await sqlAs(client, "staff", `INSERT INTO dc_inventory (guild_id, user_id, item, quantity) VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, user_id, item) DO UPDATE SET quantity = dc_inventory.quantity + $4`, [GUILD, userId, item, n]);
}

async function putItem(item: Record<string, unknown>) {
  const r = await request("staff", "PUT", "/items", { guildId: GUILD, ...item });
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
}

async function gatewayEvent(t: string, d: Record<string, unknown>) {
  const r = await request(WORKER, "POST", "/gateway/events", { contract: 1, events: [{ t, s: 9, shard: [0, 1], receivedAt: new Date().toISOString(), d: { guild_id: GUILD, ...d } }] });
  expect(r.status).toBe(202);
  await engine.idle();
}

let msgSeq = 860000000000000000n;
const message = (userId: string, content: string, channel = CHANNEL) =>
  gatewayEvent("MESSAGE_CREATE", { channel_id: channel, id: String(++msgSeq), content, author: { id: userId, username: "x" }, member: { roles: [] } });

const minutes = (n: number) => {
  clockOffsetMs += n * 60_000;
};

beforeAll(async () => {
  client = await migratedBase("kon-dc", [
    "0000_initial.sql",
    "0001_rewards_and_schedules.sql",
    "0002_global_profiles.sql",
    "0003_item_catalog.sql",
    "0004_voice.sql",
    "0005_activity.sql",
    "0006_characters.sql",
    "0007_message_cache.sql",
    "0008_guild_locale.sql",
    "0009_guild_plans.sql",
    "0012_furniture.sql",
  ]);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never, events: events as never });
  const mounted = host.mount(
    createDcRouter(ctx, {
      settings: () => settings,
      rest: () => fakeRest,
      directAnswerMs: 2000,
      panelDebounceMs: 20,
      scheduleTickMs: 0,
      renderPng: null,
      now: () => new Date(Date.now() + clockOffsetMs),
      onEngine: (e) => {
        engine = e;
      },
    })
  );
  mounted.onError((err) =>
    err instanceof AppError
      ? Response.json({ error: err.message, details: err.details }, { status: err.status })
      : Response.json({ error: String(err) }, { status: 500 })
  );
  app = mounted;
  request = requestAs(mounted);
  expect((await request("staff", "PUT", `/guilds/${GUILD}`, { name: "Fun server" })).status).toBe(200);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerDcPolicy();
  calls.length = 0;
  emitted.length = 0;
});

// ── Pure parts ──────────────────────────────────────────────────────────────────────────────────

describe("kon-dc fun: the pure parts", () => {
  it("hands, payouts, slot lines, decay and counted numbers", () => {
    expect(handValue([0, 12])).toBe(21); // A + K
    expect(handValue([0, 0, 8])).toBe(21); // A + A + 9
    expect(handValue([9, 10, 1])).toBe(22); // 10 + J + 2
    expect(payout(100, 1, 0)).toBe(200);
    expect(payout(100, 1, 10)).toBe(190);
    expect(payout(100, 1.5, 0)).toBe(250);
    expect(slotsMultiplier([5, 5, 5])).toBe(150);
    expect(slotsMultiplier([0, 3, 0])).toBe(1);
    expect(slotsMultiplier([1, 2, 3])).toBe(0);
    const pet = { species: "cat", name: "Tom", adopted: 0, food: 80, happiness: 50, energy: 10, at: 0, last: {} };
    const later = decayed(pet, 10 * 3600, { hungerPerHour: 4, happinessPerHour: 3, energyPerHour: 2 });
    expect([later.food, later.happiness, later.energy, later.at]).toEqual([40, 20, 0, 36000]);
    expect(countOf("12")).toBe(12);
    expect(countOf("  7 nice")).toBe(7);
    expect(countOf("12abc")).toBeNull();
    expect(countOf("1.5")).toBeNull();
    expect(countOf("hello")).toBeNull();
    expect(countOf("9".repeat(5000))).toBeNull();
  });

  it("a cooldown is claimed once when two requests race", async () => {
    // A kv whose writes are atomic, like the upsert, with a pause between reads and writes.
    const store = new Map<string, number>();
    const tick = () => new Promise((r) => setTimeout(r, 1));
    const kv: ModuleKv = {
      get: async (k) => (await tick(), store.get(k)),
      set: async (k, v) => void store.set(k, Number(v)),
      incr: async (k, by) => {
        await tick();
        const v = (store.get(k) ?? 0) + by;
        store.set(k, v);
        return v;
      },
    };
    const results = await Promise.all([claimCooldown(kv, "cd", 60, 1000), claimCooldown(kv, "cd", 60, 1000), claimCooldown(kv, "cd", 60, 1000)]);
    expect(results.filter((r) => r === 0)).toHaveLength(1);
    expect(store.get("cd")).toBe(1000);
    expect(await claimCooldown(kv, "cd", 60, 1030)).toBe(30);
    expect(await claimCooldown(kv, "cd", 60, 1060)).toBe(0);
  });
});

// ── Mini-games ──────────────────────────────────────────────────────────────────────────────────

describe("kon-dc fun: mini-games", () => {
  beforeAll(async () => {
    await enable("games", { minBet: 10, maxBet: 500, houseEdgePercent: 0, cooldownSeconds: 30, challengeMinutes: 5 });
  });

  it("coinflip: the bet is taken and paid double or nothing; cooldown; limits; short of coins", async () => {
    await setCoins(MEMBER, 1000);
    const flip = await run(command("coinflip", { side: "heads", bet: 100 }));
    expect(flip.text).toMatch(/It landed on \*\*(heads|tails)\*\*/);
    const after = await balance(MEMBER);
    expect([900, 1100]).toContain(after);
    expect(flip.text).toContain(after === 1100 ? "You win 🪙 100!" : "You lose 🪙 100.");

    expect((await run(command("coinflip", { side: "tails" }))).text).toMatch(/^Wait \d+ s\.$/);
    minutes(1);
    expect((await run(command("coinflip", { side: "tails", bet: 5000 }))).text).toBe("Bets go from 🪙 10 to 🪙 500.");
    await setCoins(MEMBER, 20);
    expect((await run(command("coinflip", { side: "tails", bet: 50 }))).text).toBe("You do not have 🪙 50.");
    expect(await balance(MEMBER)).toBe(20);
  });

  it("dice and slots, for fun and for coins; the cooldown holds", async () => {
    minutes(1);
    const roll = await run(command("dice", { sides: 20 }));
    expect(roll.text).toMatch(/You rolled \*\*\d+\*\* \(d20\)\./);
    minutes(1);
    expect((await run(command("dice", { bet: 10 }))).text).toBe("Pick a number to bet on.");
    expect((await run(command("dice", { sides: 6, guess: 9 }))).text).toBe("Guess a number from 1 to 6.");

    await setCoins(MEMBER, 1000);
    const spin = await run(command("slots", { bet: 100 }));
    expect((await run(command("slots", { bet: 100 }))).text).toMatch(/^Wait \d+ s\.$/);
    expect(spin.text).toMatch(/\[ .+ \| .+ \| .+ \]/);
    const left = await balance(MEMBER);
    expect([0, 1, 5, 10, 15, 30, 60, 150].map((m) => 900 + (m ? payout(100, m, 0) : 0))).toContain(left);
    expect(emitted.some((e) => e.event === "dc:game:played")).toBe(true);
  });

  it("rps against the bot, and a member challenge with both bets on the table", async () => {
    minutes(1);
    expect((await run(command("rps", { choice: "rock" }))).text).toMatch(/You: ✊ rock · Me: .+\. (You win!|A tie!|I win!)/);

    await setCoins(MEMBER, 1000);
    await setCoins(OTHER, 1000);
    minutes(1);
    const challenge = await run(command("rps", { choice: "rock", member: OTHER, bet: 100 }));
    expect(challenge.text).toContain(`<@${MEMBER}> challenges <@${OTHER}> for 🪙 100`);
    expect(await balance(MEMBER)).toBe(900);
    const buttons = challenge.components[0].components.map((b) => b.custom_id);
    expect(buttons).toHaveLength(4);
    const paper = buttons.find((b) => b.includes(":rps-p-"))!;
    expect((await run(component(paper, MEMBER))).text).toBe(`Only <@${OTHER}> can answer this.`);
    const answered = await run(component(paper, OTHER));
    expect(answered.update).toBe(true);
    expect(answered.text).toContain(`<@${OTHER}> wins 🪙 200!`);
    expect([await balance(MEMBER), await balance(OTHER)]).toEqual([900, 1100]);
    expect((await run(component(paper, OTHER))).text).toBe("This game is over.");

    // Nobody answers: the challenger's bet comes back when it expires.
    minutes(1);
    await run(command("rps", { choice: "scissors", member: OTHER, bet: 50 }));
    expect(await balance(MEMBER)).toBe(850);
    minutes(6);
    await engine.tick();
    await engine.idle();
    expect(await balance(MEMBER)).toBe(900);
  });

  it("blackjack: one table per member, only the player presses, the stand pays", async () => {
    await enable("games", { minBet: 10, maxBet: 500, houseEdgePercent: 0, cooldownSeconds: 0 });
    let table: Seen | null = null;
    let start = 0;
    for (let i = 0; i < 20 && !table; i++) {
      await setCoins(MEMBER, 1000);
      const t = await run(command("blackjack", { bet: 100 }));
      expect(t.text).toContain("Blackjack");
      if (t.components.length) table = t;
      start = 1000;
    }
    expect(table).not.toBeNull();
    expect(await balance(MEMBER)).toBe(start - 100);
    expect((await run(command("blackjack", { bet: 100 }))).text).toBe("Finish your blackjack game first.");
    const [hit, stand] = table!.components[0].components.map((b) => b.custom_id);
    expect(hit).toContain(`:bj-h-${MEMBER}`);
    expect((await run(component(stand, OTHER))).text).toBe("This is not your game.");
    const done = await run(component(stand, MEMBER));
    expect(done.update).toBe(true);
    expect(done.components).toEqual([]);
    expect(done.text).toMatch(/You beat the dealer|A push|The dealer wins|Blackjack!/);
    expect([900, 1000, 1100, 1150]).toContain(await balance(MEMBER));
    expect((await run(component(stand, MEMBER))).text).toBe("This game is over.");
    // The table is closed: a new one can start.
    await setCoins(MEMBER, 1000);
    expect((await run(command("blackjack"))).text).toContain("Blackjack");
  });
});

// ── Pets ────────────────────────────────────────────────────────────────────────────────────────

describe("kon-dc fun: pets", () => {
  beforeAll(async () => {
    await putItem({ item: "kibble", name: "Kibble", emoji: "🦴", kind: "consumable" });
    await enable("pets", { feedCost: 5, foodItem: "kibble", xpPerAction: 60, levelUpCoins: 25, species: [{ id: "cat", name: "Cat", emoji: "🐱", imageUrl: "https://example.com/cat.png" }] });
  });

  it("adopt, feed (food item first, then coins), cooldowns, decay over time, XP and levels", async () => {
    expect((await run(sub("pet", "feed"))).text).toBe("You have no pet. Adopt one with /pet adopt.");
    const adopted = await run(sub("pet", "adopt", { species: "cat", name: "Tom`*@everyone" }));
    expect(adopted.text).toContain("Welcome home, **Tomeveryone**!");
    expect((await run(sub("pet", "adopt", { species: "cat" }))).text).toBe("You already have **Tomeveryone**.");

    await giveItem(MEMBER, "kibble", 1);
    await setCoins(MEMBER, 100);
    const fed = await run(sub("pet", "feed"));
    expect(fed.text).toContain("You fed Tomeveryone. Paid with Kibble.");
    expect(await quantity(MEMBER, "kibble")).toBe(0);
    expect((await run(sub("pet", "feed"))).text).toMatch(/needs a break\. Try again <t:\d+:R>\./);

    minutes(31);
    // 120 XP: level 1, and the coins for it.
    const second = await run(sub("pet", "feed"));
    expect(second.text).toContain("Paid with 🪙 5.");
    expect(second.text).toContain("Tomeveryone reached level 1!");
    expect(await balance(MEMBER)).toBe(120);
    expect((await run(sub("pet", "play"))).text).toContain("You played with Tomeveryone.");
    expect(await balance(MEMBER, "pet-xp")).toBe(180);

    // Ten hours later the bars have fallen, worked out from the time.
    minutes(600);
    const status = await run(sub("pet", "status", { member: MEMBER }, OTHER));
    expect(status.text).toContain(`<@${MEMBER}>'s Cat · level 1`);
    const fullness = Number(/Fullness: [█░]+ (\d+)%/.exec(status.text)![1]);
    expect(fullness).toBeLessThanOrEqual(60);
    expect(status.text).toMatch(/Mood: /);
  });

  it("rename, someone else's pet, release with a button", async () => {
    expect((await run(sub("pet", "rename", { name: "Garfield" }))).text).toBe("Your pet is now called **Garfield**.");
    expect((await run(sub("pet", "status", {}, OTHER))).text).toBe("You have no pet. Adopt one with /pet adopt.");
    const ask = await run(sub("pet", "release"));
    expect(ask.text).toBe("Release **Garfield**? This cannot be undone.");
    const button = ask.components[0].components[0].custom_id;
    expect((await run(component(button, OTHER))).text).toBe("This is not your pet.");
    expect((await run(component(button, MEMBER))).text).toContain("**Garfield** went off to a new adventure");
    expect(await balance(MEMBER, "pet-xp")).toBe(0);
    expect((await run(sub("pet", "status"))).text).toBe("You have no pet. Adopt one with /pet adopt.");
  });
});

// ── Housing ─────────────────────────────────────────────────────────────────────────────────────

describe("kon-dc fun: housing", () => {
  beforeAll(async () => {
    await putItem({ item: "chair", name: "Chair", emoji: "🪑", kind: "furniture", price: 10 });
    await putItem({ item: "lamp", name: "Lamp", emoji: "💡", kind: "furniture" });
    await enable("housing", { slotsPerRoom: 1, rooms: [{ name: "Living room", price: 0 }, { name: "Attic", price: 300 }] });
  });

  it("the catalog takes furniture; place from the inventory, a full room, unlock with coins, remove", async () => {
    const items = (await (await request("staff", "GET", `/items?guildId=${GUILD}`)).json()).docs as Array<{ item: string; kind: string }>;
    expect(items.find((i) => i.item === "chair")!.kind).toBe("furniture");

    expect((await run(sub("house", "place", { item: "chair" }))).text).toBe("You have no **Chair**.");
    await giveItem(MEMBER, "chair", 1);
    await giveItem(MEMBER, "lamp", 1);
    expect((await run(sub("house", "place", { item: "chair" }))).text).toBe("**Chair** placed in **Living room**.");
    expect(await quantity(MEMBER, "chair")).toBe(0);
    expect((await run(sub("house", "place", { item: "lamp" }))).text).toBe("That room is full.");
    expect((await run(sub("house", "place", { item: "lamp", room: 2 }))).text).toBe("You have not unlocked that room.");
    expect((await run(sub("house", "place", { item: "kibble" }))).text).toBe("That is not furniture.");

    await setCoins(MEMBER, 100);
    expect((await run(sub("house", "unlock"))).text).toBe("**Attic** costs 🪙 300.");
    await setCoins(MEMBER, 300);
    expect((await run(sub("house", "unlock"))).text).toBe("You unlocked **Attic**.");
    expect(await balance(MEMBER)).toBe(0);
    expect((await run(sub("house", "unlock"))).text).toBe("Every room is unlocked.");
    expect((await run(sub("house", "place", { item: "lamp" }))).text).toBe("**Lamp** placed in **Attic**.");

    const home = await run(sub("house", "view", { member: MEMBER }, OTHER));
    expect(home.ephemeral).toBe(false);
    expect(home.text).toContain("Living room (1/1): 🪑 Chair");
    expect(home.text).toContain("Attic (1/1): 💡 Lamp");

    expect((await run(sub("house", "remove", { item: "chair" }))).text).toBe("**Chair** is back in your inventory.");
    expect(await quantity(MEMBER, "chair")).toBe(1);
    expect((await run(sub("house", "remove", { item: "chair" }))).text).toBe("**Chair** is not in your home.");
  });
});

// ── Achievements ────────────────────────────────────────────────────────────────────────────────

describe("kon-dc fun: achievements", () => {
  beforeAll(async () => {
    await putItem({ item: "chatty-badge", name: "Chatty", emoji: "🏅", kind: "badge" });
    await enable("achievements", {
      announceChannelId: CHANNEL,
      checkEverySeconds: 0,
      achievements: [
        { id: "talker", name: "Talker", emoji: "💬", metric: "messages", goal: 2, rewardCoins: 50, rewardRoleId: ROLE, rewardItem: "chatty-badge" },
        { id: "rich", name: "Rich", metric: "coins", goal: 1000 },
        { id: "faithful", name: "Faithful", metric: "daily-streak", goal: 3 },
        { id: "breeder", name: "Breeder", metric: "pet-level", goal: 2 },
        { id: "voice", name: "Voice", metric: "voice-minutes", goal: 100 },
      ],
    });
  });

  it("unlocks once on the related events, with the reward and an announcement", async () => {
    await setCoins(OTHER, 0);
    await message(OTHER, "hi");
    expect(calls.some((c) => c.fn === "sendMessage")).toBe(false);
    calls.length = 0;
    await message(OTHER, "hi again");
    const said = calls.filter((c) => c.fn === "sendMessage");
    expect(said).toHaveLength(1);
    expect(said[0].args[0]).toBe(CHANNEL);
    expect(String(said[0].args[1])).toContain(`<@${OTHER}> unlocked **💬 Talker**!`);
    expect(String(said[0].args[1])).toContain("Reward: 🪙 50");
    expect(calls.some((c) => c.fn === "addRole" && c.args[2] === ROLE)).toBe(true);
    expect(await quantity(OTHER, "chatty-badge")).toBe(1);
    expect(await balance(OTHER)).toBe(50);

    calls.length = 0;
    await message(OTHER, "and again");
    expect(calls.filter((c) => c.fn === "sendMessage")).toHaveLength(0);
    expect(await balance(OTHER)).toBe(50);
  });

  it("coins, daily streak and pet level; /achievements shows progress", async () => {
    await setCoins(OTHER, 2000);
    await sqlAs(client, "staff", `INSERT INTO dc_profiles (user_id, daily_day, daily_streak) VALUES ($1, 1, 3) ON CONFLICT (user_id) DO UPDATE SET daily_streak = 3`, [OTHER]);
    await setCoins(OTHER, 400, "pet-xp");
    const list = await run(command("achievements", {}, OTHER));
    expect(list.text).toContain("Achievements · 4/5");
    expect(list.text).toContain("✅ 💬 **Talker**");
    expect(list.text).toContain("✅ **Rich**");
    expect(list.text).toContain("✅ **Faithful**");
    expect(list.text).toContain("✅ **Breeder**");
    expect(list.text).toContain("🔒 **Voice** (0/100)");
    expect(emitted.filter((e) => e.event === "dc:achievement:unlocked")).toHaveLength(3);
  });
});

// ── Counting ────────────────────────────────────────────────────────────────────────────────────

describe("kon-dc fun: counting", () => {
  const reactions = () => calls.filter((c) => c.fn === "react").map((c) => c.args[2]);

  it("asks for message content only when on; counts, refuses twice in a row, resets, keeps the record", async () => {
    expect((await request("staff", "PUT", `/guilds/${GUILD}/modules/achievements`, { enabled: false })).status).toBe(200);
    let cfg = await (await request(WORKER, "GET", "/gateway/config")).json();
    expect(cfg.intents & INTENTS.MESSAGE_CONTENT).toBe(0);
    await enable("counting", { channelId: COUNT_CHANNEL });
    cfg = await (await request(WORKER, "GET", "/gateway/config")).json();
    expect(cfg.intents & INTENTS.MESSAGE_CONTENT).toBeTruthy();

    calls.length = 0;
    await message(MEMBER, "1", COUNT_CHANNEL);
    await message(OTHER, "2 easy", COUNT_CHANNEL);
    await message(MEMBER, "chatting, not counting", COUNT_CHANNEL);
    await message(MEMBER, "3", COUNT_CHANNEL);
    await message(OTHER, "5", CHANNEL); // another channel: ignored
    expect(reactions()).toEqual(["✅", "✅", "✅"]);

    calls.length = 0;
    await message(MEMBER, "4", COUNT_CHANNEL);
    expect(reactions()).toEqual(["❌"]);
    expect(String(calls.find((c) => c.fn === "sendMessage")!.args[1])).toContain("you cannot count twice in a row");

    calls.length = 0;
    await message(OTHER, "2", COUNT_CHANNEL);
    expect(reactions()).toEqual(["❌"]);
    await message(OTHER, "1", COUNT_CHANNEL);
    expect(reactions()).toEqual(["❌", "✅"]);

    const stats = await run(sub("counting", "stats"));
    expect(stats.text).toContain("Current count: **1**");
    expect(stats.text).toContain("Best record: **3**");
    expect(stats.text).toContain("Resets: 2");
  });

  it("with warnings only, a wrong number keeps the count", async () => {
    await enable("counting", { channelId: COUNT_CHANNEL, onWrong: "warn", react: false });
    calls.length = 0;
    await message(MEMBER, "7", COUNT_CHANNEL);
    expect(reactions()).toEqual([]);
    expect(String(calls.find((c) => c.fn === "sendMessage")!.args[1])).toContain("it was **2**");
    await message(MEMBER, "2", COUNT_CHANNEL);
    expect((await run(sub("counting", "stats"))).text).toContain("Current count: **2**");
  });
});

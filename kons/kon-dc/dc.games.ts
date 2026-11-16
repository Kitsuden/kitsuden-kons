/**
 * kon-dc — mini-games: /coinflip /dice /rps /blackjack /slots
 * ============================================================================
 *
 * Played for fun or for the server's coins (`rt.economy`, the Economy module's currency). A bet is
 * taken with one write (`economy.take`: all of it or nothing) before the game is drawn, and paid
 * back with the house edge taken from the WINNINGS only (a tie gives the bet back whole).
 * Randomness is `node:crypto`'s `randomInt`. Each game has a cooldown per member.
 *
 *   /coinflip <side> [bet]           double or nothing, minus the edge
 *   /dice [sides] [guess] [bet]      a roll; a bet needs a guess and pays sides − 1 to 1
 *   /rps <choice> [member] [bet]     against the bot, or a challenge another member answers with
 *                                    buttons (both bets on the table; the winner takes both, no edge)
 *   /blackjack [bet]                 Hit / Stand buttons only the player can press; one game per
 *                                    member at a time; a natural pays 3 to 2; the dealer stands on 17
 *   /slots [bet]                     three reels; three alike or two cherries pay
 */

import { randomInt, randomUUID } from "node:crypto";

import { z } from "zod";

import { COINS, ME, claimCooldown, idOf, nowSec, number, readJson } from "./dc.fun";
import { clip, customId, defineDcModule, registerDcModule, type DcModule, type ModuleRuntime, type Reply } from "./dc.modules";

const GAMES = ["coinflip", "dice", "rps", "blackjack", "slots"] as const;
type Game = (typeof GAMES)[number];
const ID = "games";
const COLOR = 0xeb459e;

const GamesConfig = z
  .object({
    games: z.array(z.enum(GAMES)).default([...GAMES]).meta({ title: "Games on", description: "coinflip, dice, rps, blackjack, slots" }),
    betting: z.boolean().default(true).meta({ title: "Members can bet coins" }),
    minBet: z.number().int().min(1).max(1_000_000_000).default(10).meta({ title: "Smallest bet" }),
    maxBet: z.number().int().min(1).max(1_000_000_000).default(10_000).meta({ title: "Largest bet" }),
    houseEdgePercent: z.number().int().min(0).max(50).default(2).meta({ title: "House edge (%)", description: "Taken from the winnings against the bot" }),
    cooldownSeconds: z.number().int().min(0).max(3600).default(5).meta({ title: "Cooldown per game (seconds)" }),
    challengeMinutes: z.number().int().min(1).max(60).default(5).meta({ title: "Minutes to answer an rps challenge" }),
    symbol: z.string().min(1).max(64).default("🪙").meta({ title: "Coin symbol" }),
  })
  .strict()
  .refine((c) => c.minBet <= c.maxBet, { message: "The smallest bet is larger than the largest" });
type GamesConfig = z.output<typeof GamesConfig>;

// ── Bets ────────────────────────────────────────────────────────────────────────────────────────

/** What a win pays back: the bet plus `multiplier` × bet, minus the house edge on that profit. */
export const payout = (bet: number, multiplier: number, edgePercent: number) => bet + Math.floor((bet * multiplier * (100 - edgePercent)) / 100);

/** Checks the bet against the limits (no write). Text = refused. */
function badBet(bet: number, config: GamesConfig, rt: ModuleRuntime): string | null {
  if (!bet) return null;
  if (!config.betting) return rt.t("Betting is off in this server.");
  if (!Number.isInteger(bet) || bet < config.minBet || bet > config.maxBet) {
    return rt.t("Bets go from {symbol} {min} to {symbol} {max}.", { symbol: config.symbol, min: number(config.minBet), max: number(config.maxBet) });
  }
  return null;
}

/** Takes the bet in one write. Text = refused (short of coins). */
async function stake(userId: string, bet: number, config: GamesConfig, rt: ModuleRuntime): Promise<string | null> {
  if (!bet) return null;
  if ((await rt.economy.take(userId, COINS, bet)) === null) return rt.t("You do not have {symbol} {amount}.", { symbol: config.symbol, amount: number(bet) });
  return null;
}

/** Pays `gross` back and says how it went. */
async function settle(userId: string, bet: number, gross: number, config: GamesConfig, rt: ModuleRuntime): Promise<string> {
  if (!bet) return "";
  const sym = config.symbol;
  const balance = gross > 0 ? await rt.economy.add(userId, COINS, gross) : (await rt.economy.get(userId, COINS)).balance;
  const line =
    gross > bet
      ? rt.t("You win {symbol} {amount}!", { symbol: sym, amount: number(gross - bet) })
      : gross === bet
        ? rt.t("Your bet is back.")
        : rt.t("You lose {symbol} {amount}.", { symbol: sym, amount: number(bet - gross) });
  return `${line} ${rt.t("You have {symbol} {balance}.", { symbol: sym, balance: number(balance) })}`;
}

const betOf = (v: unknown) => Math.trunc(Number(v ?? 0)) || 0;

/** The cooldown, then the bet's limits; text = refused. */
async function ready(game: Game, bet: number, config: GamesConfig, rt: ModuleRuntime): Promise<string | null> {
  const bad = badBet(bet, config, rt);
  if (bad) return bad;
  const wait = await claimCooldown(rt.kv, `cd:${game}:${rt.user!.id}`, config.cooldownSeconds, nowSec(rt));
  return wait > 0 ? rt.t("Wait {time}.", { time: `${wait} s` }) : null;
}

const played = (rt: ModuleRuntime, game: Game, bet: number, gross: number) =>
  rt.emit("dc:game:played", { guildId: rt.guildId, userId: rt.user?.id ?? null, game, bet, won: gross > bet });

const result = (title: string, text: string): Reply => ({ embeds: [{ title, description: clip(text, 4000), color: COLOR }] });

// ── Rock, paper, scissors ───────────────────────────────────────────────────────────────────────

const RPS = ["rock", "paper", "scissors"] as const;
type Rps = (typeof RPS)[number];
const RPS_EMOJI: Record<Rps, string> = { rock: "✊", paper: "✋", scissors: "✌️" };
/** 1 = a wins, 0 = tie, -1 = b wins. */
const rpsBeats = (a: Rps, b: Rps) => (a === b ? 0 : (RPS.indexOf(a) - RPS.indexOf(b) + 3) % 3 === 1 ? 1 : -1);
const rpsName = (c: Rps, rt: ModuleRuntime) => `${RPS_EMOJI[c]} ${rt.t(c)}`;

interface Challenge {
  from: string;
  to: string;
  choice: Rps;
  bet: number;
  expires: number;
}

/** Closes a challenge once (the answer, a decline or the clock): false when it was already closed. */
const closeChallenge = async (rt: ModuleRuntime, id: string) => (await rt.kv.incr(`rpsc:${id}`, 1)) === 1;

async function answerChallenge(id: string, pick: Rps | "x", config: GamesConfig, rt: ModuleRuntime): Promise<Reply> {
  const user = rt.user!;
  const game = await readJson<Challenge>(rt.kv, `rps:${id}`);
  if (!game) return ME(rt.t("This game is over."));
  if (user.id !== game.to) return ME(rt.t("Only <@{who}> can answer this.", { who: game.to }));
  if (!(await closeChallenge(rt, id))) return ME(rt.t("This game is over."));
  await rt.schedule.cancel(`rps-${id}`);
  const sym = config.symbol;
  const refund = async () => {
    if (game.bet) await rt.economy.add(game.from, COINS, game.bet);
  };
  const closed = (text: string): Reply => ({ ...result(`✊ ${rt.t("Rock, paper, scissors")}`, text), components: [], update: true });
  if (rt.now().getTime() > game.expires) {
    await refund();
    return closed(rt.t("The challenge expired."));
  }
  if (pick === "x") {
    await refund();
    return closed(rt.t("<@{who}> declined the challenge.", { who: game.to }));
  }
  if (game.bet && (await rt.economy.take(game.to, COINS, game.bet)) === null) {
    await refund();
    return closed(rt.t("<@{who}> does not have {symbol} {amount} for the bet.", { who: game.to, symbol: sym, amount: number(game.bet) }));
  }
  const outcome = rpsBeats(game.choice, pick);
  const lines = [`<@${game.from}>: ${rpsName(game.choice, rt)}`, `<@${game.to}>: ${rpsName(pick, rt)}`, ""];
  if (outcome === 0) {
    if (game.bet) {
      await rt.economy.add(game.from, COINS, game.bet);
      await rt.economy.add(game.to, COINS, game.bet);
    }
    lines.push(rt.t("A tie!"));
  } else {
    const winner = outcome === 1 ? game.from : game.to;
    if (game.bet) await rt.economy.add(winner, COINS, game.bet * 2);
    lines.push(game.bet ? rt.t("<@{who}> wins {symbol} {amount}!", { who: winner, symbol: sym, amount: number(game.bet * 2) }) : rt.t("<@{who}> wins!", { who: winner }));
  }
  rt.emit("dc:game:played", { guildId: rt.guildId, userId: game.to, game: "rps", bet: game.bet, won: outcome === -1 });
  return closed(lines.join("\n"));
}

// ── Blackjack ───────────────────────────────────────────────────────────────────────────────────

/** A card is 0–51: rank = c % 13 (0 = ace … 12 = king), suit = c / 13. */
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];
const cardText = (c: number) => `${RANKS[c % 13]}${SUITS[Math.floor(c / 13)]}`;

export function handValue(cards: number[]): number {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    const r = c % 13;
    if (r === 0) aces++;
    total += r === 0 ? 1 : Math.min(10, r + 1);
  }
  return aces && total + 10 <= 21 ? total + 10 : total;
}

/** A shuffled deck (Fisher–Yates with crypto randomness). */
function shuffled(): number[] {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

interface Table {
  deck: number[];
  player: number[];
  dealer: number[];
  bet: number;
  at: number;
  /** The move counter's value this table was written at (a press claims the next one). */
  mv: number;
}

const BJ_STALE_SECONDS = 600;

function tableMessage(userId: string, t: Table, rt: ModuleRuntime, outcome: string | null): Reply {
  const hidden = outcome === null;
  const dealer = hidden ? `${cardText(t.dealer[0])} 🂠` : `${t.dealer.map(cardText).join(" ")} (${handValue(t.dealer)})`;
  return {
    embeds: [
      {
        title: `🃏 ${rt.t("Blackjack")}`,
        description: clip(`<@${userId}>${t.bet ? ` · ${rt.t("Bet")}: ${number(t.bet)}` : ""}${outcome ? `\n\n${outcome}` : ""}`, 4000),
        fields: [
          { name: rt.t("Your hand"), value: `${t.player.map(cardText).join(" ")} (${handValue(t.player)})`, inline: true },
          { name: rt.t("Dealer"), value: dealer, inline: true },
        ],
        color: COLOR,
      },
    ],
    components: hidden
      ? [
          {
            type: 1,
            components: [
              { type: 2, style: 1, label: rt.t("Hit"), custom_id: customId(ID, `bj-h-${userId}`) },
              { type: 2, style: 2, label: rt.t("Stand"), custom_id: customId(ID, `bj-s-${userId}`) },
            ],
          },
        ]
      : [],
  };
}

/** The dealer draws to 17, the table is paid and closed. */
async function finishTable(userId: string, t: Table, config: GamesConfig, rt: ModuleRuntime): Promise<Reply> {
  const player = handValue(t.player);
  if (player <= 21) while (handValue(t.dealer) < 17 && t.deck.length) t.dealer.push(t.deck.pop()!);
  const dealer = handValue(t.dealer);
  const natural = player === 21 && t.player.length === 2;
  const dealerNatural = dealer === 21 && t.dealer.length === 2;
  let gross = 0;
  let line: string;
  if (player > 21) line = rt.t("Bust: you went over 21.");
  else if (natural && !dealerNatural) {
    gross = payout(t.bet, 1.5, config.houseEdgePercent);
    line = rt.t("Blackjack!");
  } else if (dealer > 21 || player > dealer) {
    gross = payout(t.bet, 1, config.houseEdgePercent);
    line = rt.t("You beat the dealer.");
  } else if (player === dealer) {
    gross = t.bet;
    line = rt.t("A push: nobody wins.");
  } else line = rt.t("The dealer wins.");
  await rt.kv.set(`bj:${userId}`, "");
  await rt.kv.set(`bj-on:${userId}`, 0);
  const paid = await settle(userId, t.bet, gross, config, rt);
  played(rt, "blackjack", t.bet, gross);
  return { ...tableMessage(userId, t, rt, `${line} ${paid}`.trim()), update: true };
}

async function startBlackjack(bet: number, config: GamesConfig, rt: ModuleRuntime): Promise<Reply> {
  const user = rt.user!;
  // One table per member, claimed in one write.
  if ((await rt.kv.incr(`bj-on:${user.id}`, 1)) !== 1) {
    await rt.kv.incr(`bj-on:${user.id}`, -1);
    const old = await readJson<Table>(rt.kv, `bj:${user.id}`);
    if (old && nowSec(rt) - old.at < BJ_STALE_SECONDS) return ME(rt.t("Finish your blackjack game first."));
    // Left alone for ten minutes: that table is lost (its bet with it).
    await rt.kv.set(`bj:${user.id}`, "");
    await rt.kv.set(`bj-on:${user.id}`, 0);
    return ME(rt.t("Your old table expired. Start again."));
  }
  const short = await stake(user.id, bet, config, rt);
  if (short) {
    await rt.kv.set(`bj-on:${user.id}`, 0);
    return ME(short);
  }
  const deck = shuffled();
  const t: Table = { deck, player: [deck.pop()!, deck.pop()!], dealer: [deck.pop()!, deck.pop()!], bet, at: nowSec(rt), mv: Number(await rt.kv.get(`bj-mv:${user.id}`)) || 0 };
  if (handValue(t.player) === 21 || handValue(t.dealer) === 21) {
    const done = await finishTable(user.id, t, config, rt);
    return { ...done, update: undefined };
  }
  await rt.kv.set(`bj:${user.id}`, JSON.stringify(t));
  return tableMessage(user.id, t, rt, null);
}

async function blackjackMove(owner: string, move: "h" | "s", config: GamesConfig, rt: ModuleRuntime): Promise<Reply> {
  const user = rt.user!;
  if (user.id !== owner) return ME(rt.t("This is not your game."));
  const t = await readJson<Table>(rt.kv, `bj:${owner}`);
  if (!t) return ME(rt.t("This game is over."));
  // One move at a time: a press claims the next move number in one write.
  const got = await rt.kv.incr(`bj-mv:${owner}`, 1);
  if (got !== t.mv + 1) {
    await rt.kv.incr(`bj-mv:${owner}`, -1);
    return ME(rt.t("One move at a time."));
  }
  t.mv = got;
  t.at = nowSec(rt);
  if (move === "s") return finishTable(owner, t, config, rt);
  t.player.push(t.deck.pop()!);
  if (handValue(t.player) >= 21) return finishTable(owner, t, config, rt);
  await rt.kv.set(`bj:${owner}`, JSON.stringify(t));
  return { ...tableMessage(owner, t, rt, null), update: true };
}

// ── Slots ───────────────────────────────────────────────────────────────────────────────────────

/** Reel symbols with their weight and what three of them pay (× the bet, as winnings). */
const REEL: Array<{ s: string; w: number; pays: number }> = [
  { s: "🍒", w: 30, pays: 5 },
  { s: "🍋", w: 25, pays: 10 },
  { s: "🔔", w: 20, pays: 15 },
  { s: "⭐", w: 13, pays: 30 },
  { s: "💎", w: 8, pays: 60 },
  { s: "7️⃣", w: 4, pays: 150 },
];
const REEL_TOTAL = REEL.reduce((n, r) => n + r.w, 0);

function spin(): number[] {
  return [0, 1, 2].map(() => {
    let roll = randomInt(0, REEL_TOTAL);
    return REEL.findIndex((r) => (roll -= r.w) < 0);
  });
}

/** The winnings multiplier of a spin (0 = lost). */
export function slotsMultiplier(reels: number[]): number {
  if (reels[0] === reels[1] && reels[1] === reels[2]) return REEL[reels[0]].pays;
  return reels.filter((r) => r === 0).length === 2 ? 1 : 0;
}

// ── The module ──────────────────────────────────────────────────────────────────────────────────

const betOption = (config: GamesConfig) =>
  config.betting ? [{ name: "bet", description: "Coins to bet", type: 4, min_value: Math.max(1, config.minBet), max_value: config.maxBet }] : [];

export const gamesModule = defineDcModule({
  id: ID,
  name: "Mini-games",
  description: "Coin flip, dice, rock paper scissors (against the bot or a member), blackjack and slots, for fun or for coins.",
  config: GamesConfig,
  intents: 0,
  events: [],
  commands: (config) => {
    const on = new Set(config.games);
    const bet = betOption(config);
    return [
      ...(on.has("coinflip")
        ? [
            {
              name: "coinflip",
              description: "Flip a coin",
              type: 1 as const,
              options: [
                { name: "side", description: "Heads or tails", type: 3, required: true, choices: [{ name: "heads", value: "heads" }, { name: "tails", value: "tails" }] },
                ...bet,
              ],
            },
          ]
        : []),
      ...(on.has("dice")
        ? [
            {
              name: "dice",
              description: "Roll a die",
              type: 1 as const,
              options: [
                { name: "sides", description: "How many sides (2-100)", type: 4, min_value: 2, max_value: 100 },
                { name: "guess", description: "The number you bet on", type: 4, min_value: 1, max_value: 100 },
                ...bet,
              ],
            },
          ]
        : []),
      ...(on.has("rps")
        ? [
            {
              name: "rps",
              description: "Rock, paper, scissors",
              type: 1 as const,
              options: [
                { name: "choice", description: "Your pick", type: 3, required: true, choices: RPS.map((c) => ({ name: c, value: c })) },
                { name: "member", description: "Challenge a member instead of the bot", type: 6 },
                ...bet,
              ],
            },
          ]
        : []),
      ...(on.has("blackjack") ? [{ name: "blackjack", description: "Play blackjack against the dealer", type: 1 as const, options: bet }] : []),
      ...(on.has("slots") ? [{ name: "slots", description: "Spin the slot machine", type: 1 as const, options: bet }] : []),
    ];
  },
  plan: (target) => (target.kind === "command" ? { reply: true } : {}),

  async onCommand(invocation, config, rt) {
    const user = rt.user;
    if (!user || !(GAMES as readonly string[]).includes(invocation.name)) return null;
    const game = invocation.name as Game;
    if (!config.games.includes(game)) return ME(rt.t("This game is off in this server."));
    const bet = betOf(invocation.options.bet);
    const o = invocation.options;

    if (game === "rps" && idOf(o.member)) {
      const to = idOf(o.member)!;
      if (to === user.id || to === rt.botUserId) return ME(rt.t("Pick another member."));
      const choice = String(o.choice) as Rps;
      if (!RPS.includes(choice)) return ME(rt.t("Pick rock, paper or scissors."));
      const refused = await ready(game, bet, config, rt);
      if (refused) return ME(refused);
      const short = await stake(user.id, bet, config, rt);
      if (short) return ME(short);
      const id = randomUUID().replace(/-/g, "").slice(0, 12);
      const expires = rt.now().getTime() + config.challengeMinutes * 60_000;
      await rt.kv.set(`rps:${id}`, JSON.stringify({ from: user.id, to, choice, bet, expires } satisfies Challenge));
      await rt.schedule.at(new Date(expires), { id }, `rps-${id}`);
      const text = bet
        ? rt.t("<@{from}> challenges <@{to}> for {symbol} {amount}. Pick within {n} min.", { from: user.id, to, symbol: config.symbol, amount: number(bet), n: config.challengeMinutes })
        : rt.t("<@{from}> challenges <@{to}>. Pick within {n} min.", { from: user.id, to, n: config.challengeMinutes });
      return {
        content: `<@${to}>`,
        ...result(`✊ ${rt.t("Rock, paper, scissors")}`, text),
        components: [
          {
            type: 1,
            components: [
              ...RPS.map((c) => ({ type: 2, style: 1, label: rt.t(c), emoji: { name: RPS_EMOJI[c] }, custom_id: customId(ID, `rps-${c[0]}-${id}`) })),
              { type: 2, style: 4, label: rt.t("Decline"), custom_id: customId(ID, `rps-x-${id}`) },
            ],
          },
        ],
      };
    }

    if (game === "dice") {
      const sides = Math.min(100, Math.max(2, Math.trunc(Number(o.sides ?? 6)) || 6));
      const guess = o.guess === undefined ? null : Math.trunc(Number(o.guess));
      if (bet && guess === null) return ME(rt.t("Pick a number to bet on."));
      if (guess !== null && (guess < 1 || guess > sides)) return ME(rt.t("Guess a number from 1 to {n}.", { n: sides }));
    }
    if (game === "blackjack") {
      const refused = await ready(game, bet, config, rt);
      return refused ? ME(refused) : startBlackjack(bet, config, rt);
    }

    const refused = await ready(game, bet, config, rt);
    if (refused) return ME(refused);
    const short = await stake(user.id, bet, config, rt);
    if (short) return ME(short);
    const edge = config.houseEdgePercent;
    let gross = 0;
    let text: string;
    let title: string;
    switch (game) {
      case "coinflip": {
        const side = randomInt(0, 2) === 0 ? "heads" : "tails";
        const won = side === o.side;
        gross = won ? payout(bet, 1, edge) : 0;
        title = `🪙 ${rt.t("Coin flip")}`;
        text = `${rt.t("It landed on **{side}**.", { side: rt.t(side) })} ${bet ? "" : won ? rt.t("You guessed right!") : rt.t("You guessed wrong.")}`;
        break;
      }
      case "dice": {
        const sides = Math.min(100, Math.max(2, Math.trunc(Number(o.sides ?? 6)) || 6));
        const roll = randomInt(1, sides + 1);
        const guess = o.guess === undefined ? null : Math.trunc(Number(o.guess));
        gross = guess === roll ? payout(bet, sides - 1, edge) : 0;
        title = `🎲 ${rt.t("Dice")}`;
        text = `${rt.t("You rolled **{n}** (d{sides}).", { n: roll, sides })} ${guess === null || bet ? "" : guess === roll ? rt.t("You guessed right!") : rt.t("You guessed wrong.")}`;
        break;
      }
      case "rps": {
        const mine = String(o.choice) as Rps;
        const theirs = RPS[randomInt(0, 3)];
        const outcome = RPS.includes(mine) ? rpsBeats(mine, theirs) : -1;
        gross = outcome === 1 ? payout(bet, 1, edge) : outcome === 0 ? bet : 0;
        title = `✊ ${rt.t("Rock, paper, scissors")}`;
        text = `${rt.t("You: {mine} · Me: {theirs}.", { mine: rpsName(mine, rt), theirs: rpsName(theirs, rt) })} ${outcome === 1 ? rt.t("You win!") : outcome === 0 ? rt.t("A tie!") : rt.t("I win!")}`;
        break;
      }
      default: {
        const reels = spin();
        const m = slotsMultiplier(reels);
        gross = m ? payout(bet, m, edge) : 0;
        title = `🎰 ${rt.t("Slots")}`;
        text = `**[ ${reels.map((r) => REEL[r].s).join(" | ")} ]**\n${m ? rt.t("A win!") : rt.t("No luck this time.")}`;
      }
    }
    const paid = await settle(user.id, bet, gross, config, rt);
    played(rt, game, bet, gross);
    return result(title, `<@${user.id}> ${text.trim()}${paid ? `\n${paid}` : ""}`);
  },

  async onComponent(use, config, rt) {
    if (!rt.user) return null;
    const bj = /^bj-([hs])-(\d{15,20})$/.exec(use.id);
    if (bj) return blackjackMove(bj[2], bj[1] as "h" | "s", config, rt);
    const rps = /^rps-([rpsx])-([0-9a-f]{12})$/.exec(use.id);
    if (rps) {
      const pick = rps[1] === "x" ? "x" : RPS.find((c) => c[0] === rps[1])!;
      return answerChallenge(rps[2], pick, config, rt);
    }
    return null;
  },

  async onSchedule(key, payload, _config, rt) {
    // A challenge nobody answered: the challenger's bet goes back.
    const id = typeof payload.id === "string" ? payload.id : null;
    if (!key.startsWith("rps-") || !id) return;
    const game = await readJson<Challenge>(rt.kv, `rps:${id}`);
    if (!game || !(await closeChallenge(rt, id))) return;
    if (game.bet) await rt.economy.add(game.from, COINS, game.bet);
  },
});

registerDcModule(gamesModule as unknown as DcModule);

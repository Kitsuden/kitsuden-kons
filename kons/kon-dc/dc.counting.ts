/**
 * kon-dc — counting: a channel where members count up together
 * ============================================================================
 *
 * In the counting channel each message that starts with a number is a count: it must be the next
 * number, and the same member cannot count twice in a row. A right one gets ✅; a wrong one gets ❌
 * and resets the count to 0 (or, with `onWrong: "warn"`, only a warning). Messages that do not
 * start with a number are left alone. /counting stats shows the count and the best record.
 *
 * It reads message text, so it needs Discord's privileged MESSAGE_CONTENT intent (switch on
 * "Message Content Intent" in the Developer Portal): only this module asks for it, and it keeps no
 * text, only the count. The next number is claimed in one write (`kv.incr`): two members typing
 * the same number at once, only the first counts.
 */

import { z } from "@kitsuden/engine/zod";

import { INTENTS, Snowflake } from "./dc.contract";
import { number } from "./dc.fun";
import { defineDcModule, messageOf, registerDcModule, type DcModule, type ModuleRuntime } from "./dc.modules";

const ID = "counting";

const CountingConfig = z
  .object({
    channelId: Snowflake.meta({ title: "Counting channel id" }),
    onWrong: z.enum(["reset", "warn"]).default("reset").meta({ title: "A wrong number", description: "reset the count, or only warn" }),
    react: z.boolean().default(true).meta({ title: "React ✅ and ❌" }),
  })
  .strict();
type CountingConfig = z.output<typeof CountingConfig>;

/** The number a message starts with, or null. Digits only, read by hand (no regex on member text). */
export function countOf(content: string | null): number | null {
  if (!content) return null;
  const text = content.trimStart();
  let digits = "";
  for (const ch of text) {
    if (ch >= "0" && ch <= "9" && digits.length < 15) digits += ch;
    else break;
  }
  if (!digits) return null;
  const rest = text.slice(digits.length);
  // "12" or "12 nice", not "12abc" nor "1.5".
  if (rest && !/^\s/.test(rest)) return null;
  return Number(digits);
}

async function react(rt: ModuleRuntime, config: CountingConfig, channelId: string, messageId: string | null | undefined, emoji: string) {
  if (!config.react || !messageId) return;
  await rt.rest.react(channelId, messageId, emoji).catch((err) => rt.logger.warn("Counting: could not react", { message: messageOf(err) }));
}

export const countingModule = defineDcModule({
  id: ID,
  name: "Counting",
  description: "A counting channel: members count up one by one, never twice in a row; a wrong number resets it. Needs the Message Content intent.",
  config: CountingConfig,
  intents: INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT,
  events: ["MESSAGE_CREATE"],
  commands: () => [{ name: "counting", description: "The counting channel", type: 1, options: [{ name: "stats", description: "The count and the best record", type: 1 }] }],
  plan: () => ({ reply: true }),

  async onEvent(event, config, rt) {
    if (event.type !== "MESSAGE_CREATE" || event.isBot || !event.user || event.channelId !== config.channelId) return;
    const n = countOf(event.content);
    if (n === null) return;
    const userId = event.user.id;
    const channel = config.channelId;
    const current = Number(await rt.kv.get("count")) || 0;
    const last = await rt.kv.get("last");
    let wrong: string | null = null;
    if (last === userId) wrong = rt.t("<@{who}>, you cannot count twice in a row.", { who: userId });
    else if (n !== current + 1) wrong = rt.t("<@{who}>, that is not the next number: it was **{next}**.", { who: userId, next: current + 1 });
    else {
      const got = await rt.kv.incr("count", 1);
      if (got !== n) {
        // Someone else counted this number first.
        await rt.kv.incr("count", -1);
        wrong = rt.t("<@{who}>, that is not the next number: it was **{next}**.", { who: userId, next: got });
      }
    }
    if (!wrong) {
      await rt.kv.set("last", userId);
      if (n > (Number(await rt.kv.get("best")) || 0)) {
        await rt.kv.set("best", n);
        await rt.kv.set("bestAt", Math.floor(rt.now().getTime() / 1000));
      }
      await react(rt, config, channel, event.messageId, "✅");
      return;
    }
    await react(rt, config, channel, event.messageId, "❌");
    let text = wrong;
    if (config.onWrong === "reset") {
      await rt.kv.set("count", 0);
      await rt.kv.set("last", "");
      await rt.kv.incr("resets", 1);
      text += ` ${rt.t("The count went back to 0. Start again from **1**.")}`;
    }
    await rt.rest.sendMessage(channel, text).catch((err) => rt.logger.warn("Counting: could not send", { message: messageOf(err) }));
  },

  async onCommand(invocation, config, rt) {
    if (invocation.name !== "counting") return null;
    const best = Number(await rt.kv.get("best")) || 0;
    const bestAt = Number(await rt.kv.get("bestAt")) || 0;
    const lines = [
      rt.t("Channel: <#{channel}>", { channel: config.channelId }),
      rt.t("Current count: **{n}**", { n: number(Number(await rt.kv.get("count")) || 0) }),
      rt.t("Best record: **{n}**", { n: number(best) }) + (bestAt ? ` (<t:${bestAt}:d>)` : ""),
      rt.t("Resets: {n}", { n: number(Number(await rt.kv.get("resets")) || 0) }),
    ];
    return { embeds: [{ title: `🔢 ${rt.t("Counting")}`, description: lines.join("\n"), color: 0x5865f2 }] };
  },
});

registerDcModule(countingModule as unknown as DcModule);

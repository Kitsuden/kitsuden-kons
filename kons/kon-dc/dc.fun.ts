/**
 * kon-dc — helpers the fun modules share (games, pets, housing, achievements, counting)
 * ============================================================================
 *
 * Claims that can race are ONE SQL write: `rt.kv.incr` is an upsert that adds and returns the new
 * value, so a cooldown or a short lock is claimed by adding exactly what makes the value equal to
 * "now". Two requests that read the same old value both add; only the first sees "now" come back,
 * the other takes its addition back and is refused. Coins and items are claimed with
 * `rt.economy.take`/`takeItem` (all or nothing).
 */

import { clip, type ModuleKv, type ModuleRuntime, type Reply } from "./dc.modules";

export const ME = (text: string): Reply => ({ content: clip(text), ephemeral: true });
export const number = (n: number) => new Intl.NumberFormat("en-US").format(n);
/** A user option's id (Discord sends the id as the value). */
export const idOf = (v: unknown) => (typeof v === "string" && /^\d{15,20}$/.test(v) ? v : null);
/** Seconds since 1970 on the engine's clock (tests move it). */
export const nowSec = (rt: Pick<ModuleRuntime, "now">) => Math.floor(rt.now().getTime() / 1000);
export const COINS = "coins";
/** A pet's XP: a balance in the shared economy, so Achievements can read pet levels. */
export const PET_XP = "pet-xp";

/**
 * Claims a cooldown of `seconds` on `key` in one write. 0 = claimed; otherwise the seconds to wait.
 */
export async function claimCooldown(kv: ModuleKv, key: string, seconds: number, now: number): Promise<number> {
  if (seconds <= 0) return 0;
  const last = Number(await kv.get(key)) || 0;
  const wait = last + seconds - now;
  if (wait > 0) return wait;
  const delta = now - last;
  const got = await kv.incr(key, delta);
  if (got === now) return 0;
  // Somebody else claimed it between the read and the write: take ours back (additions commute).
  await kv.incr(key, -delta);
  return seconds;
}

/**
 * Runs `fn` holding a short lock on `key` (a member's pet, house): `null` when another request
 * holds it. The lock is a cooldown released at the end; a crashed holder's lock ends by itself.
 */
export async function withLock<T>(rt: Pick<ModuleRuntime, "kv" | "now">, key: string, fn: () => Promise<T>, seconds = 15): Promise<T | null> {
  if ((await claimCooldown(rt.kv, `lock:${key}`, seconds, nowSec(rt))) > 0) return null;
  try {
    return await fn();
  } finally {
    await rt.kv.set(`lock:${key}`, 0);
  }
}

/** A JSON value a module stored with `rt.kv.set(key, JSON.stringify(...))`. */
export async function readJson<T>(kv: ModuleKv, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** A bar of 10 blocks for 0–100. */
export const bar = (value: number) => {
  const full = Math.max(0, Math.min(10, Math.round(value / 10)));
  return `${"█".repeat(full)}${"░".repeat(10 - full)} ${Math.round(value)}%`;
};

/** A name members choose, without markdown or mentions. */
export function plainName(text: string, max = 32): string {
  let out = "";
  for (const ch of text) if (!"`*_~|<>@#\\\n\r".includes(ch)) out += ch;
  return out.trim().slice(0, max);
}

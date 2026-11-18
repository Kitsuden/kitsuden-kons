/** Times, sizes and durations as the inbox shows them, in the browser's locale. */

import { T } from "./strings";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "now", "5m", "3h", "Mon", "12 May": the list's short time. */
export function shortTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  const d = now - t;
  if (d < MIN) return T.now;
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY && new Date(t).getDate() === new Date(now).getDate()) return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d < 6 * DAY) return new Date(t).toLocaleDateString(undefined, { weekday: "short" });
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** "14:05", or with the date when it is not today. */
export function clock(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso);
  const sameDay = t.toDateString() === new Date(now).toDateString();
  return sameDay
    ? t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : t.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The full date and time, for a title attribute. */
export const full = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");

/** "3h 12m", "45m", "2d 4h": time left until `iso`, or "" when it passed. */
export function left(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "";
  if (ms >= DAY) return `${Math.floor(ms / DAY)}d ${Math.floor((ms % DAY) / HOUR)}h`;
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MIN)}m`;
  return `${Math.max(1, Math.floor(ms / MIN))}m`;
}

export const msLeft = (iso: string | null | undefined, now = Date.now()) => (iso ? new Date(iso).getTime() - now : -1);

/** "1:05" from milliseconds. */
export function duration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return "0:00";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function bytes(n: number | null | undefined): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Day separators in the thread: "Today", "Yesterday", or the date. */
export function dayLabel(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return T.today;
  const y = new Date(now - DAY);
  if (d.toDateString() === y.toDateString()) return T.yesterday;
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

/** A key that makes a retried request the same one (the API's idempotency keys). */
export function newKey(prefix = "inbox"): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return `${prefix}-${Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Only http(s) links are followed from what the API returns. */
export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw, window.location.href);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Local time: quiet hours, contact hours, time zones
 * ============================================================================
 *
 * A campaign or a sequence must not write to someone at 3 a.m. their time, and collections laws in
 * several countries limit the hours a debtor may be contacted. Two shapes, both pure:
 *
 *   quiet hours     {from, to, timezone}: do NOT send between `from` and `to` (it may wrap midnight:
 *                   21:00 → 08:00). Campaigns carry it (`koe_campaigns.quiet_hours`).
 *   business hours  {mon: [["09:00", "18:00"]], …}: a team's contact hours; outside them nothing
 *                   automatic goes out for a collections team (`koe_teams.business_hours`).
 *
 * The contact's own time zone wins when the contact has an attribute `timezone` (an IANA name);
 * otherwise the campaign's or the team's. An unknown zone falls back to UTC rather than failing.
 */

export type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface QuietHours {
  from: string;
  to: string;
  timezone?: string | null;
}

const DAYS: Record<string, Day> = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" };
const HHMM = /^([01]\d|2[0-4]):([0-5]\d)$/;

export function isHhMm(value: unknown): value is string {
  return typeof value === "string" && HHMM.test(value) && minutesOf(value) <= 24 * 60;
}

export function minutesOf(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

const zones = new Map<string, boolean>();
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  const known = zones.get(tz);
  if (known !== undefined) return known;
  let ok = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    ok = true;
  } catch {
    ok = false;
  }
  zones.set(tz, ok);
  return ok;
}

/** Day of the week and minutes since midnight at `date` in `timeZone` (UTC when the zone is unknown). */
export function localTime(date: Date, timeZone?: string | null): { day: Day; minutes: number } {
  const tz = validTimeZone(timeZone) ? timeZone : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: DAYS[get("weekday")] ?? "mon", minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}

/** Whether `date` falls in the quiet hours, in the contact's zone when it has one. */
export function inQuietHours(date: Date, quiet: QuietHours | null | undefined, contactTimeZone?: string | null): boolean {
  if (!quiet || !isHhMm(quiet.from) || !isHhMm(quiet.to)) return false;
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  if (from === to) return false;
  const { minutes } = localTime(date, validTimeZone(contactTimeZone) ? contactTimeZone : quiet.timezone);
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/**
 * Whether `date` is inside a team's contact hours. No hours configured means "any time": a team that
 * never set them is not silenced by surprise.
 */
export function inBusinessHours(date: Date, hours: Record<string, Array<[string, string]>> | null | undefined, timeZone?: string | null): boolean {
  if (!hours || Object.keys(hours).length === 0) return true;
  const { day, minutes } = localTime(date, timeZone);
  for (const [a, b] of hours[day] ?? []) {
    if (!isHhMm(a) || !isHhMm(b)) continue;
    const from = minutesOf(a);
    const to = minutesOf(b);
    if (from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to) return true;
  }
  return false;
}

/** The contact's own zone, when it has a valid one. */
export function contactTimeZone(attributes: Record<string, unknown> | null | undefined): string | null {
  const tz = attributes?.timezone;
  return validTimeZone(tz) ? tz : null;
}

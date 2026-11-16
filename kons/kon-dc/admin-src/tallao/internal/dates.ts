/**
 * tallao — dates without time for Calendar and DatePicker
 *
 * A date is an ISO "YYYY-MM-DD" string. Arithmetic is done in UTC: with local time,
 * a daylight-saving change or a zone west of Greenwich shifted the day.
 */

export type ISODate = string;

/** "2026-11-03" → { y, m, d }, or null if it is not a real date (February 31 is not). */
export function parseISO(text: string | null | undefined): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((text ?? "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const month = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, month - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== d) return null;
  return { y, m: month, d };
}

export const toISO = (y: number, m: number, d: number): ISODate =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

const toDate = (iso: ISODate) => {
  const p = parseISO(iso)!;
  return new Date(Date.UTC(p.y, p.m - 1, p.d));
};

const fromDate = (date: Date): ISODate => toISO(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());

export function addDays(iso: ISODate, n: number): ISODate {
  const date = toDate(iso);
  date.setUTCDate(date.getUTCDate() + n);
  return fromDate(date);
}

/** Adds months without overflowing the month: January 31 + 1 month = February 28 (or 29). */
export function addMonths(iso: ISODate, n: number): ISODate {
  const p = parseISO(iso)!;
  const target = new Date(Date.UTC(p.y, p.m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return toISO(target.getUTCFullYear(), target.getUTCMonth() + 1, Math.min(p.d, last));
}

/** Day of the week: 0 Sunday … 6 Saturday. */
export const weekday = (iso: ISODate) => toDate(iso).getUTCDay();

export function todayISO(): ISODate {
  const date = new Date();
  return toISO(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export const sameMonth = (a: ISODate, b: ISODate) => a.slice(0, 7) === b.slice(0, 7);

export const clampISO = (iso: ISODate, min?: ISODate | null, max?: ISODate | null) =>
  min && iso < min ? min : max && iso > max ? max : iso;

/** The weeks (of 7 dates) that cover the month of `iso`, starting on `weekStartsOn`. */
export function monthGrid(iso: ISODate, weekStartsOn: number): ISODate[][] {
  const p = parseISO(iso)!;
  const first = toISO(p.y, p.m, 1);
  const start = addDays(first, -((weekday(first) - weekStartsOn + 7) % 7));
  const weeks: ISODate[][] = [];
  let day = start;
  do {
    const week: ISODate[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(day);
      day = addDays(day, 1);
    }
    weeks.push(week);
  } while (sameMonth(day, first));
  return weeks;
}

/** Locale formats (Intl) for dates without time: read in UTC so the day does not shift. */
export function formatDate(iso: ISODate, locale: string | undefined, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).format(toDate(iso));
}

/** Uppercases the first letter and nothing else ("noviembre de 2026" → "Noviembre de 2026"). */
export function capitalizeFirst(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

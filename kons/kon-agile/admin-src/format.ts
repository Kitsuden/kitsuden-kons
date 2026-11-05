/** Display helpers shared by the sections. */

export function day(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString().slice(0, 10);
}

export function moment(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}

/** For `<input type="date">`: the date part of an ISO value. */
export const dateInput = (value: string | null | undefined) => (value ? value.slice(0, 10) : "");

export const money = (value: string | number | null | undefined) =>
  `$${Number(value ?? 0).toFixed(Number(value ?? 0) < 1 ? 4 : 2)}`;

export const count = (value: number | null | undefined) => (value ?? 0).toLocaleString("en-US");

/** "in_progress" → "In progress". */
export const words = (value: string | null | undefined) =>
  value ? value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ") : "—";

export const options = (values: readonly string[]) => values.map((v) => ({ value: v, label: words(v) }));

/** Empty input → undefined, so an optional field is left out of the body. */
export const optional = (value: string) => (value.trim() === "" ? undefined : value.trim());

/** Empty input → null, to clear a nullable field on an update. */
export const nullable = (value: string) => (value.trim() === "" ? null : value.trim());

export const statusVariant = (status: string) =>
  ({
    done: "success",
    completed: "success",
    accepted: "success",
    active: "info",
    started: "info",
    running: "info",
    in_progress: "info",
    queued: "warning",
    pending: "warning",
    planned: "secondary",
    failed: "error",
    declined: "error",
    spam: "error",
    cancelled: "default",
    duplicate: "default",
  })[status] as "success" | "info" | "warning" | "secondary" | "error" | "default" | undefined;

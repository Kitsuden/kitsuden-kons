/** The API client every section uses, given once by the view's root. */
import { getContext, setContext } from "svelte";

import type { Api } from "./api";

const KEY = Symbol("kon-dc-api");

export const provideApi = (api: Api) => setContext(KEY, api);
export const useApi = () => getContext<Api>(KEY);

/** A UTC day (YYYY-MM-DD) as a short, unambiguous label in the viewer's locale: "16 nov", "Nov 16". */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Dates as the panel shows them: short, in the viewer's locale. */
export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

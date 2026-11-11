<!--
  tallao — FilterBar
  The filters of a list, from a declaration: a search field, one FilterChip per filter, an
  "Add filter" menu for the ones that start hidden, and "Clear all".

    <FilterBar bind:value={query} onchange={load} filters={[
      { key: "status", label: "Status", type: "select", options: ["Draft", "Published"] },
      { key: "featured", label: "Featured", type: "boolean" },
      { key: "since", label: "Published since", type: "date", hidden: true },
      { key: "period", label: "Period", type: "date", range: true, hidden: true },
      { key: "author", label: "Author", type: "text", hidden: true },
    ]} />

  - `value` is a plain object with only what is applied: `{ q: "tide", status: "Draft",
    featured: true }`. The search text goes under `searchKey` ("q"). It is JSON, so the page
    can keep it in the URL: `filtersToQuery(value)` writes a query string and
    `filtersFromQuery(location.search, filters)` reads one back (booleans by the declaration).
  - `onchange` gets the whole object on every change (each keystroke of the search too:
    debounce in the page if the list comes from an API).
  - A filter with `hidden: true` lives in the "Add filter" menu until it is chosen or has a
    value; choosing it adds its chip and opens its editor. Removing it puts it back.
  - It is a `search` landmark named `ariaLabel`. How many filters apply is announced in a
    polite live region ("2 filters active"); the chips say their value in text.
  - `end` puts your own controls at the end of the row (SavedViews, an export button).
  Each chip's keyboard is in FilterChip. Rendered on the server with the values applied.
-->
<script lang="ts" module>
  import type { FilterOption, FilterType } from "./filter-chip.svelte";

  export interface FilterDef {
    /** The key of the filter in `value` and in the URL. */
    key: string;
    label: string;
    type: FilterType;
    /** The choices of a "select". */
    options?: FilterOption[];
    /** Starts in the "Add filter" menu instead of in the bar. */
    hidden?: boolean;
    /** Placeholder of a "text" filter. */
    placeholder?: string;
    /** A "date" filter takes two dates: its value is "start..end". */
    range?: boolean;
  }

  export type FilterValues = Record<string, string | boolean>;

  /** A query string ("status=Draft&featured=true") from the applied filters. */
  export function filtersToQuery(value: FilterValues): string {
    const params = new URLSearchParams();
    for (const [key, v] of Object.entries(value)) {
      if (v !== "" && v !== null && v !== undefined) params.set(key, String(v));
    }
    return params.toString();
  }

  /** The applied filters from a query string; keys that are not declared are ignored. */
  export function filtersFromQuery(query: string | URLSearchParams, filters: FilterDef[], searchKey = "q"): FilterValues {
    const params = typeof query === "string" ? new URLSearchParams(query) : query;
    const value: FilterValues = {};
    const search = params.get(searchKey);
    if (search) value[searchKey] = search;
    for (const def of filters) {
      const raw = params.get(def.key);
      if (raw === null || raw === "") continue;
      if (def.type === "boolean") {
        if (raw === "true" || raw === "false") value[def.key] = raw === "true";
      } else value[def.key] = raw;
    }
    return value;
  }
</script>

<script lang="ts">
  import { tick, type Snippet } from "svelte";

  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  import Button from "./button.svelte";
  import DropdownMenu from "./dropdown-menu.svelte";
  import FilterChip, { type FilterChipValue } from "./filter-chip.svelte";
  import Icon from "./icon.svelte";
  import MenuItem from "./menu-item.svelte";
  import SearchInput from "./search-input.svelte";

  interface Props {
    filters: FilterDef[];
    /** What is applied, by key (bindable). */
    value?: FilterValues;
    /** Shows the search field. */
    search?: boolean;
    /** The key of the search text in `value`. */
    searchKey?: string;
    searchPlaceholder?: string;
    /** Accessible name of the search field; the placeholder by default. */
    searchLabel?: string;
    /** Accessible name of the bar. */
    ariaLabel?: string;
    addFilterLabel?: string;
    clearAllLabel?: string;
    /** Language of the date filters' calendar. */
    locale?: string;
    class?: string;
    onchange?: (value: FilterValues) => void;
    /** Your own controls at the end of the row. */
    end?: Snippet;
    /** Any other attribute goes to the root element. */
    [key: string]: unknown;
  }

  const L = useLabels();
  let {
    filters,
    value = $bindable({}),
    search = true,
    searchKey = "q",
    searchPlaceholder = L.search,
    searchLabel,
    ariaLabel = L.filters,
    addFilterLabel = L.addFilter,
    clearAllLabel = L.clearAll,
    locale,
    class: className = "",
    onchange,
    end,
    ...rest
  }: Props = $props();

  const has = (key: string) => value[key] !== undefined && value[key] !== "" && value[key] !== null;

  /** Hidden filters the user took out of the menu. */
  let added = $state<string[]>([]);
  const shown = $derived(filters.filter((f) => !f.hidden || has(f.key) || added.includes(f.key)));
  const available = $derived(filters.filter((f) => !shown.includes(f)));
  const activeCount = $derived(filters.filter((f) => has(f.key)).length);
  const anything = $derived(activeCount > 0 || (search && has(searchKey)));
  const countText = $derived(
    activeCount === 0 ? L.noActiveFilters : activeCount === 1 ? L.activeFilterOne : L.activeFilters.replace("{n}", String(activeCount))
  );

  function set(key: string, next: FilterChipValue | undefined) {
    const copy = { ...value };
    if (next === null || next === undefined || next === "") delete copy[key];
    else copy[key] = next;
    value = copy;
    onchange?.(copy);
  }

  const chips: Record<string, ReturnType<typeof FilterChip> | undefined> = {};

  async function add(key: string) {
    added = [...added, key];
    await tick();
    chips[key]?.openEditor();
  }

  /** Empties the search and every filter (also the "Clear all" button). */
  export function clear() {
    added = [];
    value = {};
    onchange?.({});
  }
</script>

<div {...rest} class={cn("ta-filter-bar", className)} role="search" aria-label={ariaLabel}>
  {#if search}
    <SearchInput
      class="ta-filter-bar-search"
      placeholder={searchPlaceholder}
      ariaLabel={searchLabel}
      value={typeof value[searchKey] === "string" ? (value[searchKey] as string) : ""}
      oninput={(text) => set(searchKey, text)}
    />
  {/if}
  {#each shown as def (def.key)}
    <FilterChip
      bind:this={chips[def.key]}
      label={def.label}
      type={def.type}
      options={def.options}
      placeholder={def.placeholder}
      range={def.range}
      {locale}
      value={has(def.key) ? value[def.key] : null}
      onchange={(next) => set(def.key, next)}
      onremove={() => (added = added.filter((k) => k !== def.key))}
    />
  {/each}
  {#if available.length}
    <DropdownMenu label={addFilterLabel}>
      {#snippet trigger(props)}
        <button {...props} type="button" class="ta-filter-bar-add">
          <Icon name="plus" size={14} />{addFilterLabel}
        </button>
      {/snippet}
      {#each available as def (def.key)}
        <MenuItem onSelect={() => add(def.key)}>{def.label}</MenuItem>
      {/each}
    </DropdownMenu>
  {/if}
  {#if anything}
    <Button variant="ghost" size="sm" class="ta-filter-bar-clear" onclick={clear}>{clearAllLabel}</Button>
  {/if}
  {#if end}<div class="ta-filter-bar-end">{@render end()}</div>{/if}
  <span class="ta-filter-bar-count" role="status" aria-live="polite">{countText}</span>
</div>

<style>
  .ta-filter-bar {
    position: relative;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    min-width: 0;
  }

  .ta-filter-bar :global(.ta-filter-bar-search) { flex: 1 1 14rem; max-width: 22rem; }

  .ta-filter-bar-add {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    min-height: 2.25rem;
    padding: 0 0.75rem;
    font: inherit;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: 1px solid transparent;
    border-radius: 9999px;
    cursor: pointer;
  }
  .ta-filter-bar-add:hover { color: rgb(var(--ta-text)); background: rgb(var(--ta-elevated) / 0.5); }
  .ta-filter-bar-add:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 1px; }

  .ta-filter-bar-end { display: flex; align-items: center; gap: 0.5rem; margin-left: auto; }

  .ta-filter-bar-count {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  /* A phone: the search takes the first row. */
  @media (max-width: 480px) {
    .ta-filter-bar :global(.ta-filter-bar-search) { flex-basis: 100%; max-width: none; }
  }

  @media (pointer: coarse) {
    .ta-filter-bar-add { min-height: 2.75rem; }
  }
</style>

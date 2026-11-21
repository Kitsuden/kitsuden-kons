<!--
  tallao — DataTable
  Data table built on Table: sortable columns, pagination, row selection with
  "select all" (with a partial state), loading and a visible empty row.

  The data can live in the browser (the table sorts and paginates) or in the API
  (`manual`: the table only reports through onSortChange / onPageChange and renders
  `rows` as they are, with `total` for the pages).

    <DataTable rows={contacts} rowKey="id" columns={[
      { key: "name", header: "Name", sortable: true, filter: "text" },
      { key: "team", header: "Team", filter: "select" },
      { key: "score", header: "Points", sortable: true, align: "right", filter: "range" },
    ]} pageSize={20} selectable bind:selected bind:filters>
      {#snippet cell(row, col)}{#if col.key === "name"}<a href={`/c/${row.id}`}>{row.name}</a>{:else}{row[col.key]}{/if}{/snippet}
    </DataTable>

  Accessible sorting: each sortable header is a button inside the <th>, which carries
  aria-sort; click: ascending → descending → unsorted.

  Column filters: a column with `filter` gets a control in a second header row.
  - "text": contains, ignoring case and accents (like Combobox);
  - "select": one of the column's values (or `filterOptions`), with an "All" option;
  - "range": numbers between a minimum and a maximum, both optional;
  - a snippet: your own control, given `{ column, value, set, label }`; it matches with
    `filterFn(row, value)` (without it, a snippet filter does not filter locally).
  The filters combine with AND, and with the sorting; a change from a control goes back
  to page 1. `bind:filters` holds the state ({ [key]: string | { min, max } | anything }),
  so a page can read it or keep it in the URL. With `manual` nothing is filtered here:
  `onFiltersChange` hands the state to whoever asks the API.

  For an admin list:
  - `rowHref`: the first column's cell (or `linkColumn`) is a real link to the record, so the
    row opens with a click, a middle click or Enter, and reads as a link.
  - `rowActions`: a last column that stays in view while the table scrolls sideways (usually
    a "⋯" DropdownMenu). Its background is `--ta-table-sticky-bg` (the page background by
    default: set it when the table sits on a card). `actions` is still the plain last column.
  - `density` ("comfortable" | "compact", bindable) and `visibleColumns` (bindable keys; a
    column with `hideable: false` always shows). `densityToggle` and `columnChooser` add
    their controls to a toolbar above the table: a pressed button (`aria-pressed`) and a menu
    of `menuitemcheckbox`. The `toolbar` snippet puts your own content at its start.
  - `loading` with no rows draws skeleton rows shaped like the columns (`loadingRows`); the
    table is `aria-busy` and "Loading" is announced once.
  - `error` (a message) replaces the rows with an EmptyState `variant="error"`, with Retry
    when `onRetry` is given; the `errorState` snippet draws it yourself.
  - With no rows the body is an EmptyState; the `empty` snippet draws your own (it gets
    `{ filtered, clear }`: whether column filters are applied and how to clear them).
-->
<script lang="ts" module>
  import type { Snippet } from "svelte";

  export interface DataFilterControl<T = Record<string, unknown>> {
    column: DataColumn<T>;
    value: unknown;
    set: (value: unknown) => void;
    /** Accessible name for the control ("Filter Team"). */
    label: string;
  }

  export interface DataRange {
    min?: number | null;
    max?: number | null;
  }

  export type DataFilters = Record<string, unknown>;

  export interface DataColumn<T = Record<string, unknown>> {
    key: string;
    header: string;
    sortable?: boolean;
    align?: "left" | "center" | "right";
    /** CSS width of the column. */
    width?: string;
    /** Value to sort, filter and render by; `row[key]` by default. */
    value?: (row: T) => unknown;
    /** A filter control in the filter row. */
    filter?: "text" | "select" | "range" | Snippet<[DataFilterControl<T>]>;
    /** Options of a "select" filter; by default the distinct values of the column. */
    filterOptions?: (string | { value: string; label: string })[];
    /** Custom match (required for a snippet filter, optional for the others). */
    filterFn?: (row: T, value: unknown) => boolean;
    /** `false`: the column chooser cannot hide it. */
    hideable?: boolean;
  }

  export type DataDensity = "comfortable" | "compact";

  export interface DataSort {
    key: string;
    direction: "asc" | "desc";
  }

  /** Whether a filter value filters anything: "" , null and an empty range do not. */
  export function isActiveFilter(value: unknown): boolean {
    if (value == null || value === "") return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object" && ("min" in value || "max" in value)) {
      const range = value as DataRange;
      return range.min != null || range.max != null;
    }
    return true;
  }
</script>

<script lang="ts" generics="T extends Record<string, any>">
  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  import Button from "./button.svelte";
  import { normalizeText } from "./combobox.svelte";
  import DropdownMenu from "./dropdown-menu.svelte";
  import EmptyState from "./empty-state.svelte";
  import Icon from "./icon.svelte";
  import MenuItem from "./menu-item.svelte";
  import Pagination from "./pagination.svelte";
  import Skeleton from "./skeleton.svelte";
  import Table from "./table.svelte";
  import TableBody from "./table-body.svelte";
  import TableCell from "./table-cell.svelte";
  import TableHead from "./table-head.svelte";
  import TableHeader from "./table-header.svelte";
  import TableRow from "./table-row.svelte";

  const L = useLabels();
  let {
    rows,
    columns,
    rowKey,
    /** Name of the row for its checkbox and screen readers ("Select row: Ana"). */
    rowLabel,
    sort = $bindable(null),
    page = $bindable(1),
    pageSize,
    total,
    manual = false,
    selectable = false,
    selected = $bindable([]),
    loading = false,
    emptyText = L.noResults,
    filters = $bindable({}),
    noMatchesText = L.noMatches,
    /** Accessible name of the table (goes in a hidden <caption>). */
    caption,
    density = $bindable("comfortable"),
    densityToggle = false,
    visibleColumns = $bindable(),
    columnChooser = false,
    rowHref,
    linkColumn,
    loadingRows,
    error,
    onRetry,
    compactLabel = L.compactRows,
    columnsLabel = L.columns,
    class: className = "",
    cell,
    actions,
    rowActions,
    toolbar,
    empty,
    errorState,
    onSortChange,
    onPageChange,
    onSelectionChange,
    onFiltersChange,
    onDensityChange,
    onVisibleColumnsChange,
  }: {
    rows: T[];
    columns: DataColumn<T>[];
    /** Field or function that gives each row's unique key. */
    rowKey: keyof T | ((row: T) => string);
    rowLabel?: (row: T) => string;
    sort?: DataSort | null;
    page?: number;
    /** Rows per page; without it, there is no pagination. */
    pageSize?: number;
    /** With `manual`: how many rows the API has in total. */
    total?: number;
    manual?: boolean;
    selectable?: boolean;
    selected?: string[];
    loading?: boolean;
    emptyText?: string;
    /** Column filter values by column key (bindable). */
    filters?: DataFilters;
    /** Empty row when the filters leave no rows. */
    noMatchesText?: string;
    caption?: string;
    /** Row height (bindable). */
    density?: DataDensity;
    /** Shows the density toggle in the toolbar. */
    densityToggle?: boolean;
    /** Keys of the columns shown (bindable); without it, all of them. */
    visibleColumns?: string[];
    /** Shows the column menu in the toolbar. */
    columnChooser?: boolean;
    /** Where a row leads: its first cell (or `linkColumn`) becomes a link. */
    rowHref?: (row: T) => string | undefined;
    /** Key of the column that carries the row's link; the first one shown by default. */
    linkColumn?: string;
    /** How many skeleton rows `loading` draws (by default the page size, 5 at most). */
    loadingRows?: number;
    /** The load failed: this message replaces the rows. */
    error?: string | null;
    /** Adds "Retry" to the error state. */
    onRetry?: () => void;
    compactLabel?: string;
    columnsLabel?: string;
    class?: string;
    /** Custom cell content; without it, the value as text. */
    cell?: Snippet<[T, DataColumn<T>]>;
    /** Last column with per-row actions. */
    actions?: Snippet<[T]>;
    /** Per-row actions in a last column that stays in view when the table scrolls sideways. */
    rowActions?: Snippet<[T]>;
    /** Your own content at the start of the toolbar. */
    toolbar?: Snippet;
    /** Replaces the default empty state. */
    empty?: Snippet<[{ filtered: boolean; clear: () => void }]>;
    /** Replaces the default error state; gets the message. */
    errorState?: Snippet<[string]>;
    onDensityChange?: (density: DataDensity) => void;
    onVisibleColumnsChange?: (keys: string[]) => void;
    onSortChange?: (sort: DataSort | null) => void;
    onPageChange?: (page: number) => void;
    onSelectionChange?: (selected: string[]) => void;
    /** A filter control changed (the whole state). With `manual`, send it to the API. */
    onFiltersChange?: (filters: DataFilters) => void;
  } = $props();

  const id = $props.id();
  const keyOf = (row: T) => (typeof rowKey === "function" ? rowKey(row) : String(row[rowKey]));
  const valueOf = (row: T, col: DataColumn<T>) => (col.value ? col.value(row) : row[col.key]);

  function compare(a: unknown, b: unknown) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }

  // ——— Column filters ———
  const filterable = $derived(columns.filter((c) => c.filter));
  const anyActive = $derived(filterable.some((c) => isActiveFilter(filters[c.key])));

  function matches(row: T, col: DataColumn<T>, value: unknown): boolean {
    if (col.filterFn) return col.filterFn(row, value);
    const v = valueOf(row, col);
    if (col.filter === "text") return normalizeText(String(v ?? "")).includes(normalizeText(String(value)));
    if (col.filter === "select") return String(v ?? "") === String(value);
    if (col.filter === "range") {
      const { min, max } = value as DataRange;
      const n = typeof v === "number" ? v : Number(v);
      if (v == null || v === "" || Number.isNaN(n)) return false;
      return (min == null || n >= min) && (max == null || n <= max);
    }
    return true;
  }

  const filtered = $derived.by(() => {
    if (manual) return rows;
    const active = filterable.filter((c) => isActiveFilter(filters[c.key]));
    if (active.length === 0) return rows;
    return rows.filter((row) => active.every((c) => matches(row, c, filters[c.key])));
  });

  function setFilter(key: string, value: unknown) {
    const next = { ...filters };
    if (isActiveFilter(value)) next[key] = value;
    else delete next[key];
    filters = next;
    onFiltersChange?.(next);
    if (page !== 1) {
      page = 1;
      onPageChange?.(1);
    }
  }

  /** Empties every column filter (also the "Clear filters" button). */
  export function clearFilters() {
    filters = {};
    onFiltersChange?.({});
    if (page !== 1) {
      page = 1;
      onPageChange?.(1);
    }
  }

  type FilterOption = { value: string; label: string };
  function optionsOf(col: DataColumn<T>): FilterOption[] {
    if (col.filterOptions)
      return col.filterOptions.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
    const seen = new Set<string>();
    for (const row of rows) {
      const v = valueOf(row, col);
      if (v != null && v !== "") seen.add(String(v));
    }
    return [...seen]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
      .map((v) => ({ value: v, label: v }));
  }

  const filterLabel = (col: DataColumn<T>) => L.filterColumn.replace("{column}", col.header);
  const rangeOf = (col: DataColumn<T>) => (filters[col.key] ?? {}) as DataRange;
  const toNumber = (text: string) => (text.trim() === "" || Number.isNaN(Number(text)) ? null : Number(text));

  const sorted = $derived.by(() => {
    if (manual || !sort) return filtered;
    const col = columns.find((c) => c.key === sort!.key);
    if (!col) return filtered;
    const sign = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => sign * compare(valueOf(a, col), valueOf(b, col)));
  });

  const pageCount = $derived(
    pageSize ? Math.max(1, Math.ceil((manual ? (total ?? rows.length) : filtered.length) / pageSize)) : 1
  );
  const visible = $derived(
    !pageSize || manual ? sorted : sorted.slice((page - 1) * pageSize, page * pageSize)
  );

  // If the data shrinks, the page does not stay out of range.
  $effect(() => {
    if (page > pageCount) page = pageCount;
  });

  function toggleSort(col: DataColumn<T>) {
    const next: DataSort | null =
      sort?.key !== col.key
        ? { key: col.key, direction: "asc" }
        : sort.direction === "asc"
          ? { key: col.key, direction: "desc" }
          : null;
    sort = next;
    onSortChange?.(next);
  }

  const ariaSort = (col: DataColumn<T>) =>
    sort?.key === col.key ? (sort.direction === "asc" ? "ascending" : "descending") : "none";

  // Selection: "all" refers to what is visible (the current page).
  const visibleKeys = $derived(visible.map(keyOf));
  const checkedVisible = $derived(visibleKeys.filter((k) => selected.includes(k)).length);
  const allChecked = $derived(visibleKeys.length > 0 && checkedVisible === visibleKeys.length);
  const partial = $derived(checkedVisible > 0 && !allChecked);

  // A row that is deleted fades out; a new page, order or filter swaps the rows at once
  // (fading them would show two pages for a moment). A deletion takes away one or two rows
  // and brings in at most as many (the next ones of the following page).
  let previousKeys: string[] = [];
  let rowsLeaving = false;
  $effect.pre(() => {
    const now = visibleKeys;
    const gone = previousKeys.filter((k) => !now.includes(k)).length;
    const added = now.filter((k) => !previousKeys.includes(k)).length;
    rowsLeaving = gone > 0 && gone <= 2 && added <= gone;
    previousKeys = now;
  });

  function setSelected(next: string[]) {
    selected = next;
    onSelectionChange?.(next);
  }

  function toggleAll() {
    setSelected(allChecked ? selected.filter((k) => !visibleKeys.includes(k)) : [...new Set([...selected, ...visibleKeys])]);
  }

  function toggle(k: string) {
    setSelected(selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k]);
  }

  // ——— Columns shown, density ———
  const shownColumns = $derived(
    visibleColumns ? columns.filter((c) => c.hideable === false || visibleColumns!.includes(c.key)) : columns
  );
  const linkKey = $derived(linkColumn ?? shownColumns[0]?.key);

  function toggleColumn(key: string) {
    const all = columns.map((c) => c.key);
    const current = visibleColumns ?? all;
    const next = current.includes(key) ? current.filter((k) => k !== key) : all.filter((k) => k === key || current.includes(k));
    // A table with no columns is not a table: the last one stays.
    if (!columns.some((c) => c.hideable === false || next.includes(c.key))) return;
    visibleColumns = next;
    onVisibleColumnsChange?.(next);
  }

  function toggleDensity() {
    density = density === "compact" ? "comfortable" : "compact";
    onDensityChange?.(density);
  }

  const SKELETON_WIDTHS = ["70%", "45%", "60%", "35%", "55%"];
  const skeletonRows = $derived(loadingRows ?? Math.min(pageSize ?? 5, 5));

  const totalColumns = $derived(shownColumns.length + (selectable ? 1 : 0) + (actions ? 1 : 0) + (rowActions ? 1 : 0));
  const styleOf = (col: DataColumn<T>) =>
    [col.width ? `width: ${col.width}` : "", col.align ? `text-align: ${col.align}` : ""].filter(Boolean).join("; ") || undefined;
</script>

<div class={cn("ta-datatable", density === "compact" && "ta-datatable--compact", className)} aria-busy={loading || undefined} data-density={density}>
  {#if toolbar || densityToggle || columnChooser}
    <div class="ta-datatable-toolbar">
      <div class="ta-datatable-toolbar-start">{@render toolbar?.()}</div>
      {#if densityToggle || columnChooser}
        <div class="ta-datatable-tools">
          {#if densityToggle}
            <button type="button" class="ta-datatable-tool" aria-pressed={density === "compact"} onclick={toggleDensity}>
              <Icon name="menu" size={14} />{compactLabel}
            </button>
          {/if}
          {#if columnChooser}
            <DropdownMenu label={columnsLabel} placement="bottom-end">
              {#snippet trigger(props)}
                <button {...props} type="button" class="ta-datatable-tool">
                  <Icon name="eye" size={14} />{columnsLabel}<Icon name="chevron-down" size={12} />
                </button>
              {/snippet}
              {#each columns as col (col.key)}
                <MenuItem
                  checked={shownColumns.includes(col)}
                  disabled={col.hideable === false}
                  closeOnSelect={false}
                  onSelect={() => toggleColumn(col.key)}
                >{col.header}</MenuItem>
              {/each}
            </DropdownMenu>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
  <Table>
    {#if caption}<caption class="ta-hidden">{caption}</caption>{/if}
    <TableHeader>
      <TableRow>
        {#if selectable}
          <TableHead class="ta-datatable-check">
            <input
              type="checkbox"
              class="ta-datatable-checkbox"
              aria-label={L.selectAll}
              checked={allChecked}
              disabled={visibleKeys.length === 0}
              {@attach (el: HTMLInputElement) => {
                el.indeterminate = partial;
              }}
              onchange={toggleAll}
            />
          </TableHead>
        {/if}
        {#each shownColumns as col (col.key)}
          <TableHead aria-sort={col.sortable ? ariaSort(col) : undefined} style={styleOf(col)}>
            {#if col.sortable}
              <button type="button" class="ta-datatable-sort" onclick={() => toggleSort(col)}>
                {col.header}
                <span class="ta-datatable-arrow" aria-hidden="true">
                  {sort?.key === col.key ? (sort.direction === "asc" ? "▲" : "▼") : "↕"}
                </span>
              </button>
            {:else}
              {col.header}
            {/if}
          </TableHead>
        {/each}
        {#if actions}<TableHead><span class="ta-hidden">{L.actions}</span></TableHead>{/if}
        {#if rowActions}<TableHead class="ta-datatable-pin"><span class="ta-hidden">{L.actions}</span></TableHead>{/if}
      </TableRow>
      {#if filterable.length}
        <TableRow class="ta-datatable-filters">
          {#if selectable}<TableCell></TableCell>{/if}
          {#each shownColumns as col (col.key)}
            {@const custom = typeof col.filter === "function" ? col.filter : null}
            <TableCell class="ta-datatable-filter">
              {#if custom}
                {@render custom({ column: col, value: filters[col.key], set: (v) => setFilter(col.key, v), label: filterLabel(col) })}
              {:else if col.filter === "text"}
                <input
                  type="search"
                  class="ta-datatable-field"
                  aria-label={filterLabel(col)}
                  value={typeof filters[col.key] === "string" ? (filters[col.key] as string) : ""}
                  oninput={(e) => setFilter(col.key, e.currentTarget.value)}
                />
              {:else if col.filter === "select"}
                <select
                  class="ta-datatable-field"
                  aria-label={filterLabel(col)}
                  value={filters[col.key] == null ? "" : String(filters[col.key])}
                  onchange={(e) => setFilter(col.key, e.currentTarget.value)}
                >
                  <option value="">{L.allValues}</option>
                  {#each optionsOf(col) as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                </select>
              {:else if col.filter === "range"}
                <div class="ta-datatable-range">
                  <input
                    type="number"
                    inputmode="decimal"
                    class="ta-datatable-field"
                    aria-label={`${filterLabel(col)}: ${L.minimum}`}
                    placeholder={L.minimum}
                    value={rangeOf(col).min ?? ""}
                    oninput={(e) => setFilter(col.key, { ...rangeOf(col), min: toNumber(e.currentTarget.value) })}
                  />
                  <input
                    type="number"
                    inputmode="decimal"
                    class="ta-datatable-field"
                    aria-label={`${filterLabel(col)}: ${L.maximum}`}
                    placeholder={L.maximum}
                    value={rangeOf(col).max ?? ""}
                    oninput={(e) => setFilter(col.key, { ...rangeOf(col), max: toNumber(e.currentTarget.value) })}
                  />
                </div>
              {/if}
            </TableCell>
          {/each}
          {#if actions}<TableCell></TableCell>{/if}
          {#if rowActions}<TableCell class="ta-datatable-pin"></TableCell>{/if}
        </TableRow>
      {/if}
    </TableHeader>
    <TableBody>
      {#if error}
        <TableRow class="ta-datatable-state">
          <TableCell colspan={totalColumns}>
            {#if errorState}{@render errorState(error)}{:else}<EmptyState variant="error" size="sm" level={null} description={error} {onRetry} retrying={loading} />{/if}
          </TableCell>
        </TableRow>
      {:else if loading && visible.length === 0}
        {#each Array.from({ length: skeletonRows }) as _, i (i)}
          <TableRow class="ta-datatable-loading">
            {#if selectable}<TableCell class="ta-datatable-check"><Skeleton width="1rem" height="1rem" /></TableCell>{/if}
            {#each shownColumns as col, c (col.key)}
              <TableCell><Skeleton height="0.875rem" width={SKELETON_WIDTHS[(i + c) % SKELETON_WIDTHS.length]} class={col.align === "right" ? "ta-datatable-skeleton-end" : ""} /></TableCell>
            {/each}
            {#if actions}<TableCell></TableCell>{/if}
            {#if rowActions}<TableCell class="ta-datatable-pin"></TableCell>{/if}
          </TableRow>
        {/each}
      {:else}
        {#each visible as row (keyOf(row))}
          {@const k = keyOf(row)}
          <TableRow data-selected={selected.includes(k) || undefined} exit={() => rowsLeaving}>
            {#if selectable}
              <TableCell class="ta-datatable-check">
                <input
                  type="checkbox"
                  class="ta-datatable-checkbox"
                  aria-label={`${L.selectRow}: ${rowLabel ? rowLabel(row) : k}`}
                  checked={selected.includes(k)}
                  onchange={() => toggle(k)}
                />
              </TableCell>
            {/if}
            {#each shownColumns as col (col.key)}
              {@const href = rowHref && col.key === linkKey ? rowHref(row) : undefined}
              <TableCell class={href ? "ta-datatable-linkcell" : ""} style={col.align ? `text-align: ${col.align}` : undefined}>
                {#if href}
                  <a class="ta-datatable-link" {href}>{#if cell}{@render cell(row, col)}{:else}{valueOf(row, col) ?? "—"}{/if}</a>
                {:else if cell}{@render cell(row, col)}{:else}{valueOf(row, col) ?? "—"}{/if}
              </TableCell>
            {/each}
            {#if actions}<TableCell class="ta-datatable-actions">{@render actions(row)}</TableCell>{/if}
            {#if rowActions}<TableCell class="ta-datatable-pin">{@render rowActions(row)}</TableCell>{/if}
          </TableRow>
        {:else}
          <TableRow class="ta-datatable-state">
            <TableCell colspan={totalColumns}>
              {#if empty}
                {@render empty({ filtered: anyActive, clear: clearFilters })}
              {:else}
                <EmptyState variant={anyActive ? "no-results" : "empty"} size="sm" level={null} icon={false} title={anyActive ? noMatchesText : emptyText} />
              {/if}
            </TableCell>
          </TableRow>
        {/each}
      {/if}
    </TableBody>
  </Table>

  {#if (pageSize && pageCount > 1) || anyActive}
    <div class="ta-datatable-footer">
      {#if anyActive}
        <Button variant="ghost" size="sm" class="ta-datatable-clear" onclick={clearFilters}>{L.clearFilters}</Button>
      {/if}
      {#if pageSize && pageCount > 1}
        <Pagination bind:page {pageCount} onchange={(p) => onPageChange?.(p)} ariaLabel={caption ? `${L.pagination}: ${caption}` : undefined} />
      {/if}
    </div>
  {/if}
  <span class="ta-hidden" aria-live="polite" id={`${id}-status`}>{loading ? L.loading : ""}</span>
</div>

<style>
  /* A size container: the state rows below measure the visible width, not the table's. */
  .ta-datatable { container-type: inline-size; display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; }

  .ta-datatable :global(.ta-datatable-check) { width: 2.5rem; }

  .ta-datatable-checkbox {
    width: 1rem;
    height: 1rem;
    margin: 0;
    accent-color: rgb(var(--ta-accent));
    cursor: pointer;
  }
  .ta-datatable-checkbox:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 2px; }

  .ta-datatable-sort {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    /* A 24px target (WCAG 2.5.8) inside the header's own height. */
    min-height: 1.5rem;
    padding: 0;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    color: inherit;
    background: none;
    border: none;
    cursor: pointer;
  }
  .ta-datatable-sort:hover { color: rgb(var(--ta-text)); }
  .ta-datatable-sort:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 2px; border-radius: var(--ta-radius-sm); }

  .ta-datatable-arrow { font-size: 0.625rem; opacity: 0.7; }

  .ta-datatable :global(tr[data-selected]) { background: rgb(var(--ta-accent) / 0.08); }

  .ta-datatable :global(.ta-datatable-actions) { text-align: right; white-space: nowrap; }

  /* A row that appears (a new record, another page) fades in; it is usable at once. */
  .ta-datatable :global(tbody > tr) {
    transition: opacity var(--ta-duration-base, 180ms) ease-out, background-color 0.15s;
    @starting-style {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ta-datatable :global(tbody > tr) { transition: background-color 0.15s; }
  }

  /* The state rows (empty, error, loading) are not data: no hover tint. */
  .ta-datatable :global(.ta-datatable-state:hover),
  .ta-datatable :global(.ta-datatable-loading:hover) { background: none; }
  .ta-datatable :global(.ta-datatable-skeleton-end) { margin-left: auto; }
  /* When the table is wider than its box, the empty and error states stay in view, centred
     in the visible part, instead of being cut at the edge. */
  .ta-datatable :global(.ta-datatable-state > td > *) {
    position: sticky;
    left: 1rem;
    width: calc(100cqw - 2rem - 2px);
    max-width: 100%;
    box-sizing: border-box;
  }

  /* — Toolbar — */
  .ta-datatable-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem 0.75rem; min-width: 0; }
  .ta-datatable-toolbar-start { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; min-width: 0; flex: 1 1 auto; }
  .ta-datatable-tools { display: flex; align-items: center; gap: 0.25rem; margin-left: auto; }
  .ta-datatable-tool {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 2rem;
    padding: 0 0.625rem;
    font: inherit;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: 1px solid transparent;
    border-radius: var(--ta-radius);
    cursor: pointer;
  }
  .ta-datatable-tool:hover { color: rgb(var(--ta-text)); background: rgb(var(--ta-elevated) / 0.5); }
  .ta-datatable-tool:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 1px; }
  /* Pressed: a frame and a tint (the state is also in aria-pressed). */
  .ta-datatable-tool[aria-pressed="true"] {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-accent) / 0.12);
    border-color: rgb(var(--ta-accent) / 0.45);
  }

  /* — Density — */
  .ta-datatable--compact :global(.ta-table-td) { padding-top: 0.3125rem; padding-bottom: 0.3125rem; font-size: 0.8125rem; }
  .ta-datatable--compact :global(.ta-table-th) { padding-top: 0.4375rem; padding-bottom: 0.4375rem; }

  /* — The row's link — */
  /* The column that names the row keeps a readable width when the table is squeezed. */
  .ta-datatable :global(.ta-datatable-linkcell) { min-width: 11rem; }
  .ta-datatable-link {
    position: relative;
    font-weight: 500;
    color: rgb(var(--ta-text));
    text-decoration: none;
    border-radius: var(--ta-radius-sm);
  }
  .ta-datatable-link:hover { text-decoration: underline; text-decoration-color: rgb(var(--ta-accent)); text-underline-offset: 3px; }
  .ta-datatable-link:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 2px; }

  /* — Pinned actions column: stays at the right edge while the table scrolls sideways.
     The cell is opaque, so the header, hover and selection tints are repeated on it. — */
  .ta-datatable :global(.ta-datatable-pin) {
    position: sticky;
    right: 0;
    z-index: 1;
    width: 1%;
    padding-left: 0.5rem;
    padding-right: 0.5rem;
    text-align: right;
    white-space: nowrap;
    background: var(--ta-table-sticky-bg, rgb(var(--ta-bg)));
    box-shadow: inset 1px 0 0 rgb(var(--ta-border));
  }
  .ta-datatable :global(thead .ta-datatable-pin) {
    background:
      linear-gradient(rgb(var(--ta-elevated) / 0.4), rgb(var(--ta-elevated) / 0.4)),
      var(--ta-table-sticky-bg, rgb(var(--ta-bg)));
  }
  .ta-datatable :global(tbody tr:hover > .ta-datatable-pin) {
    background:
      linear-gradient(rgb(var(--ta-elevated) / 0.35), rgb(var(--ta-elevated) / 0.35)),
      var(--ta-table-sticky-bg, rgb(var(--ta-bg)));
  }
  .ta-datatable :global(tbody tr[data-selected] > .ta-datatable-pin) {
    background:
      linear-gradient(rgb(var(--ta-accent) / 0.08), rgb(var(--ta-accent) / 0.08)),
      var(--ta-table-sticky-bg, rgb(var(--ta-bg)));
  }

  .ta-datatable-footer { display: flex; align-items: center; justify-content: flex-end; gap: 0.75rem; flex-wrap: wrap; }
  .ta-datatable-footer :global(.ta-datatable-clear) { margin-right: auto; }

  /* Filter row: the controls sit under their headers, on the header background. */
  .ta-datatable :global(.ta-datatable-filters td) {
    padding-top: 0.25rem;
    padding-bottom: 0.5rem;
    background: rgb(var(--ta-surface));
    vertical-align: top;
  }
  .ta-datatable-range { display: flex; gap: 0.25rem; }
  .ta-datatable-field {
    width: 100%;
    min-width: 4rem;
    padding: 0.25rem 0.5rem;
    font: inherit;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-bg));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-sm);
    outline: none;
  }
  .ta-datatable-field::placeholder { color: rgb(var(--ta-text-dim)); }
  .ta-datatable-field:focus {
    border-color: rgb(var(--ta-accent) / 0.5);
    box-shadow: 0 0 0 2px rgb(var(--ta-accent) / 0.15);
  }

  @media (pointer: coarse) {
    .ta-datatable-field { font-size: 1rem; min-height: 2.75rem; }
    .ta-datatable-tool { min-height: 2.75rem; }
    /* The link's hit area grows to 44px without changing the row height. */
    .ta-datatable-link::after { content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 2.75rem; transform: translateY(-50%); }
  }

  .ta-hidden {
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
</style>

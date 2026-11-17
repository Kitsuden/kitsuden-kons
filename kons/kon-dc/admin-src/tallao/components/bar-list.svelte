<!--
  tallao — BarList
  A ranking: the "top 10" block of a dashboard. One row per item with its label, a bar
  whose length is its share of the largest value (or of `max`), and the value in text at
  the right. An ordered list when `ranked` (the position is printed and announced), a
  plain list otherwise; named by `title`.
  - The bar is decoration behind the label: the value is always text.
  - An item with `href` is a link; its row is 44px tall on touch screens.
  - `limit` keeps the first n rows; with no rows it shows a labelled empty state.
  - Rows come in the order given: sort the data before passing it. Same HTML on the server.
  `data` is plain JSON: `[{ "label": "Kaela", "value": 18.4, "note": "Fire · DPS" }, …]`
  (optional per item: `"href"`, `"note"`, and `"color"`, any CSS colour for its bar).
-->
<script lang="ts" module>
  export interface BarListItem {
    label: string;
    value: number;
    /** Makes the label a link. */
    href?: string;
    /** A short second line under the label. */
    note?: string;
    /** Any CSS colour for this row's bar. */
    color?: string;
  }
</script>

<script lang="ts">
  import { useLabels } from "$lib/i18n";
  import { compactNumber, finite } from "$lib/internal/chart";
  import { cn } from "$lib/utils";

  const L = useLabels();

  interface Props {
    data: BarListItem[];
    /** What is ranked: the visible heading and the list's accessible name. */
    title?: string;
    /** Accessible name when there is no visible `title`. */
    ariaLabel?: string;
    /** Numbers the rows (1, 2, 3…) in an ordered list. */
    ranked?: boolean;
    /** Value of a full bar; by default the largest value. */
    max?: number;
    /** Rows shown. */
    limit?: number;
    /** Any CSS colour for the bars; by default the first series colour. */
    color?: string;
    locale?: string;
    /** Format of the values. */
    format?: (n: number) => string;
    /** Text shown when `data` is empty. */
    emptyText?: string;
    class?: string;
    /** Any other attribute goes to the root element. */
    [key: string]: unknown;
  }

  const {
    data,
    title,
    ariaLabel,
    ranked = false,
    max,
    limit,
    color,
    locale,
    format = (n: number) => compactNumber(n, locale),
    emptyText = L.noData,
    class: className = "",
    ...rest
  }: Props = $props();

  const id = $props.id();
  const rows = $derived(limit != null ? data.slice(0, Math.max(0, limit)) : data);
  const top = $derived(max ?? Math.max(0, ...rows.map((r) => finite(r.value) ?? 0)));
  const widthOf = (v: number) => (top > 0 ? Math.min(100, Math.max(0, ((finite(v) ?? 0) / top) * 100)) : 0);
</script>

<div {...rest} class={cn("ta-barlist", className)} style:--ta-barlist-color={color}>
  {#if title}<p class="ta-barlist-title" id={`${id}-title`}>{title}</p>{/if}
  {#if rows.length === 0}
    <p class="ta-barlist-empty">{emptyText}</p>
  {:else}
    <svelte:element this={ranked ? "ol" : "ul"} class="ta-barlist-rows" aria-labelledby={title ? `${id}-title` : undefined} aria-label={title ? undefined : ariaLabel}>
      {#each rows as row, i (i)}
        <li class="ta-barlist-row">
          <div class="ta-barlist-main">
            <span class="ta-barlist-fill" style:width={`${widthOf(row.value)}%`} style:background={row.color} aria-hidden="true"></span>
            {#if ranked}<span class="ta-barlist-rank" aria-hidden="true">{i + 1}</span>{/if}
            <span class="ta-barlist-text">
              {#if row.href}<a class="ta-barlist-link" href={row.href}>{row.label}</a>{:else}<span class="ta-barlist-label">{row.label}</span>{/if}
              {#if row.note}<span class="ta-barlist-note">{row.note}</span>{/if}
            </span>
          </div>
          <span class="ta-barlist-value">{finite(row.value) == null ? "—" : format(row.value)}</span>
        </li>
      {/each}
    </svelte:element>
  {/if}
</div>

<style>
  .ta-barlist { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; color: rgb(var(--ta-text)); }
  .ta-barlist-title { margin: 0; font-size: 0.875rem; font-weight: 600; }
  .ta-barlist-empty { margin: 0; padding: 1.5rem 1rem; text-align: center; font-size: 0.8125rem; color: rgb(var(--ta-text-dim)); border: 1px dashed rgb(var(--ta-border)); border-radius: var(--ta-radius); }

  .ta-barlist-rows { display: flex; flex-direction: column; gap: 0.25rem; margin: 0; padding: 0; list-style: none; }
  .ta-barlist-row { display: flex; align-items: center; gap: 0.75rem; min-width: 0; font-size: 0.8125rem; }
  .ta-barlist-main { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.5rem; min-height: 2rem; padding: 0.25rem 0.5rem; border-radius: var(--ta-radius-sm); }
  .ta-barlist-fill { position: absolute; inset: 0 auto 0 0; min-width: 2px; border-radius: var(--ta-radius-sm); background: var(--ta-barlist-color, rgb(var(--ta-series-1))); opacity: 0.28; }
  .ta-barlist-rank { position: relative; flex-shrink: 0; min-width: 1.125rem; font-size: 0.75rem; font-variant-numeric: tabular-nums; color: rgb(var(--ta-text-dim)); }
  .ta-barlist-text { position: relative; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
  .ta-barlist-label,
  .ta-barlist-link { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: inherit; }
  .ta-barlist-link { text-decoration: underline; text-decoration-color: rgb(var(--ta-muted)); text-underline-offset: 2px; }
  .ta-barlist-link:hover { text-decoration-color: currentColor; }
  .ta-barlist-link:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 2px; border-radius: 2px; }
  .ta-barlist-note { font-size: 0.6875rem; color: rgb(var(--ta-text-dim)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ta-barlist-value { flex-shrink: 0; min-width: 2.5rem; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }

  @media (pointer: coarse) {
    .ta-barlist-main { min-height: 2.75rem; }
    /* The link's hit area is the whole row. */
    .ta-barlist-link::after { content: ""; position: absolute; inset: -0.5rem; min-height: 2.75rem; }
  }
</style>

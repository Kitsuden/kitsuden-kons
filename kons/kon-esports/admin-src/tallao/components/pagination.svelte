<!--
  tallao — Pagination
  Navigation between pages: Previous, numbers (with "…" when there are many) and
  Next, inside a named <nav>. The current page has
  aria-current="page". `page` starts at 1. Pass `pageCount`, or `total` and `pageSize`.
-->
<script lang="ts">
  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  const L = useLabels();
  let {
    page = $bindable(1),
    pageCount,
    total,
    pageSize = 20,
    /** Pages shown on each side of the current one. */
    siblings = 1,
    ariaLabel = L.pagination,
    previousLabel = L.previous,
    nextLabel = L.next,
    pageLabel = (n: number) => `${L.page} ${n}`,
    class: className = "",
    onchange,
  }: {
    page?: number;
    pageCount?: number;
    total?: number;
    pageSize?: number;
    siblings?: number;
    ariaLabel?: string;
    previousLabel?: string;
    nextLabel?: string;
    pageLabel?: (n: number) => string;
    class?: string;
    onchange?: (page: number) => void;
  } = $props();

  const pages = $derived(Math.max(1, pageCount ?? Math.ceil((total ?? 0) / Math.max(1, pageSize))));

  /** 1 … 4 5 [6] 7 8 … 20: always the ends, the current one with its neighbors, and gaps. */
  const range = $derived.by(() => {
    const n = pages;
    const from = Math.max(2, page - siblings);
    const to = Math.min(n - 1, page + siblings);
    const res: (number | "…")[] = [1];
    if (from > 2) res.push("…");
    for (let i = from; i <= to; i++) res.push(i);
    if (to < n - 1) res.push("…");
    if (n > 1) res.push(n);
    return res;
  });

  function goTo(n: number) {
    const target = Math.min(pages, Math.max(1, n));
    if (target === page) return;
    page = target;
    onchange?.(target);
  }
</script>

<nav class={cn("ta-pagination", className)} aria-label={ariaLabel}>
  <ul>
    <li>
      <button type="button" class="ta-pagination-button" disabled={page <= 1} onclick={() => goTo(page - 1)}>
        <span aria-hidden="true">‹</span> {previousLabel}
      </button>
    </li>
    {#each range as t, i (`${t}-${i}`)}
      <li>
        {#if t === "…"}
          <span class="ta-pagination-gap" aria-hidden="true">…</span>
        {:else}
          <button
            type="button"
            class="ta-pagination-button ta-pagination-number"
            aria-label={pageLabel(t)}
            aria-current={t === page ? "page" : undefined}
            onclick={() => goTo(t)}>{t}</button
          >
        {/if}
      </li>
    {/each}
    <li>
      <button type="button" class="ta-pagination-button" disabled={page >= pages} onclick={() => goTo(page + 1)}>
        {nextLabel} <span aria-hidden="true">›</span>
      </button>
    </li>
  </ul>
</nav>

<style>
  .ta-pagination ul {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ta-pagination-button {
    min-width: 2rem;
    padding: 0.3rem 0.6rem;
    font: inherit;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text));
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--ta-radius);
    cursor: pointer;
  }
  .ta-pagination-button:hover:not(:disabled) { background: rgb(var(--ta-elevated)); }
  .ta-pagination-button:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 1px; }
  .ta-pagination-button:disabled { opacity: 0.45; cursor: not-allowed; }

  .ta-pagination-number[aria-current="page"] {
    color: rgb(var(--ta-on-accent));
    background: var(--ta-accent-fill, color-mix(in srgb, rgb(var(--ta-accent)) 88%, black));
    border-color: var(--ta-accent-fill, color-mix(in srgb, rgb(var(--ta-accent)) 88%, black));
  }

  .ta-pagination-gap {
    padding: 0 0.25rem;
    color: rgb(var(--ta-text-dim));
  }

  /* On touch screens: 44 × 44px buttons, per WCAG 2.5.5. */
  @media (pointer: coarse) {
    .ta-pagination-button { min-height: 2.75rem; min-width: 2.75rem; }
  }
</style>

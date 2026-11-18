<!--
  tallao — DashboardGrid
  The layout of a dashboard: a responsive grid for KpiCard, ChartCard and anything else.
  `columns` (4 by default) is the number of tracks on a wide container; each child takes
  one unless it asks for more with `span` (a prop of KpiCard, ChartCard and DashboardItem,
  which wraps any other content). `span="full"` takes the whole row.
  It answers to the width of its own container, not of the window, so it also works in a
  sidebar or an island: under 56rem it has two columns (a span of 2 or more takes the
  row), under 34rem one. Layout only: no roles, no JavaScript, same HTML on the server.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  import { cn } from "$lib/utils";

  interface Props {
    /** Tracks on a wide container. */
    columns?: 2 | 3 | 4 | 6;
    /** Space between items (any CSS length). */
    gap?: string;
    class?: string;
    children?: Snippet;
    /** Any other attribute goes to the root element. */
    [key: string]: unknown;
  }

  const { columns = 4, gap = "1rem", class: className = "", children, ...rest }: Props = $props();
</script>

<div {...rest} class={cn("ta-dash", className)}>
  <div class="ta-dash-grid" style:--ta-dash-columns={columns} style:gap>
    {@render children?.()}
  </div>
</div>

<style>
  .ta-dash { container-type: inline-size; min-width: 0; }
  .ta-dash-grid { display: grid; grid-template-columns: repeat(var(--ta-dash-columns, 4), minmax(0, 1fr)); align-items: stretch; }

  .ta-dash-grid > :global(*) { min-width: 0; }
  .ta-dash-grid > :global([data-ta-span="2"]) { grid-column: span 2; }
  .ta-dash-grid > :global([data-ta-span="3"]) { grid-column: span 3; }
  .ta-dash-grid > :global([data-ta-span="4"]) { grid-column: span 4; }
  .ta-dash-grid > :global([data-ta-span="full"]) { grid-column: 1 / -1; }

  @container (max-width: 56rem) {
    .ta-dash-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .ta-dash-grid > :global([data-ta-span="2"]),
    .ta-dash-grid > :global([data-ta-span="3"]),
    .ta-dash-grid > :global([data-ta-span="4"]) { grid-column: 1 / -1; }
  }
  @container (max-width: 34rem) {
    .ta-dash-grid { grid-template-columns: minmax(0, 1fr); }
    .ta-dash-grid > :global([data-ta-span]) { grid-column: 1 / -1; }
  }
</style>

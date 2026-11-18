<!--
  tallao — ChartCard
  The frame of a chart or any other block of a dashboard: a title, a one-line description
  of what to read in it, a `toolbar` snippet for its controls (a period toggle, a filter),
  the content, and a footer with a note and the source of the data.
  - A `<section>` named by its title (a heading of `level`, 3 by default).
  - Charts inside take `hideTitle`, so the title is shown once and still names the figure.
  - `source` prints "Source: …" (a link with `sourceHref`, 44px tall on touch screens);
    the `footer` snippet replaces note and source.
  - `span` is the number of columns it takes inside a DashboardGrid.
  - Same HTML on the server.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  const L = useLabels();

  interface Props {
    title: string;
    /** One line under the title: what the chart says or how to read it. */
    description?: string;
    /** Heading level of the title. */
    level?: 2 | 3 | 4 | 5 | 6;
    /** A caveat or the date of the data, in the footer. */
    note?: string;
    /** Where the data comes from, in the footer after "Source:". */
    source?: string;
    sourceHref?: string;
    /** "Source". */
    sourceLabel?: string;
    /** Columns it takes inside a DashboardGrid (`"full"`: the whole row). */
    span?: 1 | 2 | 3 | 4 | "full";
    /** Controls at the right of the header. */
    toolbar?: Snippet;
    /** Replaces the footer's note and source. */
    footer?: Snippet;
    class?: string;
    children?: Snippet;
    /** Any other attribute goes to the `<section>`. */
    [key: string]: unknown;
  }

  const {
    title,
    description,
    level = 3,
    note,
    source,
    sourceHref,
    sourceLabel = L.source,
    span,
    toolbar,
    footer,
    class: className = "",
    children,
    ...rest
  }: Props = $props();

  const id = $props.id();
</script>

<section {...rest} class={cn("ta-chart-card", className)} aria-labelledby={`${id}-title`} data-ta-span={span}>
  <header class="ta-chart-card-header">
    <div class="ta-chart-card-heading">
      <svelte:element this={`h${level}`} class="ta-chart-card-title" id={`${id}-title`}>{title}</svelte:element>
      {#if description}<p class="ta-chart-card-description">{description}</p>{/if}
    </div>
    {#if toolbar}<div class="ta-chart-card-toolbar">{@render toolbar()}</div>{/if}
  </header>
  <div class="ta-chart-card-body">{@render children?.()}</div>
  {#if footer}
    <footer class="ta-chart-card-footer">{@render footer()}</footer>
  {:else if note || source}
    <footer class="ta-chart-card-footer">
      {#if note}<span>{note}</span>{/if}
      {#if source}
        <span>
          {sourceLabel}:
          {#if sourceHref}<a class="ta-chart-card-source" href={sourceHref}>{source}</a>{:else}{source}{/if}
        </span>
      {/if}
    </footer>
  {/if}
</section>

<style>
  .ta-chart-card {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    min-width: 0;
    padding: 1rem 1.125rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-surface) / 0.5);
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
    /* What sticks inside (a Heatmap's row headers) takes the card's own background. */
    --ta-heatmap-sticky-bg: color-mix(in srgb, rgb(var(--ta-surface)) 50%, rgb(var(--ta-bg)));
  }

  .ta-chart-card-header { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 0.5rem 1rem; }
  .ta-chart-card-heading { flex: 1 1 12rem; min-width: 0; }
  .ta-chart-card-title { margin: 0; font-size: 0.9375rem; font-weight: 600; line-height: 1.3; }
  .ta-chart-card-description { margin: 0.125rem 0 0; font-size: 0.8125rem; color: rgb(var(--ta-text-dim)); }
  .ta-chart-card-toolbar { flex: 0 0 auto; max-width: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; white-space: nowrap; }

  .ta-chart-card-body { flex: 1; min-width: 0; }

  .ta-chart-card-footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.25rem 1rem;
    padding-top: 0.625rem;
    font-size: 0.6875rem;
    color: rgb(var(--ta-text-dim));
    border-top: 1px solid rgb(var(--ta-border));
  }
  .ta-chart-card-source { position: relative; color: inherit; text-decoration: underline; text-underline-offset: 2px; }
  .ta-chart-card-source:hover { color: rgb(var(--ta-text)); }
  .ta-chart-card-source:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 2px; border-radius: 2px; }

  @media (max-width: 480px) {
    .ta-chart-card { padding: 0.875rem; }
  }
  @media (pointer: coarse) {
    .ta-chart-card-source::after { content: ""; position: absolute; top: 50%; left: 50%; width: max(100%, 2.75rem); height: 2.75rem; transform: translate(-50%, -50%); }
  }
</style>

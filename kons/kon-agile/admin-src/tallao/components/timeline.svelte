<!--
  tallao — Timeline
  Dated events in order (patches, tournaments, a season's milestones): an ordered list
  with a rail of dots, each event with its date in a `<time>`, a title, an optional
  description and an optional tag. `tone` colours an event's dot and `current` makes it
  larger with a ring and marks it `aria-current="step"`: neither is conveyed by colour
  alone, since the tag and the title are text.
  - A `date` written as `YYYY-MM-DD` is formatted for `locale` (in UTC, so the server and
    the browser agree); any other text is shown as is.
  - An event with `href` has a linked title (44px tall on touch screens).
  - Events come in the order given. Same HTML on the server; with none, an empty state.
  `items` is plain JSON: `[{ "date": "2026-11-03", "title": "Patch 1.2", "description":
  "Fire rebalance", "tag": "Patch", "tone": "accent" }, …]`.
-->
<script lang="ts" module>
  export interface TimelineItem {
    /** `YYYY-MM-DD` (formatted for the locale) or any text ("Season 3"). */
    date: string;
    title: string;
    description?: string;
    /** A short label next to the date ("Patch", "Tournament"). */
    tag?: string;
    /** Colour of the dot. */
    tone?: "default" | "accent" | "success" | "warning" | "error";
    /** Makes the title a link. */
    href?: string;
    /** The event happening now: a larger dot and `aria-current="step"`. */
    current?: boolean;
  }
</script>

<script lang="ts">
  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  const L = useLabels();

  interface Props {
    items: TimelineItem[];
    /** Accessible name of the list. */
    ariaLabel?: string;
    locale?: string;
    /** How ISO dates are written (by default `{ dateStyle: "medium" }`). */
    dateFormat?: Intl.DateTimeFormatOptions;
    /** Text shown when `items` is empty. */
    emptyText?: string;
    class?: string;
    /** Any other attribute goes to the root element. */
    [key: string]: unknown;
  }

  const { items, ariaLabel, locale, dateFormat = { dateStyle: "medium" }, emptyText = L.noData, class: className = "", ...rest }: Props = $props();

  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const formatter = $derived(new Intl.DateTimeFormat(locale, { ...dateFormat, timeZone: "UTC" }));
  const dateText = (date: string) => {
    if (!ISO.test(date)) return date;
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? date : formatter.format(parsed);
  };
</script>

{#if items.length === 0}
  <p {...rest} class={cn("ta-timeline-empty", className)}>{emptyText}</p>
{:else}
  <ol {...rest} class={cn("ta-timeline", className)} aria-label={ariaLabel}>
    {#each items as item, i (i)}
      <li class={cn("ta-timeline-item", `ta-timeline-item--${item.tone ?? "default"}`, item.current && "ta-timeline-item--current")} aria-current={item.current ? "step" : undefined}>
        <span class="ta-timeline-dot" aria-hidden="true"></span>
        <div class="ta-timeline-body">
          <p class="ta-timeline-meta">
            <time datetime={ISO.test(item.date) ? item.date : undefined}>{dateText(item.date)}</time>
            {#if item.tag}<span class="ta-timeline-tag">{item.tag}</span>{/if}
          </p>
          <p class="ta-timeline-title">
            {#if item.href}<a class="ta-timeline-link" href={item.href}>{item.title}</a>{:else}{item.title}{/if}
          </p>
          {#if item.description}<p class="ta-timeline-text">{item.description}</p>{/if}
        </div>
      </li>
    {/each}
  </ol>
{/if}

<style>
  .ta-timeline { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; color: rgb(var(--ta-text)); }
  .ta-timeline-empty { margin: 0; padding: 1.5rem 1rem; text-align: center; font-size: 0.8125rem; color: rgb(var(--ta-text-dim)); border: 1px dashed rgb(var(--ta-border)); border-radius: var(--ta-radius); }

  .ta-timeline-item { position: relative; display: flex; gap: 0.75rem; padding-bottom: 1.125rem; min-width: 0; --ta-timeline-color: rgb(var(--ta-subtle)); }
  .ta-timeline-item:last-child { padding-bottom: 0; }
  .ta-timeline-item--accent { --ta-timeline-color: rgb(var(--ta-accent)); }
  .ta-timeline-item--success { --ta-timeline-color: rgb(var(--ta-success)); }
  .ta-timeline-item--warning { --ta-timeline-color: rgb(var(--ta-warning)); }
  .ta-timeline-item--error { --ta-timeline-color: rgb(var(--ta-danger)); }

  /* The rail: a line from each dot down to the next one. */
  .ta-timeline-item::before { content: ""; position: absolute; top: 1rem; bottom: -0.25rem; left: 0.4375rem; width: 1px; background: rgb(var(--ta-border)); }
  .ta-timeline-item:last-child::before { display: none; }
  .ta-timeline-dot { position: relative; flex-shrink: 0; width: 0.625rem; height: 0.625rem; margin: 0.3125rem 0.15625rem 0; border-radius: 9999px; background: var(--ta-timeline-color); }
  .ta-timeline-item--current .ta-timeline-dot { box-shadow: 0 0 0 3px rgb(var(--ta-bg)), 0 0 0 5px var(--ta-timeline-color); }

  .ta-timeline-body { min-width: 0; display: flex; flex-direction: column; gap: 0.125rem; }
  .ta-timeline-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin: 0; font-size: 0.75rem; color: rgb(var(--ta-text-dim)); font-variant-numeric: tabular-nums; }
  .ta-timeline-tag { padding: 0 0.375rem; font-size: 0.6875rem; font-weight: 500; color: rgb(var(--ta-text)); border: 1px solid rgb(var(--ta-border)); border-radius: 9999px; }
  .ta-timeline-title { margin: 0; font-size: 0.875rem; font-weight: 600; overflow-wrap: anywhere; }
  .ta-timeline-link { position: relative; color: inherit; text-decoration: underline; text-decoration-color: rgb(var(--ta-muted)); text-underline-offset: 2px; }
  .ta-timeline-link:hover { text-decoration-color: currentColor; }
  .ta-timeline-link:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 2px; border-radius: 2px; }
  .ta-timeline-text { margin: 0; font-size: 0.8125rem; color: rgb(var(--ta-text-dim)); }

  @media (pointer: coarse) {
    .ta-timeline-link::after { content: ""; position: absolute; top: 50%; left: 0; width: 100%; min-width: 2.75rem; height: 2.75rem; transform: translateY(-50%); }
  }
</style>

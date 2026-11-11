<!--
  tallao — Tabs
  Accessible tabs (tablist/tab/tabpanel) with arrows, Home and End.
  The parent renders the content: `children` receives the active tab's id.

  `panels={false}` renders only the tablist and the page places the content anywhere,
  following `bind:value`. Each item can then name its panel with `controls` (the id of the
  page's element, which gets `role="tabpanel"`); a tab without one has no `aria-controls`
  rather than a dangling one. `tabId` sets the tab's own id, for the panel's `aria-labelledby`.

    <Tabs items={[{ id: "a", label: "One", controls: "panel-a", tabId: "tab-a" }]} panels={false} bind:value />
    <section id="panel-a" role="tabpanel" aria-labelledby="tab-a" hidden={value !== "a"}>…</section>
-->
<script lang="ts" module>
  export interface TabItem {
    id: string;
    label: string;
    /** Counter next to the label (e.g. pending items). */
    count?: number;
    /** With `panels={false}`: the id of the page's panel for this tab (`aria-controls`). */
    controls?: string;
    /** The tab's own id, instead of the generated one (to label a panel the page renders). */
    tabId?: string;
  }
</script>

<script lang="ts">
  import { tabIndicator } from "$lib/motion";
  import { cn } from "$lib/utils";

  let {
    items,
    value = $bindable(items[0]?.id ?? ""),
    ariaLabel,
    variant = "underline",
    tabClass = "",
    wrap = false,
    panels = true,
    class: className = "",
    onchange,
    children,
    tab,
    end,
  }: {
    items: TabItem[];
    value?: string;
    ariaLabel?: string;
    /** `pills`: tabs as rounded buttons inside a frame. */
    variant?: "underline" | "pills";
    /** Classes for each tab (touch height on mobile, for example). */
    tabClass?: string;
    /** Tabs wrap onto several lines when they do not fit, instead of scrolling sideways. */
    wrap?: boolean;
    /** `false`: only the tablist; the page renders the panels (see `controls`). */
    panels?: boolean;
    /** Custom content for each tab (two lines, icon…); by default, label + count. */
    tab?: import("svelte").Snippet<[TabItem, boolean]>;
    /** Controls on the same row as the tabs, on the right (outside the tablist). */
    end?: import("svelte").Snippet;
    class?: string;
    onchange?: (id: string) => void;
    children?: import("svelte").Snippet<[string]>;
  } = $props();

  // Ids that are unique and identical on server and browser ($props.id): with Math.random
  // the SSR HTML did not match the hydrated one.
  const uid = $props.id();
  const prefix = `ta-tabs-${uid}`;
  let list: HTMLElement | undefined = $state();
  const tabIdOf = (t: TabItem) => t.tabId || `${prefix}-${t.id}`;
  const activeTabId = $derived(tabIdOf(items.find((t) => t.id === value) ?? { id: value, label: "" }));

  function select(id: string, focus = false) {
    if (id !== value) {
      value = id;
      onchange?.(id);
    }
    if (focus) list?.querySelector<HTMLElement>(`[data-tab="${id}"]`)?.focus();
  }

  function onKey(e: KeyboardEvent) {
    const i = items.findIndex((t) => t.id === value);
    const target =
      e.key === "ArrowRight" ? (i + 1) % items.length
      : e.key === "ArrowLeft" ? (i - 1 + items.length) % items.length
      : e.key === "Home" ? 0
      : e.key === "End" ? items.length - 1
      : -1;
    if (target < 0) return;
    e.preventDefault();
    select(items[target].id, true);
  }

  // The sliding underline needs the browser to measure the tabs: it starts after mount.
  let mounted = $state(false);
  $effect(() => {
    mounted = true;
  });
  const sliding = $derived(mounted && variant === "underline" && !wrap);
</script>

<div class={cn("ta-tabs", variant === "pills" && "ta-tabs--pills", wrap && "ta-tabs--wrap", sliding && "ta-tabs--sliding", className)}>
  <div class="ta-tabs-row">
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div class="ta-tabs-list" role="tablist" aria-label={ariaLabel} bind:this={list} onkeydown={onKey}>
    {#each items as t (t.id)}
      <button
        type="button"
        role="tab"
        id={tabIdOf(t)}
        data-tab={t.id}
        aria-selected={t.id === value}
        aria-controls={panels ? `${prefix}-panel` : t.controls || undefined}
        tabindex={t.id === value ? 0 : -1}
        class={cn("ta-tab", tabClass)}
        onclick={() => select(t.id)}
      >
        {#if tab}{@render tab(t, t.id === value)}{:else}
          {t.label}
          {#if t.count !== undefined}
            <span class="ta-tab-count">{t.count}</span>
          {/if}
        {/if}
      </button>
    {/each}
    {#if sliding}<span class="ta-tabs-indicator" role="presentation" {@attach tabIndicator(() => '[aria-selected="true"]', () => [value, items.length])}></span>{/if}
  </div>
  {#if end}<div class="ta-tabs-end">{@render end()}</div>{/if}
  </div>
  {#if panels}
    <div
      class="ta-tabs-panel"
      role="tabpanel"
      id={`${prefix}-panel`}
      aria-labelledby={activeTabId}
      tabindex="-1"
    >
      {@render children?.(value)}
    </div>
  {/if}
</div>

<style>
  .ta-tabs-row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .ta-tabs-row > .ta-tabs-list { flex: 1 1 auto; min-width: 0; }
  .ta-tabs--wrap .ta-tabs-list { flex-wrap: wrap; overflow-x: visible; }
  .ta-tabs-end { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }

  /* "pills" variant: rounded buttons in a frame, no baseline. */
  .ta-tabs--pills .ta-tabs-list {
    flex: 0 1 auto;
    width: fit-content;
    max-width: 100%;
    padding: 0.125rem;
    box-shadow: none;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
  }
  .ta-tabs--pills .ta-tab {
    padding: 0.375rem 0.75rem;
    border-bottom: none;
    border-radius: calc(var(--ta-radius) - 2px);
  }
  .ta-tabs--pills .ta-tab[aria-selected="true"] {
    color: rgb(var(--ta-on-accent));
    background: var(--ta-accent-fill, color-mix(in srgb, rgb(var(--ta-accent)) 88%, black));
  }

  .ta-tabs-list {
    display: flex;
    gap: 0.25rem;
    overflow-x: auto;
    overflow-y: hidden;
    /* Baseline as an inset shadow rather than a border: that way the active tab's
       underline covers it without a negative margin, which produced a vertical bar. */
    box-shadow: inset 0 -1px 0 rgb(var(--ta-border));
  }

  .ta-tab {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.55rem 0.85rem;
    font-family: inherit;
    font-size: 0.875rem;
    font-weight: 500;
    white-space: nowrap;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  /* After hydration the underline is one bar that slides between the tabs (`tabIndicator`);
     on the server, and where it cannot slide (pills, wrapped rows), each tab draws its own. */
  .ta-tabs-list { position: relative; }
  .ta-tabs-indicator {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    opacity: 0;
    background: rgb(var(--ta-accent));
    border-radius: 1px;
    pointer-events: none;
  }
  .ta-tabs--sliding .ta-tab[aria-selected="true"] { border-bottom-color: transparent; }

  .ta-tab:hover {
    color: rgb(var(--ta-text));
  }

  .ta-tab[aria-selected="true"] {
    color: rgb(var(--ta-text));
    border-bottom-color: rgb(var(--ta-accent));
  }

  .ta-tab:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px rgb(var(--ta-accent) / 0.6);
    border-radius: var(--ta-radius-sm);
  }

  .ta-tab-count {
    min-width: 1.25rem;
    padding: 0 0.35rem;
    font-size: 0.6875rem;
    line-height: 1.25rem;
    text-align: center;
    border-radius: 9999px;
    background: rgb(var(--ta-accent) / 0.15);
    color: rgb(var(--ta-accent-hover));
  }

  .ta-tabs-panel {
    padding-top: 1rem;
    outline: none;
  }

  /* On touch screens: 16px so iOS does not zoom the page on focus, and 44px of height for the finger. */
  @media (pointer: coarse) {
    .ta-tab { min-height: 2.75rem; }
  }
</style>

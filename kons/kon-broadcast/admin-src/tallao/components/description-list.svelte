<!--
  tallao — DescriptionList
  Label / value pairs of a record (its "About" panel: created, updated, by whom, the API
  path): a real `<dl>`, each pair in a `<div>` with its `<dt>` and `<dd>`.

    <DescriptionList ariaLabel="About" items={[
      { label: "Created", value: "3 Nov 2026, 10:12" },
      { label: "Author", value: "Ana López", href: "/users/ana" },
      { label: "API path", value: "/api/posts/42", copy: true },
    ]} />

  - `copy: true` makes the value a CopyButton (monospace, announced when copied); a string
    copies that text instead of the one shown. `href` makes it a link. `mono` sets it in
    monospace (ids, paths). A missing value shows `emptyValue` ("—").
  - The `value` snippet draws any value yourself (a Badge, an Avatar with a name); it gets
    the item.
  - Layout answers to the list's own width: label and value side by side when there is room
    (`layout="auto"`), stacked when narrow. `layout="stacked"` always stacks, and `columns`
    (2 or 3) lays stacked pairs out in a grid that falls back to one column.
  - `items` is plain JSON. Same HTML on the server.
-->
<script lang="ts" module>
  export interface DescriptionItem {
    label: string;
    /** The value as text; missing or empty shows `emptyValue`. */
    value?: string | number | null;
    /** A CopyButton instead of plain text: `true` copies the value, a string copies that. */
    copy?: boolean | string;
    /** Makes the value a link. */
    href?: string;
    /** Monospace (ids, paths, hashes). */
    mono?: boolean;
    /** Anything else you want to read in the `value` snippet. */
    [key: string]: unknown;
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";

  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  import CopyButton from "./copy-button.svelte";

  interface Props {
    items: DescriptionItem[];
    /** `auto`: side by side when there is room, stacked when narrow. */
    layout?: "auto" | "stacked";
    /** Columns of pairs (stacked) when the list is wide enough. */
    columns?: 1 | 2 | 3;
    /** Accessible name of the list. */
    ariaLabel?: string;
    /** What a missing value shows. */
    emptyValue?: string;
    copyLabel?: string;
    copiedLabel?: string;
    class?: string;
    /** Draws a value yourself; gets the item. Return nothing special: it replaces the text. */
    value?: Snippet<[DescriptionItem]>;
    /** Any other attribute goes to the <dl>. */
    [key: string]: unknown;
  }

  const L = useLabels();
  const {
    items,
    layout = "auto",
    columns = 1,
    ariaLabel,
    emptyValue = "—",
    copyLabel = L.copy,
    copiedLabel = L.copied,
    class: className = "",
    value,
    ...rest
  }: Props = $props();

  const textOf = (it: DescriptionItem) => (it.value == null || it.value === "" ? "" : String(it.value));
</script>

<div class={cn("ta-desc-box", className)}>
  <dl
    {...rest}
    class={cn("ta-desc", `ta-desc--${columns > 1 ? "stacked" : layout}`, columns > 1 && `ta-desc--cols-${columns}`)}
    aria-label={ariaLabel}
  >
    {#each items as it, i (i)}
      {@const text = textOf(it)}
      <div class="ta-desc-pair">
        <dt class="ta-desc-label">{it.label}</dt>
        <dd class={cn("ta-desc-value", it.mono && "ta-desc-value--mono")}>
          {#if value}
            {@render value(it)}
          {:else if !text}
            <span class="ta-desc-none">{emptyValue}</span>
          {:else if it.copy}
            <CopyButton text={typeof it.copy === "string" ? it.copy : text} label={text} {copyLabel} {copiedLabel} class="ta-desc-copy" />
          {:else if it.href}
            <a class="ta-desc-link" href={it.href}>{text}</a>
          {:else}
            {text}
          {/if}
        </dd>
      </div>
    {/each}
  </dl>
</div>

<style>
  .ta-desc-box { container-type: inline-size; min-width: 0; }

  .ta-desc {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
    margin: 0;
    font-size: 0.875rem;
  }

  .ta-desc-pair {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.125rem;
    min-width: 0;
    padding: 0.5rem 0;
    border-bottom: 1px solid rgb(var(--ta-border) / 0.7);
  }
  .ta-desc-pair:last-child { border-bottom: none; }

  .ta-desc-label {
    font-size: 0.75rem;
    font-weight: 500;
    color: rgb(var(--ta-text-dim));
  }

  .ta-desc-value {
    margin: 0;
    min-width: 0;
    color: rgb(var(--ta-text));
    overflow-wrap: anywhere;
  }
  .ta-desc-value--mono { font-family: var(--ta-font-mono); font-size: 0.8125rem; }
  .ta-desc-none { color: rgb(var(--ta-text-dim)); }

  .ta-desc-link {
    position: relative;
    color: color-mix(in srgb, rgb(var(--ta-accent)) 65%, rgb(var(--ta-text)));
    text-decoration: underline;
    text-decoration-color: rgb(var(--ta-accent) / 0.4);
    text-underline-offset: 2px;
    border-radius: var(--ta-radius-sm);
  }
  .ta-desc-link:hover { text-decoration-color: currentColor; }
  .ta-desc-link:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 2px; }

  .ta-desc :global(.ta-desc-copy) { max-width: 100%; }

  /* Several columns of stacked pairs: no rules, a gap instead. */
  .ta-desc[class*="ta-desc--cols-"] { gap: 1rem 1.5rem; }
  .ta-desc[class*="ta-desc--cols-"] .ta-desc-pair { padding: 0; border-bottom: none; }

  /* Room for label and value side by side. */
  @container (min-width: 26rem) {
    .ta-desc--auto .ta-desc-pair {
      grid-template-columns: minmax(7rem, 11rem) minmax(0, 1fr);
      gap: 1rem;
      align-items: baseline;
    }
    .ta-desc--auto .ta-desc-label { font-size: 0.8125rem; }
    .ta-desc--cols-2,
    .ta-desc--cols-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @container (min-width: 44rem) {
    .ta-desc--cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }

  /* The link's hit area grows to 44px without moving the text. */
  @media (pointer: coarse) {
    .ta-desc-link::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      height: 2.75rem;
      transform: translateY(-50%);
    }
  }
</style>

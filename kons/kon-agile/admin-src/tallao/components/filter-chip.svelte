<!--
  tallao — FilterChip
  One filter of a list as a chip: a button that says the filter and its value
  ("Status: Published") and opens its editor, and, while it has a value, a second button
  that removes it. FilterBar draws one per declared filter; it also works on its own.

    <FilterChip label="Status" type="select" options={["Draft", "Published"]} bind:value={status} />

  The editor depends on `type`:
  - "select": a menu of the options (APG menu button; each one a `menuitemradio`, the
    current one checked), with "All" first to clear it. ↑ ↓, Home / End, a letter, Escape.
  - "boolean": the same menu with "Yes" and "No"; the value is `true` / `false`.
  - "text": a small non-modal panel with a text field; it filters as you type and Enter
    closes it.
  - "date": a panel with a Calendar; picking a day sets an ISO date ("2026-11-03") and
    closes it. With `range` it is a DateRangePicker (quick ranges and two calendars) and the
    value is "2026-11-01..2026-11-07" (either end may be empty: "2026-11-01..").
  No value is `null` (an empty text is `null` too). An active chip is marked by its value in
  text and a filled style, never by colour alone. Without JavaScript the chip is an inert
  button: render your own `<form>` controls for a page that must filter without it.
-->
<script lang="ts" module>
  export type FilterType = "select" | "boolean" | "date" | "text";
  export type FilterOption = string | { value: string; label: string };
  export type FilterChipValue = string | boolean | null;
</script>

<script lang="ts">
  import { tick } from "svelte";

  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  import Calendar from "./calendar.svelte";
  import DateRangePicker from "./date-range-picker.svelte";
  import DropdownMenu from "./dropdown-menu.svelte";
  import Icon from "./icon.svelte";
  import MenuItem from "./menu-item.svelte";
  import MenuSeparator from "./menu-separator.svelte";
  import Popover from "./popover.svelte";

  interface Props {
    /** The filter's name ("Status"). */
    label: string;
    type: FilterType;
    /** The choices of a "select". */
    options?: FilterOption[];
    /** `null` when the filter is not applied. */
    value?: FilterChipValue;
    /** Shows the remove button while the chip has a value. */
    removable?: boolean;
    /** Placeholder of the "text" field. */
    placeholder?: string;
    /** A "date" filter takes two dates, stored as "start..end". */
    range?: boolean;
    /** Language of the "date" calendar. */
    locale?: string;
    /** Accessible name of the remove button; "{filter}" is replaced by the label. */
    removeLabel?: string;
    /** The entry that clears a "select" or "boolean". */
    anyLabel?: string;
    yesLabel?: string;
    noLabel?: string;
    class?: string;
    onchange?: (value: FilterChipValue) => void;
    /** The remove button was pressed (after the value was cleared). */
    onremove?: () => void;
  }

  const L = useLabels();
  let {
    label,
    type,
    options = [],
    value = $bindable(null),
    removable = true,
    placeholder,
    range = false,
    locale,
    removeLabel = L.removeFilter,
    anyLabel = L.allValues,
    yesLabel = L.yes,
    noLabel = L.no,
    class: className = "",
    onchange,
    onremove,
  }: Props = $props();

  let root: HTMLElement | undefined = $state();
  let open = $state(false);

  const choices = $derived(
    type === "boolean"
      ? [
          { value: true as string | boolean, label: yesLabel },
          { value: false as string | boolean, label: noLabel },
        ]
      : options.map((o) => (typeof o === "string" ? { value: o as string | boolean, label: o } : { value: o.value as string | boolean, label: o.label }))
  );
  const active = $derived(value !== null && value !== undefined && value !== "");
  const shown = $derived.by(() => {
    if (!active) return "";
    if (type === "select" || type === "boolean") return choices.find((c) => c.value === value)?.label ?? String(value);
    if (type === "date" && range) return String(value).split("..").map((d) => d || "…").join(" – ");
    return String(value);
  });

  const rangeValue = $derived.by(() => {
    const [start = "", end = ""] = typeof value === "string" ? value.split("..") : [];
    return { start: start || null, end: end || null };
  });

  function set(next: FilterChipValue) {
    const clean = next === "" || next === undefined ? null : next;
    if (clean === value) return;
    value = clean;
    onchange?.(clean);
  }

  const main = () => root?.querySelector<HTMLElement>(".ta-filter-chip-main");

  function remove() {
    set(null);
    onremove?.();
    // The remove button is gone: focus stays on the chip (if it is still there).
    tick().then(() => main()?.focus());
  }

  /** Opens the chip's editor, as a click on it does. */
  export function openEditor() {
    if (!open) main()?.click();
  }
</script>

{#snippet face(props: Record<string | symbol, unknown>)}
  <button {...props} type="button" class="ta-filter-chip-main" aria-label={active ? label + ": " + shown : undefined}>
    <span class="ta-filter-chip-label">{label}{#if active}<span class="ta-filter-chip-colon">:</span>{/if}</span>
    {#if active}<span class="ta-filter-chip-value">{shown}</span>{/if}
    <Icon name="chevron-down" size={12} class="ta-filter-chip-caret" />
  </button>
{/snippet}

<span bind:this={root} class={cn("ta-filter-chip", active && "ta-filter-chip--active", className)} data-active={active || undefined}>
  {#if type === "select" || type === "boolean"}
    <DropdownMenu {label} bind:open>
      {#snippet trigger(props)}{@render face(props)}{/snippet}
      <MenuItem checked={!active} checkType="radio" onSelect={() => set(null)}>{anyLabel}</MenuItem>
      <MenuSeparator />
      {#each choices as c (c.value)}
        <MenuItem checked={active && c.value === value} checkType="radio" onSelect={() => set(c.value)}>{c.label}</MenuItem>
      {/each}
    </DropdownMenu>
  {:else}
    <Popover ariaLabel={label} bind:open>
      {#snippet trigger(props)}{@render face(props)}{/snippet}
      {#if type === "text"}
        <input
          type="text"
          class="ta-filter-chip-field"
          aria-label={label}
          {placeholder}
          autocomplete="off"
          value={typeof value === "string" ? value : ""}
          oninput={(e) => set(e.currentTarget.value)}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              open = false;
              main()?.focus();
            }
          }}
        />
      {:else if range}
        <DateRangePicker inline value={rangeValue} {locale} onchange={(next) => set(next.start || next.end ? `${next.start ?? ""}..${next.end ?? ""}` : null)} />
      {:else}
        <Calendar
          value={typeof value === "string" ? value : null}
          {locale}
          onselect={(iso) => {
            set(iso);
            open = false;
            main()?.focus();
          }}
        />
      {/if}
    </Popover>
  {/if}
  {#if active && removable}
    <button type="button" class="ta-filter-chip-remove" aria-label={removeLabel.replace("{filter}", label)} onclick={remove}>
      <Icon name="x" size={12} />
    </button>
  {/if}
</span>

<style>
  .ta-filter-chip {
    display: inline-flex;
    align-items: stretch;
    max-width: 100%;
    min-height: 2.25rem;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
    border: 1px dashed rgb(var(--ta-muted));
    border-radius: 9999px;
    transition: border-color 0.15s, background-color 0.15s;
  }
  .ta-filter-chip:hover { border-color: rgb(var(--ta-subtle)); }
  /* Applied: a solid frame and a tint, besides the value in text. */
  .ta-filter-chip--active {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-accent) / 0.1);
    border: 1px solid rgb(var(--ta-accent) / 0.45);
  }

  .ta-filter-chip-main {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    min-width: 0;
    padding: 0 0.625rem 0 0.75rem;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    border-radius: 9999px;
    cursor: pointer;
  }
  .ta-filter-chip-main:hover { color: rgb(var(--ta-text)); }
  .ta-filter-chip-main:focus-visible,
  .ta-filter-chip-remove:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 1px; }

  .ta-filter-chip-label { flex-shrink: 0; white-space: nowrap; }
  .ta-filter-chip--active .ta-filter-chip-label { color: rgb(var(--ta-text-dim)); }
  .ta-filter-chip-value {
    min-width: 0;
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .ta-filter-chip :global(.ta-filter-chip-caret) { flex-shrink: 0; opacity: 0.7; }

  .ta-filter-chip-remove {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 1.75rem;
    padding: 0;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: none;
    border-left: 1px solid rgb(var(--ta-accent) / 0.3);
    border-radius: 0 9999px 9999px 0;
    cursor: pointer;
  }
  .ta-filter-chip-remove:hover { color: rgb(var(--ta-text)); background: rgb(var(--ta-accent) / 0.15); }

  .ta-filter-chip-field {
    width: 14rem;
    max-width: 100%;
    padding: 0.4375rem 0.625rem;
    font: inherit;
    font-size: 0.875rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-bg));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    outline: none;
  }
  .ta-filter-chip-field::placeholder { color: rgb(var(--ta-text-dim)); }
  .ta-filter-chip-field:focus { border-color: rgb(var(--ta-accent) / 0.5); box-shadow: 0 0 0 2px rgb(var(--ta-accent) / 0.15); }

  @media (pointer: coarse) {
    .ta-filter-chip { min-height: 2.75rem; }
    .ta-filter-chip-remove { width: 2.75rem; }
    .ta-filter-chip-field { font-size: 1rem; min-height: 2.75rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-filter-chip { transition: none; }
  }
</style>

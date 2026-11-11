<!--
  tallao — DateRangePicker
  Two dates, from and to: typed (ISO "YYYY-MM-DD") or picked in a panel with quick ranges
  ("Last 7 days") and a Calendar for each end. Built on Calendar, like DatePicker.

    <DateRangePicker bind:value={range} name="period" />
    <DateRangePicker inline bind:value={range} presets={[{ label: "Season 3", start: "2026-09-01", end: "2026-11-30" }]} />

  - `value` is `{ start, end }`, each an ISO date or `null`. Typing a date that does not exist
    marks that field (`aria-invalid`) and changes nothing. If the start ends up after the end,
    the two are swapped, so the range is always in order.
  - The two fields are real text inputs in a group named `ariaLabel`. With `name` they are
    submitted as `<name>_start` and `<name>_end` (or `startName` / `endName`), so a plain
    `<form method="GET">` filters by date without JavaScript.
  - The button opens a non-modal panel (Escape or a click outside close it and focus returns
    to the button; Alt+↓ in a field opens it). In it: the quick ranges as buttons, and two
    Calendars with their own keyboard (see Calendar); the end calendar cannot go before the
    start, nor the start after the end.
  - `presets`: `{ label, days }` counts back from today (today included); `{ label, start,
    end }` is a fixed range. By default: the last 7, 30 and 90 days and this month. "Today" is
    read in the browser when a preset is pressed.
  - `inline` renders only the panel's content in place (no fields, no button): FilterChip
    uses it for a date range filter.
-->
<script lang="ts" module>
  import type { ISODate } from "$lib/internal/dates";

  export interface DateRange {
    start: ISODate | null;
    end: ISODate | null;
  }

  export type DateRangePreset = { label: string; days: number } | { label: string; start: ISODate; end: ISODate };
</script>

<script lang="ts">
  import { tick, untrack } from "svelte";

  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";
  import { addDays, parseISO, todayISO } from "$lib/internal/dates";
  import { restoreFocus } from "$lib/internal/focus";
  import { pushLayer } from "$lib/internal/layers";
  import { anchor } from "$lib/internal/position";
  import { scaleIn } from "$lib/motion";

  import Calendar from "./calendar.svelte";
  import Icon from "./icon.svelte";

  interface Props {
    /** The two dates (bindable). */
    value?: DateRange;
    min?: ISODate;
    max?: ISODate;
    locale?: string;
    weekStartsOn?: number;
    /** Quick ranges; `[]` shows none. */
    presets?: DateRangePreset[];
    /** Submits the dates as `<name>_start` and `<name>_end`. */
    name?: string;
    startName?: string;
    endName?: string;
    disabled?: boolean;
    /** Only the panel's content, in place. */
    inline?: boolean;
    /** Accessible name of the group of two fields. */
    ariaLabel?: string;
    startLabel?: string;
    endLabel?: string;
    buttonLabel?: string;
    class?: string;
    onchange?: (value: DateRange) => void;
  }

  const L = useLabels();
  let {
    value = $bindable({ start: null, end: null }),
    min,
    max,
    locale,
    weekStartsOn = 1,
    presets,
    name,
    startName = name ? `${name}_start` : undefined,
    endName = name ? `${name}_end` : undefined,
    disabled = false,
    inline = false,
    ariaLabel = L.chooseDates,
    startLabel = L.startDate,
    endLabel = L.endDate,
    buttonLabel = L.chooseDates,
    class: className = "",
    onchange,
  }: Props = $props();

  const id = $props.id();
  const quick = $derived<DateRangePreset[]>(
    presets ?? [
      { label: L.lastDays.replace("{n}", "7"), days: 7 },
      { label: L.lastDays.replace("{n}", "30"), days: 30 },
      { label: L.lastDays.replace("{n}", "90"), days: 90 },
      { label: L.thisMonth, days: 0 },
    ]
  );

  let wrapper: HTMLElement | undefined = $state();
  let button: HTMLButtonElement | undefined = $state();
  let panel: HTMLElement | undefined = $state();
  let open = $state(false);
  // Filled from the value at once, so the server renders the dates in the fields.
  let texts = $state(untrack(() => ({ start: value.start ?? "", end: value.end ?? "" })));
  let invalid = $state({ start: false, end: false });

  // The fields follow the value when it changes from outside or from the panel.
  $effect(() => {
    texts = { start: value.start ?? "", end: value.end ?? "" };
    invalid = { start: false, end: false };
  });

  const outOfRange = (iso: ISODate) => (min != null && iso < min) || (max != null && iso > max);

  function set(next: DateRange) {
    const ordered = next.start && next.end && next.start > next.end ? { start: next.end, end: next.start } : next;
    if (ordered.start === value.start && ordered.end === value.end) return;
    value = ordered;
    onchange?.(ordered);
  }

  function commit(side: "start" | "end") {
    const text = texts[side].trim();
    if (text === "") {
      invalid[side] = false;
      set({ ...value, [side]: null });
      return;
    }
    const ok = !!parseISO(text) && !outOfRange(text);
    invalid[side] = !ok;
    if (ok) set({ ...value, [side]: text });
  }

  function apply(preset: DateRangePreset) {
    if ("start" in preset) set({ start: preset.start, end: preset.end });
    else {
      const today = todayISO();
      set({ start: preset.days > 0 ? addDays(today, -(preset.days - 1)) : `${today.slice(0, 7)}-01`, end: today });
    }
  }
  const isCurrent = (preset: DateRangePreset) => "start" in preset && preset.start === value.start && preset.end === value.end;

  $effect(() => {
    const p = panel;
    const c = wrapper;
    if (inline || !open || !p || !c) return;
    const release = anchor(c, p, { placement: "bottom-start", gap: 4 });
    const remove = pushLayer({
      inside: () => [p, button],
      dismiss: (reason) => {
        open = false;
        if (reason === "escape") restoreFocus(button ?? null);
      },
    });
    tick().then(() => p.querySelector<HTMLElement>("button")?.focus());
    return () => {
      remove();
      release();
    };
  });
</script>

{#snippet content()}
  {#if quick.length}
    <div class="ta-daterange-presets" role="group" aria-label={buttonLabel}>
      {#each quick as preset (preset.label)}
        <button type="button" class="ta-daterange-preset" aria-pressed={isCurrent(preset) || undefined} onclick={() => apply(preset)}>{preset.label}</button>
      {/each}
    </div>
  {/if}
  <div class="ta-daterange-months">
    <div role="group" aria-label={startLabel}>
      <p class="ta-daterange-caption" aria-hidden="true">{startLabel}</p>
      <Calendar value={value.start} {min} max={value.end ?? max} {locale} {weekStartsOn} onselect={(iso) => set({ ...value, start: iso })} />
    </div>
    <div role="group" aria-label={endLabel}>
      <p class="ta-daterange-caption" aria-hidden="true">{endLabel}</p>
      <Calendar value={value.end} min={value.start ?? min} {max} {locale} {weekStartsOn} onselect={(iso) => set({ ...value, end: iso })} />
    </div>
  </div>
{/snippet}

{#if inline}
  <div class={cn("ta-daterange-panel ta-daterange-panel--inline", className)}>{@render content()}</div>
{:else}
  <div class={cn("ta-daterange", className)} bind:this={wrapper} role="group" aria-label={ariaLabel}>
    {#each ["start", "end"] as const as side (side)}
      {#if side === "end"}<span class="ta-daterange-dash" aria-hidden="true">–</span>{/if}
      <input
        type="text"
        inputmode="numeric"
        class="ta-daterange-field"
        name={side === "start" ? startName : endName}
        placeholder="YYYY-MM-DD"
        aria-label={side === "start" ? startLabel : endLabel}
        aria-invalid={invalid[side] || undefined}
        {disabled}
        bind:value={texts[side]}
        onblur={() => commit(side)}
        onkeydown={(e) => {
          if (e.key === "Enter") commit(side);
          if (e.key === "ArrowDown" && e.altKey) {
            e.preventDefault();
            open = true;
          }
        }}
      />
    {/each}
    <button
      type="button"
      class="ta-daterange-button"
      bind:this={button}
      aria-label={buttonLabel}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? `${id}-panel` : undefined}
      {disabled}
      onclick={() => (open = !open)}
    >
      <Icon name="calendar" size={16} />
    </button>
    {#if open}
      <div bind:this={panel} id={`${id}-panel`} role="dialog" aria-label={buttonLabel} popover="manual" class="ta-daterange-panel ta-daterange-panel--floating" out:scaleIn={{ duration: "fast", from: 0.98 }}>
        {@render content()}
      </div>
    {/if}
  </div>
{/if}

<style>
  .ta-daterange {
    position: relative;
    display: flex;
    align-items: stretch;
    width: 100%;
    max-width: 22rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-bg));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
  }
  .ta-daterange:focus-within { border-color: rgb(var(--ta-accent) / 0.5); box-shadow: 0 0 0 2px rgb(var(--ta-accent) / 0.15); }

  .ta-daterange-field {
    flex: 1 1 0;
    min-width: 0;
    padding: 0.5rem 0.625rem;
    font: inherit;
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
    color: inherit;
    background: none;
    border: none;
    border-radius: var(--ta-radius);
    outline: none;
  }
  .ta-daterange-field::placeholder { color: rgb(var(--ta-text-dim)); }
  .ta-daterange-field:focus-visible { box-shadow: inset 0 0 0 2px rgb(var(--ta-accent) / 0.45); }
  .ta-daterange-field[aria-invalid="true"] { box-shadow: inset 0 0 0 1px rgb(var(--ta-danger) / 0.8); }
  .ta-daterange-dash { align-self: center; color: rgb(var(--ta-text-dim)); }

  .ta-daterange-button {
    display: flex;
    align-items: center;
    padding: 0 0.625rem;
    color: rgb(var(--ta-text-dim));
    background: rgb(var(--ta-surface));
    border: none;
    border-left: 1px solid rgb(var(--ta-border));
    border-radius: 0 var(--ta-radius) var(--ta-radius) 0;
    cursor: pointer;
  }
  .ta-daterange-button:hover:not(:disabled) { color: rgb(var(--ta-text)); }
  .ta-daterange-button:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 2px; }
  .ta-daterange-button:disabled,
  .ta-daterange-field:disabled { opacity: 0.5; cursor: not-allowed; }

  .ta-daterange-panel { display: flex; gap: 0.75rem; color: rgb(var(--ta-text)); }
  .ta-daterange-panel--floating {
    position: fixed;
    inset: auto;
    margin: 0;
    z-index: 50;
    max-width: calc(100vw - 1rem);
    max-height: var(--ta-available-height, calc(100dvh - 2rem));
    padding: 0.625rem;
    overflow: auto;
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
    box-shadow: 0 12px 32px -8px rgb(0 0 0 / 0.45);
    font: inherit;
    animation: ta-daterange-enter var(--ta-duration-fast, 120ms) var(--ta-ease-out, ease-out);
  }
  @keyframes ta-daterange-enter {
    from { opacity: 0; transform: translateY(-2px) scale(0.98); }
    to { opacity: 1; transform: none; }
  }

  .ta-daterange-presets { display: flex; flex: 0 0 auto; flex-direction: column; gap: 0.125rem; min-width: 8rem; }
  .ta-daterange-preset {
    padding: 0.375rem 0.625rem;
    font: inherit;
    font-size: 0.8125rem;
    text-align: left;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: 1px solid transparent;
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
  }
  .ta-daterange-preset:hover { color: rgb(var(--ta-text)); background: rgb(var(--ta-elevated)); }
  .ta-daterange-preset:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 1px; }
  .ta-daterange-preset[aria-pressed="true"] { color: rgb(var(--ta-text)); border-color: rgb(var(--ta-accent) / 0.45); background: rgb(var(--ta-accent) / 0.1); }

  .ta-daterange-months { display: flex; flex-wrap: wrap; gap: 0.75rem; min-width: 0; }
  .ta-daterange-caption {
    margin: 0 0 0.25rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgb(var(--ta-text-dim));
  }

  /* A phone: the quick ranges become a row over the calendars, which stack. */
  @media (max-width: 640px) {
    .ta-daterange-panel { flex-direction: column; }
    .ta-daterange-presets { flex-direction: row; flex-wrap: wrap; min-width: 0; }
  }

  @media (pointer: coarse) {
    .ta-daterange-field { font-size: 1rem; min-height: 2.75rem; }
    .ta-daterange-button { min-width: 2.75rem; justify-content: center; }
    .ta-daterange-preset { min-height: 2.75rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-daterange-panel--floating { animation: none; }
  }
</style>

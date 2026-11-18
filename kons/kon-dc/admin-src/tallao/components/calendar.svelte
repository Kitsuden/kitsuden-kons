<!--
  tallao — Calendar
  A month to pick a day (grid from the WAI-ARIA APG "date picker" pattern).
    - ← → previous / next day; ↑ ↓ previous / next week.
    - Home / End: first / last day of the week.
    - PageUp / PageDown: previous / next month (with Shift, year).
    - Enter or Space picks the day.
  Only one day receives Tab (roving tabindex). Today carries aria-current="date";
  days outside [min, max] or rejected by `isDisabled` cannot be picked.
  ISO dates "YYYY-MM-DD"; month and day names from the language (`locale`, Intl).
-->
<script lang="ts">
  import { tick, untrack } from "svelte";

  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";
  import {
    addDays,
    addMonths,
    clampISO,
    formatDate,
    capitalizeFirst,
    monthGrid,
    parseISO,
    sameMonth,
    todayISO,
    weekday,
    type ISODate,
  } from "$lib/internal/dates";

  const L = useLabels();
  let {
    value = $bindable(null),
    min,
    max,
    locale,
    /** First day of the week: 0 Sunday, 1 Monday (default). */
    weekStartsOn = 1,
    isDisabled,
    previousLabel = L.previousMonth,
    nextLabel = L.nextMonth,
    class: className = "",
    onselect,
  }: {
    value?: ISODate | null;
    min?: ISODate;
    max?: ISODate;
    locale?: string;
    weekStartsOn?: number;
    isDisabled?: (iso: ISODate) => boolean;
    previousLabel?: string;
    nextLabel?: string;
    class?: string;
    onselect?: (iso: ISODate) => void;
  } = $props();

  const id = $props.id();
  // "Today" is computed in the browser: the server may be in another time zone and its
  // "today" be a different day, and the mark would not match on hydration.
  let today = $state<ISODate | null>(null);
  $effect(() => {
    today = todayISO();
  });
  // The focused day (and so the month shown); starts at the value, or at today.
  let focused = $state<ISODate>(untrack(() => clampISO(parseISO(value) ? value! : todayISO(), min, max)));
  let grid: HTMLElement | undefined = $state();

  // If the value changes from outside, the calendar goes to that month. It only follows the
  // value: if it also depended on the focused day, changing month with the keyboard would undo it.
  $effect(() => {
    const v = value;
    untrack(() => {
      if (parseISO(v) && !sameMonth(v!, focused)) focused = v!;
    });
  });

  const weeks = $derived(monthGrid(focused, weekStartsOn));
  // Only the first letter: CSS capitalize produced "Noviembre De 2026"
  const heading = $derived(capitalizeFirst(formatDate(focused, locale, { month: "long", year: "numeric" })));
  const headers = $derived(
    weeks[0].map((d) => ({
      short: formatDate(d, locale, { weekday: "short" }),
      long: formatDate(d, locale, { weekday: "long" }),
    }))
  );

  const isBlocked = (iso: ISODate) => (min != null && iso < min) || (max != null && iso > max) || !!isDisabled?.(iso);

  async function focusDay(iso: ISODate) {
    focused = clampISO(iso, min, max);
    await tick();
    grid?.querySelector<HTMLElement>(`[data-day="${focused}"]`)?.focus();
  }

  function choose(iso: ISODate) {
    if (isBlocked(iso)) return;
    value = iso;
    focused = iso;
    onselect?.(iso);
  }

  function onKey(e: KeyboardEvent, iso: ISODate) {
    const weekStart = addDays(iso, -((weekday(iso) - weekStartsOn + 7) % 7));
    const target =
      e.key === "ArrowLeft" ? addDays(iso, -1)
      : e.key === "ArrowRight" ? addDays(iso, 1)
      : e.key === "ArrowUp" ? addDays(iso, -7)
      : e.key === "ArrowDown" ? addDays(iso, 7)
      : e.key === "Home" ? weekStart
      : e.key === "End" ? addDays(weekStart, 6)
      : e.key === "PageUp" ? addMonths(iso, e.shiftKey ? -12 : -1)
      : e.key === "PageDown" ? addMonths(iso, e.shiftKey ? 12 : 1)
      : null;
    if (target) {
      e.preventDefault();
      focusDay(target);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(iso);
    }
  }

  /** So focus is not left on a button that is no longer rendered when changing month with the arrows. */
  const shiftMonth = (n: number) => focusDay(addMonths(focused, n));

  const dayLabel = (iso: ISODate) => formatDate(iso, locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
</script>

<div class={cn("ta-calendar", className)}>
  <div class="ta-calendar-header">
    <button type="button" class="ta-calendar-month" aria-label={previousLabel} onclick={() => shiftMonth(-1)}>‹</button>
    <h2 class="ta-calendar-title" id={`${id}-title`} aria-live="polite">{heading}</h2>
    <button type="button" class="ta-calendar-month" aria-label={nextLabel} onclick={() => shiftMonth(1)}>›</button>
  </div>
  <table class="ta-calendar-grid" role="grid" aria-labelledby={`${id}-title`} bind:this={grid}>
    <thead>
      <tr>
        {#each headers as c, i (i)}<th scope="col" abbr={c.long}>{c.short}</th>{/each}
      </tr>
    </thead>
    <tbody>
      {#each weeks as week, s (s)}
        <tr>
          {#each week as day (day)}
            <td role="gridcell" aria-selected={day === value} class:ta-calendar-outside={!sameMonth(day, focused)}>
              <button
                type="button"
                class="ta-calendar-day"
                data-day={day}
                tabindex={day === focused ? 0 : -1}
                aria-label={dayLabel(day)}
                aria-current={day === today ? "date" : undefined}
                aria-disabled={isBlocked(day) ? "true" : undefined}
                onclick={() => choose(day)}
                onkeydown={(e) => onKey(e, day)}
              >
                {parseISO(day)!.d}
              </button>
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .ta-calendar {
    display: inline-flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem;
    color: rgb(var(--ta-text));
  }

  .ta-calendar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .ta-calendar-title {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
  }

  .ta-calendar-month {
    width: 1.75rem;
    height: 1.75rem;
    font: inherit;
    font-size: 1rem;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: 1px solid transparent;
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
  }
  .ta-calendar-month:hover { color: rgb(var(--ta-text)); background: rgb(var(--ta-elevated)); }

  .ta-calendar-grid { border-collapse: collapse; }

  .ta-calendar-grid th {
    padding: 0.25rem 0;
    font-size: 0.6875rem;
    font-weight: 500;
    color: rgb(var(--ta-text-dim));
    text-transform: capitalize;
  }

  .ta-calendar-grid td { padding: 1px; text-align: center; }

  .ta-calendar-day {
    width: 2rem;
    height: 2rem;
    font: inherit;
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
    color: inherit;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
  }
  .ta-calendar-day:hover { background: rgb(var(--ta-elevated)); }
  .ta-calendar-day:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.7); outline-offset: 1px; }
  .ta-calendar-day[aria-current="date"] { border-color: rgb(var(--ta-accent) / 0.6); }
  .ta-calendar-day[aria-disabled="true"] { opacity: 0.35; cursor: not-allowed; }

  .ta-calendar-outside .ta-calendar-day { color: rgb(var(--ta-text-dim) / 0.7); }

  td[aria-selected="true"] .ta-calendar-day {
    color: rgb(var(--ta-on-accent));
    background: var(--ta-accent-fill, color-mix(in srgb, rgb(var(--ta-accent)) 88%, black));
    border-color: var(--ta-accent-fill, color-mix(in srgb, rgb(var(--ta-accent)) 88%, black));
  }

  /* On touch screens: 44 × 44px days and month arrows. */
  @media (pointer: coarse) {
    .ta-calendar-month { min-width: 2.75rem; min-height: 2.75rem; }
    .ta-calendar-day { min-width: 2.75rem; min-height: 2.75rem; }
  }
</style>

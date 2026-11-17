<!--
  tallao — DatePicker
  Date field: typed (ISO "YYYY-MM-DD") or picked in a Calendar that opens next to
  the field. The calendar is a non-modal panel: Escape or a click outside close it
  and focus returns to the button. With `name`, a hidden input submits the value in
  a native form. A typed date that does not exist marks the field
  (aria-invalid) and does not change the value.
-->
<script lang="ts">
  import { tick } from "svelte";

  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";
  import { parseISO, type ISODate } from "$lib/internal/dates";
  import { restoreFocus } from "$lib/internal/focus";
  import { pushLayer } from "$lib/internal/layers";
  import { anchor } from "$lib/internal/position";

  import Calendar from "./calendar.svelte";

  const L = useLabels();
  let {
    value = $bindable(null),
    min,
    max,
    locale,
    weekStartsOn = 1,
    isDisabled,
    name,
    required = false,
    disabled = false,
    placeholder = "YYYY-MM-DD",
    ariaLabel,
    buttonLabel = L.chooseDate,
    class: className = "",
    onchange,
  }: {
    value?: ISODate | null;
    min?: ISODate;
    max?: ISODate;
    locale?: string;
    weekStartsOn?: number;
    isDisabled?: (iso: ISODate) => boolean;
    name?: string;
    required?: boolean;
    disabled?: boolean;
    placeholder?: string;
    /** Accessible name of the field when it is not inside a Field. */
    ariaLabel?: string;
    buttonLabel?: string;
    class?: string;
    onchange?: (value: ISODate | null) => void;
  } = $props();

  const id = $props.id();
  let wrapper: HTMLElement | undefined = $state();
  let button: HTMLButtonElement | undefined = $state();
  let panel: HTMLElement | undefined = $state();
  let open = $state(false);
  let text = $state("");
  let invalid = $state(false);

  // The text follows the value when it changes from outside (or when picking in the calendar).
  $effect(() => {
    text = value ?? "";
    invalid = false;
  });

  const isOutOfRange = (iso: ISODate) => (min != null && iso < min) || (max != null && iso > max) || !!isDisabled?.(iso);

  function setValue(iso: ISODate | null) {
    value = iso;
    onchange?.(iso);
  }

  function commitText() {
    const t = text.trim();
    if (t === "") {
      invalid = false;
      if (value !== null) setValue(null);
      return;
    }
    const ok = parseISO(t) && !isOutOfRange(t);
    invalid = !ok;
    if (ok && t !== value) setValue(t);
  }

  async function onPicked(iso: ISODate) {
    setValue(iso);
    open = false;
    await tick();
    button?.focus();
  }

  $effect(() => {
    const p = panel;
    const c = wrapper;
    if (!open || !p || !c) return;
    const release = anchor(c, p, { placement: "bottom-start", gap: 4 });
    const remove = pushLayer({
      inside: () => [p, button],
      dismiss: (reason) => {
        open = false;
        if (reason === "escape") restoreFocus(button ?? null);
      },
    });
    // Focus goes to the selected day (or to today).
    tick().then(() => p.querySelector<HTMLElement>('.ta-calendar-day[tabindex="0"]')?.focus());
    return () => {
      remove();
      release();
    };
  });
</script>

<div class={cn("ta-datepicker", className)} bind:this={wrapper}>
  {#if name}<input type="hidden" {name} value={value ?? ""} />{/if}
  <input
    type="text"
    inputmode="numeric"
    class="ta-datepicker-field"
    bind:value={text}
    {placeholder}
    {disabled}
    aria-label={ariaLabel}
    aria-invalid={invalid || undefined}
    aria-required={required || undefined}
    onblur={commitText}
    onkeydown={(e) => {
      if (e.key === "Enter") commitText();
      if (e.key === "ArrowDown" && e.altKey) {
        e.preventDefault();
        open = true;
      }
    }}
  />
  <button
    type="button"
    class="ta-datepicker-button"
    bind:this={button}
    aria-label={buttonLabel}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={open ? `${id}-panel` : undefined}
    {disabled}
    onclick={() => (open = !open)}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
  </button>

  {#if open}
    <div bind:this={panel} id={`${id}-panel`} role="dialog" aria-label={buttonLabel} popover="manual" class="ta-datepicker-panel">
      <Calendar {value} {min} {max} {locale} {weekStartsOn} {isDisabled} onselect={onPicked} />
    </div>
  {/if}
</div>

<style>
  .ta-datepicker {
    position: relative;
    display: flex;
    width: 100%;
  }

  .ta-datepicker-field {
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0.75rem;
    font: inherit;
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-bg));
    border: 1px solid rgb(var(--ta-border));
    border-right: none;
    border-radius: var(--ta-radius) 0 0 var(--ta-radius);
    outline: none;
  }
  .ta-datepicker-field:focus {
    border-color: rgb(var(--ta-accent) / 0.5);
    box-shadow: 0 0 0 2px rgb(var(--ta-accent) / 0.15);
  }
  .ta-datepicker-field[aria-invalid="true"] { border-color: rgb(var(--ta-danger) / 0.7); }

  .ta-datepicker-button {
    display: flex;
    align-items: center;
    padding: 0 0.625rem;
    color: rgb(var(--ta-text-dim));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: 0 var(--ta-radius) var(--ta-radius) 0;
    cursor: pointer;
  }
  .ta-datepicker-button:hover:not(:disabled) { color: rgb(var(--ta-text)); }
  .ta-datepicker-button:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 2px; }
  .ta-datepicker-button:disabled, .ta-datepicker-field:disabled { opacity: 0.5; cursor: not-allowed; }

  .ta-datepicker-panel {
    position: fixed;
    inset: auto;
    margin: 0;
    z-index: 50;
    padding: 0;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
    box-shadow: 0 12px 32px -8px rgb(0 0 0 / 0.45);
    font: inherit;
    overflow: visible;
  }

  /* On touch screens: the field button reaches 44px. */
  @media (pointer: coarse) {
    .ta-datepicker-button { min-height: 2.75rem; }
  }
</style>

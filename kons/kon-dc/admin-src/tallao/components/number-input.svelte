<!--
  tallao — NumberInput
  A real number: `value` is a number (or null when empty), never text.
  - Optional − / + buttons (`stepper`) that respect `min`, `max` and `step`.
  - `width="auto"`: as wide as the figure needs (a row of settings); by default, full
    width, like Input.
  - On leaving the field, a value outside the bounds is clamped to the bound (unless `clamp={false}`).
  - With `name`, it is submitted in a <form> like the native field.
  - With `stepper`, do not put it inside a Field (its <label> wraps it and a click on the label
    would press "−"): name it with `ariaLabel` or with a separate <label for={id}>.
-->
<script lang="ts">
  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  import Icon from "./icon.svelte";

  const L = useLabels();
  let {
    value = $bindable(null),
    min,
    max,
    step = 1,
    stepper = false,
    clamp = true,
    width = "full",
    size = "md",
    name,
    id,
    placeholder,
    disabled = false,
    ariaLabel,
    decrementLabel = L.decrement,
    incrementLabel = L.increment,
    class: className = "",
    inputClass = "",
    onchange,
    onblur,
    ...rest
  }: {
    value?: number | null;
    min?: number;
    max?: number;
    step?: number;
    /** − and + buttons on the sides. */
    stepper?: boolean;
    /** On leaving, clamp a value outside `min`/`max` to the bound. Without it, the value stays
     *  and the consumer validates it (a form that warns "at most 100"). */
    clamp?: boolean;
    width?: "full" | "auto";
    size?: "sm" | "md";
    name?: string;
    id?: string;
    placeholder?: string;
    disabled?: boolean;
    ariaLabel?: string;
    decrementLabel?: string;
    incrementLabel?: string;
    class?: string;
    inputClass?: string;
    /** On every new value (typed, from the buttons, or clamped on leaving). */
    onchange?: (value: number | null) => void;
    /** In addition to the component's own clamping on leaving. */
    onblur?: (e: FocusEvent) => void;
    [key: string]: unknown;
  } = $props();

  const clampToRange = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  const decimals = $derived((String(step).split(".")[1] ?? "").length);
  const round = (n: number) => Number(n.toFixed(decimals));

  function setValue(n: number | null) {
    if (n === value) return;
    value = n;
    onchange?.(n);
  }

  function stepBy(direction: 1 | -1) {
    const base = value ?? min ?? 0;
    setValue(clampToRange(round(base + direction * step)));
  }

  function handleInput(e: Event) {
    const t = (e.currentTarget as HTMLInputElement).value;
    if (t === "") return setValue(null);
    const n = Number(t);
    if (Number.isFinite(n)) setValue(n);
  }

  function handleBlur(e: FocusEvent) {
    const field = e.currentTarget as HTMLInputElement;
    if (value == null) field.value = "";
    else if (clamp) {
      const n = clampToRange(value);
      setValue(n);
      field.value = String(n);
    }
    onblur?.(e);
  }
</script>

<div class={cn("ta-number", `ta-number--${size}`, width === "auto" && "ta-number--auto", stepper && "ta-number--stepper", className)}>
  {#if stepper}
    <button
      type="button"
      class="ta-number-step"
      aria-label={decrementLabel}
      disabled={disabled || (min != null && value != null && value <= min)}
      onclick={() => stepBy(-1)}
    ><Icon name="minus" size={14} /></button>
  {/if}
  <input
    {...rest}
    {id}
    {name}
    {placeholder}
    {min}
    {max}
    {step}
    {disabled}
    type="number"
    inputmode={Number.isInteger(step) && (min == null || min >= 0) ? "numeric" : "decimal"}
    class={cn("ta-number-field", inputClass)}
    aria-label={ariaLabel}
    value={value ?? ""}
    oninput={handleInput}
    onblur={handleBlur}
  />
  {#if stepper}
    <button
      type="button"
      class="ta-number-step"
      aria-label={incrementLabel}
      disabled={disabled || (max != null && value != null && value >= max)}
      onclick={() => stepBy(1)}
    ><Icon name="plus" size={14} /></button>
  {/if}
</div>

<style>
  .ta-number { display: flex; align-items: stretch; width: 100%; min-width: 0; }
  .ta-number--auto { display: inline-flex; width: auto; }

  .ta-number-field {
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    padding: 0.5rem 0.75rem;
    font-family: inherit;
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-bg));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
    appearance: textfield;
    -moz-appearance: textfield;
  }
  .ta-number--sm .ta-number-field { padding: 0.3125rem 0.5rem; font-size: 0.8125rem; }
  /* With width="auto", about 6 digits wide. */
  .ta-number--auto .ta-number-field { width: 6ch; flex: 0 0 auto; box-sizing: content-box; }
  .ta-number-field::-webkit-inner-spin-button,
  .ta-number-field::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .ta-number-field:focus { border-color: rgb(var(--ta-accent) / 0.5); box-shadow: 0 0 0 2px rgb(var(--ta-accent) / 0.15); position: relative; z-index: 1; }
  .ta-number-field:disabled { opacity: 0.5; cursor: not-allowed; }
  .ta-number--stepper .ta-number-field { border-radius: 0; text-align: center; }

  .ta-number-step {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    flex: 0 0 auto;
    padding: 0;
    color: rgb(var(--ta-text-dim));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    cursor: pointer;
  }
  .ta-number--sm .ta-number-step { width: 1.75rem; }
  .ta-number-step:first-child { border-right: none; border-radius: var(--ta-radius) 0 0 var(--ta-radius); }
  .ta-number-step:last-child { border-left: none; border-radius: 0 var(--ta-radius) var(--ta-radius) 0; }
  .ta-number-step:hover:not(:disabled) { color: rgb(var(--ta-text)); background: rgb(var(--ta-elevated)); }
  .ta-number-step:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 1px; position: relative; z-index: 1; }
  .ta-number-step:disabled { opacity: 0.4; cursor: not-allowed; }

  /* On touch screens: 16px so iOS does not zoom the page on focus, and 44px tall for a finger. */
  @media (pointer: coarse) {
    .ta-number-field { font-size: 1rem; min-height: 2.75rem; }
    .ta-number-step { width: 2.75rem; }
  }
</style>

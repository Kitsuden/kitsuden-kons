<!--
  tallao — ToggleGroup
  Filters or modes as a row of pressable buttons (aria-pressed) inside a named
  group: "All · Rare · Epic", "Daily · Weekly".
  - `type="single"` (default): one pressed (`value`); pressing the active one releases it
    unless `required` is set.
  - `type="multiple"`: several (`values`).
  - With `name`, the pressed values are submitted in a <form> (hidden inputs, also without JavaScript).
  They are normal buttons in Tab order: each one can be reached and is read with its state.
  - `variant="bare"`: no frame or background, for icon-only facets (with the `item`
    snippet); the pressed one gets a ring and, while any is pressed, the others are
    dimmed (`dimOthers`). Each icon-only option just needs `ariaLabel` (and `title`).
  - Per-option color: `color` (or `--ta-toggle-accent` in its `style`) tints its pressed
    state, its ring and its solid background. Variables the page can set: `--ta-toggle-accent`,
    `--ta-toggle-on-accent`, `--ta-toggle-ring-offset` (the background under the ring) and
    `--ta-toggle-dim` (opacity of the dimmed ones).
-->
<script lang="ts" module>
  export interface ToggleOption {
    value: string;
    label: string;
    disabled?: boolean;
    /** Small figure after the text (how many results that filter has). */
    count?: number;
    /** Accessible name of the button (required if it only carries an icon). */
    ariaLabel?: string;
    /** Tooltip on hover. */
    title?: string;
    /** Custom pressed color (any CSS color): sets `--ta-toggle-accent`. */
    color?: string;
    /** Classes for this button, after `itemClass`. */
    class?: string;
    /** Inline style for this button (other variables, a background…). */
    style?: string;
  }
</script>

<script lang="ts">
  import { cn } from "$lib/utils";

  let {
    options,
    type = "single",
    value = $bindable(""),
    values = $bindable([]),
    label,
    ariaLabel,
    variant = "pills",
    tone = "tint",
    itemClass = "",
    hideLabel = true,
    dimOthers,
    required = false,
    size = "md",
    name,
    disabled = false,
    class: className = "",
    onchange,
    onValuesChange,
    item,
  }: {
    options: ToggleOption[];
    type?: "single" | "multiple";
    value?: string;
    values?: string[];
    /** Name of the group (the screen reader hears it; visible with hideLabel={false}). */
    label?: string;
    /** Name of the group without a visible label of its own. */
    ariaLabel?: string;
    /** `segmented`: equal-width buttons, joined, full width. `bare`: no frame, for icons. */
    variant?: "pills" | "segmented" | "bare";
    /** Pressed: `tint` (soft accent) or `solid` (accent background). */
    tone?: "tint" | "solid";
    /** Classes for each button (touch height on mobile, for example). */
    itemClass?: string;
    hideLabel?: boolean;
    /** Dim the unpressed buttons while any is pressed (by default, only in `bare`). */
    dimOthers?: boolean;
    /** In `single`, always keep one pressed. */
    required?: boolean;
    size?: "sm" | "md";
    name?: string;
    disabled?: boolean;
    class?: string;
    onchange?: (value: string) => void;
    onValuesChange?: (values: string[]) => void;
    /** Custom content for each button (icon + text). */
    item?: import("svelte").Snippet<[ToggleOption, boolean]>;
  } = $props();

  const id = $props.id();
  const isPressed = (v: string) => (type === "multiple" ? values.includes(v) : value === v);
  const anyPressed = $derived(options.some((o) => isPressed(o.value)));
  const dim = $derived(dimOthers ?? variant === "bare");
  const styleOf = (o: ToggleOption) =>
    [o.color && `--ta-toggle-accent: ${o.color}`, o.style].filter(Boolean).join("; ") || undefined;

  function press(v: string) {
    if (type === "multiple") {
      values = values.includes(v) ? values.filter((x) => x !== v) : [...values, v];
      onValuesChange?.(values);
      return;
    }
    if (value === v && required) return;
    value = value === v ? "" : v;
    onchange?.(value);
  }
</script>

<div
  class={cn(
    "ta-toggle-group",
    variant === "segmented" && "ta-toggle-group--segmented",
    variant === "bare" && "ta-toggle-group--bare",
    dim && anyPressed && "ta-toggle-group--dimmed",
    className
  )}
  role="group"
  aria-labelledby={label ? `${id}-label` : undefined}
  aria-label={label ? undefined : ariaLabel}
>
  {#if label}<span id={`${id}-label`} class={hideLabel ? "ta-toggle-group-hidden" : "ta-toggle-group-label"}>{label}</span>{/if}
  {#if name}
    {#each type === "multiple" ? values : value ? [value] : [] as v (v)}<input type="hidden" {name} value={v} />{/each}
  {/if}
  {#each options as o (o.value)}
    {@const active = isPressed(o.value)}
    <button
      type="button"
      class={cn("ta-toggle-group-button", `ta-toggle-group-button--${size}`, tone === "solid" && "ta-toggle-group-button--solid", itemClass, o.class)}
      style={styleOf(o)}
      aria-pressed={active}
      aria-label={o.ariaLabel}
      title={o.title}
      disabled={disabled || o.disabled}
      onclick={() => press(o.value)}
    >
      {#if item}{@render item(o, active)}{:else}{o.label}{#if o.count != null}<span class="ta-toggle-group-count">{o.count}</span>{/if}{/if}
    </button>
  {/each}
</div>

<style>
  .ta-toggle-group { display: flex; flex-wrap: wrap; align-items: center; gap: 0.375rem; }
  .ta-toggle-group-label { margin-right: 0.25rem; font-size: 0.75rem; font-weight: 500; color: rgb(var(--ta-text-dim)); }
  .ta-toggle-group-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

  .ta-toggle-group-button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    font: inherit;
    font-size: 0.8125rem;
    font-weight: 500;
    line-height: 1.25;
    color: rgb(var(--ta-text-dim));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: 999px;
    cursor: pointer;
    transition: color 0.15s, background-color 0.15s, border-color 0.15s;
  }
  .ta-toggle-group-button--sm { padding: 0.25rem 0.625rem; font-size: 0.75rem; }
  .ta-toggle-group-button:hover:not(:disabled) { color: rgb(var(--ta-text)); border-color: rgb(var(--ta-muted)); }
  .ta-toggle-group-button[aria-pressed="true"] {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-accent) / 0.18);
    border-color: rgb(var(--ta-accent) / 0.7);
  }
  /* With a custom color (the option or the page sets --ta-toggle-accent), the same tint in that color. */
  @supports (color: color-mix(in srgb, red, blue)) {
    .ta-toggle-group-button[aria-pressed="true"] {
      background: color-mix(in srgb, var(--ta-toggle-accent, rgb(var(--ta-accent))) 18%, transparent);
      border-color: color-mix(in srgb, var(--ta-toggle-accent, rgb(var(--ta-accent))) 70%, transparent);
    }
  }
  .ta-toggle-group-button:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 2px; }
  .ta-toggle-group-button:disabled { opacity: 0.45; cursor: not-allowed; }
  .ta-toggle-group--segmented {
    flex-wrap: nowrap;
    gap: 0;
    padding: 0.125rem;
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
  }
  .ta-toggle-group--segmented .ta-toggle-group-button {
    flex: 1 1 0;
    justify-content: center;
    border-color: transparent;
    border-radius: calc(var(--ta-radius) - 2px);
    background: transparent;
  }
  .ta-toggle-group--segmented .ta-toggle-group-button[aria-pressed="true"] {
    background: rgb(var(--ta-accent) / 0.18);
    border-color: rgb(var(--ta-accent) / 0.5);
  }
  @supports (color: color-mix(in srgb, red, blue)) {
    .ta-toggle-group--segmented .ta-toggle-group-button[aria-pressed="true"] {
      background: color-mix(in srgb, var(--ta-toggle-accent, rgb(var(--ta-accent))) 18%, transparent);
      border-color: color-mix(in srgb, var(--ta-toggle-accent, rgb(var(--ta-accent))) 50%, transparent);
    }
  }
  .ta-toggle-group .ta-toggle-group-button--solid[aria-pressed="true"] {
    color: var(--ta-toggle-on-accent, rgb(var(--ta-on-accent)));
    background: var(--ta-toggle-accent, var(--ta-accent-fill, color-mix(in srgb, rgb(var(--ta-accent)) 88%, black)));
    border-color: var(--ta-toggle-accent, var(--ta-accent-fill, color-mix(in srgb, rgb(var(--ta-accent)) 88%, black)));
  }

  /* bare: the button is its content (an icon), no frame or background; when pressed, a ring. */
  .ta-toggle-group--bare .ta-toggle-group-button {
    padding: 0.125rem;
    color: rgb(var(--ta-text));
    background: transparent;
    border-color: transparent;
    transition: opacity 0.15s, box-shadow 0.15s, transform 0.15s;
  }
  .ta-toggle-group--bare .ta-toggle-group-button--sm { padding: 0.0625rem; }
  .ta-toggle-group--bare .ta-toggle-group-button:hover:not(:disabled) { border-color: transparent; transform: scale(1.05); }
  .ta-toggle-group.ta-toggle-group--bare .ta-toggle-group-button[aria-pressed="true"] {
    background: transparent;
    border-color: transparent;
    box-shadow:
      0 0 0 2px var(--ta-toggle-ring-offset, rgb(var(--ta-surface))),
      0 0 0 4px var(--ta-toggle-accent, rgb(var(--ta-accent)));
  }
  .ta-toggle-group--dimmed .ta-toggle-group-button[aria-pressed="false"]:not(:hover):not(:focus-visible) { opacity: var(--ta-toggle-dim, 0.4); }
  @media (prefers-reduced-motion: reduce) {
    .ta-toggle-group--bare .ta-toggle-group-button:hover:not(:disabled) { transform: none; }
  }
  .ta-toggle-group-button--solid[aria-pressed="true"] .ta-toggle-group-count { color: inherit; }
  .ta-toggle-group-count { font-size: 0.6875rem; font-variant-numeric: tabular-nums; color: rgb(var(--ta-text-dim)); }

  /* On touch screens: 16px so iOS does not zoom the page on focus, and 44px of height for the finger. */
  @media (pointer: coarse) {
    .ta-toggle-group-button { min-height: 2.75rem; }
  }
</style>

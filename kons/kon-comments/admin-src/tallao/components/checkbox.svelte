<!--
  tallao — Checkbox
  Native checkbox with the kit's accent and its clickable label.
  Without `label` or children, pass `ariaLabel`: an unnamed checkbox makes no sense.
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  let {
    checked = $bindable(false),
    label,
    ariaLabel,
    disabled = false,
    class: className = "",
    children,
    ...rest
  }: {
    checked?: boolean;
    label?: string;
    ariaLabel?: string;
    disabled?: boolean;
    class?: string;
    children?: import("svelte").Snippet;
    [key: string]: unknown;
  } = $props();
</script>

<label class={cn("ta-checkbox", disabled && "ta-checkbox--off", className)}>
  <span class="ta-checkbox-box">
    <input type="checkbox" bind:checked {disabled} aria-label={ariaLabel} {...rest} />
    <svg class="ta-checkbox-mark" viewBox="0 0 16 16" aria-hidden="true"><path class="ta-checkbox-check" d="M3.5 8.4l3 3 6-6.6" /><path class="ta-checkbox-dash" d="M4 8h8" /></svg>
  </span>
  {#if label}<span>{label}</span>{/if}
  {@render children?.()}
</label>

<style>
  .ta-checkbox {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    /* The label is the target: 24px at least (WCAG 2.5.8), also around a box with no text. */
    min-width: 1.5rem;
    min-height: 1.5rem;
    font-size: 0.875rem;
    color: rgb(var(--ta-text));
    cursor: pointer;
    user-select: none;
  }

  /* Still a native checkbox (name, value, form, :indeterminate, Space): only its drawing is
     the kit's, so the check can be drawn by its stroke. */
  .ta-checkbox-box { position: relative; display: inline-flex; flex-shrink: 0; width: 1rem; height: 1rem; }
  .ta-checkbox input {
    appearance: none;
    width: 1rem;
    height: 1rem;
    margin: 0;
    background: rgb(var(--ta-bg));
    border: 1px solid rgb(var(--ta-subtle));
    border-radius: 0.25rem;
    cursor: inherit;
    transition: transform var(--ta-duration-fast, 120ms) var(--ta-ease-out, ease-out);
  }
  /* Press feedback: the box gives a little under the pointer. */
  .ta-checkbox input:active:not(:disabled) { transform: scale(0.88); }

  .ta-checkbox input:checked,
  .ta-checkbox input:indeterminate {
    background: var(--ta-accent-fill, color-mix(in srgb, rgb(var(--ta-accent)) 88%, black));
    border-color: transparent;
  }
  .ta-checkbox-mark {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    fill: none;
    stroke: rgb(var(--ta-on-accent));
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: none;
  }
  .ta-checkbox-check,
  .ta-checkbox-dash { stroke-dasharray: 16; stroke-dashoffset: 16; transition: stroke-dashoffset var(--ta-duration-base, 180ms) var(--ta-ease-out, ease-out); }
  .ta-checkbox input:checked:not(:indeterminate) + .ta-checkbox-mark .ta-checkbox-check,
  .ta-checkbox input:indeterminate + .ta-checkbox-mark .ta-checkbox-dash { stroke-dashoffset: 0; }

  /* Forced colours: the system draws its own checkbox. */
  @media (forced-colors: active) {
    .ta-checkbox input { appearance: auto; }
    .ta-checkbox-mark { display: none; }
  }

  .ta-checkbox input:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 2px;
  }

  .ta-checkbox--off {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-checkbox input,
    .ta-checkbox-check,
    .ta-checkbox-dash { transition: none; }
    .ta-checkbox input:active:not(:disabled) { transform: none; }
  }

  /* On touch screens: the whole label is the 44px hit area; the box stays 16px. */
  @media (pointer: coarse) {
    .ta-checkbox { min-height: 2.75rem; align-items: center; }
  }
</style>

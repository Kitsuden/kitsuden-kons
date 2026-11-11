<!--
  tallao — Switch
  On/off switch (role="switch", WAI-ARIA APG): a button that announces "on"
  or "off". For a setting that applies immediately; for something submitted
  with a form, use Checkbox.
  Without `label` or children, pass `ariaLabel`.
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  let {
    checked = $bindable(false),
    label,
    ariaLabel,
    disabled = false,
    size = "md",
    name,
    value = "on",
    class: className = "",
    onchange,
    children,
  }: {
    checked?: boolean;
    label?: string;
    ariaLabel?: string;
    disabled?: boolean;
    size?: "sm" | "md";
    /** Name in a form: on submits `name=value`, off submits nothing (like a checkbox). */
    name?: string;
    value?: string;
    class?: string;
    onchange?: (checked: boolean) => void;
    children?: import("svelte").Snippet;
  } = $props();

  const id = $props.id();

  function toggle() {
    if (disabled) return;
    checked = !checked;
    onchange?.(checked);
  }
</script>

<span class={cn("ta-switch", `ta-switch--${size}`, disabled && "ta-switch--off", className)}>
  {#if name && checked}<input type="hidden" {name} {value} />{/if}
  <button
    type="button"
    role="switch"
    id={`${id}-switch`}
    aria-checked={checked}
    aria-label={label || children ? undefined : ariaLabel}
    aria-labelledby={label || children ? `${id}-label` : undefined}
    {disabled}
    class="ta-switch-track"
    onclick={toggle}
  >
    <span class="ta-switch-thumb" aria-hidden="true"></span>
  </button>
  {#if label || children}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <span class="ta-switch-label" id={`${id}-label`} onclick={toggle}>
      {label}{@render children?.()}
    </span>
  {/if}
</span>

<style>
  .ta-switch {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: rgb(var(--ta-text));
  }

  .ta-switch-track {
    position: relative;
    flex-shrink: 0;
    padding: 0;
    border: 1px solid rgb(var(--ta-border));
    border-radius: 9999px;
    background: rgb(var(--ta-muted));
    cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s;
  }

  /* The track is 16–20px tall: its hit area is 24px (WCAG 2.5.8) without changing the drawing. */
  .ta-switch-track::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 1.5rem;
    transform: translateY(-50%);
  }

  .ta-switch--md .ta-switch-track { width: 2.25rem; height: 1.25rem; }
  .ta-switch--sm .ta-switch-track { width: 1.75rem; height: 1rem; }

  .ta-switch-track[aria-checked="true"] {
    background: rgb(var(--ta-accent));
    border-color: rgb(var(--ta-accent));
  }

  .ta-switch-track:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 2px;
  }

  .ta-switch-thumb {
    position: absolute;
    top: 50%;
    left: 0.125rem;
    border-radius: 9999px;
    background: white;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.3);
    transform: translateY(-50%);
    transition: transform var(--ta-duration-base, 180ms) var(--ta-ease-spring, ease-out);
  }

  .ta-switch--md .ta-switch-thumb { width: 0.875rem; height: 0.875rem; }
  .ta-switch--sm .ta-switch-thumb { width: 0.625rem; height: 0.625rem; }

  .ta-switch--md .ta-switch-track[aria-checked="true"] .ta-switch-thumb { transform: translate(1rem, -50%); }
  .ta-switch--sm .ta-switch-track[aria-checked="true"] .ta-switch-thumb { transform: translate(0.75rem, -50%); }

  .ta-switch-label {
    cursor: pointer;
    user-select: none;
  }

  .ta-switch--off {
    opacity: 0.5;
  }
  .ta-switch--off .ta-switch-track,
  .ta-switch--off .ta-switch-label {
    cursor: not-allowed;
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-switch-track,
    .ta-switch-thumb { transition: none; }
  }

  /* On touch screens: the whole label is the 44px hit area; the track keeps its size. */
  @media (pointer: coarse) {
    .ta-switch { min-height: 2.75rem; }
  }
</style>

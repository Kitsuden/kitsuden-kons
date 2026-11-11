<!--
  tallao — Toggle
  A button that stays pressed (aria-pressed): "Favorites only", "Show completed".
  To choose between several options with buttons, use ToggleGroup.
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  let {
    pressed = $bindable(false),
    size = "md",
    tone = "tint",
    disabled = false,
    ariaLabel,
    class: className = "",
    onchange,
    children,
    ...rest
  }: {
    pressed?: boolean;
    size?: "sm" | "md";
    /** Pressed: `tint` (soft accent) or `solid` (accent background). */
    tone?: "tint" | "solid";
    disabled?: boolean;
    /** Accessible name when the content is only an icon. */
    ariaLabel?: string;
    class?: string;
    onchange?: (pressed: boolean) => void;
    children: import("svelte").Snippet;
    [key: string]: unknown;
  } = $props();
</script>

<button
  {...rest}
  type="button"
  class={cn("ta-toggle", `ta-toggle--${size}`, tone === "solid" && "ta-toggle--solid", className)}
  aria-pressed={pressed}
  aria-label={ariaLabel}
  {disabled}
  onclick={() => {
    pressed = !pressed;
    onchange?.(pressed);
  }}
>
  {@render children()}
</button>

<style>
  .ta-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
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
  .ta-toggle--sm { padding: 0.25rem 0.625rem; font-size: 0.75rem; }
  .ta-toggle:hover:not(:disabled) { color: rgb(var(--ta-text)); border-color: rgb(var(--ta-muted)); }
  .ta-toggle[aria-pressed="true"] {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-accent) / 0.18);
    border-color: rgb(var(--ta-accent) / 0.7);
  }
  .ta-toggle--solid[aria-pressed="true"] { color: rgb(var(--ta-on-accent)); background: var(--ta-accent-fill, color-mix(in srgb, rgb(var(--ta-accent)) 88%, black)); border-color: var(--ta-accent-fill, color-mix(in srgb, rgb(var(--ta-accent)) 88%, black)); }
  .ta-toggle:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 2px; }
  .ta-toggle:disabled { opacity: 0.45; cursor: not-allowed; }

  /* On touch screens: 16px so iOS does not zoom the page on focus, and 44px of height for the finger. */
  @media (pointer: coarse) {
    .ta-toggle { min-height: 2.75rem; }
  }
</style>

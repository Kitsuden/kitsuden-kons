<!--
  tallao — MenuItem
  An option of a DropdownMenu. Choosing it (click, Enter or Space) calls
  `onSelect` and closes the menu; with `closeOnSelect={false}` it stays open.
  A disabled option is announced and skipped while navigating, but not hidden.
  With `checked` (true or false) it is a choice that can be on or off: `menuitemcheckbox`,
  or `menuitemradio` with `checkType="radio"` (one of several), with `aria-checked` and a
  check mark, so the state is not carried by colour.
-->
<script lang="ts">
  import { useMenu } from "$lib/internal/menu";
  import { cn } from "$lib/utils";

  interface Props {
    onSelect?: () => void;
    disabled?: boolean;
    variant?: "default" | "danger";
    closeOnSelect?: boolean;
    /** On or off: makes the option a `menuitemcheckbox` (or a radio, see `checkType`). */
    checked?: boolean;
    checkType?: "checkbox" | "radio";
    class?: string;
    children: import("svelte").Snippet;
  }

  const {
    onSelect,
    disabled = false,
    variant = "default",
    closeOnSelect = true,
    checked,
    checkType = "checkbox",
    class: className = "",
    children,
  }: Props = $props();

  const menu = useMenu();

  function choose() {
    if (disabled) return;
    onSelect?.();
    if (closeOnSelect) menu?.close();
  }
</script>

<button
  type="button"
  role={checked === undefined ? "menuitem" : checkType === "radio" ? "menuitemradio" : "menuitemcheckbox"}
  aria-checked={checked}
  tabindex="-1"
  aria-disabled={disabled ? "true" : undefined}
  class={cn("ta-menu-item", `ta-menu-item--${variant}`, className)}
  onclick={choose}
>
  {#if checked !== undefined}
    <svg class="ta-menu-item-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{#if checked}<path d="M5 12.5l4.5 4.5L19 7.5" />{/if}</svg>
  {/if}
  {@render children()}
</button>

<style>
  .ta-menu-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4rem 0.6rem;
    font: inherit;
    font-size: 0.875rem;
    text-align: left;
    color: rgb(var(--ta-text));
    background: none;
    border: none;
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
    outline: none;
  }

  .ta-menu-item:hover,
  .ta-menu-item:focus-visible,
  .ta-menu-item:focus {
    background: rgb(var(--ta-elevated));
  }

  .ta-menu-item-check { flex-shrink: 0; color: color-mix(in srgb, rgb(var(--ta-accent)) 65%, rgb(var(--ta-text))); }

  .ta-menu-item--danger {
    color: rgb(var(--ta-danger));
  }

  .ta-menu-item[aria-disabled="true"] {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* On touch screens: 44px items for the finger. */
  @media (pointer: coarse) {
    .ta-menu-item { min-height: 2.75rem; }
  }
</style>

<!--
  tallao — SelectionBar
  Selection bar for bulk actions on a list: a "select all" checkbox
  (with an indeterminate state when only some are checked), how many are checked, and
  the actions, which only appear when something is checked: a button that can do
  nothing gets in the way more than it helps. The caller provides each row's checkboxes.
  The counter is announced (aria-live) for those who cannot see the list.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  import { cn } from "$lib/utils";

  interface Props {
    /** How many items can be checked (those in the visible list). */
    total: number;
    /** How many are checked. */
    selected: number;
    /** The "select all" checkbox: `true` checks all, `false` unchecks them. */
    onToggleAll: (checked: boolean) => void;
    selectAllLabel?: string;
    /** Text of the counter. */
    countLabel?: (selected: number) => string;
    /** Name of the group for screen readers. */
    ariaLabel?: string;
    class?: string;
    /** The bulk actions; rendered only when something is checked. */
    actions?: Snippet;
  }

  const {
    total,
    selected,
    onToggleAll,
    selectAllLabel = "Select all",
    countLabel = (n: number) => `${n} selected`,
    ariaLabel = "Selection",
    class: className = "",
    actions,
  }: Props = $props();

  const allChecked = $derived(total > 0 && selected >= total);
  const partial = $derived(selected > 0 && selected < total);
</script>

<div
  class={cn("ta-selection-bar", selected > 0 && "ta-selection-bar--active", className)}
  role="group"
  aria-label={ariaLabel}
>
  <label class={cn("ta-selection-bar-all", total === 0 && "ta-selection-bar-all--off")}>
    <input
      type="checkbox"
      checked={allChecked}
      indeterminate={partial}
      disabled={total === 0}
      aria-label={selectAllLabel}
      onchange={(e) => onToggleAll((e.currentTarget as HTMLInputElement).checked)}
    />
    <span class="ta-selection-bar-count" aria-live="polite">{countLabel(selected)}</span>
  </label>
  {#if selected > 0 && actions}
    <div class="ta-selection-bar-actions">{@render actions()}</div>
  {/if}
</div>

<style>
  .ta-selection-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem 0.75rem;
    flex-wrap: wrap;
    min-height: 2.5rem;
    padding: 0.375rem 0.75rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    background: rgb(var(--ta-surface));
    transition: border-color 0.15s;
  }

  .ta-selection-bar--active {
    border-color: rgb(var(--ta-accent) / 0.6);
    background: rgb(var(--ta-accent) / 0.06);
  }

  .ta-selection-bar-all {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
    cursor: pointer;
    user-select: none;
  }

  .ta-selection-bar-all input {
    width: 1rem;
    height: 1rem;
    margin: 0;
    accent-color: rgb(var(--ta-accent));
    cursor: inherit;
  }

  .ta-selection-bar-all input:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 2px;
  }

  .ta-selection-bar-all--off {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .ta-selection-bar-actions {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-wrap: wrap;
  }
  @media (pointer: coarse) {
    .ta-selection-bar-all { min-height: 2.75rem; }
  }
</style>

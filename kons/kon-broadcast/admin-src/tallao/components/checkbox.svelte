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
  <input type="checkbox" bind:checked {disabled} aria-label={ariaLabel} {...rest} />
  {#if label}<span>{label}</span>{/if}
  {@render children?.()}
</label>

<style>
  .ta-checkbox {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: rgb(var(--ta-text));
    cursor: pointer;
    user-select: none;
  }

  .ta-checkbox input {
    width: 1rem;
    height: 1rem;
    margin: 0;
    accent-color: rgb(var(--ta-accent));
    cursor: inherit;
  }

  .ta-checkbox input:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 2px;
  }

  .ta-checkbox--off {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>

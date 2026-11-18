<!--
  tallao — Select
  Native drop-down list with the kit's tokens. Options come as a prop
  (`options`) or as <option>/<optgroup> children; they can be mixed.
-->
<script lang="ts" module>
  export interface SelectOption {
    value: string;
    label: string;
    disabled?: boolean;
  }
</script>

<script lang="ts">
  import { cn } from "$lib/utils";

  let {
    value = $bindable(""),
    /** The native element (bind:ref), to focus or measure it. */
    ref = $bindable(),
    options = [],
    placeholder,
    size = "md",
    width = "full",
    class: className = "",
    disabled = false,
    children,
    ...rest
  }: {
    value?: string;
    ref?: HTMLSelectElement;
    options?: SelectOption[];
    /** Empty first option (value ""). */
    placeholder?: string;
    size?: "sm" | "md";
    /** `auto`: as wide as its longest option, for a row of filters. */
    width?: "full" | "auto";
    class?: string;
    disabled?: boolean;
    children?: import("svelte").Snippet;
    [key: string]: unknown;
  } = $props();
</script>

<select bind:this={ref} bind:value {disabled} class={cn("ta-select", `ta-select--${size}`, width === "auto" && "ta-select--auto", className)} {...rest}>
  {#if placeholder !== undefined}
    <option value="">{placeholder}</option>
  {/if}
  {#each options as o (o.value)}
    <option value={o.value} disabled={o.disabled}>{o.label}</option>
  {/each}
  {@render children?.()}
</select>

<style>
  .ta-select {
    width: 100%;
    /* In a narrow table cell it does not shrink down to just the arrow. */
    min-width: 7rem;
    font-family: inherit;
    color: rgb(var(--ta-text));
    background-color: rgb(var(--ta-bg));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    outline: none;
    cursor: pointer;
    appearance: none;
    /* Custom arrow: the native one does not follow the theme. */
    background-image: linear-gradient(45deg, transparent 50%, rgb(var(--ta-text-dim)) 50%),
      linear-gradient(135deg, rgb(var(--ta-text-dim)) 50%, transparent 50%);
    background-position:
      calc(100% - 1rem) 50%,
      calc(100% - 0.7rem) 50%;
    background-size: 0.3rem 0.3rem;
    background-repeat: no-repeat;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .ta-select--md { padding: 0.5rem 2rem 0.5rem 0.75rem; font-size: 0.875rem; }
  .ta-select--sm { padding: 0.3rem 1.75rem 0.3rem 0.5rem; font-size: 0.75rem; }

  .ta-select:focus {
    border-color: rgb(var(--ta-accent) / 0.5);
    box-shadow: 0 0 0 2px rgb(var(--ta-accent) / 0.15);
  }

  .ta-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .ta-select :global(option) {
    background: rgb(var(--ta-surface));
    color: rgb(var(--ta-text));
  }
  .ta-select.ta-select--auto { width: auto; min-width: 0; max-width: 100%; }

  /* On touch screens: 16px so iOS does not zoom the page on focus, and 44px tall for a finger. */
  @media (pointer: coarse) {
    .ta-select { font-size: 1rem; min-height: 2.75rem; }
  }
</style>

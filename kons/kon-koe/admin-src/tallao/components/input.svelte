<!--
  tallao — Input
  Text field with a focus state that matches the tokens.
  Accepts any native <input> attribute through rest props.
  For numbers use NumberInput: its `value` is typed `number | null` (null when empty).
  (Here, with `type="number"`, Svelte's bind:value already hands back a number or null at
  runtime, but the prop is typed as a string.)
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  let {
    value = $bindable(""),
    /** The native element (bind:ref), to focus or measure it. */
    ref = $bindable(),
    class: className = "",
    type = "text",
    disabled = false,
    ...rest
  }: {
    value?: string;
    ref?: HTMLInputElement;
    class?: string;
    type?: string;
    disabled?: boolean;
    [key: string]: unknown;
  } = $props();
</script>

<input
  bind:this={ref}
  bind:value
  {type}
  {disabled}
  class={cn("ta-input", className)}
  {...rest}
/>

<style>
  .ta-input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    font-family: inherit;
    font-size: 0.875rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-bg));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .ta-input::placeholder {
    color: rgb(var(--ta-text-dim));
  }

  .ta-input:focus {
    border-color: rgb(var(--ta-accent) / 0.5);
    box-shadow: 0 0 0 2px rgb(var(--ta-accent) / 0.15);
  }

  .ta-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  /* Colour picker: no text padding, field height and a full-width swatch. */
  .ta-input[type="color"] {
    height: 2.375rem;
    padding: 0.25rem;
    cursor: pointer;
  }
  .ta-input[type="color"]::-webkit-color-swatch-wrapper {
    padding: 0;
  }
  .ta-input[type="color"]::-webkit-color-swatch {
    border: none;
    border-radius: var(--ta-radius-sm);
  }
  .ta-input[type="color"]::-moz-color-swatch {
    border: none;
    border-radius: var(--ta-radius-sm);
  }

  /* On touch screens: 16px so iOS does not zoom the page on focus, and 44px tall for the finger. */
  @media (pointer: coarse) {
    .ta-input:not([type="color"]) { font-size: 1rem; min-height: 2.75rem; }
  }
</style>

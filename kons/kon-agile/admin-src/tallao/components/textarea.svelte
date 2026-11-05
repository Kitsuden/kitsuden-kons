<!--
  tallao — Textarea
  Multi-line text with the same states as Input.
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  let {
    value = $bindable(""),
    /** The native element (bind:ref), to focus or measure it. */
    ref = $bindable(),
    rows = 3,
    mono = false,
    class: className = "",
    disabled = false,
    ...rest
  }: {
    value?: string;
    ref?: HTMLTextAreaElement;
    rows?: number;
    /** Monospaced font (a card list, code, data). */
    mono?: boolean;
    class?: string;
    disabled?: boolean;
    [key: string]: unknown;
  } = $props();
</script>

<textarea bind:this={ref} bind:value {rows} {disabled} class={cn("ta-textarea", mono && "ta-textarea--mono", className)} {...rest}></textarea>

<style>
  .ta-textarea {
    width: 100%;
    padding: 0.5rem 0.75rem;
    font-family: inherit;
    font-size: 0.875rem;
    line-height: 1.5;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-bg));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    outline: none;
    resize: vertical;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .ta-textarea::placeholder {
    color: rgb(var(--ta-text-dim));
  }

  .ta-textarea:focus {
    border-color: rgb(var(--ta-accent) / 0.5);
    box-shadow: 0 0 0 2px rgb(var(--ta-accent) / 0.15);
  }

  .ta-textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .ta-textarea--mono { font-family: var(--ta-font-mono); font-size: 0.75rem; line-height: 1.625; }

  /* On touch screens: 16px so iOS does not zoom the page on focus, and 44px of height for the finger. */
  @media (pointer: coarse) {
    .ta-textarea { font-size: 1rem; }
  }

</style>

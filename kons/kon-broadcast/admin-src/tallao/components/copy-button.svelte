<!--
  CopyButton: a piece of text copied to the clipboard with one click.

  For URLs, keys or commands someone pastes elsewhere. It shows the text (or `label`) in
  monospace and, on copy, announces `copiedLabel` in an `aria-live` region for
  `resetAfter` ms. Without the clipboard API (insecure context) it does nothing and does not fake it.
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    /** What gets copied. */
    text: string;
    /** What is shown; by default, the text itself. */
    label?: string;
    /** Accessible name and title of the button. */
    copyLabel?: string;
    /** Notice after copying. */
    copiedLabel?: string;
    /** How long the notice lasts, in ms. */
    resetAfter?: number;
    disabled?: boolean;
    class?: string;
    onCopy?: (text: string) => void;
  }

  const {
    text,
    label,
    copyLabel = "Copy",
    copiedLabel = "Copied",
    resetAfter = 1500,
    disabled = false,
    class: className = "",
    onCopy,
  }: Props = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  // If the component unmounts while the notice is shown, the timer does not stay alive.
  $effect(() => () => clearTimeout(timer));

  async function copy() {
    if (disabled || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    copied = true;
    onCopy?.(text);
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), resetAfter);
  }
</script>

<button
  type="button"
  class={cn("ta-copy", copied && "ta-copy--done", className)}
  title={copyLabel}
  aria-label={`${copyLabel}: ${label ?? text}`}
  {disabled}
  onclick={copy}
>
  <span class="ta-copy-text">{label ?? text}</span>
  <span class="ta-copy-status" aria-live="polite">{copied ? copiedLabel : ""}</span>
</button>

<style>
  .ta-copy {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    padding: 0.25rem 0.5rem;
    font: inherit;
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    text-align: left;
    color: rgb(var(--ta-text-dim));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
  }

  .ta-copy:hover:not(:disabled) {
    color: rgb(var(--ta-text));
    border-color: rgb(var(--ta-accent));
  }

  .ta-copy:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 2px;
  }

  .ta-copy:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .ta-copy-text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .ta-copy-status {
    flex-shrink: 0;
    font-family: var(--ta-font-sans);
    color: rgb(var(--ta-success));
  }

  /* The live region stays in the DOM even when empty: if it appeared suddenly, it would not be announced. */
  .ta-copy-status:not(:empty) {
    margin-left: 0.5rem;
  }

  .ta-copy--done {
    border-color: rgb(var(--ta-success) / 0.5);
  }
</style>

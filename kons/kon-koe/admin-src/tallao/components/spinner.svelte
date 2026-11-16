<!--
  tallao — Spinner
  Standalone loading indicator: a spinning ring in the text color (currentColor).
  It is a `role="status"` region with hidden text (`label`, by default "Loading" from the
  kit's labels), so the screen reader announces it. With `prefers-reduced-motion` it does
  not spin: it pulses. Not needed inside a button: Button `loading` already draws its own.
-->
<script lang="ts">
  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  const L = useLabels();

  interface Props {
    /** sm 1rem · md 1.5rem · lg 2rem, or a size in pixels. */
    size?: "sm" | "md" | "lg" | number;
    /** What the screen reader announces. */
    label?: string;
    class?: string;
    /** Any other attribute (id, style, data-*…) goes to the container. */
    [key: string]: unknown;
  }

  const { size = "md", label = L.loading, class: className = "", ...rest }: Props = $props();
  const side = $derived(typeof size === "number" ? `${size}px` : undefined);
</script>

<span
  {...rest}
  role="status"
  class={cn("ta-spinner", typeof size === "string" && `ta-spinner--${size}`, className)}
  style:--ta-spinner-size={side}
>
  <span class="ta-spinner-ring" aria-hidden="true"></span>
  <span class="ta-spinner-text">{label}</span>
</span>

<style>
  .ta-spinner {
    --ta-spinner-size: 1.5rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: middle;
  }
  .ta-spinner--sm { --ta-spinner-size: 1rem; }
  .ta-spinner--md { --ta-spinner-size: 1.5rem; }
  .ta-spinner--lg { --ta-spinner-size: 2rem; }

  .ta-spinner-ring {
    width: var(--ta-spinner-size);
    height: var(--ta-spinner-size);
    border: max(2px, calc(var(--ta-spinner-size) / 10)) solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: ta-spinner-spin 0.7s linear infinite;
  }

  .ta-spinner-text {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  @keyframes ta-spinner-spin {
    to { transform: rotate(360deg); }
  }
  @keyframes ta-spinner-pulse {
    50% { opacity: 0.35; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-spinner-ring {
      border-right-color: currentColor;
      opacity: 0.8;
      animation: ta-spinner-pulse 2s ease-in-out infinite;
    }
  }
</style>

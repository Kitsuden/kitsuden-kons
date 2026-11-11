<!--
  tallao — Skeleton
  A placeholder shaped like the content while it loads. It is decorative (aria-hidden):
  the caller announces the loading once, e.g. with aria-busy on the container.
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  const {
    width = "100%",
    height = "1rem",
    shape = "rect",
    /** Several lines of text, the last one shorter. */
    lines = 1,
    class: className = "",
  }: {
    width?: string;
    height?: string;
    shape?: "rect" | "circle" | "text";
    lines?: number;
    class?: string;
  } = $props();
</script>

{#if lines > 1}
  <div class={cn("ta-skeleton-lines", className)} aria-hidden="true">
    {#each Array.from({ length: lines }) as _, i (i)}
      <div class="ta-skeleton ta-skeleton--text" style:width={i === lines - 1 ? "60%" : "100%"} style:height></div>
    {/each}
  </div>
{:else}
  <div
    class={cn("ta-skeleton", `ta-skeleton--${shape}`, className)}
    style:width={shape === "circle" ? height : width}
    style:height
    aria-hidden="true"
  ></div>
{/if}

<style>
  .ta-skeleton {
    background: linear-gradient(90deg, rgb(var(--ta-elevated)) 25%, rgb(var(--ta-muted) / 0.6) 50%, rgb(var(--ta-elevated)) 75%);
    background-size: 200% 100%;
    animation: ta-skeleton-shimmer 1.4s ease-in-out infinite;
  }

  .ta-skeleton--rect { border-radius: var(--ta-radius); }
  .ta-skeleton--text { border-radius: var(--ta-radius-sm); }
  .ta-skeleton--circle { border-radius: 9999px; flex-shrink: 0; }

  .ta-skeleton-lines { display: flex; flex-direction: column; gap: 0.5rem; }

  @keyframes ta-skeleton-shimmer {
    from { background-position: 200% 0; }
    to { background-position: -200% 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-skeleton { animation: none; }
  }
</style>

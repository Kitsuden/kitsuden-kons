<script lang="ts">
  import { cn } from "$lib/utils";
  interface Props {
    /** Heading level: whichever fits the page that uses it (h3 by default). */
    level?: 1 | 2 | 3 | 4 | 5 | 6;
    class?: string;
    children?: import("svelte").Snippet;
  }
  const { level = 3, class: className = "", children }: Props = $props();
</script>

<svelte:element this={`h${level}`} class={cn("ta-card-title", className)}>
  {@render children?.()}
</svelte:element>

<style>
  .ta-card-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: rgb(var(--ta-text));
  }
</style>

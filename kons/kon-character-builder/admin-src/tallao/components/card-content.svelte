<script lang="ts">
  import { cn } from "$lib/utils";
  interface Props {
    class?: string;
    children?: import("svelte").Snippet;
  }
  const { class: className = "", children }: Props = $props();
</script>

<div class={cn("ta-card-content", className)}>
  {@render children?.()}
</div>

<style>
  .ta-card-content {
    padding: 1rem 1.5rem;
  }
</style>

<!--
  tallao — CardHeader / CardTitle / CardContent / CardFooter
  Parts of Card, composable as snippets or subcomponents.
-->
<script lang="ts">
  import { cn } from "$lib/utils";
  interface Props {
    class?: string;
    children?: import("svelte").Snippet;
  }
  const { class: className = "", children }: Props = $props();
</script>

<div class={cn("ta-card-header", className)}>
  {@render children?.()}
</div>

<style>
  .ta-card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid rgb(var(--ta-border));
  }
</style>

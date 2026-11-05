<!--
  tallao — Card
  Styled container for content, with optional parts.
-->
<script lang="ts" module>
  export interface CardProps {
    class?: string;
    children?: import("svelte").Snippet;
  }
</script>

<script lang="ts">
  import { cn } from "$lib/utils";
  const { class: className = "", children }: CardProps = $props();
</script>

<div class={cn("ta-card", className)}>
  {@render children?.()}
</div>

<style>
  .ta-card {
    background: rgb(var(--ta-surface) / 0.5);
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
  }
</style>

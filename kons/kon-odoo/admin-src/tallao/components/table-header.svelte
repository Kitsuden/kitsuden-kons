<script lang="ts">
  import { cn } from "$lib/utils";
  interface Props {
    class?: string;
    children?: import("svelte").Snippet;
    /** Any other attribute (id, style, data-*…) goes to the <thead>. */
    [key: string]: unknown;
  }
  const { class: className = "", children, ...rest }: Props = $props();
</script>

<thead {...rest} class={cn("ta-table-head", className)}>
  {@render children?.()}
</thead>

<style>
  .ta-table-head {
    background: rgb(var(--ta-elevated) / 0.4);
  }
</style>

<script lang="ts">
  import { cn } from "$lib/utils";
  interface Props {
    class?: string;
    children?: import("svelte").Snippet;
    /** Any other attribute (id, style, data-*…) goes to the <tbody>. */
    [key: string]: unknown;
  }
  const { class: className = "", children, ...rest }: Props = $props();
</script>

<tbody {...rest} class={cn("ta-table-body", className)}>
  {@render children?.()}
</tbody>

<style>
  .ta-table-body {
    background: rgb(var(--ta-bg) / 0.3);
  }
</style>

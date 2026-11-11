<script lang="ts">
  import { fade } from "$lib/motion";
  import { cn } from "$lib/utils";
  interface Props {
    class?: string;
    /** Asked when the row is removed: `true` fades it out first (DataTable uses it). */
    exit?: () => boolean;
    children?: import("svelte").Snippet;
    /** Any other attribute (title, data-*, events) goes to the <tr>. */
    [key: string]: unknown;
  }
  const { class: className = "", exit, children, ...rest }: Props = $props();
  const leave = (node: Element) => (exit?.() ? fade(node, { duration: "fast" }) : { duration: 0 });
</script>

<tr {...rest} class={cn("ta-table-row", className)} out:leave|global>
  {@render children?.()}
</tr>

<style>
  .ta-table-row {
    border-bottom: 1px solid rgb(var(--ta-border));
    transition: background-color 0.15s;
  }
  .ta-table-row:last-child {
    border-bottom: none;
  }
  .ta-table-row:hover {
    background: rgb(var(--ta-elevated) / 0.35);
  }
</style>

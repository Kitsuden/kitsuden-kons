<script lang="ts">
  import { cn } from "$lib/utils";
  interface Props {
    class?: string;
    /** For a row that spans the whole table (e.g. "no results"). */
    colspan?: number;
    children?: import("svelte").Snippet;
    /** Any other attribute (title, data-*, headers…) goes to the <td>. */
    [key: string]: unknown;
  }
  const { class: className = "", colspan, children, ...rest }: Props = $props();
</script>

<td {...rest} class={cn("ta-table-td", className)} {colspan}>
  {@render children?.()}
</td>

<style>
  .ta-table-td {
    padding: 0.75rem 1rem;
    color: rgb(var(--ta-text));
    vertical-align: middle;
  }
</style>

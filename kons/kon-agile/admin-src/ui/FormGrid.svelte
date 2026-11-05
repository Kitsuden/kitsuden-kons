<!-- Fields of a form side by side, one column on a narrow screen. -->
<script lang="ts">
  import type { Snippet } from "svelte";

  const { children, columns = 2 }: { children: Snippet; columns?: number } = $props();
</script>

<div class="grid" style:--columns={columns}>{@render children()}</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(var(--columns), minmax(0, 1fr));
    gap: 0.75rem 1rem;
    align-items: start;
  }

  .grid :global(.wide) {
    grid-column: 1 / -1;
  }

  @media (max-width: 640px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>

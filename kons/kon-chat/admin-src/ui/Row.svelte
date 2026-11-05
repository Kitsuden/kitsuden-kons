<!-- Controls side by side that wrap on a narrow screen: a form on one line under a table. -->
<script lang="ts">
  import type { Snippet } from "svelte";

  const { children }: { children: Snippet } = $props();
</script>

<div class="row">{@render children()}</div>

<style>
  .row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
    margin: 0.5rem 0;
  }

  .row > :global(.ta-input),
  .row > :global(.ta-select) {
    width: auto;
    flex: 1 1 9rem;
    min-width: 9rem;
  }
</style>

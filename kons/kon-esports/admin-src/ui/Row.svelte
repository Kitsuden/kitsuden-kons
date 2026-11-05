<!-- Controls side by side, wrapping on a narrow screen. -->
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
  }

  /* Controls of a row take their own width, not the full row a form field takes. */
  .row > :global(.ta-input),
  .row > :global(.ta-select) {
    width: auto;
  }
</style>

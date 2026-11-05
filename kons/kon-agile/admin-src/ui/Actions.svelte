<!-- Buttons at the end of a table row. -->
<script lang="ts">
  import type { Snippet } from "svelte";

  const { children }: { children: Snippet } = $props();
</script>

<div class="actions">{@render children()}</div>

<style>
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.25rem;
    flex-wrap: wrap;
  }
</style>

<!-- A card with a title, optional actions on the right and its content. -->
<script lang="ts">
  import { Card, CardContent, CardHeader, CardTitle } from "$lib/components";
  import type { Snippet } from "svelte";

  const { title, actions, children }: { title: string; actions?: Snippet; children: Snippet } = $props();
</script>

<Card>
  <CardHeader>
    <CardTitle>{title}</CardTitle>
    {#if actions}<div class="actions">{@render actions()}</div>{/if}
  </CardHeader>
  <CardContent>
    {@render children()}
  </CardContent>
</Card>

<style>
  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  /* Filters in the header take their own width, not the full row a form field takes. */
  .actions :global(.ta-select) {
    width: auto;
    min-width: 9rem;
  }
</style>

<!-- A block of the booth: a small uppercase title and its content. -->
<script lang="ts">
  import { Card, CardContent } from "$lib/components";
  import type { Snippet } from "svelte";

  const { title, children }: { title: string; children: Snippet } = $props();
</script>

<Card>
  <CardContent class="broadcast-panel">
    <h3>{title}</h3>
    {@render children()}
  </CardContent>
</Card>

<style>
  :global(.broadcast-panel) {
    display: grid;
    gap: 0.625rem;
  }

  h3 {
    margin: 0;
    font-size: 0.6875rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 600;
    color: rgb(var(--ta-text-dim));
  }
</style>

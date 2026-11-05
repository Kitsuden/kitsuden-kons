<!--
  A section of the booth: a card with its title and, beside it, a short state ("OPEN", "3 phase(s)").
  `off` greys it out and makes it inert: without a tournament there is nothing to operate, and an
  active button that cannot act is the trap this panel once had.
-->
<script lang="ts">
  import { Card, CardContent, CardHeader, CardTitle } from "$lib/components";
  import type { Snippet } from "svelte";

  const {
    title,
    off = false,
    meta,
    children,
  }: { title: string; off?: boolean; meta?: Snippet; children: Snippet } = $props();
</script>

<section class="section" class:off inert={off} aria-label={title}>
  <Card>
    <CardHeader>
      <CardTitle>{title}</CardTitle>
      {#if meta}<div class="meta">{@render meta()}</div>{/if}
    </CardHeader>
    <CardContent>
      <div class="body">{@render children()}</div>
    </CardContent>
  </Card>
</section>

<style>
  .section.off {
    opacity: 0.45;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
</style>

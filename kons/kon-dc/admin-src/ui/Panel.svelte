<!--
  A section of the view: a card with its title (an h2: the panel draws the page's h1), what it is
  for in one quiet line, its actions on the right with the primary one last, and its content.
  `footer` is where a form's SaveBar goes.
-->
<script lang="ts">
  import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "$lib/components";
  import type { Snippet } from "svelte";

  const {
    title,
    description,
    status,
    actions,
    footer,
    children,
  }: {
    title: string;
    description?: string;
    /** Next to the title: a Badge with a count or a state. */
    status?: Snippet;
    actions?: Snippet;
    footer?: Snippet;
    children: Snippet;
  } = $props();
</script>

<Card>
  <CardHeader class="panel-header">
    <div class="heading">
      <div class="title">
        <CardTitle level={2}>{title}</CardTitle>
        {#if status}{@render status()}{/if}
      </div>
      {#if description}<p class="description">{description}</p>{/if}
    </div>
    {#if actions}<div class="actions">{@render actions()}</div>{/if}
  </CardHeader>
  <CardContent>
    <div class="body">{@render children()}</div>
  </CardContent>
  {#if footer}<CardFooter class="panel-footer">{@render footer()}</CardFooter>{/if}
</Card>

<style>
  :global(.ta-card-header.panel-header) {
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.5rem 1rem;
  }

  .heading {
    flex: 1 1 14rem;
    min-width: 0;
  }

  .title {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .description {
    margin: 0.25rem 0 0;
    max-width: 72ch;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

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

  .body {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 0;
  }

  .body > :global(*) {
    min-width: 0;
    max-width: 100%;
  }

  /* A SaveBar that ends a section's form: the section's gap is its distance, not its own margin. */
  .body :global(.ta-save-bar) {
    margin-top: 0;
  }

  /* A SaveBar brings its own layout: the footer only gives it the card's padding. */
  :global(.ta-card-footer.panel-footer) {
    display: block;
  }

  @media (max-width: 480px) {
    :global(.ta-card-header.panel-header),
    :global(.ta-card-footer.panel-footer) {
      padding-inline: 1rem;
    }
  }
</style>

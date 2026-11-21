<!--
  tallao — PageHeader
  The top of a page, the same on every page: where you are, what this is, what you can do.

    <PageHeader title="Posts" description="Everything published on the site.">
      {#snippet breadcrumb()}<Breadcrumb items={trail} />{/snippet}
      {#snippet status()}<Badge variant="success" dot>Published</Badge>{/snippet}
      {#snippet meta()}Updated 2 hours ago by Ana{/snippet}
      {#snippet actions()}<Button variant="secondary">Export</Button><Button>New post</Button>{/snippet}
      {#snippet tabs()}<Tabs panels={false} items={sections} bind:value={section} />{/snippet}
    </PageHeader>

  - The title is a heading (`level`, h1 by default). The root is a plain `<div>`, not a
    `<header>`: outside `<main>` that would be a second page banner. The breadcrumb sits
    above it, the status badge next to it, the meta line and the description under it.
  - `actions` is right-aligned on the title's row, the primary action last; when the header
    is narrow (its own width, not the window's) the actions drop under the title and wrap.
  - The title row has one minimum height whether there are actions or not, and the header
    ends with one bottom margin (`--ta-page-header-gap`, 1.5rem), so the content of every
    page starts at the same place.
  - `tabs` goes under everything, on the header's bottom rule. `divider={false}` drops the rule.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  import { cn } from "$lib/utils";

  interface Props {
    title: string;
    /** Heading level of the title. */
    level?: 1 | 2 | 3 | 4 | 5 | 6;
    description?: string;
    /** A rule under the header (or under the tabs). */
    divider?: boolean;
    class?: string;
    /** Above the title: a Breadcrumb, or a "back" link. */
    breadcrumb?: Snippet;
    /** Next to the title: a status Badge. */
    status?: Snippet;
    /** A quiet line under the title: who, when, an id. */
    meta?: Snippet;
    /** The page's actions, right-aligned; the primary one last. */
    actions?: Snippet;
    /** Tabs (with `panels={false}`) or another sub-navigation, under the header. */
    tabs?: Snippet;
    /** Richer content in place of `description`. */
    children?: Snippet;
    /** Any other attribute goes to the root element. */
    [key: string]: unknown;
  }

  const {
    title,
    level = 1,
    description,
    divider = true,
    class: className = "",
    breadcrumb,
    status,
    meta,
    actions,
    tabs,
    children,
    ...rest
  }: Props = $props();
</script>

<div {...rest} class={cn("ta-page-header", divider && "ta-page-header--divider", tabs && "ta-page-header--tabs", className)}>
  {#if breadcrumb}<div class="ta-page-header-trail">{@render breadcrumb()}</div>{/if}
  <div class="ta-page-header-row">
    <div class="ta-page-header-main">
      <div class="ta-page-header-heading">
        <svelte:element this={`h${level}`} class="ta-page-header-title">{title}</svelte:element>
        {#if status}<span class="ta-page-header-status">{@render status()}</span>{/if}
      </div>
      {#if meta}<p class="ta-page-header-meta">{@render meta()}</p>{/if}
      {#if children}
        <div class="ta-page-header-text">{@render children()}</div>
      {:else if description}
        <p class="ta-page-header-text">{description}</p>
      {/if}
    </div>
    {#if actions}<div class="ta-page-header-actions">{@render actions()}</div>{/if}
  </div>
  {#if tabs}<div class="ta-page-header-tabs">{@render tabs()}</div>{/if}
</div>

<style>
  .ta-page-header {
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
    margin-bottom: var(--ta-page-header-gap, 1.5rem);
    color: rgb(var(--ta-text));
  }
  .ta-page-header--divider { padding-bottom: 1rem; border-bottom: 1px solid rgb(var(--ta-border)); }
  /* With tabs, the tabs' own rule closes the header. */
  .ta-page-header--tabs { padding-bottom: 0; border-bottom: none; }

  .ta-page-header-trail { min-width: 0; font-size: 0.8125rem; }

  .ta-page-header-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem 1.5rem;
    min-width: 0;
  }

  .ta-page-header-main { flex: 1 1 auto; min-width: 0; }

  /* One height with or without actions: the height of a medium Button. */
  .ta-page-header-heading {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    min-height: 2.375rem;
  }

  .ta-page-header-title {
    margin: 0;
    min-width: 0;
    font-size: 1.5rem;
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: -0.015em;
    overflow-wrap: anywhere;
  }

  .ta-page-header-status { display: inline-flex; align-items: center; gap: 0.375rem; }

  .ta-page-header-meta {
    margin: 0.125rem 0 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .ta-page-header-text {
    margin: 0.25rem 0 0;
    max-width: 44rem;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }

  .ta-page-header-actions {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 0.5rem;
    min-height: 2.375rem;
  }

  .ta-page-header-tabs { min-width: 0; margin-top: 0.25rem; }

  /* Narrow header: the actions go under the title, left-aligned, and wrap. */
  @container (max-width: 36rem) {
    .ta-page-header-row { flex-direction: column; align-items: stretch; }
    .ta-page-header-actions { justify-content: flex-start; }
    .ta-page-header-title { font-size: 1.25rem; }
  }
</style>

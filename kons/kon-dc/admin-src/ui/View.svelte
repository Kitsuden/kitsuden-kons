<!--
  The frame of an admin view: the theme scope, the sections one under another with one gap, and
  the Toaster every result of an action goes to.

  The panel draws the page title and the breadcrumb above a kon's view, so a view starts at its
  sections: each is a Panel whose title is an h2, and headings inside a section are h3.
-->
<script lang="ts">
  import { ThemeScope, Toaster } from "$lib/components";
  import type { Snippet } from "svelte";

  const { children }: { children: Snippet } = $props();
</script>

<ThemeScope class="kon-view">
  {@render children()}
  <Toaster />
</ThemeScope>

<style>
  :global(.kon-view) {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 0;
    /* The pinned actions column of a DataTable sits on a card here, not on the page. */
    --ta-table-sticky-bg: rgb(var(--ta-surface));
  }

  /* A section never widens the page: what is too wide for it (a table) scrolls inside it. */
  :global(.kon-view > *) {
    min-width: 0;
    max-width: 100%;
  }

  /* A field inside a table cell keeps a width it can be read at; the table scrolls sideways. */
  :global(.kon-view .ta-table td .ta-input),
  :global(.kon-view .ta-table td .ta-select) {
    min-width: 6.5rem;
  }
  :global(.kon-view .ta-table td .ta-input[type="number"]) {
    min-width: 4.5rem;
  }
</style>

<!--
  A short form inside a section (the "add one" under a table): labelled fields in a grid that
  wraps to one column on a narrow screen, and its buttons at the end with the primary one last.
  Enter in a field submits it.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  const {
    label,
    onsubmit,
    actions,
    children,
  }: {
    /** Accessible name of the form ("Add a rule"). */
    label: string;
    onsubmit?: () => void;
    actions?: Snippet;
    children: Snippet;
  } = $props();
</script>

<form
  class="form-grid"
  aria-label={label}
  onsubmit={(e) => {
    e.preventDefault();
    onsubmit?.();
  }}
>
  <div class="fields">{@render children()}</div>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</form>

<style>
  .form-grid {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  /* Fields share a row and fill it; on a narrow screen each takes the whole row. */
  .fields {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: flex-end;
  }

  .fields > :global(*) {
    flex: 1 1 11rem;
    min-width: min(100%, 11rem);
  }

  /* A field that needs the whole row (a textarea, a long text). */
  .fields > :global(.wide) {
    flex-basis: 100%;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>

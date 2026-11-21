<!--
  What a section shows around content it loads (a form, a board, a list that is not a
  DataTable): a skeleton while it loads, the error with Retry when the load failed, an empty
  state with the next action when there is nothing, and the content otherwise.
-->
<script lang="ts">
  import { EmptyState, Skeleton } from "$lib/components";
  import type { Snippet } from "svelte";

  import type { Load } from "./load.svelte";

  const {
    load,
    empty = false,
    emptyTitle,
    emptyDescription,
    actionLabel,
    onAction,
    errorTitle,
    lines = 4,
    skeleton,
    children,
  }: {
    load: Load;
    /** Loaded, and there is nothing to show. */
    empty?: boolean;
    emptyTitle?: string;
    emptyDescription?: string;
    /** The action that creates the first item. */
    actionLabel?: string;
    onAction?: () => void;
    errorTitle?: string;
    /** Lines of the default skeleton. */
    lines?: number;
    /** A skeleton shaped like the content, instead of lines. */
    skeleton?: Snippet;
    children: Snippet;
  } = $props();
</script>

{#if load.loading}
  <div class="loading" aria-busy="true">
    <span class="sr-only" role="status">Loading</span>
    {#if skeleton}{@render skeleton()}{:else}<Skeleton {lines} />{/if}
  </div>
{:else if load.error !== null}
  <EmptyState
    variant="error"
    size="sm"
    level={3}
    title={errorTitle}
    description={load.error}
    onRetry={load.load}
    retrying={load.retrying}
  />
{:else if empty}
  <EmptyState size="sm" level={3} title={emptyTitle} description={emptyDescription} {actionLabel} {onAction} />
{:else}
  {@render children()}
{/if}

<style>
  .loading {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
</style>

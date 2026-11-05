<!-- One comment of the queue: its mark for the batch, who and where, the body and its actions. -->
<script lang="ts">
  import { Button, Checkbox } from "$lib/components";

  import { author, link, when } from "../format";
  import type { QueueRow, Status } from "../types";

  const {
    row,
    marked,
    busy,
    onMark,
    onModerate,
    onDelete,
  }: {
    row: QueueRow;
    marked: boolean;
    busy: boolean;
    onMark: (on: boolean) => void;
    onModerate: (status: Status) => void;
    onDelete: () => void;
  } = $props();

  const name = $derived(author(row.authorName));
</script>

<li class="item" class:marked>
  <Checkbox
    checked={marked}
    ariaLabel={`Select the comment by ${name}`}
    onchange={(e: Event) => onMark((e.currentTarget as HTMLInputElement).checked)}
  />

  <div class="content">
    <div class="meta">
      <span class="author">{name}</span>
      {#if when(row.createdAt)}<time datetime={row.createdAt}>{when(row.createdAt)}</time>{/if}
      {#if row.subject}
        <span>on <a href={link(row.subjectType, row.subject.slug)} target="_blank" rel="noreferrer">{row.subject.title}</a></span>
      {:else}
        <!-- Informative, not a failure: it is a legitimate reason to delete it. -->
        <span class="orphan">the content it hung from no longer exists</span>
      {/if}
    </div>
    <p class="body">{row.body}</p>
  </div>

  <div class="actions">
    {#if row.status !== "published"}
      <Button size="sm" variant="secondary" disabled={busy} ariaLabel={`Approve the comment by ${name}`} onclick={() => onModerate("published")}>Approve</Button>
    {/if}
    {#if row.status !== "hidden"}
      <Button size="sm" variant="secondary" disabled={busy} ariaLabel={`Hide the comment by ${name}`} onclick={() => onModerate("hidden")}>Hide</Button>
    {/if}
    <Button size="sm" variant="danger" disabled={busy} ariaLabel={`Delete the comment by ${name}`} onclick={onDelete}>Delete</Button>
  </div>
</li>

<style>
  .item {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 0.625rem;
    align-items: start;
    padding: 0.625rem 0.75rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    background: rgb(var(--ta-bg));
  }

  .item.marked {
    border-color: rgb(var(--ta-accent));
  }

  .item :global(.ta-checkbox) {
    padding-top: 0.125rem;
  }

  .meta {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: baseline;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .author {
    font-weight: 600;
    color: rgb(var(--ta-text));
  }

  .meta a {
    color: rgb(var(--ta-accent-hover));
  }

  .orphan {
    color: rgb(var(--ta-danger));
  }

  .body {
    margin: 0.3rem 0 0;
    font-size: 0.875rem;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: rgb(var(--ta-text));
  }

  .actions {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  @media (max-width: 640px) {
    .item {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .actions {
      grid-column: 2;
      justify-content: flex-start;
    }
  }
</style>

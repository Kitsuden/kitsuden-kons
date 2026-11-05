<svelte:options
  customElement={{
    tag: "comments-moderation",
    shadow: "open",
    props: { context: { type: "Object" }, params: { type: "Object" } },
  }}
/>

<!--
  <comments-moderation>: the comment moderation queue.

  `kon-comments` had `GET /moderation/queue` and `POST /:id/moderate` from the start, and the
  panel did not use them: moderating meant editing the `status` column by hand in a table grid,
  copying a `subject_id` to find which article a comment belonged to.

  It lives in the comments kon and not the blog one because the queue is CROSS-CUTTING: a
  moderator wants a single inbox with everything pending — from articles, pages, whatever comes.
  A queue per kon splits a spam streak across several screens, which is the easiest way for half
  of it to go unreviewed.

  The admin mounts it with `context` ({ apiBase, theme, locale… }); calls go to the kon's REST
  routes with the browser's cookies, never a token. The theme comes from the admin's
  `--kitsuden-*` variables through tallao's ThemeScope.
-->
<script lang="ts">
  import {
    Alert,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    ConfirmDialog,
    SelectionBar,
    Tabs,
    ThemeScope,
  } from "$lib/components";

  import { createApi } from "./api";
  import { author } from "./format";
  import { Queue, STATUSES } from "./store.svelte";
  import type { QueueRow, Status } from "./types";
  import CommentItem from "./ui/CommentItem.svelte";

  interface ViewContext {
    apiBase?: string;
    theme?: "light" | "dark";
    locale?: string;
  }

  let { context, params }: { context?: ViewContext; params?: unknown } = $props();

  const q = new Queue(createApi(() => `${context?.apiBase || "/api"}/comments`));

  // The host may set `context` before or after connecting, and again when the theme changes:
  // load once per API base.
  let loadedBase: string | null = null;
  $effect(() => {
    const base = context?.apiBase || "/api";
    if (base === loadedBase) return;
    loadedBase = base;
    void q.load();
  });

  const tabs = $derived(STATUSES.map((s) => ({ id: s.id, label: s.label, count: q.counts[s.id] ?? 0 })));

  /** The comment waiting for the delete confirmation. */
  let deleting = $state<QueueRow | null>(null);
  let confirmOpen = $state(false);
  let deleteError = $state<string | null>(null);

  function askDelete(row: QueueRow) {
    deleting = row;
    deleteError = null;
    confirmOpen = true;
  }

  async function confirmDelete() {
    if (!deleting) return;
    deleteError = null;
    try {
      await q.remove(deleting.id);
    } catch (e) {
      deleteError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }
</script>

<ThemeScope class="comments-admin">
  <Card>
    <CardHeader>
      <CardTitle>Moderation</CardTitle>
      <div class="head-actions">
        <span class="outcome" role="status">{q.outcome ?? ""}</span>
        <Button size="sm" variant="secondary" onclick={() => void q.load()}>Reload</Button>
      </div>
    </CardHeader>
    <CardContent>
      <Tabs
        items={tabs}
        bind:value={q.status}
        ariaLabel="Moderation state"
        onchange={(id) => q.show(id as Status)}
      >
        {#snippet children(active)}
          <div class="panel">
            {#if q.error}
              <Alert variant="error" dismissLabel="Dismiss" onDismiss={() => (q.error = null)}>{q.error}</Alert>
            {/if}

            {#if q.rows.length > 0}
              <SelectionBar
                total={q.rows.length}
                selected={q.marked.size}
                onToggleAll={(on) => q.toggleAll(on)}
                ariaLabel="Batch moderation"
              >
                {#snippet actions()}
                  <Button size="sm" variant="secondary" disabled={q.busy} onclick={() => q.bulk("published")}>Approve</Button>
                  <Button size="sm" variant="secondary" disabled={q.busy} onclick={() => q.bulk("hidden")}>Hide</Button>
                  <Button size="sm" variant="secondary" disabled={q.busy} onclick={() => q.bulk("pending")}>Return to pending</Button>
                {/snippet}
              </SelectionBar>

              <ul class="list">
                {#each q.rows as row (row.id)}
                  <CommentItem
                    {row}
                    marked={q.marked.has(row.id)}
                    busy={q.busy}
                    onMark={(on) => q.toggle(row.id, on)}
                    onModerate={(status) => q.moderate(row.id, status)}
                    onDelete={() => askDelete(row)}
                  />
                {/each}
              </ul>
            {:else if q.loaded}
              <p class="empty">
                {active === "pending" ? "Nothing is waiting for moderation." : "There are no comments in this state."}
              </p>
            {/if}
          </div>
        {/snippet}
      </Tabs>
    </CardContent>
  </Card>

  <ConfirmDialog
    bind:open={confirmOpen}
    title="Delete comment"
    description={`Really delete the comment by ${author(deleting?.authorName)}? Hiding is almost always better: deleting also takes its replies, which belong to other people.`}
    confirmLabel="Delete"
    cancelLabel="Cancel"
    closeLabel="Close"
    onConfirm={confirmDelete}
  >
    {#if deleteError}
      <Alert variant="error">{deleteError}</Alert>
    {/if}
  </ConfirmDialog>
</ThemeScope>

<style>
  :host {
    display: block;
  }

  :global(.comments-admin) {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .head-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .outcome {
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .list {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .empty {
    margin: 0;
    padding: 1.25rem 0;
    text-align: center;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }
</style>

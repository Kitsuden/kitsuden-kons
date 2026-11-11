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
  `--kitsuden-*` variables through tallao's ThemeScope (ui/View.svelte), which also holds the
  Toaster every result of an action goes to.
-->
<script lang="ts">
  import { Button, ConfirmDialog, SelectionBar, Skeleton, Tabs } from "$lib/components";

  import { createApi } from "./api";
  import { author } from "./format";
  import { Queue, STATUSES } from "./store.svelte";
  import type { QueueRow, Status } from "./types";
  import CommentItem from "./ui/CommentItem.svelte";
  import { CANCEL, CLOSE } from "./ui/labels";
  import Loadable from "./ui/Loadable.svelte";
  import { failed, toast } from "./ui/notify";
  import Panel from "./ui/Panel.svelte";
  import View from "./ui/View.svelte";

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

  const EMPTY: Record<Status, { title: string; description: string }> = {
    pending: { title: "No comments waiting", description: "There is nothing to moderate. New comments arrive here." },
    published: { title: "No published comments", description: "A comment you approve is listed here." },
    hidden: { title: "No hidden comments", description: "A comment you hide is listed here and can be approved again." },
  };

  /** The comment waiting for the delete confirmation. */
  let deleting = $state<QueueRow | null>(null);
  let confirmOpen = $state(false);

  function askDelete(row: QueueRow) {
    deleting = row;
    confirmOpen = true;
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      const hidden = await q.remove(deleting.id);
      if (hidden) {
        toast.success("Hidden, not deleted", { description: "It has replies, so it stays in the thread without its text." });
      } else toast.success("Comment deleted");
    } catch (e) {
      failed("Could not delete the comment", e);
      throw e;
    }
  }
</script>

<View>
  <Panel title="Comments" description="From every article and page, newest first.">
    {#snippet actions()}
      <Button size="sm" variant="outline" onclick={() => void q.load()}>Reload</Button>
    {/snippet}
    <Tabs items={tabs} bind:value={q.status} ariaLabel="Moderation state" onchange={(id) => q.show(id as Status)}>
      {#snippet children(active)}
        {@const none = EMPTY[active as Status] ?? EMPTY.pending}
        <div class="queue">
          <Loadable
            load={q.state}
            empty={q.rows.length === 0}
            emptyTitle={none.title}
            emptyDescription={none.description}
            errorTitle="The comments did not load"
          >
            {#snippet skeleton()}
              {#each [0, 1, 2] as i (i)}
                <div class="ghost">
                  <Skeleton width="1.25rem" height="1.25rem" />
                  <Skeleton lines={2} />
                </div>
              {/each}
            {/snippet}
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
          </Loadable>
        </div>
      {/snippet}
    </Tabs>
  </Panel>

  <ConfirmDialog
    bind:open={confirmOpen}
    title={`Delete the comment by ${author(deleting?.authorName)}?`}
    description="It cannot be brought back. A comment that has replies is hidden instead, so the replies keep their thread."
    confirmLabel="Delete"
    cancelLabel={CANCEL}
    closeLabel={CLOSE}
    variant="danger"
    onConfirm={confirmDelete}
  />
</View>

<style>
  :host {
    display: block;
  }

  .queue {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
  }

  .list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ghost {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 0.75rem;
    align-items: start;
  }
</style>

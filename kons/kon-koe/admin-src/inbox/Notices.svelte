<!-- The bell: my notices (assignments, mentions, waiting conversations, closing windows), newest first. -->
<script lang="ts">
  import { Button, Popover } from "$lib/components";

  import { full, shortTime } from "./format";
  import type { Inbox } from "./store.svelte";
  import { T } from "./strings";

  const { inbox, onOpen }: { inbox: Inbox; onOpen: (id: string) => void } = $props();

  let open = $state(false);
  const unread = $derived(inbox.unreadNotices);

  function pick(id: string, conversationId: string | null) {
    open = false;
    void inbox.readNotices([id]);
    if (conversationId) onOpen(conversationId);
  }
</script>

<Popover bind:open title={T.notices} placement="bottom-end" onOpenChange={(o: boolean) => o && void inbox.loadNotices()}>
  {#snippet trigger(props)}
    <Button {...props} size="icon" variant="ghost" ariaLabel={unread ? `${T.notices} (${unread})` : T.notices} title={T.notices}>
      <span class="bell">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15l1.5-2zM10 20.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /></svg>
        {#if unread}<span class="dot" aria-hidden="true">{unread > 9 ? "9+" : unread}</span>{/if}
      </span>
    </Button>
  {/snippet}
  <div class="notices">
    {#if inbox.notices.length}
      <ul>
        {#each inbox.notices as n (n.id)}
          <li>
            <button type="button" class="notice" class:unread={!n.readAt} onclick={() => pick(n.id, n.conversationId)}>
              <span class="title">{n.title}</span>
              {#if n.body}<span class="body">{n.body}</span>{/if}
              <time title={full(n.createdAt)}>{shortTime(n.createdAt, inbox.now)}</time>
            </button>
          </li>
        {/each}
      </ul>
      {#if unread}
        <div class="foot"><Button size="sm" variant="ghost" onclick={() => void inbox.readNotices()}>{T.markAllRead}</Button></div>
      {/if}
    {:else}
      <p class="none">{T.noNotices}</p>
    {/if}
  </div>
</Popover>

<style>
  .bell {
    position: relative;
    display: inline-flex;
  }

  .dot {
    position: absolute;
    top: -0.45rem;
    right: -0.55rem;
    min-width: 1rem;
    height: 1rem;
    padding: 0 0.2rem;
    border-radius: 999px;
    background: rgb(var(--ta-danger));
    color: rgb(var(--ta-on-danger));
    font-size: 0.625rem;
    font-weight: 700;
    line-height: 1rem;
    text-align: center;
  }

  .notices {
    width: min(22rem, 85vw);
    max-height: 60vh;
    overflow-y: auto;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .notice {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.125rem 0.5rem;
    width: 100%;
    padding: 0.5rem;
    border: 0;
    border-radius: var(--ta-radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .notice:hover {
    background: rgb(var(--ta-elevated));
  }

  .notice:focus-visible {
    outline: 2px solid rgb(var(--ta-accent));
  }

  .unread .title {
    font-weight: 700;
  }

  .title {
    font-size: 0.8125rem;
  }

  .body {
    grid-column: 1;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  time {
    grid-column: 2;
    grid-row: 1;
    font-size: 0.6875rem;
    color: rgb(var(--ta-text-dim));
  }

  .foot {
    display: flex;
    justify-content: flex-end;
    padding-top: 0.25rem;
  }

  .none {
    margin: 0;
    padding: 0.5rem;
    color: rgb(var(--ta-text-dim));
  }
</style>

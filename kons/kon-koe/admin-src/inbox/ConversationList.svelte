<!--
  The list: filters by state with their counters, by team, channel and label, a search, and the
  conversations newest first with what needs attention on each (unread, SLA, closing window).
-->
<script lang="ts">
  import { Badge, Button, EmptyState, Input, Select, Skeleton } from "$lib/components";
  import { untrack } from "svelte";

  import type { Conversation } from "../types";
  import ChannelIcon from "./ChannelIcon.svelte";
  import { left, msLeft, shortTime, full } from "./format";
  import { FILTER_COUNT, FILTERS, type Filter, type Inbox } from "./store.svelte";
  import { T } from "./strings";

  let { inbox, onOpen, searchRef = $bindable() }: { inbox: Inbox; onOpen: (id: string) => void; searchRef?: HTMLInputElement } = $props();

  let search = $state(untrack(() => inbox.q));
  let label = $state(untrack(() => inbox.label));
  let timer: ReturnType<typeof setTimeout> | null = null;

  function typed() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      inbox.q = search;
      inbox.label = label;
      void inbox.loadList();
    }, 350);
  }

  function pick(f: Filter) {
    inbox.setFilter(f);
  }

  const name = (c: Conversation) => c.contact?.displayName || c.contact?.phone || c.contact?.email || T.noContactName;

  /** The service window, where the channel has one: time left, or closed. */
  function windowOf(c: Conversation, now: number): { text: string; tone: "ok" | "warn" | "closed" } | null {
    if (!c.window || c.channel?.kind === "webchat" || c.state === "resolved") return null;
    if (!c.window.open) return { text: T.windowClosed, tone: "closed" };
    const l = left(c.window.expiresAt, now);
    if (!l) return null;
    return { text: l, tone: msLeft(c.window.expiresAt, now) < 2 * 3_600_000 ? "warn" : "ok" };
  }

  function sla(c: Conversation, now: number): "breached" | "soon" | null {
    if (c.state === "resolved") return null;
    if (c.slaBreached) return "breached";
    const due = msLeft(c.firstResponseDueAt, now);
    return c.firstResponseDueAt && due > 0 && due < 15 * 60_000 ? "soon" : null;
  }
</script>

<section class="list" aria-label={T.conversations}>
  <div class="filters">
    <div class="states" role="group" aria-label={T.conversations}>
      {#each FILTERS as f (f)}
        {@const key = FILTER_COUNT[f]}
        {@const n = key ? inbox.counts[key] ?? 0 : 0}
        <button type="button" class="state" aria-pressed={inbox.filter === f} onclick={() => pick(f)}>
          {T.filters[f]}
          {#if key && n > 0}<span class="count">{n > 99 ? "99+" : n}</span>{/if}
        </button>
      {/each}
    </div>
    <Input
      bind:ref={searchRef}
      bind:value={search}
      oninput={typed}
      type="search"
      placeholder={T.search}
      aria-label={T.search}
      aria-keyshortcuts="/"
      autocomplete="off"
    />
    <div class="selects">
      <Select
        size="sm"
        aria-label={T.allTeams}
        value={inbox.teamId}
        onchange={(e: Event) => {
          inbox.teamId = (e.currentTarget as HTMLSelectElement).value;
          void inbox.loadList();
        }}
        options={[{ value: "", label: T.allTeams }, ...inbox.teams.map((t) => ({ value: t.id, label: t.name }))]}
      />
      <Select
        size="sm"
        aria-label={T.allChannels}
        value={inbox.channelId}
        onchange={(e: Event) => {
          inbox.channelId = (e.currentTarget as HTMLSelectElement).value;
          void inbox.loadList();
        }}
        options={[{ value: "", label: T.allChannels }, ...inbox.channels.map((c) => ({ value: c.id, label: c.name }))]}
      />
      <Input bind:value={label} oninput={typed} placeholder={T.label} aria-label={T.label} autocomplete="off" class="label-filter" />
    </div>
  </div>

  <div class="items">
    {#if inbox.listLoad === "loading" && !inbox.list.length}
      <div class="pad" aria-busy="true"><span class="sr">{T.loading}</span><Skeleton lines={8} /></div>
    {:else if inbox.listLoad === "error" && !inbox.list.length}
      <EmptyState variant="error" size="sm" level={2} title={T.failedTitle} description={inbox.listError} onRetry={() => void inbox.loadList()} retryLabel={T.retry} />
    {:else if !inbox.list.length}
      <EmptyState size="sm" level={2} title={inbox.q || inbox.label ? T.noMatches : T.noConversations} />
    {:else}
      <ul>
        {#each inbox.list as c (c.id)}
          {@const w = windowOf(c, inbox.now)}
          {@const s = sla(c, inbox.now)}
          <li>
            <button
              type="button"
              class="item"
              class:open={inbox.openId === c.id}
              class:unread={c.unreadCount > 0}
              aria-current={inbox.openId === c.id ? "true" : undefined}
              data-conversation={c.id}
              onclick={() => onOpen(c.id)}
            >
              <span class="top">
                <ChannelIcon kind={c.channel?.kind} />
                <span class="name">{name(c)}</span>
                {#if c.priority === "urgent" || c.priority === "high"}
                  <span class="priority priority--{c.priority}" title={T.priority[c.priority]}>{T.priority[c.priority]}</span>
                {/if}
                <time class="time" datetime={c.lastMessageAt ?? undefined} title={full(c.lastMessageAt)}>{shortTime(c.lastMessageAt, inbox.now)}</time>
              </span>
              <span class="preview">{c.lastMessagePreview ?? ""}</span>
              <span class="meta">
                {#if inbox.filter === "open" || inbox.filter === "unassigned"}
                  <span class="chip">{T.states[c.state] ?? c.state}</span>
                {/if}
                {#if c.assigneeId && c.assigneeId !== inbox.me?.userId}
                  <span class="chip">{inbox.nameOf(c.assigneeId)}</span>
                {/if}
                {#each c.labels.slice(0, 2) as l (l)}<span class="chip chip--label">{l}</span>{/each}
                {#if s === "breached"}
                  <Badge variant="error" size="sm">{T.slaBreached}</Badge>
                {:else if s === "soon"}
                  <Badge variant="warning" size="sm">{T.slaSoon}</Badge>
                {/if}
                {#if w}
                  <span class="window window--{w.tone}" title={w.tone === "closed" ? T.windowClosed : T.windowLeft(w.text)}>
                    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
                    <span class="sr">{w.tone === "closed" ? T.windowClosed : T.windowLeft(w.text)}</span>
                    <span aria-hidden="true">{w.text}</span>
                  </span>
                {/if}
                {#if c.unreadCount > 0}
                  <span class="unread-count" title={T.unread(c.unreadCount)}>
                    <span class="sr">{T.unread(c.unreadCount)}</span>
                    <span aria-hidden="true">{c.unreadCount > 99 ? "99+" : c.unreadCount}</span>
                  </span>
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
      {#if inbox.next}
        <div class="pad">
          <Button variant="ghost" size="sm" loading={inbox.loadingMore} onclick={() => void inbox.loadMore()}>{T.loadMore}</Button>
        </div>
      {/if}
    {/if}
  </div>
</section>

<style>
  .list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }

  .filters {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    border-bottom: 1px solid rgb(var(--ta-border));
  }

  .states {
    display: flex;
    gap: 0.25rem;
    overflow-x: auto;
    scrollbar-width: thin;
    padding-bottom: 0.125rem;
  }

  .state {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
    min-height: 2rem;
    padding: 0.25rem 0.625rem;
    border: 1px solid transparent;
    border-radius: 999px;
    background: none;
    color: rgb(var(--ta-text-dim));
    font: inherit;
    font-size: 0.8125rem;
    cursor: pointer;
  }

  .state:hover {
    background: rgb(var(--ta-elevated));
    color: rgb(var(--ta-text));
  }

  .state[aria-pressed="true"] {
    border-color: rgb(var(--ta-accent) / 0.5);
    background: rgb(var(--ta-accent) / 0.12);
    color: rgb(var(--ta-text));
    font-weight: 600;
  }

  .state:focus-visible,
  .item:focus-visible {
    outline: 2px solid rgb(var(--ta-accent));
    outline-offset: -2px;
  }

  .count {
    min-width: 1.25rem;
    padding: 0 0.3rem;
    border-radius: 999px;
    background: rgb(var(--ta-elevated));
    font-size: 0.6875rem;
    text-align: center;
  }

  .selects {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 0.375rem;
  }

  .selects :global(.ta-input) {
    padding-block: 0.3rem;
    font-size: 0.8125rem;
  }

  .items {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    width: 100%;
    padding: 0.625rem 0.75rem;
    border: 0;
    border-bottom: 1px solid rgb(var(--ta-border));
    border-left: 3px solid transparent;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .item:hover {
    background: rgb(var(--ta-elevated) / 0.6);
  }

  .item.open {
    border-left-color: rgb(var(--ta-accent));
    background: rgb(var(--ta-accent) / 0.08);
  }

  .top {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .unread .name {
    font-weight: 700;
  }

  .time {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .unread .preview {
    color: rgb(var(--ta-text));
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
    min-height: 1.25rem;
  }

  .chip {
    padding: 0 0.4rem;
    border-radius: var(--ta-radius-sm);
    background: rgb(var(--ta-elevated));
    font-size: 0.6875rem;
    color: rgb(var(--ta-text-dim));
  }

  .chip--label {
    color: rgb(var(--ta-info));
  }

  .priority {
    flex-shrink: 0;
    font-size: 0.6875rem;
    font-weight: 600;
  }

  .priority--urgent {
    color: rgb(var(--ta-danger));
  }

  .priority--high {
    color: rgb(var(--ta-warning));
  }

  .window {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.6875rem;
    color: rgb(var(--ta-text-dim));
  }

  .window--warn {
    color: rgb(var(--ta-warning));
    font-weight: 600;
  }

  .window--closed {
    color: rgb(var(--ta-danger));
  }

  .unread-count {
    margin-left: auto;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--ta-accent-fill, rgb(var(--ta-accent)));
    color: rgb(var(--ta-on-accent));
    font-size: 0.6875rem;
    font-weight: 700;
    line-height: 1.25rem;
    text-align: center;
  }

  .pad {
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .sr {
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

<!--
  The open conversation: who it is with and who has it, what can be done with it (take, assign, release,
  snooze, resolve, transfer, back to the bot, a copilot summary), its messages with notes and history in
  the same line of time, a warning when someone else is writing, and the composer.
-->
<script lang="ts">
  import { Alert, Badge, Button, DropdownMenu, EmptyState, MenuItem, MenuLabel, MenuSeparator, Skeleton } from "$lib/components";
  import { tick } from "svelte";

  import { ApiError, seg } from "../api";
  import type { Message } from "../types";
  import ChannelIcon from "./ChannelIcon.svelte";
  import Composer from "./Composer.svelte";
  import { clock, dayLabel, full, left, newKey } from "./format";
  import MessageBubble from "./MessageBubble.svelte";
  import { timeline, type Inbox } from "./store.svelte";
  import { T } from "./strings";

  let {
    inbox,
    contactShown,
    onBack,
    onToggleContact,
    onToast,
    textarea = $bindable(),
  }: {
    inbox: Inbox;
    contactShown: boolean;
    onBack: () => void;
    onToggleContact: () => void;
    onToast: (kind: "success" | "error" | "info", title: string, description?: string) => void;
    textarea?: HTMLTextAreaElement;
  } = $props();

  let history = $state(true);
  let replyTo = $state<Message | null>(null);
  let mode = $state<"reply" | "note">("reply");
  let scroller = $state<HTMLElement>();
  let busy = $state<string | null>(null);
  let summary = $state<string | null>(null);

  const conv = $derived(inbox.current);
  const me = $derived(inbox.me?.userId ?? "");
  const items = $derived(timeline(inbox.messages, inbox.notes, inbox.events, history));
  const byId = $derived(new Map(inbox.messages.map((m) => [m.id, m])));
  const name = $derived(conv?.contact?.displayName || conv?.contact?.phone || conv?.contact?.email || T.noContactName);
  const mine = $derived(!!conv && conv.assigneeId === me && conv.state === "human");
  const lead = $derived(!!inbox.me?.lead);

  // Stay at the bottom while new things arrive, unless the person scrolled up to read.
  let stick = true;
  function onScroll() {
    if (!scroller) return;
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  }
  $effect(() => {
    void items.length;
    void inbox.openId;
    if (!stick) return;
    void tick().then(() => scroller && (scroller.scrollTop = scroller.scrollHeight));
  });
  $effect(() => {
    void inbox.openId;
    stick = true;
    replyTo = null;
    summary = null;
    mode = "reply";
  });

  async function act(action: Parameters<Inbox["act"]>[0], body: Record<string, unknown>, done: string) {
    busy = action;
    try {
      await inbox.act(action, body);
      onToast("success", done);
    } catch (e) {
      onToast("error", T.actionFailed, e instanceof Error ? e.message : String(e));
    } finally {
      busy = null;
    }
  }

  function snoozeUntil(option: string): string {
    const d = new Date();
    if (option === "1h") return new Date(Date.now() + 3_600_000).toISOString();
    if (option === "3h") return new Date(Date.now() + 3 * 3_600_000).toISOString();
    if (option === "tomorrow") d.setDate(d.getDate() + 1);
    else d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }

  async function react(m: Message, emoji: string) {
    try {
      await inbox.send({ kind: "reaction", reaction: { messageId: m.id, emoji }, idempotencyKey: newKey("react") });
    } catch (e) {
      onToast("error", T.sendFailed, e instanceof ApiError && e.koe ? T.sendErrors[e.koe] ?? e.message : e instanceof Error ? e.message : String(e));
    }
  }

  function reply(m: Message) {
    replyTo = m;
    mode = "reply";
    void tick().then(() => textarea?.focus());
  }

  function jump(id: string) {
    const el = scroller?.querySelector(`#msg-${CSS.escape(id)}`);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1200);
    }
  }

  async function summarize() {
    busy = "summary";
    try {
      const res = await inbox.api.post<{ data: { summary: string } }>(`conversations/${seg(inbox.openId!)}/copilot/summary`, {});
      summary = res.data.summary;
    } catch (e) {
      onToast("error", T.summary, e instanceof Error ? e.message : String(e));
    } finally {
      busy = null;
    }
  }

  /** Who did a history event, in words. */
  function eventText(e: (typeof inbox.events)[number]): string {
    const who = e.actorKind === "agent" ? inbox.nameOf(e.actorId) || T.authors.agent : T.authors[e.actorKind] ?? e.actorKind;
    if (e.type === "transfer") return T.event({ what: "moved", who, target: inbox.teamName(e.data?.to as string) || T.noTeam, reason: e.reason });
    const assignee = e.data?.assigneeId as string | undefined;
    if (e.toState === "human" && assignee) return T.event({ what: "assigned", who, target: inbox.nameOf(assignee), reason: e.reason });
    return T.event({ what: "state", who, state: e.toState ?? e.type, reason: e.reason });
  }

  const typingName = $derived(inbox.typing ? inbox.nameOf(inbox.typing.userId) : "");
</script>

<section class="thread" aria-label={conv ? name : T.pickConversation}>
  {#if !inbox.openId}
    <div class="empty">
      <EmptyState size="md" level={2} title={T.pickConversation} description={T.pickConversationBody} />
    </div>
  {:else}
    <header class="head">
      <Button variant="ghost" size="icon" class="back" ariaLabel={T.back} onclick={onBack}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </Button>
      <div class="who">
        <h2 class="name"><ChannelIcon kind={conv?.channel?.kind} />{name}</h2>
        {#if conv}
          <span class="sub">
            <Badge size="sm" variant={conv.state === "human" ? "success" : conv.state === "queued" ? "warning" : conv.state === "bot" ? "info" : "default"}>{T.states[conv.state]}</Badge>
            {#if conv.assigneeId}<span>{conv.assigneeId === me ? T.you : inbox.nameOf(conv.assigneeId)}</span>{/if}
            {#if conv.teamId}<span>· {inbox.teamName(conv.teamId)}</span>{/if}
            {#if conv.window && conv.channel?.kind !== "webchat"}
              {#if conv.window.open}
                <span class="window" title={full(conv.window.expiresAt)}>· {T.windowLeft(left(conv.window.expiresAt, inbox.now))}</span>
              {:else}
                <span class="window window--closed">· {T.windowClosed}</span>
              {/if}
            {/if}
            {#if conv.snoozedUntil && conv.state === "snoozed"}<span>· {clock(conv.snoozedUntil)}</span>{/if}
          </span>
        {/if}
      </div>
      {#if conv}
        <div class="actions">
          {#if !mine && conv.state !== "resolved"}
            <Button size="sm" loading={busy === "take"} onclick={() => act("take", {}, T.done.take)}>{T.take}</Button>
          {/if}
          {#if lead || mine}
            <DropdownMenu label={T.assignTo} placement="bottom-end">
              {#snippet trigger(props)}<Button {...props} size="sm" variant="outline" loading={busy === "assign"}>{T.assign}</Button>{/snippet}
              <MenuLabel>{T.assignTo}</MenuLabel>
              {#each inbox.members.filter((m) => m.userId !== conv.assigneeId) as m (m.userId)}
                <MenuItem onSelect={() => act("assign", { userId: m.userId }, T.done.assign(m.displayName))}>{m.displayName}{m.available ? "" : ` (${T.away})`}</MenuItem>
              {/each}
            </DropdownMenu>
          {/if}
          <DropdownMenu label={T.more} placement="bottom-end">
            {#snippet trigger(props)}<Button {...props} size="sm" variant="ghost" ariaLabel={T.more}>⋯</Button>{/snippet}
            {#if conv.state !== "resolved"}
              <MenuItem onSelect={() => act("resolve", {}, T.done.resolve)}>{T.resolve} <span class="kbd">e</span></MenuItem>
            {/if}
            {#if (mine || lead) && conv.assigneeId}
              <MenuItem onSelect={() => act("release", {}, T.done.release)}>{T.release}</MenuItem>
            {/if}
            {#if inbox.hasBot(conv.channelId) && (conv.state === "queued" || conv.state === "human")}
              <MenuItem onSelect={() => act("return-to-bot", {}, T.done.returnToBot)}>{T.returnToBot}</MenuItem>
            {/if}
            {#if conv.state === "human"}
              <MenuSeparator />
              <MenuLabel>{T.snooze}</MenuLabel>
              {#each Object.entries(T.snoozeOptions) as [k, label] (k)}
                <MenuItem onSelect={() => act("snooze", { until: snoozeUntil(k) }, T.done.snooze)}>{label}</MenuItem>
              {/each}
            {/if}
            <MenuSeparator />
            <MenuLabel>{T.transferTo}</MenuLabel>
            {#each inbox.teams.filter((t) => t.id !== conv.teamId) as t (t.id)}
              <MenuItem onSelect={() => act("transfer", { teamId: t.id }, T.done.transfer(t.name))}>{t.name}</MenuItem>
            {/each}
            {#if conv.teamId}
              <MenuItem onSelect={() => act("transfer", { teamId: null }, T.done.transfer(T.noTeam))}>{T.noTeam}</MenuItem>
            {/if}
            <MenuSeparator />
            <MenuItem checked={history} checkType="checkbox" onSelect={() => (history = !history)}>{T.showHistory}</MenuItem>
            {#if inbox.copilot}
              <MenuItem onSelect={summarize}>{T.summary}</MenuItem>
            {/if}
          </DropdownMenu>
          {#if conv.state !== "resolved"}
            <Button size="sm" variant="outline" loading={busy === "resolve"} onclick={() => act("resolve", {}, T.done.resolve)} aria-keyshortcuts="e" class="resolve">{T.resolve}</Button>
          {/if}
          <Button size="icon" variant="ghost" ariaLabel={contactShown ? T.hideDetails : T.showDetails} title={T.contactDetails} aria-pressed={contactShown} onclick={onToggleContact}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
          </Button>
        </div>
      {/if}
    </header>

    {#if typingName}
      <div class="collision" role="status"><Alert variant="warning">{T.someoneTyping(typingName)}</Alert></div>
    {:else if conv?.assigneeId && conv.assigneeId !== me && conv.state === "human"}
      <div class="collision" role="status"><Alert variant="info">{T.assignedElsewhere(inbox.nameOf(conv.assigneeId))}</Alert></div>
    {/if}
    {#if summary}
      <div class="collision">
        <Alert variant="info" title={T.summaryTitle} onDismiss={() => (summary = null)} dismissLabel={T.close}><span class="pre">{summary}</span></Alert>
      </div>
    {/if}

    <div class="scroll" bind:this={scroller} onscroll={onScroll} role="log" aria-live="polite" aria-relevant="additions" tabindex="-1">
      {#if inbox.threadLoad === "loading"}
        <div aria-busy="true"><span class="sr">{T.loading}</span><Skeleton lines={6} /></div>
      {:else if inbox.threadLoad === "error"}
        <EmptyState variant="error" size="sm" level={3} title={T.failedTitle} description={inbox.threadError} onRetry={() => void inbox.loadThread()} retryLabel={T.retry} />
      {:else}
        {#if inbox.hasEarlier}
          <div class="earlier"><Button size="sm" variant="ghost" onclick={() => void inbox.loadEarlier()}>{T.loadEarlier}</Button></div>
        {/if}
        {#each items as item, i (item.id)}
          {#if i === 0 || dayLabel(items[i - 1]!.at, inbox.now) !== dayLabel(item.at, inbox.now)}
            <div class="day" role="separator"><span>{dayLabel(item.at, inbox.now)}</span></div>
          {/if}
          {#if item.type === "message"}
            <MessageBubble
              message={item.message}
              reactions={item.reactions}
              quoted={item.message.replyToId ? byId.get(item.message.replyToId) : undefined}
              author={inbox.nameOf(item.message.authorId)}
              onReply={reply}
              onReact={react}
              onQuote={jump}
            />
          {:else if item.type === "note"}
            <article class="note" aria-label={T.note}>
              <span class="note-head">
                <strong>{T.note}</strong>
                {item.note.authorKind === "agent" ? inbox.nameOf(item.note.authorId) : T.authors[item.note.authorKind] ?? item.note.authorKind}
                <time datetime={item.note.createdAt} title={full(item.note.createdAt)}>{clock(item.note.createdAt)}</time>
              </span>
              <p>{item.note.body}</p>
            </article>
          {:else}
            <p class="event"><span>{eventText(item.event)}</span> <time datetime={item.event.createdAt} title={full(item.event.createdAt)}>{clock(item.event.createdAt)}</time></p>
          {/if}
        {/each}
        {#if conv?.metadata?.handoffSummary && history}
          <p class="event"><span>{T.handoffSummary}: {conv.metadata.handoffSummary}</span></p>
        {/if}
      {/if}
    </div>

    {#if inbox.threadLoad === "ready"}
      <Composer {inbox} bind:replyTo bind:textarea bind:mode {onToast} />
    {/if}
  {/if}
</section>

<style>
  .thread {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    height: 100%;
  }

  .empty {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }

  .head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid rgb(var(--ta-border));
    background: rgb(var(--ta-surface));
  }

  .head :global(.back) {
    display: none;
  }

  .who {
    flex: 1 1 12rem;
    min-width: 0;
  }

  .name {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    font-size: 1rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.3rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .window--closed {
    color: rgb(var(--ta-danger));
  }

  .actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .kbd {
    margin-left: auto;
    padding: 0 0.3rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: 0.25rem;
    font-size: 0.6875rem;
    color: rgb(var(--ta-text-dim));
  }

  .collision {
    padding: 0.5rem 0.75rem 0;
  }

  .pre {
    white-space: pre-wrap;
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem 1rem 1rem;
  }

  .scroll:focus {
    outline: none;
  }

  .earlier {
    display: flex;
    justify-content: center;
  }

  .day {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.5rem 0;
    font-size: 0.6875rem;
    font-weight: 600;
    color: rgb(var(--ta-text-dim));
  }

  .day::before,
  .day::after {
    content: "";
    flex: 1;
    border-top: 1px solid rgb(var(--ta-border));
  }

  .note {
    align-self: center;
    width: min(34rem, 92%);
    padding: 0.5rem 0.75rem;
    border: 1px dashed rgb(var(--ta-warning) / 0.7);
    border-radius: var(--ta-radius);
    background: rgb(var(--ta-warning) / 0.08);
  }

  .note-head {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .note-head strong {
    color: rgb(var(--ta-warning));
  }

  .note-head time {
    margin-left: auto;
  }

  .note p {
    margin: 0.25rem 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .event {
    align-self: center;
    margin: 0;
    max-width: 90%;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
    text-align: center;
  }

  .event time {
    opacity: 0.8;
  }

  .scroll :global(.flash .bubble) {
    outline: 2px solid rgb(var(--ta-accent));
  }

  @media (max-width: 767px) {
    .head :global(.back) {
      display: inline-flex;
    }

    .head :global(.resolve) {
      display: none;
    }

    .scroll {
      padding-inline: 0.625rem;
    }
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

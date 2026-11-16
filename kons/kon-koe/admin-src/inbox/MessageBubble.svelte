<!--
  One message of the thread: who wrote it (contact on the left; the team, the bot, the AI and automations on
  the right), what it replies to, its media, text or interactive content, its reactions, and for what the
  team sent, its delivery ticks and why it failed.

  Everything from the API is text (no HTML is rendered) and links are followed only when they are http(s).
-->
<script lang="ts">
  import type { Message } from "../types";
  import { bytes, clock, full, safeUrl } from "./format";
  import { T } from "./strings";
  import VoicePlayer from "./VoicePlayer.svelte";

  const {
    message: m,
    reactions = [],
    quoted,
    author,
    onReply,
    onReact,
    onQuote,
  }: {
    message: Message;
    reactions?: string[];
    quoted?: Message;
    /** The display name of the agent who wrote it. */
    author: string;
    onReply: (m: Message) => void;
    onReact: (m: Message, emoji: string) => void;
    onQuote: (id: string) => void;
  } = $props();

  const QUICK = ["👍", "❤️", "😂", "😮", "🙏", "✅"];

  const out = $derived(m.direction === "out");
  const media = $derived(m.media);
  const url = $derived(safeUrl(media?.url));
  const interactive = $derived((m.payload?.interactive ?? null) as
    | { type: "buttons"; body?: string; buttons?: Array<{ id: string; title: string }> }
    | { type: "list"; body?: string; button?: string; sections?: Array<{ title?: string; rows: Array<{ id: string; title: string }> }> }
    | { type: "url"; body?: string; text?: string; url?: string }
    | null);
  const template = $derived((m.payload?.template ?? null) as { name?: string } | null);
  const location = $derived((m.payload?.location ?? null) as { latitude: number; longitude: number; name?: string; address?: string } | null);
  const contacts = $derived((Array.isArray(m.payload?.contacts) ? m.payload.contacts : []) as Array<{ name?: { formatted_name?: string } | string; phones?: Array<{ phone?: string }> }>);
  const replyChoice = $derived(m.direction === "in" && (m.kind === "button_reply" || m.kind === "list_reply" || m.kind === "button" || m.kind === "interactive"));

  const who = $derived(out ? (m.authorKind === "agent" ? author || T.authors.agent : T.authors[m.authorKind] ?? m.authorKind) : "");
  const quoteText = (q: Message) => q.body || (q.media ? q.media.filename || q.kind : q.kind);
  const contactName = (c: (typeof contacts)[number]) => (typeof c.name === "string" ? c.name : c.name?.formatted_name ?? "");
  const mapUrl = (l: { latitude: number; longitude: number }) => `https://www.openstreetmap.org/?mlat=${l.latitude}&mlon=${l.longitude}#map=16/${l.latitude}/${l.longitude}`;

  let reacting = $state(false);
</script>

<div class="msg" class:out class:failed={m.status === "failed"} id={`msg-${m.id}`}>
  <div class="bubble" class:sticker={m.kind === "sticker"}>
    {#if who}<span class="who">{who}</span>{/if}
    {#if m.replyToId}
      <button type="button" class="quote" onclick={() => onQuote(m.replyToId!)}>
        <span class="sr">{T.replyingTo}:</span>
        {quoted ? quoteText(quoted) : "…"}
      </button>
    {/if}
    {#if template}<span class="tag">{T.template(template.name ?? "")}</span>{/if}
    {#if replyChoice}<span class="tag">{T.buttonReply}</span>{/if}

    {#if media}
      {#if media.status === "pending" && !url}
        <span class="dim">{T.mediaPending}</span>
      {:else if media.status === "failed" && !url}
        <span class="dim">{T.mediaFailed}</span>
      {:else if m.kind === "voice" || (m.kind === "audio" && media.waveform)}
        <VoicePlayer {media} mine={out} />
      {:else if url && (m.kind === "sticker" || media.kind === "sticker")}
        <img class="sticker-img" src={url} alt={T.sticker} loading="lazy" />
      {:else if url && (m.kind === "image" || media.mime.startsWith("image/"))}
        <a href={url} target="_blank" rel="noopener noreferrer" class="media-link"><img src={url} alt={media.filename ?? ""} loading="lazy" /></a>
      {:else if url && (m.kind === "video" || media.mime.startsWith("video/"))}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={url} controls preload="metadata"></video>
      {:else if url && (m.kind === "audio" || media.mime.startsWith("audio/"))}
        <audio src={url} controls preload="metadata"></audio>
      {:else if url}
        <a class="doc" href={url} target="_blank" rel="noopener noreferrer" download={media.filename ?? true}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M7 3.5h7l4 4v13H7zM14 3.5v4h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /></svg>
          <span class="doc-name">{media.filename ?? T.openFile}</span>
          {#if media.sizeBytes}<span class="dim">{bytes(media.sizeBytes)}</span>{/if}
        </a>
      {/if}
    {/if}

    {#if m.body}<p class="text">{m.body}</p>{/if}

    {#if interactive}
      {#if interactive.type === "buttons"}
        <span class="choices">{#each interactive.buttons ?? [] as b (b.id)}<span class="choice">{b.title}</span>{/each}</span>
      {:else if interactive.type === "list"}
        <span class="choices"><span class="choice">☰ {interactive.button}</span></span>
        {#each interactive.sections ?? [] as s, i (i)}
          <span class="list-rows">{#if s.title}<strong>{s.title}: </strong>{/if}{s.rows.map((r) => r.title).join(" · ")}</span>
        {/each}
      {:else if interactive.type === "url" && safeUrl(interactive.url)}
        <a class="choice" href={safeUrl(interactive.url)} target="_blank" rel="noopener noreferrer">{interactive.text}</a>
      {/if}
    {/if}

    {#if location}
      <a class="doc" href={mapUrl(location)} target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" fill="none" stroke="currentColor" stroke-width="1.6" /></svg>
        <span>{location.name || location.address || T.location}</span>
      </a>
    {/if}
    {#if contacts.length}
      <span class="tag">{T.contactCard}</span>
      {#each contacts as c, i (i)}<span class="contact-card">{contactName(c)} {c.phones?.[0]?.phone ?? ""}</span>{/each}
    {/if}

    <span class="foot">
      <time datetime={m.createdAt} title={full(m.createdAt)}>{clock(m.createdAt)}</time>
      {#if out}
        <span class="ticks ticks--{m.status}" title={T.status[m.status] ?? m.status}>
          <span class="sr">{T.status[m.status] ?? m.status}</span>
          {#if m.status === "queued"}
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
          {:else if m.status === "sent"}
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
          {:else if m.status === "delivered" || m.status === "read"}
            <svg viewBox="0 0 28 24" width="17" height="14" aria-hidden="true"><path d="M2 12.5l4.5 4.5L16 7.5M10 15.5l1.5 1.5L21 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
          {:else if m.status === "failed"}
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 4l9 16H3l9-16zM12 10v4.5M12 17.4v.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
          {/if}
        </span>
      {/if}
    </span>
    {#if m.status === "failed"}
      <span class="error" role="note">{m.errorMessage || T.sendErrors[m.errorCode ?? ""] || m.errorCode || T.sendFailed}</span>
    {/if}
  </div>

  {#if reactions.length}
    <span class="reactions" aria-label={T.react}>{#each reactions as r, i (i)}<span>{r}</span>{/each}</span>
  {/if}

  <span class="actions">
    <button type="button" class="action" onclick={() => onReply(m)} aria-label={`${T.replyTo}: ${quoteText(m)}`}>{T.replyTo}</button>
    <button type="button" class="action" aria-expanded={reacting} onclick={() => (reacting = !reacting)}>{T.react}</button>
    {#if reacting}
      <span class="emoji-row" role="group" aria-label={T.react}>
        {#each QUICK as e (e)}
          <button
            type="button"
            class="emoji"
            onclick={() => {
              reacting = false;
              onReact(m, e);
            }}>{e}</button
          >
        {/each}
      </span>
    {/if}
  </span>
</div>

<style>
  .msg {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.2rem;
    max-width: min(36rem, 85%);
  }

  .msg.out {
    align-self: flex-end;
    align-items: flex-end;
  }

  .bubble {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.5rem 0.7rem;
    border-radius: 0.875rem;
    border-bottom-left-radius: 0.25rem;
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    min-width: 0;
    max-width: 100%;
  }

  .out .bubble {
    border-bottom-left-radius: 0.875rem;
    border-bottom-right-radius: 0.25rem;
    background: rgb(var(--ta-accent) / 0.14);
    border-color: rgb(var(--ta-accent) / 0.3);
  }

  .failed .bubble {
    border-color: rgb(var(--ta-danger) / 0.6);
  }

  .bubble.sticker {
    background: none;
    border-color: transparent;
    padding: 0;
  }

  .who {
    font-size: 0.6875rem;
    font-weight: 600;
    color: rgb(var(--ta-accent-hover));
  }

  .quote {
    display: block;
    max-width: 100%;
    padding: 0.25rem 0.5rem;
    border: 0;
    border-left: 3px solid rgb(var(--ta-accent));
    border-radius: var(--ta-radius-sm);
    background: rgb(var(--ta-elevated));
    color: rgb(var(--ta-text-dim));
    font: inherit;
    font-size: 0.75rem;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }

  .tag {
    font-size: 0.6875rem;
    color: rgb(var(--ta-text-dim));
  }

  .text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  img,
  video {
    display: block;
    max-width: min(20rem, 100%);
    max-height: 18rem;
    border-radius: var(--ta-radius);
  }

  .sticker-img {
    width: 8rem;
    height: 8rem;
    object-fit: contain;
  }

  audio {
    max-width: 100%;
  }

  .media-link {
    display: block;
  }

  .doc {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: inherit;
    text-decoration: none;
    padding: 0.4rem 0.5rem;
    border-radius: var(--ta-radius);
    background: rgb(var(--ta-elevated));
  }

  .doc:hover .doc-name {
    text-decoration: underline;
  }

  .doc-name {
    overflow-wrap: anywhere;
  }

  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .choice {
    padding: 0.15rem 0.55rem;
    border: 1px solid rgb(var(--ta-accent) / 0.5);
    border-radius: 999px;
    font-size: 0.75rem;
    color: rgb(var(--ta-accent-hover));
  }

  .list-rows,
  .contact-card {
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .foot {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    align-self: flex-end;
    font-size: 0.6875rem;
    color: rgb(var(--ta-text-dim));
  }

  .ticks {
    display: inline-flex;
  }

  .ticks--read {
    color: rgb(var(--ta-info));
  }

  .ticks--failed {
    color: rgb(var(--ta-danger));
  }

  .error {
    font-size: 0.75rem;
    color: rgb(var(--ta-danger));
  }

  .dim {
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .reactions {
    display: inline-flex;
    gap: 0.125rem;
    margin-top: -0.4rem;
    padding: 0 0.3rem;
    border-radius: 999px;
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    font-size: 0.875rem;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    opacity: 0;
    transition: opacity var(--ta-duration-fast, 120ms);
  }

  .msg:hover .actions,
  .msg:focus-within .actions {
    opacity: 1;
  }

  @media (hover: none) {
    .actions {
      opacity: 1;
    }
  }

  .action,
  .emoji {
    min-height: 1.5rem;
    padding: 0 0.4rem;
    border: 1px solid transparent;
    border-radius: var(--ta-radius-sm);
    background: none;
    color: rgb(var(--ta-text-dim));
    font: inherit;
    font-size: 0.6875rem;
    cursor: pointer;
  }

  .action:hover,
  .emoji:hover {
    background: rgb(var(--ta-elevated));
    color: rgb(var(--ta-text));
  }

  .action:focus-visible,
  .emoji:focus-visible,
  .quote:focus-visible {
    outline: 2px solid rgb(var(--ta-accent));
  }

  .emoji {
    font-size: 1rem;
  }

  .emoji-row {
    display: inline-flex;
    gap: 0.125rem;
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

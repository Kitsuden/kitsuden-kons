<!--
  Writing in a conversation: a reply to the contact or a note for the team.

  Reply: text (Enter sends, Shift+Enter breaks the line), "/" opens the quick replies, files, a voice note
  recorded here (MediaRecorder → POST /media kind voice), stickers from the team's library, emoji, and the
  copilot's draft and translation. Outside WhatsApp's 24-hour window the reply becomes the template picker;
  on Messenger and Instagram it says when only a person may still answer (human agent tag, 7 days).
  Note: text with @mentions, which notify those members.

  A refused send keeps the text and says why (koe's 409 `details.koe`).
-->
<script lang="ts">
  import { Alert, Button, Popover, Spinner } from "$lib/components";
  import { onDestroy } from "svelte";

  import { ApiError, seg } from "../api";
  import type { Member, Message, QuickReply, Sticker } from "../types";
  import { clock, duration, newKey, safeUrl } from "./format";
  import type { Inbox } from "./store.svelte";
  import { T } from "./strings";
  import TemplatePicker from "./TemplatePicker.svelte";

  let {
    inbox,
    replyTo = $bindable(null),
    textarea = $bindable(),
    mode = $bindable("reply"),
    onToast,
  }: {
    inbox: Inbox;
    replyTo?: Message | null;
    textarea?: HTMLTextAreaElement;
    mode?: "reply" | "note";
    onToast: (kind: "success" | "error" | "info", title: string, description?: string) => void;
  } = $props();

  const EMOJI = ["😀", "😊", "😂", "😉", "😍", "🙏", "👍", "👌", "👏", "🙌", "💪", "🎉", "✅", "❌", "⚠️", "❤️", "🔥", "⭐", "📦", "🚚", "💳", "💰", "📅", "⏰", "📞", "📍", "🤔", "😅", "😢", "😮"];

  let text = $state("");
  let sending = $state(false);
  let error = $state("");
  let key = newKey();
  let lastText = "";

  const conv = $derived(inbox.current);
  const kind = $derived(conv?.channel?.kind ?? null);
  const win = $derived(inbox.window);
  /** WhatsApp, window closed: templates only. */
  const templatesOnly = $derived(mode === "reply" && kind === "whatsapp" && !!win && !win.personMayWrite);
  /** Messenger/Instagram after 24 h: a person may still answer, up to 7 days. */
  const humanAgent = $derived(mode === "reply" && (kind === "messenger" || kind === "instagram") && !!win && !win.open && win.personMayWrite);
  /** Messenger/Instagram after 7 days: nothing can go out. */
  const closed = $derived(mode === "reply" && (kind === "messenger" || kind === "instagram") && !!win && !win.personMayWrite);

  // A different conversation starts a clean composer.
  $effect(() => {
    void inbox.openId;
    text = "";
    error = "";
    key = newKey();
    qrOpen = false;
    mentionOpen = false;
    translation = null;
  });

  function grow() {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(220, textarea.scrollHeight)}px`;
  }

  function reasonOf(e: unknown): string {
    if (e instanceof ApiError && e.koe) return T.sendErrors[e.koe] ?? e.message;
    return e instanceof Error ? e.message : String(e);
  }

  // ── Sending ─────────────────────────────────────────────────────────────

  async function submit() {
    const body = text.trim();
    if (!body || sending) return;
    if (body !== lastText) key = newKey();
    lastText = body;
    sending = true;
    error = "";
    try {
      if (mode === "note") {
        await inbox.addNote(body, mentionsIn(body));
      } else {
        await inbox.send({ kind: "text", body, ...(replyTo ? { replyToMessageId: replyTo.id } : {}), idempotencyKey: key });
        replyTo = null;
      }
      text = "";
      key = newKey();
      queueMicrotask(grow);
    } catch (e) {
      error = reasonOf(e);
      if (e instanceof ApiError && e.status === 409) void inbox.refreshConversation();
    } finally {
      sending = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (qrOpen && handleMenuKey(e, qrItems.length, (i) => pickQuick(qrItems[i]!))) return;
    if (mentionOpen && handleMenuKey(e, mentionItems.length, (i) => pickMention(mentionItems[i]!))) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
    }
    if (e.key === "Escape" && replyTo) {
      e.preventDefault();
      replyTo = null;
    }
  }

  function onInput() {
    grow();
    if (mode === "reply") {
      inbox.typingNow();
      watchQuick();
    } else {
      watchMention();
    }
  }

  // ── Menus (quick replies, mentions) ─────────────────────────────────────

  let active = $state(0);
  function handleMenuKey(e: KeyboardEvent, n: number, pick: (i: number) => void): boolean {
    if (e.key === "ArrowDown") active = n ? (active + 1) % n : 0;
    else if (e.key === "ArrowUp") active = n ? (active - 1 + n) % n : 0;
    else if ((e.key === "Enter" || e.key === "Tab") && n) pick(active);
    else if (e.key === "Escape") {
      qrOpen = false;
      mentionOpen = false;
    } else return false;
    e.preventDefault();
    return true;
  }

  let qrOpen = $state(false);
  let qrItems = $state<Array<QuickReply & { preview?: string | null }>>([]);
  let qrLoading = $state(false);
  let qrTimer: ReturnType<typeof setTimeout> | null = null;

  function watchQuick() {
    const m = /^\/([\w-]*)$/.exec(text);
    if (!m) {
      qrOpen = false;
      return;
    }
    qrOpen = true;
    if (qrTimer) clearTimeout(qrTimer);
    qrTimer = setTimeout(async () => {
      qrLoading = true;
      try {
        qrItems = (await inbox.api.get<{ data: Array<QuickReply & { preview?: string | null }> }>("quick-replies", { shortcut: m[1], conversationId: inbox.openId, limit: 8 })).data ?? [];
        active = 0;
      } catch {
        qrItems = [];
      } finally {
        qrLoading = false;
      }
    }, 150);
  }

  async function pickQuick(q: QuickReply & { preview?: string | null }) {
    qrOpen = false;
    if (q.attachments.length) {
      // Text and files go together, resolved and sent by the API.
      text = "";
      try {
        await inbox.api.post(`conversations/${seg(inbox.openId!)}/quick-replies/${seg(q.id)}/send`, { clientKey: newKey("qr") });
        void inbox.refreshMessages();
      } catch (e) {
        error = reasonOf(e);
      }
      return;
    }
    text = q.preview ?? q.body ?? "";
    queueMicrotask(() => {
      grow();
      textarea?.focus();
    });
  }

  let mentionOpen = $state(false);
  let mentionQuery = $state("");
  const mentionItems = $derived(
    inbox.members.filter((m) => m.userId !== inbox.me?.userId && m.displayName.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6)
  );

  function watchMention() {
    const caret = textarea?.selectionStart ?? text.length;
    const m = /(^|\s)@([^\s@]{0,30})$/.exec(text.slice(0, caret));
    mentionOpen = !!m;
    mentionQuery = m?.[2] ?? "";
    active = 0;
  }

  function pickMention(member: Member) {
    const caret = textarea?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([^\s@]{0,30})$/, `@${member.displayName} `);
    text = before + text.slice(caret);
    mentionOpen = false;
    queueMicrotask(() => {
      textarea?.focus();
      textarea?.setSelectionRange(before.length, before.length);
    });
  }

  /** Members whose "@Name" is in the note. */
  const mentionsIn = (body: string) => inbox.members.filter((m) => body.includes(`@${m.displayName}`)).map((m) => m.userId);

  // ── Files, voice, stickers, emoji ───────────────────────────────────────

  let fileInput = $state<HTMLInputElement>();
  let uploads = $state<string[]>([]);

  const kindOfFile = (f: File) => (f.type.startsWith("image/") ? "image" : f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : "document");

  async function uploadAndSend(file: File | Blob, name: string, kind: string, caption?: string) {
    uploads = [...uploads, name];
    try {
      const form = new FormData();
      form.append("file", file, name);
      form.append("kind", kind);
      if (inbox.openId) form.append("conversationId", inbox.openId);
      const res = await inbox.api.upload<{ data: { id: string; kind: string }; notice?: string }>("media", form);
      if (res.notice) onToast("info", res.notice);
      await inbox.send({ kind: res.data.kind || kind, mediaId: res.data.id, ...(caption ? { body: caption } : {}), idempotencyKey: newKey("media") });
    } catch (e) {
      onToast("error", T.uploadFailed(name), reasonOf(e));
    } finally {
      uploads = uploads.filter((u) => u !== name);
    }
  }

  async function attach(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    const caption = text.trim();
    if (caption && files.length) text = "";
    for (const [i, f] of files.entries()) await uploadAndSend(f, f.name, kindOfFile(f), i === 0 ? caption : undefined);
  }

  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let recording = $state(false);
  let recStart = $state(0);
  let recNow = $state(0);
  let recTimer: ReturnType<typeof setInterval> | null = null;

  const canRecord = typeof window !== "undefined" && "MediaRecorder" in window && !!navigator.mediaDevices?.getUserMedia;

  async function startRecording() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onToast("error", T.micDenied);
      return;
    }
    // OGG/Opus is what WhatsApp shows as a voice note; the API converts the rest when it can.
    const mime = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data.size) chunks.push(ev.data);
    };
    recorder.start(250);
    recording = true;
    recStart = Date.now();
    recNow = recStart;
    recTimer = setInterval(() => (recNow = Date.now()), 250);
  }

  function stopRecording(send: boolean) {
    const r = recorder;
    if (!r) return;
    r.onstop = () => {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      const type = r.mimeType || "audio/webm";
      const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
      if (send && chunks.length) void uploadAndSend(new Blob(chunks, { type }), `voice-${Date.now()}.${ext}`, "voice");
      chunks = [];
    };
    r.stop();
    recorder = null;
    recording = false;
    if (recTimer) clearInterval(recTimer);
  }

  onDestroy(() => {
    if (recorder) stopRecording(false);
  });

  let stickers = $state<Sticker[] | null>(null);
  let stickerOpen = $state(false);
  async function loadStickers() {
    if (stickers) return;
    try {
      stickers = (await inbox.api.get<{ data: Sticker[] }>("stickers", { limit: 60 })).data ?? [];
    } catch {
      stickers = [];
    }
  }
  async function sendSticker(s: Sticker) {
    stickerOpen = false;
    try {
      await inbox.send({ kind: "sticker", mediaId: s.mediaId, idempotencyKey: newKey("sticker") });
    } catch (e) {
      error = reasonOf(e);
    }
  }

  let emojiOpen = $state(false);
  function insert(s: string) {
    const start = textarea?.selectionStart ?? text.length;
    const end = textarea?.selectionEnd ?? text.length;
    text = text.slice(0, start) + s + text.slice(end);
    emojiOpen = false;
    queueMicrotask(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + s.length, start + s.length);
    });
  }

  // ── Copilot ─────────────────────────────────────────────────────────────

  let copilotBusy = $state<"draft" | "translate" | null>(null);
  let translation = $state<{ text: string; mine: boolean } | null>(null);
  let translateOpen = $state(false);
  let language = $state("");

  async function draft() {
    copilotBusy = "draft";
    try {
      const res = await inbox.api.post<{ data: { draft: string } }>(`conversations/${seg(inbox.openId!)}/copilot/draft`, text.trim() ? { instructions: text.trim().slice(0, 1000) } : {});
      text = res.data.draft ?? "";
      queueMicrotask(() => {
        grow();
        textarea?.focus();
      });
    } catch (e) {
      onToast("error", T.copilot, reasonOf(e));
    } finally {
      copilotBusy = null;
    }
  }

  async function translate(mine: boolean) {
    translateOpen = false;
    const to = language.trim() || (mine ? "English" : navigator.language || "English");
    copilotBusy = "translate";
    try {
      const res = await inbox.api.post<{ data: { translation: string } }>(`conversations/${seg(inbox.openId!)}/copilot/translate`, { to, ...(mine && text.trim() ? { text: text.trim() } : {}) });
      translation = { text: res.data.translation, mine };
    } catch (e) {
      onToast("error", T.translate, reasonOf(e));
    } finally {
      copilotBusy = null;
    }
  }
</script>

<div class="composer">
  <div class="modes" role="group" aria-label={T.reply}>
    <button type="button" class="mode" aria-pressed={mode === "reply"} onclick={() => (mode = "reply")}>{T.reply}</button>
    <button type="button" class="mode mode--note" aria-pressed={mode === "note"} onclick={() => (mode = "note")}>{T.writeNote}</button>
    {#if inbox.copilot && mode === "reply" && !templatesOnly && !closed}
      <span class="copilot">
        <Button size="sm" variant="ghost" loading={copilotBusy === "draft"} onclick={draft}>{T.draft}</Button>
        <Popover bind:open={translateOpen} title={T.translate} placement="top-end">
          {#snippet trigger(props)}
            <Button {...props} size="sm" variant="ghost" loading={copilotBusy === "translate"}>{T.translate}</Button>
          {/snippet}
          <div class="translate">
            <label>
              <span>{T.translateTo}</span>
              <input bind:value={language} placeholder={conv?.contact ? "English, es, pt-BR" : "English"} maxlength="40" />
            </label>
            <Button size="sm" variant="outline" onclick={() => translate(false)}>{T.translateIncoming}</Button>
            <Button size="sm" variant="outline" disabled={!text.trim()} onclick={() => translate(true)}>{T.translateMine}</Button>
          </div>
        </Popover>
      </span>
    {/if}
  </div>

  {#if translation}
    <div class="translation" role="status">
      <strong>{T.translationTitle}</strong>
      <p>{translation.text}</p>
      <span class="row">
        {#if translation.mine}
          <Button
            size="sm"
            variant="outline"
            onclick={() => {
              text = translation!.text;
              translation = null;
              queueMicrotask(grow);
            }}>{T.useText}</Button
          >
        {/if}
        <Button size="sm" variant="ghost" onclick={() => (translation = null)}>{T.close}</Button>
      </span>
    </div>
  {/if}

  {#if templatesOnly}
    <TemplatePicker {inbox} onSent={() => {}} />
  {:else if closed}
    <p class="closed" role="note">{T.windowClosedMeta}</p>
  {:else}
    {#if humanAgent && win?.humanAgentUntil}
      <p class="note-line" role="note">{T.windowHumanAgent(clock(win.humanAgentUntil))}</p>
    {/if}
    {#if replyTo && mode === "reply"}
      <div class="replying">
        <span class="sr">{T.replyingTo}</span>
        <span class="replying-text">{replyTo.body || replyTo.media?.filename || replyTo.kind}</span>
        <button type="button" class="x" aria-label={T.cancelReply} onclick={() => (replyTo = null)}>×</button>
      </div>
    {/if}
    {#if error}<Alert variant="error" onDismiss={() => (error = "")} dismissLabel={T.close}>{error}</Alert>{/if}
    {#each uploads as u (u)}<p class="uploading"><Spinner size="sm" label={T.uploading(u)} /> {T.uploading(u)}</p>{/each}

    <div class="box" class:note={mode === "note"}>
      {#if qrOpen}
        <ul class="menu" role="listbox" aria-label={T.quickReplies}>
          {#if qrLoading}<li class="menu-empty"><Spinner size="sm" label={T.loading} /></li>{/if}
          {#each qrItems as q, i (q.id)}
            <li role="option" aria-selected={i === active}>
              <button type="button" class="menu-item" class:active={i === active} onmousedown={(e) => e.preventDefault()} onclick={() => pickQuick(q)}>
                <span class="shortcut">/{q.shortcut}</span>
                <span class="menu-title">{q.title}</span>
                <span class="menu-body">{q.preview ?? q.body ?? ""}{q.attachments.length ? ` 📎${q.attachments.length}` : ""}</span>
              </button>
            </li>
          {/each}
          {#if !qrLoading && !qrItems.length}<li class="menu-empty">{T.noQuickReplies}</li>{/if}
        </ul>
      {/if}
      {#if mentionOpen && mentionItems.length}
        <ul class="menu" role="listbox" aria-label={T.mention}>
          {#each mentionItems as mm, i (mm.userId)}
            <li role="option" aria-selected={i === active}>
              <button type="button" class="menu-item" class:active={i === active} onmousedown={(e) => e.preventDefault()} onclick={() => pickMention(mm)}>
                <span class="menu-title">@{mm.displayName}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if recording}
        <div class="recording" role="status">
          <span class="dot" aria-hidden="true"></span>
          {T.recording(duration(recNow - recStart))}
          <span class="grow"></span>
          <Button size="sm" variant="ghost" onclick={() => stopRecording(false)}>{T.cancelRecording}</Button>
          <Button size="sm" onclick={() => stopRecording(true)}>{T.stopRecording}</Button>
        </div>
      {:else}
        <textarea
          bind:this={textarea}
          bind:value={text}
          rows="2"
          maxlength={mode === "note" ? 5000 : 4096}
          placeholder={mode === "note" ? T.notePlaceholder : T.replyPlaceholder}
          aria-label={mode === "note" ? T.writeNote : T.reply}
          aria-keyshortcuts="r"
          oninput={onInput}
          onkeydown={onKeydown}
          onblur={() => setTimeout(() => ((qrOpen = false), (mentionOpen = false)), 150)}
        ></textarea>
      {/if}

      <div class="tools">
        {#if mode === "reply"}
          <input bind:this={fileInput} type="file" multiple hidden onchange={attach} />
          <Button size="icon" variant="ghost" ariaLabel={T.attach} title={T.attach} onclick={() => fileInput?.click()} disabled={recording}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
          </Button>
          {#if canRecord}
            <Button size="icon" variant="ghost" ariaLabel={T.record} title={T.record} onclick={startRecording} disabled={recording}>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
            </Button>
          {/if}
          <Popover bind:open={stickerOpen} title={T.stickers} placement="top-start" onOpenChange={(o: boolean) => o && loadStickers()}>
            {#snippet trigger(props)}
              <Button {...props} size="icon" variant="ghost" ariaLabel={T.stickers} title={T.stickers} disabled={recording}>
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20.5 12A8.5 8.5 0 1 1 12 3.5h3.5l5 5V12zM15 3.5V9h5.5M8.5 14.5s1.2 1.5 3.5 1.5 3.5-1.5 3.5-1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </Button>
            {/snippet}
            {#if stickers === null}
              <Spinner size="sm" label={T.loading} />
            {:else if !stickers.length}
              <p class="menu-empty">{T.noStickers}</p>
            {:else}
              <div class="stickers">
                {#each stickers as s (s.id)}
                  {@const src = safeUrl(s.media?.url)}
                  {#if src}
                    <button type="button" class="sticker" aria-label={s.name ?? T.sticker} onclick={() => sendSticker(s)}><img {src} alt="" loading="lazy" /></button>
                  {/if}
                {/each}
              </div>
            {/if}
          </Popover>
        {/if}
        <Popover bind:open={emojiOpen} title={T.emoji} placement="top-start">
          {#snippet trigger(props)}
            <Button {...props} size="icon" variant="ghost" ariaLabel={T.emoji} title={T.emoji} disabled={recording}>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM8.5 14s1.2 2 3.5 2 3.5-2 3.5-2M9 9.5v.1M15 9.5v.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
            </Button>
          {/snippet}
          <div class="emojis">
            {#each EMOJI as e (e)}<button type="button" class="emoji" onclick={() => insert(e)}>{e}</button>{/each}
          </div>
        </Popover>
        <span class="grow"></span>
        <Button size="sm" onclick={submit} loading={sending} disabled={!text.trim() || recording}>{mode === "note" ? T.addNote : T.send}</Button>
      </div>
    </div>
  {/if}
</div>

<style>
  .composer {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.625rem 0.75rem 0.75rem;
    border-top: 1px solid rgb(var(--ta-border));
    background: rgb(var(--ta-surface));
  }

  .modes {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-wrap: wrap;
  }

  .mode {
    min-height: 1.75rem;
    padding: 0.125rem 0.625rem;
    border: 1px solid transparent;
    border-radius: var(--ta-radius-sm);
    background: none;
    color: rgb(var(--ta-text-dim));
    font: inherit;
    font-size: 0.8125rem;
    cursor: pointer;
  }

  .mode[aria-pressed="true"] {
    border-color: rgb(var(--ta-border));
    background: rgb(var(--ta-bg));
    color: rgb(var(--ta-text));
    font-weight: 600;
  }

  .mode--note[aria-pressed="true"] {
    border-color: rgb(var(--ta-warning) / 0.6);
    color: rgb(var(--ta-warning));
  }

  .mode:focus-visible,
  .menu-item:focus-visible,
  .emoji:focus-visible,
  .sticker:focus-visible,
  .x:focus-visible {
    outline: 2px solid rgb(var(--ta-accent));
  }

  .copilot {
    margin-left: auto;
    display: inline-flex;
    gap: 0.125rem;
  }

  .translate {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 14rem;
  }

  .translate label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .translate input {
    padding: 0.375rem 0.5rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-sm);
    background: rgb(var(--ta-bg));
    color: rgb(var(--ta-text));
    font: inherit;
  }

  .translation {
    padding: 0.5rem 0.75rem;
    border: 1px solid rgb(var(--ta-info) / 0.5);
    border-radius: var(--ta-radius);
    background: rgb(var(--ta-info) / 0.08);
    font-size: 0.875rem;
  }

  .translation p {
    margin: 0.25rem 0;
    white-space: pre-wrap;
  }

  .row {
    display: flex;
    gap: 0.375rem;
  }

  .closed,
  .note-line {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-warning));
  }

  .closed {
    padding: 0.75rem;
    border: 1px dashed rgb(var(--ta-warning) / 0.6);
    border-radius: var(--ta-radius);
  }

  .replying {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    border-left: 3px solid rgb(var(--ta-accent));
    border-radius: var(--ta-radius-sm);
    background: rgb(var(--ta-elevated));
    font-size: 0.8125rem;
  }

  .replying-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .x {
    border: 0;
    background: none;
    color: inherit;
    font-size: 1.125rem;
    cursor: pointer;
  }

  .uploading {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .box {
    position: relative;
    display: flex;
    flex-direction: column;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    background: rgb(var(--ta-bg));
  }

  .box:focus-within {
    border-color: rgb(var(--ta-accent) / 0.7);
  }

  .box.note {
    border-style: dashed;
    border-color: rgb(var(--ta-warning) / 0.7);
    background: rgb(var(--ta-warning) / 0.06);
  }

  textarea {
    width: 100%;
    min-height: 3rem;
    max-height: 13.75rem;
    padding: 0.625rem 0.75rem;
    border: 0;
    background: transparent;
    color: rgb(var(--ta-text));
    font: inherit;
    resize: none;
    outline: none;
  }

  .tools {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    padding: 0.25rem 0.375rem 0.375rem;
  }

  .grow {
    flex: 1;
  }

  .recording {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 3rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
  }

  .dot {
    width: 0.625rem;
    height: 0.625rem;
    border-radius: 50%;
    background: rgb(var(--ta-danger));
    animation: pulse 1s ease-in-out infinite;
  }

  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }

  .menu {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 0.25rem);
    z-index: 5;
    max-height: 16rem;
    overflow-y: auto;
    margin: 0;
    padding: 0.25rem;
    list-style: none;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    background: rgb(var(--ta-surface));
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.2);
  }

  .menu-item {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0 0.5rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border: 0;
    border-radius: var(--ta-radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .menu-item.active,
  .menu-item:hover {
    background: rgb(var(--ta-accent) / 0.12);
  }

  .shortcut {
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    color: rgb(var(--ta-accent-hover));
  }

  .menu-title {
    font-weight: 600;
    font-size: 0.8125rem;
  }

  .menu-body {
    grid-column: 1 / -1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .menu-empty {
    margin: 0;
    padding: 0.5rem;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .stickers {
    display: grid;
    grid-template-columns: repeat(4, 4rem);
    gap: 0.25rem;
    max-height: 16rem;
    overflow-y: auto;
  }

  .sticker {
    width: 4rem;
    height: 4rem;
    padding: 0.125rem;
    border: 0;
    border-radius: var(--ta-radius-sm);
    background: none;
    cursor: pointer;
  }

  .sticker:hover {
    background: rgb(var(--ta-elevated));
  }

  .sticker img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .emojis {
    display: grid;
    grid-template-columns: repeat(6, 2.25rem);
    gap: 0.125rem;
  }

  .emoji {
    width: 2.25rem;
    height: 2.25rem;
    border: 0;
    border-radius: var(--ta-radius-sm);
    background: none;
    font-size: 1.25rem;
    cursor: pointer;
  }

  .emoji:hover {
    background: rgb(var(--ta-elevated));
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

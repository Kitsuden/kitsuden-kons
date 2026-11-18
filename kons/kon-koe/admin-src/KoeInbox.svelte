<svelte:options
  customElement={{
    tag: "koe-inbox",
    shadow: "open",
    props: { base: { type: "String", attribute: "base" }, context: { type: "Object" } },
  }}
/>

<!--
  <koe-inbox>: the live inbox, where the team answers. Served full screen by GET /api/koe/inbox
  (koe.ops.web.ts) on the API's own origin, with the person's session cookie.

  Three panes on a wide screen (list | thread | contact), one at a time under 768px. Live through the core's
  WebSocket (kon:koe:inbox, the open conversation, kon:koe:user:<me>) with polling as the floor; a heartbeat
  every 30 s marks the person present (no web push while they are) and carries their availability. Web push
  is opt-in per browser. Keyboard: j/k move through the list, r replies, e resolves, / searches, Esc goes
  back. Every visible word is in inbox/strings.ts.
-->
<script lang="ts">
  import { Button, EmptyState, Popover, Spinner, Switch, ThemeScope, Toaster } from "$lib/components";
  import { toast } from "$lib/toast.svelte";
  import { onDestroy, onMount, tick } from "svelte";

  import ContactPane from "./inbox/ContactPane.svelte";
  import ConversationList from "./inbox/ConversationList.svelte";
  import Notices from "./inbox/Notices.svelte";
  import { disablePush, enablePush, onWorkerMessage, pushState, type PushState } from "./inbox/push";
  import { Inbox } from "./inbox/store.svelte";
  import { T } from "./inbox/strings";
  import Thread from "./inbox/Thread.svelte";

  let { base, context }: { base?: string; context?: { apiBase?: string } } = $props();

  // `base` from the inbox page, or the admin's `apiBase` when mounted there.
  const koeBase = $derived((base || (context?.apiBase ? `${context.apiBase}/koe` : "/api/koe")).replace(/\/+$/, ""));

  let inbox = $state<Inbox | null>(null);
  let pane = $state<"list" | "thread" | "contact">("list");
  /** The contact pane sits beside the thread on a wide screen; narrower, it opens on demand. */
  let contactShown = $state(typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches);
  let search = $state<HTMLInputElement>();
  let composer = $state<HTMLTextAreaElement>();
  let push = $state<PushState>("unsupported");
  let pushBusy = $state(false);
  let theme = $state<"system" | "light" | "dark">("system");

  function notify(kind: "success" | "error" | "info", title: string, description?: string) {
    toast[kind](title, description ? { description } : undefined);
  }

  // ── Theme (the page's variables follow <html data-theme>) ───────────────

  function applyTheme(t: typeof theme) {
    theme = t;
    const root = document.documentElement;
    if (t === "system") delete root.dataset.theme;
    else root.dataset.theme = t;
    try {
      localStorage.setItem("koe:theme", t);
    } catch {
      /* private mode */
    }
  }

  // ── Opening conversations, and the address bar ──────────────────────────

  async function openConversation(id: string | null) {
    if (!inbox) return;
    if (id) {
      pane = "thread";
      if (location.hash.slice(1) !== encodeURIComponent(id)) history.replaceState(null, "", `#${encodeURIComponent(id)}`);
    }
    await inbox.open(id);
  }

  function fromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && id !== inbox?.openId) void openConversation(id);
  }

  function move(step: 1 | -1) {
    if (!inbox || !inbox.list.length) return;
    const i = inbox.list.findIndex((c) => c.id === inbox!.openId);
    const next = inbox.list[Math.max(0, Math.min(inbox.list.length - 1, i < 0 ? 0 : i + step))];
    if (!next) return;
    void openConversation(next.id);
    void tick().then(() => {
      const root = (document.querySelector("koe-inbox") as HTMLElement | null)?.shadowRoot;
      root?.querySelector(`[data-conversation="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }

  /** Shortcuts, except while writing in a field. */
  function onKey(e: KeyboardEvent) {
    if (!inbox || inbox.auth !== "ok" || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.composedPath()[0] as HTMLElement | undefined;
    const typing = !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    if (e.key === "Escape") {
      if (typing) (target as HTMLElement).blur();
      else if (pane !== "list") pane = pane === "contact" ? "thread" : "list";
      return;
    }
    if (typing) return;
    if (e.key === "j") move(1);
    else if (e.key === "k") move(-1);
    else if (e.key === "r" && inbox.openId) {
      pane = "thread";
      void tick().then(() => composer?.focus());
    } else if (e.key === "e" && inbox.current && inbox.current.state !== "resolved") {
      inbox.act("resolve").then(
        () => notify("success", T.done.resolve),
        (err) => notify("error", T.actionFailed, err instanceof Error ? err.message : String(err))
      );
    } else if (e.key === "/") {
      pane = "list";
      void tick().then(() => search?.focus());
    } else return;
    e.preventDefault();
  }

  // ── Push ────────────────────────────────────────────────────────────────

  async function togglePush() {
    if (!inbox) return;
    pushBusy = true;
    try {
      if (push === "on") push = await disablePush(koeBase, inbox.api);
      else if (inbox.me?.pushKey) {
        push = await enablePush(koeBase, inbox.api, inbox.me.pushKey);
        if (push === "on") notify("success", T.pushReady);
        else if (push === "denied") notify("error", T.pushDenied);
      }
    } catch (e) {
      notify("error", T.pushFailed, e instanceof Error ? e.message : String(e));
    } finally {
      pushBusy = false;
    }
  }

  async function setAvailable(v: boolean) {
    try {
      await inbox?.heartbeat(v);
    } catch (e) {
      notify("error", T.saveFailed, e instanceof Error ? e.message : String(e));
    }
  }

  // ── Life cycle ──────────────────────────────────────────────────────────

  let stopWorker: (() => void) | null = null;

  onMount(() => {
    try {
      const t = localStorage.getItem("koe:theme");
      if (t === "light" || t === "dark") applyTheme(t);
    } catch {
      /* private mode */
    }
    const store = new Inbox(koeBase);
    store.onNotice = (n) => notify("info", n.title);
    inbox = store;
    void store.start().then(async () => {
      if (store.auth !== "ok") return;
      fromHash();
      if (store.me?.pushKey) push = await pushState(koeBase);
    });
    window.addEventListener("hashchange", fromHash);
    window.addEventListener("keydown", onKey);
    stopWorker = onWorkerMessage((id) => {
      if (id) void openConversation(id);
    });
  });

  onDestroy(() => {
    inbox?.stop();
    stopWorker?.();
    if (typeof window !== "undefined") {
      window.removeEventListener("hashchange", fromHash);
      window.removeEventListener("keydown", onKey);
    }
  });

  const liveLabel = $derived(inbox?.live === "live" ? T.live : inbox?.live === "connecting" ? T.connecting : T.offline);
</script>

<ThemeScope class="koe-inbox">
  {#if !inbox || inbox.auth === "loading"}
    <div class="center" aria-busy="true"><Spinner label={T.loading} /></div>
  {:else if inbox.auth === "signed-out"}
    <div class="center"><EmptyState size="md" level={1} title={T.signedOutTitle} description={T.signedOutBody} actionLabel={T.reload} onAction={() => location.reload()} /></div>
  {:else if inbox.auth === "not-member"}
    <div class="center"><EmptyState size="md" level={1} title={T.notMemberTitle} description={T.notMemberBody} /></div>
  {:else if inbox.auth === "error"}
    <div class="center"><EmptyState variant="error" size="md" level={1} title={T.failedTitle} description={inbox.authError} onRetry={() => void inbox!.start()} retryLabel={T.retry} /></div>
  {:else}
    <div class="app" data-pane={pane} class:with-contact={contactShown && !!inbox.openId}>
      <header class="bar">
        <h1>{T.appTitle}</h1>
        <span class="live live--{inbox.live}" role="status" title={liveLabel}><span class="dot" aria-hidden="true"></span><span class="live-text">{liveLabel}</span></span>
        <span class="grow"></span>
        <Switch size="sm" checked={inbox.available} label={inbox.available ? T.available : T.away} onchange={(v: boolean) => setAvailable(v)} />
        <Notices {inbox} onOpen={(id) => void openConversation(id)} />
        <Popover title={T.account} placement="bottom-end">
          {#snippet trigger(props)}
            <Button {...props} size="icon" variant="ghost" ariaLabel={T.account} title={T.account}>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
            </Button>
          {/snippet}
          <div class="settings">
            {#if push === "unsupported" || !inbox.me?.pushKey}
              <p class="dim">{T.pushUnsupported}</p>
            {:else if push === "denied"}
              <p class="dim">{T.pushDenied}</p>
            {:else}
              <Button size="sm" variant={push === "on" ? "outline" : "primary"} loading={pushBusy} onclick={togglePush}>{push === "on" ? T.pushTurnOff : T.pushOff}</Button>
            {/if}
            <div class="theme" role="group" aria-label={T.theme}>
              {#each [["system", T.themeSystem], ["light", T.themeLight], ["dark", T.themeDark]] as [value, label] (value)}
                <button type="button" aria-pressed={theme === value} onclick={() => applyTheme(value as typeof theme)}>{label}</button>
              {/each}
            </div>
            <div class="keys">
              <strong>{T.shortcuts}</strong>
              <dl>
                {#each T.shortcutList as [k, what] (k)}<dt><kbd>{k}</kbd></dt><dd>{what}</dd>{/each}
              </dl>
            </div>
          </div>
        </Popover>
      </header>

      <div class="panes">
        <div class="pane pane--list">
          <ConversationList {inbox} bind:searchRef={search} onOpen={(id) => void openConversation(id)} />
        </div>
        <div class="pane pane--thread">
          <Thread
            {inbox}
            {contactShown}
            bind:textarea={composer}
            onToast={notify}
            onBack={() => (pane = "list")}
            onToggleContact={() => {
              if (window.matchMedia("(max-width: 767px)").matches) pane = "contact";
              else contactShown = !contactShown;
            }}
          />
        </div>
        {#if inbox.openId && (contactShown || pane === "contact")}
          <div class="pane pane--contact">
            <ContactPane
              {inbox}
              onToast={notify}
              onOpen={(id) => void openConversation(id)}
              onWriteNote={() => {
                pane = "thread";
                void tick().then(() => composer?.focus());
              }}
              onClose={() => {
                if (pane === "contact") pane = "thread";
                else contactShown = false;
              }}
            />
          </div>
        {/if}
      </div>
    </div>
  {/if}
  <Toaster />
</ThemeScope>

<style>
  :host {
    display: block;
    height: 100%;
  }

  :global(.koe-inbox) {
    height: 100%;
    background: rgb(var(--ta-bg));
  }

  .center {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 1.5rem;
  }

  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 3rem;
    padding: 0.25rem 0.75rem;
    border-bottom: 1px solid rgb(var(--ta-border));
    background: rgb(var(--ta-surface));
  }

  h1 {
    margin: 0;
    font-size: 1rem;
  }

  .grow {
    flex: 1;
  }

  .live {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .live .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: rgb(var(--ta-subtle));
  }

  .live--live .dot {
    background: rgb(var(--ta-success));
  }

  .live--connecting .dot {
    background: rgb(var(--ta-warning));
  }

  .panes {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(18rem, 22rem) minmax(0, 1fr);
    position: relative;
  }

  .with-contact .panes {
    grid-template-columns: minmax(18rem, 22rem) minmax(0, 1fr) minmax(16rem, 20rem);
  }

  .pane {
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  .pane--list {
    border-right: 1px solid rgb(var(--ta-border));
  }

  .pane--contact {
    border-left: 1px solid rgb(var(--ta-border));
  }

  /* Medium screens: the contact pane slides over the thread instead of squeezing it. */
  @media (max-width: 1279px) {
    .with-contact .panes {
      grid-template-columns: minmax(16rem, 20rem) minmax(0, 1fr);
    }

    .pane--contact {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(22rem, 90%);
      z-index: 3;
      box-shadow: -8px 0 24px rgb(0 0 0 / 0.2);
    }
  }

  /* Phones: one pane at a time. */
  @media (max-width: 767px) {
    .panes,
    .with-contact .panes {
      grid-template-columns: minmax(0, 1fr);
    }

    .pane {
      display: none;
    }

    [data-pane="list"] .pane--list,
    [data-pane="thread"] .pane--thread,
    [data-pane="contact"] .pane--contact {
      display: block;
    }

    .pane--contact {
      position: static;
      width: auto;
      box-shadow: none;
      border-left: 0;
    }

    .pane--list {
      border-right: 0;
    }

    .live-text {
      display: none;
    }
  }

  .settings {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 15rem;
  }

  .dim {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .theme {
    display: flex;
    gap: 0.25rem;
    flex-wrap: wrap;
  }

  .theme button {
    padding: 0.25rem 0.5rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-sm);
    background: none;
    color: rgb(var(--ta-text-dim));
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }

  .theme button[aria-pressed="true"] {
    border-color: rgb(var(--ta-accent));
    color: rgb(var(--ta-text));
  }

  .theme button:focus-visible {
    outline: 2px solid rgb(var(--ta-accent));
  }

  .keys dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 0.75rem;
    margin: 0.375rem 0 0;
    font-size: 0.8125rem;
  }

  .keys dt,
  .keys dd {
    margin: 0;
  }

  kbd {
    padding: 0 0.35rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: 0.25rem;
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
  }
</style>

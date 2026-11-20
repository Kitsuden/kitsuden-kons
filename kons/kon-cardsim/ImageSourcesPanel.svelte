<script lang="ts">
  /**
   * "My images": where the card images come from, in the player's order
   * ============================================================================
   *
   * Renders an `ImagesController` (`cardsim.images.controller.ts`); all the logic lives there.
   * Images never leave the browser: the panel says so in one line, and nothing else explains it.
   */
  import { untrack } from "svelte";

  import type { BoardTexts } from "./cardsim.board.i18n.js";
  import { formatBytes } from "./cardsim.board.i18n.js";
  import { localId, type ImagesController, type ImagesState } from "./cardsim.images.controller.js";
  import { urlProblem } from "./cardsim.images.js";

  interface Props {
    controller: ImagesController;
    texts: BoardTexts;
    lang?: string;
  }

  const { controller, texts, lang }: Props = $props();

  let current = $state.raw<ImagesState>(untrack(() => controller.state));
  // Follows the controller it is given, and lets go of it when it changes or the panel closes.
  $effect(() => {
    const unsubscribe = controller.subscribe((s) => (current = s));
    return () => void unsubscribe();
  });

  type Adding = null | "template" | "cardUrls" | "pack";
  let adding = $state<Adding>(null);
  let label = $state("");
  let link = $state("");
  let lines = $state("");
  let busy = $state(false);
  let note = $state<string | null>(null);
  let localError = $state<string | null>(null);

  let folderInput: HTMLInputElement | undefined = $state();
  let zipInput: HTMLInputElement | undefined = $state();

  const KIND_NAME = $derived<Record<string, string>>({
    folder: texts.addFolder,
    zip: texts.addZip,
    dropped: texts.dropped,
    template: texts.addTemplate,
    cardUrls: texts.addCardUrls,
    pack: texts.addPack,
  });

  /** The controller's errors are codes or English reasons; this says them in the board's language. */
  const errorText = $derived.by(() => {
    const e = localError ?? current.error;
    if (!e) return null;
    if (e === "zip") return texts.zipFailed;
    if (e.startsWith("lines:")) return `${texts.cardUrlsHint} (${e})`;
    if (e.startsWith("Link refused: ")) {
      const why = e.slice("Link refused: ".length);
      return texts.linkRefused(texts.linkReasons[why] ?? why);
    }
    return e;
  });

  function reset() {
    adding = null;
    label = "";
    link = "";
    lines = "";
    localError = null;
  }

  async function run(task: () => Promise<unknown>) {
    busy = true;
    note = null;
    controller.clearError();
    try {
      await task();
    } finally {
      busy = false;
    }
  }

  async function addFolder() {
    if (controller.canPickFolders()) await run(() => controller.addFolderFromPicker());
    else folderInput?.click();
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    localError = null;
    if (adding === "template") {
      const problem = urlProblem(link);
      if (problem) return void (localError = `Link refused: ${problem}`);
      if (!link.includes("{id}") && !link.includes("{name}")) return void (localError = texts.templateHint);
    }
    if (adding === "pack") {
      const problem = urlProblem(link);
      if (problem) return void (localError = `Link refused: ${problem}`);
    }
    let ok = false;
    await run(async () => {
      if (adding === "template") ok = await controller.addTemplate(label, link.trim());
      else if (adding === "pack") ok = await controller.addPack(label, link.trim());
      else if (adding === "cardUrls") ok = await controller.addCardUrls(label, lines);
    });
    if (ok) reset();
  }

  const isMissing = (s: ImagesState["sources"][number]) =>
    (s.kind === "folder" || s.kind === "zip") && !current.open.has(localId(s));
</script>

<section class="cs-images" aria-labelledby="cs-images-title">
  <header class="cs-images__head">
    <h3 id="cs-images-title">{texts.myImages}</h3>
    <span class="cs-chip">{current.synced ? texts.synced : texts.localOnly}</span>
  </header>
  <p class="cs-images__notice">{texts.byodNotice}</p>

  <p class="cs-label">{texts.sources}</p>
  {#if current.sources.length === 0}
    <p class="cs-faint">{texts.noSources}</p>
  {:else}
    <ol class="cs-sources">
      {#each current.sources as source, i (localId(source))}
        <li class={["cs-source", source.enabled === false && "cs-source--off"]}>
          <span class="cs-source__kind">{KIND_NAME[source.kind]}</span>
          <span class="cs-source__label" title={"url" in source ? source.url : source.label}>{source.label}</span>
          {#if source.kind === "folder" && current.closedFolders.has(source.label)}
            <button type="button" class="cs-btn cs-btn--sm" disabled={busy} onclick={() => run(() => controller.reopen(source.label))}>
              {texts.reopen}
            </button>
          {:else if isMissing(source)}
            <span class="cs-faint cs-source__missing">{texts.notOnThisDevice}</span>
          {/if}
          <span class="cs-source__actions">
            <label class="cs-switch">
              <input type="checkbox" checked={source.enabled !== false} disabled={busy} onchange={() => run(() => controller.toggle(i))} />
              <span>{texts.enabled}</span>
            </label>
            <button type="button" class="cs-icon" aria-label={texts.moveUp} title={texts.moveUp} disabled={busy || i === 0} onclick={() => run(() => controller.move(i, -1))}>↑</button>
            <button type="button" class="cs-icon" aria-label={texts.moveDown} title={texts.moveDown} disabled={busy || i === current.sources.length - 1} onclick={() => run(() => controller.move(i, 1))}>↓</button>
            <button type="button" class="cs-icon" aria-label={texts.remove} title={texts.remove} disabled={busy} onclick={() => run(() => controller.remove(i))}>✕</button>
          </span>
        </li>
      {/each}
    </ol>
  {/if}

  {#if adding === null}
    <div class="cs-row">
      <button type="button" class="cs-btn cs-btn--sm" disabled={busy} onclick={addFolder}>+ {texts.addFolder}</button>
      <button type="button" class="cs-btn cs-btn--sm" disabled={busy} onclick={() => zipInput?.click()}>+ {texts.addZip}</button>
      <button type="button" class="cs-btn cs-btn--sm" disabled={busy} onclick={() => (adding = "template")}>+ {texts.addTemplate}</button>
      <button type="button" class="cs-btn cs-btn--sm" disabled={busy} onclick={() => (adding = "cardUrls")}>+ {texts.addCardUrls}</button>
      <button type="button" class="cs-btn cs-btn--sm" disabled={busy} onclick={() => (adding = "pack")}>+ {texts.addPack}</button>
    </div>
  {:else}
    <form class="cs-form" onsubmit={submit}>
      <p class="cs-label">{KIND_NAME[adding]}</p>
      <label class="cs-field">
        <span>{texts.label}</span>
        <input type="text" maxlength="70" bind:value={label} />
      </label>
      {#if adding === "cardUrls"}
        <label class="cs-field">
          <span>{texts.link}</span>
          <textarea rows="5" bind:value={lines} placeholder={"OP01-025 | https://…\nNami | https://…"}></textarea>
        </label>
        <p class="cs-faint">{texts.cardUrlsHint}</p>
      {:else}
        <label class="cs-field">
          <span>{texts.link}</span>
          <input type="url" required bind:value={link} placeholder={adding === "template" ? "https://…/{id}.webp" : "https://…/pack.json"} />
        </label>
        <p class="cs-faint">{adding === "template" ? texts.templateHint : texts.packHint}</p>
      {/if}
      <div class="cs-row">
        <button type="submit" class="cs-btn cs-btn--primary cs-btn--sm" disabled={busy}>{texts.add}</button>
        <button type="button" class="cs-btn cs-btn--sm" disabled={busy} onclick={reset}>{texts.cancel}</button>
      </div>
    </form>
  {/if}

  {#if errorText}
    <p class="cs-error" role="alert">{errorText}</p>
  {/if}

  <p class="cs-faint cs-images__drop">{texts.dropHint}</p>

  <footer class="cs-images__foot">
    <span class="cs-faint">{texts.cacheUsage(current.usage.count, formatBytes(current.usage.bytes, lang))}</span>
    <span class="cs-row">
      <button
        type="button"
        class="cs-btn cs-btn--sm"
        disabled={busy}
        onclick={() => run(async () => (note = (await controller.persist()) ? texts.storageKept : null))}
      >
        {texts.keepStorage}
      </button>
      <button
        type="button"
        class="cs-btn cs-btn--sm"
        disabled={busy || current.usage.count === 0}
        onclick={() => run(async () => {
          await controller.clearCache();
          note = texts.clearCacheDone;
        })}
      >
        {texts.clearCache}
      </button>
    </span>
  </footer>
  {#if note}
    <p class="cs-faint" role="status">{note}</p>
  {/if}

  <!-- Hidden pickers: a folder where there is no directory picker, and zips -->
  <input
    bind:this={folderInput}
    class="cs-hidden"
    type="file"
    webkitdirectory
    multiple
    onchange={(e) => {
      const files = (e.currentTarget as HTMLInputElement).files;
      if (files?.length) run(() => controller.addFolderFromFiles(files));
      (e.currentTarget as HTMLInputElement).value = "";
    }}
  />
  <input
    bind:this={zipInput}
    class="cs-hidden"
    type="file"
    accept=".zip,application/zip"
    onchange={(e) => {
      const file = (e.currentTarget as HTMLInputElement).files?.[0];
      if (file) run(() => controller.addZip(file));
      (e.currentTarget as HTMLInputElement).value = "";
    }}
  />
</section>

<style>
  .cs-images {
    display: grid;
    gap: 0.6rem;
    padding: 1rem;
    border: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.08));
    border-radius: var(--cardsim-radius, 12px);
    background: var(--cardsim-surface, #17171c);
    color: var(--cardsim-text, #f4f4f5);
  }
  .cs-images__head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .cs-images__head h3 {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 700;
  }
  .cs-images__notice {
    margin: 0;
    font-size: 0.875rem;
    color: var(--cardsim-muted, #a1a1aa);
  }
  .cs-images__foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.08));
  }
  .cs-images__drop {
    margin: 0;
  }
  .cs-chip {
    border-radius: 999px;
    padding: 0.1rem 0.6rem;
    font-size: 0.72rem;
    border: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.08));
    color: var(--cardsim-muted, #a1a1aa);
  }
  .cs-label {
    margin: 0;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--cardsim-faint, #71717a);
  }
  .cs-faint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--cardsim-faint, #71717a);
  }
  .cs-error {
    margin: 0;
    font-size: 0.85rem;
    color: var(--cardsim-danger, #f87171);
  }
  .cs-sources {
    display: grid;
    gap: 0.35rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .cs-source {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.6rem;
    border-radius: 8px;
    background: var(--cardsim-surface-2, #222229);
    font-size: 0.85rem;
  }
  .cs-source--off {
    opacity: 0.55;
  }
  .cs-source__kind {
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--cardsim-accent, #f59e0b);
  }
  .cs-source__label {
    min-width: 0;
    flex: 1 1 8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cs-source__actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: auto;
  }
  .cs-switch {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: var(--cardsim-muted, #a1a1aa);
  }
  .cs-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .cs-form {
    display: grid;
    gap: 0.5rem;
  }
  .cs-field {
    display: grid;
    gap: 0.2rem;
    font-size: 0.8rem;
    color: var(--cardsim-muted, #a1a1aa);
  }
  .cs-field input,
  .cs-field textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 0.45rem 0.6rem;
    border-radius: 8px;
    border: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.12));
    background: var(--cardsim-input, #0f0f13);
    color: var(--cardsim-text, #f4f4f5);
    font: inherit;
    font-size: 0.85rem;
  }
  .cs-btn {
    border-radius: 8px;
    border: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.14));
    background: transparent;
    color: var(--cardsim-text, #f4f4f5);
    padding: 0.45rem 0.8rem;
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .cs-btn--sm {
    padding: 0.3rem 0.6rem;
    font-size: 0.8rem;
  }
  .cs-btn--primary {
    border-color: var(--cardsim-accent, #f59e0b);
    background: var(--cardsim-accent, #f59e0b);
    color: var(--cardsim-on-accent, #111);
    font-weight: 700;
  }
  .cs-btn:hover:not(:disabled) {
    border-color: var(--cardsim-accent, #f59e0b);
  }
  .cs-btn:disabled,
  .cs-icon:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .cs-icon {
    width: 1.8rem;
    height: 1.8rem;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--cardsim-muted, #a1a1aa);
    cursor: pointer;
  }
  .cs-icon:hover:not(:disabled) {
    border-color: var(--cardsim-border, rgb(255 255 255 / 0.14));
    color: var(--cardsim-text, #f4f4f5);
  }
  .cs-btn:focus-visible,
  .cs-icon:focus-visible,
  .cs-field input:focus-visible,
  .cs-field textarea:focus-visible {
    outline: 2px solid var(--cardsim-accent, #f59e0b);
    outline-offset: 2px;
  }
  .cs-hidden {
    display: none;
  }
</style>

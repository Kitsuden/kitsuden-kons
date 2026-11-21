<script lang="ts">
  /**
   * `@kitsuden/kon-cardsim/board` — the solo board
   * ============================================================================
   *
   * A real game against nobody: shuffle, draw, play cards around the board and keep the counters.
   * It is what you need to test a deck before taking it to a table, and the step before playing
   * another person — same engine, same board, only the second seat is missing.
   *
   * Moved from the Cardback site (`TableroSolitario.svelte`) into the kon, 2026-11-20, with the
   * card images brought by the player (`./images`).
   *
   * ── WHY EVERYTHING HAPPENS IN THE BROWSER ──────────────────────────────────
   *
   * The engine has no Node dependency, so it runs here: the solo board works **without an
   * account**, **offline**, and writes nothing to any database. Nobody should have to sign up to
   * shuffle their own deck. With `apiBase` and a session, only the player's IMAGE SETTINGS go to
   * the kon (`/image-prefs`); the deck and the game never do.
   *
   * ── WHAT THE ENGINE DOES AND WHAT IT DOES NOT ──────────────────────────────
   *
   * It keeps the STRUCTURE —zones, caps, what is seen and what is not, defeats— and does NOT read
   * the cards' text: the player carries out effects by moving cards.
   *
   * ── UNDO ───────────────────────────────────────────────────────────────────
   *
   * The game is not stored: the ACTION LIST is, and the state is rebuilt by replaying it with the
   * same seed. Undo is dropping the last one and replaying.
   *
   * ── IMAGES ─────────────────────────────────────────────────────────────────
   *
   * `imageMode="byod"`: the catalog's pictures are ignored even if a site passes them; every card
   * comes from the player's sources or is drawn by code. `hosted`: the site's picture is used when
   * the player has none of their own. Dropping or pasting an image on a card always wins.
   *
   * Theming: CSS custom properties `--cardsim-*` on any ancestor (see the style block).
   */
  import { onDestroy, onMount } from "svelte";

  import {
    applyAction,
    createSession,
    mainSectionOf,
    replay,
    sectionsOf,
    validateDeck,
    viewFor,
    type Action,
    type CardCatalog,
    type DeckSection,
    type GameDefinition,
    type SessionView,
  } from "./cardsim.engine.js";
  import { parseDeckList } from "./cardsim.decklist.js";
  import { boardTexts, type BoardTexts } from "./cardsim.board.i18n.js";
  import { freeTable, soloSeat } from "./cardsim.solo.js";
  import type { ImageMode } from "./cardsim.images.js";
  import {
    createBestCache,
    type CardRef,
    type ResolvedImage,
    type SourceRuntime,
  } from "./cardsim.images.client.js";
  import { createImagesController, type ImagesController } from "./cardsim.images.controller.js";
  import ImageSourcesPanel from "./ImageSourcesPanel.svelte";

  /** What the site knows about a card, by the key the deck list uses (a name or an id). */
  type CatalogCard = {
    name: string;
    /** The card's catalog id, when the list key is a name. Used to find images by id. */
    id?: string;
    /** Site-hosted picture. Ignored in `byod`. */
    image?: string | null;
    /** Cost, type, color…: for the card drawn by code. */
    data?: Record<string, unknown>;
  };

  interface Props {
    /** The game's key for image settings and cache (a cardsim slug or the site's game slug). */
    game: string;
    definition: GameDefinition;
    catalog?: Record<string, CatalogCard>;
    /** Lists to start from without typing. */
    presets?: Array<{ name: string; cards: string[] }>;
    imageMode?: ImageMode;
    /** The kon's base URL (`…/api/cardsim`) to keep image settings in the player's account. */
    apiBase?: string;
    /** Language tag; defaults to the page's `<html lang>`. */
    lang?: string;
    /** Single strings to override. */
    texts?: Partial<BoardTexts>;
  }

  const {
    game,
    definition,
    catalog = {},
    presets = [],
    imageMode = "byod",
    apiBase,
    lang: langProp,
    texts: overrides = {},
  }: Props = $props();

  const lang = $derived(
    langProp ?? (typeof document !== "undefined" ? document.documentElement.lang : undefined) ?? "en"
  );
  const t = $derived(boardTexts(lang, overrides));

  // ── The list ──────────────────────────────────────────────────────────────

  let listText = $state("");
  let errors = $state.raw<string[]>([]);

  /**
   * Deck sections with the MAIN one first. `parseDeckList` sends everything without a header to
   * `sections[0]`, and in ONE PIECE the first is the Leader (one card): a pasted list ended up
   * there whole, with an error ("the maximum is 1") that looked nothing like the problem.
   */
  const sections = $derived.by<DeckSection[]>(() => {
    const main = mainSectionOf(definition);
    return [main, ...sectionsOf(definition).filter((s) => s.id !== main.id)];
  });

  const deck = $derived(parseDeckList(listText, sections));
  const cardTotal = $derived(Object.values(deck.cards).reduce((n, list) => n + list.length, 0));

  /**
   * Cards are identified by the key the list uses (usually the NAME): the game's catalog has
   * thousands of cards, and sending it whole to the browser for one game would be absurd.
   */
  const sessionCatalog = $derived.by<CardCatalog>(() => {
    const cat: CardCatalog = {};
    for (const list of Object.values(deck.cards)) {
      for (const id of list) {
        const known = catalog[id];
        cat[id] ??= { name: known?.name ?? id, ...(known?.data ?? {}) };
      }
    }
    return cat;
  });

  // ── Rules or free table ───────────────────────────────────────────────────

  let mode = $state<"rules" | "free">("rules");

  const activeDefinition = $derived.by(() => {
    const base = soloSeat(definition);
    return mode === "free" ? freeTable(base, deck.cards[mainSectionOf(base).id]?.length ?? 0) : base;
  });

  /** A meta list ALWAYS opens on the free table: it is a sample of cards, not a full deck. */
  function choosePreset(value: string) {
    const i = value === "" ? Number.NaN : Number(value);
    const chosen = Number.isFinite(i) ? presets[i] : null;
    if (!chosen) return;
    listText = `# ${sections[0].name}\n${chosen.cards.join("\n")}\n`;
    mode = "free";
    errors = [];
  }

  /** A template with each section's header and what it asks for. */
  function fillTemplate() {
    listText = sections
      .map((s) => {
        const size = s.minSize === s.maxSize ? `${s.minSize}` : `${s.minSize}-${s.maxSize}`;
        return `# ${s.name}\n// ${t.sectionSize(size)}\n`;
      })
      .join("\n");
  }

  // ── The game ──────────────────────────────────────────────────────────────

  let session = $state.raw<ReturnType<typeof createSession> | null>(null);
  let view = $state.raw<SessionView | null>(null);
  let actions = $state.raw<Action[]>([]);
  let seed = 0;
  const ME = 0;

  /**
   * What is being played, frozen at the start. Undo REPLAYS from scratch, so it must replay with
   * the same deck, catalog and rules it started with; reading them from the screen again would
   * rebuild a different game without saying so.
   */
  let playing: { definition: GameDefinition; cards: Record<string, string[]>; catalog: CardCatalog } | null =
    null;

  function refresh() {
    if (session) view = viewFor(session, ME);
  }

  function start() {
    const def = activeDefinition;
    const cards = deck.cards;
    const cat = sessionCatalog;
    if (cardTotal === 0) {
      errors = [t.pasteToStart];
      return;
    }
    // Lines the parser did not understand go FIRST: they are the likely cause of a missing card.
    const problems = [...deck.errors, ...validateDeck(def, cards, cat)];
    errors = problems;
    if (problems.length > 0) return;

    seed = Math.floor(Math.random() * 2 ** 31);
    actions = [];
    playing = { definition: def, cards, catalog: cat };
    try {
      // Two decks because the game is for two; only seat 0 is painted.
      session = createSession(def, [cards, { ...cards }], seed, cat);
    } catch (e) {
      errors = [e instanceof Error ? e.message : String(e)];
      playing = null;
      return;
    }
    refresh();
  }

  function act(...next: Action[]) {
    if (!session) return;
    const done: Action[] = [];
    try {
      for (const action of next) {
        applyAction(session, action, seed);
        done.push(action);
      }
      errors = [];
    } catch (e) {
      errors = [e instanceof Error ? e.message : String(e)];
    }
    // Only the ones that WERE applied: the log must keep describing the real state.
    actions = [...actions, ...done];
    refresh();
    closeMenu();
  }

  /** Ending the turn solo brings it back to YOU: once per seat is one full lap of the table. */
  const endTurn = () =>
    act(
      ...Array.from({ length: definition.players.min }, (_, seat) => ({
        type: "endTurn" as const,
        player: seat,
      }))
    );

  function undo() {
    const game = playing;
    if (!session || !game || actions.length === 0) return;
    const remaining = actions.slice(0, -1);
    session = replay(game.definition, [game.cards, { ...game.cards }], seed, remaining, game.catalog);
    actions = remaining;
    errors = [];
    refresh();
  }

  function reset() {
    session = null;
    view = null;
    playing = null;
    actions = [];
    errors = [];
  }

  // ── How the board is painted ──────────────────────────────────────────────

  const zones = $derived(definition.zones.filter((z) => !z.shared && z.id !== definition.handZone));
  const handZone = $derived(definition.handZone);
  const shared = $derived(definition.zones.filter((z) => z.shared));
  const mine = $derived(view?.players?.[ME] ?? null);

  /** A SHARED zone lives in `board`, not in the seat: reading only the seat left them empty. */
  const cardsIn = (zone: string) => mine?.zones?.[zone] ?? view?.board?.[zone] ?? [];
  const hiddenIn = (zone: string) => mine?.hiddenCounts?.[zone] ?? 0;
  const countIn = (zone: string) => cardsIn(zone).length + hiddenIn(zone);

  const nameOf = (cardId: string | null) => (cardId ? (catalog[cardId]?.name ?? cardId) : t.faceDown);

  /** A stacked zone (deck, graveyard) is painted as a pile with its count. */
  const isPile = (zoneId: string) => {
    const z = definition.zones.find((x) => x.id === zoneId);
    return z?.ordered === true || z?.visibility === "none";
  };

  // ── A card's menu ─────────────────────────────────────────────────────────

  let selected = $state.raw<{ instanceId: number; zone: string; cardId: string | null } | null>(null);
  const openMenu = (instanceId: number, zone: string, cardId: string | null) => {
    selected = selected?.instanceId === instanceId ? null : { instanceId, zone, cardId };
  };
  function closeMenu() {
    selected = null;
  }

  const targets = $derived(definition.zones.filter((z) => !z.shared && z.id !== selected?.zone));
  const move = (toZone: string) => {
    if (selected) act({ type: "move", player: ME, instanceId: selected.instanceId, toZone, toPlayer: ME });
  };
  const withSelected = (make: (instanceId: number) => Action) => {
    if (selected) act(make(selected.instanceId));
  };

  const resources = $derived(definition.resources ?? []);

  /** The log without the ghost seat's lines, nor turn handovers (the turn number is above). */
  const logLines = $derived(
    (view?.log ?? [])
      .filter((l) => (l.player === null || l.player === ME) && l.type !== "endTurn")
      .slice(-14)
      .reverse()
  );

  // ── Images ────────────────────────────────────────────────────────────────

  let images: ImagesController | null = $state.raw(null);
  let faces = $state.raw<Record<string, ResolvedImage>>({});
  const pending = new Set<string>();
  let imageError = $state<string | null>(null);
  let showImages = $state(false);

  const refOf = (key: string): CardRef => {
    const known = catalog[key];
    return { key, id: known?.id, name: known?.name ?? key, data: known?.data };
  };

  /** The site's pictures, after the player's own sources, only in `hosted`. Never cached. */
  const hostedSource = (): SourceRuntime => ({
    kind: "cardUrls",
    label: "site",
    async find(card) {
      const url = catalog[card.key]?.image;
      return url ? { directUrl: url } : null;
    },
  });

  onMount(() => {
    let disposed = false;
    let unsubscribe = () => {};
    (async () => {
      const cache = await createBestCache();
      if (disposed) return;
      const controller = createImagesController({
        game,
        cache,
        apiBase,
        trailing: imageMode === "hosted" ? [hostedSource()] : [],
      });
      unsubscribe = controller.resolver.onChange((key) => {
        pending.delete(key);
        const { [key]: _gone, ...rest } = faces;
        faces = rest;
      });
      images = controller;
      await controller.load();
      // Sources changed: everything not cached is looked up again.
      faces = Object.fromEntries(Object.entries(faces).filter(([, f]) => f.cached));
    })();
    return () => {
      disposed = true;
      unsubscribe();
    };
  });

  onDestroy(() => images?.dispose());

  /** Every card on screen gets looked up once; results arrive as they are found. */
  const visibleKeys = $derived.by(() => {
    const keys = new Set<string>();
    for (const z of [...zones, ...shared]) for (const c of cardsIn(z.id)) if (c.cardId) keys.add(c.cardId);
    for (const c of cardsIn(handZone)) if (c.cardId) keys.add(c.cardId);
    if (selected?.cardId) keys.add(selected.cardId);
    return [...keys];
  });

  $effect(() => {
    const controller = images;
    if (!controller) return;
    for (const key of visibleKeys) {
      if (faces[key] || pending.has(key)) continue;
      pending.add(key);
      controller.resolver
        .resolve(refOf(key))
        .then((face) => {
          if (!pending.has(key)) return; // superseded by a change
          pending.delete(key);
          faces = { ...faces, [key]: face };
        })
        .catch(() => pending.delete(key));
    }
  });

  /** A direct link that does not load: draw the card instead. */
  function onImageError(key: string) {
    const face = faces[key];
    if (face?.direct && images) faces = { ...faces, [key]: images.resolver.fallback(refOf(key)) };
  }

  async function useImage(key: string, file: Blob | null | undefined) {
    if (!images || !file) return;
    imageError = null;
    try {
      const face = await images.resolver.putDropped(refOf(key), file, t.dropped);
      pending.delete(key);
      faces = { ...faces, [key]: face };
      await images.refreshUsage();
    } catch {
      imageError = t.imageRejected;
    }
  }

  function dragOver(event: DragEvent) {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }

  function dropOn(key: string | null, event: DragEvent) {
    if (!key || !event.dataTransfer?.files.length) return;
    event.preventDefault();
    void useImage(key, event.dataTransfer.files[0]);
  }

  /** Pasting an image while a card's menu is open puts it on that card. */
  function onPaste(event: ClipboardEvent) {
    const key = selected?.cardId;
    if (!key) return;
    const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    void useImage(key, file);
  }

  async function forgetImage(key: string) {
    if (!images) return;
    await images.resolver.forget(refOf(key));
    await images.refreshUsage();
  }

  let filePicker: HTMLInputElement | undefined = $state();
</script>

<svelte:window onpaste={onPaste} />

{#snippet face(cardId: string | null)}
  {#if cardId === null}
    <span class="cs-card__back" aria-hidden="true"></span>
  {:else if faces[cardId]}
    <img
      src={faces[cardId].url}
      alt=""
      loading="lazy"
      referrerpolicy="no-referrer"
      onerror={() => onImageError(cardId)}
    />
  {:else}
    <span class="cs-card__text">{nameOf(cardId)}</span>
  {/if}
{/snippet}

<div class="cardsim" {lang}>
  {#if !view}
    <!-- ── Before starting: the list ── -->
    <section class="cs-panel">
      <h3 class="cs-title">{t.yourDeck}</h3>
      <p class="cs-muted">{t.yourDeckNote}</p>

      <ul class="cs-sections">
        {#each sections as s (s.id)}
          <li>
            <strong>{s.name}</strong>
            <span class="cs-accent">{deck.cards[s.id]?.length ?? 0}</span>
            <span class="cs-faint">/{s.minSize === s.maxSize ? s.minSize : `${s.minSize}–${s.maxSize}`}</span>
          </li>
        {/each}
      </ul>

      <div class="cs-toggle" role="group" aria-label={`${t.modeRules} / ${t.modeFree}`}>
        <button type="button" aria-pressed={mode === "rules"} onclick={() => (mode = "rules")}>{t.modeRules}</button>
        <button type="button" aria-pressed={mode === "free"} onclick={() => (mode = "free")}>{t.modeFree}</button>
      </div>
      <p class="cs-faint">{mode === "rules" ? t.modeRulesNote : t.modeFreeNote}</p>

      {#if presets.length > 0}
        <label class="cs-field">
          <span class="cs-label">{t.startFromMeta}</span>
          <select onchange={(e) => choosePreset((e.currentTarget as HTMLSelectElement).value)}>
            <option value="">{t.writeMine}</option>
            {#each presets as p, i (i)}
              <option value={String(i)}>{p.name}</option>
            {/each}
          </select>
          <span class="cs-faint">{t.metaNote}</span>
        </label>
      {/if}

      <textarea
        class="cs-list"
        bind:value={listText}
        rows={10}
        aria-label={t.yourDeck}
        placeholder={t.deckPlaceholder}
      ></textarea>
      {#if sections.length > 1}
        <p class="cs-faint">{t.noHeaderNote(sections[0].name, sections[1].name)}</p>
      {/if}

      {#if errors.length > 0}
        <ul class="cs-errors" role="alert">
          {#each errors as e (e)}
            <li>{e}</li>
          {/each}
        </ul>
      {/if}

      <div class="cs-row">
        <button type="button" class="cs-btn cs-btn--primary" onclick={start}>{t.shuffleAndStart}</button>
        {#if sections.length > 1}
          <button type="button" class="cs-btn cs-btn--sm" onclick={fillTemplate}>{t.template}</button>
        {/if}
        <span class="cs-faint">{t.cardCount(cardTotal)}</span>
        <button type="button" class="cs-btn cs-btn--sm cs-push" aria-expanded={showImages} onclick={() => (showImages = !showImages)}>
          {t.myImages}
        </button>
      </div>
    </section>
  {:else}
    <!-- ── The game ── -->
    <div class="cs-panel cs-toolbar">
      <button type="button" class="cs-btn cs-btn--primary" onclick={() => act({ type: "draw", player: ME, count: 1 })}>{t.draw}</button>
      <button type="button" class="cs-btn cs-btn--sm" onclick={() => act({ type: "shuffleZone", player: ME, zone: definition.deckZone })}>{t.shuffle}</button>
      <button type="button" class="cs-btn cs-btn--sm" onclick={() => act({ type: "mulligan", player: ME })}>{t.mulligan}</button>
      <button type="button" class="cs-btn cs-btn--sm" onclick={() => act({ type: "nextPhase", player: ME })}>{t.nextPhase}</button>
      <button type="button" class="cs-btn cs-btn--sm" onclick={endTurn}>{t.endTurn}</button>
      <button type="button" class="cs-btn cs-btn--sm" aria-label={t.rollDie} title={t.rollDie} onclick={() => act({ type: "roll", player: ME, sides: 6, count: 1 })}>🎲</button>
      <span class="cs-row cs-push">
        <button type="button" class="cs-btn cs-btn--sm" aria-expanded={showImages} onclick={() => (showImages = !showImages)}>{t.myImages}</button>
        <button type="button" class="cs-btn cs-btn--sm" disabled={actions.length === 0} onclick={undo}>{t.undo}</button>
        <button type="button" class="cs-btn cs-btn--sm" onclick={reset}>{t.otherDeck}</button>
      </span>
    </div>

    <p class="cs-faint cs-status">
      {t.turnLine(view.turn, view.phase)} ·
      {#if mode === "free"}
        <strong class="cs-accent">{t.freeTable}</strong>
      {:else}
        <span>{t.withRules}</span>
      {/if}
      · {t.engineNote}
    </p>

    {#if errors.length > 0}
      <ul class="cs-errors" role="alert">
        {#each errors as e (e)}
          <li>{e}</li>
        {/each}
      </ul>
    {/if}

    {#if resources.length > 0}
      <ul class="cs-resources">
        {#each resources as r (r.id)}
          <li class="cs-panel">
            <span class="cs-label">{r.name}</span>
            <button type="button" class="cs-step" aria-label={t.decrease(r.name)} onclick={() => act({ type: "resource", player: ME, target: ME, resource: r.id, delta: -1 })}>−</button>
            <span class="cs-value">{mine?.resources?.[r.id] ?? 0}</span>
            <button type="button" class="cs-step" aria-label={t.increase(r.name)} onclick={() => act({ type: "resource", player: ME, target: ME, resource: r.id, delta: 1 })}>+</button>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="cs-board">
      <ul class="cs-zones">
        {#each [...zones, ...shared] as z (z.id)}
          <li class="cs-panel">
            <p class="cs-zone-head">
              <span class="cs-label">{z.name}</span>
              <span class="cs-faint">{countIn(z.id)}</span>
            </p>
            <!-- A pile is not spread out: that would lie about what can be seen -->
            {#if isPile(z.id) && cardsIn(z.id).length === 0}
              <div class="cs-pile">{countIn(z.id) === 0 ? t.empty : t.pileCount(countIn(z.id))}</div>
            {:else}
              <ul class="cs-cards">
                {#each cardsIn(z.id) as c (c.instanceId)}
                  <li>
                    <button
                      type="button"
                      class={["cs-card", c.tapped && "cs-card--tapped", selected?.instanceId === c.instanceId && "cs-card--selected"]}
                      title={nameOf(c.cardId)}
                      aria-label={nameOf(c.cardId)}
                      aria-expanded={selected?.instanceId === c.instanceId}
                      onclick={() => openMenu(c.instanceId, z.id, c.cardId)}
                      ondragover={dragOver}
                      ondrop={(e) => dropOn(c.cardId, e)}
                    >
                      {@render face(c.cardId)}
                    </button>
                  </li>
                {/each}
                {#if cardsIn(z.id).length === 0}
                  <li class="cs-empty">{t.empty}</li>
                {/if}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>

      <div class="cs-panel">
        <p class="cs-label">{t.log}</p>
        <ol class="cs-log">
          {#each logLines as l, i (i)}
            <li>{l.text}</li>
          {/each}
          {#if logLines.length === 0}
            <li class="cs-faint">{t.nothingYet}</li>
          {/if}
        </ol>
      </div>
    </div>

    <div class="cs-panel cs-hand">
      <p class="cs-label">{t.hand(countIn(handZone))}</p>
      <ul class="cs-cards">
        {#each cardsIn(handZone) as c (c.instanceId)}
          <li>
            <button
              type="button"
              class={["cs-card cs-card--hand", selected?.instanceId === c.instanceId && "cs-card--selected"]}
              title={nameOf(c.cardId)}
              aria-label={nameOf(c.cardId)}
              aria-expanded={selected?.instanceId === c.instanceId}
              onclick={() => openMenu(c.instanceId, handZone, c.cardId)}
              ondragover={dragOver}
              ondrop={(e) => dropOn(c.cardId, e)}
            >
              {@render face(c.cardId)}
            </button>
          </li>
        {/each}
        {#if cardsIn(handZone).length === 0}
          <li class="cs-empty">{t.emptyHand}</li>
        {/if}
      </ul>
    </div>

    {#if selected}
      <div class="cs-panel cs-menu">
        <p class="cs-menu-head">
          <strong>{nameOf(selected.cardId)}</strong>
          {#if selected.cardId && faces[selected.cardId]}
            <span class="cs-chip">{t.origin[faces[selected.cardId].origin]}</span>
          {/if}
          <button type="button" class="cs-btn cs-btn--sm cs-push" onclick={closeMenu}>{t.close}</button>
        </p>
        <div class="cs-row">
          <button type="button" class="cs-btn cs-btn--sm" onclick={() => withSelected((instanceId) => ({ type: "tap", player: ME, instanceId, tapped: true }))}>{t.tap}</button>
          <button type="button" class="cs-btn cs-btn--sm" onclick={() => withSelected((instanceId) => ({ type: "tap", player: ME, instanceId, tapped: false }))}>{t.untap}</button>
          <button type="button" class="cs-btn cs-btn--sm" onclick={() => withSelected((instanceId) => ({ type: "flip", player: ME, instanceId }))}>{t.flip}</button>
          <button type="button" class="cs-btn cs-btn--sm" onclick={() => withSelected((instanceId) => ({ type: "counter", player: ME, instanceId, name: t.counterName, delta: 1 }))}>{t.addCounter}</button>
          {#if selected.cardId && images}
            <button type="button" class="cs-btn cs-btn--sm" onclick={() => filePicker?.click()}>{t.useImageFile}</button>
            {#if faces[selected.cardId]?.cached}
              <button type="button" class="cs-btn cs-btn--sm" onclick={() => selected?.cardId && forgetImage(selected.cardId)}>{t.forgetImage}</button>
            {/if}
          {/if}
        </div>
        <p class="cs-label">{t.moveTo}</p>
        <div class="cs-row">
          {#each targets as z (z.id)}
            <button type="button" class="cs-btn cs-btn--sm" onclick={() => move(z.id)}>{z.name}</button>
          {/each}
        </div>
      </div>
    {/if}
  {/if}

  {#if imageError}
    <p class="cs-errors" role="alert">{imageError}</p>
  {/if}

  {#if showImages && images}
    <div class="cs-images-wrap">
      <ImageSourcesPanel controller={images} texts={t} {lang} />
    </div>
  {/if}

  <input
    bind:this={filePicker}
    class="cs-hidden"
    type="file"
    accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
    onchange={(e) => {
      const input = e.currentTarget as HTMLInputElement;
      const key = selected?.cardId;
      if (key) void useImage(key, input.files?.[0]);
      input.value = "";
    }}
  />
</div>

<style>
  /*
   * Theme it from outside with custom properties on any ancestor:
   *   --cardsim-surface, --cardsim-surface-2, --cardsim-input, --cardsim-border, --cardsim-text,
   *   --cardsim-muted, --cardsim-faint, --cardsim-accent, --cardsim-on-accent, --cardsim-danger,
   *   --cardsim-radius, --cardsim-card-width, --cardsim-hand-width.
   */
  .cardsim {
    display: grid;
    gap: 0.9rem;
    color: var(--cardsim-text, #f4f4f5);
    font-size: 0.95rem;
  }
  .cs-panel {
    padding: 0.9rem;
    border: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.08));
    border-radius: var(--cardsim-radius, 12px);
    background: var(--cardsim-surface, #17171c);
  }
  .cs-title {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 700;
  }
  .cs-muted {
    margin: 0.3rem 0 0;
    font-size: 0.875rem;
    color: var(--cardsim-muted, #a1a1aa);
  }
  .cs-faint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--cardsim-faint, #71717a);
  }
  .cs-label {
    margin: 0;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--cardsim-faint, #71717a);
  }
  .cs-accent {
    color: var(--cardsim-accent, #f59e0b);
  }
  .cs-chip {
    border-radius: 999px;
    padding: 0.05rem 0.5rem;
    font-size: 0.7rem;
    border: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.12));
    color: var(--cardsim-muted, #a1a1aa);
  }
  .cs-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem;
  }
  .cs-push {
    margin-left: auto;
  }
  .cs-sections {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0.8rem 0 0;
    padding: 0;
    list-style: none;
  }
  .cs-sections li {
    display: flex;
    gap: 0.35rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.08));
    border-radius: 6px;
    font-size: 0.72rem;
    color: var(--cardsim-muted, #a1a1aa);
  }
  .cs-toggle {
    display: inline-flex;
    margin-top: 0.9rem;
    border: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.14));
    border-radius: 8px;
    overflow: hidden;
  }
  .cs-toggle button {
    padding: 0.35rem 0.8rem;
    border: 0;
    background: transparent;
    color: var(--cardsim-muted, #a1a1aa);
    font: inherit;
    font-size: 0.82rem;
    cursor: pointer;
  }
  .cs-toggle button[aria-pressed="true"] {
    background: var(--cardsim-accent, #f59e0b);
    color: var(--cardsim-on-accent, #111);
    font-weight: 700;
  }
  .cs-toggle + .cs-faint {
    margin-top: 0.35rem;
  }
  .cs-field {
    display: grid;
    gap: 0.3rem;
    margin-top: 0.9rem;
  }
  .cs-field select,
  .cs-list {
    width: 100%;
    box-sizing: border-box;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.12));
    border-radius: 8px;
    background: var(--cardsim-input, #0f0f13);
    color: var(--cardsim-text, #f4f4f5);
    font: inherit;
  }
  .cs-list {
    margin-top: 0.8rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem;
    line-height: 1.55;
  }
  .cs-list + .cs-faint {
    margin-top: 0.3rem;
  }
  .cs-errors {
    display: grid;
    gap: 0.2rem;
    margin: 0.6rem 0 0;
    padding: 0;
    list-style: none;
    color: var(--cardsim-danger, #f87171);
    font-size: 0.875rem;
  }
  section .cs-row {
    margin-top: 0.9rem;
  }
  .cs-btn {
    border-radius: 8px;
    border: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.14));
    background: transparent;
    color: var(--cardsim-text, #f4f4f5);
    padding: 0.5rem 0.9rem;
    font: inherit;
    font-size: 0.875rem;
    cursor: pointer;
  }
  .cs-btn--sm {
    padding: 0.32rem 0.65rem;
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
  .cs-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .cs-btn:focus-visible,
  .cs-toggle button:focus-visible,
  .cs-card:focus-visible,
  .cs-step:focus-visible,
  .cs-list:focus-visible,
  .cs-field select:focus-visible {
    outline: 2px solid var(--cardsim-accent, #f59e0b);
    outline-offset: 2px;
  }
  .cs-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem;
    padding: 0.7rem;
  }
  .cs-status {
    margin-top: -0.4rem;
  }
  .cs-resources {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .cs-resources li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.7rem;
  }
  .cs-value {
    min-width: 2ch;
    text-align: center;
    font-size: 1.25rem;
    font-weight: 800;
  }
  .cs-step {
    border-radius: 6px;
    border: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.08));
    background: transparent;
    color: var(--cardsim-muted, #a1a1aa);
    padding: 0.1rem 0.5rem;
    font-family: ui-monospace, monospace;
    font-weight: 700;
    cursor: pointer;
  }
  .cs-step:hover {
    color: var(--cardsim-accent, #f59e0b);
  }
  .cs-board {
    display: grid;
    gap: 0.75rem;
  }
  @media (min-width: 1024px) {
    .cs-board {
      grid-template-columns: minmax(0, 1fr) 260px;
      align-items: start;
    }
  }
  .cs-zones {
    display: grid;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  @media (min-width: 640px) {
    .cs-zones {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .cs-zone-head {
    display: flex;
    justify-content: space-between;
    margin: 0;
  }
  .cs-pile {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 5rem;
    margin-top: 0.5rem;
    border: 1px dashed var(--cardsim-border, rgb(255 255 255 / 0.12));
    border-radius: 8px;
    color: var(--cardsim-faint, #71717a);
    font-size: 0.85rem;
  }
  .cs-cards {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.5rem 0 0;
    padding: 0;
    list-style: none;
  }
  .cs-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 5rem;
    color: var(--cardsim-faint, #71717a);
    font-size: 0.85rem;
  }
  .cs-hand .cs-empty {
    min-height: 3rem;
  }
  .cs-card {
    display: block;
    width: var(--cardsim-card-width, 52px);
    aspect-ratio: 5 / 7;
    padding: 0;
    overflow: hidden;
    border-radius: 0.3rem;
    border: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.1));
    background: var(--cardsim-surface-2, #222229);
    cursor: pointer;
    transition:
      transform 0.15s,
      border-color 0.15s;
  }
  .cs-card--hand {
    width: var(--cardsim-hand-width, 66px);
  }
  .cs-card:hover {
    transform: translateY(-3px);
    border-color: var(--cardsim-accent, #f59e0b);
  }
  .cs-card--tapped {
    transform: rotate(90deg);
  }
  .cs-card--tapped:hover {
    transform: rotate(90deg) translateX(-3px);
  }
  .cs-card--selected {
    border-color: var(--cardsim-accent, #f59e0b);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--cardsim-accent, #f59e0b) 35%, transparent);
  }
  .cs-card img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .cs-card__text {
    display: block;
    padding: 0.2rem;
    font-size: 8px;
    line-height: 1.15;
    font-weight: 600;
    text-align: left;
    color: var(--cardsim-muted, #d4d4d8);
    overflow-wrap: anywhere;
  }
  .cs-card__back {
    display: block;
    width: 100%;
    height: 100%;
    background: repeating-linear-gradient(
      45deg,
      var(--cardsim-surface-2, #222229) 0 6px,
      color-mix(in srgb, var(--cardsim-accent, #f59e0b) 18%, var(--cardsim-surface-2, #222229)) 6px 12px
    );
  }
  .cs-log {
    display: grid;
    gap: 0.25rem;
    margin: 0.5rem 0 0;
    padding: 0;
    list-style: none;
    font-size: 0.75rem;
    line-height: 1.5;
    color: var(--cardsim-muted, #a1a1aa);
  }
  .cs-menu {
    display: grid;
    gap: 0.5rem;
    border-color: color-mix(in srgb, var(--cardsim-accent, #f59e0b) 45%, transparent);
  }
  .cs-menu-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
  }
  .cs-images-wrap {
    max-width: 44rem;
  }
  .cs-hidden {
    display: none;
  }
</style>

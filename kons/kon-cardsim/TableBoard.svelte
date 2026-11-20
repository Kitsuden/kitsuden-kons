<script lang="ts">
  /**
   * `@kitsuden/kon-cardsim/board/table` — playing another person
   * ============================================================================
   *
   * Lobby (your decks, create a room, join with a code, open rooms) and the two-seat table, over
   * the kon's routes and the host's WebSocket (`./table`). The server decides everything: what
   * each seat sees (`viewFor`), whether an action is legal, the clock. This component only shows
   * the seat's view and sends what the player does.
   *
   * Card images are the player's own (`./images`), exactly as on the solo board; nothing about
   * them travels between players unless a player shares a link and the other accepts it.
   *
   * The game must be published in the kon (`publish-game`): decks are validated against its
   * catalog on the server.
   */
  import { onDestroy, onMount } from "svelte";

  import type { GameDefinition, RedactedCard, SessionView } from "./cardsim.engine.js";
  import { boardTexts, type BoardTexts } from "./cardsim.board.i18n.js";
  import { tableTexts, type TableTexts } from "./cardsim.table.i18n.js";
  import {
    ApiError,
    connectRealtime,
    createTableApi,
    createTableSession,
    realtimeUrl,
    type RoomSummary,
    type TableSession,
    type TableState,
  } from "./cardsim.table.client.js";
  import { createBestCache, type CardRef, type ResolvedImage, type SourceRuntime } from "./cardsim.images.client.js";
  import { createImagesController, type ImagesController, type ImagesState } from "./cardsim.images.controller.js";
  import ImageSourcesPanel from "./ImageSourcesPanel.svelte";

  interface Props {
    /** The kon's base URL, e.g. `https://api.example.org/api/cardsim` (or `/api/cardsim`). */
    apiBase: string;
    /** The published cardsim game's slug. */
    game: string;
    /** Open this table directly (a shared link). */
    sessionId?: string | null;
    /** Told whenever the player enters or leaves a table, to keep it in the page's URL. */
    onTable?: (sessionId: string | null) => void;
    lang?: string;
    texts?: Partial<BoardTexts>;
    tableTextOverrides?: Partial<TableTexts>;
  }

  const {
    apiBase,
    game,
    sessionId: initialSession = null,
    onTable,
    lang: langProp,
    texts: overrides = {},
    tableTextOverrides = {},
  }: Props = $props();

  const lang = $derived(
    langProp ?? (typeof document !== "undefined" ? document.documentElement.lang : undefined) ?? "en"
  );
  const t = $derived(boardTexts(lang, overrides));
  const tt = $derived(tableTexts(lang, tableTextOverrides));

  // svelte-ignore state_referenced_locally
  const api = createTableApi({ apiBase });

  // ── The game ────────────────────────────────────────────────────────────────

  let gameRow = $state.raw<{ id: string; slug: string; name: string; imageMode?: string; definition: GameDefinition } | null>(null);
  let gameError = $state<string | null>(null);

  // ── Lobby ───────────────────────────────────────────────────────────────────

  let decks = $state.raw<Array<{ id: string; name: string }>>([]);
  let signedIn = $state(true);
  let deckId = $state("");
  let newDeckName = $state("");
  let newDeckList = $state("");
  let rooms = $state.raw<RoomSummary[]>([]);
  let roomName = $state("");
  let roomPassword = $state("");
  let allowSpectators = $state(true);
  let clockMinutes = $state(0);
  let bestOf = $state(1);
  let code = $state("");
  let codePassword = $state("");
  let lobbyError = $state<string | null>(null);
  let lobbyBusy = $state(false);
  let roomCode = $state<string | null>(null);

  const messageOf = (e: unknown) => (e instanceof ApiError ? (e.status === 401 ? tt.auth : e.message) : String(e));

  async function loadLobby() {
    if (!gameRow) return;
    try {
      rooms = (await api.listRooms(gameRow.id)).data;
    } catch {
      rooms = [];
    }
    try {
      decks = (await api.myDecks(gameRow.id)).data;
      signedIn = true;
      if (!deckId && decks[0]) deckId = decks[0].id;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) signedIn = false;
    }
  }

  async function lobby<T>(task: () => Promise<T>): Promise<T | null> {
    lobbyBusy = true;
    lobbyError = null;
    try {
      return await task();
    } catch (e) {
      lobbyError = messageOf(e);
      return null;
    } finally {
      lobbyBusy = false;
    }
  }

  async function saveDeck() {
    if (!gameRow || !newDeckList.trim()) return;
    const saved = await lobby(() =>
      api.importDeck({ gameId: gameRow!.id, name: newDeckName.trim() || undefined, content: newDeckList })
    );
    if (saved) {
      newDeckList = "";
      newDeckName = "";
      await loadLobby();
      deckId = saved.data.id;
    }
  }

  async function createRoom() {
    if (!gameRow) return;
    if (!deckId) return void (lobbyError = tt.pickDeckFirst);
    const created = await lobby(() =>
      api.createRoom({
        gameId: gameRow!.id,
        deckIds: [deckId],
        name: roomName.trim() || undefined,
        password: roomPassword || undefined,
        allowSpectators,
        bestOf,
        ...(clockMinutes ? { timeControlSeconds: clockMinutes * 60 } : {}),
      })
    );
    if (created) {
      roomCode = created.data.code;
      await enter(created.data.id);
    }
  }

  /** Sit in the first free seat: the code says which room, not which seat. */
  async function sit(roomId: string, password?: string) {
    if (!deckId) return void (lobbyError = tt.pickDeckFirst);
    const seats = gameRow?.definition.players.max ?? 2;
    const done = await lobby(async () => {
      let last: unknown = null;
      for (let seat = 0; seat < seats; seat++) {
        try {
          return await api.takeSeat(roomId, { seat, deckId, password: password || undefined });
        } catch (e) {
          last = e;
          // Taken: try the next one. Anything else (password, already seated) is the answer.
          if (!(e instanceof ApiError && e.status === 409 && /taken/i.test(e.message))) throw e;
        }
      }
      throw last;
    });
    if (done) await enter(roomId);
  }

  async function joinByCode(watchOnly: boolean) {
    const found = await lobby(() => api.findRoom(code));
    if (!found) return;
    roomCode = code.trim().toUpperCase();
    if (watchOnly) await enter(found.data.id);
    else await sit(found.data.id, codePassword);
  }

  // ── The table ───────────────────────────────────────────────────────────────

  let table: TableSession | null = null;
  let ts = $state.raw<TableState | null>(null);
  let unsubscribeTable = () => {};
  let clockTick = $state(0);
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  async function enter(id: string) {
    leave(false);
    const session = createTableSession({
      api,
      sessionId: id,
      realtime: (opts) => connectRealtime({ url: realtimeUrl(apiBase), ...opts }),
    });
    table = session;
    unsubscribeTable = session.subscribe((s) => (ts = s));
    await session.start();
    onTable?.(id);
    tickTimer = setInterval(() => (clockTick = Date.now()), 500);
  }

  function leave(notify = true) {
    unsubscribeTable();
    table?.stop();
    table = null;
    ts = null;
    selected = null;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (notify) {
      onTable?.(null);
      void loadLobby();
    }
  }

  const view = $derived<SessionView | null>(ts?.view ?? null);
  const mySeat = $derived(ts?.seat ?? null);
  const definition = $derived<GameDefinition | null>(ts?.definition ?? gameRow?.definition ?? null);
  const playing = $derived(ts?.status === "playing" && !view?.result);
  const seatsOrder = $derived.by(() => {
    const n = view?.players.length ?? 0;
    const all = Array.from({ length: n }, (_, i) => i);
    // Your seat at the bottom; spectators see seat 0 at the bottom.
    const bottom = mySeat ?? 0;
    return [...all.filter((i) => i !== bottom), bottom];
  });

  const nameOfSeat = (seat: number) => (seat === mySeat ? tt.you : tt.player(seat + 1));

  const zonesFor = $derived(definition ? definition.zones.filter((z) => !z.shared && z.id !== definition.handZone) : []);
  const sharedZones = $derived(definition ? definition.zones.filter((z) => z.shared) : []);
  const handZone = $derived(definition?.handZone ?? "hand");

  const cardsIn = (seat: number, zone: string): RedactedCard[] => view?.players[seat]?.zones?.[zone] ?? [];
  const hiddenIn = (seat: number, zone: string) => view?.players[seat]?.hiddenCounts?.[zone] ?? 0;
  const countIn = (seat: number, zone: string) => cardsIn(seat, zone).length + hiddenIn(seat, zone);
  const isPile = (zoneId: string) => {
    const z = definition?.zones.find((x) => x.id === zoneId);
    return z?.ordered === true || z?.visibility === "none";
  };

  const clocks = $derived.by(() => {
    void clockTick;
    return table?.clocksNow() ?? null;
  });
  const fmtClock = (ms: number) => {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  // ── Acting ──────────────────────────────────────────────────────────────────

  let selected = $state.raw<{ instanceId: number; zone: string; cardId: string | null } | null>(null);
  const act = (action: Record<string, unknown>) => {
    selected = null;
    void table?.act(action);
  };
  const targets = $derived(definition ? definition.zones.filter((z) => !z.shared && z.id !== selected?.zone) : []);

  const resultText = $derived.by(() => {
    const result = view?.result;
    if (!result) return null;
    if (result.winners.length !== 1) return tt.draw;
    const w = result.winners[0];
    if (mySeat === null) return tt.winner(tt.player(w + 1));
    return w === mySeat ? tt.youWon : tt.youLost;
  });

  const errorText = $derived.by(() => {
    const e = ts?.error;
    if (!e) return null;
    if (e.kind === "stale") return tt.stale;
    if (e.kind === "offline") return tt.offline;
    if (e.kind === "auth") return tt.auth;
    return e.message;
  });

  const logLines = $derived((view?.log ?? []).slice(-14).reverse());

  // ── Card names and images ───────────────────────────────────────────────────

  let names = $state.raw<Record<string, { name: string; data?: Record<string, unknown>; imageUrl?: string | null }>>({});
  const asking = new Set<string>();

  $effect(() => {
    const ids = new Set<string>();
    if (view) {
      for (const p of view.players) for (const list of Object.values(p.zones ?? {})) for (const c of list) if (c.cardId) ids.add(c.cardId);
      for (const list of Object.values(view.board ?? {})) for (const c of list) if (c.cardId) ids.add(c.cardId);
    }
    const missing = [...ids].filter((id) => !names[id] && !asking.has(id));
    if (!missing.length || !gameRow) return;
    for (const id of missing) asking.add(id);
    for (let i = 0; i < missing.length; i += 200) {
      const chunk = missing.slice(i, i + 200);
      api
        .lookupCards(gameRow.slug, chunk)
        .then((r) => {
          const next = { ...names };
          for (const c of r.data) next[c.cardId] = { name: c.name, data: c.data, imageUrl: c.imageUrl };
          // Unknown ids keep their id as name, so they are not asked again.
          for (const id of chunk) next[id] ??= { name: id };
          names = next;
        })
        .catch(() => chunk.forEach((id) => asking.delete(id)));
    }
  });

  const nameOf = (cardId: string | null) => (cardId ? (names[cardId]?.name ?? cardId) : t.faceDown);
  const refOf = (cardId: string): CardRef => ({ key: cardId, id: cardId, name: names[cardId]?.name ?? cardId, data: names[cardId]?.data });

  let images: ImagesController | null = $state.raw(null);
  let faces = $state.raw<Record<string, ResolvedImage>>({});
  const pending = new Set<string>();
  let showImages = $state(false);
  let showShare = $state(false);
  let note = $state<string | null>(null);

  /** The kon's own pictures, last, only for a `hosted` game. */
  const hostedSource = (): SourceRuntime => ({
    kind: "cardUrls",
    label: "site",
    async find(card) {
      const url = names[card.key]?.imageUrl;
      return url ? { directUrl: url } : null;
    },
  });

  $effect(() => {
    const controller = images;
    if (!controller || !view) return;
    for (const key of Object.keys(names)) {
      if (faces[key] || pending.has(key) || names[key].name === undefined) continue;
      pending.add(key);
      controller.resolver
        .resolve(refOf(key))
        .then((face) => {
          if (!pending.has(key)) return;
          pending.delete(key);
          faces = { ...faces, [key]: face };
        })
        .catch(() => pending.delete(key));
    }
  });

  function onImageError(key: string) {
    if (faces[key]?.direct && images) faces = { ...faces, [key]: images.resolver.fallback(refOf(key)) };
  }

  async function dropOn(cardId: string | null, event: DragEvent) {
    const file = event.dataTransfer?.files[0];
    if (!cardId || !file || !images) return;
    event.preventDefault();
    try {
      const face = await images.resolver.putDropped(refOf(cardId), file, t.dropped);
      pending.delete(cardId);
      faces = { ...faces, [cardId]: face };
    } catch {
      note = t.imageRejected;
    }
  }

  let imageSources = $state.raw<ImagesState["sources"]>([]);
  const shareable = $derived(imageSources.filter((s) => s.kind === "template" || s.kind === "pack"));

  async function share(index: number) {
    const source = shareable[index];
    if (!source || !table) return;
    const r = await table.share(source);
    note = r ? tt.shared : null;
    showShare = false;
  }

  async function acceptOffer(index: number) {
    const offer = ts?.offers[index];
    if (!offer || !images) return;
    const ok =
      offer.source.kind === "template"
        ? await images.addTemplate(offer.source.label, offer.source.url)
        : await images.addPack(offer.source.label, offer.source.url);
    if (ok) table?.dismissOffer(index);
  }

  const hostOf = (url: string) => {
    try {
      return new URL(url.replaceAll("{id}", "x").replaceAll("{name}", "x")).host;
    } catch {
      return url;
    }
  };

  // ── Start and stop ──────────────────────────────────────────────────────────

  let unsubscribeImages = () => {};

  onMount(() => {
    let gone = false;
    (async () => {
      try {
        gameRow = (await api.getGame(game)).data;
      } catch (e) {
        gameError = e instanceof ApiError && e.status === 404 ? tt.gameNotOnline : messageOf(e);
        return;
      }
      const cache = await createBestCache();
      if (gone) return;
      const controller = createImagesController({
        game,
        cache,
        apiBase,
        trailing: gameRow.imageMode === "byod" ? [] : [hostedSource()],
      });
      unsubscribeImages = controller.resolver.onChange((key) => {
        pending.delete(key);
        const { [key]: _gone, ...rest } = faces;
        faces = rest;
      });
      const unsubscribeSources = controller.subscribe((st) => (imageSources = st.sources));
      const stopChanges = unsubscribeImages;
      unsubscribeImages = () => {
        stopChanges();
        unsubscribeSources();
      };
      images = controller;
      void controller.load();
      if (initialSession) await enter(initialSession);
      else await loadLobby();
    })();
    return () => {
      gone = true;
    };
  });

  onDestroy(() => {
    unsubscribeImages();
    images?.dispose();
    leave(false);
  });

  async function copyLink() {
    if (!ts) return;
    try {
      const url = new URL(location.href);
      url.searchParams.set("table", ts.sessionId);
      await navigator.clipboard.writeText(url.toString());
      note = tt.copied;
    } catch {
      note = null;
    }
  }

  $effect(() => {
    // The code is known when the room is created or found; otherwise ask the lobby list.
    const id = ts?.sessionId;
    if (!id) return;
    const known = rooms.find((r) => r.id === id)?.code;
    if (known) roomCode = known;
  });
</script>

{#snippet face(cardId: string | null)}
  {#if cardId === null}
    <span class="cs-card__back" aria-hidden="true"></span>
  {:else if faces[cardId]}
    <img src={faces[cardId].url} alt="" loading="lazy" referrerpolicy="no-referrer" onerror={() => onImageError(cardId)} />
  {:else}
    <span class="cs-card__text">{nameOf(cardId)}</span>
  {/if}
{/snippet}

{#snippet cards(seat: number, zone: string, mine: boolean, hand = false)}
  <ul class="cs-cards">
    {#each cardsIn(seat, zone) as c (c.instanceId)}
      <li>
        <button
          type="button"
          class={["cs-card", hand && "cs-card--hand", c.tapped && "cs-card--tapped", selected?.instanceId === c.instanceId && "cs-card--selected"]}
          title={nameOf(c.cardId)}
          aria-label={nameOf(c.cardId)}
          disabled={!mine || !playing}
          onclick={() => (selected = selected?.instanceId === c.instanceId ? null : { instanceId: c.instanceId, zone, cardId: c.cardId })}
          ondragover={(e) => e.dataTransfer?.types.includes("Files") && e.preventDefault()}
          ondrop={(e) => dropOn(c.cardId, e)}
        >
          {@render face(c.cardId)}
        </button>
      </li>
    {/each}
    {#each Array.from({ length: Math.min(hiddenIn(seat, zone), 30) }) as _, i (i)}
      <li><span class={["cs-card", hand && "cs-card--hand"]}><span class="cs-card__back" aria-hidden="true"></span></span></li>
    {/each}
    {#if countIn(seat, zone) === 0}
      <li class="cs-empty">{t.empty}</li>
    {:else if hiddenIn(seat, zone) > 0}
      <li class="cs-faint cs-hidden-count">{tt.hiddenCards(hiddenIn(seat, zone))}</li>
    {/if}
  </ul>
{/snippet}

{#snippet seatArea(seat: number)}
  {@const mine = seat === mySeat}
  {@const player = view?.players[seat]}
  <section class={["cs-panel cs-seat", mine && "cs-seat--mine", view?.activePlayer === seat && "cs-seat--active"]}>
    <header class="cs-seat-head">
      <strong>{nameOfSeat(seat)}</strong>
      {#if clocks}
        <span class={["cs-clock", view?.activePlayer === seat && playing && "cs-clock--running"]}>{fmtClock(clocks[seat] ?? 0)}</span>
      {/if}
      {#each definition?.resources ?? [] as r (r.id)}
        <span class="cs-resource">
          <span class="cs-label">{r.name}</span>
          {#if mine && playing}
            <button type="button" class="cs-step" aria-label={t.decrease(r.name)} onclick={() => act({ type: "resource", target: seat, resource: r.id, delta: -1 })}>−</button>
          {/if}
          <span class="cs-value">{player?.resources?.[r.id] ?? 0}</span>
          {#if mine && playing}
            <button type="button" class="cs-step" aria-label={t.increase(r.name)} onclick={() => act({ type: "resource", target: seat, resource: r.id, delta: 1 })}>+</button>
          {/if}
        </span>
      {/each}
    </header>
    <ul class="cs-zones">
      {#each zonesFor as z (z.id)}
        <li class="cs-zone">
          <p class="cs-zone-head"><span class="cs-label">{z.name}</span><span class="cs-faint">{countIn(seat, z.id)}</span></p>
          {#if isPile(z.id) && cardsIn(seat, z.id).length === 0}
            <div class="cs-pile">{countIn(seat, z.id) === 0 ? t.empty : t.pileCount(countIn(seat, z.id))}</div>
          {:else}
            {@render cards(seat, z.id, mine)}
          {/if}
        </li>
      {/each}
    </ul>
    <div class="cs-zone">
      <p class="cs-zone-head"><span class="cs-label">{t.hand(countIn(seat, handZone))}</span></p>
      {@render cards(seat, handZone, mine, true)}
    </div>
  </section>
{/snippet}

<div class="cardsim cardsim-table" {lang}>
  {#if gameError}
    <p class="cs-panel cs-faint" role="status">{gameError}</p>
  {:else if !gameRow}
    <p class="cs-faint" aria-busy="true">…</p>
  {:else if !ts}
    <!-- ── Lobby ── -->
    <section class="cs-panel">
      <h3 class="cs-title">{tt.playOnline}</h3>
      {#if !signedIn}
        <p class="cs-muted">{tt.signInToPlay}</p>
      {:else}
        <div class="cs-grid">
          <div class="cs-col">
            <p class="cs-label">{tt.yourDecks}</p>
            {#if decks.length === 0}
              <p class="cs-faint">{tt.noDecks}</p>
            {:else}
              <label class="cs-field">
                <span class="cs-faint">{tt.chooseDeck}</span>
                <select bind:value={deckId}>
                  {#each decks as d (d.id)}
                    <option value={d.id}>{d.name}</option>
                  {/each}
                </select>
              </label>
            {/if}
            <details class="cs-details">
              <summary>{tt.newDeckFromList}</summary>
              <label class="cs-field"><span class="cs-faint">{tt.deckName}</span><input type="text" maxlength="80" bind:value={newDeckName} /></label>
              <textarea class="cs-list" rows="6" bind:value={newDeckList} placeholder={t.deckPlaceholder} aria-label={tt.newDeckFromList}></textarea>
              <button type="button" class="cs-btn cs-btn--sm" disabled={lobbyBusy || !newDeckList.trim()} onclick={saveDeck}>{tt.saveDeck}</button>
            </details>
          </div>

          <div class="cs-col">
            <p class="cs-label">{tt.createRoom}</p>
            <label class="cs-field"><span class="cs-faint">{tt.roomName}</span><input type="text" maxlength="80" bind:value={roomName} /></label>
            <label class="cs-field"><span class="cs-faint">{tt.password}</span><input type="password" maxlength="100" autocomplete="new-password" bind:value={roomPassword} /></label>
            <div class="cs-row">
              <label class="cs-field cs-field--inline"><span class="cs-faint">{tt.clock}</span>
                <select bind:value={clockMinutes}>
                  <option value={0}>{tt.noClock}</option>
                  {#each [5, 10, 25, 50] as m (m)}<option value={m}>{tt.minutes(m)}</option>{/each}
                </select>
              </label>
              <label class="cs-field cs-field--inline">
                <select bind:value={bestOf} aria-label={tt.bestOf(3)}>
                  {#each [1, 3, 5] as n (n)}<option value={n}>{tt.bestOf(n)}</option>{/each}
                </select>
              </label>
              <label class="cs-check"><input type="checkbox" bind:checked={allowSpectators} /> {tt.allowSpectators}</label>
            </div>
            <button type="button" class="cs-btn cs-btn--primary" disabled={lobbyBusy} onclick={createRoom}>{tt.create}</button>

            <p class="cs-label cs-gap">{tt.joinByCode}</p>
            <div class="cs-row">
              <input class="cs-input cs-code" type="text" maxlength="12" bind:value={code} placeholder={tt.code} aria-label={tt.code} />
              <input class="cs-input" type="password" maxlength="100" bind:value={codePassword} placeholder={tt.password} aria-label={tt.password} />
              <button type="button" class="cs-btn cs-btn--sm" disabled={lobbyBusy || !code.trim()} onclick={() => joinByCode(false)}>{tt.join}</button>
              <button type="button" class="cs-btn cs-btn--sm" disabled={lobbyBusy || !code.trim()} onclick={() => joinByCode(true)}>{tt.watch}</button>
            </div>
          </div>
        </div>
      {/if}

      {#if lobbyError}<p class="cs-errors" role="alert">{lobbyError}</p>{/if}

      <div class="cs-row cs-gap">
        <p class="cs-label">{tt.openRooms}</p>
        <button type="button" class="cs-btn cs-btn--sm cs-push" onclick={loadLobby}>{tt.refresh}</button>
      </div>
      {#if rooms.length === 0}
        <p class="cs-faint">{tt.noOpenRooms}</p>
      {:else}
        <ul class="cs-rooms">
          {#each rooms as r (r.id)}
            <li>
              <strong>{r.name ?? r.code}</strong>
              <span class="cs-faint">{tt.seatsTaken(r.seats.filter(Boolean).length, r.seats.length)}</span>
              {#if r.hasPassword}<span class="cs-chip">{tt.locked}</span>{/if}
              <span class="cs-row cs-push">
                {#if signedIn && !r.hasPassword}
                  <button type="button" class="cs-btn cs-btn--sm" disabled={lobbyBusy} onclick={() => sit(r.id)}>{tt.join}</button>
                {/if}
                {#if r.allowSpectators}
                  <button type="button" class="cs-btn cs-btn--sm" onclick={() => enter(r.id)}>{tt.watch}</button>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {:else}
    <!-- ── The table ── -->
    <div class="cs-panel cs-toolbar">
      <button type="button" class="cs-btn cs-btn--sm" onclick={() => leave()}>{tt.backToRooms}</button>
      <span class={["cs-chip", ts.connection === "live" ? "cs-chip--ok" : "cs-chip--warn"]}>
        {ts.connection === "live" ? tt.live : ts.connection === "polling" ? tt.polling : tt.reconnecting}
      </span>
      {#if mySeat === null}<span class="cs-chip">{tt.spectating}</span>{/if}
      {#if view}
        <span class="cs-faint">
          {t.turnLine(view.turn, view.phase)} · {view.activePlayer === mySeat ? tt.yourTurn : tt.turnOf(nameOfSeat(view.activePlayer))}
        </span>
      {/if}
      <span class="cs-row cs-push">
        {#if roomCode}<span class="cs-faint">{tt.roomCode(roomCode)}</span>{/if}
        <button type="button" class="cs-btn cs-btn--sm" onclick={copyLink}>{tt.copyLink}</button>
        <button type="button" class="cs-btn cs-btn--sm" aria-expanded={showImages} onclick={() => (showImages = !showImages)}>{t.myImages}</button>
      </span>
    </div>

    {#if ts.status === "open"}
      <p class="cs-panel cs-muted" role="status">{tt.waitingRival}</p>
    {/if}

    {#if errorText}<p class="cs-errors" role="alert">{errorText}</p>{/if}
    {#if note}<p class="cs-faint" role="status">{note}</p>{/if}

    {#each ts.offers as offer, i (i)}
      <div class="cs-panel cs-banner" role="status">
        <span>{tt.offer(nameOfSeat(offer.by), offer.source.label, hostOf(offer.source.url))}</span>
        <span class="cs-row cs-push">
          <button type="button" class="cs-btn cs-btn--sm cs-btn--primary" onclick={() => acceptOffer(i)}>{tt.addToMine}</button>
          <button type="button" class="cs-btn cs-btn--sm" onclick={() => table?.dismissOffer(i)}>{tt.ignore}</button>
        </span>
      </div>
    {/each}

    {#if ts.undoRequest && mySeat !== null}
      <div class="cs-panel cs-banner" role="status">
        {#if ts.undoRequest.by === mySeat}
          <span>{tt.undoWaiting}</span>
          <button type="button" class="cs-btn cs-btn--sm cs-push" onclick={() => table?.declineUndo()}>{t.cancel}</button>
        {:else}
          <span>{tt.undoOffered}</span>
          <span class="cs-row cs-push">
            <button type="button" class="cs-btn cs-btn--sm cs-btn--primary" onclick={() => table?.acceptUndo()}>{tt.accept}</button>
            <button type="button" class="cs-btn cs-btn--sm" onclick={() => table?.declineUndo()}>{tt.decline}</button>
          </span>
        {/if}
      </div>
    {/if}

    {#if resultText}
      <div class="cs-panel cs-banner cs-result" role="status">
        <strong>{resultText}</strong>
        {#if ts.timedOut !== null}<span class="cs-faint">{tt.timedOut(nameOfSeat(ts.timedOut))}</span>{/if}
        {#if mySeat !== null}
          <span class="cs-row cs-push">
            {#if ts.rematchId}
              <button type="button" class="cs-btn cs-btn--primary cs-btn--sm" onclick={() => table?.follow(ts!.rematchId!).then(() => onTable?.(ts?.sessionId ?? null))}>{tt.goToRematch}</button>
            {:else}
              <button type="button" class="cs-btn cs-btn--primary cs-btn--sm" disabled={ts.busy} onclick={() => table?.rematch()}>{tt.rematch}</button>
            {/if}
          </span>
        {/if}
      </div>
    {/if}

    {#if mySeat !== null && playing}
      <div class="cs-panel cs-toolbar">
        <button type="button" class="cs-btn cs-btn--primary" disabled={ts.busy} onclick={() => act({ type: "draw", count: 1 })}>{t.draw}</button>
        <button type="button" class="cs-btn cs-btn--sm" disabled={ts.busy} onclick={() => act({ type: "shuffleZone", zone: definition?.deckZone })}>{t.shuffle}</button>
        <button type="button" class="cs-btn cs-btn--sm" disabled={ts.busy} onclick={() => act({ type: "mulligan" })}>{t.mulligan}</button>
        <button type="button" class="cs-btn cs-btn--sm" disabled={ts.busy} onclick={() => act({ type: "nextPhase" })}>{t.nextPhase}</button>
        <button type="button" class="cs-btn cs-btn--sm" disabled={ts.busy} onclick={() => act({ type: "endTurn" })}>{t.endTurn}</button>
        <button type="button" class="cs-btn cs-btn--sm" aria-label={t.rollDie} title={t.rollDie} disabled={ts.busy} onclick={() => act({ type: "roll", sides: 6, count: 1 })}>🎲</button>
        <span class="cs-row cs-push">
          <button type="button" class="cs-btn cs-btn--sm" disabled={ts.busy || ts.actionCount === 0 || !!ts.undoRequest} onclick={() => table?.askUndo()}>{tt.askUndo}</button>
          <button type="button" class="cs-btn cs-btn--sm" aria-expanded={showShare} onclick={() => (showShare = !showShare)}>{tt.shareImages}</button>
          <button type="button" class="cs-btn cs-btn--sm" disabled={ts.busy} onclick={() => table?.concede()}>{tt.concede}</button>
        </span>
      </div>
      {#if showShare}
        <div class="cs-panel">
          {#if shareable.length === 0}
            <p class="cs-faint">{tt.nothingToShare}</p>
          {:else}
            <ul class="cs-rooms">
              {#each shareable as s, i (s.label)}
                <li>
                  <span>{s.label}</span>
                  <span class="cs-faint">{"url" in s ? hostOf(s.url) : ""}</span>
                  <button type="button" class="cs-btn cs-btn--sm cs-push" onclick={() => share(i)}>{tt.shareImages}</button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    {/if}

    {#if view}
      <div class="cs-board">
        <div class="cs-seats">
          {#each seatsOrder as seat (seat)}
            {@render seatArea(seat)}
          {/each}
          {#if sharedZones.length}
            <section class="cs-panel">
              <ul class="cs-zones">
                {#each sharedZones as z (z.id)}
                  <li class="cs-zone">
                    <p class="cs-zone-head"><span class="cs-label">{z.name}</span></p>
                    <ul class="cs-cards">
                      {#each view.board?.[z.id] ?? [] as c (c.instanceId)}
                        <li><span class="cs-card" title={nameOf(c.cardId)}>{@render face(c.cardId)}</span></li>
                      {/each}
                    </ul>
                  </li>
                {/each}
              </ul>
            </section>
          {/if}
        </div>

        <div class="cs-panel">
          <p class="cs-label">{t.log}</p>
          <ol class="cs-log">
            {#each logLines as l (l.seq)}<li>{l.text}</li>{/each}
            {#if logLines.length === 0}<li class="cs-faint">{t.nothingYet}</li>{/if}
          </ol>
        </div>
      </div>
    {/if}

    {#if selected && mySeat !== null}
      <div class="cs-panel cs-menu">
        <p class="cs-menu-head">
          <strong>{nameOf(selected.cardId)}</strong>
          <button type="button" class="cs-btn cs-btn--sm cs-push" onclick={() => (selected = null)}>{t.close}</button>
        </p>
        <div class="cs-row">
          <button type="button" class="cs-btn cs-btn--sm" onclick={() => act({ type: "tap", instanceId: selected!.instanceId, tapped: true })}>{t.tap}</button>
          <button type="button" class="cs-btn cs-btn--sm" onclick={() => act({ type: "tap", instanceId: selected!.instanceId, tapped: false })}>{t.untap}</button>
          <button type="button" class="cs-btn cs-btn--sm" onclick={() => act({ type: "flip", instanceId: selected!.instanceId })}>{t.flip}</button>
          <button type="button" class="cs-btn cs-btn--sm" onclick={() => act({ type: "counter", instanceId: selected!.instanceId, name: t.counterName, delta: 1 })}>{t.addCounter}</button>
        </div>
        <p class="cs-label">{t.moveTo}</p>
        <div class="cs-row">
          {#each targets as z (z.id)}
            <button type="button" class="cs-btn cs-btn--sm" onclick={() => act({ type: "move", instanceId: selected!.instanceId, toZone: z.id, toPlayer: mySeat })}>{z.name}</button>
          {/each}
        </div>
      </div>
    {/if}
  {/if}

  {#if showImages && images}
    <div class="cs-images-wrap">
      <ImageSourcesPanel controller={images} texts={t} {lang} />
    </div>
  {/if}
</div>

<style>
  .cardsim {
    display: grid;
    gap: 0.8rem;
    color: var(--cardsim-text, #f4f4f5);
    font-size: 0.95rem;
  }
  .cs-panel {
    padding: 0.85rem;
    border: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.08));
    border-radius: var(--cardsim-radius, 12px);
    background: var(--cardsim-surface, #17171c);
  }
  .cs-title { margin: 0 0 0.6rem; font-size: 1.1rem; font-weight: 700; }
  .cs-muted { margin: 0; font-size: 0.9rem; color: var(--cardsim-muted, #a1a1aa); }
  .cs-faint { margin: 0; font-size: 0.75rem; color: var(--cardsim-faint, #71717a); }
  .cs-label { margin: 0; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--cardsim-faint, #71717a); }
  .cs-gap { margin-top: 0.9rem; }
  .cs-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; }
  .cs-push { margin-left: auto; }
  .cs-grid { display: grid; gap: 1rem; }
  @media (min-width: 768px) { .cs-grid { grid-template-columns: 1fr 1fr; } }
  .cs-col { display: grid; gap: 0.5rem; align-content: start; }
  .cs-field { display: grid; gap: 0.25rem; }
  .cs-field--inline { display: inline-grid; }
  .cs-check { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.82rem; color: var(--cardsim-muted, #a1a1aa); }
  .cs-field input, .cs-field select, .cs-input, .cs-list {
    box-sizing: border-box;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.12));
    border-radius: 8px;
    background: var(--cardsim-input, #0f0f13);
    color: var(--cardsim-text, #f4f4f5);
    font: inherit;
    font-size: 0.85rem;
  }
  .cs-input { min-width: 0; flex: 1 1 7rem; }
  .cs-code { flex: 0 1 7rem; text-transform: uppercase; font-family: ui-monospace, monospace; }
  .cs-list { width: 100%; font-family: ui-monospace, monospace; font-size: 0.78rem; }
  .cs-details summary { cursor: pointer; font-size: 0.85rem; color: var(--cardsim-muted, #a1a1aa); }
  .cs-details[open] { display: grid; gap: 0.45rem; }
  .cs-errors { margin: 0; color: var(--cardsim-danger, #f87171); font-size: 0.875rem; }
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
  .cs-btn--sm { padding: 0.32rem 0.65rem; font-size: 0.8rem; }
  .cs-btn--primary { border-color: var(--cardsim-accent, #f59e0b); background: var(--cardsim-accent, #f59e0b); color: var(--cardsim-on-accent, #111); font-weight: 700; }
  .cs-btn:hover:not(:disabled) { border-color: var(--cardsim-accent, #f59e0b); }
  .cs-btn:disabled { opacity: 0.45; cursor: default; }
  .cs-btn:focus-visible, .cs-card:focus-visible, .cs-step:focus-visible, .cs-input:focus-visible, .cs-field select:focus-visible, .cs-field input:focus-visible {
    outline: 2px solid var(--cardsim-accent, #f59e0b);
    outline-offset: 2px;
  }
  .cs-chip { border-radius: 999px; padding: 0.05rem 0.55rem; font-size: 0.72rem; border: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.12)); color: var(--cardsim-muted, #a1a1aa); }
  .cs-chip--ok { border-color: color-mix(in srgb, #22c55e 55%, transparent); color: #86efac; }
  .cs-chip--warn { border-color: color-mix(in srgb, var(--cardsim-accent, #f59e0b) 55%, transparent); color: var(--cardsim-accent, #f59e0b); }
  .cs-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; padding: 0.65rem; }
  .cs-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; border-color: color-mix(in srgb, var(--cardsim-accent, #f59e0b) 45%, transparent); }
  .cs-result strong { font-size: 1.05rem; }
  .cs-rooms { display: grid; gap: 0.35rem; margin: 0.5rem 0 0; padding: 0; list-style: none; }
  .cs-rooms li { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; padding: 0.45rem 0.6rem; border-radius: 8px; background: var(--cardsim-surface-2, #222229); }
  .cs-board { display: grid; gap: 0.75rem; }
  @media (min-width: 1024px) { .cs-board { grid-template-columns: minmax(0, 1fr) 260px; align-items: start; } }
  .cs-seats { display: grid; gap: 0.75rem; }
  .cs-seat--active { border-color: color-mix(in srgb, var(--cardsim-accent, #f59e0b) 55%, transparent); }
  .cs-seat-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
  .cs-clock { font-family: ui-monospace, monospace; font-weight: 700; padding: 0.05rem 0.45rem; border-radius: 6px; background: var(--cardsim-surface-2, #222229); }
  .cs-clock--running { color: var(--cardsim-on-accent, #111); background: var(--cardsim-accent, #f59e0b); }
  .cs-resource { display: inline-flex; align-items: center; gap: 0.3rem; }
  .cs-value { min-width: 2ch; text-align: center; font-weight: 800; font-size: 1.05rem; }
  .cs-step { border-radius: 6px; border: 1px solid var(--cardsim-border, rgb(255 255 255 / 0.08)); background: transparent; color: var(--cardsim-muted, #a1a1aa); padding: 0.05rem 0.45rem; font-weight: 700; cursor: pointer; }
  .cs-zones { display: grid; gap: 0.6rem; margin: 0; padding: 0; list-style: none; }
  @media (min-width: 640px) { .cs-zones { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .cs-zone { min-width: 0; }
  .cs-zone-head { display: flex; justify-content: space-between; margin: 0; }
  .cs-pile { display: flex; align-items: center; justify-content: center; height: 4.5rem; margin-top: 0.4rem; border: 1px dashed var(--cardsim-border, rgb(255 255 255 / 0.12)); border-radius: 8px; color: var(--cardsim-faint, #71717a); font-size: 0.85rem; }
  .cs-cards { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; margin: 0.4rem 0 0; padding: 0; list-style: none; }
  .cs-empty { color: var(--cardsim-faint, #71717a); font-size: 0.8rem; min-height: 2.5rem; display: flex; align-items: center; }
  .cs-hidden-count { width: 100%; }
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
    transition: transform 0.15s, border-color 0.15s;
  }
  .cs-card:disabled { cursor: default; opacity: 1; }
  .cs-card--hand { width: var(--cardsim-hand-width, 66px); }
  .cs-card:not(:disabled):hover { transform: translateY(-3px); border-color: var(--cardsim-accent, #f59e0b); }
  .cs-card--tapped { transform: rotate(90deg); }
  .cs-card--selected { border-color: var(--cardsim-accent, #f59e0b); box-shadow: 0 0 0 2px color-mix(in srgb, var(--cardsim-accent, #f59e0b) 35%, transparent); }
  .cs-card img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .cs-card__text { display: block; padding: 0.2rem; font-size: 8px; line-height: 1.15; font-weight: 600; text-align: left; color: var(--cardsim-muted, #d4d4d8); overflow-wrap: anywhere; }
  .cs-card__back {
    display: block;
    width: 100%;
    height: 100%;
    background: repeating-linear-gradient(45deg, var(--cardsim-surface-2, #222229) 0 6px, color-mix(in srgb, var(--cardsim-accent, #f59e0b) 18%, var(--cardsim-surface-2, #222229)) 6px 12px);
  }
  .cs-log { display: grid; gap: 0.25rem; margin: 0.5rem 0 0; padding: 0; list-style: none; font-size: 0.75rem; line-height: 1.5; color: var(--cardsim-muted, #a1a1aa); }
  .cs-menu { display: grid; gap: 0.5rem; border-color: color-mix(in srgb, var(--cardsim-accent, #f59e0b) 45%, transparent); }
  .cs-menu-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin: 0; }
  .cs-images-wrap { max-width: 44rem; }
</style>

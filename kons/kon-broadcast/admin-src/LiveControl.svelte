<svelte:options
  customElement={{
    tag: "broadcast-live-control",
    shadow: "open",
    props: { context: { type: "Object" }, params: { type: "Object" } },
  }}
/>

<!--
  <broadcast-live-control>: the MOBA booth. Picks the set and game being broadcast, runs the draft,
  starts and stops live ingestion, closes the game and lists the OBS sources.

  The panel does not decide: Fearless, the draft order and the series score are resolved by the
  server, and the panel shows what it answers. `params.gameId`, when the host passes it, opens
  that game.
-->
<script lang="ts">
  import {
    Alert,
    Button,
    ConfirmDialog,
    CopyButton,
    Input,
    Select,
    ThemeScope,
  } from "$lib/components";

  import { untrack } from "svelte";

  import { apiBaseOf, createApi, messageOf, seg } from "./api";
  import type { Adapter, Game, Match, Side, ViewContext } from "./types";
  import Panel from "./ui/Panel.svelte";

  let { context, params }: { context?: ViewContext; params?: { gameId?: string } } = $props();

  const api = createApi(() => `${apiBaseOf(context)}/broadcast`);
  const uid = $props.id();
  const champsId = `${uid}-champs`;

  let sections = $state<Record<string, boolean> | null>(null);
  let matchList = $state<Match[]>([]);
  let match = $state<Match | null>(null);
  let games = $state<Game[]>([]);
  let game = $state<Game | null>(null);
  let chosenGame = $state<string | null>(null);
  let seriesValue = $state("");
  let gameValue = $state("");
  let adapters = $state<Adapter[]>([]);
  let adapterId = $state("");
  let champions = $state<{ id: string; name: string }[]>([]);
  let locked = $state<string[]>([]);
  let champ = $state("");
  let hint = $state("");
  let warnings = $state<string[]>([]);

  let pickErr = $state("");
  let draftErr = $state("");
  let ingestErr = $state("");
  let finishErr = $state("");

  let confirming = $state<"blue" | "red" | null>(null);
  let confirmOpen = $state(false);

  const gamesOff = $derived(sections !== null && !sections.games);

  // Sides are swapped between games: drawing them backwards gives the point to the wrong side.
  const teams = $derived.by((): { blue: Side; red: Side } | null => {
    if (!match || !game) return null;
    return game.sideAFirst
      ? { blue: match.sideA, red: match.sideB }
      : { blue: match.sideB, red: match.sideA };
  });

  // The score belongs to the SET, not the game: it comes from sideA/sideB, not from `teams`.
  // `bestOf` is derived from the stored `firstTo` (a Bo3 is won on reaching 2).
  const scoreText = $derived.by(() => {
    if (!match || !teams) return "—";
    const bestOf = Math.max(1, match.firstTo) * 2 - 1;
    const tag = (s: Side) => s.sponsor || s.name;
    return `Bo${bestOf} · ${tag(match.sideA)} ${match.sideA.score} — ${match.sideB.score} ${tag(match.sideB)}`;
  });

  const fearlessText = $derived(
    !teams || !match || match.fearless === "off" ? "" : `· Fearless ${match.fearless}`
  );

  const draft = $derived(game?.draft ?? null);
  const showDraft = $derived(Boolean(draft && !draft.complete));

  const turnText = $derived.by(() => {
    const step = draft?.current;
    if (!step || !teams) return "—";
    const team = step.team === "blue" ? teams.blue : teams.red;
    return `${step.action === "ban" ? "Ban" : "Choose"} ${team.name} · step ${step.index + 1} of 20`;
  });

  /**
   * `graphics/`, not `admin-asset/`: the admin artifacts route rejects `.html` on purpose, and
   * graphics go through their own route with its CSP.
   */
  const overlayUrls = $derived.by(() => {
    if (!teams || !chosenGame) return [];
    const base =
      `${location.origin}${apiBaseOf(context)}` +
      `/kons/kon-broadcast/graphics/overlay-live.html?game=${chosenGame}`;
    return ["full", "matchbar", "gold,objectives", "draft", "postgame"].map((layers) =>
      layers === "full" ? base : `${base}&layers=${layers}`
    );
  });

  const seriesOptions = $derived(
    matchList.length === 0
      ? [{ value: "", label: "There is no matchup" }]
      : matchList.map((m) => ({ value: m.id, label: m.round ? `${m.eventTitle} · ${m.round}` : m.eventTitle }))
  );

  const gameOptions = $derived(
    games.map((g) => ({
      value: g.id,
      label: `Game ${g.gameNumber}${g.status && g.status !== "live" ? ` · ${g.status}` : ""}`,
    }))
  );

  const adapterOptions = $derived(
    // The list itself flags which source gives no gold, before starting.
    adapters.map((a) => ({ value: a.id, label: a.capabilities?.gold ? a.name : `${a.name} — no gold` }))
  );

  // Once per API base and requested game: the host sets `context` again when the theme changes.
  // Deferred one tick because the host sets `context` and then `params`, each flushing on its own:
  // without it the booth booted twice.
  let bootKey: string | null = null;
  let bootTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const key = `${apiBaseOf(context)}|${params?.gameId ?? context?.params?.gameId ?? ""}`;
    if (key === bootKey) return;
    bootKey = key;
    clearTimeout(bootTimer);
    bootTimer = setTimeout(() => untrack(() => void boot()), 0);
  });
  $effect(() => () => clearTimeout(bootTimer));

  // ── Data ───────────────────────────────────────────────────────────────────

  /** Lists the sets and opens the one being operated (the requested game's, else the first). */
  async function boot() {
    pickErr = "";

    // Sections first: without `games` every call is a 409 that reads as a breakdown.
    try {
      const res = await api.get<{ data?: { id: string; enabled: boolean }[] }>("/sections");
      sections = Object.fromEntries((res.data ?? []).map((x) => [x.id, x.enabled]));
    } catch {
      // An old API without `/sections`: carry on and fail where it has to.
      sections = null;
    }

    if (sections && !sections.games) {
      matchList = [];
      games = [];
      hint =
        "The games section of Broadcast is switched off, and this booth operates games. " +
        'Switch it on in the grimoire: konConfig["kon-broadcast"].enableGames = true';
      return;
    }

    try {
      const res = await api.get<{ docs?: Match[]; data?: Match[]; items?: Match[] } | Match[]>("/matches");
      matchList = Array.isArray(res) ? res : (res.docs ?? res.data ?? res.items ?? []);
    } catch (e) {
      pickErr = messageOf(e);
      matchList = [];
    }

    if (matchList.length === 0) {
      games = [];
      seriesValue = "";
      hint =
        "Create one in the Sets tab and come back here. This booth operates a matchup that " +
        "already exists; it does not create it.";
      return;
    }

    hint = "";
    let seriesId = match?.id ?? matchList[0].id;
    let prefer: string | null = null;
    const wanted = params?.gameId ?? context?.params?.gameId ?? null;
    if (wanted) {
      try {
        const { data } = await api.get<{ data: Game }>(`/games/${seg(wanted)}`);
        seriesId = data.matchId;
        prefer = data.id;
      } catch (e) {
        pickErr = messageOf(e);
      }
    }
    await openSeries(seriesId, prefer);
  }

  async function openSeries(matchId: string, prefer: string | null = null) {
    if (!matchId) return;
    pickErr = "";
    seriesValue = matchId;
    try {
      const { data } = await api.get<{ data: Match }>(`/matches/${seg(matchId)}`);
      match = data;
      // Games hang from their own route: most profiles have none.
      const list = await api.get<{ data?: Game[] }>(`/matches/${seg(matchId)}/games`);
      games = list.data ?? [];

      if (games.length === 0) {
        hint = "This matchup has no games yet.";
        chosenGame = null;
        gameValue = "";
        game = null;
        return;
      }

      hint = "";
      // The requested one; else the one being played; else the last one created.
      const alive =
        games.find((g) => g.id === prefer) ?? games.find((g) => g.status === "live") ?? games[games.length - 1];
      chosenGame = alive.id;
      gameValue = alive.id;
      await load();
    } catch (e) {
      pickErr = messageOf(e);
    }
  }

  /** Creates the set's next game; the server alternates the sides. */
  async function newGame() {
    if (!match) return;
    pickErr = "";
    try {
      await api.post(`/matches/${seg(match.id)}/games`, {});
      await openSeries(match.id);
    } catch (e) {
      pickErr = messageOf(e);
    }
  }

  async function load() {
    if (!chosenGame) return;
    try {
      const { data } = await api.get<{ data: Game }>(`/games/${seg(chosenGame)}`);
      game = data;
      const container = await api.get<{ data: Match }>(`/matches/${seg(data.matchId)}`);
      match = container.data;
    } catch (e) {
      pickErr = messageOf(e);
      return;
    }
    await loadAdapters();
    void loadChampions();
    await loadFearless();
  }

  async function loadAdapters() {
    try {
      const { data } = await api.get<{ data: Adapter[] }>("/live/adapters");
      adapters = data ?? [];
      if (!adapters.some((a) => a.id === adapterId)) adapterId = adapters[0]?.id ?? "";
    } catch (e) {
      ingestErr = messageOf(e);
    }
  }

  /**
   * The champion autocomplete, from Data Dragon. The CDN KEY is the value and the translated name
   * the label: the operator searches "Lee Sin" and what is stored is `LeeSin`. Without it the
   * panel still works by hand; the booth may have no internet access.
   */
  let championsLoaded = false;
  async function loadChampions() {
    if (championsLoaded) return;
    championsLoaded = true;
    try {
      const versions = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
      const version = versions?.[0];
      if (!version) return;
      const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/es_ES/champion.json`);
      const { data } = await res.json();
      champions = Object.values((data ?? {}) as Record<string, { id: string; name: string }>).map((c) => ({
        id: c.id,
        name: c.name,
      }));
    } catch {
      championsLoaded = false;
    }
  }

  async function loadFearless() {
    if (!chosenGame) return;
    try {
      const { data } = await api.get<{ data: { locked?: Record<string, string[]> } }>(
        `/games/${seg(chosenGame)}/fearless`
      );
      const side = game?.draft?.current?.team ?? null;
      locked = side ? (data.locked?.[side] ?? []) : [];
    } catch {
      // Informational: the server keeps rejecting what is not valid.
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async function pick(championId: string | null) {
    if (!chosenGame) return;
    draftErr = "";
    try {
      const { data } = await api.post<{ data: Game }>(`/games/${seg(chosenGame)}/draft`, { championId });
      game = data;
      if (championId) champ = "";
      await loadFearless();
    } catch (e) {
      draftErr = messageOf(e);
    }
  }

  async function startIngest() {
    if (!chosenGame) return;
    ingestErr = "";
    try {
      const result = await api.post<{ warnings?: string[] }>(`/games/${seg(chosenGame)}/ingest/start`, {
        adapterId,
      });
      warnings = result?.warnings ?? [];
    } catch (e) {
      ingestErr = messageOf(e);
    }
  }

  /** A game action; the server answers with the game (and, on finish, the set). */
  async function act(path: string, body: unknown, setError: (m: string) => void) {
    if (!chosenGame) return;
    setError("");
    const result = await api
      .post<{ data?: (Game & { game?: Game; series?: Partial<Match>; match?: Partial<Match> }) | null }>(
        `/games/${seg(chosenGame)}/${path}`,
        body ?? {}
      )
      .catch((e: unknown) => {
        setError(messageOf(e));
        throw e;
      });
    const data = result?.data;
    game = data?.game ?? (data && "id" in data ? data : null) ?? game;
    const next = data?.series ?? data?.match;
    if (next && match) match = { ...match, ...next };
    await loadFearless();
  }

  const quiet = (p: Promise<unknown>) => void p.catch(() => {});

  function askFinish(side: "blue" | "red") {
    confirming = side;
    finishErr = "";
    confirmOpen = true;
  }

  // Closing a game rewrites the series score: it is confirmed first. A failure keeps the dialog
  // open with the reason.
  const finish = () => act("finish", { winner: confirming }, (m) => (finishErr = m));

  const winnerName = $derived(
    confirming ? ((confirming === "blue" ? teams?.blue : teams?.red)?.name ?? confirming) : ""
  );
</script>

<ThemeScope class="broadcast-live">
  <Panel title="What is being broadcast">
    <div class="row">
      <div class="pick">
        <Select
          aria-label="Matchup"
          bind:value={seriesValue}
          options={seriesOptions}
          disabled={gamesOff || matchList.length === 0}
          onchange={(e: Event) => void openSeries((e.currentTarget as HTMLSelectElement).value)}
        />
      </div>
      <div class="pick">
        <Select
          aria-label="Game"
          bind:value={gameValue}
          options={gameOptions}
          disabled={gamesOff || games.length === 0}
          onchange={(e: Event) => {
            chosenGame = (e.currentTarget as HTMLSelectElement).value || null;
            if (chosenGame) void load();
          }}
        />
      </div>
      <Button variant="outline" disabled={gamesOff || !match} onclick={newGame}>New game</Button>
      <Button variant="outline" onclick={() => void boot()}>Reload</Button>
    </div>
    {#if hint}<p class="muted">{hint}</p>{/if}
    {#if pickErr}<Alert variant="error">{pickErr}</Alert>{/if}
  </Panel>

  <Panel title="Matchup">
    <div class="grid">
      <div class="team">
        <span class="swatch" style:background={teams?.blue.color ?? "rgb(var(--ta-subtle))"}></span>
        <span>{teams?.blue.name ?? "—"}</span>
      </div>
      <div class="team">
        <span class="swatch" style:background={teams?.red.color ?? "rgb(var(--ta-subtle))"}></span>
        <span>{teams?.red.name ?? "—"}</span>
      </div>
    </div>
    <div class="row">
      <span class="muted">{scoreText}</span>
      {#if fearlessText}<span class="muted">{fearlessText}</span>{/if}
    </div>
  </Panel>

  {#if showDraft}
    <Panel title="Draft">
      <div class="turn">{turnText}</div>
      <div class="row">
        <div class="pick">
          <Input
            bind:value={champ}
            placeholder="Champion"
            aria-label="Champion"
            list={champsId}
            onkeydown={(e: KeyboardEvent) => {
              if (e.key === "Enter" && champ.trim()) void pick(champ.trim());
            }}
          />
        </div>
        <Button onclick={() => champ.trim() && void pick(champ.trim())}>Confirm</Button>
        <Button variant="outline" onclick={() => void pick(null)}>Skip ban</Button>
        <Button variant="outline" onclick={() => quiet(act("draft/undo", undefined, (m) => (draftErr = m)))}
          >Undo</Button
        >
      </div>
      {#if match && match.fearless !== "off"}
        <div class="chips">
          {#each locked as c (c)}
            <span class="chip locked">{c}</span>
          {:else}
            <span class="muted">No locked champions</span>
          {/each}
        </div>
      {/if}
      {#if draftErr}<Alert variant="error">{draftErr}</Alert>{/if}
    </Panel>
  {/if}

  <Panel title="Ingestion">
    <div class="row">
      <div class="pick">
        <Select
          aria-label="Data source"
          bind:value={adapterId}
          options={adapterOptions}
          placeholder={adapters.length ? undefined : "No sources"}
          disabled={adapters.length === 0}
        />
      </div>
      <Button disabled={!chosenGame} onclick={startIngest}>Start</Button>
      <Button
        variant="outline"
        disabled={!chosenGame}
        onclick={() => quiet(act("ingest/stop", undefined, (m) => (ingestErr = m)))}>Stop</Button
      >
    </div>
    {#if warnings.length}<Alert variant="warning">{warnings.join(" ")}</Alert>{/if}
    {#if ingestErr}<Alert variant="error">{ingestErr}</Alert>{/if}
  </Panel>

  <Panel title="Close game">
    <div class="row">
      <Button variant="outline" disabled={!chosenGame} onclick={() => askFinish("blue")}>Blue wins</Button>
      <Button variant="outline" disabled={!chosenGame} onclick={() => askFinish("red")}>Red wins</Button>
    </div>
    <p class="muted">
      Closes ingestion, adds the point to the series team —not to the side— and shows the result
      screen.
    </p>
    {#if finishErr && !confirmOpen}<Alert variant="error">{finishErr}</Alert>{/if}
  </Panel>

  <Panel title="OBS sources">
    <p class="muted">
      Add a 1920×1080 Browser Source for each layer you want to separate. Without
      <code>?layers=</code> the full overlay comes out.
    </p>
    <div class="chips">
      {#each overlayUrls as url (url)}
        <CopyButton text={url} copyLabel="Click to copy" />
      {:else}
        <span class="muted">No game</span>
      {/each}
    </div>
  </Panel>

  <datalist id={champsId}>
    {#each champions as c (c.id)}
      <option value={c.id}>{c.name}</option>
    {/each}
  </datalist>

  <ConfirmDialog
    bind:open={confirmOpen}
    title={`Close the game with a win for ${winnerName}?`}
    confirmLabel="Close game"
    cancelLabel="Cancel"
    closeLabel="Close"
    variant="primary"
    onConfirm={finish}
  >
    {#if finishErr}<Alert variant="error">{finishErr}</Alert>{/if}
  </ConfirmDialog>
</ThemeScope>

<style>
  :host {
    display: block;
  }

  :global(.broadcast-live) {
    display: grid;
    gap: 1rem;
  }

  .row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .pick {
    flex: 0 1 14rem;
    min-width: 10rem;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.875rem;
  }

  .team {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
    color: rgb(var(--ta-text));
  }

  .swatch {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: var(--ta-radius-sm);
    flex-shrink: 0;
  }

  .turn {
    font-size: 0.8125rem;
    padding: 0.5rem 0.75rem;
    border-radius: var(--ta-radius-sm);
    background: rgb(var(--ta-elevated));
    color: rgb(var(--ta-text));
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .chip {
    font-size: 0.6875rem;
    padding: 0.2rem 0.5rem;
    border-radius: var(--ta-radius-sm);
    background: rgb(var(--ta-elevated));
    color: rgb(var(--ta-text-dim));
  }

  .chip.locked {
    text-decoration: line-through;
    opacity: 0.55;
  }

  .muted {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.5;
    color: rgb(var(--ta-text-dim));
  }

  code {
    font-family: var(--ta-font-mono);
    font-size: 0.6875rem;
    background: rgb(var(--ta-bg));
    padding: 0.125rem 0.3rem;
    border-radius: var(--ta-radius-sm);
  }

  @media (max-width: 640px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>

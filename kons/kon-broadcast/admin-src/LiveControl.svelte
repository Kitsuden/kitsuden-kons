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
    Badge,
    Button,
    ConfirmDialog,
    DescriptionList,
    EmptyState,
    Field,
    Input,
    Select,
    type DescriptionItem,
  } from "$lib/components";

  import { untrack } from "svelte";

  import { apiBaseOf, createApi, seg } from "./api";
  import type { Adapter, Game, Match, Side, ViewContext } from "./types";
  import FormGrid from "./ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "./ui/labels";
  import { createLoad } from "./ui/load.svelte";
  import Loadable from "./ui/Loadable.svelte";
  import { failed, toast } from "./ui/notify";
  import Panel from "./ui/Panel.svelte";
  import View from "./ui/View.svelte";

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
  let warnings = $state<string[]>([]);
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

  const facts = $derived.by((): DescriptionItem[] => {
    if (!match || !teams) return [];
    const list: DescriptionItem[] = [
      { label: "Blue side", value: teams.blue.name, color: teams.blue.color },
      { label: "Red side", value: teams.red.name, color: teams.red.color },
      { label: "Series", value: scoreText },
    ];
    if (match.fearless !== "off") list.push({ label: "Fearless", value: match.fearless });
    return list;
  });

  const draft = $derived(game?.draft ?? null);
  const showDraft = $derived(Boolean(draft && !draft.complete));

  /** Whose turn it is and what for; the server decides the order. */
  const turn = $derived.by(() => {
    const step = draft?.current;
    if (!step || !teams) return null;
    return {
      ban: step.action === "ban",
      team: (step.team === "blue" ? teams.blue : teams.red).name,
      side: step.team === "blue" ? "Blue side" : "Red side",
      step: step.index + 1,
    };
  });

  /**
   * `graphics/`, not `admin-asset/`: the admin artifacts route rejects `.html` on purpose, and
   * graphics go through their own route with its CSP.
   */
  const overlays = $derived.by((): DescriptionItem[] => {
    if (!teams || !chosenGame) return [];
    const base =
      `${location.origin}${apiBaseOf(context)}` +
      `/kons/kon-broadcast/graphics/overlay-live.html?game=${chosenGame}`;
    return [
      ["Full overlay", "full"],
      ["Match bar", "matchbar"],
      ["Gold and objectives", "gold,objectives"],
      ["Draft", "draft"],
      ["Post-game", "postgame"],
    ].map(([label, layers]) => ({
      label,
      value: layers === "full" ? base : `${base}&layers=${layers}`,
      copy: true,
      mono: true,
    }));
  });

  const seriesOptions = $derived(
    matchList.map((m) => ({ value: m.id, label: m.round ? `${m.eventTitle} · ${m.round}` : m.eventTitle }))
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

  // ── Data ───────────────────────────────────────────────────────────────────

  /** Lists the sets and opens the one being operated (the requested game's, else the first). */
  const data = createLoad(async () => {
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
      return;
    }

    try {
      const res = await api.get<{ docs?: Match[]; data?: Match[]; items?: Match[] } | Match[]>("/matches");
      matchList = Array.isArray(res) ? res : (res.docs ?? res.data ?? res.items ?? []);
    } catch (e) {
      matchList = [];
      throw e;
    }

    if (matchList.length === 0) {
      games = [];
      seriesValue = "";
      return;
    }

    let seriesId = match?.id ?? matchList[0].id;
    let prefer: string | null = null;
    const wanted = params?.gameId ?? context?.params?.gameId ?? null;
    if (wanted) {
      try {
        const { data: found } = await api.get<{ data: Game }>(`/games/${seg(wanted)}`);
        seriesId = found.matchId;
        prefer = found.id;
      } catch (e) {
        failed("Could not open the requested game", e);
      }
    }
    await openSeries(seriesId, prefer);
  });

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
    bootTimer = setTimeout(() => untrack(() => void data.load()), 0);
  });
  $effect(() => () => clearTimeout(bootTimer));

  async function openSeries(matchId: string, prefer: string | null = null) {
    if (!matchId) return;
    seriesValue = matchId;
    const { data: found } = await api.get<{ data: Match }>(`/matches/${seg(matchId)}`);
    match = found;
    // Games hang from their own route: most profiles have none.
    const list = await api.get<{ data?: Game[] }>(`/matches/${seg(matchId)}/games`);
    games = list.data ?? [];

    if (games.length === 0) {
      chosenGame = null;
      gameValue = "";
      game = null;
      return;
    }

    // The requested one; else the one being played; else the last one created.
    const alive =
      games.find((g) => g.id === prefer) ?? games.find((g) => g.status === "live") ?? games[games.length - 1];
    chosenGame = alive.id;
    gameValue = alive.id;
    await load();
  }

  /** Creates the set's next game; the server alternates the sides. */
  async function newGame() {
    if (!match) return;
    try {
      await api.post(`/matches/${seg(match.id)}/games`, {});
      await openSeries(match.id);
      toast.success(game ? `Game ${game.gameNumber} created` : "Game created");
    } catch (e) {
      failed("Could not create the game", e);
    }
  }

  async function load() {
    if (!chosenGame) return;
    const { data: found } = await api.get<{ data: Game }>(`/games/${seg(chosenGame)}`);
    game = found;
    const container = await api.get<{ data: Match }>(`/matches/${seg(found.matchId)}`);
    match = container.data;
    await sources.load();
    void loadChampions();
    await loadFearless();
  }

  /** The data sources of the ingestion. */
  const sources = createLoad(async () => {
    const { data: list } = await api.get<{ data: Adapter[] }>("/live/adapters");
    adapters = list ?? [];
    if (!adapters.some((a) => a.id === adapterId)) adapterId = adapters[0]?.id ?? "";
  });

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
      const { data: all } = await res.json();
      champions = Object.values((all ?? {}) as Record<string, { id: string; name: string }>).map((c) => ({
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
      const { data: found } = await api.get<{ data: { locked?: Record<string, string[]> } }>(
        `/games/${seg(chosenGame)}/fearless`
      );
      const side = game?.draft?.current?.team ?? null;
      locked = side ? (found.locked?.[side] ?? []) : [];
    } catch {
      // Informational: the server keeps rejecting what is not valid.
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  function chooseSeries(id: string) {
    openSeries(id).catch((e: unknown) => failed("Could not open the matchup", e));
  }

  function chooseGame(id: string) {
    chosenGame = id || null;
    if (chosenGame) load().catch((e: unknown) => failed("Could not open the game", e));
  }

  async function pick(championId: string | null) {
    if (!chosenGame) return;
    const now = turn;
    try {
      const { data: next } = await api.post<{ data: Game }>(`/games/${seg(chosenGame)}/draft`, { championId });
      game = next;
      if (championId) champ = "";
      toast.success(
        championId ? `${championId} ${now?.ban ? "banned" : "picked"} for ${now?.team ?? "the team"}` : "Ban skipped"
      );
      await loadFearless();
    } catch (e) {
      // The server's reason says WHY (champion already used, burned by Fearless).
      failed(championId ? `The draft did not take ${championId}` : "Could not skip the ban", e);
    }
  }

  const confirmPick = () => {
    if (champ.trim()) void pick(champ.trim());
  };

  async function startIngest() {
    if (!chosenGame) return;
    try {
      const result = await api.post<{ warnings?: string[] }>(`/games/${seg(chosenGame)}/ingest/start`, {
        adapterId,
      });
      warnings = result?.warnings ?? [];
      toast.success("Ingestion started");
    } catch (e) {
      failed("Could not start ingestion", e);
    }
  }

  /** A game action; the server answers with the game (and, on finish, the set). */
  async function act(path: string, body: unknown) {
    if (!chosenGame) return;
    const result = await api.post<{
      data?: (Game & { game?: Game; series?: Partial<Match>; match?: Partial<Match> }) | null;
    }>(`/games/${seg(chosenGame)}/${path}`, body ?? {});
    const next = result?.data;
    game = next?.game ?? (next && "id" in next ? next : null) ?? game;
    const series = next?.series ?? next?.match;
    if (series && match) match = { ...match, ...series };
    await loadFearless();
  }

  async function undo() {
    try {
      await act("draft/undo", undefined);
      toast.success("Last draft step undone");
    } catch (e) {
      failed("Could not undo the last draft step", e);
    }
  }

  async function stopIngest() {
    try {
      await act("ingest/stop", undefined);
      toast.success("Ingestion stopped");
    } catch (e) {
      failed("Could not stop ingestion", e);
    }
  }

  function askFinish(side: "blue" | "red") {
    confirming = side;
    finishErr = "";
    confirmOpen = true;
  }

  const winnerName = $derived(
    confirming ? ((confirming === "blue" ? teams?.blue : teams?.red)?.name ?? confirming) : ""
  );

  // Closing a game rewrites the series score: it is confirmed first. A failure keeps the dialog
  // open with the reason.
  async function finish() {
    const winner = winnerName;
    finishErr = "";
    try {
      await act("finish", { winner: confirming });
    } catch (e) {
      finishErr = e instanceof Error ? e.message : String(e);
      throw e;
    }
    toast.success(`Game closed: ${winner} wins`);
  }
</script>

<View>
  <Panel title="What is being broadcast">
    {#snippet actions()}
      <Button variant="outline" onclick={() => void data.load()}>Reload</Button>
      <Button variant="outline" disabled={gamesOff || !match} onclick={newGame}>New game</Button>
    {/snippet}
    <Loadable
      load={data}
      errorTitle="The matchups did not load"
      lines={3}
      empty={gamesOff || matchList.length === 0}
      emptyTitle={gamesOff ? "The games section is switched off" : "No matchups yet"}
      emptyDescription={gamesOff
        ? 'This booth operates games. Switch the section on in the grimoire: konConfig["kon-broadcast"].enableGames = true'
        : "Create one in the Sets tab and come back here. This booth operates a matchup that already exists; it does not create it."}
    >
      <div class="pickers">
        <Field label="Matchup">
          <Select
            bind:value={seriesValue}
            options={seriesOptions}
            onchange={(e: Event) => chooseSeries((e.currentTarget as HTMLSelectElement).value)}
          />
        </Field>
        <Field label="Game">
          <Select
            bind:value={gameValue}
            options={gameOptions}
            placeholder={games.length ? undefined : "No games"}
            disabled={games.length === 0}
            onchange={(e: Event) => chooseGame((e.currentTarget as HTMLSelectElement).value)}
          />
        </Field>
      </div>
      {#if match && games.length === 0}
        <EmptyState
          size="sm"
          level={3}
          title="This matchup has no games yet"
          description="The draft, the ingestion and the OBS sources belong to a game."
          actionLabel="New game"
          onAction={newGame}
        />
      {/if}
    </Loadable>
  </Panel>

  {#if data.ready && teams && match}
    <Panel title="Matchup">
      <DescriptionList ariaLabel="Matchup" items={facts}>
        {#snippet value(item)}
          {#if item.color}
            <span class="team">
              <span class="swatch" role="img" aria-label={`Colour of ${item.value}`} style:background={String(item.color)}
              ></span>
              {item.value}
            </span>
          {:else}
            {item.value}
          {/if}
        {/snippet}
      </DescriptionList>
    </Panel>

    {#if showDraft}
      <Panel title="Draft">
        {#snippet status()}
          {#if turn}<Badge variant="info" dot>Step {turn.step} of 20</Badge>{/if}
        {/snippet}
        {#if turn}
          <p class="turn">
            <Badge variant={turn.ban ? "warning" : "success"}>{turn.ban ? "Ban" : "Pick"}</Badge>
            <strong>{turn.team}</strong>
            <Badge>{turn.side}</Badge>
          </p>
        {/if}
        <FormGrid label="Draft step" onsubmit={confirmPick}>
          <Field label="Champion">
            <Input bind:value={champ} list={champsId} autocomplete="off" />
          </Field>
          {#snippet actions()}
            <Button variant="outline" onclick={undo}>Undo last step</Button>
            <Button variant="outline" onclick={() => void pick(null)}>Skip ban</Button>
            <Button type="submit">{turn?.ban === false ? "Confirm pick" : "Confirm ban"}</Button>
          {/snippet}
        </FormGrid>
        {#if match.fearless !== "off"}
          <section class="group" aria-labelledby={`${uid}-locked`}>
            <h3 class="sub" id={`${uid}-locked`}>Locked by Fearless</h3>
            {#if locked.length}
              <ul class="chips">
                {#each locked as c (c)}
                  <li><Badge>{c}</Badge></li>
                {/each}
              </ul>
            {:else}
              <p class="quiet">No locked champions.</p>
            {/if}
          </section>
        {/if}
      </Panel>
    {/if}

    <Panel title="Ingestion">
      <Loadable
        load={sources}
        errorTitle="The data sources did not load"
        lines={2}
        empty={adapters.length === 0}
        emptyTitle="No data sources"
        emptyDescription="This installation has no live adapter to read the game from."
      >
        <FormGrid label="Ingestion" onsubmit={startIngest}>
          <Field label="Data source">
            <Select bind:value={adapterId} options={adapterOptions} />
          </Field>
          {#snippet actions()}
            <Button variant="outline" disabled={!chosenGame} onclick={stopIngest}>Stop ingestion</Button>
            <Button type="submit" disabled={!chosenGame}>Start ingestion</Button>
          {/snippet}
        </FormGrid>
        {#if warnings.length}<Alert variant="warning">{warnings.join(" ")}</Alert>{/if}
      </Loadable>
    </Panel>

    <Panel
      title="Close game"
      description="Closes ingestion, adds the point to the series team (not to the side) and shows the result screen."
    >
      <div class="buttons">
        <Button variant="outline" disabled={!chosenGame} onclick={() => askFinish("blue")}>
          {teams.blue.name} (blue) wins
        </Button>
        <Button variant="outline" disabled={!chosenGame} onclick={() => askFinish("red")}>
          {teams.red.name} (red) wins
        </Button>
      </div>
    </Panel>

    <Panel
      title="OBS sources"
      description="Add a 1920×1080 Browser Source for each layer you want to separate. Without ?layers= the full overlay comes out."
    >
      <DescriptionList ariaLabel="OBS sources" items={overlays} />
    </Panel>
  {/if}

  <datalist id={champsId}>
    {#each champions as c (c.id)}
      <option value={c.id}>{c.name}</option>
    {/each}
  </datalist>

  <ConfirmDialog
    bind:open={confirmOpen}
    title={`Close the game with a win for ${winnerName}?`}
    confirmLabel="Close game"
    cancelLabel={CANCEL}
    closeLabel={CLOSE}
    variant="primary"
    onConfirm={finish}
  >
    {#if finishErr}<Alert variant="error" title="The game was not closed">{finishErr}</Alert>{/if}
  </ConfirmDialog>
</View>

<style>
  :host {
    display: block;
  }

  .pickers {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
    gap: 0.75rem;
    max-width: 44rem;
  }

  .team {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
  }

  .swatch {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: var(--ta-radius-sm);
    border: 1px solid rgb(var(--ta-border));
    flex-shrink: 0;
  }

  .turn {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0;
    font-size: 1rem;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .sub {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    font-weight: 600;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .quiet {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>

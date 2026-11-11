<svelte:options
  customElement={{
    tag: "wiki-creator",
    shadow: "open",
    props: { context: { type: "Object" }, params: { type: "Object" } },
  }}
/>

<!--
  <wiki-creator>: creates a game's wiki and lists the existing ones.

  Each wiki is published inside its game, at `/<game>/wiki/` of the site that serves it, so the
  GAME is mandatory and each game has a single wiki. While typing, the form asks
  `/wiki/wikis/suggestion` whether the slug is valid and whether the game already has a wiki, and
  shows exactly that: the rule is NOT reimplemented here, a copy in the panel would end up
  accepting what the server rejects.

  Creating a wiki is for administrators (policy `wiki-space`); the pages inside remain open. The
  admin mounts it with `context` ({ apiBase, theme, locale… }); calls use the browser's cookies.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import { Alert, Badge, Button, DataTable, EmptyState, Field, Input, Select, Textarea } from "$lib/components";
  import type { DataColumn } from "$lib/components";

  import { createApi } from "./api";
  import FormGrid from "./ui/FormGrid.svelte";
  import { createLoad } from "./ui/load.svelte";
  import { failed, toast } from "./ui/notify";
  import Panel from "./ui/Panel.svelte";
  import View from "./ui/View.svelte";

  interface ViewContext {
    apiBase?: string;
    theme?: "light" | "dark";
    locale?: string;
  }

  interface Game {
    id: string;
    title: string;
    slug: string;
  }

  interface Wiki {
    id: string;
    slug: string;
    title: string;
    gameId?: string | null;
    createdAt?: string;
  }

  interface Suggestion {
    slug?: string;
    valid: boolean;
    reason?: string | null;
  }

  let { context, params }: { context?: ViewContext; params?: unknown } = $props();

  const api = createApi(() => context?.apiBase || "/api");

  const DERIVED = "derived from the title";

  let games = $state<Game[]>([]);
  let wikis = $state<Wiki[]>([]);
  const gamesById = $derived(new Map(games.map((g) => [g.id, g])));
  const gameOptions = $derived(games.map((g) => ({ value: g.id, label: g.title })));

  let title = $state("");
  let gameId = $state("");
  let slug = $state("");
  let description = $state("");
  /** If someone typed the address by hand, the title stops overwriting it. */
  let slugManual = false;
  let slugPlaceholder = $state(DERIVED);

  let suggestion = $state<Suggestion | null>(null);
  let creating = $state(false);

  let debounce: ReturnType<typeof setTimeout> | undefined;
  /** Keeps a slow response from overwriting a newer one. */
  let latest = 0;

  const game = $derived(gamesById.get(gameId));
  // Without a game there is no address: the wiki lives inside it.
  const valid = $derived(Boolean(suggestion?.valid && game));
  const reason = $derived(
    !suggestion
      ? ""
      : !game
        ? "Choose the game: the wiki is published inside it."
        : valid
          ? "It can be created."
          : (suggestion.reason ?? "")
  );

  // The host may set `context` before or after connecting, and again when the theme changes:
  // load once per API base.
  let loadedBase: string | null = null;
  $effect(() => {
    const base = context?.apiBase || "/api";
    if (base === loadedBase) return;
    loadedBase = base;
    untrack(data.load);
  });

  const data = createLoad(async () => {
    // Without kon-games there are no games, and without a game there is nowhere to publish the
    // wiki: the dropdown stays empty and the server would reject the registration.
    const [w, g] = await Promise.allSettled([
      api.get<{ docs?: Wiki[] }>("/wiki/wikis"),
      api.get<{ docs?: Game[] }>("/games?limit=100"),
    ]);
    if (g.status === "fulfilled") {
      games = (g.value.docs ?? []).map((x) => ({ id: x.id, title: x.title, slug: x.slug }));
    }
    if (w.status === "fulfilled") wikis = w.value.docs ?? [];
    else throw w.reason;
  });

  function errorText(e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }

  function schedule() {
    clearTimeout(debounce);
    debounce = setTimeout(() => void suggest(), 250);
  }

  function onTitle() {
    if (!slugManual) slug = "";
    schedule();
  }

  // Read from the event: the binding may not have written `slug` yet.
  function onSlug(e: Event) {
    slugManual = (e.currentTarget as HTMLInputElement).value.trim() !== "";
    schedule();
  }

  async function suggest() {
    const t = title.trim();
    const s = slug.trim();
    if (!t && !s) {
      suggestion = null;
      return;
    }

    const number = ++latest;
    const query = new URLSearchParams();
    if (t) query.set("title", t);
    if (s) query.set("slug", s);
    if (gameId) query.set("game", gameId);

    try {
      const answer = await api.get<Suggestion>(`/wiki/wikis/suggestion?${query}`);
      if (number !== latest) return; // arrived late: a newer one already exists
      if (!slugManual) slugPlaceholder = answer.slug || DERIVED;
      suggestion = answer;
    } catch (e) {
      if (number !== latest) return;
      suggestion = { valid: false, reason: errorText(e) };
    }
  }

  async function create() {
    if (!valid || creating) return;
    creating = true;

    const body: { title: string; description?: string; gameId: string; slug?: string } = {
      title: title.trim(),
      description: description.trim() || undefined,
      gameId,
    };
    const wanted = slug.trim() || slugPlaceholder;
    if (wanted && wanted !== DERIVED) body.slug = wanted;

    try {
      const { data } = await api.post<{ data: Wiki }>("/wiki/wikis", body);
      const of = data?.gameId ? gamesById.get(data.gameId) : undefined;
      toast.success("Wiki created", of ? { description: `It is published at /${of.slug}/wiki/` } : undefined);

      clearTimeout(debounce);
      latest++;
      title = "";
      gameId = "";
      slug = "";
      description = "";
      slugManual = false;
      slugPlaceholder = DERIVED;
      suggestion = null;

      const list = await api.get<{ docs?: Wiki[] }>("/wiki/wikis");
      wikis = list.docs ?? [];
    } catch (e) {
      failed("Could not create the wiki", e);
    } finally {
      creating = false;
    }
  }

  function created(at?: string) {
    return at ? new Date(at).toLocaleDateString() : "";
  }

  const gameOf = (wiki: Wiki) => (wiki.gameId ? gamesById.get(wiki.gameId) : undefined);
  // Without a game it is not published: it predates wikis hanging off a game.
  const address = (wiki: Wiki) => {
    const of = gameOf(wiki);
    return of ? `/${of.slug}/wiki/` : "";
  };

  const columns: DataColumn<Wiki>[] = [
    { key: "title", header: "Wiki", sortable: true, hideable: false },
    { key: "address", header: "Address", value: address },
    {
      key: "game",
      header: "Game",
      sortable: true,
      value: (wiki) => (wiki.gameId ? (gameOf(wiki)?.title ?? "(game not available)") : "—"),
    },
    { key: "created", header: "Created", sortable: true, value: (wiki) => wiki.createdAt ?? "" },
  ];
</script>

<View>
  <Panel title="New wiki">
    <FormGrid label="New wiki" onsubmit={create}>
      <Field label="Title" required>
        <Input bind:value={title} maxlength={200} placeholder="Throne and Liberty" autocomplete="off" oninput={onTitle} />
      </Field>
      <Field label="Game" required>
        <Select bind:value={gameId} options={gameOptions} placeholder="— Choose the game —" onchange={schedule} />
      </Field>
      <Field label="Internal name (slug)">
        <Input
          bind:value={slug}
          maxlength={63}
          placeholder={slugPlaceholder}
          autocomplete="off"
          spellcheck="false"
          oninput={onSlug}
        />
      </Field>
      <Field label="Description" class="wide">
        <Textarea bind:value={description} maxlength={2000} />
      </Field>

      <div class="preview wide" aria-live="polite">
        {#if suggestion}
          <Alert variant={valid ? "success" : "warning"} title={game ? `/${game.slug}/wiki/` : "/<game>/wiki/"}>
            {reason}
          </Alert>
        {:else}
          <p class="hint">Choose the game and type a title to see the address.</p>
        {/if}
      </div>

      {#snippet actions()}
        <Button type="submit" disabled={!valid || creating} loading={creating}>Create wiki</Button>
      {/snippet}
    </FormGrid>
  </Panel>

  <Panel title="Wikis">
    {#snippet status()}
      {#if data.ready}<Badge>{wikis.length} {wikis.length === 1 ? "wiki" : "wikis"}</Badge>{/if}
    {/snippet}
    <DataTable
      caption="Wikis"
      rows={wikis}
      {columns}
      rowKey="id"
      rowLabel={(wiki) => wiki.title}
      pageSize={25}
      loading={data.loading}
      error={data.error}
      onRetry={data.load}
    >
      {#snippet cell(wiki, col)}
        {#if col.key === "address"}
          {#if address(wiki)}<code>{address(wiki)}</code>{:else}<Badge variant="secondary">Unpublished</Badge>{/if}
        {:else if col.key === "created"}
          {created(wiki.createdAt)}
        {:else}
          {col.value ? col.value(wiki) : wiki.title}
        {/if}
      {/snippet}
      {#snippet empty()}
        <EmptyState size="sm" level={null} title="No wikis yet" description="Create the first one with the form above." />
      {/snippet}
    </DataTable>
  </Panel>
</View>

<style>
  :host {
    display: block;
  }

  .hint {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  code {
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
  }
</style>

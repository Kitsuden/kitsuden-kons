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
  import {
    Alert,
    Button,
    Field,
    Input,
    Select,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Textarea,
    ThemeScope,
  } from "$lib/components";

  import { createApi } from "./api";
  import Panel from "./ui/Panel.svelte";

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
  let notice = $state<{ kind: "success" | "error"; text: string } | null>(null);

  let debounce: ReturnType<typeof setTimeout> | undefined;
  /** Keeps a slow response from overwriting a newer one. */
  let latest = 0;

  const game = $derived(gamesById.get(gameId));
  // Without a game there is no address: the wiki lives inside it.
  const valid = $derived(Boolean(suggestion?.valid && game));
  const previewState = $derived(!suggestion ? "empty" : valid ? "ok" : "error");
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
    load();
  });

  async function load() {
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
    else notice = { kind: "error", text: `Could not load the wikis: ${errorText(w.reason)}` };
  }

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

  async function create(event: SubmitEvent) {
    event.preventDefault();
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
      notice = { kind: "success", text: of ? `Wiki created: it is published at /${of.slug}/wiki/` : "Wiki created." };

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
      notice = { kind: "error", text: errorText(e) };
    } finally {
      creating = false;
    }
  }

  function created(at?: string) {
    return at ? new Date(at).toLocaleDateString() : "";
  }
</script>

<ThemeScope class="wiki-admin">
  <Panel title="New wiki">
    <form novalidate onsubmit={create}>
      <div class="grid">
        <Field label="Title" required>
          <Input
            bind:value={title}
            required
            maxlength={200}
            placeholder="Throne and Liberty"
            autocomplete="off"
            oninput={onTitle}
          />
        </Field>
        <Field label="Game" required>
          <Select
            bind:value={gameId}
            required
            options={gameOptions}
            placeholder="— Choose the game —"
            onchange={schedule}
          />
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
      </div>
      <div class="description">
        <Field label="Description">
          <Textarea bind:value={description} maxlength={2000} />
        </Field>
      </div>

      <div class="preview" data-state={previewState} aria-live="polite">
        <div class="url">
          {#if suggestion}
            {game ? `/${game.slug}/wiki/` : "/<game>/wiki/"}
          {:else}
            Choose the game and type a title to see the address.
          {/if}
        </div>
        {#if suggestion}
          <div class="reason">{reason}</div>
        {/if}
      </div>

      <div class="actions">
        <Button type="submit" disabled={!valid || creating} loading={creating}>Create wiki</Button>
      </div>
    </form>

    {#if notice}
      <div class="notice">
        <Alert variant={notice.kind} dismissLabel="Dismiss" onDismiss={() => (notice = null)}>
          {notice.text}
        </Alert>
      </div>
    {/if}
  </Panel>

  <Panel title={wikis.length ? `Wikis (${wikis.length})` : "Wikis"}>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Wiki</TableHead>
          <TableHead>Address</TableHead>
          <TableHead>Game</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each wikis as wiki (wiki.id)}
          {@const of = wiki.gameId ? gamesById.get(wiki.gameId) : undefined}
          <TableRow>
            <TableCell>{wiki.title}</TableCell>
            <!-- Without a game it is not published: it predates wikis hanging off a game. -->
            <TableCell><code>{of ? `/${of.slug}/wiki/` : "unpublished"}</code></TableCell>
            <TableCell>{wiki.gameId ? (of?.title ?? "(game not available)") : "—"}</TableCell>
            <TableCell>{created(wiki.createdAt)}</TableCell>
          </TableRow>
        {:else}
          <TableRow>
            <TableCell colspan={4}><span class="empty">There are no wikis yet.</span></TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </Panel>
</ThemeScope>

<style>
  :host {
    display: block;
  }

  :global(.wiki-admin) {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.75rem 1rem;
  }

  .description {
    margin-top: 0.75rem;
  }

  .preview {
    margin-top: 0.75rem;
    padding: 0.625rem 0.75rem;
    border: 1px dashed rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
    color: rgb(var(--ta-text));
  }

  .preview[data-state="ok"] {
    border-color: rgb(var(--ta-success) / 0.6);
  }

  .preview[data-state="error"] {
    border-color: rgb(var(--ta-danger) / 0.6);
  }

  .preview[data-state="empty"] .url {
    color: rgb(var(--ta-text-dim));
    font-family: var(--ta-font-sans);
  }

  .reason {
    margin-top: 0.25rem;
    font-family: var(--ta-font-sans);
    font-size: 0.75rem;
  }

  .preview[data-state="ok"] .reason {
    color: rgb(var(--ta-success));
  }

  .preview[data-state="error"] .reason {
    color: rgb(var(--ta-danger));
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  .notice {
    margin-top: 0.75rem;
  }

  code {
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
  }

  .empty {
    color: rgb(var(--ta-text-dim));
  }
</style>

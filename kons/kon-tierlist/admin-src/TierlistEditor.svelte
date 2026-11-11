<svelte:options
  customElement={{
    tag: "tierlist-editor",
    shadow: "open",
    props: { context: { type: "Object" }, params: { type: "Object" } },
  }}
/>

<!--
  <tierlist-editor>: the editorial board of the tier list kon.

  WHY IT IS NOT A GRID: a tier list is built by LOOKING at it. Distributing 80 characters across
  five rows from an `itemId | tierId` table forces you to hold the board in your head.

  Three decisions that are not about style:
    · Drag, click AND keys. HTML5 drag does not exist on touch, and a tier list is exactly what
      someone builds on a tablet: selecting a chip and then clicking the row does the same job.
      With the keyboard, Space picks a chip up, the arrows choose its row, Space drops it.
    · The move is painted before it is confirmed. With 200 elements, a round trip for every drop
      makes the board feel broken. If the server rejects, it is reverted and the reason is given.
    · One request per move, not a save of the whole list: two editors working at once only
      compete for the element both moved. So there is nothing to save, and no save bar.

  The editor does NOT decide: placing, validating and comparing is resolved by the engine on the
  server. Here you drag and show what it responds. Calls go with the browser's cookies.

  This file holds the state and the calls, and draws the first section (which list, its catalog,
  the form of a new one). The board is Board.svelte and the comparison is Compare.svelte.
-->
<script lang="ts">
  import { tick, untrack } from "svelte";

  import { Badge, Button, ConfirmDialog, Field, Input, Select, Switch } from "$lib/components";

  import { ApiError, createApi, seg } from "./api";
  import Board from "./Board.svelte";
  import Compare from "./Compare.svelte";
  import { rankedColors, slugDe, tiersFrom, titled, viewOf } from "./format";
  import type { Dataset, SyncResult, TemplateSummary, TierList } from "./types";
  import FormGrid from "./ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "./ui/labels";
  import { createLoad } from "./ui/load.svelte";
  import { failed, toast } from "./ui/notify";
  import Panel from "./ui/Panel.svelte";
  import View from "./ui/View.svelte";

  interface ViewContext {
    apiBase?: string;
    theme?: "light" | "dark";
    locale?: string;
    params?: { slug?: string };
  }

  let { context, params }: { context?: ViewContext; params?: { slug?: string } } = $props();

  const api = createApi(() => context?.apiBase || "/api");

  let templates = $state<TemplateSummary[]>([]);
  /** The open list, as the server returns it. */
  let list = $state<TierList | null>(null);
  let slug = $state<string | null>(null);
  let pickerSlug = $state("");
  /** Selected chip waiting for a row (the no-drag route). */
  let picked = $state<string | null>(null);

  // ── Load ───────────────────────────────────────────────────────────────────

  // The host may set `context` before or after connecting, and again when the theme changes:
  // load once per API base.
  let loadedBase: string | null = null;
  $effect(() => {
    const base = context?.apiBase || "/api";
    if (base === loadedBase) return;
    loadedBase = base;
    untrack(data.load);
  });

  // Dropping outside a row must not open the dragged file in the browser, which is the default
  // and takes the editor off the page. Escape drops the selection: otherwise, the marked chip
  // places itself in the next row clicked for any other reason.
  //
  // The listeners go on the HOST: Svelte handles `onkeydown` by delegation at the shadow root,
  // so a listener on an inner element would run BEFORE a chip's own Escape (which cancels a
  // keyboard move and stops the event there).
  $effect(() => {
    const host: EventTarget = $host();
    const stop = (e: Event) => e.preventDefault();
    const escape = (e: Event) => {
      if ((e as KeyboardEvent).key === "Escape" && !e.defaultPrevented) picked = null;
    };
    host.addEventListener("dragover", stop);
    host.addEventListener("drop", stop);
    host.addEventListener("keydown", escape);
    return () => {
      host.removeEventListener("dragover", stop);
      host.removeEventListener("drop", stop);
      host.removeEventListener("keydown", escape);
    };
  });

  /** The first load: the templates and the list to open. A failure is the board's error state. */
  async function load() {
    const { data } = await api.tierlist<{ data?: TemplateSummary[] }>("templates");
    templates = data ?? [];
    const wanted = params?.slug ?? context?.params?.slug ?? templates[0]?.slug ?? null;
    if (wanted) await read(wanted);
    // Saying there are none and not offering to create one is a dead end. The form is opened
    // directly: it is the only thing that can be done here.
    else void toggleNew(true);
  }

  const data = createLoad(load);

  /** Opens a list; `false` when it could not be read (the one on screen stays). */
  async function open(s: string | null): Promise<boolean> {
    if (!s) return false;
    try {
      await read(s);
      return true;
    } catch (e) {
      failed("Could not open the tier list", e);
      // The picker goes back to the list that is open.
      pickerSlug = slug ?? "";
      return false;
    }
  }

  async function read(s: string) {
    picked = null;
    const { data } = await api.tierlist<{ data: TierList }>(`templates/${seg(s)}`);
    slug = s;
    list = data;
    pickerSlug = s;
    rendered();
  }

  /** What follows the open list on every change: the catalog and the «manual» switch. */
  function rendered() {
    catalogValue = list?.catalogDatasetId ?? "";
    manualChecked = Boolean(list?.manual);
    void loadDatasets();
  }

  const templateOptions = $derived(templates.map((t) => ({ value: t.slug ?? "", label: titled(t) })));

  // ── Datasets (catalogs) ────────────────────────────────────────────────────

  let datasets = $state<Dataset[]>([]);
  let datasetsSettled = $state(false);
  let datasetsLoaded = false;
  let datasetsLoading: Promise<void> | null = null;

  /**
   * The available datasets, to choose a catalog. They are requested when a list is open or the
   * form is opened, not before: having none cannot prevent creating a tier list by hand.
   */
  function loadDatasets(): Promise<void> {
    if (datasetsLoaded) return Promise.resolve();
    datasetsLoading ??= (async () => {
      try {
        const payload = await api.other<{ docs?: Dataset[]; data?: Dataset[] }>("data-sets");
        datasets = payload.docs ?? payload.data ?? [];
        datasetsLoaded = true;
      } catch {
        // Having no datasets cannot prevent creating a tier list by hand.
      } finally {
        datasetsSettled = true;
        datasetsLoading = null;
      }
    })();
    return datasetsLoading;
  }

  const datasetOptions = $derived(datasets.map((d) => ({ value: d.id, label: d.name ?? d.slug ?? d.id })));

  // ── Catalog of the open list ───────────────────────────────────────────────

  let catalogValue = $state("");
  const pinned = $derived(list?.catalogDatasetId ?? "");

  const catalogOptions = $derived.by(() => {
    const options = [{ value: "", label: "No catalog — I add the items myself" }, ...datasetOptions];
    // If the pinned dataset is no longer among the readable ones —it was deleted, or stopped being
    // public— the dropdown would fall to «no catalog», which is a lie.
    if (datasetsSettled && pinned && !datasetOptions.some((o) => o.value === pinned)) {
      options.push({ value: pinned, label: "Pinned catalog that can no longer be read" });
    }
    return options;
  });

  let syncAsk = $state<{ label: string; lost: string[] } | null>(null);
  let syncOpen = $state(false);
  let syncConfirmed = false;

  /**
   * Re-reads the pinned dataset's catalog: a new character enters the dataset, this is pressed,
   * and it appears unranked without touching what is already placed. Changing the catalog FETCHES
   * it: choosing a dataset and having the board stay empty reads as if it didn't work.
   */
  async function sync(confirm = false) {
    if (!slug || !list) return;
    const datasetId = catalogValue || null;
    const current = slug;

    // Removing the catalog does NOT sync: it is detached and the chips stay where they are.
    if (!datasetId) {
      try {
        await api.tierlist("templates", "PUT", { slug: current, title: list.title, catalogDatasetId: null });
        if (await open(current)) toast.success("Catalog detached");
      } catch (e) {
        failed("Could not detach the catalog", e);
        catalogValue = list?.catalogDatasetId ?? "";
      }
      return;
    }

    try {
      const r = await api.tierlist<SyncResult>(`templates/${seg(current)}/sync`, "POST", {
        datasetId,
        ...(confirm ? { confirm: true } : {}),
      });
      await open(current);

      // «Catalog up to date» on an empty board is a lie: everything was already fetched, or there
      // is nothing there. With the catalog size they can be told apart.
      const newOnes = r.unranked ?? 0;
      const inCatalog = r.inCatalog ?? null;
      if (inCatalog === 0) toast.warning(`«${r.origin?.dataset ?? "The catalog"}» has no entries yet`);
      else if (newOnes === 0) toast.success("Catalog up to date");
      else toast.success("Catalog fetched", { description: `${newOnes} unranked` });
    } catch (e) {
      // 409 is not a failure: the server says this will take hand-placed chips with it. It asks
      // with the names up front.
      const lost = e instanceof ApiError && e.status === 409 ? e.payload.lost : undefined;
      if (Array.isArray(lost)) {
        syncAsk = {
          label: catalogOptions.find((o) => o.value === datasetId)?.label ?? "the catalog",
          lost: lost.map(String),
        };
        syncConfirmed = false;
        syncOpen = true;
        return;
      }
      failed("Could not fetch the catalog", e);
      catalogValue = list?.catalogDatasetId ?? "";
    }
  }

  function syncDialog(open: boolean) {
    syncOpen = open;
    // The dropdown is returned to what the list truly has: otherwise, it keeps showing a catalog
    // that never got applied.
    if (!open && !syncConfirmed) catalogValue = list?.catalogDatasetId ?? "";
  }

  // ── «Ordered by the team» ──────────────────────────────────────────────────

  let manualChecked = $state(false);

  /**
   * Marks or unmarks the list as «manual»: the content loader respects it. The PUT sends the
   * `version` the list already had (the endpoint empties it when absent). If the server rejects,
   * the switch goes back to its place: what is painted is what is true.
   */
  async function markManual(manual: boolean) {
    if (!slug || !list) return;
    try {
      const { data } = await api.tierlist<{ data: TierList }>("templates", "PUT", {
        slug,
        title: list.title,
        version: list.version,
        manual,
      });
      list = { ...list, ...data };
      manualChecked = manual;
      toast.success(manual ? "Ordered by the team" : "No longer ordered by the team");
    } catch (e) {
      manualChecked = !manual;
      failed("Could not change who orders the list", e);
    }
  }

  // ── Publish as page ────────────────────────────────────────────────────────

  let publishing = $state(false);

  /**
   * Publishes the open list as a page of its own, against the page builder's generic route
   * (idempotent by slug: republishing each patch updates the same URL).
   */
  async function publish() {
    if (!slug || !list) return;
    publishing = true;
    try {
      const payload = await api.other<{ created?: boolean; data: { slug: string } }>(
        "page-builder/pages/from-block",
        "POST",
        {
          blockType: "tier-list",
          title: list.title,
          slug,
          status: "published",
          content: { templateSlug: slug, showUnranked: true, allowFork: false },
        }
      );
      // The URL is stated, not just «done»: the first thing whoever publishes wants is to see it.
      toast.success(payload.created ? "Page published" : "Page updated", {
        description: `/${payload.data.slug}`,
      });
    } catch (e) {
      failed("Could not publish", e);
    } finally {
      publishing = false;
    }
  }

  // ── New tier list ──────────────────────────────────────────────────────────

  let creating = $state(false);
  let titleField: HTMLInputElement | undefined = $state();
  let newTitle = $state("");
  let newSlug = $state("");
  let newTiers = $state("S,A,B,C,D");
  let newDataset = $state("");
  let newErrors = $state<{ title?: string; slug?: string; tiers?: string }>({});
  /** Has someone typed the slug by hand? Then it is not overwritten. */
  let slugTouched = false;

  async function toggleNew(show: boolean) {
    creating = show;
    if (!show) return;
    slugTouched = false;
    newTitle = "";
    newSlug = "";
    newTiers = "S,A,B,C,D";
    newDataset = "";
    newErrors = {};
    void loadDatasets();
    await tick();
    titleField?.focus();
  }

  /** The slug is suggested from the title while typing, and stops as soon as someone touches it. */
  function titleInput() {
    if (!slugTouched) newSlug = slugDe(newTitle);
  }

  /** Creates the template and OPENS it: leaving the user on the same empty screen is no use. */
  async function create() {
    const title = newTitle.trim();
    const s = newSlug.trim() || slugDe(title);
    const tags = newTiers
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 12);

    newErrors = {
      title: title ? undefined : "A title is required",
      slug: s ? undefined : "A URL is required",
      tiers: tags.length ? undefined : "At least one row is required",
    };
    if (!title || !s || tags.length === 0) return;

    try {
      const catalogDatasetId = newDataset || null;
      // Each row gets its colour by POSITION, read from the theme's tokens; the API keeps it as hex
      // (and gives its own default to the rows the palette does not reach).
      const tiers = tiersFrom(tags, titleField ? rankedColors(getComputedStyle(titleField)) : []);
      await api.tierlist("templates", "PUT", { slug: s, title, tiers, catalogDatasetId });

      // If a catalog was chosen, it is filled in at once.
      if (catalogDatasetId) {
        await api.tierlist(`templates/${seg(s)}/sync`, "POST", { datasetId: catalogDatasetId });
      }

      creating = false;
      const { data } = await api.tierlist<{ data?: TemplateSummary[] }>("templates");
      templates = data ?? [];
      if (await open(s)) toast.success("Tier list created");
    } catch (err) {
      failed("Could not create the tier list", err);
    }
  }

  // ── Board ──────────────────────────────────────────────────────────────────

  const view = $derived(list ? viewOf(list) : null);
  const pickedItem = $derived(picked && list ? (list.items.find((i) => i.id === picked) ?? null) : null);

  /**
   * Places a chip. `null` returns it to the pool. It is painted BEFORE confirming and reverted if
   * the server rejects. The server's distribution is adopted afterwards: if another editor moved
   * something in the meantime, that move arrives here instead of being lost.
   */
  async function move(itemId: string, tierId: string | null) {
    if (!slug || !list) return;
    if ((list.placement[itemId] ?? null) === tierId) {
      picked = null;
      return;
    }

    const previous = list.placement;
    const optimistic = { ...previous };
    if (tierId === null) delete optimistic[itemId];
    else optimistic[itemId] = tierId;

    list = { ...list, placement: optimistic };
    picked = null;
    rendered();

    try {
      const { data } = await api.tierlist<{ data: TierList }>(`templates/${seg(slug)}/place`, "POST", {
        itemId,
        tierId,
      });
      list = { ...list, ...data };
      rendered();
    } catch (e) {
      list = { ...list, placement: previous };
      rendered();
      failed("Could not move", e);
    }
  }

  // ── Remove ─────────────────────────────────────────────────────────────────

  let removing = $state<{ id: string; label: string } | null>(null);
  let removeOpen = $state(false);

  function askRemove() {
    if (!picked) return;
    removing = { id: picked, label: pickedItem?.label ?? picked };
    removeOpen = true;
  }

  /** Removes the selected chip. It is confirmed: there is no undo. */
  async function remove() {
    if (!removing || !slug) return;
    const label = removing.label;
    try {
      await api.tierlist(`templates/${seg(slug)}/items/${seg(removing.id)}`, "DELETE");
      picked = null;
      if (await open(slug)) toast.success(`Removed «${label}»`);
    } catch (e) {
      failed("Could not remove the chip", e);
    }
  }

  // ── Add by hand ────────────────────────────────────────────────────────────

  /**
   * Adds a chip by hand. The id is derived from the name and not from a counter: two «Ganyu» are
   * the same chip, and the server updates instead of duplicating. `true` when it was added.
   */
  async function add(label: string, imageUrl: string | null): Promise<boolean> {
    if (!slug) return false;
    const id = slugDe(label) || `item-${Date.now()}`;

    try {
      await api.tierlist(`templates/${seg(slug)}/items`, "POST", { items: [{ id, label, imageUrl }] });
      await open(slug);
      return true;
    } catch (err) {
      failed("Could not add the chip", err);
      return false;
    }
  }
</script>

<View>
  <Panel title="Tier list">
    {#snippet status()}
      {#if list?.manual}<Badge dot>Ordered by the team</Badge>{/if}
    {/snippet}
    {#snippet actions()}
      <Button variant="secondary" disabled={!slug} onclick={() => void open(slug)}>Reload</Button>
      <Button variant="secondary" onclick={() => void toggleNew(true)}>New tier list</Button>
      {#if list}
        <Button loading={publishing} onclick={publish}>Publish as page</Button>
      {/if}
    {/snippet}

    <div class="fields">
      <Field label="Tier list">
        <Select
          aria-label="Tier list to edit"
          bind:value={pickerSlug}
          options={templateOptions}
          placeholder={templates.length || !data.ready ? undefined : "No tier lists"}
          disabled={!templates.length}
          onchange={(e: Event) => void open((e.currentTarget as HTMLSelectElement).value)}
        />
      </Field>
      {#if list}
        <Field label="Catalog">
          <Select aria-label="Catalog" bind:value={catalogValue} options={catalogOptions} onchange={() => void sync()} />
        </Field>
        <div class="fetch">
          <Button variant="secondary" disabled={!pinned} onclick={() => void sync()}>Fetch from catalog</Button>
        </div>
      {/if}
    </div>

    {#if list}
      <p class="hint">
        {pinned
          ? "New items enter unranked; what is already placed is not touched."
          : "Choose one and its entries come in as chips."}
      </p>
      <Switch
        bind:checked={manualChecked}
        label="Ordered by the team — the data reload doesn't touch it"
        onchange={(manual) => void markManual(manual)}
      />
    {/if}

    {#if creating}
      <h3 class="sub">New tier list</h3>
      <FormGrid label="New tier list" onsubmit={create}>
        <Field label="Title" required error={newErrors.title}>
          <Input
            aria-label="Title"
            bind:ref={titleField}
            bind:value={newTitle}
            oninput={titleInput}
            placeholder="Patch 1.2 tier list"
            required
          />
        </Field>
        <Field label="URL" required error={newErrors.slug}>
          <Input
            aria-label="URL"
            bind:value={newSlug}
            oninput={() => (slugTouched = true)}
            placeholder="list-url"
            pattern="[a-z0-9\-]+"
            required
          />
        </Field>
        <Field label="Rows" error={newErrors.tiers}>
          <Input aria-label="Rows" bind:value={newTiers} placeholder="Rows separated by commas" />
        </Field>
        <!-- The ITEMS can come from a dataset; the ROWS cannot — you decide those. -->
        <Field label="Catalog">
          <Select
            aria-label="Catalog to take the items from"
            bind:value={newDataset}
            options={[{ value: "", label: "No catalog — I add them by hand" }, ...datasetOptions]}
          />
        </Field>
        {#snippet actions()}
          <Button variant="ghost" onclick={() => void toggleNew(false)}>{CANCEL}</Button>
          <Button type="submit">Create</Button>
        {/snippet}
      </FormGrid>
    {/if}
  </Panel>

  <Board
    load={data}
    {list}
    {view}
    bind:picked
    onMove={move}
    onRemove={askRemove}
    onAdd={add}
    onNew={() => void toggleNew(true)}
  />

  <Compare {api} {slug} {templates} />

  <ConfirmDialog
    bind:open={removeOpen}
    title={`Remove «${removing?.label ?? ""}» from this tier list?`}
    description="The chip and its placement are deleted."
    confirmLabel="Remove"
    cancelLabel={CANCEL}
    closeLabel={CLOSE}
    variant="danger"
    onConfirm={remove}
  />

  <ConfirmDialog
    bind:open={() => syncOpen, syncDialog}
    title={`Fetch «${syncAsk?.label ?? ""}»?`}
    description={syncAsk
      ? `Fetching «${syncAsk.label}» will delete ${syncAsk.lost.length} chip(s) you added by hand, and their placement:`
      : undefined}
    confirmLabel="Fetch and delete"
    cancelLabel={CANCEL}
    closeLabel={CLOSE}
    variant="danger"
    onConfirm={() => {
      syncConfirmed = true;
      return sync(true);
    }}
  >
    {#if syncAsk}
      <p class="lost">{syncAsk.lost.slice(0, 15).join(", ")}{syncAsk.lost.length > 15 ? "…" : ""}</p>
    {/if}
  </ConfirmDialog>
</View>

<style>
  :host {
    display: block;
  }

  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
    gap: 0.75rem;
    align-items: end;
  }

  .fetch {
    display: flex;
  }

  .hint {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .sub {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    font-weight: 600;
  }

  .lost {
    margin: 0;
    font-size: 0.875rem;
    color: rgb(var(--ta-text));
  }
</style>

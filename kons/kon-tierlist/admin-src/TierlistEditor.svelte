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
      compete for the element both moved.

  The editor does NOT decide: placing, validating and comparing is resolved by the engine on the
  server. Here you drag and show what it responds. Calls go with the browser's cookies.
-->
<script lang="ts">
  import { tick, untrack } from "svelte";

  import {
    Alert,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Checkbox,
    ConfirmDialog,
    DragBoard,
    DragItem,
    DropZone,
    Input,
    Select,
    ThemeScope,
  } from "$lib/components";

  import { ApiError, createApi, seg } from "./api";
  import Chip from "./Chip.svelte";
  import { arrow, diffGroups, diffMarkdown, slugDe, statusOf, tiersFrom, titled, viewOf } from "./format";
  import type { Dataset, Diff, SyncResult, TemplateSummary, TierList } from "./types";

  interface ViewContext {
    apiBase?: string;
    theme?: "light" | "dark";
    locale?: string;
    params?: { slug?: string };
  }

  let { context, params }: { context?: ViewContext; params?: { slug?: string } } = $props();

  const api = createApi(() => context?.apiBase || "/api");

  /** The pool's zone id: tier ids come from the server, this one cannot collide with them. */
  const POOL = "\u0000unranked";

  const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  let templates = $state<TemplateSummary[]>([]);
  /** The open list, as the server returns it. */
  let list = $state<TierList | null>(null);
  let slug = $state<string | null>(null);
  let pickerSlug = $state("");
  /** Selected chip waiting for a row (the no-drag route). */
  let picked = $state<string | null>(null);
  let status = $state("");
  let boardError = $state<string | null>(null);

  // ── Load ───────────────────────────────────────────────────────────────────

  // The host may set `context` before or after connecting, and again when the theme changes:
  // load once per API base.
  let loadedBase: string | null = null;
  $effect(() => {
    const base = context?.apiBase || "/api";
    if (base === loadedBase) return;
    loadedBase = base;
    untrack(() => void load());
  });

  // Dropping outside a row must not open the dragged file in the browser, which is the default
  // and takes the editor off the page. Escape drops the selection: otherwise, the marked chip
  // places itself in the next row clicked for any other reason.
  //
  // The listeners go on the HOST, as before: Svelte handles `onkeydown` by delegation at the
  // shadow root, so a listener on an inner element would run BEFORE a chip's own Escape (which
  // cancels a keyboard move and stops the event there).
  function guard(node: HTMLElement) {
    const rootNode = node.getRootNode();
    const root: EventTarget = rootNode instanceof ShadowRoot ? rootNode.host : node;
    const stop = (e: Event) => e.preventDefault();
    const escape = (e: Event) => {
      if ((e as KeyboardEvent).key === "Escape" && !e.defaultPrevented) picked = null;
    };
    root.addEventListener("dragover", stop);
    root.addEventListener("drop", stop);
    root.addEventListener("keydown", escape);
    return () => {
      root.removeEventListener("dragover", stop);
      root.removeEventListener("drop", stop);
      root.removeEventListener("keydown", escape);
    };
  }

  async function load() {
    try {
      const { data } = await api.tierlist<{ data?: TemplateSummary[] }>("templates");
      templates = data ?? [];
      const wanted = params?.slug ?? context?.params?.slug ?? templates[0]?.slug ?? null;
      if (wanted) await open(wanted);
      else {
        // Saying there are none and not offering to create one is a dead end. The form is opened
        // directly: it is the only thing that can be done here.
        boardError = "There is no tier list yet. Fill in the form above.";
        void toggleNew(true);
      }
    } catch (e) {
      boardError = errorText(e);
    }
  }

  async function open(s: string | null) {
    if (!s) return;
    boardError = null;
    picked = null;
    try {
      const { data } = await api.tierlist<{ data: TierList }>(`templates/${seg(s)}`);
      slug = s;
      list = data;
      pickerSlug = s;
      rendered();
    } catch (e) {
      boardError = errorText(e);
    }
  }

  /** What the old board repainted on every change: status line, catalog and «manual» box. */
  function rendered() {
    status = statusOf(list);
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
        boardError = null;
        await api.tierlist("templates", "PUT", { slug: current, title: list.title, catalogDatasetId: null });
        await open(current);
      } catch (e) {
        boardError = errorText(e);
      }
      return;
    }

    try {
      boardError = null;
      const r = await api.tierlist<SyncResult>(`templates/${seg(current)}/sync`, "POST", {
        datasetId,
        ...(confirm ? { confirm: true } : {}),
      });
      await open(current);

      // «Catalog up to date» on an empty board is a lie: everything was already fetched, or there
      // is nothing there. With the catalog size they can be told apart.
      const newOnes = r.unranked ?? 0;
      const inCatalog = r.inCatalog ?? null;
      if (inCatalog === 0) status = `«${r.origin?.dataset ?? "The catalog"}» has no entries yet`;
      else if (newOnes === 0) status = "Catalog up to date";
      else status = `${newOnes} unranked`;
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
      boardError = errorText(e);
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
   * the box goes back to its place: what is painted is what is true.
   */
  async function markManual(manual: boolean) {
    if (!slug || !list) return;
    try {
      boardError = null;
      const { data } = await api.tierlist<{ data: TierList }>("templates", "PUT", {
        slug,
        title: list.title,
        version: list.version,
        manual,
      });
      list = { ...list, ...data };
      manualChecked = manual;
      status = statusOf(list);
    } catch (e) {
      manualChecked = !manual;
      boardError = errorText(e);
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
      boardError = null;
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
      status = `${payload.created ? "Published" : "Updated"} at /${payload.data.slug}`;
    } catch (e) {
      boardError = `Could not publish: ${errorText(e)}`;
    } finally {
      publishing = false;
    }
  }

  // ── New tier list ──────────────────────────────────────────────────────────

  let creating = $state(false);
  let newForm: HTMLFormElement | undefined = $state();
  let newTitle = $state("");
  let newSlug = $state("");
  let newTiers = $state("S,A,B,C,D");
  let newDataset = $state("");
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
    void loadDatasets();
    await tick();
    newForm?.querySelector<HTMLInputElement>("input")?.focus();
  }

  /** The slug is suggested from the title while typing, and stops as soon as someone touches it. */
  function titleInput() {
    if (!slugTouched) newSlug = slugDe(newTitle);
  }

  /** Creates the template and OPENS it: leaving the user on the same empty screen is no use. */
  async function create(e: SubmitEvent) {
    e.preventDefault();
    const title = newTitle.trim();
    const s = newSlug.trim() || slugDe(title);
    const tags = newTiers
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 12);

    if (!title || !s) {
      boardError = "A title and a URL are required.";
      return;
    }
    if (tags.length === 0) {
      boardError = "At least one row is required.";
      return;
    }

    try {
      boardError = null;
      const catalogDatasetId = newDataset || null;
      await api.tierlist("templates", "PUT", { slug: s, title, tiers: tiersFrom(tags), catalogDatasetId });

      // If a catalog was chosen, it is filled in at once.
      if (catalogDatasetId) {
        await api.tierlist(`templates/${seg(s)}/sync`, "POST", { datasetId: catalogDatasetId });
      }

      creating = false;
      const { data } = await api.tierlist<{ data?: TemplateSummary[] }>("templates");
      templates = data ?? [];
      await open(s);
    } catch (err) {
      boardError = errorText(err);
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
    boardError = null;

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
      boardError = `Could not move: ${errorText(e)}`;
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
    try {
      boardError = null;
      await api.tierlist(`templates/${seg(slug)}/items/${seg(removing.id)}`, "DELETE");
      picked = null;
      await open(slug);
    } catch (e) {
      boardError = errorText(e);
    }
  }

  // ── Add by hand ────────────────────────────────────────────────────────────

  let addForm: HTMLFormElement | undefined = $state();
  let addLabel = $state("");
  let addImage = $state("");
  let addError = $state<string | null>(null);

  /**
   * Adds a chip by hand. The id is derived from the name and not from a counter: two «Ganyu» are
   * the same chip, and the server updates instead of duplicating.
   */
  async function addItems(e: SubmitEvent) {
    e.preventDefault();
    if (!slug) return;
    const label = addLabel.trim();
    if (!label) return;
    const imageUrl = addImage.trim() || null;
    const id = slugDe(label) || `item-${Date.now()}`;

    try {
      addError = null;
      await api.tierlist(`templates/${seg(slug)}/items`, "POST", { items: [{ id, label, imageUrl }] });
      // Only the name is cleared: when adding several from the same source, clearing the URL too
      // forces re-pasting it every time.
      addLabel = "";
      addForm?.querySelector<HTMLInputElement>("input")?.focus();
      await open(slug);
    } catch (err) {
      addError = errorText(err);
    }
  }

  // ── Diff ───────────────────────────────────────────────────────────────────

  // The comparison is against ANOTHER template: each published version is its own entry
  // (`meta-14-1`, `meta-14-2`), so the previous one is in this same list.
  const others = $derived(templates.filter((t) => t.slug !== slug));
  const diffOptions = $derived(others.map((t) => ({ value: t.id, label: titled(t) })));
  let diffValue = $derived(others[0]?.id ?? "");
  let lastDiff = $state<Diff | null>(null);
  let diffError = $state<string | null>(null);
  let copied = $state(false);

  async function diff() {
    const otherId = diffValue;
    if (!otherId || !slug) return;
    diffError = null;
    try {
      const payload = await api.tierlist<{ data: Diff }>(`templates/${seg(slug)}/diff/${seg(otherId)}`);
      lastDiff = payload.data;
    } catch (e) {
      diffError = errorText(e);
    }
  }

  async function copyDiff() {
    if (!lastDiff) return;
    try {
      await navigator.clipboard.writeText(diffMarkdown(lastDiff));
      copied = true;
    } catch {
      // The clipboard fails without a user gesture or without permission.
      diffError = "The browser blocked the clipboard.";
      return;
    }
    setTimeout(() => (copied = false), 1500);
  }
</script>

<ThemeScope>
  <div class="tierlist-admin" {@attach guard}>
    <Card>
      <CardHeader>
        <CardTitle>Tier list</CardTitle>
        <span class="muted">{status}</span>
      </CardHeader>
      <CardContent>
        <div class="stack">
          <div class="row">
            <div class="grow">
              <Select
                aria-label="Tier list to edit"
                bind:value={pickerSlug}
                options={templateOptions}
                placeholder={templates.length ? undefined : "No tier lists"}
                disabled={!templates.length}
                onchange={(e: Event) => void open((e.currentTarget as HTMLSelectElement).value)}
              />
            </div>
            <Button variant="secondary" onclick={() => void open(slug)}>Reload</Button>
            <Button variant="secondary" onclick={() => void toggleNew(true)}>New tier list</Button>
            {#if list}
              <Button variant="secondary" loading={publishing} onclick={publish}>Publish as page</Button>
            {/if}
            <span class="muted">Drag a chip to its row, or click it and then click the row.</span>
          </div>

          {#if list}
            <div class="row">
              <span class="muted">Catalog</span>
              <div class="grow">
                <Select
                  aria-label="Catalog"
                  bind:value={catalogValue}
                  options={catalogOptions}
                  onchange={() => void sync()}
                />
              </div>
              <Button variant="secondary" disabled={!pinned} onclick={() => void sync()}>Fetch from catalog</Button>
              <span class="muted">
                {pinned
                  ? "New items enter unranked; what is already placed is not touched."
                  : "Choose one and its entries come in as chips."}
              </span>
            </div>

            <div class="row">
              <Checkbox
                checked={manualChecked}
                label="Ordered by the team — the data reload doesn't touch it"
                onchange={(e: Event) => void markManual((e.currentTarget as HTMLInputElement).checked)}
              />
            </div>
          {/if}

          {#if creating}
            <form class="new-item" bind:this={newForm} onsubmit={create}>
              <div class="row">
                <div class="grow">
                  <Input
                    aria-label="Title"
                    bind:value={newTitle}
                    oninput={titleInput}
                    placeholder="Title — «Patch 1.2 tier list»"
                    required
                  />
                </div>
                <div class="grow">
                  <Input
                    aria-label="URL"
                    bind:value={newSlug}
                    oninput={() => (slugTouched = true)}
                    placeholder="list-url"
                    pattern="[a-z0-9\-]+"
                    required
                  />
                </div>
              </div>
              <div class="row">
                <div class="grow">
                  <Input aria-label="Rows" bind:value={newTiers} placeholder="Rows separated by commas" />
                </div>
                <!-- The ITEMS can come from a dataset; the ROWS cannot — you decide those. -->
                <div class="grow">
                  <Select
                    aria-label="Catalog to take the items from"
                    bind:value={newDataset}
                    options={[{ value: "", label: "No catalog — I add them by hand" }, ...datasetOptions]}
                  />
                </div>
              </div>
              <div class="row">
                <Button type="submit">Create</Button>
                <Button variant="ghost" onclick={() => void toggleNew(false)}>Cancel</Button>
              </div>
              <span class="muted">
                The rows and the catalog can be changed later, and items can be added by hand from the board.
              </span>
            </form>
          {/if}

          {#if boardError}
            <Alert variant="error">{boardError}</Alert>
          {/if}
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Board</CardTitle>
        {#if list && view}
          <span class="muted">
            {list.items.length - view.unranked.length}/{list.items.length} placed{view.unranked.length
              ? ` · ${view.unranked.length} unranked`
              : ""}
          </span>
        {/if}
      </CardHeader>
      <CardContent>
        {#if list && view}
          <DragBoard
            bind:selected={picked}
            onMove={(item, zone) => move(item, zone === POOL ? null : zone)}
            class="board-wrap"
          >
            <div class="board">
              {#each view.rows as row (row.tier.id)}
                <DropZone id={row.tier.id} label={row.tier.label} class="tier-row">
                  <button
                    type="button"
                    class="tier-label"
                    style:background={row.tier.color ?? undefined}
                    title={`Place the selected chip in ${row.tier.label}`}
                    onclick={() => picked && void move(picked, row.tier.id)}
                  >
                    {row.tier.label}
                  </button>
                  <div class="tier-items">
                    {#each row.items as item (item.id)}
                      <DragItem id={item.id} label={item.label} zone={row.tier.id} title={item.label} class="chip">
                        <Chip {item} />
                      </DragItem>
                    {/each}
                  </div>
                </DropZone>
              {/each}
            </div>

            <div class="pool-head">
              <h4>Unranked</h4>
              <!--
                Removing is offered on the SELECTED chip and not with an «x» on each one: the chips
                are the drop target, and a control inside them turns every clumsy drag into a deletion.
              -->
              {#if pickedItem}
                <Button size="sm" variant="secondary" onclick={askRemove}>Remove «{pickedItem.label}»</Button>
              {/if}
            </div>
            <DropZone id={POOL} label="Unranked" class="tier-items pool">
              {#each view.unranked as item (item.id)}
                <DragItem id={item.id} label={item.label} zone={POOL} title={item.label} class="chip">
                  <Chip {item} />
                </DragItem>
              {:else}
                <span class="empty">No unranked chips</span>
              {/each}
            </DropZone>
          </DragBoard>

          <form class="row add" bind:this={addForm} onsubmit={addItems}>
            <div class="grow">
              <Input aria-label="Chip name" bind:value={addLabel} placeholder="Add by hand — chip name" maxlength={120} />
            </div>
            <div class="grow">
              <Input aria-label="Image URL" bind:value={addImage} placeholder="Image URL (optional)" maxlength={500} />
            </div>
            <Button type="submit" variant="secondary">Add</Button>
          </form>
          {#if addError}
            <Alert variant="error">{addError}</Alert>
          {/if}
        {:else}
          <p class="empty">No tier list open</p>
        {/if}
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>What changed</CardTitle>
        <span class="muted">The diff IS the update post</span>
      </CardHeader>
      <CardContent>
        <div class="stack">
          <div class="row">
            <div class="grow">
              <Select
                aria-label="Version to compare with"
                bind:value={diffValue}
                options={diffOptions}
                placeholder={diffOptions.length ? undefined : "No other version"}
                disabled={!diffOptions.length}
              />
            </div>
            <Button variant="secondary" disabled={others.length === 0} onclick={diff}>Compare</Button>
            <Button variant="secondary" disabled={!lastDiff} onclick={copyDiff}>
              {copied ? "Copied" : "Copy as markdown"}
            </Button>
          </div>

          {#if lastDiff}
            {@const groups = diffGroups(lastDiff)}
            <div class="diff">
              {#each groups as [title, changes, tone] (title)}
                <div class="diff-group">
                  <h4>{title} ({changes.length})</h4>
                  {#each changes as change (change.item.id)}
                    <div class={["diff-line", tone]}><b>{change.item.label}</b> {arrow(change)}</div>
                  {/each}
                </div>
              {:else}
                <p class="empty">No changes between these two versions.</p>
              {/each}
              {#if groups.length}
                <!-- Those that did not move are COUNTED, not listed. -->
                <div class="diff-line">{lastDiff.unchanged} unchanged</div>
              {/if}
            </div>
          {/if}

          {#if diffError}
            <Alert variant="error">{diffError}</Alert>
          {/if}
        </div>
      </CardContent>
    </Card>

    <ConfirmDialog
      bind:open={removeOpen}
      title={`Remove «${removing?.label ?? ""}» from this tier list?`}
      confirmLabel="Remove"
      cancelLabel="Cancel"
      closeLabel="Close"
      onConfirm={remove}
    />

    <ConfirmDialog
      bind:open={() => syncOpen, syncDialog}
      title="Continue?"
      description={syncAsk
        ? `Fetching «${syncAsk.label}» will delete ${syncAsk.lost.length} chip(s) you added by hand, and their placement:`
        : undefined}
      confirmLabel="Continue"
      cancelLabel="Cancel"
      closeLabel="Close"
      onConfirm={() => {
        syncConfirmed = true;
        return sync(true);
      }}
    >
      {#if syncAsk}
        <p class="lost">{syncAsk.lost.slice(0, 15).join(", ")}{syncAsk.lost.length > 15 ? "…" : ""}</p>
      {/if}
    </ConfirmDialog>
  </div>
</ThemeScope>

<style>
  :host {
    display: block;
  }

  :global(.tierlist-admin) {
    display: grid;
    gap: 1rem;
  }

  .stack {
    display: grid;
    gap: 0.75rem;
  }

  .row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .grow {
    flex: 1 1 10rem;
    min-width: 9rem;
  }

  .muted {
    color: rgb(var(--ta-text-dim));
    font-size: 0.75rem;
    font-weight: 400;
  }

  .empty {
    margin: 0;
    padding: 0.625rem 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .new-item {
    display: grid;
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    background: rgb(var(--ta-bg));
  }

  .add {
    margin-top: 0.75rem;
  }

  .lost {
    margin: 0;
    font-size: 0.875rem;
    color: rgb(var(--ta-text));
  }

  /* ── Board ── */
  .board {
    display: grid;
    gap: 3px;
  }

  /* The drop target is marked on the BORDER of the whole row: with the rows stuck together,
     highlighting only the chip area leaves you unsure where it will land. */
  .board :global(.tier-row) {
    display: grid;
    grid-template-columns: 76px 1fr;
    align-items: stretch;
    background: rgb(var(--ta-elevated));
    border-radius: var(--ta-radius-sm);
    overflow: hidden;
    border: 1px solid transparent;
    box-shadow: none;
  }

  .board :global(.tier-row[data-over]) {
    border-color: rgb(var(--ta-accent));
  }

  .tier-label {
    display: flex;
    align-items: center;
    justify-content: center;
    font: inherit;
    font-size: 22px;
    font-weight: 800;
    /* Dark text: the row's colour comes from the data and is always a bright one. */
    color: #14181f;
    background: rgb(var(--ta-muted));
    min-height: 62px;
    padding: 4px;
    text-align: center;
    word-break: break-word;
    line-height: 1.1;
    cursor: pointer;
    border: none;
  }

  .tier-label:focus-visible {
    outline: 2px solid rgb(var(--ta-text));
    outline-offset: -4px;
  }

  /* Also the pool, which is a DropZone with this class. */
  :global(.tierlist-admin .tier-items) {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 5px;
    min-height: 62px;
    align-content: flex-start;
  }

  :global(.tierlist-admin .pool) {
    border: 1px dashed rgb(var(--ta-border));
    border-radius: var(--ta-radius-sm);
    box-shadow: none;
  }

  :global(.tierlist-admin .pool[data-over]) {
    border-color: rgb(var(--ta-accent));
    border-style: solid;
  }

  .pool-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    margin: 0.875rem 0 0.5rem;
  }

  h4 {
    margin: 0;
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgb(var(--ta-text-dim));
    font-weight: 600;
  }

  /* ── Chips ── */
  :global(.tierlist-admin .chip) {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 9px 4px 4px;
    border-radius: 3px;
    font-size: 12px;
    background: rgb(var(--ta-bg));
    color: rgb(var(--ta-text));
    max-width: 168px;
  }

  :global(.tierlist-admin .chip[aria-pressed="true"]) {
    background: rgb(var(--ta-accent) / 0.12);
  }

  /* ── Diff ── */
  .diff {
    display: grid;
    gap: 10px;
  }

  .diff-group h4 {
    margin: 0 0 5px;
    font-size: 12px;
    letter-spacing: 0;
    text-transform: none;
    color: rgb(var(--ta-text));
  }

  .diff-line {
    font-size: 12px;
    line-height: 1.7;
    color: rgb(var(--ta-text-dim));
  }

  .diff-line b {
    color: rgb(var(--ta-text));
    font-weight: 600;
  }

  .up {
    color: rgb(var(--ta-success));
  }

  .down {
    color: rgb(var(--ta-danger));
  }
</style>

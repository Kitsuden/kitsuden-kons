<!--
  The board of the open list: a row per tier, the pool of what is left to place, and the form
  that adds a chip by hand. It draws and reports; the calls are the editor's.

  A row's colour comes from the list (it is data, and it is what the public tier list paints):
  here it is a band beside the row's name, never the background of the text, so the name reads
  on any colour and the colour is never the only thing that tells the rows apart.
-->
<script lang="ts">
  import { Badge, Button, DragBoard, DragItem, DropZone, EmptyState, Field, Input, Skeleton } from "$lib/components";

  import Chip from "./Chip.svelte";
  import type { Item, Tier, TierList } from "./types";
  import FormGrid from "./ui/FormGrid.svelte";
  import type { Load } from "./ui/load.svelte";
  import Loadable from "./ui/Loadable.svelte";
  import Panel from "./ui/Panel.svelte";

  let {
    load,
    list,
    view,
    picked = $bindable(),
    onMove,
    onRemove,
    onAdd,
    onNew,
  }: {
    /** The editor's first load: while there is no list, the board shows its state. */
    load: Load;
    list: TierList | null;
    view: { rows: { tier: Tier; items: Item[] }[]; unranked: Item[] } | null;
    /** Selected chip waiting for a row (the no-drag route). */
    picked: string | null;
    /** `null` returns the chip to the pool. */
    onMove: (itemId: string, tierId: string | null) => void | Promise<void>;
    /** Asks to remove the selected chip. */
    onRemove: () => void;
    /** Adds a chip by hand; `true` when it was added. */
    onAdd: (label: string, imageUrl: string | null) => Promise<boolean>;
    onNew: () => void;
  } = $props();

  /** The pool's zone id: tier ids come from the server, this one cannot collide with them. */
  const POOL = "\u0000unranked";

  const pickedItem = $derived(picked && list ? (list.items.find((i) => i.id === picked) ?? null) : null);

  let nameField: HTMLInputElement | undefined = $state();
  let addLabel = $state("");
  let addImage = $state("");
  let adding = $state(false);

  async function addItems() {
    const label = addLabel.trim();
    if (!label || adding) return;
    adding = true;
    try {
      if (!(await onAdd(label, addImage.trim() || null))) return;
      // Only the name is cleared: when adding several from the same source, clearing the URL too
      // forces re-pasting it every time.
      addLabel = "";
      nameField?.focus();
    } finally {
      adding = false;
    }
  }
</script>

<Panel title="Board" description="Drag a chip to its row, or click it and then click the row.">
  {#snippet status()}
    {#if list && view}
      <Badge>{list.items.length - view.unranked.length}/{list.items.length} placed</Badge>
      {#if view.unranked.length}<Badge variant="secondary">{view.unranked.length} unranked</Badge>{/if}
    {/if}
  {/snippet}

  {#if list && view}
    <DragBoard bind:selected={picked} onMove={(item, zone) => onMove(item, zone === POOL ? null : zone)} class="board-wrap">
      <div class="board">
        {#each view.rows as row (row.tier.id)}
          <DropZone id={row.tier.id} label={row.tier.label} class="tier-row">
            <Button
              variant="ghost"
              class="tier-label"
              title={`Place the selected chip in ${row.tier.label}`}
              onclick={() => picked && void onMove(picked, row.tier.id)}
            >
              <span class="swatch" style:background={row.tier.color ?? undefined} aria-hidden="true"></span>
              <span class="tier-name">{row.tier.label}</span>
            </Button>
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
        <h3 class="sub">Unranked</h3>
        <!--
          Removing is offered on the SELECTED chip and not with an «x» on each one: the chips
          are the drop target, and a control inside them turns every clumsy drag into a deletion.
        -->
        {#if pickedItem}
          <Button size="sm" variant="danger-ghost" onclick={onRemove}>Remove «{pickedItem.label}»</Button>
        {/if}
      </div>
      <DropZone id={POOL} label="Unranked" class="tier-items pool">
        {#each view.unranked as item (item.id)}
          <DragItem id={item.id} label={item.label} zone={POOL} title={item.label} class="chip">
            <Chip {item} />
          </DragItem>
        {:else}
          {#if list.items.length}
            <span class="none">No unranked chips</span>
          {:else}
            <EmptyState
              size="sm"
              level={null}
              title="No chips yet"
              description="Fetch them from a catalog, or add them by hand below."
            />
          {/if}
        {/each}
      </DropZone>
    </DragBoard>

    <h3 class="sub">Add a chip by hand</h3>
    <FormGrid label="Add a chip by hand" onsubmit={addItems}>
      <Field label="Chip name">
        <Input aria-label="Chip name" bind:ref={nameField} bind:value={addLabel} maxlength={120} />
      </Field>
      <Field label="Image URL">
        <Input aria-label="Image URL" bind:value={addImage} placeholder="Optional" maxlength={500} />
      </Field>
      {#snippet actions()}
        <Button type="submit" variant="secondary" loading={adding}>Add</Button>
      {/snippet}
    </FormGrid>
  {:else}
    <Loadable
      {load}
      empty
      errorTitle="Could not load the tier lists"
      emptyTitle="There is no tier list yet"
      emptyDescription="Create the first one: its rows, and the catalog its chips come from."
      actionLabel="New tier list"
      onAction={onNew}
    >
      {#snippet skeleton()}
        {#each [0, 1, 2, 3] as row (row)}<Skeleton height="62px" />{/each}
      {/snippet}
      <!-- Without a list there is nothing else to draw: loading, the error or the empty state. -->
      {#snippet children()}{/snippet}
    </Loadable>
  {/if}
</Panel>

<style>
  .sub {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    font-weight: 600;
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
    grid-template-columns: 5.5rem minmax(0, 1fr);
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

  /* The row's name is a button: it places the selected chip there. */
  .board :global(.tier-label) {
    justify-content: flex-start;
    gap: 0.5rem;
    width: 100%;
    height: auto;
    min-height: 62px;
    padding: 4px 6px 4px 4px;
    border-radius: 0;
    background: rgb(var(--ta-muted));
    color: rgb(var(--ta-text));
    font-size: 1.25rem;
    font-weight: 800;
    line-height: 1.1;
    white-space: normal;
  }

  /* The row's colour, from the list. Without one, the border colour. */
  .swatch {
    flex: none;
    align-self: stretch;
    width: 0.625rem;
    border-radius: var(--ta-radius-sm);
    background: rgb(var(--ta-border));
  }

  .tier-name {
    min-width: 0;
    overflow-wrap: anywhere;
    text-align: start;
  }

  /* Also the pool, which is a DropZone with this class. */
  :global(.board-wrap .tier-items) {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 5px;
    min-height: 62px;
    min-width: 0;
    align-content: flex-start;
  }

  :global(.board-wrap .pool) {
    border: 1px dashed rgb(var(--ta-border));
    border-radius: var(--ta-radius-sm);
    box-shadow: none;
  }

  :global(.board-wrap .pool[data-over]) {
    border-color: rgb(var(--ta-accent));
    border-style: solid;
  }

  .pool-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
    min-height: 2rem;
    margin: 1rem 0 0.5rem;
  }

  .pool-head .sub {
    margin: 0;
  }

  .none {
    padding: 0.625rem 0.25rem;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  /* ── Chips ── */
  :global(.board-wrap .chip) {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 9px 4px 4px;
    border-radius: var(--ta-radius-sm);
    font-size: 0.75rem;
    background: rgb(var(--ta-bg));
    color: rgb(var(--ta-text));
    max-width: 168px;
  }

  :global(.board-wrap .chip[aria-pressed="true"]) {
    background: rgb(var(--ta-accent) / 0.12);
  }
</style>

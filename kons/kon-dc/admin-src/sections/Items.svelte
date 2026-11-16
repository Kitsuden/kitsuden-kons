<!--
  The item catalog: what the Items module sells, what loot drops, what goes on a profile. A server's
  own items, or global ones (every server shows them, paid in credits: badges, backgrounds). Each
  item is a form; inventories count items by their id, so an id is chosen once.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import {
    Alert,
    Badge,
    Button,
    ConfirmDialog,
    DataTable,
    Dialog,
    SchemaForm,
    Select,
    type DataColumn,
    type JsonSchema,
  } from "$lib/components";

  import { seg } from "../api";
  import { useApi } from "../context";
  import type { CatalogItem, Guild } from "../types";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import RowMenu, { type RowAction } from "../ui/RowMenu.svelte";
  import { createLoad } from "../ui/load.svelte";
  import { failed, toast } from "../ui/notify";

  const api = useApi();

  let guilds = $state<Guild[]>([]);
  let scope = $state("global");
  let items = $state<CatalogItem[]>([]);

  const list = createLoad(async () => {
    items = (await api.get<{ docs: CatalogItem[] }>(`/items?guildId=${seg(scope)}`)).docs;
  });
  $effect(() => {
    untrack(() => {
      api
        .get<{ docs: Guild[] }>("/guilds")
        .then((r) => (guilds = r.docs.filter((g) => !g.leftAt)))
        .catch((e) => failed("The servers did not load", e));
    });
  });
  $effect(() => {
    void scope;
    untrack(() => void list.load());
  });

  const scopes = $derived([{ value: "global", label: "Global (every server)" }, ...guilds.map((g) => ({ value: g.id, label: g.name }))]);

  const columns: DataColumn<CatalogItem>[] = [
    { key: "name", header: "Item", sortable: true },
    { key: "rarity", header: "Rarity", sortable: true },
    { key: "kind", header: "Kind", sortable: true },
    { key: "price", header: "Price", align: "right", sortable: true },
    { key: "stock", header: "Sold", align: "right" },
    { key: "enabled", header: "On sale" },
  ];

  /** The form: what PUT /items takes, without the server (chosen above). */
  const schema: JsonSchema = {
    type: "object",
    required: ["item", "name"],
    properties: {
      item: { type: "string", title: "Id", pattern: "[a-z0-9_-]{1,64}", description: "Lowercase, e.g. vip-pass. Inventories count by it: do not change it later" },
      name: { type: "string", title: "Name", maxLength: 80 },
      emoji: { type: "string", title: "Emoji", maxLength: 64 },
      description: { type: "string", title: "Description", maxLength: 300, "x-widget": "textarea" },
      rarity: { type: "string", title: "Rarity", enum: ["common", "uncommon", "rare", "epic", "legendary"], default: "common" },
      kind: {
        type: "string",
        title: "Kind",
        oneOf: [
          { const: "item", title: "Item (kept)" },
          { const: "consumable", title: "Consumable (used up; blueprints hear it)" },
          { const: "role", title: "Role (using it gives a role)" },
          { const: "badge", title: "Badge (on the profile)" },
          { const: "background", title: "Background (behind the profile card)" },
          { const: "pet", title: "Pet" },
        ],
        default: "item",
      },
      price: { type: "integer", title: "Price", minimum: 0, description: "Empty = not for sale" },
      currency: { type: "string", title: "Currency", default: "coins", description: "Global items are paid in credits" },
      sellPrice: { type: "integer", title: "Sell price", minimum: 0, description: "What /items sell pays; empty = cannot be sold" },
      stock: { type: "integer", title: "Stock", minimum: 0, description: "Empty = unlimited" },
      roleId: { type: "string", title: "Role id", pattern: "\\d{15,20}", description: "For role items" },
      imageUrl: { type: "string", title: "Image URL", format: "uri", description: "https; drawn on cards only from Discord or allowed hosts" },
      color: { type: "string", title: "Colour", pattern: "#[0-9a-fA-F]{6}", description: "#rrggbb (badges); empty = the rarity's" },
      dropWeight: { type: "integer", title: "Drop weight", minimum: 0, default: 1, description: "How often random drops give it (0 = never)" },
      tradeable: { type: "boolean", title: "Can be traded and gifted", default: true },
      enabled: { type: "boolean", title: "Shown", default: true },
    },
  };

  let editing = $state<CatalogItem | null>(null);
  let formOpen = $state(false);
  let value = $state<Record<string, unknown>>({});
  let formError = $state<string | null>(null);

  function open(item: CatalogItem | null) {
    editing = item;
    formError = null;
    value = item ? Object.fromEntries(Object.entries(item).filter(([k, v]) => k in schema.properties! && v !== null)) : {};
    formOpen = true;
  }

  async function save(v: Record<string, unknown>) {
    const body: Record<string, unknown> = { guildId: scope === "global" ? null : scope };
    for (const [k, x] of Object.entries(v)) body[k] = x === "" || x === undefined ? null : x;
    try {
      await api.put("/items", body);
      toast.success(`${String(v.name)} saved`);
      formOpen = false;
      await list.load();
    } catch (e) {
      formError = e instanceof Error ? e.message : String(e);
    }
  }

  let deleting = $state<CatalogItem | null>(null);
  let confirmOpen = $state(false);
  async function remove() {
    if (!deleting) return;
    try {
      await api.del(`/items/${seg(deleting.id)}`);
      toast.success(`${deleting.name} deleted`);
      await list.load();
    } catch (e) {
      failed("Could not delete the item", e);
    }
  }

  const menu = (i: CatalogItem): RowAction[] => [
    { label: "Edit", onSelect: () => open(i) },
    {
      label: "Delete",
      danger: true,
      separated: true,
      onSelect: () => {
        deleting = i;
        confirmOpen = true;
      },
    },
  ];

  const RARITY_TONE: Record<string, "default" | "success" | "info" | "warning" | "error"> = {
    common: "default",
    uncommon: "success",
    rare: "info",
    epic: "error",
    legendary: "warning",
  };
</script>

<Panel title="Item catalog">
  {#snippet status()}
    <Badge>{items.length}</Badge>
  {/snippet}
  {#snippet actions()}
    <Select bind:value={scope} options={scopes} aria-label="Whose items" />
    <Button size="sm" onclick={() => open(null)}>New item</Button>
  {/snippet}
  <DataTable
    caption="Items"
    rows={items}
    {columns}
    rowKey="id"
    rowLabel={(i) => i.name}
    loading={list.loading}
    error={list.error}
    onRetry={list.load}
    emptyText={scope === "global" ? "No global items yet: badges and backgrounds go here" : "No items in this server yet"}
  >
    {#snippet cell(i, col)}
      {#if col.key === "name"}
        <span class="name">{i.emoji ? `${i.emoji} ` : ""}{i.name}</span> <code>{i.item}</code>
      {:else if col.key === "rarity"}
        <Badge variant={RARITY_TONE[i.rarity] ?? "default"}>{i.rarity}</Badge>
      {:else if col.key === "price"}
        {i.price === null ? "—" : `${i.price} ${i.currency}`}
      {:else if col.key === "stock"}
        {i.stock === null ? i.sold : `${i.sold} / ${i.stock}`}
      {:else if col.key === "enabled"}
        {i.enabled ? "Yes" : "No"}
      {:else}
        {String(i[col.key as keyof CatalogItem] ?? "")}
      {/if}
    {/snippet}
    {#snippet rowActions(i)}
      <RowMenu label={`Actions: ${i.name}`} items={menu(i)} />
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open={formOpen} title={editing ? `Edit ${editing.name}` : "New item"} closeLabel={CLOSE} size="lg">
  {#if formError}<Alert variant="error" title="Not saved">{formError}</Alert>{/if}
  {#if formOpen}
    <SchemaForm {schema} bind:value submitLabel="Save" onsubmit={save} />
  {/if}
</Dialog>

<ConfirmDialog
  bind:open={confirmOpen}
  title={deleting ? `Delete ${deleting.name}?` : "Delete?"}
  description="Inventories keep their counts under its id, shown as the bare id until an item with it exists again."
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  onConfirm={remove}
/>

<style>
  .name {
    font-weight: 600;
  }

  code {
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
</style>

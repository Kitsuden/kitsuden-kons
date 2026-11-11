<!-- Client portal links: which work, which expired, and revoking one that works. -->
<script lang="ts">
  import { Badge, ConfirmDialog, DataTable, EmptyState, type DataColumn } from "$lib/components";
  import { untrack } from "svelte";

  import { seg, type Api } from "../api";
  import type { PortalLink } from "../types";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { createLoad } from "../ui/load.svelte";
  import { failed, toast } from "../ui/notify";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";

  const { api }: { api: Api } = $props();

  let links = $state<PortalLink[]>([]);
  let revoking = $state<PortalLink | null>(null);
  let confirmRevoke = $state(false);

  const stateOf = (l: PortalLink) => (l.live ? "Working" : l.revokedAt ? "Revoked" : "Expired");

  const columns: DataColumn<PortalLink>[] = [
    { key: "contactId", header: "Contact", sortable: true, hideable: false },
    { key: "expiresAt", header: "Until", sortable: true, value: (l) => String(l.expiresAt).slice(0, 10) },
    { key: "state", header: "State", sortable: true, value: stateOf },
  ];

  const data = createLoad(async () => {
    links = (await api.get<{ data: PortalLink[] }>("portal-links")).data;
  });

  $effect(() => {
    untrack(data.load);
  });

  async function revoke() {
    const link = revoking!;
    try {
      await api.del(`portal-links/${seg(link.id)}`);
    } catch (e) {
      failed("Could not revoke the link", e);
      throw e;
    }
    toast.success(`The link of ${link.contactId} no longer works`);
    await data.load();
  }
</script>

<Panel title="Client portal links" description="The links clients open their portal with: which work, which expired.">
  {#snippet status()}
    {#if data.ready}<Badge>{links.filter((l) => l.live).length} working</Badge>{/if}
  {/snippet}
  <DataTable
    caption="Client portal links"
    rows={links}
    {columns}
    rowKey="id"
    rowLabel={(l) => l.contactId}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet cell(l, col)}
      {#if col.key === "state"}
        <Badge variant={l.live ? "success" : l.revokedAt ? "error" : "default"} dot>{stateOf(l)}</Badge>
      {:else if col.key === "contactId"}
        {l.contactId}
      {:else}
        {col.value?.(l)}
      {/if}
    {/snippet}
    {#snippet rowActions(l)}
      {#if l.live}
        <RowMenu
          label={`Actions: link of ${l.contactId}`}
          items={[
            {
              label: "Revoke",
              danger: true,
              onSelect: () => {
                revoking = l;
                confirmRevoke = true;
              },
            },
          ]}
        />
      {/if}
    {/snippet}
    {#snippet empty()}
      <EmptyState
        size="sm"
        level={null}
        title="No portal links yet"
        description="A link appears here when someone on the team, or an agent, sends a client their portal."
      />
    {/snippet}
  </DataTable>
</Panel>

<ConfirmDialog
  bind:open={confirmRevoke}
  title={`Revoke the link of ${revoking?.contactId ?? ""}?`}
  description="The client can no longer open the portal with it. A new link has to be sent."
  confirmLabel="Revoke"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="danger"
  onConfirm={revoke}
/>

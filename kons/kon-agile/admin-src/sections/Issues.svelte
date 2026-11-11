<!--
  Issue audit: find issues (archived ones too), archive or restore them, and delete them for
  good. Editing an issue's content is daily work and stays out of the admin panel.
-->
<script lang="ts">
  import { Badge, Checkbox, ConfirmDialog, DataTable, EmptyState, FilterBar, type DataColumn, type FilterValues } from "$lib/components";
  import { untrack } from "svelte";

  import { seg } from "../api";
  import { day, words } from "../format";
  import type { Issue, List } from "../types";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { createLoad } from "../ui/load.svelte";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";
  import Swatch from "../ui/Swatch.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();
  const LIMIT = 200;
  const NONE = "__none";

  let issues = $state<Issue[]>([]);
  // The filters of the list: the API takes them as query parameters.
  let query = $state<FilterValues>({});
  let search = "";
  let stateId = $state("");
  let assigneeId = $state("");
  let archived = $state(false);
  let deleting = $state<Issue | null>(null);
  let confirmDelete = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const filtered = $derived(!!stateId || !!assigneeId || archived || !!query.q);

  const columns: DataColumn<Issue>[] = [
    { key: "key", header: "Key", sortable: true, hideable: false },
    { key: "name", header: "Issue", sortable: true },
    { key: "stateName", header: "State", sortable: true, value: (i) => i.stateName ?? "—" },
    { key: "assigneeId", header: "Assignee", sortable: true, value: (i) => ws.memberLabel(i.assigneeId) },
    { key: "priority", header: "Priority", sortable: true, value: (i) => words(i.priority) },
    { key: "createdAt", header: "Created", sortable: true, value: (i) => day(i.createdAt) },
  ];

  const data = createLoad(async () => {
    const res = await ws.api.get<List<Issue>>(`/${seg(ws.projectId!)}/issues`, {
      search: search.trim(),
      stateId,
      assigneeId: assigneeId === NONE ? undefined : assigneeId,
      unassigned: assigneeId === NONE ? "true" : undefined,
      includeArchived: archived ? "true" : undefined,
      limit: LIMIT,
    });
    issues = archived ? res.docs.filter((i) => i.archivedAt) : res.docs;
  });

  // Filters reload at once; the search waits for a pause in typing.
  $effect(() => {
    void [ws.version, stateId, assigneeId, archived];
    if (ws.projectId) untrack(data.load);
  });

  function changed(value: FilterValues) {
    const q = String(value.q ?? "");
    if (q !== search) {
      search = q;
      clearTimeout(timer);
      timer = setTimeout(data.load, 300);
    }
    stateId = String(value.state ?? "");
    assigneeId = String(value.assignee ?? "");
  }

  function clear() {
    archived = false;
    query = {};
    changed({});
  }

  async function setArchived(i: Issue, value: boolean) {
    await ws.run(
      () => ws.api.post(`/issues/${seg(i.key)}/${value ? "archive" : "unarchive"}`),
      value ? `${i.key} archived` : `${i.key} restored`,
      value ? `Could not archive ${i.key}` : `Could not restore ${i.key}`
    );
    await data.load();
  }

  async function remove() {
    await ws.act(() => ws.api.del(`/issues/${seg(deleting!.key)}`), `${deleting!.key} deleted`, `Could not delete ${deleting!.key}`);
    await data.load();
  }
</script>

<Panel title="Issues">
  {#snippet status()}
    {#if data.ready}<Badge>{issues.length >= LIMIT ? `First ${LIMIT}` : `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`}</Badge>{/if}
  {/snippet}
  <FilterBar
    bind:value={query}
    onchange={changed}
    ariaLabel="Filter the issues"
    searchPlaceholder="Search name or key"
    filters={[
      { key: "state", label: "State", type: "select", options: ws.stateOptions },
      { key: "assignee", label: "Assignee", type: "select", options: [{ value: NONE, label: "Unassigned" }, ...ws.memberOptions] },
    ]}
  >
    {#snippet end()}
      <Checkbox bind:checked={archived} label="Archived only" />
    {/snippet}
  </FilterBar>
  <DataTable
    caption="Issues"
    rows={issues}
    {columns}
    rowKey="id"
    rowLabel={(i) => i.key}
    pageSize={25}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet cell(i, col)}
      {#if col.key === "key"}
        <code>{i.key}</code>
      {:else if col.key === "name"}
        <span class="name">
          {i.name}
          {#if i.archivedAt}<Badge>Archived {day(i.archivedAt)}</Badge>{/if}
        </span>
      {:else if col.key === "stateName"}
        {#if i.stateName}<Swatch color={i.stateColor} name={i.stateName} />{:else}—{/if}
      {:else}
        <span class="nowrap">{col.value?.(i)}</span>
      {/if}
    {/snippet}
    {#snippet rowActions(i)}
      <RowMenu
        label={`Actions: ${i.key}`}
        items={[
          { label: i.archivedAt ? "Restore" : "Archive", onSelect: () => void setArchived(i, !i.archivedAt) },
          {
            label: "Delete",
            danger: true,
            separated: true,
            onSelect: () => {
              deleting = i;
              confirmDelete = true;
            },
          },
        ]}
      />
    {/snippet}
    {#snippet empty()}
      {#if filtered}
        <EmptyState size="sm" level={null} variant="no-results" onClearFilters={clear} />
      {:else}
        <EmptyState size="sm" level={null} title="No issues yet" description="Issues are created on the board or by approving an intake." />
      {/if}
    {/snippet}
  </DataTable>
</Panel>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete ${deleting?.key ?? ""} for good?`}
  description={deleting?.name}
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="danger"
  onConfirm={remove}
/>

<style>
  .nowrap {
    white-space: nowrap;
  }

  .name {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    min-width: 10rem;
  }

  code {
    white-space: nowrap;
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
  }
</style>

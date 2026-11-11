<!--
  Squads: teams inside the project. An agent that is a squad's scrum master also writes on the
  issues of the squad's members and on unassigned ones; everyone else, agent or not, keeps to
  their own issues. The scrum master and the members are changed in the squad's "Members"
  dialog, one request per change.
-->
<script lang="ts">
  import {
    Badge,
    Button,
    ConfirmDialog,
    DataTable,
    Dialog,
    EmptyState,
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
    type DataColumn,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { seg } from "../api";
  import { optional } from "../format";
  import type { List, Squad } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { createLoad } from "../ui/load.svelte";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let squads = $state<Squad[]>([]);
  let editing = $state<Squad | null>(null);
  let form = $state({ name: "", description: "" });
  let open = $state(false);
  let saving = $state(false);
  let deleting = $state<Squad | null>(null);
  let confirmDelete = $state(false);
  let managingId = $state<string | null>(null);
  let managingOpen = $state(false);

  // Read from the list, so the dialog shows each change once the list is back.
  const managing = $derived(squads.find((s) => s.id === managingId) ?? null);

  const columns: DataColumn<Squad>[] = [
    { key: "name", header: "Squad", sortable: true, hideable: false },
    { key: "scrumMasterId", header: "Scrum master", sortable: true, value: (s) => ws.memberLabel(s.scrumMasterId) },
    { key: "members", header: "Members", sortable: true, value: (s) => s.memberIds.length },
  ];

  const data = createLoad(async () => {
    squads = (await ws.api.get<List<Squad>>(`/${seg(ws.projectId!)}/squads`)).docs;
  });

  // Reload when the project changes or another section changed something.
  $effect(() => {
    void ws.version;
    if (ws.projectId) untrack(data.load);
  });

  function edit(s: Squad | null) {
    editing = s;
    form = { name: s?.name ?? "", description: s?.description ?? "" };
    open = true;
  }

  async function save() {
    const body = { name: form.name.trim(), description: optional(form.description) ?? "" };
    saving = true;
    try {
      await ws.act(
        () => (editing ? ws.api.patch(`/squads/${seg(editing.id)}`, body) : ws.api.post(`/${seg(ws.projectId!)}/squads`, body)),
        editing ? "Squad saved" : "Squad created",
        editing ? "Could not save the squad" : "Could not create the squad"
      );
      open = false;
      await data.load();
    } catch {
      // Shown in the toast.
    } finally {
      saving = false;
    }
  }

  async function setScrumMaster(s: Squad, value: string) {
    await ws.run(
      () => ws.api.patch(`/squads/${seg(s.id)}`, { scrumMasterId: value || null }),
      "Scrum master changed",
      "Could not change the scrum master"
    );
    await data.load();
  }

  async function addMember(s: Squad, userId: string) {
    if (!userId) return;
    await ws.run(() => ws.api.post(`/squads/${seg(s.id)}/members`, { userId }), "Member added to the squad", "Could not add the member to the squad");
    await data.load();
  }

  async function removeMember(s: Squad, userId: string) {
    await ws.run(
      () => ws.api.del(`/squads/${seg(s.id)}/members/${seg(userId)}`),
      "Member removed from the squad",
      "Could not remove the member from the squad"
    );
    await data.load();
  }

  async function remove() {
    await ws.act(() => ws.api.del(`/squads/${seg(deleting!.id)}`), "Squad deleted", "Could not delete the squad");
    await data.load();
  }
</script>

<Panel title="Squads">
  {#snippet status()}
    {#if data.ready}<Badge>{squads.length} {squads.length === 1 ? "squad" : "squads"}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Button onclick={() => edit(null)}>New squad</Button>
  {/snippet}
  <DataTable
    caption="Squads"
    rows={squads}
    {columns}
    rowKey="id"
    rowLabel={(s) => s.name}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet cell(s, col)}
      {#if col.key === "members"}
        <span class="members">
          {#each s.memberIds as id (id)}
            <Badge variant={ws.members.find((m) => m.userId === id)?.isAgent ? "info" : "default"}>{ws.memberLabel(id)}</Badge>
          {:else}
            —
          {/each}
        </span>
      {:else if col.key === "name"}
        {s.name}
      {:else}
        {col.value?.(s)}
      {/if}
    {/snippet}
    {#snippet rowActions(s)}
      <RowMenu
        label={`Actions: ${s.name}`}
        items={[
          { label: "Edit", onSelect: () => edit(s) },
          {
            label: "Members",
            onSelect: () => {
              managingId = s.id;
              managingOpen = true;
            },
          },
          {
            label: "Delete",
            danger: true,
            separated: true,
            onSelect: () => {
              deleting = s;
              confirmDelete = true;
            },
          },
        ]}
      />
    {/snippet}
    {#snippet empty()}
      <EmptyState size="sm" level={null} title="No squads yet" actionLabel="New squad" onAction={() => edit(null)} />
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New squad"} closeLabel={CLOSE}>
  <FormGrid label={editing ? `Edit ${editing.name}` : "New squad"} onsubmit={() => form.name.trim() && !saving && save()}>
    <Field label="Name" required class="wide">
      <Input bind:value={form.name} maxlength={100} />
    </Field>
    <Field label="Description" class="wide">
      <Textarea bind:value={form.description} rows={2} maxlength={2000} />
    </Field>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{CANCEL}</Button>
    <Button loading={saving} disabled={!form.name.trim()} onclick={save}>Save</Button>
  {/snippet}
</Dialog>

<Dialog bind:open={managingOpen} title={`Members of ${managing?.name ?? ""}`} closeLabel={CLOSE}>
  {#if managing}
    {@const squad = managing}
    <div class="manage">
      <Field label="Scrum master">
        <Select
          value={squad.scrumMasterId ?? ""}
          options={ws.memberOptions}
          placeholder="None"
          onchange={(e: Event) => setScrumMaster(squad, (e.currentTarget as HTMLSelectElement).value)}
        />
      </Field>
      {#if squad.memberIds.length}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead><span class="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each squad.memberIds as id (id)}
              <TableRow>
                <TableCell>{ws.memberLabel(id)}</TableCell>
                <TableCell>
                  <span class="end">
                    <Button size="sm" variant="ghost" ariaLabel={`Remove ${id} from ${squad.name}`} onclick={() => removeMember(squad, id)}>
                      Remove
                    </Button>
                  </span>
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {:else}
        <EmptyState size="sm" level={null} title="No members in this squad yet" />
      {/if}
      <Field label="Add a member">
        <Select
          value=""
          options={ws.memberOptions.filter((o) => !squad.memberIds.includes(o.value))}
          placeholder="Choose a member"
          onchange={(e: Event) => addMember(squad, (e.currentTarget as HTMLSelectElement).value)}
        />
      </Field>
    </div>
  {/if}
  {#snippet footer()}
    <Button onclick={() => (managingOpen = false)}>Done</Button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete ${deleting?.name ?? ""}?`}
  description="Its scrum master loses the reach over the squad's issues."
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="danger"
  onConfirm={remove}
/>

<style>
  .members {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    flex-wrap: wrap;
  }

  .manage {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .end {
    display: flex;
    justify-content: flex-end;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
</style>

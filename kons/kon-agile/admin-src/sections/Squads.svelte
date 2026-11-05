<!--
  Squads: teams inside the project. An agent that is a squad's scrum master also writes on the
  issues of the squad's members and on unassigned ones; everyone else, agent or not, keeps to
  their own issues.
-->
<script lang="ts">
  import {
    Badge,
    Button,
    ConfirmDialog,
    Dialog,
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
  } from "$lib/components";

  import { seg } from "../api";
  import { optional } from "../format";
  import type { List, Squad } from "../types";
  import Actions from "../ui/Actions.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let squads = $state<Squad[]>([]);
  let editing = $state<Squad | null>(null);
  let form = $state({ name: "", description: "" });
  let open = $state(false);
  let saving = $state(false);
  let deleting = $state<Squad | null>(null);
  let confirmDelete = $state(false);

  async function load() {
    squads = (await ws.api.get<List<Squad>>(`/${seg(ws.projectId!)}/squads`)).docs;
  }

  // Reload when the project changes or another section changed something.
  $effect(() => {
    void ws.version;
    if (ws.projectId) ws.run(load);
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
        editing ? "Squad saved" : "Squad created"
      );
      open = false;
      await load();
    } catch {
      // Shown in the notice.
    } finally {
      saving = false;
    }
  }

  async function setScrumMaster(s: Squad, value: string) {
    await ws.run(() => ws.api.patch(`/squads/${seg(s.id)}`, { scrumMasterId: value || null }), "Scrum master changed");
    await load();
  }

  async function addMember(s: Squad, userId: string) {
    if (!userId) return;
    await ws.run(() => ws.api.post(`/squads/${seg(s.id)}/members`, { userId }), "Member added to the squad");
    await load();
  }

  async function removeMember(s: Squad, userId: string) {
    await ws.run(() => ws.api.del(`/squads/${seg(s.id)}/members/${seg(userId)}`), "Member removed from the squad");
    await load();
  }

  async function remove() {
    await ws.act(() => ws.api.del(`/squads/${seg(deleting!.id)}`), "Squad deleted");
    await load();
  }
</script>

<Panel title="Squads">
  {#snippet actions()}
    <Button size="sm" onclick={() => edit(null)}>New squad</Button>
  {/snippet}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Squad</TableHead>
        <TableHead>Scrum master</TableHead>
        <TableHead>Members</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each squads as s (s.id)}
        <TableRow>
          <TableCell>{s.name}</TableCell>
          <TableCell>
            <Select
              size="sm"
              aria-label={`Scrum master of ${s.name}`}
              value={s.scrumMasterId ?? ""}
              options={ws.memberOptions}
              placeholder="None"
              onchange={(e: Event) => setScrumMaster(s, (e.currentTarget as HTMLSelectElement).value)}
            />
          </TableCell>
          <TableCell>
            <div class="members">
              {#each s.memberIds as id (id)}
                <span class="member">
                  <Badge variant={ws.members.find((m) => m.userId === id)?.isAgent ? "info" : "default"}>{id}</Badge>
                  <button type="button" class="drop" aria-label={`Remove ${id} from ${s.name}`} onclick={() => removeMember(s, id)}>×</button>
                </span>
              {:else}
                <span class="none">—</span>
              {/each}
              <Select
                size="sm"
                class="add"
                aria-label={`Add a member to ${s.name}`}
                value=""
                options={ws.memberOptions.filter((o) => !s.memberIds.includes(o.value))}
                placeholder="Add…"
                onchange={(e: Event) => addMember(s, (e.currentTarget as HTMLSelectElement).value)}
              />
            </div>
          </TableCell>
          <TableCell>
            <Actions>
              <Button size="sm" variant="ghost" onclick={() => edit(s)}>Edit</Button>
              <Button
                size="sm"
                variant="ghost"
                onclick={() => {
                  deleting = s;
                  confirmDelete = true;
                }}>Delete</Button
              >
            </Actions>
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={4} text="No squads" />
      {/each}
    </TableBody>
  </Table>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New squad"} closeLabel={CLOSE}>
  <FormGrid columns={1}>
    <Field label="Name" required>
      <Input bind:value={form.name} maxlength={100} />
    </Field>
    <Field label="Description">
      <Textarea bind:value={form.description} rows={2} maxlength={2000} />
    </Field>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{CANCEL}</Button>
    <Button loading={saving} disabled={!form.name.trim()} onclick={save}>Save</Button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete ${deleting?.name ?? ""}?`}
  description="Its scrum master loses the reach over the squad's issues."
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  onConfirm={remove}
/>

<style>
  .members {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-wrap: wrap;
  }

  .member {
    display: inline-flex;
    align-items: center;
  }

  .drop {
    padding: 0 0.3rem;
    font: inherit;
    line-height: 1;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: none;
    cursor: pointer;
  }
  .drop:hover {
    color: rgb(var(--ta-danger));
  }

  .none {
    color: rgb(var(--ta-text-dim));
  }

  .members :global(.add) {
    width: auto;
    min-width: 8rem;
  }
</style>

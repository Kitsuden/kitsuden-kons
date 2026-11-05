<script lang="ts">
  import {
    Button,
    ConfirmDialog,
    Dialog,
    Field,
    Input,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components";

  import { seg } from "../api";
  import type { Label, List } from "../types";
  import Actions from "../ui/Actions.svelte";
  import Dot from "../ui/Dot.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let labels = $state<Label[]>([]);
  let editing = $state<Label | null>(null);
  let form = $state({ name: "", description: "", color: "#64748b" });
  let open = $state(false);
  let saving = $state(false);
  let deleting = $state<Label | null>(null);
  let confirmDelete = $state(false);

  async function load() {
    labels = (await ws.api.get<List<Label>>(`/${seg(ws.projectId!)}/labels`)).docs;
  }

  // Reload when the project changes or another section changed something.
  $effect(() => {
    void ws.version;
    if (ws.projectId) ws.run(load);
  });

  function edit(l: Label | null) {
    editing = l;
    form = { name: l?.name ?? "", description: l?.description ?? "", color: l?.color ?? "#64748b" };
    open = true;
  }

  async function save() {
    const body = { name: form.name.trim(), description: form.description.trim(), color: form.color };
    saving = true;
    try {
      await ws.act(
        () =>
          editing
            ? ws.api.patch(`/labels/${seg(editing.id)}`, body)
            : ws.api.post(`/${seg(ws.projectId!)}/labels`, body),
        editing ? "Label saved" : "Label created"
      );
      open = false;
      await load();
    } catch {
      // Shown in the notice.
    } finally {
      saving = false;
    }
  }

  async function remove() {
    await ws.act(() => ws.api.del(`/labels/${seg(deleting!.id)}`), "Label deleted");
    await load();
  }
</script>

<Panel title="Labels">
  {#snippet actions()}
    <Button size="sm" onclick={() => edit(null)}>New label</Button>
  {/snippet}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Label</TableHead>
        <TableHead>Description</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each labels as l (l.id)}
        <TableRow>
          <TableCell><Dot color={l.color} />{l.name}</TableCell>
          <TableCell>{l.description || "—"}</TableCell>
          <TableCell>
            <Actions>
              <Button size="sm" variant="ghost" onclick={() => edit(l)}>Edit</Button>
              <Button
                size="sm"
                variant="ghost"
                onclick={() => {
                  deleting = l;
                  confirmDelete = true;
                }}>Delete</Button
              >
            </Actions>
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={3} text="No labels" />
      {/each}
    </TableBody>
  </Table>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New label"} closeLabel={CLOSE}>
  <FormGrid>
    <Field label="Name" required>
      <Input bind:value={form.name} maxlength={100} />
    </Field>
    <Field label="Color">
      <Input type="color" bind:value={form.color} />
    </Field>
    <div class="wide">
      <Field label="Description">
        <Input bind:value={form.description} maxlength={1000} />
      </Field>
    </div>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{CANCEL}</Button>
    <Button loading={saving} disabled={!form.name.trim()} onclick={save}>Save</Button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete ${deleting?.name ?? ""}?`}
  description="It is removed from every issue."
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  onConfirm={remove}
/>

<!--
  Custom fields of the project's issues. The key and the type are fixed once created (values on
  issues depend on them); deleting a field strips its values from every issue.
-->
<script lang="ts">
  import {
    Badge,
    Button,
    Checkbox,
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
  } from "$lib/components";

  import { seg } from "../api";
  import { options, words } from "../format";
  import { FIELD_TYPES, type CustomField, type List } from "../types";
  import Actions from "../ui/Actions.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let fields = $state<CustomField[]>([]);
  let editing = $state<CustomField | null>(null);
  let form = $state({ key: "", name: "", type: "text", options: "", isRequired: false, sortOrder: "0" });
  let open = $state(false);
  let saving = $state(false);
  let deleting = $state<CustomField | null>(null);
  let confirmDelete = $state(false);

  const withOptions = $derived(form.type === "select" || form.type === "multi_select");
  const keyError = $derived(
    !editing && form.key && !/^[a-z][a-z0-9_]{0,49}$/.test(form.key) ? "Lower-case letters, digits and _, starting with a letter" : undefined
  );

  async function load() {
    fields = (await ws.api.get<List<CustomField>>(`/${seg(ws.projectId!)}/fields`)).docs;
  }

  // Reload when the project changes or another section changed something.
  $effect(() => {
    void ws.version;
    if (ws.projectId) ws.run(load);
  });

  function edit(f: CustomField | null) {
    editing = f;
    form = {
      key: f?.key ?? "",
      name: f?.name ?? "",
      type: f?.type ?? "text",
      options: (f?.options ?? []).join(", "),
      isRequired: !!f?.isRequired,
      sortOrder: String(f?.sortOrder ?? fields.length),
    };
    open = true;
  }

  async function save() {
    const opts = form.options.split(",").map((s) => s.trim()).filter(Boolean);
    const common = {
      name: form.name.trim(),
      isRequired: form.isRequired,
      sortOrder: Number(form.sortOrder) || 0,
      ...(withOptions ? { options: opts } : {}),
    };
    saving = true;
    try {
      await ws.act(
        () =>
          editing
            ? ws.api.patch(`/fields/${seg(editing.id)}`, common)
            : ws.api.post(`/${seg(ws.projectId!)}/fields`, { ...common, key: form.key, type: form.type }),
        editing ? "Field saved" : "Field created"
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
    await ws.act(() => ws.api.del(`/fields/${seg(deleting!.id)}`), "Field deleted");
    await load();
  }
</script>

<Panel title="Custom fields">
  {#snippet actions()}
    <Button size="sm" onclick={() => edit(null)}>New field</Button>
  {/snippet}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Field</TableHead>
        <TableHead>Key</TableHead>
        <TableHead>Type</TableHead>
        <TableHead>Options</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each fields as f (f.id)}
        <TableRow>
          <TableCell>
            {f.name}
            {#if f.isRequired}<Badge variant="warning">required</Badge>{/if}
          </TableCell>
          <TableCell><code>{f.key}</code></TableCell>
          <TableCell>{words(f.type)}</TableCell>
          <TableCell>{(f.options ?? []).join(", ") || "—"}</TableCell>
          <TableCell>
            <Actions>
              <Button size="sm" variant="ghost" onclick={() => edit(f)}>Edit</Button>
              <Button
                size="sm"
                variant="ghost"
                onclick={() => {
                  deleting = f;
                  confirmDelete = true;
                }}>Delete</Button
              >
            </Actions>
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={5} text="No custom fields" />
      {/each}
    </TableBody>
  </Table>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New field"} closeLabel={CLOSE} size="lg">
  <FormGrid>
    <Field label="Name" required>
      <Input bind:value={form.name} maxlength={100} />
    </Field>
    <Field label="Key" required error={keyError}>
      <Input bind:value={form.key} maxlength={50} disabled={!!editing} placeholder="customer_id" />
    </Field>
    <Field label="Type">
      <Select bind:value={form.type} options={options(FIELD_TYPES)} disabled={!!editing} />
    </Field>
    <Field label="Order">
      <Input type="number" min="0" max="10000" bind:value={form.sortOrder} />
    </Field>
    {#if withOptions}
      <div class="wide">
        <Field label="Options">
          <Input bind:value={form.options} placeholder="Small, Medium, Large" />
        </Field>
      </div>
    {/if}
    <div class="wide">
      <Checkbox bind:checked={form.isRequired} label="Required" />
    </div>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{CANCEL}</Button>
    <Button loading={saving} disabled={!form.name.trim() || (!editing && (!form.key || !!keyError))} onclick={save}>Save</Button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete ${deleting?.name ?? ""}?`}
  description="Its values are removed from every issue."
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  onConfirm={remove}
/>

<style>
  code {
    white-space: nowrap;
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
  }
</style>

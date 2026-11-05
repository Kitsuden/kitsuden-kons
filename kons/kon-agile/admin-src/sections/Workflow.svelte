<!--
  The project's states (board columns): order, group, default, the validations an issue must
  pass to enter, and deleting one by moving its issues to another.
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
    Textarea,
  } from "$lib/components";

  import { seg } from "../api";
  import { options, words } from "../format";
  import { STATE_GROUPS, type State, type StateGroup } from "../types";
  import Actions from "../ui/Actions.svelte";
  import Dot from "../ui/Dot.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  const blank = () => ({
    name: "",
    group: "unstarted" as StateGroup,
    color: "#64748b",
    description: "",
    isDefault: false,
    requireAssignee: false,
    requireEstimate: false,
    requireDescription: false,
  });

  let editing = $state<State | null>(null);
  let form = $state(blank());
  let open = $state(false);
  let saving = $state(false);
  let deleting = $state<State | null>(null);
  let moveTo = $state("");
  let confirmDelete = $state(false);

  function edit(s: State | null) {
    editing = s;
    form = s
      ? {
          name: s.name,
          group: s.group,
          color: s.color ?? "#64748b",
          description: s.description ?? "",
          isDefault: !!s.isDefault,
          requireAssignee: !!s.validations?.requireAssignee,
          requireEstimate: !!s.validations?.requireEstimate,
          requireDescription: !!s.validations?.requireDescription,
        }
      : blank();
    open = true;
  }

  async function save() {
    const body = {
      name: form.name.trim(),
      group: form.group,
      color: form.color,
      description: form.description.trim(),
      // Turning the default off is not a change the kon accepts: another state takes it.
      ...(form.isDefault ? { isDefault: true } : {}),
      validations: {
        requireAssignee: form.requireAssignee,
        requireEstimate: form.requireEstimate,
        requireDescription: form.requireDescription,
      },
    };
    saving = true;
    try {
      await ws.act(
        () =>
          editing
            ? ws.api.patch(`/states/${seg(editing.id)}`, body)
            : ws.api.post(`/${seg(ws.projectId!)}/states`, body),
        editing ? "State saved" : "State created"
      );
      open = false;
      await ws.reloadProject();
    } catch {
      // Shown in the notice.
    } finally {
      saving = false;
    }
  }

  async function move(index: number, by: -1 | 1) {
    const ids = ws.states.map((s) => s.id);
    const j = index + by;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    await ws.run(() => ws.api.put(`/${seg(ws.projectId!)}/states/order`, { stateIds: ids }));
    await ws.reloadProject();
  }

  async function remove() {
    const s = deleting!;
    await ws.act(() => ws.api.del(`/states/${seg(s.id)}`, { moveTo }), "State deleted");
    await ws.reloadProject();
  }

  const required = (s: State) =>
    [
      s.validations?.requireAssignee && "assignee",
      s.validations?.requireEstimate && "estimate",
      s.validations?.requireDescription && "description",
    ].filter(Boolean) as string[];
</script>

<Panel title="States">
  {#snippet actions()}
    <Button size="sm" onclick={() => edit(null)}>New state</Button>
  {/snippet}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Order</TableHead>
        <TableHead>State</TableHead>
        <TableHead>Group</TableHead>
        <TableHead>Requires</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each ws.states as s, i (s.id)}
        <TableRow>
          <TableCell>
            <div class="order">
              <Button size="sm" variant="ghost" ariaLabel={`Move ${s.name} up`} disabled={i === 0} onclick={() => move(i, -1)}>↑</Button>
              <Button size="sm" variant="ghost" ariaLabel={`Move ${s.name} down`} disabled={i === ws.states.length - 1} onclick={() => move(i, 1)}>↓</Button>
            </div>
          </TableCell>
          <TableCell>
            <Dot color={s.color} />{s.name}
            {#if s.isDefault}<Badge variant="purple">default</Badge>{/if}
          </TableCell>
          <TableCell><Badge>{words(s.group)}</Badge></TableCell>
          <TableCell>{required(s).join(", ") || "—"}</TableCell>
          <TableCell>
            <Actions>
              <Button size="sm" variant="ghost" onclick={() => edit(s)}>Edit</Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={s.isDefault}
                onclick={() => {
                  deleting = s;
                  moveTo = ws.states.find((o) => o.id !== s.id)?.id ?? "";
                  confirmDelete = true;
                }}>Delete</Button
              >
            </Actions>
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={5} text="No states" />
      {/each}
    </TableBody>
  </Table>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New state"} closeLabel={CLOSE} size="lg">
  <FormGrid>
    <Field label="Name" required>
      <Input bind:value={form.name} maxlength={100} />
    </Field>
    <Field label="Group">
      <Select bind:value={form.group} options={options(STATE_GROUPS)} />
    </Field>
    <Field label="Color">
      <Input type="color" bind:value={form.color} />
    </Field>
    <div class="check">
      <Checkbox bind:checked={form.isDefault} disabled={!!editing?.isDefault} label="Default for new issues" />
    </div>
    <div class="wide">
      <Field label="Description">
        <Textarea bind:value={form.description} rows={2} maxlength={1000} />
      </Field>
    </div>
    <fieldset class="wide">
      <legend>To enter, an issue needs</legend>
      <Checkbox bind:checked={form.requireAssignee} label="An assignee" />
      <Checkbox bind:checked={form.requireEstimate} label="An estimate" />
      <Checkbox bind:checked={form.requireDescription} label="A description" />
    </fieldset>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{CANCEL}</Button>
    <Button loading={saving} disabled={!form.name.trim()} onclick={save}>Save</Button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete ${deleting?.name ?? ""}?`}
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  onConfirm={remove}
>
  <Field label="Move its issues to">
    <Select bind:value={moveTo} options={ws.stateOptions.filter((o) => o.value !== deleting?.id)} />
  </Field>
</ConfirmDialog>

<style>
  .order {
    display: flex;
    gap: 0.125rem;
  }

  .check {
    padding-top: 1.6rem;
  }

  fieldset {
    display: flex;
    gap: 1.25rem;
    flex-wrap: wrap;
    margin: 0;
    padding: 0.75rem 1rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
  }

  legend {
    padding: 0 0.25rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
</style>

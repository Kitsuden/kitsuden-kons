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
    DataTable,
    Dialog,
    EmptyState,
    Field,
    Icon,
    Input,
    Select,
    Textarea,
    type DataColumn,
  } from "$lib/components";

  import { seg } from "../api";
  import { options, words } from "../format";
  import { STATE_GROUPS, type State, type StateGroup } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";
  import Swatch from "../ui/Swatch.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  const blank = () => ({
    name: "",
    group: "unstarted" as StateGroup,
    color: ws.neutralColor(),
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

  const required = (s: State) =>
    [
      s.validations?.requireAssignee && "assignee",
      s.validations?.requireEstimate && "estimate",
      s.validations?.requireDescription && "description",
    ].filter(Boolean) as string[];

  // Not sortable: the order of the rows is the order of the board's columns.
  const columns: DataColumn<State>[] = [
    { key: "order", header: "Order", width: "6rem", value: (s) => s.sequence },
    { key: "name", header: "State", hideable: false },
    { key: "group", header: "Group", value: (s) => words(s.group) },
    { key: "requires", header: "Requires", value: (s) => required(s).join(", ") || "—" },
  ];

  function edit(s: State | null) {
    editing = s;
    form = s
      ? {
          name: s.name,
          group: s.group,
          color: s.color ?? ws.neutralColor(),
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
      color: form.color || undefined,
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
        editing ? "State saved" : "State created",
        editing ? "Could not save the state" : "Could not create the state"
      );
      open = false;
      await ws.reloadProject();
    } catch {
      // Shown in the toast.
    } finally {
      saving = false;
    }
  }

  async function move(s: State, by: -1 | 1) {
    const ids = ws.states.map((o) => o.id);
    const index = ids.indexOf(s.id);
    const j = index + by;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    await ws.run(() => ws.api.put(`/${seg(ws.projectId!)}/states/order`, { stateIds: ids }), undefined, "Could not reorder the states");
    await ws.reloadProject();
  }

  async function remove() {
    const s = deleting!;
    await ws.act(() => ws.api.del(`/states/${seg(s.id)}`, { moveTo }), "State deleted", "Could not delete the state");
    await ws.reloadProject();
  }
</script>

<Panel title="States">
  {#snippet status()}
    <Badge>{ws.states.length} {ws.states.length === 1 ? "state" : "states"}</Badge>
  {/snippet}
  {#snippet actions()}
    <Button onclick={() => edit(null)}>New state</Button>
  {/snippet}
  <DataTable caption="States of the project, in board order" rows={ws.states} {columns} rowKey="id" rowLabel={(s) => s.name}>
    {#snippet cell(s, col)}
      {#if col.key === "order"}
        <span class="order">
          <Button size="icon" variant="ghost" ariaLabel={`Move ${s.name} up`} disabled={ws.states[0]?.id === s.id} onclick={() => move(s, -1)}>
            <Icon name="chevron-up" />
          </Button>
          <Button size="icon" variant="ghost" ariaLabel={`Move ${s.name} down`} disabled={ws.states.at(-1)?.id === s.id} onclick={() => move(s, 1)}>
            <Icon name="chevron-down" />
          </Button>
        </span>
      {:else if col.key === "name"}
        <span class="name">
          <Swatch color={s.color} name={s.name} />
          {#if s.isDefault}<Badge variant="purple">Default</Badge>{/if}
        </span>
      {:else if col.key === "group"}
        <Badge>{words(s.group)}</Badge>
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
            label: "Delete",
            danger: true,
            separated: true,
            disabled: s.isDefault,
            onSelect: () => {
              deleting = s;
              moveTo = ws.states.find((o) => o.id !== s.id)?.id ?? "";
              confirmDelete = true;
            },
          },
        ]}
      />
    {/snippet}
    {#snippet empty()}
      <EmptyState size="sm" level={null} title="No states yet" description="A board needs at least one." actionLabel="New state" onAction={() => edit(null)} />
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New state"} closeLabel={CLOSE} size="lg">
  <FormGrid label={editing ? `Edit ${editing.name}` : "New state"} onsubmit={() => form.name.trim() && !saving && save()}>
    <Field label="Name" required>
      <Input bind:value={form.name} maxlength={100} />
    </Field>
    <Field label="Group">
      <Select bind:value={form.group} options={options(STATE_GROUPS)} />
    </Field>
    <Field label="Color">
      <Input type="color" bind:value={form.color} />
    </Field>
    <div>
      <Checkbox bind:checked={form.isDefault} disabled={!!editing?.isDefault} label="Default for new issues" />
    </div>
    <Field label="Description" class="wide">
      <Textarea bind:value={form.description} rows={2} maxlength={1000} />
    </Field>
    <div class="checks wide" role="group" aria-label="To enter, an issue needs">
      <Checkbox bind:checked={form.requireAssignee} label="Requires an assignee" />
      <Checkbox bind:checked={form.requireEstimate} label="Requires an estimate" />
      <Checkbox bind:checked={form.requireDescription} label="Requires a description" />
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
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="danger"
  onConfirm={remove}
>
  <Field label="Move its issues to">
    <Select bind:value={moveTo} options={ws.stateOptions.filter((o) => o.value !== deleting?.id)} />
  </Field>
</ConfirmDialog>

<style>
  .order {
    display: inline-flex;
    gap: 0.125rem;
  }

  .name {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .checks {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.25rem;
  }
</style>

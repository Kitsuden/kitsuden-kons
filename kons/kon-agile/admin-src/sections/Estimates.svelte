<!--
  Estimate scales. Points are written as a list: "1, 2, 3, 5, 8", or "1=XS, 2=S, 3=M" when the
  label is not the number.
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
  import { ESTIMATE_TYPES, type Estimate, type EstimatePoint, type List } from "../types";
  import Actions from "../ui/Actions.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();

  let estimates = $state<Estimate[]>([]);
  let editing = $state<Estimate | null>(null);
  let form = $state({ name: "", type: "fibonacci", points: "", isDefault: false });
  let open = $state(false);
  let saving = $state(false);
  let deleting = $state<Estimate | null>(null);
  let confirmDelete = $state(false);

  async function load() {
    estimates = (await ws.api.get<List<Estimate>>(`/${seg(ws.projectId!)}/estimates`)).docs;
  }

  // Reload when the project changes or another section changed something.
  $effect(() => {
    void ws.version;
    if (ws.projectId) ws.run(load);
  });

  const showPoints = (points: EstimatePoint[] | null | undefined) =>
    (points ?? []).map((p) => (String(p.value) === p.label ? p.label : `${p.value}=${p.label}`)).join(", ");

  /** "1, 2=S" → points; null when a value is not a number. */
  function parsePoints(text: string): EstimatePoint[] | null {
    const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
    const points: EstimatePoint[] = [];
    for (const part of parts) {
      const [v, label] = part.split("=").map((s) => s.trim());
      const value = Number(v);
      if (!v || Number.isNaN(value)) return null;
      points.push({ value, label: label || v });
    }
    return points;
  }

  const pointsError = $derived(form.points.trim() && parsePoints(form.points) === null ? "Each point is a number, or number=label" : undefined);

  function edit(e: Estimate | null) {
    editing = e;
    form = { name: e?.name ?? "", type: e?.type ?? "fibonacci", points: showPoints(e?.customPoints), isDefault: !!e?.isDefault };
    open = true;
  }

  async function save() {
    const points = parsePoints(form.points) ?? [];
    const body = {
      name: form.name.trim(),
      type: form.type,
      customPoints: points,
      ...(form.isDefault ? { isDefault: true } : {}),
    };
    saving = true;
    try {
      await ws.act(
        () =>
          editing
            ? ws.api.patch(`/estimates/${seg(editing.id)}`, body)
            : ws.api.post(`/${seg(ws.projectId!)}/estimates`, body),
        editing ? "Estimate saved" : "Estimate created"
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
    await ws.act(() => ws.api.del(`/estimates/${seg(deleting!.id)}`), "Estimate deleted");
    await load();
  }
</script>

<Panel title="Estimates">
  {#snippet actions()}
    <Button size="sm" onclick={() => edit(null)}>New estimate</Button>
  {/snippet}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Estimate</TableHead>
        <TableHead>Type</TableHead>
        <TableHead>Points</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each estimates as e (e.id)}
        <TableRow>
          <TableCell>
            {e.name}
            {#if e.isDefault}<Badge variant="purple">default</Badge>{/if}
          </TableCell>
          <TableCell>{words(e.type)}</TableCell>
          <TableCell>{showPoints(e.customPoints) || "—"}</TableCell>
          <TableCell>
            <Actions>
              <Button size="sm" variant="ghost" onclick={() => edit(e)}>Edit</Button>
              <Button
                size="sm"
                variant="ghost"
                onclick={() => {
                  deleting = e;
                  confirmDelete = true;
                }}>Delete</Button
              >
            </Actions>
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={4} text="No estimates" />
      {/each}
    </TableBody>
  </Table>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New estimate"} closeLabel={CLOSE}>
  <FormGrid>
    <Field label="Name" required>
      <Input bind:value={form.name} maxlength={100} />
    </Field>
    <Field label="Type">
      <Select bind:value={form.type} options={options(ESTIMATE_TYPES)} />
    </Field>
    <div class="wide">
      <Field label="Points" error={pointsError}>
        <Input bind:value={form.points} placeholder="1, 2, 3, 5, 8" />
      </Field>
    </div>
    <div class="wide">
      <Checkbox bind:checked={form.isDefault} label="Default for the project" />
    </div>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{CANCEL}</Button>
    <Button loading={saving} disabled={!form.name.trim() || !!pointsError} onclick={save}>Save</Button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete ${deleting?.name ?? ""}?`}
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  onConfirm={remove}
/>

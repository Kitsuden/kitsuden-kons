<!-- Who reaches how much of the CRM: the grants, and a form to set one. -->
<script lang="ts">
  import {
    Badge,
    Button,
    Checkbox,
    ConfirmDialog,
    DataTable,
    EmptyState,
    Field,
    Input,
    Select,
    type DataColumn,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { seg, type Api } from "../api";
  import type { Grant } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { createLoad } from "../ui/load.svelte";
  import { failed, toast } from "../ui/notify";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";

  const { api }: { api: Api } = $props();

  let grants = $state<Grant[]>([]);
  let saving = $state(false);
  let revoking = $state<Grant | null>(null);
  let confirmRevoke = $state(false);
  let form = $state({
    subjectType: "user",
    subjectId: "",
    records: "all",
    money: true,
    sensitive: false,
    notes: true,
    sensitiveUntil: "",
    reason: "",
  });

  const yes = (v: unknown) => (v ? "Yes" : "No");
  /** No `notes` on the grant: people read notes and agents do not. */
  const notes = (g: Grant) => (g.notes === null || g.notes === undefined ? (g.subjectType === "agent" ? "No" : "Yes") : yes(g.notes));
  const subject = (g: Grant) => `${g.subjectType === "agent" ? "Agent" : "Person"} ${g.subjectId}`;

  const columns: DataColumn<Grant>[] = [
    { key: "subject", header: "Subject", sortable: true, value: subject, hideable: false },
    { key: "records", header: "Records", sortable: true, value: (g) => (g.records === "all" ? "All" : "Assigned") },
    { key: "money", header: "Amounts", sortable: true, value: (g) => yes(g.money) },
    { key: "sensitive", header: "Sensitive", sortable: true, value: (g) => yes(g.sensitive) },
    { key: "notes", header: "Notes", sortable: true, value: notes },
    { key: "until", header: "Until", sortable: true, value: (g) => (g.sensitiveUntil ? String(g.sensitiveUntil).slice(0, 10) : "—") },
    { key: "reason", header: "Why", value: (g) => g.reason },
  ];

  const data = createLoad(async () => {
    grants = (await api.get<{ data?: Grant[] }>("access")).data ?? [];
  });

  $effect(() => {
    untrack(data.load);
  });

  async function grant() {
    const subjectId = form.subjectId.trim();
    if (!subjectId) return toast.error("Write the user or agent id");
    const until = form.sensitiveUntil;
    saving = true;
    try {
      await api.put(`access/${form.subjectType}/${seg(subjectId)}`, {
        records: form.records,
        money: form.money,
        sensitive: form.sensitive,
        notes: form.notes,
        sensitiveUntil: until ? new Date(`${until}T23:59:59Z`).toISOString() : null,
        reason: form.reason.trim(),
      });
      toast.success("Access saved");
      await data.load();
    } catch (e) {
      failed("Could not save the access", e);
    } finally {
      saving = false;
    }
  }

  async function revoke() {
    const g = revoking!;
    try {
      await api.del(`access/${g.subjectType}/${seg(g.subjectId)}`);
    } catch (e) {
      failed("Could not put the access back to default", e);
      throw e;
    }
    toast.success(`${subject(g)} is back to the default access`);
    await data.load();
  }
</script>

<Panel title="Who reaches how much" description="A person or an agent without a grant has the default access of its role.">
  {#snippet status()}
    {#if data.ready}<Badge>{grants.length} {grants.length === 1 ? "grant" : "grants"}</Badge>{/if}
  {/snippet}
  <DataTable
    caption="Access grants"
    rows={grants}
    {columns}
    rowKey={(g) => `${g.subjectType}/${g.subjectId}`}
    rowLabel={subject}
    loading={data.loading}
    error={data.error}
    onRetry={data.load}
  >
    {#snippet rowActions(g)}
      <RowMenu
        label={`Actions: ${subject(g)}`}
        items={[
          {
            label: "Back to default",
            danger: true,
            onSelect: () => {
              revoking = g;
              confirmRevoke = true;
            },
          },
        ]}
      />
    {/snippet}
    {#snippet empty()}
      <EmptyState
        size="sm"
        level={null}
        title="No grants yet"
        description="Everyone has the default access of their role. Grant one with the form below."
      />
    {/snippet}
  </DataTable>

  <h3 class="sub">Grant access</h3>
  <FormGrid label="Grant access" onsubmit={grant}>
    <Field label="Kind of subject">
      <Select
        bind:value={form.subjectType}
        options={[
          { value: "user", label: "Person" },
          { value: "agent", label: "Agent" },
        ]}
      />
    </Field>
    <Field label="User or agent id" required>
      <Input bind:value={form.subjectId} />
    </Field>
    <Field label="Records">
      <Select
        bind:value={form.records}
        options={[
          { value: "all", label: "All records" },
          { value: "assigned", label: "Only assigned" },
        ]}
      />
    </Field>
    <Field label="Sensitive access until">
      <Input type="date" bind:value={form.sensitiveUntil} />
    </Field>
    <Field label="Why" class="wide">
      <Input bind:value={form.reason} />
    </Field>
    <div class="checks wide" role="group" aria-label="What the grant reaches">
      <Checkbox bind:checked={form.money} label="Amounts" />
      <Checkbox bind:checked={form.sensitive} label="Sensitive" />
      <Checkbox bind:checked={form.notes} label="Notes" />
    </div>
    {#snippet actions()}
      <Button type="submit" loading={saving}>Save access</Button>
    {/snippet}
  </FormGrid>
</Panel>

<ConfirmDialog
  bind:open={confirmRevoke}
  title={`Put ${revoking ? subject(revoking) : ""} back to the default access?`}
  description="The grant is removed. What it reached beyond the default is no longer reachable."
  confirmLabel="Back to default"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="danger"
  onConfirm={revoke}
/>

<style>
  .sub {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    font-weight: 600;
  }

  .checks {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.25rem;
  }
</style>

<!--
  Who is on koe: a Kitsuden account with a koe role. Agents answer their teams' conversations, supervisors
  see and reassign all, admins also connect channels. Removing someone sends their open conversations back
  to the queue.
-->
<script lang="ts">
  import { Badge, Button, ConfirmDialog, DataTable, Dialog, EmptyState, Field, Input, Select, Switch, type DataColumn } from "$lib/components";

  import { seg, type Api } from "../api";
  import type { Member, MemberRole, Team } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import type { Load } from "../ui/load.svelte";
  import { failed, toast } from "../ui/notify";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";

  const {
    api,
    members,
    teams,
    load,
    reloadTeams,
  }: { api: Api; members: Member[]; teams: Team[]; load: Load; reloadTeams: () => Promise<void> } = $props();

  const ROLES: Record<MemberRole, string> = { agent: "Agent", supervisor: "Supervisor", admin: "Admin" };

  const blank = () => ({ userId: "", displayName: "", role: "agent" as MemberRole, maxConcurrent: "10", available: true });
  let form = $state(blank());
  let editing = $state<Member | null>(null);
  let open = $state(false);
  let saving = $state(false);
  let errors = $state<Record<string, string>>({});
  let removing = $state<Member | null>(null);
  let confirmRemove = $state(false);

  const teamNames = (m: Member) =>
    m.teamIds
      .map((id) => teams.find((t) => t.id === id)?.name)
      .filter(Boolean)
      .join(", ");

  const seen = (iso: string | null) => {
    if (!iso) return "Never";
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 2) return "Now";
    if (mins < 60) return `${mins} min ago`;
    if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
    return new Date(iso).toLocaleDateString();
  };

  const columns: DataColumn<Member>[] = [
    { key: "displayName", header: "Name", sortable: true, hideable: false },
    { key: "role", header: "Role", sortable: true, filter: "select", value: (m) => ROLES[m.role] },
    { key: "available", header: "Availability", sortable: true, value: (m) => (m.available ? "Available" : "Away") },
    { key: "maxConcurrent", header: "At once", sortable: true, align: "right" },
    { key: "teams", header: "Teams", value: teamNames },
    { key: "lastSeenAt", header: "In the inbox", sortable: true, value: (m) => seen(m.lastSeenAt) },
  ];

  function openNew() {
    editing = null;
    form = blank();
    errors = {};
    open = true;
  }

  function openEdit(m: Member) {
    editing = m;
    form = { userId: m.userId, displayName: m.displayName, role: m.role, maxConcurrent: String(m.maxConcurrent), available: m.available };
    errors = {};
    open = true;
  }

  async function save() {
    const e: Record<string, string> = {};
    if (!form.userId.trim()) e.userId = "The Kitsuden account id";
    if (!form.displayName.trim()) e.displayName = "Required";
    const max = Number(form.maxConcurrent);
    if (!Number.isInteger(max) || max < 0 || max > 500) e.maxConcurrent = "From 0 to 500";
    errors = e;
    if (Object.keys(e).length) return;
    saving = true;
    try {
      await api.put(`members/${seg(form.userId.trim())}`, { role: form.role, displayName: form.displayName.trim(), maxConcurrent: max, available: form.available });
      toast.success(editing ? `${form.displayName.trim()} saved` : `${form.displayName.trim()} added to koe`);
      open = false;
      await load.load();
    } catch (err) {
      failed(editing ? "Could not save the member" : "Could not add the member", err);
    } finally {
      saving = false;
    }
  }

  async function remove() {
    const m = removing!;
    try {
      await api.del(`members/${seg(m.userId)}`);
    } catch (e) {
      failed("Could not remove the member", e);
      throw e;
    }
    toast.success(`${m.displayName} removed from koe`);
    await Promise.all([load.load(), reloadTeams()]);
  }
</script>

<Panel title="Members" description="Kitsuden accounts that work in koe, with their role and how many conversations each takes at once.">
  {#snippet status()}
    {#if load.ready}<Badge>{members.length} {members.length === 1 ? "member" : "members"}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Button size="sm" onclick={openNew}>Add member</Button>
  {/snippet}
  <DataTable caption="Members" rows={members} {columns} rowKey="userId" rowLabel={(m) => m.displayName} loading={load.loading} error={load.error} onRetry={load.load}>
    {#snippet cell(m, col)}
      {#if col.key === "displayName"}
        <span class="name">{m.displayName}</span> <span class="mono">{m.userId}</span>
      {:else if col.key === "role"}
        <Badge variant={m.role === "admin" ? "accent" : m.role === "supervisor" ? "info" : "default"}>{ROLES[m.role]}</Badge>
      {:else if col.key === "available"}
        <Badge variant={m.available ? "success" : "default"} dot>{m.available ? "Available" : "Away"}</Badge>
      {:else if col.key === "maxConcurrent"}
        {m.maxConcurrent}
      {:else}
        {col.value?.(m)}
      {/if}
    {/snippet}
    {#snippet rowActions(m)}
      <RowMenu
        label={`Actions: ${m.displayName}`}
        items={[
          { label: "Edit", onSelect: () => openEdit(m) },
          {
            label: "Remove from koe",
            danger: true,
            separated: true,
            onSelect: () => {
              removing = m;
              confirmRemove = true;
            },
          },
        ]}
      />
    {/snippet}
    {#snippet empty()}
      <EmptyState size="sm" level={null} title="Nobody on koe yet" description="Kitsuden admins are koe admins. Add the people who answer." actionLabel="Add member" onAction={openNew} />
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.displayName}` : "Add a member"} size="lg" closeLabel={CLOSE}>
  <FormGrid label={editing ? "Edit member" : "Add a member"} onsubmit={save}>
    <Field label="Kitsuden account id" required error={errors.userId}>
      <Input bind:value={form.userId} disabled={!!editing} autocomplete="off" spellcheck="false" />
    </Field>
    <Field label="Name in the inbox" required error={errors.displayName}>
      <Input bind:value={form.displayName} autocomplete="off" />
    </Field>
    <Field label="Role">
      <Select bind:value={form.role} options={(Object.keys(ROLES) as MemberRole[]).map((r) => ({ value: r, label: ROLES[r] }))} />
    </Field>
    <Field label="Conversations at once" error={errors.maxConcurrent}>
      <Input bind:value={form.maxConcurrent} inputmode="numeric" />
    </Field>
    <div class="wide">
      <Switch bind:checked={form.available} label="Available for automatic assignment" />
    </div>
    {#snippet actions()}
      <Button variant="ghost" onclick={() => (open = false)}>{CANCEL}</Button>
      <Button type="submit" loading={saving}>{editing ? "Save" : "Add"}</Button>
    {/snippet}
  </FormGrid>
</Dialog>

<ConfirmDialog
  bind:open={confirmRemove}
  title={`Remove ${removing?.displayName ?? ""} from koe?`}
  description="Their open conversations go back to the queue."
  confirmLabel="Remove"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="danger"
  onConfirm={remove}
/>

<style>
  .name {
    font-weight: 600;
  }

  .mono {
    margin-left: 0.25rem;
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
</style>

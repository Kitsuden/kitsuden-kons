<!--
  Teams: support, sales and collections, each with its hours, how conversations are handed out, its SLAs and
  its people. A conversation waiting in a team's queue is assigned to one of its available members.
-->
<script lang="ts">
  import { Badge, Button, Checkbox, ConfirmDialog, DataTable, Dialog, EmptyState, Field, Input, Select, type DataColumn } from "$lib/components";

  import { seg, type Api } from "../api";
  import type { Member, Team } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import type { Load } from "../ui/load.svelte";
  import { failed, toast } from "../ui/notify";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";

  const {
    api,
    teams,
    members,
    load,
    reloadMembers,
  }: { api: Api; teams: Team[]; members: Member[]; load: Load; reloadMembers: () => Promise<void> } = $props();

  const PURPOSES = { support: "Support", sales: "Sales", collections: "Collections" } as const;
  const ASSIGNMENT = { round_robin: "In turns", load: "Least busy", manual: "By hand" } as const;
  const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  const DAY_LABEL: Record<(typeof DAYS)[number], string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

  const blank = () => ({
    slug: "",
    name: "",
    purpose: "support" as Team["purpose"],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    assignment: "round_robin" as Team["assignment"],
    slaFirst: "",
    slaResolution: "",
    hours: Object.fromEntries(DAYS.map((d) => [d, ""])) as Record<(typeof DAYS)[number], string>,
    memberIds: [] as string[],
  });

  let form = $state(blank());
  let editing = $state<Team | null>(null);
  let open = $state(false);
  let saving = $state(false);
  let errors = $state<Record<string, string>>({});
  let deleting = $state<Team | null>(null);
  let confirmDelete = $state(false);

  const minutes = (s: number | null) => (s ? (s % 3600 === 0 ? `${s / 3600} h` : `${Math.round(s / 60)} min`) : "None");

  const columns: DataColumn<Team>[] = [
    { key: "name", header: "Team", sortable: true, hideable: false },
    { key: "purpose", header: "For", sortable: true, filter: "select", value: (t) => PURPOSES[t.purpose] },
    { key: "assignment", header: "Hand out", value: (t) => ASSIGNMENT[t.assignment] },
    { key: "slaFirstResponseS", header: "First answer", sortable: true, value: (t) => minutes(t.slaFirstResponseS) },
    { key: "slaResolutionS", header: "Resolve within", sortable: true, value: (t) => minutes(t.slaResolutionS) },
    { key: "members", header: "People", align: "right", value: (t) => t.memberIds.length },
  ];

  const hoursText = (ranges: Array<[string, string]> | undefined) => (ranges ?? []).map(([a, b]) => `${a}-${b}`).join(", ");

  function openNew() {
    editing = null;
    form = blank();
    errors = {};
    open = true;
  }

  function openEdit(t: Team) {
    editing = t;
    form = {
      slug: t.slug,
      name: t.name,
      purpose: t.purpose,
      timezone: t.timezone,
      assignment: t.assignment,
      slaFirst: t.slaFirstResponseS ? String(Math.round(t.slaFirstResponseS / 60)) : "",
      slaResolution: t.slaResolutionS ? String(Math.round(t.slaResolutionS / 3600)) : "",
      hours: Object.fromEntries(DAYS.map((d) => [d, hoursText(t.businessHours?.[d])])) as Record<(typeof DAYS)[number], string>,
      memberIds: [...t.memberIds],
    };
    errors = {};
    open = true;
  }

  /** "09:00-13:00, 14:00-18:00" → [["09:00","13:00"],["14:00","18:00"]], or null when it does not read. */
  function parseHours(s: string): Array<[string, string]> | null {
    const out: Array<[string, string]> = [];
    for (const part of s.split(",").map((x) => x.trim()).filter(Boolean)) {
      const m = /^(\d\d:\d\d)\s*-\s*(\d\d:\d\d)$/.exec(part);
      if (!m) return null;
      out.push([m[1]!, m[2]!]);
    }
    return out.length <= 4 ? out : null;
  }

  function toggleMember(id: string, on: boolean) {
    form.memberIds = on ? [...new Set([...form.memberIds, id])] : form.memberIds.filter((x) => x !== id);
  }

  async function save() {
    const e: Record<string, string> = {};
    if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(form.slug)) e.slug = "Lowercase letters, digits and dashes";
    if (!form.name.trim()) e.name = "Required";
    const first = form.slaFirst.trim() ? Number(form.slaFirst) : null;
    const resolution = form.slaResolution.trim() ? Number(form.slaResolution) : null;
    if (first !== null && (!Number.isInteger(first) || first < 1)) e.slaFirst = "Whole minutes";
    if (resolution !== null && (!Number.isInteger(resolution) || resolution < 1)) e.slaResolution = "Whole hours";
    const businessHours: Record<string, Array<[string, string]>> = {};
    for (const d of DAYS) {
      const parsed = parseHours(form.hours[d]);
      if (!parsed) e[`hours.${d}`] = "Like 09:00-18:00";
      else if (parsed.length) businessHours[d] = parsed;
    }
    errors = e;
    if (Object.keys(e).length) return;

    const body = {
      name: form.name.trim(),
      purpose: form.purpose,
      timezone: form.timezone.trim() || "UTC",
      assignment: form.assignment,
      businessHours,
      slaFirstResponseS: first ? first * 60 : null,
      slaResolutionS: resolution ? resolution * 3600 : null,
    };
    saving = true;
    try {
      let id = editing?.id;
      if (editing) await api.patch(`teams/${seg(editing.id)}`, body);
      else id = (await api.post<{ data: Team }>("teams", { ...body, slug: form.slug })).data.id;
      await api.put(`teams/${seg(id!)}/members`, { userIds: form.memberIds });
      toast.success(`${body.name} saved`);
      open = false;
      await Promise.all([load.load(), reloadMembers()]);
    } catch (err) {
      failed("Could not save the team", err);
    } finally {
      saving = false;
    }
  }

  async function remove() {
    const t = deleting!;
    try {
      await api.del(`teams/${seg(t.id)}`);
    } catch (e) {
      failed("Could not delete the team", e);
      throw e;
    }
    toast.success(`${t.name} deleted`);
    await Promise.all([load.load(), reloadMembers()]);
  }
</script>

<Panel title="Teams" description="Who answers what: each team has its queue, hours, SLAs and people.">
  {#snippet status()}
    {#if load.ready}<Badge>{teams.length} {teams.length === 1 ? "team" : "teams"}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Button size="sm" onclick={openNew}>New team</Button>
  {/snippet}
  <DataTable caption="Teams" rows={teams} {columns} rowKey="id" rowLabel={(t) => t.name} loading={load.loading} error={load.error} onRetry={load.load}>
    {#snippet cell(t, col)}
      {#if col.key === "name"}
        <span class="name">{t.name}</span> <span class="mono">{t.slug}</span>
      {:else if col.key === "purpose"}
        <Badge variant={t.purpose === "sales" ? "success" : t.purpose === "collections" ? "warning" : "info"}>{PURPOSES[t.purpose]}</Badge>
      {:else}
        {col.value?.(t)}
      {/if}
    {/snippet}
    {#snippet rowActions(t)}
      <RowMenu
        label={`Actions: ${t.name}`}
        items={[
          { label: "Edit", onSelect: () => openEdit(t) },
          {
            label: "Delete",
            danger: true,
            separated: true,
            onSelect: () => {
              deleting = t;
              confirmDelete = true;
            },
          },
        ]}
      />
    {/snippet}
    {#snippet empty()}
      <EmptyState size="sm" level={null} title="No teams yet" description="Without teams, waiting conversations go to supervisors." actionLabel="New team" onAction={openNew} />
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open title={editing ? `Edit ${editing.name}` : "New team"} size="xl" closeLabel={CLOSE}>
  <FormGrid label={editing ? "Edit team" : "New team"} onsubmit={save}>
    <Field label="Name" required error={errors.name}>
      <Input bind:value={form.name} autocomplete="off" />
    </Field>
    <Field label="Slug" required error={errors.slug}>
      <Input bind:value={form.slug} disabled={!!editing} autocomplete="off" spellcheck="false" placeholder="support" />
    </Field>
    <Field label="For">
      <Select bind:value={form.purpose} options={Object.entries(PURPOSES).map(([value, label]) => ({ value, label }))} />
    </Field>
    <Field label="Hand out conversations">
      <Select bind:value={form.assignment} options={Object.entries(ASSIGNMENT).map(([value, label]) => ({ value, label }))} />
    </Field>
    <Field label="Time zone">
      <Input bind:value={form.timezone} autocomplete="off" spellcheck="false" placeholder="America/Lima" />
    </Field>
    <Field label="First answer within (minutes)" error={errors.slaFirst}>
      <Input bind:value={form.slaFirst} inputmode="numeric" placeholder="No SLA" />
    </Field>
    <Field label="Resolve within (hours)" error={errors.slaResolution}>
      <Input bind:value={form.slaResolution} inputmode="numeric" placeholder="No SLA" />
    </Field>
    <fieldset class="wide group">
      <legend>Business hours (empty: closed)</legend>
      <div class="days">
        {#each DAYS as d (d)}
          <Field label={DAY_LABEL[d]} error={errors[`hours.${d}`]}>
            <Input bind:value={form.hours[d]} placeholder="09:00-18:00" spellcheck="false" />
          </Field>
        {/each}
      </div>
    </fieldset>
    <fieldset class="wide group">
      <legend>People</legend>
      {#if members.length}
        <div class="people">
          {#each members as m (m.userId)}
            <Checkbox checked={form.memberIds.includes(m.userId)} label={m.displayName} onchange={(e: Event) => toggleMember(m.userId, (e.currentTarget as HTMLInputElement).checked)} />
          {/each}
        </div>
      {:else}
        <p class="none">Add members first.</p>
      {/if}
    </fieldset>
    {#snippet actions()}
      <Button variant="ghost" onclick={() => (open = false)}>{CANCEL}</Button>
      <Button type="submit" loading={saving}>{editing ? "Save" : "Create team"}</Button>
    {/snippet}
  </FormGrid>
</Dialog>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete ${deleting?.name ?? ""}?`}
  description="Its conversations stay, without a team."
  confirmLabel="Delete"
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

  .group {
    margin: 0;
    padding: 0.75rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
  }

  .group legend {
    padding: 0 0.25rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: rgb(var(--ta-text-dim));
  }

  .days {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
    gap: 0.5rem;
  }

  .people {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.25rem;
  }

  .none {
    margin: 0;
    color: rgb(var(--ta-text-dim));
  }
</style>

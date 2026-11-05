<!--
  The project itself: details, automation (estimate type, week, auto-assign by state,
  auto-archive, auto-close of cycles) and archiving.
-->
<script lang="ts">
  import {
    Button,
    Checkbox,
    ConfirmDialog,
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
  import { optional, options } from "../format";
  import { ESTIMATE_TYPES, type ProjectConfig } from "../types";
  import Dot from "../ui/Dot.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // Copies of the project for the forms, refreshed whenever the project is reloaded.
  let details = $state({ name: "", description: "", emoji: "", color: "#6366f1", leadId: "", defaultAssigneeId: "" });
  let auto = $state({
    estimateType: "",
    timezone: "",
    weekStartDay: "1",
    autoArchiveDays: "",
    autoCloseCycles: false,
    autoAssign: {} as Record<string, string>,
  });
  let savingDetails = $state(false);
  let savingAuto = $state(false);
  let confirmArchive = $state(false);

  $effect(() => {
    const p = ws.project;
    if (!p) return;
    details = {
      name: p.name,
      description: p.description ?? "",
      emoji: p.emoji ?? "",
      color: p.color ?? "#6366f1",
      leadId: p.leadId ?? "",
      defaultAssigneeId: p.defaultAssigneeId ?? "",
    };
    const c = p.config ?? {};
    auto = {
      estimateType: c.estimateType ?? "",
      timezone: c.timezone ?? "",
      weekStartDay: String(c.weekStartDay ?? 1),
      autoArchiveDays: c.autoArchiveDays ? String(c.autoArchiveDays) : "",
      autoCloseCycles: c.autoCloseCycles ?? false,
      autoAssign: { ...(c.autoAssign ?? {}) },
    };
  });

  const path = () => `/projects/${seg(ws.projectId!)}`;

  async function saveDetails() {
    savingDetails = true;
    await ws.run(
      () =>
        ws.api.patch(path(), {
          name: details.name.trim(),
          description: optional(details.description) ?? "",
          emoji: optional(details.emoji) ?? "",
          color: details.color,
          // The kon's schema takes an id or nothing for these: an empty choice is left out.
          leadId: optional(details.leadId),
          defaultAssigneeId: optional(details.defaultAssigneeId),
        }),
      "Project saved"
    );
    savingDetails = false;
    await ws.loadProjects();
  }

  async function saveAutomation() {
    // A number input bound with bind:value holds a number, or null when empty.
    const days = String(auto.autoArchiveDays ?? "").trim();
    if (days && !(Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 3650)) {
      ws.say("error", "Auto-archive takes whole days from 1 to 3650");
      return;
    }
    const autoAssign = Object.fromEntries(Object.entries(auto.autoAssign).filter(([, v]) => v));
    const config: ProjectConfig = {
      ...(auto.estimateType ? { estimateType: auto.estimateType } : {}),
      ...(auto.timezone.trim() ? { timezone: auto.timezone.trim() } : {}),
      weekStartDay: Number(auto.weekStartDay),
      autoAssign,
      autoArchiveDays: days ? Number(days) : null,
      autoCloseCycles: auto.autoCloseCycles,
    };
    savingAuto = true;
    await ws.run(() => ws.api.patch(path(), { config }), "Automation saved");
    savingAuto = false;
    await ws.reloadProject();
  }

  async function toggleArchived() {
    const archived = !ws.project!.isArchived;
    await ws.act(() => ws.api.patch(path(), { isArchived: archived }), archived ? "Project archived" : "Project restored");
    await ws.loadProjects();
  }
</script>

<div class="stack">
  <Panel title="Details">
    {#snippet actions()}
      <Button size="sm" loading={savingDetails} disabled={!details.name.trim()} onclick={saveDetails}>Save</Button>
    {/snippet}
    <FormGrid columns={3}>
      <Field label="Name" required>
        <Input bind:value={details.name} maxlength={200} />
      </Field>
      <Field label="Key">
        <Input value={ws.project?.identifier ?? ""} disabled />
      </Field>
      <FormGrid>
        <Field label="Emoji">
          <Input bind:value={details.emoji} maxlength={16} />
        </Field>
        <Field label="Color">
          <Input type="color" bind:value={details.color} />
        </Field>
      </FormGrid>
      <Field label="Lead">
        <Select bind:value={details.leadId} options={ws.memberOptions} placeholder="None" />
      </Field>
      <Field label="Default assignee">
        <Select bind:value={details.defaultAssigneeId} options={ws.memberOptions} placeholder="None" />
      </Field>
      <div></div>
      <div class="wide">
        <Field label="Description">
          <Textarea bind:value={details.description} rows={3} maxlength={5000} />
        </Field>
      </div>
    </FormGrid>
  </Panel>

  <Panel title="Automation">
    {#snippet actions()}
      <Button size="sm" loading={savingAuto} onclick={saveAutomation}>Save</Button>
    {/snippet}
    <FormGrid columns={3}>
      <Field label="Estimate type">
        <Select bind:value={auto.estimateType} options={options(ESTIMATE_TYPES)} placeholder="None" />
      </Field>
      <Field label="Time zone">
        <Input bind:value={auto.timezone} maxlength={64} placeholder="UTC" />
      </Field>
      <Field label="Week starts on">
        <Select bind:value={auto.weekStartDay} options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))} />
      </Field>
      <Field label="Auto-archive closed issues after (days)">
        <Input type="number" min="1" max="3650" bind:value={auto.autoArchiveDays} placeholder="Off" />
      </Field>
      <div class="check">
        <Checkbox bind:checked={auto.autoCloseCycles} label="Close cycles when they end" />
      </div>
    </FormGrid>

    <h4>Assign on entering a state</h4>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>State</TableHead>
          <TableHead>Assign to</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each ws.states as s (s.id)}
          <TableRow>
            <TableCell><Dot color={s.color} />{s.name}</TableCell>
            <TableCell>
              <Select
                size="sm"
                aria-label={`Assign on entering ${s.name}`}
                value={auto.autoAssign[s.id] ?? ""}
                options={ws.memberOptions}
                placeholder="Nobody"
                onchange={(e: Event) => (auto.autoAssign[s.id] = (e.currentTarget as HTMLSelectElement).value)}
              />
            </TableCell>
          </TableRow>
        {:else}
          <EmptyRow columns={2} text="No states" />
        {/each}
      </TableBody>
    </Table>
  </Panel>

  <Panel title={ws.project?.isArchived ? "Archived project" : "Archive"}>
    <Button variant={ws.project?.isArchived ? "secondary" : "danger"} onclick={() => (confirmArchive = true)}>
      {ws.project?.isArchived ? "Restore project" : "Archive project"}
    </Button>
  </Panel>
</div>

<ConfirmDialog
  bind:open={confirmArchive}
  title={ws.project?.isArchived ? `Restore ${ws.project?.name}?` : `Archive ${ws.project?.name}?`}
  confirmLabel={ws.project?.isArchived ? "Restore" : "Archive"}
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant={ws.project?.isArchived ? "primary" : "danger"}
  onConfirm={toggleArchived}
/>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  h4 {
    margin: 1.25rem 0 0.5rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: rgb(var(--ta-text-dim));
  }

  .check {
    padding-top: 1.6rem;
  }
</style>

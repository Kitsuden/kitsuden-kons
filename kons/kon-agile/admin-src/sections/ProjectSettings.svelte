<!--
  The project itself: details, automation (estimate type, week, auto-assign by state,
  auto-archive, auto-close of cycles) and archiving. Details and automation are two forms, each
  saved by its own SaveBar.
-->
<script lang="ts">
  import {
    Badge,
    Button,
    Checkbox,
    ConfirmDialog,
    EmptyState,
    Field,
    Input,
    SaveBar,
    Select,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Textarea,
  } from "$lib/components";

  import { untrack } from "svelte";

  import { seg } from "../api";
  import { optional, options } from "../format";
  import { ESTIMATE_TYPES, type ProjectConfig } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { toast } from "../ui/notify";
  import Panel from "../ui/Panel.svelte";
  import Swatch from "../ui/Swatch.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // Copies of the project for the forms, refreshed whenever the project is reloaded.
  let details = $state({ name: "", description: "", emoji: "", color: "", leadId: "", defaultAssigneeId: "" });
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

  // What each form held when it was loaded or saved: the SaveBar compares the screen with it.
  let savedDetails = $state("");
  let savedAuto = $state("");

  const detailsSnapshot = () => JSON.stringify(details);
  // A number field holds a number (or null when empty), and an auto-assign set back to "Nobody"
  // is the same as one never set.
  const autoSnapshot = () =>
    JSON.stringify({
      ...auto,
      autoArchiveDays: String(auto.autoArchiveDays ?? "").trim(),
      autoAssign: Object.entries(auto.autoAssign)
        .filter(([, v]) => v)
        .sort(([a], [b]) => a.localeCompare(b)),
    });

  const detailsDirty = $derived(savedDetails !== "" && detailsSnapshot() !== savedDetails);
  const autoDirty = $derived(savedAuto !== "" && autoSnapshot() !== savedAuto);

  function paint() {
    const p = ws.project;
    if (!p) return;
    details = {
      name: p.name,
      description: p.description ?? "",
      emoji: p.emoji ?? "",
      color: p.color ?? ws.accentColor(),
      leadId: p.leadId ?? "",
      defaultAssigneeId: p.defaultAssigneeId ?? "",
    };
    savedDetails = detailsSnapshot();
    const c = p.config ?? {};
    auto = {
      estimateType: c.estimateType ?? "",
      timezone: c.timezone ?? "",
      weekStartDay: String(c.weekStartDay ?? 1),
      autoArchiveDays: c.autoArchiveDays ? String(c.autoArchiveDays) : "",
      autoCloseCycles: c.autoCloseCycles ?? false,
      autoAssign: { ...(c.autoAssign ?? {}) },
    };
    savedAuto = autoSnapshot();
  }

  // Only a reloaded project repaints the forms: what is typed is not a reason to.
  $effect(() => {
    void ws.project;
    untrack(paint);
  });

  const path = () => `/projects/${seg(ws.projectId!)}`;

  const days = $derived(String(auto.autoArchiveDays ?? "").trim());
  const daysError = $derived(
    days && !(Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 3650) ? "Whole days from 1 to 3650" : undefined
  );

  async function saveDetails() {
    if (!details.name.trim()) {
      toast.error("Write the project's name");
      return;
    }
    savingDetails = true;
    await ws.run(
      () =>
        ws.api.patch(path(), {
          name: details.name.trim(),
          description: optional(details.description) ?? "",
          emoji: optional(details.emoji) ?? "",
          color: details.color || undefined,
          // The kon's schema takes an id or nothing for these: an empty choice is left out.
          leadId: optional(details.leadId),
          defaultAssigneeId: optional(details.defaultAssigneeId),
        }),
      "Project saved",
      "Could not save the project"
    );
    savingDetails = false;
    await ws.loadProjects();
  }

  async function saveAutomation() {
    if (daysError) {
      toast.error("Auto-archive takes whole days from 1 to 3650");
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
    await ws.run(() => ws.api.patch(path(), { config }), "Automation saved", "Could not save the automation");
    savingAuto = false;
    await ws.reloadProject();
  }

  async function toggleArchived() {
    const archived = !ws.project!.isArchived;
    await ws.act(
      () => ws.api.patch(path(), { isArchived: archived }),
      archived ? "Project archived" : "Project restored",
      archived ? "Could not archive the project" : "Could not restore the project"
    );
    await ws.loadProjects();
  }
</script>

<Panel title="Details">
  <FormGrid label="Project details" onsubmit={saveDetails}>
    <Field label="Name" required error={savedDetails && !details.name.trim() ? "A project needs a name" : undefined}>
      <Input bind:value={details.name} maxlength={200} />
    </Field>
    <Field label="Key">
      <Input value={ws.project?.identifier ?? ""} disabled />
    </Field>
    <Field label="Emoji">
      <Input bind:value={details.emoji} maxlength={16} />
    </Field>
    <Field label="Color">
      <Input type="color" bind:value={details.color} />
    </Field>
    <Field label="Lead">
      <Select bind:value={details.leadId} options={ws.memberOptions} placeholder="None" />
    </Field>
    <Field label="Default assignee">
      <Select bind:value={details.defaultAssigneeId} options={ws.memberOptions} placeholder="None" />
    </Field>
    <Field label="Description" class="wide">
      <Textarea bind:value={details.description} rows={3} maxlength={5000} />
    </Field>
  </FormGrid>
  <SaveBar
    sticky={false}
    savedText="No unsaved changes"
    dirty={detailsDirty}
    saving={savingDetails}
    cancelLabel="Discard"
    ariaLabel="Save the project details"
    onSave={saveDetails}
    onCancel={detailsDirty ? paint : undefined}
  />
</Panel>

<Panel title="Automation">
  <FormGrid label="Project automation" onsubmit={saveAutomation}>
    <Field label="Estimate type">
      <Select bind:value={auto.estimateType} options={options(ESTIMATE_TYPES)} placeholder="None" />
    </Field>
    <Field label="Time zone">
      <Input bind:value={auto.timezone} maxlength={64} placeholder="UTC" />
    </Field>
    <Field label="Week starts on">
      <Select bind:value={auto.weekStartDay} options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))} />
    </Field>
    <Field label="Auto-archive closed issues after (days)" error={daysError}>
      <Input type="number" min="1" max="3650" bind:value={auto.autoArchiveDays} placeholder="Off" />
    </Field>
    <div class="wide">
      <Checkbox bind:checked={auto.autoCloseCycles} label="Close cycles when they end" />
    </div>
  </FormGrid>

  <h3 class="sub">Assign on entering a state</h3>
  {#if ws.states.length}
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
            <TableCell><Swatch color={s.color} name={s.name} /></TableCell>
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
        {/each}
      </TableBody>
    </Table>
  {:else}
    <EmptyState size="sm" level={null} title="No states yet" description="Add the project's states in the States tab." />
  {/if}
  <SaveBar
    sticky={false}
    savedText="No unsaved changes"
    dirty={autoDirty}
    saving={savingAuto}
    cancelLabel="Discard"
    ariaLabel="Save the automation"
    onSave={saveAutomation}
    onCancel={autoDirty ? paint : undefined}
  />
</Panel>

<Panel title="Archive">
  {#snippet status()}
    <Badge variant={ws.project?.isArchived ? "warning" : "success"} dot>{ws.project?.isArchived ? "Archived" : "Active"}</Badge>
  {/snippet}
  <div>
    <Button variant={ws.project?.isArchived ? "secondary" : "danger"} onclick={() => (confirmArchive = true)}>
      {ws.project?.isArchived ? "Restore project" : "Archive project"}
    </Button>
  </div>
</Panel>

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
  .sub {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    font-weight: 600;
  }
</style>

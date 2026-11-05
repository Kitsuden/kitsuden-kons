<!--
  Issue audit: find issues (archived ones too), archive or restore them, and delete them for
  good. Editing an issue's content is daily work and stays out of the admin panel.
-->
<script lang="ts">
  import {
    Badge,
    Button,
    Checkbox,
    ConfirmDialog,
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
  import { day, words } from "../format";
  import type { Issue, List } from "../types";
  import Actions from "../ui/Actions.svelte";
  import Dot from "../ui/Dot.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();
  const LIMIT = 200;

  let issues = $state<Issue[]>([]);
  let search = $state("");
  let stateId = $state("");
  let assigneeId = $state("");
  let archived = $state(false);
  let deleting = $state<Issue | null>(null);
  let confirmDelete = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function load() {
    const res = await ws.api.get<List<Issue>>(`/${seg(ws.projectId!)}/issues`, {
      search: search.trim(),
      stateId,
      assigneeId: assigneeId === "__none" ? undefined : assigneeId,
      unassigned: assigneeId === "__none" ? "true" : undefined,
      includeArchived: archived ? "true" : undefined,
      limit: LIMIT,
    });
    issues = archived ? res.docs.filter((i) => i.archivedAt) : res.docs;
  }

  // Filters reload at once; the search waits for a pause in typing.
  $effect(() => {
    void [ws.version, stateId, assigneeId, archived];
    if (ws.projectId) ws.run(load);
  });

  function typed() {
    clearTimeout(timer);
    timer = setTimeout(() => ws.run(load), 300);
  }

  async function setArchived(i: Issue, value: boolean) {
    await ws.run(() => ws.api.post(`/issues/${seg(i.key)}/${value ? "archive" : "unarchive"}`), value ? `${i.key} archived` : `${i.key} restored`);
    await load();
  }

  async function remove() {
    await ws.act(() => ws.api.del(`/issues/${seg(deleting!.key)}`), `${deleting!.key} deleted`);
    await load();
  }
</script>

<Panel title="Issues">
  {#snippet actions()}
    <div class="search">
      <Input type="search" aria-label="Search" placeholder="Search name or key" bind:value={search} oninput={typed} />
    </div>
    <Select size="sm" aria-label="State" bind:value={stateId} options={ws.stateOptions} placeholder="Any state" />
    <Select
      size="sm"
      aria-label="Assignee"
      bind:value={assigneeId}
      options={[{ value: "__none", label: "Unassigned" }, ...ws.memberOptions]}
      placeholder="Anyone"
    />
    <Checkbox bind:checked={archived} label="Archived only" />
  {/snippet}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Key</TableHead>
        <TableHead>Issue</TableHead>
        <TableHead>State</TableHead>
        <TableHead>Assignee</TableHead>
        <TableHead>Priority</TableHead>
        <TableHead>Created</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each issues as i (i.id)}
        <TableRow>
          <TableCell><code>{i.key}</code></TableCell>
          <TableCell>
            {i.name}
            {#if i.archivedAt}<Badge>archived {day(i.archivedAt)}</Badge>{/if}
          </TableCell>
          <TableCell><Dot color={i.stateColor} />{i.stateName ?? "—"}</TableCell>
          <TableCell>{ws.memberLabel(i.assigneeId)}</TableCell>
          <TableCell>{words(i.priority)}</TableCell>
          <TableCell>{day(i.createdAt)}</TableCell>
          <TableCell>
            <Actions>
              <Button size="sm" variant="ghost" onclick={() => setArchived(i, !i.archivedAt)}>
                {i.archivedAt ? "Restore" : "Archive"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onclick={() => {
                  deleting = i;
                  confirmDelete = true;
                }}>Delete</Button
              >
            </Actions>
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={7} text="No issues" />
      {/each}
    </TableBody>
  </Table>
  {#if issues.length >= LIMIT}
    <p class="more">First {LIMIT}</p>
  {/if}
</Panel>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete ${deleting?.key ?? ""} for good?`}
  description={deleting?.name}
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  onConfirm={remove}
/>

<style>
  .search {
    width: 14rem;
  }

  code {
    white-space: nowrap;
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
  }

  .more {
    margin: 0.75rem 0 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }
</style>

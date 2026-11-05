<!-- The project's history, newest first, a page at a time. -->
<script lang="ts">
  import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components";

  import { seg } from "../api";
  import { moment, words } from "../format";
  import type { Activity, List } from "../types";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import Panel from "../ui/Panel.svelte";
  import { useWorkspace } from "../store.svelte";

  const ws = useWorkspace();
  const PAGE = 50;

  let rows = $state<Activity[]>([]);
  let more = $state(false);
  let loadingMore = $state(false);

  async function page(before?: string) {
    const { docs } = await ws.api.get<List<Activity>>(`/${seg(ws.projectId!)}/activity`, { limit: PAGE, before });
    rows = before ? [...rows, ...docs] : docs;
    more = docs.length === PAGE;
  }

  $effect(() => {
    void ws.version;
    if (ws.projectId) ws.run(() => page());
  });

  async function next() {
    loadingMore = true;
    await ws.run(() => page(rows.at(-1)?.createdAt));
    loadingMore = false;
  }

  /** A short readable value for an old or new value of any type. */
  function show(v: unknown): string {
    if (v === null || v === undefined || v === "") return "—";
    if (typeof v === "string") return ws.states.find((s) => s.id === v)?.name ?? (v.length > 60 ? `${v.slice(0, 60)}…` : v);
    const text = JSON.stringify(v);
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }
</script>

<Panel title="History">
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>When</TableHead>
        <TableHead>Who</TableHead>
        <TableHead>What</TableHead>
        <TableHead>Field</TableHead>
        <TableHead>Before</TableHead>
        <TableHead>After</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each rows as r (r.id)}
        <TableRow>
          <TableCell>{moment(r.createdAt)}</TableCell>
          <TableCell><code>{ws.memberLabel(r.actorId)}</code></TableCell>
          <TableCell>
            {words(r.action)}
            {#if r.entityType}<span class="entity">{words(r.entityType)}</span>{/if}
            {#if r.description}<div class="description">{r.description}</div>{/if}
          </TableCell>
          <TableCell>{r.field ?? "—"}</TableCell>
          <TableCell>{show(r.oldValue)}</TableCell>
          <TableCell>{show(r.newValue)}</TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={6} text="No history" />
      {/each}
    </TableBody>
  </Table>
  {#if more}
    <div class="more">
      <Button variant="secondary" size="sm" loading={loadingMore} onclick={next}>Older</Button>
    </div>
  {/if}
</Panel>

<style>
  code {
    white-space: nowrap;
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
  }

  .entity {
    margin-left: 0.35rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .description {
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .more {
    display: flex;
    justify-content: center;
    margin-top: 0.75rem;
  }
</style>

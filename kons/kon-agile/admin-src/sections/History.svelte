<!-- The project's history, newest first, a page at a time. -->
<script lang="ts">
  import { Badge, Button, Timeline, type TimelineItem } from "$lib/components";
  import { untrack } from "svelte";

  import { seg } from "../api";
  import { moment, words } from "../format";
  import type { Activity, List } from "../types";
  import Loadable from "../ui/Loadable.svelte";
  import { createLoad } from "../ui/load.svelte";
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

  const data = createLoad(() => page());

  $effect(() => {
    void ws.version;
    if (ws.projectId) untrack(data.load);
  });

  async function next() {
    loadingMore = true;
    await ws.run(() => page(rows.at(-1)?.createdAt), undefined, "Could not load older history");
    loadingMore = false;
  }

  /** A short readable value for an old or new value of any type. */
  function show(v: unknown): string {
    if (v === null || v === undefined || v === "") return "—";
    if (typeof v === "string") return ws.states.find((s) => s.id === v)?.name ?? (v.length > 60 ? `${v.slice(0, 60)}…` : v);
    const text = JSON.stringify(v);
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }

  const tone = (action: string): TimelineItem["tone"] =>
    /^(created|added)/.test(action) ? "success" : /^(deleted|removed)/.test(action) ? "error" : "default";

  const items = $derived(
    rows.map((r): TimelineItem => {
      const change = r.field ? `${r.field}: ${show(r.oldValue)} → ${show(r.newValue)}` : "";
      return {
        date: moment(r.createdAt),
        title: r.entityType ? `${words(r.action)} ${words(r.entityType).toLowerCase()}` : words(r.action),
        description: [change, r.description].filter(Boolean).join(" · ") || undefined,
        tag: ws.memberLabel(r.actorId),
        tone: tone(r.action),
      };
    })
  );
</script>

<Panel title="History">
  {#snippet status()}
    {#if data.ready && rows.length}<Badge>{more ? `Latest ${rows.length}` : `${rows.length} ${rows.length === 1 ? "event" : "events"}`}</Badge>{/if}
  {/snippet}
  <Loadable
    load={data}
    empty={!rows.length}
    emptyTitle="No history yet"
    emptyDescription="Every change to the project's issues is recorded here."
    errorTitle="Could not load the history"
    lines={6}
  >
    <Timeline {items} ariaLabel="Project history, newest first" />
    {#if more}
      <div class="more">
        <Button variant="secondary" loading={loadingMore} onclick={next}>Older</Button>
      </div>
    {/if}
  </Loadable>
</Panel>

<style>
  .more {
    display: flex;
    justify-content: center;
  }
</style>

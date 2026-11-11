<svelte:options
  customElement={{
    tag: "broadcast-classifications",
    shadow: "open",
    props: { context: { type: "Object" }, params: { type: "Object" } },
  }}
/>

<!--
  <broadcast-classifications>: which classifications the broadcast offers.

  The CATALOG (which exist, which games each brings) comes from the kon:
  `GET /broadcast/classifications`. The SELECTION lives in the module settings:
  `PATCH /modules/kon-broadcast` with `{ settings: { classifications } }`. With nothing stored,
  the catalog's default is what is active.

  The view is one form: the checkboxes change what is on screen, and the bar at the end saves it.
-->
<script lang="ts">
  import {
    Alert,
    Badge,
    Checkbox,
    SaveBar,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components";

  import { untrack } from "svelte";

  import { apiBaseOf, createApi } from "./api";
  import type { Classification, ViewContext } from "./types";
  import { createLoad } from "./ui/load.svelte";
  import Loadable from "./ui/Loadable.svelte";
  import { failed, toast } from "./ui/notify";
  import Panel from "./ui/Panel.svelte";
  import View from "./ui/View.svelte";

  let { context }: { context?: ViewContext; params?: unknown } = $props();

  const api = createApi(() => apiBaseOf(context));

  interface ModulesResponse {
    categories?: Record<string, { modules?: { key: string; settings?: { classifications?: unknown } }[] }>;
  }

  let catalog = $state<Classification[]>([]);
  let fallback = $state<string[]>([]);
  /** What is stored; `null` when nothing is, which means the catalog's default. */
  let stored = $state<string[] | null>(null);
  /** One checkbox per classification. */
  let checks = $state<Record<string, boolean>>({});
  let saving = $state(false);

  /** `settings.classifications` of the broadcast module; `/modules` groups them by category. */
  function readSetting(response: ModulesResponse | null): string[] | null {
    for (const category of Object.values(response?.categories ?? {})) {
      for (const mod of category?.modules ?? []) {
        if (mod.key !== "kon-broadcast") continue;
        const saved = mod.settings?.classifications;
        return Array.isArray(saved) && saved.length > 0 ? (saved as string[]) : null;
      }
    }
    return null;
  }

  const active = $derived(stored ?? fallback);
  const selected = $derived(catalog.filter((c) => checks[c.id]).map((c) => c.id));
  /** What is on screen against what is stored (or the default, with nothing stored). */
  const dirty = $derived(
    catalog.length > 0 && catalog.some((c) => Boolean(checks[c.id]) !== active.includes(c.id))
  );

  function paint() {
    checks = Object.fromEntries(catalog.map((c) => [c.id, active.includes(c.id)]));
  }

  const data = createLoad(async () => {
    const [cat, modules] = await Promise.all([
      api.get<{ data?: Classification[]; default?: string[] }>("/broadcast/classifications"),
      // The selection is optional: without it, the default applies.
      api.get<ModulesResponse>("/modules").catch(() => null),
    ]);
    catalog = cat.data ?? [];
    fallback = cat.default ?? [];
    stored = readSetting(modules);
    paint();
  });

  let loadedBase: string | null = null;
  $effect(() => {
    const base = apiBaseOf(context);
    if (base === loadedBase) return;
    loadedBase = base;
    untrack(() => void data.load());
  });

  async function save() {
    // Zero classifications leave the scoreboard with no games at all, which looks broken: refused
    // here instead of saved.
    if (selected.length === 0) return toast.error("At least one classification must stay active");
    const next = selected;
    saving = true;
    try {
      await api.patch("/modules/kon-broadcast", { settings: { classifications: next } });
      stored = next;
      paint();
      toast.success("Classifications saved");
    } catch (e) {
      failed("Could not save the classifications", e);
    } finally {
      saving = false;
    }
  }
</script>

<View>
  <Panel
    title="Classifications"
    description="Which forms of matchup the scoreboard offers. Each one changes how the result is counted, not just which games appear."
  >
    {#snippet status()}
      {#if data.ready && catalog.length}<Badge>{selected.length} of {catalog.length} offered</Badge>{/if}
    {/snippet}
    <Loadable
      load={data}
      errorTitle="The classifications did not load"
      lines={6}
      empty={catalog.length === 0}
      emptyTitle="No classifications"
      emptyDescription="The broadcast catalog of this site has none to offer."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Offered</TableHead>
            <TableHead>Classification</TableHead>
            <TableHead>Games</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each catalog as c (c.id)}
            <TableRow>
              <TableCell>
                <div class="offer">
                  <Checkbox bind:checked={checks[c.id]} disabled={saving} ariaLabel={`Offer ${c.name}`} />
                  <span class="state" aria-hidden="true">{checks[c.id] ? "Offered" : "Not offered"}</span>
                </div>
              </TableCell>
              <TableCell>
                <span class="name">{c.name}</span>
                {#if c.description}<span class="desc">{c.description}</span>{/if}
              </TableCell>
              <TableCell>
                {#if c.games?.length}
                  <ul class="games" aria-label={`Games of ${c.name}`}>
                    {#each c.games as g (g.id)}
                      <li><Badge>{g.name}</Badge></li>
                    {/each}
                  </ul>
                {:else}
                  <span class="desc">No games</span>
                {/if}
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
      {#if selected.length === 0}
        <Alert variant="warning">At least one classification must stay active.</Alert>
      {/if}
    </Loadable>
  </Panel>

  {#if data.ready && catalog.length}
    <SaveBar
      savedText="No unsaved changes"
      {dirty}
      {saving}
      cancelLabel="Discard"
      ariaLabel="Save the classifications"
      onSave={save}
      onCancel={dirty ? paint : undefined}
    />
  {/if}
</View>

<style>
  :host {
    display: block;
  }

  .name {
    display: block;
    font-weight: 600;
  }

  .desc {
    display: block;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .games {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .offer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .state {
    font-size: 0.8125rem;
    white-space: nowrap;
  }
</style>
